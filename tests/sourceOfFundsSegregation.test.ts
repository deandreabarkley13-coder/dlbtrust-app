import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const { SourceOfFundsAdapter } = require('../server/integrations/stablecoin/sourceOfFundsAdapter');
const { ModuleFundingEngine } = require('../server/integrations/dapp/moduleFundingEngine');
const { PtcBankEngine } = require('../server/integrations/os/osEngine');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('trust accounting funding positions', () => {
  it('normalizes a liquid asset account as available payment funds', () => {
    const position = TrustAccountingEngine.describeFundingPosition({
      account_code: '1000',
      account_name: 'Trust Cash & Equivalents',
      account_type: 'asset',
      sub_type: 'cash',
      balance: '125.50',
      is_active: true,
    });

    expect(position).toMatchObject({
      source_type: 'trust',
      source_account_id: '1000',
      source_of_truth: 'trust_accounting',
      current_balance_cents: 12550,
      available_balance_cents: 12550,
      funding_eligible: true,
      segregation_status: 'available',
    });
  });

  it.each([
    {
      account: { account_code: '4000', account_type: 'income', sub_type: 'interest_income', balance: 100, is_active: true },
      reason: 'income accounts cannot be used as payment funds',
    },
    {
      account: { account_code: '1210', account_type: 'asset', sub_type: 'cash', balance: 100, is_active: true },
      reason: 'account is segregated for a protected purpose',
    },
    {
      account: { account_code: '1010', account_type: 'asset', sub_type: 'cash', balance: 100, is_active: false },
      reason: 'account is inactive',
    },
  ])('restricts ineligible or segregated trust accounts', ({ account, reason }) => {
    const position = TrustAccountingEngine.describeFundingPosition(account);

    expect(position).toMatchObject({
      available_balance_cents: 0,
      funding_eligible: false,
      segregation_status: 'restricted',
      segregation_reason: reason,
    });
  });

  it('enforces a purpose-specific source-account allowlist', () => {
    const position = TrustAccountingEngine.describeFundingPosition({
      account_code: '1010',
      account_type: 'asset',
      sub_type: 'cash',
      balance: 100,
      is_active: true,
    }, {
      purpose: 'Melio B2B CSV payments',
      allowedAccountCodes: ['1000'],
    });

    expect(position.funding_eligible).toBe(false);
    expect(position.segregation_reason).toBe('account is not approved for Melio B2B CSV payments');
  });
});

describe('canonical source-of-funds delegation', () => {
  it('never reports available funds above the ledger balance', () => {
    const position = SourceOfFundsAdapter._position({
      sourceType: 'cash',
      sourceAccountId: 'CA-1',
      balanceCents: 5000,
      availableBalanceCents: 9000,
    });

    expect(position.currentBalanceCents).toBe(5000);
    expect(position.availableBalanceCents).toBe(5000);
  });

  it('never exposes a negative ledger balance as available funds', () => {
    const position = SourceOfFundsAdapter._position({
      sourceType: 'trust',
      sourceAccountId: '1000',
      balanceCents: -500,
      availableBalanceCents: 1000,
    });

    expect(position.currentBalanceCents).toBe(-500);
    expect(position.availableBalanceCents).toBe(0);
  });

  it('uses trust accounting as the authoritative trust position', async () => {
    vi.spyOn(TrustAccountingEngine, 'getFundingPosition').mockResolvedValue({
      account_code: '1000',
      account_name: 'Trust Cash',
      current_balance_cents: 10000,
      available_balance_cents: 7500,
      funding_eligible: true,
      segregation_reason: null,
    });

    const position = await SourceOfFundsAdapter.getPosition({
      sourceType: 'trust',
      sourceAccountId: '1000',
      purpose: 'Melio B2B CSV payments',
      allowedAccountIds: ['1000'],
    });

    expect(TrustAccountingEngine.getFundingPosition).toHaveBeenCalledWith('1000', {
      purpose: 'Melio B2B CSV payments',
      allowedAccountCodes: ['1000'],
    });
    expect(position).toMatchObject({
      sourceType: 'trust',
      sourceAccountId: '1000',
      sourceOfTruth: 'trust_accounting',
      currentBalanceCents: 10000,
      availableBalanceCents: 7500,
      fundingEligible: true,
    });
  });

  it('posts trust-to-trust transfers as debit destination and credit source', async () => {
    vi.spyOn(TrustAccountingEngine, 'assertFundingAvailable').mockResolvedValue({});
    vi.spyOn(TrustAccountingEngine, 'getAccount').mockResolvedValue({
      account_code: '1010',
      account_type: 'asset',
      is_active: true,
    });
    const post = vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ entry_id: 'JRN-1' });

    await ModuleFundingEngine.internalTransfer({
      fromType: 'trust',
      fromAccountId: '1000',
      toType: 'trust',
      toAccountId: '1010',
      amount: 25,
    });

    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      lines: [
        expect.objectContaining({ accountCode: '1010', debitAmount: 25, creditAmount: 0 }),
        expect.objectContaining({ accountCode: '1000', debitAmount: 0, creditAmount: 25 }),
      ],
    }));
  });
});

describe('PTC bank trust funding controls', () => {
  it('validates the source through trust accounting before posting or depositing', async () => {
    const assertFundingAvailable = vi.fn().mockRejectedValue(
      new Error('Segregation of funds violation for trust:4000: income accounts cannot be used as payment funds')
    );
    const postJournalEntry = vi.fn();
    const deposit = vi.fn();
    vi.spyOn(PtcBankEngine, '_deps').mockReturnValue({
      TrustBank: {
        getAccount: vi.fn().mockResolvedValue({
          account_id: 'PTC-1',
          linked_trust_account_code: '1010',
        }),
        deposit,
      },
      TrustAccounting: {
        assertFundingAvailable,
        postJournalEntry,
      },
    });

    await expect(PtcBankEngine._process('fundFromSource', {
      accountId: 'PTC-1',
      sourceType: 'trust',
      sourceAccountId: '4000',
      amount: 10,
    })).rejects.toThrow('Segregation of funds violation for trust:4000');

    expect(assertFundingAvailable).toHaveBeenCalledWith('4000', 1000, {
      purpose: 'PTC bank funding',
    });
    expect(postJournalEntry).not.toHaveBeenCalled();
    expect(deposit).not.toHaveBeenCalled();
  });
});
