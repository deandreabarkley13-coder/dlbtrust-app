/**
 * Dwolla API Client — ACH payment processing via REST API
 * Free sandbox at api-sandbox.dwolla.com
 * Docs: https://developers.dwolla.com/
 *
 * Dwolla provides ACH, RTP, FedNow, Wire, and Push-to-Debit.
 * No SFTP needed — API-based payment submission.
 *
 * Sandbox: Free. Sign up at https://dashboard-sandbox.dwolla.com/
 * Production: Requires Dwolla account approval.
 */
'use strict';

const https = require('https');

const DWOLLA_KEY    = process.env.DWOLLA_APP_KEY || '';
const DWOLLA_SECRET = process.env.DWOLLA_APP_SECRET || '';
const DWOLLA_ENV    = process.env.DWOLLA_ENV || 'sandbox'; // 'sandbox' or 'production'

const BASE_URLS = {
  sandbox: 'https://api-sandbox.dwolla.com',
  production: 'https://api.dwolla.com',
};
const AUTH_URLS = {
  sandbox: 'https://api-sandbox.dwolla.com/token',
  production: 'https://api.dwolla.com/token',
};

let accessToken = null;
let tokenExpiry = 0;

function dwollaRequest(method, path, body = null, customHeaders = {}) {
  return new Promise((resolve, reject) => {
    const baseUrl = BASE_URLS[DWOLLA_ENV] || BASE_URLS.sandbox;
    const fullUrl = path.startsWith('http') ? path : `${baseUrl}${path}`;
    const parsed = new URL(fullUrl);

    const headers = {
      'Accept': 'application/vnd.dwolla.v1.hal+json',
      ...customHeaders,
    };

    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    let bodyStr = null;
    if (body) {
      headers['Content-Type'] = 'application/vnd.dwolla.v1.hal+json';
      bodyStr = JSON.stringify(body);
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method,
      headers,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode === 201) {
            // Created — location header has the resource URL
            resolve({ location: res.headers.location, statusCode: 201 });
          } else if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data ? JSON.parse(data) : { success: true });
          } else {
            const err = data ? JSON.parse(data) : {};
            reject(new Error(`Dwolla ${res.statusCode}: ${err.message || err.code || data.substring(0, 300)}`));
          }
        } catch (e) {
          reject(new Error(`Dwolla parse error: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Dwolla request timed out')));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Authentication ─────────────────────────────────────────────────────────

async function authenticate() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken;

  if (!DWOLLA_KEY || !DWOLLA_SECRET) {
    throw new Error('DWOLLA_APP_KEY and DWOLLA_APP_SECRET must be set');
  }

  return new Promise((resolve, reject) => {
    const authUrl = AUTH_URLS[DWOLLA_ENV] || AUTH_URLS.sandbox;
    const parsed = new URL(authUrl);
    const auth = Buffer.from(`${DWOLLA_KEY}:${DWOLLA_SECRET}`).toString('base64');
    const body = 'grant_type=client_credentials';

    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${auth}`,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            accessToken = json.access_token;
            tokenExpiry = Date.now() + (json.expires_in - 60) * 1000;
            resolve(accessToken);
          } else {
            reject(new Error(`Dwolla auth failed: ${data.substring(0, 200)}`));
          }
        } catch (e) {
          reject(new Error(`Dwolla auth parse error: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Customers ──────────────────────────────────────────────────────────────

async function createCustomer({ firstName, lastName, email, type = 'receive-only' }) {
  await authenticate();
  return dwollaRequest('POST', '/customers', {
    firstName,
    lastName,
    email,
    type, // 'receive-only', 'unverified', or 'personal'
  });
}

// ─── Funding Sources ────────────────────────────────────────────────────────

async function createFundingSource(customerUrl, { routingNumber, accountNumber, bankAccountType = 'checking', name }) {
  await authenticate();
  return dwollaRequest('POST', `${customerUrl}/funding-sources`, {
    routingNumber,
    accountNumber,
    bankAccountType,
    name: name || 'Bank Account',
  });
}

async function getFundingSources(customerUrl) {
  await authenticate();
  return dwollaRequest('GET', `${customerUrl}/funding-sources`);
}

// ─── Transfers ──────────────────────────────────────────────────────────────

/**
 * Initiate an ACH transfer
 * This is the core payment submission — no SFTP needed
 */
async function createTransfer({ sourceFundingUrl, destFundingUrl, amount, currency = 'USD', metadata = {} }) {
  await authenticate();
  return dwollaRequest('POST', '/transfers', {
    _links: {
      source: { href: sourceFundingUrl },
      destination: { href: destFundingUrl },
    },
    amount: {
      currency,
      value: amount, // e.g., "500.00"
    },
    metadata,
  });
}

async function getTransfer(transferUrl) {
  await authenticate();
  return dwollaRequest('GET', transferUrl);
}

// ─── Sandbox Simulation ─────────────────────────────────────────────────────

async function simulateTransferProcessing() {
  await authenticate();
  return dwollaRequest('POST', '/sandbox-simulations');
}

// ─── Health Check ───────────────────────────────────────────────────────────

async function healthCheck() {
  try {
    if (!DWOLLA_KEY || !DWOLLA_SECRET) {
      return { connected: false, service: 'dwolla', error: 'DWOLLA_APP_KEY/SECRET not set' };
    }
    await authenticate();
    return {
      connected: true,
      service: 'dwolla',
      environment: DWOLLA_ENV,
      message: `Dwolla API connected (${DWOLLA_ENV})`,
    };
  } catch (err) {
    return { connected: false, service: 'dwolla', error: err.message };
  }
}

/**
 * Full ACH disbursement flow via Dwolla
 */
async function disbursement({
  source_funding_url,
  recipient_name,
  recipient_email,
  routing_number,
  account_number,
  account_type = 'checking',
  amount_dollars,
  description = '',
}) {
  await authenticate();

  // Create receive-only customer
  const customer = await createCustomer({
    firstName: recipient_name.split(' ')[0] || 'Recipient',
    lastName: recipient_name.split(' ').slice(1).join(' ') || 'Payment',
    email: recipient_email || `payment-${Date.now()}@dlbtrust.cloud`,
  });

  // Add their bank account
  const fundingSource = await createFundingSource(customer.location, {
    routingNumber: routing_number,
    accountNumber: account_number,
    bankAccountType: account_type,
    name: `${recipient_name} Account`,
  });

  // Submit transfer
  const transfer = await createTransfer({
    sourceFundingUrl: source_funding_url,
    destFundingUrl: fundingSource.location,
    amount: amount_dollars,
    metadata: { description },
  });

  return {
    success: true,
    transfer_url: transfer.location,
    customer_url: customer.location,
    funding_source_url: fundingSource.location,
    delivery_method: 'dwolla',
    environment: DWOLLA_ENV,
    message: `ACH transfer submitted via Dwolla (${DWOLLA_ENV})`,
  };
}

module.exports = {
  authenticate,
  createCustomer,
  createFundingSource,
  getFundingSources,
  createTransfer,
  getTransfer,
  simulateTransferProcessing,
  healthCheck,
  disbursement,
  DWOLLA_KEY,
  DWOLLA_SECRET,
};
