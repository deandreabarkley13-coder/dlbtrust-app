'use strict';

/**
 * Finlynq connector — read-only bank feed over Finlynq's first-party MCP
 * server (https://finlynq.com/api/mcp, Streamable HTTP in stateless JSON mode;
 * AGPL-3.0, github.com/finlynq/finlynq). Finlynq holds the trust's linked
 * accounts (its own SimpleFIN bank feed, OFX/CSV imports) and this connector
 * reads balances and transactions from it. No MCP tool outside the read
 * allowlist is ever called — the `pf_` key is account-wide, so the allowlist
 * (tool names, and the read-only `op` of multi-op tools) is enforced here.
 *
 * Two sources (config.source):
 *   'ledger' (default) — Finlynq's bookkeeping ledger: `get_account_balances`
 *                        (ledger basis) + `search_transactions`.
 *   'bank'             — Finlynq's bank-side ledger, which is where its
 *                        SimpleFIN bank feed lands: the latest bank-reported
 *                        balance anchor (`manage_bank_ledger` op `list_anchors`)
 *                        + bank rows (GET /api/import/bank-ledger?accountId=).
 *                        An account with no anchor yet reports a null balance.
 *
 * config.syncBankFeed=true re-syncs Finlynq's SimpleFIN bank feed (POST
 * /api/settings/bank-feeds/simplefin/sync, already-mapped accounts only) at the
 * start of a pull when its last sync is older than config.syncIntervalHours
 * (default 6), keeping well inside SimpleFIN's daily request quota.
 *
 * Connection config:
 *   {
 *     apiKey?:      'pf_...',       // normally projected from Secret Manager
 *                                   // (AGGREGATOR_<CONNECTION>_API_KEY) or FINLYNQ_API_KEY
 *     mcpUrl?:      'https://finlynq.com/api/mcp',   // or FINLYNQ_MCP_URL (self-hosted)
 *     accountIds?:  [12, 13],       // Finlynq accounts.id to read (default: all)
 *     lookbackDays?: 30,            // first-pull window
 *     source?:      'ledger' | 'bank',
 *     syncBankFeed?: false,         // re-sync Finlynq's SimpleFIN feed before pulling
 *     syncIntervalHours?: 6,
 *     mode:         'live' | 'shadow',
 *   }
 *
 * Over a `pf_` API key Finlynq has no decryption key, so account names come
 * back encrypted and are dropped; pin the accounts with config.accountIds.
 *
 * Handshake: MCP initialize + tools/list (both read tools must be exposed),
 * then get_account_balances proves the key reads data and that the configured
 * accounts exist. Capabilities are { pull: true, push: false, webhook: false }.
 */

const DEFAULT_MCP_URL = 'https://finlynq.com/api/mcp';
const PROTOCOL_VERSION = '2025-06-18';
const READ_TOOLS = ['get_account_balances', 'search_transactions'];
const READ_OPS = { manage_bank_ledger: ['list_anchors'] };
const DEFAULT_SYNC_INTERVAL_HOURS = 6;
const SYNC_TIMEOUT_MS = 180000;
const SYNC_CAP_WARNING = /date range exceeds limit/i;
const DEFAULT_LOOKBACK_DAYS = 30;
const OVERLAP_DAYS = 5;
const TXN_LIMIT = 500;

let rpcSeq = 0;

function isLoopback(u) {
  return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
}

function mcpUrl(config) {
  const raw = config.mcpUrl || process.env.FINLYNQ_MCP_URL || DEFAULT_MCP_URL;
  let u;
  try { u = new URL(String(raw).trim()); } catch (e) { throw new Error('Finlynq MCP URL is not a valid URL'); }
  if (u.protocol !== 'https:' && !isLoopback(u)) throw new Error('Finlynq MCP URL must use https');
  if (u.username || u.password) throw new Error('Finlynq MCP URL must not embed credentials');
  return u;
}

function apiKey(config) {
  const key = config.apiKey || process.env.FINLYNQ_API_KEY || null;
  if (!key) throw new Error('Finlynq API key missing: set config.apiKey via AGGREGATOR_<CONNECTION>_API_KEY or FINLYNQ_API_KEY (Finlynq Settings → API Keys)');
  if (!String(key).startsWith('pf_')) throw new Error('Finlynq API key must be a pf_ token');
  return String(key).trim();
}

