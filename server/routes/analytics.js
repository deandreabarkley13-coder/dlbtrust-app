/**
 * DLB Trust Analytics API Routes
 * File: analytics-api-routes.js
 *
 * Add these routes to your main Express server (e.g., server.js or app.js):
 *
 *   const analyticsRoutes = require('./analytics-api-routes');
 *   app.use('/api/analytics', analyticsRoutes);
 *
 * Requires: better-sqlite3 (already used by the main app)
 * Generated: 2026-04-08
 */

const express = require('express');
const router = express.Router();

// ─────────────────────────────────────────────────────────────
// DATABASE CONNECTION
// Adjust the path to match your actual DB file location
// ─────────────────────────────────────────────────────────────
const Database = require('better-sqlite3');
const path = require('path');

function getDb() {
  // Try common locations — adjust as needed
  const dbPaths = [
    path.join(__dirname, 'trust.db'),
    path.join(__dirname, 'data', 'trust.db'),
    path.join(__dirname, '..', 'trust.db'),
    '/app/trust.db',
  ];
  for (const p of dbPaths) {
    try {
      return new Database(p, { readonly: true });
    } catch (_) {}
  }
  throw new Error('Cannot find trust.db — update DB path in analytics-api-routes.js');
}

// ─────────────────────────────────────────────────────────────
// HELPER: cents → dollars
// ─────────────────────────────────────────────────────────────
const toDollars = (cents) => (cents !== null && cents !== undefined) ? Math.round(cents) / 100 : null;

