'use strict';

/**
 * Bond Subscriptions API — /api/bond-subscriptions
 *
 * Sells units of a tokenized bond for stablecoin through thirdweb Payments.
 * Creating a subscription only issues a payment link; units are delivered and
 * the sale is booked when `sync` sees the payment COMPLETED.
 */

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { BondSubscriptionEngine } = require('../integrations/bonds/bondSubscriptionEngine');

const router = express.Router();
const operatorAuth = requireAuth({ role: 'operator' });
const adminAuth = requireAuth({ role: 'admin' });

function principal(req) {
  const user = req.user || {};
  return user.email || user.username || user.userId || user.sub || null;
}

function send(res, err) {
  res.status(err.status || err.statusCode || 500).json({ success: false, error: err.message, code: err.code || null });
}

router.get('/readiness', operatorAuth, (req, res) => {
  res.json({ success: true, data: BondSubscriptionEngine.readiness() });
});

router.get('/', operatorAuth, async (req, res) => {
  try {
    const data = await BondSubscriptionEngine.list({ status: req.query.status || null, limit: Number(req.query.limit) || 50 });
    res.json({ success: true, data });
  } catch (err) { send(res, err); }
});

router.get('/available/:tokenId', operatorAuth, async (req, res) => {
  try {
    const units = await BondSubscriptionEngine.availableUnits(req.params.tokenId);
    res.json({ success: true, data: { tokenId: req.params.tokenId, availableUnits: units } });
  } catch (err) { send(res, err); }
});

router.get('/:id', operatorAuth, async (req, res) => {
  try {
    const data = await BondSubscriptionEngine.get(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'subscription not found' });
    res.json({ success: true, data });
  } catch (err) { send(res, err); }
});

router.post('/', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { tokenId, units, investorAddress, investorName } = req.body || {};
    const data = await BondSubscriptionEngine.create({ tokenId, units, investorAddress, investorName, requestedBy: principal(req) });
    res.status(201).json({ success: true, data });
  } catch (err) { send(res, err); }
});

router.post('/sync', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    res.json({ success: true, data: await BondSubscriptionEngine.syncOpen() });
  } catch (err) { send(res, err); }
});

router.post('/:id/sync', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    res.json({ success: true, data: await BondSubscriptionEngine.sync(req.params.id) });
  } catch (err) { send(res, err); }
});

router.post('/:id/deliver', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    res.json({ success: true, data: await BondSubscriptionEngine.deliver(req.params.id) });
  } catch (err) { send(res, err); }
});

module.exports = router;
