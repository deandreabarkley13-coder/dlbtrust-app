'use strict';

/**
 * Electronic Payment & Secure Financial Settlement Engine
 * ────────────────────────────────────────────────────────
 *
 * Provides instant electronic payment transmission and secure settlement
 * for non-delayed vendor, distribution, and disbursement payments.
 *
 * Key capabilities:
 *  - Real-time payment file generation and submission (no batch delays)
 *  - Priority routing for urgent payments (same-day ACH, express wire, instant BILL)
 *  - Secure settlement verification with integrity hashing
 *  - Settlement finality tracking and confirmation pipeline
 *  - Automated settlement polling and reconciliation
 *  - Digital settlement certificates with cryptographic verification
 *  - Sub-ledger (Core Banking) account funding for all transactions
 *  - Data Bridge sync for cross-module consistency
 *  - Auto-retry and circuit breaker for failure recovery
 *
 * Settlement lifecycle:
 *   submitted → transmitted → accepted → clearing → settled → confirmed → finalized
 *
 * Integrates with: ACHEngine, WireEngine, BILL API, PaymentNotificationEngine,
 *                  TrustAccountingEngine, VendorEngine, SubLedgerEngine, DataBridge
 */

var crypto = require('crypto');
var pool = require('../bonds/pgPool');

var TrustAccountingEngine;
try { TrustAccountingEngine = require('../accounting/trustAccountingEngine').TrustAccountingEngine; } catch (e) { TrustAccountingEngine = null; }

var SubLedgerEngine;
try { SubLedgerEngine = require('../accounting/subLedgerEngine').SubLedgerEngine; } catch (e) { SubLedgerEngine = null; }

var DataBridge;
try { DataBridge = require('../accounting/dataBridge').DataBridge; } catch (e) { DataBridge = null; }

var billClient;
try { billClient = require('../bill/billClient'); } catch (e) { billClient = null; }

var notifEngine;
try { notifEngine = require('./paymentNotificationEngine'); } catch (e) { notifEngine = null; }

var ACHEngine;
try { ACHEngine = require('../ach/achEngine').ACHEngine; } catch (e) { ACHEngine = null; }

// OpenACH REST client — real ACH money movement via ODFI (Eaton Family Credit Union).
// This is the "core banking" rail: funds originate from the trust's own ODFI account,
// NOT from the BILL Cash Account. Preferred for vendor payments when bank details present.
var OpenACHClient;
try { OpenACHClient = require('../openach/openachClient').OpenACHClient; } catch (e) { OpenACHClient = null; }

var WireEngine;
try { WireEngine = require('../wire/wireEngine').WireEngine; } catch (e) { WireEngine = null; }

var STPEngine;
try { STPEngine = require('./stpEngine'); } catch (e) { STPEngine = null; }

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

var SETTLEMENT_STATUSES = [
  'submitted', 'transmitted', 'accepted', 'clearing',
  'settled', 'confirmed', 'finalized', 'failed', 'returned',
];

var PRIORITY_LEVELS = {
  standard:  { label: 'Standard',  sla_hours: 48, method_preference: ['ach', 'bill'] },
  express:   { label: 'Express',   sla_hours: 24, method_preference: ['bill', 'wire'] },
  urgent:    { label: 'Urgent',    sla_hours: 4,  method_preference: ['wire', 'bill'] },
  immediate: { label: 'Immediate', sla_hours: 1,  method_preference: ['wire'] },
};

var ACCOUNT_CODES = {
  CASH: '1000',
  BILL_CASH: '1050',
  SETTLEMENT_CLEARING: '1060',
  EXPENSES: '5200',
  DISTRIBUTIONS: '5100',
};

var MAX_RETRIES = 3;
var RETRY_DELAYS_MS = [1000, 3000, 8000];

// ─── CIRCUIT BREAKER ──────────────────────────────────────────────────────────

var circuitState = { failures: 0, lastFailure: 0, open: false };
var CIRCUIT_THRESHOLD = 5;
var CIRCUIT_RESET_MS = 60000;

function checkCircuit(component) {
  if (!circuitState.open) return;
  if (Date.now() - circuitState.lastFailure > CIRCUIT_RESET_MS) {
    circuitState.open = false;
    circuitState.failures = 0;
    console.log('[ElectronicSettlement] circuit breaker reset for ' + (component || 'payment'));
    return;
  }
  throw new Error('Circuit breaker OPEN — ' + (component || 'payment') + ' temporarily unavailable. Retry in ' +
    Math.ceil((CIRCUIT_RESET_MS - (Date.now() - circuitState.lastFailure)) / 1000) + 's');
}

function recordCircuitFailure(err) {
  circuitState.failures++;
  circuitState.lastFailure = Date.now();
  if (circuitState.failures >= CIRCUIT_THRESHOLD) {
    circuitState.open = true;
    console.error('[ElectronicSettlement] circuit breaker OPENED after ' + circuitState.failures + ' failures: ' + err.message);
  }
}

function recordCircuitSuccess() {
  if (circuitState.failures > 0) {
    circuitState.failures = Math.max(0, circuitState.failures - 1);
  }
}

// ─── RETRY LOGIC ──────────────────────────────────────────────────────────────

async function withRetry(fn, label, maxRetries) {
  maxRetries = maxRetries || MAX_RETRIES;
  var lastErr;
  for (var attempt = 0; attempt < maxRetries; attempt++) {
    try {
      var result = await fn();
      recordCircuitSuccess();
      return result;
    } catch (err) {
      lastErr = err;
      console.warn('[ElectronicSettlement] ' + label + ' attempt ' + (attempt + 1) + '/' + maxRetries + ' failed: ' + err.message);
      if (attempt < maxRetries - 1) {
        var delay = RETRY_DELAYS_MS[attempt] || 5000;
        await new Promise(function(r) { setTimeout(r, delay); });
      }
    }
  }
  recordCircuitFailure(lastErr);
  throw lastErr;
}

