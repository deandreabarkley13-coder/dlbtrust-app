'use strict';

/**
 * Plaid connector — read-only data aggregation (Balance + Transactions) for
 * banks without a direct API, e.g. the trust's Betterment Checking account.
 *
 * Connection config:
 *   {
 *     env:          'sandbox' | 'development' | 'production'   (default: PLAID_ENV || 'production')
 *     clientId?:    '...',      // falls back to PLAID_CLIENT_ID
 *     clientSecret?: '...',     // projected from AGGREGATOR_<CONNECTION>_CLIENT_SECRET, falls back to PLAID_SECRET
 *     accessToken?: '...',      // projected from AGGREGATOR_<CONNECTION>_ACCESS_TOKEN (Item access token from Link)
 *     accountIds?:  ['...'],    // restrict to these Plaid account_ids (default: all accounts on the Item)
 *     lookbackDays?: 90,        // first-pull transaction window when opts.since is absent
 *     mode:         'live' | 'shadow',
 *   }
 *
 * Linking flow (one-time, admin): createLinkToken(conn) → complete Plaid Link
 * in the browser → exchangePublicToken(conn, publicToken) → store the returned
 * access_token in Secret Manager as AGGREGATOR_<CONNECTION>_ACCESS_TOKEN. The
 * token is never written to banking_aggregator_connections.config.
 *
 * Handshake: POST /item/get proves client credentials + access token and
 * yields item_id (external_connection_id) and the institution; capabilities
 * are { pull: true, push: false, webhook: !!config.webhookUrl }.
 */

const PLAID_HOSTS = {
  sandbox: 'https://sandbox.plaid.com',
  development: 'https://development.plaid.com',
  production: 'https://production.plaid.com',
};

function plaidEnv(config) {
  const env = String(config.env || process.env.PLAID_ENV || 'production').toLowerCase();
  if (!PLAID_HOSTS[env]) throw new Error(`Unknown Plaid env "${env}" (sandbox|development|production)`);
  return env;
}

function credentials(config) {
  const clientId = config.clientId || process.env.PLAID_CLIENT_ID;
  const secret = config.clientSecret || process.env.PLAID_SECRET;
  if (!clientId || !secret) {
    throw new Error('Plaid credentials missing: set config.clientId/clientSecret (AGGREGATOR_<CONNECTION>_CLIENT_SECRET) or PLAID_CLIENT_ID/PLAID_SECRET');
  }
  return { client_id: clientId, secret };
}

function accessToken(config) {
  const token = config.accessToken || process.env.PLAID_ACCESS_TOKEN;
  if (!token) {
    throw new Error('Plaid access token missing: complete Plaid Link and store AGGREGATOR_<CONNECTION>_ACCESS_TOKEN');
  }
  return token;
}

async function plaidRequest(conn, path, body, { timeoutMs } = {}) {
  const config = conn.config || {};
  const url = PLAID_HOSTS[plaidEnv(config)] + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 30000);
  if (timer.unref) timer.unref();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(Object.assign({}, credentials(config), body || {})),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`Plaid request failed (${path}): ${err.name === 'AbortError' ? 'timeout' : err.message}`);
  }
  clearTimeout(timer);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  if (!res.ok || (json && json.error_code)) {
    const code = json && json.error_code ? `${json.error_code}: ` : '';
    const msg = (json && (json.error_message || json.display_message)) || `HTTP ${res.status}`;
    throw new Error(`Plaid ${path}: ${code}${msg}`);
  }
  return json || {};
}

function accountFilter(config) {
  const ids = Array.isArray(config.accountIds) && config.accountIds.length ? new Set(config.accountIds.map(String)) : null;
  return (a) => !ids || ids.has(String(a.account_id));
}

function normalizeAccount(a) {
  const bal = a.balances || {};
  return {
    externalAccountId: String(a.account_id),
    name: a.official_name || a.name || null,
    accountType: [a.type, a.subtype].filter(Boolean).join('/') || null,
    currency: bal.iso_currency_code || bal.unofficial_currency_code || 'USD',
    mask: a.mask || null,
    balanceAvailable: bal.available != null ? Number(bal.available) : null,
    balanceCurrent: bal.current != null ? Number(bal.current) : null,
    raw: a,
  };
}

