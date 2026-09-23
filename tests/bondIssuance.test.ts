import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

process.env.INCOME_OBLIGOR_NAME = 'DEANDREA LAVAR BARKLEY TRUST COMPANY';
process.env.INCOME_OBLIGOR_EIN = '99-6411566';
process.env.INCOME_OBLIGOR_PAYER_ID = 'dlb-trust-company';
process.env.TRUST_HOLDER_NAME = 'DeAndrea Lavar Barkley Irrevocable Trust';
process.env.FINERACT_SAVINGS_PRODUCT_ID = '7';

const pool = require('../server/integrations/bonds/pgPool');
const { FineractClient } = require('../server/integrations/fineract/fineractClient');
const { LiveBondEngine } = require('../server/integrations/bonds/liveEngine');
const { DataBridge } = require('../server/integrations/accounting/dataBridge');
const { StripePaymentIntakeEngine } = require('../server/integrations/payments/stripePaymentIntakeEngine');
const { FixedIncomeDistributionEngine } = require('../server/integrations/os/fixedIncomeDistributionEngine');
const { BondIssuanceEngine } = require('../server/integrations/bonds/bondIssuanceEngine');

type Row = Record<string, any>;

function store() {
  const t: Record<string, Row[]> = { bond_issuance_parties: [], bond_issuances: [], bond_issuance_payments: [] };
  const bonds: Row[] = [{ id: 42, bond_name: 'DLB-IT-2026', status: 'active', face_value: 100000, coupon_rate: 5, payment_freq: 'quarterly', maturity_date: '2031-01-01' }];
  const query = vi.fn(async (sql: any, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^CREATE/.test(text)) return { rows: [] };
    if (/^SELECT id, bond_name, status FROM bonds/.test(text)) return { rows: bonds.filter(b => b.id === params[0]) };
    if (/^UPDATE bonds SET issuer/.test(text)) { const b = bonds.find(x => x.id === params[0])!; b.issuer = params[1]; b.bondholder = params[2]; return { rows: [] }; }
    if (/^INSERT INTO bond_issuance_parties/.test(text)) {
      const row = { role: params[0], external_id: params[1], name: params[2], fineract_client_id: params[3], fineract_account_id: params[4], fineract_account_no: params[5] };
      t.bond_issuance_parties = t.bond_issuance_parties.filter(r => r.role !== row.role).concat(row); return { rows: [] };
    }
    if (/^SELECT \* FROM bond_issuance_parties/.test(text)) return { rows: t.bond_issuance_parties };
    if (/^SELECT role, fineract_account_id FROM bond_issuance_parties/.test(text)) return { rows: t.bond_issuance_parties };
    if (/^INSERT INTO bond_issuances/.test(text)) {
      const row = { bond_id: params[0], issuer_external_id: params[1], holder_external_id: params[2], issued_by: params[3], status: 'issued', issued_at: new Date() };
      t.bond_issuances = t.bond_issuances.filter(r => r.bond_id !== row.bond_id).concat(row); return { rows: [] };
    }
    if (/^SELECT i\.bond_id, i\.issuer_external_id/.test(text)) return { rows: t.bond_issuances.filter(i => i.bond_id === params[0]).map(i => ({ ...bonds.find(b => b.id === i.bond_id)!, ...i, issuance_status: i.status, bond_status: bonds.find(b => b.id === i.bond_id)!.status })) };
    if (/^SELECT bond_id FROM bond_issuances/.test(text)) return { rows: t.bond_issuances };
    if (/^SELECT \* FROM bond_issuance_payments WHERE bond_id/.test(text)) return { rows: t.bond_issuance_payments.filter(p => p.bond_id === params[0]) };
    if (/^SELECT payment_id, status FROM bond_issuance_payments/.test(text)) return { rows: t.bond_issuance_payments.filter(p => p.bond_id === params[0] && p.kind === params[1] && p.period_date === params[2]) };
    if (/^INSERT INTO bond_issuance_payments/.test(text)) {
      const ex = t.bond_issuance_payments.find(p => p.payment_id === params[0]);
      if (ex) { ex.status = 'held'; ex.error_message = null; return { rows: [] }; }
      t.bond_issuance_payments.push({ payment_id: params[0], bond_id: params[1], kind: params[2], period_date: params[3], amount_usd: params[4], status: 'held', initiated_by: params[5] });
      return { rows: [] };
    }
    if (/^UPDATE bond_issuance_payments SET status = 'held', fineract_withdrawal_id/.test(text)) {
      const p = t.bond_issuance_payments.find(x => x.payment_id === params[0])!;
      Object.assign(p, { status: 'held', fineract_withdrawal_id: params[1], fineract_deposit_id: params[2], issuer_entry_ids: params[3], holder_entry_id: params[4] });
      return { rows: [] };
    }
    if (/^UPDATE bond_issuance_payments SET status = 'sent_to_bank'/.test(text)) { t.bond_issuance_payments.find(x => x.payment_id === params[0])!.status = 'sent_to_bank'; return { rows: [] }; }
    if (/^UPDATE bond_issuance_payments SET status = 'awaiting_external_funds'/.test(text)) { const p = t.bond_issuance_payments.find(x => x.payment_id === params[0])!; p.status = 'awaiting_external_funds'; p.intake_id = params[1]; return { rows: [] }; }
    if (/^UPDATE bond_issuance_payments SET status = 'failed'/.test(text)) { const p = t.bond_issuance_payments.find(x => x.payment_id === params[0])!; p.status = 'failed'; p.error_message = params[1]; return { rows: [] }; }
    if (/^UPDATE bond_issuance_payments SET status = 'funded'/.test(text)) {
      const p = t.bond_issuance_payments.find(x => x.intake_id === params[0] && x.status === 'awaiting_external_funds');
      if (p) p.status = 'funded'; return { rows: p ? [p] : [] };
    }
    if (/^SELECT \* FROM bond_issuance_payments WHERE payment_id/.test(text)) return { rows: t.bond_issuance_payments.filter(p => p.payment_id === params[0]) };
    if (/^SELECT status, COUNT/.test(text)) return { rows: [] };
    throw new Error('unexpected sql: ' + text.slice(0, 80));
  });
  return { t, query };
}

