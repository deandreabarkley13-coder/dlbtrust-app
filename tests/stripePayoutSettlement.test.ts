import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pool = require('../server/integrations/bonds/pgPool');
const { StripePayoutSettlementOriginator } = require('../server/integrations/payments/stripePayoutSettlementOriginator');
const { SettlementBankRegistry } = require('../server/integrations/payments/settlementBankRegistry');
const { BankSettlementEngine } = require('../server/integrations/payments/bankSettlementEngine');

const saved = { ...process.env };
const BANK = { bankId: 'betterment', provider: 'stripe_payout', name: 'Betterment Checking', accountName: 'DEANDREA LAVAR BARKLEY TRUST COMPANY', routingNumber: '101019644', rail: 'ach', enabled: true, metadata: {}, _account: '000987654321' };
const EA = { id: 'ba_bett', object: 'bank_account', last4: '4321', routing_number: '101019644', bank_name: 'NBKC BANK', status: 'new', default_for_currency: false };
const OTHER = { id: 'ba_lili', object: 'bank_account', last4: '2959', routing_number: '091017138' };
const ACCT = { id: 'acct_live', payouts_enabled: true, business_profile: { name: 'TRUST' } };
const BAL = { livemode: true, available: [{ currency: 'usd', amount: 500 }], pending: [] };

function mockStripe({ externals = [OTHER, EA], bal = BAL, acct = ACCT, payout = null } = {}) {
  const create = vi.fn().mockResolvedValue(payout || { id: 'po_1', status: 'pending', method: 'standard', arrival_date: 1_800_000_000 });
  const createExternalAccount = vi.fn().mockResolvedValue({ ...EA, id: 'ba_new' });
  const client = {
    accounts: {
      retrieve: vi.fn().mockResolvedValue(acct),
      listExternalAccounts: vi.fn().mockImplementation(() => (async function* () { for (const ea of externals) yield ea; })()),
      retrieveExternalAccount: vi.fn().mockImplementation(async (_a: string, id: string) => externals.find((e) => e.id === id)),
      createExternalAccount,
    },
    balance: { retrieve: vi.fn().mockResolvedValue(bal) },
    payouts: { create },
  };
  vi.spyOn(StripePayoutSettlementOriginator, '_client').mockReturnValue(client);
  return { create, createExternalAccount };
}

