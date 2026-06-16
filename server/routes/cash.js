/**
 * Cash Management Routes — dlbtrust.cloud
 * Mounts at: /api/cash
 *
 * Inter-account transfers, deposits, position summaries, and Fineract reconciliation.
 */

'use strict';

const express = require('express');
const router  = express.Router();
const { CashEngine } = require('../integrations/cash/cashEngine');

// ─── GET /api/cash/accounts ───────────────────────────────────────────────────
router.get('/accounts', async (req, res) => {
  try {
    const accounts = await CashEngine.listAccounts({ type: req.query.type, status: req.query.status });
    res.json({ success: true, count: accounts.length, data: accounts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/cash/accounts ──────────────────────────────────────────────────
router.post('/accounts', async (req, res) => {
  const { accountId, accountName, accountType, linkedFineractAccountId, notes } = req.body;
  if (!accountName || !accountType) {
    return res.status(400).json({ error: 'Required: accountName, accountType' });
  }
  try {
    const account = await CashEngine.createAccount({ accountId, accountName, accountType, linkedFineractAccountId, notes });
    res.json({ success: true, data: account });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/cash/accounts/:id ───────────────────────────────────────────────
router.get('/accounts/:id', async (req, res) => {
  try {
    const account = await CashEngine.getAccount(req.params.id);
    if (!account) return res.status(404).json({ success: false, error: `Account ${req.params.id} not found` });
    res.json({ success: true, data: account });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/cash/accounts/:id/transfer ─────────────────────────────────────
router.post('/accounts/:id/transfer', async (req, res) => {
  const { toAccountId, amountCents, movementType, memo, referenceId, referenceType, initiatedBy, glDebitAccountId, glCreditAccountId } = req.body;
  if (!toAccountId || !amountCents) {
    return res.status(400).json({ error: 'Required: toAccountId, amountCents' });
  }
  try {
    const movement = await CashEngine.transfer({
      fromAccountId: req.params.id, toAccountId, amountCents, movementType, memo,
      referenceId, referenceType, initiatedBy, glDebitAccountId, glCreditAccountId,
    });
    res.json({ success: true, data: movement });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/cash/accounts/:id/deposit ──────────────────────────────────────
router.post('/accounts/:id/deposit', async (req, res) => {
  const { amountCents, memo, referenceId, initiatedBy } = req.body;
  if (!amountCents) {
    return res.status(400).json({ error: 'Required: amountCents' });
  }
  try {
    const movement = await CashEngine.deposit({ toAccountId: req.params.id, amountCents, memo, referenceId, initiatedBy });
    res.json({ success: true, data: movement });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/cash/accounts/:id/reconcile ────────────────────────────────────
router.post('/accounts/:id/reconcile', async (req, res) => {
  try {
    const result = await CashEngine.reconcile(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ─── GET /api/cash/position ───────────────────────────────────────────────────
router.get('/position', async (req, res) => {
  try {
    const summary = await CashEngine.getPositionSummary();
    res.json({ success: true, data: summary });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/cash/movements ──────────────────────────────────────────────────
router.get('/movements', async (req, res) => {
  try {
    const movements = await CashEngine.getMovements({
      fromAccountId: req.query.from,
      toAccountId: req.query.to,
      movementType: req.query.type,
      fromDate: req.query.fromDate,
      toDate: req.query.toDate,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ success: true, count: movements.length, data: movements });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
