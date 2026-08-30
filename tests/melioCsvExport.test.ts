import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { MelioEngine } = require('../server/integrations/os/osEngine');
const { EmailEngine } = require('../server/integrations/dapp/emailEngine');
const { PaymentComplianceGate } = require('../server/integrations/compliance/paymentComplianceGate');
const pool = require('../server/integrations/bonds/pgPool');
const vendorsRouter = require('../server/routes/vendors');

const markSubmittedRoute = vendorsRouter.stack.find(
  (layer: any) => layer.route?.path === '/payments/melio/:identifier/mark-submitted',
);
const markSubmittedHandler = markSubmittedRoute.route.stack[markSubmittedRoute.route.stack.length - 1].handle;
const markPaidRoute = vendorsRouter.stack.find(
  (layer: any) => layer.route?.path === '/payments/melio/:identifier/mark-paid',
);
const markPaidHandler = markPaidRoute.route.stack[markPaidRoute.route.stack.length - 1].handle;

describe('Melio bill spreadsheet CSV export', () => {
  beforeEach(() => {
    vi.spyOn(MelioEngine, '_compliancePayload').mockImplementation(async (payload: any) => payload);
    vi.spyOn(PaymentComplianceGate, 'verifyRecordedScreening').mockResolvedValue({
      screening_id: 'COMP-MELIO-TEST',
      status: 'clear',
      provider: 'local',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses trust account 1000 as the canonical Melio funding default without changing other rail defaults', () => {
    const dashboard = fs.readFileSync(path.resolve(process.cwd(), 'public/os-engine-dashboard.html'), 'utf8');
    const vendorsRoutes = fs.readFileSync(path.resolve(process.cwd(), 'server/routes/vendors.js'), 'utf8');
    const config = MelioEngine._cfg();

    expect(config).toMatchObject({
      defaultSourceType: 'trust',
      defaultSourceAccountId: '1000',
      allowedSourceAccounts: ['1000'],
    });
    expect(dashboard).toContain('id="melio-source-gl" value="1000"');
    expect(dashboard).toContain('id="melio-invoice-source-gl" value="1000"');
    expect(dashboard).toContain("el('melio-source-gl').value.trim() || '1000'");
    expect(dashboard).toContain("el('melio-invoice-source-gl').value.trim() || '1000'");
    expect(dashboard).toContain('id="apisix-source-gl" value="4000"');
    expect(dashboard).toContain('id="nickel-source-gl" value="4000"');
    expect(vendorsRoutes.match(/source_account_code: paymentPayload\.source_account_code \|\| '1000'/g) || []).toHaveLength(1);
    expect(vendorsRoutes).toContain("source_account_code: paymentPayload.source_account_code || '4000'");
  });

  it('maps canonical accounts to Melio settlement instruments without changing funding authority', () => {
    const cfg = {
      ...MelioEngine._cfg(),
      defaultSourceType: 'trust',
      defaultSourceAccountId: '1000',
      defaultFundingSourceId: '',
      fundingSourceField: 'payment_method_id',
      fundingSourceMap: {
        'trust:1000': {
          id: 'melio-program-settlement',
          field: 'funding_source_id',
          type: 'partner_balance',
        },
      },
    };

    expect(MelioEngine._resolveFundingSource('trust', '1000', cfg)).toEqual({
      id: 'melio-program-settlement',
      field: 'funding_source_id',
      type: 'partner_balance',
      canonicalSourceType: 'trust',
      canonicalSourceAccountId: '1000',
    });
    expect(MelioEngine._resolveFundingSource('trust', '1010', cfg)).toBeNull();
  });

  it('maps canonical accounts to non-sensitive manual portal funding labels', () => {
    const cfg = {
      ...MelioEngine._cfg(),
      defaultSourceType: 'trust',
      defaultSourceAccountId: '1000',
      defaultPortalFundingSourceLabel: 'DLB Trust',
      defaultPortalFundingSourceLast4: '',
      portalFundingSourceMap: {
        'trust:1000': {
          label: 'Trust operating account',
          accountLast4: '1234',
        },
      },
    };

    expect(MelioEngine._resolvePortalFundingSource('trust', '1000', cfg)).toEqual({
      label: 'Trust operating account',
      accountLast4: '1234',
      canonicalSourceType: 'trust',
      canonicalSourceAccountId: '1000',
    });
    expect(MelioEngine._resolvePortalFundingSource('trust', '1010', cfg)).toBeNull();
  });

  it('redacts vendor banking coordinates from stored payment metadata', () => {
    expect(MelioEngine._sanitizePaymentPayload({
      vendor: {
        name: 'Settlement Vendor',
        bankAccount: {
          accountNumber: '1234567890',
          routingNumber: '111000025',
          accountType: 'checking',
        },
      },
    })).toMatchObject({
      vendor: {
        bankAccount: {
          accountNumber: '[REDACTED]',
          routingNumber: '[REDACTED]',
          accountType: 'checking',
        },
      },
    });
  });

  it('classifies management, income, and principal flows to distinct canonical accounts', () => {
    const cfg = MelioEngine._cfg();

    expect(MelioEngine._accountingProfile({ accountingClass: 'management_fee' }, cfg)).toMatchObject({
      debitGlAccount: '5000',
      liabilityGlAccount: '2100',
    });
    expect(MelioEngine._accountingProfile({
      accountingClass: 'beneficiary_income_distribution',
    }, cfg)).toMatchObject({
      debitGlAccount: '3100',
      liabilityGlAccount: '2000',
    });
    expect(MelioEngine._accountingProfile({
      accountingClass: 'beneficiary_principal_distribution',
    }, cfg)).toMatchObject({
      debitGlAccount: '3000',
      liabilityGlAccount: '2000',
    });
  });

  it('reserves outstanding CSV instructions against the canonical source position', async () => {
    const getPosition = vi.fn().mockResolvedValue({
      sourceType: 'trust',
      sourceAccountId: '1000',
      currentBalanceCents: 25000,
      availableBalanceCents: 20000,
      fundingEligible: true,
      segregationStatus: 'available',
      sourceOfTruth: 'trust_accounting',
    });
    vi.spyOn(MelioEngine, '_deps').mockReturnValue({ SourceOfFunds: { getPosition } });
    const querySpy = vi.spyOn(pool, 'query').mockResolvedValue({
      rows: [{ reserved_cents: '7500' }],
    });

    const source = await MelioEngine._sourceBalance('trust', '1000');

    expect(getPosition).toHaveBeenCalledWith({
      sourceType: 'trust',
      sourceAccountId: '1000',
      purpose: 'Melio B2B CSV payments',
      allowedAccountIds: ['1000'],
    });
    expect(source).toMatchObject({
      balanceCents: 12500,
      ledgerBalanceCents: 25000,
      sourceAvailableBalanceCents: 20000,
      reservedCents: 7500,
    });
    expect(querySpy.mock.calls[0][0]).toContain(
      "status NOT IN ('failed', 'cancelled', 'paid')",
    );
  });

  it('rejects a segregated source before generating a payment file', async () => {
    vi.spyOn(MelioEngine, '_deps').mockReturnValue({
      SourceOfFunds: {
        getPosition: vi.fn().mockResolvedValue({
          fundingEligible: false,
          segregationReason: 'account is segregated for a protected purpose',
        }),
      },
    });
    const query = vi.spyOn(pool, 'query');

    await expect(MelioEngine._sourceBalance('trust', '1210')).rejects.toThrow(
      'Segregation of funds violation for trust:1210: account is segregated for a protected purpose',
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('writes exports to the configured directory and validates downloads within it', () => {
    const exportDir = fs.mkdtempSync(path.join(process.cwd(), 'data', 'melio-export-test-'));
    const previousExportDir = process.env.MELIO_EXPORT_DIR;
    process.env.MELIO_EXPORT_DIR = exportDir;

    try {
      const now = new Date('2026-01-15T12:00:00.000Z');
      const entry = MelioEngine._buildCsvRow({
        amount: 4.25,
        vendor: { name: 'Configured Directory Vendor' },
        dueDate: '2026-02-01',
      }, 'MEL-CONFIGURED-DIR', now);
      const file = MelioEngine._writeCsvFiles([entry], 'MEL-CONFIGURED-DIR', now)[0];

      expect(path.dirname(file.filePath)).toBe(path.resolve(exportDir));
      expect(fs.existsSync(file.filePath)).toBe(true);
      expect(MelioEngine._resolveExportPath(file.filePath, file.fileName)).toBe(file.filePath);
      expect(MelioEngine._resolveExportPath(path.join(exportDir, '..', 'outside.csv'), 'outside.csv')).toBeNull();
      expect(MelioEngine._resolveExportPath(path.join(exportDir, file.fileName), '../outside.csv')).toBeNull();
      expect(() => MelioEngine._validateExportIdentifier('../outside')).toThrow('Invalid Melio export identifier');
    } finally {
      if (previousExportDir === undefined) delete process.env.MELIO_EXPORT_DIR;
      else process.env.MELIO_EXPORT_DIR = previousExportDir;
      fs.rmSync(exportDir, { recursive: true, force: true });
    }
  });

  it('returns 404 for unknown mark-paid identifiers and 400 for invalid ones', async () => {
    const recordsSpy = vi.spyOn(MelioEngine, '_getRecordsByExportIdentifier').mockImplementation(async (identifier: string) => {
      if (identifier === 'MEL--0000000000000-XXXXXX') return [];
      MelioEngine._validateExportIdentifier(identifier);
      return [];
    });
    const logSpy = vi.spyOn(MelioEngine, '_log').mockResolvedValue({ eventId: 'TEST-EVENT', status: 'failed', logged: false });

    const invoke = async (identifier: string) => {
      const response: any = {
        status: vi.fn(function status(code: number) {
          response.statusCode = code;
          return response;
        }),
        json: vi.fn(function json(body: any) {
          response.body = body;
          return response;
        }),
      };
      await markPaidHandler({ params: { identifier }, body: {} }, response);
      return response;
    };

    try {
      const unknown = await invoke('MEL--0000000000000-XXXXXX');
      expect(unknown.status).toHaveBeenCalledWith(404);
      expect(unknown.body).toMatchObject({
        success: false,
        error: 'melio.markPaid failed: Melio export not found: MEL--0000000000000-XXXXXX',
      });

      // Express normalizes a literal ../ path before routing, so it cannot
      // reach this handler; encoded forms are decoded before it and stay JSON 400s.
      for (const encoded of ['..%2F..%2Fetc%2Fpasswd', 'a%2Fb', 'a%5Cb']) {
        const invalid = await invoke(decodeURIComponent(encoded));
        expect(invalid.status).toHaveBeenCalledWith(400);
        expect(invalid.body).toMatchObject({
          success: false,
          error: 'melio.markPaid failed: Invalid Melio export identifier',
        });
      }
    } finally {
      recordsSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('records manual portal submission references through the operator route', async () => {
    const processSpy = vi.spyOn(MelioEngine, 'process').mockResolvedValue({
      id: 'MEL-PORTAL-1',
      status: 'submitted',
    });
    const response: any = {
      json: vi.fn(function json(body: any) {
        response.body = body;
        return response;
      }),
      status: vi.fn(function status() {
        return response;
      }),
    };

    await markSubmittedHandler({
      params: { identifier: 'MEL-PORTAL-1' },
      body: {
        portal_submission_reference: 'PORTAL-REF-1',
      },
      user: { email: 'operator@example.com' },
    }, response);

    expect(processSpy).toHaveBeenCalledWith({
      action: 'markSubmitted',
      identifier: 'MEL-PORTAL-1',
      portalSubmissionReference: 'PORTAL-REF-1',
      submittedAt: undefined,
      submittedBy: 'operator@example.com',
    });
    expect(response.body).toMatchObject({
      success: true,
      data: { status: 'submitted' },
    });
  });

  it('emits the Melio headers, formats values, and omits bank details', () => {
    const now = new Date('2026-01-15T12:00:00.000Z');
    const entry = MelioEngine._buildCsvRow({
      amount: 1234.5,
      dueDate: '2026-02-03',
      vendor: {
        name: 'Acme, LLC',
        email: 'vendor@example.com',
        bankAccount: {
          routingNumber: '011000015',
          accountNumber: '123456789',
          accountType: 'checking',
          bankName: 'Example Bank',
        },
      },
      memo: 'Quarterly service',
    }, 'MEL-TEST-1', now);
    const file = MelioEngine._writeCsvFiles([entry], 'test-header', now)[0];
    const csv = fs.readFileSync(file.filePath, 'utf8');

    expect(csv.split('\n')[0]).toBe('Business name,Due date,Bill amount,Invoice number,Invoice date,Note');
    expect(csv.split('\n')[1]).toBe('"Acme, LLC",2026-02-03,1234.50,MEL-TEST-1,2026-01-15,Quarterly service');
    expect(csv).not.toContain('vendor@example.com');
    expect(csv).not.toContain('011000015');
    expect(csv).not.toContain('123456789');
    expect(csv).not.toContain('Example Bank');
  });

  it('reports all invalid rows together before writing', () => {
    expect(() => MelioEngine._validateBatchRows([
      { amount: 5, vendor: { name: 'Valid Vendor' }, dueDate: '2026-02-01' },
      { amount: 7, vendor: { name: 'Missing Due Date' } },
      { amount: 0, vendor: { name: 'Bad Amount' }, dueDate: '2026-02-01' },
      { amount: 8, vendor: { name: 'Bad Date' }, dueDate: 'not-a-date' },
    ])).toThrow(/3 row\(s\)/);

    try {
      MelioEngine._validateBatchRows([
        { amount: 7, vendor: { name: 'Missing Due Date' } },
        { amount: 0, vendor: { name: 'Bad Amount' }, dueDate: '2026-02-01' },
      ]);
    } catch (err) {
      expect(err.invalidRows).toHaveLength(2);
      expect(err.outcomes).toHaveLength(2);
    }
  });

  it('preserves invalid-row details through the engine action', async () => {
    try {
      await MelioEngine.process({
        action: 'exportBatch',
        payables: [
          { amount: 5, vendor: { name: 'Missing Due Date' } },
          { amount: 0, vendor: { name: 'Bad Amount' }, dueDate: '2026-02-01' },
        ],
      });
      throw new Error('expected exportBatch to reject');
    } catch (err) {
      expect(err.invalidRows).toHaveLength(2);
      expect(err.outcomes).toHaveLength(2);
    }
  });

  it('returns chunk paths and persists one record per batch payable', async () => {
    const cfg = MelioEngine._cfg();
    const cfgSpy = vi.spyOn(MelioEngine, '_cfg').mockReturnValue({
      ...cfg,
      payBillsEmail: '',
      postPayableGl: false,
    });
    const balanceSpy = vi.spyOn(MelioEngine, '_sourceBalance').mockResolvedValue({
      balanceCents: 10000,
      account: null,
    });
    const records = [];
    const recordSpy = vi.spyOn(MelioEngine, '_recordPayment').mockImplementation(async (record) => {
      records.push(record);
    });

    try {
      const result = await MelioEngine.exportBatch({
        batchId: 'MEL-BATCH-TEST',
        payables: [
          {
            paymentId: 'MEL-ROW-1',
            amount: 5,
            vendor: { name: 'First Vendor' },
            dueDate: '2026-02-01',
          },
          {
            paymentId: 'MEL-ROW-2',
            amount: 7,
            vendor: { name: 'Second Vendor' },
            dueDate: '2026-02-02',
          },
        ],
      });

      expect(result.outcomes).toHaveLength(2);
      expect(result.outcomes.map((outcome) => outcome.paymentId)).toEqual(['MEL-ROW-1', 'MEL-ROW-2']);
      expect(result.outcomes.every((outcome) => outcome.status === 'exported')).toBe(true);
      expect(result.outcomes[0].csvPath).toBe(result.outcomes[1].csvPath);
      expect(records).toHaveLength(2);
      expect(records[0].id).toBe('MEL-ROW-1');
      expect(records[0].result.csvPath).toBe(result.outcomes[0].csvPath);
      expect(records[0].metadata.batchId).toBe('MEL-BATCH-TEST');
      expect(records[0].result.emailedTo).toBeUndefined();
      expect(records[0].emailedTo).toBeUndefined();
      expect(records[1].result.csvPath).toBe(result.outcomes[1].csvPath);
      expect(records[1].metadata.batchId).toBe('MEL-BATCH-TEST');
    } finally {
      recordSpy.mockRestore();
      balanceSpy.mockRestore();
      cfgSpy.mockRestore();
    }
  });

  it('inherits top-level source values while preserving per-row overrides', async () => {
    const cfg = MelioEngine._cfg();
    const cfgSpy = vi.spyOn(MelioEngine, '_cfg').mockReturnValue({
      ...cfg,
      payBillsEmail: '',
      postPayableGl: false,
      portalFundingSourceMap: {
        'trust:1200': 'Trust receivables test source',
        'cash:CA-OVERRIDE': 'Cash override test source',
      },
    });
    const sourceCalls = [];
    const balanceSpy = vi.spyOn(MelioEngine, '_sourceBalance').mockImplementation(async (sourceType, sourceAccountId) => {
      sourceCalls.push([sourceType, sourceAccountId]);
      return { balanceCents: 1200, account: null };
    });
    const recordSpy = vi.spyOn(MelioEngine, '_recordPayment').mockResolvedValue(undefined);

    try {
      const result = await MelioEngine.exportBatch({
        source_type: 'trust',
        source_account_id: '1200',
        payables: [
          {
            paymentId: 'MEL-INHERITED',
            amount: 5,
            vendor: { name: 'Inherited Source Vendor' },
            dueDate: '2026-02-01',
          },
          {
            paymentId: 'MEL-OVERRIDE',
            amount: 7,
            source_type: 'cash',
            source_account_id: 'CA-OVERRIDE',
            vendor: { name: 'Override Source Vendor' },
            dueDate: '2026-02-02',
          },
        ],
      });

      expect(sourceCalls).toEqual([
        ['trust', '1200'],
        ['cash', 'CA-OVERRIDE'],
      ]);
      expect(result.records.map((record) => [record.sourceType, record.sourceAccountId])).toEqual([
        ['trust', '1200'],
        ['cash', 'CA-OVERRIDE'],
      ]);
    } finally {
      recordSpy.mockRestore();
      balanceSpy.mockRestore();
      cfgSpy.mockRestore();
    }
  });

  it('names the source in insufficient-balance errors', async () => {
    const cfg = MelioEngine._cfg();
    const cfgSpy = vi.spyOn(MelioEngine, '_cfg').mockReturnValue({
      ...cfg,
      payBillsEmail: '',
      postPayableGl: false,
    });
    const balanceSpy = vi.spyOn(MelioEngine, '_sourceBalance').mockResolvedValue({
      balanceCents: 10000,
      account: null,
    });

    try {
      await expect(MelioEngine.exportBatch({
        sourceType: 'trust',
        sourceAccountId: 'TRUST-LOW',
        payables: [{
          paymentId: 'MEL-LOW-BALANCE',
          amount: 101,
          vendor: { name: 'Insufficient Vendor' },
          dueDate: '2026-02-01',
        }],
      })).rejects.toThrow('Insufficient source balance for trust:TRUST-LOW: 100.00 < 101.00');
    } finally {
      balanceSpy.mockRestore();
      cfgSpy.mockRestore();
    }
  });

  it('persists emailedTo in result for a successful-ish email send', async () => {
    const cfg = MelioEngine._cfg();
    const cfgSpy = vi.spyOn(MelioEngine, '_cfg').mockReturnValue({
      ...cfg,
      payBillsEmail: 'payables@example.com',
      postPayableGl: false,
    });
    const balanceSpy = vi.spyOn(MelioEngine, '_sourceBalance').mockResolvedValue({
      balanceCents: 10000,
      account: null,
    });
    const records = [];
    const recordSpy = vi.spyOn(MelioEngine, '_recordPayment').mockImplementation(async (record) => {
      records.push(record);
    });
    const sendSpy = vi.spyOn(EmailEngine, 'send').mockResolvedValue({
      sent: true,
      provider: 'test',
    });

    try {
      await MelioEngine.exportBatch({
        payables: [{
          paymentId: 'MEL-EMAIL-SUCCESS',
          amount: 5,
          vendor: { name: 'Emailed Vendor' },
          dueDate: '2026-02-01',
        }],
      });

      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ to: 'payables@example.com' }));
      expect(records[0].emailedTo).toBe('payables@example.com');
      expect(records[0].result).toMatchObject({
        emailSent: true,
        emailProvider: 'test',
        emailedTo: 'payables@example.com',
      });
    } finally {
      sendSpy.mockRestore();
      recordSpy.mockRestore();
      balanceSpy.mockRestore();
      cfgSpy.mockRestore();
    }
  });

  it('persists emailedTo in result for the no-provider fallback', async () => {
    const cfg = MelioEngine._cfg();
    const cfgSpy = vi.spyOn(MelioEngine, '_cfg').mockReturnValue({
      ...cfg,
      payBillsEmail: 'payables@example.com',
      postPayableGl: false,
    });
    const balanceSpy = vi.spyOn(MelioEngine, '_sourceBalance').mockResolvedValue({
      balanceCents: 10000,
      account: null,
    });
    const records = [];
    const recordSpy = vi.spyOn(MelioEngine, '_recordPayment').mockImplementation(async (record) => {
      records.push(record);
    });
    const sendSpy = vi.spyOn(EmailEngine, 'send');

    try {
      await MelioEngine.exportBatch({
        payables: [{
          paymentId: 'MEL-EMAIL-FALLBACK',
          amount: 5,
          vendor: { name: 'Fallback Vendor' },
          dueDate: '2026-02-01',
        }],
      });

      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ to: 'payables@example.com' }));
      expect(records[0].emailedTo).toBe('payables@example.com');
      expect(records[0].result).toMatchObject({
        emailSent: false,
        emailProvider: 'log',
        emailedTo: 'payables@example.com',
      });
    } finally {
      sendSpy.mockRestore();
      recordSpy.mockRestore();
      balanceSpy.mockRestore();
      cfgSpy.mockRestore();
    }
  });

  it('chunks a 301-row export at the 300-row boundary', () => {
    const now = new Date('2026-01-15T12:00:00.000Z');
    const entries = Array.from({ length: 301 }, (_, index) => MelioEngine._buildCsvRow({
      amount: 1,
      vendor: { name: `Vendor ${index + 1}` },
      dueDate: '2026-02-03',
    }, `MEL-TEST-${index + 1}`, now));
    const files = MelioEngine._writeCsvFiles(entries, 'test-chunk', now);

    expect(files).toHaveLength(2);
    expect(files[0].rowCount).toBe(300);
    expect(files[1].rowCount).toBe(1);
    expect(fs.readFileSync(files[0].filePath, 'utf8').split('\n')).toHaveLength(301);
    expect(fs.readFileSync(files[1].filePath, 'utf8').split('\n')).toHaveLength(2);
  });

  it('accrues every export to expense and payables regardless of source account type', async () => {
    const cfg = MelioEngine._cfg();
    const cfgSpy = vi.spyOn(MelioEngine, '_cfg').mockReturnValue({
      ...cfg,
      payBillsEmail: '',
      postPayableGl: true,
      expenseGlAccount: '5300',
      payablesGlAccount: '2100',
      portalFundingSourceMap: {
        'cash:CA-OPERATING': 'Cash operating test source',
      },
    });
    const deps = MelioEngine._deps();
    const postJournalEntry = vi.fn().mockResolvedValue({ entry_id: 'JRN-ACCRUAL' });
    const depsSpy = vi.spyOn(MelioEngine, '_deps').mockReturnValue({
      ...deps,
      TrustAcct: { postJournalEntry },
    });
    const balanceSpy = vi.spyOn(MelioEngine, '_sourceBalance').mockResolvedValue({
      balanceCents: 10000,
      account: { account_type: 'asset' },
    });
    const recordSpy = vi.spyOn(MelioEngine, '_recordPayment').mockResolvedValue(undefined);

    try {
      const result = await MelioEngine.exportPayment({
        amount: 12.34,
        sourceType: 'cash',
        sourceAccountId: 'CA-OPERATING',
        vendor: { name: 'Expense Vendor' },
        dueDate: '2026-02-01',
      });

      expect(result.journalEntryId).toBe('JRN-ACCRUAL');
      expect(result.result).toMatchObject({
        glPosted: true,
        expenseGlAccount: '5300',
        payableGlAccount: '2100',
      });
      expect(postJournalEntry).toHaveBeenCalledWith(expect.objectContaining({
        lines: [
          expect.objectContaining({ accountCode: '5300', debitAmount: '12.34', creditAmount: 0 }),
          expect.objectContaining({ accountCode: '2100', debitAmount: 0, creditAmount: '12.34' }),
        ],
      }));
    } finally {
      recordSpy.mockRestore();
      balanceSpy.mockRestore();
      depsSpy.mockRestore();
      cfgSpy.mockRestore();
    }
  });

  it('schedules API payments against the mapped canonical settlement instrument', async () => {
    const cfg = {
      ...MelioEngine._cfg(),
      useApi: true,
      shadow: false,
      apiKey: 'test-melio-api-key',
      apiBaseUrlConfigured: true,
      apiContractVerified: true,
      defaultSourceType: 'trust',
      defaultSourceAccountId: '1000',
      defaultFundingSourceId: '',
      fundingSourceField: 'payment_method_id',
      postPayableGl: false,
      fundingSourceMap: {
        'trust:1000': {
          id: 'melio-program-settlement',
          field: 'funding_source_id',
          type: 'partner_balance',
        },
      },
    };
    vi.spyOn(MelioEngine, '_cfg').mockReturnValue(cfg);
    vi.spyOn(MelioEngine, '_sourceBalance').mockResolvedValue({
      balanceCents: 20000,
      ledgerBalanceCents: 25000,
      reservedCents: 5000,
      position: { sourceOfTruth: 'trust_accounting' },
    });
    vi.spyOn(MelioEngine, '_getPaymentRecord').mockResolvedValue(null);
    const records: any[] = [];
    vi.spyOn(MelioEngine, '_createPendingPayment').mockImplementation(async (record: any) => {
      records.push(record);
    });
    vi.spyOn(MelioEngine, '_recordPayment').mockImplementation(async (record: any) => {
      records.push(record);
    });
    const schedulePayment = vi.fn().mockResolvedValue({
      id: 'melio-payment-1',
      status: 'scheduled',
    });
    vi.spyOn(MelioEngine, '_client').mockReturnValue({
      createVendor: vi.fn().mockResolvedValue({ id: 'melio-vendor-1' }),
      createBill: vi.fn().mockResolvedValue({ id: 'melio-bill-1' }),
      schedulePayment,
    });

    const result = await MelioEngine._schedulePayment({
      amount: 12.5,
      sourceType: 'trust',
      sourceAccountId: '1000',
      vendor: { name: 'Settlement Vendor' },
      dueDate: '2026-02-01',
    });

    expect(schedulePayment).toHaveBeenCalledWith(expect.objectContaining({
      vendor_id: 'melio-vendor-1',
      bill_id: 'melio-bill-1',
      amount: '12.5',
      funding_source_id: 'melio-program-settlement',
    }));
    expect(records.map((record) => record.status)).toEqual(['pending', 'scheduled']);
    expect(result).toMatchObject({
      sourceType: 'trust',
      sourceAccountId: '1000',
      reserveId: null,
      journalEntryId: null,
      funding: {
        authority: 'canonical_ledger',
        sourceOfTruth: 'trust_accounting',
        reservationStatus: 'active',
        settlementInstrument: {
          id: 'melio-program-settlement',
          type: 'partner_balance',
          canonicalSourceAccountId: '1000',
        },
      },
    });
  });

  it('rejects live API scheduling without a mapped settlement instrument', async () => {
    vi.spyOn(MelioEngine, '_cfg').mockReturnValue({
      ...MelioEngine._cfg(),
      useApi: true,
      shadow: false,
      apiKey: 'test-melio-api-key',
      apiBaseUrlConfigured: true,
      apiContractVerified: true,
      defaultFundingSourceId: '',
      fundingSourceMap: {},
    });
    vi.spyOn(MelioEngine, '_sourceBalance').mockResolvedValue({
      balanceCents: 20000,
      ledgerBalanceCents: 20000,
      reservedCents: 0,
      position: { sourceOfTruth: 'trust_accounting' },
    });
    const createVendor = vi.fn();
    vi.spyOn(MelioEngine, '_client').mockReturnValue({
      createVendor,
      createBill: vi.fn(),
      schedulePayment: vi.fn(),
    });

    await expect(MelioEngine._schedulePayment({
      amount: 12.5,
      sourceType: 'trust',
      sourceAccountId: '1000',
      vendor: { name: 'Settlement Vendor' },
      dueDate: '2026-02-01',
    })).rejects.toThrow(
      'No Melio settlement instrument is mapped to trust:1000',
    );
    expect(createVendor).not.toHaveBeenCalled();
  });

  it('does not resubmit an existing canonical payment identifier', async () => {
    vi.spyOn(MelioEngine, '_cfg').mockReturnValue({
      ...MelioEngine._cfg(),
      useApi: true,
      shadow: false,
      apiKey: 'test-melio-api-key',
      apiBaseUrlConfigured: true,
      apiContractVerified: true,
      defaultFundingSourceId: 'melio-program-settlement',
    });
    vi.spyOn(MelioEngine, '_getPaymentRecord').mockResolvedValue({
      id: 'MEL-CC-EXISTING',
      status: 'scheduled',
      melio_payment_id: 'melio-remote-existing',
    });
    const sourceBalance = vi.spyOn(MelioEngine, '_sourceBalance');
    const schedulePayment = vi.fn();
    vi.spyOn(MelioEngine, '_client').mockReturnValue({ schedulePayment });

    await expect(MelioEngine._schedulePayment({
      paymentId: 'MEL-CC-EXISTING',
      amount: 12.5,
      sourceType: 'trust',
      sourceAccountId: '1000',
      vendor: { name: 'Settlement Vendor' },
      dueDate: '2026-02-01',
    })).rejects.toThrow(
      'Melio payment MEL-CC-EXISTING already exists with status scheduled',
    );
    expect(sourceBalance).not.toHaveBeenCalled();
    expect(schedulePayment).not.toHaveBeenCalled();
  });

  it('fails live scheduling closed before contacting Melio when readiness is incomplete', async () => {
    vi.spyOn(MelioEngine, '_cfg').mockReturnValue({
      ...MelioEngine._cfg(),
      useApi: true,
      shadow: false,
      apiKey: '',
      apiBaseUrlConfigured: false,
      apiContractVerified: false,
      defaultFundingSourceId: 'melio-program-settlement',
    });
    const sourceBalance = vi.spyOn(MelioEngine, '_sourceBalance');
    const client = vi.spyOn(MelioEngine, '_client');

    await expect(MelioEngine._schedulePayment({
      amount: 12.5,
      sourceType: 'trust',
      sourceAccountId: '1000',
      vendor: { name: 'Settlement Vendor' },
      dueDate: '2026-02-01',
    })).rejects.toThrow(
      'MELIO_API_KEY is required; MELIO_BASE_URL must be explicitly configured; '
      + 'MELIO_API_CONTRACT_VERIFIED must be true',
    );
    expect(sourceBalance).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
  });

  it('settles the canonical payment only after authenticated API polling reports completion', async () => {
    vi.spyOn(MelioEngine, '_cfg').mockReturnValue({
      ...MelioEngine._cfg(),
      shadow: false,
    });
    const ready = vi.spyOn(MelioEngine, 'assertLiveApiReady').mockReturnValue({
      id: 'melio-program-settlement',
      field: 'payment_method_id',
    });
    vi.spyOn(MelioEngine, '_getPaymentRecord').mockResolvedValue({
      id: 'MEL-CANONICAL-1',
      source_type: 'trust',
      source_account_id: '1000',
      melio_payment_id: 'melio-remote-1',
      status: 'scheduled',
      result: {},
    });
    const getPayment = vi.fn().mockResolvedValue({
      id: 'melio-remote-1',
      status: 'completed',
    });
    vi.spyOn(MelioEngine, '_client').mockReturnValue({ getPayment });
    const markPaid = vi.spyOn(MelioEngine, '_markPaidRecord').mockResolvedValue({
      id: 'MEL-CANONICAL-1',
      status: 'paid',
      settlementJournalEntryId: 'JE-SETTLEMENT-1',
    });

    const result = await MelioEngine._getPayment({ paymentId: 'MEL-CANONICAL-1' });

    expect(ready).toHaveBeenCalledWith('trust', '1000', expect.any(Object));
    expect(getPayment).toHaveBeenCalledWith('melio-remote-1');
    expect(markPaid).toHaveBeenCalledWith(expect.objectContaining({
      id: 'MEL-CANONICAL-1',
      status: 'completed',
      result: {
        remote: {
          id: 'melio-remote-1',
          status: 'completed',
        },
      },
    }));
    expect(result.status).toBe('paid');
  });

  it('uses the per-payable expense account override', async () => {
    const cfg = MelioEngine._cfg();
    const cfgSpy = vi.spyOn(MelioEngine, '_cfg').mockReturnValue({
      ...cfg,
      payBillsEmail: '',
      postPayableGl: true,
      expenseGlAccount: '5300',
      payablesGlAccount: '2100',
      portalFundingSourceMap: {
        'trust:4000': 'Trust income test source',
      },
    });
    const deps = MelioEngine._deps();
    const postJournalEntry = vi.fn().mockResolvedValue({ entry_id: 'JRN-LEGAL' });
    const depsSpy = vi.spyOn(MelioEngine, '_deps').mockReturnValue({
      ...deps,
      TrustAcct: { postJournalEntry },
    });
    const balanceSpy = vi.spyOn(MelioEngine, '_sourceBalance').mockResolvedValue({
      balanceCents: 10000,
      account: { account_type: 'income' },
    });
    const recordSpy = vi.spyOn(MelioEngine, '_recordPayment').mockResolvedValue(undefined);

    try {
      const result = await MelioEngine.exportBatch({
        sourceType: 'trust',
        sourceAccountId: '4000',
        payables: [{
          paymentId: 'MEL-LEGAL',
          amount: 25,
          expenseGlAccount: '5200',
          vendor: { name: 'Legal Vendor' },
          dueDate: '2026-02-01',
        }],
      });

      expect(result.records[0].result.expenseGlAccount).toBe('5200');
      expect(postJournalEntry.mock.calls[0][0].lines[0].accountCode).toBe('5200');
    } finally {
      recordSpy.mockRestore();
      balanceSpy.mockRestore();
      depsSpy.mockRestore();
      cfgSpy.mockRestore();
    }
  });

  it('posts beneficiary principal support through corpus and distributions payable', async () => {
    const cfg = MelioEngine._cfg();
    const cfgSpy = vi.spyOn(MelioEngine, '_cfg').mockReturnValue({
      ...cfg,
      payBillsEmail: '',
      postPayableGl: true,
    });
    const deps = MelioEngine._deps();
    const postJournalEntry = vi.fn().mockResolvedValue({ entry_id: 'JRN-PRINCIPAL' });
    const depsSpy = vi.spyOn(MelioEngine, '_deps').mockReturnValue({
      ...deps,
      TrustAcct: { postJournalEntry },
    });
    const balanceSpy = vi.spyOn(MelioEngine, '_sourceBalance').mockResolvedValue({
      balanceCents: 10000,
      account: { account_type: 'asset' },
    });
    const recordSpy = vi.spyOn(MelioEngine, '_recordPayment').mockResolvedValue(undefined);

    try {
      const result = await MelioEngine.exportPayment({
        amount: 25,
        sourceType: 'trust',
        sourceAccountId: '1000',
        accountingClass: 'beneficiary_principal_distribution',
        vendor: { name: 'DB NET MGMT' },
        dueDate: '2026-02-01',
      });

      expect(result.result).toMatchObject({
        accountingClass: 'beneficiary_principal_distribution',
        debitGlAccount: '3000',
        liabilityGlAccount: '2000',
      });
      expect(postJournalEntry).toHaveBeenCalledWith(expect.objectContaining({
        lines: [
          expect.objectContaining({
            accountCode: '3000',
            debitAmount: '25.00',
            creditAmount: 0,
          }),
          expect.objectContaining({
            accountCode: '2000',
            debitAmount: 0,
            creditAmount: '25.00',
          }),
        ],
      }));
    } finally {
      recordSpy.mockRestore();
      balanceSpy.mockRestore();
      depsSpy.mockRestore();
      cfgSpy.mockRestore();
    }
  });

  it('posts settlement once and reports the existing journal on repeat mark-paid calls', async () => {
    const cfg = MelioEngine._cfg();
    const cfgSpy = vi.spyOn(MelioEngine, '_cfg').mockReturnValue({
      ...cfg,
      settlementGlAccount: '1000',
      payablesGlAccount: '2100',
    });
    const deps = MelioEngine._deps();
    const assertFundingAvailable = vi.fn().mockResolvedValue({});
    const postJournalEntry = vi.fn().mockResolvedValue({ entry_id: 'JRN-SETTLE' });
    const depsSpy = vi.spyOn(MelioEngine, '_deps').mockReturnValue({
      ...deps,
      TrustAcct: { assertFundingAvailable, postJournalEntry },
    });
    const recordSpy = vi.spyOn(MelioEngine, '_recordPayment').mockResolvedValue(undefined);
    const record = {
      id: 'MEL-SETTLE',
      action: 'exportPayment',
      status: 'submitted',
      amount: 8.5,
      amountCents: 850,
      currency: 'USD',
      sourceType: 'trust',
      sourceAccountId: '1000',
      result: {
        csvPath: 'data/melio-exports/test.csv',
        portalSubmissionReference: 'BANK-1',
      },
    };

    try {
      const first = await MelioEngine._markPaidRecord(record, { settlementReference: 'BANK-1' });
      const second = await MelioEngine._markPaidRecord(first, { settlementReference: 'BANK-1' });

      expect(first.status).toBe('paid');
      expect(first.result).toMatchObject({
        settlementJournalEntryId: 'JRN-SETTLE',
        settlementGlPosted: true,
        settlementGlAccount: '1000',
      });
      expect(second.alreadySettled).toBe(true);
      expect(second.result.settlementJournalEntryId).toBe('JRN-SETTLE');
      expect(postJournalEntry).toHaveBeenCalledTimes(1);
      expect(assertFundingAvailable).toHaveBeenCalledWith('1000', 850, {
        purpose: 'Melio settlement',
        allowedAccountCodes: ['1000'],
      });
      expect(postJournalEntry).toHaveBeenCalledWith(expect.objectContaining({
        lines: [
          expect.objectContaining({ accountCode: '2100', debitAmount: '8.50', creditAmount: 0 }),
          expect.objectContaining({ accountCode: '1000', debitAmount: 0, creditAmount: '8.50' }),
        ],
      }));
    } finally {
      recordSpy.mockRestore();
      depsSpy.mockRestore();
      cfgSpy.mockRestore();
    }
  });

  it('requires portal submission evidence before manual settlement', async () => {
    const record = {
      id: 'MEL-MANUAL-EVIDENCE',
      action: 'exportPayment',
      status: 'exported',
      amount: 0.23,
      amountCents: 23,
      currency: 'USD',
      sourceType: 'trust',
      sourceAccountId: '1000',
      funding: {
        portalFundingSource: {
          label: 'DLB Trust',
          canonicalSourceType: 'trust',
          canonicalSourceAccountId: '1000',
        },
      },
      result: { csvPath: 'data/melio-exports/test.csv' },
    };
    vi.spyOn(MelioEngine, '_recordPayment').mockResolvedValue(undefined);

    await expect(MelioEngine._markPaidRecord(record, {
      settlementReference: 'BANK-23',
    })).rejects.toThrow(
      'Melio portal payment must be submitted before settlement, current: exported',
    );
    await expect(MelioEngine._markSubmittedRecord(record, {})).rejects.toThrow(
      'Melio portal submission reference is required',
    );

    const submitted = await MelioEngine._markSubmittedRecord(record, {
      portalSubmissionReference: 'BANK-23',
      submittedBy: 'operator@example.com',
    });

    expect(submitted).toMatchObject({
      status: 'submitted',
      result: {
        portalSubmissionReference: 'BANK-23',
        submittedBy: 'operator@example.com',
      },
      funding: {
        reservationStatus: 'submitted_pending_settlement',
      },
    });
  });

  it('scopes approved source accounts by source type', () => {
    const cfg = {
      defaultSourceType: 'trust',
      defaultSourceAccountId: '1000',
      allowedSourceAccounts: ['1000', 'cash:CA-OPERATING'],
    } as any;

    expect(MelioEngine._allowedAccountIds('trust', cfg)).toEqual(['1000']);
    expect(MelioEngine._allowedAccountIds('cash', cfg)).toEqual(['CA-OPERATING']);
    expect(MelioEngine._allowedAccountIds('treasury', cfg)).toEqual([]);
  });

  it('exports a portal CSV instead of screening a live execution when the API is off', async () => {
    const exportPayment = vi.spyOn(MelioEngine, 'exportPayment').mockResolvedValue({ id: 'MEL-EXPORTED' } as any);
    const compliance = vi.spyOn(MelioEngine, '_compliancePayload');
    vi.spyOn(MelioEngine, '_cfg').mockReturnValue({ useApi: false } as any);

    const record = await MelioEngine._schedulePayment({ amount: 1, vendor: { name: 'DB NET MGMT' } });

    expect(record).toMatchObject({ id: 'MEL-EXPORTED' });
    expect(exportPayment).toHaveBeenCalledTimes(1);
    expect(compliance).not.toHaveBeenCalledWith(expect.anything(), 'execute');
  });

  it('lists portal exports awaiting upload, submission and settlement', async () => {
    const query = vi.spyOn(pool, 'query').mockResolvedValue({
      rows: [{
        id: 'MEL-1',
        status: 'exported',
        amount: '0.01',
        currency: 'USD',
        source_type: 'trust',
        source_account_id: '1000',
        bill_id: 'BILL-1',
        result: { fileName: 'melio-export-MEL-1.csv', vendorName: 'DB NET MGMT', emailedTo: 'portal@invoicesmelio.com' },
        metadata: {},
        created_at: new Date(),
        updated_at: new Date(),
      }],
    } as any);

    const rows = await MelioEngine.listExports({});

    expect(query.mock.calls[0][1][0]).toEqual(['exported', 'emailed', 'submitted', 'paid']);
    expect(rows[0]).toMatchObject({
      id: 'MEL-1',
      status: 'exported',
      amount: 0.01,
      fileName: 'melio-export-MEL-1.csv',
      emailedTo: 'portal@invoicesmelio.com',
    });
  });

  it('rejects settlement against an account other than the authorized canonical source', async () => {
    const postJournalEntry = vi.fn();
    vi.spyOn(MelioEngine, '_deps').mockReturnValue({
      TrustAcct: { postJournalEntry },
    });

    await expect(MelioEngine._markPaidRecord({
      id: 'MEL-SETTLEMENT-MISMATCH',
      status: 'scheduled',
      amount: 8.5,
      sourceType: 'trust',
      sourceAccountId: '1000',
      metadata: { complianceScreeningId: 'COMP-MELIO-TEST' },
      result: {},
    }, {
      settlementGlAccount: '1010',
    })).rejects.toThrow(
      'Melio settlement account 1010 does not match the authorized canonical source account 1000',
    );
    expect(postJournalEntry).not.toHaveBeenCalled();
  });
});
