'use strict';

/**
 * Wire Transfer Routes — DLB Trust Platform
 * Mounts at: /api/wire
 *
 * Fedwire-style wire origination with dual-approval workflow,
 * IMAD/OMAD tracking, GL integration, and auto-routing.
 */

const express = require('express');
const router = express.Router();
const { WireEngine } = require('../integrations/wire/wireEngine');
const { ApiCredentials } = require('../integrations/ach/apiCredentials');

// ─── Auth Middleware (shared with ACH pipeline) ─────────────────────────────
const requireAuth = async (req, res, next) => {
  const adminToken = req.headers['x-admin-token'] || req.query.adminToken;
  if (adminToken && adminToken === process.env.ADMIN_SECRET_TOKEN) {
    req.authMethod = 'admin_token';
    req.authUser = 'admin';
    return next();
  }

  let apiKey = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    apiKey = authHeader.slice(7).trim();
  } else if (req.headers['x-api-key']) {
    apiKey = req.headers['x-api-key'];
  }

  if (apiKey) {
    try {
      const cred = await ApiCredentials.validate(apiKey);
      if (cred) {
        req.authMethod = 'api_key';
        req.apiCredential = cred;
        req.authUser = cred.label || 'api_user';
        return next();
      }
    } catch (err) { /* fall through */ }
  }

  return res.status(401).json({
    success: false,
    error: 'Authentication required. Use x-admin-token, Authorization: Bearer <api_key>, or X-API-Key header.',
  });
};

// ─── GET /api/wire/summary ─────────────────────────────────────────────────
// Wire transfer dashboard metrics
router.get('/summary', async (req, res) => {
  try {
    const summary = await WireEngine.getWireSummary();
    res.json({ success: true, data: summary });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/wire/initiate ───────────────────────────────────────────────
// Initiate a new wire transfer (maker action)
router.post('/initiate', requireAuth, async (req, res) => {
  try {
    const {
      amountCents, amountDollars,
      beneficiaryName, beneficiaryRouting, beneficiaryAccount,
      beneficiaryBankName, beneficiaryAddress,
      paymentType, purpose, description, wireType,
      requiresApproval,
      intermediaryRouting, intermediaryName,
      senderName, senderRouting, senderAccount, senderAddress,
    } = req.body;

    // Accept either cents or dollars
    let cents = amountCents;
    if (!cents && amountDollars) {
      cents = Math.round(parseFloat(amountDollars) * 100);
    }
    if (!cents || cents <= 0) {
      return res.status(400).json({ success: false, error: 'amountCents or amountDollars is required and must be positive' });
    }

    const wire = await WireEngine.initiateWire({
      amountCents: cents,
      beneficiaryName, beneficiaryRouting, beneficiaryAccount,
      beneficiaryBankName, beneficiaryAddress,
      paymentType, purpose, description, wireType,
      initiatedBy: req.authUser || 'admin',
      requiresApproval,
      intermediaryRouting, intermediaryName,
      senderName, senderRouting, senderAccount, senderAddress,
    });

    res.json({ success: true, data: wire });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── GET /api/wire/pending-approvals ───────────────────────────────────────
// List wires awaiting checker approval
router.get('/pending-approvals', requireAuth, async (req, res) => {
  try {
    const wires = await WireEngine.getPendingApprovals();
    res.json({ success: true, count: wires.length, data: wires });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/wire/:id/approve ────────────────────────────────────────────
// Approve a pending wire (checker action)
router.post('/:id/approve', requireAuth, async (req, res) => {
  try {
    const approvedBy = req.body.approvedBy || req.authUser || 'checker';
    const wire = await WireEngine.approveWire(req.params.id, approvedBy);
    res.json({ success: true, data: wire });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── POST /api/wire/:id/reject ─────────────────────────────────────────────
// Reject a pending wire (checker action)
router.post('/:id/reject', requireAuth, async (req, res) => {
  try {
    const rejectedBy = req.body.rejectedBy || req.authUser || 'checker';
    const reason = req.body.reason;
    const wire = await WireEngine.rejectWire(req.params.id, rejectedBy, reason);
    res.json({ success: true, data: wire });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── POST /api/wire/:id/send ───────────────────────────────────────────────
// Send an approved wire (transmit to Fed)
router.post('/:id/send', requireAuth, async (req, res) => {
  try {
    const wire = await WireEngine.sendWire(req.params.id);
    res.json({ success: true, data: wire });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/wire/:id/settle ─────────────────────────────────────────────
// Settle a confirmed wire
router.post('/:id/settle', requireAuth, async (req, res) => {
  try {
    const wire = await WireEngine.settleWire(req.params.id);
    res.json({ success: true, data: wire });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── POST /api/wire/:id/cancel ─────────────────────────────────────────────
// Cancel a pre-send wire
router.post('/:id/cancel', requireAuth, async (req, res) => {
  try {
    const wire = await WireEngine.cancelWire(req.params.id, req.authUser || 'admin');
    res.json({ success: true, data: wire });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── POST /api/wire/:id/return ─────────────────────────────────────────────
// Process a wire return
router.post('/:id/return', requireAuth, async (req, res) => {
  try {
    const wire = await WireEngine.returnWire(req.params.id, req.body.reason);
    res.json({ success: true, data: wire });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── GET /api/wire/transfers ───────────────────────────────────────────────
// List all wire transfers with optional filters
router.get('/transfers', async (req, res) => {
  try {
    const { status, fromDate, toDate, initiatedBy, limit, offset } = req.query;
    const wires = await WireEngine.listWires({
      status, fromDate, toDate, initiatedBy,
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0,
    });
    res.json({ success: true, count: wires.length, data: wires });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/wire/:id ─────────────────────────────────────────────────────
// Get a specific wire transfer
router.get('/:id', async (req, res) => {
  try {
    const wire = await WireEngine.getWire(req.params.id);
    if (!wire) return res.status(404).json({ success: false, error: 'Wire not found' });
    res.json({ success: true, data: wire });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/wire/:id/message ─────────────────────────────────────────────
// Get formatted Fedwire message for a wire
router.get('/:id/message', async (req, res) => {
  try {
    const wire = await WireEngine.getWire(req.params.id);
    if (!wire) return res.status(404).json({ success: false, error: 'Wire not found' });
    const message = WireEngine.formatWireMessage(wire);
    res.json({ success: true, data: message });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/wire/:id/audit ───────────────────────────────────────────────
// Get audit trail for a wire
router.get('/:id/audit', async (req, res) => {
  try {
    const log = await WireEngine.getWireAuditLog(req.params.id);
    res.json({ success: true, count: log.length, data: log });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/wire/route ──────────────────────────────────────────────────
// Check how a payment would be routed (ACH vs Wire)
router.post('/route', async (req, res) => {
  try {
    const { amountCents, amountDollars, urgent } = req.body;
    let cents = amountCents;
    if (!cents && amountDollars) {
      cents = Math.round(parseFloat(amountDollars) * 100);
    }
    if (!cents || cents <= 0) {
      return res.status(400).json({ success: false, error: 'amountCents or amountDollars is required' });
    }
    const routing = WireEngine.routePayment(cents, { urgent });
    res.json({ success: true, data: routing });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
