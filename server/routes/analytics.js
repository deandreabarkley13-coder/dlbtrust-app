/**
 * DLB Trust Analytics API Routes
 *
 * Mounted by server/server-3002.js as:
 *   app.use('/api/analytics', require('./routes/analytics'));
 *
 * Reads the legacy trust ledger out of PostgreSQL, in the schema that
 * server/scripts/migrateSqliteToPostgres.js copies the old SQLite file into.
 * Timestamps are stored as ISO text there, so date grouping slices the string
 * instead of casting, which keeps rows with odd values queryable.
 */

const express = require('express');
const { getMandate } = require('../integrations/trust/trustMandate');
const pool = require('../integrations/bonds/pgPool');
const router = express.Router();

const SCHEMA = process.env.LEGACY_SQLITE_SCHEMA || 'legacy_sqlite';
if (!/^[a-z_][a-z0-9_]*$/.test(SCHEMA)) {
  throw new Error('LEGACY_SQLITE_SCHEMA must be a plain lowercase identifier, got: ' + SCHEMA);
}
const WALLETS = SCHEMA + '.wallets';
const TRANSACTIONS = SCHEMA + '.transactions';

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
const toDollars = (cents) => (cents !== null && cents !== undefined) ? Math.round(cents) / 100 : null;

/** Postgres returns bigint and numeric as strings; these columns are all cents. */
const num = (value) => (value === null || value === undefined ? null : Number(value));

async function one(sql, params) {
  const res = await pool.query(sql, params);
  return res.rows[0] || {};
}

async function all(sql, params) {
  const res = await pool.query(sql, params);
  return res.rows;
}

// ─────────────────────────────────────────────────────────────
// MIDDLEWARE: the legacy ledger must be migrated before any route works
// ─────────────────────────────────────────────────────────────
const schemaState = { checkedAt: 0, ok: false, detail: null, walletColumns: [] };
const SCHEMA_TTL_MS = 30000;

