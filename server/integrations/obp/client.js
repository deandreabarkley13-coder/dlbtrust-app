/**
 * Open Bank Project REST Client
 * Wraps OBP v4.0.0 API for account and transaction operations.
 */

'use strict';

const fetch = require('node-fetch');

const OBP_URL          = process.env.OBP_URL || 'https://your-obp-instance/obp/v4.0.0';
const OBP_CONSUMER_KEY = process.env.OBP_CONSUMER_KEY || '';
const OBP_TOKEN        = process.env.OBP_TOKEN || '';
const OBP_BANK_ID      = process.env.OBP_BANK_ID || 'dlbtrust';

function headers() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `DirectLogin token="${OBP_TOKEN}"`,
    'Consumer-Key': OBP_CONSUMER_KEY,
  };
}

async function obpRequest(method, path, body) {
  const url = `${OBP_URL}${path}`;
  const opts = { method, headers: headers() };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = text; }

  if (!res.ok) {
    const msg = typeof data === 'object' ? JSON.stringify(data) : data;
    throw new Error(`OBP ${method} ${path} failed (${res.status}): ${msg}`);
  }
  return data;
}

/**
 * Create a bank account for a beneficiary
 */
async function createAccount(beneficiary) {
  return obpRequest('POST', `/banks/${OBP_BANK_ID}/accounts`, {
    user_id: beneficiary.user_id || beneficiary.id,
    label: beneficiary.name || `Beneficiary ${beneficiary.id}`,
    type: 'CURRENT',
    balance: { currency: 'USD', amount: '0' },
    branch_id: '001',
    account_routings: [{
      scheme: 'OBP',
      address: `beneficiary-${beneficiary.id}`,
    }],
  });
}

/**
 * Get transactions for an account
 */
async function getTransactions(account_id) {
  return obpRequest('GET', `/banks/${OBP_BANK_ID}/accounts/${account_id}/transactions`, null);
}

module.exports = { createAccount, getTransactions };
