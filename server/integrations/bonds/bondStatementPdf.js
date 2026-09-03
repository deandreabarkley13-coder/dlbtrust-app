'use strict';

// Renders the Bond Financial Statement (statement of account, coupon schedule
// and proof of venue) as a dependency-free two-page PDF, mirroring the paper
// statement the trust issues to the bondholder.

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const LEFT = 56;
const RIGHT = PAGE_WIDTH - 56;

function sanitize(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\r?\n/g, ' ')
    .replace(/[\u2014\u2013]/g, '-')
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
    if (candidate.length <= maxChars) { line = candidate; return; }
    if (line) lines.push(line);
    line = word.length <= maxChars ? word : word.slice(0, maxChars);
  });
  if (line) lines.push(line);
  return lines;
}

function money(n, currency = 'USD') {
  const value = Number(n || 0);
  const fixed = Math.abs(value).toFixed(2);
  const [whole, frac] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${value < 0 ? '-' : ''}$${grouped}.${frac} ${currency}`;
}

function usDate(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${m}/${d}/${y}`;
}

function longDate(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[m - 1]} ${d}, ${y}`;
}

// Helvetica average glyph width ~0.5em; good enough for right alignment.
function textWidth(value, size) {
  return sanitize(value).length * size * 0.5;
}

class Page {
  constructor() {
    this.ops = [];
    this.y = PAGE_HEIGHT - 64;
  }
  text(font, size, value, x = LEFT) {
    this.ops.push('BT', `/${font} ${size} Tf`, `1 0 0 1 ${x} ${this.y} Tm`, `(${escapeText(value)}) Tj`, 'ET');
  }
  textRight(font, size, value, right = RIGHT) {
    this.text(font, size, value, right - textWidth(value, size));
  }
  rule(width = 0.75) {
    this.ops.push(`${width} w`, `${LEFT} ${this.y} m`, `${RIGHT} ${this.y} l`, 'S');
  }
  down(n) { this.y -= n; }
  heading(value) {
    this.text('F2', 12, value);
    this.down(6);
    this.rule(1);
    this.down(20);
  }
  stream() { return this.ops.join('\n'); }
}

function pageOne(s) {
  const p = new Page();
  const cur = s.bond.currency || 'USD';

  p.text('F2', 20, s.title.toUpperCase());
  p.textRight('F2', 10, `STATEMENT ID: #${s.statementId}`);
  p.down(16);
  p.text('F1', 9, s.subtitle);
  p.textRight('F1', 8, `As of Date: ${longDate(s.asOf)}`);
  p.down(10);
  p.rule(1.5);
  p.down(26);

  p.text('F1', 7, 'ISSUER / PAYER');
  p.text('F1', 7, 'BONDHOLDER / PAYEE', 330);
  p.down(14);
  p.text('F2', 10, s.issuer);
  p.text('F2', 10, s.bondholder || '-', 330);
  p.down(34);

  p.heading('1. BOND TERMS & INSTRUMENT CHARACTERISTICS');
  const t = s.terms;
  const rows = [
    ['Principal / Par Value', money(t.principal, cur), 'Issue / Start Date', longDate(t.issueDate)],
    ['Coupon Rate', `${(t.couponRate * 100).toFixed(2)}% per annum`, 'Maturity Date', `${longDate(t.maturityDate)} (${t.termYears}-Year Term)`],
    ['Payment Frequency', t.paymentFrequency, `${t.paymentFrequency} Rate`, `${(t.periodRate * 100).toFixed(2)}% per period (${money(t.couponPerPeriod, cur)})`],
  ];
  rows.forEach(([l1, v1, l2, v2]) => {
    p.text('F2', 9, l1);
    p.text('F1', 9, v1, 170);
    p.text('F2', 9, l2, 330);
    p.text('F1', 9, v2, 430);
    p.down(20);
  });
  p.down(14);

  p.heading('2. CURRENT FINANCIAL STATUS & BALANCE');
  const b = s.balance;
  [
    ['Original Principal Amount:', money(b.originalPrincipal, cur), 'F1'],
    [`Periods Elapsed (as of ${longDate(s.asOf)}):`, `${b.periodsElapsed} ${t.paymentFrequency} Periods`, 'F1'],
    ['Cumulative Accrued Interest to Date:', money(b.cumulativeInterest, cur), 'F1'],
  ].forEach(([l, v]) => {
    p.text('F1', 9, l);
    p.textRight('F2', 9, v);
    p.down(18);
  });
  p.rule(0.5);
  p.down(16);
  p.text('F2', 11, 'End-to-Date Total Balance:');
  p.textRight('F2', 11, money(b.endToDateBalance, cur));
  p.down(34);

  p.heading('3. ACCRUAL & CUMULATIVE PAYMENT SCHEDULE');
  const cols = [LEFT, LEFT + 40, LEFT + 110, 330, 420, RIGHT];
  p.text('F2', 8, 'PERIOD', cols[0]);
  p.text('F2', 8, 'DATE', cols[1]);
  p.text('F2', 8, 'EVENT', cols[2]);
  p.textRight('F2', 8, 'PERIOD INTEREST', cols[3]);
  p.textRight('F2', 8, 'CUMULATIVE', cols[4]);
  p.textRight('F2', 8, 'ENDING BALANCE', cols[5]);
  p.down(6);
  p.rule(0.75);
  p.down(14);
  const visible = s.schedule.slice(-18);
  if (visible.length < s.schedule.length) {
    p.text('F1', 8, `... ${s.schedule.length - visible.length} earlier period(s) omitted`, cols[1]);
    p.down(14);
  }
  visible.forEach((r) => {
    const font = r.period === s.schedule.length - 1 ? 'F2' : 'F1';
    p.text(font, 8, String(r.period), cols[0]);
    p.text(font, 8, usDate(r.date), cols[1]);
    p.text(font, 8, r.event + (r.ledgered ? '' : ' *'), cols[2]);
    p.textRight(font, 8, money(r.periodInterest, cur).replace(` ${cur}`, ''), cols[3]);
    p.textRight(font, 8, money(r.cumulativeInterest, cur).replace(` ${cur}`, ''), cols[4]);
    p.textRight(font, 8, money(r.endingBalance, cur).replace(` ${cur}`, ''), cols[5]);
    p.down(14);
  });
  if (!s.ledger.reconciled) {
    p.down(4);
    p.text('F1', 7, '* period not yet registered on the bond ledger');
  }

  p.y = 40;
  p.text('F1', 8, 'Page 1 of 2', PAGE_WIDTH / 2 - 20);
  return p.stream();
}

