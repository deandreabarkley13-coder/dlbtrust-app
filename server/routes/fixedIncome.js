'use strict';

/**
 * Fixed Income Distribution API — /api/fixed-income
 *
 * Booked coupon periods (1020) -> beneficiary distributions; operating
 * allocations (1030) -> trustee payouts. Reading is operator work; planning,
 * staging (ERP -> USDC funding), executing and cancelling move trust value and
 * are admin-only. Every stage/execute still requires the on-chain checker.
 */

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { FixedIncomeDistributionEngine } = require('../integrations/os/fixedIncomeDistributionEngine');

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
  try { res.json({ success: true, data: await FixedIncomeDistributionEngine.readiness() }); } catch (err) { sendError(res, err); }
});

router.get('/summary', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await FixedIncomeDistributionEngine.summary() }); } catch (err) { sendError(res, err); }
});

router.get('/sources', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await FixedIncomeDistributionEngine.unplannedSources({ limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.get('/distributions', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await FixedIncomeDistributionEngine.list({ status: req.query.status || null, bucket: req.query.bucket || null, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.get('/distributions/:distributionId', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await FixedIncomeDistributionEngine.get(req.params.distributionId) }); } catch (err) { sendError(res, err); }
});

router.post('/plan', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await FixedIncomeDistributionEngine.plan({ createdBy: principal(req), dryRun: Boolean(req.body?.dryRun) }) }); } catch (err) { sendError(res, err); }
});

router.post('/distributions/:distributionId/stage', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await FixedIncomeDistributionEngine.stage({ distributionId: req.params.distributionId, actor: principal(req), autoApprove: Boolean(req.body?.autoApprove) }) }); } catch (err) { sendError(res, err); }
});

router.post('/distributions/:distributionId/execute', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await FixedIncomeDistributionEngine.execute({ distributionId: req.params.distributionId, actor: principal(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/distributions/:distributionId/cancel', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await FixedIncomeDistributionEngine.cancel({ distributionId: req.params.distributionId, actor: principal(req), reason: req.body?.reason }) }); } catch (err) { sendError(res, err); }
});

router.post('/reconcile', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await FixedIncomeDistributionEngine.reconcile({ actor: principal(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/cycle', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await FixedIncomeDistributionEngine.runCycle({ actor: principal(req) }) }); } catch (err) { sendError(res, err); }
});

module.exports = router;
