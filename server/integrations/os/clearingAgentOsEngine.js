'use strict';

/**
 * Clearing Agent OS
 *
 * Backend-to-backend clearing agent for the trust's private Electronic
 * Payment Networks (USA only). It
 *
 *   1. keeps a registry of PPN endpoints (network_id, base URL, format) whose
 *      credentials are held ONLY as Secret Manager / runtime env references
 *      (`credential_ref`). The secret value is read at call time, used for an
 *      HMAC, and never persisted, logged or returned;
 *   2. verifies each endpoint through a challenge/verify handshake: the agent
 *      signs a nonce with the shared credential, the network must echo it back
 *      signed with the same credential (mutual proof of possession) before the
 *      endpoint may carry any instruction. Registration and verification must
 *      be done by two distinct trustees (maker/checker);
 *   3. converts one canonical USD instruction into the format each network
 *      consumes — NACHA (PPD/CCD), ISO 20022 pain.001 / pacs.008 XML,
 *      FedNow / RTP credit-transfer JSON, BAI2 posting record — and validates
 *      US routing numbers (ABA check digit) on both legs;
 *   4. clears: submits the converted message to the verified endpoint over an
 *      Egress-OS-authorised HTTPS call with an HMAC request signature;
 *   5. posts: books the cleared instruction on Fineract (core banking system of
 *      record) idempotently — a withdrawal from the Fineract savings account
 *      named on the debit leg and, for family book instructions, a deposit to
 *      the credit-leg Fineract account.
 *
 * Guard-rails: a successful handshake or conversion never moves money; only
 * `submit` (approvalRef + screeningRef required, family-only participants
 * unchanged from the PPN) clears, and only `post` books. Non-US instructions
 * are refused. Retired rails (Stripe, on-chain) are not networks here.
 */

const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');
const pool = require('../bonds/pgPool');
const { EgressOsEngine } = require('./egressOsEngine');
const { ClearingAgentNetworkEndpoint } = require('./clearingAgentNetworkEndpoint');
const { FineractClient } = require('../fineract/fineractClient');
const nacha = require('../ach/nachaGenerator');
const TabaPay = require('./clearingAgentTabaPayAdapter');

const COUNTRY = 'US';
const CURRENCY = 'USD';
const FORMATS = ['nacha', 'iso20022_pain001', 'iso20022_pacs008', 'fednow', 'rtp', 'bai2', 'tabapay_json'];
const SPEEDS = ['instant', 'same_day', 'standard'];
const NETWORK_KINDS = ['private_payment_network', 'ach_operator', 'rtp_participant', 'fednow_participant', 'book_transfer'];
const HANDSHAKE_STATES = ['registered', 'challenged', 'verified', 'failed', 'revoked'];
const INSTRUCTION_STATES = ['converted', 'cleared', 'posted', 'rejected', 'failed'];
const REDACTED = '***';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_AMOUNT_CENTS = 99999999999; // NACHA 10-digit amount field

class ClearingAgentError extends Error {
  constructor(message, code, statusCode = 400, details = {}) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}
function bool(v, dflt = false) {
  if (v === undefined || v === null || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}
function normalizeActor(a) {
  return a ? String(a).trim().toLowerCase() : null;
}
function sha256(x) {
  return crypto.createHash('sha256').update(x).digest('hex');
}
function hmac(secret, ...parts) {
  return crypto.createHmac('sha256', secret).update(parts.join('\n')).digest('hex');
}
function timingEqual(a, b) {
  const ab = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
function xmlEsc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}
function last4(s) {
  const d = String(s || '').replace(/\D/g, '');
  return d ? `${'*'.repeat(Math.max(0, d.length - 4))}${d.slice(-4)}` : null;
}

function getClearingAgentConfig(env = process.env) {
  return {
    enabled: bool(env.CLEARING_AGENT_ENABLED, true),
    live: bool(env.CLEARING_AGENT_LIVE, false),
    agentId: env.CLEARING_AGENT_ID || 'DLB-TRUST-CLEARING-AGENT',
    requireDistinctVerifier: bool(env.CLEARING_AGENT_REQUIRE_DISTINCT_VERIFIER, true),
    requireApproval: bool(env.CLEARING_AGENT_REQUIRE_APPROVAL, true),
    timeoutMs: Math.max(1000, Number(env.CLEARING_AGENT_TIMEOUT_MS) || 15000),
    postToFineract: bool(env.CLEARING_AGENT_POST_TO_FINERACT, true),
    paymentTypeId: Number(env.CANONICAL_FUNDING_PAYMENT_TYPE_ID) || 1,
    familyOnly: bool(env.PRIVATE_PAYMENT_NETWORK_FAMILY_ONLY, false),
    fineractConfigured: Boolean(env.FINERACT_URL && (env.FINERACT_USERNAME || env.FINERACT_PASSWORD)),
  };
}

/** Read the credential named by `ref` from the runtime environment (Secret Manager mounts). Never returned to callers. */
function readCredential(ref) {
  if (!ref || !/^[A-Z][A-Z0-9_]{2,63}$/.test(ref)) throw new ClearingAgentError('credential_ref must be an UPPER_SNAKE env/Secret Manager reference name', 'CLEARING_AGENT_BAD_REF', 400);
  const v = process.env[ref];
  if (!v) throw new ClearingAgentError(`credential reference ${ref} has no runtime value (Secret Manager version not mounted)`, 'CLEARING_AGENT_NO_CREDENTIAL', 503, { ref });
  return String(v);
}

function redactNetwork(row) {
  if (!row) return null;
  const { credential_ref, ...rest } = row;
  return { ...rest, credential_ref, credential: REDACTED, credential_configured: Boolean(credential_ref && process.env[credential_ref]) };
}

/** Deep-redact anything that looks like a secret or full account number before it leaves the engine. */
function redactPayload(obj) {
  if (Array.isArray(obj)) return obj.map(redactPayload);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/secret|token|password|credential|signature|api[_-]?key/i.test(k)) out[k] = REDACTED;
      else if (/account(_?number|_?no|Id)?$|^acct/i.test(k) && typeof v === 'string' && /\d{5,}/.test(v)) out[k] = last4(v);
      else out[k] = redactPayload(v);
    }
    return out;
  }
  return obj;
}

// ─── Canonical instruction ───────────────────────────────────────────────────

