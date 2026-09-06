'use strict';

/**
 * Hyperledger Fabric notarization — an independently verifiable record of what
 * the trust did with money.
 *
 * Every rail in this platform already writes its own truth: the sub-ledger in
 * Postgres, the canonical GL in Fineract, a NACHA file on disk, a tx hash on a
 * public chain. What none of them provide is *tamper evidence* over the
 * bookkeeping itself. A settled wire's row can be edited afterwards and no
 * artifact contradicts the edit, which is exactly what an auditor, a
 * co-trustee, or a regulator needs to rule out.
 *
 * So the ledger stores no money and no payload — only a digest:
 *
 *   digest = sha256(canonical JSON of the record)
 *
 * written to a permissioned Fabric channel through Fabconnect (FireFly's
 * Fabric connector, also usable standalone) as chaincode invocations:
 *
 *   POST /transactions        invoke  NotarizeRecord(recordType, recordId, digest, metadata)
 *   POST /query               query   GetRecord(recordType, recordId)
 *   GET  /receipts/{id}       receipt txId + blockNumber once the block commits
 *
 * verify() re-derives the digest from the record as it exists *today* and
 * compares it against both the local notarization row and the digest the
 * channel returns. Three outcomes, never conflated: `verified` (all three
 * agree), `mismatch` (the record changed after notarization — the interesting
 * case), `unnotarized` (nothing was ever anchored, so silence proves nothing).
 *
 * Gating follows the rest of the platform: FABRIC_LEDGER_LIVE must be true to
 * invoke chaincode. Otherwise notarize() computes and stores the digest and
 * marks the row `shadow` — the digest is still useful (it pins the record at a
 * point in time) but it makes no claim about a block.
 */

const crypto = require('crypto');

let pool = null;
try { pool = require('../bonds/pgPool'); } catch (e) { /* no DB in tests */ }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function num(name, def = 0) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : def; }
function reject(message, code, status = 422) { return Object.assign(new Error(message), { code, status }); }
function id(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }

/**
 * Deterministic serialization: object keys sorted at every depth so two
 * structurally identical records always hash the same, whatever order the
 * database, the API, or JSON.stringify happened to produce.
 */
function canonicalize(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const entry = canonicalize(value[key]);
      if (entry !== undefined) out[key] = entry;
    }
    return out;
  }
  return value;
}

function digestOf(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex');
}

let tablesReady = null;
async function ensureTables() {
  if (!pool || !pool.query) return;
  if (tablesReady) return tablesReady;
  tablesReady = pool.query(`
    CREATE TABLE IF NOT EXISTS fabric_notarizations (
      id TEXT PRIMARY KEY,
      record_type TEXT NOT NULL,
      record_id TEXT NOT NULL,
      digest TEXT NOT NULL,
      channel TEXT NOT NULL,
      chaincode TEXT NOT NULL,
      status TEXT NOT NULL,
      request_id TEXT,
      transaction_id TEXT,
      block_number BIGINT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      failure_reason TEXT,
      notarized_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS fabric_notarizations_record_digest_idx
      ON fabric_notarizations (record_type, record_id, digest);
    CREATE INDEX IF NOT EXISTS fabric_notarizations_record_idx
      ON fabric_notarizations (record_type, record_id, created_at DESC);
  `).catch((e) => { tablesReady = null; throw e; });
  return tablesReady;
}

const memoryNotarizations = [];

