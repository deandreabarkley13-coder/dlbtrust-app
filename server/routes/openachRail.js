'use strict';

/**
 * OpenACH Rail API — PTC In-House Family Bank
 *
 * Mounted at /api/openach-rail. This is the ACH rail of the in-house bank: it
 * originates dispatched ACH payments through OpenACH, polls what it originated,
 * and accepts the advices OpenACH pushes back.
 *
 * The one thing it does not do is decide a payment's fate. Origination reports
 * to the in-house bank; a settlement, return or failure is applied through
 * InHouseBankEngine.confirm(), so this rail can only ever tell the bank what the
 * network said.
 *
 * The advice endpoint is signed with the OpenACH webhook secret rather than an
 * operator session, because OpenACH holds no session — and an unsigned advice
 * would be an anonymous instruction to settle a payment.
 */

const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../integrations/auth/securityMiddleware');
const { ZeroTrustGateway } = require('../integrations/inhouseBank/zeroTrustGateway');
const { OpenAchRailEngine } = require('../integrations/openach/openachRailEngine');
const { openAchRailReadiness } = require('../integrations/openach/openachRailConfig');
const { CamelRouteEngine } = require('../integrations/camel/camelRouteEngine');
const { installFamilyBankFlow } = require('../integrations/camel/familyBankFlow');

const router = express.Router();

installFamilyBankFlow();

const sessionAuth = requireAuth({ role: 'operator' });

function optionalSession(req, res, next) {
  let settled = false;
  const advance = () => { if (!settled) { settled = true; next(); } };
  const shim = {
    status() { return shim; },
    json() { advance(); return shim; },
    send() { advance(); return shim; },
    setHeader() { return shim; },
  };
  sessionAuth(req, shim, advance);
}

function sendError(res, err) {
  const status = err.status || err.statusCode || 400;
  res.status(status).json({ success: false, error: err.message, code: err.code || null });
}

function rawBodyOf(req) {
  return Buffer.isBuffer(req.rawBody)
    ? req.rawBody.toString('utf8')
    : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
}

function guard(scope) {
  return async (req, res, next) => {
    try {
      req.ihb = await ZeroTrustGateway.authorize({
        scope,
        headers: req.headers,
        body: rawBodyOf(req),
        user: req.user || null,
        requestRef: req.headers['idempotency-key'] || null,
      });
      next();
    } catch (err) {
      sendError(res, err);
    }
  };
}

/**
 * Verify an OpenACH advice. The secret is separate from the API credentials the
 * client uses outbound: a leaked read credential must not become the ability to
 * mark payments settled. Without a configured secret the endpoint is closed.
 */
function verifyAdvice(req, res, next) {
  const secret = process.env.OPENACH_WEBHOOK_SECRET || null;
  if (!secret) {
    return sendError(res, Object.assign(
      new Error('OPENACH_WEBHOOK_SECRET is not configured; the advice endpoint is closed'),
      { status: 503, code: 'OPENACH_ADVICE_CLOSED' }
    ));
  }
  const signature = req.headers['x-openach-signature'];
  if (!signature) {
    return sendError(res, Object.assign(
      new Error('x-openach-signature is required'),
      { status: 401, code: 'OPENACH_UNSIGNED' }
    ));
  }
  const expected = crypto.createHmac('sha256', secret).update(rawBodyOf(req)).digest('hex');
  const given = Buffer.from(String(signature).replace(/^sha256=/, ''), 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return sendError(res, Object.assign(
      new Error('the advice signature does not match'),
      { status: 401, code: 'OPENACH_BAD_SIGNATURE' }
    ));
  }
  next();
}

// ── Status ───────────────────────────────────────────────────────────────────

router.get('/health', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    const readiness = openAchRailReadiness();
    res.status(readiness.ready ? 200 : 503).json({ success: readiness.ready, data: readiness });
  } catch (err) { sendError(res, err); }
});

router.get('/status', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    res.json({ success: true, data: await OpenAchRailEngine.status() });
  } catch (err) { sendError(res, err); }
});

router.get('/dispatches', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    const { state = null, limit = 100 } = req.query || {};
    res.json({ success: true, data: { dispatches: await OpenAchRailEngine.list({ state, limit }) } });
  } catch (err) { sendError(res, err); }
});

router.get('/dispatches/:paymentId', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    const dispatch = await OpenAchRailEngine.get(req.params.paymentId);
    if (!dispatch) return res.status(404).json({ success: false, error: 'no OpenACH dispatch for that payment' });
    res.json({ success: true, data: dispatch });
  } catch (err) { sendError(res, err); }
});

// ── Origination ──────────────────────────────────────────────────────────────

/**
 * Originate one dispatched ACH payment. The flow does this on its own; this
 * endpoint exists for the payment the flow could not finish — an OpenACH outage,
 * a corrected beneficiary — where an operator needs to push a single payment
 * through without waiting for the next cycle.
 */
router.post('/dispatches/:paymentId/originate', optionalSession, guard('payments:initiate'), async (req, res) => {
  try {
    const dispatch = await OpenAchRailEngine.originate(req.params.paymentId, {
      actor: req.ihb?.principal || 'operator',
    });
    res.json({ success: true, data: dispatch });
  } catch (err) { sendError(res, err); }
});

router.post('/dispatches/:paymentId/retry', optionalSession, guard('payments:initiate'), async (req, res) => {
  try {
    const dispatch = await OpenAchRailEngine.retry(req.params.paymentId, {
      actor: req.ihb?.principal || 'operator',
    });
    res.json({ success: true, data: dispatch });
  } catch (err) { sendError(res, err); }
});

// ── Settlement ───────────────────────────────────────────────────────────────

router.post('/poll', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    res.json({
      success: true,
      data: await OpenAchRailEngine.pollStatuses({
        actor: req.ihb?.principal || 'operator',
        limit: req.body?.limit || null,
      }),
    });
  } catch (err) { sendError(res, err); }
});

router.post('/drive', optionalSession, guard('payments:initiate'), async (req, res) => {
  try {
    res.json({
      success: true,
      data: await OpenAchRailEngine.driveOnce({
        actor: req.ihb?.principal || 'operator',
        limit: req.body?.limit || null,
      }),
    });
  } catch (err) { sendError(res, err); }
});

/**
 * An advice from OpenACH. It goes onto the flow's advice route rather than
 * straight into the engine so that the advice is a durable, traceable exchange
 * before it can change a payment: if applying it fails, it is redelivered and
 * eventually dead-lettered, not lost inside a webhook response.
 */
router.post('/advice', verifyAdvice, async (req, res) => {
  try {
    const advice = req.body || {};
    const messageKey = advice.reference || advice.transactionId || advice.scheduleId
      || `${advice.paymentId || 'unknown'}:${advice.status || 'unknown'}`;
    const result = await CamelRouteEngine.send('family-bank-advice', advice, {
      headers: { source: 'openach', messageKey },
      messageKey: String(messageKey),
      source: 'openach-webhook',
      paymentId: advice.paymentId || null,
    });
    res.status(result.accepted ? 202 : 200).json({ success: true, data: result });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
