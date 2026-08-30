'use strict';

/**
 * Bank advice parsing
 *
 * Everything the bank tells us after we drop a file arrives as another file:
 * an acknowledgement that our pacs.008 was picked up and accepted, a status
 * report as it clears, or a pacs.004 return when the beneficiary side sends
 * the money back. Correspondent banks differ wildly in what they put in that
 * directory, so this parser accepts the three shapes that actually turn up —
 * ISO 20022 XML, JSON, and delimited text — and normalises all of them into
 * one advice record.
 *
 * The parser is deliberately strict about identity and lenient about
 * everything else. An advice that cannot be tied to one of our payments by
 * end-to-end id, payment id, our filename or the bank's own reference is
 * returned as unmatched for an operator to look at; it is never guessed at by
 * amount, because two family members wiring the same amount on the same day is
 * an ordinary Tuesday.
 *
 * Nothing here touches the ledger. Parsing answers "what did the bank say";
 * deciding what that means for the money is the reconciliation engine's job.
 */

const crypto = require('crypto');

const ACCEPTED_STATUSES = Object.freeze(['ACTC', 'ACCP', 'ACSP', 'PDNG', 'RCVD']);
const SETTLED_STATUSES = Object.freeze(['ACSC', 'ACCC', 'SETT']);
const REJECTED_STATUSES = Object.freeze(['RJCT', 'CANC']);

class WireAdviceError extends Error {
  constructor(message, code = 'WIRE_H2H_ADVICE', status = 422) {
    super(message);
    this.name = 'WireAdviceError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function tag(xml, name) {
  const match = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i').exec(xml);
  return match ? match[1].trim() : null;
}

function tagAll(xml, name) {
  const out = [];
  const re = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'gi');
  let match;
  while ((match = re.exec(xml)) !== null) out.push(match[1]);
  return out;
}

function attr(xml, name, attribute) {
  const match = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*\\b${attribute}="([^"]*)"`, 'i').exec(xml);
  return match ? match[1] : null;
}

function decode(value) {
  if (value === null || value === undefined) return null;
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim() || null;
}

function amountToCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(String(value).replace(/[, ]/g, ''));
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric * 100);
}

function contentHash(content) {
  return crypto.createHash('sha256').update(String(content), 'utf8').digest('hex');
}

function classify(status, adviceType) {
  if (adviceType === 'return') return 'returned';
  if (SETTLED_STATUSES.includes(status)) return 'settled';
  if (REJECTED_STATUSES.includes(status)) return 'rejected';
  if (ACCEPTED_STATUSES.includes(status)) return 'acknowledged';
  return null;
}

function normalise(record, { filename, raw, adviceType }) {
  const outcome = classify(record.status, adviceType);
  return {
    adviceType,
    filename: filename || null,
    contentHash: contentHash(raw),
    paymentId: record.paymentId || null,
    endToEndId: record.endToEndId || null,
    uetr: record.uetr || null,
    originalFilename: record.originalFilename || null,
    bankReference: record.bankReference || null,
    status: record.status || null,
    outcome,
    reasonCode: record.reasonCode || null,
    reason: record.reason || null,
    amountCents: record.amountCents === undefined ? null : record.amountCents,
    currency: record.currency || null,
    raw,
  };
}

/** ISO 20022 pacs.002 / pain.002 status reports and pacs.004 returns. */
function parseXmlAdvice(xml, filename) {
  const isReturn = /pacs\.004|PmtRtr|RtrRsnInf|<(?:\w+:)?TxInf>[\s\S]*?<(?:\w+:)?RtrId>/i.test(xml);
  const blocks = isReturn
    ? tagAll(xml, 'TxInf').concat(tagAll(xml, 'OrgnlTxRef'))
    : tagAll(xml, 'TxInfAndSts').concat(tagAll(xml, 'OrgnlPmtInfAndSts'));
  const scopes = blocks.length ? blocks : [xml];
  const adviceType = isReturn ? 'return' : 'status';

  return scopes.map(scope => {
    const reasonBlock = tag(scope, 'RtrRsnInf') || tag(scope, 'StsRsnInf') || '';
    const record = {
      paymentId: decode(tag(scope, 'OrgnlInstrId')) || decode(tag(scope, 'InstrId')),
      endToEndId: decode(tag(scope, 'OrgnlEndToEndId')) || decode(tag(scope, 'EndToEndId')),
      uetr: decode(tag(scope, 'OrgnlUETR')) || decode(tag(scope, 'UETR')),
      originalFilename: decode(tag(xml, 'OrgnlMsgId')),
      bankReference: decode(tag(scope, 'RtrId')) || decode(tag(scope, 'AcctSvcrRef')) || decode(tag(scope, 'ClrSysRef')) || decode(tag(xml, 'MsgId')),
      status: decode(tag(scope, 'TxSts')) || decode(tag(scope, 'GrpSts')) || (isReturn ? 'RTRN' : null),
      reasonCode: decode(tag(reasonBlock, 'Cd')) || decode(tag(reasonBlock, 'Prtry')),
      reason: decode(tag(reasonBlock, 'AddtlInf')) || decode(tag(scope, 'AddtlInf')),
      amountCents: amountToCents(decode(tag(scope, 'RtrdIntrBkSttlmAmt')) || decode(tag(scope, 'IntrBkSttlmAmt'))),
      currency: attr(scope, 'RtrdIntrBkSttlmAmt', 'Ccy') || attr(scope, 'IntrBkSttlmAmt', 'Ccy'),
    };
    return normalise(record, { filename, raw: xml, adviceType });
  });
}

