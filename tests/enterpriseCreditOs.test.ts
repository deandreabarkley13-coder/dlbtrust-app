import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { EnterpriseCreditOsEngine } = require('../server/integrations/os/enterpriseCreditOsEngine');
const { PrivateEquityHoldingsOsEngine } = require('../server/integrations/os/privateEquityHoldingsOsEngine');
const { PledgeOsEngine } = require('../server/integrations/os/pledgeOsEngine');
const { CreditOsEngine } = require('../server/integrations/os/creditOsEngine');
const wire = require('../server/scripts/enterpriseCreditWire');
const pool = require('../server/integrations/bonds/pgPool');

const saved = { ...process.env };
type Row = Record<string, any>;

function fakeDb(state: { rows: Row[]; events: Row[]; journal: number }) {
  return vi.spyOn(pool, 'query').mockImplementation(async (sql: any, p: any[] = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/^CREATE/i.test(s)) return { rows: [] };
    if (/trust_journal/i.test(s)) { state.journal += 1; return { rows: [] }; }
    if (s.startsWith('SELECT event_hash FROM enterprise_credit_events')) return { rows: state.events.slice(-1) };
    if (s.startsWith('INSERT INTO enterprise_credit_events')) {
      state.events.push({ sequence: state.events.length + 1, event_id: p[0], allocation_id: p[1], event_type: p[2], actor: p[3], payload: JSON.parse(p[4]), prev_hash: p[5], event_hash: p[6], created_at: p[7] });
      return { rows: [] };
    }
    if (s.startsWith('SELECT * FROM enterprise_credit_events')) return { rows: state.events };
    if (s.startsWith('SELECT event_id, event_type')) return { rows: state.events.filter((e) => e.allocation_id === p[0]) };
    if (s.startsWith('SELECT COALESCE(SUM(amount_cents)')) {
      return { rows: [{ used: state.rows.filter((r) => ['approved', 'disbursed'].includes(r.status)).reduce((a, r) => a + r.amount_cents, 0) }] };
    }
    if (s.startsWith('INSERT INTO enterprise_credit_allocations')) {
      const row = { allocation_id: p[0], kind: p[1], amount_cents: p[2], beneficiary: p[3], purpose: p[4], bond_id: p[5], backing: JSON.parse(p[6]), requested_by: p[7], status: 'requested', created_at: new Date(Date.now() + state.rows.length).toISOString() };
      state.rows.push(row);
      return { rows: [row] };
    }
    if (s.startsWith('SELECT * FROM enterprise_credit_allocations WHERE allocation_id')) return { rows: state.rows.filter((r) => r.allocation_id === p[0]) };
    if (s.startsWith("SELECT * FROM enterprise_credit_allocations WHERE status IN")) return { rows: state.rows.filter((r) => ['requested', 'approved', 'disbursed'].includes(r.status)) };
    if (s.startsWith('SELECT * FROM enterprise_credit_allocations ORDER BY')) return { rows: [...state.rows].reverse() };
    if (s.startsWith('UPDATE enterprise_credit_allocations SET backing')) {
      const r = state.rows.find((x) => x.allocation_id === p[0])!;
      r.backing = JSON.parse(p[1]);
      return { rows: [r] };
    }
    if (s.startsWith('UPDATE enterprise_credit_allocations SET status')) {
      const r = state.rows.find((x) => x.allocation_id === p[0])!;
      r.status = p[1];
      const cols = [...s.matchAll(/(\w+) = \$(\d+)/g)].filter((m) => Number(m[2]) >= 3);
      for (const m of cols) r[m[1]] = m[1] === 'backing' ? JSON.parse(p[Number(m[2]) - 1]) : p[Number(m[2]) - 1];
      return { rows: [r] };
    }
    throw new Error(`unexpected SQL: ${s}`);
  });
}

function stubBacking({ peCents = 0, custodyPledgeCents = 0 } = {}) {
  vi.spyOn(PrivateEquityHoldingsOsEngine, 'status').mockResolvedValue({
    summary: { eligibleCollateralCents: peCents, collateralEligible: peCents ? 1 : 0, receipted: '0.00', intraTrust: { holdings: 1, bookCents: 9854652191, countsAsCollateral: false } },
  });
  vi.spyOn(PledgeOsEngine, 'list').mockResolvedValue([
    { reference: 'PLEDGE-DLB-PRB-1', backingType: 'bond', status: 'not_counted', countedCents: 0 },
    { reference: 'PLEDGE-PE-1', backingType: 'pe_holding', status: 'counted', countedCents: 999999 },
    ...(custodyPledgeCents ? [{ reference: 'PLEDGE-CUS-1', backingType: 'custody_position', status: 'counted', countedCents: custodyPledgeCents }] : []),
  ]);
  vi.spyOn(CreditOsEngine, 'gate').mockResolvedValue({ allowed: false, blockers: ['no funded real-value origination source'] });
}

