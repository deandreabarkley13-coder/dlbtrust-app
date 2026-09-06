import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { BondSubscriptionEngine } = require('../server/integrations/bonds/bondSubscriptionEngine');
const { BondTokenizationEngine } = require('../server/integrations/dapp/bondTokenizationEngine');
const { ThirdwebServerWalletEngine } = require('../server/integrations/dapp/thirdwebServerWalletEngine');
const { FixedIncomeDataService } = require('../server/integrations/bonds/fixedIncomeDataService');
const pool = require('../server/integrations/bonds/pgPool');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');

type Row = Record<string, any>;

const saved = { ...process.env };
const OPERATOR = '0x3e53028cf69949f3B961ce786Baf2D4D75166562';
const SERVER_WALLET = '0x1A904F795a0511C31Ba6347504D08d1bA58E4f89';
const INVESTOR = '0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const PRB = '0x5555555555555555555555555555555555555555';

const token: Row = {
  id: 'BTOK-1', bond_id: 1, token_name: 'DLB Private Reserve Bond', token_symbol: 'DLB-PRB', token_address: PRB,
  status: 'active', total_supply: '98524627.51', tokenized_principal: '98524627.51', tokenized_interest: '0', metadata: { chainId: 1, decimals: 6 },
};

/** In-memory bond_subscriptions table behind pool.query. */
function mockSubscriptionsTable() {
  const rows: Row[] = [];
  vi.spyOn(pool, 'query').mockImplementation(async (text: string, params: any[] = []) => {
    if (/INSERT INTO bond_subscriptions/.test(text)) {
      const [id, token_id, bond_id, units, price_bps, amount_usd, settlement_token, settlement_quantity, chain_id,
        recipient, investor_address, investor_name, payment_id, link, status, requested_by] = params;
      rows.unshift({ id, token_id, bond_id, units, price_bps, amount_usd, settlement_token, settlement_quantity, chain_id,
        recipient, investor_address, investor_name, payment_id, link, status, requested_by,
        payment_hash: null, delivery_hash: null, journal_entry_id: null, failure_reason: null });
      return { rows: [] };
    }
    if (/UPDATE bond_subscriptions/.test(text)) {
      const row = rows.find((r) => r.id === params[0]);
      if (row) Object.assign(row, { status: params[1], payment_hash: params[2], delivery_hash: params[3], journal_entry_id: params[4], failure_reason: params[5] });
      return { rows: [] };
    }
    if (/SELECT \* FROM bond_subscriptions WHERE id/.test(text)) return { rows: rows.filter((r) => r.id === params[0]) };
    if (/SELECT \* FROM bond_subscriptions WHERE status/.test(text)) return { rows: rows.filter((r) => r.status === params[0]) };
    if (/SELECT \* FROM bond_subscriptions/.test(text)) return { rows };
    return { rows: [] };
  });
  return rows;
}

