'use strict';

/**
 * Bond Redemption Clearing & Settlement OS API — /api/bond-redemption-os
 *
 * Reading the calendar and register is operator-gated. Announcing a call,
 * funding and settling a batch retire principal and move trust cash, so they
 * are admin-only. The record-date strike and the clearing gate are operator
 * work; they change nothing on the bond ledger.
 */

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { BondRedemptionOsEngine } = require('../integrations/os/bondRedemptionOsEngine');

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
  try { res.json({ success: true, data: await BondRedemptionOsEngine.status() }); } catch (err) { sendError(res, err); }
});

router.get('/events', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await BondRedemptionOsEngine.events({ subjectId: req.query.subjectId || null, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.get('/calendar', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await BondRedemptionOsEngine.upcoming({ horizonDays: req.query.horizonDays }) }); } catch (err) { sendError(res, err); }
});

router.post('/preflight', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await BondRedemptionOsEngine.preflight(req.body || {}) }); } catch (err) { sendError(res, err); }
});

// ── Notices ─────────────────────────────────────────────────────────────────

router.get('/notices', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await BondRedemptionOsEngine.notices({ status: req.query.status || null, bondId: req.query.bondId || null, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.post('/notices', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await BondRedemptionOsEngine.announce({ ...req.body, announcedBy: principal(req) }) }); } catch (err) { sendError(res, err); }
});

router.get('/notices/:noticeId', operatorAuth, async (req, res) => {
  try {
    const [notice, allocations] = await Promise.all([BondRedemptionOsEngine.notice(req.params.noticeId), BondRedemptionOsEngine.allocations(req.params.noticeId)]);
    res.json({ success: true, data: { ...notice, allocations } });
  } catch (err) { sendError(res, err); }
});

router.post('/notices/:noticeId/record', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await BondRedemptionOsEngine.strikeRecord(req.params.noticeId, { holders: req.body.holders, recordDate: req.body.recordDate, actor: principal(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/notices/:noticeId/clear', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await BondRedemptionOsEngine.clear(req.params.noticeId, { actor: principal(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/notices/:noticeId/cancel', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await BondRedemptionOsEngine.cancelNotice(req.params.noticeId, { actor: principal(req), reason: req.body.reason }) }); } catch (err) { sendError(res, err); }
});

// ── Batches ─────────────────────────────────────────────────────────────────

router.get('/batches', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await BondRedemptionOsEngine.batches({ status: req.query.status || null, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.post('/batches', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await BondRedemptionOsEngine.openBatch({ ...req.body, openedBy: principal(req) }) }); } catch (err) { sendError(res, err); }
});

router.get('/batches/:batchId', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await BondRedemptionOsEngine.batch(req.params.batchId) }); } catch (err) { sendError(res, err); }
});

router.post('/batches/:batchId/fund', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await BondRedemptionOsEngine.fundBatch(req.params.batchId, { fundedBy: principal(req), force: Boolean(req.body.force) }) }); } catch (err) { sendError(res, err); }
});

router.post('/batches/:batchId/settle', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await BondRedemptionOsEngine.settleBatch(req.params.batchId, { settledBy: principal(req), postGl: req.body.postGl !== false }) }); } catch (err) { sendError(res, err); }
});

router.post('/batches/:batchId/cancel', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await BondRedemptionOsEngine.cancelBatch(req.params.batchId, { cancelledBy: principal(req), reason: req.body.reason }) }); } catch (err) { sendError(res, err); }
});

// ── Ledger drain ────────────────────────────────────────────────────────────

router.get('/ledger/unposted', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await BondRedemptionOsEngine.unpostedSettlements({ limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.post('/ledger/sync', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { DataBridge } = require('../integrations/accounting/dataBridge');
    res.json({ success: true, data: await DataBridge.syncBondRedemptionsToAccounting() });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
