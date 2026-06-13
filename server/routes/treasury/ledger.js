'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db-postgres');

// GET /api/treasury/ledger — General ledger with filtering
router.get('/', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT id FROM trusts LIMIT 1');
    const { entry_type, start_date, end_date, limit } = req.query;

    let sql = `
      SELECT le.*,
        dw.name as debit_wallet_name,
        cw.name as credit_wallet_name
      FROM ledger_entries le
      LEFT JOIN wallets dw ON dw.id = le.debit_wallet_id
      LEFT JOIN wallets cw ON cw.id = le.credit_wallet_id
      WHERE le.trust_id = $1
    `;
    const params = [trust.id];
    let paramIdx = 2;

    if (entry_type) {
      sql += ` AND le.entry_type = $${paramIdx++}`;
      params.push(entry_type);
    }
    if (start_date) {
      sql += ` AND le.entry_date >= $${paramIdx++}`;
      params.push(start_date);
    }
    if (end_date) {
      sql += ` AND le.entry_date <= $${paramIdx++}`;
      params.push(end_date);
    }

    sql += ' ORDER BY le.entry_date DESC, le.created_at DESC';
    if (limit) sql += ` LIMIT ${parseInt(limit)}`;
    else sql += ' LIMIT 100';

    const entries = await db.queryAll(sql, params);

    // Summary totals
    const summary = await db.queryOne(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE entry_type = 'coupon_received'), 0) as total_income,
        COALESCE(SUM(amount) FILTER (WHERE entry_type = 'distribution'), 0) as total_distributed,
        COALESCE(SUM(amount) FILTER (WHERE entry_type = 'expense'), 0) as total_expenses,
        COALESCE(SUM(amount) FILTER (WHERE entry_type = 'tax'), 0) as total_taxes,
        COUNT(*) as total_entries
      FROM ledger_entries WHERE trust_id = $1
    `, [trust.id]);

    res.json({ success: true, data: entries, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/treasury/ledger/entry — Create a manual ledger entry
router.post('/entry', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT id FROM trusts LIMIT 1');
    const { entry_type, debit_wallet_id, credit_wallet_id, amount, description, entry_date } = req.body;

    if (!entry_type || !amount) {
      return res.status(400).json({ error: 'entry_type and amount are required' });
    }
    if (amount <= 0) {
      return res.status(400).json({ error: 'amount must be positive' });
    }

    const entry = await db.queryOne(`
      INSERT INTO ledger_entries (trust_id, entry_date, entry_type, debit_wallet_id, credit_wallet_id, amount, description, status, posted_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'posted', 'manual')
      RETURNING *
    `, [trust.id, entry_date || new Date().toISOString().split('T')[0], entry_type, debit_wallet_id, credit_wallet_id, amount, description]);

    // Update wallet balances if wallets specified
    if (debit_wallet_id) {
      await db.query('UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE id = $2', [amount, debit_wallet_id]);
    }
    if (credit_wallet_id) {
      await db.query('UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE id = $2', [amount, credit_wallet_id]);
    }

    res.status(201).json({ success: true, data: entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/treasury/ledger/report — Financial report summary
router.get('/report', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT id FROM trusts LIMIT 1');
    const { period } = req.query; // 'month', 'quarter', 'year', or 'all'

    let dateFilter = '';
    if (period === 'month') dateFilter = "AND entry_date >= CURRENT_DATE - INTERVAL '1 month'";
    else if (period === 'quarter') dateFilter = "AND entry_date >= CURRENT_DATE - INTERVAL '3 months'";
    else if (period === 'year') dateFilter = "AND entry_date >= CURRENT_DATE - INTERVAL '1 year'";

    const report = await db.queryOne(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE entry_type IN ('coupon_received','corpus_addition')), 0) as total_receipts,
        COALESCE(SUM(amount) FILTER (WHERE entry_type = 'coupon_received'), 0) as bond_income,
        COALESCE(SUM(amount) FILTER (WHERE entry_type = 'distribution'), 0) as distributions_paid,
        COALESCE(SUM(amount) FILTER (WHERE entry_type = 'expense'), 0) as expenses,
        COALESCE(SUM(amount) FILTER (WHERE entry_type = 'tax'), 0) as taxes_paid,
        COALESCE(SUM(amount) FILTER (WHERE entry_type IN ('coupon_received','corpus_addition')), 0) -
        COALESCE(SUM(amount) FILTER (WHERE entry_type IN ('distribution','expense','tax')), 0) as net_income
      FROM ledger_entries
      WHERE trust_id = $1 AND status = 'posted' ${dateFilter}
    `, [trust.id]);

    const walletBalances = await db.queryAll(`
      SELECT wallet_type, SUM(balance) as total_balance, COUNT(*) as count
      FROM wallets WHERE trust_id = $1
      GROUP BY wallet_type ORDER BY total_balance DESC
    `, [trust.id]);

    res.json({ success: true, period: period || 'all', report, wallet_balances: walletBalances });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