// ─── TABLE SETUP ──────────────────────────────────────────────────────────────

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS electronic_settlements (
      id                    SERIAL PRIMARY KEY,
      settlement_id         TEXT UNIQUE NOT NULL,
      payment_ref           TEXT NOT NULL,
      payment_type          TEXT NOT NULL DEFAULT 'vendor_payment',
      payment_method        TEXT NOT NULL DEFAULT 'bill',
      priority              TEXT NOT NULL DEFAULT 'standard'
                              CHECK (priority IN ('standard','express','urgent','immediate')),
      payer_name            TEXT NOT NULL DEFAULT 'DLB Trust',
      payer_account         TEXT,
      payee_name            TEXT NOT NULL,
      payee_account         TEXT,
      payee_routing         TEXT,
      payee_bank_name       TEXT,
      sub_ledger_id         TEXT,
      sub_ledger_txn_id     TEXT,
      source_account_code   TEXT DEFAULT '1000',
      amount                NUMERIC(18,2) NOT NULL,
      currency              TEXT NOT NULL DEFAULT 'USD',
      status                TEXT NOT NULL DEFAULT 'submitted'
                              CHECK (status IN ('submitted','transmitted','accepted','clearing',
                                'settled','confirmed','finalized','failed','returned')),
      payment_file_hash     TEXT,
      transmission_ref      TEXT,
      processor_ref         TEXT,
      settlement_ref        TEXT,
      confirmation_code     TEXT,
      integrity_hash        TEXT,
      settlement_certificate TEXT,
      bill_ref              TEXT,
      ach_batch_id          TEXT,
      wire_id               TEXT,
      journal_entry_id      TEXT,
      tracking_id           TEXT,
      retry_count           INTEGER DEFAULT 0,
      last_error            TEXT,
      submitted_at          TIMESTAMPTZ DEFAULT NOW(),
      transmitted_at        TIMESTAMPTZ,
      accepted_at           TIMESTAMPTZ,
      clearing_at           TIMESTAMPTZ,
      settled_at            TIMESTAMPTZ,
      confirmed_at          TIMESTAMPTZ,
      finalized_at          TIMESTAMPTZ,
      sla_deadline          TIMESTAMPTZ,
      initiated_by          TEXT NOT NULL DEFAULT 'system',
      description           TEXT,
      memo                  TEXT,
      vendor_id             TEXT,
      data_bridge_synced    BOOLEAN DEFAULT FALSE,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      updated_at            TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_es_status ON electronic_settlements(status);
    CREATE INDEX IF NOT EXISTS idx_es_payment_ref ON electronic_settlements(payment_ref);
    CREATE INDEX IF NOT EXISTS idx_es_vendor ON electronic_settlements(vendor_id);
    CREATE INDEX IF NOT EXISTS idx_es_sub_ledger ON electronic_settlements(sub_ledger_id);
  `);

  // Add new columns if table already existed from prior deploy
  var migrations = [
    'ALTER TABLE electronic_settlements ADD COLUMN IF NOT EXISTS sub_ledger_id TEXT',
    'ALTER TABLE electronic_settlements ADD COLUMN IF NOT EXISTS sub_ledger_txn_id TEXT',
    'ALTER TABLE electronic_settlements ADD COLUMN IF NOT EXISTS source_account_code TEXT DEFAULT \'1000\'',
    'ALTER TABLE electronic_settlements ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0',
    'ALTER TABLE electronic_settlements ADD COLUMN IF NOT EXISTS last_error TEXT',
    'ALTER TABLE electronic_settlements ADD COLUMN IF NOT EXISTS data_bridge_synced BOOLEAN DEFAULT FALSE',
  ];
  for (var i = 0; i < migrations.length; i++) {
    try { await pool.query(migrations[i]); } catch (e) { /* column exists */ }
  }

  // Ensure STP table exists
  if (STPEngine && STPEngine.ensureSTPTable) {
    try { await STPEngine.ensureSTPTable(); } catch (e) {
      console.warn('[ElectronicSettlement] STP table init failed:', e.message);
    }
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function generateSettlementId() {
  var ts = Date.now().toString(36).toUpperCase();
  var rand = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 4);
  return 'ESTL-' + ts + '-' + rand;
}

function generateConfirmationCode() {
  var ts = Date.now().toString(36).toUpperCase();
  var rand = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
  return 'ECONF-' + ts + '-' + rand;
}

function computeIntegrityHash(data) {
  var payload = JSON.stringify({
    settlement_id: data.settlement_id,
    amount: data.amount,
    payee_name: data.payee_name,
    payment_ref: data.payment_ref,
    timestamp: data.submitted_at || new Date().toISOString(),
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function computePaymentFileHash(fileContent) {
  return crypto.createHash('sha256').update(fileContent).digest('hex');
}

function generateSettlementCertificate(settlement) {
  var certData = {
    certificate_type: 'ELECTRONIC_SETTLEMENT_CONFIRMATION',
    settlement_id: settlement.settlement_id,
    confirmation_code: settlement.confirmation_code,
    amount: settlement.amount,
    currency: settlement.currency,
    payer: settlement.payer_name,
    payee: settlement.payee_name,
    sub_ledger_id: settlement.sub_ledger_id || null,
    payment_method: settlement.payment_method,
    settled_at: settlement.settled_at,
    confirmed_at: settlement.confirmed_at || new Date().toISOString(),
    integrity_hash: settlement.integrity_hash,
    processor_ref: settlement.processor_ref,
    settlement_ref: settlement.settlement_ref,
    bill_ref: settlement.bill_ref,
    issuer: 'DLB Trust Electronic Settlement System',
    issued_at: new Date().toISOString(),
  };
  certData.certificate_hash = crypto.createHash('sha256')
    .update(JSON.stringify(certData)).digest('hex');
  return JSON.stringify(certData);
}

// ─── SUB-LEDGER INTEGRATION ──────────────────────────────────────────────────

/**
 * Debit a Core Banking sub-ledger account to fund a payment.
 * Returns the sub-ledger transaction ID.
 */
async function debitSubLedger(subLedgerId, amount, settlementId, description) {
  if (!SubLedgerEngine) {
    console.warn('[ElectronicSettlement] SubLedgerEngine not available — skipping sub-ledger debit');
    return null;
  }

  // Validate sufficient balance before debiting
  try {
    var ledger = await SubLedgerEngine.getSubLedger(subLedgerId);
    if (ledger && parseFloat(ledger.balance) < amount) {
      throw new Error('Insufficient sub-ledger balance: $' + parseFloat(ledger.balance).toFixed(2) + ' available, $' + amount.toFixed(2) + ' required');
    }
  } catch (balErr) {
    if (balErr.message.startsWith('Insufficient')) throw balErr;
  }

  var txn = await SubLedgerEngine.postTransaction({
    subLedgerId: subLedgerId,
    transactionType: 'debit',
    amount: amount,
    description: description || ('Electronic settlement ' + settlementId),
    referenceType: 'electronic_settlement',
    referenceId: settlementId,
    postedBy: 'electronic_settlement_engine',
  });

  return txn.transactionId;
}

/**
 * Reverse a sub-ledger debit on settlement failure.
 */
async function reverseSubLedgerDebit(subLedgerId, amount, settlementId) {
  if (!SubLedgerEngine) return null;
  try {
    var txn = await SubLedgerEngine.postTransaction({
      subLedgerId: subLedgerId,
      transactionType: 'credit',
      amount: amount,
      description: 'Reversal — failed settlement ' + settlementId,
      referenceType: 'electronic_settlement_reversal',
      referenceId: settlementId,
      postedBy: 'electronic_settlement_engine',
    });
    return txn.transactionId;
  } catch (err) {
    console.error('[ElectronicSettlement] sub-ledger reversal failed:', err.message);
    return null;
  }
}

/**
 * List all available client accounts for funding payments.
 * Returns both sub-ledger (client) accounts and trust GL accounts.
 */
async function listFundingAccounts() {
  var results = { clientAccounts: [], trustAccounts: [] };

  // 1. Sub-ledger (client) accounts — all active accounts, any balance
  if (SubLedgerEngine) {
    try {
      var accounts = await SubLedgerEngine.listSubLedgers({});
      results.clientAccounts = accounts.filter(function(a) {
        return a.status === 'active';
      }).map(function(a) {
        return {
          sub_ledger_id: a.sub_ledger_id,
          name: a.sub_account_name,
          parent_account: a.parent_account_code,
          balance: parseFloat(a.balance),
          type: a.sub_account_type,
          contact_id: a.contact_id,
          source: 'client',
        };
      });
    } catch (err) {
      console.warn('[ElectronicSettlement] listFundingAccounts sub-ledger failed:', err.message);
    }
  }

  // 2. Trust GL accounts (asset accounts that can fund payments)
  try {
    var glRows = await pool.query(
      `SELECT account_code, account_name, account_type, balance
       FROM trust_accounts
       WHERE account_type = 'asset'
       ORDER BY account_code`
    );
    results.trustAccounts = (glRows.rows || []).map(function(r) {
      return {
        account_code: r.account_code,
        name: r.account_name,
        balance: parseFloat(r.balance || 0),
        source: 'trust',
      };
    });
  } catch (err) {
    console.warn('[ElectronicSettlement] listFundingAccounts trust GL failed:', err.message);
  }

  return results;
}

// ─── DATA BRIDGE SYNC ─────────────────────────────────────────────────────────

/**
 * Sync a completed settlement to Data Bridge for cross-module consistency.
 */
async function syncToDataBridge(settlementId) {
  var settlement = await getSettlement(settlementId);
  if (!settlement) return { synced: false, reason: 'Settlement not found' };

  var syncResults = { settlement_id: settlementId, modules: {} };

  // 1. Sync to trust accounting (journal entry should already exist)
  if (settlement.journal_entry_id) {
    syncResults.modules.trust_accounting = { synced: true, journal_entry: settlement.journal_entry_id };
  }

  // 2. Sync to Fineract via Data Bridge push
  if (DataBridge) {
    try {
      var pushResult = await DataBridge.pushToFineract();
      syncResults.modules.fineract = { synced: true, pushed: pushResult.pushed || 0 };
    } catch (err) {
      syncResults.modules.fineract = { synced: false, error: err.message };
    }
  }

  // 3. Reconcile sub-ledger balances
  if (settlement.sub_ledger_id && DataBridge) {
    try {
      var reconResult = await DataBridge.reconcileSubLedgers();
      syncResults.modules.sub_ledger = {
        synced: true,
        sub_ledger_id: settlement.sub_ledger_id,
        reconciled: reconResult.reconciled || 0,
      };
    } catch (err) {
      syncResults.modules.sub_ledger = { synced: false, error: err.message };
    }
  }

  // 4. Reconcile cash balances
  if (DataBridge) {
    try {
      var cashResult = await DataBridge.reconcileCashToAccounting();
      syncResults.modules.cash = { synced: true, difference: cashResult.difference || 0 };
    } catch (err) {
      syncResults.modules.cash = { synced: false, error: err.message };
    }
  }

  // Mark as synced if core modules succeed (trust accounting + sub-ledger)
  // Fineract/cash reconciliation failures should not block sync status
  var coreModules = ['trust_accounting', 'sub_ledger'];
  var allModulesSynced = coreModules.every(function(k) {
    return !syncResults.modules[k] || syncResults.modules[k].synced !== false;
  });

  if (allModulesSynced) {
    await pool.query(
      'UPDATE electronic_settlements SET data_bridge_synced = TRUE, updated_at = NOW() WHERE settlement_id = $1',
      [settlementId]
    );
  }

  syncResults.synced = allModulesSynced;
  return syncResults;
}

// ─── CORE ENGINE ──────────────────────────────────────────────────────────────

/**
 * Submit an electronic payment for instant processing.
 *
 * @param {Object} opts
 * @param {number} opts.amount - payment amount in dollars
 * @param {string} opts.payee_name - recipient name
 * @param {string} opts.payee_routing - routing number (for ACH/wire)
 * @param {string} opts.payee_account - account number (for ACH/wire)
 * @param {string} opts.payee_bank_name - bank name (optional)
 * @param {string} opts.payment_type - vendor_payment|trust_distribution|disbursement|fee_payment
 * @param {string} opts.priority - standard|express|urgent|immediate
 * @param {string} opts.force_method - force specific method (ach|wire|bill)
 * @param {string} opts.sub_ledger_id - Core Banking sub-ledger to fund from (optional)
 * @param {string} opts.source_account_code - GL account code if no sub-ledger (default 1000)
 * @param {string} opts.vendor_id - vendor ID (optional)
 * @param {string} opts.description - payment description
 * @param {string} opts.memo - internal memo
 * @param {string} opts.initiated_by - who initiated
 * @returns {Object} settlement record with tracking info
 */
async function submitElectronicPayment(opts) {
  checkCircuit('payment_submission');

  var amount = parseFloat(opts.amount);
  if (isNaN(amount) || amount <= 0) throw new Error('Invalid payment amount');

  var priority = opts.priority || 'standard';
  var priorityConfig = PRIORITY_LEVELS[priority] || PRIORITY_LEVELS.standard;
  var method = opts.force_method || determineOptimalMethod(amount, priority, opts);

  var settlementId = generateSettlementId();
  var paymentRef = 'EPAY-' + Date.now().toString(36).toUpperCase() + '-' +
    crypto.randomBytes(2).toString('hex').toUpperCase();
  var slaDeadline = new Date(Date.now() + priorityConfig.sla_hours * 60 * 60 * 1000);
  var sourceCode = opts.source_account_code || ACCOUNT_CODES.CASH;
  var submittedAt = new Date();

  var integrityHash = computeIntegrityHash({
    settlement_id: settlementId,
    amount: amount,
    payee_name: opts.payee_name,
    payment_ref: paymentRef,
    submitted_at: submittedAt.toISOString(),
  });

  // 1. If sub-ledger specified, debit it first (funds source)
  var subLedgerTxnId = null;
  if (opts.sub_ledger_id) {
    subLedgerTxnId = await withRetry(function() {
      return debitSubLedger(opts.sub_ledger_id, amount, settlementId,
        'Payment to ' + opts.payee_name + ' via ' + method);
    }, 'sub-ledger debit', 2);

    // Get the sub-ledger's parent account code for the JE
    if (SubLedgerEngine) {
      try {
        var ledgerInfo = await SubLedgerEngine.getSubLedger(opts.sub_ledger_id);
        if (ledgerInfo) sourceCode = ledgerInfo.parent_account_code;
      } catch (e) { /* use default */ }
    }
  }

  // 2. Create settlement record
  await pool.query(`
    INSERT INTO electronic_settlements
      (settlement_id, payment_ref, payment_type, payment_method, priority,
       payer_account, payee_name, payee_account, payee_routing, payee_bank_name,
       sub_ledger_id, sub_ledger_txn_id, source_account_code,
       amount, integrity_hash, sla_deadline, submitted_at, initiated_by, description, memo, vendor_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
  `, [
    settlementId, paymentRef, opts.payment_type || 'vendor_payment', method, priority,
    sourceCode, opts.payee_name, opts.payee_account || null,
    opts.payee_routing || null, opts.payee_bank_name || null,
    opts.sub_ledger_id || null, subLedgerTxnId, sourceCode,
    amount, integrityHash, slaDeadline, submittedAt, opts.initiated_by || 'admin',
    opts.description || ('Electronic payment to ' + opts.payee_name),
    opts.memo || null, opts.vendor_id || null,
  ]);

  // 3. Execute payment with retry
  var executionResult;
  try {
    executionResult = await withRetry(function() {
      return executePaymentByMethod(method, {
        settlementId: settlementId,
        paymentRef: paymentRef,
        amount: amount,
        payee_name: opts.payee_name,
        payee_routing: opts.payee_routing,
        payee_account: opts.payee_account,
        payee_bank_name: opts.payee_bank_name,
        payment_type: opts.payment_type,
        source_account_code: sourceCode,
        description: opts.description || ('Electronic payment to ' + opts.payee_name),
        initiated_by: opts.initiated_by || 'admin',
        vendor_id: opts.vendor_id,
        priority: priority,
      });
    }, 'payment execution');

    // 4. Update settlement with execution refs
    await pool.query(`
      UPDATE electronic_settlements SET
        status = 'transmitted', transmitted_at = NOW(),
        bill_ref = $2, ach_batch_id = $3, wire_id = $4, journal_entry_id = $5,
        transmission_ref = $6, processor_ref = $7, payment_file_hash = $8,
        updated_at = NOW()
      WHERE settlement_id = $1
    `, [
      settlementId,
      executionResult.bill_ref || null,
      executionResult.ach_batch_id || null,
      executionResult.wire_id || null,
      executionResult.journal_entry_id || null,
      executionResult.transmission_ref || paymentRef,
      executionResult.processor_ref || null,
      executionResult.payment_file_hash || null,
    ]);

    // 5. Track with notification engine
    var trackingId = null;
    if (notifEngine) {
      try {
        trackingId = await notifEngine.trackPayment({
          payment_type: opts.payment_type || 'vendor_payment',
          payment_method: method,
          direction: 'outbound',
          amount: amount,
          source_account: sourceCode,
          destination_name: opts.payee_name,
          vendor_id: opts.vendor_id,
          vendor_name: opts.payee_name,
          sub_ledger_id: opts.sub_ledger_id || null,
          internal_ref: paymentRef,
          bill_ref: executionResult.bill_ref || null,
          ach_batch_id: executionResult.ach_batch_id || null,
          wire_id: executionResult.wire_id || null,
          journal_entry_id: executionResult.journal_entry_id || null,
          description: opts.description || ('Electronic payment to ' + opts.payee_name),
          initiated_by: opts.initiated_by || 'admin',
        });
        await notifEngine.updatePaymentStatus(trackingId, 'processing');
        await notifEngine.updatePaymentStatus(trackingId, 'submitted', {
          bill_ref: executionResult.bill_ref || executionResult.transmission_ref,
        });
        if (executionResult.journal_entry_id) {
          await notifEngine.updatePaymentStatus(trackingId, 'posted', {
            journal_entry_id: executionResult.journal_entry_id,
          });
        }
      } catch (trkErr) {
        console.warn('[ElectronicSettlement] notification tracking failed:', trkErr.message);
      }
    }

    await pool.query('UPDATE electronic_settlements SET tracking_id = $2, updated_at = NOW() WHERE settlement_id = $1',
      [settlementId, trackingId]);

    // 6. BILL direct → accepted immediately
    if (method === 'bill' && executionResult.bill_ref) {
      await advanceSettlementStatus(settlementId, 'accepted');
    }

    // 7. Async Data Bridge sync (non-blocking)
    syncToDataBridge(settlementId).catch(function(err) {
      console.warn('[ElectronicSettlement] async DataBridge sync failed:', err.message);
    });

    return {
      settlement_id: settlementId,
      payment_ref: paymentRef,
      tracking_id: trackingId,
      status: 'transmitted',
      method: method,
      priority: priority,
      priority_label: priorityConfig.label,
      sla_deadline: slaDeadline.toISOString(),
      amount: amount,
      payee: opts.payee_name,
      sub_ledger_id: opts.sub_ledger_id || null,
      sub_ledger_txn_id: subLedgerTxnId,
      source_account: sourceCode,
      integrity_hash: integrityHash,
      bill_ref: executionResult.bill_ref || null,
      bill_vendor_id: executionResult.bill_vendor_id || null,
      bill_id: executionResult.bill_id || null,
      ach_batch_id: executionResult.ach_batch_id || null,
      wire_id: executionResult.wire_id || null,
      journal_entry_id: executionResult.journal_entry_id || null,
      transmission_ref: executionResult.transmission_ref || null,
      payment_file_hash: executionResult.payment_file_hash || null,
      // STP enrichment data
      stp_id: executionResult.stp_id || null,
      settlement_date: executionResult.settlement_date || null,
      availability_date: executionResult.availability_date || null,
      settlement_timing: executionResult.settlement_timing || null,
      enrichment_complete: executionResult.enrichment_complete || false,
      chart_of_account: executionResult.chart_of_account || null,
      invoice_number: executionResult.invoice_number || null,
    };

  } catch (err) {
    // Payment execution failed — reverse sub-ledger debit if applicable
    if (opts.sub_ledger_id && subLedgerTxnId) {
      await reverseSubLedgerDebit(opts.sub_ledger_id, amount, settlementId);
    }
    await pool.query(`
      UPDATE electronic_settlements SET status = 'failed', last_error = $2,
        retry_count = retry_count + 1, updated_at = NOW()
      WHERE settlement_id = $1
    `, [settlementId, err.message]);
    throw err;
  }
}

/**
 * Determine optimal payment method based on priority and amount.
 *
 * Preference order for outbound vendor/distribution payments:
 *   1. WIRE  — for immediate/urgent when recipient bank details present
 *   2. OPENACH — real ACH from core banking ODFI (funds from trust's own account, NOT BILL Cash)
 *   3. BILL  — fallback rail (draws from BILL Cash Account)
 *
 * OpenACH is preferred over BILL whenever the recipient's routing+account are
 * present and the OpenACH REST rail is configured, so funds pull from core banking.
 */
function determineOptimalMethod(amount, priority, opts) {
  if (opts.payee_routing && opts.payee_account) {
    if (priority === 'immediate' || priority === 'urgent') {
      return WireEngine ? 'wire' : 'bill';
    }
    // Prefer the core-banking ACH rail (OpenACH) when available.
    if (OpenACHClient && openACHConfigured()) return 'openach';
    if (priority === 'express') return 'bill';
  }
  return 'bill';
}

/**
 * Whether the OpenACH REST rail has credentials + base URL configured.
 */
function openACHConfigured() {
  return !!(process.env.OPENACH_API_TOKEN && process.env.OPENACH_API_KEY && process.env.OPENACH_BASE_URL);
}

/**
 * Execute payment through the selected channel.
 */
async function executePaymentByMethod(method, opts) {
  switch (method) {
    case 'bill':    return executeBILLPayment(opts);
    case 'wire':    return executeWirePayment(opts);
    case 'ach':     return executeACHPayment(opts);
    case 'openach': return executeOpenACHPayment(opts);
    default:        throw new Error('Unsupported payment method: ' + method);
  }
}

/**
 * Execute a REAL ACH credit through the OpenACH REST API (core banking ODFI).
 * Funds originate from the trust's ODFI account (Eaton Family Credit Union),
 * NOT the BILL Cash Account. Posts a core-banking journal entry.
 *
 * Falls back to BILL if OpenACH is unreachable so payments are never silently dropped.
 */
async function executeOpenACHPayment(opts) {
  if (!OpenACHClient || !openACHConfigured()) {
    console.warn('[ElectronicSettlement] OpenACH not configured — falling back to BILL');
    return executeBILLPayment(opts);
  }

  var payeeName = opts.payee_name || 'Vendor';
  var nameParts = String(payeeName).trim().split(/\s+/);
  var firstName = nameParts[0] || 'Payee';
  var lastName = nameParts.slice(1).join(' ') || payeeName;

  try {
    // Resolve the disbursement payment type (credit) from the ODFI account.
    var paymentTypeId = opts.openach_payment_type_id || process.env.OPENACH_PAYMENT_TYPE_ID;
    if (!paymentTypeId) {
      var types = await OpenACHClient.getPaymentTypes();
      var creditType = Array.isArray(types)
        ? types.find(function(t) { return /dist|credit|disburse/i.test(t.name || t.payment_type_name || ''); })
        : null;
      paymentTypeId = creditType ? (creditType.id || creditType.payment_type_id) : null;
    }
    if (!paymentTypeId) throw new Error('No OpenACH credit payment type available');

    var sendDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    var achResult = await OpenACHClient.disburseToBeneficiary({
      first_name: firstName,
      last_name: lastName,
      email: opts.payee_email || '',
      external_id: 'estl_' + opts.settlementId,
      bank_name: opts.payee_bank_name || 'Recipient Bank',
      routing_number: opts.payee_routing,
      account_number: opts.payee_account,
      account_type: opts.payee_account_type || 'Checking',
      amount: opts.amount,
      send_date: sendDate,
      payment_type_id: paymentTypeId,
    });

    // Post the core-banking journal entry (funds leave the trust ODFI/cash account).
    var journalEntryId = null;
    if (TrustAccountingEngine) {
      try {
        var debitCode = opts.payment_type === 'trust_distribution' ? ACCOUNT_CODES.DISTRIBUTIONS : ACCOUNT_CODES.EXPENSES;
        var creditCode = opts.source_account_code || ACCOUNT_CODES.CASH;
        var je = await TrustAccountingEngine.postJournalEntry({
          entryDate: new Date(),
          description: 'OpenACH settlement (core banking): ' + (opts.description || payeeName),
          lines: [
            { accountCode: debitCode, debitAmount: opts.amount, creditAmount: 0,
              memo: 'OpenACH ' + opts.settlementId + ' — ' + payeeName },
            { accountCode: creditCode, debitAmount: 0, creditAmount: opts.amount,
              memo: 'ACH outflow (ODFI): ' + opts.paymentRef },
          ],
          referenceType: 'electronic_settlement',
          referenceId: opts.settlementId,
          postedBy: opts.initiated_by || 'system',
        });
        journalEntryId = je.entry_id || je.id || null;
      } catch (jeErr) {
        console.warn('[ElectronicSettlement] OpenACH JE failed:', jeErr.message);
      }
    }

    return {
      journal_entry_id: journalEntryId,
      transmission_ref: achResult.payment_schedule_id || achResult.external_account_id || opts.paymentRef,
      processor_ref: achResult.payment_schedule_id || null,
      openach_profile_id: achResult.payment_profile_id || null,
      openach_schedule_id: achResult.payment_schedule_id || null,
      payment_file_hash: computePaymentFileHash(JSON.stringify({
        method: 'openach_rest', schedule_id: achResult.payment_schedule_id,
        amount: opts.amount, payee: payeeName, timestamp: new Date().toISOString(),
      })),
    };
  } catch (err) {
    console.error('[ElectronicSettlement] OpenACH payment failed: ' + err.message + ' — falling back to BILL');
    return executeBILLPayment(opts);
  }
}

/**
 * Execute via BILL API with Straight-Through Processing (STP).
 * Routes based on payment_type:
 *   - 'deposit' / 'bill_cash_deposit': RecordARPayment → funds INTO BILL Cash Account
 *   - 'vendor_payment' / 'trust_distribution': PayBills → funds OUT of BILL Cash to vendor
 *
 * STP enrichment ensures ALL required fields for clearing are present:
 *   - Chart of Account mapping for GL posting
 *   - Payment terms (Net 0 for immediate)
 *   - Due date, GL posting date
 *   - Invoice linkage (for deposits)
 *   - Vendor address (for PayBills)
 *   - T+1 settlement/availability dates
 */
async function executeBILLPayment(opts) {
  if (!billClient) throw new Error('BILL client not available');

  var isDeposit = opts.payment_type === 'deposit' || opts.payment_type === 'bill_cash_deposit';

  // ─── STP ENRICHMENT ──────────────────────────────────────────
  // Use STP engine if available for enriched payment processing
  var stpResult = null;
  if (STPEngine) {
    try {
      stpResult = await STPEngine.processPayment({
        settlement_id: opts.settlementId,
        payment_type: opts.payment_type,
        payment_method: 'bill',
        amount: opts.amount,
        payee_name: opts.payee_name,
        payee_email: opts.payee_email,
        description: opts.description,
        priority: opts.priority,
        method: isDeposit ? 'ach' : 'bill',
      });

      if (stpResult.status === 'transmitted' && !stpResult.error) {
        // STP successfully executed and transmitted — use its results
        var journalEntryId = null;
        if (TrustAccountingEngine) {
          try {
            var debitCode, creditCode;
            if (isDeposit) {
              debitCode = ACCOUNT_CODES.BILL_CASH;
              creditCode = opts.source_account_code || ACCOUNT_CODES.CASH;
            } else {
              debitCode = opts.payment_type === 'trust_distribution' ? ACCOUNT_CODES.DISTRIBUTIONS : ACCOUNT_CODES.EXPENSES;
              creditCode = opts.source_account_code || ACCOUNT_CODES.BILL_CASH;
            }
            var je = await TrustAccountingEngine.postJournalEntry({
              entryDate: new Date(),
              description: 'STP settlement: ' + (opts.description || opts.payee_name),
              lines: [
                { accountCode: debitCode, debitAmount: opts.amount, creditAmount: 0,
                  memo: 'ESTL ' + opts.settlementId + ' — ' + (opts.payee_name || 'BILL Cash deposit') +
                    ' [STP ' + stpResult.stp_id + ', settle ' + (stpResult.settlement_date || 'pending') +
                    ', avail ' + (stpResult.availability_date || 'T+1') + ']' },
                { accountCode: creditCode, debitAmount: 0, creditAmount: opts.amount,
                  memo: 'Electronic settlement ' + (isDeposit ? 'deposit' : 'outflow') + ': ' + opts.paymentRef },
              ],
              referenceType: 'electronic_settlement',
              referenceId: opts.settlementId,
              postedBy: opts.initiated_by || 'system',
            });
            journalEntryId = je.entry_id || je.id || null;
          } catch (err) {
            console.warn('[ElectronicSettlement] JE failed:', err.message);
          }
        }

        var billRef = stpResult.bill_ref;
        var fileContent = JSON.stringify({
          method: 'bill_api_stp',
          stp_id: stpResult.stp_id,
          endpoint: isDeposit ? '/api/v2/RecordARPayment' : '/api/v2/PayBills',
          type: isDeposit ? 'deposit' : 'vendor_payment',
          amount: opts.amount,
          ref: billRef,
          chart_of_account: stpResult.chart_of_account,
          gl_posting_date: stpResult.gl_posting_date,
          settlement_date: stpResult.settlement_date,
          availability_date: stpResult.availability_date,
          settlement_timing: stpResult.settlement_timing,
          timestamp: new Date().toISOString(),
        });

        return {
          bill_ref: billRef,
          bill_vendor_id: isDeposit ? null : (stpResult.bill_vendor_id || null),
          bill_id: isDeposit ? null : (stpResult.bill_id || null),
          journal_entry_id: journalEntryId,
          transmission_ref: billRef || opts.paymentRef,
          processor_ref: billRef,
          payment_file_hash: computePaymentFileHash(fileContent),
          stp_id: stpResult.stp_id,
          settlement_date: stpResult.settlement_date,
          availability_date: stpResult.availability_date,
          settlement_timing: stpResult.settlement_timing,
          enrichment_complete: stpResult.enrichment_complete,
          chart_of_account: stpResult.chart_of_account,
          invoice_number: stpResult.invoice_number,
        };
      }
    } catch (stpErr) {
      // Re-throw MFA errors
      if (stpErr.mfa_required) throw stpErr;
      console.warn('[ElectronicSettlement] STP processing failed, falling back to direct:', stpErr.message);
    }
  }

  // ─── FALLBACK: Direct BILL execution (non-STP) ──────────────
  var paymentResult;
  if (isDeposit) {
    paymentResult = await billClient.depositToBillCash({
      amount: opts.amount,
      method: 'ach',
      memo: opts.description || 'Electronic settlement deposit',
    });
  } else {
    try {
      paymentResult = await billClient.sendVendorPayment({
        payee_name: opts.payee_name,
        amount: opts.amount,
        description: opts.description || 'Electronic settlement payment',
        invoiceNumber: 'ES-' + Date.now().toString(36).toUpperCase(),
        email: opts.payee_email || undefined,
      });
    } catch (vendorErr) {
      if (vendorErr.message && vendorErr.message.indexOf('ntrusted') !== -1) {
        var challengeData = null;
        try {
          challengeData = await billClient.sendMFAChallenge('primary');
        } catch (mfaErr) {
          console.warn('[ElectronicSettlement] MFA challenge failed:', mfaErr.message);
        }
        var mfaError = new Error('MFA_REQUIRED');
        mfaError.mfa_required = true;
        mfaError.challengeId = challengeData ? challengeData.challengeId : null;
        mfaError.settlementId = opts.settlementId;
        mfaError.payee_name = opts.payee_name;
        mfaError.amount = opts.amount;
        throw mfaError;
      }
      throw vendorErr;
    }
  }

  var journalEntryIdFB = null;
  if (TrustAccountingEngine) {
    try {
      var debitCodeFB, creditCodeFB;
      if (isDeposit) {
        debitCodeFB = ACCOUNT_CODES.BILL_CASH;
        creditCodeFB = opts.source_account_code || ACCOUNT_CODES.CASH;
      } else {
        debitCodeFB = opts.payment_type === 'trust_distribution' ? ACCOUNT_CODES.DISTRIBUTIONS : ACCOUNT_CODES.EXPENSES;
        creditCodeFB = opts.source_account_code || ACCOUNT_CODES.BILL_CASH;
      }
      var jeFB = await TrustAccountingEngine.postJournalEntry({
        entryDate: new Date(),
        description: 'Electronic settlement: ' + (opts.description || opts.payee_name),
        lines: [
          { accountCode: debitCodeFB, debitAmount: opts.amount, creditAmount: 0,
            memo: 'ESTL ' + opts.settlementId + ' — ' + (opts.payee_name || 'BILL Cash deposit') },
          { accountCode: creditCodeFB, debitAmount: 0, creditAmount: opts.amount,
            memo: 'Electronic settlement ' + (isDeposit ? 'deposit' : 'outflow') + ': ' + opts.paymentRef },
        ],
        referenceType: 'electronic_settlement',
        referenceId: opts.settlementId,
        postedBy: opts.initiated_by || 'system',
      });
      journalEntryIdFB = jeFB.entry_id || jeFB.id || null;
    } catch (err) {
      console.warn('[ElectronicSettlement] JE failed:', err.message);
    }
  }

  var billRefFB = isDeposit
    ? (paymentResult.receivedPayId || paymentResult.id || null)
    : (paymentResult.sentPayId || paymentResult.billId || null);

  var fileContentFB = JSON.stringify({
    method: 'bill_api',
    endpoint: isDeposit ? '/api/v2/RecordARPayment' : '/api/v2/PayBills',
    type: isDeposit ? 'deposit' : 'vendor_payment',
    amount: opts.amount,
    ref: billRefFB,
    timestamp: new Date().toISOString(),
  });

  return {
    bill_ref: billRefFB,
    bill_vendor_id: isDeposit ? null : (paymentResult.vendorId || null),
    bill_id: isDeposit ? null : (paymentResult.billId || null),
    journal_entry_id: journalEntryIdFB,
    transmission_ref: billRefFB || opts.paymentRef,
    processor_ref: billRefFB,
    payment_file_hash: computePaymentFileHash(fileContentFB),
  };
}

/**
 * Execute via Wire.
 */
async function executeWirePayment(opts) {
  if (!WireEngine) throw new Error('Wire engine not available');

  var wire = await WireEngine.initiateWire({
    amountCents: Math.round(opts.amount * 100),
    beneficiaryName: opts.payee_name,
    beneficiaryRouting: opts.payee_routing,
    beneficiaryAccount: opts.payee_account,
    beneficiaryBankName: opts.payee_bank_name || '',
    purpose: 'Electronic settlement: ' + (opts.description || opts.payment_type),
    description: opts.settlementId + ' — ' + opts.payee_name,
    paymentType: opts.payment_type || 'vendor_payment',
    wireType: 'funds_transfer',
    initiatedBy: opts.initiated_by || 'system',
    requiresApproval: false,
    skipJournalEntry: true,
  });

  var journalEntryId = null;
  if (TrustAccountingEngine) {
    try {
      var debitCode = opts.payment_type === 'trust_distribution' ? ACCOUNT_CODES.DISTRIBUTIONS : ACCOUNT_CODES.EXPENSES;
      var creditCode = opts.source_account_code || ACCOUNT_CODES.CASH;
      var je = await TrustAccountingEngine.postJournalEntry({
        entryDate: new Date(),
        description: 'Electronic wire settlement: ' + (opts.description || opts.payee_name),
        lines: [
          { accountCode: debitCode, debitAmount: opts.amount, creditAmount: 0,
            memo: 'Wire ESTL ' + opts.settlementId + ' — ' + opts.payee_name },
          { accountCode: creditCode, debitAmount: 0, creditAmount: opts.amount,
            memo: 'Wire outflow: ' + opts.paymentRef },
        ],
        referenceType: 'electronic_settlement',
        referenceId: opts.settlementId,
        postedBy: opts.initiated_by || 'system',
      });
      journalEntryId = je.entry_id || je.id || null;
    } catch (err) {
      console.warn('[ElectronicSettlement] Wire JE failed:', err.message);
    }
  }

  return {
    wire_id: wire.wire_id,
    journal_entry_id: journalEntryId,
    transmission_ref: wire.wire_id,
    processor_ref: wire.wire_id,
    payment_file_hash: computePaymentFileHash(JSON.stringify({
      method: 'wire_transfer', wire_id: wire.wire_id,
      amount: opts.amount, beneficiary: opts.payee_name,
      timestamp: new Date().toISOString(),
    })),
  };
}

/**
 * Execute via ACH.
 */
async function executeACHPayment(opts) {
  if (!ACHEngine) throw new Error('ACH engine not available');

  var batch = await ACHEngine.createBatch(
    {
      effectiveDate: new Date().toISOString().split('T')[0],
      secCode: 'CCD',
      description: ('ESTL ' + (opts.payee_name || '').slice(0, 10)).toUpperCase(),
      createdBy: opts.initiated_by || 'system',
    },
    [{
      receivingRouting: opts.payee_routing,
      accountNumber: opts.payee_account,
      receivingName: opts.payee_name,
      amountCents: Math.round(opts.amount * 100),
      transactionCode: '22',
      identification: opts.settlementId,
      discretionaryData: opts.paymentRef || '',
    }]
  );

  var journalEntryId = null;
  if (TrustAccountingEngine) {
    try {
      var debitCode = opts.payment_type === 'trust_distribution' ? ACCOUNT_CODES.DISTRIBUTIONS : ACCOUNT_CODES.EXPENSES;
      var creditCode = opts.source_account_code || ACCOUNT_CODES.CASH;
      var je = await TrustAccountingEngine.postJournalEntry({
        entryDate: new Date(),
        description: 'Electronic ACH settlement: ' + (opts.description || opts.payee_name),
        lines: [
          { accountCode: debitCode, debitAmount: opts.amount, creditAmount: 0,
            memo: 'ACH ESTL ' + opts.settlementId + ' — ' + opts.payee_name },
          { accountCode: creditCode, debitAmount: 0, creditAmount: opts.amount,
            memo: 'ACH outflow: ' + opts.paymentRef },
        ],
        referenceType: 'electronic_settlement',
        referenceId: opts.settlementId,
        postedBy: opts.initiated_by || 'system',
      });
      journalEntryId = je.entry_id || je.id || null;
    } catch (err) {
      console.warn('[ElectronicSettlement] ACH JE failed:', err.message);
    }
  }

  var billRef = null;
  if (billClient) {
    try {
      var billResult = await billClient.recordDeposit({
        amount: opts.amount,
        method: 'ach',
        memo: 'ACH settlement: ' + (opts.description || opts.payee_name),
      });
      billRef = billResult.receivedPayId || null;
    } catch (err) {
      console.warn('[ElectronicSettlement] BILL recording for ACH failed:', err.message);
    }
  }

  return {
    ach_batch_id: batch.batch_id,
    bill_ref: billRef,
    journal_entry_id: journalEntryId,
    transmission_ref: batch.batch_id,
    processor_ref: batch.batch_id,
    payment_file_hash: computePaymentFileHash(JSON.stringify({
      method: 'ach_nacha', batch_id: batch.batch_id,
      amount: opts.amount, payee: opts.payee_name,
      timestamp: new Date().toISOString(),
    })),
  };
}

// ─── SETTLEMENT STATUS MANAGEMENT ─────────────────────────────────────────────

async function advanceSettlementStatus(settlementId, newStatus, extras) {
  extras = extras || {};
  var statusField = newStatus + '_at';
  var setClauses = ['status = $2', 'updated_at = NOW()'];
  var params = [settlementId, newStatus];
  var idx = 3;

  var validTimestampFields = ['submitted_at','transmitted_at','accepted_at',
    'clearing_at','settled_at','confirmed_at','finalized_at'];
  if (validTimestampFields.indexOf(statusField) >= 0) {
    setClauses.push(statusField + ' = NOW()');
  }
  if (extras.settlement_ref) { setClauses.push('settlement_ref = $' + idx++); params.push(extras.settlement_ref); }
  if (extras.confirmation_code) { setClauses.push('confirmation_code = $' + idx++); params.push(extras.confirmation_code); }
  if (extras.processor_ref) { setClauses.push('processor_ref = $' + idx++); params.push(extras.processor_ref); }

  await pool.query('UPDATE electronic_settlements SET ' + setClauses.join(', ') + ' WHERE settlement_id = $1', params);

  var settlement = await getSettlement(settlementId);
  if (settlement && settlement.tracking_id && notifEngine) {
    try {
      var statusMap = { accepted: 'clearing', clearing: 'clearing', settled: 'settled', confirmed: 'completed', finalized: 'completed' };
      var notifStatus = statusMap[newStatus];
      if (notifStatus) {
        await notifEngine.updatePaymentStatus(settlement.tracking_id, notifStatus, {
          settlement_ref: extras.settlement_ref || settlement.settlement_ref,
          confirmation_code: extras.confirmation_code || settlement.confirmation_code,
        });
      }
    } catch (err) {
      console.warn('[ElectronicSettlement] notif status update failed:', err.message);
    }
  }

  return settlement;
}

async function confirmSettlement(settlementId) {
  var settlement = await getSettlement(settlementId);
  if (!settlement) throw new Error('Settlement not found: ' + settlementId);
  if (settlement.status !== 'settled' && settlement.status !== 'clearing') {
    throw new Error('Settlement must be settled/clearing to confirm. Current: ' + settlement.status);
  }

  var confirmationCode = generateConfirmationCode();
  var certificate = generateSettlementCertificate({
    ...settlement,
    confirmation_code: confirmationCode,
    confirmed_at: new Date().toISOString(),
  });

  await pool.query(`
    UPDATE electronic_settlements SET status = 'confirmed', confirmed_at = NOW(),
      confirmation_code = $2, settlement_certificate = $3, updated_at = NOW()
    WHERE settlement_id = $1
  `, [settlementId, confirmationCode, certificate]);

  if (settlement.tracking_id && notifEngine) {
    try {
      await notifEngine.updatePaymentStatus(settlement.tracking_id, 'settled', {
        settlement_ref: settlement.settlement_ref || settlement.processor_ref,
        confirmation_code: confirmationCode,
      });
    } catch (err) {
      console.warn('[ElectronicSettlement] confirm notif failed:', err.message);
    }
  }

  // Trigger Data Bridge sync on confirmation
  syncToDataBridge(settlementId).catch(function(err) {
    console.warn('[ElectronicSettlement] post-confirm sync failed:', err.message);
  });

  return {
    settlement_id: settlementId, status: 'confirmed',
    confirmation_code: confirmationCode,
    certificate: JSON.parse(certificate),
    amount: parseFloat(settlement.amount), payee: settlement.payee_name,
    settled_at: settlement.settled_at, confirmed_at: new Date().toISOString(),
  };
}

async function finalizeSettlement(settlementId) {
  var settlement = await getSettlement(settlementId);
  if (!settlement) throw new Error('Settlement not found');
  if (settlement.status !== 'confirmed') {
    throw new Error('Settlement must be confirmed to finalize. Current: ' + settlement.status);
  }

  await pool.query('UPDATE electronic_settlements SET status = $2, finalized_at = NOW(), updated_at = NOW() WHERE settlement_id = $1',
    [settlementId, 'finalized']);

  return { settlement_id: settlementId, status: 'finalized', finalized_at: new Date().toISOString() };
}

// ─── SETTLEMENT POLLING ───────────────────────────────────────────────────────

async function pollSettlements() {
  var pendingRes = await pool.query(`
    SELECT * FROM electronic_settlements
    WHERE status IN ('transmitted','accepted','clearing')
    ORDER BY submitted_at ASC LIMIT 20
  `);

  var results = { checked: 0, advanced: 0, confirmed: 0, stp_polled: 0, details: [] };

  // ─── STP BILL STATUS POLLING ──────────────────────────────────
  // Poll BILL API for actual payment statuses (not time-based)
  if (STPEngine) {
    try {
      var stpPollResults = await STPEngine.pollBILLStatuses();
      results.stp_polled = stpPollResults.checked;
      results.advanced += stpPollResults.advanced;
      if (stpPollResults.details) {
        for (var j = 0; j < stpPollResults.details.length; j++) {
          results.details.push(stpPollResults.details[j]);
        }
      }
    } catch (stpErr) {
      console.warn('[ElectronicSettlement] STP poll failed:', stpErr.message);
    }

    // Check availability on posted STP entries
    try {
      var availResults = await STPEngine.checkAvailability();
      if (availResults.made_available > 0) {
        results.details.push({ stp_availability: availResults.made_available + ' payments now available (T+1 passed)' });
      }
    } catch (e) { /* non-critical */ }
  }

  // ─── STANDARD POLLING (BILL ref or wire/ACH) ─────────────────
  for (var i = 0; i < pendingRes.rows.length; i++) {
    var s = pendingRes.rows[i];
    results.checked++;

    try {
      if (s.bill_ref && (s.status === 'transmitted' || s.status === 'accepted' || s.status === 'clearing')) {
        // Try actual BILL status check first via readEntity
        var actualBillStatus = null;
        if (billClient && billClient.readEntity) {
          try {
            // Determine entity type: SentPay (vendor) or ReceivedPay (deposit)
            var entityType = (s.bill_ref && s.bill_ref.indexOf('stp01') === 0) ? 'SentPay' :
                             (s.bill_ref && s.bill_ref.indexOf('0rp01') === 0) ? 'ReceivedPay' : null;
            if (entityType) {
              var entity = await billClient.readEntity(entityType, s.bill_ref);
              if (entity) {
                actualBillStatus = String(entity.status);
              }
            }
          } catch (readErr) {
            console.warn('[ElectronicSettlement] BILL read failed:', readErr.message);
          }
        }

        if (actualBillStatus) {
          // Use actual BILL status for advancement
          if (entityType === 'SentPay') {
            // SentPay: 0=Scheduled, 1=Processing, 2=Processed, 3=Failed, 4=Voided
            if (actualBillStatus === '2') {
              // Processed — fully cleared
              if (s.status !== 'clearing') {
                await advanceSettlementStatus(s.settlement_id, 'clearing');
              }
              await advanceSettlementStatus(s.settlement_id, 'settled', { settlement_ref: s.bill_ref });
              var confirmRes = await confirmSettlement(s.settlement_id);
              results.advanced += 2;
              results.confirmed++;
              results.details.push({ settlement_id: s.settlement_id, bill_status: 'Processed', to: 'confirmed',
                confirmation_code: confirmRes.confirmation_code });
            } else if (actualBillStatus === '1') {
              // Processing
              if (s.status === 'transmitted') {
                await advanceSettlementStatus(s.settlement_id, 'accepted');
                await advanceSettlementStatus(s.settlement_id, 'clearing');
                results.advanced += 2;
                results.details.push({ settlement_id: s.settlement_id, bill_status: 'Processing', to: 'clearing' });
              } else if (s.status === 'accepted') {
                await advanceSettlementStatus(s.settlement_id, 'clearing');
                results.advanced++;
              }
            } else if (actualBillStatus === '3' || actualBillStatus === '4') {
              // Failed or Voided
              await pool.query(
                "UPDATE electronic_settlements SET status = 'failed', last_error = $2, updated_at = NOW() WHERE settlement_id = $1",
                [s.settlement_id, 'BILL SentPay status: ' + (actualBillStatus === '3' ? 'Failed' : 'Voided')]
              );
              results.details.push({ settlement_id: s.settlement_id, bill_status: actualBillStatus === '3' ? 'Failed' : 'Voided' });
            }
            // 0=Scheduled — still waiting, advance to accepted
            else if (actualBillStatus === '0' && s.status === 'transmitted') {
              await advanceSettlementStatus(s.settlement_id, 'accepted');
              results.advanced++;
            }
          } else if (entityType === 'ReceivedPay') {
            // ReceivedPay: 0=Uncleared, 1=Cleared, 2=Voided
            if (actualBillStatus === '1') {
              // Cleared
              if (s.status !== 'clearing') {
                await advanceSettlementStatus(s.settlement_id, 'clearing');
              }
              await advanceSettlementStatus(s.settlement_id, 'settled', { settlement_ref: s.bill_ref });
              var confirmDeposit = await confirmSettlement(s.settlement_id);
              results.advanced += 2;
              results.confirmed++;
              results.details.push({ settlement_id: s.settlement_id, bill_status: 'Cleared', to: 'confirmed' });
            } else if (actualBillStatus === '2') {
              await pool.query(
                "UPDATE electronic_settlements SET status = 'failed', last_error = 'Deposit voided in BILL', updated_at = NOW() WHERE settlement_id = $1",
                [s.settlement_id]
              );
            } else if (s.status === 'transmitted') {
              await advanceSettlementStatus(s.settlement_id, 'accepted');
              await advanceSettlementStatus(s.settlement_id, 'clearing');
              results.advanced += 2;
            }
          }
        } else {
          // Fallback: time-based advancement when BILL read unavailable
          if (s.status === 'transmitted') {
            await advanceSettlementStatus(s.settlement_id, 'accepted');
            s.status = 'accepted';
            results.advanced++;
            results.details.push({ settlement_id: s.settlement_id, from: 'transmitted', to: 'accepted' });
          }

          var elapsedMinutes = (Date.now() - new Date(s.submitted_at).getTime()) / 60000;
          var clearingMinutes = s.payment_method === 'bill' ? 5 : s.payment_method === 'wire' ? 30 : 60;

          if (elapsedMinutes >= clearingMinutes) {
            await advanceSettlementStatus(s.settlement_id, 'settled', {
              settlement_ref: s.bill_ref || s.processor_ref,
            });
            s.status = 'settled';
            results.advanced++;
            results.details.push({ settlement_id: s.settlement_id, from: 'accepted', to: 'settled' });

            if (s.payment_method === 'bill') {
              var confirmResult = await confirmSettlement(s.settlement_id);
              results.confirmed++;
              results.details.push({
                settlement_id: s.settlement_id, to: 'confirmed',
                confirmation_code: confirmResult.confirmation_code,
              });
            }
          } else if (s.status === 'accepted') {
            await advanceSettlementStatus(s.settlement_id, 'clearing');
            s.status = 'clearing';
            results.advanced++;
            results.details.push({ settlement_id: s.settlement_id, from: 'accepted', to: 'clearing' });
          }
        }
      }

      if (!s.bill_ref && (s.wire_id || s.ach_batch_id)) {
        var elapsed = (Date.now() - new Date(s.submitted_at).getTime()) / 60000;
        if (s.status === 'transmitted' && elapsed >= 2) {
          await advanceSettlementStatus(s.settlement_id, 'accepted', { processor_ref: s.wire_id || s.ach_batch_id });
          s.status = 'accepted';
          results.advanced++;
        }
        if (s.status === 'accepted' && elapsed >= 5) {
          await advanceSettlementStatus(s.settlement_id, 'clearing');
          s.status = 'clearing';
          results.advanced++;
        }
      }
    } catch (pollErr) {
      console.warn('[ElectronicSettlement] poll error for ' + s.settlement_id + ':', pollErr.message);
      results.details.push({ settlement_id: s.settlement_id, error: pollErr.message });
    }
  }

  return results;
}

// ─── FAILURE RECOVERY ─────────────────────────────────────────────────────────

/**
 * Retry failed settlements that haven't exceeded max retries.
 */
async function retryFailedSettlements() {
  var failedRes = await pool.query(`
    SELECT * FROM electronic_settlements
    WHERE status = 'failed' AND retry_count < $1
    ORDER BY updated_at ASC LIMIT 5
  `, [MAX_RETRIES]);

  var results = { checked: failedRes.rows.length, retried: 0, recovered: 0, details: [] };

  for (var i = 0; i < failedRes.rows.length; i++) {
    var s = failedRes.rows[i];
    results.details.push({ settlement_id: s.settlement_id, attempt: s.retry_count + 1 });

    try {
      // Skip retry if payment was already executed externally (prevents duplicates)
      if (s.bill_ref || s.wire_id || s.ach_batch_id) {
        console.warn('[ElectronicSettlement] skipping retry for ' + s.settlement_id + ' — external ref exists (bill_ref=' + s.bill_ref + ', wire_id=' + s.wire_id + ', ach_batch_id=' + s.ach_batch_id + ')');
        results.details[results.details.length - 1].skipped = true;
        results.details[results.details.length - 1].reason = 'external_ref_exists';
        continue;
      }

      // Reset to submitted and re-execute
      await pool.query(
        'UPDATE electronic_settlements SET status = $2, retry_count = retry_count + 1, last_error = NULL, updated_at = NOW() WHERE settlement_id = $1',
        [s.settlement_id, 'submitted']
      );

      var execResult = await withRetry(function() {
        return executePaymentByMethod(s.payment_method, {
          settlementId: s.settlement_id,
          paymentRef: s.payment_ref,
          amount: parseFloat(s.amount),
          payee_name: s.payee_name,
          payee_routing: s.payee_routing,
          payee_account: s.payee_account,
          payee_bank_name: s.payee_bank_name,
          payment_type: s.payment_type,
          source_account_code: s.source_account_code,
          description: s.description,
          initiated_by: s.initiated_by,
          vendor_id: s.vendor_id,
          priority: s.priority,
        });
      }, 'retry-' + s.settlement_id, 2);

      await pool.query(`
        UPDATE electronic_settlements SET status = 'transmitted', transmitted_at = NOW(),
          bill_ref = COALESCE($2, bill_ref), ach_batch_id = COALESCE($3, ach_batch_id),
          wire_id = COALESCE($4, wire_id), journal_entry_id = COALESCE($5, journal_entry_id),
          transmission_ref = COALESCE($6, transmission_ref), updated_at = NOW()
        WHERE settlement_id = $1
      `, [
        s.settlement_id,
        execResult.bill_ref || null, execResult.ach_batch_id || null,
        execResult.wire_id || null, execResult.journal_entry_id || null,
        execResult.transmission_ref || null,
      ]);

      results.retried++;
      results.recovered++;
      results.details[results.details.length - 1].result = 'recovered';
    } catch (retryErr) {
      await pool.query(
        'UPDATE electronic_settlements SET status = $2, last_error = $3, updated_at = NOW() WHERE settlement_id = $1',
        [s.settlement_id, 'failed', retryErr.message]
      );
      results.retried++;
      results.details[results.details.length - 1].result = 'still_failed';
      results.details[results.details.length - 1].error = retryErr.message;
    }
  }

  return results;
}

/**
 * Get circuit breaker status.
 */
function getCircuitStatus() {
  return {
    open: circuitState.open,
    failures: circuitState.failures,
    threshold: CIRCUIT_THRESHOLD,
    last_failure: circuitState.lastFailure ? new Date(circuitState.lastFailure).toISOString() : null,
    reset_in_seconds: circuitState.open
      ? Math.max(0, Math.ceil((CIRCUIT_RESET_MS - (Date.now() - circuitState.lastFailure)) / 1000))
      : 0,
  };
}

// ─── QUERIES ──────────────────────────────────────────────────────────────────

async function getSettlement(settlementId) {
  var res = await pool.query('SELECT * FROM electronic_settlements WHERE settlement_id = $1', [settlementId]);
  return res.rows[0] || null;
}

async function listSettlements(filters) {
  filters = filters || {};
  var where = ['1=1'];
  var params = [];
  var idx = 1;
  if (filters.status) { where.push('status = $' + idx++); params.push(filters.status); }
  if (filters.priority) { where.push('priority = $' + idx++); params.push(filters.priority); }
  if (filters.vendor_id) { where.push('vendor_id = $' + idx++); params.push(filters.vendor_id); }
  if (filters.payment_method) { where.push('payment_method = $' + idx++); params.push(filters.payment_method); }
  if (filters.sub_ledger_id) { where.push('sub_ledger_id = $' + idx++); params.push(filters.sub_ledger_id); }
  var limit = parseInt(filters.limit) || 50;
  var res = await pool.query(
    'SELECT * FROM electronic_settlements WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ' + limit,
    params
  );
  return res.rows;
}

async function getDashboard() {
  var results = await Promise.all([
    pool.query(`SELECT
      COUNT(*) as total,
      COALESCE(SUM(amount), 0) as total_amount,
      COUNT(CASE WHEN status = 'finalized' OR status = 'confirmed' THEN 1 END) as completed,
      COUNT(CASE WHEN status IN ('submitted','transmitted','accepted','clearing') THEN 1 END) as pending,
      COUNT(CASE WHEN status = 'settled' THEN 1 END) as settled,
      COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
      COUNT(CASE WHEN status = 'returned' THEN 1 END) as returned,
      COALESCE(SUM(CASE WHEN status IN ('confirmed','finalized') THEN amount ELSE 0 END), 0) as confirmed_amount,
      COALESCE(SUM(CASE WHEN status IN ('submitted','transmitted','accepted','clearing','settled') THEN amount ELSE 0 END), 0) as pending_amount,
      AVG(CASE WHEN confirmed_at IS NOT NULL AND submitted_at IS NOT NULL
        THEN EXTRACT(EPOCH FROM (confirmed_at - submitted_at)) / 60 END) as avg_settlement_minutes
      FROM electronic_settlements`),
    pool.query('SELECT * FROM electronic_settlements ORDER BY created_at DESC LIMIT 10'),
    pool.query("SELECT * FROM electronic_settlements WHERE status IN ('submitted','transmitted','accepted','clearing','settled') ORDER BY sla_deadline ASC LIMIT 10"),
    pool.query("SELECT COUNT(*) as cnt FROM electronic_settlements WHERE status NOT IN ('confirmed','finalized','failed','returned') AND sla_deadline < NOW()"),
  ]);

  var s = results[0].rows[0];
  return {
    total_settlements: parseInt(s.total),
    total_amount: parseFloat(s.total_amount),
    completed: parseInt(s.completed),
    pending: parseInt(s.pending),
    settled_awaiting_confirm: parseInt(s.settled),
    failed: parseInt(s.failed),
    returned: parseInt(s.returned),
    confirmed_amount: parseFloat(s.confirmed_amount),
    pending_amount: parseFloat(s.pending_amount),
    avg_settlement_minutes: s.avg_settlement_minutes ? parseFloat(s.avg_settlement_minutes).toFixed(1) : null,
    sla_breaches: parseInt(results[3].rows[0].cnt),
    circuit_breaker: getCircuitStatus(),
    recent_settlements: results[1].rows,
    pending_settlements: results[2].rows,
  };
}

async function verifySettlementIntegrity(settlementId) {
  var settlement = await getSettlement(settlementId);
  if (!settlement) throw new Error('Settlement not found');

  var expectedHash = computeIntegrityHash({
    settlement_id: settlement.settlement_id,
    amount: parseFloat(settlement.amount),
    payee_name: settlement.payee_name,
    payment_ref: settlement.payment_ref,
    submitted_at: settlement.submitted_at.toISOString(),
  });

  return {
    settlement_id: settlementId,
    integrity_valid: expectedHash === settlement.integrity_hash,
    stored_hash: settlement.integrity_hash,
    computed_hash: expectedHash,
    amount: parseFloat(settlement.amount),
    payee: settlement.payee_name,
    status: settlement.status,
  };
}

/**
 * Complete a settlement that is pending MFA verification.
 * Verifies the MFA code, retries PayBills, and updates the settlement.
 */
async function completeMFASettlement(opts) {
  if (!billClient) throw new Error('BILL client not available');
  var code = opts.code;
  var challengeId = opts.challengeId;
  var settlementId = opts.settlementId;

  // 1. Get the failed settlement
  var settlement = await getSettlement(settlementId);
  if (!settlement) throw new Error('Settlement not found: ' + settlementId);
  if (settlement.status !== 'failed') throw new Error('Settlement is not in failed state');

  // 2. Verify MFA code (session becomes trusted — DO NOT re-login)
  var mfaResult = await billClient.verifyMFACode(code, challengeId);
  if (!mfaResult.success) throw new Error('MFA verification failed');

  // 3. Create vendor + bill using the MFA-verified session, then pay directly
  var vendor = await billClient.findVendor(settlement.payee_name);
  if (!vendor) {
    vendor = await billClient.createVendor({
      name: settlement.payee_name,
      address1: '1 Trust Way',
      city: 'Wilmington',
      state: 'DE',
      zip: '19801',
      paymentType: '0',
    });
  } else if (!vendor.address1) {
    // Existing vendor missing address — update it for PayBills compatibility
    try {
      await billClient.updateVendor(vendor.id, {
        address1: '1 Trust Way', city: 'Wilmington', state: 'DE', zip: '19801', paymentType: '0',
      });
    } catch (updErr) { console.warn('[ElectronicSettlement] vendor address update failed:', updErr.message); }
  }
  var bill = await billClient.createBill({
    vendorId: vendor.id,
    amount: parseFloat(settlement.amount),
    invoiceNumber: 'ES-' + Date.now().toString(36).toUpperCase(),
    description: settlement.description || 'Electronic settlement payment to ' + settlement.payee_name,
  });

  // 4. Pay using the MFA-verified session directly (no getSession/re-login)
  var paymentResult = await billClient.payBillDirect({
    billId: bill.id,
    amount: parseFloat(settlement.amount),
  });

  var billRef = paymentResult.sentPayId || bill.id || null;

  // 4. Post journal entry
  var journalEntryId = null;
  if (TrustAccountingEngine) {
    try {
      var debitCode = settlement.payment_type === 'trust_distribution' ? ACCOUNT_CODES.DISTRIBUTIONS : ACCOUNT_CODES.EXPENSES;
      var creditCode = settlement.source_account_code || ACCOUNT_CODES.BILL_CASH;
      var je = await TrustAccountingEngine.postJournalEntry({
        entryDate: new Date(),
        description: 'Electronic settlement: ' + (settlement.description || settlement.payee_name),
        lines: [
          { accountCode: debitCode, debitAmount: parseFloat(settlement.amount), creditAmount: 0,
            memo: 'ESTL ' + settlementId + ' — ' + settlement.payee_name },
          { accountCode: creditCode, debitAmount: 0, creditAmount: parseFloat(settlement.amount),
            memo: 'Electronic settlement outflow: ' + settlement.payment_ref },
        ],
        referenceType: 'electronic_settlement',
        referenceId: settlementId,
        postedBy: 'admin',
      });
      journalEntryId = je.entry_id || je.id || null;
    } catch (jeErr) {
      console.warn('[ElectronicSettlement] JE failed during MFA completion:', jeErr.message);
    }
  }

  // 5. Update settlement to success
  await pool.query(`
    UPDATE electronic_settlements SET
      status = 'accepted', transmitted_at = NOW(),
      bill_ref = $2, journal_entry_id = $3,
      last_error = NULL, updated_at = NOW()
    WHERE settlement_id = $1
  `, [settlementId, billRef, journalEntryId]);

  // 6. Async Data Bridge sync
  syncToDataBridge(settlementId).catch(function(err) {
    console.warn('[ElectronicSettlement] async DataBridge sync failed:', err.message);
  });

  return {
    settlement_id: settlementId,
    payment_ref: settlement.payment_ref,
    status: 'accepted',
    bill_ref: billRef,
    bill_vendor_id: paymentResult.vendorId || null,
    journal_entry_id: journalEntryId,
    amount: parseFloat(settlement.amount),
    payee: settlement.payee_name,
    mfa_verified: true,
  };
}

// ─── EXPORT ───────────────────────────────────────────────────────────────────

module.exports = {
  ensureTables: ensureTables,
  submitElectronicPayment: submitElectronicPayment,
  completeMFASettlement: completeMFASettlement,
  advanceSettlementStatus: advanceSettlementStatus,
  confirmSettlement: confirmSettlement,
  finalizeSettlement: finalizeSettlement,
  pollSettlements: pollSettlements,
  retryFailedSettlements: retryFailedSettlements,
  syncToDataBridge: syncToDataBridge,
  listFundingAccounts: listFundingAccounts,
  getSettlement: getSettlement,
  listSettlements: listSettlements,
  getDashboard: getDashboard,
  verifySettlementIntegrity: verifySettlementIntegrity,
  getCircuitStatus: getCircuitStatus,
  SETTLEMENT_STATUSES: SETTLEMENT_STATUSES,
  PRIORITY_LEVELS: PRIORITY_LEVELS,
};
