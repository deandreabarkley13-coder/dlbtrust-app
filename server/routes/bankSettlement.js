'use strict';

/**
 * S2S clearing/settlement payment server — mounted at /api/payment-server/v1.
 *
 * Service-token auth (PAYMENT_SERVER_SERVICE_TOKEN), same constant-time check
 * as paymentHub.js verifyServiceToken. Operators are not expected here; this
 * is the machine surface other treasury services call.
 */

const express = require('express');
const { timingSafeEqual } = require('../integrations/paymentHub/paymentCrypto');
const { writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { SettlementBankRegistry } = require('../integrations/payments/settlementBankRegistry');
const { BankSettlementEngine } = require('../integrations/payments/bankSettlementEngine');

const router = express.Router();

function serviceToken() {
  return (process.env.PAYMENT_SERVER_SERVICE_TOKEN || '').trim();
}

function verifyServiceToken(req, res, next) {
  const expected = serviceToken();
  const header = req.headers.authorization || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7).trim() : req.headers['x-payment-server-service-token'];
  if (!expected || !timingSafeEqual(supplied, expected)) {
    return res.status(401).json({ success: false, error: 'Payment server service authentication failed' });
  }
  next();
}

function sendError(res, err) {
  const status = Number(err && (err.status || err.statusCode));
  const body = { success: false, error: (err && err.message) || 'Payment server error' };
  if (err && err.settlementId) body.settlementId = err.settlementId;
  if (err && err.settlementStatus) body.status = err.settlementStatus;
  res.status(status >= 400 && status <= 599 ? status : 400).json(body);
}

router.use(verifyServiceToken);

router.get('/settlement-banks', async (req, res) => {
  try { res.json({ success: true, data: await SettlementBankRegistry.list() }); } catch (err) { sendError(res, err); }
});

router.post('/settlement-banks', writeRateLimiter(), async (req, res) => {
  try {
    const bank = await SettlementBankRegistry.register({ ...req.body, createdBy: 'payment_server' });
    res.status(201).json({ success: true, data: SettlementBankRegistry.publicView(bank) });
  } catch (err) { sendError(res, err); }
});

router.get('/settlement-banks/:id/readiness', async (req, res) => {
  try {
    const data = await BankSettlementEngine.readiness(req.params.id);
    res.status(data.ready ? 200 : 503).json({ success: data.ready, data });
  } catch (err) { sendError(res, err); }
});

router.get('/settlements', async (req, res) => {
  try {
    res.json({ success: true, data: await BankSettlementEngine.list({ bankId: req.query.bankId, limit: Math.min(Number(req.query.limit) || 50, 500) }) });
  } catch (err) { sendError(res, err); }
});

router.post('/settlements', writeRateLimiter(), async (req, res) => {
  try {
    const data = await BankSettlementEngine.clearAndSettle({ ...req.body, initiatedBy: 'payment_server' });
    res.status(data.status === 'awaiting_odfi' ? 202 : 201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/settlements/:id', async (req, res) => {
  try {
    const data = await BankSettlementEngine.get(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'settlement not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/settlements/:id/reconcile', writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await BankSettlementEngine.reconcile(req.params.id, req.body || {}) }); } catch (err) { sendError(res, err); }
});

module.exports = router;
module.exports.verifyServiceToken = verifyServiceToken;
