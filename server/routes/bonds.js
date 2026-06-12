/**
 * Bond Master Routes — dlbtrust.cloud (PostgreSQL)
 * Mounts at: /api/bonds
 */

'use strict';

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { BondMasterClient } = require('../integrations/bondmaster/bondmasterClient');

// ─── POST /api/bonds — Create bond ──────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { bond_name, issuer, face_value, coupon_rate, frequency, issue_date, maturity_date } = req.body;

    if (!bond_name || !face_value || !coupon_rate || !issue_date || !maturity_date) {
      return res.status(400).json({ error: 'Required: bond_name, face_value, coupon_rate, issue_date, maturity_date' });
    }

    const { rows } = await pool.query(
      `INSERT INTO bonds (bond_name, issuer, face_value, coupon_rate, frequency, issue_date, maturity_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        bond_name,
        issuer || 'DEANDREA LAVAR BARKLEY TRUST',
        face_value,
        coupon_rate,
        frequency || 'semi-annual',
        issue_date,
        maturity_date,
      ]
    );

    res.status(201).json({ success: true, bond: rows[0] });
  } catch (err) {
    console.error('[bonds/create]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/bonds — List bonds ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM bonds ORDER BY created_at DESC');
    res.json({ success: true, bonds: rows });
  } catch (err) {
    console.error('[bonds/list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/bonds/payments — All bond payments ─────────────────────────────
router.get('/payments', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT bp.*, b.bond_name, ba.wallet_id, ba.beneficiary_name
      FROM bond_payments bp
      JOIN bonds b ON b.id = bp.bond_id
      LEFT JOIN bond_allocations ba ON ba.id = bp.allocation_id
      ORDER BY bp.payment_date DESC
    `);
    res.json({ success: true, payments: rows });
  } catch (err) {
    console.error('[bonds/payments]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/bonds/:id — Bond details ───────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM bonds WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Bond not found' });
    res.json({ success: true, bond: rows[0] });
  } catch (err) {
    console.error('[bonds/detail]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/bonds/:id/allocate — Allocate to beneficiary ─────────────────
router.post('/:id/allocate', async (req, res) => {
  try {
    const { wallet_id, beneficiary_name, allocation_pct } = req.body;

    if (!wallet_id || !allocation_pct) {
      return res.status(400).json({ error: 'Required: wallet_id, allocation_pct' });
    }

    // Check bond exists
    const bondRes = await pool.query('SELECT * FROM bonds WHERE id = $1', [req.params.id]);
    if (!bondRes.rows.length) return res.status(404).json({ error: 'Bond not found' });

    // Check total allocation doesn't exceed 100%
    const existingRes = await pool.query(
      'SELECT COALESCE(SUM(allocation_pct), 0) AS total FROM bond_allocations WHERE bond_id = $1',
      [req.params.id]
    );
    const currentTotal = parseFloat(existingRes.rows[0].total);
    if (currentTotal + parseFloat(allocation_pct) > 100) {
      return res.status(400).json({
        error: `Allocation would exceed 100%. Current total: ${currentTotal}%, requested: ${allocation_pct}%`,
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO bond_allocations (bond_id, wallet_id, beneficiary_name, allocation_pct)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.id, wallet_id, beneficiary_name || null, allocation_pct]
    );

    res.status(201).json({ success: true, allocation: rows[0] });
  } catch (err) {
    console.error('[bonds/allocate]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/bonds/:id/allocations — List allocations ───────────────────────
router.get('/:id/allocations', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM bond_allocations WHERE bond_id = $1 ORDER BY id',
      [req.params.id]
    );
    res.json({ success: true, allocations: rows });
  } catch (err) {
    console.error('[bonds/allocations]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/bonds/:id/pay — Trigger interest payment ─────────────────────
router.post('/:id/pay', async (req, res) => {
  try {
    const { send_date } = req.body;
    if (!send_date) return res.status(400).json({ error: 'Required: send_date' });

    const bondRes = await pool.query('SELECT * FROM bonds WHERE id = $1', [req.params.id]);
    if (!bondRes.rows.length) return res.status(404).json({ error: 'Bond not found' });
    const bond = bondRes.rows[0];

    const allocRes = await pool.query(
      'SELECT * FROM bond_allocations WHERE bond_id = $1',
      [req.params.id]
    );

    if (!allocRes.rows.length) {
      return res.status(400).json({ error: 'No allocations found for this bond' });
    }

    const results = [];
    for (const allocation of allocRes.rows) {
      try {
        const r = await BondMasterClient.disburseInterest({ bond, allocation, send_date, pool });
        results.push(r);
      } catch (err) {
        results.push({
          success: false,
          allocation_id: allocation.id,
          error: err.message,
        });
      }
    }

    res.json({ success: true, bond_id: bond.id, payments: results });
  } catch (err) {
    console.error('[bonds/pay]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/bonds/:id/schedule — Projected payment schedule ────────────────
router.get('/:id/schedule', async (req, res) => {
  try {
    const bondRes = await pool.query('SELECT * FROM bonds WHERE id = $1', [req.params.id]);
    if (!bondRes.rows.length) return res.status(404).json({ error: 'Bond not found' });
    const bond = bondRes.rows[0];

    const schedule = BondMasterClient.generateSchedule({
      bond_id: bond.id,
      issue_date: bond.issue_date,
      maturity_date: bond.maturity_date,
      frequency: bond.frequency,
      coupon_rate: parseFloat(bond.coupon_rate),
      face_value: parseFloat(bond.face_value),
    });

    res.json({
      success: true,
      bond_id: bond.id,
      bond_name: bond.bond_name,
      interest_per_period: BondMasterClient.calculateInterest({
        face_value: parseFloat(bond.face_value),
        coupon_rate: parseFloat(bond.coupon_rate),
        frequency: bond.frequency,
      }),
      total_payments: schedule.length,
      schedule,
    });
  } catch (err) {
    console.error('[bonds/schedule]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
