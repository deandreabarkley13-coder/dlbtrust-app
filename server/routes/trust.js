'use strict';

/**
 * /api/trust — Trust Mandate control plane.
 *
 *   GET  /mandate                      the canonical mandate every component reads
 *   GET  /control-plane                mandate + component readiness + unified snapshot + pipeline + gaps
 *   GET  /control-plane/readiness      config-only readiness (no ledger reads)
 *   GET  /control-plane/pipeline       pipeline stages and gaps only
 *   POST /control-plane/evaluate       { amountUsd, requesterRole?, purpose? } → mandate decision (no side effects)
 *
 * Trust token rail (fixed income → bond token → reserve vault → trust token → expense wallet):
 *   GET  /token-rail                   readiness + on-chain state + recent runs
 *   GET  /token-rail/readiness         config-only readiness
 *   GET  /token-rail/off-ramp          what carries trust token to a merchant/card/bill (and what is configured)
 *   POST /token-rail/plan              validate a request without running it
 *   POST /token-rail/run               run the pipeline (admin; live only when every gate is on)
 *   GET  /token-rail/runs              recent runs
 *   GET  /token-rail/runs/:id          one run, all stages
 *   POST /token-rail/runs/:id/notarize record Fabric evidence for a run whose evidence stage failed (admin)
 *   POST /token-rail/reconcile         rail-wide reconciliation from state
 */

const express = require('express');
const { requireAuth } = require('../integrations/auth/securityMiddleware');
const { TrustControlPlaneEngine } = require('../integrations/trust/trustControlPlaneEngine');
const { TrustTokenRailEngine, UNNOTARIZED } = require('../integrations/dapp/trustTokenRailEngine');

const router = express.Router();
const INCOMPLETE = new Set(['failed', UNNOTARIZED]);
const operatorAuth = requireAuth({ role: 'operator' });
const adminAuth = requireAuth({ role: 'admin' });

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

// ------------------------------------------------------------ token rail

router.get('/token-rail', operatorAuth, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: await TrustTokenRailEngine.status() });
  } catch (err) { sendError(res, err); }
});

router.get('/token-rail/readiness', operatorAuth, (req, res) => {
  try {
    res.json({ success: true, data: TrustTokenRailEngine.readiness() });
  } catch (err) { sendError(res, err); }
});

router.get('/token-rail/off-ramp', operatorAuth, (req, res) => {
  try {
    res.json({ success: true, data: TrustTokenRailEngine.offRamp() });
  } catch (err) { sendError(res, err); }
});

router.post('/token-rail/plan', operatorAuth, (req, res) => {
  try {
    res.json({ success: true, data: TrustTokenRailEngine.plan(req.body || {}) });
  } catch (err) { sendError(res, err); }
});

router.post('/token-rail/run', adminAuth, async (req, res) => {
  try {
    const run = await TrustTokenRailEngine.run(req.body || {});
    const ok = !INCOMPLETE.has(run.status);
    res.status(ok ? 200 : 422).json({ success: ok, data: run });
  } catch (err) { sendError(res, err); }
});

router.post('/token-rail/runs/:id/notarize', adminAuth, async (req, res) => {
  try {
    const run = await TrustTokenRailEngine.notarize({ runId: req.params.id, force: Boolean(req.body && req.body.force) });
    const ok = !INCOMPLETE.has(run.status);
    res.status(ok ? 200 : 422).json({ success: ok, data: run });
  } catch (err) { sendError(res, err); }
});

router.get('/token-rail/runs', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await TrustTokenRailEngine.listRuns({ limit: req.query.limit }) });
  } catch (err) { sendError(res, err); }
});

router.get('/token-rail/runs/:id', operatorAuth, async (req, res) => {
  try {
    const run = await TrustTokenRailEngine.getRun(req.params.id);
    if (!run) return res.status(404).json({ success: false, error: `run ${req.params.id} not found` });
    return res.json({ success: true, data: run });
  } catch (err) { return sendError(res, err); }
});

router.post('/token-rail/reconcile', operatorAuth, async (req, res) => {
  try {
    const run = req.body && req.body.runId ? await TrustTokenRailEngine.getRun(req.body.runId) : null;
    if (req.body && req.body.runId && !run) return res.status(404).json({ success: false, error: `run ${req.body.runId} not found` });
    return res.json({ success: true, data: await TrustTokenRailEngine.reconcile({ run }) });
  } catch (err) { return sendError(res, err); }
});

module.exports = router;
