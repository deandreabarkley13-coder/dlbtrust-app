import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Must be set before the engine loads: it decides at require time whether to use Postgres.
process.env.DAPP_MEMORY_MODE = 'true';

const { ThirdwebTreasuryFundingEngine } = require('../server/integrations/dapp/thirdwebTreasuryFundingEngine');
const { ThirdwebServerWalletEngine } = require('../server/integrations/dapp/thirdwebServerWalletEngine');
const { ThirdwebPriceOracle } = require('../server/integrations/dapp/thirdwebPriceOracle');
const { SourceOfFundsAdapter } = require('../server/integrations/stablecoin/sourceOfFundsAdapter');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');

const saved = { ...process.env };
const TREASURY = '0x95bb85FdeC42b1517d282e8AD43A789d390aAda2';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

function position(availableCents: number, fundingEligible = true) {
  return { availableBalanceCents: availableCents, fundingEligible, segregationReason: fundingEligible ? null : 'segregated' } as any;
}

function bridgeCall(index = 0) {
  const [url, init] = (globalThis.fetch as any).mock.calls[index];
  return { url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : null };
}

beforeEach(() => {
  process.env.DAPP_MEMORY_MODE = 'true';
  process.env.DAPP_CHAIN_ID = '1';
  process.env.THIRDWEB_SECRET_KEY = 'tw-secret';
  process.env.THIRDWEB_SERVER_WALLET_ADDRESS = TREASURY;
  process.env.TREASURY_TOPUP_TOKEN_ADDRESS = USDC;
  process.env.TREASURY_TOPUP_HOLD_ACCOUNT_ID = '1000';
  delete process.env.THIRDWEB_SERVER_WALLET_LIVE;
  delete process.env.TREASURY_TOPUP_MAX_USD;

  vi.spyOn(ThirdwebPriceOracle, 'getPrice').mockResolvedValue({
    chainId: 1, tokenAddress: USDC, symbol: 'USDC', decimals: 6, priceUsd: 1, source: 'thirdweb', fetchedAt: Date.now(),
  } as any);
  vi.spyOn(SourceOfFundsAdapter, 'getPosition').mockResolvedValue(position(500_000_00));
  vi.spyOn(SourceOfFundsAdapter, '_fundSourceToTreasury').mockResolvedValue({ swept: true } as any);
  vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ id: 'je-1' } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...saved };
});

function mockFetch(responses: any[]) {
  const spy = vi.spyOn(globalThis, 'fetch');
  for (const body of responses) {
    spy.mockResolvedValueOnce({ ok: true, status: 200, statusText: 'ok', json: async () => body } as any);
  }
  return spy;
}

describe('thirdweb treasury funding readiness', () => {
  it('reports the bridge as the on-ramp, with top-ups open and swaps gated', () => {
    expect(ThirdwebTreasuryFundingEngine.readiness()).toMatchObject({
      provider: 'thirdweb-bridge',
      treasuryAddress: TREASURY,
      tokenAddress: USDC,
      currency: 'USD',
      holdSourceType: 'trust',
      holdSourceAccountId: '1000',
      canTopUp: true,
      canSwap: false,
      ready: true,
    });
  });

  it('is not ready without a secret key or a hold account', () => {
    delete process.env.THIRDWEB_SECRET_KEY;
    delete process.env.TREASURY_TOPUP_HOLD_ACCOUNT_ID;
    delete process.env.EXPENSE_WALLET_HOLD_ACCOUNT_ID;
    const status = ThirdwebTreasuryFundingEngine.readiness();
    expect(status).toMatchObject({ canTopUp: false, ready: false });
    expect(status.issues).toEqual([
      'THIRDWEB_SECRET_KEY not configured',
      'TREASURY_TOPUP_HOLD_ACCOUNT_ID not configured (pass sourceAccountId per request)',
    ]);
  });
});

