import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { PledgeOsEngine } = require('../server/integrations/os/pledgeOsEngine');
const { PrivateEquityHoldingsOsEngine } = require('../server/integrations/os/privateEquityHoldingsOsEngine');
const { CustodyOsEngine } = require('../server/integrations/custody/custodyOsEngine');
const { DebtOsEngine } = require('../server/integrations/os/debtOsEngine');
const { CollateralOsEngine } = require('../server/integrations/os/collateralOsEngine');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const wire = require('../server/scripts/pledgeOsWire');
const pool = require('../server/integrations/bonds/pgPool');

const saved = { ...process.env };
type Row = Record<string, any>;

function fakeDb(state: { pledges: Row[]; events: Row[] }) {
  return vi.spyOn(pool, 'query').mockImplementation(async (sql: any, p: any[] = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/^CREATE/i.test(s)) return { rows: [] };
    if (s.startsWith('SELECT event_hash FROM pledge_os_events')) return { rows: state.events.slice(-1) };
    if (s.startsWith('INSERT INTO pledge_os_events')) {
      state.events.push({ sequence: state.events.length + 1, event_id: p[0], pledge_id: p[1], event_type: p[2], actor: p[3], payload: JSON.parse(p[4]), prev_hash: p[5], event_hash: p[6], created_at: p[7] });
      return { rows: [] };
    }
    if (s.startsWith('SELECT * FROM pledge_os_events')) return { rows: state.events };
    if (s.startsWith('SELECT event_id, event_type')) return { rows: state.events.filter((e) => e.pledge_id === p[0]) };
    if (s.startsWith('INSERT INTO pledge_os_pledges')) {
      const existing = state.pledges.find((x) => x.reference === p[1]);
      const row = {
        pledge_id: existing ? existing.pledge_id : p[0], reference: p[1], asset_description: p[2], pledgor: p[3], secured_party: p[4],
        backing_type: p[5], backing_ref: p[6], lien_filing_number: p[7], lien_jurisdiction: p[8], lien_filing_type: p[9],
        lien_filing_office: p[10], lien_filed_at: p[11], recorded_by: p[12], status: 'recorded', evaluation: null, created_at: new Date().toISOString(),
      };
      if (existing) Object.assign(existing, row); else state.pledges.push(row);
      return { rows: [existing || row] };
    }
    if (s.startsWith('SELECT * FROM pledge_os_pledges WHERE pledge_id = $1 OR reference = $1')) return { rows: state.pledges.filter((x) => x.pledge_id === p[0] || x.reference === p[0]) };
    if (s.startsWith("SELECT * FROM pledge_os_pledges WHERE status <> 'released'")) return { rows: state.pledges.filter((x) => x.status !== 'released') };
    if (s.startsWith('SELECT * FROM pledge_os_pledges ORDER BY')) return { rows: state.pledges };
    if (s.startsWith('UPDATE pledge_os_pledges SET status = $2')) {
      const x = state.pledges.find((r) => r.pledge_id === p[0])!;
      Object.assign(x, { status: p[1], evaluation: JSON.parse(p[2]), evaluated_at: new Date().toISOString() });
      return { rows: [x] };
    }
    if (s.startsWith("UPDATE pledge_os_pledges SET status = 'released'")) {
      const x = state.pledges.find((r) => r.pledge_id === p[0])!;
      Object.assign(x, { status: 'released', released_at: new Date().toISOString() });
      return { rows: [x] };
    }
    throw new Error(`unexpected SQL: ${s}`);
  });
}

const PPB = {
  reference: 'PLEDGE-DLB-PRB-1', assetDescription: 'DLB-PRB private placement bond', pledgor: 'DEANDREA LAVAR BARKLEY TRUST',
  securedParty: 'DEANDREA-LAVAR: BARKLEY', backingType: 'bond', backingRef: '1', lienFilingNumber: 'P24000656-2',
  lienJurisdiction: 'US-IA', lienFilingType: 'UTILITY', lienFilingOffice: 'Iowa Secretary of State', lienFiledAt: '2024-03-26', actor: 'trustee.a',
};

const ELIGIBLE = { holdingId: 'PEH-1', bondId: 1, status: 'collateral_eligible', evaluation: { receiptedCents: 250_000_000, failing: [] } };
const BLOCKED = { holdingId: 'PEH-2', bondId: 1, status: 'blocked', evaluation: { receiptedCents: 0, failing: ['third_party_custody'] } };

function stub({ holdings = [] as any[], position = null as any } = {}) {
  vi.spyOn(PrivateEquityHoldingsOsEngine, 'list').mockResolvedValue(holdings);
  vi.spyOn(DebtOsEngine, 'listBonds').mockResolvedValue([{ id: 1, bond_name: 'DLB-PRB', status: 'active', placement_type: 'private' }]);
  vi.spyOn(CustodyOsEngine, 'verifyChain').mockResolvedValue({ events: 44, intact: true, breaks: [] });
  vi.spyOn(CustodyOsEngine, 'getPosition').mockResolvedValue(position);
  vi.spyOn(CollateralOsEngine, 'facility').mockResolvedValue({ positions: 1, collateralUsd: 4_000_000, spendableUsd: 2_800_000, drawnUsd: 0 });
}

