/**
 * Virtual Account Generator Engine
 * 
 * Architecture:
 * - MASTER ACCOUNTS = Core Banking trust_accounts (platform's own bank)
 * - VIRTUAL ACCOUNTS = Payment routing layer issued by the platform
 * - SETTLEMENT ACCOUNT = Eaton Family Credit Union (ABA 241075470)
 *   where trust funds are deposited after external transactions complete
 * 
 * How it works:
 * 1. Platform trust_account (Core Banking) = master account with real balance
 * 2. Virtual account auto-created for each master account
 * 3. Virtual accounts are used to initiate external payments
 * 4. Payment debits the master trust_account balance
 * 5. Payment routes through gateway (NACHA/Wire/OBP)
 * 6. Settlement happens at Eaton Family CU (deposit destination)
 * 
 * The platform IS the bank. Eaton Family CU is the correspondent/settlement bank.
 * 
 * Platform Internal Routing: DLB-241-0001 (DLB Trust Banking System)
 * Settlement Bank: Eaton Family Credit Union (ABA 241075470)
 * Virtual Account Prefix: DLB-VA-XXXX (DLB Trust issued)
 */

'use strict';

const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');

// ─── Configuration ────────────────────────────────────────────────────────────

// Platform's own banking system (master)
const PLATFORM_BANK_NAME = 'DLB Trust Banking System';
const PLATFORM_ROUTING = 'DLB-241-0001';  // Internal platform routing ID
const ORIGINATOR_NAME = 'DEANDREA LAVAR BARKLEY TRUST';

// Settlement bank (where funds are deposited externally)
const SETTLEMENT_BANK_NAME = 'Eaton Family Credit Union';
const SETTLEMENT_ROUTING = '241075470';
const SETTLEMENT_ACCOUNT = 'DLB-TRUST-SETTLEMENT-001';

// ─── Virtual Account Number Generation ────────────────────────────────────────

/**
 * Generate a unique virtual account number issued by the platform.
 * Format: DLB-VA-{TYPE}{SEQ} — platform-issued, maps to master trust_account
 */
function generateVirtualAccountNumber(accountId, accountType = 'operating') {
  const typeMap = {
    'corpus':       'CP',
    'operating':    'OP',
    'reserve':      'RS',
    'beneficiary':  'BN',
    'trustee_fee':  'TF',
    'tax_escrow':   'TX',
    'investment':   'IV',
    'petty_cash':   'PC',
    'vendor':       'VN',
    'distribution': 'DS',
  };

  const typeCode = typeMap[accountType] || 'GN';
  
  // Generate unique 6-char suffix
  const hash = crypto.createHash('sha256')
    .update(`${accountId}-${accountType}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`)
    .digest('hex');
  const suffix = hash.substring(0, 6).toUpperCase();
  
  return `DLB-VA-${typeCode}${suffix}`;
}

/**
 * Create a virtual account backed by a core banking master account
 */
