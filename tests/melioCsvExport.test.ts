import { describe, expect, it } from 'vitest';
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
