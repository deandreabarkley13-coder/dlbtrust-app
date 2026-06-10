/**
 * Payment Settlement Engine
 * 
 * Tracks payment lifecycle from submission through clearing/failure.
 * Handles ACH return codes, wire confirmations, and automatic status advancement.
 *
 * Status Flow:
 *   processing → sent → cleared (success) OR failed/returned (failure)
 *
 * Settlement Windows:
 *   ACH Standard: T+2 business days
 *   ACH Same-Day: T+0 (before 4:45 PM ET cutoff)
 *   Domestic Wire: Same day (real-time via Fedwire)
 *   International Wire: T+1 to T+3
 *
 * ACH Return Codes (common):
 *   R01 - Insufficient Funds
 *   R02 - Account Closed
 *   R03 - No Account/Unable to Locate
 *   R04 - Invalid Account Number
 *   R05 - Unauthorized Debit (improper)
 *   R06 - Returned per ODFI Request
 *   R07 - Authorization Revoked by Customer
 *   R08 - Payment Stopped
 *   R09 - Uncollected Funds
 *   R10 - Customer Advises Not Authorized
 *   R16 - Account Frozen
 *   R20 - Non-Transaction Account
 *   R29 - Corporate Customer Advises Not Authorized
 *
 * DEANDREA LAVAR BARKLEY TRUST — Private Wealth Management Platform
 */

'use strict';

const path = require('path');
const Database = require('better-sqlite3');

// ACH Return Code descriptions
const ACH_RETURN_CODES = {
  R01: { description: 'Insufficient Funds', action: 'retry', refund: true },
  R02: { description: 'Account Closed', action: 'fail', refund: true },
  R03: { description: 'No Account / Unable to Locate', action: 'fail', refund: true },
  R04: { description: 'Invalid Account Number', action: 'fail', refund: true },
  R05: { description: 'Unauthorized Debit', action: 'fail', refund: true },
  R06: { description: 'Returned per ODFI Request', action: 'review', refund: true },
  R07: { description: 'Authorization Revoked', action: 'fail', refund: true },
  R08: { description: 'Payment Stopped', action: 'fail', refund: true },
  R09: { description: 'Uncollected Funds', action: 'retry', refund: true },
  R10: { description: 'Customer Advises Not Authorized', action: 'fail', refund: true },
  R11: { description: 'Check Truncation Entry Return', action: 'review', refund: true },
  R12: { description: 'Account Sold to Another DFI', action: 'retry', refund: true },
  R13: { description: 'Invalid ACH Routing Number', action: 'fail', refund: true },
  R14: { description: 'Representative Payee Deceased', action: 'fail', refund: true },
  R15: { description: 'Beneficiary Deceased', action: 'fail', refund: true },
  R16: { description: 'Account Frozen', action: 'fail', refund: true },
  R17: { description: 'File Record Edit Criteria', action: 'review', refund: true },
  R20: { description: 'Non-Transaction Account', action: 'fail', refund: true },
  R21: { description: 'Invalid Company Identification', action: 'review', refund: true },
  R22: { description: 'Invalid Individual ID Number', action: 'review', refund: true },
  R23: { description: 'Credit Entry Refused by Receiver', action: 'fail', refund: true },
  R24: { description: 'Duplicate Entry', action: 'review', refund: true },
  R29: { description: 'Corporate Customer Advises Not Authorized', action: 'fail', refund: true },
  R31: { description: 'Permissible Return Entry', action: 'review', refund: true },
  R33: { description: 'Return of XCK Entry', action: 'review', refund: true },
};

// Settlement windows by payment method (in hours)
const SETTLEMENT_WINDOWS = {
  ach: { standard: 48, same_day: 4, return_window: 48 },
  wire: { domestic: 1, international: 72 },
  check: { standard: 120 },
};

function getDb() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'dlbtrust.db');
  return new Database(dbPath);
}

/**
 * Initialize settlement tracking schema
 */
function initSettlementSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transfer_id INTEGER NOT NULL,
      transfer_number TEXT NOT NULL,
      -- Settlement tracking
      submission_method TEXT,
      submission_reference TEXT,
      submitted_at TEXT,
      -- Expected settlement
      expected_clear_date TEXT,
      actual_clear_date TEXT,
      -- Status
      settlement_status TEXT NOT NULL DEFAULT 'pending',
        -- pending, in_transit, cleared, returned, failed, review
      -- Return/failure info
      return_code TEXT,
      return_reason TEXT,
      return_date TEXT,
      -- Confirmation
      bank_reference TEXT,
      confirmation_number TEXT,
      trace_number TEXT,
      -- Amount
      settled_amount_cents INTEGER,
      -- Metadata
      attempts INTEGER DEFAULT 1,
      last_check_at TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (transfer_id) REFERENCES external_transfers(id)
    );
    CREATE INDEX IF NOT EXISTS idx_settlement_transfer ON payment_settlements(transfer_id);
    CREATE INDEX IF NOT EXISTS idx_settlement_status ON payment_settlements(settlement_status);
    CREATE INDEX IF NOT EXISTS idx_settlement_expected ON payment_settlements(expected_clear_date);
  `);
}

/**
 * Calculate expected clearing date based on payment method and submission time
 */
function calculateExpectedClearDate(paymentMethod, submittedAt, priority) {
  const submitted = submittedAt ? new Date(submittedAt) : new Date();
  let hoursToAdd;

  if (paymentMethod === 'wire') {
    hoursToAdd = SETTLEMENT_WINDOWS.wire.domestic;
  } else if (paymentMethod === 'ach') {
    hoursToAdd = priority === 'urgent' || priority === 'same_day'
      ? SETTLEMENT_WINDOWS.ach.same_day
      : SETTLEMENT_WINDOWS.ach.standard;
  } else {
    hoursToAdd = SETTLEMENT_WINDOWS.check?.standard || 120;
  }

  const clearDate = new Date(submitted.getTime() + hoursToAdd * 60 * 60 * 1000);
  // Skip weekends
  while (clearDate.getDay() === 0 || clearDate.getDay() === 6) {
    clearDate.setDate(clearDate.getDate() + 1);
  }
  return clearDate.toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * Create settlement record when payment is transmitted
 */
function createSettlementRecord(db, transfer, deliveryResult) {
  initSettlementSchema(db);

  const expectedClear = calculateExpectedClearDate(
    transfer.payment_method,
    new Date().toISOString(),
    transfer.priority
  );

  const submissionRef = deliveryResult?.confirmation?.transaction_request_id
    || deliveryResult?.confirmation?.transfer_id
    || deliveryResult?.confirmation?.payment_schedule_id
    || deliveryResult?.confirmation?.filename
    || `TX-${Date.now()}`;

  const result = db.prepare(`
    INSERT INTO payment_settlements (
      transfer_id, transfer_number, submission_method, submission_reference,
      submitted_at, expected_clear_date, settlement_status, settled_amount_cents
    ) VALUES (?, ?, ?, ?, datetime('now'), ?, 'in_transit', ?)
  `).run(
    transfer.id,
    transfer.transfer_number,
    deliveryResult?.delivery_method || 'platform_gateway',
    submissionRef,
    expectedClear,
    transfer.amount_cents
  );

  return {
    settlement_id: result.lastInsertRowid,
    expected_clear_date: expectedClear,
    submission_reference: submissionRef,
    status: 'in_transit',
  };
}

/**
 * Process a payment clearing — payment successfully arrived at destination
 */
function clearPayment(db, transferId, opts = {}) {
  initSettlementSchema(db);

  const transfer = db.prepare('SELECT * FROM external_transfers WHERE id = ?').get(transferId);
  if (!transfer) throw new Error('Transfer not found');
  if (!['processing', 'sent'].includes(transfer.status)) {
    throw new Error(`Cannot clear from status '${transfer.status}'`);
  }

  const bankRef = opts.bank_reference || opts.confirmation_number || `CLR-${Date.now()}`;
  const traceNumber = opts.trace_number || null;

  db.prepare(`
    UPDATE external_transfers SET
      status = 'completed',
      completed_date = datetime('now'),
      reference_id = COALESCE(?, reference_id),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(bankRef, transferId);

  // Update settlement record
  db.prepare(`
    UPDATE payment_settlements SET
      settlement_status = 'cleared',
      actual_clear_date = datetime('now'),
      bank_reference = ?,
      confirmation_number = ?,
      trace_number = ?,
      last_check_at = datetime('now'),
      updated_at = datetime('now')
    WHERE transfer_id = ?
  `).run(bankRef, opts.confirmation_number || null, traceNumber, transferId);

  // Audit log
  try {
    db.prepare(`
      INSERT INTO banking_audit_log (event_type, entity_type, entity_id, actor, action, details, created_at)
      VALUES ('payment_cleared', 'external_transfer', ?, 'system', 'clear_payment', ?, datetime('now'))
    `).run(String(transferId), JSON.stringify({
      bank_reference: bankRef,
      trace_number: traceNumber,
      cleared_at: new Date().toISOString(),
      amount_cents: transfer.amount_cents,
    }));
  } catch (_) {}

  return {
    status: 'cleared',
    transfer_number: transfer.transfer_number,
    bank_reference: bankRef,
    cleared_at: new Date().toISOString(),
    amount_cents: transfer.amount_cents,
  };
}

