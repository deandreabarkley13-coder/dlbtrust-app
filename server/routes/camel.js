'use strict';

/**
 * Camel Integration Context API — PTC In-House Family Bank
 *
 * Mounted at /api/camel. Two kinds of caller reach this router and they are not
 * trusted the same way:
 *
 *   Operators and services  authenticate through the zero trust gateway, the
 *                           same gateway the in-house bank API uses, so a
 *                           session or signed service call scoped to the
 *                           operation is required to submit a payment, drive the
 *                           bus or retry a dead letter.
 *
 *   A Camel runtime         posts to /inbox/:routeId with an HMAC over the exact
 *                           bytes it sent. It holds no operator session and no
 *                           service token; the shared inbox secret is all it
 *                           gets, and all it needs, because an inbox call can
 *                           only put a message on a registered route.
 *
 * Nothing here decides a payment. Every handler either records a message, asks
 * the bus to mediate what is already recorded, or reads state back.
 */

const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../integrations/auth/securityMiddleware');
const { ZeroTrustGateway } = require('../integrations/inhouseBank/zeroTrustGateway');
const { CamelRouteEngine } = require('../integrations/camel/camelRouteEngine');
const { getCamelConfig, camelReadiness } = require('../integrations/camel/camelConfig');
const { renderCamelYaml } = require('../integrations/camel/camelYaml');
const { installFamilyBankFlow, submitToFlow } = require('../integrations/camel/familyBankFlow');

const router = express.Router();

// The flow has to be registered before any handler can name one of its routes.
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
 * Verify a Camel runtime's inbox call. The signature covers the timestamp, the
 * route and the raw bytes, so a message cannot be replayed onto a different
 * route or altered in flight, and a stale one is refused outright rather than
 * queued. Comparison is constant time; a missing secret refuses everything,
 * because an unauthenticated inbox is worse than a closed one.
 */
function verifyInbox(req, res, next) {
  const config = getCamelConfig();
  if (!config.inboundSecret) {
    return sendError(res, Object.assign(
      new Error('CAMEL_INBOUND_HMAC_SECRET is not configured; the Camel inbox is closed'),
      { status: 503, code: 'CAMEL_INBOX_CLOSED' }
    ));
  }

  const signature = req.headers['x-camel-signature'];
  const timestamp = req.headers['x-camel-timestamp'];
  if (!signature || !timestamp) {
    return sendError(res, Object.assign(
      new Error('x-camel-signature and x-camel-timestamp are required'),
      { status: 401, code: 'CAMEL_UNSIGNED' }
    ));
  }

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > config.inboundMaxAgeSeconds) {
    return sendError(res, Object.assign(
      new Error('the signature timestamp is outside the accepted window'),
      { status: 401, code: 'CAMEL_STALE_SIGNATURE' }
    ));
  }

  const expected = crypto
    .createHmac('sha256', config.inboundSecret)
    .update(`${timestamp}.${req.params.routeId}.${rawBodyOf(req)}`)
    .digest('hex');
  const given = Buffer.from(String(signature), 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return sendError(res, Object.assign(
      new Error('the inbox signature does not match'),
      { status: 401, code: 'CAMEL_BAD_SIGNATURE' }
    ));
  }
  next();
}

// ── Status and topology ──────────────────────────────────────────────────────

router.get('/health', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    const readiness = camelReadiness();
    res.status(readiness.ready ? 200 : 503).json({ success: readiness.ready, data: readiness });
  } catch (err) { sendError(res, err); }
});

router.get('/status', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    res.json({ success: true, data: await CamelRouteEngine.status() });
  } catch (err) { sendError(res, err); }
});

router.get('/routes', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    res.json({ success: true, data: { routes: CamelRouteEngine.routes() } });
  } catch (err) { sendError(res, err); }
});

/** The deployable Camel YAML for the routes this context is running. */
router.get('/yaml', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    res.type('application/yaml').send(renderCamelYaml({}));
  } catch (err) { sendError(res, err); }
});

// ── Producing ────────────────────────────────────────────────────────────────

/**
 * Put a canonical payment instruction on the flow. This is the one entry point a
 * channel needs: the dashboard, an ISO 20022 translator and an ERP feed all
 * arrive here and are mediated identically from this point on.
 */
