'use strict';

/**
 * Money Movement OS API — /api/money-movement-os
 *
 * Acquiring the trust's first on-chain value. Reads are operator-gated;
 * raising, approving and executing an acquisition spend real dollars at a
 * trading venue, so they are admin-gated and keep the maker-checker split the
 * engine enforces — the API cannot hand both roles to one caller because the
 * checker is compared against the maker on the record, not on the request.
 */

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { MoneyMovementOsEngine } = require('../integrations/os/moneyMovementOsEngine');

const router = express.Router();
const operatorAuth = requireAuth({ role: 'operator' });
const adminAuth = requireAuth({ role: 'admin' });

function principal(req) {
  const user = req.user || {};
  return user.email || user.username || user.userId || user.sub || null;
}

function sendError(res, err) {
  const status = err.status || err.statusCode || 400;
  res.status(status).json({ success: false, error: err.message, code: err.code || null });
}

/** Whether dollars can become XLM right now, and what is missing if not. */
router.get('/readiness', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await MoneyMovementOsEngine.readiness() });
  } catch (err) { sendError(res, err); }
});

router.get('/plan', operatorAuth, async (req, res) => {
  try {
    const usdCents = Number(req.query.usdCents || 500);
    res.json({ success: true, data: await MoneyMovementOsEngine.plan({ usdCents }) });
  } catch (err) { sendError(res, err); }
});

router.get('/acquisitions', operatorAuth, async (req, res) => {
  try {
    const data = await MoneyMovementOsEngine.list({
      status: req.query.status || null,
      limit: req.query.limit || 50,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/acquisitions/:id', operatorAuth, async (req, res) => {
  try {
    const data = await MoneyMovementOsEngine.get(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: `${req.params.id} not found` });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/acquisitions', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    const data = await MoneyMovementOsEngine.initiate({
      usdCents: body.usdCents,
      initiatedBy: body.initiatedBy || principal(req),
      memo: body.memo || null,
    });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/acquisitions/:id/approve', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    const data = await MoneyMovementOsEngine.approve(req.params.id, body.approvedBy || principal(req));
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/acquisitions/:id/deposit', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    const data = await MoneyMovementOsEngine.recordDeposit(req.params.id, {
      reference: body.reference,
      sentBy: body.sentBy || principal(req),
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

/** Buys XLM with real dollars and withdraws it on-chain. */
router.post('/acquisitions/:id/execute', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await MoneyMovementOsEngine.execute(req.params.id, { executedBy: principal(req) });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

/** Recognise what Horizon shows. Idempotent: a confirmed acquisition is returned as-is. */
router.post('/acquisitions/:id/confirm', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await MoneyMovementOsEngine.confirm(req.params.id, { confirmedBy: principal(req) });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
