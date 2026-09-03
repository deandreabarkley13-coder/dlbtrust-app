import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const accounts: Record<string, any> = {};
const inserted: any[] = [];
const query = vi.fn(async (sql: string, params: any[] = []) => {
  if (/UPDATE corporate_treasury_accounts SET balance_cents/.test(sql)) {
    const a = accounts[params[1]]; a.balance_cents += Number(params[0]); a.available_cents += Number(params[0]);
    return { rows: [] };
  }
  if (/INSERT INTO ptc_cma_movements/.test(sql)) { inserted.push({ table: 'movements', params }); return { rows: [] }; }
  if (/INSERT INTO ptc_cma_liquidity_snapshots/.test(sql)) return { rows: [] };
  if (/SELECT \* FROM ptc_cma_accounts WHERE cma_id/.test(sql)) return { rows: [cmaRow] };
  return { rows: [] };
});
const pool = require('../server/integrations/bonds/pgPool');
pool.query = query;

const { CorporateTreasuryEngine } = require('../server/integrations/finops/corporateTreasuryEngine');
Object.assign(CorporateTreasuryEngine, {
  ensureTables: vi.fn(),
  getAccount: vi.fn(async (id: string) => accounts[id] || null),
  createTransaction: vi.fn(async (o: any) => ({ transaction_id: 'CTT-1', ...o })),
  createInvestment: vi.fn(async (o: any) => ({ investment_id: 'CTI-1', ...o })),
  createCashFlow: vi.fn(async (o: any) => ({ flow_id: 'CTF-1', ...o })),
  listCashFlows: vi.fn(async () => [{ type: 'outflow', amount_cents: 30_000_00 * 30, status: 'projected', account_id: null }]),
  updateAccount: vi.fn(),
});
const { WireEngine } = require('../server/integrations/wire/wireEngine');
const initiateWire = vi.fn(async (o: any) => ({ wire_id: 'WIRE-1', status: 'pending_approval', ...o }));
WireEngine.initiateWire = initiateWire;
const { LiliMcpEngine } = require('../server/integrations/payments/liliMcpEngine');
LiliMcpEngine.getPublicConfig = async () => ({ configured: false });
let LiliDirectDepositEngine: any = null;
try { ({ LiliDirectDepositEngine } = require('../server/integrations/payments/liliDirectDepositEngine')); } catch { /* not on this branch */ }
if (LiliDirectDepositEngine) LiliDirectDepositEngine.createDirectDeposit = vi.fn(async (o: any) => ({ deposit_id: 'LDD-1', status: 'awaiting_odfi', ...o }));

const cmaRow: any = {
  cma_id: 'CMA-1', name: 'PTC CMA', status: 'active', currency: 'USD',
  operating_account_id: 'CMA-1-operating', reserve_account_id: 'CMA-1-liquidity_reserve', sweep_account_id: 'CMA-1-investment_sweep',
  linked_bank: { provider: 'lili' }, policy: {},
};

const { PtcCashManagementEngine, DEFAULT_POLICY } = require('../server/integrations/finops/ptcCashManagementEngine');

function setLedgers(op: number, rs: number, sw: number) {
  accounts['CMA-1-operating'] = { account_id: 'CMA-1-operating', balance_cents: op, available_cents: op };
  accounts['CMA-1-liquidity_reserve'] = { account_id: 'CMA-1-liquidity_reserve', balance_cents: rs, available_cents: rs };
  accounts['CMA-1-investment_sweep'] = { account_id: 'CMA-1-investment_sweep', balance_cents: sw, available_cents: sw };
}
const pos = (op: number, rs: number, sw: number, policy = {}) => ({ policy: { ...DEFAULT_POLICY, ...policy }, ledgers: { operating: op, liquidity_reserve: rs, investment_sweep: sw } });

beforeEach(() => { inserted.length = 0; initiateWire.mockClear(); });

