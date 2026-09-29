import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

process.env.FIXED_INCOME_RAIL = 'bank';
process.env.COUPON_INCOME_GL_ACCOUNT_CODE = '1020';
process.env.TRUST_OPERATING_GL_ACCOUNT_CODE = '1030';
delete process.env.FIXED_INCOME_BANK_PAYEES;

const pool = require('../server/integrations/bonds/pgPool');
const { BankSettlementEngine } = require('../server/integrations/payments/bankSettlementEngine');
const { SettlementBankRegistry } = require('../server/integrations/payments/settlementBankRegistry');
const { CanonicalFundingSource } = require('../server/integrations/fineract/canonicalFundingSource');
const { ReserveEngine } = require('../server/integrations/finops/reserveEngine');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const { SpritzTreasuryLegEngine } = require('../server/integrations/spritz/spritzTreasuryLegEngine');
const { TrustPolicyEngine } = require('../server/integrations/dapp/trustPolicyEngine');
const { FixedIncomeDistributionEngine } = require('../server/integrations/os/fixedIncomeDistributionEngine');
const { TrustAdministrationWorkflowEngine } = require('../server/integrations/trust/trustAdministrationWorkflowEngine');
const { BankingAggregator } = require('../server/integrations/aggregator/bankingAggregator');
const aggregatorScheduler = require('../server/integrations/aggregator/aggregatorScheduler');
const { CollateralOsEngine } = require('../server/integrations/os/collateralOsEngine');
const { FraudComplianceOsEngine } = require('../server/integrations/os/fraudComplianceOsEngine');
const { CashEngine } = require('../server/integrations/cash/cashEngine');
const { PtcCashManagementEngine } = require('../server/integrations/finops/ptcCashManagementEngine');
const { LiquidityOsEngine } = require('../server/integrations/os/liquidityOsEngine');
const { BondIssuanceEngine } = require('../server/integrations/bonds/bondIssuanceEngine');
const { ProofOfAssetOsEngine } = require('../server/integrations/os/proofOfAssetOsEngine');
const { DepositAndSettlementEngine } = require('../server/integrations/payments/depositAndSettlementEngine');

type Row = Record<string, any>;

const LILI = { bankId: 'lili', name: 'Lili (Sunrise Banks N.A.)', accountName: 'DB NET MGMT LLC', provider: 'lili', rail: 'ach', routingNumber: '121145307', accountNumberMasked: '****2959', enabled: true, _account: '2959' };

function store(sources: Row[]) {
  const t: Record<string, Row[]> = { fixed_income_distributions: [] };
  const cols = /\(([^)]+)\)\s+VALUES/i;
  const query = vi.fn(async (sql: any, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^CREATE/.test(text)) return { rows: [] };
    let m: RegExpExecArray | null;
    if (/FROM trust_journal_entries je/.test(text)) return { rows: sources.filter(s => !t.fixed_income_distributions.some(d => d.source_entry_id === s.entry_id)) };
    if ((m = /^INSERT INTO fixed_income_distributions/.exec(text))) {
      const names = cols.exec(text)![1].split(',').map(s => s.trim());
      const values = /VALUES \((.+?)\)/.exec(text)![1].split(',').map(s => s.trim());
      const row: Row = { status: 'planned', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      names.forEach((n, i) => { row[n] = params[Number(values[i].replace(/\D/g, '')) - 1]; });
      t.fixed_income_distributions.push(row);
      return { rows: [row] };
    }
    if ((m = /^UPDATE fixed_income_distributions SET (.+) WHERE distribution_id = \$1$/.exec(text))) {
      t.fixed_income_distributions.filter(r => r.distribution_id === params[0]).forEach(r => {
        m![1].split(/, (?=\w+ = )/).forEach(pair => {
          const [col, value] = pair.split(/ = (.+)/);
          r[col] = value === 'NOW()' ? new Date().toISOString() : params[Number(value.slice(1)) - 1];
        });
      });
      return { rows: [] };
    }
    if (/^SELECT \* FROM fixed_income_distributions WHERE distribution_id = \$1$/.test(text)) return { rows: t.fixed_income_distributions.filter(r => r.distribution_id === params[0]) };
    if ((m = /^SELECT \* FROM fixed_income_distributions( WHERE (.+?))? ORDER BY .+ LIMIT \$\d+$/.exec(text))) {
      let rows = [...t.fixed_income_distributions];
      if (m[2]) m[2].split(' AND ').forEach(cond => { const [col, ref] = cond.split(' = '); rows = rows.filter(r => r[col] === params[Number(ref.slice(1)) - 1]); });
      return { rows };
    }
    if (/GROUP BY bucket, status/.test(text)) return { rows: [] };
    throw new Error(`unhandled SQL in test store: ${text}`);
  });
  return { t, query };
}

