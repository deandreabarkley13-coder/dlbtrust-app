/**
 * Document Management API Routes
 * Mounts at: /api/docs
 */

'use strict';

const express = require('express');
const router  = express.Router();
const dms     = require('../integrations/docs/dms-client');
const docgen  = require('../integrations/docs/docgen-client');
const pool    = require('../db/postgres');

// ─── Middleware: require admin auth ──────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (typeof req.user !== 'undefined' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

router.use(requireAdmin);

// ─── GET /api/docs/:id ──────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const doc = await dms.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.json({ success: true, data: doc });
  } catch (err) {
    console.error('[docs/get]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/docs/bond/:bondId ─────────────────────────────────────────────
router.get('/bond/:bondId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM bond_documents WHERE bond_id = $1 ORDER BY created_at DESC',
      [req.params.bondId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[docs/bond]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/docs/generate/ppm ────────────────────────────────────────────
router.post('/generate/ppm', async (req, res) => {
  try {
    const { bond_id } = req.body;
    if (!bond_id) return res.status(400).json({ error: 'bond_id required' });

    const { rows: [bond] } = await pool.query(
      'SELECT * FROM bond_master_records WHERE bond_id = $1',
      [bond_id]
    );
    if (!bond) return res.status(404).json({ error: 'Bond not found' });

    const result = await docgen.generatePPM(bond);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[docs/generate/ppm]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/docs/generate/certificate ────────────────────────────────────
router.post('/generate/certificate', async (req, res) => {
  try {
    const { bond_id } = req.body;
    if (!bond_id) return res.status(400).json({ error: 'bond_id required' });

    const { rows: [bond] } = await pool.query(
      'SELECT * FROM bond_master_records WHERE bond_id = $1',
      [bond_id]
    );
    if (!bond) return res.status(404).json({ error: 'Bond not found' });

    const result = await docgen.generateBondCertificate(bond);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[docs/generate/certificate]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/docs/generate/k1 ────────────────────────────────────────────
router.post('/generate/k1', async (req, res) => {
  try {
    const { bond_id, beneficiary } = req.body;
    if (!bond_id || !beneficiary) {
      return res.status(400).json({ error: 'bond_id and beneficiary required' });
    }

    const { rows: [bond] } = await pool.query(
      'SELECT * FROM bond_master_records WHERE bond_id = $1',
      [bond_id]
    );
    if (!bond) return res.status(404).json({ error: 'Bond not found' });

    const result = await docgen.generateK1(beneficiary, bond);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[docs/generate/k1]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
