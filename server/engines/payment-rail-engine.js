/**
 * Payment Rail Engine — Increase Integration
 * DEANDREA LAVAR BARKLEY TRUST — Real Money Movement
 *
 * Provider-agnostic interface wrapping the Increase API for
 * ACH, Wire, RTP (Real-Time Payments), and Check transfers.
 *
 * All amounts are in cents. Idempotency keys prevent duplicate submissions.
 */

'use strict';

// --- Constants ---------------------------------------------------------------

const INCREASE_SANDBOX_URL = 'https://sandbox.increase.com';
const INCREASE_PRODUCTION_URL = 'https://api.increase.com';

const RAILS = {
  ach:   { name: 'ACH',   endpoint: '/ach_transfers',                speed: '1-3 days',  fee: 0 },
  wire:  { name: 'Wire',  endpoint: '/wire_transfers',               speed: 'Same day',   fee: 2500 },
  rtp:   { name: 'RTP',   endpoint: '/real_time_payments_transfers', speed: 'Seconds',    fee: 100 },
  check: { name: 'Check', endpoint: '/check_transfers',              speed: '5-10 days',  fee: 500 },
};

const ACH_SEC_CODES = {
  CCD: 'Corporate Credit or Debit',
  PPD: 'Prearranged Payment and Deposit',
  WEB: 'Internet-Initiated Entry',
  TEL: 'Telephone-Initiated Entry',
};

const STATUS_MAP = {
  // Increase ACH statuses → our statuses
  pending_approval:    'pending_approval',
  canceled:            'cancelled',
  pending_reviewing:   'processing',
  pending_submission:  'pending_submission',
  submitted:           'submitted',
  returned:            'returned',
  requires_attention:  'failed',
  rejected:            'failed',
  // Increase Wire statuses
  complete:            'completed',
  reversed:            'reversed',
  // Increase RTP statuses
  created:             'submitted',
  // Increase Check statuses
  pending_mailing:     'processing',
  mailed:              'sent',
  deposited:           'completed',
  stopped:             'cancelled',
};

const ACH_RETURN_CODES = {
  R01: 'Insufficient Funds',
  R02: 'Account Closed',
  R03: 'No Account/Unable to Locate',
  R04: 'Invalid Account Number',
  R05: 'Unauthorized Debit',
  R06: 'Returned per ODFI Request',
  R07: 'Authorization Revoked',
  R08: 'Payment Stopped',
  R09: 'Uncollected Funds',
  R10: 'Customer Advises Not Authorized',
  R11: 'Check Truncation Entry Return',
  R12: 'Branch Sold to Another DFI',
  R13: 'Invalid ACH Routing Number',
  R14: 'Representative Payee Deceased',
  R15: 'Beneficiary or Account Holder Deceased',
  R16: 'Account Frozen',
  R17: 'File Record Edit Criteria',
  R20: 'Non-Transaction Account',
  R21: 'Invalid Company Identification',
  R22: 'Invalid Individual ID Number',
  R23: 'Credit Entry Refused by Receiver',
  R24: 'Duplicate Entry',
  R29: 'Corporate Customer Advises Not Authorized',
};

// --- Transaction Number Generator --------------------------------------------

function generateRailTxNumber() {
  const d = new Date();
  const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `RAIL-${dateStr}-${rand}`;
}

// --- Idempotency Key Generator -----------------------------------------------