beforeEach(() => {
  process.env.THIRDWEB_SECRET_KEY = 'tw-secret';
  process.env.THIRDWEB_SERVER_WALLET_ADDRESS = SERVER_WALLET;
  process.env.DAPP_USDC_ADDRESS = USDC;
  delete process.env.BOND_SUBSCRIPTION_ALLOWED_INVESTORS;
  delete process.env.BOND_SUBSCRIPTION_MAX_UNITS;
  delete process.env.BOND_SUBSCRIPTION_PRICE_BPS;
  vi.spyOn(BondTokenizationEngine, 'getToken').mockResolvedValue({ ...token });
  vi.spyOn(BondTokenizationEngine, 'operatorAddress').mockReturnValue(OPERATOR);
  vi.spyOn(BondTokenizationEngine, 'getHoldings').mockResolvedValue([
    { token_id: 'BTOK-1', holder_address: OPERATOR, balance: '98524627.51' },
    { token_id: 'BTOK-1', holder_address: 'treasury', balance: '0' },
  ]);
  vi.spyOn(BondTokenizationEngine, 'readiness').mockReturnValue({ ready: true, mode: 'live', issues: [] });
  vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ entry_id: 'JE-1' });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe('BondSubscriptionEngine.create', () => {
  it('prices units at par, creates a thirdweb payment to the server wallet and moves nothing', async () => {
    const rows = mockSubscriptionsTable();
    const request = vi.spyOn(ThirdwebServerWalletEngine, '_request').mockResolvedValue({ id: 'pay-1', link: 'https://thirdweb.com/pay/pay-1' });
    const transfer = vi.spyOn(BondTokenizationEngine, 'applyTransfer');

    const sub = await BondSubscriptionEngine.create({ tokenId: 'BTOK-1', units: 2500.5, investorAddress: INVESTOR, requestedBy: 'trustee' });

    expect(sub.status).toBe('PENDING_PAYMENT');
    expect(sub.amountUsd).toBe(2500.5);
    expect(sub.settlementQuantity).toBe('2500500000');
    expect(sub.link).toBe('https://thirdweb.com/pay/pay-1');
    const [method, path, body] = request.mock.calls[0];
    expect(method).toBe('POST');
    expect(path).toBe('/v1/bridge/payments');
    expect(body.recipient).toBe(SERVER_WALLET);
    expect(body.token).toEqual({ address: USDC, chainId: 1, amount: '2500500000' });
    expect(body.purchaseData).toMatchObject({ subscriptionId: sub.id, tokenId: 'BTOK-1', bondId: 1, units: 2500.5, investorAddress: INVESTOR });
    expect(transfer).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
  });

  it('cannot sell more units than the operator holds, unbacked or off-chain tokens, or to non-allowlisted wallets', async () => {
    mockSubscriptionsTable();
    const request = vi.spyOn(ThirdwebServerWalletEngine, '_request');

    await expect(BondSubscriptionEngine.create({ tokenId: 'BTOK-1', units: 98524627.52, investorAddress: INVESTOR }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_UNITS' });

    vi.spyOn(BondTokenizationEngine, 'getToken').mockResolvedValue({ ...token, bond_id: null });
    await expect(BondSubscriptionEngine.create({ tokenId: 'BTOK-1', units: 10, investorAddress: INVESTOR }))
      .rejects.toMatchObject({ code: 'TOKEN_UNBACKED' });

    vi.spyOn(BondTokenizationEngine, 'getToken').mockResolvedValue({ ...token, metadata: { chainId: 11155111 } });
    await expect(BondSubscriptionEngine.create({ tokenId: 'BTOK-1', units: 10, investorAddress: INVESTOR }))
      .rejects.toMatchObject({ code: 'TOKEN_OFF_CHAIN' });

    vi.spyOn(BondTokenizationEngine, 'getToken').mockResolvedValue({ ...token });
    process.env.BOND_SUBSCRIPTION_ALLOWED_INVESTORS = OPERATOR;
    await expect(BondSubscriptionEngine.create({ tokenId: 'BTOK-1', units: 10, investorAddress: INVESTOR }))
      .rejects.toMatchObject({ code: 'INVESTOR_NOT_ALLOWED' });

    expect(request).not.toHaveBeenCalled();
  });
});

describe('BondSubscriptionEngine.sync', () => {
  async function open() {
    mockSubscriptionsTable();
    vi.spyOn(ThirdwebServerWalletEngine, '_request').mockResolvedValueOnce({ id: 'pay-1', link: 'https://thirdweb.com/pay/pay-1' });
    return BondSubscriptionEngine.create({ tokenId: 'BTOK-1', units: 1000, investorAddress: INVESTOR, requestedBy: 'trustee' });
  }

  it('leaves a PENDING payment alone and delivers nothing', async () => {
    const sub = await open();
    vi.spyOn(ThirdwebServerWalletEngine, '_request').mockResolvedValue({ data: [{ status: 'PENDING', transactions: [] }] });
    const transfer = vi.spyOn(BondTokenizationEngine, 'applyTransfer');
    const after = await BondSubscriptionEngine.sync(sub.id);
    expect(after.status).toBe('PENDING_PAYMENT');
    expect(transfer).not.toHaveBeenCalled();
  });

  it('on COMPLETED transfers the units from the operator to the investor exactly once', async () => {
    const sub = await open();
    vi.spyOn(ThirdwebServerWalletEngine, '_request').mockResolvedValue({
      data: [{ status: 'COMPLETED', destinationAmount: '1000000000', transactions: [{ chainId: 1, transactionHash: '0xpay' }] }],
    });
    const transfer = vi.spyOn(BondTokenizationEngine, 'applyTransfer').mockResolvedValue({ txHash: '0xdeliver', transferred: 1000 });

    const delivered = await BondSubscriptionEngine.sync(sub.id);
    expect(delivered.status).toBe('DELIVERED');
    expect(delivered.paymentHash).toBe('0xpay');
    expect(delivered.deliveryHash).toBe('0xdeliver');
    expect(delivered.journalEntryId).toBe('JE-1');
    const journal = (TrustAccountingEngine.postJournalEntry as any).mock.calls[0][0];
    expect(journal.lines.map((l: any) => [l.accountCode, l.debitAmount, l.creditAmount])).toEqual([['1210', 1000, 0], ['2010', 0, 1000]]);
    expect(transfer).toHaveBeenCalledWith({ tokenId: 'BTOK-1', amount: 1000, toAddress: INVESTOR });

    const again = await BondSubscriptionEngine.sync(sub.id);
    expect(again.status).toBe('DELIVERED');
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it('fails a payment that settled short instead of delivering', async () => {
    const sub = await open();
    vi.spyOn(ThirdwebServerWalletEngine, '_request').mockResolvedValue({
      data: [{ status: 'COMPLETED', destinationAmount: '999000000', transactions: [] }],
    });
    const transfer = vi.spyOn(BondTokenizationEngine, 'applyTransfer');
    const after = await BondSubscriptionEngine.sync(sub.id);
    expect(after.status).toBe('FAILED');
    expect(after.failureReason).toMatch(/settled 999000000 < expected 1000000000/);
    expect(transfer).not.toHaveBeenCalled();
  });

  it('keeps a PAID subscription retryable when delivery throws', async () => {
    const sub = await open();
    vi.spyOn(ThirdwebServerWalletEngine, '_request').mockResolvedValue({
      data: [{ status: 'COMPLETED', destinationAmount: '1000000000', transactions: [] }],
    });
    vi.spyOn(BondTokenizationEngine, 'applyTransfer').mockRejectedValueOnce(new Error('rpc down')).mockResolvedValueOnce({ txHash: '0xok' });
    await expect(BondSubscriptionEngine.sync(sub.id)).rejects.toThrow('rpc down');
    const stuck = await BondSubscriptionEngine.get(sub.id);
    expect(stuck.status).toBe('PAID');
    expect(stuck.failureReason).toMatch(/delivery failed: rpc down/);
    const retried = await BondSubscriptionEngine.deliver(sub.id);
    expect(retried.status).toBe('DELIVERED');
    expect(retried.deliveryHash).toBe('0xok');
  });
});

describe('FixedIncomeDataService.getHolderReconciliation', () => {
  const tokenization = { by_bond: { '1': { tokens: [{ id: 'BTOK-1', bond_id: 1, token_symbol: 'DLB-PRB', token_address: PRB }] } } };

  it('compares ledger holders with chain owners and flags per-address mismatches', async () => {
    vi.spyOn(ThirdwebServerWalletEngine, 'tokenOwners').mockResolvedValue({
      chainId: 1, tokenAddress: PRB, complete: true,
      owners: [{ address: OPERATOR, amount: '98523627510000' }, { address: INVESTOR, amount: '1000000000' }],
    });
    const result = await FixedIncomeDataService.getHolderReconciliation(tokenization);
    expect(result.available).toBe(true);
    const [t] = result.tokens;
    expect(t.chain_holder_count).toBe(2);
    expect(t.unaddressed).toEqual([{ holder: 'treasury', balance: 0 }]);
    expect(result.discrepancies).toEqual([
      { bond_id: 1, token_id: 'BTOK-1', type: 'holder_balance_mismatch', address: OPERATOR.toLowerCase(), ledger_balance: 98524627.51, chain_balance: 98523627.51 },
      { bond_id: 1, token_id: 'BTOK-1', type: 'holder_balance_mismatch', address: INVESTOR.toLowerCase(), ledger_balance: 0, chain_balance: 1000 },
    ]);
  });

  it('is unavailable rather than failing when thirdweb is not configured', async () => {
    delete process.env.THIRDWEB_SECRET_KEY;
    const result = await FixedIncomeDataService.getHolderReconciliation(tokenization);
    expect(result.available).toBe(false);
    expect(result.discrepancies).toEqual([]);
  });
});
