'use strict';

/**
 * Direct Send — the raw clearing file
 *
 * A clearing file is one ISO 20022 pacs.008 envelope carrying every dispatched
 * wire in the batch. Two properties make it safe to hand straight to a bank's
 * pipeline with no portal in front of it:
 *
 *   • The transaction bodies are not re-rendered here. Each `<CdtTrfTxInf>` is
 *     lifted verbatim out of the payment's own pacs.008 — the same bytes the
 *     idempotency vault reserved and hashed for that payment — so a batched
 *     wire and a single-file wire instruct the bank identically, and the vault's
 *     payload-conflict check still means what it says.
 *   • The group header carries the control totals the bank's pipeline balances
 *     against: the number of transactions and the summed interbank settlement
 *     amount. The manifest repeats them next to the file digest, so a truncated
 *     or altered file fails the bank's arithmetic instead of clearing.
 *
 * The file is signed detached: the bank authenticates the bytes it ingested,
 * not merely the connection they arrived on.
 */

const crypto = require('crypto');
const fs = require('fs');

class WireClearingFileError extends Error {
  constructor(message, code = 'WIRE_CLEARING_FILE_ERROR', status = 400) {
    super(message);
    this.name = 'WireClearingFileError';
    this.code = code;
    this.status = status;
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

function stamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '');
}

function hashPayload(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Lift the transaction body out of a single-payment pacs.008. Anything else in
 * that message (its own group header and totals) belongs to a file of one and
 * is replaced by the batch header.
 */
function transactionBlockFrom(pacs008, paymentId) {
  const match = /<CdtTrfTxInf>[\s\S]*<\/CdtTrfTxInf>/.exec(String(pacs008 || ''));
  if (!match) {
    throw new WireClearingFileError(
      `The pacs.008 rendered for ${paymentId} has no CdtTrfTxInf to clear`,
      'WIRE_CLEARING_NO_TRANSACTION',
      500
    );
  }
  return match[0];
}

function indent(block, spaces) {
  const pad = ' '.repeat(spaces);
  return block
    .split('\n')
    .map(line => (line.trim() ? pad + line.trim() : line))
    .join('\n');
}

function filenameFor(batchId, createdAt, config) {
  const suffix = String(batchId).split('-').pop();
  return `${config.filePrefix}-${stamp(createdAt)}-${suffix}${config.fileExtension}`;
}

/**
 * Build the batch envelope. `members` are `{ payment, pacs008 }` pairs, already
 * validated and reserved by the engine; this function only renders.
 */
function buildClearingFile({ batchId, members, config, createdAt = new Date() }) {
  if (!Array.isArray(members) || members.length === 0) {
    throw new WireClearingFileError('A clearing file needs at least one dispatched wire', 'WIRE_CLEARING_EMPTY', 409);
  }
  const currency = (members[0].payment.currency || config.currency || 'USD').toUpperCase();
  const mixed = members.find(m => (m.payment.currency || currency).toUpperCase() !== currency);
  if (mixed) {
    throw new WireClearingFileError(
      `Payment ${mixed.payment.paymentId} is ${mixed.payment.currency} in a ${currency} clearing file; the bank balances one currency per file`,
      'WIRE_CLEARING_MIXED_CURRENCY',
      409
    );
  }

  const totalCents = members.reduce((sum, m) => sum + Number(m.payment.amountCents || 0), 0);
  const total = (totalCents / 100).toFixed(2);
  const transactions = members
    .map(m => indent(transactionBlockFrom(m.pacs008, m.payment.paymentId), 4))
    .join('\n');

  const payload = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08">
  <FIToFICstmrCdtTrf>
    <GrpHdr>
      <MsgId>${escapeXml(batchId)}</MsgId>
      <CreDtTm>${createdAt.toISOString()}</CreDtTm>
      <NbOfTxs>${members.length}</NbOfTxs>
      <TtlIntrBkSttlmAmt Ccy="${escapeXml(currency)}">${total}</TtlIntrBkSttlmAmt>
      <IntrBkSttlmDt>${createdAt.toISOString().slice(0, 10)}</IntrBkSttlmDt>
      <SttlmInf><SttlmMtd>CLRG</SttlmMtd></SttlmInf>
      <InstgAgt><FinInstnId><BICFI>${escapeXml(config.senderId)}</BICFI></FinInstnId></InstgAgt>
${config.receiverId ? `      <InstdAgt><FinInstnId><BICFI>${escapeXml(config.receiverId)}</BICFI></FinInstnId></InstdAgt>\n` : ''}    </GrpHdr>
${transactions}
  </FIToFICstmrCdtTrf>
</Document>`;

  return {
    batchId,
    filename: filenameFor(batchId, createdAt, config),
    payload,
    payloadHash: hashPayload(payload),
    currency,
    count: members.length,
    totalAmountCents: totalCents,
    createdAt: createdAt.toISOString(),
  };
}

/**
 * Detached signature over the exact bytes sent. HMAC when the bank issued a
 * shared secret, asymmetric when it registered the trust's public key.
 */
function signClearingFile(payload, config) {
  const algorithm = String(config.signingAlgorithm || '').toLowerCase();
  if (algorithm === 'hmac-sha256') {
    if (!config.signingSecret) return null;
    return {
      algorithm: 'hmac-sha256',
      value: crypto.createHmac('sha256', config.signingSecret).update(payload, 'utf8').digest('hex'),
    };
  }
  const keyPem = config.signingKeyPath ? fs.readFileSync(config.signingKeyPath, 'utf8') : config.signingSecret;
  if (!keyPem) return null;
  const digest = algorithm.endsWith('sha512') ? 'sha512' : 'sha256';
  try {
    const key = config.signingKeyPassphrase
      ? { key: keyPem, passphrase: config.signingKeyPassphrase }
      : keyPem;
    return {
      algorithm,
      value: crypto.createSign(digest).update(payload, 'utf8').sign(key, 'base64'),
    };
  } catch (error) {
    throw new WireClearingFileError(
      `The clearing file could not be signed with ${algorithm}: ${error.message}`,
      'WIRE_CLEARING_SIGNATURE_FAILED',
      500
    );
  }
}

/**
 * The manifest travels beside the file so the bank — and the trust's own
 * auditors — can balance the file without parsing it.
 */
function buildManifest({ file, members, signature, config }) {
  return {
    batchId: file.batchId,
    filename: file.filename,
    format: 'pacs.008.001.08',
    createdAt: file.createdAt,
    sender: config.senderId,
    receiver: config.receiverId || null,
    mode: config.mode,
    currency: file.currency,
    controls: {
      count: file.count,
      totalAmountCents: file.totalAmountCents,
      totalAmount: (file.totalAmountCents / 100).toFixed(2),
      payloadSha256: file.payloadHash,
    },
    signature: signature ? { algorithm: signature.algorithm, value: signature.value } : null,
    items: members.map(({ payment }) => ({
      paymentId: payment.paymentId,
      endToEndId: payment.endToEndId || payment.paymentId,
      uetr: payment.uetr || null,
      rail: payment.rail,
      amountCents: Number(payment.amountCents || 0),
      currency: (payment.currency || file.currency).toUpperCase(),
      creditorName: (payment.creditor && payment.creditor.name) || null,
      creditorRouting: (payment.creditor && (payment.creditor.routingNumber || payment.creditor.bic)) || null,
    })),
  };
}

module.exports = {
  WireClearingFileError,
  buildClearingFile,
  buildManifest,
  signClearingFile,
  transactionBlockFrom,
  filenameFor,
  hashPayload,
};
