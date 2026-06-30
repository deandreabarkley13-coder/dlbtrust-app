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
      var wire = await WireEngine.initiateWire({
        amountCents: Math.round(amount * 100),
        beneficiaryName: accountHolder,
        beneficiaryAccount: accountNumber,
        beneficiaryRouting: routing,
        beneficiaryBankName: targetAccount.bankName || 'Betterment',
        description: memo,
        purpose: 'BILL Cash Account Deposit',
        paymentType: 'trust_distribution',
        initiatedBy: req.user === 'admin' ? 'admin' : (req.user && req.user.username) || 'system'
      });

      // Record the wire deposit in BILL's system via API
      var billRecord = null;
      try {
        billRecord = await billClient.recordDeposit({
          amount: amount,
          method: 'wire',
          memo: memo,
          bankAccountId: targetAccount.id
        });
      } catch(billErr) {
        console.error('[bill-deposit] BILL API recording failed (wire):', billErr.message);
      }

      return res.json({
        success: true,
        method: 'wire',
        wireId: wire.wire_id,
        amount: amount,
        status: wire.status,
        destination: (targetAccount.bankName || 'Betterment') + ' ****' + accountNumber.slice(-4),
        message: 'Wire transfer initiated and recorded in BILL.',
        billRecord: billRecord ? {
          receivedPayId: billRecord.receivedPayId,
          billStatus: billRecord.status,
          billDashboardVisible: true
        } : null
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

    // Record the ACH deposit in BILL's system via API
    var billRecord = null;
    try {
      billRecord = await billClient.recordDeposit({
        amount: amount,
        method: 'ach',
        memo: memo,
        bankAccountId: targetAccount.id
      });
    } catch(billErr) {
      console.error('[bill-deposit] BILL API recording failed (ach):', billErr.message);
    }

    res.json({
      success: true,
      method: 'ach',
      batchId: batch.batch_id,
      amount: amount,
      status: batch.status,
      destination: (targetAccount.bankName || 'Bank') + ' ****' + accountNumber.slice(-4),
      message: 'ACH credit initiated and recorded in BILL.',
      billRecord: billRecord ? {
        receivedPayId: billRecord.receivedPayId,
        billStatus: billRecord.status,
        billDashboardVisible: true
      } : null
    });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/bill/deposits ──────────────────────────────────────────────────
// List deposit history to BILL accounts (combines local ACH batches + BILL API records)
router.get('/deposits', async function(req, res) {
  try {
    var billClient = require(path.join(__dirname, '../integrations/bill/billClient'));
    var accounts = [];
    try { accounts = await billClient.listBankAccounts(); } catch(e) {}
    var routings = [];
    if (Array.isArray(accounts)) {
      accounts.forEach(function(a) { if (a.routingNumber) routings.push(a.routingNumber); });
    }

    var deposits = [];

    // 1. Local ACH batch records
    if (routings.length > 0) {
      try {
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

        deposits = result.rows.map(function(r) {
          return {
            batchId: r.batch_id,
            status: r.status,
            amount: r.amount_cents / 100,
            date: r.created_at,
            description: r.entry_description,
            destination: '****' + (r.account_number || '').slice(-4),
            recipient: r.individual_name,
            source: 'local',
            submittedToBill: false
          };
        });
      } catch(dbErr) {
        console.error('[bill-deposits] DB query failed:', dbErr.message);
      }
    }

    // 2. BILL API received payments (shows what's actually recorded in BILL)
    var billPayments = [];
    try {
      billPayments = await billClient.listReceivedPayments(20);
    } catch(e) { /* BILL API might be unavailable */ }

    if (billPayments.length > 0) {
      billPayments.forEach(function(rp) {
        deposits.push({
          batchId: rp.id,
          status: 'submitted_to_bill',
          amount: rp.amount,
          date: rp.createdTime || rp.paymentDate,
          description: rp.description || 'BILL deposit',
          destination: '****3054',
          recipient: 'BILL Cash Account',
          source: 'bill_api',
          submittedToBill: true,
          billPaymentType: rp.paymentType === '4' ? 'ACH' : (rp.paymentType === '6' ? 'Wire' : 'Other')
        });
      });
    }

    // Sort by date descending
    deposits.sort(function(a, b) {
      return new Date(b.date) - new Date(a.date);
    });

    res.json({ success: true, deposits: deposits });
  } catch(err) {
    res.json({ success: true, deposits: [], error: err.message });
  }
});

// ─── GET /api/bill/transactions ──────────────────────────────────────────────
// List BILL payment transactions directly from the BILL API
router.get('/transactions', async function(req, res) {
  try {
    var billClient = require(path.join(__dirname, '../integrations/bill/billClient'));
    if (!billClient.isConfigured()) {
      return res.json({ success: false, error: 'BILL not configured' });
    }

    var received = [];
    var sent = [];
    try { received = await billClient.listReceivedPayments(20); } catch(e) {}
    try { sent = await billClient.listSentPayments(20); } catch(e) {}

    res.json({
      success: true,
      received: received.map(function(rp) {
        return {
          id: rp.id,
          amount: rp.amount,
          date: rp.paymentDate || rp.createdTime,
          description: rp.description,
          paymentType: rp.paymentType === '4' ? 'ACH' : (rp.paymentType === '6' ? 'Wire' : 'Other'),
          status: rp.status === '0' ? 'recorded' : 'processed'
        };
      }),
      sent: sent.map(function(sp) {
        return {
          id: sp.id,
          amount: sp.amount,
          date: sp.processDate || sp.createdTime,
          name: sp.name,
          status: sp.status
        };
      })
    });
  } catch(err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