// Plaid amounts are positive for money leaving the account (debits).
function normalizeTransaction(t) {
  const amount = Number(t.amount);
  const pfc = t.personal_finance_category || {};
  return {
    externalTxnId: String(t.transaction_id),
    externalAccountId: String(t.account_id),
    postedDate: t.authorized_date || t.date || null,
    amount: Number.isFinite(amount) ? Math.abs(amount) : null,
    currency: t.iso_currency_code || t.unofficial_currency_code || 'USD',
    direction: Number.isFinite(amount) && amount > 0 ? 'debit' : 'credit',
    description: t.merchant_name || t.name || null,
    category: pfc.primary || (Array.isArray(t.category) ? t.category.join('/') : null),
    status: t.pending ? 'pending' : 'posted',
    raw: t,
  };
}

function isoDate(d) { return new Date(d).toISOString().slice(0, 10); }

const plaidConnector = {
  type: 'plaid',

  async handshake(conn, opts) {
    const config = conn.config || {};
    const { item } = await plaidRequest(conn, '/item/get', { access_token: accessToken(config) }, opts);
    if (!item || !item.item_id) throw new Error('Plaid /item/get returned no item_id');
    let institution = null;
    if (item.institution_id) {
      try {
        const r = await plaidRequest(conn, '/institutions/get_by_id',
          { institution_id: item.institution_id, country_codes: ['US'] }, opts);
        institution = r.institution ? { id: item.institution_id, name: r.institution.name || null } : { id: item.institution_id };
      } catch (e) {
        institution = { id: item.institution_id };
      }
    }
    if (item.error) {
      throw new Error(`Plaid Item in error state: ${item.error.error_code || ''} ${item.error.error_message || ''}`.trim());
    }
    return {
      externalConnectionId: String(item.item_id),
      capabilities: { pull: true, push: false, webhook: !!config.webhookUrl },
      meta: {
        provider: 'plaid',
        env: plaidEnv(config),
        institution,
        products: item.products || [],
        secretSource: config.accessToken ? 'connection' : 'PLAID_ACCESS_TOKEN',
      },
    };
  },

  async pullAccounts(conn, opts) {
    const config = conn.config || {};
    const { accounts } = await plaidRequest(conn, '/accounts/balance/get', { access_token: accessToken(config) }, opts);
    return (accounts || []).filter(accountFilter(config)).map(normalizeAccount);
  },

  async pullTransactions(conn, opts) {
    const config = conn.config || {};
    const token = accessToken(config);
    const lookbackDays = Number(config.lookbackDays) > 0 ? Number(config.lookbackDays) : 90;
    const start = opts && opts.since ? isoDate(opts.since) : isoDate(Date.now() - lookbackDays * 86400000);
    const end = isoDate(Date.now());
    const ids = Array.isArray(config.accountIds) && config.accountIds.length ? config.accountIds.map(String) : undefined;
    const out = [];
    let offset = 0;
    const count = 500;
    for (let page = 0; page < 40; page++) {
      const body = {
        access_token: token,
        start_date: start,
        end_date: end,
        options: Object.assign({ count, offset, include_personal_finance_category: true }, ids ? { account_ids: ids } : {}),
      };
      const r = await plaidRequest(conn, '/transactions/get', body, opts);
      const txns = r.transactions || [];
      for (const t of txns) out.push(normalizeTransaction(t));
      offset += txns.length;
      if (!txns.length || offset >= Number(r.total_transactions || 0)) break;
    }
    return out;
  },

  /** One-time Link bootstrap: returns a link_token for the Plaid Link UI. */
  async createLinkToken(conn, { redirectUri, webhookUrl } = {}) {
    const config = conn.config || {};
    const body = {
      user: { client_user_id: String(config.clientUserId || conn.id) },
      client_name: config.clientName || 'DLB Trust Treasury',
      products: config.products || ['transactions'],
      country_codes: config.countryCodes || ['US'],
      language: 'en',
    };
    if (redirectUri || config.redirectUri) body.redirect_uri = redirectUri || config.redirectUri;
    if (webhookUrl || config.webhookUrl) body.webhook = webhookUrl || config.webhookUrl;
    const r = await plaidRequest(conn, '/link/token/create', body);
    return { linkToken: r.link_token, expiration: r.expiration || null, env: plaidEnv(config) };
  },

  /** One-time Link bootstrap: exchanges the Link public_token for the Item access token. */
  async exchangePublicToken(conn, publicToken) {
    if (!publicToken) throw new Error('publicToken is required');
    const r = await plaidRequest(conn, '/item/public_token/exchange', { public_token: publicToken });
    return { accessToken: r.access_token, itemId: r.item_id };
  },
};

module.exports = { plaidConnector, PLAID_HOSTS, normalizeAccount, normalizeTransaction };