/**
 * Process a payment failure/return — payment did not reach destination
 */
function failPayment(db, transferId, opts = {}) {
  initSettlementSchema(db);

  const transfer = db.prepare('SELECT * FROM external_transfers WHERE id = ?').get(transferId);
  if (!transfer) throw new Error('Transfer not found');
  if (!['processing', 'sent'].includes(transfer.status)) {
    throw new Error(`Cannot fail from status '${transfer.status}'`);
  }

  const returnCode = opts.return_code || null;
  const returnInfo = returnCode ? ACH_RETURN_CODES[returnCode] : null;
  const reason = opts.reason || (returnInfo ? `${returnCode}: ${returnInfo.description}` : 'Payment failed');
  const shouldRefund = opts.refund !== false && (!returnInfo || returnInfo.refund);
  const newStatus = returnCode ? 'returned' : 'failed';

  // Update transfer status
  db.prepare(`
    UPDATE external_transfers SET
      status = ?,
      failure_reason = ?,
      return_code = ?,
      return_date = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(newStatus, reason, returnCode, transferId);

  // Refund funds to source account
  if (shouldRefund) {
    db.prepare(`
      UPDATE trust_accounts SET
        balance_cents = balance_cents + ?,
        available_cents = available_cents + ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(transfer.total_cents, transfer.total_cents, transfer.from_account_id);

    // Post reversal GL entry
    try {
      const entryNumber = `GL-REV-${transfer.transfer_number}`;
      const entryResult = db.prepare(`
        INSERT INTO trust_journal_entries
          (entry_number, entry_date, entry_type, description, source_engine, is_posted,
           total_debit_cents, total_credit_cents, created_by, reference_type, reference_id)
        VALUES (?, date('now'), 'reversal', ?, 'payments', 1, ?, ?, 'system', 'payment_reversal', ?)
      `).run(
        entryNumber,
        `Payment returned/failed: ${transfer.transfer_number} — ${reason}`,
        transfer.amount_cents, transfer.amount_cents, String(transfer.id)
      );
      const entryId = entryResult.lastInsertRowid;

      // Debit Cash (refund back), Credit Expense/AP
      db.prepare(`
        INSERT INTO trust_journal_lines (journal_entry_id, line_number, account_id, account_code, debit_cents, credit_cents, description)
        VALUES (?, 1, (SELECT id FROM trust_chart_of_accounts WHERE account_code = '1000'), '1000', ?, 0, ?)
      `).run(entryId, transfer.amount_cents, `Refund: ${transfer.transfer_number}`);

      const creditCode = transfer.payment_type === 'beneficiary_distribution' ? '5000' : '2000';
      db.prepare(`
        INSERT INTO trust_journal_lines (journal_entry_id, line_number, account_id, account_code, debit_cents, credit_cents, description)
        VALUES (?, 2, (SELECT id FROM trust_chart_of_accounts WHERE account_code = ?), ?, 0, ?, ?)
      `).run(entryId, creditCode, creditCode, transfer.amount_cents, `Return: ${reason}`);
    } catch (_) {}
  }

  // Update settlement record
  db.prepare(`
    UPDATE payment_settlements SET
      settlement_status = ?,
      return_code = ?,
      return_reason = ?,
      return_date = datetime('now'),
      last_check_at = datetime('now'),
      updated_at = datetime('now')
    WHERE transfer_id = ?
  `).run(returnCode ? 'returned' : 'failed', returnCode, reason, transferId);

  // Audit log
  try {
    db.prepare(`
      INSERT INTO banking_audit_log (event_type, entity_type, entity_id, actor, action, details, created_at)
      VALUES ('payment_failed', 'external_transfer', ?, 'system', ?, ?, datetime('now'))
    `).run(String(transferId), returnCode ? 'ach_return' : 'payment_failed', JSON.stringify({
      return_code: returnCode,
      reason,
      refunded: shouldRefund,
      amount_cents: transfer.amount_cents,
    }));
  } catch (_) {}

  return {
    status: newStatus,
    transfer_number: transfer.transfer_number,
    return_code: returnCode,
    reason,
    refunded: shouldRefund,
    recommended_action: returnInfo ? returnInfo.action : 'review',
    amount_refunded_cents: shouldRefund ? transfer.total_cents : 0,
  };
}

