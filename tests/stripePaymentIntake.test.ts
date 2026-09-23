import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { StripePaymentIntakeEngine } = require('../server/integrations/payments/stripePaymentIntakeEngine');

const saved = { ...process.env };
const ACCT = { id: 'acct_live', charges_enabled: true, business_profile: { name: 'TRUST' }, capabilities: { card_payments: 'active', us_bank_account_ach_payments: 'active' } };

function mockStripe({ acct = ACCT, event = null } = {}) {
  vi.spyOn(StripePaymentIntakeEngine, '_insert').mockResolvedValue(undefined);
  vi.spyOn(StripePaymentIntakeEngine, '_byPaymentIntent').mockResolvedValue(null);
  const postDeposit = vi.spyOn(StripePaymentIntakeEngine, '_postDeposit').mockResolvedValue('DEP-1');
  const piCreate = vi.fn().mockResolvedValue({ id: 'pi_1', client_secret: 'pi_1_secret', status: 'requires_payment_method' });
  const csCreate = vi.fn().mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1', payment_intent: null, expires_at: 1_800_000_000 });
  const search = vi.fn().mockResolvedValue({ data: [] });
  const custCreate = vi.fn().mockResolvedValue({ id: 'cus_1' });
  const listTaxIds = vi.fn().mockResolvedValue({ data: [] });
  const createTaxId = vi.fn().mockResolvedValue({ id: 'txi_1', type: 'us_ein' });
  const constructEvent = vi.fn().mockImplementation((_body: unknown, sig: string) => {
    if (sig !== 'good') throw new Error('No signatures found matching the expected signature for payload');
    return event;
  });
  const client = {
    accounts: { retrieve: vi.fn().mockResolvedValue(acct) },
    paymentIntents: { create: piCreate },
    checkout: { sessions: { create: csCreate } },
    customers: { search, create: custCreate, listTaxIds, createTaxId },
    webhooks: { constructEvent },
  };
  vi.spyOn(StripePaymentIntakeEngine, '_client').mockReturnValue(client);
  return { piCreate, csCreate, search, custCreate, listTaxIds, createTaxId, constructEvent, postDeposit };
}

