/**
 * Fineract Core Banking Routes — dlbtrust.cloud
 * Mounts at: /api/fineract
 *
 * Provides endpoints for Fineract client/account management,
 * double-entry GL journal entries, and GL summary.
 *
 * Fineract is the GL source of truth; trust.db remains the operational/ACH cache.
 */

'use strict';

const express = require('express');
const router  = express.Router();
const { FineractClient } = require('../integrations/fineract/fineractClient');

// ─── GET /api/fineract/health ─────────────────────────────────────────────────
router.get('/health', async (req, res) => {
  try {
    const result = await FineractClient.healthCheck();
    res.json({
      success: true,
      fineract_connected: true,
      office_count: Array.isArray(result.offices) ? result.offices.length : 0,
      message: 'Fineract API is live and authenticated',
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      fineract_connected: false,
      error: err.message,
    });
  }
});

// ─── POST /api/fineract/clients ───────────────────────────────────────────────
router.post('/clients', async (req, res) => {
  const { firstName, lastName, externalId, email } = req.body;

  if (!firstName || !lastName) {
    return res.status(400).json({ error: 'Required: firstName, lastName' });
  }

  try {
    const result = await FineractClient.createClient({ firstName, lastName, externalId, email });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({
      success: false,
      error: err.message,
      detail: err.detail || null,
    });
  }
});

// ─── POST /api/fineract/accounts ──────────────────────────────────────────────
router.post('/accounts', async (req, res) => {
  const { clientId, productId, externalId } = req.body;

  if (!clientId || !productId) {
    return res.status(400).json({ error: 'Required: clientId, productId' });
  }

  try {
    const result = await FineractClient.createSavingsAccount({ clientId, productId, externalId });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({
      success: false,
      error: err.message,
      detail: err.detail || null,
    });
  }
});

// ─── GET /api/fineract/accounts/:id ───────────────────────────────────────────
router.get('/accounts/:id', async (req, res) => {
  try {
    const account = await FineractClient.getAccountBalance(req.params.id);
    res.json({ success: true, data: account });
  } catch (err) {
    res.status(err.status || 500).json({
      success: false,
      error: err.message,
      detail: err.detail || null,
    });
  }
});

// ─── POST /api/fineract/journal ───────────────────────────────────────────────
router.post('/journal', async (req, res) => {
  const { officeId, transactionDate, credits, debits, comments } = req.body;

  if (!credits || !debits || !Array.isArray(credits) || !Array.isArray(debits)) {
    return res.status(400).json({ error: 'Required: credits (array), debits (array)' });
  }
  if (credits.length === 0 || debits.length === 0) {
    return res.status(400).json({ error: 'credits and debits must each have at least one entry' });
  }

  try {
    const result = await FineractClient.postJournalEntry({
      officeId,
      transactionDate: transactionDate || new Date(),
      credits,
      debits,
      comments,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({
      success: false,
      error: err.message,
      detail: err.detail || null,
    });
  }
});

// ─── GET /api/fineract/gl/summary ─────────────────────────────────────────────
router.get('/gl/summary', async (req, res) => {
  try {
    const summary = await FineractClient.getGLSummary();
    res.json({ success: true, data: summary });
  } catch (err) {
    res.status(err.status || 500).json({
      success: false,
      error: err.message,
      detail: err.detail || null,
    });
  }
});

// ─── GET /api/fineract/gl/accounts ────────────────────────────────────────────
router.get('/gl/accounts', async (req, res) => {
  try {
    const accounts = await FineractClient.getGLAccounts();
    res.json({ success: true, data: Array.isArray(accounts) ? accounts : [] });
  } catch (err) {
    res.status(err.status || 500).json({
      success: false,
      error: err.message,
      detail: err.detail || null,
    });
  }
});

// ─── GET /api/fineract/clients ────────────────────────────────────────────────
router.get('/clients', async (req, res) => {
  try {
    const { offset, limit } = req.query;
    const result = await FineractClient.listClients({
      offset: parseInt(offset, 10) || 0,
      limit: parseInt(limit, 10) || 100,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({
      success: false,
      error: err.message,
      detail: err.detail || null,
    });
  }
});

// ─── GET /api/fineract/journal ────────────────────────────────────────────────
router.get('/journal', async (req, res) => {
  try {
    const { accountId, fromDate, toDate, offset, limit } = req.query;
    const result = await FineractClient.getJournalEntries({
      accountId: accountId ? parseInt(accountId, 10) : undefined,
      fromDate: fromDate ? new Date(fromDate) : undefined,
      toDate: toDate ? new Date(toDate) : undefined,
      offset: parseInt(offset, 10) || 0,
      limit: parseInt(limit, 10) || 50,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({
      success: false,
      error: err.message,
      detail: err.detail || null,
    });
  }
});

// ─── GET /api/fineract/savings ────────────────────────────────────────────────
router.get('/savings', async (req, res) => {
  try {
    const { clientId, offset, limit } = req.query;
    const result = await FineractClient.listSavingsAccounts({
      clientId: clientId ? parseInt(clientId, 10) : undefined,
      offset: parseInt(offset, 10) || 0,
      limit: parseInt(limit, 10) || 100,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({
      success: false,
      error: err.message,
      detail: err.detail || null,
    });
  }
});

// ─── GET /api/fineract/resilience ────────────────────────────────────────────
router.get('/resilience', (req, res) => {
  try {
    const resilience = require('../integrations/fineract/fineractResilience');
    res.json({ success: true, ...resilience.getStatus() });
  } catch (err) {
    res.json({ success: false, error: err.message, monitoring: false });
  }
});

// ─── POST /api/fineract/resilience/clean-locks ──────────────────────────────
router.post('/resilience/clean-locks', async (req, res) => {
  try {
    const resilience = require('../integrations/fineract/fineractResilience');
    const result = await resilience.cleanLiquibaseLocks();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
