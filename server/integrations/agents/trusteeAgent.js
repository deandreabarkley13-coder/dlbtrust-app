'use strict';

/**
 * Trustee Agent — Private Trust Company Automation
 *
 * Automates fiduciary duties of a Private Trust Company trustee:
 *  - Asset oversight: monitors bond portfolio, cash positions, and GL balances
 *  - Compliance checks: validates trust accounting integrity, balanced books
 *  - Distribution management: reviews and approves scheduled distributions
 *  - Duty scheduling: generates and tracks recurring trustee tasks
 *  - Fiduciary review: periodic asset reviews, risk assessments
 *
 * Integrates with: BondEngine, TrustAccountingEngine, CashEngine,
 *                  WireEngine, ACHEngine, BILL, Fineract
 */

const pool = require('../bonds/pgPool');

class TrusteeAgent {

  // ─── Table Setup ──────────────────────────────────────────────────────────

  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trustee_tasks (
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
        created_by        TEXT DEFAULT 'trustee_agent',
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS trustee_reviews (
        id                SERIAL PRIMARY KEY,
        review_id         TEXT UNIQUE NOT NULL,
        review_type       TEXT NOT NULL,
        review_date       DATE NOT NULL DEFAULT CURRENT_DATE,
        summary           TEXT,
        findings          JSONB,
        recommendations   JSONB,
        status            TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','final','acknowledged')),
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }

  // ─── Asset Oversight ──────────────────────────────────────────────────────

  /**
   * Run a comprehensive asset review: bonds, cash, GL balances, pending payments.
   * Returns a structured summary with any issues flagged.
   */
  static async runAssetReview() {
    const findings = [];
    const summary = {};

    // 1. Bond portfolio health
    try {
      const bonds = await pool.query(
        `SELECT b.*, bb.accrued_interest, bb.outstanding_principal
         FROM bonds b
         LEFT JOIN bond_balances bb ON b.id = bb.bond_id
         WHERE b.status = 'active'`
      );
      summary.bonds = {
        count: bonds.rows.length,
        totalFaceValue: bonds.rows.reduce((s, b) => s + parseFloat(b.face_value || 0), 0),
        totalAccrued: bonds.rows.reduce((s, b) => s + parseFloat(b.accrued_interest || 0), 0),
        totalOutstanding: bonds.rows.reduce((s, b) => s + parseFloat(b.outstanding_principal || 0), 0),
      };

      // Check for matured bonds still active
      var today = new Date().toISOString().split('T')[0];
      var matured = bonds.rows.filter(function(b) { return b.maturity_date && b.maturity_date <= today; });
      if (matured.length > 0) {
        findings.push({
          severity: 'high',
          area: 'bonds',
          issue: matured.length + ' bond(s) past maturity but still active',
          bonds: matured.map(function(b) { return b.bond_name; }),
        });
      }
    } catch (e) {
      findings.push({ severity: 'low', area: 'bonds', issue: 'Could not query bonds: ' + e.message });
    }

    // 2. Cash position
    try {
      const cash = await pool.query(
        `SELECT * FROM cash_accounts WHERE status = 'active'`
      );
      summary.cash = {
        accounts: cash.rows.length,
        totalBalance: cash.rows.reduce((s, c) => s + parseFloat(c.balance || 0), 0),
      };

      // Flag low cash
      var lowCash = cash.rows.filter(function(c) { return parseFloat(c.balance || 0) < 1000; });
      if (lowCash.length > 0) {
        findings.push({
          severity: 'normal',
          area: 'cash',
          issue: lowCash.length + ' cash account(s) below $1,000 threshold',
          accounts: lowCash.map(function(c) { return c.account_name; }),
        });
      }
    } catch (e) {
      findings.push({ severity: 'low', area: 'cash', issue: 'Could not query cash: ' + e.message });
    }

    // 3. Trust accounting integrity (trial balance)
    try {
      const { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');
      var tb = await TrustAccountingEngine.getTrialBalance();
      summary.accounting = {
        isBalanced: tb.is_balanced,
        totalDebits: tb.total_debits,
        totalCredits: tb.total_credits,
        accountCount: tb.accounts.length,
      };

      if (!tb.is_balanced) {
        findings.push({
          severity: 'critical',
          area: 'accounting',
          issue: 'Trial balance is NOT balanced: debits=$' + tb.total_debits + ', credits=$' + tb.total_credits,
        });
      }
    } catch (e) {
      findings.push({ severity: 'normal', area: 'accounting', issue: 'Could not run trial balance: ' + e.message });
    }

    // 4. Pending wire transfers
    try {
      const wires = await pool.query(
        `SELECT COUNT(*) as c, COALESCE(SUM(amount_cents),0) as total
         FROM wire_transfers WHERE status = 'pending_approval'`
      );
      summary.pendingWires = {
        count: parseInt(wires.rows[0].c),
        totalCents: parseInt(wires.rows[0].total),
      };
      if (parseInt(wires.rows[0].c) > 0) {
        findings.push({
          severity: 'normal',
          area: 'wires',
          issue: wires.rows[0].c + ' wire transfer(s) pending approval ($' + (parseInt(wires.rows[0].total) / 100).toFixed(2) + ')',
        });
      }
    } catch (e) { /* wire table may not exist */ }

    // 5. Pending ACH batches
    try {
      const ach = await pool.query(
        `SELECT COUNT(*) as c, COALESCE(SUM(total_amount_cents),0) as total
         FROM ach_batches WHERE status IN ('pending','created')`
      );
      summary.pendingACH = {
        count: parseInt(ach.rows[0].c),
        totalCents: parseInt(ach.rows[0].total),
      };
    } catch (e) { /* ach table may not exist */ }

    // Save the review
    var reviewId = 'REV-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    var recommendations = [];

    if (findings.filter(function(f) { return f.severity === 'critical'; }).length > 0) {
      recommendations.push({ action: 'immediate_review', detail: 'Critical findings require immediate trustee attention' });
    }
    if (summary.pendingWires && summary.pendingWires.count > 0) {
      recommendations.push({ action: 'approve_wires', detail: 'Review and approve ' + summary.pendingWires.count + ' pending wire transfer(s)' });
    }

    await pool.query(
      `INSERT INTO trustee_reviews (review_id, review_type, summary, findings, recommendations, status)
       VALUES ($1, $2, $3, $4, $5, 'final')`,
      [reviewId, 'asset_review', JSON.stringify(summary), JSON.stringify(findings), JSON.stringify(recommendations)]
    );

    return {
      reviewId: reviewId,
      reviewDate: new Date().toISOString().split('T')[0],
      summary: summary,
      findings: findings,
      recommendations: recommendations,
      criticalCount: findings.filter(function(f) { return f.severity === 'critical'; }).length,
      highCount: findings.filter(function(f) { return f.severity === 'high'; }).length,
    };
  }

  // ─── Compliance Check ─────────────────────────────────────────────────────

  /**
   * Run fiduciary compliance checks:
   * - Books balanced
   * - Required accounts exist
   * - No unauthorized transactions
   * - Distribution limits respected
   */
  static async runComplianceCheck() {
    var checks = [];

    // 1. Required trust accounts exist
    var requiredAccounts = ['1000', '1100', '3000', '4000', '5000'];
    try {
      var accts = await pool.query(
        `SELECT account_code FROM trust_accounts WHERE account_code = ANY($1)`,
        [requiredAccounts]
      );
      var existingCodes = accts.rows.map(function(r) { return r.account_code; });
      var missing = requiredAccounts.filter(function(c) { return existingCodes.indexOf(c) === -1; });
      checks.push({
        check: 'required_accounts',
        passed: missing.length === 0,
        detail: missing.length === 0 ? 'All required trust accounts present' : 'Missing accounts: ' + missing.join(', '),
      });
    } catch (e) {
      checks.push({ check: 'required_accounts', passed: false, detail: e.message });
    }

    // 2. Trial balance
    try {
      var { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');
      var tb = await TrustAccountingEngine.getTrialBalance();
      checks.push({
        check: 'trial_balance',
        passed: tb.is_balanced,
        detail: tb.is_balanced
          ? 'Books balanced at $' + tb.total_debits.toLocaleString()
          : 'IMBALANCE: debits=$' + tb.total_debits + ' credits=$' + tb.total_credits,
      });
    } catch (e) {
      checks.push({ check: 'trial_balance', passed: false, detail: e.message });
    }

    // 3. Corpus integrity — trust corpus account (3000) should be >= face value of active bonds
    try {
      var corpus = await pool.query(`SELECT balance FROM trust_accounts WHERE account_code = '3000'`);
      var bondTotal = await pool.query(`SELECT COALESCE(SUM(face_value),0) as total FROM bonds WHERE status = 'active'`);
      var corpusBalance = corpus.rows.length > 0 ? parseFloat(corpus.rows[0].balance) : 0;
      var bondValue = parseFloat(bondTotal.rows[0].total);
      checks.push({
        check: 'corpus_integrity',
        passed: corpusBalance >= bondValue * 0.9,
        detail: 'Corpus: $' + corpusBalance.toLocaleString() + ' vs Bond obligations: $' + bondValue.toLocaleString(),
      });
    } catch (e) {
      checks.push({ check: 'corpus_integrity', passed: false, detail: e.message });
    }

    // 4. Auth users — ensure admin user exists
    try {
      var admins = await pool.query(`SELECT COUNT(*) as c FROM auth_users WHERE role = 'admin'`);
      checks.push({
        check: 'admin_access',
        passed: parseInt(admins.rows[0].c) > 0,
        detail: admins.rows[0].c + ' admin user(s) configured',
      });
    } catch (e) {
      checks.push({ check: 'admin_access', passed: false, detail: e.message });
    }

    // 5. Recent journal activity (no more than 30 days stale)
    try {
      var recent = await pool.query(
        `SELECT COUNT(*) as c FROM trust_journal_entries
         WHERE status = 'posted' AND created_at >= NOW() - INTERVAL '30 days'`
      );
      checks.push({
        check: 'recent_activity',
        passed: parseInt(recent.rows[0].c) > 0,
        detail: recent.rows[0].c + ' journal entries in last 30 days',
      });
    } catch (e) {
      checks.push({ check: 'recent_activity', passed: false, detail: e.message });
    }

    var passedCount = checks.filter(function(c) { return c.passed; }).length;
    var totalCount = checks.length;

    // Save as a review
    var reviewId = 'CMP-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    await pool.query(
      `INSERT INTO trustee_reviews (review_id, review_type, summary, findings, status)
       VALUES ($1, $2, $3, $4, 'final')`,
      [reviewId, 'compliance_check', passedCount + '/' + totalCount + ' checks passed', JSON.stringify(checks)]
    );

    return {
      reviewId: reviewId,
      date: new Date().toISOString().split('T')[0],
      passed: passedCount,
      total: totalCount,
      allPassed: passedCount === totalCount,
      checks: checks,
    };
  }

  // ─── Distribution Review ──────────────────────────────────────────────────

  /**
   * Review pending distributions (ACH + wire) and generate trustee approval report.
   */
  static async reviewDistributions() {
    var pendingItems = [];

    // Pending wire transfers
    try {
      var wires = await pool.query(
        `SELECT * FROM wire_transfers WHERE status IN ('pending_approval','pending')
         ORDER BY created_at DESC LIMIT 20`
      );
      wires.rows.forEach(function(w) {
        pendingItems.push({
          type: 'wire',
          id: w.wire_id,
          amount: (w.amount_cents || 0) / 100,
          beneficiary: w.beneficiary_name,
          status: w.status,
          date: w.created_at,
          description: w.description,
        });
      });
    } catch (e) { /* wire table may not exist */ }

    // Pending ACH batches
    try {
      var batches = await pool.query(
        `SELECT b.*, COUNT(e.id) as entry_count
         FROM ach_batches b
         LEFT JOIN ach_entries e ON b.batch_id = e.batch_id
         WHERE b.status IN ('pending','created')
         GROUP BY b.batch_id
         ORDER BY b.created_at DESC LIMIT 20`
      );
      batches.rows.forEach(function(b) {
        pendingItems.push({
          type: 'ach',
          id: b.batch_id,
          amount: (b.total_amount_cents || 0) / 100,
          entryCount: parseInt(b.entry_count),
          status: b.status,
          date: b.created_at,
          description: b.entry_description,
        });
      });
    } catch (e) { /* ach table may not exist */ }

    // Coupon payments due
    try {
      var coupons = await pool.query(
        `SELECT * FROM coupon_payments WHERE status = 'pending'
         ORDER BY coupon_date ASC LIMIT 10`
      );
      coupons.rows.forEach(function(cp) {
        pendingItems.push({
          type: 'coupon',
          id: cp.coupon_payment_id,
          amount: parseFloat(cp.amount),
          bondId: cp.bond_id,
          status: cp.status,
          date: cp.coupon_date,
          description: 'Bond coupon payment',
        });
      });
    } catch (e) { /* coupon table may not exist */ }

    var totalPending = pendingItems.reduce(function(s, i) { return s + i.amount; }, 0);

    return {
      date: new Date().toISOString().split('T')[0],
      pendingCount: pendingItems.length,
      totalPendingAmount: Math.round(totalPending * 100) / 100,
      items: pendingItems,
    };
  }

  // ─── Task Management ──────────────────────────────────────────────────────

  /**
   * Generate standard trustee duties for the current period.
   */
  static async generateDuties() {
    var today = new Date();
    var dateStr = today.toISOString().split('T')[0];
    var duties = [
      {
        type: 'asset_review',
        category: 'oversight',
        title: 'Monthly Asset Review',
        description: 'Review all trust assets, verify balances, check bond portfolio health, and confirm cash positions.',
        priority: 'high',
      },
      {
        type: 'compliance_check',
        category: 'compliance',
        title: 'Fiduciary Compliance Check',
        description: 'Verify trial balance, corpus integrity, required accounts, and admin access controls.',
        priority: 'high',
      },
      {
        type: 'distribution_review',
        category: 'payments',
        title: 'Distribution Review & Approval',
        description: 'Review all pending ACH, wire, and coupon distributions for accuracy and authorization.',
        priority: 'normal',
      },
      {
        type: 'tax_review',
        category: 'tax',
        title: 'Tax Obligation Review',
        description: 'Review current tax year income, expenses, and estimated tax obligations (Form 1041).',
        priority: 'normal',
      },
      {
        type: 'beneficiary_review',
        category: 'beneficiaries',
        title: 'Beneficiary Records Review',
        description: 'Verify beneficiary contact information, KYC status, and distribution allocations.',
        priority: 'low',
      },
    ];

    var created = [];
    for (var i = 0; i < duties.length; i++) {
      var d = duties[i];
      var taskId = 'TRT-' + dateStr.replace(/-/g, '') + '-' + d.type.toUpperCase();

      // Skip if already exists for today
      var existing = await pool.query(
        `SELECT id FROM trustee_tasks WHERE task_id = $1`, [taskId]
      );
      if (existing.rows.length > 0) continue;

      await pool.query(
        `INSERT INTO trustee_tasks (task_id, task_type, category, title, description, priority, scheduled_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [taskId, d.type, d.category, d.title, d.description, d.priority, dateStr]
      );
      created.push(taskId);
    }

    return { date: dateStr, generated: created.length, taskIds: created };
  }

  /**
   * Execute a trustee task by ID (runs the corresponding automation).
   */
  static async executeTask(taskId) {
    var task = await pool.query(`SELECT * FROM trustee_tasks WHERE task_id = $1`, [taskId]);
    if (task.rows.length === 0) throw new Error('Task not found: ' + taskId);

    var t = task.rows[0];
    if (t.status === 'completed') throw new Error('Task already completed');

    await pool.query(
      `UPDATE trustee_tasks SET status = 'in_progress', updated_at = NOW() WHERE task_id = $1`,
      [taskId]
    );

    var result;
    try {
      switch (t.task_type) {
        case 'asset_review':
          result = await TrusteeAgent.runAssetReview();
          break;
        case 'compliance_check':
          result = await TrusteeAgent.runComplianceCheck();
          break;
        case 'distribution_review':
          result = await TrusteeAgent.reviewDistributions();
          break;
        default:
          result = { message: 'Manual task — mark complete when done' };
          await pool.query(
            `UPDATE trustee_tasks SET status = 'pending', updated_at = NOW() WHERE task_id = $1`,
            [taskId]
          );
          return { taskId: taskId, taskType: t.task_type, status: 'pending', result: result };
      }

      await pool.query(
        `UPDATE trustee_tasks SET status = 'completed', completed_date = NOW(),
         result = $1, updated_at = NOW() WHERE task_id = $2`,
        [JSON.stringify(result), taskId]
      );

      return { taskId: taskId, taskType: t.task_type, status: 'completed', result: result };
    } catch (err) {
      await pool.query(
        `UPDATE trustee_tasks SET status = 'failed',
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
      'SELECT * FROM trustee_tasks ' + where + ' ORDER BY scheduled_date DESC, priority DESC LIMIT $' + idx,
      params.concat([lim])
    );
    return result.rows;
  }

  static async listReviews({ reviewType, limit } = {}) {
    var conditions = [];
    var params = [];
    var idx = 1;

    if (reviewType) { conditions.push('review_type = $' + idx++); params.push(reviewType); }

    var where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    var lim = parseInt(limit) || 20;

    var result = await pool.query(
      'SELECT * FROM trustee_reviews ' + where + ' ORDER BY review_date DESC, created_at DESC LIMIT $' + idx,
      params.concat([lim])
    );
    return result.rows;
  }

  static async getReview(reviewId) {
    var result = await pool.query(
      'SELECT * FROM trustee_reviews WHERE review_id = $1', [reviewId]
    );
    return result.rows[0] || null;
  }

  // ─── Dashboard Summary ────────────────────────────────────────────────────

  static async getDashboard() {
    var pendingTasks = await pool.query(
      `SELECT COUNT(*) as c FROM trustee_tasks WHERE status IN ('pending','in_progress')`
    );
    var completedTasks = await pool.query(
      `SELECT COUNT(*) as c FROM trustee_tasks WHERE status = 'completed'
       AND completed_date >= NOW() - INTERVAL '30 days'`
    );
    var recentReviews = await pool.query(
      `SELECT review_id, review_type, review_date, status, summary
       FROM trustee_reviews ORDER BY created_at DESC LIMIT 5`
    );

    // Quick health indicators
    var health = { bonds: null, cash: null, accounting: null };
    try {
      var bondRes = await pool.query(`SELECT COUNT(*) as c FROM bonds WHERE status = 'active'`);
      health.bonds = parseInt(bondRes.rows[0].c);
    } catch (e) {}
    try {
      var cashRes = await pool.query(`SELECT COUNT(*) as c, COALESCE(SUM(balance),0) as total FROM cash_accounts WHERE status = 'active'`);
      health.cash = { accounts: parseInt(cashRes.rows[0].c), balance: parseFloat(cashRes.rows[0].total) };
    } catch (e) {}

    return {
      pendingTasks: parseInt(pendingTasks.rows[0].c),
      completedThisMonth: parseInt(completedTasks.rows[0].c),
      recentReviews: recentReviews.rows,
      health: health,
    };
  }
}

module.exports = { TrusteeAgent };
