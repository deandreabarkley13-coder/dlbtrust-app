'use strict';

const crypto = require('crypto');
const express = require('express');
const { PaymentHubEngine } = require('../integrations/paymentHub/paymentHubEngine');
const { PaymentHubClient } = require('../integrations/paymentHub/paymentHubClient');
const { getConfig } = require('../integrations/paymentHub/paymentHubConfig');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { timingSafeEqual } = require('../integrations/paymentHub/paymentCrypto');

const router = express.Router();
const operatorAuth = requireAuth({ role: 'operator' });

function sendError(res, err) {
  const message = err.message || 'Payment operation failed';
  let status = err.statusCode || 400;
  if (message.includes('not found')) status = 404;
  if (message.includes('not ready') || message.includes('disabled') || message.includes('blocked')) status = 503;
  res.status(status).json({ success: false, error: message });
}

function verifyServiceToken(req, res, next) {
  const expected = getConfig().serviceToken;
  const header = req.headers.authorization || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7).trim() : req.headers['x-payment-hub-service-token'];
  if (!expected || !timingSafeEqual(supplied, expected)) {
    return res.status(401).json({ success: false, error: 'Payment Hub service authentication failed' });
  }
  next();
}

function verifyWebhook(req, res, next) {
  const config = getConfig();
  const supplied = String(req.headers['x-payment-hub-signature'] || '').replace(/^sha256=/, '');
  const timestamp = String(req.headers['x-payment-hub-timestamp'] || '');
  if (!config.webhookSecret || !supplied || !timestamp) {
    return res.status(401).json({ success: false, error: 'Signed webhook required' });
  }
  const timestampMs = Number(timestamp) < 1000000000000 ? Number(timestamp) * 1000 : Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > config.webhookMaxAgeSeconds * 1000) {
    return res.status(401).json({ success: false, error: 'Expired webhook timestamp' });
  }
  if (!Buffer.isBuffer(req.rawBody)) {
    return res.status(400).json({ success: false, error: 'Raw webhook body is unavailable' });
  }
  const expected = crypto.createHmac('sha256', config.webhookSecret)
    .update(`${timestamp}.`)
    .update(req.rawBody)
    .digest('hex');
  if (!timingSafeEqual(supplied, expected)) {
    return res.status(401).json({ success: false, error: 'Invalid webhook signature' });
  }
  next();
}

router.get('/dashboard', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await PaymentHubEngine.dashboard() });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/health', operatorAuth, async (req, res) => {
  try {
    const dashboard = await PaymentHubEngine.dashboard();
    const phee = await PaymentHubClient.health();
    const ready = dashboard.readiness.ready && dashboard.achConnector.ready;
    res.status(ready ? 200 : 503).json({ success: ready, data: { ...dashboard, phee } });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/intents', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const input = { ...req.body, idempotencyKey: req.headers['idempotency-key'] || req.body.idempotencyKey };
    const result = await PaymentHubEngine.createIntent(input, req.user);
    res.status(result.idempotent ? 200 : 201).json({ success: true, data: result });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/intents', operatorAuth, async (req, res) => {
  try {
    const data = await PaymentHubEngine.listIntents({
      status: req.query.status,
      paymentType: req.query.paymentType,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ success: true, data });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/intents/:id', operatorAuth, async (req, res) => {
  try {
    const intent = await PaymentHubEngine.getIntent(req.params.id);
    if (!intent) return res.status(404).json({ success: false, error: 'Payment intent not found' });
    const events = await PaymentHubEngine.getEvents(req.params.id);
    const audit = await PaymentHubEngine.verifyAuditChain(req.params.id);
    res.json({ success: true, data: { intent, events, audit } });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/intents/:id/approve', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const intent = await PaymentHubEngine.approveIntent(req.params.id, req.user, req.body.reason);
    res.json({ success: true, data: intent });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/intents/:id/reject', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const intent = await PaymentHubEngine.rejectIntent(req.params.id, req.user, req.body.reason);
    res.json({ success: true, data: intent });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/intents/:id/submit', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const result = await PaymentHubEngine.submitIntent(req.params.id, req.user);
    res.status(202).json({ success: true, data: result });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/intents/:id/cancel', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const intent = await PaymentHubEngine.cancelIntent(req.params.id, req.user, req.body.reason);
    res.json({ success: true, data: intent });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/intents/:id/retry', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const result = await PaymentHubEngine.retryIntent(req.params.id, req.user);
    res.status(202).json({ success: true, data: result });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/intents/:id/retry-accounting', requireAuth({ role: 'admin' }), writeRateLimiter(), async (req, res) => {
  try {
    const intent = await PaymentHubEngine.retryAccounting(req.params.id, req.user);
    res.json({ success: true, data: intent });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/connectors/us-ach/execute', verifyServiceToken, writeRateLimiter(), async (req, res) => {
  try {
    if (!req.body.intentId) throw new Error('intentId is required');
    const result = await PaymentHubEngine.executeAchConnector(req.body.intentId, 'payment-hub-ee');
    res.status(202).json({ success: true, data: result });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/webhooks/status', verifyWebhook, writeRateLimiter(), async (req, res) => {
  try {
    const result = await PaymentHubEngine.applyExternalEvent(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
