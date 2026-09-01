'use strict';

/**
 * Token Control API — /api/token-control
 *
 * The four control engines over one surface: what may exist (Cap Control),
 * whether the books agree about what does exist (Integrity Control), the
 * tickets that authorise new supply (Issuance OS), and the acts of creating and
 * destroying it (Mint & Exchange OS).
 *
 * Reads are operator-gated and change nothing. Every write is a step in a
 * maker-checker chain: no single route mints, burns or redeems on one
 * signature, and an exchange returns an unsettled obligation rather than
 * claiming the holder has been paid.
 */

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { CapControlEngine } = require('../integrations/os/capControlEngine');
const { IntegrityControlEngine } = require('../integrations/os/integrityControlEngine');
const { IssuanceOsEngine } = require('../integrations/os/issuanceOsEngine');
const { MintExchangeOsEngine } = require('../integrations/os/mintExchangeOsEngine');

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

// ─── Cap Control ────────────────────────────────────────────────────────────

router.get('/cap/config', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: CapControlEngine.config() });
  } catch (err) { sendError(res, err); }
});

/** A bond by row id, trust identifier (19781443-DLB-PRB), name or ISIN. */
router.get('/cap/bonds/:reference', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await CapControlEngine.bondSummary(req.params.reference) });
  } catch (err) { sendError(res, err); }
});

router.get('/cap/tokens/:tokenId', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await CapControlEngine.headroom(req.params.tokenId) });
  } catch (err) { sendError(res, err); }
});

router.get('/cap/tokens/:tokenId/excess', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await CapControlEngine.excess(req.params.tokenId) });
  } catch (err) { sendError(res, err); }
});

/** Would this mint fit? A read, so a desk can check before spending approvals. */
router.post('/cap/tokens/:tokenId/assess', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    const data = await CapControlEngine.assess({
      tokenId: req.params.tokenId,
      principalCents: body.principalCents || 0,
      interestCents: body.interestCents || 0,
    });
    res.status(data.allowed ? 200 : 409).json({ success: data.allowed, data });
  } catch (err) { sendError(res, err); }
});

// ─── Integrity Control ──────────────────────────────────────────────────────

router.get('/integrity', operatorAuth, async (req, res) => {
  try {
    const data = await IntegrityControlEngine.check({ tokenId: req.query.tokenId || null });
    res.status(data.clean ? 200 : 409).json({ success: data.clean, data });
  } catch (err) { sendError(res, err); }
});

/** Runs the same reconciliation and files the report, so breaches have a record. */
router.post('/integrity/runs', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const report = await IntegrityControlEngine.check({ tokenId: (req.body || {}).tokenId || null });
    const data = await IntegrityControlEngine.record(report, { checkedBy: principal(req) });
    res.status(data.clean ? 201 : 409).json({ success: data.clean, data });
  } catch (err) { sendError(res, err); }
});

// ─── Issuance OS ────────────────────────────────────────────────────────────

router.get('/issuances', operatorAuth, async (req, res) => {
  try {
    const data = await IssuanceOsEngine.list({
      status: req.query.status || null,
      tokenId: req.query.tokenId || null,
      limit: req.query.limit,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/issuances/status/:tokenId', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await IssuanceOsEngine.status(req.params.tokenId) });
  } catch (err) { sendError(res, err); }
});

router.get('/issuances/:issuanceId', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await IssuanceOsEngine.require(req.params.issuanceId) });
  } catch (err) { sendError(res, err); }
});

router.post('/issuances', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    const data = await IssuanceOsEngine.request({
      tokenId: body.tokenId,
      principalCents: body.principalCents || 0,
      interestCents: body.interestCents || 0,
      holderAddress: body.holderAddress || null,
      memo: body.memo || null,
      initiatedBy: principal(req),
    });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/issuances/:issuanceId/approve', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await IssuanceOsEngine.approve(req.params.issuanceId, principal(req));
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/issuances/:issuanceId/reject', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await IssuanceOsEngine.reject(req.params.issuanceId, {
      rejectedBy: principal(req),
      reason: (req.body || {}).reason || null,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Mint & Exchange OS ─────────────────────────────────────────────────────

router.get('/movements', operatorAuth, async (req, res) => {
  try {
    const data = await MintExchangeOsEngine.list({
      kind: req.query.kind || null,
      status: req.query.status || null,
      tokenId: req.query.tokenId || null,
      limit: req.query.limit,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/movements/:movementId', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await MintExchangeOsEngine.require(req.params.movementId) });
  } catch (err) { sendError(res, err); }
});

/** Mint. The amount is the approved ticket's; the body cannot name its own. */
router.post('/mints', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    const data = await MintExchangeOsEngine.mint({
      issuanceId: body.issuanceId,
      mintedBy: principal(req),
      expect: body.expect || null,
    });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/movements', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    const data = await MintExchangeOsEngine.request({
      kind: body.kind,
      tokenId: body.tokenId,
      holderAddress: body.holderAddress,
      principalCents: body.principalCents || 0,
      interestCents: body.interestCents || 0,
      memo: body.memo || null,
      initiatedBy: principal(req),
    });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/movements/:movementId/approve', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await MintExchangeOsEngine.approve(req.params.movementId, principal(req));
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/movements/:movementId/execute', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await MintExchangeOsEngine.execute(req.params.movementId, {
      settlementReference: (req.body || {}).settlementReference || null,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/movements/:movementId/cancel', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await MintExchangeOsEngine.cancel(req.params.movementId, principal(req));
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/burn-required/:tokenId', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await MintExchangeOsEngine.burnRequired(req.params.tokenId) });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
