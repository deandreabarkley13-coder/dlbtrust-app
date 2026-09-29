'use strict';

/**
 * Fraud & Compliance OS — the screening authority behind every `screeningRef`.
 *
 * One screening per outbound payment, bound to the payee, amount and
 * settlement bank it was run for:
 *
 *   screen()   maker step: sanctions (ComplianceEngine: OFAC / OpenSanctions
 *              list) + DLB internal fraud rules (prior block, new payee,
 *              amount, 24h velocity) + optional Sardine fraud / AML risk
 *              (POST /v1/customers) -> a screening_ref with status
 *              clear | review | blocked
 *   review()   checker step for status=review: a distinct reviewer (optionally
 *              on FRAUD_COMPLIANCE_REVIEWERS) clears or blocks it
 *   verify()   is this screening_ref a live, clear, unexpired, unconsumed
 *              screening for exactly this amount / bank / payee?
 *              consume=true marks it used (single use per settlement)
 *
 * BankSettlementEngine.clearAndSettle() calls verify({ consume: true }) for
 * every live settlement when FRAUD_COMPLIANCE_ENFORCE_SETTLEMENT=true, so a
 * live Unit / Column / Increase / Lili settlement only leaves with a
 * screeningRef this engine issued.
 *
 * ClearingAgentOsEngine.submit() (Enterprise ODFI / Transfer API path) does the
 * same, and PaymentComplianceGate.verifyRecordedScreening() accepts FCS- refs.
 *
 * Nothing is `live` unless FRAUD_COMPLIANCE_LIVE=true and the sanctions list is
 * ready (COMPLIANCE_PROVIDER=ofac|opensanctions); with
 * FRAUD_COMPLIANCE_PROVIDER=sardine, Sardine credentials plus an explicit
 * SARDINE_BASE_URL are also required. Shadow screenings are recorded but can
 * never satisfy a live settlement.
 *
 * Env:
 *   FRAUD_COMPLIANCE_ENABLED            default true
 *   FRAUD_COMPLIANCE_LIVE               true to issue live screenings
 *   FRAUD_COMPLIANCE_PROVIDER           internal (default: DLB rules only) |
 *                                       sardine (DLB rules + Sardine)
 *   FRAUD_COMPLIANCE_REVIEW_AMOUNT_CENTS    review at/above (default 1000000 = $10k)
 *   FRAUD_COMPLIANCE_MAX_AMOUNT_CENTS       block above (default 0 = no cap)
 *   FRAUD_COMPLIANCE_VELOCITY_COUNT         review at N screenings / payee / 24h (default 5)
 *   FRAUD_COMPLIANCE_VELOCITY_CENTS         review at 24h payee total (default 5000000)
 *   FRAUD_COMPLIANCE_REVIEW_NEW_PAYEES      true (default): first payment to a payee needs review
 *   FRAUD_COMPLIANCE_TTL_MINUTES        validity of a clear screening (default 60)
 *   FRAUD_COMPLIANCE_ENFORCE_SETTLEMENT true: live settlements must present a
 *                                       verified, unconsumed screeningRef
 *   FRAUD_COMPLIANCE_REVIEWERS          comma list of identities allowed to review
 *   SARDINE_CLIENT_ID / SARDINE_CLIENT_SECRET   HTTP Basic credentials
 *   SARDINE_BASE_URL                    https://api.sardine.ai (live) |
 *                                       https://api.sandbox.sardine.ai (default)
 *   SARDINE_FLOW                        flow name sent to Sardine (default dlbtrust_payment)
 */

const crypto = require('crypto');
const { ComplianceEngine } = require('../compliance/complianceEngine');
const { EgressOsEngine } = require('./egressOsEngine');

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const SARDINE_SANDBOX_URL = 'https://api.sandbox.sardine.ai';
const SARDINE_LIVE_URL = 'https://api.sardine.ai';
const LIST_PROVIDERS = ['ofac', 'opensanctions'];
const FRAUD_PROVIDERS = ['internal', 'sardine'];
const STATUSES = ['clear', 'review', 'blocked', 'consumed'];
const ACTIONS = ['screen', 'review', 'verify', 'get', 'list', 'status', 'readiness'];
const RANK = { clear: 0, review: 1, blocked: 2 };
const LEVEL_STATUS = { low: 'clear', medium: 'review', high: 'review', very_high: 'blocked' };

