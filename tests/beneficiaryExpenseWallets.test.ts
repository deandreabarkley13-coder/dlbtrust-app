import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const { BeneficiaryExpenseWalletEngine } = require('../server/integrations/dapp/beneficiaryExpenseWalletEngine');
const { ThirdwebServerWalletEngine } = require('../server/integrations/dapp/thirdwebServerWalletEngine');
const { ThirdwebPriceOracle } = require('../server/integrations/dapp/thirdwebPriceOracle');
const { SourceOfFundsAdapter } = require('../server/integrations/stablecoin/sourceOfFundsAdapter');
const pool = require('../server/integrations/bonds/pgPool');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const { WalletFundingEngine } = require('../server/integrations/dapp/walletFundingEngine');

const saved = { ...process.env };
const TREASURY = '0x95bb85FdeC42b1517d282e8AD43A789d390aAda2';
const EXPENSE = '0x1A904F795a0511C31Ba6347504D08d1bA58E4f89';

function position(availableCents: number, fundingEligible = true) {
  return {
    sourceType: 'trust',
    sourceAccountId: '1000',
    availableBalanceCents: availableCents,
    balanceCents: availableCents,
    fundingEligible,
    segregationReason: fundingEligible ? null : 'segregated',
  } as any;
}

beforeEach(() => {
  vi.spyOn(pool, 'query').mockResolvedValue({ rows: [], rowCount: 0 } as any);
  process.env.DAPP_CHAIN_ID = '1';
  process.env.THIRDWEB_SECRET_KEY = 'tw-secret';
  process.env.THIRDWEB_SERVER_WALLET_ADDRESS = TREASURY;
  process.env.EXPENSE_WALLET_HOLD_ACCOUNT_ID = '1000';
  delete process.env.THIRDWEB_SERVER_WALLET_LIVE;
  delete process.env.EXPENSE_WALLET_TOKEN_ADDRESS;

  vi.spyOn(ThirdwebServerWalletEngine, 'ensureWallet').mockImplementation(async (identifier: string) => ({
    identifier, address: EXPENSE, smartAccountAddress: null, createdAt: '2026-01-01',
  }));
  // Funding is asserted against chain balances, which these tests never mock —
  // the underfunded guard has its own coverage in serverWalletFunding.test.ts.
  vi.spyOn(ThirdwebServerWalletEngine, 'assertFunded').mockResolvedValue({ funded: true } as any);
  // Test asset: 0 decimals at $1/unit so quantity == USD.
  vi.spyOn(ThirdwebPriceOracle, 'getPrice').mockResolvedValue({
    chainId: 1, tokenAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', symbol: 'TST', decimals: 0, priceUsd: 1, source: 'thirdweb', fetchedAt: Date.now(),
  } as any);
  vi.spyOn(SourceOfFundsAdapter, 'getPosition').mockResolvedValue(position(50_000_00));
  vi.spyOn(SourceOfFundsAdapter, '_fundSourceToTreasury').mockResolvedValue({ swept: true } as any);
  vi.spyOn(WalletFundingEngine, 'ensureAccounts').mockResolvedValue(undefined as any);
  vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ id: 'je-1' } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe('beneficiary expense wallet provisioning', () => {
  it('derives one deterministic wallet identifier per purpose', async () => {
    expect(BeneficiaryExpenseWalletEngine.identifierFor('Jane Doe', 'Medical')).toBe('dlbt-exp-jane-doe-medical');
    expect(BeneficiaryExpenseWalletEngine.identifierFor('jane.doe@example.com', 'travel')).toBe('dlbt-exp-jane-doe-travel');
    expect(() => BeneficiaryExpenseWalletEngine.identifierFor('Jane Doe', 'yacht')).toThrow(/not permitted/);
    expect(() => BeneficiaryExpenseWalletEngine.identifierFor('', 'medical')).toThrow(/beneficiary required/);
  });

  it('provisions every permitted expense purpose without moving value', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { wallets } = await BeneficiaryExpenseWalletEngine.ensureWallets({ beneficiary: 'Jane Doe' });
    expect(wallets.map((w: any) => w.purpose)).toEqual(['lifestyle', 'medical', 'travel', 'home', 'education']);
    expect(wallets.every((w: any) => w.address === EXPENSE && w.chainId === 1)).toBe(true);
    expect(ThirdwebServerWalletEngine.ensureWallet).toHaveBeenCalledWith('dlbt-exp-jane-doe-lifestyle');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO beneficiary_expense_wallets/), expect.any(Array));
  });

  it('reports the hold account and treasury wallet it would fund from', () => {
    const status = BeneficiaryExpenseWalletEngine.readiness();
    expect(status).toMatchObject({
      provider: 'beneficiary-expense-wallets',
      holdSourceType: 'trust',
      holdSourceAccountId: '1000',
      treasuryWallet: TREASURY,
      shadow: true,
      canFund: false,
      ready: true,
    });
  });
});

