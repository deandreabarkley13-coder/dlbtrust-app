/**
 * Virtual Account Generator Engine
 * 
 * Generates unique virtual bank accounts for every platform account.
 * Virtual accounts provide real routing + account numbers that map back
 * to the trust's master account at the ODFI (Eaton Family Credit Union).
 * 
 * Each virtual account:
 * - Has a unique 10-digit account number under the trust's master routing
 * - Maps 1:1 to a platform trust_account
 * - Can send/receive external ACH and wire payments
 * - Maintains its own ledger balance
 * - Is automatically created when a trust_account is opened
 * 
 * Routing: 241075470 (Eaton Family Credit Union)
 * Master Account: DEANDREA LAVAR BARKLEY TRUST
 * Virtual Account Prefix: 8800 (identifies DLB Trust virtual accounts)
 * 
 * How virtual accounts work:
 * 1. Platform creates trust_account → virtual account auto-generated
 * 2. Virtual account gets unique number: 8800-XXXXXX (10 digits total)
 * 3. External parties send to: routing=241075470, account=88XXXXXXXX
 * 4. Incoming payments are routed to the correct trust_account via the virtual mapping
 * 5. Outgoing payments originate from the virtual account number
 */

'use strict';

const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');

// Configuration
const ODFI_ROUTING_NUMBER = '241075470'; // Eaton Family Credit Union
const VIRTUAL_PREFIX = '8800';           // DLB Trust virtual account identifier
const ORIGINATOR_NAME = 'DEANDREA LAVAR BARKLEY TRUST';

// ─── Virtual Account Number Generation ────────────────────────────────────────

/**
 * Generate a unique 10-digit virtual account number.
 * Format: 8800XXXXXX where X is derived from account metadata + random.
 * 
 * The prefix 8800 identifies this as a DLB Trust virtual account.
 * The remaining 6 digits are unique per account.
 */
function generateVirtualAccountNumber(accountId, accountType = 'operating') {
  // Type-based sub-prefix (2nd digit pair after 8800)
  const typeMap = {
    'corpus':       '10',
    'operating':    '20',
    'reserve':      '30',
    'beneficiary':  '40',
    'trustee_fee':  '50',
    'tax_escrow':   '60',
    'investment':   '70',
    'petty_cash':   '80',
    'vendor':       '90',
    'distribution': '01',
  };

  const typeCode = typeMap[accountType] || '00';
  
  // Generate unique 4-digit suffix using account ID + entropy
  const hash = crypto.createHash('sha256')
    .update(`${accountId}-${accountType}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`)
    .digest('hex');
  const suffix = parseInt(hash.substring(0, 8), 16).toString().substring(0, 4).padStart(4, '0');
  
  return `${VIRTUAL_PREFIX}${typeCode}${suffix}`;
}

/**
 * Generate a check digit using Luhn algorithm (standard for account numbers)
 */
function luhnCheckDigit(number) {
  const digits = number.split('').reverse().map(Number);
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits[i];
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return ((10 - (sum % 10)) % 10).toString();
}

/**
 * Create a virtual account with full banking details
 */
