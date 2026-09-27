'use strict';

/**
 * SimpleFIN connector — read-only bank feed over the SimpleFIN protocol
 * (https://www.simplefin.org/protocol.html) via the SimpleFIN Bridge
 * (https://beta-bridge.simplefin.org). This is the bank-data path the Alderfi
 * personal-finance platform standardizes on; the trust's Betterment Trust
 * Checking account is linked in the Bridge ("Betterment (Login with App
 * Password)") and read here.
 *
 * Flow: the user creates a Setup Token in the Bridge → claimSetupToken()
 * exchanges it ONCE for an Access URL (https://user:pass@host/simplefin) →
 * the Access URL is stored in Secret Manager and projected onto the connection
 * as config.accessUrl (AGGREGATOR_<CONNECTION>_ACCESS_URL or SIMPLEFIN_ACCESS_URL).
 *
 * Connection config:
 *   {
 *     accessUrl?:   'https://...@beta-bridge.simplefin.org/simplefin',  // secret
 *     orgName?:     'Betterment',      // case-insensitive match on org/connection name
 *     connId?:      'CON-...',         // Bridge connection id (preferred once known)
 *     accountIds?:  ['ACT-...'],       // restrict to these account ids (default: all)
 *     lookbackDays?: 30,               // first-pull window (Bridge caps at 90)
 *     includePending?: true,
 *     mode:         'live' | 'shadow',
 *   }
 *
 * Handshake: GET {accessUrl}/accounts?balances-only=1 proves the Access URL is
 * live and resolves the configured institution; its conn_id becomes the
 * external_connection_id. Capabilities are { pull: true, push: false,
 * webhook: false } — outbound payments still go over the trust's own rails.
 */

const MAX_WINDOW_DAYS = 90;
const DEFAULT_LOOKBACK_DAYS = 30;
const OVERLAP_DAYS = 5;

function isLoopback(u) {
  return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
}

function accessUrl(config) {
  const raw = config.accessUrl || process.env.SIMPLEFIN_ACCESS_URL || null;
  if (!raw) {
    throw new Error('SimpleFIN Access URL missing: set AGGREGATOR_<CONNECTION>_ACCESS_URL or SIMPLEFIN_ACCESS_URL (claim it from a Setup Token first)');
  }
  let u;
  try { u = new URL(String(raw).trim()); } catch (e) { throw new Error('SimpleFIN Access URL is not a valid URL'); }
  if (u.protocol !== 'https:' && !isLoopback(u)) throw new Error('SimpleFIN Access URL must use https');
  if (!u.username) throw new Error('SimpleFIN Access URL must embed Basic-Auth credentials');
  const auth = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
  u.username = '';
  u.password = '';
  return { base: u.toString().replace(/\/$/, ''), auth, host: u.host };
}

