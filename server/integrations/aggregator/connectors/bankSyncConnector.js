'use strict';

/**
 * BankSync connector — read-only open-banking feed (banksync.io) for bank
 * accounts that expose no direct API of their own, e.g. the trust's
 * Betterment Checking account.
 *
 * Connection config:
 *   {
 *     bankId?:     'bnk_...'            // BankSync bank (connection) id; or
 *     bankName?:   'Betterment',        // case-insensitive match on bank name/provider
 *     accountIds?: ['acc_...'],         // restrict to these BankSync account ids (default: all)
 *     apiKey?:     '...',               // normally projected from Secret Manager
 *                                       // (AGGREGATOR_<CONNECTION>_API_KEY) or BANKSYNC_API_KEY
 *     baseUrl?:    'https://api.banksync.io/v1',
 *     mode:        'live' | 'shadow',
 *   }
 *
 * Handshake: GET /whoami (proves the key + plan can use the API), then
 * GET /banks and resolve the configured bank. The bank id becomes the
 * external_connection_id; capabilities are { pull: true, push: false,
 * webhook: false } — BankSync is a data aggregator, so outbound payments for
 * these accounts still go over the trust's own rails (NACHA / BILL / wires).
 */

const DEFAULT_BASE_URL = 'https://api.banksync.io/v1';

function baseUrl(config) {
  return String(config.baseUrl || process.env.BANKSYNC_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
}

function apiKey(config) {
  return config.apiKey || process.env.BANKSYNC_API_KEY || null;
}

function asList(payload, key) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload[key])) return payload[key];
    if (Array.isArray(payload.data)) return payload.data;
  }
  return [];
}

async function bsRequest(conn, path, { timeoutMs } = {}) {
  const config = conn.config || {};
  const key = apiKey(config);
  if (!key) throw new Error('BankSync API key missing: set config.apiKey via AGGREGATOR_<CONNECTION>_API_KEY or BANKSYNC_API_KEY');
  const url = baseUrl(config) + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 30000);
  if (timer.unref) timer.unref();
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json', 'X-API-Key': key },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`BankSync request failed (${path}): ${err.name === 'AbortError' ? 'timeout' : err.message}`);
  }
  clearTimeout(timer);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  if (!res.ok) {
    const msg = (json && (json.message || json.error)) || `HTTP ${res.status}`;
    throw new Error(`BankSync ${path}: ${msg}`);
  }
  return json;
}

// BankSync wraps responses as { success, data, ... }; unwrap a single object.
function unwrap(payload) {
  if (payload && typeof payload === 'object' && payload.success === true && payload.data !== undefined) return payload.data;
  return payload;
}

function nextCursor(page) {
  if (!page || typeof page !== 'object' || Array.isArray(page)) return null;
  const meta = page.meta || page.pagination || {};
  return page.nextCursor || page.next_cursor || meta.nextCursor || meta.next_cursor || null;
}

function matchesBank(bank, config) {
  if (config.bankId) return String(bank.id) === String(config.bankId);
  if (config.bankName) {
    const needle = String(config.bankName).toLowerCase();
    return [bank.name, bank.provider, bank.institution, bank.institutionName]
      .some((v) => v && String(v).toLowerCase().includes(needle));
  }
  return false;
}

async function resolveBank(conn, opts) {
  const config = conn.config || {};
  if (conn.external_connection_id && conn.handshake_state === 'verified') {
    return { id: conn.external_connection_id };
  }
  if (!config.bankId && !config.bankName) {
    throw new Error('BankSync connection needs config.bankId or config.bankName (e.g. "Betterment")');
  }
  const banks = asList(await bsRequest(conn, '/banks', opts), 'banks');
  const matches = banks.filter((b) => matchesBank(b, config));
  if (!matches.length) {
    const have = banks.map((b) => b.name || b.provider || b.id).filter(Boolean).join(', ') || 'none';
    throw new Error(`BankSync has no linked bank matching ${config.bankId ? 'id ' + config.bankId : '"' + config.bankName + '"'} (linked: ${have}). Link the account in the BankSync dashboard first.`);
  }
  if (matches.length > 1 && !config.bankId) {
    throw new Error(`BankSync has ${matches.length} banks matching "${config.bankName}"; set config.bankId to one of: ${matches.map((b) => b.id).join(', ')}`);
  }
  return matches[0];
}

