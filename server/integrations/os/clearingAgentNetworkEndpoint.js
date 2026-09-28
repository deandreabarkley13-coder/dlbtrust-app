'use strict';

/**
 * Private Electronic Payment Network — clearing-agent participant endpoint.
 *
 * This is the *network side* of the Clearing Agent OS protocol, served by the
 * trust's own PPN so the agent has a real, family-only counterparty:
 *
 *   POST <base>/handshake  { agentId, networkId, nonce, signature }
 *        -> { signature: HMAC(secret, networkId|agentId|nonce|'ack'), capabilities }
 *   POST <base>/clear      <bank-format body>  (X-Clearing-Format, X-Idempotency-Key)
 *        -> { reference, status: 'accepted', idempotent }
 *
 * Every request must carry the agent's HMAC request signature
 * (X-Clearing-Agent-Signature over agentId|METHOD|path|ts|sha256(body)) made
 * with the shared credential in PRIVATE_PAYMENT_NETWORK_AGENT_SECRET; only the
 * configured CLEARING_AGENT_ID is admitted; timestamps older than 5 minutes
 * are refused. The secret is never logged, persisted or returned. Accepting a
 * message here is a clearing receipt only: nothing is booked until the agent
 * posts the cleared instruction to Fineract.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');

const SKEW_MS = 5 * 60 * 1000;
const FORMATS = ['nacha', 'iso20022_pain001', 'iso20022_pacs008', 'fednow', 'rtp', 'bai2'];
const MAX_BODY_BYTES = 1024 * 1024;

class NetworkEndpointError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function sha256(x) { return crypto.createHash('sha256').update(x).digest('hex'); }
function hmac(secret, ...parts) { return crypto.createHmac('sha256', secret).update(parts.join('\n')).digest('hex'); }
function timingEqual(a, b) {
  const ab = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function getNetworkEndpointConfig(env = process.env) {
  return {
    enabled: String(env.PRIVATE_PAYMENT_NETWORK_AGENT_ENABLED || 'true').toLowerCase() !== 'false',
    secretConfigured: Boolean(env.PRIVATE_PAYMENT_NETWORK_AGENT_SECRET),
    agentId: env.CLEARING_AGENT_ID || 'DLB-TRUST-CLEARING-AGENT',
    networkId: env.PRIVATE_PAYMENT_NETWORK_AGENT_NETWORK_ID || 'PPN-FAMILY',
    baseUrl: String(env.PRIVATE_PAYMENT_NETWORK_AGENT_BASE_URL || '').trim() || null,
  };
}

function secret(env = process.env) {
  const s = env.PRIVATE_PAYMENT_NETWORK_AGENT_SECRET;
  if (!s) throw new NetworkEndpointError('PRIVATE_PAYMENT_NETWORK_AGENT_SECRET not mounted', 'PPN_AGENT_NOT_CONFIGURED', 503);
  return String(s);
}

/**
 * Verify the agent's request signature. `body` is the raw Buffer/string the
 * agent signed. Throws on any mismatch; never reveals which check failed
 * beyond a generic reason.
 */
function verifyRequest({ headers = {}, method, path, body }) {
  const cfg = getNetworkEndpointConfig();
  if (!cfg.enabled) throw new NetworkEndpointError('participant endpoint disabled', 'PPN_AGENT_DISABLED', 503);
  const s = secret();
  const h = (k) => String(headers[k.toLowerCase()] || '');
  const agentId = h('X-Clearing-Agent-Id');
  const ts = Number(h('X-Clearing-Agent-Ts'));
  const bodyHash = h('X-Clearing-Agent-Body-Sha256');
  const sig = h('X-Clearing-Agent-Signature');
  if (!timingEqual(agentId, cfg.agentId)) throw new NetworkEndpointError('agent not admitted', 'PPN_AGENT_UNAUTHORIZED', 401);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > SKEW_MS) throw new NetworkEndpointError('request timestamp outside window', 'PPN_AGENT_UNAUTHORIZED', 401);
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body || '', 'utf8');
  if (raw.length > MAX_BODY_BYTES) throw new NetworkEndpointError('body too large', 'PPN_AGENT_BAD_REQUEST', 413);
  if (!timingEqual(bodyHash, sha256(raw))) throw new NetworkEndpointError('signature did not verify', 'PPN_AGENT_UNAUTHORIZED', 401);
  const expected = hmac(s, agentId, String(method).toUpperCase(), path, String(ts), bodyHash);
  if (!timingEqual(sig, expected)) throw new NetworkEndpointError('signature did not verify', 'PPN_AGENT_UNAUTHORIZED', 401);
  return { agentId, ts };
}

