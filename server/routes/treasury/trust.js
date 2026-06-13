'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db-postgres');

// GET /api/treasury/trust — Trust overview with portfolio summary
router.get('/', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT * FROM trusts LIMIT 1');
    if (!trust) return res.status(404).json({ error: 'No trust configured' });

    const [trustees, wallets, bonds, beneficiaries] = await Promise.all([
      db.queryAll('SELECT id, name, role, authority_level, status FROM trustees WHERE trust_id = $1', [trust.id]),
      db.queryAll('SELECT id, wallet_code, name, wallet_type, balance, status FROM wallets WHERE trust_id = $1 ORDER BY wallet_type', [trust.id]),
      db.queryAll('SELECT id, bond_name, issuer, face_value, coupon_rate, coupon_frequency, next_coupon_date, status FROM bonds WHERE trust_id = $1', [trust.id]),
      db.queryAll('SELECT id, name, beneficiary_type, distribution_pct, status FROM beneficiaries WHERE trust_id = $1', [trust.id]),
    ]);

    // Calculate projected annual income from bonds
    const annual_income = bonds
      .filter(b => b.status === 'active')
      .reduce((sum, b) => sum + Math.round((b.face_value * b.coupon_rate) / 100), 0);

    res.json({
      trust,
      trustees,
      wallets,
      bonds,
      beneficiaries,
      summary: {
        total_corpus: trust.total_corpus,
        annual_bond_income: annual_income,
        wallet_count: wallets.length,
        beneficiary_count: beneficiaries.length,
        active_bonds: bonds.filter(b => b.status === 'active').length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/treasury/trust/dashboard — High-level dashboard data
router.get('/dashboard', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT * FROM trusts LIMIT 1');
    if (!trust) return res.status(404).json({ error: 'No trust configured' });

    const [
      walletSummary,
      recentLedger,
      pendingDistributions,
      upcomingCoupons,
      recentPayments,
    ] = await Promise.all([
      db.queryAll(`
        SELECT wallet_type, COUNT(*) as count, SUM(balance) as total_balance
        FROM wallets WHERE trust_id = $1
        GROUP BY wallet_type
      `, [trust.id]),
      db.queryAll(`
        SELECT * FROM ledger_entries WHERE trust_id = $1
        ORDER BY created_at DESC LIMIT 20
      `, [trust.id]),
      db.queryAll(`
        SELECT * FROM distributions WHERE trust_id = $1 AND status IN ('pending','approved','processing')
        ORDER BY distribution_date
      `, [trust.id]),
      db.queryAll(`
        SELECT bcp.*, b.bond_name FROM bond_coupon_payments bcp
        JOIN bonds b ON b.id = bcp.bond_id
        WHERE b.trust_id = $1 AND bcp.status = 'scheduled'
        ORDER BY bcp.payment_date LIMIT 5
      `, [trust.id]),
      db.queryAll(`
        SELECT pi.*, dp.beneficiary_id FROM payment_instructions pi
        LEFT JOIN distribution_payments dp ON dp.id = pi.distribution_payment_id
        WHERE pi.trust_id = $1
        ORDER BY pi.created_at DESC LIMIT 10
      `, [trust.id]),
    ]);

    res.json({
      trust,
      wallet_summary: walletSummary,
      recent_ledger: recentLedger,
      pending_distributions: pendingDistributions,
      upcoming_coupons: upcomingCoupons,
      recent_payments: recentPayments,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
