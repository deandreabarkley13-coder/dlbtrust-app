/**
 * Cash Management System Routes
 * DEANDREA LAVAR BARKLEY TRUST — Treasury & Liquidity Management
 *
 * Endpoints:
 *   GET  /api/cash-management/position          - Unified cash position
 *   GET  /api/cash-management/forecast           - Cash flow forecast
 *   GET  /api/cash-management/reconciliation     - Cross-engine reconciliation
 *   GET  /api/cash-management/alerts             - Active alerts
 *   POST /api/cash-management/alerts/:id/acknowledge - Acknowledge alert
 *   POST /api/cash-management/alerts/:id/dismiss     - Dismiss alert
 *   GET  /api/cash-management/income-summary     - Income vs expense summary
 *   POST /api/cash-management/snapshot           - Save position snapshot
 *   GET  /api/cash-management/snapshots          - List historical snapshots
 *   GET  /api/cash-management/events             - Event bus history
 *   GET  /api/cash-management/rules              - List liquidity rules
 *   POST /api/cash-management/rules              - Create liquidity rule
 */

'use strict';

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const {
  buildCashPosition,
  buildForecast,
  reconcile,
  generateAlerts,
  buildIncomeExpenseSummary,
} = require('../engines/cash-management-engine');

const { bus, EVENTS } = require('../engines/event-bus');

// --- DB Setup ---------------------------------------------------------------

function getDb() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'dlbtrust.db');
  return new Database(dbPath);
}

function ensureTables(db) {
  const schemaPath = path.join(__dirname, '..', 'db', 'migrations', 'cash-management-schema.sql');
  if (fs.existsSync(schemaPath)) {
    const sql = fs.readFileSync(schemaPath, 'utf8');
    db.exec(sql);
  }
}

// --- Helper: gather data from all engines -----------------------------------

function gatherPositionData(db) {
  // Bank accounts
  let accounts = [];
  try {
    accounts = db.prepare('SELECT * FROM trust_accounts').all();
  } catch (e) { /* table may not exist */ }

  // Blockchain wallets
  let wallets = [];
  try {
    wallets = db.prepare('SELECT * FROM blockchain_wallets').all();
  } catch (e) { /* table may not exist */ }

  // Fixed income holdings
  let holdings = [];
  try {
    holdings = db.prepare('SELECT * FROM fixed_income_holdings').all();
  } catch (e) { /* table may not exist */ }

  // Pending transfers
  let pendingTransfers = [];
  try {
    pendingTransfers = db.prepare(
      "SELECT * FROM internal_transfers WHERE status IN ('pending', 'approved', 'executing')"
    ).all();
  } catch (e) { /* table may not exist */ }

  // Pending blockchain transactions
  let pendingBlockchainTxns = [];
  try {
    pendingBlockchainTxns = db.prepare(
      "SELECT * FROM blockchain_transactions WHERE status IN ('pending_approval', 'initiated', 'submitted', 'confirming')"
    ).all();
  } catch (e) { /* table may not exist */ }

  return { accounts, wallets, holdings, pendingTransfers, pendingBlockchainTxns };
}

function gatherForecastData(db) {
  const posData = gatherPositionData(db);

  // Scheduled payments
  let scheduledPayments = [];
  try {
    scheduledPayments = db.prepare(
      "SELECT * FROM external_transfers WHERE status IN ('draft', 'pending_approval', 'approved') AND scheduled_date IS NOT NULL"
    ).all();
  } catch (e) { /* table may not exist */ }

  return {
    accounts: posData.accounts,
    holdings: posData.holdings,
    wallets: posData.wallets,
    scheduledPayments,
    recurringTransfers: [],
  };
}

