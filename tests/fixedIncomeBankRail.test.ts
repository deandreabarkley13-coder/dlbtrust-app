import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

process.env.FIXED_INCOME_RAIL = 'bank';
process.env.LILI_ORIGINATOR = 'stripe_payout';
process.env.COUPON_INCOME_GL_ACCOUNT_CODE = '1020';
process.env.TRUST_OPERATING_GL_ACCOUNT_CODE = '1030';
delete process.env.FIXED_INCOME_BANK_PAYEES;

const pool = require('../server/integrations/bonds/pgPool');
const { BankSettlementEngine } = require('../server/integrations/payments/bankSettlementEngine');
const { SettlementBankRegistry } = require('../server/integrations/payments/settlementBankRegistry');
const { LiliStripePayoutOriginator } = require('../server/integrations/payments/liliStripePayoutOriginator');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const { SpritzTreasuryLegEngine } = require('../server/integrations/spritz/spritzTreasuryLegEngine');
const { TrustPolicyEngine } = require('../server/integrations/dapp/trustPolicyEngine');
const { FixedIncomeDistributionEngine } = require('../server/integrations/os/fixedIncomeDistributionEngine');
const { TrustAdministrationWorkflowEngine } = require('../server/integrations/trust/trustAdministrationWorkflowEngine');
const { StripePaymentIntakeEngine } = require('../server/integrations/payments/stripePaymentIntakeEngine');
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
  let balance: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    s = store([COUPON, ALLOC]);
    vi.spyOn(pool, 'query').mockImplementation(s.query as any);
    vi.spyOn(SettlementBankRegistry, 'resolve').mockResolvedValue(LILI);
    vi.spyOn(SettlementBankRegistry, 'list').mockResolvedValue([LILI]);
    readiness = vi.spyOn(BankSettlementEngine, 'readiness').mockResolvedValue({ bankId: 'lili', provider: 'lili', mode: 'live', ready: true, blockers: [], requires: ['approvalRef', 'screeningRef'], bank: SettlementBankRegistry.publicView(LILI) });
    settle = vi.spyOn(BankSettlementEngine, 'clearAndSettle').mockResolvedValue({ settlementId: 'STL-1', status: 'originated', providerReference: 'po_123' });
    balance = vi.spyOn(LiliStripePayoutOriginator, 'status').mockResolvedValue({ ready: true, balance: { availableCents: 500000 } });
    vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ entryId: 'JE-DIST' });
    vi.spyOn(SpritzTreasuryLegEngine, 'fund').mockRejectedValue(new Error('spritz must not be called'));
    vi.spyOn(TrustPolicyEngine, 'propose').mockRejectedValue(new Error('policy contract must not be called'));
  });
  afterEach(() => vi.restoreAllMocks());

  it('reports the bank rail and Lili as the payee of both buckets', async () => {
    const r = await FixedIncomeDistributionEngine.readiness();
    expect(r.rail).toBe('bank');
    expect(r.ready).toBe(true);
    expect(r.treasury.fundingSource).toBe('stripe_balance');
    expect(r.treasury.banks.lili.availableCents).toBe(500000);
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
    expect(staged.funding.source).toBe('stripe_balance');

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

  it('refuses to stage when the Stripe balance cannot cover the distribution or the bank is not ready', async () => {
    await FixedIncomeDistributionEngine.plan({ createdBy: 't' });
    const id = s.t.fixed_income_distributions[0].distribution_id;
    balance.mockResolvedValue({ ready: true, balance: { availableCents: 29 } });
    await expect(FixedIncomeDistributionEngine.stage({ distributionId: id })).rejects.toMatchObject({ code: 'FIXED_INCOME_UNFUNDED', details: { availableCents: 29, needCents: 125050 } });
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
  afterEach(() => vi.restoreAllMocks());

  it('aggregates issuance, intake, ledger, distribution and settlement and lists gaps per stage', async () => {
    vi.spyOn(BondIssuanceEngine, 'status').mockResolvedValue({ ready: true, issues: [], issuances: 1 });
    vi.spyOn(StripePaymentIntakeEngine, 'status').mockResolvedValue({ ready: true, mode: 'live', issues: [] });
    vi.spyOn(StripePaymentIntakeEngine, 'list').mockResolvedValue([{ intakeId: 'SPI-1', status: 'received' }]);
    vi.spyOn(DepositAndSettlementEngine, 'list').mockResolvedValue([{ order_id: 'DEP-1' }]);
    vi.spyOn(FixedIncomeDistributionEngine, 'readiness').mockResolvedValue({ ready: false, rail: 'bank', issues: ['lili: Stripe balance is test-mode'] });
    vi.spyOn(FixedIncomeDistributionEngine, 'summary').mockResolvedValue([]);
    vi.spyOn(SettlementBankRegistry, 'list').mockResolvedValue([LILI]);
    vi.spyOn(BankSettlementEngine, 'readiness').mockResolvedValue({ bankId: 'lili', provider: 'lili', mode: 'live', ready: true, blockers: [], bank: SettlementBankRegistry.publicView(LILI) });
    vi.spyOn(BankSettlementEngine, 'list').mockResolvedValue([]);
    vi.spyOn(ProofOfAssetOsEngine, 'status').mockResolvedValue({ ready: true, issues: [], latest: { verdict: 'proven' } });

    const w = await TrustAdministrationWorkflowEngine.status();
    expect(w.ready).toBe(false);
    expect(w.gaps).toEqual(['distribution: lili: Stripe balance is test-mode']);
    expect(w.stages.proof.status.latest.verdict).toBe('proven');
    expect(w.stages.issuance.status.issuances).toBe(1);
    expect(w.stages.intake.recent).toHaveLength(1);
    expect(w.stages.ledger.deposits).toEqual([{ order_id: 'DEP-1' }]);
    expect(w.stages.fineract.skipped).toBe(true);
    expect(w.stages.settlement.banks[0]).toMatchObject({ bankId: 'lili', ready: true });
    expect(JSON.stringify(w)).not.toContain('_account');

    (FixedIncomeDistributionEngine.readiness as any).mockResolvedValue({ ready: true, rail: 'bank', issues: [] });
    expect((await TrustAdministrationWorkflowEngine.status()).ready).toBe(true);
  });

  it('never lets one failing engine hide the others', async () => {
    vi.spyOn(BondIssuanceEngine, 'status').mockResolvedValue({ ready: false, issues: ['issuer Fineract account not provisioned'] });
    vi.spyOn(StripePaymentIntakeEngine, 'status').mockRejectedValue(new Error('stripe down'));
    vi.spyOn(DepositAndSettlementEngine, 'list').mockResolvedValue([]);
    vi.spyOn(FixedIncomeDistributionEngine, 'readiness').mockResolvedValue({ ready: true, rail: 'bank', issues: [] });
    vi.spyOn(FixedIncomeDistributionEngine, 'summary').mockResolvedValue([]);
    vi.spyOn(SettlementBankRegistry, 'list').mockResolvedValue([]);
    vi.spyOn(BankSettlementEngine, 'list').mockResolvedValue([]);
    vi.spyOn(ProofOfAssetOsEngine, 'status').mockResolvedValue({ ready: false, issues: ['no portfolio proof yet'] });
    const w = await TrustAdministrationWorkflowEngine.status();
    expect(w.ready).toBe(false);
    expect(w.gaps).toEqual(['issuance: issuer Fineract account not provisioned', 'intake: stripe down', 'settlement: not ready', 'proof: no portfolio proof yet']);
    expect(w.stages.distribution.ready).toBe(true);
  });
});