describe('Enterprise Credit OS', () => {
  let state: { rows: Row[]; events: Row[]; journal: number };
  beforeEach(() => {
    vi.restoreAllMocks();
    state = { rows: [], events: [], journal: 0 };
    fakeDb(state);
    process.env.ENTERPRISE_CREDIT_LIVE = 'true';
    process.env.PAYMENT_APPROVAL_THRESHOLD = '2';
  });
  afterEach(() => { process.env = { ...saved }; });

  it('capacity = eligible PE collateral + custody-position pledges at the advance rate; intra-trust and PE/bond pledges not double counted', async () => {
    stubBacking({ peCents: 5000000, custodyPledgeCents: 2000000 });
    const cap = await EnterpriseCreditOsEngine.capacity();
    expect(cap).toMatchObject({ capacityCents: 6000000, usedCents: 0, availableCents: 6000000 });
    expect(cap.sources[0].detail.intraTrustExcluded.countsAsCollateral).toBe(false);
  });

  it('request -> approve (distinct trustee) -> disburse with bank reference, backing verdicts recorded, no GL writes', async () => {
    stubBacking({ peCents: 5000000 });
    const a = await EnterpriseCreditOsEngine.process({ action: 'request', kind: 'distribution', amountCents: 3000000, beneficiary: 'Beneficiary A', purpose: 'Q3 distribution', actor: 'trustee.a' });
    expect(a).toMatchObject({ status: 'requested', backing: { verdict: 'backed', backedCents: 3000000 } });
    await expect(EnterpriseCreditOsEngine.approve({ allocationId: a.allocationId, approvalRef: 'APR-1', actor: 'trustee.a' })).rejects.toThrow(/differ/);
    const ok = await EnterpriseCreditOsEngine.approve({ allocationId: a.allocationId, approvalRef: 'APR-1', actor: 'trustee.b' });
    expect(ok).toMatchObject({ status: 'approved', approvedBy: 'trustee.b', approvalRef: 'APR-1' });

    const b = await EnterpriseCreditOsEngine.request({ kind: 'disbursement', amountCents: 3000000, beneficiary: 'Vendor B', purpose: 'services', actor: 'trustee.a' });
    expect(b.backing).toMatchObject({ verdict: 'partial', backedCents: 2000000 });

    const plan = await EnterpriseCreditOsEngine.fundingPlan({ allocationId: a.allocationId });
    expect(plan.steps[1].via).toContain('fundSettlementAccount.js pipeline --amount 30000.00');
    expect(plan.liquidity.allowed).toBe(false);

    await expect(EnterpriseCreditOsEngine.disburse({ allocationId: a.allocationId, actor: 'trustee.a' })).rejects.toThrow(/bankReference/);
    const d = await EnterpriseCreditOsEngine.disburse({ allocationId: a.allocationId, bankReference: 'FED-IMAD-123', actor: 'trustee.a' });
    expect(d).toMatchObject({ status: 'disbursed', bankReference: 'FED-IMAD-123' });

    const r = await EnterpriseCreditOsEngine.readiness();
    expect(r.ready).toBe(true);
    expect(r.status.summary).toMatchObject({ open: 2, disbursedCents: 3000000, backed: 1, partial: 1 });
    expect(r.warnings.some((w: string) => w.includes('partial'))).toBe(true);
    expect((await EnterpriseCreditOsEngine.verifyChain()).intact).toBe(true);
    expect(state.journal).toBe(0);
  });

  it('with no counted backing, allocations are recorded as unbacked and readiness warns', async () => {
    stubBacking();
    const a = await EnterpriseCreditOsEngine.request({ kind: 'distribution', amountCents: 100, beneficiary: 'X', purpose: 'y', actor: 'trustee.a' });
    expect(a.backing.verdict).toBe('unbacked');
    const ev = await EnterpriseCreditOsEngine.evaluate({ actor: 'job' });
    expect(ev.summary.unbacked).toBe(1);
    const r = await EnterpriseCreditOsEngine.readiness();
    expect(r.warnings[0]).toMatch(/no counted asset backing/);
  });

  it('wire script parses actions', () => {
    expect(wire.parseArgs(['--request', '--kind', 'distribution', '--amount', '250.50', '--beneficiary', 'A', '--purpose', 'p', '--actor', 'm']).fields).toMatchObject({ amountCents: 25050, kind: 'distribution' });
    expect(() => wire.parseArgs(['--approve', '--actor', 'c'])).toThrow(/--allocation/);
    expect(() => wire.parseArgs(['--evaluate'])).toThrow(/--actor/);
    expect(wire.parseArgs(['--plan', '--allocation', 'ECA-1']).action).toBe('plan');
  });
});