function gatherReconData(db) {
  const posData = gatherPositionData(db);

  // GL balances
  let glBalances = [];
  try {
    glBalances = db.prepare('SELECT * FROM trust_chart_of_accounts WHERE is_active = 1').all();
    // Compute balances from journal lines
    const balanceQuery = db.prepare(`
      SELECT jl.account_code,
             SUM(jl.debit_cents) as total_debit,
             SUM(jl.credit_cents) as total_credit
      FROM trust_journal_lines jl
      JOIN trust_journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.is_posted = 1
      GROUP BY jl.account_code
    `);
    const balances = balanceQuery.all();
    const balMap = {};
    for (const b of balances) {
      balMap[b.account_code] = b;
    }

    glBalances = glBalances.map(gl => {
      const b = balMap[gl.account_code] || {};
      const debit = b.total_debit || 0;
      const credit = b.total_credit || 0;
      const balance = gl.normal_balance === 'debit' ? debit - credit : credit - debit;
      return { ...gl, balance_cents: balance };
    });
  } catch (e) { /* tables may not exist */ }

  // All transfers
  let transfers = [];
  try {
    transfers = db.prepare('SELECT * FROM internal_transfers').all();
  } catch (e) { /* table may not exist */ }

  // All blockchain transactions
  let blockchainTxns = [];
  try {
    blockchainTxns = db.prepare('SELECT * FROM blockchain_transactions').all();
  } catch (e) { /* table may not exist */ }

  return {
    accounts: posData.accounts,
    wallets: posData.wallets,
    holdings: posData.holdings,
    glBalances,
    transfers,
    blockchainTxns,
  };
}

// ============================================================================
// ROUTES
// ============================================================================

