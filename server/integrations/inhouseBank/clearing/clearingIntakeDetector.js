'use strict';

/**
 * Inbound payment data — detection and normalisation
 *
 * What a data workflow hands over is whatever its source system emits: a JSON
 * array from the vendor settlement run, a CSV from a payroll export, a pain.001
 * from a sub-ledger, a pacs.008 from an upstream bank, a NACHA file from an
 * inherited ACH job. This module answers two questions about those bytes and
 * nothing else:
 *
 *   1. What is it? — `detectFormat` sniffs the payload and reports what it
 *      recognised, with the evidence it used. Detection is deliberately
 *      structural (root element, record geometry, delimiter) rather than
 *      extension-based, because a data workflow's `.txt` is routinely a NACHA
 *      file and its `.xml` is routinely either ISO message.
 *   2. What does it say? — `normalize` lifts every payment out into the same
 *      canonical instruction the in-house bank's ISO parser produces, so
 *      downstream formatting never sees the source format again.
 *
 * Detection never chooses the *output* spec. It reports what arrived; the rail
 * mapping in the configuration decides what the bank gets. A hostile input file
 * can therefore make the trust reject it, but it cannot make the trust emit a
 * file shaped for a different bank.
 */

const { Iso20022 } = require('../iso20022');
const { parseNACHAFile } = require('../../ach/nachaGenerator');

class ClearingIntakeError extends Error {
  constructor(message, code = 'CLEARING_INTAKE_ERROR', status = 400) {
    super(message);
    this.name = 'ClearingIntakeError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

const FORMATS = ['pain.001', 'pacs.008', 'nacha', 'csv', 'json'];

function textOf(input) {
  if (Buffer.isBuffer(input)) return input.toString('utf8');
  if (typeof input === 'string') return input;
  return null;
}

/**
 * Amounts arrive as dollars ("1,250.00", "$1250"), as cents (125000), or
 * already named as cents. Anything that is not one of those is refused rather
 * than rounded: a misread amount is a misdirected payment.
 */
function toCents(row, keys = {}) {
  const cents = keys.cents;
  if (cents !== undefined && cents !== null && String(cents).trim() !== '') {
    const value = Number(String(cents).replace(/[^0-9-]/g, ''));
    if (!Number.isFinite(value)) throw new ClearingIntakeError(`Amount in cents "${cents}" is not a number`, 'CLEARING_INTAKE_AMOUNT');
    return Math.round(value);
  }
  const raw = keys.amount;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new ClearingIntakeError(`No amount on ${row || 'instruction'}`, 'CLEARING_INTAKE_AMOUNT');
  }
  const cleaned = String(raw).replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new ClearingIntakeError(`Amount "${raw}" on ${row || 'instruction'} is not a currency value`, 'CLEARING_INTAKE_AMOUNT');
  }
  return Math.round(Number(cleaned) * 100);
}

function pick(source, names) {
  for (const name of names) {
    const value = source[name];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return null;
}

/** Alias sets, because no two source systems name these columns the same way. */
const ALIASES = {
  reference: ['reference', 'ref', 'id', 'paymentid', 'payment_id', 'endtoendid', 'end_to_end_id', 'traceid', 'trace_id'],
  amount: ['amount', 'amountusd', 'amount_usd', 'value', 'total', 'gross'],
  amountCents: ['amountcents', 'amount_cents', 'cents', 'amountminor', 'amount_minor'],
  currency: ['currency', 'ccy', 'curr'],
  rail: ['rail', 'method', 'paymentmethod', 'payment_method', 'network', 'type', 'paymenttype', 'payment_type'],
  direction: ['direction', 'drcr', 'debitcredit', 'debit_credit'],
  creditorName: ['creditorname', 'creditor_name', 'beneficiary', 'beneficiaryname', 'beneficiary_name', 'payeename', 'payee_name', 'payee', 'vendor', 'vendorname', 'name', 'receivername', 'receiver_name'],
  creditorAccount: ['creditoraccount', 'creditor_account', 'accountnumber', 'account_number', 'account', 'beneficiaryaccount', 'beneficiary_account', 'payeeaccount', 'dda'],
  creditorRouting: ['creditorrouting', 'creditor_routing', 'routingnumber', 'routing_number', 'routing', 'aba', 'abanumber', 'aba_number', 'rdfi'],
  creditorBic: ['bic', 'swift', 'swiftcode', 'swift_code', 'bicfi'],
  creditorIban: ['iban'],
  creditorBank: ['bankname', 'bank_name', 'creditorbank', 'creditor_bank', 'receivingbank', 'receiving_bank'],
  accountType: ['accounttype', 'account_type', 'dda_type'],
  country: ['country', 'countrycode', 'country_code', 'ctry'],
  debtorName: ['debtorname', 'debtor_name', 'originator', 'originatorname', 'originator_name', 'payername', 'payer_name'],
  debtorAccount: ['debtoraccount', 'debtor_account', 'sourceaccount', 'source_account', 'fromaccount', 'from_account', 'funding_account'],
  remittance: ['remittance', 'remittanceinformation', 'remittance_information', 'memo', 'description', 'note', 'invoice', 'invoicenumber', 'invoice_number', 'obi'],
  purposeCode: ['purposecode', 'purpose_code', 'purpose'],
  effectiveDate: ['effectivedate', 'effective_date', 'valuedate', 'value_date', 'settlementdate', 'settlement_date', 'executiondate', 'execution_date'],
  secCode: ['seccode', 'sec_code', 'sec'],
};

/** Flatten `{ creditor: { name } }` and `{ creditor_name: ... }` into one lookup. */
function flatten(record, prefix = '', sink = {}) {
  for (const [key, value] of Object.entries(record || {})) {
    const flatKey = `${prefix}${String(key).toLowerCase().replace(/[^a-z0-9_]/g, '')}`;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, `${flatKey}`, sink);
      // Also expose nested leaves under their bare name so `creditor.name`
      // resolves through the `creditorname` alias and through `name`.
      continue;
    }
    if (sink[flatKey] === undefined) sink[flatKey] = value;
    const bare = String(key).toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (sink[bare] === undefined) sink[bare] = value;
  }
  return sink;
}

