/**
 * Fixed Income / Bond Routes — dlbtrust.cloud
 * Mounts at: /api/bonds
 *
 * Private placement bond management with real-time balance tracking,
 * daily interest accrual, and Fineract GL integration.
 *
 * All data stored in PostgreSQL (same instance as Fineract).
 */

'use strict';

const express = require('express');
const router  = express.Router();
const { BondEngine } = require('../integrations/bonds/bondEngine');

// ─── GET /api/bonds ───────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const bonds = await BondEngine.listBonds();
    res.json({ success: true, count: bonds.length, data: bonds });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/bonds ──────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { bondName, faceValue, couponRate, issueDate, maturityDate } = req.body;

  if (!bondName || !faceValue || !couponRate || !issueDate || !maturityDate) {
    return res.status(400).json({
      error: 'Required: bondName, faceValue, couponRate, issueDate, maturityDate',
    });
  }

  if (faceValue <= 0) {
    return res.status(400).json({ error: 'faceValue must be positive' });
  }
  if (couponRate <= 0 || couponRate >= 1) {
    return res.status(400).json({ error: 'couponRate must be a decimal between 0 and 1 (e.g. 0.055 for 5.5%)' });
  }

  try {
    const bond = await BondEngine.createBond(req.body);
    res.json({ success: true, data: bond });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/bonds/:id ───────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const bond = await BondEngine.getBond(req.params.id);
    if (!bond) return res.status(404).json({ error: `Bond ${req.params.id} not found` });
    res.json({ success: true, data: bond });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/bonds/:id/dashboard ─────────────────────────────────────────────
router.get('/:id/dashboard', async (req, res) => {
  try {
    const dashboard = await BondEngine.getBondDashboard(req.params.id);
    res.json({ success: true, data: dashboard });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ─── POST /api/bonds/:id/accrue ───────────────────────────────────────────────
router.post('/:id/accrue', async (req, res) => {
  const { toDate, glDebitAccountId, glCreditAccountId } = req.body;

  try {
    const result = await BondEngine.accrueInterest(
      req.params.id,
      toDate || null,
      { glDebitAccountId, glCreditAccountId }
    );
    res.json({ success: true, data: result });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 :
                   err.message.includes('cannot accrue') ? 400 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ─── POST /api/bonds/:id/pay-interest ─────────────────────────────────────────
router.post('/:id/pay-interest', async (req, res) => {
  const { amount, glDebitAccountId, glCreditAccountId } = req.body;

  try {
    const result = await BondEngine.payInterest(
      req.params.id,
      amount || undefined,
      { glDebitAccountId, glCreditAccountId }
    );
    res.json({ success: true, data: result });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 :
                   err.message.includes('exceeds') || err.message.includes('No accrued') ? 400 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ─── POST /api/bonds/:id/pay-principal ────────────────────────────────────────
router.post('/:id/pay-principal', async (req, res) => {
  const { amount, glDebitAccountId, glCreditAccountId } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Required: amount (positive number)' });
  }

  try {
    const result = await BondEngine.payPrincipal(
      req.params.id,
      amount,
      { glDebitAccountId, glCreditAccountId }
    );
    res.json({ success: true, data: result });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 :
                   err.message.includes('exceeds') ? 400 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ─── GET /api/bonds/:id/transactions ──────────────────────────────────────────
router.get('/:id/transactions', async (req, res) => {
  const { type, fromDate, toDate, limit } = req.query;

  try {
    const txns = await BondEngine.getTransactions(req.params.id, {
      type,
      fromDate,
      toDate,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    res.json({ success: true, count: txns.length, data: txns });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
