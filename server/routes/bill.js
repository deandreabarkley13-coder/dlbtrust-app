'use strict';

var express = require('express');
var router = express.Router();
var path = require('path');

// Auth middleware — require admin token (same pattern as backup/resilience routes)
var requireAdmin = function(req, res, next) {
  var adminToken = req.headers['x-admin-token'] || req.query.adminToken;
  if (adminToken && adminToken === process.env.ADMIN_SECRET_TOKEN) {
    req.user = 'admin';
    return next();
  }
  var authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      var ApiCredentials = require(path.join(__dirname, '../integrations/ach/apiCredentials')).ApiCredentials;
      ApiCredentials.validate(authHeader.slice(7).trim()).then(function(cred) {
        if (cred) { req.user = cred.label || 'api_key'; return next(); }
        return res.status(401).json({ error: 'Authentication required' });
      }).catch(function() {
        return res.status(401).json({ error: 'Authentication required' });
      });
    } catch(e) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    return;
  }
  return res.status(401).json({ error: 'Authentication required' });
};

// ─── GET /api/bill/status ─────────────────────────────────────────────────────
// Returns BILL connection status
router.get('/status', requireAdmin, async function(req, res) {
  try {
    var billClient = require(path.join(__dirname, '../integrations/bill/billClient'));
    var status = await billClient.getStatus();
    res.json({ success: true, bill: status });
  } catch(err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── GET /api/bill/accounts ───────────────────────────────────────────────────
// List all bank accounts
router.get('/accounts', requireAdmin, async function(req, res) {
  try {
    var billClient = require(path.join(__dirname, '../integrations/bill/billClient'));
    if (!billClient.isConfigured()) {
      return res.json({ success: false, error: 'BILL not configured' });
    }
    var accounts = await billClient.listBankAccounts();
    res.json({ success: true, accounts: accounts });
  } catch(err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── GET /api/bill/balance ────────────────────────────────────────────────────
// Get organization bank balance
router.get('/balance', requireAdmin, async function(req, res) {
  try {
    var billClient = require(path.join(__dirname, '../integrations/bill/billClient'));
    if (!billClient.isConfigured()) {
      return res.json({ success: false, error: 'BILL not configured' });
    }
    var balance = await billClient.getBankBalance();
    res.json({ success: true, balance: balance });
  } catch(err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── GET /api/bill/account/:id ────────────────────────────────────────────────
// Get specific bank account details
router.get('/account/:id', requireAdmin, async function(req, res) {
  try {
    var billClient = require(path.join(__dirname, '../integrations/bill/billClient'));
    if (!billClient.isConfigured()) {
      return res.json({ success: false, error: 'BILL not configured' });
    }
    var account = await billClient.getBankAccount(req.params.id);
    res.json({ success: true, account: account });
  } catch(err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