describe('StripePayoutSettlementOriginator — Stripe balance → ACH credit into any registered settlement bank', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_unit';
    vi.spyOn(pool, 'query').mockResolvedValue({ rows: [] });
  });
  afterEach(() => { vi.restoreAllMocks(); process.env = { ...saved }; });

  it('is ready when the bank is registered on Stripe as a payout external account', async () => {
    mockStripe();
    const st = await StripePayoutSettlementOriginator.status(BANK);
    expect(st).toMatchObject({ ready: true, channel: 'stripe_payout', keyMode: 'live', bankId: 'betterment' });
    expect(st.externalAccount).toMatchObject({ id: 'ba_bett', last4: '4321' });
    expect(st.balance.availableCents).toBe(500);
    expect(st.destination).toEqual({ name: BANK.accountName, routingNumber: '101019644', accountLast4: '4321' });
    expect(JSON.stringify(st)).not.toContain('000987654321');
  });

  it('is not ready when the bank is unregistered on Stripe, and registers it (idempotently) only on send', async () => {
    const { createExternalAccount, create } = mockStripe({ externals: [OTHER] });
    const st = await StripePayoutSettlementOriginator.status(BANK);
    expect(st.ready).toBe(false);
    expect(st.issues[0]).toMatch(/not a registered external \(payout\) bank account/);
    expect(createExternalAccount).not.toHaveBeenCalled();
    const r = await StripePayoutSettlementOriginator.send(BANK, { amountCents: 100, reference: 'REF-1' });
    expect(createExternalAccount.mock.calls[0][1].external_account).toMatchObject({ routing_number: '101019644', account_number: '000987654321', account_holder_type: 'company' });
    expect(createExternalAccount.mock.calls[0][2]).toEqual({ idempotencyKey: 'sps-ea-betterment-101019644-4321' });
    expect(create.mock.calls[0][0].destination).toBe('ba_new');
    expect(r.status).toBe('originated');
  });

  it('fails closed on a test key, disabled payouts, or an ambiguous last4 match', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_unit';
    mockStripe({ bal: { ...BAL, livemode: false }, acct: { ...ACCT, payouts_enabled: false }, externals: [EA, { ...EA, id: 'ba_dup' }] });
    const st = await StripePayoutSettlementOriginator.status(BANK);
    expect(st.ready).toBe(false);
    expect(st.issues).toEqual(expect.arrayContaining([
      expect.stringMatching(/test-mode key/), 'Stripe account payouts are not enabled', expect.stringMatching(/2 Stripe external accounts end \*\*\*\*4321/),
    ]));
    await expect(StripePayoutSettlementOriginator.send(BANK, { amountCents: 1, reference: 'r' })).rejects.toMatchObject({ code: 'STRIPE_PAYOUT_NOT_READY' });
  });

  it('refuses a payout above the available Stripe balance', async () => {
    const { create } = mockStripe();
    await expect(StripePayoutSettlementOriginator.send(BANK, { amountCents: 501, reference: 'r' })).rejects.toMatchObject({ status: 409, code: 'STRIPE_PAYOUT_INSUFFICIENT_BALANCE' });
    expect(create).not.toHaveBeenCalled();
  });

  it('creates an idempotent ACH payout and reports originated (not settled) with the expected arrival', async () => {
    const { create } = mockStripe();
    const r = await StripePayoutSettlementOriginator.send(BANK, { amountCents: 100, reference: 'BIP-C:1', description: 'coupon' });
    expect(create.mock.calls[0][0]).toMatchObject({ amount: 100, currency: 'usd', destination: 'ba_bett', method: 'standard', metadata: { dlb_bank_id: 'betterment', reference: 'BIP-C:1', direction: 'treasury_to_betterment' } });
    expect(create.mock.calls[0][1]).toEqual({ idempotencyKey: 'sps-betterment-BIP-C:1' });
    expect(r).toMatchObject({ status: 'originated', network: 'ach', payoutId: 'po_1', stripeStatus: 'pending', expectedArrival: '2027-01-15' });
  });

  it('surfaces a failed payout', async () => {
    mockStripe({ payout: { id: 'po_f', status: 'failed', failure_message: 'account_closed' } });
    await expect(StripePayoutSettlementOriginator.send(BANK, { amountCents: 1, reference: 'r' })).rejects.toMatchObject({ status: 502, code: 'STRIPE_PAYOUT_FAILED' });
  });
});

describe('BankSettlementEngine — stripe_payout provider', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_unit';
    vi.spyOn(pool, 'query').mockResolvedValue({ rows: [] });
    vi.spyOn(SettlementBankRegistry, 'resolve').mockResolvedValue(BANK);
  });
  afterEach(() => { vi.restoreAllMocks(); process.env = { ...saved }; });

  it('is registered as a provider and treated as live (maker/checker + screening required)', async () => {
    expect(SettlementBankRegistry.PROVIDERS).toContain('stripe_payout');
    await expect(BankSettlementEngine.clearAndSettle({ bankId: 'betterment', amountCents: 100 })).rejects.toMatchObject({ status: 409 });
  });

  it('readiness delegates to the Stripe payout originator', async () => {
    mockStripe();
    const r = await BankSettlementEngine.readiness('betterment');
    expect(r.ready).toBe(true);
    expect(r.live).toBe(true);
    expect(r.externalAccount.id).toBe('ba_bett');
    expect(r.balance.availableCents).toBe(500);
  });

  it('dispatches the settlement to a Stripe payout and journals it as originated', async () => {
    const { create } = mockStripe();
    const out = await BankSettlementEngine.clearAndSettle({ bankId: 'betterment', amountCents: 100, approvalRef: 'MC-1', screeningRef: 'SCR-1', reference: 'BIP-C:1', description: 'send-to-bank' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ bankId: 'betterment', provider: 'stripe_payout', rail: 'ach', live: true, status: 'originated', providerReference: 'po_1', providerStatus: 'pending' });
  });

  it('records the failure when the Stripe balance is short', async () => {
    mockStripe();
    await expect(BankSettlementEngine.clearAndSettle({ bankId: 'betterment', amountCents: 10000, approvalRef: 'MC-1', screeningRef: 'SCR-1' })).rejects.toMatchObject({ code: 'STRIPE_PAYOUT_INSUFFICIENT_BALANCE', settlementStatus: 'failed' });
  });
});
