/**
 * Bond Master Record API Routes
 * Mounts at: /api/bonds
 *
 * Central CRUD for private placement bonds. Every module writes here
 * via PATCH /api/bonds/:id and emits bond:updated on the event bus.
 */

'use strict';

const express = require('express');
const router  = express.Router();
const pool    = require('../db/postgres');
const bus     = require('../event-bus');

// ─── Middleware: require admin auth ──────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (typeof req.user !== 'undefined' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

router.use(requireAdmin);

// ─── GET /api/bonds/:id ────────────────────────────────────────────────────
// Fetch full bond master record with joined trust account and documents
router.get('/:id', async (req, res) => {
  try {
    const { rows: [bond] } = await pool.query(
      `SELECT b.*, t.trust_name, t.trustee_name, t.beneficiary_ids
       FROM bond_master_records b
       LEFT JOIN trust_accounts t ON b.trust_account_id = t.id
       WHERE b.bond_id = $1`,
      [req.params.id]
    );
    if (!bond) return res.status(404).json({ error: 'Bond not found' });

    const { rows: docs } = await pool.query(
      'SELECT * FROM bond_documents WHERE bond_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );

    res.json({ success: true, data: { ...bond, documents: docs } });
  } catch (err) {
    console.error('[bonds/get]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/bonds ────────────────────────────────────────────────────────
// Create a new private placement bond
router.post('/', async (req, res) => {
  try {
    const {
      cusip, issuer_name, trust_account_id, face_value, coupon_rate,
      maturity_date, issue_date, next_payment_date, updated_by_module = 'api',
    } = req.body;

    if (!issuer_name || !face_value || !coupon_rate || !maturity_date || !issue_date) {
      return res.status(400).json({
        error: 'Required: issuer_name, face_value, coupon_rate, maturity_date, issue_date',
      });
    }

    const { rows: [bond] } = await pool.query(
      `INSERT INTO bond_master_records
         (cusip, issuer_name, trust_account_id, face_value, coupon_rate,
          maturity_date, issue_date, next_payment_date, updated_by_module)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [cusip, issuer_name, trust_account_id, face_value, coupon_rate,
       maturity_date, issue_date, next_payment_date, updated_by_module]
    );

    await pool.query(
      `INSERT INTO bond_audit_log (bond_id, source, changes) VALUES ($1,$2,$3)`,
      [bond.bond_id, updated_by_module, JSON.stringify(bond)]
    );

    bus.emit('bond:updated', {
      bond_id: bond.bond_id,
      source: updated_by_module,
      changes: bond,
    });

    res.status(201).json({ success: true, data: bond });
  } catch (err) {
    console.error('[bonds/create]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── PATCH /api/bonds/:id ───────────────────────────────────────────────────
// Partial update — any module can call this
router.patch('/:id', async (req, res) => {
  try {
    const allowedFields = [
      'cusip', 'issuer_name', 'trust_account_id', 'face_value', 'coupon_rate',
      'maturity_date', 'issue_date', 'fineract_loan_id', 'fineract_gl_id',
      'obp_account_id', 'cash_position', 'accrued_interest',
      'last_payment_date', 'next_payment_date', 'prospectus_doc_id',
      'indenture_doc_id', 'last_sftp_file', 'updated_by_module',
    ];

    const updates = {};
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updates.updated_at = new Date().toISOString();
    const source = updates.updated_by_module || 'api';

    const setClauses = [];
    const values = [];
    let idx = 1;
    for (const [key, val] of Object.entries(updates)) {
      setClauses.push(`${key} = $${idx}`);
      values.push(val);
      idx++;
    }
    values.push(req.params.id);

    const { rows: [bond] } = await pool.query(
      `UPDATE bond_master_records SET ${setClauses.join(', ')} WHERE bond_id = $${idx} RETURNING *`,
      values
    );

    if (!bond) return res.status(404).json({ error: 'Bond not found' });

    await pool.query(
      `INSERT INTO bond_audit_log (bond_id, source, changes) VALUES ($1,$2,$3)`,
      [req.params.id, source, JSON.stringify(updates)]
    );

    bus.emit('bond:updated', {
      bond_id: req.params.id,
      source,
      changes: updates,
    });

    res.json({ success: true, data: bond });
  } catch (err) {
    console.error('[bonds/patch]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/bonds/:id/history ─────────────────────────────────────────────
// Audit log of all module updates
router.get('/:id/history', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM bond_audit_log WHERE bond_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[bonds/history]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
