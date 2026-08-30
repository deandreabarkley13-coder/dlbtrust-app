'use strict';

/**
 * Zero Trust Gateway
 *
 * Every instruction reaching the in-house bank is treated as hostile until it
 * proves otherwise, including instructions from inside the trust's own network.
 * A caller must present four independent things:
 *
 *   1. a channel credential (service token or an authenticated operator session)
 *   2. an HMAC signature over the exact bytes it sent, with a timestamp
 *   3. a nonce that has never been used before
 *   4. a scope that actually covers the operation being asked for
 *
 * The signature is what makes the other three worth anything: without it a
 * leaked token replays forever, and a body can be rewritten in flight. The
 * nonce ledger is persisted rather than kept in memory because a replay that
 * lands on a second process is still a replay.
 *
 * The gateway fails closed. If it cannot verify, the payment does not enter the
 * pipeline at all — there is no "log and continue" path.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');
const { getConfig } = require('./inHouseBankConfig');

const SCOPES = Object.freeze({
  'payments:initiate': ['operator', 'trustee_maker', 'trustee_checker', 'admin', 'service'],
  'payments:approve': ['trustee_maker', 'trustee_checker', 'admin'],
  'payments:read': ['operator', 'trustee_maker', 'trustee_checker', 'admin', 'service', 'auditor'],
  'accounts:manage': ['operator', 'admin'],
  'accounts:read': ['operator', 'trustee_maker', 'trustee_checker', 'admin', 'service', 'auditor'],
  'ledger:reconcile': ['operator', 'admin', 'auditor'],
});

class ZeroTrustError extends Error {
  constructor(message, code = 'IHB_DENIED', status = 401) {
    super(message);
    this.name = 'ZeroTrustError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a == null ? '' : a));
  const right = Buffer.from(String(b == null ? '' : b));
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

/** The signed string is timestamp.nonce.body — order fixed so it cannot be shuffled. */
function signingPayload({ timestamp, nonce, body }) {
  return `${timestamp}.${nonce}.${typeof body === 'string' ? body : JSON.stringify(body || {})}`;
}

function sign({ timestamp, nonce, body, secret }) {
  return crypto.createHmac('sha256', secret).update(signingPayload({ timestamp, nonce, body })).digest('hex');
}