// ─────────────────────────────────────────────────────────────
// MIDDLEWARE: attach DB to req, auto-close after response
// ─────────────────────────────────────────────────────────────
router.use((req, res, next) => {
  try {
    req.db = getDb();
    res.on('finish', () => { try { req.db.close(); } catch (_) {} });
    res.on('close',  () => { try { req.db.close(); } catch (_) {} });
    next();
  } catch (err) {
    res.status(500).json({ error: 'Database connection failed', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/analytics/summary
// Overall trust financial summary
// ─────────────────────────────────────────────────────────────
router.get('/summary', (req, res) => {
  try {
    const db = req.db;

    // Total portfolio
    const portfolioRow = db.prepare(`
      SELECT
        SUM(fiat_balance) AS total_portfolio_cents,
        COUNT(*) AS total_wallets,
        SUM(CASE WHEN role = 'trust_entity' THEN fiat_balance ELSE 0 END) AS trust_balance_cents,
        SUM(CASE WHEN role = 'trustee'      THEN fiat_balance ELSE 0 END) AS trustee_balance_cents,
        SUM(CASE WHEN role = 'beneficiary'  THEN fiat_balance ELSE 0 END) AS beneficiary_balance_cents
      FROM wallets
    `).get();

    // Transaction aggregates
    const txRow = db.prepare(`
      SELECT
        COUNT(*) AS total_count,
        SUM(CASE WHEN amount >= 0 THEN amount ELSE 0 END) AS total_credits_cents,
        SUM(CASE WHEN amount < 0  THEN ABS(amount) ELSE 0 END) AS total_debits_cents,
        MAX(CASE WHEN amount >= 0 THEN amount ELSE 0 END) AS largest_credit_cents,
        MIN(CASE WHEN amount < 0  THEN amount ELSE 0 END) AS largest_debit_cents_neg
      FROM transactions
      WHERE status = 'completed'
    `).get();

    // Distribution totals
    const distRow = db.prepare(`
      SELECT
        COUNT(*) AS dist_count,
        SUM(ABS(amount)) AS total_dist_cents,
        AVG(ABS(amount)) AS avg_dist_cents
      FROM transactions
      WHERE category = 'distribution' AND status = 'completed'
    `).get();

    // Interest income totals
    const interestRow = db.prepare(`
      SELECT SUM(amount) AS total_interest_cents
      FROM transactions
      WHERE category IN ('interest', 'investment') AND status = 'completed'
    `).get();

    // Management fee totals
    const feeRow = db.prepare(`
      SELECT SUM(ABS(amount)) AS total_fees_cents
      FROM transactions
      WHERE category = 'fee' AND status = 'completed'
    `).get();

    // Corpus
    const corpusRow = db.prepare(`
      SELECT SUM(amount) AS corpus_cents
      FROM transactions
      WHERE category = 'corpus'
    `).get();

    // Inception date
    const inceptionRow = db.prepare(`
      SELECT MIN(created_at) AS inception_date FROM transactions WHERE category = 'corpus'
    `).get();

    const summary = {
      generated_at: new Date().toISOString(),
      trust_name: 'DeAndrea Lavar Barkley Trust',
      inception_date: inceptionRow?.inception_date || null,

      portfolio: {
        total_cents: portfolioRow.total_portfolio_cents,
        total_usd: toDollars(portfolioRow.total_portfolio_cents),
        trust_primary_cents: portfolioRow.trust_balance_cents,
        trust_primary_usd: toDollars(portfolioRow.trust_balance_cents),
        trustee_total_cents: portfolioRow.trustee_balance_cents,
        trustee_total_usd: toDollars(portfolioRow.trustee_balance_cents),
        beneficiary_total_cents: portfolioRow.beneficiary_balance_cents,
        beneficiary_total_usd: toDollars(portfolioRow.beneficiary_balance_cents),
        total_wallets: portfolioRow.total_wallets,
      },

      corpus: {
        original_cents: corpusRow.corpus_cents,
        original_usd: toDollars(corpusRow.corpus_cents),
      },

      transactions: {
        total_count: txRow.total_count,
        total_credits_cents: txRow.total_credits_cents,
        total_credits_usd: toDollars(txRow.total_credits_cents),
        total_debits_cents: txRow.total_debits_cents,
        total_debits_usd: toDollars(txRow.total_debits_cents),
        net_flow_cents: txRow.total_credits_cents - txRow.total_debits_cents,
        net_flow_usd: toDollars(txRow.total_credits_cents - txRow.total_debits_cents),
        largest_credit_cents: txRow.largest_credit_cents,
        largest_credit_usd: toDollars(txRow.largest_credit_cents),
        largest_debit_cents: txRow.largest_debit_cents_neg ? Math.abs(txRow.largest_debit_cents_neg) : null,
        largest_debit_usd: txRow.largest_debit_cents_neg ? toDollars(Math.abs(txRow.largest_debit_cents_neg)) : null,
      },

      distributions: {
        count: distRow.dist_count,
        total_cents: distRow.total_dist_cents,
        total_usd: toDollars(distRow.total_dist_cents),
        average_cents: distRow.avg_dist_cents ? Math.round(distRow.avg_dist_cents) : null,
        average_usd: toDollars(distRow.avg_dist_cents),
      },

      interest_income: {
        total_cents: interestRow.total_interest_cents,
        total_usd: toDollars(interestRow.total_interest_cents),
        effective_yield_pct: corpusRow.corpus_cents
          ? Math.round((interestRow.total_interest_cents / corpusRow.corpus_cents) * 10000) / 100
          : null,
      },

      management_fees: {
        total_cents: feeRow.total_fees_cents,
        total_usd: toDollars(feeRow.total_fees_cents),
      },
    };

    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: 'Summary query failed', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/analytics/wallets
// Per-wallet breakdown with flow stats
// ─────────────────────────────────────────────────────────────
router.get('/wallets', (req, res) => {
  try {
    const db = req.db;

    const wallets = db.prepare(`SELECT * FROM wallets ORDER BY id`).all();

    const walletStats = wallets.map(w => {
      // Inflows to this wallet
      const inflow = db.prepare(`
        SELECT
          COUNT(*) AS count,
          COALESCE(SUM(ABS(amount)), 0) AS total_cents
        FROM transactions
        WHERE to_wallet_id = ? AND status = 'completed'
      `).get(w.wallet_id);

      // Outflows from this wallet
      const outflow = db.prepare(`
        SELECT
          COUNT(*) AS count,
          COALESCE(SUM(ABS(amount)), 0) AS total_cents
        FROM transactions
        WHERE from_wallet_id = ? AND status = 'completed'
      `).get(w.wallet_id);

      // Last transaction
      const lastTx = db.prepare(`
        SELECT MAX(created_at) AS last_date
        FROM transactions
        WHERE from_wallet_id = ? OR to_wallet_id = ?
      `).get(w.wallet_id, w.wallet_id);

      return {
        wallet_id: w.wallet_id,
        name: w.name,
        role: w.role,
        balance_cents: w.fiat_balance,
        balance_usd: toDollars(w.fiat_balance),
        currency: w.currency || 'USD',
        status: w.status || 'active',
        email: w.email || null,
        phone: w.phone || null,
        holder_name: w.holder_name || null,
        public_address: w.public_address || null,
        total_received_cents: inflow.total_cents,
        total_received_usd: toDollars(inflow.total_cents),
        total_sent_cents: outflow.total_cents,
        total_sent_usd: toDollars(outflow.total_cents),
        inflow_count: inflow.count,
        outflow_count: outflow.count,
        transaction_count: inflow.count + outflow.count,
        last_activity: lastTx.last_date || null,
      };
    });

    res.json({
      generated_at: new Date().toISOString(),
      count: walletStats.length,
      wallets: walletStats,
    });
  } catch (err) {
    res.status(500).json({ error: 'Wallets query failed', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/analytics/transactions
// Aggregated transaction data — by category, method, month
// Query params: ?category=distribution&method=ach&from=2024-01-01&to=2025-12-31
// ─────────────────────────────────────────────────────────────
router.get('/transactions', (req, res) => {
  try {
    const db = req.db;
    const { category, method, from: fromDate, to: toDate, limit = 100, offset = 0 } = req.query;

    // Build dynamic WHERE clause
    const conditions = [];
    const params = [];

    if (category) { conditions.push('category = ?'); params.push(category); }
    if (method)   { conditions.push('payment_method = ?'); params.push(method); }
    if (fromDate) { conditions.push('DATE(created_at) >= ?'); params.push(fromDate); }
    if (toDate)   { conditions.push('DATE(created_at) <= ?'); params.push(toDate); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    // Category breakdown
    const byCategory = db.prepare(`
      SELECT
        category,
        COUNT(*) AS count,
        SUM(ABS(amount)) AS total_cents,
        AVG(ABS(amount)) AS avg_cents,
        MIN(created_at) AS first_date,
        MAX(created_at) AS last_date
      FROM transactions
      ${where}
      GROUP BY category
      ORDER BY total_cents DESC
    `).all(...params);

    // Method breakdown
    const byMethod = db.prepare(`
      SELECT
        payment_method AS method,
        COUNT(*) AS count,
        SUM(ABS(amount)) AS total_cents
      FROM transactions
      ${where}
      GROUP BY payment_method
      ORDER BY count DESC
    `).all(...params);

    // Monthly flow
    const byMonth = db.prepare(`
      SELECT
        STRFTIME('%Y-%m', created_at) AS month,
        SUM(CASE WHEN amount >= 0 THEN amount ELSE 0 END) AS credits_cents,
        SUM(CASE WHEN amount < 0  THEN ABS(amount) ELSE 0 END) AS debits_cents,
        COUNT(*) AS count
      FROM transactions
      ${where}
      GROUP BY month
      ORDER BY month ASC
    `).all(...params);

    // Individual transactions (paginated)
    const txList = db.prepare(`
      SELECT
        id,
        category,
        description,
        amount,
        payment_method,
        from_wallet_id,
        to_wallet_id,
        status,
        created_at
      FROM transactions
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), parseInt(offset));

    // Total count
    const totalRow = db.prepare(`
      SELECT COUNT(*) AS total FROM transactions ${where}
    `).get(...params);

    res.json({
      generated_at: new Date().toISOString(),
      filters: { category: category || null, method: method || null, from: fromDate || null, to: toDate || null },
      total_count: totalRow.total,
      page: { limit: parseInt(limit), offset: parseInt(offset) },

      by_category: byCategory.map(r => ({
        category: r.category,
        count: r.count,
        total_cents: r.total_cents,
        total_usd: toDollars(r.total_cents),
        avg_cents: Math.round(r.avg_cents),
        avg_usd: toDollars(Math.round(r.avg_cents)),
        first_date: r.first_date,
        last_date: r.last_date,
      })),

      by_method: byMethod.map(r => ({
        method: r.method,
        count: r.count,
        total_cents: r.total_cents,
        total_usd: toDollars(r.total_cents),
      })),

      monthly_flows: byMonth.map(r => ({
        month: r.month,
        credits_cents: r.credits_cents,
        credits_usd: toDollars(r.credits_cents),
        debits_cents: r.debits_cents,
        debits_usd: toDollars(r.debits_cents),
        net_cents: r.credits_cents - r.debits_cents,
        net_usd: toDollars(r.credits_cents - r.debits_cents),
        count: r.count,
      })),

      transactions: txList.map(t => ({
        id: t.id,
        category: t.category,
        description: t.description,
        amount_cents: t.amount,
        amount_usd: toDollars(Math.abs(t.amount)),
        direction: t.amount >= 0 ? 'credit' : 'debit',
        method: t.payment_method,
        from_wallet: t.from_wallet_id,
        to_wallet: t.to_wallet_id,
        status: t.status,
        date: t.created_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Transactions query failed', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/analytics/beneficiaries
// Per-beneficiary balance, allocation, disbursement analysis
// ─────────────────────────────────────────────────────────────
router.get('/beneficiaries', (req, res) => {
  try {
    const db = req.db;

    const beneficiaries = db.prepare(`
      SELECT * FROM wallets WHERE role = 'beneficiary' ORDER BY id
    `).all();

    const result = beneficiaries.map(b => {
      // Total received
      const received = db.prepare(`
        SELECT COALESCE(SUM(ABS(amount)), 0) AS total, COUNT(*) AS count
        FROM transactions
        WHERE to_wallet_id = ? AND status = 'completed'
      `).get(b.wallet_id);

      // Total disbursed
      const disbursed = db.prepare(`
        SELECT COALESCE(SUM(ABS(amount)), 0) AS total, COUNT(*) AS count
        FROM transactions
        WHERE from_wallet_id = ? AND status = 'completed'
      `).get(b.wallet_id);

      // Last activity
      const lastTx = db.prepare(`
        SELECT MAX(created_at) AS last_date, category, payment_method
        FROM transactions
        WHERE from_wallet_id = ? OR to_wallet_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(b.wallet_id, b.wallet_id);

      // Payment methods used
      const methods = db.prepare(`
        SELECT payment_method, COUNT(*) AS count
        FROM transactions
        WHERE from_wallet_id = ? OR to_wallet_id = ?
        GROUP BY payment_method
      `).all(b.wallet_id, b.wallet_id);

      // Recent transactions (last 5)
      const recentTx = db.prepare(`
        SELECT id, category, description, amount, payment_method, status, created_at
        FROM transactions
        WHERE from_wallet_id = ? OR to_wallet_id = ?
        ORDER BY created_at DESC
        LIMIT 5
      `).all(b.wallet_id, b.wallet_id);

      return {
        wallet_id: b.wallet_id,
        name: b.name,
        role: b.role,
        current_balance_cents: b.fiat_balance,
        current_balance_usd: toDollars(b.fiat_balance),
        currency: b.currency || 'USD',
        // Profile completeness
        email: b.email || null,
        phone: b.phone || null,
        holder_name: b.holder_name || null,
        // Financials
        total_received_cents: received.total,
        total_received_usd: toDollars(received.total),
        inflow_count: received.count,
        total_disbursed_cents: disbursed.total,
        total_disbursed_usd: toDollars(disbursed.total),
        outflow_count: disbursed.count,
        net_position_cents: received.total - disbursed.total,
        net_position_usd: toDollars(received.total - disbursed.total),
        // Activity
        last_activity: lastTx?.last_date || null,
        last_tx_category: lastTx?.category || null,
        last_tx_method: lastTx?.payment_method || null,
        payment_methods_used: methods.reduce((acc, m) => {
          acc[m.payment_method] = m.count;
          return acc;
        }, {}),
        recent_transactions: recentTx.map(t => ({
          id: t.id,
          category: t.category,
          description: t.description,
          amount_cents: t.amount,
          amount_usd: toDollars(Math.abs(t.amount)),
          direction: t.amount >= 0 ? 'credit' : 'debit',
          method: t.payment_method,
          status: t.status,
          date: t.created_at,
        })),
      };
    });

    res.json({
      generated_at: new Date().toISOString(),
      count: result.length,
      total_balance_cents: result.reduce((s, b) => s + b.current_balance_cents, 0),
      total_balance_usd: toDollars(result.reduce((s, b) => s + b.current_balance_cents, 0)),
      total_distributed_cents: result.reduce((s, b) => s + b.total_disbursed_cents, 0),
      total_distributed_usd: toDollars(result.reduce((s, b) => s + b.total_disbursed_cents, 0)),
      beneficiaries: result,
    });
  } catch (err) {
    res.status(500).json({ error: 'Beneficiaries query failed', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/analytics/ach-readiness
// Which beneficiaries can receive ACH disbursements
// ─────────────────────────────────────────────────────────────
router.get('/ach-readiness', (req, res) => {
  try {
    const db = req.db;

    // Fetch all beneficiaries and trustees
    const users = db.prepare(`
      SELECT
        w.wallet_id,
        w.name,
        w.role,
        w.fiat_balance,
        w.email,
        w.phone,
        w.holder_name,
        -- These columns may not exist yet — use CASE to handle gracefully
        -- Add routing_number and account_number columns to your wallets table
        -- or create a separate bank_accounts table
        CASE WHEN EXISTS(
          SELECT 1 FROM wallets ba WHERE ba.wallet_id = w.wallet_id AND ba.routing_number IS NOT NULL
        ) THEN 1 ELSE 0 END AS has_routing,
        CASE WHEN EXISTS(
          SELECT 1 FROM wallets ba WHERE ba.wallet_id = w.wallet_id AND ba.account_number IS NOT NULL
        ) THEN 1 ELSE 0 END AS has_account
      FROM wallets w
      ORDER BY w.role, w.id
    `).all();

    // Alternate query if bank details are in a separate table:
    // SELECT w.*, ba.routing_number, ba.account_number
    // FROM wallets w LEFT JOIN bank_accounts ba ON ba.wallet_id = w.wallet_id

    const withStatus = users.map(u => {
      const blockers = [];
      if (!u.email)       blockers.push('email');
      if (!u.phone)       blockers.push('phone');
      if (!u.has_routing) blockers.push('routing_number');
      if (!u.has_account) blockers.push('bank_account');

      return {
        wallet_id: u.wallet_id,
        name: u.name,
        display_name: u.holder_name || u.name,
        role: u.role,
        current_balance_cents: u.fiat_balance,
        current_balance_usd: toDollars(u.fiat_balance),
        email: u.email || null,
        phone: u.phone || null,
        routing_on_file: !!u.has_routing,
        account_on_file: !!u.has_account,
        ach_ready: !u.email ? false : (!!u.has_routing && !!u.has_account),
        blockers,
        action_required: blockers.length > 0
          ? `Collect: ${blockers.join(', ')}`
          : 'No action required — ready for ACH',
      };
    });

    const beneficiaryStatus = withStatus.filter(u => u.role === 'beneficiary');
    const readyCount   = beneficiaryStatus.filter(u => u.ach_ready).length;
    const pendingCount = beneficiaryStatus.filter(u => !u.ach_ready).length;

    res.json({
      generated_at: new Date().toISOString(),
      summary: {
        total_beneficiaries: beneficiaryStatus.length,
        ach_ready_count: readyCount,
        ach_pending_count: pendingCount,
        readiness_pct: beneficiaryStatus.length
          ? Math.round((readyCount / beneficiaryStatus.length) * 100)
          : 0,
        total_disbursable_cents: beneficiaryStatus
          .filter(u => u.ach_ready)
          .reduce((s, u) => s + u.current_balance_cents, 0),
        total_disbursable_usd: toDollars(
          beneficiaryStatus.filter(u => u.ach_ready).reduce((s, u) => s + u.current_balance_cents, 0)
        ),
      },
      all_users: withStatus,
      ach_ready: beneficiaryStatus.filter(u => u.ach_ready),
      ach_pending: beneficiaryStatus.filter(u => !u.ach_ready),
    });
  } catch (err) {
    res.status(500).json({ error: 'ACH readiness query failed', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/analytics/distributions
// Distribution history with trends
// ─────────────────────────────────────────────────────────────
router.get('/distributions', (req, res) => {
  try {
    const db = req.db;
    const { year } = req.query;

    const conditions = ["category = 'distribution'", "status = 'completed'"];
    const params = [];
    if (year) { conditions.push("STRFTIME('%Y', created_at) = ?"); params.push(year); }
    const where = 'WHERE ' + conditions.join(' AND ');

    const distributions = db.prepare(`
      SELECT
        id,
        description,
        amount,
        payment_method,
        from_wallet_id,
        to_wallet_id,
        status,
        created_at,
        STRFTIME('%Y', created_at) AS year,
        STRFTIME('%Y-%m', created_at) AS month,
        STRFTIME('%Q', created_at) AS quarter
      FROM transactions
      ${where}
      ORDER BY created_at DESC
    `).all(...params);

    // Annual totals
    const byYear = db.prepare(`
      SELECT
        STRFTIME('%Y', created_at) AS year,
        COUNT(*) AS count,
        SUM(ABS(amount)) AS total_cents
      FROM transactions
      WHERE category = 'distribution' AND status = 'completed'
      GROUP BY year
      ORDER BY year
    `).all();

    // Quarterly totals
    const byQuarter = db.prepare(`
      SELECT
        STRFTIME('%Y', created_at) AS year,
        STRFTIME('%m', created_at) AS month_num,
        COUNT(*) AS count,
        SUM(ABS(amount)) AS total_cents,
        AVG(ABS(amount)) AS avg_cents
      FROM transactions
      WHERE category = 'distribution' AND status = 'completed'
      GROUP BY year, month_num
      ORDER BY year, month_num
    `).all();

    res.json({
      generated_at: new Date().toISOString(),
      count: distributions.length,
      total_cents: distributions.reduce((s, d) => s + Math.abs(d.amount), 0),
      total_usd: toDollars(distributions.reduce((s, d) => s + Math.abs(d.amount), 0)),
      avg_cents: distributions.length
        ? Math.round(distributions.reduce((s, d) => s + Math.abs(d.amount), 0) / distributions.length)
        : 0,
      avg_usd: distributions.length
        ? toDollars(Math.round(distributions.reduce((s, d) => s + Math.abs(d.amount), 0) / distributions.length))
        : 0,

      by_year: byYear.map(r => ({
        year: r.year,
        count: r.count,
        total_cents: r.total_cents,
        total_usd: toDollars(r.total_cents),
      })),

      by_period: byQuarter.map(r => ({
        year: r.year,
        month: r.month_num,
        count: r.count,
        total_cents: r.total_cents,
        total_usd: toDollars(r.total_cents),
        avg_cents: Math.round(r.avg_cents),
        avg_usd: toDollars(Math.round(r.avg_cents)),
      })),

      distributions: distributions.map(d => ({
        id: d.id,
        description: d.description,
        amount_cents: Math.abs(d.amount),
        amount_usd: toDollars(Math.abs(d.amount)),
        method: d.payment_method,
        from_wallet: d.from_wallet_id,
        to_wallet: d.to_wallet_id,
        status: d.status,
        date: d.created_at,
        year: d.year,
        month: d.month,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Distributions query failed', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/analytics/data-quality
// Profile completeness and missing field audit
// ─────────────────────────────────────────────────────────────
router.get('/data-quality', (req, res) => {
  try {
    const db = req.db;

    const users = db.prepare(`
      SELECT wallet_id, name, role, email, phone, holder_name
      FROM wallets
      ORDER BY role, id
    `).all();

    const totalUsers = users.length;

    const missing = {
      email:   users.filter(u => !u.email).length,
      phone:   users.filter(u => !u.phone).length,
      holder_name: users.filter(u => !u.holder_name).length,
      // routing_number and account_number require those columns to exist:
      // routing_number: users.filter(u => !u.routing_number).length,
      // account_number: users.filter(u => !u.account_number).length,
    };

    // Orphaned transactions (wallets referenced that don't exist)
    const orphanedFrom = db.prepare(`
      SELECT COUNT(*) AS count FROM transactions t
      LEFT JOIN wallets w ON w.wallet_id = t.from_wallet_id
      WHERE t.from_wallet_id IS NOT NULL AND w.wallet_id IS NULL
    `).get();

    const orphanedTo = db.prepare(`
      SELECT COUNT(*) AS count FROM transactions t
      LEFT JOIN wallets w ON w.wallet_id = t.to_wallet_id
      WHERE t.to_wallet_id IS NOT NULL AND w.wallet_id IS NULL
    `).get();

    // Transactions missing category
    const missingCategory = db.prepare(`
      SELECT COUNT(*) AS count FROM transactions WHERE category IS NULL OR category = ''
    `).get();

    const totalFields = totalUsers * Object.keys(missing).length;
    const missingTotal = Object.values(missing).reduce((a, b) => a + b, 0);
    const completenessScore = Math.round(((totalFields - missingTotal) / totalFields) * 100);

    res.json({
      generated_at: new Date().toISOString(),
      user_profile_quality: {
        total_users: totalUsers,
        missing_fields: missing,
        completeness_score_pct: completenessScore,
        users_with_issues: users.filter(u => !u.email || !u.phone || !u.holder_name).map(u => ({
          wallet_id: u.wallet_id,
          name: u.name,
          role: u.role,
          missing: [
            ...(!u.email ? ['email'] : []),
            ...(!u.phone ? ['phone'] : []),
            ...(!u.holder_name ? ['holder_name'] : []),
          ],
        })),
      },
      transaction_quality: {
        orphaned_from_wallet: orphanedFrom.count,
        orphaned_to_wallet: orphanedTo.count,
        missing_category: missingCategory.count,
      },
      recommended_schema_additions: [
        { field: 'wallets.routing_number', type: 'TEXT', reason: 'Required for ACH disbursements' },
        { field: 'wallets.account_number', type: 'TEXT', reason: 'Required for ACH disbursements' },
        { field: 'wallets.account_type', type: 'TEXT', reason: 'Checking vs savings for ACH' },
        { field: 'wallets.kyc_verified', type: 'INTEGER (boolean)', reason: 'KYC compliance tracking' },
        { field: 'wallets.ssn_encrypted', type: 'TEXT', reason: 'IRS 1099 reporting' },
        { field: 'wallets.date_of_birth', type: 'TEXT', reason: 'Identity verification' },
        { field: 'wallets.mailing_address', type: 'TEXT', reason: 'Legal correspondence' },
        { field: 'wallets.preferred_payment_method', type: 'TEXT', reason: 'Disbursement preferences' },
        { field: 'transactions.is_test', type: 'INTEGER (boolean)', reason: 'Separate test from production transactions' },
        { field: 'transactions.beneficiary_split', type: 'TEXT (JSON)', reason: 'Per-beneficiary distribution tracking' },
      ],
    });
  } catch (err) {
    res.status(500).json({ error: 'Data quality query failed', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────
module.exports = router;

/*
 * ─────────────────────────────────────────────────────────────
 * INTEGRATION INSTRUCTIONS
 * ─────────────────────────────────────────────────────────────
 *
 * 1. Copy this file to your server directory (same level as server.js)
 *
 * 2. In server.js, add:
 *
 *      const analyticsRoutes = require('./analytics-api-routes');
 *      app.use('/api/analytics', analyticsRoutes);
 *
 * 3. Available endpoints:
 *
 *    GET /api/analytics/summary
 *      → Overall trust financial summary
 *
 *    GET /api/analytics/wallets
 *      → All 8 wallets with flow stats
 *
 *    GET /api/analytics/transactions
 *      → Aggregated by category/method/month + paginated list
 *      → Query params: category, method, from, to, limit, offset
 *
 *    GET /api/analytics/beneficiaries
 *      → Per-beneficiary balance, flows, recent transactions
 *
 *    GET /api/analytics/ach-readiness
 *      → Who can receive ACH, who is blocked and why
 *
 *    GET /api/analytics/distributions
 *      → Distribution history, annual/quarterly totals
 *      → Query param: year (e.g. ?year=2025)
 *
 *    GET /api/analytics/data-quality
 *      → Missing fields, schema recommendations
 *
 * 4. Column name assumptions:
 *    - wallets.wallet_id (TEXT PK)
 *    - wallets.fiat_balance (INTEGER, cents)
 *    - wallets.role (TEXT: 'trust_entity'|'trustee'|'beneficiary')
 *    - transactions.amount (INTEGER, cents; negative = debit)
 *    - transactions.category (TEXT)
 *    - transactions.payment_method (TEXT)
 *    - transactions.from_wallet_id (TEXT FK)
 *    - transactions.to_wallet_id (TEXT FK)
 *    - transactions.created_at (TEXT ISO date)
 *    - transactions.status (TEXT: 'completed'|'pending'|etc.)
 *
 *    If column names differ in your schema, update the SQL queries above.
 *
 * 5. Required schema additions for full ACH readiness:
 *    ALTER TABLE wallets ADD COLUMN routing_number TEXT;
 *    ALTER TABLE wallets ADD COLUMN account_number TEXT;
 *    ALTER TABLE wallets ADD COLUMN account_type TEXT DEFAULT 'checking';
 *    ALTER TABLE wallets ADD COLUMN kyc_verified INTEGER DEFAULT 0;
 *    ALTER TABLE wallets ADD COLUMN ssn_encrypted TEXT;
 *    ALTER TABLE wallets ADD COLUMN date_of_birth TEXT;
 *    ALTER TABLE wallets ADD COLUMN mailing_address TEXT;
 *    ALTER TABLE wallets ADD COLUMN preferred_payment_method TEXT DEFAULT 'ach';
 *    ALTER TABLE transactions ADD COLUMN is_test INTEGER DEFAULT 0;
 * ─────────────────────────────────────────────────────────────
 */