describe('StripePaymentIntakeEngine', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'rk_live_x';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
    process.env.STRIPE_INTAKE_RETURN_URL = 'https://app.example';
    delete process.env.STRIPE_INTAKE_PAYMENT_METHODS;
  });
  afterEach(() => { vi.restoreAllMocks(); process.env = { ...saved }; });

  it('status is ready only with a live key, webhook secret, charges enabled and active capabilities', async () => {
    mockStripe();
    expect((await StripePaymentIntakeEngine.status()).ready).toBe(true);
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    let st = await StripePaymentIntakeEngine.status();
    expect(st.ready).toBe(false);
    expect(st.issues.join(' ')).toMatch(/test mode/);
    process.env.STRIPE_SECRET_KEY = 'rk_live_x';
    delete process.env.STRIPE_WEBHOOK_SECRET;
    st = await StripePaymentIntakeEngine.status();
    expect(st.issues.join(' ')).toMatch(/STRIPE_WEBHOOK_SECRET/);
    vi.restoreAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
    mockStripe({ acct: { ...ACCT, capabilities: { card_payments: 'active', us_bank_account_ach_payments: 'inactive' } } });
    st = await StripePaymentIntakeEngine.status();
    expect(st.ready).toBe(false);
    expect(st.issues.join(' ')).toMatch(/us_bank_account is inactive/);
  });

  it('createPaymentIntent creates/reuses the payer customer and tags the intent for Lili', async () => {
    const m = mockStripe();
    const r = await StripePaymentIntakeEngine.createPaymentIntent({ amountCents: 2500, payerEmail: 'payer@example.com', payerName: 'Payer', reference: 'FUND-1', paymentMethodTypes: ['us_bank_account'] });
    expect(m.custCreate).toHaveBeenCalled();
    const [params, opts] = m.piCreate.mock.calls[0];
    expect(params).toMatchObject({ amount: 2500, currency: 'usd', payment_method_types: ['us_bank_account'], customer: 'cus_1' });
    expect(params.metadata).toMatchObject({ reference: 'FUND-1', destination: 'lili_direct_deposit' });
    expect(params.metadata.dlb_intake_id).toBe(r.intakeId);
    expect(opts.idempotencyKey).toBe(`spi-${r.intakeId}`);
    expect(r.clientSecret).toBe('pi_1_secret');
    expect(r.paymentIntentId).toBe('pi_1');
  });

  it('rejects bad amounts, non-USD and disabled payment methods', async () => {
    mockStripe();
    await expect(StripePaymentIntakeEngine.createPaymentIntent({ amountCents: 10 })).rejects.toMatchObject({ status: 400 });
    await expect(StripePaymentIntakeEngine.createPaymentIntent({ amountCents: 100, currency: 'eur' })).rejects.toMatchObject({ status: 400 });
    process.env.STRIPE_INTAKE_PAYMENT_METHODS = 'card';
    await expect(StripePaymentIntakeEngine.createPaymentIntent({ amountCents: 100, paymentMethodTypes: ['us_bank_account'] })).rejects.toThrow(/not enabled/);
  });

  it('createCheckoutLink returns the hosted URL and carries the intake id as client_reference_id', async () => {
    const m = mockStripe();
    const r = await StripePaymentIntakeEngine.createCheckoutLink({ amountCents: 5000, purpose: 'trust_funding' });
    expect(r.checkoutUrl).toBe('https://checkout.stripe.com/c/pay/cs_1');
    const [params] = m.csCreate.mock.calls[0];
    expect(params).toMatchObject({ mode: 'payment', client_reference_id: r.intakeId, success_url: expect.stringContaining('https://app.example/') });
    expect(params.line_items[0].price_data.unit_amount).toBe(5000);
    expect(params.payment_intent_data.metadata.destination).toBe('lili_direct_deposit');
  });

  it('createIncomePaymentLink bills the configured obligor (Stripe customer + EIN tax id) for the bond coupon via ACH debit', async () => {
    process.env.INCOME_OBLIGOR_NAME = 'DEANDREA LAVAR BARKLEY TRUST COMPANY';
    process.env.INCOME_OBLIGOR_EIN = '99-6411566';
    process.env.INCOME_OBLIGOR_EMAIL = 'tc@example.org';
    const m = mockStripe();
    const { CouponService } = require('../server/integrations/bonds/couponService');
    vi.spyOn(CouponService, 'getCouponSchedule').mockResolvedValue({ bond_name: 'Series A', coupon_per_period: 1234.56, next_coupon_date: '2026-10-01T00:00:00Z' });
    expect(StripePaymentIntakeEngine.incomeObligor()).toMatchObject({ configured: true, einMasked: '**-***1566', issues: [] });
    const r = await StripePaymentIntakeEngine.createIncomePaymentLink({ bondId: 7 });
    expect(r).toMatchObject({ amountCents: 123456, purpose: 'coupon_income', reference: 'BOND-7-COUPON_INCOME-2026-10-01', payerName: 'DEANDREA LAVAR BARKLEY TRUST COMPANY', paymentMethodTypes: ['us_bank_account'] });
    expect(m.search.mock.calls[0][0].query).toContain("metadata['payer_id']:'income-obligor'");
    expect(m.custCreate.mock.calls[0][0]).toMatchObject({ name: 'DEANDREA LAVAR BARKLEY TRUST COMPANY', email: 'tc@example.org' });
    expect(m.createTaxId).toHaveBeenCalledWith('cus_1', { type: 'us_ein', value: '99-6411566' });
    expect(m.csCreate.mock.calls[0][0].customer).toBe('cus_1');
    await expect(StripePaymentIntakeEngine.createIncomePaymentLink({ amountCents: 100, purpose: 'gift' })).rejects.toMatchObject({ status: 400 });
    delete process.env.INCOME_OBLIGOR_NAME;
    await expect(StripePaymentIntakeEngine.createIncomePaymentLink({ amountCents: 100 })).rejects.toMatchObject({ code: 'INCOME_OBLIGOR_NOT_CONFIGURED' });
  });

  it('webhook rejects bad signatures and test-mode events, records deposit on payment_intent.succeeded', async () => {
    const event = { id: 'evt_1', type: 'payment_intent.succeeded', livemode: true, data: { object: { id: 'pi_1', amount_received: 2500, metadata: { dlb_intake_id: 'SPI-1', reference: 'FUND-1' } } } };
    const m = mockStripe({ event });
    await expect(StripePaymentIntakeEngine.handleWebhook('{}', 'bad')).rejects.toMatchObject({ status: 400, code: 'BAD_SIGNATURE' });
    expect(m.postDeposit).not.toHaveBeenCalled();
    const r = await StripePaymentIntakeEngine.handleWebhook('{}', 'good');
    expect(r).toMatchObject({ received: true, paymentIntentId: 'pi_1', amountCents: 2500, depositOrderId: 'DEP-1' });
    expect(m.postDeposit.mock.calls[0][0]).toMatchObject({ amount: 25, cashAccountId: 'CA-STRIPE-BALANCE', externalReference: 'pi_1', initiatedBy: 'stripe_webhook' });
    vi.restoreAllMocks();
    mockStripe({ event: { ...event, livemode: false } });
    await expect(StripePaymentIntakeEngine.handleWebhook('{}', 'good')).rejects.toThrow(/test-mode event/);
    delete process.env.STRIPE_WEBHOOK_SECRET;
    await expect(StripePaymentIntakeEngine.handleWebhook('{}', 'good')).rejects.toMatchObject({ status: 503 });
  });

  it('webhook is idempotent for an already-received intent and ignores unrelated events', async () => {
    const event = { id: 'evt_2', type: 'payment_intent.succeeded', livemode: true, data: { object: { id: 'pi_1', amount_received: 2500, metadata: {} } } };
    mockStripe({ event });
    vi.spyOn(StripePaymentIntakeEngine, '_byPaymentIntent').mockResolvedValue({ intake_id: 'SPI-1', payment_intent_id: 'pi_1', status: 'received', amount_cents: 2500 });
    expect(await StripePaymentIntakeEngine.handleWebhook('{}', 'good')).toMatchObject({ received: true, duplicate: true });
    expect(StripePaymentIntakeEngine._postDeposit).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    mockStripe({ event: { id: 'evt_3', type: 'customer.created', livemode: true, data: { object: {} } } });
    expect(await StripePaymentIntakeEngine.handleWebhook('{}', 'good')).toMatchObject({ received: false, ignored: true });
  });
});