// GET /api/cash-management/position
router.get('/position', (req, res) => {
  const db = getDb();
  try {
    ensureTables(db);
    const data = gatherPositionData(db);
    const position = buildCashPosition(data);
    res.json(position);
  } catch (err) {
    console.error('[CMS] Position error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// GET /api/cash-management/forecast
router.get('/forecast', (req, res) => {
  const db = getDb();
  try {
    ensureTables(db);
    const horizonDays = parseInt(req.query.horizon_days) || 90;
    const data = gatherForecastData(db);
    const forecast = buildForecast(data, horizonDays);
    res.json(forecast);
  } catch (err) {
    console.error('[CMS] Forecast error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// GET /api/cash-management/reconciliation
router.get('/reconciliation', (req, res) => {
  const db = getDb();
  try {
    ensureTables(db);
    const data = gatherReconData(db);
    const recon = reconcile(data);

    // Save to reconciliation log
    try {
      db.prepare(`
        INSERT INTO cms_reconciliation_log (recon_time, total_checks, matched_count, mismatch_count, review_count, overall_status, recon_data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        recon.reconciliation_time,
        recon.summary.total_checks,
        recon.summary.matched,
        recon.summary.mismatched,
        recon.summary.pending_review,
        recon.summary.overall_status,
        JSON.stringify(recon)
      );
    } catch (e) { /* log save is best-effort */ }

    bus.emit(EVENTS.RECON_COMPLETED, { status: recon.summary.overall_status });
    res.json(recon);
  } catch (err) {
    console.error('[CMS] Reconciliation error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// GET /api/cash-management/alerts
router.get('/alerts', (req, res) => {
  const db = getDb();
  try {
    ensureTables(db);

    // Generate live alerts from current state
    const posData = gatherPositionData(db);
    const position = buildCashPosition(posData);
    const forecastData = gatherForecastData(db);
    const forecast = buildForecast(forecastData, 90);
    const reconData = gatherReconData(db);
    const recon = reconcile(reconData);

    const liveAlerts = generateAlerts(position, forecast, recon);

    // Also fetch persisted alerts
    let persistedAlerts = [];
    try {
      const statusFilter = req.query.status || 'active';
      persistedAlerts = db.prepare(
        'SELECT * FROM cms_alerts WHERE status = ? ORDER BY created_at DESC LIMIT 50'
      ).all(statusFilter);
    } catch (e) { /* table may not exist */ }

    res.json({
      live_alerts: liveAlerts,
      persisted_alerts: persistedAlerts,
      summary: {
        critical: liveAlerts.filter(a => a.severity === 'critical').length,
        warning: liveAlerts.filter(a => a.severity === 'warning').length,
        info: liveAlerts.filter(a => a.severity === 'info').length,
        total: liveAlerts.length,
      },
    });
  } catch (err) {
    console.error('[CMS] Alerts error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// POST /api/cash-management/alerts/:id/acknowledge
router.post('/alerts/:id/acknowledge', (req, res) => {
  const db = getDb();
  try {
    ensureTables(db);
    const result = db.prepare(`
      UPDATE cms_alerts SET status = 'acknowledged', acknowledged_by = 'trustee', acknowledged_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'active'
    `).run(req.params.id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Alert not found or already acknowledged' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// POST /api/cash-management/alerts/:id/dismiss
router.post('/alerts/:id/dismiss', (req, res) => {
  const db = getDb();
  try {
    ensureTables(db);
    const result = db.prepare(`
      UPDATE cms_alerts SET status = 'dismissed', updated_at = datetime('now')
      WHERE id = ? AND status IN ('active', 'acknowledged')
    `).run(req.params.id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Alert not found or already dismissed' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// GET /api/cash-management/income-summary
router.get('/income-summary', (req, res) => {
  const db = getDb();
  try {
    ensureTables(db);
    const posData = gatherPositionData(db);

    let payments = [];
    try {
      payments = db.prepare('SELECT * FROM external_transfers').all();
    } catch (e) { /* table may not exist */ }

    const summary = buildIncomeExpenseSummary({
      holdings: posData.holdings,
      accounts: posData.accounts,
      payments,
    });

    res.json(summary);
  } catch (err) {
    console.error('[CMS] Income summary error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// POST /api/cash-management/snapshot
router.post('/snapshot', (req, res) => {
  const db = getDb();
  try {
    ensureTables(db);
    const data = gatherPositionData(db);
    const position = buildCashPosition(data);
    const s = position.summary;

    const result = db.prepare(`
      INSERT INTO cms_position_snapshots
        (bank_balance_cents, bank_available_cents, bank_account_count,
         crypto_usdc_cents, crypto_wallet_count,
         fi_par_value_cents, fi_market_value_cents, fi_accrued_cents, fi_holding_count,
         pending_inflow_cents, pending_outflow_cents,
         total_liquid_cents, total_assets_cents)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      s.bank_balance_cents, position.bank_accounts.total_available_cents, s.account_count,
      s.crypto_balance_cents, s.wallet_count,
      position.fixed_income.total_par_cents, s.fixed_income_market_cents, s.accrued_interest_cents, s.holding_count,
      position.pending.inflow_cents, position.pending.outflow_cents,
      s.total_liquid_cents, s.total_assets_cents
    );

    bus.emit(EVENTS.POSITION_UPDATED, { snapshot_id: result.lastInsertRowid });

    res.json({
      success: true,
      snapshot_id: result.lastInsertRowid,
      summary: s,
    });
  } catch (err) {
    console.error('[CMS] Snapshot error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// GET /api/cash-management/snapshots
router.get('/snapshots', (req, res) => {
  const db = getDb();
  try {
    ensureTables(db);
    const limit = parseInt(req.query.limit) || 30;
    const snapshots = db.prepare(
      'SELECT * FROM cms_position_snapshots ORDER BY snapshot_time DESC LIMIT ?'
    ).all(limit);

    res.json({ snapshots, count: snapshots.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// GET /api/cash-management/events
router.get('/events', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const eventFilter = req.query.event || null;
  const history = bus.getHistory({ event: eventFilter, limit });
  res.json({ events: history, count: history.length });
});

// GET /api/cash-management/rules
router.get('/rules', (req, res) => {
  const db = getDb();
  try {
    ensureTables(db);
    const rules = db.prepare('SELECT * FROM cms_liquidity_rules ORDER BY created_at DESC').all();
    res.json({ rules, count: rules.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// POST /api/cash-management/rules
router.post('/rules', (req, res) => {
  const db = getDb();
  try {
    ensureTables(db);
    const { rule_name, rule_type, description, trigger_condition, action_type, action_config } = req.body;

    if (!rule_name || !rule_type || !trigger_condition || !action_type) {
      return res.status(400).json({ error: 'rule_name, rule_type, trigger_condition, and action_type are required' });
    }

    const result = db.prepare(`
      INSERT INTO cms_liquidity_rules (rule_name, rule_type, description, trigger_condition, action_type, action_config)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      rule_name, rule_type, description || null,
      JSON.stringify(trigger_condition), action_type,
      action_config ? JSON.stringify(action_config) : null
    );

    const rule = db.prepare('SELECT * FROM cms_liquidity_rules WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(rule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// GET /api/cash-management/reconciliation/history
router.get('/reconciliation/history', (req, res) => {
  const db = getDb();
  try {
    ensureTables(db);
    const limit = parseInt(req.query.limit) || 20;
    const history = db.prepare(
      'SELECT id, recon_time, total_checks, matched_count, mismatch_count, review_count, overall_status, notes, created_at FROM cms_reconciliation_log ORDER BY recon_time DESC LIMIT ?'
    ).all(limit);
    res.json({ history, count: history.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// ─── POST /initialize-gl ──────────────────────────────────────────────────────
// Books initial journal entries for all existing data:
//   - Bank accounts → Debit 1010/Credit 3000 (Trust Corpus funding)
//   - FI holdings → Debit 1100/Credit 3000 (Bond purchase)
//   - Accrued interest → Debit 1500/Credit 4000 (Receivable)

router.post('/initialize-gl', (req, res) => {
  const db = getDb();
  try {
    ensureTables(db);
    const entries = [];
    const now = new Date().toISOString().split('T')[0];

    // Check if GL already has entries (avoid double-init)
    const existingCount = db.prepare('SELECT COUNT(*) as cnt FROM trust_journal_entries').get().cnt;
    if (existingCount > 0 && !req.body.force) {
      return res.status(400).json({
        error: 'GL already has entries. Pass { "force": true } to re-initialize.',
        existing_entries: existingCount,
      });
    }

    // Resolve GL account IDs
    const glAccounts = {};
    for (const code of ['1010', '1100', '1500', '3000', '4000']) {
      const acct = db.prepare("SELECT id FROM trust_chart_of_accounts WHERE account_code = ? AND is_active = 1").get(code);
      if (!acct) return res.status(500).json({ error: `GL account ${code} not found in chart of accounts` });
      glAccounts[code] = acct.id;
    }

    const insertEntry = db.prepare(`
      INSERT INTO trust_journal_entries (entry_number, entry_date, entry_type, description, source_engine, is_posted, total_debit_cents, total_credit_cents, created_by)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'system')
    `);
    const insertLine = db.prepare(`
      INSERT INTO trust_journal_lines (journal_entry_id, line_number, account_id, account_code, debit_cents, credit_cents, description)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const txn = db.transaction(() => {
      // 1. Bank accounts — Debit Operating Cash / Credit Trust Corpus
      const accounts = db.prepare("SELECT * FROM trust_accounts WHERE status = 'active'").all();
      for (const acct of accounts) {
        if (acct.balance_cents <= 0) continue;
        const entryNum = `INIT-BANK-${acct.id}-${Date.now()}`;
        const desc = `Initial trust funding — ${acct.account_name}`;
        const result = insertEntry.run(entryNum, now, 'initial_funding', desc, 'banking', acct.balance_cents, acct.balance_cents);
        const eid = result.lastInsertRowid;
        insertLine.run(eid, 1, glAccounts['1010'], '1010', acct.balance_cents, 0, `Cash — ${acct.account_name}`);
        insertLine.run(eid, 2, glAccounts['3000'], '3000', 0, acct.balance_cents, `Trust corpus — initial funding`);
        entries.push({ type: 'bank_funding', account: acct.account_name, amount_cents: acct.balance_cents, entry_id: eid });
      }

      // 2. Fixed income holdings — Debit FI Investments / Credit Trust Corpus
      const holdings = db.prepare("SELECT * FROM fixed_income_holdings WHERE status = 'active'").all();
      for (const h of holdings) {
        const valueCents = h.purchase_price_cents || h.par_value_cents;
        if (valueCents <= 0) continue;
        const entryNum = `INIT-FI-${h.id}-${Date.now()}`;
        const desc = `Bond purchase — ${h.security_name}`;
        const result = insertEntry.run(entryNum, h.purchase_date || now, 'bond_purchase', desc, 'fixed_income', valueCents, valueCents);
        const eid = result.lastInsertRowid;
        insertLine.run(eid, 1, glAccounts['1100'], '1100', valueCents, 0, `Fixed income — ${h.security_name}`);
        insertLine.run(eid, 2, glAccounts['3000'], '3000', 0, valueCents, `Trust corpus — bond investment`);
        entries.push({ type: 'bond_purchase', security: h.security_name, amount_cents: valueCents, entry_id: eid });
      }

      // 3. Accrued interest — Debit Accrued Interest Receivable / Credit Interest Income
      //    Calculate dynamically using FI analytics
      let totalAccruedCents = 0;
      try {
        const { analyzeBond } = require('../engines/fixed-income-engine');
        for (const h of holdings) {
          const analytics = analyzeBond(h);
          const accrued = analytics.accrued_interest_cents || 0;
          if (accrued > 0) {
            totalAccruedCents += accrued;
          }
        }
      } catch (_) { /* FI engine not available */ }

      if (totalAccruedCents > 0) {
        const entryNum = `INIT-AI-${Date.now()}`;
        const desc = `Accrued interest receivable — all holdings`;
        const result = insertEntry.run(entryNum, now, 'accrued_interest', desc, 'fixed_income', totalAccruedCents, totalAccruedCents);
        const eid = result.lastInsertRowid;
        insertLine.run(eid, 1, glAccounts['1500'], '1500', totalAccruedCents, 0, 'Accrued interest receivable');
        insertLine.run(eid, 2, glAccounts['4000'], '4000', 0, totalAccruedCents, 'Interest income — accrued');
        entries.push({ type: 'accrued_interest', amount_cents: totalAccruedCents, entry_id: eid });
      }

      return entries;
    });

    const result = txn();
    const totalDebits = result.reduce((s, e) => s + e.amount_cents, 0);

    res.json({
      success: true,
      message: `GL initialized with ${result.length} journal entries`,
      entries: result,
      total_debits_cents: totalDebits,
      total_debits_usd: (totalDebits / 100).toFixed(2),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// ─── POST /generate-coupon-schedule ───────────────────────────────────────────
// Generates missing coupon schedules for existing bonds

router.post('/generate-coupon-schedule', (req, res) => {
  const db = getDb();
  try {
    ensureTables(db);
    const { generateCouponDates, periodsPerYear } = require('../engines/fixed-income-engine');
    const holdings = db.prepare("SELECT * FROM fixed_income_holdings WHERE status = 'active'").all();
    const results = [];

    for (const h of holdings) {
      const existingCoupons = db.prepare('SELECT COUNT(*) as cnt FROM coupon_payments WHERE holding_id = ?').get(h.id).cnt;
      if (existingCoupons > 0 && !req.body.force) {
        results.push({ holding_id: h.id, security_name: h.security_name, skipped: true, existing_coupons: existingCoupons });
        continue;
      }

      const ppy = periodsPerYear(h.coupon_frequency);
      if (ppy <= 0) continue;

      const couponDates = generateCouponDates(h.purchase_date, h.maturity_date, h.coupon_frequency);
      const couponAmount = Math.round((h.par_value_cents * h.coupon_rate) / ppy);
      const todayStr = new Date().toISOString().split('T')[0];
      let inserted = 0;

      const insertCoupon = db.prepare(
        'INSERT INTO coupon_payments (holding_id, payment_date, amount_cents, status) VALUES (?, ?, ?, ?)'
      );

      for (const date of couponDates) {
        // Skip if this exact coupon already exists
        const existing = db.prepare('SELECT id FROM coupon_payments WHERE holding_id = ? AND payment_date = ?').get(h.id, date);
        if (existing) continue;

        const status = date <= todayStr ? 'accrued' : 'scheduled';
        insertCoupon.run(h.id, date, couponAmount, status);
        inserted++;
      }

      results.push({
        holding_id: h.id,
        security_name: h.security_name,
        coupon_amount_cents: couponAmount,
        coupon_amount_usd: (couponAmount / 100).toFixed(2),
        total_dates: couponDates.length,
        newly_inserted: inserted,
        frequency: h.coupon_frequency,
      });
    }

    res.json({
      success: true,
      message: `Coupon schedules processed for ${results.length} holding(s)`,
      holdings: results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// ─── GET /upcoming-coupons ────────────────────────────────────────────────────
// Returns the next N coupon payments across all holdings

router.get('/upcoming-coupons', (req, res) => {
  const db = getDb();
  try {
    ensureTables(db);
    const limit = parseInt(req.query.limit) || 10;
    const todayStr = new Date().toISOString().split('T')[0];

    const coupons = db.prepare(`
      SELECT cp.*, h.security_name, h.security_type, h.coupon_rate, h.coupon_frequency
      FROM coupon_payments cp
      JOIN fixed_income_holdings h ON cp.holding_id = h.id
      WHERE cp.status IN ('scheduled', 'accrued') AND cp.payment_date >= ?
      ORDER BY cp.payment_date ASC
      LIMIT ?
    `).all(todayStr, limit);

    const accruedCoupons = db.prepare(`
      SELECT cp.*, h.security_name, h.security_type
      FROM coupon_payments cp
      JOIN fixed_income_holdings h ON cp.holding_id = h.id
      WHERE cp.status = 'accrued'
      ORDER BY cp.payment_date ASC
    `).all();

    res.json({
      upcoming: coupons.map(c => ({
        ...c,
        amount_usd: (c.amount_cents / 100).toFixed(2),
      })),
      accrued_count: accruedCoupons.length,
      accrued_total_cents: accruedCoupons.reduce((s, c) => s + c.amount_cents, 0),
      total_upcoming: coupons.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

module.exports = router;