function party(p, leg) {
  if (!p || typeof p !== 'object') throw new ClearingAgentError(`${leg} party required`, 'CLEARING_AGENT_BAD_REQUEST', 400);
  const country = String(p.country || COUNTRY).toUpperCase();
  if (country !== COUNTRY) throw new ClearingAgentError(`${leg} party country ${country} refused: USA-only processing`, 'CLEARING_AGENT_NON_US', 422);
  const routing = String(p.routingNumber || '').replace(/\D/g, '');
  if (!nacha.validateRouting(routing)) throw new ClearingAgentError(`${leg} routingNumber is not a valid 9-digit ABA number`, 'CLEARING_AGENT_BAD_ROUTING', 422);
  const accountNumber = String(p.accountNumber || '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9-]{4,17}$/.test(accountNumber)) throw new ClearingAgentError(`${leg} accountNumber invalid`, 'CLEARING_AGENT_BAD_REQUEST', 400);
  const name = String(p.name || '').trim();
  if (name.length < 2) throw new ClearingAgentError(`${leg} name required`, 'CLEARING_AGENT_BAD_REQUEST', 400);
  const accountType = String(p.accountType || 'checking').toLowerCase();
  if (!['checking', 'savings'].includes(accountType)) throw new ClearingAgentError(`${leg} accountType must be checking|savings`, 'CLEARING_AGENT_BAD_REQUEST', 400);
  return {
    name: name.slice(0, 140),
    routingNumber: routing,
    accountNumber,
    accountType,
    country,
    fineractAccountId: p.fineractAccountId ? String(p.fineractAccountId) : null,
    participantId: p.participantId ? String(p.participantId) : null,
  };
}

/**
 * Normalise a caller instruction. Amount in cents, USD, both legs US.
 */
function canonicalize(input = {}) {
  const amountCents = Math.round(Number(input.amountCents));
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new ClearingAgentError('amountCents must be a positive integer', 'CLEARING_AGENT_BAD_REQUEST', 400);
  if (amountCents > MAX_AMOUNT_CENTS) throw new ClearingAgentError('amountCents exceeds format limit', 'CLEARING_AGENT_BAD_REQUEST', 400);
  const currency = String(input.currency || CURRENCY).toUpperCase();
  if (currency !== CURRENCY) throw new ClearingAgentError(`currency ${currency} refused: USD only`, 'CLEARING_AGENT_NON_US', 422);
  const purpose = String(input.purpose || 'TRUST DISTRIBUTION').replace(/[^\x20-\x7E]/g, '').slice(0, 140);
  const endToEndId = String(input.endToEndId || input.idempotencyKey || newId('E2E')).replace(/[^A-Za-z0-9-]/g, '').slice(0, 35);
  if (!endToEndId) throw new ClearingAgentError('endToEndId invalid', 'CLEARING_AGENT_BAD_REQUEST', 400);
  const secCode = String(input.secCode || 'PPD').toUpperCase();
  if (!['PPD', 'CCD'].includes(secCode)) throw new ClearingAgentError('secCode must be PPD|CCD', 'CLEARING_AGENT_BAD_REQUEST', 400);
  const speed = SPEEDS.includes(input.speed) ? input.speed : 'standard';
  return {
    endToEndId,
    speed,
    amountCents,
    amount: (amountCents / 100).toFixed(2),
    currency,
    purpose,
    secCode,
    debtor: party(input.debtor, 'debtor'),
    creditor: party(input.creditor, 'creditor'),
    requestedExecutionDate: (input.requestedExecutionDate ? new Date(input.requestedExecutionDate) : new Date()).toISOString().slice(0, 10),
    createdAt: new Date().toISOString(),
  };
}

// ─── Format converters (USA formats only) ────────────────────────────────────

function toNacha(ix, agentId) {
  const creditCode = ix.creditor.accountType === 'savings' ? '32' : '22';
  return nacha.generateNACHAFile(
    { immediateDestination: ix.creditor.routingNumber, immediateDestinationName: 'PRIVATE PAYMENT NETWORK', fileIdModifier: 'A' },
    [{
      secCode: ix.secCode,
      companyEntryDescription: ix.purpose.slice(0, 10).toUpperCase() || 'DISTRIB',
      serviceClassCode: '220',
      companyName: nacha.ORIGINATOR_NAME,
      companyId: nacha.ORIGINATOR_ID,
      effectiveEntryDate: ix.requestedExecutionDate,
      entries: [{
        transactionCode: creditCode,
        receivingRouting: ix.creditor.routingNumber,
        accountNumber: ix.creditor.accountNumber,
        amountCents: ix.amountCents,
        individualId: ix.endToEndId.slice(0, 15),
        individualName: ix.creditor.name.slice(0, 22),
        discretionaryData: agentId.slice(0, 2),
      }],
    }]
  );
}

function isoHeader(ix, agentId) {
  return `<GrpHdr><MsgId>${xmlEsc(ix.endToEndId)}</MsgId><CreDtTm>${xmlEsc(ix.createdAt)}</CreDtTm><NbOfTxs>1</NbOfTxs><CtrlSum>${ix.amount}</CtrlSum>`
    + `<InitgPty><Nm>${xmlEsc(agentId)}</Nm><CtryOfRes>US</CtryOfRes></InitgPty></GrpHdr>`;
}
function isoAcct(p) {
  return `<Id><Othr><Id>${xmlEsc(p.accountNumber)}</Id></Othr></Id><Tp><Cd>${p.accountType === 'savings' ? 'SVGS' : 'CACC'}</Cd></Tp><Ccy>USD</Ccy>`;
}
function isoAgent(p) {
  return `<FinInstnId><ClrSysMmbId><ClrSysId><Cd>USABA</Cd></ClrSysId><MmbId>${p.routingNumber}</MmbId></ClrSysMmbId><PstlAdr><Ctry>US</Ctry></PstlAdr></FinInstnId>`;
}

function toPain001(ix, agentId) {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09"><CstmrCdtTrfInitn>'
    + isoHeader(ix, agentId)
    + `<PmtInf><PmtInfId>${xmlEsc(ix.endToEndId)}</PmtInfId><PmtMtd>TRF</PmtMtd><NbOfTxs>1</NbOfTxs><CtrlSum>${ix.amount}</CtrlSum>`
    + `<ReqdExctnDt><Dt>${ix.requestedExecutionDate}</Dt></ReqdExctnDt>`
    + `<Dbtr><Nm>${xmlEsc(ix.debtor.name)}</Nm><PstlAdr><Ctry>US</Ctry></PstlAdr></Dbtr><DbtrAcct>${isoAcct(ix.debtor)}</DbtrAcct><DbtrAgt>${isoAgent(ix.debtor)}</DbtrAgt>`
    + `<CdtTrfTxInf><PmtId><EndToEndId>${xmlEsc(ix.endToEndId)}</EndToEndId></PmtId><Amt><InstdAmt Ccy="USD">${ix.amount}</InstdAmt></Amt>`
    + `<CdtrAgt>${isoAgent(ix.creditor)}</CdtrAgt><Cdtr><Nm>${xmlEsc(ix.creditor.name)}</Nm><PstlAdr><Ctry>US</Ctry></PstlAdr></Cdtr><CdtrAcct>${isoAcct(ix.creditor)}</CdtrAcct>`
    + `<RmtInf><Ustrd>${xmlEsc(ix.purpose)}</Ustrd></RmtInf></CdtTrfTxInf></PmtInf></CstmrCdtTrfInitn></Document>`;
}

function toPacs008(ix, agentId, { sttlmMtd = 'CLRG', clrSys = 'USPPN' } = {}) {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08"><FIToFICstmrCdtTrf>'
    + `<GrpHdr><MsgId>${xmlEsc(ix.endToEndId)}</MsgId><CreDtTm>${xmlEsc(ix.createdAt)}</CreDtTm><NbOfTxs>1</NbOfTxs>`
    + `<SttlmInf><SttlmMtd>${sttlmMtd}</SttlmMtd><ClrSys><Prtry>${clrSys}</Prtry></ClrSys></SttlmInf>`
    + `<InstgAgt>${isoAgent(ix.debtor)}</InstgAgt><InstdAgt>${isoAgent(ix.creditor)}</InstdAgt></GrpHdr>`
    + `<CdtTrfTxInf><PmtId><InstrId>${xmlEsc(agentId)}-${xmlEsc(ix.endToEndId)}</InstrId><EndToEndId>${xmlEsc(ix.endToEndId)}</EndToEndId><TxId>${xmlEsc(ix.endToEndId)}</TxId></PmtId>`
    + `<IntrBkSttlmAmt Ccy="USD">${ix.amount}</IntrBkSttlmAmt><IntrBkSttlmDt>${ix.requestedExecutionDate}</IntrBkSttlmDt><ChrgBr>SLEV</ChrgBr>`
    + `<Dbtr><Nm>${xmlEsc(ix.debtor.name)}</Nm></Dbtr><DbtrAcct>${isoAcct(ix.debtor)}</DbtrAcct><DbtrAgt>${isoAgent(ix.debtor)}</DbtrAgt>`
    + `<CdtrAgt>${isoAgent(ix.creditor)}</CdtrAgt><Cdtr><Nm>${xmlEsc(ix.creditor.name)}</Nm></Cdtr><CdtrAcct>${isoAcct(ix.creditor)}</CdtrAcct>`
    + `<RmtInf><Ustrd>${xmlEsc(ix.purpose)}</Ustrd></RmtInf></CdtTrfTxInf></FIToFICstmrCdtTrf></Document>`;
}

/** FedNow / RTP instant credit transfer as JSON-bodied pacs.008 (what US instant-rail gateways accept over REST). */
function toInstantJson(ix, agentId, rail) {
  return JSON.stringify({
    rail,
    messageType: 'pacs.008.001.08',
    country: COUNTRY,
    groupHeader: { messageId: ix.endToEndId, creationDateTime: ix.createdAt, numberOfTransactions: 1, settlementMethod: rail === 'fednow' ? 'CLRG' : 'CLRG', clearingSystem: rail === 'fednow' ? 'FDN' : 'TCH', instructingAgent: { aba: ix.debtor.routingNumber }, instructedAgent: { aba: ix.creditor.routingNumber } },
    creditTransfer: {
      paymentId: { instructionId: `${agentId}-${ix.endToEndId}`, endToEndId: ix.endToEndId, transactionId: ix.endToEndId },
      interbankSettlementAmount: { currency: CURRENCY, amount: ix.amount },
      interbankSettlementDate: ix.requestedExecutionDate,
      chargeBearer: 'SLEV',
      debtor: { name: ix.debtor.name, country: COUNTRY },
      debtorAccount: { identification: ix.debtor.accountNumber, type: ix.debtor.accountType === 'savings' ? 'SVGS' : 'CACC' },
      debtorAgent: { aba: ix.debtor.routingNumber },
      creditorAgent: { aba: ix.creditor.routingNumber },
      creditor: { name: ix.creditor.name, country: COUNTRY },
      creditorAccount: { identification: ix.creditor.accountNumber, type: ix.creditor.accountType === 'savings' ? 'SVGS' : 'CACC' },
      remittanceInformation: { unstructured: ix.purpose },
    },
  });
}

/** BAI2 posting record: one 03 account record with a 16 detail line per leg (credit to creditor, debit from debtor). */
function toBai2(ix, agentId) {
  const d = ix.createdAt.slice(2, 10).replace(/-/g, '');
  const t = ix.createdAt.slice(11, 16).replace(':', '');
  const fileId = ix.endToEndId.slice(0, 10);
  const lines = [
    `01,${ix.debtor.routingNumber},${agentId.slice(0, 20)},${d},${t},${fileId},80,1,2/`,
    `02,${agentId.slice(0, 20)},${ix.debtor.routingNumber},1,${d},${t},USD,2/`,
    `03,${ix.debtor.accountNumber},USD/`,
    `16,495,${ix.amountCents},Z,${ix.endToEndId},${ix.creditor.name.slice(0, 40)},${ix.purpose.slice(0, 40)}/`,
    `03,${ix.creditor.accountNumber},USD/`,
    `16,195,${ix.amountCents},Z,${ix.endToEndId},${ix.debtor.name.slice(0, 40)},${ix.purpose.slice(0, 40)}/`,
  ];
  const recordCount = lines.length + 3;
  lines.push(`49,${ix.amountCents * 2},${recordCount - 1}/`);
  lines.push(`98,${ix.amountCents * 2},2,${recordCount}/`);
  lines.push(`99,${ix.amountCents * 2},1,${recordCount + 1}/`);
  return lines.join('\n') + '\n';
}

/** tabapay_json needs the registered network (settlement AccountID) and the idempotency key; there is no standalone rendering. */
function convert(ix, format, agentId, ctx = {}) {
  switch (format) {
    case 'nacha': return { contentType: 'text/plain', body: toNacha(ix, agentId) };
    case 'iso20022_pain001': return { contentType: 'application/xml', body: toPain001(ix, agentId) };
    case 'iso20022_pacs008': return { contentType: 'application/xml', body: toPacs008(ix, agentId) };
    case 'fednow': return { contentType: 'application/json', body: toInstantJson(ix, agentId, 'fednow') };
    case 'rtp': return { contentType: 'application/json', body: toInstantJson(ix, agentId, 'rtp') };
    case 'bai2': return { contentType: 'text/plain', body: toBai2(ix, agentId) };
    case 'tabapay_json': {
      if (!TabaPay.isTabaPay(ctx.network) || !ctx.idempotencyKey) throw new ClearingAgentError('tabapay_json requires a registered tabapay network and an idempotency key', 'CLEARING_AGENT_BAD_FORMAT', 400);
      let conf;
      try { conf = TabaPay.adapterConfig(ctx.network); } catch (e) { throw new ClearingAgentError(e.message, 'CLEARING_AGENT_BAD_REQUEST', 400); }
      return { contentType: 'application/json', body: JSON.stringify(TabaPay.toTransaction(ix, { settlementAccountId: conf.settlementAccountId, idempotencyKey: ctx.idempotencyKey })) };
    }
    default: throw new ClearingAgentError(`format must be one of ${FORMATS.join(', ')}`, 'CLEARING_AGENT_BAD_FORMAT', 400);
  }
}

// ─── HTTPS (backend-to-backend, HMAC signed, Egress-authorised) ──────────────

function signedHeaders(secret, agentId, method, path, body, ts = Date.now()) {
  const bodyHash = sha256(body || '');
  const sig = hmac(secret, agentId, method.toUpperCase(), path, String(ts), bodyHash);
  return { 'X-Clearing-Agent-Id': agentId, 'X-Clearing-Agent-Ts': String(ts), 'X-Clearing-Agent-Body-Sha256': bodyHash, 'X-Clearing-Agent-Signature': sig };
}

const METADATA_IDENTITY_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';

/**
 * Google OIDC identity token for the runtime service account, for networks
 * that sit behind Identity-Aware Proxy (the trust's own PPN on Cloud Run).
 * Fetched from the metadata server per call; never persisted or logged.
 */
async function iapIdentityToken(audience) {
  const res = await fetch(`${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(audience)}&format=full`, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new ClearingAgentError(`identity token unavailable (metadata HTTP ${res.status})`, 'CLEARING_AGENT_IAP', 503);
  const token = (await res.text()).trim();
  if (!token) throw new ClearingAgentError('identity token unavailable (empty)', 'CLEARING_AGENT_IAP', 503);
  return token;
}

async function transportHeaders(n) {
  const aud = n && n.capabilities && typeof n.capabilities.iapAudience === 'string' ? n.capabilities.iapAudience.trim() : '';
  if (!aud) return {};
  return { Authorization: `Bearer ${await iapIdentityToken(aud)}` };
}

function httpsPost(url, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') return reject(new ClearingAgentError('network endpoints must be https', 'CLEARING_AGENT_INSECURE', 400));
    const data = Buffer.from(body || '', 'utf8');
    const req = https.request({ method: 'POST', hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers: { ...headers, 'Content-Length': data.length }, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ statusCode: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, json, text: text.slice(0, 2000) });
      });
    });
    req.on('timeout', () => req.destroy(new ClearingAgentError('network endpoint timeout', 'CLEARING_AGENT_TIMEOUT', 504)));
    req.on('error', reject);
    req.end(data);
  });
}

