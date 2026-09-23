import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { LiliStripePayoutOriginator } = require('../server/integrations/payments/liliStripePayoutOriginator');
const { LiliSettlementBankEngine } = require('../server/integrations/payments/liliSettlementBankEngine');
const { LiliDirectDepositEngine } = require('../server/integrations/payments/liliDirectDepositEngine');

const saved = { ...process.env };
const DEST = { configured: true, routingNumber: '121145307', accountNumberMasked: '****2959', accountName: 'DB NET MGMT LLC', _account: '692101092959' };
const BA = { id: 'ba_lili', object: 'bank_account', last4: '2959', routing_number: '091017138', bank_name: 'SUN RISE BANKS, NATIONAL ASSOCIATION', status: 'new', default_for_currency: true };
const ACCT = { id: 'acct_live', payouts_enabled: true, business_profile: { name: 'TRUST' }, external_accounts: { data: [BA, { id: 'ba_other', object: 'bank_account', last4: '1234' }] } };
const BAL = { livemode: true, available: [{ currency: 'usd', amount: 500 }], pending: [{ currency: 'usd', amount: 0 }] };

function mockStripe({ acct = ACCT, bal = BAL, payout = null } = {}) {
  vi.spyOn(LiliDirectDepositEngine, 'getDestination').mockResolvedValue(DEST);
  const create = vi.fn().mockResolvedValue(payout || { id: 'po_1', status: 'pending', method: 'standard', arrival_date: 1_800_000_000 });
  const client = {
    accounts: { retrieve: vi.fn().mockResolvedValue(acct) },
    balance: { retrieve: vi.fn().mockResolvedValue(bal) },
    payouts: { create },
  };
  vi.spyOn(LiliStripePayoutOriginator, '_client').mockReturnValue(client);
  return { create };
}

describe('LiliStripePayoutOriginator', () => {
  beforeEach(() => {
    process.env.LILI_CLEARING_LIVE = 'true';
    process.env.LILI_ORIGINATOR = 'stripe_payout';
    process.env.LILI_DD_ROUTING_NUMBER = '121145307';
    process.env.LILI_DD_ACCOUNT_NUMBER = '692101092959';
    process.env.STRIPE_SECRET_KEY = 'sk_live_unit_test';
    delete process.env.STRIPE_PAYOUT_EXTERNAL_ACCOUNT_ID;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  it('is ready with a live key, payouts enabled and Lili registered as the external account', async () => {
    mockStripe();
    const st = await LiliStripePayoutOriginator.status();
    expect(st).toMatchObject({ ready: true, keyMode: 'live', method: 'standard' });
    expect(st.externalAccount).toMatchObject({ id: 'ba_lili', last4: '2959', routingMismatch: true });
    expect(st.balance.availableCents).toBe(500);
  });

  it('fails closed on a test-mode key and never creates a payout', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_unit_test';
    const { create } = mockStripe({ bal: { ...BAL, livemode: false } });
    const st = await LiliStripePayoutOriginator.status();
    expect(st.ready).toBe(false);
    expect(st.issues).toEqual(expect.arrayContaining([expect.stringMatching(/test-mode key/), expect.stringMatching(/balance is test-mode/)]));
    await expect(LiliStripePayoutOriginator.send({ amount: 1, reference: 'R1' })).rejects.toMatchObject({ status: 503, code: 'LILI_STRIPE_PAYOUT_NOT_READY' });
    expect(create).not.toHaveBeenCalled();
  });

  it('fails closed when Lili is not a registered external account or payouts are disabled', async () => {
    mockStripe({ acct: { ...ACCT, payouts_enabled: false, external_accounts: { data: [{ id: 'ba_other', object: 'bank_account', last4: '1234' }] } } });
    const st = await LiliStripePayoutOriginator.status();
    expect(st.ready).toBe(false);
    expect(st.issues).toEqual(expect.arrayContaining([expect.stringMatching(/payouts are not enabled/), expect.stringMatching(/\*\*\*\*2959 is not a registered external/)]));
  });

  it('send() pays out to the Lili external account only, idempotent on reference, and refuses over-balance', async () => {
    const { create } = mockStripe();
    const sent = await LiliStripePayoutOriginator.send({ amount: 1, reference: 'REF-1', description: 'test' });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 100, currency: 'usd', destination: 'ba_lili', method: 'standard', metadata: expect.objectContaining({ reference: 'REF-1', direction: 'treasury_to_lili' }) }),
      { idempotencyKey: 'lili-dd-REF-1' },
    );
    expect(sent).toMatchObject({ status: 'originated', channel: 'stripe_payout', payoutId: 'po_1', stripeStatus: 'pending', externalAccountId: 'ba_lili' });
    await expect(LiliStripePayoutOriginator.send({ amount: 10, reference: 'REF-2' })).rejects.toMatchObject({ status: 409, code: 'LILI_STRIPE_PAYOUT_INSUFFICIENT_BALANCE' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('maps a failed payout to 502', async () => {
    mockStripe({ payout: { id: 'po_f', status: 'failed', failure_message: 'account closed' } });
    await expect(LiliStripePayoutOriginator.send({ amount: 1, reference: 'REF-F' })).rejects.toMatchObject({ status: 502, code: 'LILI_STRIPE_PAYOUT_FAILED' });
  });

  it('LiliSettlementBankEngine routes to stripe_payout and reports it in originatorStatus', async () => {
    mockStripe();
    const os = await LiliSettlementBankEngine.originatorStatus();
    expect(os).toMatchObject({ originator: 'stripe_payout', ready: true, channels: ['stripe_payout:ba_lili'] });
    const res = await LiliSettlementBankEngine._sendPayment({ amount: 1, reference: 'REF-3' });
    expect(res).toMatchObject({ status: 'originated', originator: 'stripe_payout', live: true, destination: { accountLast4: '2959' } });
    expect(res.lili).toMatchObject({ odfiChannels: ['stripe_payout:ba_lili'], payoutId: 'po_1' });
    await expect(LiliSettlementBankEngine._sendPayment({ amount: 1, reference: 'X', destination: { routingNumber: '000000000', accountNumber: '1' } })).rejects.toMatchObject({ status: 400 });
  });
});
