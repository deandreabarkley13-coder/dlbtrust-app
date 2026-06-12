/**
 * DLB Trust Analytics API Routes (PostgreSQL)
 *
 *   const analyticsRoutes = require('./routes/analytics');
 *   app.use('/api/analytics', analyticsRoutes);
 */

'use strict';

const express = require('express');
const router = express.Router();
const pool = require('../db');

const toDollars = (cents) =>
  cents !== null && cents !== undefined ? Math.round(cents) / 100 : null;

// ─── GET /api/analytics/summary ──────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const portfolioRow = (await pool.query(`
      SELECT
        SUM(fiat_balance)                                         AS total_portfolio_cents,
        COUNT(*)                                                  AS total_wallets,
        SUM(CASE WHEN role = 'trust_entity' THEN fiat_balance ELSE 0 END) AS trust_balance_cents,
        SUM(CASE WHEN role = 'trustee'      THEN fiat_balance ELSE 0 END) AS trustee_balance_cents,
        SUM(CASE WHEN role = 'beneficiary'  THEN fiat_balance ELSE 0 END) AS beneficiary_balance_cents
      FROM wallets
    `)).rows[0];

    const txRow = (await pool.query(`
      SELECT
        COUNT(*)                                                 AS total_count,
        SUM(CASE WHEN amount >= 0 THEN amount ELSE 0 END)       AS total_credits_cents,
        SUM(CASE WHEN amount <  0 THEN ABS(amount) ELSE 0 END)  AS total_debits_cents,
        MAX(CASE WHEN amount >= 0 THEN amount ELSE 0 END)       AS largest_credit_cents,
        MIN(CASE WHEN amount <  0 THEN amount ELSE 0 END)       AS largest_debit_cents_neg
      FROM transactions
      WHERE status = 'completed'
    `)).rows[0];

    const distRow = (await pool.query(`
      SELECT
        COUNT(*)            AS dist_count,
        SUM(ABS(amount))    AS total_dist_cents,
        AVG(ABS(amount))    AS avg_dist_cents
      FROM transactions
      WHERE category = 'distribution' AND status = 'completed'
    `)).rows[0];

    const interestRow = (await pool.query(`
      SELECT SUM(amount) AS total_interest_cents
      FROM transactions
      WHERE category IN ('interest', 'investment') AND status = 'completed'
    `)).rows[0];

    const feeRow = (await pool.query(`
      SELECT SUM(ABS(amount)) AS total_fees_cents
      FROM transactions
      WHERE category = 'fee' AND status = 'completed'
    `)).rows[0];

    const corpusRow = (await pool.query(`
      SELECT SUM(amount) AS corpus_cents
      FROM transactions
      WHERE category = 'corpus'
    `)).rows[0];

    const inceptionRow = (await pool.query(`
      SELECT MIN(created_at) AS inception_date FROM transactions WHERE category = 'corpus'
    `)).rows[0];

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
        total_wallets: parseInt(portfolioRow.total_wallets, 10),
      },

      corpus: {
        original_cents: corpusRow.corpus_cents,
        original_usd: toDollars(corpusRow.corpus_cents),
      },

      transactions: {
        total_count: parseInt(txRow.total_count, 10),
        total_credits_cents: txRow.total_credits_cents,
        total_credits_usd: toDollars(txRow.total_credits_cents),
        total_debits_cents: txRow.total_debits_cents,
        total_debits_usd: toDollars(txRow.total_debits_cents),
        net_flow_cents: (txRow.total_credits_cents || 0) - (txRow.total_debits_cents || 0),
        net_flow_usd: toDollars((txRow.total_credits_cents || 0) - (txRow.total_debits_cents || 0)),
        largest_credit_cents: txRow.largest_credit_cents,
        largest_credit_usd: toDollars(txRow.largest_credit_cents),
        largest_debit_cents: txRow.largest_debit_cents_neg ? Math.abs(txRow.largest_debit_cents_neg) : null,
        largest_debit_usd: txRow.largest_debit_cents_neg ? toDollars(Math.abs(txRow.largest_debit_cents_neg)) : null,
      },

      distributions: {
        count: parseInt(distRow.dist_count, 10),
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

// ─── GET /api/analytics/wallets ──────────────────────────────────────────────
router.get('/wallets', async (req, res) => {
  try {
    const { rows: wallets } = await pool.query('SELECT * FROM wallets ORDER BY id');

    const walletStats = await Promise.all(wallets.map(async (w) => {
      const inflow = (await pool.query(`
        SELECT COUNT(*) AS count, COALESCE(SUM(ABS(amount)), 0) AS total_cents
        FROM transactions WHERE to_wallet_id = $1 AND status = 'completed'
      `, [w.wallet_id])).rows[0];

      const outflow = (await pool.query(`
        SELECT COUNT(*) AS count, COALESCE(SUM(ABS(amount)), 0) AS total_cents
        FROM transactions WHERE from_wallet_id = $1 AND status = 'completed'
      `, [w.wallet_id])).rows[0];

      const lastTx = (await pool.query(`
        SELECT MAX(created_at) AS last_date
        FROM transactions WHERE from_wallet_id = $1 OR to_wallet_id = $1
      `, [w.wallet_id])).rows[0];

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
        total_received_cents: parseInt(inflow.total_cents, 10),
        total_received_usd: toDollars(parseInt(inflow.total_cents, 10)),
        total_sent_cents: parseInt(outflow.total_cents, 10),
        total_sent_usd: toDollars(parseInt(outflow.total_cents, 10)),
        inflow_count: parseInt(inflow.count, 10),
        outflow_count: parseInt(outflow.count, 10),
        transaction_count: parseInt(inflow.count, 10) + parseInt(outflow.count, 10),
        last_activity: lastTx.last_date || null,
      };
    }));

    res.json({
      generated_at: new Date().toISOString(),
      count: walletStats.length,
      wallets: walletStats,
    });
  } catch (err) {
    res.status(500).json({ error: 'Wallets query failed', detail: err.message });
  }
});

// ─── GET /api/analytics/transactions ─────────────────────────────────────────
router.get('/transactions', async (req, res) => {
  try {
    const { category, method, from: fromDate, to: toDate, limit = 100, offset = 0 } = req.query;

    const conditions = [];
    const params = [];
    let n = 1;

    if (category) { conditions.push(`category = $${n++}`); params.push(category); }
    if (method)   { conditions.push(`payment_method = $${n++}`); params.push(method); }
    if (fromDate) { conditions.push(`created_at::DATE >= $${n++}`); params.push(fromDate); }
    if (toDate)   { conditions.push(`created_at::DATE <= $${n++}`); params.push(toDate); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const byCategory = (await pool.query(`
      SELECT category, COUNT(*) AS count, SUM(ABS(amount)) AS total_cents,
        AVG(ABS(amount)) AS avg_cents, MIN(created_at) AS first_date, MAX(created_at) AS last_date
      FROM transactions ${where}
      GROUP BY category ORDER BY total_cents DESC
    `, params)).rows;

    const byMethod = (await pool.query(`
      SELECT payment_method AS method, COUNT(*) AS count, SUM(ABS(amount)) AS total_cents
      FROM transactions ${where}
      GROUP BY payment_method ORDER BY count DESC
    `, params)).rows;

    const byMonth = (await pool.query(`
      SELECT TO_CHAR(created_at, 'YYYY-MM') AS month,
        SUM(CASE WHEN amount >= 0 THEN amount ELSE 0 END) AS credits_cents,
        SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) AS debits_cents,
        COUNT(*) AS count
      FROM transactions ${where}
      GROUP BY month ORDER BY month ASC
    `, params)).rows;

    const limitN = n++;
    const offsetN = n++;
    const txList = (await pool.query(`
      SELECT id, category, description, amount, payment_method,
        from_wallet_id, to_wallet_id, status, created_at
      FROM transactions ${where}
      ORDER BY created_at DESC
      LIMIT $${limitN} OFFSET $${offsetN}
    `, [...params, parseInt(limit), parseInt(offset)])).rows;

    const totalRow = (await pool.query(`
      SELECT COUNT(*) AS total FROM transactions ${where}
    `, params)).rows[0];

    res.json({
      generated_at: new Date().toISOString(),
      filters: { category: category || null, method: method || null, from: fromDate || null, to: toDate || null },
      total_count: parseInt(totalRow.total, 10),
      page: { limit: parseInt(limit), offset: parseInt(offset) },

      by_category: byCategory.map(r => ({
        category: r.category,
        count: parseInt(r.count, 10),
        total_cents: parseInt(r.total_cents, 10),
        total_usd: toDollars(parseInt(r.total_cents, 10)),
        avg_cents: Math.round(parseFloat(r.avg_cents)),
        avg_usd: toDollars(Math.round(parseFloat(r.avg_cents))),
        first_date: r.first_date,
        last_date: r.last_date,
      })),

      by_method: byMethod.map(r => ({
        method: r.method,
        count: parseInt(r.count, 10),
        total_cents: parseInt(r.total_cents, 10),
        total_usd: toDollars(parseInt(r.total_cents, 10)),
      })),

      monthly_flows: byMonth.map(r => ({
        month: r.month,
        credits_cents: parseInt(r.credits_cents, 10),
        credits_usd: toDollars(parseInt(r.credits_cents, 10)),
        debits_cents: parseInt(r.debits_cents, 10),
        debits_usd: toDollars(parseInt(r.debits_cents, 10)),
        net_cents: parseInt(r.credits_cents, 10) - parseInt(r.debits_cents, 10),
        net_usd: toDollars(parseInt(r.credits_cents, 10) - parseInt(r.debits_cents, 10)),
        count: parseInt(r.count, 10),
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

// ─── GET /api/analytics/beneficiaries ────────────────────────────────────────
router.get('/beneficiaries', async (req, res) => {
  try {
    const { rows: beneficiaries } = await pool.query(
      "SELECT * FROM wallets WHERE role = 'beneficiary' ORDER BY id"
    );

    const result = await Promise.all(beneficiaries.map(async (b) => {
      const received = (await pool.query(`
        SELECT COALESCE(SUM(ABS(amount)), 0) AS total, COUNT(*) AS count
        FROM transactions WHERE to_wallet_id = $1 AND status = 'completed'
      `, [b.wallet_id])).rows[0];

      const disbursed = (await pool.query(`
        SELECT COALESCE(SUM(ABS(amount)), 0) AS total, COUNT(*) AS count
        FROM transactions WHERE from_wallet_id = $1 AND status = 'completed'
      `, [b.wallet_id])).rows[0];

      const lastTx = (await pool.query(`
        SELECT created_at AS last_date, category, payment_method
        FROM transactions
        WHERE from_wallet_id = $1 OR to_wallet_id = $1
        ORDER BY created_at DESC LIMIT 1
      `, [b.wallet_id])).rows[0];

      const methods = (await pool.query(`
        SELECT payment_method, COUNT(*) AS count
        FROM transactions WHERE from_wallet_id = $1 OR to_wallet_id = $1
        GROUP BY payment_method
      `, [b.wallet_id])).rows;

      const recentTx = (await pool.query(`
        SELECT id, category, description, amount, payment_method, status, created_at
        FROM transactions
        WHERE from_wallet_id = $1 OR to_wallet_id = $1
        ORDER BY created_at DESC LIMIT 5
      `, [b.wallet_id])).rows;

      return {
        wallet_id: b.wallet_id,
        name: b.name,
        role: b.role,
        current_balance_cents: b.fiat_balance,
        current_balance_usd: toDollars(b.fiat_balance),
        currency: b.currency || 'USD',
        email: b.email || null,
        phone: b.phone || null,
        holder_name: b.holder_name || null,
        total_received_cents: parseInt(received.total, 10),
        total_received_usd: toDollars(parseInt(received.total, 10)),
        inflow_count: parseInt(received.count, 10),
        total_disbursed_cents: parseInt(disbursed.total, 10),
        total_disbursed_usd: toDollars(parseInt(disbursed.total, 10)),
        outflow_count: parseInt(disbursed.count, 10),
        net_position_cents: parseInt(received.total, 10) - parseInt(disbursed.total, 10),
        net_position_usd: toDollars(parseInt(received.total, 10) - parseInt(disbursed.total, 10)),
        last_activity: lastTx?.last_date || null,
        last_tx_category: lastTx?.category || null,
        last_tx_method: lastTx?.payment_method || null,
        payment_methods_used: methods.reduce((acc, m) => {
          acc[m.payment_method] = parseInt(m.count, 10);
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
    }));

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

// ─── GET /api/analytics/ach-readiness ────────────────────────────────────────
router.get('/ach-readiness', async (req, res) => {
  try {
    const { rows: users } = await pool.query(`
      SELECT wallet_id, name, role, fiat_balance, email, phone, holder_name,
        CASE WHEN routing_number IS NOT NULL THEN 1 ELSE 0 END AS has_routing,
        CASE WHEN account_number IS NOT NULL THEN 1 ELSE 0 END AS has_account
      FROM wallets ORDER BY role, id
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

