'use strict';

/**
 * Venue Account OS API — /api/venue-account-os
 *
 * The register of the trust's accounts at outside institutions. Reads are
 * operator-gated. Registering, approving and attesting change what the rails
 * believe about the outside world, so they are admin-gated, and approval keeps
 * the maker-checker split the engine enforces against the record rather than
 * the request.
 */

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { VenueAccountOsEngine } = require('../integrations/os/venueAccountOsEngine');

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

/** Every account, with credentials reported as present or missing, never as values. */
router.get('/accounts', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await VenueAccountOsEngine.snapshot() });
  } catch (err) { sendError(res, err); }
});

router.get('/accounts/:id', operatorAuth, async (req, res) => {
  try {
    const row = await VenueAccountOsEngine.get(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: `${req.params.id} is not a registered venue account` });
    res.json({ success: true, data: await VenueAccountOsEngine.describe(row) });
  } catch (err) { sendError(res, err); }
});

/** Which account can do this today, or precisely what is missing. */
router.get('/capability/:capability', operatorAuth, async (req, res) => {
  try {
    const data = await VenueAccountOsEngine.forCapability(req.params.capability, {
      requireFunds: String(req.query.requireFunds || '') === 'true',
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/accounts', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    const data = await VenueAccountOsEngine.register({
      provider: body.provider,
      label: body.label || null,
      externalReference: body.externalReference || null,
      registeredBy: body.registeredBy || principal(req),
      metadata: body.metadata || {},
    });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/accounts/:id/application', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    const data = await VenueAccountOsEngine.recordApplication(req.params.id, {
      reference: body.reference,
      filedBy: body.filedBy || principal(req),
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/accounts/:id/approval', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    const data = await VenueAccountOsEngine.recordApproval(req.params.id, {
      approvedBy: body.approvedBy || principal(req),
      evidenceReference: body.evidenceReference,
      externalReference: body.externalReference || null,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

/** Ask the venue what it holds, and record the answer as custody evidence. */
router.post('/accounts/:id/probe', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    res.json({ success: true, data: await VenueAccountOsEngine.probe(req.params.id) });
  } catch (err) { sendError(res, err); }
});

router.post('/probe', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    res.json({ success: true, data: await VenueAccountOsEngine.probeAll() });
  } catch (err) { sendError(res, err); }
});

/** A balance no API confirmed, asserted on evidence by a named trustee. */
router.post('/accounts/:id/attestation', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    const data = await VenueAccountOsEngine.attestBalance(req.params.id, {
      balanceCents: body.balanceCents,
      evidenceReference: body.evidenceReference,
      attestedBy: body.attestedBy || principal(req),
      asset: body.asset || 'USD',
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/accounts/:id/suspend', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    const data = await VenueAccountOsEngine.suspend(req.params.id, {
      reason: body.reason,
      suspendedBy: body.suspendedBy || principal(req),
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/accounts/:id/reinstate', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await VenueAccountOsEngine.reinstate(req.params.id, { reinstatedBy: principal(req) });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/accounts/:id/close', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    const data = await VenueAccountOsEngine.close(req.params.id, {
      reason: body.reason || null,
      closedBy: principal(req),
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
