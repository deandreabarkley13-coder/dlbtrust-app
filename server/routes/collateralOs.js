'use strict';

/**
 * Collateral OS API — /api/collateral-os
 *
 * Reading the facility, positions and draws is operator work. Pledging,
 * drawing, settling, repaying and releasing change the borrowing base or move
 * trust value, so they are admin-only; revalue and reconcile only read prices
 * and ERP request state and are operator work.
 */

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { CollateralOsEngine } = require('../integrations/os/collateralOsEngine');

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

router.get('/readiness', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CollateralOsEngine.readiness() }); } catch (err) { sendError(res, err); }
});

router.get('/status', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CollateralOsEngine.status() }); } catch (err) { sendError(res, err); }
});

router.get('/facility', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CollateralOsEngine.facility() }); } catch (err) { sendError(res, err); }
});

router.get('/events', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CollateralOsEngine.events({ subjectId: req.query.subjectId || null, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

// ── Positions ───────────────────────────────────────────────────────────────

router.get('/positions', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CollateralOsEngine.positions({ status: req.query.status || null, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.post('/positions', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await CollateralOsEngine.pledge({ ...req.body, pledgedBy: principal(req) }) }); } catch (err) { sendError(res, err); }
});

router.get('/positions/:positionId', operatorAuth, async (req, res) => {
  try {
    const [position, draws] = await Promise.all([CollateralOsEngine.position(req.params.positionId), CollateralOsEngine.draws({ positionId: req.params.positionId })]);
    res.json({ success: true, data: { ...position, draws } });
  } catch (err) { sendError(res, err); }
});

router.post('/positions/:positionId/release', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CollateralOsEngine.release({ positionId: req.params.positionId, actor: principal(req), reason: req.body.reason }) }); } catch (err) { sendError(res, err); }
});

router.post('/revalue', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CollateralOsEngine.revalue({ actor: principal(req) }) }); } catch (err) { sendError(res, err); }
});

// ── Draws ───────────────────────────────────────────────────────────────────

router.get('/draws', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CollateralOsEngine.draws({ status: req.query.status || null, positionId: req.query.positionId || null, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.post('/draws', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await CollateralOsEngine.draw({ ...req.body, createdBy: principal(req) }) }); } catch (err) { sendError(res, err); }
});

router.get('/draws/:drawId', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CollateralOsEngine.getDraw(req.params.drawId) }); } catch (err) { sendError(res, err); }
});

router.post('/draws/:drawId/settle', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CollateralOsEngine.settle({ drawId: req.params.drawId, ...req.body, actor: principal(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/draws/:drawId/execute', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CollateralOsEngine.executeSettlement({ drawId: req.params.drawId, actor: principal(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/draws/:drawId/repay', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CollateralOsEngine.repay({ drawId: req.params.drawId, amountUsd: req.body.amountUsd, reference: req.body.reference, actor: principal(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/reconcile', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CollateralOsEngine.reconcile({ postedBy: principal(req) }) }); } catch (err) { sendError(res, err); }
});

module.exports = router;