function generateIdempotencyKey(prefix) {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix || 'dlb'}_${ts}_${rand}`;
}

// --- Increase API Client -----------------------------------------------------

class IncreaseClient {
  constructor(apiKey, environment = 'sandbox') {
    this.apiKey = apiKey;
    this.baseUrl = environment === 'production'
      ? INCREASE_PRODUCTION_URL
      : INCREASE_SANDBOX_URL;
  }

  async request(method, path, body = null, idempotencyKey = null) {
    const headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    const options = { method, headers };
    if (body && (method === 'POST' || method === 'PATCH')) {
      options.body = JSON.stringify(body);
    }

    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, options);
    const data = await response.json();

    if (!response.ok) {
      const err = new Error(data.detail || data.title || `Increase API error ${response.status}`);
      err.status = response.status;
      err.increaseError = data;
      throw err;
    }
    return data;
  }

  // --- Accounts ---

  async listAccounts(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request('GET', `/accounts${qs ? '?' + qs : ''}`);
  }

  async getAccount(accountId) {
    return this.request('GET', `/accounts/${accountId}`);
  }

  async getAccountBalance(accountId) {
    return this.request('GET', `/accounts/${accountId}/balance`);
  }

  // --- External Accounts ---

  async createExternalAccount(body, idempotencyKey) {
    return this.request('POST', '/external_accounts', body, idempotencyKey);
  }

  async getExternalAccount(extAccountId) {
    return this.request('GET', `/external_accounts/${extAccountId}`);
  }

  async listExternalAccounts(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request('GET', `/external_accounts${qs ? '?' + qs : ''}`);
  }

  // --- ACH Transfers ---

  async createACHTransfer(body, idempotencyKey) {
    return this.request('POST', '/ach_transfers', body, idempotencyKey);
  }

  async getACHTransfer(transferId) {
    return this.request('GET', `/ach_transfers/${transferId}`);
  }

  async listACHTransfers(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request('GET', `/ach_transfers${qs ? '?' + qs : ''}`);
  }

  async approveACHTransfer(transferId) {
    return this.request('POST', `/ach_transfers/${transferId}/approve`);
  }

  async cancelACHTransfer(transferId) {
    return this.request('POST', `/ach_transfers/${transferId}/cancel`);
  }

  // --- Wire Transfers ---

  async createWireTransfer(body, idempotencyKey) {
    return this.request('POST', '/wire_transfers', body, idempotencyKey);
  }

  async getWireTransfer(transferId) {
    return this.request('GET', `/wire_transfers/${transferId}`);
  }

  async listWireTransfers(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request('GET', `/wire_transfers${qs ? '?' + qs : ''}`);
  }

  async approveWireTransfer(transferId) {
    return this.request('POST', `/wire_transfers/${transferId}/approve`);
  }

  async cancelWireTransfer(transferId) {
    return this.request('POST', `/wire_transfers/${transferId}/cancel`);
  }

  // --- Real-Time Payments ---

  async createRTPTransfer(body, idempotencyKey) {
    return this.request('POST', '/real_time_payments_transfers', body, idempotencyKey);
  }

  async getRTPTransfer(transferId) {
    return this.request('GET', `/real_time_payments_transfers/${transferId}`);
  }

  async listRTPTransfers(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request('GET', `/real_time_payments_transfers${qs ? '?' + qs : ''}`);
  }

  // --- Check Transfers ---

  async createCheckTransfer(body, idempotencyKey) {
    return this.request('POST', '/check_transfers', body, idempotencyKey);
  }

  async getCheckTransfer(transferId) {
    return this.request('GET', `/check_transfers/${transferId}`);
  }

  async listCheckTransfers(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request('GET', `/check_transfers${qs ? '?' + qs : ''}`);
  }

  async approveCheckTransfer(transferId) {
    return this.request('POST', `/check_transfers/${transferId}/approve`);
  }

  async cancelCheckTransfer(transferId) {
    return this.request('POST', `/check_transfers/${transferId}/cancel`);
  }

  // --- Transactions ---

  async listTransactions(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request('GET', `/transactions${qs ? '?' + qs : ''}`);
  }

  async getTransaction(txId) {
    return this.request('GET', `/transactions/${txId}`);
  }

  // --- Events ---

  async listEvents(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request('GET', `/events${qs ? '?' + qs : ''}`);
  }

  // --- Event Subscriptions ---

  async createEventSubscription(body) {
    return this.request('POST', '/event_subscriptions', body);
  }

  async listEventSubscriptions(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request('GET', `/event_subscriptions${qs ? '?' + qs : ''}`);
  }
}

// --- Build Increase Transfer Payload -----------------------------------------

function buildACHPayload({ accountId, externalAccountId, amount, description, secCode, idempotencyKey, settlementSchedule }) {
  const payload = {
    account_id: accountId,
    amount: amount,                     // positive = credit (send money), negative = debit (pull money)
    statement_descriptor: description || 'DLB Trust Payment',
    standard_entry_class_code: secCode || 'corporate_credit_or_debit',
  };
  if (externalAccountId) {
    payload.external_account_id = externalAccountId;
  }
  if (settlementSchedule) {
    payload.preferred_effective_date = { settlement_schedule: settlementSchedule };
  }
  return payload;
}

function buildWirePayload({ accountId, externalAccountId, accountNumber, routingNumber, amount, beneficiaryName, memo }) {
  const payload = {
    account_id: accountId,
    amount: amount,
  };
  if (externalAccountId) {
    payload.external_account_id = externalAccountId;
  } else {
    payload.account_number = accountNumber;
    payload.routing_number = routingNumber;
    payload.beneficiary_name = beneficiaryName || 'Beneficiary';
  }
  if (memo) {
    payload.message_to_recipient = memo;
  }
  return payload;
}

function buildRTPPayload({ accountId, externalAccountId, amount, creditorName, remittanceInfo }) {
  return {
    source_account_number_id: accountId,   // RTP uses account_number_id
    external_account_id: externalAccountId,
    amount: amount,
    creditor_name: creditorName || 'DLB Trust',
    remittance_information: remittanceInfo || 'Payment',
  };
}

function buildCheckPayload({ accountId, amount, recipientName, mailingAddress, memo }) {
  return {
    account_id: accountId,
    amount: amount,
    fulfillment_method: 'physical_check',
    physical_check: {
      recipient_name: recipientName,
      mailing_address: mailingAddress,
      memo: memo || 'DLB Trust Payment',
    },
  };
}

// --- Map Increase status to our status ---------------------------------------

function mapIncreaseStatus(increaseStatus) {
  return STATUS_MAP[increaseStatus] || increaseStatus;
}

// --- Validation --------------------------------------------------------------

function validateRailRequest(body) {
  const errors = [];
  if (!body.rail) errors.push('rail is required (ach, wire, rtp, check)');
  if (!RAILS[body.rail]) errors.push(`Invalid rail: ${body.rail}. Must be one of: ${Object.keys(RAILS).join(', ')}`);
  if (!body.amount_cents && !body.amount) errors.push('amount is required');
  const amount = body.amount_cents || (body.amount ? Math.round(parseFloat(body.amount) * 100) : 0);
  if (amount <= 0) errors.push('amount must be positive');
  if (amount > 100000000) errors.push('amount exceeds single-transaction maximum ($1,000,000)');

  if (body.rail === 'ach' || body.rail === 'wire') {
    if (!body.increase_account_id && !body.from_account_id) {
      errors.push('increase_account_id or from_account_id is required');
    }
  }
  if (body.rail === 'check') {
    if (!body.recipient_name) errors.push('recipient_name is required for check transfers');
    if (!body.mailing_address) errors.push('mailing_address is required for check transfers');
  }
  return errors;
}

// --- Daily Limit Check -------------------------------------------------------

function checkDailyLimit(db, rail, amountCents, configLimitKey) {
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) as total
    FROM rail_transactions
    WHERE rail = ? AND DATE(created_at) = ? AND status NOT IN ('cancelled', 'failed', 'returned')
  `).get(rail, today);

  const limitRow = db.prepare('SELECT config_value FROM rail_config WHERE config_key = ?').get(configLimitKey);
  const limit = limitRow ? parseInt(limitRow.config_value) : Infinity;
  const currentTotal = row ? row.total : 0;

  if (currentTotal + amountCents > limit) {
    return {
      exceeded: true,
      current: currentTotal,
      limit: limit,
      remaining: Math.max(0, limit - currentTotal),
    };
  }
  return { exceeded: false, current: currentTotal, limit, remaining: limit - currentTotal };
}

