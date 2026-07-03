'use strict';

/**
 * Electronic Payment & Settlement API Routes
 */

var express = require('express');
var router = express.Router();
var settlementEngine = require('../integrations/payments/electronicSettlementEngine');

var requireAdmin = async function(req, res, next) {
  var adminToken = req.headers['x-admin-token'] || req.query.adminToken;
  if (adminToken && adminToken === process.env.ADMIN_SECRET_TOKEN) { req.user = 'admin'; return next(); }
  var authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    var token = authHeader.slice(7);
    if (token === process.env.ADMIN_SECRET_TOKEN || token === process.env.API_KEY) { req.user = 'admin'; return next(); }
  }
  if (!process.env.ADMIN_SECRET_TOKEN) { req.user = 'admin'; return next(); }
  return res.status(401).json({ success: false, error: 'Authentication required' });
};

// Dashboard
router.get('/dashboard', requireAdmin, async function(req, res) {
  try {
    var data = await settlementEngine.getDashboard();
    res.json({ success: true, data: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Submit electronic payment
router.post('/submit', requireAdmin, async function(req, res) {
  try {
    var result = await settlementEngine.submitElectronicPayment(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    if (err.mfa_required) {
      // PayBills needs MFA — return structured response so UI can prompt for code
      return res.json({
        success: false,
        mfa_required: true,
        challengeId: err.challengeId,
        settlementId: err.settlementId,
        payee_name: err.payee_name,
        amount: err.amount,
        error: 'BILL requires MFA verification for vendor payments. Enter the code sent to your phone/email.'
      });
    }
    res.status(400).json({ success: false, error: err.message });
  }
});

// Complete MFA-pending settlement (verify MFA + retry PayBills)
router.post('/complete-mfa', requireAdmin, async function(req, res) {
  try {
    var code = req.body.code;
    var challengeId = req.body.challengeId;
    var settlementId = req.body.settlementId;
    if (!code || !settlementId) {
      return res.json({ success: false, error: 'code and settlementId required' });
    }
    var result = await settlementEngine.completeMFASettlement({ code: code, challengeId: challengeId, settlementId: settlementId });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// List settlements
router.get('/settlements', requireAdmin, async function(req, res) {
  try {
    var settlements = await settlementEngine.listSettlements(req.query);
    res.json({ success: true, data: settlements });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get single settlement
router.get('/settlements/:id', requireAdmin, async function(req, res) {
  try {
    var settlement = await settlementEngine.getSettlement(req.params.id);
    if (!settlement) return res.status(404).json({ success: false, error: 'Settlement not found' });
    res.json({ success: true, data: settlement });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Advance settlement status
router.post('/settlements/:id/advance', requireAdmin, async function(req, res) {
  try {
    var result = await settlementEngine.advanceSettlementStatus(req.params.id, req.body.status, req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Confirm settlement
router.post('/settlements/:id/confirm', requireAdmin, async function(req, res) {
  try {
    var result = await settlementEngine.confirmSettlement(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Finalize settlement
router.post('/settlements/:id/finalize', requireAdmin, async function(req, res) {
  try {
    var result = await settlementEngine.finalizeSettlement(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Verify settlement integrity
router.get('/settlements/:id/verify', requireAdmin, async function(req, res) {
  try {
    var result = await settlementEngine.verifySettlementIntegrity(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Sync settlement to Data Bridge
router.post('/settlements/:id/sync', requireAdmin, async function(req, res) {
  try {
    var result = await settlementEngine.syncToDataBridge(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Poll settlements for status updates
router.post('/poll', requireAdmin, async function(req, res) {
  try {
    var results = await settlementEngine.pollSettlements();
    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Retry failed settlements
router.post('/retry-failed', requireAdmin, async function(req, res) {
  try {
    var results = await settlementEngine.retryFailedSettlements();
    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// List available sub-ledger funding accounts
router.get('/funding-accounts', requireAdmin, async function(req, res) {
  try {
    var accounts = await settlementEngine.listFundingAccounts();
    res.json({ success: true, data: accounts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Circuit breaker status
router.get('/circuit-status', requireAdmin, async function(req, res) {
  res.json({ success: true, data: settlementEngine.getCircuitStatus() });
});

module.exports = router;
