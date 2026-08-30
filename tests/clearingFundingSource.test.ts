import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const {
  FundingSourceRegistry,
  describeOperating,
  describeBeneficiary,
  getFundingSourceConfig,
  parseRef,
} = require('../server/integrations/inhouseBank/clearing/fundingSourceRegistry');
const { ClearingAutoFormatEngine } = require('../server/integrations/inhouseBank/clearing/clearingAutoFormatEngine');
const { normalize } = require('../server/integrations/inhouseBank/clearing/clearingIntakeDetector');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const { SubLedgerEngine } = require('../server/integrations/accounting/subLedgerEngine');

const OPERATING_ROW = {
  account_code: '1010',
  account_name: 'Trust Checking',
  account_type: 'asset',
  sub_type: 'operating',
  balance: '50000.00',
  is_active: true,
};

function subLedger(overrides: Record<string, any> = {}) {
  return {
    sub_ledger_id: 'SL-JANE',
    contact_id: 'CT-JANE',
    contact_type: 'beneficiary',
    first_name: 'Jane',
    last_name: 'Doe',
    parent_account_code: '2100',
    sub_account_name: 'Jane Doe distribution account',
    sub_account_type: 'distribution',
    balance: '9000.00',
    currency: 'USD',
    status: 'active',
    ...overrides,
  };
}

function ledgers(rows: Record<string, any>[]) {
  vi.spyOn(TrustAccountingEngine, 'getAccount').mockImplementation(async (code: string) =>
    (code === process.env.CLEARING_FUNDING_OPERATING_ACCOUNT || code === '1010'
      ? TrustAccountingEngine.describeFundingPosition(OPERATING_ROW)
      : null)
  );
  vi.spyOn(SubLedgerEngine, 'ensureTables').mockResolvedValue(undefined);
  vi.spyOn(SubLedgerEngine, 'listSubLedgers').mockResolvedValue(rows);
}

const VENDOR_CSV = [
  'reference,payee_name,routing_number,account_number,amount,rail',
  'INV-1,ACME SUPPLY CO,021000021,1234567890,1250.00,fedwire',
].join('\n');

const DISTRIBUTION_CSV = [
  'reference,payee_name,routing_number,account_number,amount,rail,funding_source',
  'DIST-1,JANE DOE,021000021,55566677,900.00,fedwire,SL-JANE',
].join('\n');

