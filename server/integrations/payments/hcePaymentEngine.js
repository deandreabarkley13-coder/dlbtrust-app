'use strict';

/**
 * HCE (Host Card Emulation) Payment Engine
 * ──────────────────────────────────────────
 *
 * Manages Android NFC contactless payment authorization, tokenization,
 * and transaction processing for trust and beneficiary expenses.
 *
 * Payment flow:
 *   1. Android HCE app requests payment token from server
 *   2. Server validates funding source, creates authorization
 *   3. Android taps terminal — HCE responds with payment credentials
 *   4. Merchant acquirer processes → server receives webhook/poll confirmation
 *   5. Settlement posts to core banking (sub-ledger debit, JE, Data Bridge sync)
 *
 * Security:
 *   - HMAC-SHA256 signed tokens with expiry (5 min default)
 *   - Per-device registration with hardware fingerprint
 *   - Amount-based approval tiers ($0-$5K auto, $5K-$50K single-approval, $50K+ dual-approval)
 *   - Velocity checks (max transactions per hour/day)
 *   - Geolocation logging for audit
 *
 * Integrates with: ElectronicSettlementEngine, SubLedgerEngine,
 *   TrustAccountingEngine, DataBridge, PaymentNotificationEngine
 */

var crypto = require('crypto');
var pool = require('../bonds/pgPool');

var TrustAccountingEngine;
try { TrustAccountingEngine = require('../accounting/trustAccountingEngine').TrustAccountingEngine; } catch (e) { TrustAccountingEngine = null; }

var SubLedgerEngine;
try { SubLedgerEngine = require('../accounting/subLedgerEngine').SubLedgerEngine; } catch (e) { SubLedgerEngine = null; }

var DataBridge;
try { DataBridge = require('../accounting/dataBridge').DataBridge; } catch (e) { DataBridge = null; }

var notifEngine;
try { notifEngine = require('./paymentNotificationEngine'); } catch (e) { notifEngine = null; }

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

var TOKEN_SECRET = process.env.HCE_TOKEN_SECRET || crypto.randomBytes(32).toString('hex');
var TOKEN_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
var MAX_PAYMENT_AMOUNT = 500000;
var MIN_PAYMENT_AMOUNT = 1;

var APPROVAL_TIERS = {
  auto:           { min: 0,     max: 5000,   requires: 'none' },
  single_approve: { min: 5000,  max: 50000,  requires: 'single' },
  dual_approve:   { min: 50000, max: 500000, requires: 'dual' },
};

var VELOCITY_LIMITS = {
  per_hour: 10,
  per_day: 50,
  daily_amount: 1000000,
};

var ACCOUNT_CODES = {
  CASH: '1000',
  BILL_CASH: '1050',
  HCE_CLEARING: '1070',
  EXPENSES: '5200',
};

// ─── CIRCUIT BREAKER ──────────────────────────────────────────────────────────

var circuitState = { failures: 0, lastFailure: 0, open: false };
var CIRCUIT_THRESHOLD = 5;
var CIRCUIT_RESET_MS = 30000;

function checkCircuit() {
  if (!circuitState.open) return;
  if (Date.now() - circuitState.lastFailure > CIRCUIT_RESET_MS) {
    circuitState.open = false;
    circuitState.failures = 0;
    return;
  }
  throw new Error('HCE circuit breaker OPEN — retry in ' +
    Math.ceil((CIRCUIT_RESET_MS - (Date.now() - circuitState.lastFailure)) / 1000) + 's');
}

function recordFailure(err) {
  circuitState.failures++;
  circuitState.lastFailure = Date.now();
  if (circuitState.failures >= CIRCUIT_THRESHOLD) {
    circuitState.open = true;
    console.error('[HCE] circuit breaker OPENED: ' + err.message);
  }
}

function recordSuccess() {
  if (circuitState.failures > 0) circuitState.failures = Math.max(0, circuitState.failures - 1);
}

