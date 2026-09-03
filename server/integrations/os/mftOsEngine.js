'use strict';

/**
 * MFT OS — managed file transfer for the trust's bank payment files.
 *
 * Every rail that pays somebody by file ends the same way: a fixed-format file
 * is rendered, a person decides it may leave, it is handed to a bank host, and
 * the bank answers days later with an acknowledgement or a return. Payer OS,
 * the ACH engine and the wire host-to-host channel each do a version of that
 * for themselves. This engine is the one floor under all of them: one file
 * register, one set of channels, one lifecycle, and one place where a file is
 * proven to have been sent — or proven not to have been.
 *
 * Three kinds of file, one shape:
 *
 *   direct_deposit          PPD credits to individuals — payouts, distributions.
 *   vendor_payment          CCD credits to companies — invoices, fees.
 *   clearing_settlement     CCD/CTX mixed debits and credits between the
 *                           trust's own settlement accounts and its
 *                           counterparties — end-of-day nets.
 *   wire_payment            ISO 20022 pacs.008 credit transfers — one
 *                           envelope, one or many wires.
 *
 * Two doors in. `build` renders a file from entries. `ingest` takes a file
 * another engine already rendered (an ACH batch's NACHA, a wire's pacs.008),
 * parses it back to prove it adds up, and registers it under the caller's
 * `sourceRef` — so a rail that keeps its own record still transmits through
 * this one, and the same source is never registered twice.
 *
 * Lifecycle (nothing skips a step, and nothing goes backwards):
 *
 *   built        the file is rendered, hashed, and written to the register.
 *                Its entries are checked against its control totals before it
 *                is stored, so a file that does not add up is never a file.
 *   approved     a second person, not the builder, has read the totals and
 *                released it. One person can never both build and release.
 *   transmitted  the bytes are on the bank host under their final name. The
 *                transport writes to a staging name and renames, so the bank
 *                collector never sees a half-written file.
 *   acknowledged the bank's own acknowledgement was read back for this file.
 *   settled      the bank confirmed value moved; the register carries the
 *                bank's reference, never ours.
 *   rejected     the bank refused the file, or an operator withdrew it before
 *                transmission. Terminal.
 *
 * Two controls are load-bearing:
 *
 *   • Duplicate suppression. A file with the same content hash as one already
 *     transmitted on the same channel inside the replay window is refused. A
 *     payroll run submitted twice is the most expensive mistake a file channel
 *     can make, and the fix is to make it impossible rather than to reverse it.
 *   • Transport truth. A channel with no bank host runs on the local spool
 *     and says so on every file. The spool is not a simulator — it writes the
 *     same bytes with the same staging semantics — but in production a spool
 *     transmission is refused unless the operator has said in configuration
 *     that a spool is acceptable, because a file in a directory is not money
 *     that moved.
 */

const path = require('path');
const crypto = require('crypto');
const fsp = require('fs/promises');
const pool = require('../bonds/pgPool');
const { generateNACHAFile, parseNACHAFile, validateRouting, ODFI_ROUTING, ORIGINATOR_ID, ORIGINATOR_NAME } = require('../ach/nachaGenerator');
const wireTransport = require('../inhouseBank/wire/wireTransport');

const FILE_TYPES = {
  direct_deposit: {
    label: 'Direct deposit',
    format: 'nacha',
    secCode: 'PPD',
    serviceClassCode: '220',
    entryDescription: 'DIRECT DEP',
    allowDebits: false,
  },
  vendor_payment: {
    label: 'Vendor payment',
    format: 'nacha',
    secCode: 'CCD',
    serviceClassCode: '220',
    entryDescription: 'VENDOR PAY',
    allowDebits: false,
  },
  clearing_settlement: {
    label: 'Clearing and settlement',
    format: 'nacha',
    secCode: 'CCD',
    serviceClassCode: '200',
    entryDescription: 'SETTLEMENT',
    allowDebits: true,
  },
  wire_payment: {
    label: 'Wire payment',
    format: 'pacs.008',
    secCode: null,
    serviceClassCode: null,
    entryDescription: 'WIRE',
    allowDebits: false,
  },
};

const FORMATS = ['nacha', 'pacs.008'];
const EXTENSIONS = { nacha: 'ach', 'pacs.008': 'xml' };
const TRANSPORTS = ['sftp', 'spool'];

const STATUSES = ['built', 'approved', 'transmitted', 'acknowledged', 'settled', 'rejected'];
const TRANSITIONS = {
  built: ['approved', 'rejected'],
  approved: ['transmitted', 'rejected'],
  transmitted: ['acknowledged', 'settled', 'rejected'],
  acknowledged: ['settled', 'rejected'],
  settled: [],
  rejected: [],
};
const IN_FLIGHT = ['transmitted', 'acknowledged'];

class MftError extends Error {
  constructor(message, code = 'MFT_ERROR', status = 409, details = {}) {
    super(message);
    this.name = 'MftError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
    this.details = details;
  }
}

function text(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === null ? fallback : String(value).trim();
}

function intEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function dollars(cents) {
  return `$${(Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function mask(account) {
  const s = String(account || '');
  return s.length <= 4 ? s : `${'*'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`;
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function joinRemote(base, child) {
  if (!child) return base;
  if (child.startsWith('/')) return child;
  return `${String(base).replace(/\/+$/, '')}/${child}`;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function escapeXml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function unescapeXml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function xmlText(block, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`).exec(block || '');
  return m ? unescapeXml(m[1].trim()) : '';
}

function xmlBlock(block, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(block || '');
  return m ? m[1] : '';
}

function moneyToCents(text) {
  const s = String(text || '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

/**
 * Read a pacs.008 back the way the bank will: header count and control sum
 * against the transactions actually carried. Anything that does not add up
 * is a parse failure, not a file.
 */
function parsePacs008(xml) {
  const s = String(xml || '');
  if (!/urn:iso:std:iso:20022:tech:xsd:pacs\.008/.test(s)) throw new MftError('Not a pacs.008 document', 'MFT_BAD_CONTENT', 400);
  const header = xmlBlock(s, 'GrpHdr');
  if (!header) throw new MftError('pacs.008 has no GrpHdr', 'MFT_BAD_CONTENT', 400);
  const transactions = [];
  const re = /<CdtTrfTxInf>([\s\S]*?)<\/CdtTrfTxInf>/g;
  let m;
  while ((m = re.exec(s))) {
    const tx = m[1];
    const amountTag = /<IntrBkSttlmAmt\s+Ccy="([^"]*)"\s*>([^<]*)<\/IntrBkSttlmAmt>/.exec(tx);
    const amountCents = amountTag ? moneyToCents(amountTag[2]) : NaN;
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new MftError('pacs.008 transaction has no positive IntrBkSttlmAmt', 'MFT_BAD_CONTENT', 400);
    transactions.push({
      endToEndId: xmlText(xmlBlock(tx, 'PmtId'), 'EndToEndId'),
      instructionId: xmlText(xmlBlock(tx, 'PmtId'), 'InstrId'),
      currency: amountTag[1],
      amountCents,
      creditorName: xmlText(xmlBlock(tx, 'Cdtr'), 'Nm'),
      creditorAccount: xmlText(xmlBlock(tx, 'CdtrAcct'), 'Id'),
      creditorAgent: xmlText(xmlBlock(tx, 'CdtrAgt'), 'BICFI') || xmlText(xmlBlock(tx, 'CdtrAgt'), 'MmbId'),
    });
  }
  if (!transactions.length) throw new MftError('pacs.008 carries no CdtTrfTxInf', 'MFT_BAD_CONTENT', 400);
  const declaredCount = Number(xmlText(header, 'NbOfTxs'));
  const ctrlSumTag = /<(?:TtlIntrBkSttlmAmt|CtrlSum)(?:\s[^>]*)?>([^<]*)</.exec(header);
  const declaredCents = ctrlSumTag ? moneyToCents(ctrlSumTag[1]) : NaN;
  const totalCents = transactions.reduce((t, x) => t + x.amountCents, 0);
  if (declaredCount !== transactions.length || declaredCents !== totalCents) {
    throw new MftError(
      `pacs.008 header does not match its transactions (count ${declaredCount}/${transactions.length}, total ${declaredCents}/${totalCents})`,
      'MFT_CONTROL_MISMATCH',
      400
    );
  }
  return { messageId: xmlText(header, 'MsgId'), createdAt: xmlText(header, 'CreDtTm'), count: transactions.length, totalCents, currency: transactions[0].currency, transactions };
}

