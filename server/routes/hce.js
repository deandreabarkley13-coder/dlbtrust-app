'use strict';

/**
 * HCE (Host Card Emulation) Payment API Routes
 * ──────────────────────────────────────────────
 *
 * Endpoints for Android HCE NFC contactless payment management:
 *   - Device registration and management
 *   - Payment authorization and token generation
 *   - Transaction processing and settlement
 *   - Approval workflows for high-value payments
 *   - Dashboard and transaction history
 */

var express = require('express');
var router = express.Router();
var path = require('path');
var HD = path.resolve(__dirname, '../..');

var requireAdmin;
try {
  requireAdmin = require(path.join(HD, 'server', 'integrations', 'auth', 'securityMiddleware')).requireAdmin;
} catch (e) {
  requireAdmin = function(req, res, next) {
    var token = req.headers['x-admin-token'];
    if (token === (process.env.ADMIN_TOKEN || 'dlb-admin-2026-trust')) return next();
    res.status(401).json({ success: false, error: 'Unauthorized' });
  };
}

var hceEngine = require(path.join(HD, 'server', 'integrations', 'payments', 'hcePaymentEngine'));

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

router.get('/dashboard', requireAdmin, async function(req, res) {
  try {
    var data = await hceEngine.getDashboard();
    res.json({ success: true, data: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── DEVICE MANAGEMENT ───────────────────────────────────────────────────────

router.post('/devices/register', requireAdmin, async function(req, res) {
  try {
    var result = await hceEngine.registerDevice(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/devices', requireAdmin, async function(req, res) {
  try {
    var devices = await hceEngine.listDevices();
    res.json({ success: true, data: devices });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/devices/:deviceId', requireAdmin, async function(req, res) {
  try {
    var device = await hceEngine.getDevice(req.params.deviceId);
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });
    res.json({ success: true, data: device });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/devices/:deviceId', requireAdmin, async function(req, res) {
  try {
    var device = await hceEngine.updateDevice(req.params.deviceId, req.body);
    res.json({ success: true, data: device });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/devices/:deviceId/deactivate', requireAdmin, async function(req, res) {
  try {
    var result = await hceEngine.deactivateDevice(req.params.deviceId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── PAYMENT AUTHORIZATION (Android app calls this) ──────────────────────────

router.post('/authorize', requireAdmin, async function(req, res) {
  try {
    var result = await hceEngine.authorizePayment(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── PAYMENT PROCESSING (after terminal tap confirms) ────────────────────────

router.post('/process/:txnId', requireAdmin, async function(req, res) {
  try {
    var receipt = await hceEngine.processPayment(req.params.txnId, req.body);
    res.json({ success: true, data: receipt });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── APPROVAL WORKFLOW ───────────────────────────────────────────────────────

router.post('/approve/:txnId', requireAdmin, async function(req, res) {
  try {
    var result = await hceEngine.approveTransaction(req.params.txnId, req.body.approved_by || 'admin');
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/decline/:txnId', requireAdmin, async function(req, res) {
  try {
    var result = await hceEngine.declineTransaction(req.params.txnId, req.body.reason);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── REVERSAL ─────────────────────────────────────────────────────────────────

router.post('/reverse/:txnId', requireAdmin, async function(req, res) {
  try {
    var result = await hceEngine.reverseTransaction(req.params.txnId, req.body.reason);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── TRANSACTION QUERIES ─────────────────────────────────────────────────────

router.get('/transactions', requireAdmin, async function(req, res) {
  try {
    var txns = await hceEngine.listTransactions(req.query);
    res.json({ success: true, data: txns });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/transactions/:txnId', requireAdmin, async function(req, res) {
  try {
    var txn = await hceEngine.getTransaction(req.params.txnId);
    if (!txn) return res.status(404).json({ success: false, error: 'Transaction not found' });
    res.json({ success: true, data: txn });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── TOKEN VERIFICATION (Android app calls to verify token validity) ─────────

router.post('/verify-token', requireAdmin, async function(req, res) {
  try {
    var token = req.body.token;
    if (!token) return res.json({ success: false, error: 'Token required' });
    var payload = hceEngine.verifyToken(token);
    if (!payload) return res.json({ success: false, error: 'Invalid or expired token' });
    res.json({ success: true, data: { valid: true, payload: payload } });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── CIRCUIT BREAKER STATUS ──────────────────────────────────────────────────

router.get('/circuit-status', requireAdmin, async function(req, res) {
  try {
    var status = await hceEngine.getCircuitStatus();
    res.json({ success: true, data: status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
