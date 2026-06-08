/**
 * Apache Fineract Banking Routes
 * DEANDREA LAVAR BARKLEY TRUST
 *
 * REST API for Fineract-compatible core banking operations:
 * - Payment initiation (ACH, Wire, RTP, Check)
 * - Payment approval (maker-checker)
 * - Settlement processing
 * - ACH batch management
 * - Account synchronization
 * - Status dashboard
 */

'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const Database = require('better-sqlite3');

const { fineractEngine, PAYMENT_RAILS, PAYMENT_STATES } = require('../engines/fineract-engine');

function getDb() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'dlbtrust.db');
  return new Database(dbPath);
}

let schemaInitialized = false;

router.use((req, res, next) => {
  try {
    req.db = getDb();
    req.db.pragma('journal_mode = WAL');
    if (!schemaInitialized) {
      fineractEngine.initSchema(req.db);
      schemaInitialized = true;
    }
    res.on('finish', () => { try { req.db.close(); } catch (_) {} });
    res.on('close', () => { try { req.db.close(); } catch (_) {} });
    next();
  } catch (err) {
    res.status(500).json({ error: 'Database connection failed: ' + err.message });
  }
});

// ─── Status / Dashboard ──────────────────────────────────────────────────────

router.get('/status', (req, res) => {
  try {
    const status = fineractEngine.getStatus(req.db);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Available Payment Rails ─────────────────────────────────────────────────

router.get('/rails', (req, res) => {
  const rails = Object.entries(PAYMENT_RAILS).map(([code, config]) => ({
    code,
    name: config.name,
    fee_cents: config.fee_cents,
    fee_display: `$${(config.fee_cents / 100).toFixed(2)}`,
    settlement_days: config.settlement_days,
    settlement_display: config.settlement_days === 0 ? 'Same day / Instant' : `${config.settlement_days} business days`,
    max_amount: config.max_amount_cents ? `$${(config.max_amount_cents / 100).toLocaleString()}` : 'No limit',
    batch_eligible: config.batch_eligible,
    requires_routing: config.requires_routing,
    cutoff_time: config.cutoff_time,
  }));
  res.json(rails);
});

// ─── Initiate Payment ────────────────────────────────────────────────────────

router.post('/payments', (req, res) => {
  try {
    const result = fineractEngine.initiatePayment(req.db, req.body);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Approve Payment ─────────────────────────────────────────────────────────

router.post('/payments/:id/approve', (req, res) => {
  try {
    const result = fineractEngine.approvePayment(req.db, parseInt(req.params.id), req.body.approved_by || 'trustee');
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Get Payment Details ─────────────────────────────────────────────────────

router.get('/payments/:id', (req, res) => {
  try {
    const payment = fineractEngine.getPayment(req.db, parseInt(req.params.id));
    res.json(payment);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ─── List Payments ───────────────────────────────────────────────────────────

router.get('/payments', (req, res) => {
  try {
    const payments = fineractEngine.listPayments(req.db, {
      status: req.query.status,
      rail: req.query.rail,
      from_account_id: req.query.from_account_id ? parseInt(req.query.from_account_id) : null,
      limit: req.query.limit ? parseInt(req.query.limit) : 50,
    });
    res.json(payments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ACH Batch Operations ────────────────────────────────────────────────────

router.post('/ach/batch', (req, res) => {
  try {
    const result = fineractEngine.createACHBatch(req.db, req.body);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/ach/batch/:id/settle', (req, res) => {
  try {
    const result = fineractEngine.settleACHBatch(req.db, parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/ach/batches', (req, res) => {
  try {
    const batches = req.db.prepare('SELECT * FROM fineract_ach_batches ORDER BY created_at DESC LIMIT 50').all();
    res.json(batches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Process Settlements ─────────────────────────────────────────────────────

router.post('/settlements/process', (req, res) => {
  try {
    const result = fineractEngine.processSettlements(req.db);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Sync Trust Accounts → Fineract ─────────────────────────────────────────

router.post('/sync', (req, res) => {
  try {
    const result = fineractEngine.syncTrustAccounts(req.db);
    res.json({ message: 'Accounts synchronized', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Fineract Savings Accounts ───────────────────────────────────────────────

router.get('/accounts', (req, res) => {
  try {
    const accounts = req.db.prepare(`
      SELECT fa.*, ta.account_name as trust_account_name
      FROM fineract_savings_accounts fa
      LEFT JOIN trust_accounts ta ON fa.trust_account_id = ta.id
      ORDER BY fa.created_at DESC
    `).all();
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Settlement Log ──────────────────────────────────────────────────────────

router.get('/settlement-log', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const log = req.db.prepare(`
      SELECT sl.*, fp.payment_number, fp.rail, fp.amount_cents
      FROM fineract_settlement_log sl
      JOIN fineract_payments fp ON sl.payment_id = fp.id
      ORDER BY sl.created_at DESC LIMIT ?
    `).all(limit);
    res.json(log);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
