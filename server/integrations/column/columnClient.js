/**
 * Column Bank API Client — Direct Federal Reserve ACH/Wire submission
 * Free sandbox at api.column.com (test_ prefixed keys)
 * Docs: https://docs.column.com/
 *
 * Column is a real bank (FDIC insured) with direct Fed connection.
 * No SFTP needed — single API call = ACH/Wire transfer submitted.
 *
 * Sandbox: Free, unlimited. Prefix key with test_
 * Production: Requires Column account approval. Prefix key with live_
 */
'use strict';

const https = require('https');

const COLUMN_API_KEY = process.env.COLUMN_API_KEY || '';
const COLUMN_BASE_URL = process.env.COLUMN_BASE_URL || 'https://api.column.com';

function columnRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    if (!COLUMN_API_KEY) {
      return reject(new Error('COLUMN_API_KEY not configured'));
    }

    const parsed = new URL(`${COLUMN_BASE_URL}${path}`);
    const auth = Buffer.from(`:${COLUMN_API_KEY}`).toString('base64');
    const headers = {
      'Accept': 'application/json',
      'Authorization': `Basic ${auth}`,
    };

    let bodyStr = null;
    if (body) {
      if (typeof body === 'object') {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        bodyStr = new URLSearchParams(body).toString();
      } else {
        headers['Content-Type'] = 'application/json';
        bodyStr = body;
      }
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
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(`Column ${res.statusCode}: ${json.message || json.error || data.substring(0, 300)}`));
          }
        } catch (e) {
          reject(new Error(`Column parse error: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Column request timed out')));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Entity Management ──────────────────────────────────────────────────────

async function createEntity({ first_name, last_name, ssn_last4, date_of_birth }) {
  return columnRequest('POST', '/entities/person', {
    first_name,
    last_name,
    ssn_last4: ssn_last4 || '0000',
    date_of_birth: date_of_birth || '1990-01-01',
  });
}

async function createBusinessEntity({ legal_name, ein }) {
  return columnRequest('POST', '/entities/business', {
    legal_name,
    ein: ein || '000000000',
  });
}

// ─── Bank Account ───────────────────────────────────────────────────────────

async function createBankAccount(entityId, description = 'Trust Operating Account') {
  return columnRequest('POST', '/bank-accounts', {
    entity_id: entityId,
    description,
  });
}

async function getBankAccount(bankAccountId) {
  return columnRequest('GET', `/bank-accounts/${bankAccountId}`);
}

// ─── ACH Transfers ──────────────────────────────────────────────────────────

/**
 * Create an ACH transfer (the core payment submission)
 * This is what replaces SFTP file upload — one API call sends ACH to the Fed
 */
async function createACHTransfer({
  bank_account_id,
  counterparty_id,
  amount,          // in cents (e.g., $500 = 50000)
  type = 'CREDIT', // CREDIT (send money) or DEBIT (pull money)
  currency_code = 'USD',
  description = '',
  sec_code = 'PPD',
}) {
  return columnRequest('POST', '/transfers/ach', {
    bank_account_id,
    counterparty_id,
    amount: String(amount),
    type,
    currency_code,
    description,
    sec_code,
  });
}

/**
 * Create a counterparty (external bank account to send money to)
 */
async function createCounterparty({
  routing_number,
  account_number,
  account_type = 'CHECKING',
  name,
}) {
  return columnRequest('POST', '/counterparties', {
    routing_number,
    account_number,
    account_type,
    name: name || 'Payment Recipient',
  });
}

// ─── Wire Transfers ─────────────────────────────────────────────────────────

async function createWireTransfer({
  bank_account_id,
  counterparty_id,
  amount,
  currency_code = 'USD',
  description = '',
}) {
  return columnRequest('POST', '/transfers/wire', {
    bank_account_id,
    counterparty_id,
    amount: String(amount),
    currency_code,
    description,
  });
}

// ─── Transfer Status ────────────────────────────────────────────────────────

async function getTransfer(transferId) {
  return columnRequest('GET', `/transfers/${transferId}`);
}

async function listTransfers(bankAccountId) {
  return columnRequest('GET', `/transfers?bank_account_id=${bankAccountId}`);
}

// ─── Sandbox Simulation ─────────────────────────────────────────────────────

async function simulateIncomingWire({ destination_account_number_id, amount = 100000 }) {
  return columnRequest('POST', '/simulate/receive-wire', {
    destination_account_number_id,
    amount: String(amount),
    currency_code: 'USD',
  });
}

async function settleTransfers() {
  return columnRequest('POST', '/simulate/transfers/ach/settle');
}

// ─── Health Check ───────────────────────────────────────────────────────────

async function healthCheck() {
  try {
    if (!COLUMN_API_KEY) {
      return { connected: false, service: 'column', error: 'COLUMN_API_KEY not set' };
    }
    // Try listing entities to verify API key works
    await columnRequest('GET', '/entities?limit=1');
    return {
      connected: true,
      service: 'column',
      sandbox: COLUMN_API_KEY.startsWith('test_'),
      message: `Column Bank API connected (${COLUMN_API_KEY.startsWith('test_') ? 'sandbox' : 'production'})`,
    };
  } catch (err) {
    return { connected: false, service: 'column', error: err.message };
  }
}

/**
 * Full ACH disbursement flow via Column API
 * Creates counterparty + submits ACH transfer in one call
 */
async function disbursement({
  bank_account_id,
  recipient_name,
  routing_number,
  account_number,
  account_type = 'CHECKING',
  amount_cents,
  description = '',
  sec_code = 'PPD',
}) {
  // Create counterparty for the recipient
  const counterparty = await createCounterparty({
    routing_number,
    account_number,
    account_type: account_type.toUpperCase(),
    name: recipient_name,
  });

  // Submit ACH credit transfer
  const transfer = await createACHTransfer({
    bank_account_id,
    counterparty_id: counterparty.id,
    amount: amount_cents,
    type: 'CREDIT',
    description,
    sec_code,
  });

  return {
    success: true,
    transfer_id: transfer.id,
    counterparty_id: counterparty.id,
    status: transfer.status,
    amount_cents: transfer.amount,
    delivery_method: 'column',
    message: `ACH transfer submitted via Column Bank API — ${COLUMN_API_KEY.startsWith('test_') ? 'sandbox' : 'LIVE'}`,
  };
}

module.exports = {
  createEntity,
  createBusinessEntity,
  createBankAccount,
  getBankAccount,
  createACHTransfer,
  createCounterparty,
  createWireTransfer,
  getTransfer,
  listTransfers,
  simulateIncomingWire,
  settleTransfers,
  healthCheck,
  disbursement,
  COLUMN_API_KEY,
};
