'use strict';

/**
 * X12 820 — Payment Order / Remittance Advice
 *
 * Renders a committed ERP payout run into an ASC X12 005010 820 transaction
 * set. It mirrors the clearing spec registry's contract: validation runs
 * before rendering and names the payment that failed, and every render
 * returns the control totals (payment count, summed amount) a receiving
 * trading partner balances the interchange against.
 *
 * Idempotency is structural. Every control number (ISA13, GS06, ST02 and the
 * TRN trace) is derived from the ERP reference, so re-rendering the same run
 * yields a byte-identical document rather than a "new" interchange the payee
 * would post twice.
 *
 * Envelope produced, one ST per payment:
 *
 *   ISA / GS (functional group RA)
 *     ST*820  BPR  TRN  REF*TN  DTM*097
 *       N1*PR (payer)   N1*PE (payee) [N3/N4]
 *       ENT  RMR*IV (one per invoice)  [REF*PO]  [DTM*003]
 *     SE
 *   GE / IEA
 *
 * A generator describes a file, it does not send one: nothing here opens a
 * connection.
 */

const crypto = require('crypto');
const { validateRouting } = require('../ach/nachaGenerator');

const SEGMENT_TERMINATOR = '~';
const ELEMENT_SEPARATOR = '*';
const SUB_ELEMENT_SEPARATOR = '>';
const REPETITION_SEPARATOR = '^';
const X12_VERSION = '005010';
const ISA_VERSION = '00501';

const PAYMENT_METHODS = {
  ach: { code: 'ACH', format: 'CCP' },
  ach_ccd: { code: 'ACH', format: 'CCD' },
  ach_ctx: { code: 'ACH', format: 'CTX' },
  wire: { code: 'FWT', format: '' },
  check: { code: 'CHK', format: '' },
};

class Edi820Error extends Error {
  constructor(message, code = 'EDI_820_ERROR', status = 400, { failures = null } = {}) {
    super(message);
    this.name = 'Edi820Error';
    this.code = code;
    this.status = status;
    this.statusCode = status;
    this.failures = failures;
  }
}

