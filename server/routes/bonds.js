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
const { LiveBondEngine } = require('../integrations/bonds/liveEngine');
const pool = require('../integrations/bonds/pgPool');
const { FineractClient } = require('../integrations/fineract/fineractClient');

// ─── GET /api/bonds/portfolio/live ─────────────────────────────────────────────
router.get('/portfolio/live', async (req, res) => {
  try {
    const snapshot = await LiveBondEngine.getPortfolioSnapshot();
    res.json({ success: true, data: snapshot });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/bonds/trustee/:trusteeId ────────────────────────────────────────
router.get('/trustee/:trusteeId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT bt.*, b.bond_name, b.face_value, b.coupon_rate, b.status AS bond_status
       FROM bond_trustees bt
       JOIN bonds b ON b.id = bt.bond_id
       WHERE bt.trustee_id = $1
       ORDER BY bt.effective_date DESC`,
      [req.params.trusteeId]
    );
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

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

// ─── GET /api/bonds/:id/live ──────────────────────────────────────────────────
router.get('/:id/live', async (req, res) => {
  try {
    const marketYield = req.query.marketYield !== undefined ? parseFloat(req.query.marketYield) : undefined;
    const metrics = await LiveBondEngine.getBondLiveMetrics(req.params.id, marketYield);
    res.json({ success: true, data: metrics });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ─── POST /api/bonds/:id/issue ────────────────────────────────────────────────
router.post('/:id/issue', async (req, res) => {
  const { investorContactId, settlementDate, offeringPrice, trusteeId, cashAccountId, subscriptionAmount } = req.body;

  if (!investorContactId || !settlementDate || !subscriptionAmount) {
    return res.status(400).json({ error: 'Required: investorContactId, settlementDate, subscriptionAmount' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const bondId = parseInt(req.params.id, 10);
    const subscriptionId = 'SUB-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();

    await client.query(
      `INSERT INTO crm_bond_subscriptions
         (subscription_id, contact_id, bond_id, subscription_amount, offering_price, settlement_date, cash_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [subscriptionId, investorContactId, bondId, subscriptionAmount, offeringPrice || 1.0, settlementDate, cashAccountId || null]
    );

    if (trusteeId) {
      await client.query(
        `INSERT INTO bond_trustees (bond_id, trustee_id, trustee_name, trustee_role, effective_date)
         VALUES ($1, $2, $2, 'primary', $3)
         ON CONFLICT DO NOTHING`,
        [bondId, trusteeId, settlementDate]
      );
    }

    // Post GL entry for issuance
    try {
      await FineractClient.postJournalEntry({
        officeId: 1,
        transactionDate: new Date(settlementDate),
        credits: [{ glAccountId: 1, amount: subscriptionAmount }],
        debits: [{ glAccountId: 2, amount: subscriptionAmount }],
        comments: `PTC issuance — subscription ${subscriptionId} for bond ${bondId}`,
      });
    } catch (glErr) {
      console.warn('[bonds/issue] GL post failed:', glErr.message);
    }

    await client.query('COMMIT');
    res.json({ success: true, data: { subscription_id: subscriptionId, bond_id: bondId } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// ─── GET /api/bonds/:id/trustee ───────────────────────────────────────────────
router.get('/:id/trustee', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM bond_trustees WHERE bond_id = $1 ORDER BY effective_date DESC`,
      [req.params.id]
    );
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/bonds/:id/trustee ──────────────────────────────────────────────
router.post('/:id/trustee', async (req, res) => {
  const { trusteeId, trusteeName, trusteeRole, effectiveDate, notes } = req.body;

  if (!trusteeId || !effectiveDate) {
    return res.status(400).json({ error: 'Required: trusteeId, effectiveDate' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO bond_trustees (bond_id, trustee_id, trustee_name, trustee_role, effective_date, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.params.id, trusteeId, trusteeName || null, trusteeRole || 'primary', effectiveDate, notes || null]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
