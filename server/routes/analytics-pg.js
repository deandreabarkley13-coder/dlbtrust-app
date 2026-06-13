'use strict';

/**
 * DLB Trust Analytics API Routes (PostgreSQL)
 * Provides financial analytics, portfolio summaries, and reporting.
 */

const express = require('express');
const router = express.Router();
const db = require('../db-postgres');

const toDollars = (cents) => (cents !== null && cents !== undefined) ? Math.round(cents) / 100 : null;

// GET /api/analytics/summary — Overall trust financial summary
router.get('/summary', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT * FROM trusts LIMIT 1');
    if (!trust) return res.json({ error: 'No trust data' });

    const portfolioRow = await db.queryOne(`
      SELECT
        SUM(balance) AS total_portfolio_cents,
        COUNT(*) AS total_wallets,
        SUM(CASE WHEN wallet_type = 'corpus' THEN balance ELSE 0 END) AS trust_balance_cents,
        SUM(CASE WHEN wallet_type = 'income' THEN balance ELSE 0 END) AS income_balance_cents,
        SUM(CASE WHEN wallet_type = 'beneficiary' THEN balance ELSE 0 END) AS beneficiary_balance_cents,
        SUM(CASE WHEN wallet_type = 'reserve' THEN balance ELSE 0 END) AS reserve_balance_cents
      FROM wallets WHERE trust_id = $1
    `, [trust.id]);

    const ledgerRow = await db.queryOne(`
      SELECT
        COUNT(*) AS total_entries,
        COALESCE(SUM(amount) FILTER (WHERE entry_type = 'coupon_received'), 0) AS total_income_cents,
        COALESCE(SUM(amount) FILTER (WHERE entry_type = 'distribution'), 0) AS total_distributions_cents,
        COALESCE(SUM(amount) FILTER (WHERE entry_type = 'expense'), 0) AS total_expenses_cents,
        COALESCE(SUM(amount) FILTER (WHERE entry_type = 'tax'), 0) AS total_taxes_cents
      FROM ledger_entries WHERE trust_id = $1 AND status = 'posted'
    `, [trust.id]);

    const bondRow = await db.queryOne(`
      SELECT
        COUNT(*) AS bond_count,
        COALESCE(SUM(face_value), 0) AS total_face_value,
        COALESCE(SUM(ROUND(face_value * coupon_rate / 100)::BIGINT), 0) AS total_annual_income
      FROM bonds WHERE trust_id = $1 AND status = 'active'
    `, [trust.id]);

    const distRow = await db.queryOne(`
      SELECT
        COUNT(*) AS dist_count,
        COALESCE(SUM(total_amount), 0) AS total_distributed,
        COALESCE(AVG(total_amount), 0) AS avg_distribution
      FROM distributions WHERE trust_id = $1 AND status = 'completed'
    `, [trust.id]);

    res.json({
      generated_at: new Date().toISOString(),
      trust_name: trust.trust_name,
      trust_type: trust.trust_type,
      corpus: trust.total_corpus,
      corpus_usd: toDollars(trust.total_corpus),
      portfolio: {
        total_cents: parseInt(portfolioRow.total_portfolio_cents) || 0,
        total_usd: toDollars(portfolioRow.total_portfolio_cents),
        corpus_cents: parseInt(portfolioRow.trust_balance_cents) || 0,
        income_cents: parseInt(portfolioRow.income_balance_cents) || 0,
        beneficiary_cents: parseInt(portfolioRow.beneficiary_balance_cents) || 0,
        reserve_cents: parseInt(portfolioRow.reserve_balance_cents) || 0,
        wallet_count: parseInt(portfolioRow.total_wallets) || 0,
      },
      income: {
        total_received_cents: parseInt(ledgerRow.total_income_cents) || 0,
        total_received_usd: toDollars(ledgerRow.total_income_cents),
        annual_projected_cents: parseInt(bondRow.total_annual_income) || 0,
        annual_projected_usd: toDollars(bondRow.total_annual_income),
      },
      distributions: {
        count: parseInt(distRow.dist_count) || 0,
        total_cents: parseInt(distRow.total_distributed) || 0,
        total_usd: toDollars(distRow.total_distributed),
        average_cents: parseInt(distRow.avg_distribution) || 0,
      },
      expenses: {
        total_cents: parseInt(ledgerRow.total_expenses_cents) || 0,
        total_usd: toDollars(ledgerRow.total_expenses_cents),
      },
      bonds: {
        count: parseInt(bondRow.bond_count) || 0,
        face_value_cents: parseInt(bondRow.total_face_value) || 0,
        face_value_usd: toDollars(bondRow.total_face_value),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/income — Income analysis
router.get('/income', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT id FROM trusts LIMIT 1');
    const { period } = req.query;

    let dateFilter = '';
    if (period === 'month') dateFilter = "AND le.entry_date >= CURRENT_DATE - INTERVAL '1 month'";
    else if (period === 'quarter') dateFilter = "AND le.entry_date >= CURRENT_DATE - INTERVAL '3 months'";
    else if (period === 'year') dateFilter = "AND le.entry_date >= CURRENT_DATE - INTERVAL '1 year'";

    const income = await db.queryAll(`
      SELECT 
        DATE_TRUNC('month', le.entry_date) as month,
        SUM(le.amount) as total_cents,
        COUNT(*) as entries
      FROM ledger_entries le
      WHERE le.trust_id = $1 AND le.entry_type = 'coupon_received' AND le.status = 'posted' ${dateFilter}
      GROUP BY DATE_TRUNC('month', le.entry_date)
      ORDER BY month DESC
    `, [trust.id]);

    const upcomingCoupons = await db.queryAll(`
      SELECT bcp.payment_date, bcp.coupon_amount, b.bond_name, b.coupon_rate
      FROM bond_coupon_payments bcp
      JOIN bonds b ON b.id = bcp.bond_id
      WHERE b.trust_id = $1 AND bcp.status = 'scheduled' AND bcp.payment_date >= CURRENT_DATE
      ORDER BY bcp.payment_date LIMIT 12
    `, [trust.id]);

    res.json({ success: true, monthly_income: income, upcoming_coupons: upcomingCoupons });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/distributions — Distribution analysis
router.get('/distributions', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT id FROM trusts LIMIT 1');

    const byBeneficiary = await db.queryAll(`
      SELECT 
        b.name as beneficiary_name,
        COUNT(dp.id) as payment_count,
        COALESCE(SUM(dp.gross_amount), 0) as total_gross,
        COALESCE(SUM(dp.net_amount), 0) as total_net,
        COALESCE(SUM(dp.tax_withheld), 0) as total_tax
      FROM beneficiaries b
      LEFT JOIN distribution_payments dp ON dp.beneficiary_id = b.id AND dp.status = 'settled'
      WHERE b.trust_id = $1
      GROUP BY b.id, b.name
      ORDER BY total_net DESC
    `, [trust.id]);

    const byMonth = await db.queryAll(`
      SELECT 
        DATE_TRUNC('month', d.distribution_date) as month,
        SUM(d.total_amount) as total_cents,
        COUNT(*) as count
      FROM distributions d
      WHERE d.trust_id = $1 AND d.status = 'completed'
      GROUP BY DATE_TRUNC('month', d.distribution_date)
      ORDER BY month DESC LIMIT 12
    `, [trust.id]);

    res.json({ success: true, by_beneficiary: byBeneficiary, by_month: byMonth });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/payments — Payment activity
router.get('/payments', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT id FROM trusts LIMIT 1');

    const byStatus = await db.queryAll(`
      SELECT status, COUNT(*) as count, COALESCE(SUM(amount), 0) as total_cents
      FROM payment_instructions WHERE trust_id = $1
      GROUP BY status
    `, [trust.id]);

    const byRail = await db.queryAll(`
      SELECT payment_rail, COUNT(*) as count, COALESCE(SUM(amount), 0) as total_cents
      FROM payment_instructions WHERE trust_id = $1
      GROUP BY payment_rail
    `, [trust.id]);

    const recent = await db.queryAll(`
      SELECT id, payment_rail, amount, beneficiary_name, status, effective_date, settled_at
      FROM payment_instructions WHERE trust_id = $1
      ORDER BY created_at DESC LIMIT 20
    `, [trust.id]);

    res.json({ success: true, by_status: byStatus, by_rail: byRail, recent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
