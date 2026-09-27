'use strict';

/**
 * Orange Rails connector — read-only bank aggregation through the Apache-2.0
 * Orange Rails API (github.com/Orange-The-World/orangerails). Banks are linked
 * through Orange Rails' Quiltt banking partner widget; bank credentials never
 * reach this service or Orange Rails' database (Quiltt-managed).
 *
 * Orange Rails does not persist cleartext transactions: `or-sync` fetches from
 * the bank and stores each row AES-256-GCM encrypted under a key only the
 * integrating platform holds (`transactionsKey`). This connector runs the
 * sync, lists the encrypted rows and decrypts them in-process, so the trust
 * ledger receives cleartext only inside Cloud Run.
 *
 * Connection config:
 *   {
 *     baseUrl?:         'https://api.orangerails.com'   (default; or ORANGERAILS_BASE_URL — self-hosted gateway)
 *     apiKey?:          '...',   // platform key: projected from AGGREGATOR_<CONNECTION>_API_KEY, falls back to ORANGERAILS_PLATFORM_API_KEY
 *     credentialsKey?:  '...',   // base64 32-byte vault key: AGGREGATOR_<CONNECTION>_CREDENTIALS_KEY / ORANGERAILS_CREDENTIALS_KEY
 *     transactionsKey?: '...',   // base64 32-byte AES key:  AGGREGATOR_<CONNECTION>_TRANSACTIONS_KEY / ORANGERAILS_TRANSACTIONS_KEY
 *     appUserId?:       'dlb-family-trust',   // Orange Rails external_user_id / app_user_id (one subaccount per trust)
 *     institutionName?: 'Betterment',         // keep only accounts at this institution
 *     accountIds?:      ['...'],              // restrict to these Quiltt account ids
 *     lookbackDays?:    90,
 *     mode:             'live' | 'shadow',
 *   }
 *
 * Linking flow (one-time, admin): createLinkToken(conn) → POST /v1/quiltt/session
 * returns a short-lived Quiltt session token + connector id for the Quiltt
 * Connector widget → link Betterment in the widget → linkStatus(conn) reports
 * the resulting Orange Rails connection → POST /connections/:id/handshake.
 *
 * Handshake: POST /v1/platforms/provision (idempotent) yields the subaccount
 * (external_connection_id); POST /v1/connections/list must show at least one
 * active Quiltt connection, otherwise the connection stays unreadable.
 */

const crypto = require('crypto');

const DEFAULT_BASE_URL = 'https://api.orangerails.com';
const DEFAULT_APP_USER_ID = 'dlb-family-trust';

function baseUrl(config) {
  return String(config.baseUrl || process.env.ORANGERAILS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function platformKey(config) {
  const key = config.apiKey || process.env.ORANGERAILS_PLATFORM_API_KEY;
  if (!key) throw new Error('Orange Rails platform key missing: set AGGREGATOR_<CONNECTION>_API_KEY or ORANGERAILS_PLATFORM_API_KEY');
  return key;
}

function vaultKeys(config) {
  const credentialsKey = config.credentialsKey || process.env.ORANGERAILS_CREDENTIALS_KEY;
  const transactionsKey = config.transactionsKey || process.env.ORANGERAILS_TRANSACTIONS_KEY;
  if (!credentialsKey || !transactionsKey) {
    throw new Error('Orange Rails vault keys missing: set AGGREGATOR_<CONNECTION>_CREDENTIALS_KEY and _TRANSACTIONS_KEY (or ORANGERAILS_CREDENTIALS_KEY / ORANGERAILS_TRANSACTIONS_KEY)');
  }
  return { credentialsKey, transactionsKey };
}

function appUserId(config) { return String(config.appUserId || DEFAULT_APP_USER_ID); }

async function orRequest(conn, path, body, { timeoutMs } = {}) {
  const config = conn.config || {};
  const url = baseUrl(config) + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 30000);
  if (timer.unref) timer.unref();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Platform-API-Key': platformKey(config),
      },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`Orange Rails request failed (${path}): ${err.name === 'AbortError' ? 'timeout' : err.message}`);
  }
  clearTimeout(timer);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  if (!res.ok) {
    const msg = (json && (json.error || json.message)) || `HTTP ${res.status}`;
    throw new Error(`Orange Rails ${path}: ${msg}`);
  }
  return json || {};
}

