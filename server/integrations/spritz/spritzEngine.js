'use strict';

/**
 * SpritzEngine — crypto-to-fiat off-ramp via the Spritz Finance API.
 *
 * Uses the user API key (SPRITZ_API_KEY) as a Bearer token against
 * https://platform.spritz.finance. Supports bank-account management,
 * off-ramp quotes, on-chain transaction params, and execution from an
 * internal DLB wallet.
 */

const { getConfig } = require('../dapp/config');

const SUPPORTED_CHAINS = ['ethereum','polygon','arbitrum','base','optimism','avalanche','binance-smart-chain','solana','bitcoin','dash','tron','sui','hyperevm','monad','sonic','unichain'];
const SUPPORTED_RAILS = ['ach_standard','rtp','wire','eft','sepa','push_to_debit','bill_pay'];

function str(name, def = '') { return (process.env[name] || def).trim(); }
function baseUrl() { return str('SPRITZ_API_BASE_URL', 'https://platform.spritz.finance').replace(/\/$/, ''); }
function apiKey() {
  const key = str('SPRITZ_API_KEY');
  if (!key) throw new Error('SPRITZ_API_KEY not configured');
  return key;
}

function cleanPath(p) { return p.startsWith('/') ? p : '/' + p; }

async function spritzRequest(method, path, body) {
  const url = baseUrl() + cleanPath(path);
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
      'User-Agent': 'dlbtrust-spritz-engine/1.0',
      Origin: 'https://dlbtrust-app.fly.dev',
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Spritz API ${method} ${path} failed: ${res.status} ${res.statusText} — ${text || 'no body'}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

class SpritzEngine {
  static async getUser() {
    return spritzRequest('GET', '/v1/users/me');
  }

  static async listBankAccounts() {
    return spritzRequest('GET', '/v1/bank-accounts/');
  }

  static async createUSBankAccount({ routingNumber, accountNumber, accountSubtype = 'checking', ownership = 'personal', label } = {}) {
    if (!routingNumber || !accountNumber) throw new Error('routingNumber and accountNumber required');
    const body = {
      type: 'us',
      ownership,
      routingNumber,
      accountNumber,
      accountSubtype: accountSubtype.toLowerCase(),
    };
    if (label) body.label = label;
    return spritzRequest('POST', '/v1/bank-accounts/', body);
  }

  static async createOffRampQuote({ accountId, amount, chain = 'ethereum', tokenAddress, amountMode = 'output', rail = 'ach_standard', memo } = {}) {
    if (!accountId || amount === undefined || amount === null) throw new Error('accountId and amount required');
    const c = String(chain).toLowerCase();
    if (!SUPPORTED_CHAINS.includes(c)) throw new Error(`Unsupported chain: ${chain}`);
    const r = String(rail).toLowerCase();
    if (!SUPPORTED_RAILS.includes(r)) throw new Error(`Unsupported rail: ${rail}`);
    const body = { accountId, amount: String(amount), chain: c, rail: r, amountMode: amountMode === 'input' ? 'input' : 'output' };
    if (tokenAddress) body.tokenAddress = tokenAddress;
    if (memo) body.memo = memo;
    return spritzRequest('POST', '/v1/off-ramp-quotes/', body);
  }

  static async getOffRampQuote(quoteId) {
    if (!quoteId) throw new Error('quoteId required');
    return spritzRequest('GET', `/v1/off-ramp-quotes/${quoteId}`);
  }

  static async getTransactionParams(quoteId, { senderAddress, feePayer } = {}) {
    if (!quoteId) throw new Error('quoteId required');
    const body = {};
    if (senderAddress) body.senderAddress = senderAddress;
    if (feePayer) body.feePayer = feePayer;
    return spritzRequest('POST', `/v1/off-ramp-quotes/${quoteId}/transaction`, body);
  }

  static async listOffRamps() {
    return spritzRequest('GET', '/v1/off-ramps/');
  }

  static async getOffRamp(offRampId) {
    if (!offRampId) throw new Error('offRampId required');
    return spritzRequest('GET', `/v1/off-ramps/${offRampId}`);
  }
}

module.exports = { SpritzEngine, SUPPORTED_CHAINS, SUPPORTED_RAILS };
