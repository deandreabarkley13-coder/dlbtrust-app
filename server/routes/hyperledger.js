'use strict';

/**
 * Hyperledger API — /api/hyperledger
 *
 * Two surfaces, one story. Fabric answers "can anyone prove what the trust
 * recorded"; FireFly answers "did the counterparty get the same story with the
 * money". Reads are operator-gated. Anything that anchors a digest, messages a
 * counterparty, or moves tokenized value is admin-gated — those are trustee
 * acts, not desk queries.
 *
 * The webhook is unauthenticated by design (FireFly calls it) and verifies an
 * HMAC over the raw body instead; see FireflyEngine.verifySignature.
 */

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { FabricLedgerEngine } = require('../integrations/hyperledger/fabricLedgerEngine');
const { FireflyEngine } = require('../integrations/hyperledger/fireflyEngine');

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

// ─── readiness ──────────────────────────────────────────────────────────────

router.get('/readiness', operatorAuth, (req, res) => {
  res.json({
    success: true,
    data: { fabric: FabricLedgerEngine.readiness(), firefly: FireflyEngine.readiness() },
  });
});

// ─── Fabric notarization ────────────────────────────────────────────────────

router.get('/fabric/notarizations', operatorAuth, async (req, res) => {
  try {
    res.json({
      success: true,
      data: await FabricLedgerEngine.list({
        limit: Math.min(Number(req.query.limit) || 25, 200),
        recordType: req.query.recordType || null,
        status: req.query.status || null,
      }),
    });
  } catch (err) { sendError(res, err); }
});

router.get('/fabric/notarizations/:recordType/:recordId', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await FabricLedgerEngine.history(req.params.recordType, req.params.recordId) });
  } catch (err) { sendError(res, err); }
});

/** Digest a record and anchor it. Shadow unless FABRIC_LEDGER_LIVE is true. */
router.post('/fabric/notarize', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    const data = await FabricLedgerEngine.notarize({
      recordType: body.recordType,
      recordId: body.recordId,
      payload: body.payload,
      digest: body.digest || null,
      metadata: body.metadata || {},
      notarizedBy: principal(req),
    });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/fabric/notarizations/:id/sync', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    res.json({ success: true, data: await FabricLedgerEngine.syncReceipt(req.params.id) });
  } catch (err) { sendError(res, err); }
});

/**
 * The audit question: does the record as it stands today still hash to what
 * was anchored? A `mismatch` outcome is a finding, not an error.
 */
router.post('/fabric/verify', operatorAuth, async (req, res) => {
  try {
    const body = req.body || {};
    res.json({
      success: true,
      data: await FabricLedgerEngine.verify({
        recordType: body.recordType,
        recordId: body.recordId,
        payload: body.payload,
        digest: body.digest || null,
      }),
    });
  } catch (err) { sendError(res, err); }
});

// ─── FireFly ────────────────────────────────────────────────────────────────

router.get('/firefly/status', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await FireflyEngine.status() });
  } catch (err) { sendError(res, err); }
});

router.get('/firefly/organizations', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await FireflyEngine.organizations() });
  } catch (err) { sendError(res, err); }
});

router.get('/firefly/pools', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await FireflyEngine.pools() });
  } catch (err) { sendError(res, err); }
});

router.get('/firefly/balances', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await FireflyEngine.balances() });
  } catch (err) { sendError(res, err); }
});

router.get('/firefly/settlements', operatorAuth, async (req, res) => {
  try {
    res.json({
      success: true,
      data: await FireflyEngine.list({
        limit: Math.min(Number(req.query.limit) || 25, 200),
        kind: req.query.kind || null,
        status: req.query.status || null,
      }),
    });
  } catch (err) { sendError(res, err); }
});

/** Private settlement instruction to the counterparty; moves no value. */
router.post('/firefly/instruction', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    const data = await FireflyEngine.sendInstruction({
      reference: body.reference,
      instruction: body.instruction,
      counterparty: body.counterparty || null,
      topic: body.topic || null,
      requestedBy: principal(req),
    });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

/** Tokenized value transfer. Books nothing until FireFly confirms it. */
router.post('/firefly/transfer', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    const data = await FireflyEngine.transfer({
      amountUsd: body.amountUsd,
      reference: body.reference || null,
      counterparty: body.counterparty || null,
      poolId: body.poolId || null,
      memo: body.memo || null,
      sourceType: body.sourceType || null,
      sourceAccountId: body.sourceAccountId || null,
      requestedBy: principal(req),
    });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/firefly/settlements/:id', operatorAuth, async (req, res) => {
  try {
    const data = await FireflyEngine.get(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: `settlement ${req.params.id} not found` });
    return res.json({ success: true, data });
  } catch (err) { return sendError(res, err); }
});

router.post('/firefly/settlements/:id/sync', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    res.json({ success: true, data: await FireflyEngine.sync(req.params.id) });
  } catch (err) { sendError(res, err); }
});

/** Re-drive a failed transfer once, under the same reference. */
router.post('/firefly/settlements/:id/retry', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    res.json({ success: true, data: await FireflyEngine.retry(req.params.id, { requestedBy: principal(req) }) });
  } catch (err) { sendError(res, err); }
});

router.post('/firefly/reconcile', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    res.json({ success: true, data: await FireflyEngine.reconcile({ limit: Math.min(Number((req.body || {}).limit) || 100, 500) }) });
  } catch (err) { sendError(res, err); }
});

router.post('/firefly/subscription', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    res.status(201).json({ success: true, data: await FireflyEngine.ensureSubscription({ webhookUrl: (req.body || {}).webhookUrl || null }) });
  } catch (err) { sendError(res, err); }
});

/**
 * FireFly event webhook. Authenticated by HMAC over the raw body when
 * FIREFLY_WEBHOOK_SECRET is set; an event that matches nothing is
 * acknowledged so FireFly does not retry it forever.
 */
router.post('/firefly/webhook', async (req, res) => {
  try {
    const data = await FireflyEngine.handleEvent(req.body || {}, {
      signature: req.headers['x-firefly-signature'] || req.headers['x-hub-signature-256'] || null,
      rawBody: req.rawBody || null,
    });
    res.json({ success: true, data });
  } catch (err) {
    if (err.code === 'SIGNATURE_INVALID') return sendError(res, err);
    // Never make FireFly retry on our bookkeeping failure; the reconcile pass owns it.
    res.json({ success: true, data: { handled: false, error: err.message } });
  }
});

module.exports = router;