/**
 * Check and auto-advance payments that have passed their settlement window
 * Call this periodically (e.g., every hour or on app startup)
 */
function checkSettlements(db) {
  initSettlementSchema(db);

  const results = { cleared: [], still_pending: [] };

  // Find payments past their expected clear date that haven't been updated
  const pending = db.prepare(`
    SELECT ps.*, et.status as transfer_status, et.payment_method
    FROM payment_settlements ps
    JOIN external_transfers et ON ps.transfer_id = et.id
    WHERE ps.settlement_status = 'in_transit'
      AND ps.expected_clear_date <= datetime('now')
      AND et.status IN ('processing', 'sent')
  `).all();

  for (const settlement of pending) {
    // Auto-clear: if past expected clear date with no return, assume cleared
    // (In production, this would check the bank's return file or API)
    try {
      const result = clearPayment(db, settlement.transfer_id, {
        bank_reference: `AUTO-CLR-${settlement.submission_reference}`,
        confirmation_number: settlement.submission_reference,
      });
      results.cleared.push(result);
    } catch (err) {
      results.still_pending.push({
        transfer_id: settlement.transfer_id,
        transfer_number: settlement.transfer_number,
        error: err.message,
      });
    }
  }

  return results;
}

/**
 * Get settlement status for a transfer
 */
function getSettlementStatus(db, transferId) {
  initSettlementSchema(db);

  const settlement = db.prepare(`
    SELECT * FROM payment_settlements WHERE transfer_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(transferId);

  if (!settlement) return null;

  // Calculate progress
  const now = new Date();
  const submitted = new Date(settlement.submitted_at);
  const expected = new Date(settlement.expected_clear_date);
  const totalMs = expected - submitted;
  const elapsedMs = now - submitted;
  const progress = Math.min(100, Math.max(0, Math.round((elapsedMs / totalMs) * 100)));

  return {
    ...settlement,
    progress_percent: progress,
    is_overdue: now > expected && settlement.settlement_status === 'in_transit',
    time_remaining_hours: Math.max(0, Math.round((expected - now) / (1000 * 60 * 60) * 10) / 10),
  };
}

/**
 * Get all pending settlements (for dashboard/monitoring)
 */
function getPendingSettlements(db) {
  initSettlementSchema(db);

  return db.prepare(`
    SELECT ps.*, et.amount_cents, et.payment_method, et.contact_id, et.status as transfer_status,
           c.display_name as recipient_name
    FROM payment_settlements ps
    JOIN external_transfers et ON ps.transfer_id = et.id
    LEFT JOIN crm_contacts c ON et.contact_id = c.id
    WHERE ps.settlement_status IN ('pending', 'in_transit')
    ORDER BY ps.expected_clear_date ASC
  `).all();
}

module.exports = {
  ACH_RETURN_CODES,
  SETTLEMENT_WINDOWS,
  initSettlementSchema,
  calculateExpectedClearDate,
  createSettlementRecord,
  clearPayment,
  failPayment,
  checkSettlements,
  getSettlementStatus,
  getPendingSettlements,
};
