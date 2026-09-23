'use strict';

/**
 * Spritz On-Ramp API — /api/spritz-onramp
 *
 * Treasury-Core ERP bucket cash (1020 / 1030) -> Spritz ACH-debit on-ramp ->
 * USDC in the thirdweb treasury wallet, booked Dr 1025|1035 / Cr 1020|1030.
 * Reads are operator work; quoting is harmless (a Spritz preparation) but
 * proposing, approving and cancelling move trust value and are admin-only.
 * Execution only happens through the checker approval (spritz_on_ramp proposal).
 */

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { SpritzOnRampEngine } = require('../integrations/spritz/spritzOnRampEngine');

const router = express.Router();
const operatorAuth = requireAuth({ role: 'operator' });
const adminAuth = requireAuth({ role: 'admin' });

function principal(req) {
  const user = req.user || {};
  return user.email || user.username || user.userId || user.sub || req.body?.actor || null;
}

function sendError(res, err) {
  const status = err.status || err.statusCode || 400;
  res.status(status).json({ success: false, error: err.message, code: err.code || null });
}

router.get('/readiness', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await SpritzOnRampEngine.readiness() }); } catch (err) { sendError(res, err); }
});

router.get('/summary', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await SpritzOnRampEngine.summary() }); } catch (err) { sendError(res, err); }
});

router.get('/on-ramps', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await SpritzOnRampEngine.list({ status: req.query.status || null, bucket: req.query.bucket || null, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.get('/on-ramps/:onRampId', operatorAuth, async (req, res) => {
  try {
    const r = await SpritzOnRampEngine.get(req.params.onRampId);
    if (!r) return res.status(404).json({ success: false, error: 'not found', code: 'ONRAMP_NOT_FOUND' });
    res.json({ success: true, data: r });
  } catch (err) { sendError(res, err); }
});

router.post('/quote', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await SpritzOnRampEngine.quote({ amountUsd: req.body?.amountUsd, bucket: req.body?.bucket }) }); } catch (err) { sendError(res, err); }
});

router.post('/propose', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const b = req.body || {};
    res.status(201).json({ success: true, data: await SpritzOnRampEngine.propose({ amountUsd: b.amountUsd, bucket: b.bucket, reference: b.reference, createdBy: principal(req), autoApprove: Boolean(b.autoApprove) }) });
  } catch (err) { sendError(res, err); }
});

router.post('/approve', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const b = req.body || {};
    res.json({ success: true, data: await SpritzOnRampEngine.approve({ proposalId: b.proposalId, role: b.role, approverEmail: b.approverEmail || principal(req) }) });
  } catch (err) { sendError(res, err); }
});

router.post('/reconcile', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await SpritzOnRampEngine.reconcile() }); } catch (err) { sendError(res, err); }
});

router.post('/on-ramps/:onRampId/cancel', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await SpritzOnRampEngine.cancel({ onRampId: req.params.onRampId, reason: req.body?.reason }) }); } catch (err) { sendError(res, err); }
});

module.exports = router;
