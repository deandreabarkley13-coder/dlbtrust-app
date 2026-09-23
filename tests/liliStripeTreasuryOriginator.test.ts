import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { LiliStripeTreasuryOriginator } = require('../server/integrations/payments/liliStripeTreasuryOriginator');
const { LiliSettlementBankEngine } = require('../server/integrations/payments/liliSettlementBankEngine');
const { LiliDirectDepositEngine } = require('../server/integrations/payments/liliDirectDepositEngine');
const { LiliMcpEngine } = require('../server/integrations/payments/liliMcpEngine');
const { StripeTreasuryEngine } = require('../server/integrations/payments/stripeTreasuryEngine');

const saved = { ...process.env };
const DEST = { configured: true, routingNumber: '121145307', accountNumberMasked: '****2959', accountName: 'DB NET MGMT LLC', _account: '692101092959' };
const FA = {
  id: 'fa_live_1', status: 'open', livemode: true,
  active_features: ['outbound_payments.ach', 'outbound_payments.us_domestic_wire', 'financial_addresses.aba'],
  financial_addresses: [{ aba: { routing_number: '084106768', account_number_last4: '4242', bank_name: 'Evolve' } }],
};

function mockStripe({ fa = FA, retrieveError = null } = {}) {
  vi.spyOn(LiliDirectDepositEngine, 'getDestination').mockResolvedValue(DEST);
  const retrieve = retrieveError ? vi.fn().mockRejectedValue(retrieveError) : vi.fn().mockResolvedValue(fa);
  vi.spyOn(StripeTreasuryEngine, 'getClient').mockReturnValue({ treasury: { financialAccounts: { retrieve } } });
  return retrieve;
}

