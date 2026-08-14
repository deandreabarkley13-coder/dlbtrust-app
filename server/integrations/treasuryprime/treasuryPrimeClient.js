'use strict';

/**
 * Treasury Prime API client — banking-as-a-service rails for the trust.
 *
 * Auth is HTTP Basic: API key ID as the username, API secret as the password.
 *   TREASURY_PRIME_API_KEY_ID / TREASURY_PRIME_API_SECRET
 *   TREASURY_PRIME_BASE_URL (defaults to the sandbox host)
 *
 * Environments:
 *   sandbox    https://api.sandbox.treasuryprime.com  (never touches banking networks)
 *   production https://api.treasuryprime.com
 *
 * Amounts are decimal strings ("250.00") in both directions — see
 * decimalAmount.js. This client never converts them to numbers.
 */

const { normalizeAmount } = require('./decimalAmount');

const SANDBOX_BASE_URL = 'https://api.sandbox.treasuryprime.com';
const PRODUCTION_BASE_URL = 'https://api.treasuryprime.com';
// A malformed override ("30s", "") must not silently become a 1ms (NaN) or
// 30ms timeout that aborts every banking call before it can complete.
const MIN_TIMEOUT_MS = 1000;
const rawTimeout = (process.env.TREASURY_PRIME_TIMEOUT_MS || '').trim();
const DEFAULT_TIMEOUT_MS = /^\d+$/.test(rawTimeout) && Number(rawTimeout) >= MIN_TIMEOUT_MS ? Number(rawTimeout) : 30000;

function baseUrl() {
  return (process.env.TREASURY_PRIME_BASE_URL || SANDBOX_BASE_URL).replace(/\/$/, '');
}

function isProduction() {
  return baseUrl() === PRODUCTION_BASE_URL;
}

function credentials() {
  const keyId = process.env.TREASURY_PRIME_API_KEY_ID;
  const secret = process.env.TREASURY_PRIME_API_SECRET;
  if (!keyId || !secret) {
    throw new Error('Treasury Prime not configured: TREASURY_PRIME_API_KEY_ID and TREASURY_PRIME_API_SECRET required');
  }
  return Buffer.from(`${keyId}:${secret}`).toString('base64');
}

function isConfigured() {
  return !!(process.env.TREASURY_PRIME_API_KEY_ID && process.env.TREASURY_PRIME_API_SECRET);
}

function buildQuery(params = {}) {
  const qs = new URLSearchParams();
  Object.keys(params).forEach((key) => {
    const value = params[key];
    if (value !== undefined && value !== null && value !== '') qs.set(key, String(value));
  });
  const encoded = qs.toString();
  return encoded ? `?${encoded}` : '';
}

async function request(method, path, body) {
  const url = `${baseUrl()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let res;
  let text;
  try {
    res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Basic ${credentials()}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    text = await res.text();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Treasury Prime ${method} ${path} timed out after ${DEFAULT_TIMEOUT_MS}ms`);
    throw new Error(`Treasury Prime ${method} ${path} failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  let json = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error(`Treasury Prime returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
  }
  // Treasury Prime signals failures with an `error` field, sometimes on a 200.
  if (!res.ok || json.error) {
    const message = json.error || json.message || `HTTP ${res.status}`;
    throw new Error(`Treasury Prime ${method} ${path}: ${message}`);
  }
  return json;
}

/** List endpoints wrap results in { data: [...] }. */
function unwrapList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

// ─── Diagnostics ────────────────────────────────────────────────────────────
const ping = () => request('GET', '/ping');

// ─── Accounts & ledger ──────────────────────────────────────────────────────
const listAccounts = async (params) => unwrapList(await request('GET', `/account${buildQuery(params)}`));
const getAccount = (accountId) => request('GET', `/account/${encodeURIComponent(accountId)}`);
const listTransactions = async (params) => unwrapList(await request('GET', `/transaction${buildQuery(params)}`));
const listAccountTransactions = async (accountId, params) =>
  unwrapList(await request('GET', `/account/${encodeURIComponent(accountId)}/transaction${buildQuery(params)}`));

// ─── Counterparties ─────────────────────────────────────────────────────────
const listCounterparties = async (params) => unwrapList(await request('GET', `/counterparty${buildQuery(params)}`));
const getCounterparty = (id) => request('GET', `/counterparty/${encodeURIComponent(id)}`);

/**
 * Create a counterparty. Payment instructions must be nested under `ach`
 * and/or `wire` — a flat account_number/routing_number is rejected by the API.
 * For wires, `address_on_account` belongs inside the `wire` object.
 */
function createCounterparty({ nameOnAccount, ach, wire, userdata }) {
  if (!nameOnAccount) throw new Error('nameOnAccount is required');
  if (!ach && !wire) throw new Error('At least one of ach or wire payment instructions is required');
  const body = { name_on_account: nameOnAccount };
  if (ach) {
    if (!ach.accountNumber || !ach.routingNumber) throw new Error('ach requires accountNumber and routingNumber');
    body.ach = {
      account_number: ach.accountNumber,
      routing_number: ach.routingNumber,
      account_type: ach.accountType || 'checking',
    };
  }
  if (wire) {
    if (!wire.accountNumber || !wire.routingNumber) throw new Error('wire requires accountNumber and routingNumber');
    if (!wire.addressOnAccount) throw new Error('wire requires addressOnAccount (street_line_1, city, state, postal_code)');
    body.wire = {
      account_number: wire.accountNumber,
      routing_number: wire.routingNumber,
      account_type: wire.accountType || 'checking',
      address_on_account: wire.addressOnAccount,
    };
    if (wire.bankName) body.wire.bank_name = wire.bankName;
    if (wire.bankAddress) body.wire.bank_address = wire.bankAddress;
  }
  if (userdata) body.userdata = userdata;
  return request('POST', '/counterparty', body);
}

