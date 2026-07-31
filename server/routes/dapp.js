'use strict';

const express = require('express');
const { DappEngine } = require('../integrations/dapp/dappEngine');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');

const router = express.Router();
const operatorAuth = requireAuth({ role: 'operator' });

function sendError(res, err) {
  console.error('[dapp]', err);
  res.status(500).json({ success: false, error: err.message });
}

// ─── Safe Wallets ─────────────────────────────────────────────────────────────
router.get('/safes', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await DappEngine.listSafes() }); } catch (err) { sendError(res, err); }
});

router.get('/safes/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await DappEngine.getSafe(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/safes', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { label, owners, threshold, saltNonce, deployNow } = req.body;
    const data = await DappEngine.createSafe({ label, owners, threshold, saltNonce, deployNow });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/safes/:id/sync', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await DappEngine.syncSafe(req.params.id) }); } catch (err) { sendError(res, err); }
});

// ─── Deposits ───────────────────────────────────────────────────────────────────
router.get('/deposits', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await DappEngine.listDeposits() }); } catch (err) { sendError(res, err); }
});

router.get('/deposits/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await DappEngine.getDeposit(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/deposits', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { safeId, asset, amount, fromAddress, txHash, status } = req.body;
    const data = await DappEngine.createDeposit({ safeId, asset, amount, fromAddress, txHash, status });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/deposits/from-source', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { sourceType, sourceAccountId, safeId, asset, amount, memo } = req.body;
    const data = await DappEngine.depositFromSource({ sourceType, sourceAccountId, safeId, asset, amount, memo });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Source of Funds (legacy modules) ─────────────────────────────────────────
router.get('/source-of-funds', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await DappEngine.listSourceBalances() }); } catch (err) { sendError(res, err); }
});

// ─── Payouts / Disbursements / P2P (2-signature approval) ───────────────────────
router.get('/payouts', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await DappEngine.listPayouts() }); } catch (err) { sendError(res, err); }
});

router.get('/payouts/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await DappEngine.getPayout(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/payouts', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { safeId, type, destination, value, token, tokenAmount, description, sourceType, sourceAccountId, amountUsd } = req.body;
    const data = await DappEngine.createPayout({ safeId, type, destination, value, token, tokenAmount, description, sourceType, sourceAccountId, amountUsd });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/payouts/:id/approve', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { signature, signerAddress } = req.body;
    const data = await DappEngine.approvePayout({ payoutId: req.params.id, signature, signerAddress });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/payouts/:id/execute', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await DappEngine.executePayout(req.params.id);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Distributions ──────────────────────────────────────────────────────────────
router.get('/distributions', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await DappEngine.listDistributions() }); } catch (err) { sendError(res, err); }
});

router.get('/distributions/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await DappEngine.getDistribution(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/distributions', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { safeId, name, asset, totalAmount, beneficiaries, sourceType, sourceAccountId } = req.body;
    const data = await DappEngine.createDistribution({ safeId, name, asset, totalAmount, beneficiaries, sourceType, sourceAccountId });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── P2P Payments ───────────────────────────────────────────────────────────────
router.get('/p2p', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await DappEngine.listPayouts() }); } catch (err) { sendError(res, err); }
});

router.post('/p2p', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { safeId, destination, value, token, tokenAmount, description, sourceType, sourceAccountId, amountUsd } = req.body;
    const data = await DappEngine.createP2p({ safeId, destination, value, token, tokenAmount, description, sourceType, sourceAccountId, amountUsd });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── White-label ────────────────────────────────────────────────────────────────
router.get('/white-label/:slug', async (req, res) => {
  try { res.json({ success: true, data: await DappEngine.getWhiteLabel(req.params.slug) }); } catch (err) { sendError(res, err); }
});

router.post('/white-label', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await DappEngine.setWhiteLabel(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
