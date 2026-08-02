'use strict';

const express = require('express');
const { DappEngine } = require('../integrations/dapp/dappEngine');
const { CashAppEngine } = require('../integrations/dapp/cashAppEngine');
const { GoogleWalletEngine } = require('../integrations/dapp/googleWalletEngine');
const { BondTokenizationEngine } = require('../integrations/dapp/bondTokenizationEngine');
const { DexSwapEngine } = require('../integrations/dapp/dexSwapEngine');
const { SourceToDexBridge } = require('../integrations/dapp/sourceToDexBridge');
const { StablecoinDexEngine } = require('../integrations/dapp/stablecoinDexEngine');
const { CoinbaseSpotEngine } = require('../integrations/dapp/coinbaseSpotEngine');
const { CoinbaseTreasuryBridge } = require('../integrations/dapp/coinbaseTreasuryBridge');
const { FinOpsAgent } = require('../integrations/agents/finOpsAgent');
const { CalendarEngine } = require('../integrations/calendar/calendarEngine');
const { MessagingEngine } = require('../integrations/messaging/messagingEngine');
const { DocumentEngine } = require('../integrations/documents/documentEngine');
const { ModuleFundingEngine } = require('../integrations/dapp/moduleFundingEngine');
const { SovereignTrustEngine } = require('../integrations/dapp/sovereignTrustEngine');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');

const router = express.Router();
const operatorAuth = requireAuth({ role: 'operator' });

function sendError(res, err) {
  console.error('[dapp]', err);
  const message = err && (err.message || err.error || err.detail || err.title) ? (err.message || err.error || err.detail || err.title) : (typeof err === 'string' ? err : 'Unknown error');
  res.status(500).json({ success: false, error: message, raw: typeof err === 'object' && err ? err : undefined });
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

// ─── Unified Core Modules / Funding Abstraction Layer ─────────────────────────
router.get('/modules', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await ModuleFundingEngine.listModules() }); } catch (err) { sendError(res, err); }
});

router.post('/modules/transfer', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await ModuleFundingEngine.internalTransfer(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/modules/fund-rail', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await ModuleFundingEngine.fundExternalRail(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
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

// ─── dApp Users / Identity (email/phone P2P login) ────────────────────────────
router.get('/users', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await DappEngine.listUsers() }); } catch (err) { sendError(res, err); }
});

router.get('/users/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await DappEngine.getUser(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/users', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await DappEngine.createUser(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/users/link-wallet', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { email, walletAddress, provider, safeOwnerAddress } = req.body;
    const data = await DappEngine.linkWallet({ email, walletAddress, provider, safeOwnerAddress });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/auth/send-code', async (req, res) => {
  try {
    const { email } = req.body;
    const data = await DappEngine.generateOtp(email);
    res.json({ success: true, data, note: 'In this demo the code is returned in the response; in production wire Twilio/SendGrid.' });
  } catch (err) { sendError(res, err); }
});