function fromLooseObject(source, { filename, raw, forcedType }) {
  const pick = (...keys) => {
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined && value !== null && value !== '') return String(value).trim();
    }
    return null;
  };
  const status = (pick('status', 'txSts', 'tx_status', 'state') || '').toUpperCase() || null;
  const declaredType = (pick('type', 'adviceType', 'advice_type', 'recordType') || '').toLowerCase();
  const adviceType = forcedType
    || (declaredType.includes('return') || status === 'RTRN' ? 'return'
      : declaredType.includes('ack') ? 'ack' : 'status');
  const rawCents = pick('amountCents', 'amount_cents');
  const amountCents = rawCents !== null
    ? (Number.isFinite(Number(rawCents)) ? Math.round(Number(rawCents)) : null)
    : amountToCents(pick('amount'));
  const record = {
    paymentId: pick('paymentId', 'payment_id', 'instrId', 'originalInstructionId'),
    endToEndId: pick('endToEndId', 'end_to_end_id', 'e2eId', 'originalEndToEndId'),
    uetr: pick('uetr', 'UETR'),
    originalFilename: pick('originalFilename', 'original_filename', 'file', 'filename'),
    bankReference: pick('bankReference', 'bank_reference', 'reference', 'fedReference', 'imad', 'omad', 'returnReference'),
    status,
    reasonCode: pick('reasonCode', 'reason_code', 'code'),
    reason: pick('reason', 'description', 'message'),
    amountCents,
    currency: pick('currency', 'ccy'),
  };
  return normalise(record, { filename, raw, adviceType });
}

function parseJsonAdvice(text, filename) {
  const parsed = JSON.parse(text);
  const records = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.advices) ? parsed.advices : [parsed]);
  return records.map(record => fromLooseObject(record, { filename, raw: text }));
}

function parseDelimitedAdvice(text, filename) {
  const lines = String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length < 2) throw new WireAdviceError('Delimited advice needs a header row and at least one record');
  const delimiter = lines[0].includes('|') ? '|' : ',';
  const header = lines[0].split(delimiter).map(cell => cell.trim());
  return lines.slice(1).map(line => {
    const cells = line.split(delimiter).map(cell => cell.trim());
    const record = {};
    header.forEach((column, index) => { record[column] = cells[index]; });
    return fromLooseObject(record, { filename, raw: text });
  });
}

/**
 * Parse one advice file into normalised records. `filename` only guides format
 * detection and is echoed back for the audit trail.
 */
function parseAdvice(content, filename = null) {
  const text = String(content || '').trim();
  if (!text) throw new WireAdviceError('The advice file is empty');
  try {
    if (text.startsWith('<')) return parseXmlAdvice(text, filename);
    if (text.startsWith('{') || text.startsWith('[')) return parseJsonAdvice(text, filename);
    return parseDelimitedAdvice(text, filename);
  } catch (err) {
    if (err instanceof WireAdviceError) throw err;
    throw new WireAdviceError(`Could not parse advice ${filename || ''}: ${err.message}`.trim());
  }
}

module.exports = {
  parseAdvice,
  parseXmlAdvice,
  parseJsonAdvice,
  parseDelimitedAdvice,
  contentHash,
  classify,
  WireAdviceError,
  ACCEPTED_STATUSES,
  SETTLED_STATUSES,
  REJECTED_STATUSES,
};
