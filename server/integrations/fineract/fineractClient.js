/**
 * Apache Fineract REST API Client
 * Core banking engine for double-entry GL, savings accounts, and journal entries.
 *
 * DEANDREA LAVAR BARKLEY TRUST — GL Source of Truth
 *
 * Fineract API docs: https://fineract.apache.org/docs/current
 * Auth: HTTP Basic + X-Fineract-Platform-TenantId header
 */

'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

const FINERACT_URL       = process.env.FINERACT_URL || 'https://localhost:8443/fineract-provider/api/v1';
const FINERACT_TENANT_ID = process.env.FINERACT_TENANT_ID || 'default';
const FINERACT_USERNAME  = process.env.FINERACT_USERNAME || 'mifos';
const FINERACT_PASSWORD  = process.env.FINERACT_PASSWORD || 'password';

/**
 * Low-level HTTP request to Fineract REST API.
 * Handles Basic Auth, TenantId header, and TLS for self-signed certs.
 */
function fineractRequest(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const urlStr = `${FINERACT_URL}/${endpoint}`;
    const parsed = new URL(urlStr);

    const basicAuth = Buffer.from(`${FINERACT_USERNAME}:${FINERACT_PASSWORD}`).toString('base64');

    const headers = {
      'Authorization': `Basic ${basicAuth}`,
      'X-Fineract-Platform-TenantId': FINERACT_TENANT_ID,
      'Accept': 'application/json',
    };

    let payload = null;
    if (body) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
      rejectUnauthorized: false,
    };

    const lib = parsed.protocol === 'https:' ? https : http;
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
          return reject(err);
        }
        if (!data || data.trim() === '') return resolve(null);
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Fineract parse error: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('Fineract request timed out after 30s'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── High-Level Client ────────────────────────────────────────────────────────

class FineractClient {

  /**
   * Health check — verify Fineract is reachable and authenticated.
   * Calls GET /offices to confirm connectivity.
   */
  static async healthCheck() {
    const offices = await fineractRequest('GET', 'offices');
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
    return fineractRequest('GET', `journalentries?${qs}`);
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
   * Get GL accounts (chart of accounts).
   */
  static async getGLAccounts() {
    return fineractRequest('GET', 'glaccounts');
  }

  /**
   * Get GL account summary with running balances.
   */
  static async getGLSummary() {
    const accounts = await fineractRequest('GET', 'glaccounts');
    if (!Array.isArray(accounts)) return { accounts: [] };

    const summary = {
      assets: [],
      liabilities: [],
      equity: [],
      income: [],
      expenses: [],
    };

    for (const acct of accounts) {
      const entry = {
        id: acct.id,
        name: acct.name,
        glCode: acct.glCode,
        balance: acct.organizationRunningBalance || 0,
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

    return {
      generated_at: new Date().toISOString(),
      total_assets: sumBalances(summary.assets),
      total_liabilities: sumBalances(summary.liabilities),
      total_equity: sumBalances(summary.equity),
      total_income: sumBalances(summary.income),
      total_expenses: sumBalances(summary.expenses),
      accounts: summary,
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
