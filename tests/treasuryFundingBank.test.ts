import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pool = require('../server/integrations/bonds/pgPool');
const { TreasuryFundingBankEngine } = require('../server/integrations/payments/treasuryFundingBankEngine');
const { StripePaymentIntakeEngine } = require('../server/integrations/payments/stripePaymentIntakeEngine');
const { SettlementBankRegistry } = require('../server/integrations/payments/settlementBankRegistry');

const saved = { ...process.env };
type Row = Record<string, any>;

function db() {
  const rows: Record<string, Row> = {};
  const intakes: Row[] = [];
  const query = vi.fn(async (sql: any, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^CREATE/.test(text)) return { rows: [] };
    if (/^SELECT \* FROM treasury_funding_bank/.test(text)) return { rows: rows[params[0]] ? [rows[params[0]]] : [] };
    if (/^INSERT INTO treasury_funding_bank/.test(text)) {
      const cols = text.match(/\(bank_id, ([^)]+)\)/)![1].split(', ');
      const patch: Row = {};
      cols.forEach((c, i) => { patch[c] = c === 'metadata' ? JSON.parse(params[i + 1]) : params[i + 1]; });
      rows[params[0]] = { ...(rows[params[0]] || { bank_id: params[0], verification: 'unlinked' }), ...patch };
      return { rows: [rows[params[0]]] };
    }
    if (/^INSERT INTO stripe_payment_intakes/.test(text)) { intakes.push({ intake_id: params[0], payment_intent_id: params[1], amount_cents: params[4], status: params[6], purpose: params[11], reference: params[10] }); return { rows: [] }; }
    if (/FROM stripe_payment_intakes WHERE intake_id/.test(text)) { const r = intakes.find((i) => i.intake_id === params[0]); return { rows: r ? [r] : [] }; }
    throw new Error('unexpected sql: ' + text.slice(0, 80));
  });
  return { rows, intakes, query };
}

const PM = { id: 'pm_bett', us_bank_account: { last4: '4321', fingerprint: 'fp1', bank_name: 'NBKC BANK' } };
const SI_OK = { id: 'seti_1', status: 'succeeded', mandate: 'mandate_1' };
const SI_MICRO = { id: 'seti_1', status: 'requires_action', mandate: 'mandate_1', next_action: { type: 'verify_with_microdeposits', verify_with_microdeposits: { microdeposit_type: 'descriptor_code', arrival_date: 1_800_000_000 } } };

function mockStripe({ si = SI_OK, pi = null }: { si?: any; pi?: any } = {}) {
  const client = {
    paymentMethods: { create: vi.fn().mockResolvedValue(PM) },
    setupIntents: {
      create: vi.fn().mockResolvedValue(si),
      verifyMicrodeposits: vi.fn().mockResolvedValue(SI_OK),
      retrieve: vi.fn().mockResolvedValue(si),
    },
    paymentIntents: { create: vi.fn().mockResolvedValue(pi || { id: 'pi_pull', status: 'processing' }) },
  };
  vi.spyOn(TreasuryFundingBankEngine, '_client').mockReturnValue(client);
  vi.spyOn(StripePaymentIntakeEngine, '_ensureCustomer').mockResolvedValue({ id: 'cus_trust' });
  const register = vi.spyOn(SettlementBankRegistry, 'register').mockResolvedValue({ bankId: 'betterment', provider: 'stripe_payout' });
  return { client, register };
}

