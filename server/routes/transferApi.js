'use strict';

/**
 * Transfer API — /api/transfer/v1 (backend of the GCP API Gateway facade)
 *
 * Gateway callers arrive with IAP principal = the gateway service account and
 * their own edge-verified identity in x-apigateway-api-userinfo; portal callers
 * arrive with a trustee JWT / admin token. Writes need an Idempotency-Key and
 * a Google/portal identity; API-key callers may only read.
 */

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { TransferApiOsEngine, TransferApiError, callerFromRequest, idempotencyKeyFromRequest, getTransferApiConfig, API_VERSION } = require('../integrations/os/transferApiOsEngine');

const router = express.Router();
const operatorAuth = requireAuth({ role: 'operator' });
const adminAuth = requireAuth({ role: 'admin' });

function sendError(res, err) {
  const status = err.statusCode || err.status || 400;
  res.status(status).json({ success: false, error: err.message, code: err.code || null, details: err.details || undefined });
}

/** Gateway identity first; otherwise the portal auth chain. */
function transferAuth(fallback) {
  return (req, res, next) => {
    const cfg = getTransferApiConfig();
    const pa = req.privateAccess || {};
    if (cfg.gatewayServiceAccount && pa.kind === 'platform' && String(pa.principal || '').toLowerCase() === cfg.gatewayServiceAccount) {
      req.transferCaller = callerFromRequest(req, cfg);
      if (!req.transferCaller) return sendError(res, new TransferApiError('gateway request without a verified caller identity', 'TRANSFER_API_UNAUTHENTICATED', 401));
      return next();
    }
    return fallback(req, res, (err) => {
      if (err) return next(err);
      req.transferCaller = callerFromRequest(req, cfg);
      next();
    });
  };
}

const v = `/${API_VERSION}`;

router.get(`${v}/status`, transferAuth(operatorAuth), async (req, res) => {
  try { res.json({ success: true, data: await TransferApiOsEngine.status() }); } catch (err) { sendError(res, err); }
});

router.get(`${v}/rails`, transferAuth(operatorAuth), async (req, res) => {
  try { res.json({ success: true, data: await TransferApiOsEngine.rails() }); } catch (err) { sendError(res, err); }
});

router.get(`${v}/transfers`, transferAuth(operatorAuth), async (req, res) => {
  try { res.json({ success: true, data: await TransferApiOsEngine.listTransfers({ limit: Number(req.query.limit) || 50 }) }); } catch (err) { sendError(res, err); }
});

router.get(`${v}/transfers/:id`, transferAuth(operatorAuth), async (req, res) => {
  try { res.json({ success: true, data: await TransferApiOsEngine.getTransfer({ transferId: req.params.id }) }); } catch (err) { sendError(res, err); }
});

router.post(`${v}/transfers`, transferAuth(adminAuth), writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    const data = await TransferApiOsEngine.transfer({ purposeClass: body.purposeClass, items: body.items, caller: req.transferCaller, idempotencyKey: idempotencyKeyFromRequest(req) });
    res.status(data.replayed ? 200 : 201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post(`${v}/transfers/:id/release`, transferAuth(adminAuth), writeRateLimiter(), async (req, res) => {
  try {
    res.json({ success: true, data: await TransferApiOsEngine.release({ transferId: req.params.id, caller: req.transferCaller, idempotencyKey: idempotencyKeyFromRequest(req) }) });
  } catch (err) { sendError(res, err); }
});

router.post(`${v}/transfers/:id/cancel`, transferAuth(adminAuth), writeRateLimiter(), async (req, res) => {
  try {
    res.json({ success: true, data: await TransferApiOsEngine.cancel({ transferId: req.params.id, reason: (req.body || {}).reason || null, caller: req.transferCaller, idempotencyKey: idempotencyKeyFromRequest(req) }) });
  } catch (err) { sendError(res, err); }
});

router.post(`${v}/screenings`, transferAuth(adminAuth), writeRateLimiter(), async (req, res) => {
  try {
    const b = req.body || {};
    const data = await TransferApiOsEngine.screen({ payee: b.payee, amountCents: b.amountCents, amount: b.amount, rail: b.rail, bankId: b.bankId, approvalRef: b.approvalRef, reference: b.reference, caller: req.transferCaller, idempotencyKey: idempotencyKeyFromRequest(req) });
    res.status(data.replayed ? 200 : 201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get(`${v}/screenings/:ref`, transferAuth(operatorAuth), async (req, res) => {
  try { res.json({ success: true, data: await TransferApiOsEngine.getScreening({ screeningRef: req.params.ref }) }); } catch (err) { sendError(res, err); }
});

router.post(`${v}/screenings/:ref/review`, transferAuth(adminAuth), writeRateLimiter(), async (req, res) => {
  try {
    const b = req.body || {};
    res.json({ success: true, data: await TransferApiOsEngine.reviewScreening({ screeningRef: req.params.ref, decision: b.decision, notes: b.notes, caller: req.transferCaller, idempotencyKey: idempotencyKeyFromRequest(req) }) });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