function createVirtualAccount(platformAccountId, accountName, accountType, ownerName, options = {}) {
  const virtualAccountNumber = generateVirtualAccountNumber(platformAccountId, accountType);
  const capabilities = determineCapabilities(accountType);

  const virtualAccount = {
    id: `va_${crypto.randomBytes(6).toString('hex')}`,
    platform_account_id: platformAccountId,
    // Platform's own banking system — master account is the source
    routing_number: PLATFORM_ROUTING,
    account_number: virtualAccountNumber,
    account_number_display: virtualAccountNumber,
    account_name: accountName,
    account_type: accountType,
    owner_name: ownerName || ORIGINATOR_NAME,
    bank_name: PLATFORM_BANK_NAME,
    originator: ORIGINATOR_NAME,
    currency: options.currency || 'USD',
    status: 'active',
    capabilities,
    // Master account details (Core Banking trust_account backs this VA)
    master_account: {
      platform_account_id: platformAccountId,
      bank_name: PLATFORM_BANK_NAME,
      routing: PLATFORM_ROUTING,
      description: 'Core Banking Engine trust_account — source of funds',
    },
    // Settlement details (where external funds deposit)
    settlement: {
      bank_name: SETTLEMENT_BANK_NAME,
      routing_number: SETTLEMENT_ROUTING,
      account: SETTLEMENT_ACCOUNT,
      description: 'Correspondent settlement bank for trust fund deposits',
    },
    // Limits
    daily_ach_limit_cents: options.daily_ach_limit_cents || 5000000,
    daily_wire_limit_cents: options.daily_wire_limit_cents || 25000000,
    single_ach_limit_cents: options.single_ach_limit_cents || 2500000,
    single_wire_limit_cents: options.single_wire_limit_cents || 25000000,
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
      return [...base, 'ach_send'];
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

// ─── Virtual Account Database Operations ──────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS virtual_accounts (
  id                      TEXT PRIMARY KEY,
  platform_account_id     INTEGER NOT NULL,
  routing_number          TEXT NOT NULL DEFAULT 'DLB-241-0001',
  account_number          TEXT NOT NULL UNIQUE,
  account_name            TEXT NOT NULL,
  account_type            TEXT NOT NULL DEFAULT 'operating',
  owner_name              TEXT NOT NULL,
  bank_name               TEXT NOT NULL DEFAULT 'DLB Trust Banking System',
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
  settlement_status     TEXT DEFAULT 'pending',
  settlement_reference  TEXT,
  master_account_debited INTEGER DEFAULT 0,
  error_message         TEXT,
  created_at            TEXT DEFAULT (datetime('now')),
  completed_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_vatx_va_id ON virtual_account_transactions(virtual_account_id);
CREATE INDEX IF NOT EXISTS idx_vatx_status ON virtual_account_transactions(status);
`;

/**
 * Initialize virtual account schema in database.
 * Drops old schema if it exists with different structure (migration).
 */
function initVirtualAccountSchema(db) {
  // Check if migration needed (old schema used numeric routing like 241075470)
  try {
    const existing = db.prepare("SELECT routing_number FROM virtual_accounts LIMIT 1").get();
    if (existing && /^\d{9}$/.test(existing.routing_number)) {
      // Old schema — drop and recreate with new platform-issued format
      db.exec('DROP TABLE IF EXISTS virtual_account_transactions');
      db.exec('DROP TABLE IF EXISTS virtual_accounts');
    }
  } catch (_) {
    // Table doesn't exist yet — will be created below
  }
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
    row.master_account = {
      platform_account_id: row.platform_account_id,
      bank_name: PLATFORM_BANK_NAME,
      routing: PLATFORM_ROUTING,
    };
    row.settlement = {
      bank_name: SETTLEMENT_BANK_NAME,
      routing_number: SETTLEMENT_ROUTING,
      account: SETTLEMENT_ACCOUNT,
    };
  }
  return row;
}

/**
 * Get virtual account by account number
 */
function getVirtualAccountByNumber(db, accountNumber) {
  const row = db.prepare('SELECT * FROM virtual_accounts WHERE account_number = ?').get(accountNumber);
  if (row) {
    row.capabilities = JSON.parse(row.capabilities || '[]');
    row.settlement = {
      bank_name: SETTLEMENT_BANK_NAME,
      routing_number: SETTLEMENT_ROUTING,
      account: SETTLEMENT_ACCOUNT,
    };
  }
  return row;
}

/**
 * List all virtual accounts with master + settlement info
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
    r.master_account = {
      platform_account_id: r.platform_account_id,
      bank_name: PLATFORM_BANK_NAME,
      routing: PLATFORM_ROUTING,
    };
    r.settlement = {
      bank_name: SETTLEMENT_BANK_NAME,
      routing_number: SETTLEMENT_ROUTING,
      account: SETTLEMENT_ACCOUNT,
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
       nacha_filename, obp_transaction_id, master_account_debited)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    vaId, txData.direction || 'outbound', txData.type || 'ach',
    txData.amount_cents, txData.recipient_name || null,
    txData.recipient_routing || null, txData.recipient_account || null,
    txData.description || null, txData.reference || null,
    txData.status || 'pending', txData.delivery_method || null,
    txData.delivery_confirmation ? JSON.stringify(txData.delivery_confirmation) : null,
    txData.nacha_filename || null, txData.obp_transaction_id || null,
    txData.master_account_debited || 0
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
 * Hook: Called when a platform account (trust_account) is created.
 * Auto-generates the corresponding virtual account.
 * The trust_account IS the master account that funds this VA.
 */
function onAccountCreated(db, platformAccount) {
  initVirtualAccountSchema(db);

  // Check if virtual account already exists
  const existing = getVirtualAccountByPlatformId(db, platformAccount.id);
  if (existing) return existing;

  // Create virtual account backed by this trust_account (master)
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
 * Ensure all existing trust_accounts have virtual accounts (backfill)
 */
function backfillVirtualAccounts(db) {
  initVirtualAccountSchema(db);
  
  const accounts = db.prepare(`
    SELECT id, account_name, account_type, owner_name, balance_cents 
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
 * 
 * Architecture:
 * 1. Virtual account validates payment capability + limits
 * 2. DEBIT the master trust_account (Core Banking balance reduction)
 * 3. Route through payment gateway (OBP → Moov → SFTP)
 * 4. Settlement at Eaton Family CU (deposit destination)
 * 5. Record full audit trail
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

  // ─── STEP 1: DEBIT THE MASTER TRUST ACCOUNT (Core Banking) ───────────────
  // The trust_account is the source of funds. We debit it here.
  const masterAccount = db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(va.platform_account_id);
  if (!masterAccount) {
    return { success: false, error: 'Master trust account not found' };
  }
  if (masterAccount.balance_cents < amountCents) {
    return { 
      success: false, 
      error: `Insufficient funds in master account. Available: $${(masterAccount.balance_cents / 100).toFixed(2)}, Requested: $${(amountCents / 100).toFixed(2)}`,
      master_account: {
        id: masterAccount.id,
        name: masterAccount.account_name,
        balance: (masterAccount.balance_cents / 100).toFixed(2),
      }
    };
  }

  // Debit master account
  db.prepare(`
    UPDATE trust_accounts 
    SET balance_cents = balance_cents - ?, 
        available_cents = available_cents - ?,
        last_activity_date = date('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(amountCents, amountCents, masterAccount.id);

  // Record the transaction
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
    master_account_debited: 1,
  });

  // ─── STEP 2: ROUTE THROUGH PAYMENT GATEWAY ──────────────────────────────
  // Payment goes: Platform → Gateway → Settlement at Eaton Family CU
  let gatewayResult;
  try {
    const { processExternalPayment } = require('./payment-gateway-engine');
    gatewayResult = await processExternalPayment({
      ...payment,
      amount_cents: amountCents,
      payment_type: paymentType,
      source_account: va.account_number,
      source_routing: PLATFORM_ROUTING,
      // Settlement destination
      settlement_bank: SETTLEMENT_BANK_NAME,
      settlement_routing: SETTLEMENT_ROUTING,
      settlement_account: SETTLEMENT_ACCOUNT,
    });
  } catch (err) {
    gatewayResult = { success: false, status: 'failed', error: err.message, steps: [] };
  }

  // ─── STEP 3: UPDATE TRANSACTION STATUS ──────────────────────────────────
  const finalStatus = gatewayResult.status === 'submitted_to_fed' || gatewayResult.status === 'delivered_to_bank' 
    ? 'completed' 
    : gatewayResult.status === 'file_ready' || gatewayResult.status === 'ledger_only'
    ? 'staged'
    : 'processing';

  db.prepare(`
    UPDATE virtual_account_transactions 
    SET status = ?, delivery_method = ?, delivery_confirmation = ?,
        nacha_filename = ?, obp_transaction_id = ?, error_message = ?,
        settlement_status = ?,
        completed_at = CASE WHEN ? IN ('completed', 'staged') THEN datetime('now') ELSE NULL END
    WHERE id = ?
  `).run(
    finalStatus,
    gatewayResult.delivery_method || null,
    gatewayResult.confirmation ? JSON.stringify(gatewayResult.confirmation) : null,
    gatewayResult.nacha_file?.filename || null,
    gatewayResult.steps?.find(s => s.channel === 'obp_ledger')?.transaction_id || null,
    gatewayResult.error || null,
    finalStatus === 'completed' ? 'settled' : 'pending_settlement',
    finalStatus,
    txRecord.transaction_id
  );

  // Get updated master account balance
  const updatedMaster = db.prepare('SELECT balance_cents FROM trust_accounts WHERE id = ?').get(masterAccount.id);

  return {
    success: true,
    transaction_id: txRecord.transaction_id,
    virtual_account: {
      id: va.id,
      account_number: va.account_number,
      routing_number: va.routing_number,
      bank: PLATFORM_BANK_NAME,
    },
    master_account: {
      id: masterAccount.id,
      name: masterAccount.account_name,
      previous_balance: (masterAccount.balance_cents / 100).toFixed(2),
      new_balance: ((updatedMaster?.balance_cents || 0) / 100).toFixed(2),
      debited: (amountCents / 100).toFixed(2),
    },
    settlement: {
      bank: SETTLEMENT_BANK_NAME,
      routing: SETTLEMENT_ROUTING,
      account: SETTLEMENT_ACCOUNT,
      status: finalStatus === 'completed' ? 'settled' : 'pending_settlement',
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
  PLATFORM_BANK_NAME,
  PLATFORM_ROUTING,
  SETTLEMENT_BANK_NAME,
  SETTLEMENT_ROUTING,
  SETTLEMENT_ACCOUNT,
  ORIGINATOR_NAME,
  SCHEMA_SQL,
};
