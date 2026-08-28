import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { MelioEngine } = require('../server/integrations/os/osEngine');
const { buildInvoicePdf } = require('../server/integrations/os/melioInvoicePdf');
const { PaymentComplianceGate } = require('../server/integrations/compliance/paymentComplianceGate');
const vendorsRouter = require('../server/routes/vendors');

function pdfText(buffer: Buffer): string {
  return buffer.toString('latin1');
}

describe('Melio portal invoice PDF', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a single-page PDF carrying the bill figures', () => {
    const pdf = buildInvoicePdf({
      issuerName: 'DLB Trust',
      vendorName: 'Db Net Mgmt LLC',
      invoiceNumber: 'BILL-TEST-1',
      invoiceDate: '2026-08-28',
      dueDate: '2026-09-04',
      amount: 0.25,
      currency: 'USD',
      memo: 'Micro-deposit verification',
      paymentId: 'MEL-TEST-1',
      portalFundingSource: 'DLB Trust',
    });
    const text = pdfText(pdf);

    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Type /Pages /Kids [3 0 R] /Count 1');
    expect(text).toContain('(Db Net Mgmt LLC) Tj');
    expect(text).toContain('(BILL-TEST-1) Tj');
    expect(text).toContain('(USD 0.25) Tj');
    expect(text).toContain('(2026-09-04) Tj');
    expect(text).toContain('(Micro-deposit verification) Tj');
    expect(text).toContain('(DLB Trust) Tj');
    // xref offsets must point at each object header for readers to open the file.
    const xrefOffsets = (text.match(/^(\d{10}) 00000 n $/gm) || []).map((line) => Number(line.slice(0, 10)));
    expect(xrefOffsets).toHaveLength(6);
    xrefOffsets.forEach((offset, index) => {
      expect(text.slice(offset, offset + 8)).toContain(`${index + 1} 0 obj`);
    });
  });

  it('escapes PDF syntax characters instead of corrupting the document', () => {
    const text = pdfText(buildInvoicePdf({ vendorName: 'A (B) \\ C', amount: 1, memo: '' }));
    expect(text).toContain('(A \\(B\\) \\\\ C) Tj');
  });

  it('writes an invoice PDF next to the CSV for every export', async () => {
    const exportDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-melio-invoice-'));
    vi.spyOn(MelioEngine, '_compliancePayload').mockImplementation(async (payload: any) => payload);
    vi.spyOn(PaymentComplianceGate, 'verifyRecordedScreening').mockResolvedValue({
      screening_id: 'COMP-MELIO-TEST',
      status: 'clear',
      provider: 'local',
    });
    vi.spyOn(MelioEngine, '_cfg').mockReturnValue({
      ...MelioEngine._cfg(),
      exportDir,
      payBillsEmail: '',
      postPayableGl: false,
      portalFundingSourceMap: { 'cash:CA-OPERATING': 'DLB Trust' },
    });
    vi.spyOn(MelioEngine, '_sourceBalance').mockResolvedValue({ balanceCents: 100000 });
    vi.spyOn(MelioEngine, '_recordPayment').mockResolvedValue(undefined);

    try {
      const record = await MelioEngine.exportPayment({
        amount: 0.75,
        sourceType: 'cash',
        sourceAccountId: 'CA-OPERATING',
        vendor: { name: 'Db Net Mgmt LLC' },
        dueDate: '2026-09-04',
        memo: 'Micro-deposit verification',
      });

      expect(record.result.invoicePdfFileName).toMatch(/^melio-invoice-MEL-.*\.pdf$/);
      expect(path.dirname(record.result.invoicePdfPath)).toBe(path.resolve(exportDir));
      const pdf = fs.readFileSync(record.result.invoicePdfPath);
      expect(pdfText(pdf)).toContain('(USD 0.75) Tj');
      expect(record.instructions).toContain(record.result.invoicePdfFileName);
    } finally {
      fs.rmSync(exportDir, { recursive: true, force: true });
    }
  });

  it('exposes an operator-authenticated invoice download route', () => {
    const layer = vendorsRouter.stack.find(
      (item: any) => item.route?.path === '/payments/melio/:identifier/invoice-pdf',
    );
    expect(layer).toBeDefined();
    expect(layer.route.methods.get).toBe(true);
    expect(layer.route.stack.length).toBeGreaterThan(1);
  });

  it('backfills the invoice PDF for exports recorded before invoices existed', async () => {
    const exportDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-melio-backfill-'));
    vi.spyOn(MelioEngine, '_cfg').mockReturnValue({ ...MelioEngine._cfg(), exportDir });
    vi.spyOn(MelioEngine, 'getExportFile').mockResolvedValue({
      id: 'MEL-LEGACY-1',
      amount: '1.50',
      currency: 'USD',
      source_type: 'trust',
      source_account_id: '1000',
      created_at: '2026-08-28T00:00:00.000Z',
      result: { vendorName: 'Db Net Mgmt LLC', csvPath: path.join(exportDir, 'old.csv'), fileName: 'old.csv' },
      metadata: { payload: { vendor: { name: 'Db Net Mgmt LLC' }, dueDate: '2026-09-04', memo: 'Legacy export' } },
    });

    try {
      const file = await MelioEngine.getInvoicePdfFile('MEL-LEGACY-1');
      expect(file.fileName).toBe('melio-invoice-MEL-LEGACY-1-2026-08-28.pdf');
      expect(pdfText(fs.readFileSync(file.filePath))).toContain('(USD 1.50) Tj');
    } finally {
      fs.rmSync(exportDir, { recursive: true, force: true });
    }
  });
});
