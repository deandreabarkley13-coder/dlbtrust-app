'use strict';

/**
 * Venue Depository OS API — /api/venue-depository-os
 *
 * The trust's own bank accounts, joined to the aggregator accounts that read
 * them and the GL cash accounts they book to. Reads are operator-gated;
 * linking and probing change what the rails and the books believe about a
 * bank balance, so they are admin-gated.
 */

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { VenueDepositoryOsEngine } = require('../integrations/os/venueDepositoryOsEngine');

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

/** Every linked depository with its latest aggregator reading, plus depositories still unlinked. */
router.get('/depositories', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await VenueDepositoryOsEngine.snapshot() });
  } catch (err) { sendError(res, err); }
});

router.get('/depositories/:id', operatorAuth, async (req, res) => {
  try {
    const link = await VenueDepositoryOsEngine.get(req.params.id);
    if (!link) return res.status(404).json({ success: false, error: `${req.params.id} has no depository link` });
    res.json({ success: true, data: { link, reading: await VenueDepositoryOsEngine.read(req.params.id) } });
  } catch (err) { sendError(res, err); }
});

/** Join a registered depository venue to an aggregator account and a GL cash account. */
router.post('/depositories', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    const data = await VenueDepositoryOsEngine.link({
      venueId: body.venueId,
      connectionId: body.connectionId,
      externalAccountId: body.externalAccountId,
      glAccountCode: body.glAccountCode || VenueDepositoryOsEngine.DEFAULT_GL_ACCOUNT,
      linkedBy: body.linkedBy || principal(req),
      metadata: body.metadata || {},
    });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.delete('/depositories/:id', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    res.json({ success: true, data: await VenueDepositoryOsEngine.unlink(req.params.id) });
  } catch (err) { sendError(res, err); }
});

/** Read the bank through the aggregator (optionally pulling first) and record it as custody evidence. */
router.post('/depositories/:id/probe', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const refresh = String((req.body || {}).refresh || req.query.refresh || '') === 'true';
    res.json({ success: true, data: await VenueDepositoryOsEngine.probe(req.params.id, { refresh }) });
  } catch (err) { sendError(res, err); }
});

/** Compare every linked depository with the books; gaps become DataBridge discrepancies. */
router.post('/reconcile', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const refresh = String((req.body || {}).refresh || req.query.refresh || '') === 'true';
    res.json({ success: true, data: await VenueDepositoryOsEngine.reconcile({ refresh }) });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