// ─── Engine ──────────────────────────────────────────────────────────────────

const ClearingAgentOsEngine = {
  FORMATS,
  NETWORK_KINDS,

  async ensureTables() {
    if (!pool) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS clearing_agent_networks (
      network_id        VARCHAR(64) PRIMARY KEY,
      name              TEXT NOT NULL,
      kind              VARCHAR(32) NOT NULL,
      country           CHAR(2) NOT NULL DEFAULT 'US',
      base_url          TEXT NOT NULL,
      format            VARCHAR(32) NOT NULL,
      credential_ref    VARCHAR(64) NOT NULL,
      credential_fingerprint CHAR(16),
      handshake_state   VARCHAR(16) NOT NULL DEFAULT 'registered',
      handshake_nonce   CHAR(64),
      handshake_expires TIMESTAMPTZ,
      capabilities      JSONB NOT NULL DEFAULT '{}'::jsonb,
      registered_by     VARCHAR(128),
      verified_by       VARCHAR(128),
      verified_at       TIMESTAMPTZ,
      last_error        TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS clearing_agent_instructions (
      instruction_id    VARCHAR(64) PRIMARY KEY,
      idempotency_key   VARCHAR(128) NOT NULL UNIQUE,
      network_id        VARCHAR(64) NOT NULL,
      format            VARCHAR(32) NOT NULL,
      status            VARCHAR(16) NOT NULL DEFAULT 'converted',
      amount_cents      BIGINT NOT NULL,
      currency          CHAR(3) NOT NULL DEFAULT 'USD',
      debtor_name       TEXT,
      debtor_routing    CHAR(9),
      debtor_account_last4 VARCHAR(8),
      debtor_fineract_id VARCHAR(32),
      creditor_name     TEXT,
      creditor_routing  CHAR(9),
      creditor_account_last4 VARCHAR(8),
      creditor_fineract_id VARCHAR(32),
      purpose           TEXT,
      approval_ref      VARCHAR(128),
      screening_ref     VARCHAR(128),
      message_sha256    CHAR(64) NOT NULL,
      network_ref       TEXT,
      fineract_withdrawal_id TEXT,
      fineract_deposit_id TEXT,
      submitted_by      VARCHAR(128),
      error             TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      cleared_at        TIMESTAMPTZ,
      posted_at         TIMESTAMPTZ,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS clearing_agent_events (
      event_id     VARCHAR(64) PRIMARY KEY,
      network_id   VARCHAR(64),
      instruction_id VARCHAR(64),
      event_type   VARCHAR(48) NOT NULL,
      actor        VARCHAR(128),
      detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  },

  async _event(type, { networkId = null, instructionId = null, actor = null, detail = {} } = {}) {
    if (!pool) return;
    await pool.query(
      'INSERT INTO clearing_agent_events (event_id, network_id, instruction_id, event_type, actor, detail) VALUES ($1,$2,$3,$4,$5,$6)',
      [newId('CAE'), networkId, instructionId, type, normalizeActor(actor), JSON.stringify(redactPayload(detail))]
    ).catch(() => {});
  },

  async _network(networkId) {
    if (!pool) return null;
    const r = await pool.query('SELECT * FROM clearing_agent_networks WHERE network_id = $1', [networkId]);
    return r.rows[0] || null;
  },

  async _updateNetwork(networkId, patch) {
    const keys = Object.keys(patch);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    const vals = keys.map((k) => (k === 'capabilities' ? JSON.stringify(patch[k]) : patch[k]));
    const r = await pool.query(`UPDATE clearing_agent_networks SET ${sets.join(', ')}, updated_at = NOW() WHERE network_id = $1 RETURNING *`, [networkId, ...vals]);
    return r.rows[0] || null;
  },

  async _instruction(instructionId) {
    if (!pool) return null;
    const r = await pool.query('SELECT * FROM clearing_agent_instructions WHERE instruction_id = $1', [instructionId]);
    return r.rows[0] || null;
  },

  async _updateInstruction(instructionId, patch) {
    const keys = Object.keys(patch);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    const r = await pool.query(`UPDATE clearing_agent_instructions SET ${sets.join(', ')}, updated_at = NOW() WHERE instruction_id = $1 RETURNING *`, [instructionId, ...keys.map((k) => patch[k])]);
    return r.rows[0] || null;
  },

  // ─── Network registry + handshake ─────────────────────────────────────────

  /**
   * register: { networkId, name, kind, baseUrl, format, credentialRef, actor }
   * Stores endpoint metadata and the Secret Manager reference NAME only. The
   * credential value is checked for presence and fingerprinted (first 16 hex
   * of sha256) so rotation is detectable, but never stored.
   */
  async register({ networkId = null, name, kind = 'private_payment_network', baseUrl, format, credentialRef, country = COUNTRY, capabilities = {}, actor = null } = {}) {
    const cfg = getClearingAgentConfig();
    if (!cfg.enabled) throw new ClearingAgentError('CLEARING_AGENT_ENABLED=false', 'CLEARING_AGENT_DISABLED', 503);
    if (!pool) throw new ClearingAgentError('ledger database not connected', 'CLEARING_AGENT_DB', 503);
    const a = normalizeActor(actor);
    if (!a) throw new ClearingAgentError('registering trustee identity required', 'CLEARING_AGENT_ACTOR', 401);
    if (String(country).toUpperCase() !== COUNTRY) throw new ClearingAgentError('only US networks may be registered', 'CLEARING_AGENT_NON_US', 422);
    if (!NETWORK_KINDS.includes(kind)) throw new ClearingAgentError(`kind must be one of ${NETWORK_KINDS.join(', ')}`, 'CLEARING_AGENT_BAD_REQUEST', 400);
    if (!FORMATS.includes(format)) throw new ClearingAgentError(`format must be one of ${FORMATS.join(', ')}`, 'CLEARING_AGENT_BAD_FORMAT', 400);
    if (!name || String(name).trim().length < 2) throw new ClearingAgentError('name required', 'CLEARING_AGENT_BAD_REQUEST', 400);
    let u;
    try { u = new URL(String(baseUrl)); } catch { throw new ClearingAgentError('baseUrl invalid', 'CLEARING_AGENT_BAD_REQUEST', 400); }
    if (u.protocol !== 'https:') throw new ClearingAgentError('baseUrl must be https', 'CLEARING_AGENT_INSECURE', 400);
    if (u.username || u.password || /[?#]/.test(String(baseUrl))) throw new ClearingAgentError('baseUrl must not embed credentials or query strings', 'CLEARING_AGENT_INSECURE', 400);
    const egress = await EgressOsEngine.authorize(u.toString(), { caller: 'clearing-agent', actor: a, record: false });
    if (!egress.allowed) throw new ClearingAgentError(`egress policy does not allow ${u.hostname}: ${egress.reason}`, 'CLEARING_AGENT_EGRESS', 403, { host: u.hostname });
    if (TabaPay.isTabaPay({ capabilities })) {
      if (format !== 'tabapay_json') throw new ClearingAgentError('tabapay networks must use format tabapay_json', 'CLEARING_AGENT_BAD_FORMAT', 400);
      try { TabaPay.adapterConfig({ capabilities }); } catch (e) { throw new ClearingAgentError(e.message, 'CLEARING_AGENT_BAD_REQUEST', 400); }
    } else if (format === 'tabapay_json') {
      throw new ClearingAgentError('format tabapay_json requires capabilities.adapter=tabapay', 'CLEARING_AGENT_BAD_FORMAT', 400);
    }
    const secret = readCredential(credentialRef);
    const fingerprint = sha256(secret).slice(0, 16);

    const id = networkId ? String(networkId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) : newId('PPN');
    if (!id) throw new ClearingAgentError('networkId invalid', 'CLEARING_AGENT_BAD_REQUEST', 400);
    if (await this._network(id)) throw new ClearingAgentError(`network ${id} already registered`, 'CLEARING_AGENT_DUPLICATE', 409);
    await pool.query(
      `INSERT INTO clearing_agent_networks (network_id, name, kind, country, base_url, format, credential_ref, credential_fingerprint, handshake_state, capabilities, registered_by)
       VALUES ($1,$2,$3,'US',$4,$5,$6,$7,'registered',$8,$9)`,
      [id, String(name).trim(), kind, u.toString().replace(/\/$/, ''), format, credentialRef, fingerprint, JSON.stringify(capabilities || {}), a]
    );
    await this._event('clearing_agent.registered', { networkId: id, actor: a, detail: { kind, format, host: u.hostname, credentialRef } });
    return redactNetwork(await this._network(id));
  },

  /**
   * challenge: mint a nonce for the network (step 1 of the handshake). Nothing leaves the box yet.
   */
  async challenge({ networkId, actor = null } = {}) {
    const n = await this._network(networkId);
    if (!n) throw new ClearingAgentError('network not found', 'CLEARING_AGENT_NOT_FOUND', 404);
    if (n.handshake_state === 'revoked') throw new ClearingAgentError('network revoked', 'CLEARING_AGENT_STATE', 409);
    const nonce = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + CHALLENGE_TTL_MS);
    const row = await this._updateNetwork(networkId, { handshake_state: 'challenged', handshake_nonce: nonce, handshake_expires: expires, last_error: null });
    await this._event('clearing_agent.challenged', { networkId, actor, detail: { expires } });
    return { ...redactNetwork(row), nonce, expiresAt: expires.toISOString() };
  },

  /**
   * verify: step 2. POST {agentId, networkId, nonce, signature=HMAC(secret, agentId|networkId|nonce)}
   * to <baseUrl>/handshake; the network must answer {signature=HMAC(secret, networkId|agentId|nonce|'ack')}.
   * Both proofs use the shared credential; neither side ever transmits it.
   * The verifier must be a different trustee than the registrar.
   */
  async verify({ networkId, actor = null } = {}) {
    const cfg = getClearingAgentConfig();
    const n = await this._network(networkId);
    if (!n) throw new ClearingAgentError('network not found', 'CLEARING_AGENT_NOT_FOUND', 404);
    if (n.handshake_state !== 'challenged') throw new ClearingAgentError(`network is ${n.handshake_state}; issue a challenge first`, 'CLEARING_AGENT_STATE', 409);
    if (!n.handshake_expires || new Date(n.handshake_expires).getTime() < Date.now()) throw new ClearingAgentError('challenge expired', 'CLEARING_AGENT_STATE', 409);
    const a = normalizeActor(actor);
    if (!a) throw new ClearingAgentError('verifying trustee identity required', 'CLEARING_AGENT_ACTOR', 401);
    if (cfg.requireDistinctVerifier && a === normalizeActor(n.registered_by)) throw new ClearingAgentError('verifier must differ from registrar (maker/checker)', 'CLEARING_AGENT_SAME_ACTOR', 409);

    const secret = readCredential(n.credential_ref);
    if (sha256(secret).slice(0, 16) !== n.credential_fingerprint) {
      await this._updateNetwork(networkId, { handshake_state: 'failed', last_error: 'credential rotated since registration; re-register' });
      throw new ClearingAgentError('credential rotated since registration; re-register', 'CLEARING_AGENT_CREDENTIAL_ROTATED', 409);
    }
    if (TabaPay.isTabaPay(n)) return this._verifyTabaPay(n, secret, a, cfg);
    const url = `${n.base_url}/handshake`;
    await EgressOsEngine.authorize(url, { caller: 'clearing-agent', actor: a });
    const body = JSON.stringify({ agentId: cfg.agentId, networkId, nonce: n.handshake_nonce, signature: hmac(secret, cfg.agentId, networkId, n.handshake_nonce), country: COUNTRY, formats: [n.format] });
    let res;
    try {
      res = await httpsPost(url, body, { 'Content-Type': 'application/json', ...(await transportHeaders(n)), ...signedHeaders(secret, cfg.agentId, 'POST', new URL(url).pathname, body) }, cfg.timeoutMs);
    } catch (e) {
      await this._updateNetwork(networkId, { handshake_state: 'failed', last_error: e.message });
      await this._event('clearing_agent.handshake_failed', { networkId, actor: a, detail: { error: e.message } });
      throw new ClearingAgentError(`handshake transport failed: ${e.message}`, 'CLEARING_AGENT_HANDSHAKE', 502);
    }
    const expected = hmac(secret, networkId, cfg.agentId, n.handshake_nonce, 'ack');
    const got = res.json && res.json.signature;
    if (!res.ok || !timingEqual(got, expected)) {
      const reason = !res.ok ? `network answered HTTP ${res.statusCode}` : 'network signature did not verify';
      await this._updateNetwork(networkId, { handshake_state: 'failed', last_error: reason, handshake_nonce: null });
      await this._event('clearing_agent.handshake_failed', { networkId, actor: a, detail: { reason, statusCode: res.statusCode } });
      throw new ClearingAgentError(reason, 'CLEARING_AGENT_HANDSHAKE', 502);
    }
    const caps = res.json && typeof res.json.capabilities === 'object' && res.json.capabilities ? res.json.capabilities : {};
    const row = await this._updateNetwork(networkId, { handshake_state: 'verified', verified_by: a, verified_at: new Date(), handshake_nonce: null, handshake_expires: null, capabilities: { ...(n.capabilities || {}), ...redactPayload(caps) }, last_error: null });
    await this._event('clearing_agent.verified', { networkId, actor: a, detail: { capabilities: caps } });
    return redactNetwork(row);
  },

  /** TabaPay handshake: authenticated Retrieve Client for the configured ClientID (no HMAC ack exists on their side). */
  async _verifyTabaPay(n, bearer, a, cfg) {
    const networkId = n.network_id;
    await EgressOsEngine.authorize(`${n.base_url}/v1/clients/x`, { caller: 'clearing-agent', actor: a });
    let res;
    try {
      res = await TabaPay.handshake(n, bearer, cfg.timeoutMs);
    } catch (e) {
      await this._updateNetwork(networkId, { handshake_state: 'failed', last_error: e.message });
      await this._event('clearing_agent.handshake_failed', { networkId, actor: a, detail: { error: e.message, adapter: TabaPay.ADAPTER } });
      throw new ClearingAgentError(`handshake transport failed: ${e.message}`, 'CLEARING_AGENT_HANDSHAKE', 502);
    }
    if (!res.ok) {
      await this._updateNetwork(networkId, { handshake_state: 'failed', last_error: res.reason, handshake_nonce: null });
      await this._event('clearing_agent.handshake_failed', { networkId, actor: a, detail: { reason: res.reason, statusCode: res.statusCode, adapter: TabaPay.ADAPTER } });
      throw new ClearingAgentError(res.reason, 'CLEARING_AGENT_HANDSHAKE', 502);
    }
    const row = await this._updateNetwork(networkId, { handshake_state: 'verified', verified_by: a, verified_at: new Date(), handshake_nonce: null, handshake_expires: null, capabilities: { ...(n.capabilities || {}), ...redactPayload(res.capabilities) }, last_error: null });
    await this._event('clearing_agent.verified', { networkId, actor: a, detail: { capabilities: res.capabilities, adapter: TabaPay.ADAPTER } });
    return redactNetwork(row);
  },

  async revoke({ networkId, reason = null, actor = null } = {}) {
    const n = await this._network(networkId);
    if (!n) throw new ClearingAgentError('network not found', 'CLEARING_AGENT_NOT_FOUND', 404);
    const row = await this._updateNetwork(networkId, { handshake_state: 'revoked', handshake_nonce: null, last_error: reason });
    await this._event('clearing_agent.revoked', { networkId, actor, detail: { reason } });
    return redactNetwork(row);
  },

  // ─── Convert / clear / post ───────────────────────────────────────────────

  /** convert: pure format conversion; persists nothing, moves nothing. */
  convert({ instruction, format } = {}) {
    const cfg = getClearingAgentConfig();
    const ix = canonicalize(instruction);
    const out = convert(ix, format, cfg.agentId);
    return { format, contentType: out.contentType, sha256: sha256(out.body), body: out.body, instruction: redactPayload(ix) };
  },

  /**
   * submit: convert + clear through a verified network. Requires approvalRef and
   * screeningRef (maker/checker + screening happened upstream in the PPN /
   * distribution request). Idempotent on idempotencyKey. Success = 'cleared';
   * money is booked only by `post`.
   */
  async submit({ networkId, instruction, idempotencyKey, approvalRef = null, screeningRef = null, actor = null } = {}) {
    const cfg = getClearingAgentConfig();
    if (!cfg.enabled) throw new ClearingAgentError('CLEARING_AGENT_ENABLED=false', 'CLEARING_AGENT_DISABLED', 503);
    if (!pool) throw new ClearingAgentError('ledger database not connected', 'CLEARING_AGENT_DB', 503);
    const a = normalizeActor(actor);
    if (!a) throw new ClearingAgentError('submitter identity required', 'CLEARING_AGENT_ACTOR', 401);
    if (cfg.requireApproval && (!approvalRef || !screeningRef)) throw new ClearingAgentError('approvalRef and screeningRef are required', 'CLEARING_AGENT_APPROVAL', 403);
    const key = String(idempotencyKey || '').trim();
    if (!key) throw new ClearingAgentError('idempotencyKey required', 'CLEARING_AGENT_BAD_REQUEST', 400);
    const dup = await pool.query('SELECT * FROM clearing_agent_instructions WHERE idempotency_key = $1', [key]);
    if (dup.rows.length) return { ...dup.rows[0], idempotent: true };

    const n = await this._network(networkId);
    if (!n) throw new ClearingAgentError('network not found', 'CLEARING_AGENT_NOT_FOUND', 404);
    if (n.handshake_state !== 'verified') throw new ClearingAgentError(`network ${networkId} is ${n.handshake_state}; only verified networks clear`, 'CLEARING_AGENT_UNVERIFIED', 409);
    if (n.country !== COUNTRY) throw new ClearingAgentError('non-US network refused', 'CLEARING_AGENT_NON_US', 422);
    const ix = canonicalize(instruction);
    if (cfg.familyOnly && !ix.creditor.participantId) throw new ClearingAgentError('family-only mode: creditor.participantId (admitted PPN participant) required', 'CLEARING_AGENT_FAMILY_ONLY', 403);
    const msg = convert(ix, n.format, cfg.agentId, { network: n, idempotencyKey: key });
    const instructionId = newId('CAI');
    await pool.query(
      `INSERT INTO clearing_agent_instructions (instruction_id, idempotency_key, network_id, format, status, amount_cents, currency, debtor_name, debtor_routing, debtor_account_last4, debtor_fineract_id,
         creditor_name, creditor_routing, creditor_account_last4, creditor_fineract_id, purpose, approval_ref, screening_ref, message_sha256, submitted_by)
       VALUES ($1,$2,$3,$4,'converted',$5,'USD',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [instructionId, key, networkId, n.format, ix.amountCents, ix.debtor.name, ix.debtor.routingNumber, last4(ix.debtor.accountNumber), ix.debtor.fineractAccountId,
        ix.creditor.name, ix.creditor.routingNumber, last4(ix.creditor.accountNumber), ix.creditor.fineractAccountId, ix.purpose, approvalRef, screeningRef, sha256(msg.body), a]
    );
    await this._event('clearing_agent.converted', { networkId, instructionId, actor: a, detail: { format: n.format, amountCents: ix.amountCents, sha256: sha256(msg.body) } });

    if (!cfg.live) {
      const row = await this._updateInstruction(instructionId, { status: 'rejected', error: 'CLEARING_AGENT_LIVE not true (shadow: converted only)' });
      await this._event('clearing_agent.shadow', { networkId, instructionId, actor: a });
      return { ...row, shadow: true };
    }
    const secret = readCredential(n.credential_ref);
    if (TabaPay.isTabaPay(n)) {
      await EgressOsEngine.authorize(`${n.base_url}/v1/clients/x/transactions`, { caller: 'clearing-agent', actor: a });
      let tp;
      try {
        tp = await TabaPay.clear(n, secret, ix, key, cfg.timeoutMs);
      } catch (e) {
        const row = await this._updateInstruction(instructionId, { status: 'failed', error: e.message });
        await this._event('clearing_agent.clear_failed', { networkId, instructionId, actor: a, detail: { error: e.message, adapter: TabaPay.ADAPTER } });
        return row;
      }
      if (!tp.ok) {
        const row = await this._updateInstruction(instructionId, { status: 'rejected', error: tp.reason });
        await this._event('clearing_agent.rejected', { networkId, instructionId, actor: a, detail: { statusCode: tp.statusCode, reason: tp.reason, adapter: TabaPay.ADAPTER } });
        return row;
      }
      const row = await this._updateInstruction(instructionId, { status: 'cleared', network_ref: tp.networkRef, cleared_at: new Date(), error: null });
      await this._event('clearing_agent.cleared', { networkId, instructionId, actor: a, detail: { networkRef: tp.networkRef, tabapayStatus: tp.status, referenceId: tp.body.referenceID, adapter: TabaPay.ADAPTER } });
      return row;
    }
    const url = `${n.base_url}/clear`;
    await EgressOsEngine.authorize(url, { caller: 'clearing-agent', actor: a });
    let res;
    try {
      res = await httpsPost(url, msg.body, { 'Content-Type': msg.contentType, 'X-Clearing-Format': n.format, 'X-Idempotency-Key': key, ...(await transportHeaders(n)), ...signedHeaders(secret, cfg.agentId, 'POST', new URL(url).pathname, msg.body) }, cfg.timeoutMs);
    } catch (e) {
      const row = await this._updateInstruction(instructionId, { status: 'failed', error: e.message });
      await this._event('clearing_agent.clear_failed', { networkId, instructionId, actor: a, detail: { error: e.message } });
      return row;
    }
    if (!res.ok) {
      const row = await this._updateInstruction(instructionId, { status: 'rejected', error: `network HTTP ${res.statusCode}` });
      await this._event('clearing_agent.rejected', { networkId, instructionId, actor: a, detail: { statusCode: res.statusCode } });
      return row;
    }
    const networkRef = res.json && (res.json.reference || res.json.networkRef || res.json.id) ? String(res.json.reference || res.json.networkRef || res.json.id) : null;
    const row = await this._updateInstruction(instructionId, { status: 'cleared', network_ref: networkRef, cleared_at: new Date(), error: null });
    await this._event('clearing_agent.cleared', { networkId, instructionId, actor: a, detail: { networkRef } });
    return row;
  },

  /**
   * post: book a cleared instruction on Fineract (core banking system of record).
   * Withdraw from the debtor's Fineract savings account; deposit to the
   * creditor's Fineract account when the instruction is a family book leg.
   * Idempotent: a posted instruction returns as-is.
   */
  async post({ instructionId, actor = null } = {}) {
    const cfg = getClearingAgentConfig();
    const ix = await this._instruction(instructionId);
    if (!ix) throw new ClearingAgentError('instruction not found', 'CLEARING_AGENT_NOT_FOUND', 404);
    if (ix.status === 'posted') return { ...ix, idempotent: true };
    if (ix.status !== 'cleared') throw new ClearingAgentError(`instruction is ${ix.status}; only cleared instructions post`, 'CLEARING_AGENT_STATE', 409);
    if (!cfg.postToFineract) throw new ClearingAgentError('CLEARING_AGENT_POST_TO_FINERACT=false', 'CLEARING_AGENT_DISABLED', 503);
    if (!cfg.fineractConfigured) throw new ClearingAgentError('Fineract API not configured (FINERACT_URL/credentials)', 'CLEARING_AGENT_FINERACT', 503);
    if (!ix.debtor_fineract_id) throw new ClearingAgentError('debtor.fineractAccountId missing; cannot post to core banking', 'CLEARING_AGENT_FINERACT', 409);
    const amount = Number(ix.amount_cents) / 100;
    const note = `clearing-agent ${ix.instruction_id} ${ix.network_id} ${ix.network_ref || ''}`.trim();
    let withdrawalId = ix.fineract_withdrawal_id;
    let depositId = ix.fineract_deposit_id;
    try {
      if (!withdrawalId) {
        const w = await FineractClient.withdrawSavings({ accountId: ix.debtor_fineract_id, amount, paymentTypeId: cfg.paymentTypeId, note });
        withdrawalId = String(w && w.resourceId ? w.resourceId : w && w.transactionId ? w.transactionId : 'ok');
        await this._updateInstruction(instructionId, { fineract_withdrawal_id: withdrawalId });
      }
      if (ix.creditor_fineract_id && !depositId) {
        const d = await FineractClient.depositSavings({ accountId: ix.creditor_fineract_id, amount, paymentTypeId: cfg.paymentTypeId, note });
        depositId = String(d && d.resourceId ? d.resourceId : d && d.transactionId ? d.transactionId : 'ok');
        await this._updateInstruction(instructionId, { fineract_deposit_id: depositId });
      }
    } catch (e) {
      const row = await this._updateInstruction(instructionId, { error: `fineract posting: ${e.message}` });
      await this._event('clearing_agent.post_failed', { networkId: ix.network_id, instructionId, actor, detail: { error: e.message, withdrawalId, depositId } });
      return row;
    }
    const row = await this._updateInstruction(instructionId, { status: 'posted', posted_at: new Date(), error: null });
    await this._event('clearing_agent.posted', { networkId: ix.network_id, instructionId, actor, detail: { withdrawalId, depositId, amountCents: ix.amount_cents } });
    return row;
  },

  // ─── Status / readiness ───────────────────────────────────────────────────

  async networks() {
    if (!pool) return [];
    const r = await pool.query('SELECT * FROM clearing_agent_networks ORDER BY created_at DESC');
    return r.rows.map(redactNetwork);
  },

  async counts() {
    const out = Object.fromEntries(INSTRUCTION_STATES.map((s) => [s, 0]));
    if (!pool) return out;
    const r = await pool.query('SELECT status, COUNT(*)::int AS n, COALESCE(SUM(amount_cents),0)::bigint AS cents FROM clearing_agent_instructions GROUP BY status');
    for (const row of r.rows) out[row.status] = row.n;
    out.postedCents = r.rows.filter((x) => x.status === 'posted').reduce((s, x) => s + Number(x.cents), 0);
    return out;
  },

  async status() {
    const cfg = getClearingAgentConfig();
    const nets = await this.networks();
    return {
      engine: 'clearing-agent',
      enabled: cfg.enabled,
      live: cfg.live,
      agentId: cfg.agentId,
      country: COUNTRY,
      currency: CURRENCY,
      formats: FORMATS,
      networkKinds: NETWORK_KINDS,
      networks: { total: nets.length, verified: nets.filter((n) => n.handshake_state === 'verified').length, byState: Object.fromEntries(HANDSHAKE_STATES.map((s) => [s, nets.filter((n) => n.handshake_state === s).length])), list: nets },
      instructions: await this.counts(),
      coreBanking: { system: 'fineract', configured: cfg.fineractConfigured, postToFineract: cfg.postToFineract, paymentTypeId: cfg.paymentTypeId },
      policy: { usaOnly: true, credentialStorage: 'secret_manager_reference_only', handshake: 'hmac_challenge_verify_mutual', requireDistinctVerifier: cfg.requireDistinctVerifier, requireApproval: cfg.requireApproval, familyOnly: cfg.familyOnly, egressAuthorised: true, handshakeMovesMoney: false, conversionMovesMoney: false },
    };
  },

  async health() {
    const s = await this.status();
    return { ok: s.enabled, engine: 'clearing-agent', verifiedNetworks: s.networks.verified, fineract: s.coreBanking.configured };
  },

  async readiness() {
    const s = await this.status();
    const cfg = getClearingAgentConfig();
    const blockers = [];
    if (!s.enabled) blockers.push('CLEARING_AGENT_ENABLED=false');
    if (!s.networks.total) blockers.push('no private electronic payment network registered (POST process action=register)');
    else if (!s.networks.verified) blockers.push('no network has completed the challenge/verify handshake');
    for (const n of s.networks.list) if (!n.credential_configured) blockers.push(`network ${n.network_id}: credential reference ${n.credential_ref} has no runtime value`);
    if (!cfg.fineractConfigured) blockers.push('Fineract API not configured (FINERACT_URL / FINERACT_USERNAME)');
    if (!cfg.postToFineract) blockers.push('CLEARING_AGENT_POST_TO_FINERACT=false (cleared instructions would not post to core banking)');
    if (!cfg.requireDistinctVerifier) blockers.push('CLEARING_AGENT_REQUIRE_DISTINCT_VERIFIER=false (maker/checker disabled)');
    if (!cfg.requireApproval) blockers.push('CLEARING_AGENT_REQUIRE_APPROVAL=false (approvalRef/screeningRef not enforced)');
    if (!cfg.familyOnly) blockers.push('PRIVATE_PAYMENT_NETWORK_FAMILY_ONLY not true');
    if (!s.live) blockers.push('CLEARING_AGENT_LIVE not true');
    const ep = await ClearingAgentNetworkEndpoint.status();
    blockers.push(...ep.blockers.map((b) => `family PPN participant endpoint: ${b}`));
    const live = blockers.length === 0;
    return { ready: live, mode: live ? 'live' : 'shadow', blockers, status: { ...s, networkEndpoint: ep } };
  },

  async list({ limit = 50, status = null } = {}) {
    if (!pool) return [];
    const lim = Math.min(500, Math.max(1, Number(limit) || 50));
    const r = status
      ? await pool.query('SELECT * FROM clearing_agent_instructions WHERE status = $1 ORDER BY created_at DESC LIMIT $2', [status, lim])
      : await pool.query('SELECT * FROM clearing_agent_instructions ORDER BY created_at DESC LIMIT $1', [lim]);
    return r.rows;
  },

  async get(id) {
    const ix = await this._instruction(id);
    if (ix) return ix;
    const n = await this._network(id);
    return n ? redactNetwork(n) : null;
  },

  async process({ action, actor = null, ...body } = {}) {
    switch (action) {
      case 'register': return this.register({ ...body, actor });
      case 'challenge': return this.challenge({ ...body, actor });
      case 'verify': return this.verify({ ...body, actor });
      case 'revoke': return this.revoke({ ...body, actor });
      case 'convert': return this.convert(body);
      case 'submit': return this.submit({ ...body, actor });
      case 'post': return this.post({ ...body, actor });
      case 'networks': return this.networks();
      default: throw new ClearingAgentError('action must be register|challenge|verify|revoke|convert|submit|post|networks', 'CLEARING_AGENT_BAD_ACTION', 400);
    }
  },
};

module.exports = {
  ClearingAgentOsEngine,
  ClearingAgentError,
  getClearingAgentConfig,
  canonicalize,
  convert,
  redactPayload,
  signedHeaders,
  hmac,
  FORMATS,
  NETWORK_KINDS,
  COUNTRY,
};