const COUPON = { entry_id: 'JE-CPN-9', entry_date: '2026-09-01', reference_type: 'coupon_period', reference_id: '9', bond_id: 1, payment_freq: 'semi-annual', amount: '1250.50', gl: '1020', description: 'coupon' };
const ALLOC = { entry_id: 'JE-OPS-9', entry_date: '2026-09-01', reference_type: 'operating_allocation', reference_id: '9', bond_id: 1, payment_freq: 'semi-annual', amount: '400', gl: '1030', description: 'alloc' };

describe('FixedIncomeDistributionEngine (FIXED_INCOME_RAIL=bank)', () => {
  let s: ReturnType<typeof store>;
  let readiness: ReturnType<typeof vi.spyOn>;
  let settle: ReturnType<typeof vi.spyOn>;
  let funding: ReturnType<typeof vi.spyOn>;
  let reserve: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    s = store([COUPON, ALLOC]);
    vi.spyOn(pool, 'query').mockImplementation(s.query as any);
    vi.spyOn(SettlementBankRegistry, 'resolve').mockResolvedValue(LILI);
    vi.spyOn(SettlementBankRegistry, 'list').mockResolvedValue([LILI]);
    readiness = vi.spyOn(BankSettlementEngine, 'readiness').mockResolvedValue({ bankId: 'lili', provider: 'lili', mode: 'live', ready: true, blockers: [], requires: ['approvalRef', 'screeningRef'], bank: SettlementBankRegistry.publicView(LILI) });
    settle = vi.spyOn(BankSettlementEngine, 'clearAndSettle').mockResolvedValue({ settlementId: 'STL-1', status: 'originated', providerReference: 'po_123' });
    funding = vi.spyOn(CanonicalFundingSource, 'position').mockImplementation(async ({ accountCode }: any) => ({ accountCode, availableBalanceCents: 500000, fundingEligible: true, segregationReason: null }));
    reserve = vi.spyOn(ReserveEngine, 'assertSpendable').mockResolvedValue({ allowed: true, enforcement: 'strict' });
    vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ entryId: 'JE-DIST' });
    vi.spyOn(SpritzTreasuryLegEngine, 'fund').mockRejectedValue(new Error('spritz must not be called'));
    vi.spyOn(TrustPolicyEngine, 'propose').mockRejectedValue(new Error('policy contract must not be called'));
  });
  afterEach(() => vi.restoreAllMocks());

  it('reports the bank rail and Lili as the payee of both buckets', async () => {
    const r = await FixedIncomeDistributionEngine.readiness();
    expect(r.rail).toBe('bank');
    expect(r.ready).toBe(true);
    expect(r.treasury.fundingSource).toBe('fineract_canonical');
    expect(r.buckets.map((b: any) => [b.bucket, b.funding.accountCode, b.funding.availableCents])).toEqual([['coupon_income', '1020', 500000], ['trust_operating', '1030', 500000]]);
    for (const b of r.buckets) expect(b.payees).toEqual([expect.objectContaining({ bankId: 'lili', shareBps: 10000, accountNumberMasked: '****2959' })]);
    expect(JSON.stringify(r)).not.toContain('_account');
  });

  it('plans one distribution per source journal to the settlement bank for the full journal amount', async () => {
    const out = await FixedIncomeDistributionEngine.plan({ createdBy: 't' });
    expect(out.planned).toBe(2);
    const rows = s.t.fixed_income_distributions;
    expect(rows.map(r => [r.bucket, r.payee, r.payee_role, Number(r.amount_usd)])).toEqual([
      ['coupon_income', 'lili', 'beneficiary', 1250.5],
      ['trust_operating', 'lili', 'trustee', 400],
    ]);
  });

  it('splits by shareBps and rounds the last line so the sum equals the source', () => {
    const split = FixedIncomeDistributionEngine.allocateBank({ bucket: 'coupon_income', paymentFreq: 'semi-annual', amountUsd: 100 }, [
      { bankId: 'lili', name: 'Lili', shareBps: 3333, enabled: true },
      { bankId: 'ops', name: 'Ops', shareBps: 6667, enabled: true },
    ]);
    expect(split.lines.map((l: any) => l.amountUsd)).toEqual([33.33, 66.67]);
    expect(split.retainedUsd).toBe(0);
  });

  it('stage -> reconcile -> execute originates the direct deposit via BankSettlementEngine, never Spritz/policy contract', async () => {
    await FixedIncomeDistributionEngine.plan({ createdBy: 't' });
    const id = s.t.fixed_income_distributions[0].distribution_id;
    const staged = await FixedIncomeDistributionEngine.stage({ distributionId: id, actor: 'maker' });
    expect(staged.status).toBe('funded');
    expect(staged.funding.source).toBe('fineract_canonical');
    expect(staged.funding.accountCode).toBe('1020');
    expect(funding).toHaveBeenCalledWith(expect.objectContaining({ accountCode: '1020' }));
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 125050, rail: 'fixed_income_bank' }));

    const rec = await FixedIncomeDistributionEngine.reconcile({ actor: 'maker' });
    expect(rec.rail).toBe('bank');
    expect(rec.reconciled).toBe(1);
    expect((await FixedIncomeDistributionEngine.get(id)).status).toBe('proposed');

    const done = await FixedIncomeDistributionEngine.execute({ distributionId: id, actor: 'checker', approvalRef: 'MC-1', screeningRef: 'SCR-1' });
    expect(done.status).toBe('executed');
    expect(done.txHash).toBe('po_123');
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ bankId: 'lili', amountCents: 125050, approvalRef: 'MC-1', screeningRef: 'SCR-1', paymentType: 'fixed_income_distribution', reference: `${id}:PAY` }));
    const je = (TrustAccountingEngine.postJournalEntry as any).mock.calls[0][0];
    expect(je.lines).toEqual([
      expect.objectContaining({ accountCode: '2000', debitAmount: 1250.5 }),
      expect.objectContaining({ accountCode: '1100', creditAmount: 1250.5 }),
    ]);
    expect(SpritzTreasuryLegEngine.fund).not.toHaveBeenCalled();
    expect(TrustPolicyEngine.propose).not.toHaveBeenCalled();
  });

  it('refuses to stage when the treasury ERP or the attested reserve cannot cover the distribution, or the bank is not ready', async () => {
    await FixedIncomeDistributionEngine.plan({ createdBy: 't' });
    const id = s.t.fixed_income_distributions[0].distribution_id;
    funding.mockResolvedValueOnce({ accountCode: '1020', availableBalanceCents: 29, fundingEligible: true, segregationReason: null });
    await expect(FixedIncomeDistributionEngine.stage({ distributionId: id })).rejects.toMatchObject({ code: 'FIXED_INCOME_UNFUNDED', details: { availableCents: 29, needCents: 125050 } });
    funding.mockResolvedValueOnce({ accountCode: '1020', availableBalanceCents: 0, fundingEligible: false, segregationReason: 'sub-ledger and canonical GL differ by $10 — reconcile before funding' });
    await expect(FixedIncomeDistributionEngine.stage({ distributionId: id })).rejects.toMatchObject({ code: 'FIXED_INCOME_UNFUNDED', details: { reason: expect.stringMatching(/reconcile/) } });
    reserve.mockRejectedValueOnce(Object.assign(new Error('Reserve shortfall: fixed_income_bank origination of $1250.50 exceeds the $0.84 held at an external custodian'), { code: 'RESERVE_SHORTFALL' }));
    await expect(FixedIncomeDistributionEngine.stage({ distributionId: id })).rejects.toMatchObject({ code: 'RESERVE_SHORTFALL' });
    expect((await FixedIncomeDistributionEngine.get(id)).error).toMatch(/Reserve shortfall/);
    readiness.mockResolvedValue({ ready: false, blockers: ['STRIPE_SECRET_KEY is a test-mode key'] });
    await expect(FixedIncomeDistributionEngine.stage({ distributionId: id })).rejects.toMatchObject({ code: 'FIXED_INCOME_BANK_NOT_READY' });
    expect((await FixedIncomeDistributionEngine.get(id)).status).toBe('planned');
  });

  it('keeps a distribution proposed when the settlement is only pending approval, and surfaces settlement errors', async () => {
    await FixedIncomeDistributionEngine.plan({ createdBy: 't' });
    const id = s.t.fixed_income_distributions[1].distribution_id;
    await FixedIncomeDistributionEngine.stage({ distributionId: id });
    await FixedIncomeDistributionEngine.reconcile({});
    settle.mockResolvedValueOnce({ settlementId: 'STL-2', status: 'pending_approval' });
    const pending = await FixedIncomeDistributionEngine.execute({ distributionId: id, approvalRef: 'MC', screeningRef: 'S' });
    expect(pending.pending).toBe(true);
    expect(pending.status).toBe('proposed');
    const err = Object.assign(new Error('approvalRef (maker/checker record) is required for a live settlement'), { status: 409 });
    settle.mockRejectedValueOnce(err);
    await expect(FixedIncomeDistributionEngine.execute({ distributionId: id })).rejects.toThrow(/approvalRef/);
    expect((await FixedIncomeDistributionEngine.get(id)).error).toMatch(/approvalRef/);
    expect(TrustAccountingEngine.postJournalEntry).not.toHaveBeenCalled();
  });
});