/** Exchange a one-time Setup Token (base64 claim URL) for an Access URL. */
async function claimSetupToken(setupToken, { timeoutMs } = {}) {
  const token = String(setupToken || '').trim();
  if (!token) throw new Error('SimpleFIN setup token required');
  let claimUrl;
  try { claimUrl = new URL(Buffer.from(token, 'base64').toString('utf8').trim()); } catch (e) {
    throw new Error('SimpleFIN setup token is not a base64-encoded claim URL');
  }
  if (claimUrl.protocol !== 'https:' && !isLoopback(claimUrl)) throw new Error('SimpleFIN claim URL must use https');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 30000);
  if (timer.unref) timer.unref();
  let res;
  try {
    res = await fetch(claimUrl, { method: 'POST', headers: { 'Content-Length': '0' }, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`SimpleFIN claim failed: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
  }
  clearTimeout(timer);
  const text = (await res.text()).trim();
  if (!res.ok) throw new Error(`SimpleFIN claim failed: HTTP ${res.status}${text ? ' ' + text.slice(0, 120) : ''}`);
  if (!/^https?:\/\/[^@\s]+@[^\s]+$/.test(text)) throw new Error('SimpleFIN claim returned an unexpected response');
  return text;
}

async function sfRequest(conn, params, { timeoutMs } = {}) {
  const config = conn.config || {};
  const { base, auth } = accessUrl(config);
  const qs = new URLSearchParams(params || {});
  qs.set('version', '2');
  const url = `${base}/accounts?${qs.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 30000);
  if (timer.unref) timer.unref();
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: `Basic ${auth}` },
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`SimpleFIN request failed: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
  }
  clearTimeout(timer);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  if (res.status === 403) throw new Error('SimpleFIN Access URL rejected (HTTP 403): the token was disabled or revoked in the Bridge');
  if (!res.ok) throw new Error(`SimpleFIN /accounts: HTTP ${res.status}`);
  if (!json || !Array.isArray(json.accounts)) throw new Error('SimpleFIN /accounts: malformed response');
  const errors = [].concat(json.errors || [], (json.errlist || []).map((e) => e && (e.description || e.message || e.code)))
    .filter(Boolean);
  return Object.assign({}, json, { errorMessages: errors });
}

function connectionsOf(payload) {
  if (Array.isArray(payload.connections) && payload.connections.length) return payload.connections;
  // Protocol v1 fallback: institutions live on each account as `org`.
  const seen = new Map();
  for (const a of payload.accounts) {
    const org = a.org || {};
    const id = a.conn_id || org.id || org.domain || org.name;
    if (id && !seen.has(id)) seen.set(id, { conn_id: id, name: org.name || null, org_name: org.name || null, org_id: org.id || org.domain || null, sfin_url: org['sfin-url'] || null });
  }
  return Array.from(seen.values());
}

function matchesOrg(c, config) {
  if (config.connId) return String(c.conn_id) === String(config.connId);
  if (config.orgName) {
    const needle = String(config.orgName).toLowerCase();
    return [c.name, c.org_name, c.org_id].some((v) => v && String(v).toLowerCase().includes(needle));
  }
  return false;
}

function resolveConnection(payload, conn) {
  const config = conn.config || {};
  const conns = connectionsOf(payload);
  if (conn.external_connection_id && conn.handshake_state === 'verified') {
    const hit = conns.find((c) => String(c.conn_id) === String(conn.external_connection_id));
    if (hit) return hit;
  }
  if (!config.connId && !config.orgName) {
    throw new Error('SimpleFIN connection needs config.connId or config.orgName (e.g. "Betterment")');
  }
  const matches = conns.filter((c) => matchesOrg(c, config));
  if (!matches.length) {
    const have = conns.map((c) => c.name || c.org_name || c.conn_id).filter(Boolean).join(', ') || 'none';
    throw new Error(`SimpleFIN Bridge has no linked institution matching ${config.connId ? 'id ' + config.connId : '"' + config.orgName + '"'} (linked: ${have}). Connect the institution in the SimpleFIN Bridge first.`);
  }
  if (matches.length > 1 && !config.connId) {
    throw new Error(`SimpleFIN Bridge has ${matches.length} institutions matching "${config.orgName}"; set config.connId to one of: ${matches.map((c) => c.conn_id).join(', ')}`);
  }
  return matches[0];
}

function accountFilter(config, connId) {
  const ids = Array.isArray(config.accountIds) && config.accountIds.length ? new Set(config.accountIds.map(String)) : null;
  return (a) => {
    const owner = a.conn_id || (a.org && (a.org.id || a.org.domain || a.org.name));
    if (connId && owner && String(owner) !== String(connId)) return false;
    return !ids || ids.has(String(a.id));
  };
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isoDate(unixSeconds) {
  const n = Number(unixSeconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString().slice(0, 10) : null;
}

function normalizeAccount(a) {
  const org = a.org || {};
  const { transactions, holdings, ...rest } = a; // eslint-disable-line no-unused-vars
  return {
    externalAccountId: String(a.id),
    name: a.name || null,
    accountType: Array.isArray(a.holdings) && a.holdings.length ? 'investment' : 'depository',
    currency: a.currency || 'USD',
    mask: null,
    balanceAvailable: num(a['available-balance']),
    balanceCurrent: num(a.balance),
    raw: Object.assign(rest, { org_name: org.name || a.org_name || null, balance_date: isoDate(a['balance-date']), holdings_count: Array.isArray(holdings) ? holdings.length : 0 }),
  };
}

function normalizeTransaction(t, accountId) {
  const amount = num(t.amount);
  return {
    externalTxnId: String(t.id),
    externalAccountId: String(accountId),
    postedDate: isoDate(t.posted) || isoDate(t.transacted_at),
    amount: amount != null ? Math.abs(amount) : null,
    currency: t.currency || 'USD',
    direction: amount != null ? (amount < 0 || /^\s*-/.test(String(t.amount)) ? 'debit' : 'credit') : null,
    description: t.description || t.payee || t.memo || null,
    category: t.mcc ? `mcc:${t.mcc}` : null,
    status: t.pending || !t.posted ? 'pending' : 'posted',
    raw: t,
  };
}

function windowParams(config, opts) {
  const nowSec = Math.floor(Date.now() / 1000);
  const lookback = Math.min(Number(config.lookbackDays) || DEFAULT_LOOKBACK_DAYS, MAX_WINDOW_DAYS);
  let start = nowSec - lookback * 86400;
  if (opts && opts.since) {
    const s = Math.floor(new Date(opts.since).getTime() / 1000);
    if (Number.isFinite(s)) start = Math.max(s - OVERLAP_DAYS * 86400, nowSec - MAX_WINDOW_DAYS * 86400);
  }
  const params = { 'start-date': String(start) };
  if (config.includePending !== false) params.pending = '1';
  return params;
}

const simpleFinConnector = {
  type: 'simplefin',

  async handshake(conn, opts) {
    const payload = await sfRequest(conn, { 'balances-only': '1' }, opts);
    const pending = Object.assign({}, conn, { handshake_state: 'pending', external_connection_id: null });
    const target = resolveConnection(payload, pending);
    const accounts = payload.accounts.filter(accountFilter(conn.config || {}, target.conn_id));
    if (!accounts.length) throw new Error(`SimpleFIN institution ${target.name || target.conn_id} exposes no accounts (check config.accountIds)`);
    return {
      externalConnectionId: String(target.conn_id),
      capabilities: { pull: true, push: false, webhook: false },
      meta: {
        provider: 'simplefin',
        bridge: accessUrl(conn.config || {}).host,
        institution: { id: target.conn_id, name: target.name || target.org_name || null, org_id: target.org_id || null },
        accounts: accounts.map((a) => ({ id: a.id, name: a.name || null, currency: a.currency || 'USD' })),
        bridgeErrors: payload.errorMessages,
        secretSource: (conn.config && conn.config.accessUrl) ? 'connection' : 'SIMPLEFIN_ACCESS_URL',
      },
    };
  },

  async pullAccounts(conn, opts) {
    const payload = await sfRequest(conn, { 'balances-only': '1' }, opts);
    const target = resolveConnection(payload, conn);
    return payload.accounts.filter(accountFilter(conn.config || {}, target.conn_id)).map(normalizeAccount);
  },

  async pullTransactions(conn, opts) {
    const config = conn.config || {};
    const payload = await sfRequest(conn, windowParams(config, opts), opts);
    const target = resolveConnection(payload, conn);
    const out = [];
    for (const a of payload.accounts.filter(accountFilter(config, target.conn_id))) {
      for (const t of a.transactions || []) out.push(normalizeTransaction(t, a.id));
    }
    return out;
  },
};

module.exports = { simpleFinConnector, claimSetupToken, normalizeAccount, normalizeTransaction };