describe('clearing funding sources — the two permitted classes', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.CLEARING_AUTOFORMAT_SENDER_NAME = 'DLB TRUST';
    process.env.CLEARING_AUTOFORMAT_SENDER_ROUTING = '021000021';
    process.env.CLEARING_AUTOFORMAT_SENDER_ACCOUNT = '100200300';
    process.env.CLEARING_FUNDING_OPERATING_ACCOUNT = '1010';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  it('reads the trust operating account’s position from the chart of accounts', () => {
    const source = describeOperating(
      TrustAccountingEngine.describeFundingPosition(OPERATING_ROW),
      getFundingSourceConfig()
    );
    expect(source).toMatchObject({
      sourceType: 'trust_operating',
      sourceKey: 'trust:1010',
      sourceOfTruth: 'trust_accounting',
      debtorName: 'DLB TRUST',
      debtorAccountNumber: '100200300',
      availableCents: 5000000,
      eligible: true,
    });
  });

  it('names the beneficiary in a beneficiary-funded wire without inventing them a bank account', () => {
    const source = describeBeneficiary(subLedger(), getFundingSourceConfig());
    expect(source).toMatchObject({
      sourceType: 'beneficiary_trust',
      sourceKey: 'beneficiary:SL-JANE',
      sourceOfTruth: 'client_sub_ledger',
      // The trust's own settlement account is debited for the benefit of the
      // beneficiary; the sub-ledger is a claim on it, not a DDA of its own.
      debtorName: 'DLB TRUST FBO JANE DOE',
      debtorAccountNumber: '100200300',
      availableCents: 900000,
      eligible: true,
    });
    expect(source.beneficiary).toMatchObject({ contactId: 'CT-JANE', name: 'Jane Doe' });
  });

  it.each([
    { row: { status: 'frozen' }, reason: /is frozen/ },
    { row: { contact_type: 'counterparty' }, reason: /not a beneficiary of the trust/ },
    { row: { sub_account_type: 'accrued_interest' }, reason: /not spendable trust funds/ },
    { row: { balance: '0.00' }, reason: /holds no funds/ },
  ])('restricts a sub-ledger that is not spendable beneficiary trust money', ({ row, reason }) => {
    const source = describeBeneficiary(subLedger(row), getFundingSourceConfig());
    expect(source.eligible).toBe(false);
    expect(source.availableCents).toBe(0);
    expect(source.ineligibleReason).toMatch(reason);
  });

  it('scopes a reference to the class it names', () => {
    expect(parseRef('operating')).toMatchObject({ scope: null, id: 'operating' });
    expect(parseRef('operating:1010')).toMatchObject({ scope: 'trust_operating', id: '1010' });
    expect(parseRef('trust:1010')).toMatchObject({ scope: 'trust_operating', id: '1010' });
    expect(parseRef('beneficiary:SL-JANE')).toMatchObject({ scope: 'beneficiary_trust', id: 'SL-JANE' });
    expect(parseRef('SL-JANE')).toMatchObject({ scope: null, id: 'SL-JANE' });
    // A scope naming an account of some other kind is not downgraded to a bare
    // lookup, so `cash:CA-BOND-PROCEEDS` can never match anything.
    expect(parseRef('cash:CA-BOND-PROCEEDS')).toMatchObject({ scope: 'unsupported', scopeLabel: 'cash' });
  });

  it('resolves either class by id, code, name, contact or the account number the bank debits', async () => {
    ledgers([subLedger()]);
    for (const ref of ['operating', 'trust:1010', '1010', 'Trust Checking', '100200300', null]) {
      expect(await FundingSourceRegistry.resolve(ref)).toMatchObject({ sourceKey: 'trust:1010' });
    }
    for (const ref of ['beneficiary:SL-JANE', 'SL-JANE', 'CT-JANE', 'Jane Doe']) {
      expect(await FundingSourceRegistry.resolve(ref)).toMatchObject({ sourceKey: 'beneficiary:SL-JANE' });
    }
  });

  it('refuses every account outside the two permitted classes', async () => {
    ledgers([subLedger()]);
    await expect(FundingSourceRegistry.resolve('cash:CA-BOND-PROCEEDS'))
      .rejects.toMatchObject({ code: 'CLEARING_FUNDING_SOURCE_NOT_PERMITTED' });
    await expect(FundingSourceRegistry.resolve('CA-RESERVE'))
      .rejects.toMatchObject({ code: 'CLEARING_FUNDING_SOURCE_NOT_PERMITTED' });
    // A scoped reference is authoritative: a beneficiary reference is never
    // matched against the operating account, or the other way round.
    await expect(FundingSourceRegistry.resolve('beneficiary:1010'))
      .rejects.toMatchObject({ code: 'CLEARING_FUNDING_SOURCE_UNKNOWN' });
    await expect(FundingSourceRegistry.resolve('trust:SL-JANE'))
      .rejects.toMatchObject({ code: 'CLEARING_FUNDING_SOURCE_UNKNOWN' });
  });

  it('refuses an ineligible account of a permitted class rather than reporting it available', async () => {
    ledgers([subLedger({ status: 'closed' })]);
    await expect(FundingSourceRegistry.resolve('SL-JANE'))
      .rejects.toMatchObject({ code: 'CLEARING_FUNDING_SOURCE_INELIGIBLE' });

    ledgers([subLedger({ sub_account_type: 'fee' })]);
    await expect(FundingSourceRegistry.resolve('SL-JANE'))
      .rejects.toMatchObject({ code: 'CLEARING_FUNDING_SOURCE_INELIGIBLE' });
  });

  it('checks a source against the whole file, not one payment at a time', async () => {
    ledgers([subLedger({ balance: '1000.00' })]);
    const { instructions } = normalize(JSON.stringify({
      payments: [
        { id: 'D-1', beneficiary: 'JANE DOE', aba: '021000021', account: '1', amount: '600.00', rail: 'fedwire', funding_source: 'SL-JANE' },
        { id: 'D-2', beneficiary: 'JANE DOE', aba: '021000021', account: '1', amount: '600.00', rail: 'fedwire', funding_source: 'SL-JANE' },
      ],
    }));
    const plan = await FundingSourceRegistry.plan(instructions);
    expect(plan.sources).toHaveLength(1);
    expect(plan.sources[0]).toMatchObject({
      sourceKey: 'beneficiary:SL-JANE',
      itemCount: 2,
      amountCents: 120000,
      availableCents: 100000,
      shortfallCents: 20000,
      funded: false,
    });
    expect(plan.failures[0]).toMatchObject({ code: 'CLEARING_FUNDING_SOURCE_INSUFFICIENT' });
  });

  it('reports rather than throws while planning, so a workflow gets one answer for the file', async () => {
    ledgers([subLedger()]);
    const { instructions } = normalize(JSON.stringify({
      payments: [
        { id: 'X-1', beneficiary: 'ACME', aba: '021000021', account: '1', amount: '10.00', rail: 'fedwire', funding_source: 'cash:CA-ESCROW' },
        { id: 'X-2', beneficiary: 'ACME', aba: '021000021', account: '1', amount: '10.00', rail: 'fedwire', funding_source: 'CT-NOBODY' },
      ],
    }));
    const plan = await FundingSourceRegistry.plan(instructions);
    expect(plan.failures.map((failure: any) => failure.instruction)).toEqual(['X-1', 'X-2']);
    expect(plan.sources).toHaveLength(0);
    await expect(FundingSourceRegistry.apply(instructions))
      .rejects.toMatchObject({ code: 'CLEARING_FUNDING_UNFUNDABLE' });
  });
});

