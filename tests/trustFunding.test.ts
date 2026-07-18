import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

// electronicSettlementEngine is a CommonJS module in the server tree.
const require = createRequire(import.meta.url);
const settlementEngine = require('../server/integrations/payments/electronicSettlementEngine');

describe('electronicSettlementEngine.resolveSettlementJeAccounts', () => {
  const { ACCOUNT_CODES, resolveSettlementJeAccounts } = settlementEngine;

  it('books a trust_deposit as an asset reclass: DR Trust Checking / CR source cash', () => {
    const a = resolveSettlementJeAccounts('trust_deposit', ACCOUNT_CODES.CASH);
    expect(a.debitCode).toBe(ACCOUNT_CODES.TRUST_CHECKING); // 1010
    expect(a.creditCode).toBe(ACCOUNT_CODES.CASH);          // 1000
  });

  it('treats internal_transfer the same as a deposit into the bank account', () => {
    const a = resolveSettlementJeAccounts('internal_transfer', '1099');
    expect(a.debitCode).toBe(ACCOUNT_CODES.TRUST_CHECKING);
    expect(a.creditCode).toBe('1099'); // honors sub-ledger parent cash account
  });

  it('preserves prior behavior for distributions and generic payments', () => {
    const dist = resolveSettlementJeAccounts('trust_distribution', undefined);
    expect(dist.debitCode).toBe(ACCOUNT_CODES.DISTRIBUTIONS);
    expect(dist.creditCode).toBe(ACCOUNT_CODES.CASH); // defaults to 1000

    const vendor = resolveSettlementJeAccounts('vendor_payment', ACCOUNT_CODES.CASH);
    expect(vendor.debitCode).toBe(ACCOUNT_CODES.EXPENSES);
    expect(vendor.creditCode).toBe(ACCOUNT_CODES.CASH);
  });
});

describe('electronicSettlementEngine.depositToTrustChecking', () => {
  const OLD = process.env.TRUST_BANK_ACCOUNT;
  beforeEach(() => { delete process.env.TRUST_BANK_ACCOUNT; });
  afterEach(() => { if (OLD !== undefined) process.env.TRUST_BANK_ACCOUNT = OLD; });

  it('refuses to originate when no destination account is configured', async () => {
    await expect(settlementEngine.depositToTrustChecking({ amount: 100 }))
      .rejects.toThrow(/TRUST_BANK_ACCOUNT/);
  });
});
