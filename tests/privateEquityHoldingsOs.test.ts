import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { PrivateEquityHoldingsOsEngine } = require('../server/integrations/os/privateEquityHoldingsOsEngine');
const { CustodyOsEngine, ASSET_CLASSES } = require('../server/integrations/custody/custodyOsEngine');
const { DebtOsEngine } = require('../server/integrations/os/debtOsEngine');
const { PrivateEntityOsEngine } = require('../server/integrations/os/privateEntityOsEngine');
const { ProofOfAssetOsEngine } = require('../server/integrations/os/proofOfAssetOsEngine');
const { CollateralOsEngine } = require('../server/integrations/os/collateralOsEngine');
const wire = require('../server/scripts/privateEquityHoldingsWire');
const pool = require('../server/integrations/bonds/pgPool');

const saved = { ...process.env };
const today = new Date().toISOString().slice(0, 10);

type Row = Record<string, any>;

function fakeDb(state: { holdings: Row[]; events: Row[]; receipts: Row[] }) {
  return vi.spyOn(pool, 'query').mockImplementation(async (sql: any, p: any[] = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(CREATE|ALTER)/i.test(s)) return { rows: [] };
    if (s.startsWith('SELECT event_hash FROM pe_holding_events')) return { rows: state.events.slice(-1) };
    if (s.startsWith('INSERT INTO pe_holding_events')) {
      state.events.push({ sequence: state.events.length + 1, event_id: p[0], holding_id: p[1], event_type: p[2], actor: p[3], payload: JSON.parse(p[4]), prev_hash: p[5], event_hash: p[6], created_at: p[7] });
      return { rows: [] };
    }
    if (s.startsWith('SELECT * FROM pe_holding_events')) return { rows: state.events };
    if (s.startsWith('SELECT event_id, event_type')) return { rows: state.events.filter((e) => e.holding_id === p[0]) };
    if (s.startsWith('INSERT INTO pe_holdings')) {
      const existing = state.holdings.find((h) => h.instrument_ref === p[5]);
      const row = {
        holding_id: existing ? existing.holding_id : p[0], bond_id: p[1], entity_profile_id: p[2], issuer_name: p[3], holding_name: p[4], instrument_ref: p[5],
        custody_account_id: p[6], custody_position_id: p[7], quantity: p[8], valuation_cents: p[9], valuation_as_of: p[10], valuation_source: p[11],
        registered_by: existing ? existing.registered_by : p[12], status: s.includes("'intra_trust')") ? 'intra_trust' : 'registered', evaluation: null, created_at: new Date().toISOString(),
      };
      if (existing) Object.assign(existing, row); else state.holdings.push(row);
      return { rows: [existing || row] };
    }
    if (s.startsWith('SELECT * FROM pe_holdings WHERE holding_id')) return { rows: state.holdings.filter((h) => h.holding_id === p[0]) };
    if (s.startsWith("SELECT * FROM pe_holdings WHERE status <> 'retired'")) return { rows: state.holdings.filter((h) => h.status !== 'retired') };
    if (s.startsWith('SELECT * FROM pe_holdings ORDER BY')) return { rows: state.holdings };
    if (s.startsWith('UPDATE pe_holdings SET status = $2')) {
      const h = state.holdings.find((x) => x.holding_id === p[0]);
      Object.assign(h!, { status: p[1], evaluation: JSON.parse(p[2]), evaluated_at: new Date().toISOString() });
      return { rows: [h] };
    }
    if (s.startsWith('SELECT position_id FROM custody_receipts')) return { rows: state.receipts.filter((r) => r.receipt_id === p[0]) };
    throw new Error(`unexpected SQL: ${s}`);
  });
}

const BOND = { id: 7, bond_name: 'DLB PFTC Private Placement Bond', status: 'active', placement_type: 'private' };
const PROFILE = { profile_id: 'PENT-1', entity_name: 'DEANDREA LAVAR BARKLEY TRUST COMPANY', status: 'attested' };
const POSITION = {
  position_id: 'CPS-1', custody_account_id: 'CUS-PE-HOLDINGS', asset_class: 'private_equity', control_status: 'receipted',
  valuation_cents: 1000000000, last_receipt_id: 'CRC-1', custody_type: 'third_party', custodian_name: 'Example Fund Administrator',
};