function normalizeRail(raw) {
  const value = String(raw || '').toLowerCase();
  if (!value) return null;
  if (/fedwire|wire|rtgs/.test(value)) return 'fedwire';
  if (/rtp|instant|fednow/.test(value)) return 'rtp';
  if (/swift|international|cross.?border/.test(value)) return 'swift';
  if (/ach|nacha|eft/.test(value)) return 'ach';
  return value;
}

function instructionFromRecord(record, index) {
  const flat = flatten(record);
  const rowLabel = `row ${index + 1}`;
  const amountCents = toCents(rowLabel, { amount: pick(flat, ALIASES.amount), cents: pick(flat, ALIASES.amountCents) });
  const direction = String(pick(flat, ALIASES.direction) || 'credit').toLowerCase().startsWith('d') ? 'debit' : 'credit';
  const effectiveDate = pick(flat, ALIASES.effectiveDate);
  return {
    reference: pick(flat, ALIASES.reference),
    endToEndId: pick(flat, ALIASES.reference),
    amountCents: Math.abs(amountCents),
    currency: (pick(flat, ALIASES.currency) || 'USD').toUpperCase(),
    rail: normalizeRail(pick(flat, ALIASES.rail)),
    direction: amountCents < 0 ? 'debit' : direction,
    debtor: {
      name: pick(flat, ALIASES.debtorName),
      accountNumber: pick(flat, ALIASES.debtorAccount),
    },
    creditor: {
      name: pick(flat, ALIASES.creditorName),
      accountNumber: pick(flat, ALIASES.creditorAccount),
      routingNumber: pick(flat, ALIASES.creditorRouting),
      bic: pick(flat, ALIASES.creditorBic),
      iban: pick(flat, ALIASES.creditorIban),
      bankName: pick(flat, ALIASES.creditorBank),
      accountType: pick(flat, ALIASES.accountType),
      country: (pick(flat, ALIASES.country) || 'US').toUpperCase(),
    },
    remittanceInformation: pick(flat, ALIASES.remittance),
    purposeCode: pick(flat, ALIASES.purposeCode),
    effectiveDate: effectiveDate ? new Date(effectiveDate) : null,
    secCode: pick(flat, ALIASES.secCode),
    sourceFormat: null,
  };
}

// ── CSV ──────────────────────────────────────────────────────────────────────

function splitCsvLine(line, delimiter) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') { cell += '"'; i += 1; continue; }
      if (char === '"') { quoted = false; continue; }
      cell += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === delimiter) { cells.push(cell); cell = ''; continue; }
    cell += char;
  }
  cells.push(cell);
  return cells.map(value => value.trim());
}

function detectDelimiter(headerLine) {
  const candidates = [',', ';', '\t', '|'];
  return candidates
    .map(delimiter => ({ delimiter, count: headerLine.split(delimiter).length }))
    .sort((a, b) => b.count - a.count)[0];
}

function parseCsv(content) {
  const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');
  if (lines.length < 2) throw new ClearingIntakeError('The CSV has a header but no rows', 'CLEARING_INTAKE_EMPTY');
  const { delimiter } = detectDelimiter(lines[0]);
  const header = splitCsvLine(lines[0], delimiter);
  return lines.slice(1).map(line => {
    const cells = splitCsvLine(line, delimiter);
    const record = {};
    header.forEach((column, index) => { record[column] = cells[index]; });
    return record;
  });
}

// ── ISO 20022 pacs.008 ──────────────────────────────────────────────────────