// --- Fee Calculation ---------------------------------------------------------

function calculateRailFee(rail) {
  return RAILS[rail]?.fee || 0;
}

// --- Mask Account Number -----------------------------------------------------

function maskAccountNumber(num) {
  if (!num || num.length <= 4) return num;
  return '****' + num.slice(-4);
}

// --- Dollars/Cents -----------------------------------------------------------

function toDollars(cents) { return (cents / 100).toFixed(2); }

// --- Audit Entry Builder -----------------------------------------------------

function buildRailAuditEntry(eventType, railTxId, action, actor, details) {
  return {
    event_type:  eventType,
    entity_type: 'rail_transaction',
    entity_id:   String(railTxId),
    actor:       actor || 'system',
    action:      action,
    details:     typeof details === 'string' ? details : JSON.stringify(details),
  };
}

module.exports = {
  RAILS,
  ACH_SEC_CODES,
  ACH_RETURN_CODES,
  STATUS_MAP,
  INCREASE_SANDBOX_URL,
  INCREASE_PRODUCTION_URL,
  IncreaseClient,
  generateRailTxNumber,
  generateIdempotencyKey,
  buildACHPayload,
  buildWirePayload,
  buildRTPPayload,
  buildCheckPayload,
  mapIncreaseStatus,
  validateRailRequest,
  checkDailyLimit,
  calculateRailFee,
  maskAccountNumber,
  toDollars,
  buildRailAuditEntry,
};