router.post('/auth/verify', async (req, res) => {
  try {
    const { email, code } = req.body;
    const data = await DappEngine.verifyOtp({ email, code });
    res.json({ success: true, data });
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

// ─── External Payment Rails (Google Wallet / Cash App) ──────────────────────────
router.get('/payment-rails', async (req, res) => {
  try {
    res.json({ success: true, data: [CashAppEngine.readiness(), GoogleWalletEngine.readiness()] });
  } catch (err) { sendError(res, err); }
});

router.get('/payment-rails/cashapp/readiness', async (req, res) => {
  try { res.json({ success: true, data: CashAppEngine.readiness() }); } catch (err) { sendError(res, err); }
});

router.post('/payment-rails/cashapp/request', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await CashAppEngine.requestPayment(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/payment-rails/cashapp/fund-operator', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await CashAppEngine.fundOperator(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/payment-rails/cashapp/webhook', async (req, res) => {
  try {
    const data = await CashAppEngine.verifyWebhook(req.body, req.headers['x-cashapp-signature']);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/payment-rails/google/readiness', async (req, res) => {
  try { res.json({ success: true, data: GoogleWalletEngine.readiness() }); } catch (err) { sendError(res, err); }
});

router.post('/payment-rails/google/pass', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await GoogleWalletEngine.createPass(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Bond Tokenization & DEX Swap ───────────────────────────────────────────────
router.get('/bond-tokens/readiness', async (req, res) => {
  try { res.json({ success: true, data: BondTokenizationEngine.readiness() }); } catch (err) { sendError(res, err); }
});

router.get('/bond-tokens', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await BondTokenizationEngine.listTokens() }); } catch (err) { sendError(res, err); }
});

router.post('/bond-tokens', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await BondTokenizationEngine.createToken(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/bond-tokens/:id/mint', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await BondTokenizationEngine.mint({ tokenId: req.params.id, ...req.body });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/bond-tokens/:id/holdings', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await BondTokenizationEngine.getHoldings(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.get('/dex/readiness', async (req, res) => {
  try { res.json({ success: true, data: DexSwapEngine.readiness() }); } catch (err) { sendError(res, err); }
});

router.post('/dex/quote', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await DexSwapEngine.quote(req.body);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/dex/swap', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await DexSwapEngine.swap(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/dex/pools', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await DexSwapEngine.createPool(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Stablecoin DEX (DLBUSD -> USDC/USDS, gasless via operator relayer) ───
router.get('/stablecoin-dex/readiness', async (req, res) => {
  try { res.json({ success: true, data: StablecoinDexEngine.readiness() }); } catch (err) { sendError(res, err); }
});

router.post('/stablecoin-dex/quote', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await StablecoinDexEngine.quote(req.body);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/stablecoin-dex/pool', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await StablecoinDexEngine.createPool(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/stablecoin-dex/swap', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await StablecoinDexEngine.swap(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/stablecoin-dex/deposit-and-swap', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await StablecoinDexEngine.depositAndSwap(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Source → DEX Bridge (fund Safe from legacy ledger via tokenization/swap) ───
router.post('/fund-from-source', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await SourceToDexBridge.fundSafeFromSource(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Coinbase Spot Off-Ramp (ledger -> Coinbase buy -> on-chain send) ───
router.get('/coinbase-spot/quote', operatorAuth, async (req, res) => {
  try {
    const data = await CoinbaseSpotEngine.preview({ amount: req.query.amount, targetAsset: req.query.targetAsset });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/coinbase-spot/fund', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await CoinbaseSpotEngine.fundFromSource(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Coinbase Treasury Bridge (source ledger -> Coinbase deposit -> buy -> send) ───
router.post('/coinbase-treasury/fund', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await CoinbaseTreasuryBridge.stageFromSource(req.body);
    const statusCode = data && data.status === 'needs_deposit' ? 202 : 201;
    res.status(statusCode).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/coinbase-treasury/transfers', operatorAuth, async (req, res) => {
  try {
    const data = await CoinbaseTreasuryBridge.listTransfers({ status: req.query.status, limit: req.query.limit, offset: req.query.offset });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/coinbase-treasury/transfers/:id', operatorAuth, async (req, res) => {
  try {
    const data = await CoinbaseTreasuryBridge.getTransfer(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Transfer not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/coinbase-treasury/payment-methods', operatorAuth, async (req, res) => {
  try {
    const data = await CoinbaseTreasuryBridge.getPaymentMethods();
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/coinbase-treasury/accounts', operatorAuth, async (req, res) => {
  try {
    const data = await CoinbaseTreasuryBridge.getFiatAccounts(req.query.currency || 'USD');
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/coinbase-treasury/transfers/:id/execute', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await CoinbaseTreasuryBridge.completeDepositAndExecute(req.params.id);
    res.status(200).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// FinOps AI Agent
// ═════════════════════════════════════════════════════════════════════════════

router.get('/finops-ai/trustees', async (req, res) => {
  try { res.json({ success: true, data: FinOpsAgent.getTrustees() }); } catch (err) { sendError(res, err); }
});

router.post('/finops-ai/prompt', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { prompt, requestedBy } = req.body;
    const data = await FinOpsAgent.createTask({ prompt, requestedBy });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/finops-ai/tasks', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await FinOpsAgent.listTasks(req.query) }); } catch (err) { sendError(res, err); }
});

router.get('/finops-ai/tasks/:id', operatorAuth, async (req, res) => {
  try {
    const data = await FinOpsAgent.getTask(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Task not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/finops-ai/tasks/:id/approve', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { role, trusteeEmail, signature, signerName } = req.body;
    const data = await FinOpsAgent.approveTask({ taskId: req.params.id, role, trusteeEmail, signature, signerName });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/finops-ai/tasks/:id/reject', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { role, trusteeEmail, reason } = req.body;
    const data = await FinOpsAgent.rejectTask({ taskId: req.params.id, role, trusteeEmail, reason });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/finops-ai/tasks/:id/execute', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await FinOpsAgent.executeTask(req.params.id);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Calendar & Scheduling
// ═════════════════════════════════════════════════════════════════════════════

router.get('/calendar/events', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CalendarEngine.listEvents(req.query) }); } catch (err) { sendError(res, err); }
});

router.post('/calendar/events', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await CalendarEngine.createEvent(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/calendar/events/:id', operatorAuth, async (req, res) => {
  try {
    const data = await CalendarEngine.getEvent(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Event not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.put('/calendar/events/:id', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CalendarEngine.updateEvent(req.params.id, req.body) }); } catch (err) { sendError(res, err); }
});

router.delete('/calendar/events/:id', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CalendarEngine.deleteEvent(req.params.id) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Messaging
// ═════════════════════════════════════════════════════════════════════════════

router.get('/messaging/threads', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await MessagingEngine.listThreads(req.query) }); } catch (err) { sendError(res, err); }
});

router.post('/messaging/threads', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await MessagingEngine.createThread(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/messaging/threads/:id', operatorAuth, async (req, res) => {
  try {
    const thread = await MessagingEngine.getThread(req.params.id);
    if (!thread) return res.status(404).json({ success: false, error: 'Thread not found' });
    const messages = await MessagingEngine.listMessages(req.params.id);
    res.json({ success: true, data: { thread, messages } });
  } catch (err) { sendError(res, err); }
});

router.post('/messaging/threads/:id/messages', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await MessagingEngine.sendMessage({ threadId: req.params.id, ...req.body });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Document Vault (dApp wrappers)
// ═════════════════════════════════════════════════════════════════════════════

router.get('/documents', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await DocumentEngine.listDocuments(req.query) }); } catch (err) { sendError(res, err); }
});

router.post('/documents', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await DocumentEngine.createDocument(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/documents/:id', operatorAuth, async (req, res) => {
  try {
    const data = await DocumentEngine.getDocument(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Document not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Connected wallet balances & activity
// ═════════════════════════════════════════════════════════════════════════════

router.get('/wallet/balances', operatorAuth, async (req, res) => {
  try {
    const { chain, address } = req.query;
    const data = await DappEngine.getWalletBalances({ chain, address });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/wallet/activity', operatorAuth, async (req, res) => {
  try {
    const { chain, address } = req.query;
    const data = await DappEngine.getWalletActivity({ chain, address });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Sovereign Trust Token (self-issued permissioned stablecoin)
// ═════════════════════════════════════════════════════════════════════════════

router.get('/sovereign-trust/readiness', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await SovereignTrustEngine.readiness() }); } catch (err) { sendError(res, err); }
});

router.post('/sovereign-trust/deploy', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await SovereignTrustEngine.deployContracts() }); } catch (err) { sendError(res, err); }
});

router.get('/sovereign-trust/token', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await SovereignTrustEngine.tokenInfo() }); } catch (err) { sendError(res, err); }
});

router.get('/sovereign-trust/balance/:address', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: { address: req.params.address, balance: await SovereignTrustEngine.tokenBalanceOf(req.params.address) } }); } catch (err) { sendError(res, err); }
});

router.post('/sovereign-trust/mint', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await SovereignTrustEngine.mintFromSource(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/sovereign-trust/burn', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await SovereignTrustEngine.burnToSource(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/sovereign-trust/whitelist', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: { tx: await SovereignTrustEngine.whitelistAddress(req.body.address, req.body.allowed !== false) } }); } catch (err) { sendError(res, err); }
});

router.post('/sovereign-trust/meta-tx/build', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await SovereignTrustEngine.buildMetaTx(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/sovereign-trust/meta-tx/relay', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await SovereignTrustEngine.relayMetaTx(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/sovereign-trust/on-ramp', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await SovereignTrustEngine.createOnRampOrder(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/sovereign-trust/off-ramp', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await SovereignTrustEngine.createOffRampOrder(req.body) }); } catch (err) { sendError(res, err); }
});

router.get('/sovereign-trust/orders', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await SovereignTrustEngine.listOrders() }); } catch (err) { sendError(res, err); }
});

module.exports = router;