class ZeroTrustGateway {
  static scopes() {
    return SCOPES;
  }

  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ihb_nonces (
        nonce      TEXT PRIMARY KEY,
        principal  TEXT,
        scope      TEXT,
        seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ihb_access_log (
        sequence    BIGSERIAL PRIMARY KEY,
        principal   TEXT,
        scope       TEXT,
        channel     TEXT,
        decision    TEXT NOT NULL,
        reason      TEXT,
        request_ref TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    return true;
  }

  static async _log({ principal, scope, channel, decision, reason, requestRef }) {
    try {
      await pool.query(
        `INSERT INTO ihb_access_log (principal, scope, channel, decision, reason, request_ref)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [principal || null, scope || null, channel || null, decision, reason || null, requestRef || null]
      );
    } catch (err) {
      // The access log is evidence, not a gate: a logging failure must not turn
      // into an open door or a dropped payment.
      console.warn('[ihb-zero-trust] access log unavailable:', err.message);
    }
  }

  static async _consumeNonce(nonce, principal, scope) {
    const rows = await pool.query(
      `INSERT INTO ihb_nonces (nonce, principal, scope)
       VALUES ($1,$2,$3)
       ON CONFLICT (nonce) DO NOTHING
       RETURNING nonce`,
      [nonce, principal || null, scope || null]
    );
    if (!rows.rows.length) {
      throw new ZeroTrustError('Nonce has already been used; this instruction is a replay', 'IHB_REPLAY', 409);
    }
    return true;
  }

  /**
   * @param {object} input
   * @param {string} input.scope        operation being attempted
   * @param {object} input.headers      raw request headers
   * @param {string|object} input.body  the exact body that was signed
   * @param {object} [input.user]       an already-authenticated operator session
   * @param {string} [input.clientCertFingerprint]
   */
  static async authorize({ scope, headers = {}, body = '', user = null, requestRef = null } = {}) {
    const config = getConfig();
    const allowedRoles = SCOPES[scope];
    if (!allowedRoles) throw new ZeroTrustError(`Unknown scope ${scope}`, 'IHB_UNKNOWN_SCOPE', 400);

    const header = name => {
      const value = headers[name] || headers[name.toLowerCase()];
      return value === undefined || value === null ? '' : String(value);
    };

    // ── 1. Channel credential ────────────────────────────────────────────────
    let principal = null;
    let role = null;
    let channel = null;

    const bearer = header('authorization').startsWith('Bearer ')
      ? header('authorization').slice(7).trim()
      : header('x-ihb-service-token');

    if (config.serviceToken && safeEqual(bearer, config.serviceToken)) {
      principal = header('x-ihb-principal') || 'service';
      role = 'service';
      channel = 'service_token';
    } else if (user) {
      principal = user.username || user.email || user.userId || user.id || 'operator';
      role = user.role || 'operator';
      channel = 'operator_session';
    }

    if (!principal) {
      await this._log({ scope, channel: 'unknown', decision: 'denied', reason: 'no credential', requestRef });
      throw new ZeroTrustError('No verifiable credential presented', 'IHB_NO_CREDENTIAL', 401);
    }

    // ── 2. Role/scope ────────────────────────────────────────────────────────
    if (!allowedRoles.includes(role)) {
      await this._log({ principal, scope, channel, decision: 'denied', reason: `role ${role} outside scope`, requestRef });
      throw new ZeroTrustError(`Role ${role} may not ${scope}`, 'IHB_SCOPE_DENIED', 403);
    }
    if (config.allowedOriginators.length && !config.allowedOriginators.includes(principal)) {
      await this._log({ principal, scope, channel, decision: 'denied', reason: 'originator not allow-listed', requestRef });
      throw new ZeroTrustError(`Originator ${principal} is not allow-listed`, 'IHB_ORIGINATOR_DENIED', 403);
    }

    // ── 3. mTLS client identity ──────────────────────────────────────────────
    const fingerprint = header('x-client-cert-fingerprint');
    if (config.mtlsRequired) {
      if (!fingerprint || !config.trustedClientFingerprints.includes(fingerprint)) {
        await this._log({ principal, scope, channel, decision: 'denied', reason: 'client certificate not trusted', requestRef });
        throw new ZeroTrustError('Client certificate is missing or untrusted', 'IHB_MTLS_DENIED', 403);
      }
    }

    // ── 4. Signature, freshness and replay ───────────────────────────────────
    // Machine callers always sign. An operator session has already been
    // authenticated by the app's own session middleware and cannot hold the
    // signing secret in a browser, so it signs only where a deployment puts a
    // signer in front of the API.
    const mustSign = channel === 'service_token' || config.requireSessionSignature;
    let nonce = header('x-ihb-nonce');
    if (mustSign) {
      const supplied = header('x-ihb-signature').replace(/^sha256=/, '');
      const timestamp = header('x-ihb-timestamp');
      if (!config.signingSecret) {
        throw new ZeroTrustError('Signed ingress is required but no signing secret is configured', 'IHB_NOT_READY', 503);
      }
      if (!supplied || !timestamp || !nonce) {
        await this._log({ principal, scope, channel, decision: 'denied', reason: 'unsigned request', requestRef });
        throw new ZeroTrustError('Signature, timestamp and nonce headers are required', 'IHB_UNSIGNED', 401);
      }
      const numeric = Number(timestamp);
      const timestampMs = numeric < 1e12 ? numeric * 1000 : numeric;
      if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > config.signatureMaxAgeSeconds * 1000) {
        await this._log({ principal, scope, channel, decision: 'denied', reason: 'stale timestamp', requestRef });
        throw new ZeroTrustError('Request timestamp is outside the accepted window', 'IHB_STALE', 401);
      }
      const expected = sign({ timestamp, nonce, body, secret: config.signingSecret });
      if (!safeEqual(supplied, expected)) {
        await this._log({ principal, scope, channel, decision: 'denied', reason: 'bad signature', requestRef });
        throw new ZeroTrustError('Signature does not match the request body', 'IHB_BAD_SIGNATURE', 401);
      }
      await this._consumeNonce(nonce, principal, scope);
    } else if (nonce) {
      await this._consumeNonce(nonce, principal, scope);
    }

    await this._log({ principal, scope, channel, decision: 'allowed', reason: null, requestRef });
    return {
      principal,
      role,
      channel,
      scope,
      signed: Boolean(mustSign),
      clientCertFingerprint: fingerprint || null,
      verifiedAt: new Date().toISOString(),
    };
  }

  /** Helper for clients (and tests) so the canonical signing string lives in one place. */
  static signRequest({ body, secret, timestamp = Math.floor(Date.now() / 1000), nonce = crypto.randomUUID() }) {
    const signature = sign({ timestamp, nonce, body, secret });
    return {
      headers: {
        'x-ihb-timestamp': String(timestamp),
        'x-ihb-nonce': nonce,
        'x-ihb-signature': `sha256=${signature}`,
      },
      signature,
    };
  }

  static async purgeNonces({ olderThanHours = 48 } = {}) {
    const rows = await pool.query(
      `DELETE FROM ihb_nonces WHERE seen_at < NOW() - ($1 || ' hours')::INTERVAL RETURNING nonce`,
      [String(Math.max(1, Math.round(Number(olderThanHours) || 48)))]
    );
    return { purged: rows.rows.length };
  }
}

module.exports = { ZeroTrustGateway, ZeroTrustError, SCOPES };
