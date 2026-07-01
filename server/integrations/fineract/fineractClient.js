/**
 * Apache Fineract REST API Client
 * Core banking engine for double-entry GL, savings accounts, and journal entries.
 *
 * DEANDREA LAVAR BARKLEY TRUST — GL Source of Truth
 *
 * Fineract API docs: https://fineract.apache.org/docs/current
 * Auth: HTTP Basic + X-Fineract-Platform-TenantId header
 *
 * Resilience features:
 * - Circuit breaker: fast-fails when Fineract is known-down (no 30s hangs)
 * - Retry with backoff: transient failures retry once after 2s
 * - Response cache: GL summary cached 60s, serves stale on failure
 * - Keep-alive agent: reuses TCP connections to reduce overhead
 * - Short timeout: 10s per request (was 30s)
 */

'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

const FINERACT_URL       = process.env.FINERACT_URL || 'https://localhost:8443/fineract-provider/api/v1';
const FINERACT_TENANT_ID = process.env.FINERACT_TENANT_ID || 'default';
const FINERACT_USERNAME  = process.env.FINERACT_USERNAME || 'mifos';
const FINERACT_PASSWORD  = process.env.FINERACT_PASSWORD || 'password';

// ─── Keep-Alive Agents (reuse TCP connections) ────────────────────────────────
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 4, rejectUnauthorized: false });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });

// ─── Circuit Breaker ──────────────────────────────────────────────────────────
const circuitBreaker = {
  failures: 0,
  lastFailure: 0,
  threshold: 3,        // open after 3 consecutive failures
  resetTimeout: 30000, // try again after 30s
  isOpen() {
    if (this.failures < this.threshold) return false;
    // Allow retry after resetTimeout
    if (Date.now() - this.lastFailure > this.resetTimeout) {
      this.failures = 0; // half-open: allow one request through
      return false;
    }
    return true;
  },
  recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();
  },
  recordSuccess() {
    this.failures = 0;
  },
};

// ─── Response Cache ───────────────────────────────────────────────────────────
const responseCache = new Map();
const CACHE_TTL = 60000; // 60s fresh TTL
const STALE_TTL = 300000; // 5 min stale TTL (serve stale on failure)

function getCached(key) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  const age = Date.now() - entry.timestamp;
  if (age < CACHE_TTL) return { data: entry.data, fresh: true };
  if (age < STALE_TTL) return { data: entry.data, fresh: false };
  responseCache.delete(key);
  return null;
}

function setCache(key, data) {
  responseCache.set(key, { data, timestamp: Date.now() });
}

/**
 * Low-level HTTP request to Fineract REST API.
 * Handles Basic Auth, TenantId header, TLS, circuit breaker, and retry.
 */
