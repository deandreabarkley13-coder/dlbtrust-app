'use strict';

/**
 * Collateral OS API — /api/collateral-os
 *
 * Reading the facility, positions and draws is operator work. Pledging and
 * releasing collateral, drawing spendable value and repaying it move trust
 * value, so they are admin-only. Settlement staging/execution and reconcile
 * are operator work: they only progress a draw the checker already approved.
 */

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { CollateralOsEngine } = require('../integrations/os/collateralOsEngine');

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

router.get('/readiness', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CollateralOsEngine.readiness() }); } catch (err) { sendError(res, err); }
});

router.get('/facility', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CollateralOsEngine.facility() }); } catch (err) { sendError(res, err); }
});

router.get('/events', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CollateralOsEngine.events({ subjectId: req.query.subjectId || null, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

// ── Positions ───────────────────────────────────────────────────────────────

router.get('/positions', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CollateralOsEngine.positions({ status: req.query.status || null }) }); } catch (err) { sendError(res, err); }
});

router.post('/positions/quote', operatorAuth, async (req, res) => {
  try {
    const { tokenAddress, symbol, chainId, quantity, quantityUnits, advanceRateBps } = req.body || {};
    res.json({ success: true, data: await CollateralOsEngine.quotePledge({ tokenAddress, symbol, chainId, quantity, quantityUnits, advanceRateBps }) });
  } catch (err) { sendError(res, err); }
});

router.post('/positions', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { tokenAddress, symbol, chainId, quantity, quantityUnits, advanceRateBps, custodyWallet } = req.body || {};
    const data = await CollateralOsEngine.pledge({ tokenAddress, symbol, chainId, quantity, quantityUnits, advanceRateBps, custodyWallet, pledgedBy: principal(req) });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/positions/:positionId', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CollateralOsEngine.position(req.params.positionId) }); } catch (err) { sendError(res, err); }
});

router.post('/positions/:positionId/release', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CollateralOsEngine.release({ positionId: req.params.positionId, actor: principal(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/revalue', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CollateralOsEngine.revalue({ positionId: (req.body || {}).positionId || null, actor: principal(req) }) }); } catch (err) { sendError(res, err); }
});

// ── Draws ───────────────────────────────────────────────────────────────────

router.get('/draws', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CollateralOsEngine.draws({ status: req.query.status || null, open: req.query.open === 'true', limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.post('/draws', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { amountUsd, reference, purpose, bucket, positionId } = req.body || {};
    const data = await CollateralOsEngine.draw({ amountUsd, reference, purpose, bucket, positionId, createdBy: principal(req) });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/draws/:drawId', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CollateralOsEngine.drawById(req.params.drawId) }); } catch (err) { sendError(res, err); }
});

router.post('/reconcile', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CollateralOsEngine.reconcile({ postedBy: principal(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/draws/:drawId/settle/stage', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { purpose, payoutWallet, rail, memo } = req.body || {};
    res.status(201).json({ success: true, data: await CollateralOsEngine.stageSettlement({ drawId: req.params.drawId, purpose, payoutWallet, rail, memo }) });
  } catch (err) { sendError(res, err); }
});

router.post('/draws/:drawId/settle/execute', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CollateralOsEngine.executeSettlement({ drawId: req.params.drawId, createdBy: principal(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/draws/:drawId/repay', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CollateralOsEngine.repay({ drawId: req.params.drawId, amountUsd: (req.body || {}).amountUsd, createdBy: principal(req) }) }); } catch (err) { sendError(res, err); }
});

module.exports = router;