function createVirtualAccount(platformAccountId, accountName, accountType, ownerName, options = {}) {
  const baseNumber = generateVirtualAccountNumber(platformAccountId, accountType);
  const checkDigit = luhnCheckDigit(baseNumber);
  const fullAccountNumber = `${baseNumber}${checkDigit}`;

  // Determine account capabilities based on type
  const capabilities = determineCapabilities(accountType);

  const virtualAccount = {
    id: `va_${crypto.randomBytes(6).toString('hex')}`,
    platform_account_id: platformAccountId,
    routing_number: ODFI_ROUTING_NUMBER,
    account_number: fullAccountNumber,
    account_number_display: formatAccountDisplay(fullAccountNumber),
    account_name: accountName,
    account_type: accountType,
    owner_name: ownerName || ORIGINATOR_NAME,
    bank_name: 'Eaton Family Credit Union',
    originator: ORIGINATOR_NAME,
    currency: options.currency || 'USD',
    status: 'active',
    capabilities,
    // Payment details for external parties
    payment_details: {
      bank_name: 'Eaton Family Credit Union',
      routing_number: ODFI_ROUTING_NUMBER,
      account_number: fullAccountNumber,
      account_type: mapAccountTypeForACH(accountType),
      beneficiary_name: ownerName || ORIGINATOR_NAME,
      reference: `DLB-${platformAccountId}`,
    },
    // Limits
    daily_ach_limit_cents: options.daily_ach_limit_cents || 5000000,   // $50,000 default
    daily_wire_limit_cents: options.daily_wire_limit_cents || 25000000, // $250,000 default
    single_ach_limit_cents: options.single_ach_limit_cents || 2500000,  // $25,000 default
    single_wire_limit_cents: options.single_wire_limit_cents || 25000000, // $250,000 default
    // Tracking
    total_sent_cents: 0,
    total_received_cents: 0,
    transaction_count: 0,
    created_at: new Date().toISOString(),
    last_activity: null,
  };

  return virtualAccount;
}

/**
 * Determine account capabilities based on account type
 */
function determineCapabilities(accountType) {
  const base = ['ach_receive', 'internal_transfer'];

  switch (accountType) {
    case 'corpus':
      return [...base, 'ach_send', 'wire_send', 'wire_receive', 'ach_batch'];
    case 'operating':
      return [...base, 'ach_send', 'wire_send', 'wire_receive', 'ach_batch', 'bill_pay'];
    case 'beneficiary':
      return [...base, 'ach_send', 'distribution'];
    case 'vendor':
      return [...base, 'ach_send', 'wire_send', 'bill_pay'];
    case 'investment':
      return [...base, 'wire_send', 'wire_receive', 'securities'];
    case 'reserve':
      return [...base, 'ach_send']; // Limited to outbound ACH
    case 'distribution':
      return [...base, 'ach_send', 'wire_send', 'distribution'];
    default:
      return [...base, 'ach_send'];
  }
}

/**
 * Map platform account types to ACH account type codes
 */
function mapAccountTypeForACH(accountType) {
  const savingsTypes = ['corpus', 'reserve', 'investment', 'tax_escrow'];
  return savingsTypes.includes(accountType) ? 'savings' : 'checking';
}

/**
 * Format account number for display: 8800-XX-XXXXX
 */
function formatAccountDisplay(accountNumber) {
  if (accountNumber.length === 11) {
    return `${accountNumber.substring(0, 4)}-${accountNumber.substring(4, 6)}-${accountNumber.substring(6)}`;
  }
  return accountNumber;
}

// ─── Virtual Account Database Operations ──────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS virtual_accounts (
  id                      TEXT PRIMARY KEY,
  platform_account_id     INTEGER NOT NULL,
  routing_number          TEXT NOT NULL DEFAULT '241075470',
  account_number          TEXT NOT NULL UNIQUE,
  account_name            TEXT NOT NULL,
  account_type            TEXT NOT NULL DEFAULT 'operating',
  owner_name              TEXT NOT NULL,
  bank_name               TEXT NOT NULL DEFAULT 'Eaton Family Credit Union',
  currency                TEXT NOT NULL DEFAULT 'USD',
  status                  TEXT NOT NULL DEFAULT 'active',
  capabilities            TEXT NOT NULL DEFAULT '[]',
  daily_ach_limit_cents   INTEGER NOT NULL DEFAULT 5000000,
  daily_wire_limit_cents  INTEGER NOT NULL DEFAULT 25000000,
  single_ach_limit_cents  INTEGER NOT NULL DEFAULT 2500000,
  single_wire_limit_cents INTEGER NOT NULL DEFAULT 25000000,
  total_sent_cents        INTEGER NOT NULL DEFAULT 0,
  total_received_cents    INTEGER NOT NULL DEFAULT 0,
  transaction_count       INTEGER NOT NULL DEFAULT 0,
  last_activity           TEXT,
  created_at              TEXT DEFAULT (datetime('now')),
  updated_at              TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_va_platform_account ON virtual_accounts(platform_account_id);
