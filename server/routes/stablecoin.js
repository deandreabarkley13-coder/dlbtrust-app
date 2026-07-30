'use strict';

const express = require('express');
const crypto = require('crypto');
const { StablecoinGateway, TreasuryEngine, BlockchainEngine, FyStackEngine, CircleKitEngine, MagicWalletService, Wso2ApiManager, SourceOfFundsAdapter, CircleMintClient, DEFAULT_ACCOUNT } = require('../integrations/stablecoin');
const { HollaExClient } = require('../integrations/hollaex/hollaExClient');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');

const router = express.Router();
const operatorAuth = requireAuth({ role: 'operator' });
const adminAuth = requireAuth({ role: 'admin' });

const WSO2_ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);
const WSO2_PATH_RE = /^\/[A-Za-z0-9_\-.\/]+$/;

function sendError(res, err) {
  const status = err.status || (err.message && err.message.includes('not found') ? 404 : 400);
  res.status(status).json({ success: false, error: err.message || 'Stablecoin operation failed' });
}

router.get('/health', async (req, res) => {
  try {
    const readiness = await StablecoinGateway.readiness({ publicHealth: true });
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

router.get('/source-types', async (req, res) => {
  res.json({ success: true, data: ['treasury', 'cash', 'trust', 'bond', 'fixed_income', 'fineract'] });
});

router.get('/sources/:type/:id/balance', operatorAuth, async (req, res) => {
  try {
    const balance = await SourceOfFundsAdapter.getBalance({ sourceType: req.params.type, sourceAccountId: req.params.id });
    res.json({ success: true, data: { sourceType: req.params.type, sourceAccountId: req.params.id, availableCents: balance } });
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
    const data = await StablecoinGateway.settlePayment(req.params.id, { memo: req.body.memo, destinationSecret: req.body.destinationSecret });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/ensure-trustline', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { destination, destinationSecret } = req.body;
    const blockchain = new BlockchainEngine();
    const data = await blockchain.ensureDestinationTrustline({ destination, destinationSecret });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// HollaEx Kit fiat-crypto conversion
router.get('/convert/quote', operatorAuth, async (req, res) => {
  try {
    const client = new HollaExClient();
    const data = await client.getQuote({
      spendingCurrency: req.query.spendingCurrency,
      receivingCurrency: req.query.receivingCurrency,
      spendingAmount: req.query.spendingAmount,
      receivingAmount: req.query.receivingAmount,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/convert/execute', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const client = new HollaExClient();
    const data = await client.executeQuote(req.body.token);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/convert/readiness', operatorAuth, async (req, res) => {
  try {
    const data = new HollaExClient().readiness();
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// FyStack Ignite self-hosted custody / payment rail
router.get('/fystack/readiness', operatorAuth, async (req, res) => {
  try {
    const data = await new FyStackEngine().readiness();
    res.status(data.ready ? 200 : 503).json({ success: data.ready, data });
  } catch (err) { sendError(res, err); }
});

router.post('/fystack/wallets', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await new FyStackEngine().createWallet(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/fystack/wallets', operatorAuth, async (req, res) => {
  try {
    const data = await new FyStackEngine().getWallets(req.query.workspaceId);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/fystack/wallets/:id/deposit-address', operatorAuth, async (req, res) => {
  try {
    const data = await new FyStackEngine().getDepositAddress(req.params.id, req.query.addressType || 'evm');
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/fystack/wallets/:id/balance', operatorAuth, async (req, res) => {
  try {
    const data = await new FyStackEngine().getBalance(req.params.id, req.query.asset);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/fystack/wallets/:id/withdraw', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await new FyStackEngine().requestWithdrawal(req.params.id, req.body);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/fystack/withdrawals/:id', operatorAuth, async (req, res) => {
  try {
    const data = await new FyStackEngine().getWithdrawalStatus(req.params.id);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/fystack/sweep-tasks', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await new FyStackEngine().createSweepTask(req.body.workspaceId, req.body);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// Circle App Kit stablecoin rail
router.get('/circle/readiness', operatorAuth, async (req, res) => {
  try {
    const data = await new CircleKitEngine().readiness();
    res.status(data.ready ? 200 : 503).json({ success: data.ready, data });
  } catch (err) { sendError(res, err); }
});

router.get('/circle/source-address', operatorAuth, async (req, res) => {
  try {
    const data = await new CircleKitEngine().getSourceAddress();
    res.json({ success: true, data: { sourceAddress: data } });
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

// WSO2 API Manager proxy (admin-only; restricted method/path)
router.all('/wso2/*', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    if (!WSO2_ALLOWED_METHODS.has(req.method)) {
      return res.status(405).json({ success: false, error: 'Method not allowed for WSO2 proxy' });
    }
    const path = req.path.replace('/wso2', '');
    if (!WSO2_PATH_RE.test(path) || path.includes('..')) {
      return res.status(400).json({ success: false, error: 'Invalid WSO2 proxy path' });
    }
    const manager = new Wso2ApiManager();
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

// ─── CIRCLE MINT REGULATED FIAT ON-RAMP ─────────────────────────────────────

function circleMintClient() {
  return new CircleMintClient();
}

router.get('/circle-mint/readiness', operatorAuth, async (req, res) => {
  try {
    const client = circleMintClient();
    const base = client.readiness();
    if (!base.ready) return res.status(503).json({ success: false, data: base });
    const account = await client.getBusinessAccount();
    res.json({ success: true, data: { ...base, account: (account && account.data) || null } });
  } catch (err) { sendError(res, err); }
});

router.post('/circle-mint/bank-accounts/wire', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { accountNumber, routingNumber, billingDetails, bankAddress, idempotencyKey } = req.body;
    if (!accountNumber || !routingNumber || !billingDetails) {
      return res.status(400).json({ success: false, error: 'accountNumber, routingNumber, and billingDetails are required' });
    }
    const data = await circleMintClient().createWireBankAccount({ accountNumber, routingNumber, billingDetails, bankAddress, idempotencyKey });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/circle-mint/bank-accounts/:id/instructions', operatorAuth, async (req, res) => {
  try {
    const { currency, walletId } = req.query;
    const data = await circleMintClient().getWireInstructions(req.params.id, { currency, walletId });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/circle-mint/balances', operatorAuth, async (req, res) => {
  try {
    const data = await circleMintClient().getBalances();
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/circle-mint/recipient-addresses', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { address, chain, currency, description, idempotencyKey } = req.body;
    if (!address || !chain) {
      return res.status(400).json({ success: false, error: 'address and chain are required' });
    }
    const data = await circleMintClient().createRecipientAddress({ address, chain, currency, description, idempotencyKey });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/circle-mint/transfers', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { destinationAddressId, amount, currency, idempotencyKey, sourceType, sourceAccountId } = req.body;
    if (!destinationAddressId || !amount) {
      return res.status(400).json({ success: false, error: 'destinationAddressId and amount are required' });
    }
    const amountCents = Math.round(parseFloat(amount) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) return res.status(400).json({ success: false, error: 'amount must be a positive number' });

    const paymentId = `CM-${crypto.randomUUID()}`;
    const normalizedSourceType = sourceType ? String(sourceType).toLowerCase() : '';

    // Record source-of-funds backing, reserve it in treasury, then settle.
    let funding;
    let reserveId;
    if (normalizedSourceType && normalizedSourceType !== 'treasury') {
      funding = await SourceOfFundsAdapter._fundSourceToTreasury({
        sourceType: normalizedSourceType,
        sourceAccountId: sourceAccountId || DEFAULT_ACCOUNT,
        amountCents,
        paymentId,
      });
      ({ reserveId } = await TreasuryEngine.hold(paymentId, DEFAULT_ACCOUNT, amountCents));
    }

    try {
      const data = await circleMintClient().createTransfer({ destinationAddressId, amount, currency, idempotencyKey });
      const txId = data && data.data && data.data.id;
      if (reserveId) await TreasuryEngine.post(reserveId, txId, { settledAmountCents: amountCents });
      res.status(201).json({ success: true, data, paymentId });
    } catch (err) {
      if (reserveId) {
        try { await TreasuryEngine.release(reserveId, 'Circle Mint transfer failed'); } catch (e) { console.warn('[circle-mint] reserve release failed:', e.message); }
      }
      if (funding) {
        try { await SourceOfFundsAdapter._refundSourceFromTreasury({ sourceType: normalizedSourceType, sourceAccountId: sourceAccountId || DEFAULT_ACCOUNT, payment: { id: paymentId, total_cents: amountCents }, sourceRef: funding }); } catch (e) { console.warn('[circle-mint] source refund failed:', e.message); }
      }
      throw err;
    }
  } catch (err) { sendError(res, err); }
});

router.get('/circle-mint/transfers', operatorAuth, async (req, res) => {
  try {
    const { from, to, status, type, pageSize, pageBefore, pageAfter } = req.query;
    const data = await circleMintClient().listTransfers({ from, to, status, type, pageSize, pageBefore, pageAfter });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/circle-mint/transfers/:id', operatorAuth, async (req, res) => {
  try {
    const data = await circleMintClient().getTransfer(req.params.id);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