describe('Pledge OS', () => {
  let state: { pledges: Row[]; events: Row[] };
  let postJournal: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    state = { pledges: [], events: [] };
    fakeDb(state);
    postJournal = vi.spyOn(TrustAccountingEngine, 'postJournalEntry');
    process.env.PLEDGE_OS_LIVE = 'true';
  });
  afterEach(() => { process.env = { ...saved }; });

  it('records the PPB pledge with its Iowa UCC lien evidence and a hash-chained event', async () => {
    stub();
    const p = await PledgeOsEngine.record(PPB);
    expect(p).toMatchObject({ reference: 'PLEDGE-DLB-PRB-1', backingType: 'bond', backingRef: '1', status: 'recorded', lien: { filingNumber: 'P24000656-2', jurisdiction: 'US-IA', filingType: 'UTILITY', filedAt: '2024-03-26' } });
    expect(state.events.map((e) => e.event_type)).toEqual(['pledge_recorded']);
    expect((await PledgeOsEngine.verifyChain()).intact).toBe(true);
    await expect(PledgeOsEngine.record({ ...PPB, lienFilingNumber: '' })).rejects.toMatchObject({ code: 'PLEDGE_OS_INVALID' });
    await expect(PledgeOsEngine.record({ ...PPB, backingType: 'birth_certificate' })).rejects.toMatchObject({ code: 'PLEDGE_OS_INVALID' });
  });

  it('counts a bond pledge at the receipted value of its eligible private-equity holdings', async () => {
    stub({ holdings: [ELIGIBLE, BLOCKED] });
    await PledgeOsEngine.record(PPB);
    const { pledges, summary } = await PledgeOsEngine.evaluate({ actor: 'job' });
    expect(pledges[0]).toMatchObject({ status: 'counted', countedCents: 250_000_000, counted: '2500000.00' });
    expect(summary).toMatchObject({ pledges: 1, counted: 1, countedCents: 250_000_000, liens: ['P24000656-2'] });
    const cov = await PledgeOsEngine.coverage();
    expect(cov).toMatchObject({ countedCents: 250_000_000, unbackedCents: 150_000_000 });
    expect(postJournal).not.toHaveBeenCalled();
  });

  it('does not count a bond pledge with no eligible private-equity holding behind it', async () => {
    stub({ holdings: [BLOCKED] });
    await PledgeOsEngine.record(PPB);
    const { pledges } = await PledgeOsEngine.evaluate({ actor: 'job' });
    expect(pledges[0]).toMatchObject({ status: 'not_counted', countedCents: 0 });
    expect(pledges[0].evaluation.unmet).toEqual(['bond_asset_backing']);
    const r = await PledgeOsEngine.readiness();
    expect(r.ready).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/not counted \(bond_asset_backing\)/);
  });

  it('counts pe_holding and third-party custody_position pledges; self-custody positions are not counted', async () => {
    stub({ holdings: [ELIGIBLE], position: { position_id: 'CPS-9', control_status: 'receipted', custody_type: 'third_party', custodian_name: 'Broker', valuation_cents: 90_000 } });
    await PledgeOsEngine.record({ ...PPB, reference: 'PLG-PE', backingType: 'pe_holding', backingRef: 'PEH-1' });
    await PledgeOsEngine.record({ ...PPB, reference: 'PLG-CUS', backingType: 'custody_position', backingRef: 'CPS-9' });
    let { pledges } = await PledgeOsEngine.evaluate({ actor: 'job' });
    expect(pledges.map((x: any) => [x.reference, x.status, x.countedCents])).toEqual([['PLG-PE', 'counted', 250_000_000], ['PLG-CUS', 'counted', 90_000]]);
    (CustodyOsEngine.getPosition as any).mockResolvedValue({ position_id: 'CPS-9', control_status: 'receipted', custody_type: 'self_custody', valuation_cents: 90_000 });
    ({ pledges } = await PledgeOsEngine.evaluate({ pledgeId: 'PLG-CUS', actor: 'job' }));
    expect(pledges[0]).toMatchObject({ status: 'not_counted', countedCents: 0 });
    expect(pledges[0].evaluation.unmet).toEqual(['third_party_custody']);
  });

  it('releases a pledge and reports shadow readiness when nothing is recorded', async () => {
    stub();
    delete process.env.PLEDGE_OS_LIVE;
    const empty = await PledgeOsEngine.readiness();
    expect(empty).toMatchObject({ ready: false, mode: 'shadow' });
    expect(empty.blockers).toEqual(['PLEDGE_OS_LIVE not true', 'no pledge recorded (action=record)']);
    const p = await PledgeOsEngine.record(PPB);
    await expect(PledgeOsEngine.release({ pledgeId: p.pledgeId, actor: 'trustee.a' })).rejects.toMatchObject({ code: 'PLEDGE_OS_INVALID' });
    const released = await PledgeOsEngine.process({ action: 'release', pledgeId: p.pledgeId, reason: 'satisfied', actor: 'trustee.a' });
    expect(released.status).toBe('released');
    await expect(PledgeOsEngine.process({ action: 'nope' })).rejects.toMatchObject({ code: 'PLEDGE_OS_UNKNOWN_ACTION' });
  });

  it('wire script parses record/evaluate flags and requires an actor', () => {
    const a = wire.parseArgs(['--record', '--reference', 'PLEDGE-DLB-PRB-1', '--lien-filing', 'P24000656-2', '--backing-type', 'bond', '--actor', 'trustee.a']);
    expect(a).toMatchObject({ record: true, actor: 'trustee.a', fields: { reference: 'PLEDGE-DLB-PRB-1', lienFilingNumber: 'P24000656-2', backingType: 'bond' } });
    expect(() => wire.parseArgs(['--evaluate'])).toThrow(/--actor/);
    expect(() => wire.parseArgs(['--reference', 'X'])).toThrow(/only valid with --record/);
    expect(() => wire.parseArgs(['--bogus'])).toThrow(/unknown argument/);
  });
});
