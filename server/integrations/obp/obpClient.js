/**
 * Open Banking Project (OBP) API Client
 * Free, open-source banking APIs — standardised REST interface for accounts,
 * transactions, counterparties, and payments.
 *
 * Sandbox: https://apisandbox.openbankproject.com
 * Docs:    https://github.com/OpenBankProject/OBP-API/wiki
 *
 * Authentication: DirectLogin (username + password + consumer_key → token)
 * Transaction Requests: SANDBOX_TAN, COUNTERPARTY, SEPA, FREE_FORM, ACCOUNT
 *
 * Self-hosted: Docker image at openbankproject/obp-api
 * Or connect to the free public sandbox for testing.
 */
'use strict';

const https = require('https');
const http  = require('http');

// Config from environment
const OBP_BASE_URL    = process.env.OBP_BASE_URL    || 'http://127.0.0.1:8080';
const OBP_API_VERSION = process.env.OBP_API_VERSION  || 'v4.0.0';
const OBP_USERNAME    = process.env.OBP_USERNAME     || '';
const OBP_PASSWORD    = process.env.OBP_PASSWORD     || '';
const OBP_CONSUMER_KEY = process.env.OBP_CONSUMER_KEY || '';
const OBP_BANK_ID     = process.env.OBP_BANK_ID     || '';
const OBP_ACCOUNT_ID  = process.env.OBP_ACCOUNT_ID  || '';
const OBP_VIEW_ID     = process.env.OBP_VIEW_ID     || 'owner';

// Token cache
let cachedToken = '';
let tokenExpiry = 0;

// ─── HTTP Request Helper ──────────────────────────────────────────────────────