describe('treasury top-up (fiat → on-chain)', () => {
  it('quotes fiat through the bridge and returns smallest units', async () => {
    mockFetch([{ result: 2500 }]);
    const quote = await ThirdwebTreasuryFundingEngine.convert({ amountFiat: 2500 });
    expect(quote).toMatchObject({ currency: 'USD', amountFiat: 2500, symbol: 'USDC', amount: 2500, quantity: '2500000000' });
    expect(bridgeCall().url).toContain('/v1/bridge/convert?from=USD&fromAmount=2500&chainId=1&to=0xA0b8');
  });

  it('creates a hosted checkout paying the treasury wallet, without booking anything', async () => {
    mockFetch([{ result: 1000 }, { result: { id: 'pay_1', link: 'https://thirdweb.com/pay/pay_1' } }]);
    const topUp = await ThirdwebTreasuryFundingEngine.createTopUp({ amountFiat: 1000, requestedBy: 'trustee@dlb.trust' });
    expect(topUp).toMatchObject({
      paymentId: 'pay_1',
      link: 'https://thirdweb.com/pay/pay_1',
      quantity: '1000000000',
      amountFiat: 1000,
      recipient: TREASURY,
      sourceType: 'trust',
      sourceAccountId: '1000',
      status: 'PENDING',
      booked: false,
    });
    expect(bridgeCall(1)).toMatchObject({
      method: 'POST',
      body: { token: { address: USDC, chainId: 1, amount: '1000000000' }, recipient: TREASURY },
    });
    // Inbound funding must not touch the books until the fiat actually settles.
    expect(SourceOfFundsAdapter._fundSourceToTreasury).not.toHaveBeenCalled();
    expect(TrustAccountingEngine.postJournalEntry).not.toHaveBeenCalled();
  });

  it('refuses a top-up the hold account cannot cover or the policy rejects', async () => {
    (SourceOfFundsAdapter.getPosition as any).mockResolvedValue(position(100_00));
    await expect(ThirdwebTreasuryFundingEngine.createTopUp({ amountFiat: 5000 }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_SOURCE_FUNDS', status: 422 });
    await expect(ThirdwebTreasuryFundingEngine.createTopUp({ amountFiat: 500_001 }))
      .rejects.toMatchObject({ code: 'DISTRIBUTION_LIMIT_EXCEEDED' });
    process.env.TREASURY_TOPUP_MAX_USD = '250';
    (SourceOfFundsAdapter.getPosition as any).mockResolvedValue(position(500_000_00));
    await expect(ThirdwebTreasuryFundingEngine.createTopUp({ amountFiat: 300 }))
      .rejects.toMatchObject({ code: 'TOPUP_LIMIT_EXCEEDED' });
  });

  it('books the sweep and journal once the bridge reports COMPLETED', async () => {
    mockFetch([
      { result: 400 },
      { result: { id: 'pay_2', link: 'https://thirdweb.com/pay/pay_2' } },
      { data: [{ id: 'pay_2', status: 'COMPLETED', transactions: [{ chainId: 1, transactionHash: '0xabc' }] }] },
      { data: [{ id: 'pay_2', status: 'COMPLETED', transactions: [{ chainId: 1, transactionHash: '0xabc' }] }] },
    ]);
    const topUp = await ThirdwebTreasuryFundingEngine.createTopUp({ amountFiat: 400 });
    const synced = await ThirdwebTreasuryFundingEngine.syncTopUp(topUp.id);
    expect(synced).toMatchObject({ status: 'COMPLETED', booked: true, transactionHash: '0xabc' });
    expect(SourceOfFundsAdapter._fundSourceToTreasury).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: 'trust', sourceAccountId: '1000', amountCents: 40_000 })
    );
    expect(TrustAccountingEngine.postJournalEntry).toHaveBeenCalledWith(expect.objectContaining({
      referenceType: 'treasury_topup',
      lines: [
        expect.objectContaining({ accountCode: '1210', debitAmount: 400, creditAmount: 0 }),
        expect.objectContaining({ accountCode: '1000', debitAmount: 0, creditAmount: 400 }),
      ],
    }));

    // Re-syncing a booked top-up must not sweep or journal a second time.
    await ThirdwebTreasuryFundingEngine.syncTopUp(topUp.id);
    expect(SourceOfFundsAdapter._fundSourceToTreasury).toHaveBeenCalledTimes(1);
    expect(TrustAccountingEngine.postJournalEntry).toHaveBeenCalledTimes(1);
  });

  it('leaves a pending top-up unbooked', async () => {
    mockFetch([
      { result: 100 },
      { result: { id: 'pay_3', link: 'https://thirdweb.com/pay/pay_3' } },
      { data: [{ id: 'pay_3', status: 'PENDING', transactions: [] }] },
    ]);
    const topUp = await ThirdwebTreasuryFundingEngine.createTopUp({ amountFiat: 100 });
    const synced = await ThirdwebTreasuryFundingEngine.syncTopUp(topUp.id);
    expect(synced).toMatchObject({ status: 'PENDING', booked: false });
    expect(SourceOfFundsAdapter._fundSourceToTreasury).not.toHaveBeenCalled();
  });

  it('syncOpen books only the top-ups the bridge has completed, and finds rows by payment id', async () => {
    mockFetch([
      { result: 51.5 },
      { result: { id: 'pay_open_a', link: 'https://thirdweb.com/pay/pay_open_a' } },
      { result: 76.25 },
      { result: { id: 'pay_open_b', link: 'https://thirdweb.com/pay/pay_open_b' } },
    ]);
    const a = await ThirdwebTreasuryFundingEngine.createTopUp({ amountFiat: 51.5 });
    const b = await ThirdwebTreasuryFundingEngine.createTopUp({ amountFiat: 76.25 });
    expect(await ThirdwebTreasuryFundingEngine.topUpsByPaymentId('pay_open_b')).toEqual([expect.objectContaining({ id: b.id })]);
    expect((await ThirdwebTreasuryFundingEngine.openTopUps()).map((t: any) => t.id)).toEqual(expect.arrayContaining([a.id, b.id]));

    (globalThis.fetch as any).mockImplementation(async (url: string) => ({
      ok: true, status: 200, statusText: 'ok',
      json: async () => (String(url).includes('pay_open_a')
        ? { data: [{ id: 'pay_open_a', status: 'COMPLETED', transactions: [{ transactionHash: '0xaaa' }] }] }
        : { data: [{ id: 'pay_open_b', status: 'PENDING', transactions: [] }] }),
    }));
    const results = await ThirdwebTreasuryFundingEngine.syncOpen();
    expect(results.find((r: any) => r.id === a.id)).toMatchObject({ status: 'COMPLETED', booked: true, transactionHash: '0xaaa' });
    expect(results.find((r: any) => r.id === b.id)).toMatchObject({ status: 'PENDING', booked: false });
    expect(SourceOfFundsAdapter._fundSourceToTreasury).toHaveBeenCalledTimes(1);
    const stillOpen = (await ThirdwebTreasuryFundingEngine.openTopUps()).map((t: any) => t.id);
    expect(stillOpen).toContain(b.id);
    expect(stillOpen).not.toContain(a.id);
    expect(await ThirdwebTreasuryFundingEngine.listTopUps({ status: 'COMPLETED' })).toEqual(expect.arrayContaining([expect.objectContaining({ id: a.id })]));
  });
});