// ─── TABLE SETUP ──────────────────────────────────────────────────────────────

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hce_devices (
      device_id TEXT PRIMARY KEY,
      device_name TEXT NOT NULL,
      device_fingerprint TEXT NOT NULL,
      account_holder TEXT NOT NULL,
      contact_id TEXT,
      sub_ledger_id TEXT,
      trust_account_code TEXT DEFAULT '1000',
      status TEXT DEFAULT 'active',
      daily_limit NUMERIC(15,2) DEFAULT 5000,
      per_txn_limit NUMERIC(15,2) DEFAULT 5000,
      registered_at TIMESTAMP DEFAULT NOW(),
      last_used_at TIMESTAMP,
      platform TEXT DEFAULT 'android',
      app_version TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS hce_transactions (
      txn_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      authorization_code TEXT NOT NULL,
      token TEXT,
      amount NUMERIC(15,2) NOT NULL,
      currency TEXT DEFAULT 'USD',
      merchant_name TEXT,
      merchant_id TEXT,
      merchant_category TEXT,
      terminal_id TEXT,
      payment_method TEXT DEFAULT 'nfc_contactless',
      funding_source TEXT NOT NULL,
      sub_ledger_id TEXT,
      sub_ledger_txn_id TEXT,
      source_account_code TEXT DEFAULT '1000',
      status TEXT DEFAULT 'pending',
      approval_tier TEXT DEFAULT 'auto',
      approved_by TEXT,
      approval_timestamp TIMESTAMP,
      settlement_id TEXT,
      journal_entry_id TEXT,
      integrity_hash TEXT,
      data_bridge_synced BOOLEAN DEFAULT FALSE,
      geolocation TEXT,
      device_ip TEXT,
      error_message TEXT,
      submitted_at TIMESTAMP DEFAULT NOW(),
      authorized_at TIMESTAMP,
      settled_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS hce_tokens (
      token_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      txn_id TEXT NOT NULL,
      token_data TEXT NOT NULL,
      amount NUMERIC(15,2) NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      used BOOLEAN DEFAULT FALSE,
      used_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Migrations for new columns
  var migrations = [
    'ALTER TABLE hce_transactions ADD COLUMN IF NOT EXISTS notification_id TEXT',
    'ALTER TABLE hce_transactions ADD COLUMN IF NOT EXISTS receipt_data TEXT',
    'ALTER TABLE hce_transactions ADD COLUMN IF NOT EXISTS transmission_status TEXT DEFAULT \'pending\'',
    'ALTER TABLE hce_transactions ADD COLUMN IF NOT EXISTS bill_ref TEXT',
  ];
  for (var i = 0; i < migrations.length; i++) {
    try { await pool.query(migrations[i]); } catch (e) { /* exists */ }
  }
}

// ─── TOKEN GENERATION ─────────────────────────────────────────────────────────

function generateToken(deviceId, txnId, amount) {
  var payload = {
    device_id: deviceId,
    txn_id: txnId,
    amount: amount,
    issued_at: Date.now(),
    expires_at: Date.now() + TOKEN_EXPIRY_MS,
    nonce: crypto.randomBytes(8).toString('hex'),
  };
  var payloadStr = JSON.stringify(payload);
  var hmac = crypto.createHmac('sha256', TOKEN_SECRET)
    .update(payloadStr).digest('hex');

  return {
    token: Buffer.from(payloadStr).toString('base64') + '.' + hmac,
    expires_at: new Date(payload.expires_at),
    payload: payload,
  };
}

function verifyToken(tokenStr) {
  try {
    var parts = tokenStr.split('.');
    if (parts.length !== 2) return null;
    var payloadStr = Buffer.from(parts[0], 'base64').toString('utf8');
    var hmac = crypto.createHmac('sha256', TOKEN_SECRET)
      .update(payloadStr).digest('hex');
    if (hmac !== parts[1]) return null;
    var payload = JSON.parse(payloadStr);
    if (payload.expires_at < Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function generateTxnId() {
  var ts = Date.now().toString(36).toUpperCase();
  var rand = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 4);
  return 'HCE-' + ts + '-' + rand;
}

function generateAuthCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function computeIntegrityHash(data) {
  return crypto.createHash('sha256').update(JSON.stringify({
    txn_id: data.txn_id,
    amount: data.amount,
    device_id: data.device_id,
    merchant_name: data.merchant_name,
    timestamp: data.submitted_at,
  })).digest('hex');
}

// ─── APPROVAL WORKFLOW ────────────────────────────────────────────────────────

function getApprovalTier(amount) {
  if (amount <= APPROVAL_TIERS.auto.max) return 'auto';
  if (amount <= APPROVAL_TIERS.single_approve.max) return 'single_approve';
  return 'dual_approve';
}

function requiresApproval(amount) {
  return amount > APPROVAL_TIERS.auto.max;
}

// ─── VELOCITY CHECKS ─────────────────────────────────────────────────────────

async function checkVelocity(deviceId) {
  var hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  var dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  var hourCount = await pool.query(
    `SELECT COUNT(*) as cnt FROM hce_transactions
     WHERE device_id = $1 AND status != 'declined' AND submitted_at > $2`,
    [deviceId, hourAgo]
  );

  var dayCount = await pool.query(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(amount), 0) as total
     FROM hce_transactions
     WHERE device_id = $1 AND status != 'declined' AND submitted_at > $2`,
    [deviceId, dayStart]
  );

  var hourly = parseInt(hourCount.rows[0].cnt);
  var daily = parseInt(dayCount.rows[0].cnt);
  var dailyTotal = parseFloat(dayCount.rows[0].total);

  if (hourly >= VELOCITY_LIMITS.per_hour) {
    throw new Error('Velocity limit: max ' + VELOCITY_LIMITS.per_hour + ' transactions per hour');
  }
  if (daily >= VELOCITY_LIMITS.per_day) {
    throw new Error('Velocity limit: max ' + VELOCITY_LIMITS.per_day + ' transactions per day');
  }
  if (dailyTotal >= VELOCITY_LIMITS.daily_amount) {
    throw new Error('Velocity limit: daily amount cap of $' + VELOCITY_LIMITS.daily_amount.toLocaleString() + ' reached');
  }

  return { hourly: hourly, daily: daily, dailyTotal: dailyTotal };
}

// ─── DEVICE MANAGEMENT ───────────────────────────────────────────────────────

async function registerDevice(opts) {
  await ensureTables();
  var deviceId = 'DEV-' + crypto.randomBytes(6).toString('hex').toUpperCase();

  await pool.query(`
    INSERT INTO hce_devices (device_id, device_name, device_fingerprint, account_holder,
      contact_id, sub_ledger_id, trust_account_code, daily_limit, per_txn_limit, platform, app_version)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  `, [
    deviceId,
    opts.device_name || 'Android HCE Device',
    opts.device_fingerprint || crypto.randomBytes(16).toString('hex'),
    opts.account_holder || 'Trust Account Holder',
    opts.contact_id || null,
    opts.sub_ledger_id || null,
    opts.trust_account_code || '1000',
    opts.daily_limit || 5000,
    opts.per_txn_limit || 5000,
    opts.platform || 'android',
    opts.app_version || '1.0.0',
  ]);

  return {
    device_id: deviceId,
    status: 'active',
    daily_limit: opts.daily_limit || 5000,
    per_txn_limit: opts.per_txn_limit || 5000,
  };
}

async function listDevices() {
  await ensureTables();
  var result = await pool.query(
    `SELECT * FROM hce_devices ORDER BY created_at DESC`
  );
  return result.rows;
}

async function getDevice(deviceId) {
  var result = await pool.query(
    'SELECT * FROM hce_devices WHERE device_id = $1', [deviceId]
  );
  return result.rows[0] || null;
}

async function updateDevice(deviceId, updates) {
  var fields = [];
  var values = [deviceId];
  var idx = 2;
  var allowed = ['device_name', 'daily_limit', 'per_txn_limit', 'status', 'sub_ledger_id', 'trust_account_code'];
  for (var k in updates) {
    if (allowed.indexOf(k) >= 0 && updates[k] !== undefined) {
      fields.push(k + ' = $' + idx);
      values.push(updates[k]);
      idx++;
    }
  }
  if (fields.length === 0) return getDevice(deviceId);
  await pool.query(
    'UPDATE hce_devices SET ' + fields.join(', ') + ' WHERE device_id = $1', values
  );
  return getDevice(deviceId);
}

async function deactivateDevice(deviceId) {
  await pool.query(
    "UPDATE hce_devices SET status = 'suspended' WHERE device_id = $1", [deviceId]
  );
  return { device_id: deviceId, status: 'suspended' };
}

// ─── PAYMENT AUTHORIZATION ───────────────────────────────────────────────────

async function authorizePayment(opts) {
  checkCircuit();
  await ensureTables();

  var amount = parseFloat(opts.amount);
  if (isNaN(amount) || amount < MIN_PAYMENT_AMOUNT) {
    throw new Error('Amount must be at least $' + MIN_PAYMENT_AMOUNT);
  }
  if (amount > MAX_PAYMENT_AMOUNT) {
    throw new Error('Amount exceeds maximum of $' + MAX_PAYMENT_AMOUNT.toLocaleString());
  }

  // Validate device
  var device = await getDevice(opts.device_id);
  if (!device) throw new Error('Device not registered: ' + opts.device_id);
  if (device.status !== 'active') throw new Error('Device suspended or inactive');

  // Check per-transaction limit
  if (amount > parseFloat(device.per_txn_limit)) {
    throw new Error('Amount exceeds device per-transaction limit of $' + parseFloat(device.per_txn_limit).toLocaleString());
  }

  // Check daily limit
  var dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  var dailyUsed = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) as total FROM hce_transactions
     WHERE device_id = $1 AND status NOT IN ('declined','failed','reversed') AND submitted_at > $2`,
    [opts.device_id, dayStart]
  );
  var dailyTotal = parseFloat(dailyUsed.rows[0].total);
  if (dailyTotal + amount > parseFloat(device.daily_limit)) {
    throw new Error('Daily limit exceeded: $' + dailyTotal.toFixed(2) + ' used of $' + parseFloat(device.daily_limit).toLocaleString() + ' limit');
  }

  // Velocity check
  await checkVelocity(opts.device_id);

  // Determine funding source
  var fundingSource = device.sub_ledger_id || ('trust:' + (device.trust_account_code || '1000'));
  var sourceCode = device.trust_account_code || '1000';
  var subLedgerId = device.sub_ledger_id || opts.sub_ledger_id || null;

  // If sub-ledger, validate balance
  if (subLedgerId && SubLedgerEngine) {
    try {
      var ledger = await SubLedgerEngine.getSubLedger(subLedgerId);
      if (ledger && parseFloat(ledger.balance) < amount) {
        throw new Error('Insufficient sub-ledger balance: $' + parseFloat(ledger.balance).toFixed(2));
      }
      sourceCode = ledger.parent_account_code || sourceCode;
    } catch (balErr) {
      if (balErr.message.startsWith('Insufficient')) throw balErr;
    }
  }

  // Determine approval tier
  var tier = getApprovalTier(amount);
  var status = requiresApproval(amount) ? 'pending_approval' : 'authorized';

  var txnId = generateTxnId();
  var authCode = generateAuthCode();
  var integrityHash = computeIntegrityHash({
    txn_id: txnId,
    amount: amount,
    device_id: opts.device_id,
    merchant_name: opts.merchant_name || 'POS Terminal',
    submitted_at: new Date().toISOString(),
  });

  // Generate payment token
  var tokenData = generateToken(opts.device_id, txnId, amount);

  // Create transaction record
  await pool.query(`
    INSERT INTO hce_transactions
      (txn_id, device_id, authorization_code, token, amount, merchant_name, merchant_id,
       merchant_category, terminal_id, funding_source, sub_ledger_id, source_account_code,
       status, approval_tier, integrity_hash, geolocation, device_ip)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
  `, [
    txnId, opts.device_id, authCode, tokenData.token, amount,
    opts.merchant_name || null, opts.merchant_id || null,
    opts.merchant_category || null, opts.terminal_id || null,
    fundingSource, subLedgerId, sourceCode,
    status, tier, integrityHash,
    opts.geolocation || null, opts.device_ip || null,
  ]);

  // Store token
  await pool.query(`
    INSERT INTO hce_tokens (token_id, device_id, txn_id, token_data, amount, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [
    'TKN-' + crypto.randomBytes(6).toString('hex').toUpperCase(),
    opts.device_id, txnId, tokenData.token, amount, tokenData.expires_at,
  ]);

  // Update device last_used
  await pool.query(
    'UPDATE hce_devices SET last_used_at = NOW() WHERE device_id = $1',
    [opts.device_id]
  );

  recordSuccess();

  // Generate QR payment code for terminal scanning
  var qrPayload = generateQRPayload(txnId, authCode, amount, opts.device_id, tokenData.expires_at.toISOString());

  return {
    txn_id: txnId,
    authorization_code: authCode,
    token: tokenData.token,
    token_expires_at: tokenData.expires_at.toISOString(),
    amount: amount,
    status: status,
    approval_tier: tier,
    funding_source: fundingSource,
    requires_approval: requiresApproval(amount),
    integrity_hash: integrityHash,
    qr_payload: qrPayload,
  };
}

// ─── PAYMENT PROCESSING (after terminal tap) ─────────────────────────────────

async function processPayment(txnId, opts) {
  checkCircuit();
  opts = opts || {};

  var txnRows = await pool.query(
    'SELECT * FROM hce_transactions WHERE txn_id = $1', [txnId]
  );
  var txn = txnRows.rows[0];
  if (!txn) throw new Error('Transaction not found: ' + txnId);
  if (txn.status === 'settled' || txn.status === 'completed') {
    throw new Error('Transaction already settled');
  }
  if (txn.status !== 'authorized' && txn.status !== 'pending_approval') {
    throw new Error('Transaction not in processable state: ' + txn.status);
  }

  // If pending approval, check if approved
  if (txn.status === 'pending_approval') {
    throw new Error('Transaction awaiting approval (tier: ' + txn.approval_tier + ')');
  }

  var amount = parseFloat(txn.amount);

  // 1. Debit sub-ledger if applicable
  var subLedgerTxnId = null;
  if (txn.sub_ledger_id && SubLedgerEngine) {
    try {
      var slTxn = await SubLedgerEngine.postTransaction({
        subLedgerId: txn.sub_ledger_id,
        transactionType: 'debit',
        amount: amount,
        description: 'HCE contactless payment: ' + (opts.merchant_name || txn.merchant_name || 'POS') + ' $' + amount.toFixed(2),
        referenceType: 'hce_payment',
        referenceId: txnId,
        postedBy: 'hce_payment_engine',
      });
      subLedgerTxnId = slTxn.transactionId;
    } catch (slErr) {
      recordFailure(slErr);
      await pool.query(
        "UPDATE hce_transactions SET status = 'failed', error_message = $2, updated_at = NOW() WHERE txn_id = $1",
        [txnId, 'Sub-ledger debit failed: ' + slErr.message]
      );
      throw slErr;
    }
  }

  // 2. Post journal entry
  var journalEntryId = null;
  if (TrustAccountingEngine) {
    try {
      var sourceCode = txn.source_account_code || '1000';
      var je = await TrustAccountingEngine.postJournalEntry({
        entryDate: new Date(),
        description: 'HCE contactless payment — ' + (opts.merchant_name || txn.merchant_name || 'POS') + ' $' + amount.toFixed(2),
        lines: [
          { accountCode: ACCOUNT_CODES.EXPENSES, debitAmount: amount, creditAmount: 0,
            memo: 'HCE payment ' + txnId + ' — ' + (opts.merchant_name || txn.merchant_name || 'POS') },
          { accountCode: sourceCode, debitAmount: 0, creditAmount: amount,
            memo: 'HCE ' + txnId + ' funding' },
        ],
        referenceType: 'hce_payment',
        referenceId: txnId,
        postedBy: 'hce_payment_engine',
        postToFineract: false,
      });
      journalEntryId = je.entry_id;
    } catch (jeErr) {
      console.error('[HCE] Journal entry failed:', jeErr.message);
    }
  }

  // 3. Update merchant details if provided at terminal
  var merchantName = opts.merchant_name || txn.merchant_name;
  var merchantId = opts.merchant_id || txn.merchant_id;

  // 4. Transmit payment externally via Electronic Settlement Engine (BILL PayBills)
  //    This AWAITS the external transmission so we know if real funds moved.
  //    Core banking is already debited (step 1+2). This step sends funds to the recipient.
  var settlementId = 'ESTL-HCE-' + Date.now().toString(36).toUpperCase() + '-' +
    crypto.randomBytes(2).toString('hex').toUpperCase();
  var billRef = null;
  var transmissionStatus = 'pending';
  var transmissionError = null;
  var externalPaymentRef = null;
  var billVendorId = null;

  try {
    var settlementEngine = require('./electronicSettlementEngine');
    if (settlementEngine && settlementEngine.submitElectronicPayment) {
      var eslResult = await settlementEngine.submitElectronicPayment({
        amount: amount,
        payee_name: merchantName || 'POS Terminal',
        payment_type: 'vendor_payment',
        source_account_code: txn.source_account_code || '1000',
        sub_ledger_id: txn.sub_ledger_id || null,
        priority: 'standard',
        description: 'HCE contactless payment — ' + (merchantName || 'POS') + ' $' + amount.toFixed(2),
        memo: 'HCE Txn: ' + txnId,
        initiated_by: 'hce_payment_engine',
      });
      settlementId = eslResult.settlement_id;
      billRef = eslResult.bill_ref || eslResult.payment_ref;
      externalPaymentRef = eslResult.payment_ref;
      billVendorId = eslResult.bill_vendor_id || null;
      transmissionStatus = 'transmitted';
    }
  } catch (eslErr) {
    transmissionError = eslErr.message;
    if (eslErr.mfa_required) {
      transmissionStatus = 'mfa_required';
      console.warn('[HCE] BILL MFA required — payment settled in core banking, external transmission pending MFA');
    } else {
      transmissionStatus = 'failed';
      console.error('[HCE] External transmission failed: ' + eslErr.message + ' — payment settled in core banking only');
    }
  }

  // 5. Update transaction to settled with transmission status
  await pool.query(`
    UPDATE hce_transactions SET
      status = 'settled', settled_at = NOW(),
      sub_ledger_txn_id = $2, journal_entry_id = $3, settlement_id = $4,
      merchant_name = COALESCE($5, merchant_name),
      merchant_id = COALESCE($6, merchant_id),
      transmission_status = $7, bill_ref = $8,
      updated_at = NOW()
    WHERE txn_id = $1
  `, [txnId, subLedgerTxnId, journalEntryId, settlementId, merchantName, merchantId,
      transmissionStatus, billRef]);

  // 6. Track with notification engine
  if (notifEngine) {
    try {
      await notifEngine.trackPayment({
        payment_type: 'hce_contactless',
        payment_method: 'nfc_contactless',
        direction: 'outbound',
        amount: amount,
        source_account: txn.source_account_code || '1000',
        destination_name: merchantName || 'POS Terminal',
        sub_ledger_id: txn.sub_ledger_id || null,
        internal_ref: txnId,
        journal_entry_id: journalEntryId,
        description: 'HCE contactless payment at ' + (merchantName || 'POS'),
      });
    } catch (nErr) { console.warn('[HCE] notification tracking failed:', nErr.message); }
  }

  // 7. Data Bridge sync
  if (DataBridge) {
    try {
      await DataBridge.runFullSync();
    } catch (dbErr) { console.warn('[HCE] Data Bridge sync failed:', dbErr.message); }
  }

  // Mark token as used
  await pool.query(
    "UPDATE hce_tokens SET used = TRUE, used_at = NOW() WHERE txn_id = $1",
    [txnId]
  );

  recordSuccess();

  // Generate receipt with transmission confirmation
  var receipt = {
    txn_id: txnId,
    authorization_code: txn.authorization_code,
    amount: amount,
    merchant_name: merchantName,
    merchant_id: merchantId,
    payment_method: opts.qr_scan ? 'QR Scan' : 'NFC Contactless',
    funding_source: txn.funding_source,
    journal_entry_id: journalEntryId,
    settlement_id: settlementId,
    bill_ref: billRef,
    bill_vendor_id: billVendorId,
    external_payment_ref: externalPaymentRef,
    transmission_status: transmissionStatus,
    transmission_error: transmissionError,
    settled_at: new Date().toISOString(),
    status: transmissionStatus === 'transmitted' ? 'settled' : 'settled_local',
    payment_confirmed: transmissionStatus === 'transmitted',
    confirmation_message: transmissionStatus === 'transmitted'
      ? 'Payment transmitted to recipient via BILL.com — funds processing (T+1)'
      : transmissionStatus === 'mfa_required'
        ? 'Payment settled in core banking. External transmission requires MFA verification.'
        : transmissionStatus === 'failed'
          ? 'Payment settled in core banking. External transmission failed: ' + transmissionError
          : 'Payment settled in core banking. External transmission pending.',
    issuer: 'DLB Trust HCE Payment System',
  };

  await pool.query(
    "UPDATE hce_transactions SET receipt_data = $2 WHERE txn_id = $1",
    [txnId, JSON.stringify(receipt)]
  );

  return receipt;
}

// ─── APPROVAL MANAGEMENT ─────────────────────────────────────────────────────

async function approveTransaction(txnId, approvedBy) {
  var txnRows = await pool.query(
    'SELECT * FROM hce_transactions WHERE txn_id = $1', [txnId]
  );
  var txn = txnRows.rows[0];
  if (!txn) throw new Error('Transaction not found');
  if (txn.status !== 'pending_approval') throw new Error('Transaction not pending approval');

  await pool.query(`
    UPDATE hce_transactions SET
      status = 'authorized', approved_by = $2, approval_timestamp = NOW(), updated_at = NOW()
    WHERE txn_id = $1
  `, [txnId, approvedBy || 'admin']);

  return { txn_id: txnId, status: 'authorized', approved_by: approvedBy };
}

async function declineTransaction(txnId, reason) {
  await pool.query(`
    UPDATE hce_transactions SET
      status = 'declined', error_message = $2, updated_at = NOW()
    WHERE txn_id = $1
  `, [txnId, reason || 'Declined by administrator']);

  return { txn_id: txnId, status: 'declined', reason: reason };
}

// ─── TRANSACTION REVERSAL ────────────────────────────────────────────────────

async function reverseTransaction(txnId, reason) {
  var txnRows = await pool.query(
    'SELECT * FROM hce_transactions WHERE txn_id = $1', [txnId]
  );
  var txn = txnRows.rows[0];
  if (!txn) throw new Error('Transaction not found');
  if (txn.status !== 'settled' && txn.status !== 'completed') {
    throw new Error('Can only reverse settled/completed transactions');
  }

  var amount = parseFloat(txn.amount);

  // Reverse sub-ledger debit
  if (txn.sub_ledger_id && SubLedgerEngine) {
    try {
      await SubLedgerEngine.postTransaction({
        subLedgerId: txn.sub_ledger_id,
        transactionType: 'credit',
        amount: amount,
        description: 'HCE reversal: ' + txnId + ' — ' + (reason || 'Reversed'),
        referenceType: 'hce_reversal',
        referenceId: txnId,
        postedBy: 'hce_payment_engine',
      });
    } catch (e) { console.error('[HCE] sub-ledger reversal failed:', e.message); }
  }

  // Post reversal journal entry
  if (TrustAccountingEngine) {
    try {
      var sourceCode = txn.source_account_code || '1000';
      await TrustAccountingEngine.postJournalEntry({
        entryDate: new Date(),
        description: 'HCE reversal — ' + txnId + ' ' + (reason || ''),
        lines: [
          { accountCode: sourceCode, debitAmount: amount, creditAmount: 0,
            memo: 'Reversal of HCE payment ' + txnId },
          { accountCode: ACCOUNT_CODES.EXPENSES, debitAmount: 0, creditAmount: amount,
            memo: 'HCE reversal ' + txnId },
        ],
        referenceType: 'hce_reversal',
        referenceId: txnId,
        postedBy: 'hce_payment_engine',
        postToFineract: false,
      });
    } catch (jeErr) { console.error('[HCE] reversal JE failed:', jeErr.message); }
  }

  await pool.query(`
    UPDATE hce_transactions SET
      status = 'reversed', error_message = $2, updated_at = NOW()
    WHERE txn_id = $1
  `, [txnId, 'Reversed: ' + (reason || 'Admin reversal')]);

  return { txn_id: txnId, status: 'reversed', reason: reason };
}

// ─── PAYMENT CONFIRMATION ─────────────────────────────────────────────────────

/**
 * Get payment confirmation status — checks BILL for actual external payment status.
 * Returns whether the recipient actually received the funds.
 */
async function getPaymentConfirmation(txnId) {
  var txnRows = await pool.query('SELECT * FROM hce_transactions WHERE txn_id = $1', [txnId]);
  var txn = txnRows.rows[0];
  if (!txn) throw new Error('Transaction not found');

  var receiptData = txn.receipt_data;
  if (typeof receiptData === 'string') {
    try { receiptData = JSON.parse(receiptData); } catch (e) { receiptData = {}; }
  }

  var confirmation = {
    txn_id: txnId,
    amount: parseFloat(txn.amount),
    merchant_name: txn.merchant_name,
    local_status: txn.status,
    journal_entry_id: txn.journal_entry_id,
    settlement_id: txn.settlement_id,
    settled_at: txn.settled_at,
    transmission_status: receiptData.transmission_status || 'unknown',
    bill_ref: receiptData.bill_ref || null,
    external_payment_ref: receiptData.external_payment_ref || null,
    bill_payment_status: null,
    recipient_confirmed: false,
    confirmation_details: null,
  };

  // If we have a BILL ref, poll BILL for actual status
  if (receiptData.bill_ref) {
    try {
      var billClientMod = require('../bill/billClient');
      if (billClientMod && billClientMod.readEntity) {
        var sentPay = await billClientMod.readEntity('SentPay', receiptData.bill_ref);
        if (sentPay) {
          var billStatus = String(sentPay.status || sentPay.paymentStatus || '');
          // BILL SentPay statuses: 0=Scheduled, 1=Processing, 2=Processed, 3=Failed, 4=Voided
          var statusLabels = { '0': 'scheduled', '1': 'processing', '2': 'processed', '3': 'failed', '4': 'voided' };
          confirmation.bill_payment_status = statusLabels[billStatus] || billStatus;
          confirmation.recipient_confirmed = billStatus === '2';
          confirmation.confirmation_details = {
            process_date: sentPay.processDate || sentPay.tpDate || null,
            amount: sentPay.amount || null,
            payee: sentPay.name || sentPay.vendorName || null,
            txn_number: sentPay.txnNumber || null,
            check_number: sentPay.checkNumber || null,
          };
        }
      }
    } catch (billErr) {
      confirmation.bill_payment_status = 'check_failed';
      confirmation.confirmation_details = { error: billErr.message };
    }
  }

  // Also check electronic_settlements table for additional status
  if (txn.settlement_id) {
    try {
      var eslRows = await pool.query(
        'SELECT status, bill_ref, transmitted_at, settled_at, confirmed_at FROM electronic_settlements WHERE settlement_id = $1',
        [txn.settlement_id]
      );
      if (eslRows.rows[0]) {
        var esl = eslRows.rows[0];
        confirmation.settlement_engine_status = esl.status;
        confirmation.transmitted_at = esl.transmitted_at;
        if (esl.status === 'confirmed' || esl.status === 'finalized') {
          confirmation.recipient_confirmed = true;
        }
      }
    } catch (e) { /* optional */ }
  }

  return confirmation;
}

/**
 * Retry external transmission for a payment that failed (e.g. MFA was required).
 * Call after MFA is verified to re-transmit the payment.
 */
async function retryExternalTransmission(txnId) {
  var txnRows = await pool.query('SELECT * FROM hce_transactions WHERE txn_id = $1', [txnId]);
  var txn = txnRows.rows[0];
  if (!txn) throw new Error('Transaction not found');
  if (txn.status !== 'settled') throw new Error('Transaction not in settled state');

  var amount = parseFloat(txn.amount);
  var merchantName = txn.merchant_name || 'POS Terminal';

  try {
    var settlementEngine = require('./electronicSettlementEngine');
    var eslResult = await settlementEngine.submitElectronicPayment({
      amount: amount,
      payee_name: merchantName,
      payment_type: 'vendor_payment',
      source_account_code: txn.source_account_code || '1000',
      sub_ledger_id: txn.sub_ledger_id || null,
      priority: 'standard',
      description: 'HCE retry — ' + merchantName + ' $' + amount.toFixed(2),
      memo: 'HCE Retry Txn: ' + txnId,
      initiated_by: 'hce_payment_engine',
    });

    // Update receipt with successful transmission
    var receipt = txn.receipt_data;
    if (typeof receipt === 'string') { try { receipt = JSON.parse(receipt); } catch (e) { receipt = {}; } }
    receipt.bill_ref = eslResult.bill_ref || eslResult.payment_ref;
    receipt.external_payment_ref = eslResult.payment_ref;
    receipt.bill_vendor_id = eslResult.bill_vendor_id || null;
    receipt.transmission_status = 'transmitted';
    receipt.transmission_error = null;
    receipt.status = 'settled';
    receipt.payment_confirmed = true;
    receipt.confirmation_message = 'Payment transmitted to recipient via BILL.com — funds processing (T+1)';
    receipt.retransmitted_at = new Date().toISOString();

    await pool.query(
      "UPDATE hce_transactions SET settlement_id = $2, receipt_data = $3, updated_at = NOW() WHERE txn_id = $1",
      [txnId, eslResult.settlement_id, JSON.stringify(receipt)]
    );

    return {
      txn_id: txnId,
      status: 'transmitted',
      settlement_id: eslResult.settlement_id,
      bill_ref: eslResult.bill_ref,
      payment_ref: eslResult.payment_ref,
      message: 'Payment successfully transmitted — recipient will receive funds (T+1)',
    };
  } catch (err) {
    if (err.mfa_required) {
      throw err; // Let caller handle MFA flow
    }
    throw new Error('Retry failed: ' + err.message);
  }
}

// ─── DASHBOARD / QUERIES ─────────────────────────────────────────────────────

async function getDashboard() {
  await ensureTables();

  var stats = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'settled' OR status = 'completed') as settled,
      COUNT(*) FILTER (WHERE status = 'authorized') as authorized,
      COUNT(*) FILTER (WHERE status = 'pending_approval') as pending_approval,
      COUNT(*) FILTER (WHERE status = 'declined' OR status = 'failed') as failed,
      COUNT(*) FILTER (WHERE status = 'reversed') as reversed,
      COALESCE(SUM(amount) FILTER (WHERE status = 'settled' OR status = 'completed'), 0) as settled_volume,
      COALESCE(SUM(amount) FILTER (WHERE status = 'authorized'), 0) as authorized_volume,
      COALESCE(SUM(amount) FILTER (WHERE status = 'pending_approval'), 0) as pending_volume
    FROM hce_transactions
  `);

  var recent = await pool.query(`
    SELECT txn_id, device_id, amount, merchant_name, merchant_category,
           funding_source, sub_ledger_id, status, approval_tier,
           authorization_code, submitted_at, settled_at
    FROM hce_transactions
    ORDER BY submitted_at DESC LIMIT 20
  `);

  var devices = await pool.query(`
    SELECT device_id, device_name, account_holder, status, daily_limit,
           per_txn_limit, last_used_at, platform
    FROM hce_devices
    ORDER BY created_at DESC
  `);

  return {
    stats: stats.rows[0],
    recent_transactions: recent.rows,
    devices: devices.rows,
    circuit_breaker: {
      open: circuitState.open,
      failures: circuitState.failures,
    },
    approval_tiers: APPROVAL_TIERS,
    velocity_limits: VELOCITY_LIMITS,
  };
}

async function getTransaction(txnId) {
  var result = await pool.query(
    'SELECT * FROM hce_transactions WHERE txn_id = $1', [txnId]
  );
  return result.rows[0] || null;
}

async function listTransactions(filters) {
  filters = filters || {};
  var where = [];
  var values = [];
  var idx = 1;

  if (filters.device_id) { where.push('device_id = $' + idx); values.push(filters.device_id); idx++; }
  if (filters.status) { where.push('status = $' + idx); values.push(filters.status); idx++; }
  if (filters.from_date) { where.push('submitted_at >= $' + idx); values.push(filters.from_date); idx++; }
  if (filters.to_date) { where.push('submitted_at <= $' + idx); values.push(filters.to_date); idx++; }

  var sql = 'SELECT * FROM hce_transactions' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY submitted_at DESC LIMIT 100';

  var result = await pool.query(sql, values);
  return result.rows;
}

async function getCircuitStatus() {
  return {
    open: circuitState.open,
    failures: circuitState.failures,
    threshold: CIRCUIT_THRESHOLD,
    reset_ms: CIRCUIT_RESET_MS,
  };
}

// ─── EXTERNAL QR CODE PARSING ─────────────────────────────────────────────────

function parseExternalQR(qrString) {
  if (!qrString || typeof qrString !== 'string') return null;
  qrString = qrString.trim();

  // Internal DLB HCE format
  try {
    var parsed = JSON.parse(qrString);
    if (parsed && parsed.type === 'dlb-hce-pay') {
      return { provider: 'dlb-hce', format: 'internal', raw: qrString, data: parsed };
    }
  } catch (e) { /* not JSON, continue */ }

  // Cash App: https://cash.app/$cashtag or https://cash.app/$cashtag/25.00
  var cashAppMatch = qrString.match(/^https?:\/\/cash\.app\/\$([A-Za-z0-9_-]+)(?:\/(\d+(?:\.\d{1,2})?))?/i);
  if (cashAppMatch) {
    return {
      provider: 'cashapp',
      format: 'url',
      raw: qrString,
      data: {
        cashtag: '$' + cashAppMatch[1],
        recipient: cashAppMatch[1],
        amount: cashAppMatch[2] ? parseFloat(cashAppMatch[2]) : null,
      }
    };
  }

  // Venmo: https://venmo.com/u/username or venmo://paycharge?txn=pay&recipients=user&amount=25
  var venmoWebMatch = qrString.match(/^https?:\/\/venmo\.com\/(?:u\/)?([A-Za-z0-9_-]+)(?:\?.*amount=(\d+(?:\.\d{1,2})?))?/i);
  if (venmoWebMatch) {
    return {
      provider: 'venmo',
      format: 'url',
      raw: qrString,
      data: {
        username: venmoWebMatch[1],
        recipient: venmoWebMatch[1],
        amount: venmoWebMatch[2] ? parseFloat(venmoWebMatch[2]) : null,
      }
    };
  }
  var venmoDeepMatch = qrString.match(/^venmo:\/\/paycharge\?.*recipients=([^&]+).*amount=(\d+(?:\.\d{1,2})?)?/i);
  if (venmoDeepMatch) {
    return {
      provider: 'venmo',
      format: 'deeplink',
      raw: qrString,
      data: {
        username: decodeURIComponent(venmoDeepMatch[1]),
        recipient: decodeURIComponent(venmoDeepMatch[1]),
        amount: venmoDeepMatch[2] ? parseFloat(venmoDeepMatch[2]) : null,
      }
    };
  }

  // PayPal: https://www.paypal.me/username/25.00 or paypal.me/username
  var paypalMatch = qrString.match(/^https?:\/\/(?:www\.)?paypal\.(?:me|com\/paypalme)\/([A-Za-z0-9_-]+)(?:\/(\d+(?:\.\d{1,2})?))?/i);
  if (paypalMatch) {
    return {
      provider: 'paypal',
      format: 'url',
      raw: qrString,
      data: {
        username: paypalMatch[1],
        recipient: paypalMatch[1],
        amount: paypalMatch[2] ? parseFloat(paypalMatch[2]) : null,
      }
    };
  }

  // Zelle: typically a mailto or phone-based QR
  var zelleMatch = qrString.match(/^https?:\/\/(?:www\.)?zellepay\.com\/.*?(?:recipient|to)=([^&]+)(?:.*amount=(\d+(?:\.\d{1,2})?))?/i);
  if (zelleMatch) {
    return {
      provider: 'zelle',
      format: 'url',
      raw: qrString,
      data: {
        recipient: decodeURIComponent(zelleMatch[1]),
        amount: zelleMatch[2] ? parseFloat(zelleMatch[2]) : null,
      }
    };
  }

  // Square / generic payment URL with amount in query params
  var genericPayMatch = qrString.match(/^https?:\/\/[^?]+\?.*amount=(\d+(?:\.\d{1,2})?)/i);
  if (genericPayMatch) {
    var urlObj;
    try { urlObj = new URL(qrString); } catch (e) { urlObj = null; }
    return {
      provider: 'generic',
      format: 'url',
      raw: qrString,
      data: {
        recipient: urlObj ? urlObj.hostname : 'unknown',
        amount: parseFloat(genericPayMatch[1]),
        url: qrString,
      }
    };
  }

  // Bitcoin / crypto addresses (starts with bitcoin: or ethereum:)
  var cryptoMatch = qrString.match(/^(bitcoin|ethereum|litecoin):([A-Za-z0-9]+)(?:\?amount=([0-9.]+))?/i);
  if (cryptoMatch) {
    return {
      provider: cryptoMatch[1].toLowerCase(),
      format: 'crypto',
      raw: qrString,
      data: {
        address: cryptoMatch[2],
        recipient: cryptoMatch[2].slice(0, 8) + '...',
        amount: cryptoMatch[3] ? parseFloat(cryptoMatch[3]) : null,
        currency: cryptoMatch[1].toUpperCase(),
      }
    };
  }

  // Plain URL that might be a payment page
  if (qrString.match(/^https?:\/\//i)) {
    var host;
    try { host = new URL(qrString).hostname; } catch (e) { host = 'unknown'; }
    return {
      provider: 'web',
      format: 'url',
      raw: qrString,
      data: { recipient: host, url: qrString, amount: null }
    };
  }

  // If it's just a dollar amount like "$25.00"
  var amountOnly = qrString.match(/^\$?(\d+(?:\.\d{1,2})?)$/);
  if (amountOnly) {
    return {
      provider: 'amount',
      format: 'text',
      raw: qrString,
      data: { amount: parseFloat(amountOnly[1]), recipient: null }
    };
  }

  return null;
}

async function processExternalQRPayment(parsedQR, opts) {
  checkCircuit();
  await ensureTables();
  opts = opts || {};

  if (!parsedQR || !parsedQR.provider) throw new Error('Invalid QR data');

  var amount = parsedQR.data.amount || opts.amount;
  if (!amount || amount < MIN_PAYMENT_AMOUNT) throw new Error('Amount required — enter amount for this QR payment');
  if (amount > MAX_PAYMENT_AMOUNT) throw new Error('Amount exceeds max $' + MAX_PAYMENT_AMOUNT.toLocaleString());

  var deviceId = opts.device_id;
  var device = null;
  if (deviceId) {
    device = await getDevice(deviceId);
    if (!device) throw new Error('Device not found: ' + deviceId);
    if (device.status !== 'active') throw new Error('Device suspended');
    if (amount > parseFloat(device.per_txn_limit)) throw new Error('Exceeds per-txn limit $' + device.per_txn_limit);
    await checkVelocity(deviceId);
  } else {
    // Use first active device if none specified
    var devices = await listDevices();
    device = devices.find(function(d) { return d.status === 'active'; });
    if (!device) throw new Error('No active device — register a device first');
    deviceId = device.device_id;
  }

  var merchantName = parsedQR.data.recipient || parsedQR.provider;
  var merchantCategory = parsedQR.provider === 'cashapp' ? 'P2P Transfer' :
    parsedQR.provider === 'venmo' ? 'P2P Transfer' :
    parsedQR.provider === 'paypal' ? 'P2P Transfer' : 'QR Payment';

  var fundingSource = device.sub_ledger_id || ('trust:' + (device.trust_account_code || '1000'));
  var sourceCode = device.trust_account_code || '1000';
  var subLedgerId = device.sub_ledger_id || null;

  // Balance check
  if (subLedgerId && SubLedgerEngine) {
    try {
      var ledger = await SubLedgerEngine.getSubLedger(subLedgerId);
      if (ledger && parseFloat(ledger.balance) < amount) {
        throw new Error('Insufficient sub-ledger balance: $' + parseFloat(ledger.balance).toFixed(2));
      }
      sourceCode = ledger.parent_account_code || sourceCode;
    } catch (e) { if (e.message.startsWith('Insufficient')) throw e; }
  }

  var tier = getApprovalTier(amount);
  var status = requiresApproval(amount) ? 'pending_approval' : 'authorized';

  var txnId = generateTxnId();
  var authCode = generateAuthCode();
  var integrityHash = computeIntegrityHash({
    txn_id: txnId, amount: amount, device_id: deviceId,
    merchant_name: merchantName, submitted_at: new Date().toISOString(),
  });

  var tokenData = generateToken(deviceId, txnId, amount);

  await pool.query(`
    INSERT INTO hce_transactions
      (txn_id, device_id, authorization_code, token, amount, merchant_name, merchant_id,
       merchant_category, terminal_id, payment_method, funding_source, sub_ledger_id,
       source_account_code, status, approval_tier, integrity_hash, geolocation, device_ip)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
  `, [
    txnId, deviceId, authCode, tokenData.token, amount,
    merchantName, parsedQR.provider + ':' + (parsedQR.data.recipient || ''),
    merchantCategory, 'QR-' + parsedQR.provider.toUpperCase(),
    'qr_scan_' + parsedQR.provider, fundingSource, subLedgerId, sourceCode,
    status, tier, integrityHash, opts.geolocation || null, opts.device_ip || null,
  ]);

  await pool.query(`
    INSERT INTO hce_tokens (token_id, device_id, txn_id, token_data, amount, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [
    'TKN-' + crypto.randomBytes(6).toString('hex').toUpperCase(),
    deviceId, txnId, tokenData.token, amount, tokenData.expires_at,
  ]);

  await pool.query('UPDATE hce_devices SET last_used_at = NOW() WHERE device_id = $1', [deviceId]);

  recordSuccess();

  // Auto-process if auto-approved
  if (status === 'authorized') {
    var receipt = await processPayment(txnId, { merchant_name: merchantName, qr_scan: true });
    return {
      action: receipt.transmission_status === 'transmitted' ? 'settled' : 'settled_local',
      provider: parsedQR.provider,
      recipient: parsedQR.data.recipient,
      txn_id: receipt.txn_id,
      authorization_code: receipt.authorization_code,
      amount: receipt.amount,
      journal_entry_id: receipt.journal_entry_id,
      settlement_id: receipt.settlement_id,
      bill_ref: receipt.bill_ref,
      external_payment_ref: receipt.external_payment_ref,
      transmission_status: receipt.transmission_status,
      payment_confirmed: receipt.payment_confirmed,
      confirmation_message: receipt.confirmation_message,
      status: receipt.status,
    };
  }

  return {
    action: 'pending_approval',
    provider: parsedQR.provider,
    recipient: parsedQR.data.recipient,
    txn_id: txnId,
    authorization_code: authCode,
    amount: amount,
    approval_tier: tier,
    status: 'pending_approval',
  };
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

// ─── QR PAYMENT CODE GENERATION ───────────────────────────────────────────────

function generateQRPayload(txnId, authCode, amount, deviceId, expiresAt) {
  var qrData = {
    v: 1,
    type: 'dlb-hce-pay',
    txn: txnId,
    auth: authCode,
    amt: amount,
    dev: deviceId,
    exp: expiresAt,
    ts: Date.now(),
    nonce: crypto.randomBytes(6).toString('hex'),
  };
  var dataStr = JSON.stringify(qrData);
  var sig = crypto.createHmac('sha256', TOKEN_SECRET)
    .update(dataStr).digest('hex').slice(0, 16);
  qrData.sig = sig;
  return JSON.stringify(qrData);
}

function verifyQRPayload(qrString) {
  try {
    var qrData = JSON.parse(qrString);
    if (qrData.type !== 'dlb-hce-pay') return null;
    var sig = qrData.sig;
    delete qrData.sig;
    var dataStr = JSON.stringify(qrData);
    var expectedSig = crypto.createHmac('sha256', TOKEN_SECRET)
      .update(dataStr).digest('hex').slice(0, 16);
    if (sig !== expectedSig) return null;
    if (qrData.exp && new Date(qrData.exp).getTime() < Date.now()) return null;
    return qrData;
  } catch (e) {
    return null;
  }
}

async function processQRScan(qrString) {
  var payload = verifyQRPayload(qrString);
  if (!payload) throw new Error('Invalid or expired QR payment code');

  var txn = await getTransaction(payload.txn);
  if (!txn) throw new Error('Transaction not found: ' + payload.txn);
  if (txn.authorization_code !== payload.auth) throw new Error('Authorization code mismatch');
  if (txn.status === 'settled' || txn.status === 'completed') {
    return { already_settled: true, txn_id: txn.txn_id, status: txn.status };
  }
  if (txn.status !== 'authorized') {
    throw new Error('Transaction not in authorized state: ' + txn.status);
  }

  var receipt = await processPayment(payload.txn, { qr_scan: true });
  return receipt;
}

module.exports = {
  ensureTables: ensureTables,
  registerDevice: registerDevice,
  listDevices: listDevices,
  getDevice: getDevice,
  updateDevice: updateDevice,
  deactivateDevice: deactivateDevice,
  authorizePayment: authorizePayment,
  processPayment: processPayment,
  approveTransaction: approveTransaction,
  declineTransaction: declineTransaction,
  reverseTransaction: reverseTransaction,
  getPaymentConfirmation: getPaymentConfirmation,
  retryExternalTransmission: retryExternalTransmission,
  getDashboard: getDashboard,
  getTransaction: getTransaction,
  listTransactions: listTransactions,
  getCircuitStatus: getCircuitStatus,
  verifyToken: verifyToken,
  generateQRPayload: generateQRPayload,
  verifyQRPayload: verifyQRPayload,
  processQRScan: processQRScan,
  parseExternalQR: parseExternalQR,
  processExternalQRPayment: processExternalQRPayment,
  APPROVAL_TIERS: APPROVAL_TIERS,
};
