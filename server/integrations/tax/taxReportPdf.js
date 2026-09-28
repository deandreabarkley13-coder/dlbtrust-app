'use strict';

// Multi-page, text-only PDF renderer for tax report exports (Form 1041 summary,
// Schedule K-1 statements). No external dependency, same approach as
// os/melioInvoicePdf.js so exports stay deployable on Cloud Run.

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const LEFT = 56;
const TOP = PAGE_HEIGHT - 64;
const BOTTOM = 64;

function sanitize(v) {
  return String(v === null || v === undefined ? '' : v).replace(/\r?\n/g, ' ').replace(/[^\x20-\x7E]/g, '').trim();
}

function escapeText(v) {
  return sanitize(v).replace(/([\\()])/g, '\\$1');
}

function wrap(v, maxChars) {
  const words = sanitize(v).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const cand = line ? `${line} ${w}` : w;
    if (cand.length <= maxChars) { line = cand; continue; }
    if (line) lines.push(line);
    line = w.length <= maxChars ? w : w.slice(0, maxChars);
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * lines: [{ text, font?: 'F1'|'F2', size?, indent?, gap? } | { rule: true } | { field: label, value }]
 */
function paginate(lines) {
  const pages = [];
  let ops = [];
  let y = TOP;
  const flush = () => { if (ops.length) pages.push(ops.join('\n')); ops = []; y = TOP; };
  const need = (h) => { if (y - h < BOTTOM) flush(); };
  const text = (font, size, value, indent = 0) => {
    ops.push('BT', `/${font} ${size} Tf`, `1 0 0 1 ${LEFT + indent} ${y} Tm`, `(${escapeText(value)}) Tj`, 'ET');
  };
  for (const l of lines) {
    if (l.rule) { need(12); ops.push('0.75 w', `${LEFT} ${y} m`, `${PAGE_WIDTH - LEFT} ${y} l`, 'S'); y -= 14; continue; }
    if (l.field !== undefined) {
      need(16);
      text('F2', 10, l.field);
      text('F1', 10, l.value, 300);
      y -= 15;
      continue;
    }
    const size = l.size || 10;
    const font = l.font || 'F1';
    const maxChars = Math.floor((PAGE_WIDTH - 2 * LEFT - (l.indent || 0)) / (size * 0.5));
    for (const part of wrap(l.text, maxChars).length ? wrap(l.text, maxChars) : ['']) {
      need(size + 4);
      text(font, size, part, l.indent || 0);
      y -= size + 4;
    }
    y -= l.gap || 0;
  }
  flush();
  return pages.length ? pages : [''];
}

function buildTextPdf(lines, { title = 'Report' } = {}) {
  const pages = paginate(lines);
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const catalog = add(null);
  const pagesObj = add(null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const info = add(`<< /Title (${escapeText(title)}) /Producer (dlbtrust tax-os) >>`);
  const pageIds = [];
  pages.forEach((stream, i) => {
    const footer = `BT /F1 8 Tf 1 0 0 1 ${LEFT} 40 Tm (${escapeText(`${title} - page ${i + 1} of ${pages.length}`)}) Tj ET`;
    const content = `${stream}\n${footer}`;
    const contentId = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    const pageId = add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

module.exports = { buildTextPdf };
