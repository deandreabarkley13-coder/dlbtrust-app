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
const { StripePaymentIntakeEngine } = require('../integrations/payments/stripePaymentIntakeEngine');

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

// Stripe-signed, not service-token'd: Stripe calls this directly.
router.post('/stripe/webhook', async (req, res) => {
  try {
    const data = await StripePaymentIntakeEngine.handleWebhook(req.rawBody, req.headers['stripe-signature']);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.use(verifyServiceToken);

router.get('/stripe-intakes/readiness', async (req, res) => {
  try {
    const data = await StripePaymentIntakeEngine.status();
    res.status(data.ready ? 200 : 503).json({ success: data.ready, data });
  } catch (err) { sendError(res, err); }
});

router.get('/stripe-intakes', async (req, res) => {
  try {
    res.json({ success: true, data: await StripePaymentIntakeEngine.list({ status: req.query.status, limit: Math.min(Number(req.query.limit) || 50, 500) }) });
  } catch (err) { sendError(res, err); }
});

router.post('/stripe-intakes/payment-intents', writeRateLimiter(), async (req, res) => {
  try {
    res.status(201).json({ success: true, data: await StripePaymentIntakeEngine.createPaymentIntent({ ...req.body, createdBy: 'payment_server' }) });
  } catch (err) { sendError(res, err); }
});

router.post('/stripe-intakes/checkout-links', writeRateLimiter(), async (req, res) => {
  try {
    res.status(201).json({ success: true, data: await StripePaymentIntakeEngine.createCheckoutLink({ ...req.body, createdBy: 'payment_server' }) });
  } catch (err) { sendError(res, err); }
});

router.get('/stripe-intakes/:id', async (req, res) => {
  try {
    const data = await StripePaymentIntakeEngine.get(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'intake not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// Received Stripe funds -> Lili direct deposit. Same live rules as POST /settlements
// (approvalRef + screeningRef), amount defaults to the intake amount.
router.post('/stripe-intakes/:id/payout', writeRateLimiter(), async (req, res) => {
  try {
    const intake = await StripePaymentIntakeEngine.get(req.params.id);
    if (!intake) return res.status(404).json({ success: false, error: 'intake not found' });
    if (intake.status !== 'received') return res.status(409).json({ success: false, error: `intake is ${intake.status}, not received` });
    const amountCents = req.body && req.body.amountCents != null ? Number(req.body.amountCents) : intake.amountCents;
    if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > intake.amountCents) return res.status(400).json({ success: false, error: 'amountCents must be a positive integer <= the intake amount' });
    const data = await BankSettlementEngine.clearAndSettle({
      bankId: 'lili', amountCents, rail: 'ach',
      approvalRef: req.body && req.body.approvalRef, screeningRef: req.body && req.body.screeningRef,
      reference: (req.body && req.body.reference) || intake.intakeId,
      description: (req.body && req.body.description) || `Stripe intake ${intake.intakeId} -> Lili`,
      paymentType: 'stripe_intake_payout', initiatedBy: 'payment_server',
    });
    const updated = ['originated', 'settled'].includes(data.status) ? await StripePaymentIntakeEngine.markPaidOut(intake.intakeId, data.settlementId) : null;
    res.status(['awaiting_odfi', 'pending_approval'].includes(data.status) ? 202 : 201).json({ success: true, data: { settlement: data, intake: updated || intake } });
  } catch (err) { sendError(res, err); }
});

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
    res.status(['awaiting_odfi', 'pending_approval'].includes(data.status) ? 202 : 201).json({ success: true, data });
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