describe('PtcCashManagementEngine policy', () => {
  it('normalizes dollars to cents and enforces min <= target <= max', () => {
    const p = PtcCashManagementEngine.normalizePolicy({ minOperating: 100, targetOperating: 200, maxOperating: 300, reserveRatioBps: 500 });
    expect(p.minOperatingCents).toBe(10000); expect(p.maxOperatingCents).toBe(30000); expect(p.reserveRatioBps).toBe(500);
    expect(() => PtcCashManagementEngine.normalizePolicy({ minOperating: 500, targetOperating: 200 })).toThrow(/minOperating <= targetOperating/);
    expect(() => PtcCashManagementEngine.normalizePolicy({ sweepInstrument: 'crypto' })).toThrow(/sweepInstrument/);
  });
});

describe('PtcCashManagementEngine.planRebalance', () => {
  it('sweeps operating excess above the ceiling down to target, after funding the reserve', () => {
    // $2M operating, nothing else; 10% reserve = $200k; target $500k
    const plan = PtcCashManagementEngine.planRebalance(pos(200_000_000, 0, 0));
    expect(plan.requiredReserveCents).toBe(20_000_000);
    expect(plan.projected.liquidity_reserve).toBe(20_000_000);
    expect(plan.projected.operating).toBe(50_000_000);
    expect(plan.projected.investment_sweep).toBe(130_000_000);
    expect(plan.moves.map(m => `${m.fromLedger}>${m.toLedger}`)).toEqual(['operating>liquidity_reserve', 'operating>investment_sweep']);
  });

  it('restores the operating floor from investment sweep first, then reserve', () => {
    const plan = PtcCashManagementEngine.planRebalance(pos(10_000_000, 20_000_000, 30_000_000));
    expect(plan.moves[0]).toMatchObject({ fromLedger: 'investment_sweep', toLedger: 'operating', amountCents: 30_000_000 });
    expect(plan.projected.operating).toBeGreaterThanOrEqual(DEFAULT_POLICY.minOperatingCents);
    // reserve requirement still 10% of $600k total = $60k; already above, excess released to sweep
    expect(plan.projected.liquidity_reserve).toBe(6_000_000);
  });

  it('is a no-op when all sub-ledgers are within policy', () => {
    const plan = PtcCashManagementEngine.planRebalance(pos(50_000_000, 10_000_000, 40_000_000));
    expect(plan.moves).toEqual([]);
  });

  it('unwinds investment sweep when liquid cash cannot cover the forecast horizon', () => {
    const plan = PtcCashManagementEngine.planRebalance({ ...pos(50_000_000, 10_000_000, 100_000_000), forecast: { dailyBurnCents: 3_000_000 } });
    expect(plan.requiredLiquidCents).toBe(90_000_000);
    expect(plan.moves).toContainEqual(expect.objectContaining({ fromLedger: 'investment_sweep', toLedger: 'operating', amountCents: 24_000_000 }));
    expect(plan.projected.operating + plan.projected.liquidity_reserve).toBe(90_000_000);
  });

  it('never moves more than a ledger holds', () => {
    const plan = PtcCashManagementEngine.planRebalance(pos(0, 5_000_000, 5_000_000));
    for (const l of Object.values(plan.projected)) expect(l).toBeGreaterThanOrEqual(0);
  });
});