describe('treasury swap (rebalancing held assets)', () => {
  it('is refused while shadow', async () => {
    await expect(ThirdwebTreasuryFundingEngine.swap({ amountUsd: 100 }))
      .rejects.toMatchObject({ code: 'NOT_LIVE', status: 409 });
  });

  it('swaps native gas into the configured stablecoin from the treasury wallet', async () => {
    process.env.THIRDWEB_SERVER_WALLET_LIVE = 'true';
    vi.spyOn(ThirdwebPriceOracle, 'quantityForUsd').mockResolvedValue({ quantity: '40000000000000000', decimals: 18, symbol: 'ETH' } as any);
    mockFetch([{ result: { transactionId: 'tx-swap' } }]);
    const swap = await ThirdwebTreasuryFundingEngine.swap({ amountUsd: 100 });
    expect(swap).toMatchObject({ from: TREASURY, tokenIn: NATIVE, tokenOut: USDC, transactionId: 'tx-swap' });
    expect(bridgeCall().body).toMatchObject({
      exact: 'input',
      tokenIn: { address: NATIVE, chainId: 1, amount: '40000000000000000' },
      tokenOut: { address: USDC, chainId: 1 },
      from: TREASURY,
      slippageToleranceBps: 50,
    });
  });
});

describe('thirdweb transport', () => {
  it('surfaces bridge errors instead of recording a phantom top-up', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false, status: 402, statusText: 'payment required', json: async () => ({ error: { message: 'onramp unavailable in region' } }),
    } as any);
    await expect(ThirdwebTreasuryFundingEngine.createTopUp({ amountFiat: 50 }))
      .rejects.toThrow(/onramp unavailable in region/);
    const recorded = await ThirdwebTreasuryFundingEngine.listTopUps();
    expect(recorded.some((r: any) => r.amountFiat === 50)).toBe(false);
    expect(ThirdwebServerWalletEngine.getConfig().secretKey).toBe('tw-secret');
  });
});