describe('LiliStripeTreasuryOriginator', () => {
  beforeEach(() => {
    process.env.LILI_CLEARING_LIVE = 'true';
    process.env.LILI_ORIGINATOR = 'stripe_treasury';
    process.env.LILI_DD_ROUTING_NUMBER = '121145307';
    process.env.LILI_DD_ACCOUNT_NUMBER = '692101092959';
    process.env.STRIPE_SECRET_KEY = 'sk_live_unit_test';
    process.env.STRIPE_TREASURY_FINANCIAL_ACCOUNT_ID = 'fa_live_1';
    delete process.env.LILI_STRIPE_TREASURY_NETWORK;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  it('is ready with a live key and an open financial account with outbound ACH', async () => {
    const retrieve = mockStripe();
    const st = await LiliStripeTreasuryOriginator.status();
    expect(retrieve).toHaveBeenCalledWith('fa_live_1');
    expect(st).toMatchObject({ ready: true, network: 'ach', keyMode: 'live', financialAccountId: 'fa_live_1' });
    expect(st.financialAccount.aba.accountLast4).toBe('4242');
    expect(st.destination).toEqual({ routingNumber: '121145307', accountLast4: '2959', name: 'DB NET MGMT LLC' });
  });

  it('fails closed on a test-mode key / financial account and never creates a payment', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_unit_test';
    mockStripe({ fa: { ...FA, livemode: false } });
    const create = vi.spyOn(StripeTreasuryEngine, 'createPayment');
    const st = await LiliStripeTreasuryOriginator.status();
    expect(st.ready).toBe(false);
    expect(st.issues).toEqual(expect.arrayContaining([expect.stringMatching(/test-mode key/), expect.stringMatching(/financial account is test-mode/)]));
    await expect(LiliStripeTreasuryOriginator.send({ amount: 1, reference: 'REF-1' })).rejects.toMatchObject({ status: 503, code: 'LILI_STRIPE_TREASURY_NOT_READY' });
    expect(create).not.toHaveBeenCalled();
  });

  it('fails closed when outbound ACH is not active or the account is not open', async () => {
    mockStripe({ fa: { ...FA, status: 'closed', active_features: ['financial_addresses.aba'] } });
    const st = await LiliStripeTreasuryOriginator.status();
    expect(st.ready).toBe(false);
    expect(st.issues).toEqual(expect.arrayContaining([expect.stringMatching(/is closed/), expect.stringMatching(/lacks outbound_payments\.ach/)]));
  });

  it('send() creates an OutboundPayment to the Lili account only and maps statuses', async () => {
    mockStripe();
    const create = vi.spyOn(StripeTreasuryEngine, 'createPayment')
      .mockResolvedValueOnce({ payout_id: 'STR-PAYOUT-1', stripe_outbound_payment_id: 'obp_1', status: 'pending', stripe_status: 'processing', financial_account: 'fa_live_1', response: { expected_arrival_date: 1790380800 } })
      .mockResolvedValueOnce({ payout_id: 'STR-PAYOUT-2', stripe_outbound_payment_id: null, status: 'failed', stripe_status: null, financial_account: 'fa_live_1', response: { error: { message: 'insufficient funds' } } });

    const sent = await LiliStripeTreasuryOriginator.send({ amount: 25, reference: 'REF-2', description: 'settlement' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      amount: 25, routingNumber: '121145307', accountNumber: '692101092959', accountHolderName: 'DB NET MGMT LLC',
      accountHolderType: 'company', accountType: 'checking', network: 'ach', financialAccountId: 'fa_live_1',
      metadata: expect.objectContaining({ reference: 'REF-2', direction: 'treasury_to_lili' }),
    }));
    expect(sent).toMatchObject({ status: 'originated', outboundPaymentId: 'obp_1', payoutId: 'STR-PAYOUT-1', stripeStatus: 'processing', expectedArrival: '2026-09-26' });

    await expect(LiliStripeTreasuryOriginator.send({ amount: 25, reference: 'REF-3' })).rejects.toMatchObject({ status: 502, code: 'LILI_STRIPE_TREASURY_FAILED' });
  });

  it('LiliSettlementBankEngine uses Stripe Treasury when LILI_ORIGINATOR=stripe_treasury', async () => {
    mockStripe();
    vi.spyOn(LiliMcpEngine, 'getPublicConfig').mockResolvedValue({ configured: false });
    const odfi = vi.spyOn(LiliDirectDepositEngine, 'odfiStatus');
    const dd = vi.spyOn(LiliDirectDepositEngine, 'createDirectDeposit');
    vi.spyOn(StripeTreasuryEngine, 'createPayment').mockResolvedValue({ payout_id: 'STR-PAYOUT-9', stripe_outbound_payment_id: 'obp_9', status: 'completed', stripe_status: 'posted', financial_account: 'fa_live_1', response: {} });

    const status = await LiliSettlementBankEngine.status();
    expect(status.originator).toBe('stripe_treasury');
    expect(status.originationReady).toBe(true);
    expect(status.odfi.channels).toEqual(['stripe_treasury:fa_live_1']);
    expect(odfi).not.toHaveBeenCalled();

    const sent = await LiliSettlementBankEngine._sendPayment({ amount: 10, reference: 'REF-4', description: 'x' });
    expect(sent).toMatchObject({ status: 'originated', originator: 'stripe_treasury', destination: { routingNumber: '121145307', accountLast4: '2959' } });
    expect(sent.lili).toMatchObject({ odfiChannels: ['stripe_treasury:fa_live_1'], outboundPaymentId: 'obp_9', network: 'ach' });
    expect(dd).not.toHaveBeenCalled();

    await expect(LiliSettlementBankEngine._sendPayment({ amount: 10, reference: 'REF-5', destination: { routingNumber: '011000015', accountNumber: '1' } })).rejects.toMatchObject({ status: 400 });
  });

  it('defaults to the NACHA originator', async () => {
    delete process.env.LILI_ORIGINATOR;
    vi.spyOn(LiliDirectDepositEngine, 'getDestination').mockResolvedValue(DEST);
    vi.spyOn(LiliDirectDepositEngine, 'odfiStatus').mockResolvedValue({ ready: false, channels: [], loopback: [], blocker: 'No ODFI channel configured (OpenACH/AS2/MFT/REST/SFTP)' });
    vi.spyOn(LiliMcpEngine, 'getPublicConfig').mockResolvedValue({ configured: false });
    const status = await LiliSettlementBankEngine.status();
    expect(status.originator).toBe('nacha');
    expect(status.odfi.originator).toBe('nacha');
    expect(status.originationReady).toBe(false);
  });
});