// Funding is the leg that can move real trust value: the hold account must
// cover it, the policy must allow it, and nothing may move while shadow.
describe('beneficiary expense wallet funding', () => {
  it('plans the transfer and touches neither ledger nor chain while shadow', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const record = await BeneficiaryExpenseWalletEngine.fund({ beneficiary: 'Jane Doe', purpose: 'medical', amountUsd: 2500 });
    expect(record).toMatchObject({
      identifier: 'dlbt-exp-jane-doe-medical',
      purpose: 'medical',
      requesterRole: 'beneficiary',
      amountUsd: 2500,
      quantity: '2500',
      sourceType: 'trust',
      sourceAccountId: '1000',
      address: EXPENSE,
      shadow: true,
      sweptCents: 0,
    });
    expect(SourceOfFundsAdapter._fundSourceToTreasury).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sweeps the hold account and submits the transfer when live', async () => {
    process.env.THIRDWEB_SERVER_WALLET_LIVE = 'true';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200, statusText: 'ok', json: async () => ({ result: { transactionIds: ['tx-exp'] } }),
    } as any);
    const record = await BeneficiaryExpenseWalletEngine.fund({ beneficiary: 'Jane Doe', purpose: 'travel', amountUsd: 1200 });
    expect(record).toMatchObject({ shadow: false, transactionId: 'tx-exp', sweptCents: 120_000 });
    expect(SourceOfFundsAdapter._fundSourceToTreasury).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: 'trust', sourceAccountId: '1000', amountCents: 120_000 })
    );
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toMatchObject({
      from: TREASURY, chainId: 1, recipients: [{ address: EXPENSE, quantity: '1200' }],
    });
    // The trust books must show the funding as a wallet obligation, not a loss.
    expect(TrustAccountingEngine.postJournalEntry).toHaveBeenCalledWith(expect.objectContaining({
      referenceType: 'expense_wallet_funding',
      lines: [
        expect.objectContaining({ accountCode: 'WALLET-FUNDS', debitAmount: 1200, creditAmount: 0 }),
        expect.objectContaining({ accountCode: 'WALLET-ALLOCATIONS', debitAmount: 0, creditAmount: 1200 }),
      ],
    }));
  });

  it('does not post a journal entry for a shadow funding', async () => {
    await BeneficiaryExpenseWalletEngine.fund({ beneficiary: 'Jane Doe', purpose: 'medical', amountUsd: 40 });
    expect(TrustAccountingEngine.postJournalEntry).not.toHaveBeenCalled();
  });

  it('reverses the hold-account sweep when the transfer fails', async () => {
    process.env.THIRDWEB_SERVER_WALLET_LIVE = 'true';
    const reverse = vi.spyOn(SourceOfFundsAdapter, '_reverseSourceOnly').mockResolvedValue({} as any);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false, status: 400, statusText: 'bad', json: async () => ({ error: { message: 'insufficient funds' } }),
    } as any);
    await expect(BeneficiaryExpenseWalletEngine.fund({ beneficiary: 'Jane Doe', purpose: 'home', amountUsd: 10 }))
      .rejects.toThrow(/insufficient funds/);
    expect(reverse).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 1000, sourceAccountId: '1000' }));
  });

  it('refuses a hold account that cannot cover or is not eligible to fund', async () => {
    (SourceOfFundsAdapter.getPosition as any).mockResolvedValue(position(100_00));
    await expect(BeneficiaryExpenseWalletEngine.fund({ beneficiary: 'Jane Doe', purpose: 'medical', amountUsd: 500 }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_SOURCE_FUNDS', status: 422 });
    (SourceOfFundsAdapter.getPosition as any).mockResolvedValue(position(500_000_00, false));
    await expect(BeneficiaryExpenseWalletEngine.fund({ beneficiary: 'Jane Doe', purpose: 'medical', amountUsd: 500 }))
      .rejects.toMatchObject({ code: 'SOURCE_RESTRICTED', status: 422 });
  });

  it('enforces the distribution policy and requires a hold account', async () => {
    await expect(BeneficiaryExpenseWalletEngine.fund({ beneficiary: 'Jane Doe', purpose: 'medical', amountUsd: 100_001 }))
      .rejects.toMatchObject({ code: 'DISTRIBUTION_LIMIT_EXCEEDED' });
    await expect(BeneficiaryExpenseWalletEngine.fund({ beneficiary: 'Jane Doe', amountUsd: 10 }))
      .rejects.toThrow(/purpose required/);
    delete process.env.EXPENSE_WALLET_HOLD_ACCOUNT_ID;
    await expect(BeneficiaryExpenseWalletEngine.fund({ beneficiary: 'Jane Doe', purpose: 'medical', amountUsd: 10 }))
      .rejects.toThrow(/sourceAccountId required/);
  });
});