describe('clearing funding sources — through the data workflow', () => {
  let workDir: string;
  const saved = { ...process.env };

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearing-funding-'));
    process.env.CLEARING_AUTOFORMAT_ARCHIVE_DIR = path.join(workDir, 'archive');
    process.env.CLEARING_AUTOFORMAT_SENDER_NAME = 'DLB TRUST';
    process.env.CLEARING_AUTOFORMAT_SENDER_ROUTING = '021000021';
    process.env.CLEARING_AUTOFORMAT_SENDER_ACCOUNT = '100200300';
    process.env.CLEARING_FUNDING_OPERATING_ACCOUNT = '1010';
    ledgers([subLedger()]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...saved };
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('funds a vendor file from the trust operating account and says so in the file and its manifest', async () => {
    const result = await ClearingAutoFormatEngine.format({ input: VENDOR_CSV, source: 'test' });
    expect(result.funding.sources).toEqual([
      expect.objectContaining({
        sourceType: 'trust_operating',
        sourceKey: 'trust:1010',
        accountName: 'Trust Checking',
        itemCount: 1,
        amountCents: 125000,
        funded: true,
      }),
    ]);

    const file = result.files[0];
    expect(file.payload).toContain('<Dbtr><Nm>DLB TRUST</Nm></Dbtr>');
    expect(file.payload).toContain('<DbtrAcct><Id><Othr><Id>100200300</Id></Othr></Id></DbtrAcct>');
    expect(file.manifest.items[0]).toMatchObject({
      fundingSource: 'trust:1010',
      fundingAccountName: 'Trust Checking',
    });
    // The archived manifest is the audit record of the funding, not just of the
    // bytes.
    const archived = JSON.parse(
      fs.readFileSync(path.join(file.archivePath, `${file.filename}.manifest.json`), 'utf8')
    );
    expect(archived.funding.sources[0].sourceKey).toBe('trust:1010');
  });

  it('funds a distribution from the beneficiary’s own trust account when the workflow names it', async () => {
    const result = await ClearingAutoFormatEngine.format({ input: DISTRIBUTION_CSV, source: 'test' });
    expect(result.funding.sources[0]).toMatchObject({
      sourceType: 'beneficiary_trust',
      sourceKey: 'beneficiary:SL-JANE',
      itemCount: 1,
      funded: true,
    });
    expect(result.files[0].payload).toContain('<Dbtr><Nm>DLB TRUST FBO JANE DOE</Nm></Dbtr>');
    expect(result.files[0].payload).toContain('<DbtrAcct><Id><Othr><Id>100200300</Id></Othr></Id></DbtrAcct>');
  });

  it('draws the whole file on the source the caller names, whatever its rows say', async () => {
    const result = await ClearingAutoFormatEngine.format({
      input: DISTRIBUTION_CSV,
      fundingSource: 'operating',
      source: 'test',
    });
    expect(result.funding.sources).toHaveLength(1);
    expect(result.funding.sources[0].sourceKey).toBe('trust:1010');
  });

  it('refuses to render a file drawn on an account the trust may not spend from', async () => {
    const escrowCsv = [
      'reference,payee_name,routing_number,account_number,amount,rail,funding_source',
      'INV-9,ACME SUPPLY CO,021000021,1234567890,10.00,fedwire,cash:CA-ESCROW',
    ].join('\n');
    await expect(ClearingAutoFormatEngine.format({ input: escrowCsv, source: 'test' }))
      .rejects.toMatchObject({ code: 'CLEARING_FUNDING_SOURCE_NOT_PERMITTED', status: 409 });
    // Nothing was rendered, archived or delivered.
    expect(fs.existsSync(path.join(workDir, 'archive'))).toBe(false);
  });

  it('refuses a file the named beneficiary account cannot cover', async () => {
    ledgers([subLedger({ balance: '5.00' })]);
    await expect(ClearingAutoFormatEngine.format({ input: DISTRIBUTION_CSV, source: 'test' }))
      .rejects.toMatchObject({ code: 'CLEARING_FUNDING_SOURCE_INSUFFICIENT' });
  });

  it('plans a workflow’s export without rendering or refusing anything', async () => {
    ledgers([subLedger({ balance: '1.00' })]);
    const plan = await ClearingAutoFormatEngine.plan({ input: DISTRIBUTION_CSV });
    expect(plan).toMatchObject({ rail: 'fedwire', spec: 'pacs.008.001.08-fedwire' });
    expect(plan.funding.fundable).toBe(false);
    expect(plan.funding.failures[0]).toMatchObject({ code: 'CLEARING_FUNDING_SOURCE_INSUFFICIENT' });
    expect(fs.existsSync(path.join(workDir, 'archive'))).toBe(false);
  });

  it('lists the accounts the workflow may draw on', async () => {
    const funding = await ClearingAutoFormatEngine.fundingSources();
    expect(funding.ready).toBe(true);
    expect(funding.sources.map((source: any) => source.sourceKey)).toEqual(['trust:1010', 'beneficiary:SL-JANE']);
    expect(funding.operatingAccount).toMatchObject({ sourceId: '1010', available: '50000.00' });
    expect(funding.beneficiaryAccounts).toBe(1);
  });

  it('reports the funding source instead of enforcing it when enforcement is off', async () => {
    process.env.CLEARING_FUNDING_ENFORCE = 'false';
    const escrowCsv = [
      'reference,payee_name,routing_number,account_number,amount,rail,funding_source',
      'INV-9,ACME SUPPLY CO,021000021,1234567890,10.00,fedwire,cash:CA-ESCROW',
    ].join('\n');
    const result = await ClearingAutoFormatEngine.format({ input: escrowCsv, source: 'test' });
    expect(result.funding.failures[0]).toMatchObject({ code: 'CLEARING_FUNDING_SOURCE_NOT_PERMITTED' });
    expect(result.funding.sources).toHaveLength(0);
    // The instruction keeps whatever debtor its source data carried; nothing is
    // silently redirected at a permitted account.
    expect(result.files[0].manifest.items[0].fundingSource).toBeNull();
  });
});