// ─── GET /api/analytics/distributions ────────────────────────────────────────
router.get('/distributions', async (req, res) => {
  try {
    const { year } = req.query;

    const conditions = ["category = 'distribution'", "status = 'completed'"];
    const params = [];
    let n = 1;
    if (year) { conditions.push(`EXTRACT(YEAR FROM created_at)::TEXT = $${n++}`); params.push(year); }
    const where = 'WHERE ' + conditions.join(' AND ');

    const distributions = (await pool.query(`
      SELECT id, description, amount, payment_method, from_wallet_id, to_wallet_id,
        status, created_at,
        EXTRACT(YEAR FROM created_at)::TEXT AS year,
        TO_CHAR(created_at, 'YYYY-MM') AS month,
        EXTRACT(QUARTER FROM created_at)::TEXT AS quarter
      FROM transactions ${where}
      ORDER BY created_at DESC
    `, params)).rows;

    const byYear = (await pool.query(`
      SELECT EXTRACT(YEAR FROM created_at)::TEXT AS year,
        COUNT(*) AS count, SUM(ABS(amount)) AS total_cents
      FROM transactions
      WHERE category = 'distribution' AND status = 'completed'
      GROUP BY year ORDER BY year
    `)).rows;

    const byQuarter = (await pool.query(`
      SELECT EXTRACT(YEAR FROM created_at)::TEXT AS year,
        TO_CHAR(created_at, 'MM') AS month_num,
        COUNT(*) AS count, SUM(ABS(amount)) AS total_cents, AVG(ABS(amount)) AS avg_cents
      FROM transactions
      WHERE category = 'distribution' AND status = 'completed'
      GROUP BY year, month_num ORDER BY year, month_num
    `)).rows;

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
        count: parseInt(r.count, 10),
        total_cents: parseInt(r.total_cents, 10),
        total_usd: toDollars(parseInt(r.total_cents, 10)),
      })),

      by_period: byQuarter.map(r => ({
        year: r.year,
        month: r.month_num,
        count: parseInt(r.count, 10),
        total_cents: parseInt(r.total_cents, 10),
        total_usd: toDollars(parseInt(r.total_cents, 10)),
        avg_cents: Math.round(parseFloat(r.avg_cents)),
        avg_usd: toDollars(Math.round(parseFloat(r.avg_cents))),
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

// ─── GET /api/analytics/data-quality ─────────────────────────────────────────
router.get('/data-quality', async (req, res) => {
  try {
    const { rows: users } = await pool.query(`
      SELECT wallet_id, name, role, email, phone, holder_name
      FROM wallets ORDER BY role, id
    `);

    const totalUsers = users.length;
    const missing = {
      email:       users.filter(u => !u.email).length,
      phone:       users.filter(u => !u.phone).length,
      holder_name: users.filter(u => !u.holder_name).length,
    };

    const orphanedFrom = (await pool.query(`
      SELECT COUNT(*) AS count FROM transactions t
      LEFT JOIN wallets w ON w.wallet_id = t.from_wallet_id
      WHERE t.from_wallet_id IS NOT NULL AND w.wallet_id IS NULL
    `)).rows[0];

    const orphanedTo = (await pool.query(`
      SELECT COUNT(*) AS count FROM transactions t
      LEFT JOIN wallets w ON w.wallet_id = t.to_wallet_id
      WHERE t.to_wallet_id IS NOT NULL AND w.wallet_id IS NULL
    `)).rows[0];

    const missingCategory = (await pool.query(`
      SELECT COUNT(*) AS count FROM transactions WHERE category IS NULL OR category = ''
    `)).rows[0];

    const totalFields = totalUsers * Object.keys(missing).length;
    const missingTotal = Object.values(missing).reduce((a, b) => a + b, 0);
    const completenessScore = totalFields > 0
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
        orphaned_from_wallet: parseInt(orphanedFrom.count, 10),
        orphaned_to_wallet: parseInt(orphanedTo.count, 10),
        missing_category: parseInt(missingCategory.count, 10),
      },
      recommended_schema_additions: [
        { field: 'wallets.routing_number', type: 'TEXT', reason: 'Required for ACH disbursements' },
        { field: 'wallets.account_number', type: 'TEXT', reason: 'Required for ACH disbursements' },
        { field: 'wallets.account_type', type: 'TEXT', reason: 'Checking vs savings for ACH' },
        { field: 'wallets.kyc_verified', type: 'BOOLEAN', reason: 'KYC compliance tracking' },
        { field: 'wallets.ssn_encrypted', type: 'TEXT', reason: 'IRS 1099 reporting' },
        { field: 'wallets.date_of_birth', type: 'TEXT', reason: 'Identity verification' },
        { field: 'wallets.mailing_address', type: 'TEXT', reason: 'Legal correspondence' },
        { field: 'wallets.preferred_payment_method', type: 'TEXT', reason: 'Disbursement preferences' },
        { field: 'transactions.is_test', type: 'BOOLEAN', reason: 'Separate test from production transactions' },
        { field: 'transactions.beneficiary_split', type: 'JSONB', reason: 'Per-beneficiary distribution tracking' },
      ],
    });
  } catch (err) {
    res.status(500).json({ error: 'Data quality query failed', detail: err.message });
  }
});

module.exports = router;