const ClearingAgentNetworkEndpoint = {
  FORMATS,

  async ensureTables() {
    if (!pool) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS ppn_agent_clearing_receipts (
      reference       VARCHAR(64) PRIMARY KEY,
      idempotency_key VARCHAR(128) NOT NULL UNIQUE,
      agent_id        VARCHAR(64) NOT NULL,
      format          VARCHAR(32) NOT NULL,
      content_type    VARCHAR(128),
      body_sha256     CHAR(64) NOT NULL,
      body_bytes      INTEGER NOT NULL,
      status          VARCHAR(16) NOT NULL DEFAULT 'accepted',
      received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ppn_agent_events (
      id         BIGSERIAL PRIMARY KEY,
      type       VARCHAR(64) NOT NULL,
      agent_id   VARCHAR(64),
      reference  VARCHAR(64),
      detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  },

  async _event(type, { agentId = null, reference = null, detail = {} } = {}) {
    if (!pool) return;
    await pool.query('INSERT INTO ppn_agent_events (type, agent_id, reference, detail) VALUES ($1,$2,$3,$4)', [type, agentId, reference, JSON.stringify(detail)]);
  },

  /** Step 2 of the agent handshake: prove possession of the shared credential and acknowledge. */
  async handshake({ headers, path, rawBody, payload = {} }) {
    const cfg = getNetworkEndpointConfig();
    let who;
    try {
      who = verifyRequest({ headers, method: 'POST', path, body: rawBody });
    } catch (e) {
      await this._event('ppn_agent.handshake_refused', { detail: { reason: e.code } });
      throw e;
    }
    const { agentId, networkId, nonce, signature } = payload;
    if (!agentId || !networkId || !/^[a-f0-9]{64}$/.test(String(nonce || ''))) throw new NetworkEndpointError('agentId, networkId and 64-hex nonce required', 'PPN_AGENT_BAD_REQUEST', 400);
    if (!timingEqual(agentId, who.agentId)) throw new NetworkEndpointError('agent not admitted', 'PPN_AGENT_UNAUTHORIZED', 401);
    if (String(networkId) !== cfg.networkId) throw new NetworkEndpointError('networkId does not name this network', 'PPN_AGENT_UNAUTHORIZED', 401);
    const s = secret();
    if (!timingEqual(signature, hmac(s, agentId, networkId, nonce))) {
      await this._event('ppn_agent.handshake_refused', { agentId, detail: { reason: 'nonce signature did not verify' } });
      throw new NetworkEndpointError('signature did not verify', 'PPN_AGENT_UNAUTHORIZED', 401);
    }
    await this._event('ppn_agent.handshake_ack', { agentId, detail: { networkId } });
    return {
      networkId,
      agentId,
      signature: hmac(s, networkId, agentId, nonce, 'ack'),
      capabilities: { country: 'US', currency: 'USD', formats: FORMATS, familyOnly: true, settlement: 'fineract_core_banking', instant: true },
    };
  },

  /** Accept a converted bank-format message for clearing. Idempotent on X-Idempotency-Key. */
  async clear({ headers, path, rawBody }) {
    let who;
    try {
      who = verifyRequest({ headers, method: 'POST', path, body: rawBody });
    } catch (e) {
      await this._event('ppn_agent.clear_refused', { detail: { reason: e.code } });
      throw e;
    }
    if (!pool) throw new NetworkEndpointError('ledger database not connected', 'PPN_AGENT_DB', 503);
    const format = String(headers['x-clearing-format'] || '');
    const key = String(headers['x-idempotency-key'] || '').trim();
    if (!FORMATS.includes(format)) throw new NetworkEndpointError('unsupported X-Clearing-Format', 'PPN_AGENT_BAD_FORMAT', 400);
    if (!key || key.length > 128) throw new NetworkEndpointError('X-Idempotency-Key required', 'PPN_AGENT_BAD_REQUEST', 400);
    const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || '', 'utf8');
    if (!raw.length) throw new NetworkEndpointError('empty message', 'PPN_AGENT_BAD_REQUEST', 400);
    const hash = sha256(raw);

    const existing = await pool.query('SELECT reference, body_sha256, status FROM ppn_agent_clearing_receipts WHERE idempotency_key = $1', [key]);
    if (existing.rows.length) {
      const r = existing.rows[0];
      if (r.body_sha256 !== hash) throw new NetworkEndpointError('idempotency key reused with a different message', 'PPN_AGENT_IDEMPOTENCY', 409);
      return { reference: r.reference, status: r.status, idempotent: true };
    }
    const reference = `PPNCLR-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    await pool.query(
      `INSERT INTO ppn_agent_clearing_receipts (reference, idempotency_key, agent_id, format, content_type, body_sha256, body_bytes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [reference, key, who.agentId, format, String(headers['content-type'] || '').slice(0, 128), hash, raw.length]
    );
    await this._event('ppn_agent.cleared', { agentId: who.agentId, reference, detail: { format, bytes: raw.length } });
    return { reference, status: 'accepted', idempotent: false };
  },

  async status() {
    const cfg = getNetworkEndpointConfig();
    let receipts = 0;
    if (pool) {
      const r = await pool.query('SELECT COUNT(*)::int AS n FROM ppn_agent_clearing_receipts').catch(() => ({ rows: [] }));
      receipts = r.rows && r.rows[0] ? r.rows[0].n : null;
    }
    return {
      enabled: cfg.enabled,
      secretConfigured: cfg.secretConfigured,
      agentId: cfg.agentId,
      networkId: cfg.networkId,
      baseUrl: cfg.baseUrl,
      receipts,
      blockers: [
        ...(cfg.secretConfigured ? [] : ['PRIVATE_PAYMENT_NETWORK_AGENT_SECRET not mounted']),
        ...(cfg.baseUrl ? [] : ['PRIVATE_PAYMENT_NETWORK_AGENT_BASE_URL not set']),
      ],
    };
  },
};

module.exports = { ClearingAgentNetworkEndpoint, NetworkEndpointError, getNetworkEndpointConfig, verifyRequest };
