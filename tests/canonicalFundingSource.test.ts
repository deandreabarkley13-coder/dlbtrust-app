import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const { CanonicalFundingSource } = require('../server/integrations/fineract/canonicalFundingSource');
const { ThirdwebTreasuryFundingEngine } = require('../server/integrations/dapp/thirdwebTreasuryFundingEngine');
const { ThirdwebPriceOracle } = require('../server/integrations/dapp/thirdwebPriceOracle');
const { FineractClient } = require('../server/integrations/fineract/fineractClient');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const { SourceOfFundsAdapter } = require('../server/integrations/stablecoin/sourceOfFundsAdapter');

const saved = { ...process.env };
const TREASURY = '0x95bb85FdeC42b1517d282e8AD43A789d390aAda2';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

/** Fineract GL summary shaped like FineractClient.getGLSummary(). */
function glSummary(cashUsd: number, assetUsd = 0) {
  return {
    accounts: {
      assets: [
        { id: 12, name: 'Trust Cash & Equivalents', glCode: '1000', balance: cashUsd },
        { id: 15, name: 'Stablecoin Backing Asset', glCode: '1210', balance: assetUsd },
      ],
      liabilities: [], equity: [], income: [], expenses: [],
    },
  };
}

function ledger(availableUsd: number, eligible = true) {
  return {
    account_code: '1000',
    account_name: 'Trust Cash & Equivalents',
    current_balance_cents: Math.round(availableUsd * 100),
    available_balance_cents: Math.round(availableUsd * 100),
    funding_eligible: eligible,
    segregation_reason: eligible ? null : 'restricted for bond proceeds',
  };
}

beforeEach(() => {
  process.env.DAPP_MEMORY_MODE = 'true';
  process.env.CANONICAL_GL_MAP = '1000:12,1210:15';
  process.env.CANONICAL_FUNDING_CASH_ACCOUNT_CODE = '1000';
  process.env.CANONICAL_FUNDING_ASSET_ACCOUNT_CODE = '1210';
  process.env.FINERACT_URL = 'https://fineract.dlbtrust.internal/fineract-provider/api/v1';
  delete process.env.CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID;
  delete process.env.CANONICAL_FUNDING_MIN_RESERVE_USD;
  delete process.env.CANONICAL_FUNDING_ALLOW_DRIFT;
  delete process.env.CANONICAL_FUNDING_LIVE;

  vi.spyOn(FineractClient, 'getGLSummary').mockResolvedValue(glSummary(50_000));
  vi.spyOn(TrustAccountingEngine, 'getFundingPosition').mockResolvedValue(ledger(50_000));
  vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ entry_id: 'JRN-1', fineract_transaction_id: 'FIN-9' });
  vi.spyOn(TrustAccountingEngine, 'reverseJournalEntry').mockResolvedValue({ entry_id: 'JRN-1-REV' });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe('canonical position (ERP is the authority)', () => {
  it('reports the GL as source of truth and nets the reserve buffer', async () => {
    process.env.CANONICAL_FUNDING_MIN_RESERVE_USD = '10000';
    const position = await CanonicalFundingSource.position({});
    expect(position).toMatchObject({
      sourceOfTruth: 'fineract',
      accountCode: '1000',
      glAccountId: 12,
      canonicalBalanceCents: 5_000_000,
      ledgerBalanceCents: 5_000_000,
      driftCents: 0,
      availableBalanceCents: 4_000_000,
      fundingEligible: true,
    });
  });

  it('caps availability at the lower book rather than trusting the sub-ledger', async () => {
    (FineractClient.getGLSummary as any).mockResolvedValue(glSummary(900));
    process.env.CANONICAL_FUNDING_ALLOW_DRIFT = 'true';
    (TrustAccountingEngine.getFundingPosition as any).mockResolvedValue(ledger(50_000));
    const position = await CanonicalFundingSource.position({});
    expect(position.availableBalanceCents).toBe(90_000);
  });

  it('restricts the source when the books drift beyond tolerance', async () => {
    (FineractClient.getGLSummary as any).mockResolvedValue(glSummary(0));
    const position = await CanonicalFundingSource.position({});
    expect(position).toMatchObject({ fundingEligible: false, availableBalanceCents: 0, driftCents: 5_000_000 });
    expect(position.segregationReason).toMatch(/differ by \$50000 — reconcile before funding/);
  });

  it('restricts when the ERP is unreachable or the account is unmapped', async () => {
    (FineractClient.getGLSummary as any).mockRejectedValue(Object.assign(new Error('Fineract circuit breaker OPEN'), { circuitOpen: true }));
    const down = await CanonicalFundingSource.position({});
    expect(down).toMatchObject({ fundingEligible: false, canonicalBalanceCents: null });
    expect(down.degraded).toMatch(/circuit breaker OPEN/);

    (FineractClient.getGLSummary as any).mockResolvedValue(glSummary(50_000));
    const unmapped = await CanonicalFundingSource.position({ accountCode: '4999' });
    expect(unmapped).toMatchObject({ fundingEligible: false, glAccountId: null });
  });

  it('honours a sub-ledger segregation flag', async () => {
    (TrustAccountingEngine.getFundingPosition as any).mockResolvedValue(ledger(50_000, false));
    const position = await CanonicalFundingSource.position({});
    expect(position).toMatchObject({ fundingEligible: false, segregationReason: 'restricted for bond proceeds' });
  });

  it('subtracts on-hold funds when an operating savings account is configured', async () => {
    process.env.CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID = '77';
    vi.spyOn(FineractClient, 'getAccountBalance').mockResolvedValue({
      currency: { code: 'USD' },
      status: { value: 'Active', active: true },
      summary: { accountBalance: 1_200, availableBalance: 1_200, onHoldFunds: 200 },
    } as any);
    const position = await CanonicalFundingSource.position({});
    expect(position.savings).toMatchObject({ balanceCents: 120_000, availableCents: 100_000 });
    expect(position.availableBalanceCents).toBe(100_000);
  });
});

