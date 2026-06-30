'use strict';

var express = require('express');
var router = express.Router();
var path = require('path');

// Auth middleware — require admin token, JWT, or API key
var requireAdmin = async function(req, res, next) {
  // 1. Admin secret token (x-admin-token header)
  var adminToken = req.headers['x-admin-token'] || req.query.adminToken;
  if (adminToken && adminToken === process.env.ADMIN_SECRET_TOKEN) {
    req.user = 'admin';
    return next();
  }
  // 2. Bearer token — try JWT first, then API key
  var authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    var token = authHeader.slice(7).trim();
    // Try JWT from login session
    try {
      var UserAuth = require(path.join(__dirname, '../integrations/auth/userAuth')).UserAuth;
      var decoded = await UserAuth.verifyToken(token);
      if (decoded && decoded.role === 'admin') {
        req.user = decoded;
        return next();
      }
    } catch(e) { /* not a valid JWT, try API key next */ }
    // Try API key
    try {
      var ApiCredentials = require(path.join(__dirname, '../integrations/ach/apiCredentials')).ApiCredentials;
      var cred = await ApiCredentials.validate(token);
      if (cred) { req.user = cred.label || 'api_key'; return next(); }
    } catch(e) { /* not valid API key either */ }
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
