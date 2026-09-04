'use strict';

/**
 * Third-Party Sender OS API — /api/tps-os
 *
 * Reading the register is operator-gated. Agreements and approvals change
 * what the bank is warranted, so they are admin-only; approval additionally
 * enforces four-eyes inside the engine.
 */

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { TpsOsEngine } = require('../integrations/os/thirdPartySenderOsEngine');

const router = express.Router();
const operatorAuth = requireAuth({ role: 'operator' });
const adminAuth = requireAuth({ role: 'admin' });

function principal(req) {
  const user = req.user || {};
  return user.email || user.username || user.userId || user.sub || req.body?.actor || null;
}

function sendError(res, err) {
  const status = err.status || err.statusCode || 400;
  res.status(status).json({ success: false, error: err.message, code: err.code || null, details: err.details || undefined });
}

router.get('/status', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TpsOsEngine.status() }); } catch (err) { sendError(res, err); }
});

router.get('/events', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TpsOsEngine.events({ subjectId: req.query.subjectId || null, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

// ── ODFI agreements ─────────────────────────────────────────────────────────

router.get('/agreements', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TpsOsEngine.agreements() }); } catch (err) { sendError(res, err); }
});

router.post('/agreements', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await TpsOsEngine.createAgreement({ ...req.body, createdBy: principal(req) }) }); } catch (err) { sendError(res, err); }
});

router.get('/agreements/:agreementId', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TpsOsEngine.agreement(req.params.agreementId) }); } catch (err) { sendError(res, err); }
});

router.post('/agreements/:agreementId/execute', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await TpsOsEngine.executeAgreement(req.params.agreementId, { ...req.body, actor: principal(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/agreements/:agreementId/status', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await TpsOsEngine.setAgreementStatus(req.params.agreementId, req.body.status, { actor: principal(req), reason: req.body.reason }) }); } catch (err) { sendError(res, err); }
});

// ── Originators ─────────────────────────────────────────────────────────────

router.get('/originators', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TpsOsEngine.originators() }); } catch (err) { sendError(res, err); }
});

router.post('/originators', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await TpsOsEngine.onboardOriginator({ ...req.body, onboardedBy: principal(req) }) }); } catch (err) { sendError(res, err); }
});

router.get('/originators/:originatorId', operatorAuth, async (req, res) => {
  try {
    const [originator, exposure, returns] = await Promise.all([
      TpsOsEngine.originator(req.params.originatorId),
      TpsOsEngine.exposureSnapshot(req.params.originatorId),
      TpsOsEngine.returnRates(req.params.originatorId),
    ]);
    const agreement = originator.agreementId ? await TpsOsEngine.agreement(originator.agreementId).catch(() => null) : null;
    res.json({ success: true, data: { ...originator, exposure, returns, approvalBlockers: TpsOsEngine.originatorApprovalBlockers(originator, agreement) } });
  } catch (err) { sendError(res, err); }
});

router.patch('/originators/:originatorId', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await TpsOsEngine.updateOriginator(req.params.originatorId, { ...req.body, actor: principal(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/originators/:originatorId/approve', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await TpsOsEngine.approveOriginator(req.params.originatorId, { approvedBy: principal(req), reviewIntervalMonths: req.body.reviewIntervalMonths }) }); } catch (err) { sendError(res, err); }
});

router.post('/originators/:originatorId/status', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await TpsOsEngine.setOriginatorStatus(req.params.originatorId, req.body.status, { actor: principal(req), reason: req.body.reason }) }); } catch (err) { sendError(res, err); }
});

router.post('/originators/:originatorId/exposure', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await TpsOsEngine.recordExposure({ ...req.body, originatorId: req.params.originatorId }) }); } catch (err) { sendError(res, err); }
});

router.post('/originators/:originatorId/returns', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await TpsOsEngine.recordReturn({ ...req.body, originatorId: req.params.originatorId }) }); } catch (err) { sendError(res, err); }
});

// ── Obligations ─────────────────────────────────────────────────────────────

router.get('/obligations', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TpsOsEngine.obligations({ status: req.query.status || null }) }); } catch (err) { sendError(res, err); }
});

router.post('/obligations/seed', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await TpsOsEngine.seedObligations({ owner: req.body.owner || null, actor: principal(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/obligations/:obligationId/complete', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await TpsOsEngine.completeObligation(req.params.obligationId, { completedBy: principal(req), evidence: req.body.evidence }) }); } catch (err) { sendError(res, err); }
});

// ── Preflight ───────────────────────────────────────────────────────────────

router.post('/preflight', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TpsOsEngine.preflight({ ...req.body, actor: principal(req) }) }); } catch (err) { sendError(res, err); }
});

module.exports = router;