function accountFilter(config) {
  const ids = Array.isArray(config.accountIds) && config.accountIds.length ? new Set(config.accountIds.map(String)) : null;
  return (a) => !ids || ids.has(String(a.id));
}

function normalizeAccount(a) {
  const bal = a.balance || a.balances || {};
  const current = bal.current != null ? bal.current : (a.currentBalance != null ? a.currentBalance : null);
  const available = bal.available != null ? bal.available : (a.availableBalance != null ? a.availableBalance : null);
  return {
    externalAccountId: String(a.id),
    name: a.name || a.officialName || null,
    accountType: [a.type, a.subtype].filter(Boolean).join('/') || null,
    currency: a.currency || 'USD',
    mask: a.mask || a.last4 || null,
    balanceAvailable: available != null ? Number(available) : null,
    balanceCurrent: current != null ? Number(current) : null,
    raw: a,
  };
}

function normalizeTransaction(t, accountId) {
  const amount = Number(t.amount);
  let direction = null;
  if (t.direction) direction = String(t.direction).toLowerCase();
  else if (t.type && /credit|deposit/i.test(t.type)) direction = 'credit';
  else if (t.type && /debit|withdrawal|payment/i.test(t.type)) direction = 'debit';
  else if (Number.isFinite(amount)) direction = amount < 0 ? 'debit' : 'credit';
  return {
    externalTxnId: String(t.id),
    externalAccountId: String(t.accountId || t.account_id || accountId),
    postedDate: t.date || t.postedDate || t.posted_at || null,
    amount: Number.isFinite(amount) ? Math.abs(amount) : null,
    currency: t.currency || 'USD',
    direction,
    description: t.description || t.name || t.merchantName || null,
    category: Array.isArray(t.category) ? t.category.join('/') : (t.category || null),
    status: t.pending ? 'pending' : 'posted',
    raw: t,
  };
}

const bankSyncConnector = {
  type: 'banksync',

  async handshake(conn, opts) {
    const workspace = unwrap(await bsRequest(conn, '/whoami', opts));
    const bank = await resolveBank(Object.assign({}, conn, { handshake_state: 'pending', external_connection_id: null }), opts);
    return {
      externalConnectionId: String(bank.id),
      capabilities: { pull: true, push: false, webhook: false },
      meta: {
        provider: 'banksync',
        workspace: workspace && (workspace.workspaceName || workspace.workspaceId || workspace.name) || null,
        bank: { id: bank.id, name: bank.name || null, provider: bank.provider || null, status: bank.status || null },
        secretSource: (conn.config && conn.config.apiKey) ? 'connection' : 'BANKSYNC_API_KEY',
      },
    };
  },

  async pullAccounts(conn, opts) {
    const config = conn.config || {};
    const bank = await resolveBank(conn, opts);
    const accounts = asList(await bsRequest(conn, `/banks/${encodeURIComponent(bank.id)}/accounts`, opts), 'accounts');
    return accounts.filter(accountFilter(config)).map(normalizeAccount);
  },

  async pullTransactions(conn, opts) {
    const config = conn.config || {};
    const bank = await resolveBank(conn, opts);
    const accounts = asList(await bsRequest(conn, `/banks/${encodeURIComponent(bank.id)}/accounts`, opts), 'accounts')
      .filter(accountFilter(config));
    const out = [];
    for (const a of accounts) {
      const qs = new URLSearchParams();
      if (opts && opts.since) qs.set('from', String(opts.since).slice(0, 10));
      qs.set('limit', String((opts && opts.limit) || config.pageLimit || 200));
      let cursor = null;
      let pages = 0;
      do {
        if (cursor) qs.set('cursor', cursor);
        const page = await bsRequest(conn,
          `/banks/${encodeURIComponent(bank.id)}/accounts/${encodeURIComponent(a.id)}/transactions?${qs.toString()}`, opts);
        for (const t of asList(page, 'transactions')) out.push(normalizeTransaction(t, a.id));
        cursor = nextCursor(page);
        pages++;
      } while (cursor && pages < 50);
    }
    return out;
  },
};

module.exports = { bankSyncConnector, normalizeAccount, normalizeTransaction };
