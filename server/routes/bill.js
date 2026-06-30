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
router.get('/status', async function(req, res) {
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
router.get('/accounts', async function(req, res) {
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
router.get('/balance', async function(req, res) {
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
router.get('/account/:id', async function(req, res) {
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

// ─── POST /api/bill/deposit ──────────────────────────────────────────────────
// Deposit funds to the BILL-linked bank account via ACH credit
router.post('/deposit', requireAdmin, async function(req, res) {
  try {
    var amount = parseFloat(req.body.amount);
    var memo = req.body.memo || 'BILL Cash Deposit';
    var method = req.body.method || 'ach'; // 'ach' or 'wire'

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, error: 'Amount must be greater than 0' });
    }
    if (amount > 10000000) {
      return res.status(400).json({ success: false, error: 'Amount exceeds maximum ($10,000,000)' });
    }

    var billClient = require(path.join(__dirname, '../integrations/bill/billClient'));
    if (!billClient.isConfigured()) {
      return res.json({ success: false, error: 'BILL not configured' });
    }

    // Get the first active bank account from BILL
    var accounts = await billClient.listBankAccounts();
    var targetAccount = null;
    if (Array.isArray(accounts)) {
      targetAccount = accounts.find(function(a) { return a.isActive === '1' || a.isActive === true; });
    }
    if (!targetAccount) {
      return res.json({ success: false, error: 'No active BILL bank account found' });
    }

    var routing = targetAccount.routingNumber;
    var accountNumber = targetAccount.accountNumber;
    var accountHolder = targetAccount.nameOnAcct || 'DEANDREA LAVAR BARKLEY TRUST';

    if (method === 'wire') {
      // Wire transfer to BILL account
      var WireEngine = require(path.join(__dirname, '../integrations/wire/wireEngine')).WireEngine;
      var wire = await WireEngine.originateWire({
        beneficiaryName: accountHolder,
        beneficiaryAccount: accountNumber,
        beneficiaryRouting: routing,
        beneficiaryBank: targetAccount.bankName || 'Betterment',
        amount: Math.round(amount * 100), // cents
        description: memo,
        paymentType: 'trust_distribution',
        createdBy: req.user === 'admin' ? 'admin' : (req.user && req.user.username) || 'system'
      });
      return res.json({
        success: true,
        method: 'wire',
        wireId: wire.wire_id,
        amount: amount,
        status: wire.status,
        destination: targetAccount.bankName + ' ****' + accountNumber.slice(-4),
        message: 'Wire transfer initiated. Requires approval before sending.'
      });
    }

    // ACH credit deposit (default)
    var ACHEngine = require(path.join(__dirname, '../integrations/ach/achEngine')).ACHEngine;
    var amountCents = Math.round(amount * 100);
    var batch = await ACHEngine.createBatch(
      {
        secCode: 'CCD',
        description: memo.substring(0, 10).toUpperCase(),
        effectiveDate: new Date().toISOString().split('T')[0],
        createdBy: req.user === 'admin' ? 'admin' : (req.user && req.user.username) || 'system'
      },
      [{
        receivingRouting: routing,
        accountNumber: accountNumber,
        amountCents: amountCents,
        transactionCode: '22', // Checking credit
        individualId: process.env.BILL_ORG_ID || '',
        individualName: accountHolder.substring(0, 22),
        memo: memo
      }]
    );

    res.json({
      success: true,
      method: 'ach',
      batchId: batch.batch_id,
      amount: amount,
      status: batch.status,
      destination: (targetAccount.bankName || 'Bank') + ' ****' + accountNumber.slice(-4),
      message: 'ACH credit initiated to BILL bank account'
    });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/bill/deposits ──────────────────────────────────────────────────
// List deposit history to BILL accounts
router.get('/deposits', async function(req, res) {
  try {
    var billClient = require(path.join(__dirname, '../integrations/bill/billClient'));
    var accounts = [];
    try { accounts = await billClient.listBankAccounts(); } catch(e) {}
    var routings = [];
    if (Array.isArray(accounts)) {
      accounts.forEach(function(a) { if (a.routingNumber) routings.push(a.routingNumber); });
    }

    if (routings.length === 0) {
      return res.json({ success: true, deposits: [] });
    }

    var pool = require(path.join(__dirname, '../integrations/bonds/pgPool'));
    var result = await pool.query(
      `SELECT b.batch_id, b.status, b.total_amount_cents, b.created_at, b.entry_description,
              e.receiving_routing, e.account_number, e.amount_cents, e.individual_name
       FROM ach_batches b
       JOIN ach_entries e ON b.batch_id = e.batch_id
       WHERE e.receiving_routing = ANY($1)
       ORDER BY b.created_at DESC
       LIMIT 50`,
      [routings]
    );

    var deposits = result.rows.map(function(r) {
      return {
        batchId: r.batch_id,
        status: r.status,
        amount: r.amount_cents / 100,
        date: r.created_at,
        description: r.entry_description,
        destination: '****' + (r.account_number || '').slice(-4),
        recipient: r.individual_name
      };
    });

    res.json({ success: true, deposits: deposits });
  } catch(err) {
    res.json({ success: true, deposits: [], error: err.message });
  }
});

module.exports = router;