describe('TrustAdministrationWorkflowEngine', () => {
  const FEED = { connectionId: 'CONN-BETTERMENT-TRUST-CHECKING-FINLYNQ', name: 'Betterment (Finlynq)', connector: 'finlynq', status: 'ok', error: null, accounts: [{ name: 'Checking', mask: '3054', balanceCurrent: 0.84 }] };

  function allReady() {
    vi.spyOn(BankingAggregator, 'feedStatus').mockResolvedValue([FEED]);
    vi.spyOn(BondIssuanceEngine, 'status').mockResolvedValue({ ready: true, issues: [], issuances: 1 });
    vi.spyOn(CanonicalFundingSource, 'readiness').mockReturnValue({ ready: true, issues: [], system: 'fineract' });
    vi.spyOn(CashEngine, 'getPositionSummary').mockResolvedValue({ by_type: { distribution: { total_cents: 125050, account_count: 1 } }, grand_total_cents: 125050, grand_total_dollars: 1250.5 });
    vi.spyOn(PtcCashManagementEngine, 'listAccounts').mockResolvedValue([{ cma_id: 'CMA-1', name: 'PTC CMA', status: 'active' }]);
    vi.spyOn(PtcCashManagementEngine, 'getLiquidityHistory').mockResolvedValue([{ at: '2026-09-29', totalUsd: 1250.5, liquidUsd: 1250.5, health: 'critical', coverageDays: 3 }]);
    vi.spyOn(LiquidityOsEngine, 'coverage').mockResolvedValue({ adequate: true, issues: [], cash: { liquid: 7158156.64 }, horizons: { '365d': { due: 985246.28 } } });
    vi.spyOn(ReserveEngine, 'coverage').mockResolvedValue({ spendable: 0.84 });
    vi.spyOn(ProofOfAssetOsEngine, 'status').mockResolvedValue({ ready: true, issues: [], latest: { verdict: 'proven' } });
    vi.spyOn(ReserveEngine, 'status').mockResolvedValue({ enforcement: 'strict', coverage: { attestedReserveCents: 84 } });
    vi.spyOn(CollateralOsEngine, 'readiness').mockResolvedValue({ ready: false, issues: ['TRUST_POLICY_ADDRESS not configured (draw destination)'] });
    vi.spyOn(FixedIncomeDistributionEngine, 'readiness').mockResolvedValue({ ready: true, rail: 'bank', issues: [], treasury: { fundingSource: 'fineract_canonical' } });
    vi.spyOn(FixedIncomeDistributionEngine, 'summary').mockResolvedValue([]);
    vi.spyOn(FraudComplianceOsEngine, 'readiness').mockResolvedValue({ ready: true, mode: 'live', blockers: [] });
    vi.spyOn(SettlementBankRegistry, 'list').mockResolvedValue([LILI]);
    vi.spyOn(BankSettlementEngine, 'readiness').mockResolvedValue({ bankId: 'lili', provider: 'lili', mode: 'live', ready: true, blockers: [], bank: SettlementBankRegistry.publicView(LILI) });
    vi.spyOn(BankSettlementEngine, 'list').mockResolvedValue([]);
    vi.spyOn(DepositAndSettlementEngine, 'list').mockResolvedValue([{ order_id: 'DEP-1' }]);
  }

  afterEach(() => vi.restoreAllMocks());

  it('connects every engine in one status surface; only gating stages decide ready, Stripe is not a stage', async () => {
    allReady();
    const w = await TrustAdministrationWorkflowEngine.status();
    expect(Object.keys(w.stages)).toEqual(['bankFeed', 'issuance', 'fineract', 'cashAccounts', 'cashManagement', 'liquidity', 'proof', 'reserve', 'collateral', 'distribution', 'compliance', 'funding', 'settlement', 'ledger']);
    expect(w.stages).not.toHaveProperty('intake');
    expect(w.pipeline).not.toMatch(/stripe/i);
    expect(w.gaps).toContain('collateral: TRUST_POLICY_ADDRESS not configured (draw destination)');
    expect(w.gaps).toContain('cashManagement: CMA-1: liquidity critical');
    expect(w.gaps).toContain('liquidity: 365d debt service 985246.28 exceeds Reserve OS bank-confirmed cash 0.84 (ledger liquid 7158156.64)');
    expect(w.stages.liquidity).toMatchObject({ ready: false, bankConfirmedCash: 0.84 });
    expect(w.stages.cashAccounts).toMatchObject({ ready: true, totalUsd: 1250.5, byType: { distribution: { totalUsd: 1250.5, accounts: 1 } } });
    expect(w.blocking).toEqual([]);
    expect(w.ready).toBe(true);
    expect(w.stages.distribution.fundingSource).toBe('fineract_canonical');
    expect(w.stages.bankFeed.feeds[0].connector).toBe('finlynq');
    expect(w.stages.ledger.deposits).toEqual([{ order_id: 'DEP-1' }]);
    expect(JSON.stringify(w)).not.toContain('_account');
  });

  it('blocks on a failing Finlynq feed, non-strict Reserve OS and shadow screening, without hiding other stages', async () => {
    allReady();
    (BankingAggregator.feedStatus as any).mockResolvedValue([{ ...FEED, status: 'failing', error: 'HTTP 401' }]);
    (ReserveEngine.status as any).mockResolvedValue({ enforcement: 'warn', coverage: {} });
    (FraudComplianceOsEngine.readiness as any).mockResolvedValue({ ready: false, mode: 'shadow', blockers: ['FRAUD_COMPLIANCE_LIVE not true'] });
    (BondIssuanceEngine.status as any).mockRejectedValue(new Error('fineract down'));
    const w = await TrustAdministrationWorkflowEngine.status();
    expect(w.ready).toBe(false);
    expect(w.blocking).toEqual([
      'bankFeed: Betterment (Finlynq): HTTP 401',
      'reserve: RESERVE_ENFORCEMENT=warn: outbound value is not gated on external reserve',
      'compliance: FRAUD_COMPLIANCE_LIVE not true',
    ]);
    expect(w.gaps).toContain('issuance: fineract down');
    expect(w.stages.distribution.ready).toBe(true);
  });

  it('run() refreshes feeds, reserve and proofs before planning distributions, and never executes a payment', async () => {
    allReady();
    const order: string[] = [];
    vi.spyOn(aggregatorScheduler, 'runOnce').mockImplementation(async () => { order.push('bankFeed'); return { connections: 1, pulled: 4, errors: [] }; });
    vi.spyOn(PtcCashManagementEngine, 'getOverview').mockImplementation(async () => { order.push('cashManagement'); return { count: 1, totalCents: 125050, liquidCents: 125050 }; });
    vi.spyOn(ReserveEngine, 'verifyLive').mockImplementation(async () => { order.push('reserve'); return { verified: 3, sources: [] }; });
    vi.spyOn(ProofOfAssetOsEngine, 'proveAll').mockImplementation(async () => { order.push('proof'); return [{ scope: 'portfolio', bondId: null, verdict: 'proven' }]; });
    vi.spyOn(FixedIncomeDistributionEngine, 'runCycle').mockImplementation(async () => { order.push('distribution'); return { planned: 2, staged: 0 }; });
    const execute = vi.spyOn(FixedIncomeDistributionEngine, 'execute');
    const r = await TrustAdministrationWorkflowEngine.run({ actor: 'tester' });
    expect(order).toEqual(['bankFeed', 'cashManagement', 'reserve', 'proof', 'distribution']);
    expect(execute).not.toHaveBeenCalled();
    expect(r.errors).toEqual([]);
    expect(r.steps.proof.proofs).toEqual([{ scope: 'portfolio', bondId: null, verdict: 'proven' }]);
    expect(r.ready).toBe(true);
    expect((await TrustAdministrationWorkflowEngine.status()).lastRun).toMatchObject({ actor: 'tester', ready: true });

    (ReserveEngine.verifyLive as any).mockRejectedValue(new Error('circle 503'));
    expect((await TrustAdministrationWorkflowEngine.run()).errors).toEqual(['reserve: circle 503']);
  });
});
