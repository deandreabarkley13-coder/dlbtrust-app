import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { EnterpriseCapacityOsEngine } = require('../server/integrations/os/enterpriseCapacityOsEngine');
const { CustodyOsEngine } = require('../server/integrations/custody/custodyOsEngine');
const { PrivateEquityHoldingsOsEngine } = require('../server/integrations/os/privateEquityHoldingsOsEngine');
const wire = require('../server/scripts/enterpriseCapacityWire');
const pool = require('../server/integrations/bonds/pgPool');

// Postgres JSONB returns object keys ordered by length, then bytewise.
function jsonb(v: any): any {
  if (Array.isArray(v)) return v.map(jsonb);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort((a, b) => a.length - b.length || (a < b ? -1 : 1)).map((k) => [k, jsonb(v[k])]));
  }
  return v;
}

const saved = { ...process.env };
type Row = Record<string, any>;

function fakeDb(state: { rows: Row[]; events: Row[]; journal: number }) {
  return vi.spyOn(pool, 'query').mockImplementation(async (sql: any, p: any[] = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/^CREATE/i.test(s)) return { rows: [] };
    if (/trust_journal|trust_accounts|collateral_/i.test(s)) { state.journal += 1; return { rows: [] }; }
    if (s.startsWith('SELECT event_hash FROM enterprise_capacity_events')) return { rows: state.events.slice(-1) };
    if (s.startsWith('INSERT INTO enterprise_capacity_events')) {
      state.events.push({ sequence: state.events.length + 1, event_id: p[0], allocation_id: p[1], event_type: p[2], actor: p[3], payload: jsonb(JSON.parse(p[4])), prev_hash: p[5], event_hash: p[6], created_at: p[7] });
      return { rows: [] };
    }
    if (s.startsWith('SELECT * FROM enterprise_capacity_events')) return { rows: state.events };
    if (s.startsWith('SELECT COALESCE(SUM(amount_cents)')) {
      return { rows: [{ used: state.rows.filter((r) => r.status === 'approved').reduce((a, r) => a + r.amount_cents, 0) }] };
    }
    if (s.startsWith('INSERT INTO enterprise_capacity_allocations')) {
      const row = { allocation_id: p[0], amount_cents: p[1], designation: p[2], purpose: p[3], verdict: JSON.parse(p[4]), requested_by: p[5], status: 'requested', created_at: new Date(Date.now() + state.rows.length).toISOString() };
      state.rows.push(row);
      return { rows: [row] };
    }
    if (s.startsWith('SELECT * FROM enterprise_capacity_allocations WHERE allocation_id')) return { rows: state.rows.filter((r) => r.allocation_id === p[0]) };
    if (s.startsWith('SELECT * FROM enterprise_capacity_allocations WHERE status IN')) return { rows: state.rows.filter((r) => ['requested', 'approved'].includes(r.status)) };
    if (s.startsWith('SELECT * FROM enterprise_capacity_allocations ORDER BY')) return { rows: [...state.rows].reverse() };
    if (s.startsWith('UPDATE enterprise_capacity_allocations SET verdict')) {
      const r = state.rows.find((x) => x.allocation_id === p[0])!;
      r.verdict = JSON.parse(p[1]);
      return { rows: [r] };
    }
    if (s.startsWith('UPDATE enterprise_capacity_allocations SET status')) {
      const r = state.rows.find((x) => x.allocation_id === p[0])!;
      r.status = p[1];
      for (const m of [...s.matchAll(/(\w+) = \$(\d+)/g)].filter((x) => Number(x[2]) >= 3)) r[m[1]] = m[1] === 'verdict' ? JSON.parse(p[Number(m[2]) - 1]) : p[Number(m[2]) - 1];
      return { rows: [r] };
    }
    throw new Error(`unexpected SQL: ${s}`);
  });
}

const POSITIONS = [
  { position_id: 'POS-PPB', custody_account_id: 'CUS-ISSUER-REGISTER', custody_type: 'self_custody', asset_class: 'fixed_income', instrument_ref: 'US-DLB-PRB-2024', instrument_name: 'DLB-PRB', control_status: 'unverified', valuation_cents: 9854652191 },
  { position_id: 'POS-OPS', custody_account_id: 'CUS-ISSUER-REGISTER', custody_type: 'self_custody', asset_class: 'fixed_income', instrument_ref: 'OPS', instrument_name: 'Trust operating', control_status: 'receipted', valuation_cents: 250000000 },
  { position_id: 'POS-CPN', custody_account_id: 'CUS-COUPON', custody_type: 'self_custody', asset_class: 'cash', instrument_ref: 'CPN', instrument_name: 'Coupon income', control_status: 'unverified', valuation_cents: 440319634 },
  { position_id: 'POS-OLD', custody_account_id: 'CUS-COUPON', custody_type: 'self_custody', asset_class: 'cash', instrument_ref: 'OLD', instrument_name: 'Released', control_status: 'released', valuation_cents: 99999999 },
  { position_id: 'POS-BRK', custody_account_id: 'CUS-BROKER', custody_type: 'third_party', asset_class: 'equity', instrument_ref: 'BRK', instrument_name: 'Brokerage', control_status: 'receipted', valuation_cents: 1000000 },
];