function parseRpcBody(text, contentType) {
  if (/text\/event-stream/i.test(contentType || '')) {
    const data = text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
    if (!data.length) throw new Error('Finlynq MCP returned an empty event stream');
    return JSON.parse(data[data.length - 1]);
  }
  return JSON.parse(text);
}

async function mcpRequest(conn, method, params, { timeoutMs } = {}) {
  const config = conn.config || {};
  const url = mcpUrl(config);
  const key = apiKey(config);
  const id = ++rpcSeq;
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 60000);
  if (timer.unref) timer.unref();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${key}`,
        'MCP-Protocol-Version': PROTOCOL_VERSION,
      },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`Finlynq MCP ${method} failed: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
  }
  clearTimeout(timer);
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new Error(`Finlynq API key rejected (HTTP ${res.status}): regenerate it in Finlynq Settings → API Keys`);
  if (!res.ok) throw new Error(`Finlynq MCP ${method} failed: HTTP ${res.status}`);
  let msg;
  try { msg = parseRpcBody(text, res.headers.get('content-type')); } catch (e) {
    throw new Error(`Finlynq MCP ${method} returned a non-JSON-RPC response`);
  }
  if (msg && msg.error) throw new Error(`Finlynq MCP ${method} error ${msg.error.code}: ${msg.error.message}`);
  if (!msg || msg.id !== id || msg.result === undefined) throw new Error(`Finlynq MCP ${method} returned an unexpected response`);
  return msg.result;
}

function isReadCall(name, args) {
  if (READ_TOOLS.includes(name)) return true;
  const ops = READ_OPS[name];
  return !!ops && !!args && ops.includes(args.op);
}

async function callTool(conn, name, args, opts) {
  if (!isReadCall(name, args)) throw new Error(`Finlynq tool ${name}${args && args.op ? ` op ${args.op}` : ''} is not an allowed read tool`);
  const result = await mcpRequest(conn, 'tools/call', { name, arguments: args || {} }, opts);
  const textPart = (result.content || []).find((c) => c && c.type === 'text');
  const text = textPart ? String(textPart.text) : '';
  if (result.isError || /^Error:/.test(text)) throw new Error(`Finlynq ${name} failed: ${text.replace(/^Error:\s*/, '').slice(0, 200) || 'tool error'}`);
  let payload = result.structuredContent;
  if (payload === undefined) {
    try { payload = JSON.parse(text); } catch (e) { throw new Error(`Finlynq ${name} returned non-JSON content`); }
  }
  if (payload && payload.success === false) throw new Error(`Finlynq ${name} failed: ${payload.error || 'unsuccessful'}`);
  return payload && payload.data !== undefined ? payload.data : payload;
}

