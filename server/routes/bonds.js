/**
 * Bond Routes — dlbtrust.cloud
 * Bond management endpoints from Bond Master plan
 */

'use strict';

const express = require('express');
const router = express.Router();
const pool = require('../db');

// ─── GET /api/bonds ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bonds ORDER BY created_at DESC');
    res.json({ success: true, bonds: result.rows });
  } catch (err) {
    console.error('[bonds]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/bonds/:id ─────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bonds WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) {
      return res.status(404).json({ success: false, error: 'Bond not found' });
    }
    res.json({ success: true, bond: result.rows[0] });
  } catch (err) {
    console.error('[bonds/:id]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/bonds/:id/allocations ─────────────────────────────────────────
router.get('/:id/allocations', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM bond_allocations WHERE bond_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json({ success: true, allocations: result.rows });
  } catch (err) {
    console.error('[bonds/:id/allocations]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/bonds/:id/payments ────────────────────────────────────────────
router.get('/:id/payments', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM bond_payments WHERE bond_id = $1 ORDER BY payment_date DESC',
      [req.params.id]
    );
    res.json({ success: true, payments: result.rows });
  } catch (err) {
    console.error('[bonds/:id/payments]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
