import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';

const require = createRequire(import.meta.url);
const { MelioEngine } = require('../server/integrations/os/osEngine');

describe('Melio bill spreadsheet CSV export', () => {
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
      expect(records[1].result.csvPath).toBe(result.outcomes[1].csvPath);
      expect(records[1].metadata.batchId).toBe('MEL-BATCH-TEST');
    } finally {
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
});