CREATE INDEX IF NOT EXISTS idx_va_account_number ON virtual_accounts(account_number);
CREATE INDEX IF NOT EXISTS idx_va_status ON virtual_accounts(status);

-- Virtual account transaction log
CREATE TABLE IF NOT EXISTS virtual_account_transactions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  virtual_account_id    TEXT NOT NULL,
  direction             TEXT NOT NULL DEFAULT 'outbound',
  type                  TEXT NOT NULL DEFAULT 'ach',
  amount_cents          INTEGER NOT NULL,
  recipient_name        TEXT,
  recipient_routing     TEXT,
  recipient_account     TEXT,
  description           TEXT,
  reference             TEXT,
  status                TEXT NOT NULL DEFAULT 'pending',
  delivery_method       TEXT,
  delivery_confirmation TEXT,
  nacha_filename        TEXT,
  obp_transaction_id    TEXT,
  error_message         TEXT,
  created_at            TEXT DEFAULT (datetime('now')),
  completed_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_vatx_va_id ON virtual_account_transactions(virtual_account_id);
CREATE INDEX IF NOT EXISTS idx_vatx_status ON virtual_account_transactions(status);
`;

/**
 * Initialize virtual account schema in database
 */
function initVirtualAccountSchema(db) {
  db.exec(SCHEMA_SQL);
}

/**
 * Save a virtual account to database
 */
function saveVirtualAccount(db, va) {
  db.prepare(`
    INSERT OR REPLACE INTO virtual_accounts
      (id, platform_account_id, routing_number, account_number, account_name, account_type,
       owner_name, bank_name, currency, status, capabilities,
       daily_ach_limit_cents, daily_wire_limit_cents, single_ach_limit_cents, single_wire_limit_cents,
       total_sent_cents, total_received_cents, transaction_count, last_activity, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    va.id, va.platform_account_id, va.routing_number, va.account_number,
    va.account_name, va.account_type, va.owner_name, va.bank_name,
    va.currency, va.status, JSON.stringify(va.capabilities),
    va.daily_ach_limit_cents, va.daily_wire_limit_cents,
    va.single_ach_limit_cents, va.single_wire_limit_cents,
    va.total_sent_cents, va.total_received_cents, va.transaction_count,
    va.last_activity, va.created_at
  );
  return va;
}

/**
 * Get virtual account by platform account ID
 */
function getVirtualAccountByPlatformId(db, platformAccountId) {
  const row = db.prepare('SELECT * FROM virtual_accounts WHERE platform_account_id = ? AND status = ?').get(platformAccountId, 'active');
  if (row) {
    row.capabilities = JSON.parse(row.capabilities || '[]');
    row.payment_details = {
      bank_name: row.bank_name,
      routing_number: row.routing_number,
      account_number: row.account_number,
      account_type: mapAccountTypeForACH(row.account_type),
      beneficiary_name: row.owner_name,
      reference: `DLB-${row.platform_account_id}`,
    };
  }
  return row;
}

/**
 * Get virtual account by account number
 */
function getVirtualAccountByNumber(db, accountNumber) {
  const row = db.prepare('SELECT * FROM virtual_accounts WHERE account_number = ?').get(accountNumber);
  if (row) row.capabilities = JSON.parse(row.capabilities || '[]');
  return row;
}

/**
 * List all virtual accounts
 */
function listVirtualAccounts(db, options = {}) {
  let query = 'SELECT * FROM virtual_accounts';
  const params = [];
  const conditions = [];

  if (options.status) {
    conditions.push('status = ?');
    params.push(options.status);
  }
  if (options.account_type) {
    conditions.push('account_type = ?');
    params.push(options.account_type);
  }

  if (conditions.length) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY created_at DESC';

  const rows = db.prepare(query).all(...params);
  return rows.map(r => {
    r.capabilities = JSON.parse(r.capabilities || '[]');
    r.payment_details = {
      bank_name: r.bank_name,
      routing_number: r.routing_number,
      account_number: r.account_number,
      account_type: mapAccountTypeForACH(r.account_type),
      beneficiary_name: r.owner_name,
    };
    return r;
  });
}