function renderPacs008({ messageId, entries, env, channel }) {
  const ccy = escapeXml(env.currency);
  const total = (entries.reduce((t, e) => t + e.amountCents, 0) / 100).toFixed(2);
  const tx = entries.map(e => `    <CdtTrfTxInf>
      <PmtId>
        <InstrId>${escapeXml(e.instructionId)}</InstrId>
        <EndToEndId>${escapeXml(e.endToEndId)}</EndToEndId>
      </PmtId>
      <IntrBkSttlmAmt Ccy="${ccy}">${(e.amountCents / 100).toFixed(2)}</IntrBkSttlmAmt>
      <ChrgBr>SLEV</ChrgBr>
      <Dbtr><Nm>${escapeXml(env.companyName)}</Nm></Dbtr>
      <DbtrAcct><Id><Othr><Id>${escapeXml(env.debtorAccount)}</Id></Othr></Id></DbtrAcct>
      <DbtrAgt><FinInstnId>${env.originBic ? `<BICFI>${escapeXml(env.originBic)}</BICFI>` : `<ClrSysMmbId><MmbId>${escapeXml(env.odfiRouting)}</MmbId></ClrSysMmbId>`}</FinInstnId></DbtrAgt>
      <CdtrAgt><FinInstnId>${e.bic ? `<BICFI>${escapeXml(e.bic)}</BICFI>` : `<ClrSysMmbId><MmbId>${escapeXml(e.routingNumber)}</MmbId></ClrSysMmbId>`}</FinInstnId></CdtrAgt>
      <Cdtr><Nm>${escapeXml(e.name)}</Nm></Cdtr>
      <CdtrAcct><Id><Othr><Id>${escapeXml(e.accountNumber)}</Id></Othr></Id></CdtrAcct>
      <Purp><Cd>${escapeXml(e.purposeCode)}</Cd></Purp>${e.remittance ? `
      <RmtInf><Ustrd>${escapeXml(e.remittance)}</Ustrd></RmtInf>` : ''}
    </CdtTrfTxInf>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08">
  <FIToFICstmrCdtTrf>
    <GrpHdr>
      <MsgId>${escapeXml(messageId)}</MsgId>
      <CreDtTm>${new Date().toISOString()}</CreDtTm>
      <NbOfTxs>${entries.length}</NbOfTxs>
      <TtlIntrBkSttlmAmt Ccy="${ccy}">${total}</TtlIntrBkSttlmAmt>
      <SttlmInf><SttlmMtd>CLRG</SttlmMtd></SttlmInf>
      <InstgAgt><FinInstnId>${env.originBic ? `<BICFI>${escapeXml(env.originBic)}</BICFI>` : `<ClrSysMmbId><MmbId>${escapeXml(env.odfiRouting)}</MmbId></ClrSysMmbId>`}</FinInstnId></InstgAgt>
      ${channel.bankName ? `<InstdAgt><FinInstnId><Nm>${escapeXml(channel.bankName)}</Nm></FinInstnId></InstdAgt>` : ''}
    </GrpHdr>
${tx}
  </FIToFICstmrCdtTrf>
</Document>
`;
}

/** Which register type a NACHA file another engine rendered belongs under. */
function fileTypeForNacha(parsed) {
  const batches = parsed.batches || [];
  const control = parsed.fileControl || {};
  if (Number(control.totalDebit) > 0) return 'clearing_settlement';
  if (batches.length && batches.every(b => String(b.secCode || '').toUpperCase() === 'PPD')) return 'direct_deposit';
  return 'vendor_payment';
}

/**
 * The trust's default channel, from the environment. Any secret the channel
 * needs is read from the environment at connect time and is never written to
 * the register; the register holds only the name of the variable.
 */
function getMftConfig() {
  const root = text('MFT_REMOTE_ROOT', '/payments');
  return {
    host: text('MFT_SFTP_HOST'),
    port: intEnv('MFT_SFTP_PORT', 22, { min: 1, max: 65535 }),
    username: text('MFT_SFTP_USER'),
    passwordEnv: 'MFT_SFTP_PASSWORD',
    privateKeyEnv: 'MFT_SFTP_PRIVATE_KEY',
    privateKeyPathEnv: 'MFT_SFTP_PRIVATE_KEY_PATH',
    passphraseEnv: 'MFT_SFTP_PASSPHRASE',
    hostKeyFingerprint: text('MFT_SFTP_HOST_KEY_FINGERPRINT'),
    allowUnknownHostKey: boolEnv('MFT_ALLOW_UNKNOWN_HOST_KEY', false),
    connectTimeoutMs: intEnv('MFT_CONNECT_TIMEOUT_MS', 30000, { min: 1000, max: 300000 }),
    spoolDir: path.resolve(text('MFT_SPOOL_DIR', path.join(process.cwd(), 'data', 'mft-spool'))),
    archiveDir: path.resolve(text('MFT_ARCHIVE_DIR', path.join(process.cwd(), 'data', 'mft-archive'))),
    allowSpoolInProduction: boolEnv('MFT_ALLOW_SPOOL_IN_PRODUCTION', false),
    outboundPath: joinRemote(root, text('MFT_OUTBOUND_DIR', 'outbound')),
    ackPath: joinRemote(root, text('MFT_ACK_DIR', 'ack')),
    returnPath: joinRemote(root, text('MFT_RETURN_DIR', 'returns')),
    archivePath: joinRemote(root, text('MFT_ARCHIVE_REMOTE_DIR', 'archive')),
    filePrefix: text('MFT_FILE_PREFIX', 'DLBTRUST'),
    stagingSuffix: text('MFT_STAGING_SUFFIX', '.tmp'),
    replayWindowHours: intEnv('MFT_REPLAY_WINDOW_HOURS', 168, { min: 1, max: 24 * 365 }),
    maxFileCents: intEnv('MFT_MAX_FILE_CENTS', 0),
    requireApproval: boolEnv('MFT_REQUIRE_APPROVAL', true),
    companyName: text('MFT_COMPANY_NAME', ORIGINATOR_NAME),
    companyId: text('MFT_COMPANY_ID', ORIGINATOR_ID),
    odfiRouting: text('MFT_ODFI_ROUTING', ODFI_ROUTING),
    originBic: text('MFT_ORIGIN_BIC'),
    debtorAccount: text('MFT_DEBTOR_ACCOUNT'),
    currency: text('MFT_CURRENCY', 'USD').toUpperCase(),
  };
}

/** Secrets resolve from the environment the moment a session opens, not before. */
function transportConfig(channel) {
  const c = channel.config || {};
  const transport = c.host ? 'sftp' : 'spool';
  return {
    transport,
    host: c.host || '',
    port: c.port || 22,
    username: c.username || '',
    password: c.passwordEnv ? text(c.passwordEnv) : '',
    privateKey: c.privateKeyEnv ? text(c.privateKeyEnv) : '',
    privateKeyPath: c.privateKeyPathEnv ? text(c.privateKeyPathEnv) : '',
    passphrase: c.passphraseEnv ? text(c.passphraseEnv) : '',
    hostKeyFingerprint: c.hostKeyFingerprint || '',
    allowUnknownHostKey: Boolean(c.allowUnknownHostKey),
    connectTimeoutMs: c.connectTimeoutMs || 30000,
    spoolDir: c.spoolDir,
    stagingSuffix: c.stagingSuffix || '.tmp',
    identityId: c.identityId || '',
  };
}

/**
 * The transport settings a session actually opens with. A channel bound to a
 * machine identity authenticates with that identity's key, decrypted from the
 * M2M keyring for the life of the session; no human credential is involved.
 */
async function sessionConfig(channel) {
  const config = transportConfig(channel);
  if (config.identityId && config.transport === 'sftp') {
    const { M2mOsEngine } = require('./m2mOsEngine');
    config.privateKey = await M2mOsEngine.privateKeyFor(config.identityId);
    config.privateKeyPath = '';
    config.password = '';
  }
  return config;
}

function channelReadiness(channel) {
  const c = channel.config || {};
  const blockers = [];
  const transport = c.host ? 'sftp' : 'spool';
  if (channel.status !== 'active') blockers.push(`channel ${channel.channelId} is ${channel.status}`);
  if (transport === 'sftp') {
    if (!c.username) blockers.push('no SFTP username');
    if (!c.hostKeyFingerprint && !c.allowUnknownHostKey) blockers.push('bank host key is not pinned');
    const hasSecret = Boolean(c.identityId) || ['passwordEnv', 'privateKeyEnv', 'privateKeyPathEnv'].some(k => c[k] && text(c[k]));
    if (!hasSecret) blockers.push('no SFTP credential is present in the environment');
  } else if (isProduction() && !c.allowSpoolInProduction) {
    blockers.push('channel has no bank host and spool transmission is not allowed in production');
  }
  return { ready: blockers.length === 0, transport, blockers };
}

function assertTransition(from, to, fileId) {
  if (!(TRANSITIONS[from] || []).includes(to)) {
    throw new MftError(`${fileId} is ${from} and cannot become ${to}`, 'MFT_WRONG_STATE', 409, { from, to });
  }
}

function mapChannel(row) {
  const config = parseJson(row.config, {});
  return {
    channelId: row.channel_id,
    name: row.name,
    bankName: row.bank_name,
    status: row.status,
    fileTypes: parseJson(row.file_types, []),
    config,
    transport: config.host ? 'sftp' : 'spool',
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapFile(row, { withContent = false } = {}) {
  const out = {
    fileId: row.file_id,
    channelId: row.channel_id,
    fileType: row.file_type,
    format: row.format,
    status: row.status,
    filename: row.filename,
    contentHash: row.content_hash,
    sizeBytes: Number(row.size_bytes),
    entryCount: Number(row.entry_count),
    creditCents: Number(row.credit_cents),
    debitCents: Number(row.debit_cents),
    credit: dollars(row.credit_cents),
    debit: dollars(row.debit_cents),
    effectiveDate: row.effective_date,
    entries: parseJson(row.entries, []),
    sourceRef: row.source_ref || null,
    builtBy: row.built_by,
    approvedBy: row.approved_by,
    transport: row.transport,
    remotePath: row.remote_path,
    archivePath: row.archive_path,
    bankReference: row.bank_reference,
    failureReason: row.failure_reason,
    memo: row.memo,
    builtAt: row.built_at,
    approvedAt: row.approved_at,
    transmittedAt: row.transmitted_at,
    acknowledgedAt: row.acknowledged_at,
    settledAt: row.settled_at,
  };
  if (withContent) out.content = row.content;
  return out;
}

/**
 * One entry, validated the way the bank will validate it — before it is
 * allowed anywhere near a file.
 */
function normalizeEntry(raw, spec, index) {
  const where = `entry ${index + 1}`;
  const amountCents = Math.round(Number(raw.amountCents));
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new MftError(`${where}: amountCents must be a positive integer`, 'MFT_BAD_AMOUNT', 400);
  const name = String(raw.name || raw.individualName || raw.creditorName || '').trim();
  if (!name) throw new MftError(`${where}: receiver name is required`, 'MFT_BAD_NAME', 400);
  const direction = raw.direction === 'debit' ? 'debit' : 'credit';
  if (direction === 'debit' && !spec.allowDebits) throw new MftError(`${where}: a ${spec.label.toLowerCase()} file carries credits only`, 'MFT_DEBIT_NOT_ALLOWED', 400);
  const routing = String(raw.routingNumber || raw.receivingRouting || '').replace(/\D/g, '');

  if (spec.format === 'pacs.008') {
    const bic = String(raw.bic || '').trim().toUpperCase();
    if (bic && !/^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(bic)) throw new MftError(`${where}: BIC ${bic} is not 8 or 11 characters`, 'MFT_BAD_BIC', 400);
    if (!bic && !validateRouting(routing)) throw new MftError(`${where}: a wire needs the creditor agent's BIC or a routing number that passes the ABA check digit`, 'MFT_BAD_ROUTING', 400);
    const account = String(raw.accountNumber || raw.iban || '').trim();
    if (!account || account.length > 34) throw new MftError(`${where}: account number must be 1–34 characters`, 'MFT_BAD_ACCOUNT', 400);
    const endToEndId = String(raw.endToEndId || raw.reference || '').trim().slice(0, 35);
    return {
      routingNumber: bic ? '' : routing,
      bic,
      accountNumber: account,
      amountCents,
      name: name.slice(0, 140),
      identifier: String(raw.identifier || '').slice(0, 35),
      direction: 'credit',
      transactionCode: null,
      endToEndId,
      instructionId: String(raw.instructionId || endToEndId || '').slice(0, 35),
      purposeCode: String(raw.purposeCode || 'OTHR').toUpperCase().slice(0, 4),
      remittance: String(raw.remittance || raw.memo || '').slice(0, 140),
      reference: raw.reference || endToEndId || null,
    };
  }

  if (!validateRouting(routing)) throw new MftError(`${where}: routing number ${routing || '(blank)'} fails the ABA check digit`, 'MFT_BAD_ROUTING', 400);
  const account = String(raw.accountNumber || '').trim();
  if (!account || account.length > 17) throw new MftError(`${where}: account number must be 1–17 characters`, 'MFT_BAD_ACCOUNT', 400);
  if (amountCents > 9999999999) throw new MftError(`${where}: ${dollars(amountCents)} exceeds the NACHA entry limit`, 'MFT_BAD_AMOUNT', 400);
  const savings = raw.accountType === 'savings';
  const transactionCode = direction === 'debit' ? (savings ? '37' : '27') : (savings ? '32' : '22');
  return {
    routingNumber: routing,
    accountNumber: account,
    amountCents,
    name: name.slice(0, 22),
    identifier: String(raw.identifier || raw.individualId || '').slice(0, 15),
    direction,
    transactionCode,
    reference: raw.reference || null,
  };
}

const MftOsEngine = {
  FILE_TYPES,
  STATUSES,
  TRANSITIONS,
  MftError,
  config: getMftConfig,

  async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mft_channels (
        channel_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        bank_name TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        file_types JSONB NOT NULL DEFAULT '[]'::jsonb,
        config JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mft_files (
        file_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        file_type TEXT NOT NULL,
        format TEXT NOT NULL,
        status TEXT NOT NULL,
        filename TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        entry_count INTEGER NOT NULL,
        credit_cents BIGINT NOT NULL,
        debit_cents BIGINT NOT NULL,
        effective_date TEXT,
        entries JSONB NOT NULL DEFAULT '[]'::jsonb,
        built_by TEXT,
        approved_by TEXT,
        transport TEXT,
        remote_path TEXT,
        archive_path TEXT,
        bank_reference TEXT,
        failure_reason TEXT,
        memo TEXT,
        built_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        approved_at TIMESTAMPTZ,
        transmitted_at TIMESTAMPTZ,
        acknowledged_at TIMESTAMPTZ,
        settled_at TIMESTAMPTZ
      )`);
    await pool.query('ALTER TABLE mft_files ADD COLUMN IF NOT EXISTS source_ref TEXT');
    await pool.query('CREATE INDEX IF NOT EXISTS mft_files_channel_hash_idx ON mft_files (channel_id, content_hash)');
    await pool.query('CREATE INDEX IF NOT EXISTS mft_files_source_ref_idx ON mft_files (source_ref)');
    await pool.query('CREATE INDEX IF NOT EXISTS mft_files_status_idx ON mft_files (status)');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mft_events (
        event_id TEXT PRIMARY KEY,
        file_id TEXT,
        channel_id TEXT,
        event_type TEXT NOT NULL,
        actor TEXT,
        detail JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await this._ensureDefaultChannel();
  },

  /** The environment channel exists as a row so every file names a channel. */
  async _ensureDefaultChannel() {
    const existing = await pool.query('SELECT * FROM mft_channels WHERE channel_id = $1', ['default']);
    if (existing.rows.length) return mapChannel(existing.rows[0]);
    const env = getMftConfig();
    const config = {
      host: env.host,
      port: env.port,
      username: env.username,
      passwordEnv: env.passwordEnv,
      privateKeyEnv: env.privateKeyEnv,
      privateKeyPathEnv: env.privateKeyPathEnv,
      passphraseEnv: env.passphraseEnv,
      hostKeyFingerprint: env.hostKeyFingerprint,
      allowUnknownHostKey: env.allowUnknownHostKey,
      allowSpoolInProduction: env.allowSpoolInProduction,
      connectTimeoutMs: env.connectTimeoutMs,
      outboundPath: env.outboundPath,
      ackPath: env.ackPath,
      returnPath: env.returnPath,
      archivePath: env.archivePath,
      filePrefix: env.filePrefix,
      stagingSuffix: env.stagingSuffix,
    };
    return this.registerChannel({
      channelId: 'default',
      name: 'Trust bank file channel',
      bankName: text('MFT_BANK_NAME', 'Originating bank'),
      fileTypes: Object.keys(FILE_TYPES),
      config,
      createdBy: 'system',
    });
  },

  // ── Channels ─────────────────────────────────────────────────────────────

  async registerChannel({ channelId = null, name, bankName = null, fileTypes = Object.keys(FILE_TYPES), config = {}, createdBy = null } = {}) {
    if (!name) throw new MftError('A channel needs a name', 'MFT_BAD_CHANNEL', 400);
    const bad = fileTypes.filter(t => !FILE_TYPES[t]);
    if (bad.length) throw new MftError(`Unknown file types: ${bad.join(', ')}`, 'MFT_BAD_CHANNEL', 400);
    const secretLike = ['password', 'privateKey', 'passphrase'].filter(k => config[k]);
    if (secretLike.length) {
      throw new MftError(
        `A channel stores the name of the environment variable holding a secret, never the secret itself (${secretLike.join(', ')})`,
        'MFT_SECRET_IN_CONFIG',
        400
      );
    }
    const env = getMftConfig();
    const stored = {
      host: config.host || '',
      port: Number(config.port) || 22,
      username: config.username || '',
      passwordEnv: config.passwordEnv || '',
      privateKeyEnv: config.privateKeyEnv || '',
      privateKeyPathEnv: config.privateKeyPathEnv || '',
      passphraseEnv: config.passphraseEnv || '',
      hostKeyFingerprint: config.hostKeyFingerprint || '',
      allowUnknownHostKey: Boolean(config.allowUnknownHostKey),
      allowSpoolInProduction: Boolean(config.allowSpoolInProduction),
      connectTimeoutMs: Number(config.connectTimeoutMs) || env.connectTimeoutMs,
      spoolDir: config.spoolDir || path.join(env.spoolDir, channelId || 'channel'),
      outboundPath: config.outboundPath || env.outboundPath,
      ackPath: config.ackPath || env.ackPath,
      returnPath: config.returnPath || env.returnPath,
      archivePath: config.archivePath || env.archivePath,
      filePrefix: (config.filePrefix || env.filePrefix).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16) || 'DLBTRUST',
      stagingSuffix: config.stagingSuffix || env.stagingSuffix,
      identityId: config.identityId || '',
      signManifests: Boolean(config.signManifests),
    };
    const id = channelId || newId('MFTCH');
    const { rows } = await pool.query(
      `INSERT INTO mft_channels (channel_id, name, bank_name, status, file_types, config, created_by)
       VALUES ($1, $2, $3, 'active', $4::jsonb, $5::jsonb, $6) RETURNING *`,
      [id, name, bankName, JSON.stringify(fileTypes), JSON.stringify(stored), createdBy]
    );
    await this._event(null, id, 'channel_registered', createdBy, { transport: stored.host ? 'sftp' : 'spool', identityId: stored.identityId || null });
    return mapChannel(rows[0]);
  },

  /** Re-bind a channel to a machine identity (key rotation); nothing else about the channel changes. */
  async bindIdentity(channelId, identityId, actor, { signManifests = null } = {}) {
    const channel = await this.channel(channelId);
    const config = { ...channel.config, identityId: identityId || '' };
    if (signManifests !== null) config.signManifests = Boolean(signManifests);
    await pool.query('UPDATE mft_channels SET config = $2::jsonb WHERE channel_id = $1', [channelId, JSON.stringify(config)]);
    await this._event(null, channelId, 'channel_identity_bound', actor, { identityId: identityId || null, previous: channel.config.identityId || null });
    return this.channel(channelId);
  },

  async channels() {
    const { rows } = await pool.query('SELECT * FROM mft_channels ORDER BY created_at');
    return rows.map(mapChannel).map(c => ({ ...c, readiness: channelReadiness(c) }));
  },

  async channel(channelId) {
    const { rows } = await pool.query('SELECT * FROM mft_channels WHERE channel_id = $1', [channelId]);
    if (!rows.length) throw new MftError(`Channel ${channelId} is not registered`, 'MFT_NO_CHANNEL', 404);
    const c = mapChannel(rows[0]);
    return { ...c, readiness: channelReadiness(c) };
  },

  /**
   * A channel's live transport settings and directory layout, for an engine
   * that reads the bank's own advice files off the same host. Secrets are
   * resolved here and go no further than the session that uses them.
   */
  async transportFor(channelId) {
    const channel = await this.channel(channelId);
    return {
      ...(await sessionConfig(channel)),
      outboundPath: channel.config.outboundPath,
      ackPath: channel.config.ackPath,
      returnPath: channel.config.returnPath,
      archivePath: channel.config.archivePath,
      readiness: channel.readiness,
    };
  },

  async setChannelStatus(channelId, status, actor) {
    if (!['active', 'suspended'].includes(status)) throw new MftError('status must be active or suspended', 'MFT_BAD_CHANNEL', 400);
    await this.channel(channelId);
    await pool.query('UPDATE mft_channels SET status = $2 WHERE channel_id = $1', [channelId, status]);
    await this._event(null, channelId, `channel_${status}`, actor, {});
    return this.channel(channelId);
  },

  // ── Build ────────────────────────────────────────────────────────────────

  /**
   * Render a file and write it to the register. Nothing is sent. The render
   * is parsed back and its control totals compared to the entries handed in,
   * so the stored totals are the file's own, not what the caller believed.
   */
  async build({ channelId = 'default', fileType, entries = [], effectiveDate = null, memo = null, builtBy = null, entryDescription = null } = {}) {
    const spec = FILE_TYPES[fileType];
    if (!spec) throw new MftError(`Unknown file type ${fileType}; one of ${Object.keys(FILE_TYPES).join(', ')}`, 'MFT_BAD_FILE_TYPE', 400);
    if (!Array.isArray(entries) || !entries.length) throw new MftError('A payment file needs at least one entry', 'MFT_EMPTY', 400);
    if (!builtBy) throw new MftError('builtBy is required: every file names who built it', 'MFT_NO_ACTOR', 400);

    const channel = await this.channel(channelId);
    if (!channel.fileTypes.includes(fileType)) {
      throw new MftError(`Channel ${channelId} does not carry ${spec.label.toLowerCase()} files`, 'MFT_TYPE_NOT_CARRIED', 409);
    }

    const normalized = entries.map((e, i) => normalizeEntry(e, spec, i));
    const creditCents = normalized.filter(e => e.direction === 'credit').reduce((s, e) => s + e.amountCents, 0);
    const debitCents = normalized.filter(e => e.direction === 'debit').reduce((s, e) => s + e.amountCents, 0);
    const env = getMftConfig();
    if (env.maxFileCents > 0 && creditCents + debitCents > env.maxFileCents) {
      throw new MftError(`File total ${dollars(creditCents + debitCents)} exceeds the channel ceiling ${dollars(env.maxFileCents)}`, 'MFT_OVER_CEILING', 409);
    }

    const effective = effectiveDate ? new Date(effectiveDate) : new Date(Date.now() + 86400000);
    if (Number.isNaN(effective.getTime())) throw new MftError('effectiveDate is not a date', 'MFT_BAD_DATE', 400);

    const fileId = newId('MFT');
    let content;
    if (spec.format === 'pacs.008') {
      if (!env.debtorAccount) throw new MftError('MFT_DEBTOR_ACCOUNT is unset: a wire file must name the account it draws on', 'MFT_NOT_CONFIGURED', 412);
      normalized.forEach((e, i) => {
        if (!e.endToEndId) e.endToEndId = `${fileId}-${String(i + 1).padStart(4, '0')}`;
        if (!e.instructionId) e.instructionId = e.endToEndId;
        if (!e.reference) e.reference = e.endToEndId;
      });
      content = renderPacs008({ messageId: fileId, entries: normalized, env, channel });
      const parsed = parsePacs008(content);
      if (parsed.count !== normalized.length || parsed.totalCents !== creditCents) {
        throw new MftError(`Rendered pacs.008 does not match its entries (count ${parsed.count}/${normalized.length}, total ${parsed.totalCents}/${creditCents})`, 'MFT_CONTROL_MISMATCH', 500);
      }
    } else {
      let serviceClass = spec.serviceClassCode;
      if (spec.allowDebits) serviceClass = creditCents && debitCents ? '200' : debitCents ? '225' : '220';
      content = generateNACHAFile(
        { immediateDestination: env.odfiRouting, immediateOrigin: env.companyId, immediateDestinationName: channel.bankName || undefined, immediateOriginName: env.companyName },
        [{
          secCode: spec.secCode,
          serviceClassCode: serviceClass,
          companyEntryDescription: (entryDescription || spec.entryDescription).slice(0, 10),
          effectiveEntryDate: effective,
          companyName: env.companyName,
          companyId: env.companyId,
          entries: normalized.map(e => ({
            receivingRouting: e.routingNumber,
            accountNumber: e.accountNumber,
            amountCents: e.amountCents,
            transactionCode: e.transactionCode,
            individualId: e.identifier,
            individualName: e.name,
          })),
        }]
      );
      const control = parseNACHAFile(content).fileControl || {};
      if (Number(control.entryCount) !== normalized.length || Number(control.totalCredit) !== creditCents || Number(control.totalDebit) !== debitCents) {
        throw new MftError(
          `Rendered file control totals do not match its entries (entries ${control.entryCount}/${normalized.length}, credit ${control.totalCredit}/${creditCents}, debit ${control.totalDebit}/${debitCents})`,
          'MFT_CONTROL_MISMATCH',
          500
        );
      }
    }

    const publicEntries = normalized.map(e => ({
      name: e.name,
      identifier: e.identifier,
      routingNumber: e.routingNumber,
      bic: e.bic || undefined,
      account: mask(e.accountNumber),
      amountCents: e.amountCents,
      direction: e.direction,
      reference: e.reference,
    }));

    return this._register({
      fileId, channel, fileType, format: spec.format, content, filename: null, sourceRef: null,
      entryCount: normalized.length, creditCents, debitCents, effectiveDate: effective.toISOString().slice(0, 10),
      entries: publicEntries, builtBy, approvedBy: null, memo,
    });
  },

  /**
   * Register a file another engine rendered. The bytes are parsed back and
   * the register's totals are the file's own. `sourceRef` names the caller's
   * record (`ach:<batchId>`, `wire:<paymentId>`): the same source with the
   * same bytes returns the file already registered, so a retry upstream is a
   * replay here rather than a second file. Dual control the caller already
   * ran carries over through `approvedBy`, under the same rule as `approve`.
   */
  async ingest({ channelId = 'default', fileType = null, format = 'nacha', content, filename = null, sourceRef = null, builtBy = null, approvedBy = null, memo = null } = {}) {
    if (!content || typeof content !== 'string') throw new MftError('ingest needs the rendered file content', 'MFT_EMPTY', 400);
    if (!FORMATS.includes(format)) throw new MftError(`Unknown format ${format}; one of ${FORMATS.join(', ')}`, 'MFT_BAD_FORMAT', 400);
    if (!builtBy) throw new MftError('builtBy is required: every file names who built it', 'MFT_NO_ACTOR', 400);

    let entryCount, creditCents, debitCents, effective = null, entries;
    if (format === 'pacs.008') {
      const parsed = parsePacs008(content);
      fileType = fileType || 'wire_payment';
      entryCount = parsed.count;
      creditCents = parsed.totalCents;
      debitCents = 0;
      entries = parsed.transactions.map(t => ({
        name: t.creditorName, identifier: t.instructionId, routingNumber: /^\d{9}$/.test(t.creditorAgent) ? t.creditorAgent : '', bic: /^\d{9}$/.test(t.creditorAgent) ? undefined : t.creditorAgent || undefined,
        account: mask(t.creditorAccount), amountCents: t.amountCents, direction: 'credit', reference: t.endToEndId || null,
      }));
    } else {
      let parsed;
      try { parsed = parseNACHAFile(content); } catch (e) { throw new MftError(`Content is not a NACHA file: ${e.message}`, 'MFT_BAD_CONTENT', 400); }
      const control = parsed.fileControl;
      if (!control) throw new MftError('NACHA file has no file control record', 'MFT_BAD_CONTENT', 400);
      const seen = (parsed.batches || []).flatMap(b => b.entries || []);
      entryCount = Number(control.entryCount);
      creditCents = Number(control.totalCredit);
      debitCents = Number(control.totalDebit);
      const sumCredit = seen.filter(e => /^(2[123]|3[123])$/.test(e.transactionCode)).reduce((s, e) => s + Number(e.amountCents || e.amount || 0), 0);
      const sumDebit = seen.filter(e => /^(2[789]|3[789])$/.test(e.transactionCode)).reduce((s, e) => s + Number(e.amountCents || e.amount || 0), 0);
      if (seen.length !== entryCount || sumCredit !== creditCents || sumDebit !== debitCents) {
        throw new MftError(
          `NACHA control totals do not match the entries carried (entries ${entryCount}/${seen.length}, credit ${creditCents}/${sumCredit}, debit ${debitCents}/${sumDebit})`,
          'MFT_CONTROL_MISMATCH',
          400
        );
      }
      fileType = fileType || fileTypeForNacha(parsed);
      const b0 = (parsed.batches || [])[0];
      if (b0 && /^\d{6}$/.test(b0.effectiveDate)) effective = `20${b0.effectiveDate.slice(0, 2)}-${b0.effectiveDate.slice(2, 4)}-${b0.effectiveDate.slice(4, 6)}`;
      entries = seen.map(e => ({
        name: e.individualName || e.receiverName || '', identifier: e.individualId || '', routingNumber: e.receivingRouting || e.routingNumber || '',
        account: mask(e.accountNumber), amountCents: Number(e.amountCents || e.amount || 0), direction: /^(2[789]|3[789])$/.test(e.transactionCode) ? 'debit' : 'credit', reference: e.traceNumber || null,
      }));
    }

    const spec = FILE_TYPES[fileType];
    if (!spec) throw new MftError(`Unknown file type ${fileType}`, 'MFT_BAD_FILE_TYPE', 400);
    if (spec.format !== format) throw new MftError(`${spec.label} files are ${spec.format}, not ${format}`, 'MFT_BAD_FORMAT', 400);
    if (debitCents > 0 && !spec.allowDebits) throw new MftError(`A ${spec.label.toLowerCase()} file carries credits only`, 'MFT_DEBIT_NOT_ALLOWED', 400);

    const channel = await this.channel(channelId);
    if (!channel.fileTypes.includes(fileType)) throw new MftError(`Channel ${channelId} does not carry ${spec.label.toLowerCase()} files`, 'MFT_TYPE_NOT_CARRIED', 409);
    const env = getMftConfig();
    if (env.maxFileCents > 0 && creditCents + debitCents > env.maxFileCents) {
      throw new MftError(`File total ${dollars(creditCents + debitCents)} exceeds the channel ceiling ${dollars(env.maxFileCents)}`, 'MFT_OVER_CEILING', 409);
    }

    const contentHash = sha256(content);
    if (sourceRef) {
      const { rows } = await pool.query(
        `SELECT * FROM mft_files WHERE channel_id = $1 AND source_ref = $2 AND status <> 'rejected' ORDER BY built_at DESC LIMIT 1`,
        [channelId, sourceRef]
      );
      if (rows.length) {
        if (rows[0].content_hash !== contentHash) {
          throw new MftError(
            `${sourceRef} is already registered as ${rows[0].file_id} with different bytes; reject that file before registering another for the same source`,
            'MFT_SOURCE_CONFLICT',
            409,
            { fileId: rows[0].file_id }
          );
        }
        return { file: mapFile(rows[0]), reused: true, duplicateOf: null, readiness: channel.readiness };
      }
    }

    if (approvedBy && String(approvedBy).toLowerCase() === String(builtBy).toLowerCase()) {
      throw new MftError(`${approvedBy} built this file and cannot also release it`, 'MFT_FOUR_EYES', 403);
    }

    const out = await this._register({
      fileId: newId('MFT'), channel, fileType, format, content, filename, sourceRef,
      entryCount, creditCents, debitCents, effectiveDate: effective, entries, builtBy, approvedBy, memo,
    });
    return { ...out, reused: false };
  },

  /**
   * Ingest and transmit in one call — the path the rails take. Exactly the
   * same controls as the two steps apart; nothing is skipped because the
   * caller is another engine.
   */
  async deliver({ actor = null, force = false, ...ingestArgs } = {}) {
    const registered = await this.ingest(ingestArgs);
    const sent = await this.transmit(registered.file.fileId, { actor: actor || ingestArgs.approvedBy || ingestArgs.builtBy, force });
    return { ...sent, reused: registered.reused, readiness: registered.readiness };
  },

  async _register({ fileId, channel, fileType, format, content, filename, sourceRef, entryCount, creditCents, debitCents, effectiveDate, entries, builtBy, approvedBy, memo }) {
    const contentHash = sha256(content);
    const ext = EXTENSIONS[format];
    const safeName = filename ? String(filename).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) : '';
    const name = safeName || `${channel.config.filePrefix}_${fileType.toUpperCase()}_${stamp()}_${fileId.split('-').pop()}.${ext}`;
    const status = approvedBy ? 'approved' : 'built';
    const { rows } = await pool.query(
      `INSERT INTO mft_files (file_id, channel_id, file_type, format, status, filename, content, content_hash, size_bytes,
                              entry_count, credit_cents, debit_cents, effective_date, entries, built_by, approved_by, approved_at, transport, memo, source_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, ${approvedBy ? 'NOW()' : 'NULL'}, $17, $18, $19) RETURNING *`,
      [fileId, channel.channelId, fileType, format, status, name, content, contentHash, Buffer.byteLength(content, 'utf8'),
        entryCount, creditCents, debitCents, effectiveDate, JSON.stringify(entries), builtBy, approvedBy, channel.readiness.transport, memo, sourceRef]
    );
    await this._event(fileId, channel.channelId, 'built', builtBy, { entryCount, creditCents, debitCents, contentHash, format, sourceRef });
    if (approvedBy) await this._event(fileId, channel.channelId, 'approved', approvedBy, { creditCents, debitCents, carriedFrom: sourceRef });

    const duplicate = await this._duplicateOf(channel.channelId, contentHash, fileId);
    return { file: mapFile(rows[0]), duplicateOf: duplicate ? duplicate.file_id : null, readiness: channel.readiness };
  },

  // ── Release ──────────────────────────────────────────────────────────────

  async approve(fileId, approvedBy) {
    if (!approvedBy) throw new MftError('approvedBy is required', 'MFT_NO_ACTOR', 400);
    const row = await this._require(fileId);
    assertTransition(row.status, 'approved', fileId);
    if (String(row.built_by).toLowerCase() === String(approvedBy).toLowerCase()) {
      throw new MftError(`${approvedBy} built ${fileId} and cannot also release it`, 'MFT_FOUR_EYES', 403);
    }
    return this._update(fileId, { status: 'approved', approved_by: approvedBy, approved_at: 'NOW()' }, 'approved', approvedBy, {
      creditCents: Number(row.credit_cents), debitCents: Number(row.debit_cents),
    });
  },

  async reject(fileId, actor, reason = null) {
    const row = await this._require(fileId);
    assertTransition(row.status, 'rejected', fileId);
    const detail = { reason: reason || (IN_FLIGHT.includes(row.status) ? 'bank rejected the file' : 'withdrawn before transmission') };
    return this._update(fileId, { status: 'rejected', failure_reason: detail.reason }, 'rejected', actor, detail);
  },

  // ── Transmit ─────────────────────────────────────────────────────────────

  /**
   * Put the file on the bank host. Exactly once: a file that is already
   * transmitted returns its transmission and writes nothing, and a file whose
   * bytes were already transmitted under another id on this channel inside
   * the replay window is refused.
   */
  async transmit(fileId, { actor = null, force = false } = {}) {
    const row = await this._require(fileId);
    if (row.status === 'transmitted' || row.status === 'acknowledged' || row.status === 'settled') {
      return { transmitted: false, replay: true, file: mapFile(row) };
    }
    const env = getMftConfig();
    if (row.status === 'built' && !env.requireApproval) {
      await this._update(fileId, { status: 'approved', approved_by: 'policy:no-approval', approved_at: 'NOW()' }, 'approved', actor, { policy: 'MFT_REQUIRE_APPROVAL=false' });
      row.status = 'approved';
    }
    assertTransition(row.status, 'transmitted', fileId);

    const channel = await this.channel(row.channel_id);
    if (!channel.readiness.ready) {
      throw new MftError(
        `Channel ${channel.channelId} cannot transmit: ${channel.readiness.blockers.join('; ')}`,
        'MFT_CHANNEL_NOT_READY',
        412,
        { blockers: channel.readiness.blockers }
      );
    }

    const duplicate = await this._duplicateOf(row.channel_id, row.content_hash, fileId);
    if (duplicate && !force) {
      throw new MftError(
        `${fileId} is byte-identical to ${duplicate.file_id}, transmitted ${duplicate.transmitted_at}; refused as a duplicate. Pass force=true only if the bank has confirmed the first file was not processed.`,
        'MFT_DUPLICATE',
        409,
        { duplicateOf: duplicate.file_id }
      );
    }

    const archivePath = await this._archive(channel, row);
    let remotePath;
    let manifestPath = null;
    const session = await wireTransport.openWireTransport(await sessionConfig(channel));
    try {
      if (await session.exists(`${channel.config.outboundPath}/${row.filename}`)) {
        throw new MftError(`${row.filename} already exists on the bank host; refusing to overwrite`, 'MFT_REMOTE_EXISTS', 409);
      }
      remotePath = await session.put(channel.config.outboundPath, row.filename, row.content);
      if (channel.config.identityId && channel.config.signManifests) {
        const { M2mOsEngine } = require('./m2mOsEngine');
        manifestPath = await M2mOsEngine.putManifest(session, channel, mapFile(row), remotePath);
      }
    } catch (error) {
      await this._event(fileId, row.channel_id, 'transmit_failed', actor, { error: error.message });
      if (error instanceof MftError) throw error;
      throw new MftError(`Transmission of ${fileId} failed before the bank received it: ${error.message}`, 'MFT_TRANSPORT', 502);
    } finally {
      await session.close();
    }

    const file = await this._update(fileId, {
      status: 'transmitted',
      transmitted_at: 'NOW()',
      transport: channel.readiness.transport,
      remote_path: remotePath,
      archive_path: archivePath,
    }, 'transmitted', actor, { remotePath, manifestPath, transport: channel.readiness.transport, contentHash: row.content_hash, forced: Boolean(force && duplicate), identityId: channel.config.identityId || null });
    return { transmitted: true, replay: false, file, manifestPath };
  },

  /** A byte-for-byte copy under its hash, so what was sent can always be re-read. */
  async _archive(channel, row) {
    const env = getMftConfig();
    const dir = path.join(env.archiveDir, channel.channelId);
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${row.content_hash}.${EXTENSIONS[row.format] || 'dat'}`);
    await fsp.writeFile(target, row.content, 'utf8');
    return target;
  },

  // ── Bank responses ───────────────────────────────────────────────────────

  /**
   * Read the channel's ack and return directories and apply what the bank
   * said. An acknowledgement is matched to a file by name — `<filename>.ack`
   * or `<filename>.rej` — and its first line is kept as the bank's reference.
   * A NACHA return file is parsed and matched to transmitted files by the
   * trace numbers it carries. Every processed response is moved to the
   * channel's archive directory so it is read exactly once.
   */
  async collect(channelId = 'default', { actor = null } = {}) {
    const channel = await this.channel(channelId);
    if (!channel.readiness.ready) {
      throw new MftError(`Channel ${channelId} cannot be read: ${channel.readiness.blockers.join('; ')}`, 'MFT_CHANNEL_NOT_READY', 412);
    }
    const results = { channelId, acknowledged: [], rejected: [], returns: [], ignored: [] };
    const session = await wireTransport.openWireTransport(await sessionConfig(channel));
    try {
      for (const entry of await session.list(channel.config.ackPath)) {
        const m = /^(.+)\.(ack|rej)$/i.exec(entry.name);
        if (!m) { results.ignored.push(entry.name); continue; }
        const found = await pool.query('SELECT * FROM mft_files WHERE channel_id = $1 AND filename = $2', [channelId, m[1]]);
        if (!found.rows.length) { results.ignored.push(entry.name); continue; }
        const row = found.rows[0];
        const body = await session.read(`${channel.config.ackPath}/${entry.name}`);
        const reference = String(body || '').split(/\r?\n/)[0].trim().slice(0, 64) || null;
        if (m[2].toLowerCase() === 'ack') {
          if (TRANSITIONS[row.status].includes('acknowledged')) {
            await this._update(row.file_id, { status: 'acknowledged', acknowledged_at: 'NOW()', bank_reference: reference }, 'acknowledged', actor, { ackFile: entry.name, reference });
            results.acknowledged.push(row.file_id);
          } else results.ignored.push(entry.name);
        } else if (TRANSITIONS[row.status].includes('rejected')) {
          await this._update(row.file_id, { status: 'rejected', failure_reason: reference || 'bank rejected the file', bank_reference: reference }, 'rejected', actor, { rejectFile: entry.name, reference });
          results.rejected.push(row.file_id);
        } else results.ignored.push(entry.name);
        await session.move(`${channel.config.ackPath}/${entry.name}`, channel.config.archivePath, entry.name);
      }

      for (const entry of await session.list(channel.config.returnPath)) {
        const body = await session.read(`${channel.config.returnPath}/${entry.name}`);
        let parsed;
        try { parsed = parseNACHAFile(body); } catch (e) { results.ignored.push(entry.name); continue; }
        const returned = [];
        for (const batch of parsed.batches || []) {
          for (const e of batch.entries || []) returned.push({ traceNumber: e.traceNumber, amountCents: e.amountCents, transactionCode: e.transactionCode, returnFile: entry.name });
        }
        await this._event(null, channelId, 'returns_received', actor, { returnFile: entry.name, entries: returned });
        results.returns.push({ file: entry.name, entries: returned });
        await session.move(`${channel.config.returnPath}/${entry.name}`, channel.config.archivePath, entry.name);
      }
    } finally {
      await session.close();
    }
    return results;
  },

  /**
   * The bank confirmed value moved. Needs the bank's reference: a register
   * that settles on the strength of a file we wrote ourselves is a register
   * that will one day claim money the bank never sent.
   */
  async settle(fileId, { actor = null, bankReference = null } = {}) {
    const reference = String(bankReference || '').trim();
    if (!reference) throw new MftError(`Settling ${fileId} requires the bank's own reference`, 'MFT_NO_EVIDENCE', 400);
    const row = await this._require(fileId);
    assertTransition(row.status, 'settled', fileId);
    return this._update(fileId, { status: 'settled', settled_at: 'NOW()', bank_reference: reference }, 'settled', actor, { reference });
  },

  // ── Reads ────────────────────────────────────────────────────────────────

  async get(fileId, { withContent = false } = {}) {
    return mapFile(await this._require(fileId), { withContent });
  },

  async verify(fileId) {
    const row = await this._require(fileId);
    const recomputed = sha256(row.content);
    let archiveMatches = null;
    if (row.archive_path) {
      try { archiveMatches = sha256(await fsp.readFile(row.archive_path, 'utf8')) === row.content_hash; } catch { archiveMatches = false; }
    }
    return { fileId, contentHash: row.content_hash, intact: recomputed === row.content_hash, archiveMatches };
  },

  async list({ channelId = null, fileType = null, status = null, sourceRef = null, limit = 50 } = {}) {
    const where = [];
    const params = [];
    if (channelId) { params.push(channelId); where.push(`channel_id = $${params.length}`); }
    if (sourceRef) { params.push(sourceRef); where.push(`source_ref = $${params.length}`); }
    if (fileType) { params.push(fileType); where.push(`file_type = $${params.length}`); }
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    params.push(Math.min(Math.max(Number(limit) || 50, 1), 500));
    const { rows } = await pool.query(
      `SELECT * FROM mft_files ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY built_at DESC LIMIT $${params.length}`,
      params
    );
    return rows.map(r => mapFile(r));
  },

  async events(fileId) {
    const { rows } = await pool.query('SELECT * FROM mft_events WHERE file_id = $1 ORDER BY created_at', [fileId]);
    return rows.map(r => ({ eventId: r.event_id, eventType: r.event_type, actor: r.actor, detail: parseJson(r.detail, {}), createdAt: r.created_at }));
  },

  async status() {
    const channels = await this.channels();
    const { rows } = await pool.query(
      `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(credit_cents), 0)::bigint AS credit_cents, COALESCE(SUM(debit_cents), 0)::bigint AS debit_cents
       FROM mft_files GROUP BY status`
    );
    const byStatus = {};
    for (const s of STATUSES) byStatus[s] = { count: 0, creditCents: 0, debitCents: 0 };
    for (const r of rows) byStatus[r.status] = { count: Number(r.count), creditCents: Number(r.credit_cents), debitCents: Number(r.debit_cents) };
    const inFlight = IN_FLIGHT.reduce((s, k) => s + byStatus[k].creditCents + byStatus[k].debitCents, 0);
    return {
      engine: 'mft-os',
      fileTypes: Object.fromEntries(Object.entries(FILE_TYPES).map(([k, v]) => [k, { label: v.label, format: v.format, secCode: v.secCode, allowDebits: v.allowDebits }])),
      formats: FORMATS,
      transports: TRANSPORTS,
      channels: channels.map(c => ({ channelId: c.channelId, name: c.name, bankName: c.bankName, status: c.status, transport: c.transport, readiness: c.readiness })),
      files: byStatus,
      inFlightCents: inFlight,
      inFlight: dollars(inFlight),
      policy: {
        requireApproval: getMftConfig().requireApproval,
        replayWindowHours: getMftConfig().replayWindowHours,
        maxFileCents: getMftConfig().maxFileCents,
        production: isProduction(),
      },
    };
  },

  // ── Internals ────────────────────────────────────────────────────────────

  async _duplicateOf(channelId, contentHash, exceptFileId) {
    const hours = getMftConfig().replayWindowHours;
    const { rows } = await pool.query(
      `SELECT file_id, transmitted_at FROM mft_files
       WHERE channel_id = $1 AND content_hash = $2 AND file_id <> $3
         AND status IN ('transmitted', 'acknowledged', 'settled')
         AND transmitted_at > NOW() - ($4 || ' hours')::interval
       ORDER BY transmitted_at DESC LIMIT 1`,
      [channelId, contentHash, exceptFileId, String(hours)]
    );
    return rows[0] || null;
  },

  async _require(fileId) {
    const { rows } = await pool.query('SELECT * FROM mft_files WHERE file_id = $1', [fileId]);
    if (!rows.length) throw new MftError(`File ${fileId} is not in the register`, 'MFT_NOT_FOUND', 404);
    return rows[0];
  },

  async _update(fileId, fields, eventType, actor, detail = {}) {
    const sets = [];
    const params = [fileId];
    for (const [k, v] of Object.entries(fields)) {
      if (v === 'NOW()') sets.push(`${k} = NOW()`);
      else { params.push(v); sets.push(`${k} = $${params.length}`); }
    }
    const { rows } = await pool.query(`UPDATE mft_files SET ${sets.join(', ')} WHERE file_id = $1 RETURNING *`, params);
    if (!rows.length) throw new MftError(`File ${fileId} is not in the register`, 'MFT_NOT_FOUND', 404);
    await this._event(fileId, rows[0].channel_id, eventType, actor, detail);
    return mapFile(rows[0]);
  },

  async _event(fileId, channelId, eventType, actor, detail) {
    await pool.query(
      'INSERT INTO mft_events (event_id, file_id, channel_id, event_type, actor, detail) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
      [newId('MFTEV'), fileId, channelId, eventType, actor, JSON.stringify(detail || {})]
    );
  },
};

module.exports = { MftOsEngine, MftError, FILE_TYPES, FORMATS, STATUSES, TRANSITIONS, getMftConfig, channelReadiness, sessionConfig, normalizeEntry, parsePacs008, fileTypeForNacha, mask };