// Payload layout written by or-sync: base64( iv[12] || ciphertext || tag[16] ),
// AES-256-GCM (WebCrypto appends the tag to the ciphertext).
function decryptPayload(encryptedB64, keyB64) {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error('Orange Rails transactionsKey must be a base64-encoded 32-byte key');
  const data = Buffer.from(encryptedB64, 'base64');
  if (data.length < 12 + 16) throw new Error('Orange Rails encrypted_payload too short');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(data.length - 16);
  const cipher = data.subarray(12, data.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(cipher), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

function encryptPayload(obj, keyB64) {
  const key = Buffer.from(keyB64, 'base64');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, body, c.getAuthTag()]).toString('base64');
}

function institutionMatches(config, name) {
  if (!config.institutionName) return true;
  return String(name || '').toLowerCase().includes(String(config.institutionName).toLowerCase());
}

function accountFilter(config) {
  const ids = Array.isArray(config.accountIds) && config.accountIds.length ? new Set(config.accountIds.map(String)) : null;
  return (a) => (!ids || ids.has(String(a.id))) && (ids || institutionMatches(config, a.institution_name));
}

function normalizeAccount(a) {
  return {
    externalAccountId: String(a.id),
    name: a.name || null,
    accountType: a.kind ? String(a.kind).toLowerCase() : null,
    currency: a.currency || 'USD',
    mask: a.mask || null,
    balanceAvailable: a.balance_available != null ? Number(a.balance_available) : null,
    balanceCurrent: a.balance_current != null ? Number(a.balance_current) : null,
    raw: Object.assign({}, a, { institution: a.institution_name || null }),
  };
}

// Cleartext written by or-sync for Quiltt rows:
//   { amount, currency, description, entry_type: 'CREDIT'|'DEBIT', upstream_status, account_id }
function normalizeTransaction(row, payload) {
  const amount = Number(payload.amount);
  let direction = null;
  if (payload.entry_type) direction = /credit/i.test(payload.entry_type) ? 'credit' : 'debit';
  else if (payload.direction) direction = payload.direction === 'in' ? 'credit' : 'debit';
  else if (Number.isFinite(amount)) direction = amount < 0 ? 'debit' : 'credit';
  const status = String(payload.upstream_status || payload.status || 'posted').toLowerCase();
  return {
    externalTxnId: String(row.external_id || row.id),
    externalAccountId: String(payload.account_id || payload.source_wallet_id || ''),
    postedDate: row.occurred_at || payload.timestamp || null,
    amount: Number.isFinite(amount) ? Math.abs(amount) : null,
    currency: payload.currency || 'USD',
    direction,
    description: payload.description || payload.counterparty || null,
    category: payload.type || null,
    status: /pending/.test(status) ? 'pending' : 'posted',
    raw: Object.assign({ orangeRailsConnectionId: row.connection_id, orangeRailsRowId: row.id }, payload),
  };
}

async function listConnections(conn, subaccountId, opts) {
  const r = await orRequest(conn, '/v1/connections/list', { subaccount_id: subaccountId }, opts);
  return Array.isArray(r.connections) ? r.connections : [];
}

async function provision(conn, opts) {
  const r = await orRequest(conn, '/v1/platforms/provision', { external_user_id: appUserId(conn.config || {}) }, opts);
  if (!r.subaccount_id) throw new Error('Orange Rails provision returned no subaccount_id');
  return String(r.subaccount_id);
}

function subaccountId(conn) {
  return conn.external_connection_id || (conn.handshake_meta && conn.handshake_meta.subaccountId) || null;
}

