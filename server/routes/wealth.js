/**
 * Wealth Management Dashboard Routes
 * DEANDREA LAVAR BARKLEY TRUST -- Private Wealth Management Platform
 *
 * Unified dashboard integrating all engines:
 *   - Core Banking (accounts, transfers)
 *   - Payment Engine (payouts, vendors, bills)
 *   - Fixed Income (holdings, portfolio analytics)
 *
 * Endpoints:
 *   GET /api/wealth/dashboard      - Unified wealth dashboard
 *   GET /api/wealth/net-worth      - Total net worth across all asset classes
 *   GET /api/wealth/performance    - Portfolio performance metrics
 *   GET /api/wealth/tax-center     - Tax reporting hub
 *   GET /api/wealth/compliance     - Cross-engine compliance summary
 *   GET /api/wealth/cashflow       - Projected cash flow (income vs obligations)
 *   GET /api/wealth/activity       - Recent activity across all engines
 */

'use strict';

const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const Database = require('better-sqlite3');

const {
  calculateNetWorth,
  calculateSimpleReturn,
  buildTrialBalance,
  toDollars,
} = require('../engines/banking-engine');

// --- DB Setup ---------------------------------------------------------------

function getDb() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'dlbtrust.db');
  return new Database(dbPath);
}

let schemaInitialized = false;

function initSchema(db) {
  if (schemaInitialized) return;
  const schemaPath = path.join(__dirname, '..', 'db', 'migrations', 'banking-schema.sql');
  if (fs.existsSync(schemaPath)) {
    const sql = fs.readFileSync(schemaPath, 'utf8');
    db.exec(sql);
  }
  schemaInitialized = true;
}

// --- Middleware --------------------------------------------------------------

router.use((req, res, next) => {
  try {
    req.db = getDb();
    initSchema(req.db);
    res.on('finish', () => { try { req.db.close(); } catch (_) {} });
    res.on('close',  () => { try { req.db.close(); } catch (_) {} });
    next();
  } catch (err) {
    res.status(500).json({ error: 'Database connection failed', detail: err.message });
  }
});

// --- Safe query helper (tables may not exist) --------------------------------

function safeQuery(db, sql, params = []) {
  try { return db.prepare(sql).all(...params); } catch (_) { return []; }
}
function safeGet(db, sql, params = []) {
  try { return db.prepare(sql).get(...params) || {}; } catch (_) { return {}; }
}

// ============================================================================
// ROUTES
// ============================================================================