// ─── Book transfers (internal, instant, double-entry) ────────────────────────
const listBookTransfers = async (params) => unwrapList(await request('GET', `/book${buildQuery(params)}`));
const getBookTransfer = (id) => request('GET', `/book/${encodeURIComponent(id)}`);

function createBookTransfer({ amount, fromAccountId, toAccountId, memo, userdata }) {
  if (!fromAccountId || !toAccountId) throw new Error('fromAccountId and toAccountId are required');
  const body = {
    amount: normalizeAmount(amount),
    from_account_id: fromAccountId,
    to_account_id: toAccountId,
  };
  if (memo) body.memo = memo;
  if (userdata) body.userdata = userdata;
  return request('POST', '/book', body);
}

// ─── ACH ────────────────────────────────────────────────────────────────────
const listAch = async (params) => unwrapList(await request('GET', `/ach${buildQuery(params)}`));
const getAch = (id) => request('GET', `/ach/${encodeURIComponent(id)}`);

function createAch({ amount, direction, accountId, counterpartyId, secCode, entryDesc, effectiveDate, service, addenda, userdata }) {
  if (direction !== 'credit' && direction !== 'debit') throw new Error("direction must be 'credit' or 'debit'");
  if (!accountId || !counterpartyId) throw new Error('accountId and counterpartyId are required');
  const body = {
    amount: normalizeAmount(amount),
    direction,
    account_id: accountId,
    counterparty_id: counterpartyId,
    sec_code: (secCode || 'ccd').toLowerCase(),
  };
  if (entryDesc) body.entry_desc = entryDesc;
  if (effectiveDate) body.effective_date = effectiveDate;
  if (service) body.service = service;
  if (addenda) body.addenda = addenda;
  if (userdata) body.userdata = userdata;
  return request('POST', '/ach', body);
}

// ─── Wires ──────────────────────────────────────────────────────────────────
const listWires = async (params) => unwrapList(await request('GET', `/wire${buildQuery(params)}`));
const getWire = (id) => request('GET', `/wire/${encodeURIComponent(id)}`);

function createWire({ amount, accountId, counterpartyId, memo, purpose, instructions, userdata }) {
  if (!accountId || !counterpartyId) throw new Error('accountId and counterpartyId are required');
  const body = {
    amount: normalizeAmount(amount),
    account_id: accountId,
    counterparty_id: counterpartyId,
  };
  if (memo) body.memo = memo;
  if (purpose) body.purpose = purpose;
  if (instructions) body.instructions = instructions;
  if (userdata) body.userdata = userdata;
  return request('POST', '/wire', body);
}

// ─── Reference data & webhooks ──────────────────────────────────────────────
const lookupRoutingNumber = (routingNumber) => request('GET', `/routing_number/${encodeURIComponent(routingNumber)}`);
const listWebhooks = async () => unwrapList(await request('GET', '/webhook'));
/**
 * Register one webhook per event. Treasury Prime's webhook object holds a
 * single `event`, not a list, and authenticates its own callbacks with the
 * basic_user/basic_secret pair recorded here: every notification to this URL
 * then carries `Authorization: Basic base64(basic_user:basic_secret)`, which
 * is the only way the receiver can tell a real callback from a forged one.
 * basic_secret is write-only — it reads back as null.
 */
const createWebhook = ({ url, event, basicUser, basicSecret, userdata }) => {
  if (!url) throw new Error('url is required');
  if (!event) throw new Error('event is required');
  const body = { url, event };
  if (basicUser) body.basic_user = basicUser;
  if (basicSecret) body.basic_secret = basicSecret;
  if (userdata) body.userdata = userdata;
  return request('POST', '/webhook', body);
};
const updateWebhook = (id, patch = {}) => {
  if (!id) throw new Error('id is required');
  const body = {};
  if (patch.url) body.url = patch.url;
  if (patch.status) body.status = patch.status;
  if (patch.basicUser) body.basic_user = patch.basicUser;
  if (patch.basicSecret) body.basic_secret = patch.basicSecret;
  return request('PATCH', `/webhook/${encodeURIComponent(id)}`, body);
};
const deleteWebhook = (id) => request('DELETE', `/webhook/${encodeURIComponent(id)}`);

module.exports = {
  SANDBOX_BASE_URL,
  PRODUCTION_BASE_URL,
  baseUrl,
  isProduction,
  isConfigured,
  request,
  unwrapList,
  ping,
  listAccounts,
  getAccount,
  listTransactions,
  listAccountTransactions,
  listCounterparties,
  getCounterparty,
  createCounterparty,
  listBookTransfers,
  getBookTransfer,
  createBookTransfer,
  listAch,
  getAch,
  createAch,
  listWires,
  getWire,
  createWire,
  lookupRoutingNumber,
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
};