describe('PtcCashManagementEngine position + rails', () => {
  it('reports liquidity metrics and alerts (floor breach, coverage) from ledgers and forecast', async () => {
    setLedgers(10_000_000, 0, 0);
    const p = await PtcCashManagementEngine.getPosition('CMA-1');
    expect(p.totalCents).toBe(10_000_000);
    expect(p.alerts.map((a: any) => a.code)).toEqual(expect.arrayContaining(['OPERATING_BELOW_MIN', 'RESERVE_SHORTFALL', 'COVERAGE_SHORT']));
    expect(p.health).toBe('critical');
    expect(p.forecast.coverageDays).toBe(Math.floor(10_000_000 / 3_000_000));
    expect(p.linkedBank.available).toBe(false);
  });

  it('rebalance executes the plan via treasury transactions and books the sweep as an investment', async () => {
    setLedgers(200_000_000, 0, 0);
    const res = await PtcCashManagementEngine.rebalance('CMA-1', { actor: 'tester' });
    expect(res.moves.length).toBe(2);
    // forecast burn $30k/day × 30d coverage = $900k liquid required → operating held at $700k (reserve $200k)
    expect(accounts['CMA-1-liquidity_reserve'].available_cents).toBe(20_000_000);
    expect(accounts['CMA-1-operating'].available_cents).toBe(70_000_000);
    expect(accounts['CMA-1-investment_sweep'].available_cents).toBe(110_000_000);
    expect(res.investment).toMatchObject({ type: 'mmf', amount: 1_100_000 });
    expect(res.after.alerts).toEqual([]);
    expect(res.after.health).toBe('healthy');
  });

  it('disburse via wire debits operating, hands off to WireEngine and stays pending', async () => {
    setLedgers(80_000_000, 10_000_000, 0);
    const mv = await PtcCashManagementEngine.disburse('CMA-1', {
      rail: 'wire', amount: 100_000, reason: 'Custodian fee',
      beneficiary: { name: 'Acme Custody', routingNumber: '021000021', accountNumber: '12345678', bankName: 'JPM' },
    });
    expect(initiateWire).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 10_000_000, beneficiaryRouting: '021000021', metadata: expect.objectContaining({ cmaId: 'CMA-1' }) }));
    expect(mv.status).toBe('pending');
    expect(mv.externalRef).toBe('WIRE-1');
    expect(accounts['CMA-1-operating'].available_cents).toBe(70_000_000);
  });

  it('disburse pre-funds operating from sweep when it would breach the floor, and refuses when it cannot', async () => {
    setLedgers(30_000_000, 0, 50_000_000);
    const mv = await PtcCashManagementEngine.disburse('CMA-1', { rail: 'internal', amount: 200_000, reason: 'Distribution' });
    expect(mv.status).toBe('completed');
    expect(accounts['CMA-1-operating'].available_cents).toBeGreaterThanOrEqual(DEFAULT_POLICY.minOperatingCents);

    setLedgers(30_000_000, 0, 0);
    await expect(PtcCashManagementEngine.disburse('CMA-1', { rail: 'internal', amount: 200_000 })).rejects.toThrow(/operating floor/);
  });

  it('disburse via ach_lili queues a CCD credit through the Lili direct-deposit engine', async () => {
    if (!LiliDirectDepositEngine) return;
    setLedgers(80_000_000, 0, 0);
    const mv = await PtcCashManagementEngine.disburse('CMA-1', { rail: 'ach_lili', amount: 5_000, reason: 'Sweep to Lili' });
    expect(mv.externalRef).toBe('LDD-1');
    expect(mv.status).toBe('pending');
    expect(mv.external.secCode).toBe('CCD');
  });

  it('recordFunding rejects ach_lili inbound and records unconfirmed wires as pending expected inflows', async () => {
    setLedgers(0, 0, 0);
    await expect(PtcCashManagementEngine.recordFunding('CMA-1', { rail: 'ach_lili', amount: 10 })).rejects.toThrow(/outbound rail/);
    const pending = await PtcCashManagementEngine.recordFunding('CMA-1', { rail: 'wire', amount: 1_000 });
    expect(pending.status).toBe('pending');
    expect(accounts['CMA-1-operating'].available_cents).toBe(0);
    const posted = await PtcCashManagementEngine.recordFunding('CMA-1', { rail: 'wire', amount: 1_000, externalRef: 'IMAD-123' });
    expect(posted.status).toBe('completed');
    expect(accounts['CMA-1-operating'].available_cents).toBe(100_000);
  });
});
