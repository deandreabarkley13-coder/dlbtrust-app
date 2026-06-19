/**
 * Trust Accounting Routes — dlbtrust.cloud
 * Mounts at: /api/accounting
 *
 * Chart of accounts, journal entries, trial balance,
 * balance sheet, income statement, and period management.
 */

'use strict';

const express = require('express');
const router  = express.Router();
const { TrustAccountingEngine } = require('../integrations/accounting/trustAccountingEngine');

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /api/accounting/dashboard ────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const dashboard = await TrustAccountingEngine.getDashboard();
    res.json({ success: true, data: dashboard });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CHART OF ACCOUNTS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /api/accounting/accounts ─────────────────────────────────────────────
router.get('/accounts', async (req, res) => {
  try {
    const accounts = await TrustAccountingEngine.listAccounts({
      accountType: req.query.type,
      subType: req.query.subType,
      isActive: req.query.active !== undefined ? req.query.active === 'true' : undefined,
    });
    res.json({ success: true, count: accounts.length, data: accounts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/accounting/accounts ────────────────────────────────────────────
router.post('/accounts', async (req, res) => {
  const { accountCode, accountName, accountType } = req.body;
  if (!accountCode || !accountName || !accountType) {
    return res.status(400).json({ error: 'Required: accountCode, accountName, accountType' });
  }
  try {
    const account = await TrustAccountingEngine.createAccount(req.body);
    res.json({ success: true, data: account });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/accounting/accounts/:code ───────────────────────────────────────
router.get('/accounts/:code', async (req, res) => {
  try {
    const account = await TrustAccountingEngine.getAccount(req.params.code);
    if (!account) return res.status(404).json({ success: false, error: `Account ${req.params.code} not found` });
    res.json({ success: true, data: account });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── PUT /api/accounting/accounts/:code ───────────────────────────────────────
router.put('/accounts/:code', async (req, res) => {
  try {
    const account = await TrustAccountingEngine.updateAccount(req.params.code, req.body);
    res.json({ success: true, data: account });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// JOURNAL ENTRIES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /api/accounting/journal ──────────────────────────────────────────────
router.get('/journal', async (req, res) => {
  try {
    const entries = await TrustAccountingEngine.listJournalEntries({
      fromDate: req.query.fromDate,
      toDate: req.query.toDate,
      status: req.query.status,
      bondId: req.query.bondId,
      referenceType: req.query.referenceType,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ success: true, count: entries.length, data: entries });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/accounting/journal ─────────────────────────────────────────────
router.post('/journal', async (req, res) => {
  const { description, lines } = req.body;
  if (!description || !lines || !Array.isArray(lines) || lines.length < 2) {
    return res.status(400).json({ error: 'Required: description, lines (array with at least 2 entries)' });
  }
  try {
    const entry = await TrustAccountingEngine.postJournalEntry(req.body);
    res.json({ success: true, data: entry });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/accounting/journal/:id ──────────────────────────────────────────
router.get('/journal/:id', async (req, res) => {
  try {
    const entry = await TrustAccountingEngine.getJournalEntry(req.params.id);
    if (!entry) return res.status(404).json({ success: false, error: `Journal entry ${req.params.id} not found` });
    res.json({ success: true, data: entry });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/accounting/journal/:id/reverse ─────────────────────────────────
router.post('/journal/:id/reverse', async (req, res) => {
  try {
    const reversal = await TrustAccountingEngine.reverseJournalEntry(
      req.params.id, { postedBy: req.body.postedBy }
    );
    res.json({ success: true, data: reversal });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// FINANCIAL REPORTS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /api/accounting/reports/trial-balance ────────────────────────────────
router.get('/reports/trial-balance', async (req, res) => {
  try {
    const tb = await TrustAccountingEngine.getTrialBalance({
      asOfDate: req.query.asOfDate,
    });
    res.json({ success: true, data: tb });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/accounting/reports/balance-sheet ────────────────────────────────
router.get('/reports/balance-sheet', async (req, res) => {
  try {
    const bs = await TrustAccountingEngine.getBalanceSheet({
      asOfDate: req.query.asOfDate,
    });
    res.json({ success: true, data: bs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/accounting/reports/income-statement ─────────────────────────────
router.get('/reports/income-statement', async (req, res) => {
  try {
    const is_ = await TrustAccountingEngine.getIncomeStatement({
      fromDate: req.query.fromDate,
      toDate: req.query.toDate,
    });
    res.json({ success: true, data: is_ });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/accounting/reports/cashflow ─────────────────────────────────────
router.get('/reports/cashflow', async (req, res) => {
  try {
    const cf = await TrustAccountingEngine.getCashflowStatement({
      fromDate: req.query.fromDate,
      toDate: req.query.toDate,
    });
    res.json({ success: true, data: cf });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ACCOUNTING PERIODS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /api/accounting/periods ──────────────────────────────────────────────
router.get('/periods', async (req, res) => {
  try {
    const periods = await TrustAccountingEngine.listPeriods({
      status: req.query.status,
    });
    res.json({ success: true, count: periods.length, data: periods });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/accounting/periods ─────────────────────────────────────────────
router.post('/periods', async (req, res) => {
  const { periodName, startDate, endDate } = req.body;
  if (!periodName || !startDate || !endDate) {
    return res.status(400).json({ error: 'Required: periodName, startDate, endDate' });
  }
  try {
    const period = await TrustAccountingEngine.createPeriod(req.body);
    res.json({ success: true, data: period });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/accounting/periods/:id/close ───────────────────────────────────
router.post('/periods/:id/close', async (req, res) => {
  try {
    const period = await TrustAccountingEngine.closePeriod(
      req.params.id, { closedBy: req.body.closedBy }
    );
    res.json({ success: true, data: period });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STATEMENT GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

// ─── POST /api/accounting/statements/generate ─────────────────────────────────
router.post('/statements/generate', async (req, res) => {
  const { reportType, fromDate, toDate, bondId, contactId, format } = req.body;
  const validTypes = ['balance_sheet', 'income_statement', 'cashflow', 'trial_balance', 'bond_statement'];
  if (!reportType || !validTypes.includes(reportType)) {
    return res.status(400).json({ error: `Required: reportType (one of ${validTypes.join(', ')})` });
  }
  try {
    const { GenerationEngine } = require('../integrations/documents/generationEngine');
    const result = await GenerationEngine.generateStatement({
      reportType,
      fromDate: fromDate || null,
      toDate: toDate || null,
      bondId: bondId || null,
      contactId: contactId || null,
      format: format || 'html',
      generatedBy: req.body.generatedBy || null,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/accounting/statements ───────────────────────────────────────────
router.get('/statements', async (req, res) => {
  try {
    const { GenerationEngine } = require('../integrations/documents/generationEngine');
    const statements = await GenerationEngine.listStatements({
      reportType: req.query.reportType,
      status: req.query.status,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ success: true, count: statements.length, data: statements });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/accounting/statements/:id ───────────────────────────────────────
router.get('/statements/:id', async (req, res) => {
  try {
    const { GenerationEngine } = require('../integrations/documents/generationEngine');
    const statement = await GenerationEngine.getStatement(req.params.id);
    if (!statement) return res.status(404).json({ success: false, error: `Statement ${req.params.id} not found` });
    res.json({ success: true, data: statement });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
