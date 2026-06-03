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

module.exports = router;