function stubEngines({ position = POSITION, proof = { proofId: 'POA-1', verdict: 'proven', certifiedBy: 'Trustee' } as any, entityReady = true } = {}) {
  vi.spyOn(DebtOsEngine, 'listBonds').mockResolvedValue([BOND, { id: 8, bond_name: 'Public', status: 'active', placement_type: 'public' }]);
  vi.spyOn(DebtOsEngine, 'placementCompliance').mockResolvedValue({ compliant: true, issues: [] });
  vi.spyOn(PrivateEntityOsEngine, 'current').mockResolvedValue(PROFILE);
  vi.spyOn(PrivateEntityOsEngine, 'readiness').mockResolvedValue({ ready: entityReady, blockers: entityReady ? [] : ['PRIVATE_ENTITY_LIVE not true'] });
  vi.spyOn(CustodyOsEngine, 'recordPosition').mockResolvedValue({ ...POSITION, control_status: 'unverified' });
  vi.spyOn(CustodyOsEngine, 'getPosition').mockResolvedValue(position);
  vi.spyOn(CustodyOsEngine, 'verifyChain').mockResolvedValue({ events: 4, intact: true, breaks: [] });
  vi.spyOn(ProofOfAssetOsEngine, 'latest').mockResolvedValue(proof);
  const prove = vi.spyOn(ProofOfAssetOsEngine, 'prove').mockResolvedValue(proof);
  vi.spyOn(CollateralOsEngine, 'readiness').mockResolvedValue({ ready: false, issues: ['COLLATERAL_OS_LIVE not true'] });
  return { prove };
}

const REGISTER = {
  bondId: 7, holdingName: 'Fund III LP interest', instrumentRef: 'LP-FUND-III-001', valuationCents: 1000000000,
  valuationAsOf: today, valuationSource: 'GP capital account statement Q3', actor: 'trustee.a',
};