function pageTwo(s) {
  const p = new Page();
  const cur = s.bond.currency || 'USD';
  const state = s.venueState || 'the issuer';
  const stateName = { OH: 'Ohio', CA: 'California', DE: 'Delaware', NY: 'New York', TX: 'Texas', FL: 'Florida', WY: 'Wyoming', NV: 'Nevada', SD: 'South Dakota' }[state] || state;

  p.heading('4. STATEMENT & PROOF OF VENUE');
  p.text('F2', 10, 'PROOF OF VENUE & JURISDICTIONAL AFFIRMATION');
  p.down(20);

  const paragraphs = [
    `1. Parties and Jurisdiction: This Bond Financial Statement is formally issued by ${s.issuer} (Payer) to ${s.bondholder || 'the Bondholder'} (Bondholder). Proper venue and jurisdiction for any administrative, regulatory, compliance, recordation, or legal proceedings concerning Bond ID #${s.statementId} are established under the laws of the State of ${stateName} and the governing private trust regulations of ${s.issuer}.`,
    `2. Locus of Contract: The primary seat of administration and exclusive venue for performance of payment obligations, ledger maintenance, and interest disbursements resides within the State of ${stateName}, being the official domicile of ${s.issuer}.`,
    `3. Binding Effect: This document constitutes a certified recordation of the principal value (${money(s.balance.originalPrincipal, cur)}), cumulative yield (${money(s.balance.cumulativeInterest, cur)}), and current end-to-date balance (${money(s.balance.endToDateBalance, cur)}) for Bond ID #${s.statementId} as of ${longDate(s.asOf)}.`,
  ];
  paragraphs.forEach((para) => {
    wrap(para, 105).forEach((line) => { p.text('F1', 9, line); p.down(13); });
    p.down(8);
  });
  p.down(40);

  p.rule(0.5);
  p.down(12);
  p.text('F2', 9, 'Authorized Representative');
  p.text('F2', 9, s.bondholder || 'Bondholder', 330);
  p.down(12);
  p.text('F1', 8, s.issuer);
  p.text('F1', 8, 'Bondholder', 330);
  p.down(40);

  p.text('F2', 10, `STATE OF ${stateName.toUpperCase()} NOTARY ACKNOWLEDGMENT`);
  p.down(18);
  p.text('F1', 9, `State of ${stateName}, County of ____________________ SS.`);
  p.down(16);
  wrap(`The foregoing instrument was acknowledged before me this ________ day of ____________________, 20____, by ${s.bondholder || '____________________'}, individually and as Authorized Representative for ${s.issuer}, who proved to me on the basis of satisfactory evidence to be the person(s) whose name(s) is/are subscribed to the within instrument and acknowledged that he executed the same in his authorized capacity.`, 105)
    .forEach((line) => { p.text('F1', 9, line); p.down(13); });
  p.down(40);
  p.text('F1', 9, '______________________________________');
  p.down(12);
  p.text('F2', 9, `Notary Public, State of ${stateName}`);
  p.down(12);
  p.text('F1', 8, 'My Commission Expires: ______________');

  p.down(40);
  p.text('F1', 7, `Ledger: ${s.ledger.couponRows} coupon period(s) registered, ${money(s.ledger.cumulativeInterest, cur)} cumulative; ${s.ledger.reconciled ? 'reconciled to schedule' : `NOT reconciled - ${s.ledger.missingPeriods.length} period(s) missing`}. Generated ${s.generatedAt}.`);

  p.y = 40;
  p.text('F1', 8, 'Page 2 of 2', PAGE_WIDTH / 2 - 20);
  return p.stream();
}

function buildStatementPdf(statement) {
  const streams = [pageOne(statement), pageTwo(statement)];
  // 1 catalog, 2 pages, 3 font regular, 4 font bold, then (page, content) pairs
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${streams.map((_, i) => `${5 + i * 2} 0 R`).join(' ')}] /Count ${streams.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];
  streams.forEach((stream, i) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] `
        + `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`
    );
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  });

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => { pdf += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

module.exports = { buildStatementPdf };
