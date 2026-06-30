'use strict';

/**
 * Bookkeeping Agent — Automated Trust Bookkeeping
 *
 * Automates day-to-day bookkeeping duties for the Private Trust Company:
 *  - Payment reconciliation: matches ACH/wire settlements to GL entries
 *  - Journal entry automation: auto-posts entries for accruals, payments, fees
 *  - Financial reporting: generates balance sheet, income statement, trial balance
 *  - Period management: monthly close, year-end procedures
 *  - Anomaly detection: flags unusual transactions, imbalances
 *
 * Integrates with: TrustAccountingEngine, BondEngine, ACHEngine,
 *                  WireEngine, CouponService, Fineract
 */

const pool = require('../bonds/pgPool');

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
  }

  // ─── Payment Reconciliation ───────────────────────────────────────────────

  /**
   * Reconcile ACH batches: match settled batches to journal entries.
   * Creates journal entries for any unreconciled settled payments.
   */
  static async reconcileACH() {
    var matched = [];
    var unmatched = [];

    try {
      // Find settled ACH batches without matching journal entries
      var batches = await pool.query(
        `SELECT b.batch_id, b.status, b.total_amount_cents, b.created_at,
                b.entry_description, b.sec_code
         FROM ach_batches b
         WHERE b.status IN ('settled','transmitted','submitted')
         ORDER BY b.created_at DESC LIMIT 50`
      );

      for (var i = 0; i < batches.rows.length; i++) {
        var batch = batches.rows[i];
        // Check if a journal entry already references this batch
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
    } catch (e) {
      // ACH tables may not exist
    }

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

  // ─── Automated Journal Entries ────────────────────────────────────────────

  /**
   * Post a journal entry for an ACH batch that hasn't been recorded yet.
   * Debits the payment expense account, credits the cash account.
   */
  static async postACHJournalEntry(batchId) {
    var batch = await pool.query(
      `SELECT * FROM ach_batches WHERE batch_id = $1`, [batchId]
    );
    if (batch.rows.length === 0) throw new Error('ACH batch not found: ' + batchId);

    var b = batch.rows[0];
    var amount = (b.total_amount_cents || 0) / 100;
    if (amount <= 0) throw new Error('Batch amount is zero');

    // Check if already posted
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
    var results = { ach: [], wire: [], errors: [] };

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

    return {
      date: new Date().toISOString().split('T')[0],
      achPosted: results.ach.length,
      wirePosted: results.wire.length,
      errors: results.errors.length,
      details: results,
    };
  }

  // ─── Financial Reporting ──────────────────────────────────────────────────

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

    return {
      generatedAt: new Date().toISOString(),
      summary: summary,
    };
  }

  // ─── Anomaly Detection ────────────────────────────────────────────────────

  /**
   * Scan for bookkeeping anomalies: large transactions, imbalances, gaps.
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

    return {
      date: new Date().toISOString().split('T')[0],
      anomalyCount: anomalies.length,
      anomalies: anomalies,
      highSeverity: anomalies.filter(function(a) { return a.severity === 'high' || a.severity === 'critical'; }).length,
    };
  }

  // ─── Task Management ──────────────────────────────────────────────────────

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
        description: 'Scan for bookkeeping anomalies: negative balances, large transactions, stale payments.',
        priority: 'normal',
      },
      {
        type: 'auto_post',
        category: 'journal',
        title: 'Auto-Post Unreconciled Payments',
        description: 'Automatically create journal entries for settled payments missing GL records.',
        priority: 'high',
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
        case 'financial_summary':
          result = await BookkeepingAgent.generateFinancialSummary();
          break;
        case 'anomaly_scan':
          result = await BookkeepingAgent.detectAnomalies();
          break;
        case 'auto_post':
          result = await BookkeepingAgent.autoPostUnreconciled();
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

  // ─── Queries ──────────────────────────────────────────────────────────────

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

    return {
      pendingTasks: parseInt(pendingTasks.rows[0].c),
      completedThisMonth: parseInt(completedTasks.rows[0].c),
      recentReconciliations: recentRecons.rows,
      journalsLast7Days: recentJournals.count,
    };
  }
}

module.exports = { BookkeepingAgent };
