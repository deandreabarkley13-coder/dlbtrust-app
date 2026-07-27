'use strict';

const express = require('express');
const { StablecoinGateway, TreasuryEngine, BlockchainEngine, MagicWalletService, Wso2ApiManager, DEFAULT_ACCOUNT } = require('../integrations/stablecoin');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');

const router = express.Router();
const operatorAuth = requireAuth({ role: 'operator' });

function sendError(res, err) {
  const status = err.status || (err.message && err.message.includes('not found') ? 404 : 400);
  res.status(status).json({ success: false, error: err.message || 'Stablecoin operation failed' });
}

router.get('/health', async (req, res) => {
  try {
    const readiness = await StablecoinGateway.readiness();
    res.status(readiness.ready ? 200 : 503).json({ success: readiness.ready, data: readiness });
  } catch (err) { sendError(res, err); }
});

router.post('/quote', async (req, res) => {
  try {
    const { amountCents, amount, assetCode, network } = req.body;
    const cents = amountCents || Math.round(parseFloat(amount || 0) * 100);
    if (!cents || cents <= 0) return res.status(400).json({ success: false, error: 'amount or amountCents required' });
    res.json({ success: true, data: StablecoinGateway.quote({ amountCents: cents, assetCode, network }) });
  } catch (err) { sendError(res, err); }
});

router.post('/payments', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const payment = await StablecoinGateway.createPayment(req.body);
    res.status(201).json({ success: true, data: payment });
  } catch (err) { sendError(res, err); }
});

router.get('/payments', operatorAuth, async (req, res) => {
  try {
    const data = await StablecoinGateway.listPayments({
      status: req.query.status,
      limit: req.query.limit ? Number(req.query.limit) : 50,
      offset: req.query.offset ? Number(req.query.offset) : 0,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/payments/:id', operatorAuth, async (req, res) => {
  try {
    const data = await StablecoinGateway.getPayment(req.params.id);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/payments/:id/approve', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await StablecoinGateway.approvePayment(req.params.id, req.body.accountId || DEFAULT_ACCOUNT);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/payments/:id/settle', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await StablecoinGateway.settlePayment(req.params.id, { memo: req.body.memo });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/treasury/:accountId?', operatorAuth, async (req, res) => {
  try {
    const data = await TreasuryEngine.getPosition(req.params.accountId || DEFAULT_ACCOUNT);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/treasury/:accountId/credit', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { amountCents, source, txHash } = req.body;
    const data = await TreasuryEngine.credit(req.params.accountId, amountCents, { source, txHash });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// Magic WaaS wallet operations
router.post('/wallets', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const svc = new MagicWalletService();
    const data = await svc.createWallet(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/wallets/:id', operatorAuth, async (req, res) => {
  try {
    const svc = new MagicWalletService();
    const data = await svc.getWallet(req.params.id);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/wallets/:id/sign', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const svc = new MagicWalletService();
    const data = await svc.signTransaction({ ...req.body, walletId: req.params.id });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// WSO2 API Manager proxy
router.all('/wso2/*', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const manager = new Wso2ApiManager();
    const path = req.path.replace('/wso2', '');
    const result = await manager.proxy({
      method: req.method,
      path,
      body: req.body,
      headers: Object.fromEntries(
        Object.entries(req.headers).filter(([k]) => !['host', 'authorization', 'content-length'].includes(k.toLowerCase()))
      ),
    });
    res.status(result.status).json(result.body);
  } catch (err) { sendError(res, err); }
});

module.exports = router;
