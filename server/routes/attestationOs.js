'use strict';

/**
 * Attestation OS API — /api/attestation-os
 *
 * One surface for the question every desk asks separately: what does the trust
 * actually hold, and who says so. Reads are operator-gated. Running an
 * attestation is a read of the outside world, so it is operator-gated too; a
 * statement attestation asserts a balance on an officer's word and is not.
 */

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { AttestationOsEngine } = require('../integrations/os/attestationOsEngine');

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

/** Claimed against attested, per desk, with the variance named. */
router.get('/snapshot', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await AttestationOsEngine.snapshot() });
  } catch (err) { sendError(res, err); }
});

router.get('/status', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await AttestationOsEngine.status() });
  } catch (err) { sendError(res, err); }
});

router.get('/observations', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await AttestationOsEngine.latest() });
  } catch (err) { sendError(res, err); }
});

/** Read every custody source now, and write down what each one answered. */
router.post('/attest', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await AttestationOsEngine.attest({ runBy: principal(req) });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

/**
 * A custodian with no balance API, attested on evidence. Admin-gated because
 * the trust is asserting a balance nobody's API confirmed.
 */
router.post('/statement', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    const data = await AttestationOsEngine.statement({
      domain: body.domain || 'treasury',
      sourceType: body.sourceType,
      sourceKey: body.sourceKey,
      asset: body.asset || 'USD',
      balanceCents: body.balanceCents,
      evidenceReference: body.evidenceReference,
      attestedBy: body.attestedBy || principal(req),
      detail: body.detail || {},
    });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

/** What a rail asks before it moves money. Refuses; never silently allows. */
router.post('/assert', operatorAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const data = await AttestationOsEngine.assertLive({
      amountCents: body.amountCents,
      rail: body.rail || 'external',
      domain: body.domain || 'treasury',
      accountId: body.accountId || null,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