/** X12 basic character set: delimiters and control characters must not appear in data. */
function x12(value, maxLength) {
  const flat = String(value === null || value === undefined ? '' : value)
    .replace(/[~*>^\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return maxLength ? flat.slice(0, maxLength) : flat;
}

function digits(value) {
  return String(value === null || value === undefined ? '' : value).replace(/\D/g, '');
}

function pad(value, length) {
  return String(value === null || value === undefined ? '' : value).padEnd(length, ' ').slice(0, length);
}

function dollars(cents) {
  return (Math.round(Number(cents) || 0) / 100).toFixed(2);
}

function ccyymmdd(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function yymmdd(date) {
  return ccyymmdd(date).slice(2);
}

function hhmm(date) {
  return date.toISOString().slice(11, 16).replace(':', '');
}

function toDate(value, fallback) {
  if (!value) return fallback;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

/**
 * Deterministic numeric control number from the ERP reference: the same run
 * always lands in the same interchange.
 */
function controlNumber(seed, length) {
  const hash = crypto.createHash('sha256').update(String(seed), 'utf8').digest('hex');
  const n = BigInt('0x' + hash.slice(0, 15)) % BigInt(10 ** length);
  const text = n.toString().padStart(length, '0');
  return text === '0'.repeat(length) ? '1'.padStart(length, '0') : text;
}

function segment(...elements) {
  // Trailing empty elements are dropped; interior empties are kept as positions.
  const trimmed = [...elements];
  while (trimmed.length > 1 && (trimmed[trimmed.length - 1] === '' || trimmed[trimmed.length - 1] === null || trimmed[trimmed.length - 1] === undefined)) {
    trimmed.pop();
  }
  return trimmed.map(e => (e === null || e === undefined ? '' : String(e))).join(ELEMENT_SEPARATOR) + SEGMENT_TERMINATOR;
}

function methodFor(payment) {
  const key = String(payment.method || 'ach').toLowerCase();
  return PAYMENT_METHODS[key] || null;
}

function accountTypeCode(accountType) {
  return String(accountType || '').toLowerCase() === 'savings' ? 'SG' : 'DA';
}

// ── Validation ───────────────────────────────────────────────────────────────

function validateRun(run, profile) {
  const failures = [];
  const fail = (payment, index, field, message) => failures.push({
    payment: (payment && (payment.reference || payment.paymentId)) || `payment ${index + 1}`,
    field,
    message,
  });

  if (!run || typeof run !== 'object') {
    return [{ payment: 'run', field: 'run', message: 'a payout run object is required' }];
  }
  if (!run.erpReference) {
    failures.push({ payment: 'run', field: 'erpReference', message: 'the ERP reference keys the interchange and is required' });
  }
  if (!profile || !profile.senderId) {
    failures.push({ payment: 'run', field: 'senderId', message: 'EDI_820_SENDER_ID is not configured' });
  }
  if (!profile || !profile.receiverId) {
    failures.push({ payment: 'run', field: 'receiverId', message: 'EDI_820_RECEIVER_ID is not configured' });
  }
  const payments = Array.isArray(run.payments) ? run.payments : [];
  if (!payments.length) {
    failures.push({ payment: 'run', field: 'payments', message: 'an 820 needs at least one payment' });
  }

  payments.forEach((payment, index) => {
    const payee = payment.payee || {};
    const amountCents = Number(payment.amountCents);
    if (!Number.isInteger(amountCents) || amountCents <= 0) fail(payment, index, 'amountCents', 'must be a positive integer number of cents');
    if (!payee.name) fail(payment, index, 'payee.name', 'payee name is required');
    const method = methodFor(payment);
    if (!method) fail(payment, index, 'method', `unsupported payment method ${payment.method}; use ${Object.keys(PAYMENT_METHODS).join(', ')}`);
    if (method && method.code !== 'CHK') {
      if (!validateRouting(digits(payee.routingNumber))) fail(payment, index, 'payee.routingNumber', 'must be a valid 9-digit ABA routing number');
      if (!digits(payee.accountNumber)) fail(payment, index, 'payee.accountNumber', 'payee account number is required');
    }
    const remittances = Array.isArray(payment.remittance) ? payment.remittance : [];
    const remitted = remittances.reduce((sum, r) => sum + (Number(r.amountCents) || 0), 0);
    if (remittances.length && remitted !== amountCents) {
      fail(payment, index, 'remittance', `remittance detail totals ${dollars(remitted)} but the payment is ${dollars(amountCents)}`);
    }
    remittances.forEach((r, ri) => {
      if (!r.invoiceNumber && !r.reference) fail(payment, index, `remittance[${ri}].invoiceNumber`, 'each RMR line needs an invoice number or reference');
    });
  });

  return failures;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderTransactionSet({ payment, index, run, profile, createdAt }) {
  const method = methodFor(payment);
  const payee = payment.payee || {};
  const payer = { ...(profile.payer || {}), ...(payment.payer || {}) };
  const stControl = String(index + 1).padStart(4, '0');
  const effectiveDate = toDate(payment.effectiveDate || run.effectiveDate, createdAt);
  const traceNumber = x12(payment.reference || `${run.erpReference}-${index + 1}`, 50);
  const originatorId = x12(payer.originatorId || profile.originatorId || profile.senderId, 10);

  const segments = [];
  segments.push(segment('ST', '820', stControl));
  segments.push(segment(
    'BPR',
    'C',                                   // BPR01 payment order / remittance advice
    dollars(payment.amountCents),          // BPR02 monetary amount
    'C',                                   // BPR03 credit
    method.code,                           // BPR04 payment method (ACH / FWT / CHK)
    method.format,                         // BPR05 payment format
    payer.routingNumber ? '01' : '',       // BPR06 DFI id qualifier (ABA)
    digits(payer.routingNumber),           // BPR07 originating DFI
    payer.accountNumber ? accountTypeCode(payer.accountType) : '', // BPR08
    x12(payer.accountNumber, 35),          // BPR09 originator account
    originatorId,                          // BPR10 originating company id
    '',                                    // BPR11 originating company supplemental code
    payee.routingNumber ? '01' : '',       // BPR12 receiving DFI id qualifier
    digits(payee.routingNumber),           // BPR13 receiving DFI
    payee.accountNumber ? accountTypeCode(payee.accountType) : '', // BPR14
    x12(payee.accountNumber, 35),          // BPR15 receiver account
    ccyymmdd(effectiveDate),               // BPR16 effective entry date
  ));
  segments.push(segment('TRN', '1', traceNumber, originatorId ? `1${digits(originatorId)}`.slice(0, 10) : ''));
  segments.push(segment('REF', 'TN', x12(run.erpReference, 50)));
  if (payment.externalReference) segments.push(segment('REF', 'CK', x12(payment.externalReference, 50)));
  segments.push(segment('DTM', '097', ccyymmdd(createdAt)));

  segments.push(segment('N1', 'PR', x12(payer.name || profile.senderName || profile.senderId, 60), payer.idQualifier || '91', x12(payer.id || profile.senderId, 80)));
  segments.push(segment('N1', 'PE', x12(payee.name, 60), payee.idQualifier || '91', x12(payee.id || payee.accountNumber || payee.name, 80)));
  if (payee.addressLine1) segments.push(segment('N3', x12(payee.addressLine1, 55), x12(payee.addressLine2, 55)));
  if (payee.city || payee.state || payee.postalCode) {
    segments.push(segment('N4', x12(payee.city, 30), x12(payee.state, 2), x12(digits(payee.postalCode) || payee.postalCode, 15), x12(payee.country || 'US', 3)));
  }

  segments.push(segment('ENT', '1'));
  const remittances = Array.isArray(payment.remittance) && payment.remittance.length
    ? payment.remittance
    : [{ invoiceNumber: payment.reference || `${run.erpReference}-${index + 1}`, amountCents: payment.amountCents, description: payment.memo }];
  for (const line of remittances) {
    const paid = dollars(line.amountCents);
    const gross = line.grossAmountCents !== undefined ? dollars(line.grossAmountCents) : paid;
    const discount = line.discountCents ? dollars(line.discountCents) : '';
    segments.push(segment('RMR', line.qualifier || 'IV', x12(line.invoiceNumber || line.reference, 50), 'PO', paid, gross, discount));
    if (line.purchaseOrder) segments.push(segment('REF', 'PO', x12(line.purchaseOrder, 50)));
    if (line.description) segments.push(segment('REF', 'ZZ', x12(line.description, 50)));
    if (line.invoiceDate) segments.push(segment('DTM', '003', ccyymmdd(toDate(line.invoiceDate, createdAt))));
  }

  segments.push(segment('SE', String(segments.length + 1), stControl));
  return segments;
}

/**
 * Render a payout run into one X12 820 interchange.
 *
 * @param {Object} opts
 * @param {Object} opts.run       { erpReference, payments: [{ reference, amountCents, method, payee, remittance, effectiveDate }] }
 * @param {Object} opts.profile   { senderId, senderQualifier, receiverId, receiverQualifier, senderName, originatorId, payer, usageIndicator }
 * @param {Date}   [opts.createdAt]
 */
function renderEdi820({ run, profile, createdAt = new Date() }) {
  const failures = validateRun(run, profile);
  if (failures.length) {
    const first = failures[0];
    throw new Edi820Error(
      `${failures.length} problem${failures.length === 1 ? '' : 's'} prevent rendering an 820 for ${run && run.erpReference ? run.erpReference : 'this run'}: ${first.payment} — ${first.field}: ${first.message}`,
      'EDI_820_INVALID',
      422,
      { failures }
    );
  }

  const at = toDate(createdAt, new Date());
  const isaControl = controlNumber(`ISA:${run.erpReference}`, 9);
  const gsControl = String(Number(controlNumber(`GS:${run.erpReference}`, 9)));
  const usage = profile.usageIndicator === 'P' ? 'P' : 'T';

  const payments = run.payments;
  const bodies = payments.map((payment, index) => renderTransactionSet({ payment, index, run, profile, createdAt: at }));
  const totalAmountCents = payments.reduce((sum, p) => sum + Number(p.amountCents), 0);

  const isa = segment(
    'ISA',
    '00', pad('', 10),
    '00', pad('', 10),
    pad(profile.senderQualifier || 'ZZ', 2), pad(x12(profile.senderId), 15),
    pad(profile.receiverQualifier || 'ZZ', 2), pad(x12(profile.receiverId), 15),
    yymmdd(at), hhmm(at),
    REPETITION_SEPARATOR, ISA_VERSION, isaControl, '0', usage, SUB_ELEMENT_SEPARATOR,
  );
  const gs = segment('GS', 'RA', x12(profile.applicationSenderId || profile.senderId, 15), x12(profile.applicationReceiverId || profile.receiverId, 15), ccyymmdd(at), hhmm(at), gsControl, 'X', X12_VERSION);
  const ge = segment('GE', String(bodies.length), gsControl);
  const iea = segment('IEA', '1', isaControl);

  const segments = [isa, gs, ...bodies.flat(), ge, iea];
  const payload = segments.join('\n') + '\n';

  return {
    standard: 'X12',
    version: X12_VERSION,
    transactionSet: '820',
    functionalGroup: 'RA',
    contentType: 'application/edi-x12',
    extension: 'edi',
    erpReference: run.erpReference,
    interchangeControlNumber: isaControl,
    groupControlNumber: gsControl,
    usageIndicator: usage,
    payload,
    payloadHash: crypto.createHash('sha256').update(payload, 'utf8').digest('hex'),
    controls: { count: payments.length, transactionSets: bodies.length, totalAmountCents, segments: segments.length },
    createdAt: at.toISOString(),
  };
}

/** Minimal structural parse: enough to verify envelope counts and totals in tests and previews. */
function parseEdi820(payload) {
  const segments = String(payload || '')
    .split(/~\s*/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.split(ELEMENT_SEPARATOR));
  const find = (id) => segments.filter(s => s[0] === id);
  const isa = find('ISA')[0] || [];
  const gs = find('GS')[0] || [];
  const bpr = find('BPR');
  return {
    senderId: (isa[6] || '').trim(),
    receiverId: (isa[8] || '').trim(),
    interchangeControlNumber: isa[13] || null,
    usageIndicator: isa[15] || null,
    functionalGroup: gs[1] || null,
    transactionSets: find('ST').length,
    totalAmountCents: bpr.reduce((sum, s) => sum + Math.round(Number(s[2] || 0) * 100), 0),
    payments: bpr.map(s => ({ amountCents: Math.round(Number(s[2] || 0) * 100), method: s[4], receivingDfi: s[13], receiverAccount: s[15], effectiveDate: s[16] })),
    remittanceLines: find('RMR').length,
    segments,
  };
}

module.exports = {
  Edi820Error,
  PAYMENT_METHODS,
  X12_VERSION,
  renderEdi820,
  parseEdi820,
  validateRun,
  controlNumber,
};