function obpRequest(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = `${OBP_BASE_URL}/obp/${OBP_API_VERSION}${path}`;
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';

    const headers = {
      'Accept': 'application/json',
    };

    if (token) {
      headers['Authorization'] = `DirectLogin token="${token}"`;
    }

    let bodyStr = null;
    if (body) {
      bodyStr = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
      timeout: 30000,
    };

    const transport = isHttps ? https : http;
    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(`OBP ${res.statusCode}: ${json.message || json.error || data.substring(0, 300)}`));
          }
        } catch (_) {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ raw: data });
          } else {
            reject(new Error(`OBP ${res.statusCode}: ${data.substring(0, 300)}`));
          }
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OBP request timed out')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Raw request without version prefix (for auth endpoint)
function obpRawRequest(method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = `${OBP_BASE_URL}${path}`;
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';

    const reqHeaders = {
      'Accept': 'application/json',
      ...headers,
    };

    let bodyStr = null;
    if (body) {
      bodyStr = JSON.stringify(body);
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname,
      method,
      headers: reqHeaders,
      timeout: 30000,
    };

    const transport = isHttps ? https : http;
    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(`OBP Auth ${res.statusCode}: ${json.message || json.error || data.substring(0, 300)}`));
          }
        } catch (_) {
          reject(new Error(`OBP Auth ${res.statusCode}: ${data.substring(0, 300)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OBP auth request timed out')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Authentication ───────────────────────────────────────────────────────────

/**
 * Authenticate via DirectLogin and get a token.
 * Token is cached for 1 hour.
 */
async function authenticate() {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  if (!OBP_USERNAME || !OBP_PASSWORD || !OBP_CONSUMER_KEY) {
    throw new Error('OBP credentials not configured (OBP_USERNAME, OBP_PASSWORD, OBP_CONSUMER_KEY)');
  }

  const authHeader = `DirectLogin username="${OBP_USERNAME}", password="${OBP_PASSWORD}", consumer_key="${OBP_CONSUMER_KEY}"`;
  const result = await obpRawRequest('POST', '/my/logins/direct', {
    'Authorization': authHeader,
  });

  if (!result.token) {
    throw new Error('OBP authentication failed — no token returned');
  }

  cachedToken = result.token;
  tokenExpiry = Date.now() + 3600000; // 1 hour
  return cachedToken;
}

// ─── Bank & Account Operations ────────────────────────────────────────────────

/** List all banks available on the OBP instance */
async function getBanks() {
  const token = await authenticate();
  return obpRequest('GET', '/banks', null, token);
}

/** Get details for a specific bank */
async function getBank(bankId) {
  const token = await authenticate();
  return obpRequest('GET', `/banks/${bankId}`, null, token);
}

/** Get all accounts the authenticated user can access */
async function getAccounts(bankId) {
  const token = await authenticate();
  return obpRequest('GET', `/banks/${bankId}/accounts/private`, null, token);
}

/** Get account details */
async function getAccountById(bankId, accountId) {
  const token = await authenticate();
  return obpRequest('GET', `/banks/${bankId}/accounts/${accountId}/owner/account`, null, token);
}

/** Get account balance */
async function getAccountBalance(bankId, accountId) {
  const account = await getAccountById(bankId, accountId);
  return account.balance || { currency: 'USD', amount: '0' };
}

/** Get transactions for an account */
async function getTransactions(bankId, accountId, limit = 50) {
  const token = await authenticate();
  return obpRequest('GET', `/banks/${bankId}/accounts/${accountId}/owner/transactions?limit=${limit}`, null, token);
}

// ─── Counterparty Operations ──────────────────────────────────────────────────

/** Create a counterparty (beneficiary) on an account */
async function createCounterparty(bankId, accountId, counterpartyData) {
  const token = await authenticate();
  return obpRequest('POST', `/banks/${bankId}/accounts/${accountId}/owner/counterparties`, {
    name: counterpartyData.name,
    description: counterpartyData.description || '',
    currency: counterpartyData.currency || 'USD',
    other_account_routing_scheme: counterpartyData.routing_scheme || 'OBP',
    other_account_routing_address: counterpartyData.routing_address || counterpartyData.account_id || '',
    other_account_secondary_routing_scheme: counterpartyData.secondary_routing_scheme || '',
    other_account_secondary_routing_address: counterpartyData.secondary_routing_address || '',
    other_bank_routing_scheme: counterpartyData.bank_routing_scheme || 'OBP',
    other_bank_routing_address: counterpartyData.bank_routing_address || counterpartyData.bank_id || '',
    other_branch_routing_scheme: '',
    other_branch_routing_address: '',
    is_beneficiary: true,
    bespoke: counterpartyData.bespoke || [],
  }, token);
}

/** Get all counterparties for an account */
async function getCounterparties(bankId, accountId) {
  const token = await authenticate();
  return obpRequest('GET', `/banks/${bankId}/accounts/${accountId}/owner/counterparties`, null, token);
}

// ─── Transaction Request Operations ───────────────────────────────────────────

/**
 * Get supported transaction request types for a bank
 */
async function getTransactionRequestTypes(bankId, accountId) {
  const token = await authenticate();
  return obpRequest('GET', `/banks/${bankId}/accounts/${accountId}/owner/transaction-request-types`, null, token);
}

/**
 * Create a SANDBOX_TAN transaction request (send money to a known bank_id/account_id)
 */
async function createTransactionRequestSandbox(bankId, accountId, toBank, toAccount, amount, currency, description) {
  const token = await authenticate();
  return obpRequest(
    'POST',
    `/banks/${bankId}/accounts/${accountId}/owner/transaction-request-types/SANDBOX_TAN/transaction-requests`,
    {
      to: { bank_id: toBank, account_id: toAccount },
      value: { currency: currency || 'USD', amount: String(amount) },
      description: description || '',
    },
    token
  );
}

/**
 * Create a COUNTERPARTY transaction request (send money to an existing counterparty)
 */
async function createTransactionRequestCounterparty(bankId, accountId, counterpartyId, amount, currency, description) {
  const token = await authenticate();
  return obpRequest(
    'POST',
    `/banks/${bankId}/accounts/${accountId}/owner/transaction-request-types/COUNTERPARTY/transaction-requests`,
    {
      to: { counterparty_id: counterpartyId },
      value: { currency: currency || 'USD', amount: String(amount) },
      description: description || '',
      charge_policy: 'SHARED',
    },
    token
  );
}

/**
 * Create a SEPA transaction request (international via IBAN)
 */
async function createTransactionRequestSEPA(bankId, accountId, iban, amount, currency, description) {
  const token = await authenticate();
  return obpRequest(
    'POST',
    `/banks/${bankId}/accounts/${accountId}/owner/transaction-request-types/SEPA/transaction-requests`,
    {
      to: { iban },
      value: { currency: currency || 'EUR', amount: String(amount) },
      description: description || '',
      charge_policy: 'SHARED',
    },
    token
  );
}

/**
 * Create a FREE_FORM transaction request (flexible structure for custom payments)
 */
async function createTransactionRequestFreeForm(bankId, accountId, body) {
  const token = await authenticate();
  return obpRequest(
    'POST',
    `/banks/${bankId}/accounts/${accountId}/owner/transaction-request-types/FREE_FORM/transaction-requests`,
    body,
    token
  );
}

/**
 * Create an ACCOUNT transaction request (simple same-bank transfer)
 */
async function createTransactionRequestAccount(bankId, accountId, toBankId, toAccountId, amount, currency, description) {
  const token = await authenticate();
  return obpRequest(
    'POST',
    `/banks/${bankId}/accounts/${accountId}/owner/transaction-request-types/ACCOUNT/transaction-requests`,
    {
      to: { bank_id: toBankId, account_id: toAccountId },
      value: { currency: currency || 'USD', amount: String(amount) },
      description: description || '',
    },
    token
  );
}

/**
 * Answer a transaction request challenge (for amounts above threshold)
 */
async function answerChallenge(bankId, accountId, transactionRequestType, transactionRequestId, challengeId, answer) {
  const token = await authenticate();
  return obpRequest(
    'POST',
    `/banks/${bankId}/accounts/${accountId}/owner/transaction-request-types/${transactionRequestType}/transaction-requests/${transactionRequestId}/challenge`,
    { id: challengeId, answer },
    token
  );
}

/**
 * Get all transaction requests for an account
 */
async function getTransactionRequests(bankId, accountId) {
  const token = await authenticate();
  return obpRequest('GET', `/banks/${bankId}/accounts/${accountId}/owner/transaction-requests`, null, token);
}

// ─── High-Level Disbursement ──────────────────────────────────────────────────

/**
 * Full disbursement workflow:
 * 1. Create counterparty if needed
 * 2. Submit transaction request
 * 3. Answer challenge if required
 *
 * @param {Object} opts
 * @param {string} opts.recipient_name
 * @param {string} opts.routing_number - ABA routing (mapped to bank routing)
 * @param {string} opts.account_number - Account number (mapped to account routing)
 * @param {number} opts.amount_cents
 * @param {string} opts.description
 */
async function disbursement(opts) {
  const bankId = opts.bank_id || OBP_BANK_ID;
  const accountId = opts.account_id || OBP_ACCOUNT_ID;

  if (!bankId || !accountId) {
    throw new Error('OBP bank_id and account_id required for disbursement');
  }

  const amountUSD = (opts.amount_cents / 100).toFixed(2);

  // Try SANDBOX_TAN first (works in sandbox with known target accounts)
  // For sandbox testing, the to bank_id and account_id must exist in the OBP instance
  if (opts.to_bank_id && opts.to_account_id) {
    const txReq = await createTransactionRequestSandbox(
      bankId, accountId,
      opts.to_bank_id, opts.to_account_id,
      amountUSD, 'USD',
      opts.description || `Payment to ${opts.recipient_name}`
    );

    // Handle challenge if required
    if (txReq.challenge && txReq.challenge.id) {
      // In sandbox, challenge answer is usually the challenge_id itself
      const answered = await answerChallenge(
        bankId, accountId, 'SANDBOX_TAN',
        txReq.id, txReq.challenge.id,
        txReq.challenge.id
      );
      return answered;
    }

    return txReq;
  }

  // For real payments — create counterparty with routing info, then send via COUNTERPARTY type
  const counterparty = await createCounterparty(bankId, accountId, {
    name: opts.recipient_name,
    description: `Disbursement recipient — ${opts.description || ''}`,
    routing_scheme: 'ACH',
    routing_address: opts.account_number,
    bank_routing_scheme: 'ABA',
    bank_routing_address: opts.routing_number,
    currency: 'USD',
  });

  const txReq = await createTransactionRequestCounterparty(
    bankId, accountId,
    counterparty.counterparty_id || counterparty.id,
    amountUSD, 'USD',
    opts.description || `Payment to ${opts.recipient_name}`
  );

  // Handle challenge
  if (txReq.challenge && txReq.challenge.id) {
    const answered = await answerChallenge(
      bankId, accountId, 'COUNTERPARTY',
      txReq.id, txReq.challenge.id,
      txReq.challenge.id
    );
    return answered;
  }

  return txReq;
}

// ─── Health Check ─────────────────────────────────────────────────────────────

async function healthCheck() {
  try {
    if (!OBP_USERNAME || !OBP_PASSWORD || !OBP_CONSUMER_KEY) {
      return { connected: false, error: 'OBP credentials not configured' };
    }

    // Authenticate to verify credentials
    const token = await authenticate();
    // Use /banks endpoint instead of /users/current to avoid OBP NULL-column bug
    const banks = await obpRequest('GET', '/banks', null, token);
    const bankList = banks.banks || [];
    return {
      connected: true,
      banks: bankList.length,
      bank_id: OBP_BANK_ID,
      base_url: OBP_BASE_URL,
      api_version: OBP_API_VERSION,
    };
  } catch (err) {
    return { connected: false, error: err.message };
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  OBP_BASE_URL,
  OBP_USERNAME,
  OBP_CONSUMER_KEY,
  OBP_BANK_ID,
  OBP_ACCOUNT_ID,
  authenticate,
  getBanks,
  getBank,
  getAccounts,
  getAccountById,
  getAccountBalance,
  getTransactions,
  createCounterparty,
  getCounterparties,
  getTransactionRequestTypes,
  createTransactionRequestSandbox,
  createTransactionRequestCounterparty,
  createTransactionRequestSEPA,
  createTransactionRequestFreeForm,
  createTransactionRequestAccount,
  answerChallenge,
  getTransactionRequests,
  disbursement,
  healthCheck,
};
