'use strict';

/**
 * Bank clearing spec registry
 *
 * One entry per file shape a bank pipeline will actually ingest, each able to
 * validate a canonical instruction set and render it. The canonical instruction
 * is the same object the in-house bank's ISO parser already produces, so a
 * pain.001 that entered through the ingress engine and a CSV that entered
 * through a data workflow are formatted from identical material.
 *
 * Two properties are load-bearing:
 *
 *   • Validation happens before rendering, and it names the instruction that
 *     failed. A NACHA file with one 8-digit routing number is refused whole by
 *     the ACH operator with a file-level reject; refusing it here instead
 *     costs a data workflow one error message and no clearing window.
 *   • Every render returns the control totals the bank balances the file
 *     against — count, summed amount, and for NACHA the entry hash the format
 *     itself carries. The manifest repeats them beside the payload digest, so
 *     a truncated file fails arithmetic rather than clearing partially.
 *
 * A spec is a description of a file format, not permission to send one: nothing
 * in this module opens a connection.
 */

const crypto = require('crypto');
const { generateNACHAFile, validateRouting } = require('../../ach/nachaGenerator');

class ClearingSpecError extends Error {
  constructor(message, code = 'CLEARING_SPEC_ERROR', status = 400, { failures = null } = {}) {
    super(message);
    this.name = 'ClearingSpecError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
    this.failures = failures;
  }
}

function escapeXml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function label(instruction, index) {
  return instruction.reference || instruction.endToEndId || `instruction ${index + 1}`;
}

function amount(instruction) {
  return Number(instruction.amountCents || 0);
}

function digits(value) {
  return String(value === null || value === undefined ? '' : value).replace(/\D/g, '');
}