describe('Private Equity Holdings OS', () => {
  let state: { holdings: Row[]; events: Row[]; receipts: Row[] };
  beforeEach(() => {
    state = { holdings: [], events: [], receipts: [] };
    fakeDb(state);
    process.env.PE_HOLDINGS_LIVE = 'true';
    delete process.env.PE_HOLDINGS_REQUIRE_THIRD_PARTY_CUSTODY;
    delete process.env.PE_HOLDINGS_ADVANCE_RATE_BPS;
    delete process.env.COLLATERAL_ADVANCE_RATE_EQUITY_BPS;
  });
  afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });

  it('accepts private_equity as a custody asset class', () => {
    expect(ASSET_CLASSES).toContain('private_equity');
  });

  it('registers a holding as a Custody OS private_equity position bound to the PFTC and the bond', async () => {
    stubEngines();
    const h = await PrivateEquityHoldingsOsEngine.register(REGISTER);
    expect(CustodyOsEngine.recordPosition).toHaveBeenCalledWith(expect.objectContaining({
      custodyAccountId: 'CUS-PE-HOLDINGS', assetClass: 'private_equity', instrumentRef: 'LP-FUND-III-001', valuationCents: 1000000000, recordedBy: 'trustee.a',
    }));
    expect(h).toMatchObject({ bondId: 7, entityProfileId: 'PENT-1', custodyPositionId: 'CPS-1', status: 'registered' });
    expect(state.events.map((e) => e.event_type)).toEqual(['holding_registered']);
  });

  it('refuses a public bond, a missing PFTC profile, a future valuation and an anonymous actor', async () => {
    stubEngines();
    await expect(PrivateEquityHoldingsOsEngine.register({ ...REGISTER, bondId: 8 })).rejects.toMatchObject({ code: 'PE_HOLDINGS_NOT_PRIVATE' });
    await expect(PrivateEquityHoldingsOsEngine.register({ ...REGISTER, actor: null })).rejects.toMatchObject({ code: 'PE_HOLDINGS_ACTOR' });
    await expect(PrivateEquityHoldingsOsEngine.register({ ...REGISTER, valuationAsOf: '2999-01-01' })).rejects.toMatchObject({ code: 'PE_HOLDINGS_INVALID' });
    vi.spyOn(PrivateEntityOsEngine, 'current').mockResolvedValue(null);
    await expect(PrivateEquityHoldingsOsEngine.register(REGISTER)).rejects.toMatchObject({ code: 'PE_HOLDINGS_NO_ISSUER' });
    expect(CustodyOsEngine.recordPosition).not.toHaveBeenCalled();
  });

  it('marks a fully evidenced holding collateral eligible at the equity advance rate', async () => {
    const { prove } = stubEngines();
    await PrivateEquityHoldingsOsEngine.register(REGISTER);
    const r = await PrivateEquityHoldingsOsEngine.evaluate({ prove: true, actor: 'scheduler' });
    expect(prove).toHaveBeenCalledWith({ bondId: 7, createdBy: 'scheduler' });
    expect(r.holdings[0].status).toBe('collateral_eligible');
    expect(r.holdings[0].evaluation).toMatchObject({ failing: [], receiptedCents: 1000000000, advanceRateBps: 5000, eligibleCollateralCents: 500000000 });
    expect(r.summary.eligibleCollateral).toBe('5000000.00');
    const ready = await PrivateEquityHoldingsOsEngine.readiness();
    expect(ready.ready).toBe(true);
    expect(ready.status.movesMoney).toBe(false);
    expect(ready.warnings.join('\n')).toMatch(/Collateral OS not ready/);
    expect((await PrivateEquityHoldingsOsEngine.verifyChain()).intact).toBe(true);
  });

  it('blocks a self-custody, unreceipted-value, stale, uncertified holding and reports every failing gate', async () => {
    stubEngines({
      position: { ...POSITION, custody_type: 'self_custody', valuation_cents: 900000000 },
      proof: { proofId: 'POA-2', verdict: 'variance', certifiedBy: null },
      entityReady: false,
    });
    await PrivateEquityHoldingsOsEngine.register({ ...REGISTER, valuationAsOf: '2020-01-01' });
    const r = await PrivateEquityHoldingsOsEngine.evaluate({ actor: 'scheduler' });
    const h = r.holdings[0];
    expect(h.status).toBe('blocked');
    expect(h.evaluation.failing).toEqual(['pftc_issuer', 'third_party_custody', 'valuation_matches_receipt', 'valuation_current', 'proof_of_asset']);
    expect(h.evaluation.eligibleCollateralCents).toBe(0);
    const ready = await PrivateEquityHoldingsOsEngine.readiness();
    expect(ready.ready).toBe(false);
    expect(ready.blockers.join('\n')).toMatch(/third_party_custody/);
  });

  it('stays in shadow while PE_HOLDINGS_LIVE is off and while nothing is registered', async () => {
    stubEngines();
    delete process.env.PE_HOLDINGS_LIVE;
    const ready = await PrivateEquityHoldingsOsEngine.readiness();
    expect(ready.mode).toBe('shadow');
    expect(ready.blockers).toEqual(expect.arrayContaining(['PE_HOLDINGS_LIVE not true', expect.stringMatching(/no private-equity holding registered/)]));
  });

  it('countersigns only a receipt for the holding\'s own custody position', async () => {
    stubEngines();
    const h = await PrivateEquityHoldingsOsEngine.register(REGISTER);
    state.receipts.push({ receipt_id: 'CRC-OTHER', position_id: 'CPS-9' }, { receipt_id: 'CRC-1', position_id: 'CPS-1' });
    const sign = vi.spyOn(CustodyOsEngine, 'countersignReceipt').mockResolvedValue({ controlStatus: 'receipted' });
    await expect(PrivateEquityHoldingsOsEngine.countersign({ holdingId: h.holdingId, receiptId: 'CRC-OTHER', actor: 'trustee.b' })).rejects.toMatchObject({ code: 'PE_HOLDINGS_RECEIPT_MISMATCH' });
    await PrivateEquityHoldingsOsEngine.process({ action: 'countersign', holdingId: h.holdingId, receiptId: 'CRC-1', actor: 'trustee.b' });
    expect(sign).toHaveBeenCalledWith('CRC-1', 'trustee.b', { role: 'trustee' });
  });

  it('wire script: draw plan never exceeds eligible collateral and validates its arguments', () => {
    const readiness = { ready: true, blockers: [], status: { summary: { eligibleCollateralCents: 500000000 }, collateralOs: { ready: true, issues: [] } } };
    expect(wire.planDraw(readiness, 5000000).executable).toBe(true);
    const over = wire.planDraw(readiness, 5000000.01);
    expect(over.executable).toBe(false);
    expect(over.blockers[0]).toMatch(/exceeds eligible collateral/);
    expect(over.steps.find((s: any) => s.movesMoney).requires).toEqual(expect.arrayContaining([expect.stringMatching(/FCS-/)]));
    expect(() => wire.parseArgs(['--evaluate'])).toThrow(/--actor/);
    expect(() => wire.parseArgs(['--prove', '--actor', 'x'])).toThrow(/--evaluate/);
    expect(() => wire.parseArgs(['--plan-draw'])).toThrow(/--amount/);
  });
});