router.post('/submit', optionalSession, guard('payments:initiate'), async (req, res) => {
  try {
    const { instruction, idempotencyKey, channel } = req.body || {};
    const result = await submitToFlow({
      instruction,
      idempotencyKey: idempotencyKey || req.headers['idempotency-key'] || null,
      principal: req.ihb?.principal || 'operator',
      channel: channel || 'api',
    });
    res.status(result.accepted ? 202 : 200).json({ success: true, data: result });
  } catch (err) { sendError(res, err); }
});

/** Put a message on a named route directly — batch files, advices, replays. */
router.post('/routes/:routeId/send', optionalSession, guard('payments:initiate'), async (req, res) => {
  try {
    const { body = {}, headers = {}, messageKey = null, deliver = 'now' } = req.body || {};
    const result = await CamelRouteEngine.send(req.params.routeId, body, {
      headers,
      messageKey: messageKey || req.headers['idempotency-key'] || null,
      source: `api:${req.ihb?.principal || 'operator'}`,
      deliver,
    });
    res.status(result.accepted ? 202 : 200).json({ success: true, data: result });
  } catch (err) { sendError(res, err); }
});

/**
 * The signed inbox a Camel runtime posts to. The route decides what the message
 * means; this handler only records it and lets the bus mediate.
 */
router.post('/inbox/:routeId', verifyInbox, async (req, res) => {
  try {
    const messageKey = req.headers['x-camel-message-key'] || null;
    const result = await CamelRouteEngine.send(req.params.routeId, req.body || {}, {
      headers: { ...(req.body?.headers || {}), messageKey },
      messageKey,
      source: 'camel-runtime',
    });
    res.status(result.accepted ? 202 : 200).json({ success: true, data: result });
  } catch (err) { sendError(res, err); }
});

// ── Consuming ────────────────────────────────────────────────────────────────

router.post('/drive', optionalSession, guard('payments:initiate'), async (req, res) => {
  try {
    const { limit = null, routeId = null } = req.body || {};
    res.json({ success: true, data: await CamelRouteEngine.drive({ limit, routeId }) });
  } catch (err) { sendError(res, err); }
});

router.post('/scheduler/start', optionalSession, guard('payments:initiate'), async (req, res) => {
  try {
    res.json({ success: true, data: CamelRouteEngine.start() });
  } catch (err) { sendError(res, err); }
});

router.post('/scheduler/stop', optionalSession, guard('payments:initiate'), async (req, res) => {
  try {
    res.json({ success: true, data: CamelRouteEngine.stop() });
  } catch (err) { sendError(res, err); }
});

// ── Exchanges ────────────────────────────────────────────────────────────────

router.get('/exchanges', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    const { routeId = null, state = null, paymentId = null, limit = 100 } = req.query || {};
    res.json({
      success: true,
      data: { exchanges: await CamelRouteEngine.list({ routeId, state, paymentId, limit }) },
    });
  } catch (err) { sendError(res, err); }
});

router.get('/exchanges/:id', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    const exchange = await CamelRouteEngine.get(req.params.id);
    if (!exchange) return res.status(404).json({ success: false, error: 'unknown exchange' });
    res.json({ success: true, data: exchange });
  } catch (err) { sendError(res, err); }
});

router.get('/dead-letters', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    res.json({
      success: true,
      data: { deadLetters: await CamelRouteEngine.deadLetters({ limit: req.query?.limit }) },
    });
  } catch (err) { sendError(res, err); }
});

/**
 * Replay a dead letter. The exchange keeps its identity and its trace, so a
 * replayed message is auditable as the same message, and the route's idempotent
 * consumption still protects the engines behind it.
 */
router.post('/dead-letters/:id/retry', optionalSession, guard('payments:initiate'), async (req, res) => {
  try {
    const exchange = await CamelRouteEngine.retryDeadLetter(req.params.id, {
      actor: req.ihb?.principal || 'operator',
    });
    res.json({ success: true, data: exchange });
  } catch (err) { sendError(res, err); }
});

router.post('/prune', optionalSession, guard('ledger:reconcile'), async (req, res) => {
  try {
    res.json({ success: true, data: await CamelRouteEngine.prune({ days: req.body?.days || null }) });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