async function restRequest(conn, method, path, { body, timeoutMs } = {}) {
  const config = conn.config || {};
  const url = new URL(path, mcpUrl(config).origin);
  const key = apiKey(config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 60000);
  if (timer.unref) timer.unref();
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: Object.assign({ Accept: 'application/json', Authorization: `Bearer ${key}` },
        body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`Finlynq ${method} ${url.pathname} failed: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
  }
  clearTimeout(timer);
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new Error(`Finlynq API key rejected (HTTP ${res.status}): regenerate it in Finlynq Settings → API Keys`);
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  if (!res.ok) throw new Error(`Finlynq ${method} ${url.pathname} failed: HTTP ${res.status}${json && json.error ? ` ${String(json.error).slice(0, 200)}` : ''}`);
  if (json === null) throw new Error(`Finlynq ${method} ${url.pathname} returned non-JSON content`);
  if (json.success === false) throw new Error(`Finlynq ${method} ${url.pathname} failed: ${String(json.error || 'unsuccessful').slice(0, 200)}`);
  return json.success === true && json.data !== undefined ? json.data : json;
}

function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object' && v.amount !== undefined) return num(v.amount);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function plainName(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  return /^v\d+:/.test(s) ? null : s;
}

function accountFilter(config) {
  const ids = Array.isArray(config.accountIds) && config.accountIds.length ? new Set(config.accountIds.map(String)) : null;
  return (a) => !ids || ids.has(String(a.id));
}

function accountType(a) {
  if (a.isInvestment) return 'investment';
  const t = String(a.type || '').toUpperCase();
  return t === 'L' || t === 'LIABILITY' ? 'credit' : 'depository';
}

function normalizeAccount(a) {
  const name = plainName(a.name);
  return {
    externalAccountId: String(a.id),
    name: name || plainName(a.alias) || `Finlynq account ${a.id}`,
    accountType: accountType(a),
    currency: a.currency || 'USD',
    mask: null,
    balanceAvailable: null,
    balanceCurrent: num(a.balance),
    raw: {
      finlynq_id: a.id,
      type: a.type || null,
      group: a.group || null,
      basis: a.basis || a.balanceBasis || null,
      balance_date: a.asOf || new Date().toISOString().slice(0, 10),
    },
  };
}

function normalizeBankTransaction(t, accountId) {
  const amount = num(t.amount);
  const id = t.bankTransactionId || t.id;
  return {
    externalTxnId: `bank:${id}`,
    externalAccountId: String(accountId),
    postedDate: t.date ? String(t.date).slice(0, 10) : null,
    amount: amount != null ? Math.abs(amount) : null,
    currency: t.currency || 'USD',
    direction: amount != null ? (amount < 0 ? 'debit' : 'credit') : null,
    description: plainName(t.payee) || plainName(t.note) || null,
    category: plainName(t.category),
    status: 'posted',
    raw: { id, date: t.date, amount: t.amount, currency: t.currency, source: 'finlynq_bank_ledger', note: plainName(t.note), linkedTransactionId: t.linkedTransactionId || null },
  };
}

function normalizeTransaction(t, accountId) {
  const amount = num(t.amount);
  return {
    externalTxnId: String(t.id),
    externalAccountId: String(accountId),
    postedDate: t.date ? String(t.date).slice(0, 10) : null,
    amount: amount != null ? Math.abs(amount) : null,
    currency: t.currency || 'USD',
    direction: amount != null ? (amount < 0 ? 'debit' : 'credit') : null,
    description: plainName(t.payee) || plainName(t.note) || null,
    category: plainName(t.category),
    status: 'posted',
    raw: { id: t.id, date: t.date, amount: t.amount, currency: t.currency, source: t.source || null, tags: t.tags || null },
  };
}

function startDate(config, opts) {
  const now = Date.now();
  const lookback = Number(config.lookbackDays) > 0 ? Number(config.lookbackDays) : DEFAULT_LOOKBACK_DAYS;
  let start = now - lookback * 86400000;
  if (opts && opts.since) {
    const s = new Date(opts.since).getTime();
    if (Number.isFinite(s)) start = s - OVERLAP_DAYS * 86400000;
  }
  return new Date(start).toISOString().slice(0, 10);
}

function bankSource(config) {
  return String(config.source || 'ledger').toLowerCase() === 'bank';
}

async function latestAnchor(conn, accountId, opts) {
  const rows = await callTool(conn, 'manage_bank_ledger', { op: 'list_anchors', accountId: Number(accountId) }, opts);
  const list = Array.isArray(rows) ? rows.filter((r) => r && r.date) : [];
  list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return list[0] || null;
}

async function syncBankFeed(conn, opts) {
  const config = conn.config || {};
  if (!config.syncBankFeed) return { skipped: 'disabled' };
  const status = await restRequest(conn, 'GET', '/api/settings/bank-feeds/simplefin/status', opts);
  if (!status.connected) throw new Error('Finlynq SimpleFIN bank feed is not connected (Finlynq Settings → Bank Feeds)');
  const hours = Number(config.syncIntervalHours) > 0 ? Number(config.syncIntervalHours) : DEFAULT_SYNC_INTERVAL_HOURS;
  const last = status.lastSyncAt ? new Date(status.lastSyncAt).getTime() : NaN;
  if (Number.isFinite(last) && Date.now() - last < hours * 3600000) return { skipped: 'fresh', lastSyncAt: status.lastSyncAt };
  const result = await restRequest(conn, 'POST', '/api/settings/bank-feeds/simplefin/sync', { body: {}, timeoutMs: SYNC_TIMEOUT_MS });
  const errors = (result.errors || []).filter((e) => !SYNC_CAP_WARNING.test(String(e)));
  if (errors.length) throw new Error(`Finlynq bank-feed sync reported: ${String(errors[0]).slice(0, 200)}`);
  return {
    synced: true,
    staged: (result.staged || []).length,
    unmapped: (result.skippedNoChoice || []).map((a) => a.externalId),
  };
}

async function listAccounts(conn, opts) {
  const data = await callTool(conn, 'get_account_balances', { basis: 'ledger' }, opts);
  const rows = Array.isArray(data) ? data : ((data && data.accounts) || []);
  return rows.filter(accountFilter(conn.config || {}));
}

const finlynqConnector = {
  type: 'finlynq',

  async handshake(conn, opts) {
    const init = await mcpRequest(conn, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dlbtrust-banking-aggregator', version: '1.0.0' },
    }, opts);
    const listed = await mcpRequest(conn, 'tools/list', {}, opts);
    const names = new Set(((listed && listed.tools) || []).map((t) => t.name));
    const required = bankSource(conn.config || {}) ? READ_TOOLS.concat(Object.keys(READ_OPS)) : READ_TOOLS;
    const missing = required.filter((n) => !names.has(n));
    if (missing.length) throw new Error(`Finlynq MCP does not expose ${missing.join(', ')}`);
    const accounts = await listAccounts(conn, opts);
    if (!accounts.length) throw new Error('Finlynq exposes no matching accounts (check config.accountIds)');
    const url = mcpUrl(conn.config || {});
    return {
      externalConnectionId: `finlynq:${url.host}`,
      capabilities: { pull: true, push: false, webhook: false },
      meta: {
        provider: 'finlynq',
        server: (init && init.serverInfo) || null,
        protocolVersion: (init && init.protocolVersion) || null,
        mcpHost: url.host,
        source: bankSource(conn.config || {}) ? 'bank' : 'ledger',
        accounts: accounts.map((a) => ({ id: a.id, name: plainName(a.name), currency: a.currency || 'USD' })),
        secretSource: (conn.config && conn.config.apiKey) ? 'connection' : 'FINLYNQ_API_KEY',
      },
    };
  },

  async pullAccounts(conn, opts) {
    const config = conn.config || {};
    const sync = await syncBankFeed(conn, opts);
    const accounts = await listAccounts(conn, opts);
    if (!bankSource(config)) return accounts.map(normalizeAccount);
    const out = [];
    for (const a of accounts) {
      const anchor = await latestAnchor(conn, a.id, opts);
      const n = normalizeAccount(a);
      n.balanceCurrent = anchor ? num(anchor.amount) : null;
      n.currency = (anchor && anchor.currency) || n.currency;
      n.raw = Object.assign({}, n.raw, {
        basis: 'bank_anchor',
        balance_date: anchor ? String(anchor.date).slice(0, 10) : null,
        ledger_balance: num(a.balance),
        bank_feed_sync: sync,
      });
      out.push(n);
    }
    return out;
  },

  async pullTransactions(conn, opts) {
    const config = conn.config || {};
    const start = startDate(config, opts);
    const out = [];
    if (bankSource(config)) {
      for (const a of await listAccounts(conn, opts)) {
        const data = await restRequest(conn, 'GET', `/api/import/bank-ledger?accountId=${encodeURIComponent(Number(a.id))}`, opts);
        for (const t of (data && data.transactions) || []) {
          if (t.date && String(t.date).slice(0, 10) >= start) out.push(normalizeBankTransaction(t, a.id));
        }
      }
      return out;
    }
    for (const a of await listAccounts(conn, opts)) {
      const data = await callTool(conn, 'search_transactions', { account_id: Number(a.id), start_date: start, limit: TXN_LIMIT }, opts);
      const rows = (data && data.results) || [];
      for (const t of rows) out.push(normalizeTransaction(t, a.id));
    }
    return out;
  },
};

module.exports = { finlynqConnector, normalizeAccount, normalizeTransaction, normalizeBankTransaction, READ_TOOLS, READ_OPS };