function fineractRequest(method, endpoint, body = null, opts = {}) {
  const timeout = opts.timeout || 10000;
  const skipCircuitBreaker = opts.skipCircuitBreaker || false;

  // Circuit breaker: fast-fail if Fineract is known-down
  if (!skipCircuitBreaker && circuitBreaker.isOpen()) {
    const err = new Error('Fineract circuit breaker OPEN — service temporarily unavailable');
    err.status = 503;
    err.circuitOpen = true;
    return Promise.reject(err);
  }

  return new Promise((resolve, reject) => {
    const urlStr = `${FINERACT_URL}/${endpoint}`;
    const parsed = new URL(urlStr);

    const basicAuth = Buffer.from(`${FINERACT_USERNAME}:${FINERACT_PASSWORD}`).toString('base64');

    const headers = {
      'Authorization': `Basic ${basicAuth}`,
      'Fineract-Platform-TenantId': FINERACT_TENANT_ID,
      'Accept': 'application/json',
    };

    let payload = null;
    if (body) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const isHttps = parsed.protocol === 'https:';
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
      rejectUnauthorized: false,
      agent: isHttps ? httpsAgent : httpAgent,
    };

    const lib = isHttps ? https : http;
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          let detail = data;
          try { detail = JSON.parse(data); } catch (_) {}
          const err = new Error(`Fineract ${method} ${endpoint} failed (${res.statusCode})`);
          err.status = res.statusCode;
          err.detail = detail;
          circuitBreaker.recordFailure();
          return reject(err);
        }
        circuitBreaker.recordSuccess();
        if (!data || data.trim() === '') return resolve(null);
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Fineract parse error: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', (err) => {
      circuitBreaker.recordFailure();
      if (err.code === 'ECONNREFUSED') {
        const e = new Error('Fineract not reachable — start with: docker compose up -d');
        e.status = 503;
        return reject(e);
      }
      reject(err);
    });
    req.setTimeout(timeout, () => {
      req.destroy(new Error(`Fineract request timed out after ${timeout / 1000}s`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Resilient request with single retry on transient failure.
 * Returns cached/stale data if both attempts fail.
 */
async function resilientFineractRequest(method, endpoint, body = null, cacheKey = null) {
  // Check fresh cache first (skip network entirely)
  if (cacheKey && method === 'GET') {
    const cached = getCached(cacheKey);
    if (cached && cached.fresh) return cached.data;
  }

  try {
    const result = await fineractRequest(method, endpoint, body);
    if (cacheKey && method === 'GET') setCache(cacheKey, result);
    return result;
  } catch (firstErr) {
    // If circuit is open, try stale cache immediately
    if (firstErr.circuitOpen) {
      if (cacheKey) {
        const stale = getCached(cacheKey);
        if (stale) return stale.data;
      }
      throw firstErr;
    }

    // Retry once after 2s for transient failures
    if (firstErr.status === 503 || firstErr.message.includes('timeout') || firstErr.message.includes('socket hang up') || firstErr.message.includes('ECONNRESET')) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const result = await fineractRequest(method, endpoint, body);
        if (cacheKey && method === 'GET') setCache(cacheKey, result);
        return result;
      } catch (retryErr) {
        // Fall through to stale cache
      }
    }

    // Serve stale cache if available
    if (cacheKey) {
      const stale = getCached(cacheKey);
      if (stale) {
        console.warn('[fineract-client] Serving stale cache for ' + endpoint + ' (age: ' + Math.round((Date.now() - responseCache.get(cacheKey).timestamp) / 1000) + 's)');
        return stale.data;
      }
    }

    throw firstErr;
  }
}

// ─── High-Level Client ────────────────────────────────────────────────────────

class FineractClient {

  /**
   * Health check — verify Fineract is reachable and authenticated.
   * Calls GET /offices to confirm connectivity.
   * Uses shorter timeout and skips circuit breaker (used for recovery detection).
   */
  static async healthCheck() {
    const offices = await fineractRequest('GET', 'offices', null, { timeout: 8000, skipCircuitBreaker: true });
    return { connected: true, offices };
  }

  /**
   * Create a client (beneficiary or trustee) in Fineract.
   * Maps to POST /clients
   */
  static async createClient({ firstName, lastName, externalId, email }) {
    const officeId = 1; // Head office (default Fineract setup)
    const payload = {
      officeId,
      legalFormId: 1, // 1 = Person (required by Fineract)
      firstname: firstName,
      lastname: lastName,
      externalId: externalId || undefined,
      emailAddress: email || undefined,
      active: true,
      locale: 'en',
      dateFormat: 'dd MMMM yyyy',
      activationDate: formatFineractDate(new Date()),
    };
    return fineractRequest('POST', 'clients', payload);
  }

  /**
   * Create a savings account for a client.
   * Maps to POST /savingsaccounts
   */
  static async createSavingsAccount({ clientId, productId, externalId }) {
    const payload = {
      clientId,
      productId,
      externalId: externalId || undefined,
      locale: 'en',
      dateFormat: 'dd MMMM yyyy',
      submittedOnDate: formatFineractDate(new Date()),
    };
    return fineractRequest('POST', 'savingsaccounts', payload);
  }

  /**
   * Get account balance and details.
   * Maps to GET /savingsaccounts/{accountId}
   */
  static async getAccountBalance(accountId) {
    return fineractRequest('GET', `savingsaccounts/${accountId}`);
  }

  /**
   * Post a double-entry GL journal entry.
   * Maps to POST /journalentries
   *
   * credits/debits format: [{ glAccountId, amount }]
   */
  static async postJournalEntry({ officeId, transactionDate, credits, debits, comments }) {
    const payload = {
      officeId: officeId || 1,
      transactionDate: formatFineractDate(transactionDate),
      comments: comments || '',
      locale: 'en',
      dateFormat: 'dd MMMM yyyy',
      currencyCode: 'USD',
      credits: credits.map(c => ({
        glAccountId: c.glAccountId,
        amount: c.amount,
      })),
      debits: debits.map(d => ({
        glAccountId: d.glAccountId,
        amount: d.amount,
      })),
    };
    return fineractRequest('POST', 'journalentries', payload);
  }

  /**
   * Get journal entries with optional filters.
   * Maps to GET /journalentries
   * Cached for frequently-used queries (no accountId filter).
   */
  static async getJournalEntries({ accountId, fromDate, toDate, offset, limit } = {}) {
    const params = new URLSearchParams();
    if (accountId) params.set('glAccountId', accountId);
    if (fromDate)  params.set('fromDate', formatFineractDateShort(fromDate));
    if (toDate)    params.set('toDate', formatFineractDateShort(toDate));
    if (offset !== undefined) params.set('offset', offset);
    if (limit !== undefined)  params.set('limit', limit);
    params.set('locale', 'en');
    params.set('dateFormat', 'dd MMMM yyyy');

    const qs = params.toString();
    const cacheKey = !accountId && !fromDate && !toDate ? 'journal_entries_' + (limit || 'all') : null;
    return resilientFineractRequest('GET', `journalentries?${qs}`, null, cacheKey);
  }

  /**
   * Create a standing instruction (recurring transfer/distribution).
   * Maps to POST /standinginstructions
   */
  static async createStandingOrder({ accountId, amount, frequency, startDate }) {
    const frequencyMap = {
      daily: 1,
      weekly: 2,
      monthly: 3,
      quarterly: 4,
      yearly: 5,
    };

    const payload = {
      fromAccountId: accountId,
      fromAccountType: 2, // savings
      name: `Standing order - ${amount}`,
      transferType: 1,    // account transfer
      priority: 1,
      instructionType: 1, // fixed
      amount,
      validFrom: formatFineractDate(startDate),
      recurrenceFrequency: frequencyMap[frequency] || 3,
      recurrenceInterval: 1,
      locale: 'en',
      dateFormat: 'dd MMMM yyyy',
    };
    return fineractRequest('POST', 'standinginstructions', payload);
  }

  /**
   * Send a command to a savings account (activate, block, close, etc.).
   */
  static async commandSavingsAccount(accountId, command) {
    return fineractRequest('POST', `savingsaccounts/${accountId}?command=${command}`, {});
  }

  /**
   * List Fineract clients with pagination.
   */
  static async listClients({ offset = 0, limit = 100 } = {}) {
    return fineractRequest('GET', `clients?offset=${offset}&limit=${limit}`);
  }

  /**
   * List savings accounts with optional client filter.
   */
  static async listSavingsAccounts({ clientId, offset = 0, limit = 100 } = {}) {
    const qs = clientId ? `clientId=${clientId}&offset=${offset}&limit=${limit}` : `offset=${offset}&limit=${limit}`;
    return fineractRequest('GET', `savingsaccounts?${qs}`);
  }

  /**
   * Create a GL account in Fineract.
   * type: 1=ASSET, 2=LIABILITY, 3=EQUITY, 4=INCOME, 5=EXPENSE
   * usage: 1=HEADER, 2=DETAIL
   */
  static async createGLAccount({ name, glCode, type, usage, description, manualEntriesAllowed }) {
    return fineractRequest('POST', 'glaccounts', {
      name,
      glCode,
      type,
      usage: usage || 2,
      description: description || '',
      manualEntriesAllowed: manualEntriesAllowed !== false,
    });
  }

  /**
   * Reverse a journal entry in Fineract.
   * Maps to POST /journalentries/{transactionId}?command=reverse
   */
  static async reverseJournalEntry(transactionId) {
    return fineractRequest('POST', `journalentries/${transactionId}?command=reverse`, {});
  }

  /**
   * Get GL accounts (chart of accounts).
   * Cached for 60s, serves stale for up to 5min on failure.
   */
  static async getGLAccounts() {
    return resilientFineractRequest('GET', 'glaccounts', null, 'gl_accounts');
  }

  /**
   * Get GL account summary with balances computed from journal entries.
   * Fineract's organizationRunningBalance is unreliable in some versions,
   * so we compute balances directly from journal entries.
   *
   * Uses resilient request with caching — serves stale data if Fineract is down.
   */
  static async getGLSummary() {
    // Check fresh cache first (avoid expensive computation)
    const cached = getCached('gl_summary');
    if (cached && cached.fresh) return cached.data;

    const accounts = await resilientFineractRequest('GET', 'glaccounts', null, 'gl_accounts_raw');
    if (!Array.isArray(accounts)) {
      // Try stale summary cache
      const stale = getCached('gl_summary');
      if (stale) return stale.data;
      return { accounts: [] };
    }

    // Fetch all journal entries to compute balances
    const balanceMap = {};
    try {
      const journalRes = await resilientFineractRequest('GET', 'journalentries?limit=10000', null, 'gl_journals');
      const entries = (journalRes && journalRes.pageItems) || [];
      for (const je of entries) {
        if (je.reversed) continue;
        const acctId = je.glAccountId;
        if (!balanceMap[acctId]) balanceMap[acctId] = 0;
        const amt = je.amount || 0;
        const isDebit = je.entryType && je.entryType.value === 'DEBIT';
        const acctType = je.glAccountType && je.glAccountType.value;
        // Assets/Expenses: debits increase, credits decrease
        // Liabilities/Equity/Income: credits increase, debits decrease
        if (acctType === 'ASSET' || acctType === 'EXPENSE') {
          balanceMap[acctId] += isDebit ? amt : -amt;
        } else {
          balanceMap[acctId] += isDebit ? -amt : amt;
        }
      }
    } catch (err) {
      // Fall back to organizationRunningBalance if journal fetch fails
    }

    const summary = {
      assets: [],
      liabilities: [],
      equity: [],
      income: [],
      expenses: [],
    };

    // Only include DETAIL accounts (usage.id === 1) in summary
    for (const acct of accounts) {
      if (acct.usage && acct.usage.id === 2) continue; // skip HEADER accounts
      const entry = {
        id: acct.id,
        name: acct.name,
        glCode: acct.glCode,
        balance: balanceMap[acct.id] || acct.organizationRunningBalance || 0,
        manualEntriesAllowed: acct.manualEntriesAllowed,
      };

      switch (acct.type && acct.type.value) {
        case 'ASSET':     summary.assets.push(entry); break;
        case 'LIABILITY': summary.liabilities.push(entry); break;
        case 'EQUITY':    summary.equity.push(entry); break;
        case 'INCOME':    summary.income.push(entry); break;
        case 'EXPENSE':   summary.expenses.push(entry); break;
        default: break;
      }
    }

    const sumBalances = (arr) => arr.reduce((s, a) => s + a.balance, 0);

    const result = {
      generated_at: new Date().toISOString(),
      total_assets: sumBalances(summary.assets),
      total_liabilities: sumBalances(summary.liabilities),
      total_equity: sumBalances(summary.equity),
      total_income: sumBalances(summary.income),
      total_expenses: sumBalances(summary.expenses),
      accounts: summary,
    };

    // Cache the computed summary
    setCache('gl_summary', result);
    return result;
  }

  /**
   * Get circuit breaker and cache status for diagnostics.
   */
  static getResilienceStatus() {
    return {
      circuitBreaker: {
        failures: circuitBreaker.failures,
        isOpen: circuitBreaker.isOpen(),
        lastFailure: circuitBreaker.lastFailure ? new Date(circuitBreaker.lastFailure).toISOString() : null,
      },
      cache: {
        entries: responseCache.size,
        keys: Array.from(responseCache.keys()),
      },
    };
  }
}

// ─── Date Helpers ─────────────────────────────────────────────────────────────

function formatFineractDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${String(d.getDate()).padStart(2, '0')} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function formatFineractDateShort(date) {
  const d = date instanceof Date ? date : new Date(date);
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${String(d.getDate()).padStart(2, '0')} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

module.exports = { FineractClient, fineractRequest };