const orangeRailsConnector = {
  type: 'orangerails',

  async handshake(conn, opts) {
    const config = conn.config || {};
    platformKey(config);
    vaultKeys(config);
    const sub = await provision(conn, opts);
    const connections = await listConnections(conn, sub, opts);
    const bank = connections.filter((c) => c.provider_type === 'quiltt');
    const active = bank.filter((c) => !c.status || /active|ok|linked|synced/i.test(String(c.status)));
    if (!active.length) {
      throw new Error(
        `Orange Rails subaccount ${sub} has no linked bank connection: POST /connections/:id/link-token, link ${config.institutionName || 'the bank'} in the Quiltt widget, then retry the handshake`
      );
    }
    return {
      externalConnectionId: sub,
      capabilities: { pull: true, push: false, webhook: !!config.webhookSecret },
      meta: {
        provider: 'orangerails',
        baseUrl: baseUrl(config),
        appUserId: appUserId(config),
        subaccountId: sub,
        bankConnections: active.map((c) => ({ id: c.id, status: c.status || null, lastSyncAt: c.last_sync_at || null })),
        secretSource: config.apiKey ? 'connection' : 'ORANGERAILS_PLATFORM_API_KEY',
      },
    };
  },

  async pullAccounts(conn, opts) {
    const config = conn.config || {};
    const r = await orRequest(conn, '/v1/quiltt/accounts', { app_user_id: appUserId(config) }, opts);
    return (r.accounts || []).filter(accountFilter(config)).map(normalizeAccount);
  },

  async pullTransactions(conn, opts) {
    const config = conn.config || {};
    const { credentialsKey, transactionsKey } = vaultKeys(config);
    const sub = subaccountId(conn) || await provision(conn, opts);
    const lookbackDays = Number(config.lookbackDays) > 0 ? Number(config.lookbackDays) : 90;
    const since = new Date(opts && opts.since ? opts.since : Date.now() - lookbackDays * 86400000);

    await orRequest(conn, '/v1/connections/sync', {
      subaccount_id: sub, credentials_key: credentialsKey, transactions_key: transactionsKey,
    }, opts);

    const accounts = await orangeRailsConnector.pullAccounts(conn, opts);
    const known = new Set(accounts.map((a) => a.externalAccountId));
    const out = [];
    let before = null;
    for (let page = 0; page < 50; page++) {
      const body = { subaccount_id: sub, limit: 500 };
      if (before) body.before = before;
      const r = await orRequest(conn, '/v1/transactions/list', body, opts);
      const rows = r.transactions || [];
      let stop = !rows.length;
      for (const row of rows) {
        if (row.occurred_at && new Date(row.occurred_at) < since) { stop = true; break; }
        const payload = decryptPayload(row.encrypted_payload, transactionsKey);
        const t = normalizeTransaction(row, payload);
        if (known.size && t.externalAccountId && !known.has(t.externalAccountId)) continue;
        out.push(t);
      }
      if (stop) break;
      const next = r.next_cursor || r.cursor || rows[rows.length - 1].occurred_at;
      if (!next || next === before) break;
      before = next;
    }
    return out;
  },

  /** One-time link bootstrap: Quiltt Connector session for the browser widget. */
  async createLinkToken(conn, { mode, existingConnectionId } = {}) {
    const config = conn.config || {};
    const body = { app_user_id: appUserId(config) };
    if (mode === 'reconnect') { body.mode = 'reconnect'; body.existing_connection_id = existingConnectionId; }
    const r = await orRequest(conn, '/v1/quiltt/session', body);
    return {
      provider: 'orangerails',
      linkToken: r.session_token,
      connectorId: r.connector_id || null,
      expiration: r.expires_at || null,
      env: baseUrl(config),
    };
  },

  /** After the widget completes: which bank connections Orange Rails now holds. */
  async linkStatus(conn, opts) {
    const sub = subaccountId(conn) || await provision(conn, opts);
    const connections = await listConnections(conn, sub, opts);
    const bank = connections.filter((c) => c.provider_type === 'quiltt');
    return {
      subaccountId: sub,
      linked: bank.length > 0,
      connections: bank.map((c) => ({ id: c.id, status: c.status || null, lastSyncAt: c.last_sync_at || null })),
    };
  },
};

module.exports = { orangeRailsConnector, normalizeAccount, normalizeTransaction, decryptPayload, encryptPayload, DEFAULT_BASE_URL };