// --- GET /dashboard -- Unified wealth dashboard -----------------------------
router.get('/dashboard', (req, res) => {
  try {
    // Banking accounts
    const accounts = safeQuery(req.db, `SELECT * FROM trust_accounts WHERE status != 'closed'`);
    const totalBanking = accounts.reduce((s, a) => s + (a.balance_cents || 0), 0);

    // Existing wallets (legacy)
    const wallets = safeQuery(req.db, `SELECT * FROM wallets`);
    const totalWallets = wallets.reduce((s, w) => s + (w.fiat_balance || 0), 0);

    // Fixed income holdings
    const holdings = safeQuery(req.db, `SELECT * FROM fixed_income_holdings WHERE status = 'active'`);
    const totalHoldings = holdings.reduce((s, h) => s + (h.market_value_cents || h.par_value_cents || 0), 0);

    // Outstanding payables
    const payables = safeQuery(req.db, `SELECT * FROM bills WHERE status NOT IN ('paid', 'cancelled')`);
    const totalPayables = payables.reduce((s, b) => s + (b.balance_cents || 0), 0);

    // Pending payouts
    const pendingPayouts = safeQuery(req.db, `SELECT * FROM trust_payouts WHERE status IN ('draft', 'pending_approval', 'approved', 'processing')`);
    const totalPendingPayouts = pendingPayouts.reduce((s, p) => s + (p.amount_cents || 0), 0);

    // Pending transfers
    const pendingTransfers = safeQuery(req.db, `SELECT * FROM internal_transfers WHERE status IN ('pending', 'approved')`);
    const totalPendingTransfers = pendingTransfers.reduce((s, t) => s + (t.amount_cents || 0), 0);

    // Active vendors
    const vendorCount = safeGet(req.db, `SELECT COUNT(*) AS count FROM vendors WHERE status = 'active'`);

    const totalAssets = totalBanking + totalWallets + totalHoldings;
    const netWorth = totalAssets - totalPayables;

    res.json({
      generated_at: new Date().toISOString(),
      trust_name: 'DeAndrea Lavar Barkley Trust',

      summary: {
        total_assets_cents: totalAssets,
        total_assets_usd: toDollars(totalAssets),
        total_liabilities_cents: totalPayables,
        total_liabilities_usd: toDollars(totalPayables),
        net_worth_cents: netWorth,
        net_worth_usd: toDollars(netWorth),
      },

      banking: {
        account_count: accounts.length,
        total_balance_cents: totalBanking,
        total_balance_usd: toDollars(totalBanking),
        accounts_by_type: groupBy(accounts, 'account_type', a => a.balance_cents),
      },

      wallets: {
        wallet_count: wallets.length,
        total_balance_cents: totalWallets,
        total_balance_usd: toDollars(totalWallets),
      },

      investments: {
        holding_count: holdings.length,
        total_value_cents: totalHoldings,
        total_value_usd: toDollars(totalHoldings),
      },

      obligations: {
        outstanding_bills: payables.length,
        total_payables_cents: totalPayables,
        total_payables_usd: toDollars(totalPayables),
        pending_payouts: pendingPayouts.length,
        pending_payout_amount_cents: totalPendingPayouts,
        pending_payout_amount_usd: toDollars(totalPendingPayouts),
        pending_transfers: pendingTransfers.length,
        pending_transfer_amount_cents: totalPendingTransfers,
        pending_transfer_amount_usd: toDollars(totalPendingTransfers),
      },

      operations: {
        active_vendors: vendorCount.count || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /net-worth -- Total net worth --------------------------------------
router.get('/net-worth', (req, res) => {
  try {
    const accounts = safeQuery(req.db, `SELECT * FROM trust_accounts WHERE status != 'closed'`);
    const wallets  = safeQuery(req.db, `SELECT * FROM wallets`);
    const holdings = safeQuery(req.db, `SELECT * FROM fixed_income_holdings WHERE status = 'active'`);
    const payables = safeQuery(req.db, `SELECT * FROM bills WHERE status NOT IN ('paid', 'cancelled')`);

    const bankingTotal  = accounts.reduce((s, a) => s + (a.balance_cents || 0), 0);
    const walletTotal   = wallets.reduce((s, w) => s + (w.fiat_balance || 0), 0);
    const holdingTotal  = holdings.reduce((s, h) => s + (h.market_value_cents || h.par_value_cents || 0), 0);
    const payableTotal  = payables.reduce((s, b) => s + (b.balance_cents || 0), 0);

    // Accrued interest across all accounts
    const accruedInterest = accounts.reduce((s, a) => s + (a.interest_accrued_cents || 0), 0);

    const totalAssets = bankingTotal + walletTotal + holdingTotal + accruedInterest;

    res.json({
      calculated_at: new Date().toISOString(),
      trust_name: 'DeAndrea Lavar Barkley Trust',

      assets: {
        cash_and_banking: {
          trust_accounts_cents: bankingTotal,
          trust_accounts_usd: toDollars(bankingTotal),
          legacy_wallets_cents: walletTotal,
          legacy_wallets_usd: toDollars(walletTotal),
          accrued_interest_cents: accruedInterest,
          accrued_interest_usd: toDollars(accruedInterest),
          subtotal_cents: bankingTotal + walletTotal + accruedInterest,
          subtotal_usd: toDollars(bankingTotal + walletTotal + accruedInterest),
        },
        investments: {
          fixed_income_cents: holdingTotal,
          fixed_income_usd: toDollars(holdingTotal),
          holding_count: holdings.length,
          subtotal_cents: holdingTotal,
          subtotal_usd: toDollars(holdingTotal),
        },
        total_assets_cents: totalAssets,
        total_assets_usd: toDollars(totalAssets),
      },

      liabilities: {
        outstanding_payables_cents: payableTotal,
        outstanding_payables_usd: toDollars(payableTotal),
        payable_count: payables.length,
        total_liabilities_cents: payableTotal,
        total_liabilities_usd: toDollars(payableTotal),
      },

      net_worth_cents: totalAssets - payableTotal,
      net_worth_usd: toDollars(totalAssets - payableTotal),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /performance -- Portfolio performance metrics -----------------------
router.get('/performance', (req, res) => {
  try {
    const { period = '30d' } = req.query;
    let daysBack = 30;
    if (period === '7d')  daysBack = 7;
    if (period === '90d') daysBack = 90;
    if (period === '1y')  daysBack = 365;
    if (period === 'ytd') {
      const now = new Date();
      const jan1 = new Date(now.getFullYear(), 0, 1);
      daysBack = Math.ceil((now - jan1) / (1000 * 60 * 60 * 24));
    }

    const cutoff = new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);

    // Transfer activity in period
    const transferStats = safeGet(req.db, `
      SELECT
        COUNT(*) AS count,
        COALESCE(SUM(amount_cents), 0) AS total_volume_cents,
        COALESCE(SUM(fee_cents), 0) AS total_fees_cents
      FROM internal_transfers
      WHERE status = 'completed' AND date(completed_date) >= ?
    `, [cutoff]);

    // Payout activity in period
    const payoutStats = safeGet(req.db, `
      SELECT
        COUNT(*) AS count,
        COALESCE(SUM(amount_cents), 0) AS total_cents
      FROM trust_payouts
      WHERE status = 'completed' AND date(completed_date) >= ?
    `, [cutoff]);

    // Interest earned in period
    const interestStats = safeGet(req.db, `
      SELECT COALESCE(SUM(accrued_cents), 0) AS total_cents
      FROM account_interest
      WHERE date(accrual_date) >= ?
    `, [cutoff]);

    // Current balances
    const currentTotal = safeGet(req.db, `
      SELECT COALESCE(SUM(balance_cents), 0) AS total FROM trust_accounts WHERE status != 'closed'
    `);

    res.json({
      generated_at: new Date().toISOString(),
      period,
      period_start: cutoff,

      activity: {
        transfers_completed: transferStats.count || 0,
        transfer_volume_cents: transferStats.total_volume_cents || 0,
        transfer_volume_usd: toDollars(transferStats.total_volume_cents || 0),
        transfer_fees_cents: transferStats.total_fees_cents || 0,
        transfer_fees_usd: toDollars(transferStats.total_fees_cents || 0),
        payouts_completed: payoutStats.count || 0,
        payout_total_cents: payoutStats.total_cents || 0,
        payout_total_usd: toDollars(payoutStats.total_cents || 0),
      },

      income: {
        interest_earned_cents: interestStats.total_cents || 0,
        interest_earned_usd: toDollars(interestStats.total_cents || 0),
      },

      current_position: {
        total_account_balance_cents: currentTotal.total || 0,
        total_account_balance_usd: toDollars(currentTotal.total || 0),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /tax-center -- Tax reporting hub -----------------------------------
router.get('/tax-center', (req, res) => {
  try {
    const taxYear = parseInt(req.query.year) || new Date().getFullYear();

    // Tax events from banking
    const taxEvents = safeQuery(req.db, `
      SELECT * FROM tax_events WHERE tax_year = ? ORDER BY created_at DESC
    `, [taxYear]);

    // 1099 from vendor payments
    const vendorPayments = safeQuery(req.db, `
      SELECT v.vendor_name, v.tax_id, v.tax_id_type,
             COALESCE(SUM(vp.amount_cents), 0) AS total_paid_cents,
             COUNT(vp.id) AS payment_count
      FROM vendors v
      LEFT JOIN vendor_payments vp ON vp.vendor_id = v.id AND vp.status = 'completed'
        AND vp.fiscal_year = ?
      WHERE v.status = 'active'
      GROUP BY v.id
      HAVING total_paid_cents > 0
      ORDER BY total_paid_cents DESC
    `, [taxYear]);

    const threshold1099 = 60000; // $600 in cents
    const reportable = vendorPayments.filter(v => v.total_paid_cents >= threshold1099);

    // Interest income summary
    const interestSummary = safeGet(req.db, `
      SELECT COALESCE(SUM(accrued_cents), 0) AS total_cents
      FROM account_interest
      WHERE strftime('%Y', accrual_date) = ?
    `, [String(taxYear)]);

    // Distribution summary
    const distSummary = safeGet(req.db, `
      SELECT
        COUNT(*) AS count,
        COALESCE(SUM(amount_cents), 0) AS total_cents
      FROM trust_payouts
      WHERE status = 'completed' AND fiscal_year = ? AND tax_reportable = 1
    `, [taxYear]);

    res.json({
      generated_at: new Date().toISOString(),
      tax_year: taxYear,

      summary: {
        total_tax_events: taxEvents.length,
        total_interest_income_cents: interestSummary.total_cents || 0,
        total_interest_income_usd: toDollars(interestSummary.total_cents || 0),
        total_distributions_cents: distSummary.total_cents || 0,
        total_distributions_usd: toDollars(distSummary.total_cents || 0),
        distribution_count: distSummary.count || 0,
      },

      form_1099: {
        threshold_cents: threshold1099,
        reportable_vendors: reportable.length,
        vendors: reportable.map(v => ({
          vendor_name: v.vendor_name,
          tax_id: v.tax_id ? `***-***${v.tax_id.slice(-4)}` : null,
          tax_id_type: v.tax_id_type,
          total_paid_cents: v.total_paid_cents,
          total_paid_usd: toDollars(v.total_paid_cents),
          payment_count: v.payment_count,
        })),
      },

      tax_events: taxEvents.map(e => ({
        ...e,
        amount_usd: toDollars(e.amount_cents),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /compliance -- Cross-engine compliance -----------------------------
router.get('/compliance', (req, res) => {
  try {
    const issues = [];

    // KYC compliance
    const kycPending = safeQuery(req.db, `
      SELECT id, account_number, account_name, kyc_status, kyc_expiry_date
      FROM trust_accounts WHERE status = 'active' AND kyc_status != 'verified'
    `);
    for (const a of kycPending) {
      issues.push({ engine: 'banking', severity: 'high', type: 'kyc_not_verified', account: a.account_number, detail: `KYC status is ${a.kyc_status}` });
    }

    // Expired KYC
    const today = new Date().toISOString().slice(0, 10);
    const kycExpired = safeQuery(req.db, `
      SELECT id, account_number, account_name, kyc_expiry_date
      FROM trust_accounts WHERE status = 'active' AND kyc_status = 'verified' AND kyc_expiry_date IS NOT NULL AND kyc_expiry_date < ?
    `, [today]);
    for (const a of kycExpired) {
      issues.push({ engine: 'banking', severity: 'critical', type: 'kyc_expired', account: a.account_number, detail: `KYC expired on ${a.kyc_expiry_date}` });
    }

    // High-risk AML accounts
    const highRisk = safeQuery(req.db, `
      SELECT id, account_number, account_name FROM trust_accounts WHERE aml_risk_rating = 'high' AND status = 'active'
    `);
    for (const a of highRisk) {
      issues.push({ engine: 'banking', severity: 'medium', type: 'high_aml_risk', account: a.account_number, detail: 'Account rated high AML risk' });
    }

    // Overdue bills
    const overdueBills = safeQuery(req.db, `
      SELECT id, bill_number, vendor_id, balance_cents, due_date
      FROM bills WHERE status NOT IN ('paid', 'cancelled') AND due_date < ?
    `, [today]);
    for (const b of overdueBills) {
      issues.push({ engine: 'payments', severity: 'medium', type: 'overdue_bill', bill_id: b.id, detail: `Bill ${b.bill_number || b.id} overdue since ${b.due_date}, balance: ${toDollars(b.balance_cents)}` });
    }

    // Unreconciled snapshots
    const unreconciledCount = safeGet(req.db, `
      SELECT COUNT(*) AS count FROM reconciliation_snapshots WHERE reconciled = 0
    `);

    // Frozen accounts
    const frozenAccounts = safeQuery(req.db, `
      SELECT id, account_number, account_name, status_reason FROM trust_accounts WHERE status = 'frozen'
    `);
    for (const a of frozenAccounts) {
      issues.push({ engine: 'banking', severity: 'info', type: 'account_frozen', account: a.account_number, detail: a.status_reason || 'Account is frozen' });
    }

    const criticalCount = issues.filter(i => i.severity === 'critical').length;
    const highCount     = issues.filter(i => i.severity === 'high').length;

    res.json({
      generated_at: new Date().toISOString(),
      overall_status: criticalCount > 0 ? 'critical' : highCount > 0 ? 'attention_needed' : 'compliant',
      issue_count: issues.length,
      critical_count: criticalCount,
      high_count: highCount,
      unreconciled_snapshots: unreconciledCount.count || 0,
      issues,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /cashflow -- Projected cash flow -----------------------------------
router.get('/cashflow', (req, res) => {
  try {
    const { horizon = 90 } = req.query;
    const daysAhead = parseInt(horizon);
    const cutoff = new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    // Upcoming bills
    const upcomingBills = safeQuery(req.db, `
      SELECT id, bill_number, vendor_id, balance_cents, due_date, priority
      FROM bills WHERE status NOT IN ('paid', 'cancelled') AND due_date BETWEEN ? AND ?
      ORDER BY due_date
    `, [today, cutoff]);

    const totalBillOutflow = upcomingBills.reduce((s, b) => s + (b.balance_cents || 0), 0);

    // Recurring payouts due
    const recurringSchedules = safeQuery(req.db, `
      SELECT * FROM recurring_schedules WHERE status = 'active' AND next_payment_date BETWEEN ? AND ?
      ORDER BY next_payment_date
    `, [today, cutoff]);

    const totalRecurringOutflow = recurringSchedules.reduce((s, r) => s + (r.amount_cents || 0), 0);

    // Projected interest income
    const interestBearing = safeQuery(req.db, `
      SELECT id, account_number, balance_cents, interest_rate_bps
      FROM trust_accounts WHERE status = 'active' AND interest_rate_bps > 0
    `);
    let projectedInterest = 0;
    for (const a of interestBearing) {
      const annualRate = a.interest_rate_bps / 10000;
      projectedInterest += Math.round(a.balance_cents * annualRate * (daysAhead / 365));
    }

    res.json({
      generated_at: new Date().toISOString(),
      horizon_days: daysAhead,
      period_end: cutoff,

      inflows: {
        projected_interest_cents: projectedInterest,
        projected_interest_usd: toDollars(projectedInterest),
        total_inflow_cents: projectedInterest,
        total_inflow_usd: toDollars(projectedInterest),
      },

      outflows: {
        upcoming_bills: {
          count: upcomingBills.length,
          total_cents: totalBillOutflow,
          total_usd: toDollars(totalBillOutflow),
          items: upcomingBills.map(b => ({
            bill_id: b.id,
            bill_number: b.bill_number,
            amount_cents: b.balance_cents,
            amount_usd: toDollars(b.balance_cents),
            due_date: b.due_date,
            priority: b.priority,
          })),
        },
        recurring_payouts: {
          count: recurringSchedules.length,
          total_cents: totalRecurringOutflow,
          total_usd: toDollars(totalRecurringOutflow),
        },
        total_outflow_cents: totalBillOutflow + totalRecurringOutflow,
        total_outflow_usd: toDollars(totalBillOutflow + totalRecurringOutflow),
      },

      net_cashflow_cents: projectedInterest - totalBillOutflow - totalRecurringOutflow,
      net_cashflow_usd: toDollars(projectedInterest - totalBillOutflow - totalRecurringOutflow),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /activity -- Recent activity across all engines --------------------
router.get('/activity', (req, res) => {
  try {
    const { limit = 50 } = req.query;

    // Recent transfers
    const transfers = safeQuery(req.db, `
      SELECT 'transfer' AS source, id, transfer_number AS reference, amount_cents, status, created_at, description
      FROM internal_transfers ORDER BY created_at DESC LIMIT ?
    `, [parseInt(limit)]);

    // Recent payouts
    const payouts = safeQuery(req.db, `
      SELECT 'payout' AS source, id, reference_number AS reference, amount_cents, status, created_at, description
      FROM trust_payouts ORDER BY created_at DESC LIMIT ?
    `, [parseInt(limit)]);

    // Recent audit entries
    const auditEntries = safeQuery(req.db, `
      SELECT 'audit' AS source, id, event_type AS reference, entity_id, action, created_at, details AS description
      FROM banking_audit_log ORDER BY created_at DESC LIMIT ?
    `, [parseInt(limit)]);

    // Merge and sort by date
    const allActivity = [...transfers, ...payouts, ...auditEntries]
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, parseInt(limit));

    res.json({
      generated_at: new Date().toISOString(),
      count: allActivity.length,
      activity: allActivity.map(a => ({
        ...a,
        amount_usd: a.amount_cents ? toDollars(a.amount_cents) : null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Helpers ----------------------------------------------------------------

function groupBy(items, field, valueFn) {
  const groups = {};
  for (const item of items) {
    const key = item[field] || 'unknown';
    if (!groups[key]) groups[key] = { count: 0, total_cents: 0 };
    groups[key].count++;
    groups[key].total_cents += valueFn(item) || 0;
  }
  for (const key of Object.keys(groups)) {
    groups[key].total_usd = toDollars(groups[key].total_cents);
  }
  return groups;
}

module.exports = router;
