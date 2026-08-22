import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { MelioEngine } = require('../server/integrations/os/osEngine');
const { EmailEngine } = require('../server/integrations/dapp/emailEngine');
const vendorsRouter = require('../server/routes/vendors');

const markPaidRoute = vendorsRouter.stack.find(
  (layer: any) => layer.route?.path === '/payments/melio/:identifier/mark-paid',
);
const markPaidHandler = markPaidRoute.route.stack[markPaidRoute.route.stack.length - 1].handle;

describe('Melio bill spreadsheet CSV export', () => {
  it('uses the cash funding default for Melio callers without changing other rail defaults', () => {
    const dashboard = fs.readFileSync(path.resolve(process.cwd(), 'public/os-engine-dashboard.html'), 'utf8');
    const vendorsRoutes = fs.readFileSync(path.resolve(process.cwd(), 'server/routes/vendors.js'), 'utf8');

    expect(dashboard).toContain('id="melio-source-gl" value="1000"');
    expect(dashboard).toContain('id="melio-invoice-source-gl" value="1000"');
    expect(dashboard).toContain("el('melio-source-gl').value.trim() || '1000'");
    expect(dashboard).toContain("el('melio-invoice-source-gl').value.trim() || '1000'");
    expect(dashboard).toContain('id="apisix-source-gl" value="4000"');
    expect(dashboard).toContain('id="nickel-source-gl" value="4000"');
    expect(vendorsRoutes.match(/source_account_code: paymentPayload\.source_account_code \|\| '1000'/g) || []).toHaveLength(1);
    expect(vendorsRoutes).toContain("source_account_code: paymentPayload.source_account_code || '4000'");
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

  it('uses the per-payable expense account override', async () => {
    const cfg = MelioEngine._cfg();
    const cfgSpy = vi.spyOn(MelioEngine, '_cfg').mockReturnValue({
      ...cfg,
      payBillsEmail: '',
      postPayableGl: true,
      expenseGlAccount: '5300',
      payablesGlAccount: '2100',
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

  it('posts settlement once and reports the existing journal on repeat mark-paid calls', async () => {
    const cfg = MelioEngine._cfg();
    const cfgSpy = vi.spyOn(MelioEngine, '_cfg').mockReturnValue({
      ...cfg,
      settlementGlAccount: '1000',
      payablesGlAccount: '2100',
    });
    const deps = MelioEngine._deps();
    const postJournalEntry = vi.fn().mockResolvedValue({ entry_id: 'JRN-SETTLE' });
    const depsSpy = vi.spyOn(MelioEngine, '_deps').mockReturnValue({
      ...deps,
      TrustAcct: { postJournalEntry },
    });
    const recordSpy = vi.spyOn(MelioEngine, '_recordPayment').mockResolvedValue(undefined);
    const record = {
      id: 'MEL-SETTLE',
      action: 'exportPayment',
      status: 'exported',
      amount: 8.5,
      amountCents: 850,
      currency: 'USD',
      sourceType: 'trust',
      sourceAccountId: '4000',
      result: { csvPath: 'data/melio-exports/test.csv' },
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

  it('handles a redelivered terminal webhook without repeating settlement or reserve finalization', async () => {
    const cfg = MelioEngine._cfg();
    const cfgSpy = vi.spyOn(MelioEngine, '_cfg').mockReturnValue({
      ...cfg,
      settlementGlAccount: '1000',
      payablesGlAccount: '2100',
      webhookSecret: '',
    });
    const deps = MelioEngine._deps();
    const postJournalEntry = vi.fn().mockResolvedValue({ entry_id: 'JRN-WEBHOOK' });
    const depsSpy = vi.spyOn(MelioEngine, '_deps').mockReturnValue({
      ...deps,
      TrustAcct: { postJournalEntry },
    });
    const reserveFinalizeSpy = vi.spyOn(MelioEngine, '_finalizeReserve').mockResolvedValue(undefined);
    let persistedRecord = {
      id: 'MEL-WEBHOOK',
      action: 'exportPayment',
      status: 'exported',
      amount: 8.5,
      amountCents: 850,
      currency: 'USD',
      sourceType: 'trust',
      sourceAccountId: '4000',
      reserve_id: 'RES-WEBHOOK',
      result: { csvPath: 'data/melio-exports/webhook.csv' },
    };
    const recordSpy = vi.spyOn(MelioEngine, '_getPaymentRecord').mockImplementation(async () => persistedRecord);
    const persistSpy = vi.spyOn(MelioEngine, '_recordPayment').mockImplementation(async (record) => {
      persistedRecord = record;
    });

    try {
      const first = await MelioEngine._webhook({ payment_id: 'MEL-WEBHOOK', status: 'completed' });
      const second = await MelioEngine._webhook({ payment_id: 'MEL-WEBHOOK', status: 'completed' });

      expect(first).toMatchObject({
        received: true,
        status: 'paid',
        settlementJournalEntryId: 'JRN-WEBHOOK',
      });
      expect(second).toMatchObject({
        received: true,
        status: 'paid',
        settlementJournalEntryId: 'JRN-WEBHOOK',
      });
      expect(postJournalEntry).toHaveBeenCalledTimes(1);
      expect(reserveFinalizeSpy).toHaveBeenCalledTimes(1);
      expect(persistedRecord.status).toBe('paid');
      expect(persistedRecord.result.settlementJournalEntryId).toBe('JRN-WEBHOOK');
    } finally {
      persistSpy.mockRestore();
      recordSpy.mockRestore();
      reserveFinalizeSpy.mockRestore();
      depsSpy.mockRestore();
      cfgSpy.mockRestore();
    }
  });
});
