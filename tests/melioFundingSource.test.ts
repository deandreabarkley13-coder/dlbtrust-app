import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { MelioEngine } = require('../server/integrations/os/osEngine');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const { SubLedgerEngine } = require('../server/integrations/accounting/subLedgerEngine');

const OPERATING_ACCOUNT = {
  account_code: '1000',
  account_name: 'Trust Cash & Equivalents',
  balance_cents: 5000000,
  available_balance_cents: 5000000,
  funding_eligible: true,
  currency: 'USD',
};

const BENEFICIARY_LEDGER = {
  sub_ledger_id: 'SL-JANE',
  contact_id: 'CT-JANE',
  contact_type: 'beneficiary',
  first_name: 'Jane',
  last_name: 'Doe',
  sub_account_name: 'Jane Doe distribution account',
  sub_account_type: 'distribution',
  parent_account_code: '1000',
  status: 'active',
  balance: 2500,
  currency: 'USD',
};

function mockLedgers(ledgers: any[] = [BENEFICIARY_LEDGER], account: any = OPERATING_ACCOUNT) {
  vi.spyOn(TrustAccountingEngine, 'getAccount').mockImplementation(async (code: string) => (
    account && String(account.account_code) === String(code) ? account : null
  ));
  vi.spyOn(SubLedgerEngine, 'ensureTables').mockResolvedValue(undefined);
  vi.spyOn(SubLedgerEngine, 'listSubLedgers').mockResolvedValue(ledgers);
}

function mockPosition() {
  const getPosition = vi.fn().mockResolvedValue({
    currentBalanceCents: 2500000,
    availableBalanceCents: 2500000,
    fundingEligible: true,
    segregationStatus: 'available',
    sourceOfTruth: 'trust_accounting',
  });
  vi.spyOn(MelioEngine, '_deps').mockReturnValue({ SourceOfFunds: { getPosition } });
  return getPosition;
}

describe('Melio funding sources', () => {
  const previousOperating = process.env.CLEARING_FUNDING_OPERATING_ACCOUNT;

  beforeEach(() => {
    process.env.CLEARING_FUNDING_OPERATING_ACCOUNT = '1010,1000';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousOperating === undefined) delete process.env.CLEARING_FUNDING_OPERATING_ACCOUNT;
    else process.env.CLEARING_FUNDING_OPERATING_ACCOUNT = previousOperating;
  });

  it('funds a bill from the Trust Operating Account the trust actually keeps', async () => {
    mockLedgers();
    const getPosition = mockPosition();

    const source = await MelioEngine._sourceBalance('trust', '1000');

    expect(source.fundingSource).toMatchObject({
      sourceType: 'trust_operating',
      sourceKey: 'trust:1000',
      accountName: 'Trust Cash & Equivalents',
    });
    expect(getPosition).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: 'trust',
      sourceAccountId: '1000',
    }));
  });

  it('funds a bill from a Beneficiary Trust Account without an env entry per beneficiary', async () => {
    mockLedgers();
    const getPosition = mockPosition();

    const source = await MelioEngine._sourceBalance('sub_ledger', 'SL-JANE');

    expect(source.fundingSource).toMatchObject({
      sourceType: 'beneficiary_trust',
      sourceKey: 'beneficiary:SL-JANE',
      beneficiary: { contactId: 'CT-JANE', name: 'Jane Doe' },
    });
    expect(getPosition).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: 'sub_ledger',
      sourceAccountId: 'SL-JANE',
      allowedAccountIds: ['SL-JANE'],
    }));
  });

  it('refuses an account outside the two permitted classes even when Melio allows it', async () => {
    mockLedgers();
    mockPosition();
    vi.spyOn(MelioEngine, '_cfg').mockReturnValue({
      ...MelioEngine._cfg(),
      allowedSourceAccounts: ['1000', 'bond:1100'],
    });

    await expect(MelioEngine._sourceBalance('bond', '1100')).rejects.toThrow(
      /names a bond account/,
    );
  });

  it('refuses a beneficiary sub-ledger that is not spendable trust funds', async () => {
    mockLedgers([{ ...BENEFICIARY_LEDGER, sub_account_type: 'accrued_interest' }]);
    mockPosition();

    await expect(MelioEngine._sourceBalance('sub_ledger', 'SL-JANE')).rejects.toThrow(
      /not spendable trust funds/,
    );
  });

  it('refuses a sub-ledger held for someone who is not a beneficiary', async () => {
    mockLedgers([{ ...BENEFICIARY_LEDGER, contact_type: 'vendor' }]);
    mockPosition();

    await expect(MelioEngine._sourceBalance('sub_ledger', 'SL-JANE')).rejects.toThrow(
      /No beneficiary trust account matches/,
    );
  });

  it('resolves the cash model operating account to the same operating source', async () => {
    mockLedgers();
    mockPosition();

    const source = await MelioEngine._sourceBalance('cash', 'CA-OPERATING');

    expect(source.fundingSource).toMatchObject({
      sourceType: 'trust_operating',
      sourceKey: 'trust:1000',
    });
  });

  it('settles a beneficiary draw through the trust instrument Melio holds', async () => {
    const cfg = {
      ...MelioEngine._cfg(),
      portalFundingSourceMap: { 'trust:1000': { label: 'DLB Trust', accountLast4: '4321' } },
    };

    const portal = MelioEngine._resolvePortalFundingSource('sub_ledger', 'SL-JANE', cfg, {
      sourceType: 'beneficiary_trust',
      sourceKey: 'beneficiary:SL-JANE',
    });

    expect(portal).toMatchObject({ label: 'DLB Trust', accountLast4: '4321' });
  });

  it('still refuses to export when no Melio portal instrument is mapped at all', () => {
    const cfg = {
      ...MelioEngine._cfg(),
      portalFundingSourceMap: {},
      defaultPortalFundingSourceLabel: '',
      defaultSourceAccountId: '1000',
    };

    expect(MelioEngine._resolvePortalFundingSource('sub_ledger', 'SL-JANE', cfg, {
      sourceType: 'beneficiary_trust',
    })).toBeNull();
  });

  it('records the funding class and beneficiary on the payment', () => {
    expect(MelioEngine._registryFundingMetadata({
      sourceType: 'beneficiary_trust',
      sourceKey: 'beneficiary:SL-JANE',
      accountName: 'Jane Doe distribution account',
      sourceOfTruth: 'client_sub_ledger',
      beneficiary: { contactId: 'CT-JANE', name: 'Jane Doe' },
    })).toEqual({
      fundingClass: 'beneficiary_trust',
      fundingSourceKey: 'beneficiary:SL-JANE',
      fundingAccountName: 'Jane Doe distribution account',
      fundingSourceOfTruth: 'client_sub_ledger',
      beneficiary: { contactId: 'CT-JANE', name: 'Jane Doe' },
    });
  });
});