function tagText(xml, tag) {
  const match = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`).exec(xml || '');
  return match ? match[1].trim() : null;
}

function tagBlocks(xml, tag) {
  const blocks = [];
  const pattern = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'g');
  let match = pattern.exec(xml);
  while (match) {
    blocks.push(match[1]);
    match = pattern.exec(xml);
  }
  return blocks;
}

function parsePacs008(xml) {
  const transactions = tagBlocks(xml, 'CdtTrfTxInf');
  if (!transactions.length) throw new ClearingIntakeError('The pacs.008 carries no CdtTrfTxInf transaction', 'CLEARING_INTAKE_EMPTY');
  return transactions.map((transaction, index) => {
    const amountMatch = /<(?:\w+:)?(?:IntrBkSttlmAmt|InstdAmt)\s+Ccy="([A-Za-z]{3})"[^>]*>([\s\S]*?)</.exec(transaction);
    if (!amountMatch) throw new ClearingIntakeError(`Transaction ${index + 1} has no settlement amount`, 'CLEARING_INTAKE_AMOUNT');
    const creditor = tagBlocks(transaction, 'Cdtr')[0] || '';
    const creditorAccount = tagBlocks(transaction, 'CdtrAcct')[0] || '';
    const creditorAgent = tagBlocks(transaction, 'CdtrAgt')[0] || '';
    const debtor = tagBlocks(transaction, 'Dbtr')[0] || '';
    const debtorAccount = tagBlocks(transaction, 'DbtrAcct')[0] || '';
    const paymentId = tagBlocks(transaction, 'PmtId')[0] || '';
    return {
      reference: tagText(paymentId, 'EndToEndId') || tagText(paymentId, 'InstrId'),
      endToEndId: tagText(paymentId, 'EndToEndId'),
      uetr: tagText(paymentId, 'UETR'),
      amountCents: toCents(`transaction ${index + 1}`, { amount: amountMatch[2].trim() }),
      currency: amountMatch[1].toUpperCase(),
      rail: null,
      direction: 'credit',
      debtor: { name: tagText(debtor, 'Nm'), accountNumber: tagText(debtorAccount, 'Id') },
      creditor: {
        name: tagText(creditor, 'Nm'),
        accountNumber: tagText(creditorAccount, 'IBAN') || tagText(creditorAccount, 'Id'),
        iban: tagText(creditorAccount, 'IBAN'),
        routingNumber: tagText(creditorAgent, 'MmbId'),
        bic: tagText(creditorAgent, 'BICFI') || tagText(creditorAgent, 'BIC'),
        country: (tagText(creditor, 'Ctry') || 'US').toUpperCase(),
      },
      remittanceInformation: tagText(tagBlocks(transaction, 'RmtInf')[0] || '', 'Ustrd'),
      purposeCode: tagText(tagBlocks(transaction, 'Purp')[0] || '', 'Cd'),
      effectiveDate: null,
      secCode: null,
      sourceFormat: 'pacs.008',
    };
  });
}

// ── NACHA ────────────────────────────────────────────────────────────────────

function parseNacha(content) {
  const parsed = parseNACHAFile(content);
  const entries = (parsed.batches || []).flatMap(batch =>
    (batch.entries || []).map(entry => ({ batch, entry })));
  if (!entries.length) throw new ClearingIntakeError('The NACHA file carries no entry detail records', 'CLEARING_INTAKE_EMPTY');
  return entries.map(({ batch, entry }) => ({
    reference: entry.individualId || entry.traceNumber || null,
    endToEndId: entry.individualId || entry.traceNumber || null,
    amountCents: Number(entry.amountCents || entry.amount || 0),
    currency: 'USD',
    rail: 'ach',
    direction: ['27', '37'].includes(String(entry.transactionCode)) ? 'debit' : 'credit',
    transactionCode: entry.transactionCode || null,
    debtor: { name: batch.companyName || null, accountNumber: null },
    creditor: {
      name: entry.individualName || null,
      accountNumber: entry.accountNumber || null,
      routingNumber: `${entry.receivingDFI || ''}${entry.checkDigit || ''}` || null,
      accountType: ['32', '37'].includes(String(entry.transactionCode)) ? 'savings' : 'checking',
      country: 'US',
    },
    remittanceInformation: batch.description || null,
    purposeCode: null,
    effectiveDate: null,
    secCode: batch.secCode || null,
    sourceFormat: 'nacha',
  }));
}

// ── Detection ────────────────────────────────────────────────────────────────

/**
 * Report what the payload is, and why. `confidence` is 'certain' when the
 * payload identified itself structurally (an ISO root element, 94-character
 * NACHA geometry) and 'likely' when it was recognised by shape alone.
 */
function detectFormat(input) {
  if (input && typeof input === 'object' && !Buffer.isBuffer(input)) {
    return { format: 'json', confidence: 'certain', evidence: 'the payload arrived as a parsed object' };
  }
  const content = textOf(input);
  if (content === null) throw new ClearingIntakeError('Payload must be a string, Buffer or object', 'CLEARING_INTAKE_TYPE');
  const trimmed = content.trim();
  if (!trimmed) throw new ClearingIntakeError('Payload is empty', 'CLEARING_INTAKE_EMPTY');

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return { format: 'json', confidence: 'certain', evidence: 'the payload opens a JSON object or array' };
  }
  if (trimmed.startsWith('<')) {
    if (/CstmrCdtTrfInitn/i.test(trimmed)) {
      return { format: 'pain.001', confidence: 'certain', evidence: 'the document root is CstmrCdtTrfInitn' };
    }
    if (/FIToFICstmrCdtTrf/i.test(trimmed)) {
      return { format: 'pacs.008', confidence: 'certain', evidence: 'the document root is FIToFICstmrCdtTrf' };
    }
    throw new ClearingIntakeError(
      'The payload is XML but neither a pain.001 CustomerCreditTransferInitiation nor a pacs.008 FIToFICustomerCreditTransfer',
      'CLEARING_INTAKE_UNSUPPORTED_XML'
    );
  }

  const lines = trimmed.split(/\r?\n/).filter(line => line.trim() !== '');
  const fixedWidth = lines.every(line => line.replace(/\r$/, '').length === 94);
  if (fixedWidth && /^1[01]/.test(lines[0])) {
    return { format: 'nacha', confidence: 'certain', evidence: 'every record is 94 characters and the file opens with a type 1 header' };
  }
  if (lines.length >= 2 && detectDelimiter(lines[0]).count > 1) {
    const { delimiter, count } = detectDelimiter(lines[0]);
    return {
      format: 'csv',
      confidence: 'likely',
      evidence: `the first line splits into ${count} columns on "${delimiter === '\t' ? '\\t' : delimiter}"`,
    };
  }
  throw new ClearingIntakeError(
    `The payload matches no known payment data format; recognised formats are ${FORMATS.join(', ')}`,
    'CLEARING_INTAKE_UNRECOGNISED'
  );
}

/**
 * Detect and lift into canonical instructions in one step. `format` may be
 * supplied to skip detection when the caller already knows what it holds.
 */
function normalize(input, { format = null } = {}) {
  const detection = format
    ? { format: String(format).toLowerCase(), confidence: 'declared', evidence: 'the caller declared the format' }
    : detectFormat(input);

  let instructions;
  switch (detection.format) {
    case 'json': {
      const parsed = typeof input === 'string' || Buffer.isBuffer(input) ? JSON.parse(textOf(input)) : input;
      const records = Array.isArray(parsed)
        ? parsed
        : (parsed.instructions || parsed.payments || parsed.items || parsed.rows || null);
      if (!Array.isArray(records) || records.length === 0) {
        throw new ClearingIntakeError(
          'The JSON payload carries no payments: expected an array, or an object with an instructions, payments, items or rows array',
          'CLEARING_INTAKE_EMPTY'
        );
      }
      instructions = records.map((record, index) => ({ ...instructionFromRecord(record, index), sourceFormat: 'json' }));
      break;
    }
    case 'csv':
      instructions = parseCsv(textOf(input)).map((record, index) => ({
        ...instructionFromRecord(record, index),
        sourceFormat: 'csv',
      }));
      break;
    case 'pain.001':
      instructions = Iso20022.parsePain001(textOf(input)).instructions.map(instruction => ({
        reference: instruction.endToEndId || null,
        endToEndId: instruction.endToEndId || null,
        amountCents: instruction.amountCents,
        currency: instruction.currency,
        rail: instruction.requestedSpeed === 'instant' ? 'rtp' : null,
        direction: 'credit',
        debtor: { name: null, accountNumber: instruction.debtorAccount || null },
        creditor: { ...instruction.creditor },
        remittanceInformation: instruction.remittanceInformation || null,
        purposeCode: instruction.purposeCode || null,
        effectiveDate: instruction.requestedExecutionDate ? new Date(instruction.requestedExecutionDate) : null,
        secCode: null,
        sourceFormat: 'pain.001',
      }));
      break;
    case 'pacs.008':
      instructions = parsePacs008(textOf(input));
      break;
    case 'nacha':
      instructions = parseNacha(textOf(input));
      break;
    default:
      throw new ClearingIntakeError(
        `Cannot normalise format "${detection.format}"; recognised formats are ${FORMATS.join(', ')}`,
        'CLEARING_INTAKE_UNRECOGNISED'
      );
  }

  return { detection, instructions };
}

module.exports = {
  ClearingIntakeError,
  detectFormat,
  normalize,
  normalizeRail,
  FORMATS,
};
