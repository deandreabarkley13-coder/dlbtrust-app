'use strict';

const express = require('express');
const { RallyProtocolEngine } = require('../integrations/dapp/rallyProtocolEngine');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');

const router = express.Router();
const operatorAuth = requireAuth({ role: 'operator' });
const viewerAuth = requireAuth({ role: 'viewer' });

function sendError(res, err) {
  console.error('[rally]', err);
  const message = err && (err.message || err.error || err.detail || err.title) ? (err.message || err.error || err.detail || err.title) : (typeof err === 'string' ? err : 'Unknown error');
  const safeRaw = typeof err === 'object' && err ? JSON.parse(JSON.stringify(err, (k, v) => typeof v === 'bigint' ? String(v) : v)) : undefined;
  res.status(500).json({ success: false, error: message, raw: safeRaw });
}

router.get('/readiness', async (req, res) => {
  try { res.json({ success: true, data: await RallyProtocolEngine.readiness() }); } catch (err) { sendError(res, err); }
});

router.get('/wallets', operatorAuth, async (req, res) => {
  try {
    const { userId, type } = req.query;
    const data = await RallyProtocolEngine.listWallets({ userId, type });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/wallets/:id', operatorAuth, async (req, res) => {
  try {
    const wallet = await RallyProtocolEngine.getWallet(req.params.id);
    if (!wallet) return res.status(404).json({ success: false, error: 'wallet not found' });
    res.json({ success: true, data: wallet });
  } catch (err) { sendError(res, err); }
});

router.post('/wallets', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await RallyProtocolEngine.createWallet(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/wallets/:id/balance', operatorAuth, async (req, res) => {
  try {
    const data = await RallyProtocolEngine.getBalance(req.params.id);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/wallets/:id/fund', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await RallyProtocolEngine.fundWallet({ walletId: req.params.id, ...req.body });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/wallets/:id/pay-requests', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await RallyProtocolEngine.createPaymentRequest({ walletId: req.params.id, ...req.body });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/payouts', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await RallyProtocolEngine.createPayout(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/payouts', operatorAuth, async (req, res) => {
  try {
    const data = await RallyProtocolEngine.listPayouts({ walletId: req.query.walletId });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/requests', operatorAuth, async (req, res) => {
  try {
    const data = await RallyProtocolEngine.listRequests({ walletId: req.query.walletId });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/scan-qr', operatorAuth, async (req, res) => {
  try {
    const data = await RallyProtocolEngine.scanQr(req.body);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/tap-pay', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await RallyProtocolEngine.tapPay(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