/** Fixed-width and tag formats have no escaping, so unmappable bytes are dropped. */
function ascii(value, length) {
  const flat = String(value === null || value === undefined ? '' : value)
    .toUpperCase()
    .replace(/[^A-Z0-9 .,\-/&*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return length ? flat.slice(0, length) : flat;
}

function totals(instructions) {
  const totalAmountCents = instructions.reduce((sum, instruction) => sum + amount(instruction), 0);
  return { count: instructions.length, totalAmountCents };
}

function requireFields(instructions, checks) {
  const failures = [];
  instructions.forEach((instruction, index) => {
    for (const { field, ok, message } of checks) {
      if (!ok(instruction)) failures.push({ instruction: label(instruction, index), field, message });
    }
  });
  return failures;
}

function singleCurrency(instructions, fallback) {
  const first = (instructions[0].currency || fallback || 'USD').toUpperCase();
  const mixed = instructions.find((instruction, index) => index > 0 && (instruction.currency || first).toUpperCase() !== first);
  if (mixed) {
    throw new ClearingSpecError(
      `${label(mixed, instructions.indexOf(mixed))} is ${mixed.currency} in a ${first} clearing file; a bank balances one currency per file`,
      'CLEARING_SPEC_MIXED_CURRENCY',
      409
    );
  }
  return first;
}

// ── pacs.008 (ISO 20022 FI to FI customer credit transfer) ───────────────────

function renderPacs008({ instructions, batchId, createdAt, profile }) {
  const currency = singleCurrency(instructions, profile.currency);
  const { count, totalAmountCents } = totals(instructions);
  const settlementDate = createdAt.toISOString().slice(0, 10);

  const transactions = instructions.map((instruction, index) => {
    const creditor = instruction.creditor || {};
    const debtor = instruction.debtor || {};
    const value = (amount(instruction) / 100).toFixed(2);
    const creditorAgent = creditor.bic
      ? `<FinInstnId><BICFI>${escapeXml(creditor.bic)}</BICFI></FinInstnId>`
      : `<FinInstnId><ClrSysMmbId><ClrSysId><Cd>USABA</Cd></ClrSysId><MmbId>${escapeXml(digits(creditor.routingNumber))}</MmbId></ClrSysMmbId></FinInstnId>`;
    const creditorAccount = creditor.iban
      ? `<Id><IBAN>${escapeXml(creditor.iban)}</IBAN></Id>`
      : `<Id><Othr><Id>${escapeXml(creditor.accountNumber)}</Id></Othr></Id>`;
    // An empty debtor account element is worse than none: a validating bank
    // rejects the file on the element rather than on the missing account.
    const debtorAccount = debtor.accountNumber || profile.senderAccount;
    return `    <CdtTrfTxInf>
      <PmtId>
        <InstrId>${escapeXml(`${batchId}-${index + 1}`)}</InstrId>
        <EndToEndId>${escapeXml(instruction.endToEndId || instruction.reference || `${batchId}-${index + 1}`)}</EndToEndId>
${instruction.uetr ? `        <UETR>${escapeXml(instruction.uetr)}</UETR>\n` : ''}      </PmtId>
      <IntrBkSttlmAmt Ccy="${escapeXml(currency)}">${value}</IntrBkSttlmAmt>
      <IntrBkSttlmDt>${settlementDate}</IntrBkSttlmDt>
      <ChrgBr>SLEV</ChrgBr>
      <Dbtr><Nm>${escapeXml(debtor.name || profile.senderName)}</Nm></Dbtr>
${debtorAccount ? `      <DbtrAcct><Id><Othr><Id>${escapeXml(debtorAccount)}</Id></Othr></Id></DbtrAcct>\n` : ''}      <DbtrAgt><FinInstnId><BICFI>${escapeXml(profile.senderId)}</BICFI></FinInstnId></DbtrAgt>
      <CdtrAgt>${creditorAgent}</CdtrAgt>
      <Cdtr><Nm>${escapeXml(creditor.name)}</Nm>${creditor.country ? `<PstlAdr><Ctry>${escapeXml(creditor.country)}</Ctry></PstlAdr>` : ''}</Cdtr>
      <CdtrAcct>${creditorAccount}</CdtrAcct>
      <Purp><Cd>${escapeXml(instruction.purposeCode || 'OTHR')}</Cd></Purp>
${instruction.remittanceInformation ? `      <RmtInf><Ustrd>${escapeXml(instruction.remittanceInformation)}</Ustrd></RmtInf>\n` : ''}    </CdtTrfTxInf>`;
  }).join('\n');

  const payload = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08">
  <FIToFICstmrCdtTrf>
    <GrpHdr>
      <MsgId>${escapeXml(batchId)}</MsgId>
      <CreDtTm>${createdAt.toISOString()}</CreDtTm>
      <NbOfTxs>${count}</NbOfTxs>
      <TtlIntrBkSttlmAmt Ccy="${escapeXml(currency)}">${(totalAmountCents / 100).toFixed(2)}</TtlIntrBkSttlmAmt>
      <IntrBkSttlmDt>${settlementDate}</IntrBkSttlmDt>
      <SttlmInf><SttlmMtd>CLRG</SttlmMtd></SttlmInf>
      <InstgAgt><FinInstnId><BICFI>${escapeXml(profile.senderId)}</BICFI></FinInstnId></InstgAgt>
${profile.receiverId ? `      <InstdAgt><FinInstnId><BICFI>${escapeXml(profile.receiverId)}</BICFI></FinInstnId></InstdAgt>\n` : ''}    </GrpHdr>
${transactions}
  </FIToFICstmrCdtTrf>
</Document>`;

  return { payload, currency, controls: { count, totalAmountCents } };
}

// ── NACHA (ACH fixed-width, 94-character records) ────────────────────────────

/**
 * ACH carries direction and account type in the transaction code, so a debit
 * pull and a credit push are the same record with a different two-digit code.
 */
function transactionCode(instruction) {
  if (instruction.transactionCode) return String(instruction.transactionCode);
  const savings = String((instruction.creditor && instruction.creditor.accountType) || '').toLowerCase().startsWith('sav');
  const debit = String(instruction.direction || 'credit').toLowerCase() === 'debit';
  if (savings) return debit ? '37' : '32';
  return debit ? '27' : '22';
}

function renderNacha(secCode) {
  return function render({ instructions, batchId, createdAt, profile }) {
    const currency = singleCurrency(instructions, 'USD');
    if (currency !== 'USD') {
      throw new ClearingSpecError('NACHA files clear USD only', 'CLEARING_SPEC_CURRENCY_UNSUPPORTED', 409);
    }
    const { count, totalAmountCents } = totals(instructions);
    const entries = instructions.map((instruction, index) => {
      const creditor = instruction.creditor || {};
      return {
        receivingRouting: digits(creditor.routingNumber),
        accountNumber: ascii(creditor.accountNumber, 17),
        amountCents: amount(instruction),
        transactionCode: transactionCode(instruction),
        individualId: ascii(instruction.endToEndId || instruction.reference || `${batchId}-${index + 1}`, 15),
        individualName: ascii(creditor.name, 22),
        discretionaryData: ascii(instruction.remittanceInformation, 2),
      };
    });

    const effectiveEntryDate = instructions
      .map(instruction => instruction.effectiveDate)
      .find(Boolean) || createdAt;

    const payload = generateNACHAFile({
      immediateDestination: digits(profile.receiverRouting) || digits(profile.senderRouting),
      immediateDestinationName: ascii(profile.receiverName || profile.senderName, 23),
      immediateOriginName: ascii(profile.senderName, 23),
      companyName: ascii(profile.senderName, 16),
      fileCreationDate: createdAt,
      referenceCode: ascii(batchId.split('-').pop(), 8),
    }, [{
      secCode,
      serviceClassCode: entries.every(entry => ['27', '37'].includes(entry.transactionCode)) ? '225' : '220',
      companyEntryDescription: ascii(profile.entryDescription || 'TRUST PMT', 10),
      effectiveEntryDate,
      entries,
    }]);

    // The format's own control total, recomputed here so the manifest can be
    // balanced against the file without parsing it back.
    const entryHash = entries.reduce((sum, entry) => sum + Number(digits(entry.receivingRouting).slice(0, 8) || 0), 0) % 10000000000;

    return { payload, currency, controls: { count, totalAmountCents, entryHash, secCode } };
  };
}

// ── Fedwire tag format (FAIM core tags) ──────────────────────────────────────

function renderFedwireTag({ instructions, batchId, createdAt, profile }) {
  const currency = singleCurrency(instructions, 'USD');
  if (currency !== 'USD') {
    throw new ClearingSpecError('Fedwire clears USD only', 'CLEARING_SPEC_CURRENCY_UNSUPPORTED', 409);
  }
  const { count, totalAmountCents } = totals(instructions);
  const day = `${createdAt.toISOString().slice(5, 7)}${createdAt.toISOString().slice(8, 10)}`;

  const messages = instructions.map((instruction, index) => {
    const creditor = instruction.creditor || {};
    const debtor = instruction.debtor || {};
    const sequence = String(index + 1).padStart(6, '0');
    const lines = [
      `{1500}30{1510}1000{1520}${day}${ascii(profile.senderId, 8).replace(/ /g, '')}${sequence}`,
      `{2000}${String(amount(instruction)).padStart(12, '0')}`,
      `{3100}${digits(profile.senderRouting).padEnd(9, ' ')}${ascii(profile.senderName, 18)}`,
      `{3320}${ascii(instruction.endToEndId || instruction.reference || `${batchId}-${index + 1}`, 16)}`,
      `{3400}${digits(creditor.routingNumber).padEnd(9, ' ')}${ascii(creditor.bankName || profile.receiverName, 18)}`,
      '{3600}CTR',
      `{4200}D${ascii(creditor.accountNumber, 34)}*${ascii(creditor.name, 35)}*`,
      `{5000}D${ascii(debtor.accountNumber || profile.senderAccount, 34)}*${ascii(debtor.name || profile.senderName, 35)}*`,
    ];
    if (instruction.remittanceInformation) lines.push(`{6000}${ascii(instruction.remittanceInformation, 140)}`);
    return lines.join('\n');
  });

  const payload = `${messages.join('\n')}\n`;
  return { payload, currency, controls: { count, totalAmountCents } };
}

// ── Registry ─────────────────────────────────────────────────────────────────

const CREDITOR_NAME_CHECK = {
  field: 'creditor.name',
  ok: instruction => Boolean(instruction.creditor && instruction.creditor.name),
  message: 'a clearing file cannot name an unnamed beneficiary',
};

const AMOUNT_CHECK = {
  field: 'amountCents',
  ok: instruction => Number.isInteger(amount(instruction)) && amount(instruction) > 0,
  message: 'the amount must be a positive whole number of cents',
};

const SPECS = [
  {
    id: 'pacs.008.001.08',
    label: 'ISO 20022 pacs.008.001.08 FI to FI customer credit transfer',
    format: 'xml',
    extension: '.xml',
    contentType: 'application/xml',
    rails: ['fedwire', 'rtp', 'swift', 'wire'],
    render: renderPacs008,
    validate: instructions => requireFields(instructions, [
      AMOUNT_CHECK,
      CREDITOR_NAME_CHECK,
      {
        field: 'creditor.routingNumber|creditor.bic',
        ok: instruction => Boolean(instruction.creditor && (instruction.creditor.bic || digits(instruction.creditor.routingNumber).length === 9)),
        message: 'the creditor agent needs a BIC or a nine-digit routing number',
      },
      {
        field: 'creditor.accountNumber',
        ok: instruction => Boolean(instruction.creditor && (instruction.creditor.accountNumber || instruction.creditor.iban)),
        message: 'the creditor needs an account number or IBAN',
      },
    ]),
  },
  {
    id: 'fedwire-tag',
    label: 'Fedwire funds transfer tag format (FAIM core tags)',
    format: 'tag',
    extension: '.fwr',
    contentType: 'text/plain',
    rails: ['fedwire', 'wire'],
    render: renderFedwireTag,
    validate: (instructions, profile) => requireFields(instructions, [
      AMOUNT_CHECK,
      CREDITOR_NAME_CHECK,
      {
        field: 'creditor.routingNumber',
        ok: instruction => validateRouting(digits(instruction.creditor && instruction.creditor.routingNumber)),
        message: 'Fedwire routes on the receiving bank ABA, which must pass its check digit',
      },
      {
        field: 'creditor.accountNumber',
        ok: instruction => Boolean(instruction.creditor && instruction.creditor.accountNumber),
        message: 'tag {4200} needs the beneficiary account number',
      },
      {
        field: 'profile.senderRouting',
        ok: () => validateRouting(digits(profile && profile.senderRouting)),
        message: 'tag {3100} needs the trust bank ABA: set CLEARING_AUTOFORMAT_SENDER_ROUTING',
      },
    ]),
  },
  {
    id: 'nacha-ccd',
    label: 'NACHA CCD corporate credit or debit (94-character records)',
    format: 'fixed-width',
    extension: '.ach',
    contentType: 'text/plain',
    rails: ['ach'],
    render: renderNacha('CCD'),
    validate: (instructions, profile) => nachaChecks(instructions, profile),
  },
  {
    id: 'nacha-ppd',
    label: 'NACHA PPD prearranged payment and deposit (94-character records)',
    format: 'fixed-width',
    extension: '.ach',
    contentType: 'text/plain',
    rails: ['ach'],
    render: renderNacha('PPD'),
    validate: (instructions, profile) => nachaChecks(instructions, profile),
  },
];

function nachaChecks(instructions, profile) {
  return requireFields(instructions, [
    AMOUNT_CHECK,
    CREDITOR_NAME_CHECK,
    {
      field: 'creditor.routingNumber',
      ok: instruction => validateRouting(digits(instruction.creditor && instruction.creditor.routingNumber)),
      message: 'the RDFI routing number must be nine digits and pass its NACHA check digit',
    },
    {
      field: 'creditor.accountNumber',
      ok: instruction => Boolean(instruction.creditor && instruction.creditor.accountNumber),
      message: 'an entry detail record needs the receiver account number',
    },
    {
      field: 'profile.senderRouting',
      ok: () => digits(profile && profile.senderRouting).length === 9,
      message: 'the ODFI routing number is unset: set CLEARING_AUTOFORMAT_SENDER_ROUTING or NACHA_ODFI_ROUTING',
    },
  ]);
}

function listSpecs() {
  return SPECS.map(({ id, label: name, format, extension, contentType, rails }) => ({
    id,
    label: name,
    format,
    extension,
    contentType,
    rails: [...rails],
  }));
}

function specIds() {
  return SPECS.map(spec => spec.id);
}

function getSpec(id) {
  const wanted = String(id || '').toLowerCase();
  const spec = SPECS.find(entry => entry.id === wanted);
  if (!spec) {
    throw new ClearingSpecError(
      `Unknown bank clearing spec "${id}"; known specs are ${specIds().join(', ')}`,
      'CLEARING_SPEC_UNKNOWN',
      400
    );
  }
  return spec;
}

/**
 * Validate and render one instruction set into a spec. Returns the payload
 * bytes, their digest and the control totals the bank balances against.
 */
function formatToSpec({ specId, instructions, batchId, profile, createdAt = new Date() }) {
  const spec = getSpec(specId);
  if (!Array.isArray(instructions) || instructions.length === 0) {
    throw new ClearingSpecError('A clearing file needs at least one instruction', 'CLEARING_SPEC_EMPTY', 409);
  }
  const failures = spec.validate(instructions, profile) || [];
  if (failures.length) {
    const first = failures[0];
    throw new ClearingSpecError(
      `${failures.length} instruction${failures.length === 1 ? '' : 's'} cannot be cleared as ${spec.id}: ${first.instruction} — ${first.field}: ${first.message}`,
      'CLEARING_SPEC_INVALID',
      422,
      { failures }
    );
  }

  const { payload, currency, controls } = spec.render({ instructions, batchId, createdAt, profile });
  return {
    specId: spec.id,
    format: spec.format,
    contentType: spec.contentType,
    extension: spec.extension,
    payload,
    payloadHash: crypto.createHash('sha256').update(payload, 'utf8').digest('hex'),
    currency,
    controls,
    createdAt: createdAt.toISOString(),
  };
}

module.exports = {
  ClearingSpecError,
  formatToSpec,
  getSpec,
  listSpecs,
  specIds,
  transactionCode,
};