describe('canonical draw', () => {
  it('plans without touching either book while shadow', async () => {
    const result = await CanonicalFundingSource.commit({ amountUsd: 1_000, reference: 'TOP-1' });
    expect(result).toMatchObject({
      shadow: true,
      committed: false,
      postToFineract: true,
      glAccountIds: { cash: 12, asset: 15 },
      reason: 'CANONICAL_FUNDING_LIVE=false',
    });
    expect(result.lines).toEqual([
      expect.objectContaining({ accountCode: '1210', debitAmount: 1_000, fineractGlId: 15 }),
      expect.objectContaining({ accountCode: '1000', creditAmount: 1_000, fineractGlId: 12 }),
    ]);
    expect(TrustAccountingEngine.postJournalEntry).not.toHaveBeenCalled();
  });

  it('withdraws from the ERP and posts one entry to both books when live', async () => {
    process.env.CANONICAL_FUNDING_LIVE = 'true';
    process.env.CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID = '77';
    vi.spyOn(FineractClient, 'getAccountBalance').mockResolvedValue({ summary: { accountBalance: 50_000 }, status: { active: true } } as any);
    const withdraw = vi.spyOn(FineractClient, 'withdrawSavings').mockResolvedValue({ resourceId: 4242 } as any);

    const result = await CanonicalFundingSource.commit({ amountUsd: 1_000, reference: 'TOP-2' });
    expect(result).toMatchObject({ committed: true, shadow: false, journalEntryId: 'JRN-1', fineractTransactionId: 'FIN-9', savingsTransactionId: 4242 });
    expect(withdraw).toHaveBeenCalledWith(expect.objectContaining({ accountId: '77', amount: 1_000 }));
    expect(TrustAccountingEngine.postJournalEntry).toHaveBeenCalledWith(expect.objectContaining({ postToFineract: true }));
  });

  it('puts withdrawn cash back if the journal fails', async () => {
    process.env.CANONICAL_FUNDING_LIVE = 'true';
    process.env.CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID = '77';
    vi.spyOn(FineractClient, 'getAccountBalance').mockResolvedValue({ summary: { accountBalance: 50_000 }, status: { active: true } } as any);
    vi.spyOn(FineractClient, 'withdrawSavings').mockResolvedValue({ resourceId: 4242 } as any);
    const deposit = vi.spyOn(FineractClient, 'depositSavings').mockResolvedValue({ resourceId: 4243 } as any);
    (TrustAccountingEngine.postJournalEntry as any).mockRejectedValue(new Error('GL post rejected'));

    await expect(CanonicalFundingSource.commit({ amountUsd: 1_000, reference: 'TOP-3' })).rejects.toThrow('GL post rejected');
    expect(deposit).toHaveBeenCalledWith(expect.objectContaining({ accountId: '77', amount: 1_000 }));
  });

  it('refuses a draw the ERP cannot cover, and one with no GL mapping', async () => {
    (FineractClient.getGLSummary as any).mockResolvedValue(glSummary(100));
    (TrustAccountingEngine.getFundingPosition as any).mockResolvedValue(ledger(100));
    await expect(CanonicalFundingSource.commit({ amountUsd: 5_000, reference: 'TOP-4' }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_CANONICAL_FUNDS', status: 422 });

    process.env.CANONICAL_FUNDING_LIVE = 'true';
    process.env.CANONICAL_GL_MAP = '1000:12';
    (FineractClient.getGLSummary as any).mockResolvedValue(glSummary(50_000));
    (TrustAccountingEngine.getFundingPosition as any).mockResolvedValue(ledger(50_000));
    await expect(CanonicalFundingSource.commit({ amountUsd: 1_000, reference: 'TOP-5' }))
      .rejects.toMatchObject({ code: 'GL_MAPPING_MISSING' });
  });

  it('reverses a committed draw on both sides', async () => {
    process.env.CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID = '77';
    const deposit = vi.spyOn(FineractClient, 'depositSavings').mockResolvedValue({ resourceId: 5150 } as any);
    const result = await CanonicalFundingSource.reverse({ journalEntryId: 'JRN-1', amountUsd: 1_000, reference: 'TOP-2' });
    expect(result).toEqual({ reversedJournalEntryId: 'JRN-1-REV', savingsTransactionId: 5150 });
    expect(deposit).toHaveBeenCalledOnce();
  });

  it('reports per-account drift', async () => {
    (FineractClient.getGLSummary as any).mockResolvedValue(glSummary(50_000, 250));
    (TrustAccountingEngine.getFundingPosition as any).mockImplementation(async (code: string) =>
      code === '1000' ? ledger(50_000) : { ...ledger(250), account_code: '1210' });
    const report = await CanonicalFundingSource.reconcile({});
    expect(report).toMatchObject({ system: 'fineract', inSync: true, toleranceUsd: 1 });
    expect(report.accounts).toEqual([
      expect.objectContaining({ accountCode: '1000', canonicalUsd: 50_000, ledgerUsd: 50_000, driftUsd: 0 }),
      expect.objectContaining({ accountCode: '1210', canonicalUsd: 250, ledgerUsd: 250, driftUsd: 0 }),
    ]);
  });
});

describe('thirdweb top-up funded from the canonical source', () => {
  beforeEach(() => {
    process.env.THIRDWEB_SECRET_KEY = 'tw-secret';
    process.env.THIRDWEB_SERVER_WALLET_ADDRESS = TREASURY;
    process.env.DAPP_CHAIN_ID = '1';
    process.env.TREASURY_TOPUP_TOKEN_ADDRESS = USDC;
    process.env.TREASURY_TOPUP_HOLD_SOURCE_TYPE = 'canonical';
    process.env.TREASURY_TOPUP_HOLD_ACCOUNT_ID = '1000';
    vi.spyOn(ThirdwebPriceOracle, 'getPrice').mockResolvedValue({
      chainId: 1, tokenAddress: USDC, symbol: 'USDC', decimals: 6, priceUsd: 1,
    } as any);
    vi.spyOn(SourceOfFundsAdapter, 'getPosition');
    vi.spyOn(SourceOfFundsAdapter, '_fundSourceToTreasury');
  });

  function mockBridge(responses: any[]) {
    const spy = vi.spyOn(globalThis, 'fetch');
    for (const body of responses) {
      spy.mockResolvedValueOnce({ ok: true, status: 200, statusText: 'ok', json: async () => body } as any);
    }
    return spy;
  }

  it('surfaces the canonical source in readiness', () => {
    const status = ThirdwebTreasuryFundingEngine.readiness();
    expect(status.holdSourceType).toBe('canonical');
    expect(status.canonicalSource).toMatchObject({ system: 'fineract', cashAccountCode: '1000', ready: true });
  });

  it('checks the ERP instead of the sub-ledger before issuing a checkout', async () => {
    mockBridge([{ result: 1_000 }, { result: { id: 'pay_c', link: 'https://thirdweb.com/pay/pay_c' } }]);
    const topUp = await ThirdwebTreasuryFundingEngine.createTopUp({ amountFiat: 1_000 });
    expect(topUp).toMatchObject({ sourceType: 'canonical', sourceAccountId: '1000', status: 'PENDING', booked: false });
    expect(FineractClient.getGLSummary).toHaveBeenCalled();
    expect(SourceOfFundsAdapter.getPosition).not.toHaveBeenCalled();
  });

  it('refuses the checkout when the ERP lacks the cash', async () => {
    (FineractClient.getGLSummary as any).mockResolvedValue(glSummary(10));
    (TrustAccountingEngine.getFundingPosition as any).mockResolvedValue(ledger(10));
    await expect(ThirdwebTreasuryFundingEngine.createTopUp({ amountFiat: 1_000 }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_CANONICAL_FUNDS' });
  });

  it('books through the ERP on COMPLETED, leaving the sub-ledger sweep unused', async () => {
    process.env.CANONICAL_FUNDING_LIVE = 'true';
    mockBridge([
      { result: 400 },
      { result: { id: 'pay_d', link: 'https://thirdweb.com/pay/pay_d' } },
      { data: [{ id: 'pay_d', status: 'COMPLETED', transactions: [{ transactionHash: '0xdef' }] }] },
    ]);
    const topUp = await ThirdwebTreasuryFundingEngine.createTopUp({ amountFiat: 400 });
    const synced = await ThirdwebTreasuryFundingEngine.syncTopUp(topUp.id);
    expect(synced).toMatchObject({ status: 'COMPLETED', booked: true, transactionHash: '0xdef' });
    expect(TrustAccountingEngine.postJournalEntry).toHaveBeenCalledWith(expect.objectContaining({
      postToFineract: true,
      referenceType: 'treasury_topup',
      lines: [
        expect.objectContaining({ accountCode: '1210', debitAmount: 400, fineractGlId: 15 }),
        expect.objectContaining({ accountCode: '1000', creditAmount: 400, fineractGlId: 12 }),
      ],
    }));
    expect(SourceOfFundsAdapter._fundSourceToTreasury).not.toHaveBeenCalled();
  });

  it('leaves a completed top-up unbooked while the ERP draw is shadowed', async () => {
    mockBridge([
      { result: 400 },
      { result: { id: 'pay_e', link: 'https://thirdweb.com/pay/pay_e' } },
      { data: [{ id: 'pay_e', status: 'COMPLETED', transactions: [] }] },
    ]);
    const topUp = await ThirdwebTreasuryFundingEngine.createTopUp({ amountFiat: 400 });
    const synced = await ThirdwebTreasuryFundingEngine.syncTopUp(topUp.id);
    expect(synced).toMatchObject({ status: 'COMPLETED', booked: false });
    expect(TrustAccountingEngine.postJournalEntry).not.toHaveBeenCalled();
  });
});