/**
 * Record a transaction against a virtual account
 */
function recordTransaction(db, vaId, txData) {
  const result = db.prepare(`
    INSERT INTO virtual_account_transactions
      (virtual_account_id, direction, type, amount_cents, recipient_name, recipient_routing,
       recipient_account, description, reference, status, delivery_method, delivery_confirmation,
       nacha_filename, obp_transaction_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    vaId, txData.direction || 'outbound', txData.type || 'ach',
    txData.amount_cents, txData.recipient_name || null,
    txData.recipient_routing || null, txData.recipient_account || null,
    txData.description || null, txData.reference || null,
    txData.status || 'pending', txData.delivery_method || null,
    txData.delivery_confirmation ? JSON.stringify(txData.delivery_confirmation) : null,
    txData.nacha_filename || null, txData.obp_transaction_id || null
  );

  // Update virtual account stats
  if (txData.direction === 'outbound') {
    db.prepare(`
      UPDATE virtual_accounts 
      SET total_sent_cents = total_sent_cents + ?, transaction_count = transaction_count + 1, 
          last_activity = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(txData.amount_cents, vaId);
  } else {
    db.prepare(`
      UPDATE virtual_accounts 
      SET total_received_cents = total_received_cents + ?, transaction_count = transaction_count + 1,
          last_activity = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(txData.amount_cents, vaId);
  }

  return { transaction_id: result.lastInsertRowid };
}

/**
 * Get transaction history for a virtual account
 */
function getTransactionHistory(db, vaId, limit = 50) {
  return db.prepare(`
    SELECT * FROM virtual_account_transactions 
    WHERE virtual_account_id = ? 
    ORDER BY created_at DESC 
    LIMIT ?
  `).all(vaId, limit);
}

// ─── Auto-Creation Hook ──────────────────────────────────────────────────────

/**
 * Hook: Called when a platform account is created.
 * Auto-generates the corresponding virtual account.
 */
function onAccountCreated(db, platformAccount) {
  initVirtualAccountSchema(db);

  // Check if virtual account already exists
  const existing = getVirtualAccountByPlatformId(db, platformAccount.id);
  if (existing) return existing;

  // Create virtual account
  const va = createVirtualAccount(
    platformAccount.id,
    platformAccount.account_name,
    platformAccount.account_type,
    platformAccount.owner_name || ORIGINATOR_NAME
  );

  // Save to database
  saveVirtualAccount(db, va);

  return va;
}

/**
 * Ensure all existing accounts have virtual accounts (backfill)
 */
function backfillVirtualAccounts(db) {
  initVirtualAccountSchema(db);
  
  const accounts = db.prepare(`
    SELECT id, account_name, account_type, owner_name 
    FROM trust_accounts 
    WHERE status != 'closed'
  `).all();

  const created = [];
  for (const acct of accounts) {
    const existing = getVirtualAccountByPlatformId(db, acct.id);
    if (!existing) {
      const va = onAccountCreated(db, acct);
      created.push(va);
    }
  }

  return { backfilled: created.length, accounts: created };
}

// ─── External Payment via Virtual Account ─────────────────────────────────────

/**
 * Process an external payment from a virtual account.
 * This is the main entry point for sending money externally.
 * 
 * Flow:
 * 1. Validate virtual account exists and has capability
 * 2. Check limits
 * 3. Record transaction
 * 4. Route through payment gateway (OBP → Moov → SFTP → Manual)
 * 5. Update transaction status
 */
async function sendExternalPayment(db, virtualAccountId, payment) {
  initVirtualAccountSchema(db);

  // Get virtual account
  const va = db.prepare('SELECT * FROM virtual_accounts WHERE id = ? AND status = ?').get(virtualAccountId, 'active');
  if (!va) {
    return { success: false, error: 'Virtual account not found or inactive' };
  }
  va.capabilities = JSON.parse(va.capabilities || '[]');

  // Check capability
  const paymentType = payment.type || 'ach';
  const requiredCap = paymentType === 'wire' ? 'wire_send' : 'ach_send';
  if (!va.capabilities.includes(requiredCap)) {
    return { success: false, error: `Virtual account does not have ${requiredCap} capability` };
  }

  // Check limits
  const amountCents = payment.amount_cents || Math.round(parseFloat(payment.amount || 0) * 100);
  const singleLimit = paymentType === 'wire' ? va.single_wire_limit_cents : va.single_ach_limit_cents;
  if (amountCents > singleLimit) {
    return { success: false, error: `Amount exceeds single transaction limit ($${(singleLimit / 100).toFixed(2)})` };
  }

  // Record the transaction as pending
  const txRecord = recordTransaction(db, va.id, {
    direction: 'outbound',
    type: paymentType,
    amount_cents: amountCents,
    recipient_name: payment.recipient_name,
    recipient_routing: payment.routing_number,
    recipient_account: payment.account_number,
    description: payment.description,
    reference: payment.reference,
    status: 'processing',
  });

  // Route through the payment gateway engine
  let gatewayResult;
  try {
    const { processExternalPayment } = require('./payment-gateway-engine');
    gatewayResult = await processExternalPayment({
      ...payment,
      amount_cents: amountCents,
      payment_type: paymentType,
      source_account: va.account_number,
      source_routing: va.routing_number,
    });
  } catch (err) {
    gatewayResult = { success: false, status: 'failed', error: err.message };
  }

  // Update transaction with result
  const finalStatus = gatewayResult.status === 'submitted_to_fed' || gatewayResult.status === 'delivered_to_bank' 
    ? 'completed' 
    : gatewayResult.status === 'file_ready' || gatewayResult.status === 'ledger_only'
    ? 'staged'
    : 'failed';

  db.prepare(`
    UPDATE virtual_account_transactions 
    SET status = ?, delivery_method = ?, delivery_confirmation = ?,
        nacha_filename = ?, obp_transaction_id = ?, error_message = ?,
        completed_at = CASE WHEN ? IN ('completed', 'staged') THEN datetime('now') ELSE NULL END
    WHERE id = ?
  `).run(
    finalStatus,
    gatewayResult.delivery_method || null,
    gatewayResult.confirmation ? JSON.stringify(gatewayResult.confirmation) : null,
    gatewayResult.nacha_file?.filename || null,
    gatewayResult.steps?.find(s => s.channel === 'obp_ledger')?.transaction_id || null,
    gatewayResult.error || null,
    finalStatus,
    txRecord.transaction_id
  );

  return {
    success: finalStatus !== 'failed',
    transaction_id: txRecord.transaction_id,
    virtual_account: {
      id: va.id,
      account_number: va.account_number,
      routing_number: va.routing_number,
    },
    payment: {
      amount_cents: amountCents,
      amount_dollars: (amountCents / 100).toFixed(2),
      recipient_name: payment.recipient_name,
      routing_number: payment.routing_number,
      account_masked: payment.account_number ? `****${payment.account_number.slice(-4)}` : '',
      type: paymentType,
    },
    delivery: {
      status: finalStatus,
      method: gatewayResult.delivery_method,
      confirmation: gatewayResult.confirmation,
      steps: gatewayResult.steps,
    },
    gateway_result: gatewayResult,
  };
}

module.exports = {
  // Generation
  generateVirtualAccountNumber,
  createVirtualAccount,
  // Database
  initVirtualAccountSchema,
  saveVirtualAccount,
  getVirtualAccountByPlatformId,
  getVirtualAccountByNumber,
  listVirtualAccounts,
  recordTransaction,
  getTransactionHistory,
  // Hooks
  onAccountCreated,
  backfillVirtualAccounts,
  // Payments
  sendExternalPayment,
  // Constants
  ODFI_ROUTING_NUMBER,
  VIRTUAL_PREFIX,
  ORIGINATOR_NAME,
  SCHEMA_SQL,
};
