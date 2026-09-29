'use strict';

/**
 * Transfer API OS (single transfer facade behind GCP API Gateway)
 *
 * One versioned REST surface — /api/transfer/v1 — through which trust
 * distributions, disbursements, vendor payouts and trustee expenses are
 * submitted and released. It does not move money itself: every call is
 * delegated to the Enterprise ODFI OS (maker/checker originator profile,
 * approval + screening refs, deterministic rail validation) which releases
 * through the Clearing Agent to a verified network. The facade adds
 *
 *   - GCP API Gateway in front (infra/gcp/transfer_api.tf): Google ID-token or
 *     API-key authentication at the edge, per-minute quotas, request logging,
 *     one hostname for maker/checker clients; the gateway calls Cloud Run with
 *     its own service-account identity through IAP;
 *   - caller identity taken from the gateway's verified user-info header ONLY
 *     when the request provably came through the gateway (IAP principal is the
 *     gateway service account); portal JWT / admin callers are honoured as-is;
 *   - mandatory Idempotency-Key on every write, with stored-response replay;
 *   - an audit row per request (no account numbers; Enterprise ODFI holds the
 *     encrypted instructions).
 *
 * The engine reports LIVE only when the gateway is configured, its service
 * account is on the private-access platform list, and the Enterprise ODFI OS
 * itself is live (i.e. a verified external sponsor network exists).
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');
const { EnterpriseOdfiOsEngine, PURPOSE_CLASSES } = require('./enterpriseOdfiOsEngine');
const { redactPayload } = require('./clearingAgentOsEngine');

const API_VERSION = 'v1';
const USERINFO_HEADER = 'x-apigateway-api-userinfo';
const IDEMPOTENCY_HEADER = 'idempotency-key';
const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const WRITE_ACTIONS = ['transfer', 'release', 'cancel'];
const READ_ACTIONS = ['get', 'list', 'rails'];

class TransferApiError extends Error {
  constructor(message, code, statusCode = 400, details = {}) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
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
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function getTransferApiConfig(env = process.env) {
  return {
    enabled: bool(env.TRANSFER_API_ENABLED, true),
    live: bool(env.TRANSFER_API_LIVE, false),
    gatewayHost: lower(env.TRANSFER_API_GATEWAY_HOST),
    gatewayServiceAccount: lower(env.TRANSFER_API_GATEWAY_SERVICE_ACCOUNT),
    audience: String(env.TRANSFER_API_AUDIENCE || '').trim() || null,
    platformServiceAccounts: list(env.PRIVATE_ACCESS_SERVICE_ACCOUNTS),
    maxItems: Math.max(1, Number(env.TRANSFER_API_MAX_ITEMS) || 200),
  };
}

/** Decode API Gateway's base64url JSON user-info header (claims of the edge-verified ID token). */
function decodeUserInfo(header) {
  if (!header) return null;
  try {
    const raw = Buffer.from(String(header).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const claims = JSON.parse(raw);
    return claims && typeof claims === 'object' ? claims : null;
  } catch {
    return null;
  }
}

/**
 * Who is calling. Gateway identity counts only when IAP says the request was
 * made by the gateway's own service account; otherwise the header is ignored.
 */
function callerFromRequest(req, cfg = getTransferApiConfig()) {
  const pa = req.privateAccess || {};
  const viaGateway = cfg.gatewayServiceAccount && pa.kind === 'platform' && lower(pa.principal) === cfg.gatewayServiceAccount;
  if (viaGateway) {
    const claims = decodeUserInfo(req.headers[USERINFO_HEADER]);
    const email = lower(claims && (claims.email || claims.sub));
    if (email) return { email, via: 'api_gateway', gateway: cfg.gatewayServiceAccount };
    const key = req.headers['x-api-key'] || req.query?.key;
    if (key) return { email: 'api-key', via: 'api_gateway_key', gateway: cfg.gatewayServiceAccount };
    return null;
  }
  const u = req.user || {};
  const email = lower(u.email || u.username || u.userId || u.sub);
  return email ? { email, via: 'portal', gateway: null } : null;
}

function idempotencyKeyFromRequest(req) {
  const k = String(req.headers[IDEMPOTENCY_HEADER] || req.body?.idempotencyKey || '').trim();
  if (!IDEMPOTENCY_RE.test(k)) throw new TransferApiError('Idempotency-Key header required (8-128 chars: letters, digits, . _ : -)', 'TRANSFER_API_IDEMPOTENCY', 400);
  return k;
}

/** What callers see of an Enterprise ODFI batch. */
function publicTransfer(b) {
  if (!b) return null;
  return {
    transferId: b.batch_id,
    purposeClass: b.purpose_class,
    status: b.status,
    itemCount: b.item_count,
    totalCents: Number(b.total_cents),
    planner: b.planner,
    plannedBy: b.planned_by,
    releasedBy: b.released_by || null,
    releasedAt: b.released_at || null,
    error: b.error || null,
    createdAt: b.created_at,
    items: Array.isArray(b.items) ? b.items.map((it) => ({ itemId: it.item_id, status: it.status, amountCents: Number(it.amount_cents), creditorName: it.creditor_name, creditorLast4: it.creditor_last4, rail: it.rail, networkId: it.network_id, urgency: it.urgency, error: it.error || null })) : undefined,
  };
}

const TransferApiOsEngine = {
  name: 'transfer-api',
  API_VERSION,
  WRITE_ACTIONS,
  READ_ACTIONS,

  async ensureTables() {
    if (!pool) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS transfer_api_requests (
      request_id      VARCHAR(64) PRIMARY KEY,
      idempotency_key VARCHAR(128) NOT NULL UNIQUE,
      action          VARCHAR(24) NOT NULL,
      caller          VARCHAR(160) NOT NULL,
      via             VARCHAR(24) NOT NULL,
      transfer_id     VARCHAR(64),
      status_code     INT NOT NULL,
      response        JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  },

  async _replay(key) {
    if (!pool) return null;
    const r = await pool.query('SELECT * FROM transfer_api_requests WHERE idempotency_key = $1', [key]);
    return r.rows[0] || null;
  },
  async _record({ key, action, caller, transferId = null, statusCode, response }) {
    if (!pool) return;
    await pool.query(
      'INSERT INTO transfer_api_requests (request_id, idempotency_key, action, caller, via, transfer_id, status_code, response) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (idempotency_key) DO NOTHING',
      [newId('TAR'), key, action, caller.email, caller.via, transferId, statusCode, JSON.stringify(redactPayload(response))]
    );
  },

  _requireCaller(caller) {
    if (!caller || !caller.email) throw new TransferApiError('caller identity required (API Gateway ID token or portal session)', 'TRANSFER_API_UNAUTHENTICATED', 401);
    if (caller.via === 'api_gateway_key') throw new TransferApiError('API-key callers may read only; writes need a Google identity (maker/checker)', 'TRANSFER_API_FORBIDDEN', 403);
  },

  /**
   * Idempotent write: replays the stored response for a seen key (same action
   * required), otherwise runs fn and stores the outcome — including errors, so
   * a failed attempt is not silently retried with a new outcome.
   */
  async _write(action, key, caller, fn) {
    const cfg = getTransferApiConfig();
    if (!cfg.enabled) throw new TransferApiError('TRANSFER_API_ENABLED=false', 'TRANSFER_API_DISABLED', 503);
    if (!pool) throw new TransferApiError('ledger database not connected', 'TRANSFER_API_DB', 503);
    this._requireCaller(caller);
    const seen = await this._replay(key);
    if (seen) {
      if (seen.action !== action) throw new TransferApiError(`Idempotency-Key ${key} was used for action ${seen.action}`, 'TRANSFER_API_IDEMPOTENCY', 409);
      const resp = typeof seen.response === 'string' ? JSON.parse(seen.response) : seen.response;
      if (seen.status_code >= 400) throw new TransferApiError(resp.error || 'replayed failure', resp.code || 'TRANSFER_API_REPLAYED', seen.status_code, { replayed: true });
      return { ...resp, replayed: true };
    }
    try {
      const out = await fn();
      await this._record({ key, action, caller, transferId: out.transferId || null, statusCode: 200, response: out });
      return out;
    } catch (e) {
      const statusCode = e.statusCode || e.status || 400;
      await this._record({ key, action, caller, statusCode, response: { error: e.message, code: e.code || null } });
      throw e;
    }
  },

  /** transfer: maker submits approved + screened items -> planned Enterprise ODFI batch (nothing moves). */
  async transfer({ purposeClass, items = [], caller = null, idempotencyKey } = {}) {
    const cfg = getTransferApiConfig();
    return this._write('transfer', idempotencyKey, caller, async () => {
      if (!PURPOSE_CLASSES.includes(purposeClass)) throw new TransferApiError(`purposeClass must be one of ${PURPOSE_CLASSES.join(', ')}`, 'TRANSFER_API_BAD_REQUEST', 400);
      if (!Array.isArray(items) || !items.length) throw new TransferApiError('items required', 'TRANSFER_API_BAD_REQUEST', 400);
      if (items.length > cfg.maxItems) throw new TransferApiError(`items exceeds TRANSFER_API_MAX_ITEMS (${cfg.maxItems})`, 'TRANSFER_API_BAD_REQUEST', 400);
      const scoped = items.map((it, i) => ({ ...it, idempotencyKey: it.idempotencyKey || `${idempotencyKey}:${i + 1}` }));
      const b = await EnterpriseOdfiOsEngine.originate({ purposeClass, items: scoped, actor: caller.email });
      return publicTransfer(b);
    });
  },

  /** release: a distinct checker releases a planned transfer (the only money-moving call; delegated). */
  async release({ transferId, caller = null, idempotencyKey } = {}) {
    return this._write('release', idempotencyKey, caller, async () => {
      if (!transferId) throw new TransferApiError('transferId required', 'TRANSFER_API_BAD_REQUEST', 400);
      return publicTransfer(await EnterpriseOdfiOsEngine.release({ batchId: transferId, actor: caller.email }));
    });
  },

  async cancel({ transferId, reason = null, caller = null, idempotencyKey } = {}) {
    return this._write('cancel', idempotencyKey, caller, async () => {
      if (!transferId) throw new TransferApiError('transferId required', 'TRANSFER_API_BAD_REQUEST', 400);
      return publicTransfer(await EnterpriseOdfiOsEngine.cancel({ batchId: transferId, reason, actor: caller.email }));
    });
  },

  async getTransfer({ transferId } = {}) {
    return publicTransfer(await EnterpriseOdfiOsEngine.batch({ batchId: transferId }));
  },

  async listTransfers({ limit = 50 } = {}) {
    return (await EnterpriseOdfiOsEngine.batches({ limit })).map((b) => publicTransfer(b));
  },

  async rails() {
    return EnterpriseOdfiOsEngine.rails();
  },

  async status() {
    const cfg = getTransferApiConfig();
    const odfi = await EnterpriseOdfiOsEngine.status();
    let requests = { total: 0, byAction: {} };
    if (pool) {
      const r = await pool.query('SELECT action, COUNT(*)::int AS n FROM transfer_api_requests GROUP BY action').catch(() => ({ rows: [] }));
      for (const row of r.rows) { requests.byAction[row.action] = row.n; requests.total += row.n; }
    }
    return {
      engine: 'transfer-api',
      enabled: cfg.enabled,
      live: cfg.live,
      apiVersion: API_VERSION,
      gateway: {
        product: 'GCP API Gateway',
        host: cfg.gatewayHost,
        serviceAccount: cfg.gatewayServiceAccount,
        serviceAccountOnPlatformList: Boolean(cfg.gatewayServiceAccount && cfg.platformServiceAccounts.includes(cfg.gatewayServiceAccount)),
        audience: cfg.audience,
        edgeAuth: ['google_id_token (maker/checker Google identities)', 'api_key (read-only)'],
        backendAuth: 'gateway service-account OIDC token through IAP; caller identity from x-apigateway-api-userinfo',
      },
      routes: { base: `/api/transfer/${API_VERSION}`, resources: ['transfers', 'transfers/:id', 'transfers/:id/release', 'transfers/:id/cancel', 'rails', 'status'] },
      idempotency: { header: 'Idempotency-Key', required: true, replay: 'stored response (including failures)' },
      requests,
      delegate: { engine: 'enterprise-odfi', profile: odfi.profile, rails: odfi.rails, policy: odfi.policy },
      policy: { usaOnly: true, movesMoneyDirectly: false, writesRequireGoogleIdentity: true, makerChecker: 'enforced by enterprise-odfi (ENTERPRISE_ODFI_MAKERS / CHECKERS)', approvalAndScreeningRequired: true, isBank: false },
    };
  },

  async health() {
    const cfg = getTransferApiConfig();
    return { ok: cfg.enabled, engine: 'transfer-api', gatewayConfigured: Boolean(cfg.gatewayHost && cfg.gatewayServiceAccount) };
  },

  async readiness() {
    const cfg = getTransferApiConfig();
    const s = await this.status();
    const blockers = [];
    if (!cfg.enabled) blockers.push('TRANSFER_API_ENABLED=false');
    if (!cfg.gatewayHost) blockers.push('TRANSFER_API_GATEWAY_HOST not set (API Gateway not deployed; infra/gcp/transfer_api.tf)');
    if (!cfg.gatewayServiceAccount) blockers.push('TRANSFER_API_GATEWAY_SERVICE_ACCOUNT not set');
    else if (!s.gateway.serviceAccountOnPlatformList) blockers.push('gateway service account is not in PRIVATE_ACCESS_SERVICE_ACCOUNTS (IAP would refuse the gateway)');
    if (!cfg.audience) blockers.push('TRANSFER_API_AUDIENCE not set (ID-token audience accepted at the gateway)');
    const odfi = await EnterpriseOdfiOsEngine.readiness();
    if (!odfi.ready) blockers.push(...odfi.blockers.map((b) => `enterprise-odfi: ${b}`));
    if (!cfg.live) blockers.push('TRANSFER_API_LIVE not true');
    const live = blockers.length === 0;
    return { ready: live, mode: live ? 'live' : 'shadow', blockers, status: s };
  },

  async list({ limit = 50 } = {}) {
    if (!pool) return [];
    const r = await pool.query('SELECT request_id, idempotency_key, action, caller, via, transfer_id, status_code, created_at FROM transfer_api_requests ORDER BY created_at DESC LIMIT $1', [Math.min(500, Math.max(1, Number(limit) || 50))]);
    return r.rows;
  },

  async get(id) {
    if (!pool) return null;
    const r = await pool.query('SELECT * FROM transfer_api_requests WHERE request_id = $1', [id]);
    if (r.rows[0]) return r.rows[0];
    try { return await this.getTransfer({ transferId: id }); } catch { return null; }
  },

  /** OS-route entry: actor (portal identity) is stamped by routes/os.js. */
  async process({ action, actor = null, idempotencyKey, ...body } = {}) {
    const caller = actor ? { email: lower(actor), via: 'portal', gateway: null } : null;
    switch (action) {
      case 'transfer': return this.transfer({ ...body, caller, idempotencyKey: this._key(idempotencyKey) });
      case 'release': return this.release({ ...body, caller, idempotencyKey: this._key(idempotencyKey) });
      case 'cancel': return this.cancel({ ...body, caller, idempotencyKey: this._key(idempotencyKey) });
      case 'get': return this.getTransfer(body);
      case 'list': return this.listTransfers(body);
      case 'rails': return this.rails();
      default: throw new TransferApiError(`action must be ${[...WRITE_ACTIONS, ...READ_ACTIONS].join('|')}`, 'TRANSFER_API_BAD_ACTION', 400);
    }
  },
  _key(k) {
    const key = String(k || '').trim();
    if (!IDEMPOTENCY_RE.test(key)) throw new TransferApiError('idempotencyKey required (8-128 chars: letters, digits, . _ : -)', 'TRANSFER_API_IDEMPOTENCY', 400);
    return key;
  },
};

module.exports = {
  TransferApiOsEngine,
  TransferApiError,
  getTransferApiConfig,
  callerFromRequest,
  idempotencyKeyFromRequest,
  decodeUserInfo,
  publicTransfer,
  API_VERSION,
  USERINFO_HEADER,
  IDEMPOTENCY_HEADER,
};
