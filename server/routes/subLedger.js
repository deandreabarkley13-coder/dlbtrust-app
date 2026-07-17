/**
 * Sub-Ledger Routes — DLB Trust
 * Mounts at: /api/sub-ledgers
 *
 * Per-client sub-ledger accounts within Core Banking.
 * Manages CRUD, transactions, transfers, rollup, and statements.
 */

'use strict';

var express = require('express');
var router  = express.Router();
var { SubLedgerEngine } = require('../integrations/accounting/subLedgerEngine');

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/dashboard', async function(req, res) {
  try {
    var dashboard = await SubLedgerEngine.getDashboard();
    res.json({ success: true, data: dashboard });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-LEDGER CRUD
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/', async function(req, res) {
  try {
    var ledgers = await SubLedgerEngine.listSubLedgers({
      contactId: req.query.contactId,
      parentAccountCode: req.query.parentAccountCode,
      subAccountType: req.query.subAccountType,
      status: req.query.status,
    });
    res.json({ success: true, count: ledgers.length, data: ledgers });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/rollup', async function(req, res) {
  try {
    var rollup = await SubLedgerEngine.getSubLedgerRollup();
    res.json({ success: true, data: rollup });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/:id', async function(req, res) {
  try {
    var ledger = await SubLedgerEngine.getSubLedger(req.params.id);
    if (!ledger) return res.status(404).json({ success: false, error: 'Sub-ledger not found' });
    res.json({ success: true, data: ledger });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/', async function(req, res) {
  var { contactId, parentAccountCode, subAccountName } = req.body;
  if (!contactId || !parentAccountCode || !subAccountName) {
    return res.status(400).json({ error: 'Required: contactId, parentAccountCode, subAccountName' });
  }
  try {
    var ledger = await SubLedgerEngine.createSubLedger(req.body);
    res.json({ success: true, data: ledger });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/:id', async function(req, res) {
  try {
    var ledger = await SubLedgerEngine.updateSubLedger(req.params.id, req.body);
    res.json({ success: true, data: ledger });
  } catch (err) {
    var status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSACTIONS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/:id/transactions', async function(req, res) {
  try {
    var txns = await SubLedgerEngine.getTransactions(req.params.id, {
      limit: req.query.limit,
      offset: req.query.offset,
      fromDate: req.query.fromDate,
      toDate: req.query.toDate,
    });
    res.json({ success: true, count: txns.length, data: txns });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/:id/transactions', async function(req, res) {
  var { transactionType, amount } = req.body;
  if (!transactionType || !amount) {
    return res.status(400).json({ error: 'Required: transactionType, amount' });
  }
  try {
    var result = await SubLedgerEngine.postTransaction({
      subLedgerId: req.params.id,
      ...req.body,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    var status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSFERS
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/transfer', async function(req, res) {
  var { fromSubLedgerId, toSubLedgerId, amount } = req.body;
  if (!fromSubLedgerId || !toSubLedgerId || !amount) {
    return res.status(400).json({ error: 'Required: fromSubLedgerId, toSubLedgerId, amount' });
  }
  try {
    var result = await SubLedgerEngine.transfer(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    var status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CLIENT STATEMENT
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/client/:contactId/statement', async function(req, res) {
  try {
    var statement = await SubLedgerEngine.getClientStatement(req.params.contactId, {
      fromDate: req.query.fromDate,
      toDate: req.query.toDate,
    });
    res.json({ success: true, data: statement });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE SUB-LEDGER
// ═══════════════════════════════════════════════════════════════════════════════

router.delete('/:id', async function(req, res) {
  try {
    var result = await SubLedgerEngine.deleteSubLedger(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    var status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUSH TO FINERACT GL
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/push-to-fineract', async function(req, res) {
  try {
    var result = await SubLedgerEngine.pushToFineract();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SYNC FROM BOND SUBSCRIPTIONS
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/sync-subscriptions', async function(req, res) {
  try {
    var result = await SubLedgerEngine.syncFromSubscriptions();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