class FabricLedgerEngine {
  static getConfig() {
    return {
      system: 'hyperledger-fabric',
      // Fabconnect (hyperledger/firefly-fabconnect) REST gateway.
      connectUrl: str('FABRIC_CONNECT_URL').replace(/\/+$/, ''),
      connectToken: str('FABRIC_CONNECT_TOKEN'),
      channel: str('FABRIC_CHANNEL', 'trustchannel'),
      chaincode: str('FABRIC_CHAINCODE', 'trustnotary'),
      // Fabric identity (an enrolled signer in the org's MSP) the invoke is signed with.
      signer: str('FABRIC_SIGNER'),
      notarizeFunction: str('FABRIC_NOTARIZE_FUNCTION', 'NotarizeRecord'),
      queryFunction: str('FABRIC_QUERY_FUNCTION', 'GetRecord'),
      timeoutMs: num('FABRIC_CONNECT_TIMEOUT_MS', 20000),
      receiptAttempts: num('FABRIC_RECEIPT_ATTEMPTS', 10),
      receiptDelayMs: num('FABRIC_RECEIPT_DELAY_MS', 1500),
      live: str('FABRIC_LEDGER_LIVE') === 'true',
    };
  }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.connectUrl) issues.push('FABRIC_CONNECT_URL not configured');
    if (!cfg.signer) issues.push('FABRIC_SIGNER not configured (enrolled Fabric identity)');
    if (!cfg.channel) issues.push('FABRIC_CHANNEL not configured');
    if (!cfg.chaincode) issues.push('FABRIC_CHAINCODE not configured');
    return {
      system: cfg.system,
      channel: cfg.channel,
      chaincode: cfg.chaincode,
      signer: cfg.signer || null,
      live: cfg.live,
      // A digest can always be computed and stored; only anchoring needs the channel.
      canNotarize: issues.length === 0,
      canAnchor: issues.length === 0 && cfg.live,
      mode: issues.length === 0 && cfg.live ? 'live' : 'shadow',
      issues,
      persistence: pool && pool.query ? 'postgres' : 'memory',
    };
  }

  static digest(payload) { return digestOf(payload); }

  static canonicalJson(payload) { return JSON.stringify(canonicalize(payload)); }

  static async _call(path, body, { method = 'POST' } = {}) {
    const cfg = this.getConfig();
    if (!cfg.connectUrl) throw reject('FABRIC_CONNECT_URL not configured', 'FABRIC_NOT_CONFIGURED', 503);
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.connectToken) headers.Authorization = `Bearer ${cfg.connectToken}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(`${cfg.connectUrl}${path}`, {
        method,
        headers,
        body: method === 'GET' ? undefined : JSON.stringify(body || {}),
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = { raw: text }; }
      if (!res.ok) {
        const detail = (parsed && (parsed.error || parsed.message)) || res.statusText;
        throw reject(`fabconnect ${path} failed: ${detail}`, 'FABRIC_CALL_FAILED', res.status >= 500 ? 502 : 422);
      }
      return parsed || {};
    } catch (err) {
      if (err.name === 'AbortError') throw reject(`fabconnect ${path} timed out after ${cfg.timeoutMs}ms`, 'FABRIC_TIMEOUT', 504);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Anchor one record's digest. Idempotent on (recordType, recordId, digest):
   * re-notarizing an unchanged record returns the existing row instead of
   * writing a second block, so callers can notarize on every settlement pass.
   */
  static async notarize({ recordType, recordId, payload, metadata = {}, notarizedBy = null, digest: providedDigest = null } = {}) {
    if (!recordType) throw reject('recordType is required', 'RECORD_TYPE_REQUIRED');
    if (!recordId) throw reject('recordId is required', 'RECORD_ID_REQUIRED');
    if (!providedDigest && (payload === undefined || payload === null)) {
      throw reject('payload or digest is required', 'PAYLOAD_REQUIRED');
    }
    const cfg = this.getConfig();
    const digest = providedDigest || digestOf(payload);

    const existing = await this._findByDigest(recordType, recordId, digest);
    if (existing && existing.status !== 'failed') return { ...existing, idempotent: true };

    const row = {
      id: id('FABNOT'),
      recordType: String(recordType),
      recordId: String(recordId),
      digest,
      channel: cfg.channel,
      chaincode: cfg.chaincode,
      status: cfg.live ? 'pending' : 'shadow',
      requestId: null,
      transactionId: null,
      blockNumber: null,
      metadata: canonicalize(metadata) || {},
      failureReason: null,
      notarizedBy: notarizedBy || null,
      createdAt: new Date().toISOString(),
    };

    if (!cfg.live) {
      // Shadow: the digest is real, the anchor is not. Say so explicitly.
      row.anchored = false;
      row.reason = 'FABRIC_LEDGER_LIVE is not true; digest computed and stored, nothing invoked';
      await this._persist(row);
      return row;
    }

    const readiness = this.readiness();
    if (!readiness.canNotarize) throw reject(`fabric channel unreachable: ${readiness.issues.join('; ')}`, 'FABRIC_NOT_CONFIGURED', 503);

    let response;
    try {
      response = await this._call('/transactions', {
        headers: { type: 'SendTransaction', signer: cfg.signer, channel: cfg.channel, chaincode: cfg.chaincode },
        func: cfg.notarizeFunction,
        args: [row.recordType, row.recordId, digest, JSON.stringify(row.metadata)],
        init: false,
      });
    } catch (err) {
      row.status = 'failed';
      row.failureReason = err.message;
      row.anchored = false;
      await this._persist(row);
      throw err;
    }

    row.requestId = (response.id || response.requestId || null);
    row.transactionId = (response.transactionID || response.transactionId || null);
    row.blockNumber = response.blockNumber != null ? Number(response.blockNumber) : null;
    row.status = row.transactionId ? 'anchored' : 'pending';
    row.anchored = row.status === 'anchored';
    await this._persist(row);
    return row;
  }

  /**
   * Fabconnect answers an invoke before the block commits. Poll the receipt so
   * a notarization carries a txId and block number, not just a request id.
   */
  static async syncReceipt(notarizationId) {
    const record = await this.get(notarizationId);
    if (!record) throw reject(`notarization ${notarizationId} not found`, 'NOTARIZATION_NOT_FOUND', 404);
    if (record.status === 'anchored') return { ...record, polled: false };
    if (record.status === 'shadow') return { ...record, polled: false, reason: 'shadow notarization has no receipt' };
    if (!record.requestId) return { ...record, polled: false, reason: 'no fabconnect request id to poll' };

    const receipt = await this._call(`/receipts/${encodeURIComponent(record.requestId)}`, null, { method: 'GET' });
    const txId = receipt.transactionID || receipt.transactionId || null;
    const status = String(receipt.status || '').toLowerCase();
    const patch = {
      transactionId: txId,
      blockNumber: receipt.blockNumber != null ? Number(receipt.blockNumber) : null,
      status: txId && status !== 'failed' ? 'anchored' : (status === 'failed' ? 'failed' : record.status),
      failureReason: status === 'failed' ? (receipt.errorMessage || receipt.error || 'fabric rejected the transaction') : null,
    };
    const updated = await this._update(record.id, patch);
    return { ...updated, polled: true };
  }

  /**
   * The point of the whole engine: does the record still hash to what was
   * anchored? Compares today's digest against the stored notarization and,
   * when the channel is reachable, against the chaincode's own state.
   */
  static async verify({ recordType, recordId, payload, digest: providedDigest = null } = {}) {
    if (!recordType || !recordId) throw reject('recordType and recordId are required', 'RECORD_REQUIRED');
    const currentDigest = providedDigest || digestOf(payload);
    const history = await this.history(recordType, recordId);
    const anchored = history.find((h) => h.status === 'anchored') || history[0] || null;

    if (!anchored) {
      return {
        recordType, recordId, currentDigest, outcome: 'unnotarized',
        verified: false, notarization: null, onChain: null,
        detail: 'no notarization exists for this record; absence of a mismatch proves nothing',
      };
    }

    let onChain = null;
    let onChainError = null;
    if (this.readiness().canAnchor) {
      try {
        const cfg = this.getConfig();
        const response = await this._call('/query', {
          headers: { signer: cfg.signer, channel: cfg.channel, chaincode: cfg.chaincode },
          func: cfg.queryFunction,
          args: [String(recordType), String(recordId)],
        });
        onChain = this._extractDigest(response);
      } catch (err) {
        onChainError = err.message;
      }
    }

    const localMatch = anchored.digest === currentDigest;
    const chainMatch = onChain ? onChain === currentDigest : null;
    const outcome = !localMatch || chainMatch === false ? 'mismatch' : 'verified';

    return {
      recordType,
      recordId,
      currentDigest,
      anchoredDigest: anchored.digest,
      onChainDigest: onChain,
      onChainError,
      localMatch,
      chainMatch,
      outcome,
      verified: outcome === 'verified',
      notarization: anchored,
      detail: outcome === 'mismatch'
        ? 'the record changed after it was notarized'
        : (onChain ? 'record matches the digest committed to the channel' : 'record matches the stored notarization; channel not queried'),
    };
  }

  static _extractDigest(response) {
    if (!response) return null;
    const candidate = response.result !== undefined ? response.result : response;
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
      try { return this._extractDigest(JSON.parse(trimmed)); } catch (e) { return null; }
    }
    if (candidate && typeof candidate === 'object') {
      const value = candidate.digest || candidate.Digest || candidate.hash || candidate.Hash || null;
      return value ? String(value).toLowerCase() : null;
    }
    return null;
  }

  // ─── persistence ──────────────────────────────────────────────────────────

  static async _persist(row) {
    if (!pool || !pool.query) { memoryNotarizations.unshift(row); return row; }
    await ensureTables();
    await pool.query(
      `INSERT INTO fabric_notarizations
         (id, record_type, record_id, digest, channel, chaincode, status, request_id,
          transaction_id, block_number, metadata, failure_reason, notarized_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
       ON CONFLICT (record_type, record_id, digest) DO UPDATE SET
         status = EXCLUDED.status,
         request_id = COALESCE(EXCLUDED.request_id, fabric_notarizations.request_id),
         transaction_id = COALESCE(EXCLUDED.transaction_id, fabric_notarizations.transaction_id),
         block_number = COALESCE(EXCLUDED.block_number, fabric_notarizations.block_number),
         failure_reason = EXCLUDED.failure_reason,
         updated_at = NOW()`,
      [row.id, row.recordType, row.recordId, row.digest, row.channel, row.chaincode, row.status,
        row.requestId, row.transactionId, row.blockNumber, JSON.stringify(row.metadata || {}),
        row.failureReason, row.notarizedBy],
    );
    return row;
  }

  static async _update(notarizationId, patch) {
    if (!pool || !pool.query) {
      const row = memoryNotarizations.find((r) => r.id === notarizationId);
      if (!row) return null;
      Object.assign(row, patch, { anchored: (patch.status || row.status) === 'anchored' });
      return row;
    }
    await ensureTables();
    const res = await pool.query(
      `UPDATE fabric_notarizations
          SET transaction_id = COALESCE($2, transaction_id),
              block_number = COALESCE($3, block_number),
              status = $4,
              failure_reason = $5,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [notarizationId, patch.transactionId, patch.blockNumber, patch.status, patch.failureReason],
    );
    return res.rows[0] ? this._fromRow(res.rows[0]) : null;
  }

  static async _findByDigest(recordType, recordId, digest) {
    if (!pool || !pool.query) {
      return memoryNotarizations.find((r) => r.recordType === String(recordType)
        && r.recordId === String(recordId) && r.digest === digest) || null;
    }
    await ensureTables();
    const res = await pool.query(
      'SELECT * FROM fabric_notarizations WHERE record_type = $1 AND record_id = $2 AND digest = $3 LIMIT 1',
      [String(recordType), String(recordId), digest],
    );
    return res.rows[0] ? this._fromRow(res.rows[0]) : null;
  }

  static async get(notarizationId) {
    if (!pool || !pool.query) return memoryNotarizations.find((r) => r.id === notarizationId) || null;
    await ensureTables();
    const res = await pool.query('SELECT * FROM fabric_notarizations WHERE id = $1', [notarizationId]);
    return res.rows[0] ? this._fromRow(res.rows[0]) : null;
  }

  static async history(recordType, recordId) {
    if (!pool || !pool.query) {
      return memoryNotarizations.filter((r) => r.recordType === String(recordType) && r.recordId === String(recordId));
    }
    await ensureTables();
    const res = await pool.query(
      `SELECT * FROM fabric_notarizations
        WHERE record_type = $1 AND record_id = $2
        ORDER BY (status = 'anchored') DESC, created_at DESC`,
      [String(recordType), String(recordId)],
    );
    return res.rows.map((r) => this._fromRow(r));
  }

  static async list({ limit = 25, recordType = null, status = null } = {}) {
    if (!pool || !pool.query) {
      return memoryNotarizations
        .filter((r) => (!recordType || r.recordType === String(recordType)) && (!status || r.status === status))
        .slice(0, limit);
    }
    await ensureTables();
    const res = await pool.query(
      `SELECT * FROM fabric_notarizations
        WHERE ($2::text IS NULL OR record_type = $2)
          AND ($3::text IS NULL OR status = $3)
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit, recordType, status],
    );
    return res.rows.map((r) => this._fromRow(r));
  }

  static _fromRow(row) {
    return {
      id: row.id,
      recordType: row.record_type,
      recordId: row.record_id,
      digest: row.digest,
      channel: row.channel,
      chaincode: row.chaincode,
      status: row.status,
      requestId: row.request_id,
      transactionId: row.transaction_id,
      blockNumber: row.block_number != null ? Number(row.block_number) : null,
      metadata: row.metadata || {},
      failureReason: row.failure_reason,
      notarizedBy: row.notarized_by,
      anchored: row.status === 'anchored',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Test seam. */
  static _resetMemory() { memoryNotarizations.length = 0; }
}

module.exports = { FabricLedgerEngine, canonicalize, digestOf };