async function ensureSchema() {
  if (schemaState.ok && Date.now() - schemaState.checkedAt < SCHEMA_TTL_MS) return schemaState;

  const res = await pool.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name IN ('wallets', 'transactions')`,
    [SCHEMA]
  );
  const tables = new Set(res.rows.map((r) => r.table_name));
  schemaState.checkedAt = Date.now();
  schemaState.walletColumns = res.rows.filter((r) => r.table_name === 'wallets').map((r) => r.column_name);
  schemaState.ok = tables.has('wallets') && tables.has('transactions');
  schemaState.detail = schemaState.ok
    ? null
    : 'schema ' + SCHEMA + ' has no wallets/transactions table — run: node server/scripts/migrateSqliteToPostgres.js --confirm';
  return schemaState;
}

router.use(async (req, res, next) => {
  try {
    const state = await ensureSchema();
    if (!state.ok) {
      return res.status(503).json({
        success: false,
        error: 'Analytics database not available',
        detail: state.detail,
      });
    }
    next();
  } catch (err) {
    res.status(503).json({
      success: false,
      error: 'Analytics database not available',
      detail: err.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/analytics/summary
// Overall trust financial summary
// ─────────────────────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    // Total portfolio
    const portfolioRow = await one(`
      SELECT
        SUM(fiat_balance)::float8 AS total_portfolio_cents,
        COUNT(*)::int AS total_wallets,
        SUM(CASE WHEN role = 'trust_entity' THEN fiat_balance ELSE 0 END)::float8 AS trust_balance_cents,
        SUM(CASE WHEN role = 'trustee'      THEN fiat_balance ELSE 0 END)::float8 AS trustee_balance_cents,
        SUM(CASE WHEN role = 'beneficiary'  THEN fiat_balance ELSE 0 END)::float8 AS beneficiary_balance_cents
      FROM ${WALLETS}
    `);

    // Transaction aggregates
    const txRow = await one(`
      SELECT
        COUNT(*)::int AS total_count,
        COALESCE(SUM(CASE WHEN amount >= 0 THEN amount ELSE 0 END), 0)::float8 AS total_credits_cents,
        COALESCE(SUM(CASE WHEN amount < 0  THEN ABS(amount) ELSE 0 END), 0)::float8 AS total_debits_cents,
        MAX(CASE WHEN amount >= 0 THEN amount ELSE 0 END)::float8 AS largest_credit_cents,
        MIN(CASE WHEN amount < 0  THEN amount ELSE 0 END)::float8 AS largest_debit_cents_neg
      FROM ${TRANSACTIONS}
      WHERE status = 'completed'
    `);

    // Distribution totals
    const distRow = await one(`
      SELECT
        COUNT(*)::int AS dist_count,
        SUM(ABS(amount))::float8 AS total_dist_cents,
        AVG(ABS(amount))::float8 AS avg_dist_cents
      FROM ${TRANSACTIONS}
      WHERE category = 'distribution' AND status = 'completed'
    `);

    // Interest income totals
    const interestRow = await one(`
      SELECT SUM(amount)::float8 AS total_interest_cents
      FROM ${TRANSACTIONS}
      WHERE category IN ('interest', 'investment') AND status = 'completed'
    `);

    // Management fee totals
    const feeRow = await one(`
      SELECT SUM(ABS(amount))::float8 AS total_fees_cents
      FROM ${TRANSACTIONS}
      WHERE category = 'fee' AND status = 'completed'
    `);

    // Corpus
    const corpusRow = await one(`
      SELECT SUM(amount)::float8 AS corpus_cents
      FROM ${TRANSACTIONS}
      WHERE category = 'corpus'
    `);

    // Inception date
    const inceptionRow = await one(`
      SELECT MIN(created_at) AS inception_date FROM ${TRANSACTIONS} WHERE category = 'corpus'
    `);

    const summary = {
      generated_at: new Date().toISOString(),
      trust_name: getMandate().legalName,
      inception_date: inceptionRow.inception_date || null,

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
router.get('/wallets', async (req, res) => {
  try {
    const wallets = await all(`SELECT * FROM ${WALLETS} ORDER BY id`);

    const walletStats = [];
    for (const w of wallets) {
      // Inflows to this wallet
      const inflow = await one(`
        SELECT
          COUNT(*)::int AS count,
          COALESCE(SUM(ABS(amount)), 0)::float8 AS total_cents
        FROM ${TRANSACTIONS}
        WHERE to_wallet_id = $1 AND status = 'completed'
      `, [w.wallet_id]);

      // Outflows from this wallet
      const outflow = await one(`
        SELECT
          COUNT(*)::int AS count,
          COALESCE(SUM(ABS(amount)), 0)::float8 AS total_cents
        FROM ${TRANSACTIONS}
        WHERE from_wallet_id = $1 AND status = 'completed'
      `, [w.wallet_id]);

      // Last transaction
      const lastTx = await one(`
        SELECT MAX(created_at) AS last_date
        FROM ${TRANSACTIONS}
        WHERE from_wallet_id = $1 OR to_wallet_id = $1
      `, [w.wallet_id]);

      walletStats.push({
        wallet_id: w.wallet_id,
        name: w.name,
        role: w.role,
        balance_cents: num(w.fiat_balance),
        balance_usd: toDollars(num(w.fiat_balance)),
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
      });
    }

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
router.get('/transactions', async (req, res) => {
  try {
    const { category, method, from: fromDate, to: toDate, limit = 100, offset = 0 } = req.query;

    // Build dynamic WHERE clause
    const conditions = [];
    const params = [];

    if (category) { conditions.push('category = $' + (params.length + 1)); params.push(category); }
    if (method)   { conditions.push('payment_method = $' + (params.length + 1)); params.push(method); }
    if (fromDate) { conditions.push('SUBSTR(created_at, 1, 10) >= $' + (params.length + 1)); params.push(fromDate); }
    if (toDate)   { conditions.push('SUBSTR(created_at, 1, 10) <= $' + (params.length + 1)); params.push(toDate); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    // Category breakdown
    const byCategory = await all(`
      SELECT
        category,
        COUNT(*)::int AS count,
        SUM(ABS(amount))::float8 AS total_cents,
        AVG(ABS(amount))::float8 AS avg_cents,
        MIN(created_at) AS first_date,
        MAX(created_at) AS last_date
      FROM ${TRANSACTIONS}
      ${where}
      GROUP BY category
      ORDER BY total_cents DESC
    `, params);

    // Method breakdown
    const byMethod = await all(`
      SELECT
        payment_method AS method,
        COUNT(*)::int AS count,
        SUM(ABS(amount))::float8 AS total_cents
      FROM ${TRANSACTIONS}
      ${where}
      GROUP BY payment_method
      ORDER BY count DESC
    `, params);

    // Monthly flow
    const byMonth = await all(`
      SELECT
        SUBSTR(created_at, 1, 7) AS month,
        COALESCE(SUM(CASE WHEN amount >= 0 THEN amount ELSE 0 END), 0)::float8 AS credits_cents,
        COALESCE(SUM(CASE WHEN amount < 0  THEN ABS(amount) ELSE 0 END), 0)::float8 AS debits_cents,
        COUNT(*)::int AS count
      FROM ${TRANSACTIONS}
      ${where}
      GROUP BY month
      ORDER BY month ASC
    `, params);

    // Individual transactions (paginated)
    const txList = await all(`
      SELECT
        id,
        category,
        description,
        amount::float8 AS amount,
        payment_method,
        from_wallet_id,
        to_wallet_id,
        status,
        created_at
      FROM ${TRANSACTIONS}
      ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, params.concat([parseInt(limit, 10), parseInt(offset, 10)]));

    // Total count
    const totalRow = await one(`
      SELECT COUNT(*)::int AS total FROM ${TRANSACTIONS} ${where}
    `, params);

    res.json({
      generated_at: new Date().toISOString(),
      filters: { category: category || null, method: method || null, from: fromDate || null, to: toDate || null },
      total_count: totalRow.total,
      page: { limit: parseInt(limit, 10), offset: parseInt(offset, 10) },

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
router.get('/beneficiaries', async (req, res) => {
  try {
    const beneficiaries = await all(`
      SELECT * FROM ${WALLETS} WHERE role = 'beneficiary' ORDER BY id
    `);

    const result = [];
    for (const b of beneficiaries) {
      // Total received
      const received = await one(`
        SELECT COALESCE(SUM(ABS(amount)), 0)::float8 AS total, COUNT(*)::int AS count
        FROM ${TRANSACTIONS}
        WHERE to_wallet_id = $1 AND status = 'completed'
      `, [b.wallet_id]);

      // Total disbursed
      const disbursed = await one(`
        SELECT COALESCE(SUM(ABS(amount)), 0)::float8 AS total, COUNT(*)::int AS count
        FROM ${TRANSACTIONS}
        WHERE from_wallet_id = $1 AND status = 'completed'
      `, [b.wallet_id]);

      // Last activity
      const lastTx = await one(`
        SELECT created_at AS last_date, category, payment_method
        FROM ${TRANSACTIONS}
        WHERE from_wallet_id = $1 OR to_wallet_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `, [b.wallet_id]);

      // Payment methods used
      const methods = await all(`
        SELECT payment_method, COUNT(*)::int AS count
        FROM ${TRANSACTIONS}
        WHERE from_wallet_id = $1 OR to_wallet_id = $1
        GROUP BY payment_method
      `, [b.wallet_id]);

      // Recent transactions (last 5)
      const recentTx = await all(`
        SELECT id, category, description, amount::float8 AS amount, payment_method, status, created_at
        FROM ${TRANSACTIONS}
        WHERE from_wallet_id = $1 OR to_wallet_id = $1
        ORDER BY created_at DESC
        LIMIT 5
      `, [b.wallet_id]);

      result.push({
        wallet_id: b.wallet_id,
        name: b.name,
        role: b.role,
        current_balance_cents: num(b.fiat_balance),
        current_balance_usd: toDollars(num(b.fiat_balance)),
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
        last_activity: lastTx.last_date || null,
        last_tx_category: lastTx.category || null,
        last_tx_method: lastTx.payment_method || null,
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
      });
    }

    res.json({
      generated_at: new Date().toISOString(),
      count: result.length,
      total_balance_cents: result.reduce((s, b) => s + (b.current_balance_cents || 0), 0),
      total_balance_usd: toDollars(result.reduce((s, b) => s + (b.current_balance_cents || 0), 0)),
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
router.get('/ach-readiness', async (req, res) => {
  try {
    // Bank details are an optional schema addition (see the bottom of this file),
    // so report them as absent rather than failing the whole endpoint.
    const columns = (await ensureSchema()).walletColumns;
    const flag = (column) => columns.includes(column)
      ? 'CASE WHEN ' + column + ' IS NOT NULL THEN 1 ELSE 0 END'
      : '0';

    const users = await all(`
      SELECT
        wallet_id,
        name,
        role,
        fiat_balance::float8 AS fiat_balance,
        email,
        phone,
        holder_name,
        ${flag('routing_number')} AS has_routing,
        ${flag('account_number')} AS has_account
      FROM ${WALLETS}
      ORDER BY role, id
    `);

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
          .reduce((s, u) => s + (u.current_balance_cents || 0), 0),
        total_disbursable_usd: toDollars(
          beneficiaryStatus.filter(u => u.ach_ready).reduce((s, u) => s + (u.current_balance_cents || 0), 0)
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
router.get('/distributions', async (req, res) => {
  try {
    const { year } = req.query;

    const conditions = ["category = 'distribution'", "status = 'completed'"];
    const params = [];
    if (year) { conditions.push('SUBSTR(created_at, 1, 4) = $1'); params.push(year); }
    const where = 'WHERE ' + conditions.join(' AND ');

    const distributions = await all(`
      SELECT
        id,
        description,
        amount::float8 AS amount,
        payment_method,
        from_wallet_id,
        to_wallet_id,
        status,
        created_at,
        SUBSTR(created_at, 1, 4) AS year,
        SUBSTR(created_at, 1, 7) AS month
      FROM ${TRANSACTIONS}
      ${where}
      ORDER BY created_at DESC
    `, params);

    // Annual totals
    const byYear = await all(`
      SELECT
        SUBSTR(created_at, 1, 4) AS year,
        COUNT(*)::int AS count,
        SUM(ABS(amount))::float8 AS total_cents
      FROM ${TRANSACTIONS}
      WHERE category = 'distribution' AND status = 'completed'
      GROUP BY year
      ORDER BY year
    `);

    // Monthly totals
    const byMonth = await all(`
      SELECT
        SUBSTR(created_at, 1, 4) AS year,
        SUBSTR(created_at, 6, 2) AS month_num,
        COUNT(*)::int AS count,
        SUM(ABS(amount))::float8 AS total_cents,
        AVG(ABS(amount))::float8 AS avg_cents
      FROM ${TRANSACTIONS}
      WHERE category = 'distribution' AND status = 'completed'
      GROUP BY year, month_num
      ORDER BY year, month_num
    `);

    const totalCents = distributions.reduce((s, d) => s + Math.abs(d.amount), 0);

    res.json({
      generated_at: new Date().toISOString(),
      count: distributions.length,
      total_cents: totalCents,
      total_usd: toDollars(totalCents),
      avg_cents: distributions.length ? Math.round(totalCents / distributions.length) : 0,
      avg_usd: distributions.length ? toDollars(Math.round(totalCents / distributions.length)) : 0,

      by_year: byYear.map(r => ({
        year: r.year,
        count: r.count,
        total_cents: r.total_cents,
        total_usd: toDollars(r.total_cents),
      })),

      by_period: byMonth.map(r => ({
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
router.get('/data-quality', async (req, res) => {
  try {
    const users = await all(`
      SELECT wallet_id, name, role, email, phone, holder_name
      FROM ${WALLETS}
      ORDER BY role, id
    `);

    const totalUsers = users.length;

    const missing = {
      email:   users.filter(u => !u.email).length,
      phone:   users.filter(u => !u.phone).length,
      holder_name: users.filter(u => !u.holder_name).length,
    };

    // Orphaned transactions (wallets referenced that don't exist)
    const orphanedFrom = await one(`
      SELECT COUNT(*)::int AS count FROM ${TRANSACTIONS} t
      LEFT JOIN ${WALLETS} w ON w.wallet_id = t.from_wallet_id
      WHERE t.from_wallet_id IS NOT NULL AND w.wallet_id IS NULL
    `);

    const orphanedTo = await one(`
      SELECT COUNT(*)::int AS count FROM ${TRANSACTIONS} t
      LEFT JOIN ${WALLETS} w ON w.wallet_id = t.to_wallet_id
      WHERE t.to_wallet_id IS NOT NULL AND w.wallet_id IS NULL
    `);

    // Transactions missing category
    const missingCategory = await one(`
      SELECT COUNT(*)::int AS count FROM ${TRANSACTIONS} WHERE category IS NULL OR category = ''
    `);

    const totalFields = totalUsers * Object.keys(missing).length;
    const missingTotal = Object.values(missing).reduce((a, b) => a + b, 0);
    const completenessScore = totalFields
      ? Math.round(((totalFields - missingTotal) / totalFields) * 100)
      : 0;

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
        { field: 'wallets.routing_number', type: 'text', reason: 'Required for ACH disbursements' },
        { field: 'wallets.account_number', type: 'text', reason: 'Required for ACH disbursements' },
        { field: 'wallets.account_type', type: 'text', reason: 'Checking vs savings for ACH' },
        { field: 'wallets.kyc_verified', type: 'boolean', reason: 'KYC compliance tracking' },
        { field: 'wallets.ssn_encrypted', type: 'text', reason: 'IRS 1099 reporting' },
        { field: 'wallets.date_of_birth', type: 'text', reason: 'Identity verification' },
        { field: 'wallets.mailing_address', type: 'text', reason: 'Legal correspondence' },
        { field: 'wallets.preferred_payment_method', type: 'text', reason: 'Disbursement preferences' },
        { field: 'transactions.is_test', type: 'boolean', reason: 'Separate test from production transactions' },
        { field: 'transactions.beneficiary_split', type: 'jsonb', reason: 'Per-beneficiary distribution tracking' },
      ],
    });
  } catch (err) {
    res.status(500).json({ error: 'Data quality query failed', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/analytics/gl-summary
// Fineract-backed GL summary (principal vs. income with double-entry data)
// Falls back to the legacy ledger if Fineract is unavailable
// ─────────────────────────────────────────────────────────────
router.get('/gl-summary', async (req, res) => {
  try {
    const { FineractClient } = require('../integrations/fineract/fineractClient');
    const summary = await FineractClient.getGLSummary();

    res.json({
      source: 'fineract',
      generated_at: summary.generated_at,
      total_assets: summary.total_assets,
      total_liabilities: summary.total_liabilities,
      total_equity: summary.total_equity,
      total_income: summary.total_income,
      total_expenses: summary.total_expenses,
      accounts: summary.accounts,
    });
  } catch (fineractErr) {
    // Fallback: derive a rough GL summary from the legacy ledger
    try {
      const portfolio = await one(`
        SELECT
          SUM(fiat_balance)::float8 AS total_balance_cents,
          SUM(CASE WHEN role = 'trust_entity' THEN fiat_balance ELSE 0 END)::float8 AS principal_cents,
          SUM(CASE WHEN role IN ('trustee', 'beneficiary') THEN fiat_balance ELSE 0 END)::float8 AS distributed_cents
        FROM ${WALLETS}
      `);

      const income = await one(`
        SELECT COALESCE(SUM(amount), 0)::float8 AS total_cents
        FROM ${TRANSACTIONS}
        WHERE category IN ('interest', 'investment') AND status = 'completed'
      `);

      res.json({
        source: 'legacy_ledger_fallback',
        fineract_error: fineractErr.message,
        generated_at: new Date().toISOString(),
        total_assets: toDollars(portfolio.total_balance_cents),
        principal_usd: toDollars(portfolio.principal_cents),
        distributed_usd: toDollars(portfolio.distributed_cents),
        income_usd: toDollars(income.total_cents),
        note: 'Fineract unavailable — showing the migrated legacy ledger without double-entry verification',
      });
    } catch (ledgerErr) {
      res.status(500).json({
        error: 'GL summary unavailable from both Fineract and the legacy ledger',
        fineract_error: fineractErr.message,
        legacy_ledger_error: ledgerErr.message,
      });
    }
  }
});

// ─────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────
module.exports = router;

/*
 * ─────────────────────────────────────────────────────────────
 * ENDPOINTS
 * ─────────────────────────────────────────────────────────────
 *
 *    GET /api/analytics/summary          Overall trust financial summary
 *    GET /api/analytics/wallets          All wallets with flow stats
 *    GET /api/analytics/transactions     Aggregated by category/method/month + paginated list
 *                                        Query params: category, method, from, to, limit, offset
 *    GET /api/analytics/beneficiaries    Per-beneficiary balance, flows, recent transactions
 *    GET /api/analytics/ach-readiness    Who can receive ACH, who is blocked and why
 *    GET /api/analytics/distributions    Distribution history, annual/monthly totals (?year=2025)
 *    GET /api/analytics/data-quality     Missing fields, schema recommendations
 *    GET /api/analytics/gl-summary       Fineract GL, falling back to the legacy ledger
 *
 * Column assumptions (schema LEGACY_SQLITE_SCHEMA, default legacy_sqlite):
 *    - wallets.wallet_id (text), wallets.fiat_balance (bigint, cents)
 *    - wallets.role (text: 'trust_entity'|'trustee'|'beneficiary')
 *    - transactions.amount (bigint, cents; negative = debit)
 *    - transactions.category, .payment_method, .status (text)
 *    - transactions.from_wallet_id, .to_wallet_id (text)
 *    - transactions.created_at (text, ISO 8601 — dates are grouped by SUBSTR)
 *
 * Required schema additions for full ACH readiness (absent columns report as
 * "not on file" rather than failing the endpoint):
 *    ALTER TABLE legacy_sqlite.wallets ADD COLUMN routing_number text;
 *    ALTER TABLE legacy_sqlite.wallets ADD COLUMN account_number text;
 *    ALTER TABLE legacy_sqlite.wallets ADD COLUMN account_type text DEFAULT 'checking';
 *    ALTER TABLE legacy_sqlite.wallets ADD COLUMN kyc_verified boolean DEFAULT false;
 * ─────────────────────────────────────────────────────────────
 */
