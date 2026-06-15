'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db-postgres');

// GET /api/treasury/bonds — List all bonds
router.get('/', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT id FROM trusts LIMIT 1');
    const bonds = await db.queryAll(`
      SELECT b.*, 
        ROUND((b.face_value * b.coupon_rate / 100))::BIGINT as annual_income,
        (SELECT COUNT(*) FROM bond_coupon_payments WHERE bond_id = b.id AND status = 'received') as coupons_received,
        (SELECT COALESCE(SUM(coupon_amount), 0) FROM bond_coupon_payments WHERE bond_id = b.id AND status = 'received') as total_received
      FROM bonds b
      WHERE b.trust_id = $1
      ORDER BY b.issue_date
    `, [trust.id]);
    res.json({ success: true, data: bonds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/treasury/bonds/:id — Bond detail with coupon schedule
router.get('/:id', async (req, res) => {
  try {
    const bond = await db.queryOne('SELECT * FROM bonds WHERE id = $1', [req.params.id]);
    if (!bond) return res.status(404).json({ error: 'Bond not found' });

    const coupons = await db.queryAll(`
      SELECT * FROM bond_coupon_payments WHERE bond_id = $1 ORDER BY payment_date
    `, [bond.id]);

    const summary = await db.queryOne(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'received') as received_count,
        COUNT(*) FILTER (WHERE status = 'scheduled') as scheduled_count,
        COALESCE(SUM(coupon_amount) FILTER (WHERE status = 'received'), 0) as total_received,
        COALESCE(SUM(coupon_amount) FILTER (WHERE status = 'scheduled'), 0) as total_scheduled
      FROM bond_coupon_payments WHERE bond_id = $1
    `, [bond.id]);

    res.json({ success: true, bond, coupons, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/treasury/bonds/:id/generate-coupons — Generate coupon payment schedule
router.post('/:id/generate-coupons', async (req, res) => {
  try {
    const bond = await db.queryOne('SELECT * FROM bonds WHERE id = $1', [req.params.id]);
    if (!bond) return res.status(404).json({ error: 'Bond not found' });

    const freqMonths = { monthly: 1, quarterly: 3, semi_annual: 6, annual: 12 };
    const months = freqMonths[bond.coupon_frequency] || 6;
    const couponAmount = Math.round((bond.face_value * bond.coupon_rate) / (100 * (12 / months)));

    // Generate from first_coupon_date through maturity
    const startDate = new Date(bond.first_coupon_date || bond.issue_date);
    const endDate = new Date(bond.maturity_date);
    const coupons = [];
    let current = new Date(startDate);

    while (current <= endDate) {
      const periodStart = new Date(current);
      periodStart.setMonth(periodStart.getMonth() - months);

      coupons.push({
        date: current.toISOString().split('T')[0],
        period_start: periodStart.toISOString().split('T')[0],
        period_end: current.toISOString().split('T')[0],
        amount: couponAmount,
      });
      current.setMonth(current.getMonth() + months);
    }

    // Insert only future coupons that don't already exist
    let inserted = 0;
    for (const c of coupons) {
      const exists = await db.queryOne(
        'SELECT id FROM bond_coupon_payments WHERE bond_id = $1 AND payment_date = $2',
        [bond.id, c.date]
      );
      if (!exists) {
        await db.query(`
          INSERT INTO bond_coupon_payments (bond_id, payment_date, period_start, period_end, coupon_amount, status)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [bond.id, c.date, c.period_start, c.period_end, c.amount, 'scheduled']);
        inserted++;
      }
    }

    // Update next_coupon_date on bond
    const nextCoupon = await db.queryOne(`
      SELECT payment_date FROM bond_coupon_payments 
      WHERE bond_id = $1 AND status = 'scheduled' AND payment_date >= CURRENT_DATE
      ORDER BY payment_date LIMIT 1
    `, [bond.id]);

    if (nextCoupon) {
      await db.query('UPDATE bonds SET next_coupon_date = $1, updated_at = NOW() WHERE id = $2', [nextCoupon.payment_date, bond.id]);
    }

    res.json({ success: true, total_coupons: coupons.length, inserted, coupon_amount: couponAmount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/treasury/bonds/:id/receive-coupon — Record a coupon payment received
router.post('/:id/receive-coupon', async (req, res) => {
  try {
    const { coupon_id } = req.body;
    const bond = await db.queryOne('SELECT * FROM bonds WHERE id = $1', [req.params.id]);
    if (!bond) return res.status(404).json({ error: 'Bond not found' });

    // Find the coupon to receive (either by ID or next scheduled)
    let coupon;
    if (coupon_id) {
      coupon = await db.queryOne('SELECT * FROM bond_coupon_payments WHERE id = $1 AND bond_id = $2', [coupon_id, bond.id]);
    } else {
      coupon = await db.queryOne(`
        SELECT * FROM bond_coupon_payments 
        WHERE bond_id = $1 AND status = 'scheduled'
        ORDER BY payment_date LIMIT 1
      `, [bond.id]);
    }
    if (!coupon) return res.status(404).json({ error: 'No scheduled coupon found' });

    await db.transaction(async (client) => {
      // Mark coupon as received
      await client.query(`
        UPDATE bond_coupon_payments SET status = 'received', received_at = NOW() WHERE id = $1
      `, [coupon.id]);

      // Credit income wallet
      const incomeWallet = await db.queryOne(
        "SELECT id, balance FROM wallets WHERE trust_id = $1 AND wallet_type = 'income'",
        [bond.trust_id]
      );
      if (incomeWallet) {
        await client.query('UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE id = $2', [coupon.coupon_amount, incomeWallet.id]);
      }

      // Update trust corpus
      await client.query('UPDATE trusts SET total_corpus = total_corpus + $1, updated_at = NOW() WHERE id = $2', [coupon.coupon_amount, bond.trust_id]);

      // Create ledger entry
      const corpusWallet = await db.queryOne("SELECT id FROM wallets WHERE trust_id = $1 AND wallet_type = 'corpus'", [bond.trust_id]);
      await client.query(`
        INSERT INTO ledger_entries (trust_id, entry_date, entry_type, credit_wallet_id, amount, description, reference_type, reference_id, status, posted_by)
        VALUES ($1, CURRENT_DATE, 'coupon_received', $2, $3, $4, 'bond_coupon', $5, 'posted', 'system')
      `, [bond.trust_id, incomeWallet?.id || corpusWallet?.id, coupon.coupon_amount, `Bond coupon: ${bond.bond_name} (${coupon.period_start} to ${coupon.period_end})`, coupon.id]);

      // Update next coupon date
      const nextCoupon = await client.query(`
        SELECT payment_date FROM bond_coupon_payments 
        WHERE bond_id = $1 AND status = 'scheduled' AND payment_date > $2
        ORDER BY payment_date LIMIT 1
      `, [bond.id, coupon.payment_date]);

      if (nextCoupon.rows.length > 0) {
        await client.query('UPDATE bonds SET next_coupon_date = $1, updated_at = NOW() WHERE id = $2', [nextCoupon.rows[0].payment_date, bond.id]);
      }

      // Audit
      await client.query(`
        INSERT INTO audit_log (trust_id, actor, action, entity_type, entity_id, details)
        VALUES ($1, 'system', 'coupon_received', 'bond_coupon_payment', $2, $3)
      `, [bond.trust_id, coupon.id, JSON.stringify({ amount: coupon.coupon_amount, bond: bond.bond_name })]);
    });

    res.json({ success: true, coupon_amount: coupon.coupon_amount, message: `Coupon of $${(coupon.coupon_amount / 100).toFixed(2)} received and credited to income account` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
