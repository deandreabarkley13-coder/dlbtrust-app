'use strict';

/**
 * Bookkeeping Agent — Automated Trust Bookkeeping & Payments
 *
 * Full trust company bookkeeping automation:
 *  - Transaction reversals & adjustments: reverse duplicates, post corrections
 *  - Duplicate detection: identify double-posted transactions
 *  - Payment reconciliation: match ACH/wire/BILL settlements to GL entries
 *  - Journal entry automation: auto-posts entries for accruals, payments, fees
 *  - Payment processing: approve, execute, and track vendor payments
 *  - BILL Cash reconciliation: match deposits to journal entries
 *  - Financial reporting: balance sheet, income statement, trial balance
 *  - Period management: monthly close, year-end procedures
 *  - Anomaly detection: flags unusual transactions, imbalances
 *
 * Integrates with: TrustAccountingEngine, BondEngine, ACHEngine,
 *                  WireEngine, CouponService, Fineract, BILL, VendorEngine
 */

const pool = require('../bonds/pgPool');
const { VendorEngine } = require('../vendors/vendorEngine');

class BookkeepingAgent {

  // ─── Table Setup ──────────────────────────────────────────────────────────

  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bookkeeping_tasks (
        id                SERIAL PRIMARY KEY,
        task_id           TEXT UNIQUE NOT NULL,
        task_type         TEXT NOT NULL,
        category          TEXT NOT NULL DEFAULT 'general',
        title             TEXT NOT NULL,
        description       TEXT,
        status            TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','in_progress','completed','failed','skipped')),
        priority          TEXT NOT NULL DEFAULT 'normal'
                            CHECK (priority IN ('low','normal','high','critical')),
        scheduled_date    DATE,
        completed_date    TIMESTAMPTZ,
        result            JSONB,
        created_by        TEXT DEFAULT 'bookkeeping_agent',
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bookkeeping_reconciliations (
        id                SERIAL PRIMARY KEY,
        recon_id          TEXT UNIQUE NOT NULL,
        recon_type        TEXT NOT NULL,
        recon_date        DATE NOT NULL DEFAULT CURRENT_DATE,
        items_matched     INTEGER DEFAULT 0,
        items_unmatched   INTEGER DEFAULT 0,
        total_matched     NUMERIC(18,2) DEFAULT 0,
        total_unmatched   NUMERIC(18,2) DEFAULT 0,
        details           JSONB,
        status            TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','final','reviewed')),
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bookkeeping_adjustments (
        id                SERIAL PRIMARY KEY,
        adjustment_id     TEXT UNIQUE NOT NULL,
        adjustment_type   TEXT NOT NULL
                            CHECK (adjustment_type IN ('reversal','correction','reclassification','write_off','accrual')),
        original_entry_id TEXT,
        correcting_entry_id TEXT,
        amount            NUMERIC(18,2) NOT NULL,
        reason            TEXT NOT NULL,
        approved_by       TEXT,
        approved_at       TIMESTAMPTZ,
        status            TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','approved','posted','rejected')),
        created_by        TEXT DEFAULT 'bookkeeping_agent',
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TRANSACTION REVERSALS & ADJUSTMENTS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Reverse a journal entry by ID — posts a mirror entry and marks original as reversed.
   */
  static async reverseTransaction(entryId, { reason, approvedBy } = {}) {
    var { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');

    var original = await TrustAccountingEngine.getJournalEntry(entryId);
    if (!original) throw new Error('Journal entry not found: ' + entryId);
    if (original.status === 'reversed') throw new Error('Entry already reversed: ' + entryId);

    var reversal = await TrustAccountingEngine.reverseJournalEntry(entryId, {
      postedBy: 'bookkeeping_agent',
    });

    var adjId = 'ADJ-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    var amount = 0;
    if (original.lines && original.lines.length > 0) {
      amount = original.lines.reduce(function(sum, l) {
        return sum + parseFloat(l.debit_amount || 0);
      }, 0);
    }

    await pool.query(
      `INSERT INTO bookkeeping_adjustments
         (adjustment_id, adjustment_type, original_entry_id, correcting_entry_id, amount, reason, approved_by, approved_at, status)
       VALUES ($1, 'reversal', $2, $3, $4, $5, $6, NOW(), 'posted')`,
      [adjId, entryId, reversal.entry_id, amount, reason || 'Transaction reversal', approvedBy || 'bookkeeping_agent']
    );

    return {
      success: true,
      adjustmentId: adjId,
      originalEntryId: entryId,
      reversalEntryId: reversal.entry_id,
      amount: amount,
      reason: reason || 'Transaction reversal',
      status: 'posted',
    };
  }

  /**
   * Post an adjusting/correcting journal entry.
   */
  static async postAdjustment({ description, lines, reason, adjustmentType, originalEntryId, approvedBy }) {
    if (!lines || lines.length < 2) throw new Error('Adjustment requires at least 2 lines');
    if (!reason) throw new Error('Reason is required for adjustments');

    var { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');

    var entry = await TrustAccountingEngine.postJournalEntry({
      entryDate: new Date(),
      description: '[ADJUSTMENT] ' + (description || reason),
      lines: lines,
      referenceType: 'adjustment',
      referenceId: originalEntryId || 'manual',
      postedBy: 'bookkeeping_agent',
    });

    var adjId = 'ADJ-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    var amount = lines.reduce(function(sum, l) { return sum + (parseFloat(l.debitAmount) || 0); }, 0);

    await pool.query(
      `INSERT INTO bookkeeping_adjustments
         (adjustment_id, adjustment_type, original_entry_id, correcting_entry_id, amount, reason, approved_by, approved_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), 'posted')`,
      [adjId, adjustmentType || 'correction', originalEntryId || null, entry.entry_id, amount, reason, approvedBy || 'bookkeeping_agent']
    );

    return {
      success: true,
      adjustmentId: adjId,
      entryId: entry.entry_id,
      amount: amount,
      type: adjustmentType || 'correction',
      reason: reason,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DUPLICATE DETECTION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Scan for duplicate transactions — same amount and similar description within a time window.
   */
  static async detectDuplicates({ amount, windowHours, minAmount } = {}) {
    var threshold = parseFloat(minAmount) || 1000;
    var hours = parseInt(windowHours) || 24;
    var duplicates = [];

    try {
      // Find journal lines with matching amounts posted within the time window
      var query = `
        SELECT jl.entry_id, jl.account_code, jl.debit_amount, jl.credit_amount,
               je.description, je.entry_date, je.created_at, je.status, je.reference_type
        FROM trust_journal_lines jl
        JOIN trust_journal_entries je ON je.entry_id = jl.entry_id
        WHERE je.status = 'posted'
          AND (jl.debit_amount >= $1 OR jl.credit_amount >= $1)
        ORDER BY jl.debit_amount DESC, je.created_at DESC
        LIMIT 200
      `;

      var params = [threshold];
      if (amount) {
        query = `
          SELECT jl.entry_id, jl.account_code, jl.debit_amount, jl.credit_amount,
                 je.description, je.entry_date, je.created_at, je.status, je.reference_type
          FROM trust_journal_lines jl
          JOIN trust_journal_entries je ON je.entry_id = jl.entry_id
          WHERE je.status = 'posted'
            AND (ABS(jl.debit_amount - $1) < 0.01 OR ABS(jl.credit_amount - $1) < 0.01)
          ORDER BY je.created_at DESC
          LIMIT 50
        `;
        params = [parseFloat(amount)];
      }

      var result = await pool.query(query, params);

      // Group by amount to find duplicates
      var amountGroups = {};
      for (var i = 0; i < result.rows.length; i++) {
        var row = result.rows[i];
        var amt = Math.max(parseFloat(row.debit_amount), parseFloat(row.credit_amount));
        var key = amt.toFixed(2);
        if (!amountGroups[key]) amountGroups[key] = [];
        amountGroups[key].push(row);
      }

      // Any amount appearing more than once is a potential duplicate
      for (var k in amountGroups) {
        if (amountGroups[k].length > 1) {
          var entries = amountGroups[k];
          // Check time proximity
          for (var a = 0; a < entries.length - 1; a++) {
            for (var b = a + 1; b < entries.length; b++) {
              var t1 = new Date(entries[a].created_at).getTime();
              var t2 = new Date(entries[b].created_at).getTime();
              var hoursDiff = Math.abs(t1 - t2) / (1000 * 60 * 60);
              if (hoursDiff <= hours) {
                duplicates.push({
                  amount: parseFloat(k),
                  entry1: { entryId: entries[a].entry_id, description: entries[a].description, date: entries[a].created_at, account: entries[a].account_code },
                  entry2: { entryId: entries[b].entry_id, description: entries[b].description, date: entries[b].created_at, account: entries[b].account_code },
                  hoursBetween: Math.round(hoursDiff * 10) / 10,
                  confidence: hoursDiff < 1 ? 'high' : hoursDiff < 6 ? 'medium' : 'low',
                });
              }
            }
          }
        }
      }
    } catch (e) {
      // Tables may not exist yet
    }

    return {
      scanned: new Date().toISOString(),
      threshold: threshold,
      windowHours: hours,
      duplicatesFound: duplicates.length,
      duplicates: duplicates.sort(function(a, b) { return b.amount - a.amount; }),
    };
  }

  /**
   * Find and reverse a specific duplicate by amount.
   */
  static async reverseDuplicate(amount, { reason, keepEntryId } = {}) {
    var scan = await BookkeepingAgent.detectDuplicates({ amount: amount, windowHours: 168 });
    if (scan.duplicatesFound === 0) {
      throw new Error('No duplicate found for amount $' + parseFloat(amount).toLocaleString());
    }

    var dup = scan.duplicates[0];
    // Reverse the second entry (keep the first) unless specified
    var entryToReverse = keepEntryId ? (dup.entry1.entryId === keepEntryId ? dup.entry2.entryId : dup.entry1.entryId) : dup.entry2.entryId;

    var result = await BookkeepingAgent.reverseTransaction(entryToReverse, {
      reason: reason || 'Duplicate transaction reversal ($' + parseFloat(amount).toLocaleString() + ')',
      approvedBy: 'bookkeeping_agent',
    });

    return {
      ...result,
      duplicateInfo: dup,
      reversedEntry: entryToReverse,
      keptEntry: keepEntryId || dup.entry1.entryId,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAYMENT PROCESSING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Process a vendor payment end-to-end: validate → approve → execute → record JE.
   */
  static async processVendorPayment(paymentId) {
    var payment = await pool.query(
      'SELECT * FROM vendor_payments WHERE payment_id = $1',
      [paymentId]
    );
    if (payment.rows.length === 0) throw new Error('Payment not found: ' + paymentId);

    var current = payment.rows[0];
    if (current.status === 'settled') {
      return { paymentId: paymentId, status: 'already_settled' };
    }
    if (current.status !== 'approved') {
      throw new Error('Vendor payment must be approved before execution');
    }

    var execution = await VendorEngine.executePayment(paymentId, 'bookkeeping_agent');
    return {
      paymentId: paymentId,
      status: execution.status,
      accounting_status: 'pending_settlement',
      payment_intent_id: execution.payment_intent_id || null,
      ach_batch_id: execution.ach_batch_id || null,
      wire_id: execution.wire_id || null,
      bill_payment_id: execution.bill_payment_id || null,
      steps: [
        { step: 'validate', status: 'ok' },
        { step: 'canonical_payment_execution', status: 'ok' },
        { step: 'journal_entry', status: 'pending_settlement' },
      ],
    };
  }

  /**
   * Approve a pending vendor payment.
   */
  static async approvePayment(paymentId, { approvedBy } = {}) {
    var result = await pool.query(
      `UPDATE vendor_payments SET status = 'approved', approved_by = $1, approved_at = NOW(), updated_at = NOW()
       WHERE payment_id = $2 AND status = 'pending_approval'
       RETURNING *`,
      [approvedBy || 'bookkeeping_agent', paymentId]
    );
    if (result.rows.length === 0) throw new Error('Payment not found or not pending: ' + paymentId);
    return { success: true, payment: result.rows[0] };
  }

  /**
   * Reject a vendor payment.
   */
  static async rejectPayment(paymentId, { rejectedBy, reason } = {}) {
    var result = await pool.query(
      `UPDATE vendor_payments SET status = 'rejected', updated_at = NOW()
       WHERE payment_id = $1 AND status IN ('pending_approval','approved')
       RETURNING *`,
      [paymentId]
    );
    if (result.rows.length === 0) throw new Error('Payment not found or already processed: ' + paymentId);
    return { success: true, payment: result.rows[0], reason: reason };
  }

  /**
   * Get pending payments awaiting approval.
   */
  static async getPendingPayments() {
    var result = await pool.query(
      `SELECT vp.*, v.vendor_name
       FROM vendor_payments vp
       LEFT JOIN vendors v ON v.vendor_id = vp.vendor_id
       WHERE vp.status = 'pending_approval'
       ORDER BY vp.created_at ASC`
    );
    return result.rows;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BILL CASH RECONCILIATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Reconcile BILL Cash deposits with journal entries.
   */
  static async reconcileBILLCash() {
    var matched = [];
    var unmatched = [];

    try {
      // Get all BILL-related journal entries
      var billJE = await pool.query(
        `SELECT je.entry_id, je.description, je.created_at, je.reference_id,
                COALESCE(SUM(jl.debit_amount), 0) as total_debit
         FROM trust_journal_entries je
         LEFT JOIN trust_journal_lines jl ON jl.entry_id = je.entry_id
         WHERE je.reference_type IN ('bill_deposit','ach_batch','wire')
           AND je.status = 'posted'
         GROUP BY je.entry_id, je.description, je.created_at, je.reference_id
         ORDER BY je.created_at DESC LIMIT 100`
      );

      // Get BILL deposits from settlement tracking
      var settlements = await pool.query(
        `SELECT * FROM bill_settlements ORDER BY created_at DESC LIMIT 100`
      );

      // Match settlements to journal entries
      var jeByRef = {};
      for (var i = 0; i < billJE.rows.length; i++) {
        jeByRef[billJE.rows[i].reference_id] = billJE.rows[i];
      }

      for (var j = 0; j < settlements.rows.length; j++) {
        var s = settlements.rows[j];
        if (jeByRef[s.deposit_ref]) {
          matched.push({
            settlementId: s.settlement_id,
            depositRef: s.deposit_ref,
            amount: parseFloat(s.amount),
            journalEntryId: jeByRef[s.deposit_ref].entry_id,
            status: 'reconciled',
          });
        } else {
          unmatched.push({
            settlementId: s.settlement_id,
            depositRef: s.deposit_ref,
            amount: parseFloat(s.amount),
            method: s.deposit_method,
            date: s.created_at,
            status: s.status,
          });
        }
      }
    } catch (e) { /* tables may not exist */ }

    var reconId = 'RCN-BILL-' + Date.now();
    var totalMatched = matched.reduce(function(s, m) { return s + m.amount; }, 0);
    var totalUnmatched = unmatched.reduce(function(s, u) { return s + u.amount; }, 0);

    try {
      await pool.query(
        `INSERT INTO bookkeeping_reconciliations
           (recon_id, recon_type, items_matched, items_unmatched, total_matched, total_unmatched, details, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'final')`,
        [reconId, 'bill_cash_reconciliation', matched.length, unmatched.length,
         totalMatched, totalUnmatched,
         JSON.stringify({ matched: matched, unmatched: unmatched })]
      );
    } catch (e) { /* ignore if table doesn't exist */ }

    return {
      reconId: reconId,
      type: 'bill_cash',
      date: new Date().toISOString().split('T')[0],
      matched: matched.length,
      unmatched: unmatched.length,
      totalMatched: Math.round(totalMatched * 100) / 100,
      totalUnmatched: Math.round(totalUnmatched * 100) / 100,
      unmatchedItems: unmatched,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAYMENT RECONCILIATION (ACH & WIRE)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Reconcile ACH batches: match settled batches to journal entries.
   */
  static async reconcileACH() {
    var matched = [];
    var unmatched = [];

    try {
      var batches = await pool.query(
        `SELECT b.batch_id, b.status, b.total_amount_cents, b.created_at,
                b.entry_description, b.sec_code
         FROM ach_batches b
         WHERE b.status IN ('settled','transmitted','submitted')
         ORDER BY b.created_at DESC LIMIT 50`
      );

      for (var i = 0; i < batches.rows.length; i++) {
        var batch = batches.rows[i];
        var je = await pool.query(
          `SELECT entry_id FROM trust_journal_entries
           WHERE reference_type = 'ach_batch' AND reference_id = $1`,
          [batch.batch_id]
        );

        if (je.rows.length > 0) {
          matched.push({
            batchId: batch.batch_id,
            amount: (batch.total_amount_cents || 0) / 100,
            journalEntryId: je.rows[0].entry_id,
            status: 'reconciled',
          });
        } else {
          unmatched.push({
            batchId: batch.batch_id,
            amount: (batch.total_amount_cents || 0) / 100,
            date: batch.created_at,
            description: batch.entry_description,
            status: batch.status,
          });
        }
      }
    } catch (e) { /* ACH tables may not exist */ }

    var reconId = 'RCN-ACH-' + Date.now();
    var totalMatched = matched.reduce(function(s, m) { return s + m.amount; }, 0);
    var totalUnmatched = unmatched.reduce(function(s, u) { return s + u.amount; }, 0);

    await pool.query(
      `INSERT INTO bookkeeping_reconciliations
         (recon_id, recon_type, items_matched, items_unmatched, total_matched, total_unmatched, details, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'final')`,
      [reconId, 'ach_reconciliation', matched.length, unmatched.length,
       totalMatched, totalUnmatched,
       JSON.stringify({ matched: matched, unmatched: unmatched })]
    );

    return {
      reconId: reconId,
      type: 'ach',
      date: new Date().toISOString().split('T')[0],
      matched: matched.length,
      unmatched: unmatched.length,
      totalMatched: Math.round(totalMatched * 100) / 100,
      totalUnmatched: Math.round(totalUnmatched * 100) / 100,
      unmatchedItems: unmatched,
    };
  }

  /**
   * Reconcile wire transfers: match settled wires to journal entries.
   */
  static async reconcileWires() {
    var matched = [];
    var unmatched = [];

    try {
      var wires = await pool.query(
        `SELECT wire_id, status, amount_cents, beneficiary_name,
                description, created_at
         FROM wire_transfers
         WHERE status IN ('sent','settled','completed')
         ORDER BY created_at DESC LIMIT 50`
      );

      for (var i = 0; i < wires.rows.length; i++) {
        var wire = wires.rows[i];
        var je = await pool.query(
          `SELECT entry_id FROM trust_journal_entries
           WHERE reference_type = 'wire' AND reference_id = $1`,
          [wire.wire_id]
        );

        if (je.rows.length > 0) {
          matched.push({
            wireId: wire.wire_id,
            amount: (wire.amount_cents || 0) / 100,
            journalEntryId: je.rows[0].entry_id,
          });
        } else {
          unmatched.push({
            wireId: wire.wire_id,
            amount: (wire.amount_cents || 0) / 100,
            beneficiary: wire.beneficiary_name,
            date: wire.created_at,
            description: wire.description,
          });
        }
      }
    } catch (e) { /* wire table may not exist */ }

    var totalMatched = matched.reduce(function(s, m) { return s + m.amount; }, 0);
    var totalUnmatched = unmatched.reduce(function(s, u) { return s + u.amount; }, 0);

    var reconId = 'RCN-WIRE-' + Date.now();
    await pool.query(
      `INSERT INTO bookkeeping_reconciliations
         (recon_id, recon_type, items_matched, items_unmatched, total_matched, total_unmatched, details, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'final')`,
      [reconId, 'wire_reconciliation', matched.length, unmatched.length,
       totalMatched, totalUnmatched,
       JSON.stringify({ matched: matched, unmatched: unmatched })]
    );

    return {
      reconId: reconId,
      type: 'wire',
      date: new Date().toISOString().split('T')[0],
      matched: matched.length,
      unmatched: unmatched.length,
      totalMatched: Math.round(totalMatched * 100) / 100,
      totalUnmatched: Math.round(totalUnmatched * 100) / 100,
      unmatchedItems: unmatched,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTOMATED JOURNAL ENTRIES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Post a journal entry for an ACH batch that hasn't been recorded yet.
   */
  static async postACHJournalEntry(batchId) {
    var batch = await pool.query(
      `SELECT * FROM ach_batches WHERE batch_id = $1`, [batchId]
    );
    if (batch.rows.length === 0) throw new Error('ACH batch not found: ' + batchId);

    var b = batch.rows[0];
    var amount = (b.total_amount_cents || 0) / 100;
    if (amount <= 0) throw new Error('Batch amount is zero');

    var existing = await pool.query(
      `SELECT entry_id FROM trust_journal_entries
       WHERE reference_type = 'ach_batch' AND reference_id = $1`,
      [batchId]
    );
    if (existing.rows.length > 0) {
      return { alreadyPosted: true, entryId: existing.rows[0].entry_id };
    }

    var { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');
    var entry = await TrustAccountingEngine.postJournalEntry({
      entryDate: b.created_at || new Date(),
      description: 'ACH disbursement: ' + (b.entry_description || batchId),
      lines: [
        { accountCode: '5000', debitAmount: amount, creditAmount: 0, memo: 'ACH payment ' + batchId },
        { accountCode: '1000', debitAmount: 0, creditAmount: amount, memo: 'Cash disbursed via ACH' },
      ],
      referenceType: 'ach_batch',
      referenceId: batchId,
      postedBy: 'bookkeeping_agent',
    });

    return { alreadyPosted: false, entryId: entry.entry_id, amount: amount };
  }

  /**
   * Post a journal entry for a wire transfer.
   */
  static async postWireJournalEntry(wireId) {
    var wire = await pool.query(
      `SELECT * FROM wire_transfers WHERE wire_id = $1`, [wireId]
    );
    if (wire.rows.length === 0) throw new Error('Wire transfer not found: ' + wireId);

    var w = wire.rows[0];
    var amount = (w.amount_cents || 0) / 100;
    if (amount <= 0) throw new Error('Wire amount is zero');

    var existing = await pool.query(
      `SELECT entry_id FROM trust_journal_entries
       WHERE reference_type = 'wire' AND reference_id = $1`,
      [wireId]
    );
    if (existing.rows.length > 0) {
      return { alreadyPosted: true, entryId: existing.rows[0].entry_id };
    }

    var { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');
    var entry = await TrustAccountingEngine.postJournalEntry({
      entryDate: w.created_at || new Date(),
      description: 'Wire transfer to ' + (w.beneficiary_name || 'beneficiary') + ': ' + (w.description || wireId),
      lines: [
        { accountCode: '5000', debitAmount: amount, creditAmount: 0, memo: 'Wire payment ' + wireId },
        { accountCode: '1000', debitAmount: 0, creditAmount: amount, memo: 'Cash disbursed via wire' },
      ],
      referenceType: 'wire',
      referenceId: wireId,
      postedBy: 'bookkeeping_agent',
    });

    return { alreadyPosted: false, entryId: entry.entry_id, amount: amount };
  }

  /**
   * Auto-post journal entries for all unreconciled settled payments.
   */
  static async autoPostUnreconciled() {
    var results = { ach: [], wire: [], bill: [], errors: [] };

    // ACH batches
    try {
      var achRecon = await BookkeepingAgent.reconcileACH();
      for (var i = 0; i < achRecon.unmatchedItems.length; i++) {
        var item = achRecon.unmatchedItems[i];
        try {
          var posted = await BookkeepingAgent.postACHJournalEntry(item.batchId);
          results.ach.push({ batchId: item.batchId, entryId: posted.entryId, amount: item.amount });
        } catch (e) {
          results.errors.push({ type: 'ach', id: item.batchId, error: e.message });
        }
      }
    } catch (e) {
      results.errors.push({ type: 'ach_recon', error: e.message });
    }

    // Wire transfers
    try {
      var wireRecon = await BookkeepingAgent.reconcileWires();
      for (var j = 0; j < wireRecon.unmatchedItems.length; j++) {
        var wItem = wireRecon.unmatchedItems[j];
        try {
          var wPosted = await BookkeepingAgent.postWireJournalEntry(wItem.wireId);
          results.wire.push({ wireId: wItem.wireId, entryId: wPosted.entryId, amount: wItem.amount });
        } catch (e) {
          results.errors.push({ type: 'wire', id: wItem.wireId, error: e.message });
        }
      }
    } catch (e) {
      results.errors.push({ type: 'wire_recon', error: e.message });
    }

    // BILL Cash
    try {
      var billRecon = await BookkeepingAgent.reconcileBILLCash();
      results.bill.push({ reconId: billRecon.reconId, matched: billRecon.matched, unmatched: billRecon.unmatched });
    } catch (e) {
      results.errors.push({ type: 'bill_recon', error: e.message });
    }

    return {
      date: new Date().toISOString().split('T')[0],
      achPosted: results.ach.length,
      wirePosted: results.wire.length,
      billReconciled: results.bill.length > 0 ? results.bill[0].matched : 0,
      errors: results.errors.length,
      details: results,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FINANCIAL REPORTING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Generate a comprehensive financial summary for the trust.
   */
  static async generateFinancialSummary() {
    var { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');
    var summary = {};

    try {
      summary.trialBalance = await TrustAccountingEngine.getTrialBalance();
    } catch (e) {
      summary.trialBalance = { error: e.message };
    }

    try {
      summary.balanceSheet = await TrustAccountingEngine.getBalanceSheet();
    } catch (e) {
      summary.balanceSheet = { error: e.message };
    }

    try {
      summary.incomeStatement = await TrustAccountingEngine.getIncomeStatement();
    } catch (e) {
      summary.incomeStatement = { error: e.message };
    }

    // Recent journal entries
    try {
      var recent = await pool.query(
        `SELECT entry_id, entry_date, description, status, created_at
         FROM trust_journal_entries
         WHERE status = 'posted'
         ORDER BY created_at DESC LIMIT 10`
      );
      summary.recentEntries = recent.rows;
    } catch (e) {
      summary.recentEntries = [];
    }

    // Payment totals
    try {
      var achTotal = await pool.query(
        `SELECT COUNT(*) as c, COALESCE(SUM(total_amount_cents),0) as total
         FROM ach_batches WHERE created_at >= NOW() - INTERVAL '30 days'`
      );
      summary.achLast30Days = {
        count: parseInt(achTotal.rows[0].c),
        total: parseInt(achTotal.rows[0].total) / 100,
      };
    } catch (e) {}

    try {
      var wireTotal = await pool.query(
        `SELECT COUNT(*) as c, COALESCE(SUM(amount_cents),0) as total
         FROM wire_transfers WHERE created_at >= NOW() - INTERVAL '30 days'`
      );
      summary.wiresLast30Days = {
        count: parseInt(wireTotal.rows[0].c),
        total: parseInt(wireTotal.rows[0].total) / 100,
      };
    } catch (e) {}

    // Vendor payments
    try {
      var vpTotal = await pool.query(
        `SELECT COUNT(*) as c, COALESCE(SUM(amount),0) as total, status
         FROM vendor_payments
         WHERE created_at >= NOW() - INTERVAL '30 days'
         GROUP BY status`
      );
      summary.vendorPaymentsLast30Days = vpTotal.rows.map(function(r) {
        return { status: r.status, count: parseInt(r.c), total: parseFloat(r.total) };
      });
    } catch (e) {}

    return {
      generatedAt: new Date().toISOString(),
      summary: summary,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ANOMALY DETECTION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Scan for bookkeeping anomalies: large transactions, imbalances, duplicates, gaps.
   */
  static async detectAnomalies() {
    var anomalies = [];

    // 1. Reversed entries that haven't been re-posted
    try {
      var reversed = await pool.query(
        `SELECT entry_id, description, entry_date
         FROM trust_journal_entries
         WHERE status = 'reversed'
         AND entry_id NOT IN (
           SELECT COALESCE(reversal_of, '') FROM trust_journal_entries
           WHERE reversal_of IS NOT NULL
         )
         ORDER BY entry_date DESC LIMIT 10`
      );
      if (reversed.rows.length > 0) {
        anomalies.push({
          type: 'orphaned_reversals',
          severity: 'normal',
          count: reversed.rows.length,
          detail: reversed.rows.length + ' reversed entry(ies) without correcting replacement',
          items: reversed.rows.map(function(r) { return r.entry_id; }),
        });
      }
    } catch (e) {}

    // 2. Large individual transactions (> $1M)
    try {
      var large = await pool.query(
        `SELECT jl.entry_id, jl.account_code, jl.debit_amount, jl.credit_amount,
                je.description, je.entry_date
         FROM trust_journal_lines jl
         JOIN trust_journal_entries je ON je.entry_id = jl.entry_id
         WHERE je.status = 'posted'
           AND (jl.debit_amount > 1000000 OR jl.credit_amount > 1000000)
         ORDER BY je.entry_date DESC LIMIT 10`
      );
      if (large.rows.length > 0) {
        anomalies.push({
          type: 'large_transactions',
          severity: 'low',
          count: large.rows.length,
          detail: large.rows.length + ' transaction line(s) exceed $1,000,000',
          items: large.rows.map(function(r) {
            return {
              entryId: r.entry_id,
              account: r.account_code,
              amount: Math.max(parseFloat(r.debit_amount), parseFloat(r.credit_amount)),
              description: r.description,
            };
          }),
        });
      }
    } catch (e) {}

    // 3. Account balance checks — negative asset balances
    try {
      var negative = await pool.query(
        `SELECT account_code, account_name, balance
         FROM trust_accounts
         WHERE account_type = 'asset' AND balance < 0 AND is_active = TRUE`
      );
      if (negative.rows.length > 0) {
        anomalies.push({
          type: 'negative_asset_balance',
          severity: 'high',
          count: negative.rows.length,
          detail: negative.rows.length + ' asset account(s) have negative balances',
          items: negative.rows.map(function(r) {
            return { account: r.account_code, name: r.account_name, balance: parseFloat(r.balance) };
          }),
        });
      }
    } catch (e) {}

    // 4. Stale pending payments (> 7 days old)
    try {
      var stale = await pool.query(
        `SELECT batch_id, status, total_amount_cents, created_at
         FROM ach_batches
         WHERE status IN ('pending','created')
           AND created_at < NOW() - INTERVAL '7 days'
         ORDER BY created_at ASC LIMIT 10`
      );
      if (stale.rows.length > 0) {
        anomalies.push({
          type: 'stale_payments',
          severity: 'normal',
          count: stale.rows.length,
          detail: stale.rows.length + ' ACH batch(es) pending for more than 7 days',
          items: stale.rows.map(function(r) {
            return { batchId: r.batch_id, amount: (r.total_amount_cents || 0) / 100, date: r.created_at };
          }),
        });
      }
    } catch (e) {}

    // 5. Potential duplicates (amount-based scan)
    try {
      var dupScan = await BookkeepingAgent.detectDuplicates({ windowHours: 48, minAmount: 10000 });
      if (dupScan.duplicatesFound > 0) {
        anomalies.push({
          type: 'potential_duplicates',
          severity: 'high',
          count: dupScan.duplicatesFound,
          detail: dupScan.duplicatesFound + ' potential duplicate transaction(s) detected',
          items: dupScan.duplicates.slice(0, 5).map(function(d) {
            return { amount: d.amount, entry1: d.entry1.entryId, entry2: d.entry2.entryId, confidence: d.confidence };
          }),
        });
      }
    } catch (e) {}

    // 6. Unreconciled BILL deposits
    try {
      var billRecon = await BookkeepingAgent.reconcileBILLCash();
      if (billRecon.unmatched > 0) {
        anomalies.push({
          type: 'unreconciled_bill_deposits',
          severity: 'normal',
          count: billRecon.unmatched,
          detail: billRecon.unmatched + ' BILL Cash deposit(s) without matching journal entries',
          items: billRecon.unmatchedItems.slice(0, 5),
        });
      }
    } catch (e) {}

    return {
      date: new Date().toISOString().split('T')[0],
      anomalyCount: anomalies.length,
      anomalies: anomalies,
      highSeverity: anomalies.filter(function(a) { return a.severity === 'high' || a.severity === 'critical'; }).length,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MONTHLY CLOSE & PERIOD MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Run monthly close procedures: reconcile all, post accruals, generate reports.
   */
  static async monthlyClose({ periodName, closedBy } = {}) {
    var results = { steps: [], success: true };
    var today = new Date();
    var month = today.toISOString().slice(0, 7);
    var pName = periodName || month;

    // Step 1: Reconcile all payment channels
    try {
      var achRecon = await BookkeepingAgent.reconcileACH();
      results.steps.push({ step: 'reconcile_ach', status: 'ok', matched: achRecon.matched, unmatched: achRecon.unmatched });
    } catch (e) {
      results.steps.push({ step: 'reconcile_ach', status: 'skipped', error: e.message });
    }

    try {
      var wireRecon = await BookkeepingAgent.reconcileWires();
      results.steps.push({ step: 'reconcile_wires', status: 'ok', matched: wireRecon.matched, unmatched: wireRecon.unmatched });
    } catch (e) {
      results.steps.push({ step: 'reconcile_wires', status: 'skipped', error: e.message });
    }

    try {
      var billRecon = await BookkeepingAgent.reconcileBILLCash();
      results.steps.push({ step: 'reconcile_bill', status: 'ok', matched: billRecon.matched, unmatched: billRecon.unmatched });
    } catch (e) {
      results.steps.push({ step: 'reconcile_bill', status: 'skipped', error: e.message });
    }

    // Step 2: Auto-post unreconciled entries
    try {
      var autoPost = await BookkeepingAgent.autoPostUnreconciled();
      results.steps.push({ step: 'auto_post', status: 'ok', achPosted: autoPost.achPosted, wirePosted: autoPost.wirePosted });
    } catch (e) {
      results.steps.push({ step: 'auto_post', status: 'failed', error: e.message });
    }

    // Step 3: Run anomaly detection
    try {
      var anomalies = await BookkeepingAgent.detectAnomalies();
      results.steps.push({ step: 'anomaly_scan', status: 'ok', anomalies: anomalies.anomalyCount, highSeverity: anomalies.highSeverity });
      if (anomalies.highSeverity > 0) results.success = false;
    } catch (e) {
      results.steps.push({ step: 'anomaly_scan', status: 'failed', error: e.message });
    }

    // Step 4: Generate financial reports
    try {
      var summary = await BookkeepingAgent.generateFinancialSummary();
      results.steps.push({ step: 'financial_reports', status: 'ok' });
      results.financialSummary = summary;
    } catch (e) {
      results.steps.push({ step: 'financial_reports', status: 'failed', error: e.message });
    }

    // Step 5: Create period record
    try {
      var { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');
      var startDate = month + '-01';
      var endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().split('T')[0];
      await TrustAccountingEngine.createPeriod({
        periodName: pName,
        startDate: startDate,
        endDate: endDate,
      });
      results.steps.push({ step: 'create_period', status: 'ok', period: pName });
    } catch (e) {
      results.steps.push({ step: 'create_period', status: 'skipped', error: e.message });
    }

    results.period = pName;
    results.closedBy = closedBy || 'bookkeeping_agent';
    results.closedAt = new Date().toISOString();

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TASK MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Generate standard bookkeeping duties for the current period.
   */
  static async generateDuties() {
    var today = new Date();
    var dateStr = today.toISOString().split('T')[0];
    var duties = [
      {
        type: 'reconcile_ach',
        category: 'reconciliation',
        title: 'ACH Payment Reconciliation',
        description: 'Match settled ACH batches to journal entries. Auto-post entries for unreconciled payments.',
        priority: 'high',
      },
      {
        type: 'reconcile_wires',
        category: 'reconciliation',
        title: 'Wire Transfer Reconciliation',
        description: 'Match completed wire transfers to journal entries. Post entries for unreconciled wires.',
        priority: 'high',
      },
      {
        type: 'reconcile_bill',
        category: 'reconciliation',
        title: 'BILL Cash Reconciliation',
        description: 'Match BILL Cash deposits and settlements to journal entries.',
        priority: 'high',
      },
      {
        type: 'duplicate_scan',
        category: 'audit',
        title: 'Duplicate Transaction Scan',
        description: 'Scan for potential duplicate transactions by amount and timing.',
        priority: 'high',
      },
      {
        type: 'financial_summary',
        category: 'reporting',
        title: 'Financial Summary Report',
        description: 'Generate trial balance, balance sheet, and income statement for the current period.',
        priority: 'normal',
      },
      {
        type: 'anomaly_scan',
        category: 'audit',
        title: 'Anomaly Detection Scan',
        description: 'Scan for bookkeeping anomalies: negative balances, large transactions, stale payments, duplicates.',
        priority: 'normal',
      },
      {
        type: 'auto_post',
        category: 'journal',
        title: 'Auto-Post Unreconciled Payments',
        description: 'Automatically create journal entries for settled payments missing GL records.',
        priority: 'high',
      },
      {
        type: 'process_pending_payments',
        category: 'payments',
        title: 'Process Pending Vendor Payments',
        description: 'Review and process any approved vendor payments awaiting execution.',
        priority: 'high',
      },
      {
        type: 'monthly_close',
        category: 'period',
        title: 'Monthly Close Procedures',
        description: 'Run full monthly close: reconcile all channels, post accruals, generate reports.',
        priority: 'normal',
      },
    ];

    var created = [];
    for (var i = 0; i < duties.length; i++) {
      var d = duties[i];
      var taskId = 'BKP-' + dateStr.replace(/-/g, '') + '-' + d.type.toUpperCase();

      var existing = await pool.query(
        `SELECT id FROM bookkeeping_tasks WHERE task_id = $1`, [taskId]
      );
      if (existing.rows.length > 0) continue;

      await pool.query(
        `INSERT INTO bookkeeping_tasks (task_id, task_type, category, title, description, priority, scheduled_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [taskId, d.type, d.category, d.title, d.description, d.priority, dateStr]
      );
      created.push(taskId);
    }

    return { date: dateStr, generated: created.length, taskIds: created };
  }

  /**
   * Execute a bookkeeping task by ID.
   */
  static async executeTask(taskId) {
    var task = await pool.query(`SELECT * FROM bookkeeping_tasks WHERE task_id = $1`, [taskId]);
    if (task.rows.length === 0) throw new Error('Task not found: ' + taskId);

    var t = task.rows[0];
    if (t.status === 'completed') throw new Error('Task already completed');

    await pool.query(
      `UPDATE bookkeeping_tasks SET status = 'in_progress', updated_at = NOW() WHERE task_id = $1`,
      [taskId]
    );

    var result;
    try {
      switch (t.task_type) {
        case 'reconcile_ach':
          result = await BookkeepingAgent.reconcileACH();
          break;
        case 'reconcile_wires':
          result = await BookkeepingAgent.reconcileWires();
          break;
        case 'reconcile_bill':
          result = await BookkeepingAgent.reconcileBILLCash();
          break;
        case 'duplicate_scan':
          result = await BookkeepingAgent.detectDuplicates({ windowHours: 168, minAmount: 1000 });
          break;
        case 'financial_summary':
          result = await BookkeepingAgent.generateFinancialSummary();
          break;
        case 'anomaly_scan':
          result = await BookkeepingAgent.detectAnomalies();
          break;
        case 'auto_post':
          result = await BookkeepingAgent.autoPostUnreconciled();
          break;
        case 'process_pending_payments':
          result = await BookkeepingAgent.processPendingPayments();
          break;
        case 'monthly_close':
          result = await BookkeepingAgent.monthlyClose();
          break;
        default:
          result = { message: 'Manual task — mark complete when done' };
          await pool.query(
            `UPDATE bookkeeping_tasks SET status = 'pending', updated_at = NOW() WHERE task_id = $1`,
            [taskId]
          );
          return { taskId: taskId, taskType: t.task_type, status: 'pending', result: result };
      }

      await pool.query(
        `UPDATE bookkeeping_tasks SET status = 'completed', completed_date = NOW(),
         result = $1, updated_at = NOW() WHERE task_id = $2`,
        [JSON.stringify(result), taskId]
      );

      return { taskId: taskId, taskType: t.task_type, status: 'completed', result: result };
    } catch (err) {
      await pool.query(
        `UPDATE bookkeeping_tasks SET status = 'failed',
         result = $1, updated_at = NOW() WHERE task_id = $2`,
        [JSON.stringify({ error: err.message }), taskId]
      );
      throw err;
    }
  }

  /**
   * Process all approved vendor payments.
   */
  static async processPendingPayments() {
    var pending = await BookkeepingAgent.getPendingPayments();
    var results = { processed: 0, failed: 0, details: [] };

    // Also get approved payments ready for execution
    var approved;
    try {
      approved = await pool.query(
        `SELECT * FROM vendor_payments WHERE status = 'approved' ORDER BY created_at ASC`
      );
    } catch (e) {
      return { processed: 0, failed: 0, pending: pending.length, error: e.message };
    }

    for (var i = 0; i < approved.rows.length; i++) {
      var p = approved.rows[i];
      try {
        var processResult = await BookkeepingAgent.processVendorPayment(p.payment_id);
        results.processed++;
        results.details.push({ paymentId: p.payment_id, status: 'completed' });
      } catch (e) {
        results.failed++;
        results.details.push({ paymentId: p.payment_id, status: 'failed', error: e.message });
      }
    }

    results.pendingApproval = pending.length;
    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // QUERIES & DASHBOARD
  // ═══════════════════════════════════════════════════════════════════════════

  static async listTasks({ status, category, limit } = {}) {
    var conditions = [];
    var params = [];
    var idx = 1;

    if (status) { conditions.push('status = $' + idx++); params.push(status); }
    if (category) { conditions.push('category = $' + idx++); params.push(category); }

    var where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    var lim = parseInt(limit) || 50;

    var result = await pool.query(
      'SELECT * FROM bookkeeping_tasks ' + where + ' ORDER BY scheduled_date DESC, priority DESC LIMIT $' + idx,
      params.concat([lim])
    );
    return result.rows;
  }

  static async listReconciliations({ reconType, limit } = {}) {
    var conditions = [];
    var params = [];
    var idx = 1;

    if (reconType) { conditions.push('recon_type = $' + idx++); params.push(reconType); }

    var where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    var lim = parseInt(limit) || 20;

    var result = await pool.query(
      'SELECT * FROM bookkeeping_reconciliations ' + where + ' ORDER BY recon_date DESC, created_at DESC LIMIT $' + idx,
      params.concat([lim])
    );
    return result.rows;
  }

  static async listAdjustments({ status, adjustmentType, limit } = {}) {
    var conditions = [];
    var params = [];
    var idx = 1;

    if (status) { conditions.push('status = $' + idx++); params.push(status); }
    if (adjustmentType) { conditions.push('adjustment_type = $' + idx++); params.push(adjustmentType); }

    var where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    var lim = parseInt(limit) || 50;

    var result = await pool.query(
      'SELECT * FROM bookkeeping_adjustments ' + where + ' ORDER BY created_at DESC LIMIT $' + idx,
      params.concat([lim])
    );
    return result.rows;
  }

  // ─── Dashboard Summary ────────────────────────────────────────────────────

  static async getDashboard() {
    var pendingTasks = await pool.query(
      `SELECT COUNT(*) as c FROM bookkeeping_tasks WHERE status IN ('pending','in_progress')`
    );
    var completedTasks = await pool.query(
      `SELECT COUNT(*) as c FROM bookkeeping_tasks WHERE status = 'completed'
       AND completed_date >= NOW() - INTERVAL '30 days'`
    );
    var recentRecons = await pool.query(
      `SELECT recon_id, recon_type, recon_date, items_matched, items_unmatched, status
       FROM bookkeeping_reconciliations ORDER BY created_at DESC LIMIT 5`
    );

    // Journal entries last 7 days
    var recentJournals = { count: 0, total: 0 };
    try {
      var jRes = await pool.query(
        `SELECT COUNT(*) as c FROM trust_journal_entries
         WHERE status = 'posted' AND created_at >= NOW() - INTERVAL '7 days'`
      );
      recentJournals.count = parseInt(jRes.rows[0].c);
    } catch (e) {}

    // Pending payments
    var pendingPayments = 0;
    try {
      var ppRes = await pool.query(
        `SELECT COUNT(*) as c FROM vendor_payments WHERE status = 'pending_approval'`
      );
      pendingPayments = parseInt(ppRes.rows[0].c);
    } catch (e) {}

    // Recent adjustments
    var recentAdjustments = 0;
    try {
      var adjRes = await pool.query(
        `SELECT COUNT(*) as c FROM bookkeeping_adjustments WHERE created_at >= NOW() - INTERVAL '7 days'`
      );
      recentAdjustments = parseInt(adjRes.rows[0].c);
    } catch (e) {}

    return {
      pendingTasks: parseInt(pendingTasks.rows[0].c),
      completedThisMonth: parseInt(completedTasks.rows[0].c),
      recentReconciliations: recentRecons.rows,
      journalsLast7Days: recentJournals.count,
      pendingPayments: pendingPayments,
      recentAdjustments: recentAdjustments,
    };
  }
}

module.exports = { BookkeepingAgent };
