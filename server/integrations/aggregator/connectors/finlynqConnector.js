'use strict';

/**
 * Finlynq connector — read-only bank feed over Finlynq's first-party MCP
 * server (https://finlynq.com/api/mcp, Streamable HTTP in stateless JSON mode;
 * AGPL-3.0, github.com/finlynq/finlynq). Finlynq holds the trust's linked
 * accounts (its own SimpleFIN bank feed, OFX/CSV imports) and this connector
 * reads balances and transactions from it through two MCP read tools:
 * `get_account_balances` and `search_transactions`. No other tool is ever
 * called — the `pf_` key is account-wide, so the tool allowlist is enforced here.
 *
 * Connection config:
 *   {
 *     apiKey?:      'pf_...',       // normally projected from Secret Manager
 *                                   // (AGGREGATOR_<CONNECTION>_API_KEY) or FINLYNQ_API_KEY
 *     mcpUrl?:      'https://finlynq.com/api/mcp',   // or FINLYNQ_MCP_URL (self-hosted)
 *     accountIds?:  [12, 13],       // Finlynq accounts.id to read (default: all)
 *     lookbackDays?: 30,            // first-pull window
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

async function callTool(conn, name, args, opts) {
  if (!READ_TOOLS.includes(name)) throw new Error(`Finlynq tool ${name} is not an allowed read tool`);
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
    const missing = READ_TOOLS.filter((n) => !names.has(n));
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
        accounts: accounts.map((a) => ({ id: a.id, name: plainName(a.name), currency: a.currency || 'USD' })),
        secretSource: (conn.config && conn.config.apiKey) ? 'connection' : 'FINLYNQ_API_KEY',
      },
    };
  },

  async pullAccounts(conn, opts) {
    return (await listAccounts(conn, opts)).map(normalizeAccount);
  },

  async pullTransactions(conn, opts) {
    const config = conn.config || {};
    const start = startDate(config, opts);
    const out = [];
    for (const a of await listAccounts(conn, opts)) {
      const data = await callTool(conn, 'search_transactions', { account_id: Number(a.id), start_date: start, limit: TXN_LIMIT }, opts);
      const rows = (data && data.results) || [];
      for (const t of rows) out.push(normalizeTransaction(t, a.id));
    }
    return out;
  },
};

module.exports = { finlynqConnector, normalizeAccount, normalizeTransaction, READ_TOOLS };