describe('Private Equity Holdings OS intra-trust holdings', () => {
  let state: { holdings: Row[]; events: Row[]; receipts: Row[] };
  beforeEach(() => {
    vi.restoreAllMocks();
    state = { holdings: [], events: [], receipts: [] };
    fakeDb(state);
    process.env.PE_HOLDINGS_LIVE = 'true';
  });
  afterEach(() => { process.env = { ...saved }; });

  it('records the PPB as a self-custody intra-trust holding that is never evaluated or counted as collateral', async () => {
    stubEngines();
    const issuerPos = { position_id: 'CPS-BOND-7', custody_account_id: 'CUS-ISSUER-FIXED-INCOME', instrument_ref: 'BOND-7', asset_class: 'fixed_income', control_status: 'unverified', valuation_cents: 9854652191, quantity: 100000000, custody_type: 'self_custody' };
    vi.spyOn(CustodyOsEngine, 'listPositions').mockResolvedValue([issuerPos]);
    const h = await PrivateEquityHoldingsOsEngine.process({ action: 'register_intra_trust', bondId: 7, actor: 'trustee.a' });
    expect(h).toMatchObject({ status: 'intra_trust', instrumentRef: 'INTRA-BOND-7', custodyAccountId: 'CUS-ISSUER-FIXED-INCOME', custodyPositionId: 'CPS-BOND-7', valuationCents: 9854652191 });
    expect(CustodyOsEngine.recordPosition).not.toHaveBeenCalled();
    expect(state.events.map((e) => e.event_type)).toEqual(['holding_registered_intra_trust']);

    const { holdings, summary } = await PrivateEquityHoldingsOsEngine.evaluate({ actor: 'job' });
    expect(holdings[0].status).toBe('intra_trust');
    expect(summary).toMatchObject({ holdings: 0, collateralEligible: 0, eligibleCollateralCents: 0, intraTrust: { holdings: 1, bookCents: 9854652191, countsAsCollateral: false } });
    const r = await PrivateEquityHoldingsOsEngine.readiness();
    expect(r.blockers).toContain('no private-equity holding registered against a private-placement bond (action=register)');
  });

  it('wire script parses --intra-trust --bond', () => {
    expect(wire.parseArgs(['--intra-trust', '--bond', '1', '--actor', 'trustee.a'])).toMatchObject({ intraTrust: true, bond: '1', actor: 'trustee.a' });
    expect(() => wire.parseArgs(['--intra-trust', '--actor', 'a'])).toThrow(/--bond/);
  });
});
