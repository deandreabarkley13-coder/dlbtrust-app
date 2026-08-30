'use strict';

/**
 * Payer OS API — /api/payer
 *
 * The trust as originator. Every route here pushes money out of an account the
 * book of record owns, or reports on one that was pushed; there is no endpoint
 * that debits anybody. Reading a plan reserves nothing and needs an operator
 * session; raising a push needs an operator, approving it needs a second
 * distinct one, and settling it posts to the ledger against the bank's own
 * reference, so it is admin-gated.
 */

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { PayerOsEngine } = require('../integrations/os/payerOsEngine');

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

router.get('/', operatorAuth, async (req, res) => {
  try {
    const readiness = await PayerOsEngine.readiness();
    res.status(readiness.ready ? 200 : 503).json({ success: readiness.ready, data: readiness });
  } catch (err) { sendError(res, err); }
});

router.get('/payees', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: PayerOsEngine.payees(req.query.type || null) });
  } catch (err) { sendError(res, err); }
});

router.get('/disbursements', operatorAuth, async (req, res) => {
  try {
    const data = await PayerOsEngine.list({
      disbursementType: req.query.type || null,
      status: req.query.status || null,
      limit: req.query.limit,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/disbursements/:id', operatorAuth, async (req, res) => {
  try {
    const disbursement = await PayerOsEngine.get(req.params.id);
    if (!disbursement) return res.status(404).json({ success: false, error: 'Disbursement not found' });
    res.json({ success: true, data: { disbursement, events: await PayerOsEngine.events(req.params.id) } });
  } catch (err) { sendError(res, err); }
});

router.post('/plan', operatorAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const data = await PayerOsEngine.plan({
      disbursementType: body.disbursementType || body.type,
      amountCents: body.amountCents,
      payee: body.payee || null,
      fundingSourceRef: body.fundingSource || null,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/disbursements', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    const data = await PayerOsEngine.initiate({
      disbursementType: body.disbursementType || body.type,
      amountCents: body.amountCents,
      payee: body.payee || null,
      fundingSourceRef: body.fundingSource || null,
      initiatedBy: principal(req),
      memo: body.memo || null,
    });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/disbursements/:id/approve', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await PayerOsEngine.approve(req.params.id, principal(req));
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/disbursements/:id/send', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await PayerOsEngine.send(req.params.id);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/disbursements/:id/settle', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await PayerOsEngine.settle(req.params.id, {
      ...(req.body || {}),
      settledBy: principal(req),
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/disbursements/:id/cancel', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await PayerOsEngine.cancel(req.params.id, principal(req));
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