describe('BondIssuanceEngine — issuer -> holder P&I pipeline of record', () => {
  let s: ReturnType<typeof store>;
  const fin: Record<string, any> = {};
  let intakes: any[];
  let journals: any[];

  beforeEach(() => {
    s = store();
    vi.spyOn(pool, 'query').mockImplementation(s.query as any);
    fin.clients = {}; fin.savings = {}; fin.txns = []; fin.products = [{ id: 7, name: 'Existing' }]; fin.paymentTypes = []; let nextId = 100;
    vi.spyOn(FineractClient, 'findClientByExternalId').mockImplementation(async (ext: string) => fin.clients[ext] || null);
    vi.spyOn(FineractClient, 'createClient').mockImplementation(async ({ externalId }: any) => { const c = { id: ++nextId, externalId }; fin.clients[externalId] = c; return { clientId: c.id }; });
    vi.spyOn(FineractClient, 'listSavingsProducts').mockImplementation(async () => fin.products);
    vi.spyOn(FineractClient, 'createSavingsProduct').mockImplementation(async ({ name }: any) => { const p = { id: 7, name }; fin.products.push(p); return { resourceId: 7 }; });
    vi.spyOn(FineractClient, 'listPaymentTypes').mockImplementation(async () => fin.paymentTypes);
    vi.spyOn(FineractClient, 'createPaymentType').mockImplementation(async ({ name }: any) => { fin.paymentTypes.push({ id: 3, name }); return { resourceId: 3 }; });
    vi.spyOn(FineractClient, 'findSavingsAccountByExternalId').mockImplementation(async (ext: string) => fin.savings[ext] || null);
    vi.spyOn(FineractClient, 'createSavingsAccount').mockImplementation(async ({ externalId, productId }: any) => { const a = { id: ++nextId, externalId, accountNo: 'SA' + nextId, productId, status: { submittedAndPendingApproval: true }, summary: { accountBalance: 0 } }; fin.savings[externalId] = a; return { savingsId: a.id }; });
    vi.spyOn(FineractClient, 'commandSavingsAccount').mockImplementation(async (id: number, cmd: string) => { const a = Object.values(fin.savings).find((x: any) => x.id === id) as any; a.status = cmd === 'activate' ? { active: true } : { approved: true }; return {}; });
    vi.spyOn(FineractClient, 'getAccountBalance').mockImplementation(async (id: number) => Object.values(fin.savings).find((x: any) => x.id === id));
    vi.spyOn(FineractClient, 'withdrawSavings').mockImplementation(async (p: any) => { fin.txns.push({ kind: 'withdrawal', ...p }); return { resourceId: 9001 }; });
    vi.spyOn(FineractClient, 'depositSavings').mockImplementation(async (p: any) => { fin.txns.push({ kind: 'deposit', ...p }); return { resourceId: 9002 }; });
    vi.spyOn(FineractClient, 'healthCheck').mockResolvedValue({ ok: true });
    vi.spyOn(LiveBondEngine, 'getBondLiveMetrics').mockResolvedValue({ bond_name: 'DLB-IT-2026', coupon_per_period: 1250, next_coupon_date: '2026-10-01' });
    journals = [];
    vi.spyOn(DataBridge, '_ensureIssuerAccounts').mockResolvedValue(undefined);
    vi.spyOn(DataBridge, '_postCouponDue').mockImplementation(async (p: any) => { journals.push({ side: 'issuer_due', ...p }); return { entryId: 'JE-DUE' }; });
    vi.spyOn(DataBridge, '_postCouponPaid').mockImplementation(async (p: any) => { journals.push({ side: 'issuer_paid', ...p }); return { entryId: 'JE-PAID' }; });
    vi.spyOn(DataBridge, '_postCouponReceipt').mockImplementation(async (p: any) => { journals.push({ side: 'holder', ...p }); return { entryId: 'JE-REC' }; });
    intakes = [];
    vi.spyOn(StripePaymentIntakeEngine, 'createIncomePaymentLink').mockImplementation(async (p: any) => { intakes.push(p); return { intakeId: 'SPI-1', checkoutUrl: 'https://checkout.stripe.com/c/x', expiresAt: '2026-10-02T00:00:00Z' }; });
  });
  afterEach(() => vi.restoreAllMocks());

  it('provisions issuer and holder as Fineract clients with active savings accounts (idempotent)', async () => {
    const first = await BondIssuanceEngine.ensureParties();
    expect(first.issuer.name).toBe('DEANDREA LAVAR BARKLEY TRUST COMPANY');
    expect(first.issuer.einMasked).toBe('**-***1566');
    expect(first.issuer.fineract.active).toBe(true);
    expect(first.holder.fineract.active).toBe(true);
    expect((FineractClient.createSavingsAccount as any).mock.calls[0][0].productId).toBe(7);
    const again = await BondIssuanceEngine.ensureParties();
    expect((FineractClient.createClient as any).mock.calls.length).toBe(2);
    expect(again.issuer.fineract.accountId).toBe(first.issuer.fineract.accountId);
  });

  it('issues an active bond issuer -> holder and exposes the coupon schedule', async () => {
    const iss = await BondIssuanceEngine.issue({ bondId: 42, actor: 'admin' });
    expect(iss.status).toBe('issued');
    expect(iss.couponPerPeriod).toBe(1250);
    expect(iss.nextCouponDate).toBe('2026-10-01');
    expect(s.t.bond_issuances[0].issuer_external_id).toBe('issuer:dlb-trust-company');
    await expect(BondIssuanceEngine.issue({ bondId: 7 })).rejects.toMatchObject({ status: 404 });
  });

  it('books a due coupon: Fineract issuer withdrawal -> holder deposit, GL both sides, income HELD in the holder account', async () => {
    await BondIssuanceEngine.issue({ bondId: 42 });
    const p = await BondIssuanceEngine.payDue({ bondId: 42, actor: 'admin' });
    expect(p.amountUsd).toBe(1250);
    expect(p.periodDate).toBe('2026-10-01');
    expect(p.status).toBe('held');
    expect(intakes).toHaveLength(0);
    expect(p.fineractWithdrawalId).toBe('9001');
    expect(p.fineractDepositId).toBe('9002');
    expect(fin.txns.map(t => t.kind)).toEqual(['withdrawal', 'deposit']);
    expect(fin.txns[0].accountId).toBe(s.t.bond_issuance_parties.find(r => r.role === 'issuer')!.fineract_account_id);
    expect(fin.txns[1].accountId).toBe(s.t.bond_issuance_parties.find(r => r.role === 'holder')!.fineract_account_id);
    expect(journals.map(j => j.side)).toEqual(['issuer_due', 'issuer_paid', 'holder']);
    expect(journals[2]).toMatchObject({ referenceType: 'coupon_payment', referenceId: p.paymentId, amount: 1250 });
    expect(p.next).toMatch(/held in the holder Fineract account/);
  });

  it('send-to-bank converts a held payment to fiat: plans Lili distributions from the holder journal, execution stays maker/checker', async () => {
    await BondIssuanceEngine.issue({ bondId: 42 });
    const p = await BondIssuanceEngine.payDue({ bondId: 42 });
    const plan = vi.spyOn(FixedIncomeDistributionEngine, 'plan').mockResolvedValue({ planned: 1 });
    vi.spyOn(FixedIncomeDistributionEngine, 'list').mockResolvedValue([{ distributionId: 'FID-1', sourceEntryId: 'JE-REC', amountUsd: 1250, status: 'planned' }, { distributionId: 'FID-0', sourceEntryId: 'JE-OTHER' }]);
    const r = await BondIssuanceEngine.sendToBank({ paymentId: p.paymentId, actor: 'trustee' });
    expect(plan).toHaveBeenCalledWith({ createdBy: 'trustee' });
    expect(r.status).toBe('sent_to_bank');
    expect(r.distributions.map(d => d.distributionId)).toEqual(['FID-1']);
    expect(r.next).toMatch(/approvalRef, screeningRef/);
    await expect(BondIssuanceEngine.sendToBank({ paymentId: p.paymentId })).rejects.toMatchObject({ code: 'NOT_HELD' });
  });

  it('fund-external is optional: opens a Stripe income intake keyed to the payment', async () => {
    await BondIssuanceEngine.issue({ bondId: 42 });
    const p = await BondIssuanceEngine.payDue({ bondId: 42 });
    const f = await BondIssuanceEngine.fundExternal({ paymentId: p.paymentId });
    expect(f.status).toBe('awaiting_external_funds');
    expect(intakes[0]).toMatchObject({ amountCents: 125000, purpose: 'coupon_income', reference: p.paymentId });
    expect(f.intake.checkoutUrl).toMatch(/checkout\.stripe\.com/);
  });

  it('is idempotent per bond/kind/period and refuses when parties are not provisioned', async () => {
    await BondIssuanceEngine.issue({ bondId: 42 });
    await BondIssuanceEngine.payDue({ bondId: 42 });
    await expect(BondIssuanceEngine.payDue({ bondId: 42 })).rejects.toMatchObject({ code: 'DUPLICATE' });
    expect(fin.txns.length).toBe(2);
    s.t.bond_issuance_parties = [];
    await expect(BondIssuanceEngine.payDue({ bondId: 42, periodDate: '2027-01-01' })).rejects.toMatchObject({ code: 'PARTIES_NOT_PROVISIONED' });
  });

  it('fails closed when the Fineract issuer withdrawal fails: no deposit, no GL, no intake', async () => {
    await BondIssuanceEngine.issue({ bondId: 42 });
    (FineractClient.withdrawSavings as any).mockRejectedValueOnce(new Error('Insufficient account balance'));
    await expect(BondIssuanceEngine.payDue({ bondId: 42 })).rejects.toMatchObject({ code: 'FINERACT_WITHDRAWAL_FAILED', status: 502 });
    expect(fin.txns.length).toBe(0);
    expect(journals.length).toBe(0);
    expect(intakes.length).toBe(0);
    expect(s.t.bond_issuance_payments[0].status).toBe('failed');
    const retry = await BondIssuanceEngine.payDue({ bondId: 42 });
    expect(retry.status).toBe('held');
  });

  it('with BOND_ISSUANCE_AUTO_INTAKE the booking survives an intake failure; webhook receipt marks funded', async () => {
    process.env.BOND_ISSUANCE_AUTO_INTAKE = 'true';
    await BondIssuanceEngine.issue({ bondId: 42 });
    (StripePaymentIntakeEngine.createIncomePaymentLink as any).mockRejectedValueOnce(new Error('stripe intake disabled'));
    const p = await BondIssuanceEngine.payDue({ bondId: 42 });
    expect(p.status).toBe('held');
    expect(p.intakeError).toMatch(/stripe intake disabled/);
    const q = await BondIssuanceEngine.payDue({ bondId: 42, periodDate: '2027-01-01' });
    expect(q.status).toBe('awaiting_external_funds');
    delete process.env.BOND_ISSUANCE_AUTO_INTAKE;
    expect(await BondIssuanceEngine.markFunded('SPI-1')).toMatchObject({ paymentId: q.paymentId, status: 'funded' });
    expect(await BondIssuanceEngine.markFunded('SPI-1')).toBeNull();
  });

  it('runDue books only issued bonds whose coupon date has arrived', async () => {
    await BondIssuanceEngine.issue({ bondId: 42 });
    expect((await BondIssuanceEngine.runDue({ asOf: '2026-09-30' })).results).toEqual([]);
    const r = await BondIssuanceEngine.runDue({ asOf: '2026-10-01' });
    expect(r.results).toHaveLength(1);
    expect(r.results[0].ok).toBe(true);
  });

  it('status reports readiness and the pipeline', async () => {
    const before = await BondIssuanceEngine.status();
    expect(before.ready).toBe(false);
    expect(before.issues).toContain('issuer Fineract account not provisioned');
    await BondIssuanceEngine.ensureParties();
    const after = await BondIssuanceEngine.status();
    expect(after.ready).toBe(true);
    expect(after.parties.issuer.fineract.accountNo).toMatch(/^SA/);
    expect(after.pipeline).toMatch(/held, account of record.*Lili direct deposit$/);
  });

  it('creates the savings product and payment type once when Fineract has none', async () => {
    delete process.env.FINERACT_SAVINGS_PRODUCT_ID;
    fin.products = [];
    await BondIssuanceEngine.ensureParty('issuer');
    await BondIssuanceEngine.ensureParty('holder');
    expect(fin.products).toHaveLength(1);
    expect(fin.products[0].name).toBe('Trust Account of Record (USD)');
    expect(Object.values(fin.savings).every((a: any) => a.productId === 7)).toBe(true);
    expect(await BondIssuanceEngine.ensurePaymentType()).toBe(3);
    expect(await BondIssuanceEngine.ensurePaymentType()).toBe(3);
    expect(fin.paymentTypes).toHaveLength(1);
  });
});