describe('Enterprise Capacity OS', () => {
  let state: { rows: Row[]; events: Row[]; journal: number };
  beforeEach(() => {
    vi.restoreAllMocks();
    state = { rows: [], events: [], journal: 0 };
    fakeDb(state);
    vi.spyOn(CustodyOsEngine, 'listPositions').mockResolvedValue(POSITIONS);
    vi.spyOn(PrivateEquityHoldingsOsEngine, 'status').mockResolvedValue({ summary: { intraTrust: { holdings: 1, bookCents: 9854652191, countsAsCollateral: false } } });
    process.env.ENTERPRISE_CAPACITY_LIVE = 'true';
    process.env.PAYMENT_APPROVAL_THRESHOLD = '2';
    delete process.env.ENTERPRISE_CAPACITY_INTRA_RATE_BPS;
  });
  afterEach(() => { process.env = { ...saved }; });

  it('counts every unreleased self-custody position at book as intra capacity; outside and PE intra-trust are not added', async () => {
    const cap = await EnterpriseCapacityOsEngine.capacity();
    expect(cap).toMatchObject({
      selfCustodyCents: 10544971825, capacityCents: 10544971825, capacity: '105449718.25', usedCents: 0, availableCents: 10544971825,
      selfCustodyReceipted: { cents: 250000000 }, outsideReceipted: { cents: 1000000 },
      countsAsCollateral: false, collateralOsBorrowingBase: false, enterpriseCreditCapacity: false, movesMoney: false,
    });
    expect(cap.positions.map((p: Row) => p.positionId)).toEqual(['POS-PPB', 'POS-OPS', 'POS-CPN']);
    expect(cap.byAccount['CUS-ISSUER-REGISTER']).toEqual({ positions: 2, book: '101046521.91', receipted: '2500000.00' });
    expect(cap.byAssetClass.cash).toEqual({ positions: 1, book: '4403196.34', receipted: '0.00' });
    expect(cap.peIntraTrust).toMatchObject({ holdings: 1, book: '98546521.91' });

    process.env.ENTERPRISE_CAPACITY_INTRA_RATE_BPS = '5000';
    expect((await EnterpriseCapacityOsEngine.capacity()).capacityCents).toBe(5272485912);
  });

  it('maker/checker earmarks reduce available capacity; release frees it; no GL, balance or collateral writes', async () => {
    const a = await EnterpriseCapacityOsEngine.process({ action: 'request', amountCents: 10000000000, designation: 'Series A', purpose: 'internal', actor: 'trustee.a' });
    expect(a.verdict).toMatchObject({ verdict: 'within', coveredCents: 10000000000 });
    await expect(EnterpriseCapacityOsEngine.approve({ allocationId: a.allocationId, approvalRef: 'APR-1', actor: 'trustee.a' })).rejects.toThrow(/differ/);
    await EnterpriseCapacityOsEngine.approve({ allocationId: a.allocationId, approvalRef: 'APR-1', actor: 'trustee.b' });
    const cap = await EnterpriseCapacityOsEngine.capacity();
    expect(cap).toMatchObject({ usedCents: 10000000000, availableCents: 544971825 });

    const b = await EnterpriseCapacityOsEngine.request({ amountCents: 1000000000, designation: 'Series B', purpose: 'internal', actor: 'trustee.a' });
    expect(b.verdict).toMatchObject({ verdict: 'partial', coveredCents: 544971825 });

    const ev = await EnterpriseCapacityOsEngine.evaluate({ actor: 'job' });
    expect(ev.summary).toMatchObject({ open: 2, within: 1, partial: 1 });
    const r = await EnterpriseCapacityOsEngine.readiness();
    expect(r.ready).toBe(true);
    expect(r.warnings.some((w: string) => w.includes('partial'))).toBe(true);

    const rel = await EnterpriseCapacityOsEngine.release({ allocationId: a.allocationId, actor: 'trustee.a' });
    expect(rel.status).toBe('released');
    expect((await EnterpriseCapacityOsEngine.capacity()).usedCents).toBe(0);
    await expect(EnterpriseCapacityOsEngine.release({ allocationId: b.allocationId, actor: 'trustee.a' })).rejects.toThrow(/needs approved/);
    expect((await EnterpriseCapacityOsEngine.verifyChain()).intact).toBe(true);
    expect(state.journal).toBe(0);
  });

  it('readiness blocks when not live and warns when there is no self custody', async () => {
    process.env.ENTERPRISE_CAPACITY_LIVE = 'false';
    (CustodyOsEngine.listPositions as any).mockResolvedValue([]);
    const r = await EnterpriseCapacityOsEngine.readiness();
    expect(r.blockers).toContain('ENTERPRISE_CAPACITY_LIVE not true');
    expect(r.warnings).toContain('no self-custody positions in Custody OS');
  });

  it('wire script parses actions', () => {
    expect(wire.parseArgs(['--request', '--amount', '2500.10', '--designation', 'Series A', '--purpose', 'p', '--actor', 'm']).fields).toMatchObject({ amountCents: 250010, designation: 'Series A' });
    expect(() => wire.parseArgs(['--approve', '--actor', 'c'])).toThrow(/--allocation/);
    expect(() => wire.parseArgs(['--evaluate'])).toThrow(/--actor/);
    expect(() => wire.parseArgs(['--request', '--actor', 'm'])).toThrow(/--amount/);
    expect(wire.parseArgs([]).action).toBeNull();
  });
});