describe('TreasuryFundingBankEngine — Betterment Checking as the trust company funding (originating) bank', () => {
  let d: ReturnType<typeof db>;
  beforeEach(() => {
    process.env.TREASURY_BANK_ENABLED = 'true';
    process.env.TREASURY_BANK_ID = 'betterment';
    process.env.STRIPE_PAYMENTS_SECRET_KEY = 'sk_live_unit';
    process.env.BETTERMENT_ROUTING_NUMBER = '101019644';
    process.env.BETTERMENT_ACCOUNT_NUMBER = '000987654321';
    process.env.TREASURY_BANK_ACCOUNT_HOLDER = 'DEANDREA LAVAR BARKLEY TRUST COMPANY';
    delete process.env.TREASURY_BANK_ROUTING_NUMBER;
    delete process.env.TREASURY_BANK_ACCOUNT_NUMBER;
    d = db();
    vi.spyOn(pool, 'query').mockImplementation(d.query as any);
  });
  afterEach(() => { vi.restoreAllMocks(); process.env = { ...saved }; });

  it('reads the Betterment secrets, exposes only last4, and is not ready until linked', async () => {
    const st = await TreasuryFundingBankEngine.status();
    expect(st.ready).toBe(false);
    expect(st.issues).toEqual(expect.arrayContaining([expect.stringMatching(/not linked/)]));
    expect(st.bank).toMatchObject({ bankId: 'betterment', role: 'originating_bank', accountNumberMasked: '****4321', routingNumberMasked: '*****9644', verification: 'unlinked' });
    expect(JSON.stringify(st)).not.toContain('000987654321');
    expect(JSON.stringify(st)).not.toContain('101019644');
  });

  it('fails closed without the routing/account secrets or a live key', async () => {
    delete process.env.BETTERMENT_ACCOUNT_NUMBER;
    process.env.STRIPE_PAYMENTS_SECRET_KEY = 'sk_test_unit';
    const st = await TreasuryFundingBankEngine.status();
    expect(st.issues).toEqual(expect.arrayContaining([expect.stringMatching(/ACCOUNT_NUMBER not configured/), 'Stripe key is not live-mode']));
    await expect(TreasuryFundingBankEngine.link({})).rejects.toMatchObject({ status: 503, code: 'BANK_NOT_CONFIGURED' });
  });

  it('links the account as a company us_bank_account under an off-session mandate and registers it as a stripe_payout destination when verified instantly', async () => {
    const { client, register } = mockStripe();
    const out = await TreasuryFundingBankEngine.link({ acceptedBy: 'trustee', ipAddress: '1.2.3.4', userAgent: 'ua' });
    expect(out).toMatchObject({ verification: 'verified', paymentMethodId: 'pm_bett', mandateId: 'mandate_1', customerId: 'cus_trust', stripeStatus: 'succeeded' });
    expect(client.paymentMethods.create.mock.calls[0][0]).toMatchObject({ type: 'us_bank_account', us_bank_account: { account_holder_type: 'company', account_type: 'checking', routing_number: '101019644', account_number: '000987654321' } });
    expect(client.setupIntents.create.mock.calls[0][0]).toMatchObject({ customer: 'cus_trust', payment_method: 'pm_bett', usage: 'off_session', confirm: true, mandate_data: { customer_acceptance: { type: 'online' } } });
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ bankId: 'betterment', provider: 'stripe_payout', routingNumber: '101019644', accountNumber: '000987654321' }));
    expect(JSON.stringify(out)).not.toContain('000987654321');
    const st = await TreasuryFundingBankEngine.status();
    expect(st.ready).toBe(true);
  });

  it('records requires_microdeposits, stays not-ready, then verifies with the descriptor code', async () => {
    const { client, register } = mockStripe({ si: SI_MICRO });
    const linked = await TreasuryFundingBankEngine.link({});
    expect(linked.verification).toBe('requires_microdeposits');
    expect(linked.nextAction).toMatch(/descriptor_code/);
    expect(register).not.toHaveBeenCalled();
    expect((await TreasuryFundingBankEngine.status()).issues).toEqual(expect.arrayContaining([expect.stringMatching(/mandate requires_microdeposits/)]));
    await expect(TreasuryFundingBankEngine.verify({})).rejects.toMatchObject({ status: 400 });
    const v = await TreasuryFundingBankEngine.verify({ descriptorCode: 'sm11aa' });
    expect(client.setupIntents.verifyMicrodeposits).toHaveBeenCalledWith('seti_1', { descriptor_code: 'SM11AA' });
    expect(v.verification).toBe('verified');
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('refuses readiness when the linked last4 differs from the configured account', async () => {
    mockStripe();
    await TreasuryFundingBankEngine.link({});
    process.env.BETTERMENT_ACCOUNT_NUMBER = '000000009999';
    const st = await TreasuryFundingBankEngine.status();
    expect(st.ready).toBe(false);
    expect(st.issues).toEqual(expect.arrayContaining([expect.stringMatching(/\*\*\*\*4321 differs from configured \*\*\*\*9999/)]));
  });

  it('pull() originates an idempotent off-session ACH debit and records a processing intake, never marking it received', async () => {
    const { client } = mockStripe();
    await TreasuryFundingBankEngine.link({});
    const out = await TreasuryFundingBankEngine.pull({ amountCents: 100, reference: 'BIP-C:1', bondPaymentId: 'BIP-C', destinationBankId: 'lili' });
    expect(out).toMatchObject({ paymentIntentId: 'pi_pull', stripeStatus: 'processing' });
    expect(out.intake).toMatchObject({ status: 'processing', amountCents: 100, purpose: 'trust_income' });
    const [params, opts] = client.paymentIntents.create.mock.calls[0];
    expect(params).toMatchObject({ amount: 100, currency: 'usd', customer: 'cus_trust', payment_method: 'pm_bett', confirm: true, off_session: true, mandate: 'mandate_1', payment_method_types: ['us_bank_account'] });
    expect(params.metadata).toMatchObject({ funding_bank_id: 'betterment', bond_payment_id: 'BIP-C', destination: 'settlement_bank:lili' });
    expect(opts.idempotencyKey).toBe('tfb-pull-betterment-BIP-C:1');
  });

  it('pull() fails closed while unlinked or on a bad amount', async () => {
    await expect(TreasuryFundingBankEngine.pull({ amountCents: 100, reference: 'x' })).rejects.toMatchObject({ status: 503, code: 'TREASURY_BANK_NOT_READY' });
    mockStripe();
    await TreasuryFundingBankEngine.link({});
    await expect(TreasuryFundingBankEngine.pull({ amountCents: 10, reference: 'x' })).rejects.toMatchObject({ status: 400 });
    await expect(TreasuryFundingBankEngine.pull({ amountCents: 100 })).rejects.toMatchObject({ status: 400 });
  });
});
