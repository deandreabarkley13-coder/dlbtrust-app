'use strict';

// Renders a single-page vendor invoice PDF for Melio Bill Pay portal uploads.
// Written with no external dependency so the export path stays deployable.

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const LEFT_MARGIN = 56;

function sanitize(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\r?\n/g, ' ')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
}

function escapeText(value) {
  return sanitize(value).replace(/([\\()])/g, '\\$1');
}

function wrap(value, maxChars) {
  const words = sanitize(value).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  words.forEach((word) => {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars) {
      line = candidate;
      return;
    }
    if (line) lines.push(line);
    line = word.length <= maxChars ? word : word.slice(0, maxChars);
  });
  if (line) lines.push(line);
  return lines;
}

function formatAmount(amount, currency) {
  const value = Number(amount || 0);
  return `${currency || 'USD'} ${value.toFixed(2)}`;
}

function contentStream(invoice) {
  const amount = formatAmount(invoice.amount, invoice.currency);
  const ops = [];
  let y = PAGE_HEIGHT - 72;

  const text = (font, size, value, indent = 0) => {
    ops.push('BT', `/${font} ${size} Tf`, `1 0 0 1 ${LEFT_MARGIN + indent} ${y} Tm`, `(${escapeText(value)}) Tj`, 'ET');
  };
  const line = () => {
    ops.push('0.75 w', `${LEFT_MARGIN} ${y} m`, `${PAGE_WIDTH - LEFT_MARGIN} ${y} l`, 'S');
  };
  const field = (label, value) => {
    text('F2', 10, label);
    text('F1', 10, value, 150);
    y -= 18;
  };

  text('F2', 20, invoice.issuerName || 'DLB Trust');
  y -= 20;
  text('F1', 10, 'Canonical treasury platform vendor invoice');
  y -= 30;
  text('F2', 14, 'INVOICE');
  y -= 14;
  line();
  y -= 22;

  field('Invoice number', invoice.invoiceNumber);
  field('Invoice date', invoice.invoiceDate);
  field('Due date', invoice.dueDate);
  field('Bill to', invoice.issuerName || 'DLB Trust');
  field('Business name', invoice.vendorName);
  if (invoice.vendorBankName) field('Deposit bank', invoice.vendorBankName);
  field('Amount due', amount);
  if (invoice.paymentId) field('Payment reference', invoice.paymentId);
  if (invoice.portalFundingSource) field('Funding source', invoice.portalFundingSource);

  y -= 6;
  line();
  y -= 24;

  if (invoice.memo) {
    text('F2', 10, 'Memo');
    y -= 16;
    wrap(invoice.memo, 88).forEach((memoLine) => {
      text('F1', 10, memoLine);
      y -= 14;
    });
    y -= 10;
  }

  text('F2', 12, `Total due: ${amount}`);
  y -= 26;
  wrap(
    'Payable through the Melio Bill Pay portal. Funds originate from the canonical trust ledger '
    + 'and settle to the vendor deposit account on record.',
    92
  ).forEach((noteLine) => {
    text('F1', 9, noteLine);
    y -= 12;
  });

  return ops.join('\n');
}

function buildInvoicePdf(invoice = {}) {
  const stream = contentStream(invoice);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] `
      + '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

module.exports = { buildInvoicePdf };
