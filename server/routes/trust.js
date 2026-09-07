'use strict';

/**
 * /api/trust — Trust Mandate control plane.
 *
 *   GET  /mandate                      the canonical mandate every component reads
 *   GET  /control-plane                mandate + component readiness + unified snapshot + pipeline + gaps
 *   GET  /control-plane/readiness      config-only readiness (no ledger reads)
 *   GET  /control-plane/pipeline       pipeline stages and gaps only
 *   POST /control-plane/evaluate       { amountUsd, requesterRole?, purpose? } → mandate decision (no side effects)
 */

const express = require('express');
const { requireAuth } = require('../integrations/auth/securityMiddleware');
const { TrustControlPlaneEngine } = require('../integrations/trust/trustControlPlaneEngine');

const router = express.Router();
const operatorAuth = requireAuth({ role: 'operator' });

function sendError(res, err) {
  const status = err && err.status ? err.status : 500;
  if (status >= 500) console.error('[trust]', err && err.message ? err.message : err);
  res.status(status).json({ success: false, error: err && err.message ? err.message : 'Trust control plane error', code: err && err.code ? err.code : undefined });
}

router.get('/mandate', operatorAuth, (req, res) => {
  res.json({ success: true, data: TrustControlPlaneEngine.mandate() });
});

router.get('/control-plane', operatorAuth, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: await TrustControlPlaneEngine.controlPlane() });
  } catch (err) { sendError(res, err); }
});

router.get('/control-plane/readiness', operatorAuth, (req, res) => {
  try {
    res.json({ success: true, data: TrustControlPlaneEngine.readiness() });
  } catch (err) { sendError(res, err); }
});

router.get('/control-plane/pipeline', operatorAuth, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const readiness = TrustControlPlaneEngine.readiness();
    const snapshot = await TrustControlPlaneEngine.snapshot();
    const pipeline = TrustControlPlaneEngine.evaluatePipeline(readiness, snapshot);
    res.json({ success: true, data: { mandate: readiness.mandate, ...pipeline, generatedAt: new Date().toISOString() } });
  } catch (err) { sendError(res, err); }
});

router.post('/control-plane/evaluate', operatorAuth, async (req, res) => {
  try {
    const { amountUsd, requesterRole, purpose } = req.body || {};
    const usd = Number(amountUsd);
    if (!Number.isFinite(usd) || usd <= 0) {
      return res.status(400).json({ success: false, error: 'amountUsd must be a positive number' });
    }
    return res.json({ success: true, data: await TrustControlPlaneEngine.evaluateDistribution({ amountUsd: usd, requesterRole, purpose }) });
  } catch (err) { return sendError(res, err); }
});

module.exports = router;