class FraudComplianceError extends Error {
  constructor(message, code, status = 400, details = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function bool(v, dflt = false) {
  if (v === undefined || v === null || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}
function lower(v) {
  return v ? String(v).trim().toLowerCase() : null;
}
function list(v) {
  return String(v || '').split(',').map((s) => lower(s)).filter(Boolean);
}
function newId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}
function digits(v) {
  return String(v || '').replace(/\D/g, '');
}
function worst(...statuses) {
  return statuses.filter(Boolean).reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'clear');
}

function nonNegative(v, dflt) {
  const n = Number(v);
  return v === undefined || v === null || v === '' || !Number.isFinite(n) || n < 0 ? dflt : Math.floor(n);
}

/**
 * DLB internal fraud rules over the screening history in Cloud SQL.
 * history: { blocked, trusted, dayCount, dayCents } for this payee hash.
 */
function evaluateInternalRules({ payee, amountCents, rail, history, rules }) {
  const hits = [];
  const hit = (rule, status, detail) => hits.push({ rule, status, detail });
  if (history.blocked > 0) hit('prior_block', 'blocked', `payee has ${history.blocked} blocked screening(s)`);
  if (rules.maxAmountCents > 0 && amountCents > rules.maxAmountCents) hit('max_amount', 'blocked', `amount ${amountCents} > FRAUD_COMPLIANCE_MAX_AMOUNT_CENTS ${rules.maxAmountCents}`);
  if (rules.reviewAmountCents > 0 && amountCents >= rules.reviewAmountCents) hit('review_amount', 'review', `amount ${amountCents} >= ${rules.reviewAmountCents}`);
  if (rules.reviewNewPayees && history.trusted === 0) hit('new_payee', 'review', 'no prior reviewed or settled screening for this payee');
  if (rules.velocityCount > 0 && history.dayCount + 1 >= rules.velocityCount) hit('velocity_count', 'review', `${history.dayCount + 1} screenings for this payee in 24h`);
  if (rules.velocityCents > 0 && history.dayCents + amountCents >= rules.velocityCents) hit('velocity_amount', 'review', `${history.dayCents + amountCents} cents to this payee in 24h`);
  if (['ach', 'wire'].includes(rail) && (!payee.routingNumber || !payee.accountNumber)) hit('bank_details', 'review', `${rail} payee without routing / account number`);
  const status = worst(...hits.map((h) => h.status));
  return {
    status,
    level: status === 'blocked' ? 'very_high' : status === 'review' ? 'medium' : 'low',
    amlLevel: null,
    sessionKey: null,
    reasons: hits.map((h) => `internal:${h.rule} (${h.detail})`),
    summary: { rules: hits.map(({ rule, status: st }) => ({ rule, status: st })), history },
  };
}

function getFraudComplianceConfig(env = process.env) {
  const explicitBaseUrl = String(env.SARDINE_BASE_URL || '').trim().replace(/\/+$/, '');
  return {
    enabled: bool(env.FRAUD_COMPLIANCE_ENABLED, true),
    live: bool(env.FRAUD_COMPLIANCE_LIVE, false),
    provider: lower(env.FRAUD_COMPLIANCE_PROVIDER) || 'internal',
    ttlMinutes: Math.max(1, Number(env.FRAUD_COMPLIANCE_TTL_MINUTES) || 60),
    enforceSettlement: bool(env.FRAUD_COMPLIANCE_ENFORCE_SETTLEMENT, false),
    reviewers: list(env.FRAUD_COMPLIANCE_REVIEWERS),
    sanctionsProvider: lower(env.COMPLIANCE_PROVIDER) || 'local',
    rules: {
      reviewAmountCents: nonNegative(env.FRAUD_COMPLIANCE_REVIEW_AMOUNT_CENTS, 1000000),
      maxAmountCents: nonNegative(env.FRAUD_COMPLIANCE_MAX_AMOUNT_CENTS, 0),
      velocityCount: nonNegative(env.FRAUD_COMPLIANCE_VELOCITY_COUNT, 5),
      velocityCents: nonNegative(env.FRAUD_COMPLIANCE_VELOCITY_CENTS, 5000000),
      reviewNewPayees: bool(env.FRAUD_COMPLIANCE_REVIEW_NEW_PAYEES, true),
    },
    sardine: {
      clientId: String(env.SARDINE_CLIENT_ID || '').trim(),
      clientSecret: String(env.SARDINE_CLIENT_SECRET || '').trim(),
      baseUrl: explicitBaseUrl || SARDINE_SANDBOX_URL,
      explicitBaseUrl: Boolean(explicitBaseUrl),
      flow: String(env.SARDINE_FLOW || 'dlbtrust_payment').trim(),
    },
  };
}

/** Normalized payee identity; only its hash and last4 are stored. */
function normalizePayee(payee = {}) {
  const name = String(payee.name || payee.fullName || payee.businessName || '').trim();
  const routingNumber = digits(payee.routingNumber || payee.routing);
  const accountNumber = digits(payee.accountNumber || payee.account);
  const type = payee.businessName || lower(payee.type) === 'business' ? 'business' : 'individual';
  return {
    name,
    type,
    routingNumber,
    accountNumber,
    country: String(payee.country || 'US').toUpperCase(),
    email: payee.email || null,
  };
}

function payeeHash(p) {
  if (!p.name && !p.accountNumber) return null;
  return crypto.createHash('sha256')
    .update(`${p.name.toLowerCase().replace(/\s+/g, ' ')}|${p.routingNumber}|${p.accountNumber}`)
    .digest('hex');
}

/** Deterministic UUID-shaped customer id for Sardine (no PII in the id). */
function sardineCustomerId(hash) {
  const h = hash || crypto.randomBytes(16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: parts[0] || undefined, lastName: undefined };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function buildSardineRequest({ screeningRef, payee, amountCents, rail, cfg }) {
  const hash = payeeHash(payee);
  const customer = { id: sardineCustomerId(hash) };
  if (payee.type === 'individual') Object.assign(customer, splitName(payee.name));
  else customer.businessName = payee.name;
  if (payee.email) customer.emailAddress = payee.email;
  customer.address = { countryCode: payee.country };
  return {
    flow: `${cfg.sardine.flow}_${rail || 'ach'}`,
    sessionKey: crypto.randomUUID(),
    customer,
    transaction: {
      id: screeningRef,
      status: 'pending',
      createdAtMillis: Date.now(),
      amount: amountCents / 100,
      currencyCode: 'USD',
      actionType: 'withdraw',
      paymentMethod: {
        type: 'bank',
        bank: {
          accountNumber: payee.accountNumber || undefined,
          routingNumber: payee.routingNumber || undefined,
          accountType: 'checking',
        },
      },
    },
  };
}

function parseSardineResponse(body = {}) {
  if (!body || typeof body !== 'object') throw new FraudComplianceError('Sardine returned a non-JSON response', 'FRAUD_PROVIDER_BAD_RESPONSE', 502);
  if (body.status && String(body.status).toLowerCase() !== 'success') {
    throw new FraudComplianceError(`Sardine risk call failed: status ${body.status}`, 'FRAUD_PROVIDER_FAILED', 502);
  }
  const level = lower(body.level);
  if (!level || !LEVEL_STATUS[level]) throw new FraudComplianceError('Sardine response carried no risk level', 'FRAUD_PROVIDER_BAD_RESPONSE', 502);
  const amlLevel = lower(body.transaction && body.transaction.amlLevel);
  const txLevel = lower(body.transaction && body.transaction.level);
  const status = worst(LEVEL_STATUS[level], LEVEL_STATUS[amlLevel], LEVEL_STATUS[txLevel]);
  const reasons = [];
  const signals = (body.customer && Array.isArray(body.customer.signals)) ? body.customer.signals : [];
  for (const s of signals) {
    if (s && ['high', 'very_high'].includes(lower(s.value))) reasons.push(`sardine:${s.key}=${s.value}`);
  }
  if (LEVEL_STATUS[level] !== 'clear') reasons.push(`sardine:level=${level}`);
  if (amlLevel && LEVEL_STATUS[amlLevel] !== 'clear') reasons.push(`sardine:amlLevel=${amlLevel}`);
  return {
    status,
    level,
    amlLevel: amlLevel || null,
    sessionKey: body.sessionKey || null,
    score: body.customer && body.customer.score !== undefined ? Number(body.customer.score) : null,
    reasons,
    summary: {
      level,
      status: body.status || null,
      customer: body.customer ? { score: body.customer.score, level: body.customer.level } : null,
      transaction: body.transaction ? { level: body.transaction.level, amlLevel: body.transaction.amlLevel } : null,
    },
  };
}

function rowToScreening(row) {
  if (!row) return null;
  const json = (v, d) => (typeof v === 'string' ? JSON.parse(v) : (v || d));
  return {
    screeningRef: row.screening_ref,
    status: row.status,
    mode: row.mode,
    rail: row.rail,
    bankId: row.bank_id,
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    payee: { name: row.payee_name, type: row.payee_type, last4: row.payee_last4, country: row.payee_country },
    approvalRef: row.approval_ref,
    reference: row.reference,
    sanctions: { screeningId: row.sanctions_screening_id, status: row.sanctions_status, provider: row.sanctions_provider },
    fraud: { provider: row.fraud_provider, status: row.fraud_status, level: row.fraud_level, amlLevel: row.fraud_aml_level, sessionKey: row.fraud_session_key, summary: json(row.fraud_response, {}) },
    reasons: json(row.reasons, []),
    requestedBy: row.requested_by,
    reviewedBy: row.reviewed_by,
    reviewNotes: row.review_notes,
    reviewedAt: row.reviewed_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    consumedBy: row.consumed_by,
    createdAt: row.created_at,
  };
}

const FraudComplianceOsEngine = {
  name: 'fraud-compliance',
  ACTIONS,
  STATUSES,

  async ensureTables() {
    if (!pool) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS fraud_compliance_screenings (
      screening_ref          VARCHAR(64) PRIMARY KEY,
      status                 VARCHAR(16) NOT NULL,
      mode                   VARCHAR(8) NOT NULL,
      rail                   VARCHAR(24),
      bank_id                VARCHAR(64),
      amount_cents           BIGINT NOT NULL,
      currency               VARCHAR(3) NOT NULL DEFAULT 'USD',
      payee_name             VARCHAR(200),
      payee_type             VARCHAR(16),
      payee_hash             VARCHAR(64),
      payee_last4            VARCHAR(4),
      payee_country          VARCHAR(2),
      approval_ref           VARCHAR(128),
      reference              VARCHAR(128),
      sanctions_screening_id VARCHAR(64),
      sanctions_status       VARCHAR(16),
      sanctions_provider     VARCHAR(32),
      fraud_provider         VARCHAR(32),
      fraud_status           VARCHAR(16),
      fraud_level            VARCHAR(16),
      fraud_aml_level        VARCHAR(16),
      fraud_session_key      VARCHAR(64),
      fraud_response         JSONB NOT NULL DEFAULT '{}'::jsonb,
      reasons                JSONB NOT NULL DEFAULT '[]'::jsonb,
      requested_by           VARCHAR(160) NOT NULL,
      reviewed_by            VARCHAR(160),
      review_notes           TEXT,
      reviewed_at            TIMESTAMPTZ,
      expires_at             TIMESTAMPTZ NOT NULL,
      consumed_at            TIMESTAMPTZ,
      consumed_by            VARCHAR(128),
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_fraud_compliance_screenings_status ON fraud_compliance_screenings (status, created_at DESC)');
    await pool.query(`CREATE TABLE IF NOT EXISTS fraud_compliance_events (
      event_id      VARCHAR(64) PRIMARY KEY,
      screening_ref VARCHAR(64),
      event_type    VARCHAR(48) NOT NULL,
      actor         VARCHAR(160),
      detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  },

  async _event(screeningRef, eventType, actor, detail = {}) {
    if (!pool) return;
    await pool.query(
      'INSERT INTO fraud_compliance_events (event_id, screening_ref, event_type, actor, detail) VALUES ($1,$2,$3,$4,$5)',
      [newId('FCE'), screeningRef, eventType, actor || null, JSON.stringify(detail)]
    ).catch(() => {});
  },

  async _payeeHistory(hash) {
    const empty = { blocked: 0, trusted: 0, dayCount: 0, dayCents: 0 };
    if (!pool || !hash) return empty;
    const r = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked,
              COUNT(*) FILTER (WHERE status IN ('clear', 'consumed') AND (reviewed_by IS NOT NULL OR consumed_at IS NOT NULL))::int AS trusted,
              COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS day_count,
              COALESCE(SUM(amount_cents) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours' AND status <> 'blocked'), 0)::bigint AS day_cents
         FROM fraud_compliance_screenings WHERE payee_hash = $1`,
      [hash]
    );
    const row = r.rows[0] || {};
    return { blocked: Number(row.blocked) || 0, trusted: Number(row.trusted) || 0, dayCount: Number(row.day_count) || 0, dayCents: Number(row.day_cents) || 0 };
  },

  sardineConfigured(cfg = getFraudComplianceConfig()) {
    return Boolean(cfg.sardine.clientId && cfg.sardine.clientSecret);
  },

  enforcesSettlement(cfg = getFraudComplianceConfig()) {
    return cfg.enabled && cfg.enforceSettlement;
  },

  async _sardine(request, cfg) {
    const url = `${cfg.sardine.baseUrl}/v1/customers`;
    await EgressOsEngine.authorize(url, { caller: 'fraud-compliance', record: false });
    const auth = Buffer.from(`${cfg.sardine.clientId}:${cfg.sardine.clientSecret}`).toString('base64');
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Basic ${auth}` },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      throw new FraudComplianceError(`Sardine unreachable: ${e.message}`, 'FRAUD_PROVIDER_UNREACHABLE', 503);
    }
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!res.ok) {
      const msg = (body && (body.message || body.error)) || `HTTP ${res.status}`;
      throw new FraudComplianceError(`Sardine rejected the risk request: ${msg}`, 'FRAUD_PROVIDER_REJECTED', res.status === 401 || res.status === 403 ? 503 : 502);
    }
    return parseSardineResponse(body);
  },

  /** Maker step: run sanctions + fraud checks and record a bound screening. */
  async screen({ payee = {}, amountCents, amount, rail = 'ach', bankId = null, approvalRef = null, reference = null, actor = null } = {}) {
    const cfg = getFraudComplianceConfig();
    if (!cfg.enabled) throw new FraudComplianceError('FRAUD_COMPLIANCE_ENABLED=false', 'FRAUD_COMPLIANCE_DISABLED', 503);
    if (!pool) throw new FraudComplianceError('ledger database not connected', 'FRAUD_COMPLIANCE_DB', 503);
    if (!actor) throw new FraudComplianceError('actor (requesting identity) required', 'FRAUD_COMPLIANCE_UNAUTHENTICATED', 401);
    const cents = amountCents !== undefined ? Number(amountCents) : Math.round(Number(amount) * 100);
    if (!Number.isInteger(cents) || cents <= 0) throw new FraudComplianceError('amountCents must be a positive integer', 'FRAUD_COMPLIANCE_BAD_REQUEST', 400);
    const p = normalizePayee(payee);
    if (!p.name) throw new FraudComplianceError('payee.name required', 'FRAUD_COMPLIANCE_BAD_REQUEST', 400);
    if (p.country !== 'US') throw new FraudComplianceError(`payee country ${p.country} refused: USA-only processing`, 'FRAUD_COMPLIANCE_NON_US', 422);

    const live = cfg.live;
    const screeningRef = newId('FCS');
    const reasons = [];

    if (live) {
      if (!LIST_PROVIDERS.includes(cfg.sanctionsProvider)) {
        throw new FraudComplianceError(`live screening requires COMPLIANCE_PROVIDER=ofac|opensanctions (is ${cfg.sanctionsProvider})`, 'FRAUD_COMPLIANCE_NOT_READY', 503);
      }
      await ComplianceEngine.assertPaymentReady();
      if (!FRAUD_PROVIDERS.includes(cfg.provider)) throw new FraudComplianceError(`live screening requires FRAUD_COMPLIANCE_PROVIDER=${FRAUD_PROVIDERS.join('|')}`, 'FRAUD_COMPLIANCE_NOT_READY', 503);
      if (cfg.provider === 'sardine') {
        if (!this.sardineConfigured(cfg)) throw new FraudComplianceError('live screening requires SARDINE_CLIENT_ID and SARDINE_CLIENT_SECRET', 'FRAUD_COMPLIANCE_NOT_READY', 503);
        if (!cfg.sardine.explicitBaseUrl) throw new FraudComplianceError(`live screening requires an explicit SARDINE_BASE_URL (${SARDINE_LIVE_URL})`, 'FRAUD_COMPLIANCE_NOT_READY', 503);
      }
    }

    let sanctions;
    try {
      const s = await ComplianceEngine.screen({
        type: 'combined',
        entityType: p.type,
        fullName: p.type === 'individual' ? p.name : undefined,
        businessName: p.type === 'business' ? p.name : undefined,
        email: p.email || undefined,
        bankAccount: p.accountNumber || undefined,
        routingNumber: p.routingNumber || undefined,
        country: p.country,
        amount: cents / 100,
        screenedBy: actor,
        notes: `fraud-compliance ${screeningRef}${reference ? `; reference ${reference}` : ''}`,
      });
      sanctions = { screeningId: s.screening_id, status: s.status, provider: s.provider };
      if (s.status !== 'clear') reasons.push(`sanctions:${s.status} (risk ${s.risk_level})`);
    } catch (e) {
      if (live) throw e;
      sanctions = { screeningId: null, status: 'review', provider: cfg.sanctionsProvider };
      reasons.push(`sanctions unavailable: ${e.message}`);
    }

    const internal = FRAUD_PROVIDERS.includes(cfg.provider)
      ? evaluateInternalRules({ payee: p, amountCents: cents, rail, history: await this._payeeHistory(payeeHash(p)), rules: cfg.rules })
      : { status: 'review', level: null, amlLevel: null, sessionKey: null, reasons: [`fraud provider ${cfg.provider} not supported`], summary: {} };
    reasons.push(...internal.reasons);
    let fraud = { provider: 'internal', ...internal };
    if (cfg.provider === 'sardine') {
      let sardine;
      if (this.sardineConfigured(cfg)) {
        try {
          sardine = await this._sardine(buildSardineRequest({ screeningRef, payee: p, amountCents: cents, rail, cfg }), cfg);
        } catch (e) {
          if (live) throw e;
          sardine = { status: 'review', level: null, amlLevel: null, sessionKey: null, reasons: [`sardine unavailable: ${e.message}`], summary: { error: e.message } };
        }
      } else {
        sardine = { status: 'review', level: null, amlLevel: null, sessionKey: null, reasons: ['sardine not configured'], summary: { note: 'SARDINE_CLIENT_ID / SARDINE_CLIENT_SECRET not set' } };
      }
      reasons.push(...sardine.reasons);
      fraud = {
        provider: 'internal+sardine',
        status: worst(internal.status, sardine.status),
        level: sardine.level,
        amlLevel: sardine.amlLevel,
        sessionKey: sardine.sessionKey,
        summary: { internal: internal.summary, sardine: sardine.summary },
      };
    }

    const status = worst(sanctions.status, fraud.status);
    const expiresAt = new Date(Date.now() + cfg.ttlMinutes * 60000);
    await pool.query(
      `INSERT INTO fraud_compliance_screenings
        (screening_ref, status, mode, rail, bank_id, amount_cents, currency, payee_name, payee_type, payee_hash, payee_last4, payee_country,
         approval_ref, reference, sanctions_screening_id, sanctions_status, sanctions_provider, fraud_provider, fraud_status, fraud_level,
         fraud_aml_level, fraud_session_key, fraud_response, reasons, requested_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'USD',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [screeningRef, status, live ? 'live' : 'shadow', rail, bankId, cents, p.name, p.type, payeeHash(p), p.accountNumber ? p.accountNumber.slice(-4) : null, p.country,
        approvalRef, reference, sanctions.screeningId, sanctions.status, sanctions.provider, fraud.provider, fraud.status, fraud.level,
        fraud.amlLevel, fraud.sessionKey, JSON.stringify(fraud.summary || {}), JSON.stringify(reasons), actor, expiresAt]
    );
    await this._event(screeningRef, `screening.${status}`, actor, { mode: live ? 'live' : 'shadow', amountCents: cents, bankId, rail, reasons });
    return this.getScreening(screeningRef);
  },

  /** Checker step: a distinct reviewer resolves a screening in review. */
  async review({ screeningRef, decision, notes = null, actor = null } = {}) {
    const cfg = getFraudComplianceConfig();
    if (!actor) throw new FraudComplianceError('actor (reviewer identity) required', 'FRAUD_COMPLIANCE_UNAUTHENTICATED', 401);
    if (!['clear', 'block'].includes(decision)) throw new FraudComplianceError('decision must be clear|block', 'FRAUD_COMPLIANCE_BAD_REQUEST', 400);
    const row = await this._row(screeningRef);
    if (row.status !== 'review') throw new FraudComplianceError(`screening ${screeningRef} is ${row.status}; only review screenings can be reviewed`, 'FRAUD_COMPLIANCE_STATE', 409);
    const reviewer = lower(actor);
    if (reviewer === lower(row.requested_by)) throw new FraudComplianceError('reviewer must differ from the requester (maker/checker)', 'FRAUD_COMPLIANCE_SAME_ACTOR', 403);
    if (cfg.reviewers.length && !cfg.reviewers.includes(reviewer)) throw new FraudComplianceError(`${actor} is not on FRAUD_COMPLIANCE_REVIEWERS`, 'FRAUD_COMPLIANCE_FORBIDDEN', 403);
    if (decision === 'clear' && !row.sanctions_screening_id) {
      throw new FraudComplianceError('cannot clear: no sanctions screening was recorded; re-screen once the sanctions list is ready', 'FRAUD_COMPLIANCE_STATE', 409);
    }
    if (decision === 'clear' && row.mode === 'live' && !row.fraud_level) {
      throw new FraudComplianceError('cannot clear a live screening without a fraud-provider result; re-screen', 'FRAUD_COMPLIANCE_STATE', 409);
    }
    const next = decision === 'clear' ? 'clear' : 'blocked';
    if (row.sanctions_screening_id && row.sanctions_status === 'review') {
      if (next === 'clear') await ComplianceEngine.approve(row.sanctions_screening_id, { reviewedBy: actor, notes: `fraud-compliance review ${screeningRef}` });
      else await ComplianceEngine.block(row.sanctions_screening_id, { reviewedBy: actor, notes: `fraud-compliance review ${screeningRef}` });
    }
    const expiresAt = new Date(Date.now() + cfg.ttlMinutes * 60000);
    const r = await pool.query(
      `UPDATE fraud_compliance_screenings SET status=$2, reviewed_by=$3, review_notes=$4, reviewed_at=NOW(), expires_at=$5, updated_at=NOW()
       WHERE screening_ref=$1 AND status='review' RETURNING *`,
      [screeningRef, next, actor, notes, expiresAt]
    );
    if (!r.rows[0]) throw new FraudComplianceError(`screening ${screeningRef} changed state during review`, 'FRAUD_COMPLIANCE_STATE', 409);
    await this._event(screeningRef, `screening.reviewed.${next}`, actor, { notes });
    return rowToScreening(r.rows[0]);
  },

  /**
   * Gate used by settlement: the screening must be clear, live (unless
   * requireLive=false), unexpired, unconsumed and bound to this amount / bank /
   * payee. consume=true atomically marks it used by `consumer`.
   */
  async verify({ screeningRef, amountCents, bankId = null, payee = null, requireLive = true, consume = false, consumer = null } = {}) {
    if (!screeningRef) throw new FraudComplianceError('screeningRef required', 'FRAUD_COMPLIANCE_REQUIRED', 409);
    if (!pool) throw new FraudComplianceError('ledger database not connected', 'FRAUD_COMPLIANCE_DB', 503);
    const row = await this._row(screeningRef, 409);
    const refuse = (msg) => { throw new FraudComplianceError(`screeningRef ${screeningRef} ${msg}`, 'FRAUD_COMPLIANCE_REFUSED', 409); };
    if (row.status === 'consumed' || row.consumed_at) refuse(`was already used by ${row.consumed_by || 'another settlement'}`);
    if (row.status !== 'clear') refuse(`is ${row.status}, not clear`);
    if (requireLive && row.mode !== 'live') refuse('is a shadow screening and cannot authorize a live settlement');
    if (new Date(row.expires_at).getTime() <= Date.now()) refuse(`expired at ${new Date(row.expires_at).toISOString()}`);
    if (amountCents !== undefined && Number(row.amount_cents) !== Number(amountCents)) refuse(`was screened for ${row.amount_cents} cents, not ${amountCents}`);
    if (row.bank_id && bankId && row.bank_id !== bankId) refuse(`was screened for settlement bank ${row.bank_id}, not ${bankId}`);
    if (payee && row.payee_hash) {
      const h = payeeHash(normalizePayee(payee));
      if (h && h !== row.payee_hash) refuse('was screened for a different payee');
    }
    if (!consume) return rowToScreening(row);
    const r = await pool.query(
      `UPDATE fraud_compliance_screenings SET status='consumed', consumed_at=NOW(), consumed_by=$2, updated_at=NOW()
       WHERE screening_ref=$1 AND status='clear' AND consumed_at IS NULL AND expires_at > NOW() RETURNING *`,
      [screeningRef, consumer || 'settlement']
    );
    if (!r.rows[0]) refuse('could not be consumed (used or expired concurrently)');
    await this._event(screeningRef, 'screening.consumed', consumer || 'settlement', { amountCents: Number(row.amount_cents), bankId });
    return rowToScreening(r.rows[0]);
  },

  async _row(screeningRef, notFoundStatus = 404) {
    if (!pool) throw new FraudComplianceError('ledger database not connected', 'FRAUD_COMPLIANCE_DB', 503);
    const r = await pool.query('SELECT * FROM fraud_compliance_screenings WHERE screening_ref = $1', [screeningRef]);
    if (!r.rows[0]) throw new FraudComplianceError(`screening ${screeningRef} not found`, 'FRAUD_COMPLIANCE_NOT_FOUND', notFoundStatus);
    return r.rows[0];
  },

  async getScreening(screeningRef) {
    return rowToScreening(await this._row(screeningRef));
  },

  async listScreenings({ status, limit = 50 } = {}) {
    if (!pool) return [];
    const n = Math.min(500, Math.max(1, Number(limit) || 50));
    const r = status && STATUSES.includes(status)
      ? await pool.query('SELECT * FROM fraud_compliance_screenings WHERE status = $1 ORDER BY created_at DESC LIMIT $2', [status, n])
      : await pool.query('SELECT * FROM fraud_compliance_screenings ORDER BY created_at DESC LIMIT $1', [n]);
    return r.rows.map(rowToScreening);
  },

  async status() {
    const cfg = getFraudComplianceConfig();
    const counts = {};
    if (pool) {
      const r = await pool.query('SELECT status, mode, COUNT(*)::int AS n FROM fraud_compliance_screenings GROUP BY status, mode').catch(() => ({ rows: [] }));
      for (const row of r.rows) counts[`${row.mode}:${row.status}`] = row.n;
    }
    return {
      engine: 'fraud-compliance',
      enabled: cfg.enabled,
      live: cfg.live,
      sanctions: { provider: cfg.sanctionsProvider, engine: 'ComplianceEngine' },
      fraud: {
        provider: cfg.provider,
        rules: cfg.rules,
        configured: cfg.provider === 'sardine' ? this.sardineConfigured(cfg) : FRAUD_PROVIDERS.includes(cfg.provider),
        baseUrl: cfg.provider === 'sardine' ? cfg.sardine.baseUrl : null,
        sandbox: cfg.provider === 'sardine' ? cfg.sardine.baseUrl === SARDINE_SANDBOX_URL : null,
        marketplace: cfg.provider === 'sardine' ? 'Google Cloud Marketplace: Sardine Fraud and Compliance Operating Suite' : null,
      },
      workflow: {
        screen: 'POST /api/transfer/v1/screenings (API Gateway) | POST /api/payment-server/v1/fraud-compliance/screenings (service) | /api/os/fraud-compliance/process action=screen (portal)',
        review: 'POST /api/transfer/v1/screenings/{ref}/review | /api/os/fraud-compliance/process action=review (distinct reviewer)',
        settle: 'POST /api/payment-server/v1/settlements | POST /api/transfer/v1/transfers (Enterprise ODFI -> Clearing Agent) { approvalRef, screeningRef }',
      },
      policy: {
        ttlMinutes: cfg.ttlMinutes,
        enforceSettlement: cfg.enforceSettlement,
        singleUse: true,
        boundTo: ['amountCents', 'bankId', 'payee'],
        distinctReviewer: true,
        reviewers: cfg.reviewers,
        usaOnly: true,
      },
      screenings: counts,
    };
  },

  async health() {
    const cfg = getFraudComplianceConfig();
    return { ok: cfg.enabled, engine: 'fraud-compliance', ledger: Boolean(pool), fraudProvider: cfg.provider, sardineConfigured: this.sardineConfigured(cfg) };
  },

  async readiness() {
    const cfg = getFraudComplianceConfig();
    const s = await this.status();
    const blockers = [];
    if (!cfg.enabled) blockers.push('FRAUD_COMPLIANCE_ENABLED=false');
    if (!pool) blockers.push('ledger database not connected');
    if (!LIST_PROVIDERS.includes(cfg.sanctionsProvider)) blockers.push(`COMPLIANCE_PROVIDER=${cfg.sanctionsProvider}: live screening needs ofac or opensanctions`);
    else {
      let sanctions;
      try { sanctions = await ComplianceEngine.readiness(); } catch (e) { sanctions = { ready: false, issues: [e.message] }; }
      if (!sanctions.ready) blockers.push(...(sanctions.issues && sanctions.issues.length ? sanctions.issues : ['sanctions list not ready']).map((i) => `sanctions: ${i}`));
    }
    if (!FRAUD_PROVIDERS.includes(cfg.provider)) blockers.push(`FRAUD_COMPLIANCE_PROVIDER=${cfg.provider}: live screening needs ${FRAUD_PROVIDERS.join(' or ')}`);
    else if (cfg.provider === 'sardine') {
      if (!cfg.sardine.clientId) blockers.push('SARDINE_CLIENT_ID not set');
      if (!cfg.sardine.clientSecret) blockers.push('SARDINE_CLIENT_SECRET not set');
      if (!cfg.sardine.explicitBaseUrl) blockers.push(`SARDINE_BASE_URL not set (defaults to sandbox ${SARDINE_SANDBOX_URL}; live is ${SARDINE_LIVE_URL})`);
    }
    if (!cfg.live) blockers.push('FRAUD_COMPLIANCE_LIVE not true');
    if (!cfg.enforceSettlement) blockers.push('FRAUD_COMPLIANCE_ENFORCE_SETTLEMENT not true (live settlements accept any screeningRef)');
    const live = blockers.length === 0;
    return { ready: live, mode: live ? 'live' : 'shadow', blockers, status: s };
  },

  async list({ limit = 50, status } = {}) {
    return this.listScreenings({ limit, status });
  },

  async get(id) {
    try { return await this.getScreening(id); } catch { return null; }
  },

  /** OS-route entry: actor is stamped by routes/os.js from the authenticated portal identity. */
  async process({ action, actor = null, ...body } = {}) {
    switch (action) {
      case 'screen': return this.screen({ ...body, actor });
      case 'review': return this.review({ ...body, actor });
      case 'verify': return this.verify({ ...body, consume: false });
      case 'get': return this.getScreening(body.screeningRef);
      case 'list': return this.listScreenings(body);
      case 'status': return this.status();
      case 'readiness': return this.readiness();
      default: throw new FraudComplianceError(`action must be ${ACTIONS.join('|')}`, 'FRAUD_COMPLIANCE_BAD_ACTION', 400);
    }
  },
};

module.exports = {
  FraudComplianceOsEngine,
  FraudComplianceError,
  getFraudComplianceConfig,
  buildSardineRequest,
  evaluateInternalRules,
  parseSardineResponse,
  normalizePayee,
  payeeHash,
  SARDINE_SANDBOX_URL,
  SARDINE_LIVE_URL,
};
