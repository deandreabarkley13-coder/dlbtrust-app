'use strict';

const express = require('express');
const { DappEngine } = require('../integrations/dapp/dappEngine');
const { CashAppEngine } = require('../integrations/dapp/cashAppEngine');
const { GoogleWalletEngine } = require('../integrations/dapp/googleWalletEngine');
const { BondTokenizationEngine } = require('../integrations/dapp/bondTokenizationEngine');
const { DexSwapEngine } = require('../integrations/dapp/dexSwapEngine');
const { SourceToDexBridge } = require('../integrations/dapp/sourceToDexBridge');
const { StablecoinDexEngine } = require('../integrations/dapp/stablecoinDexEngine');
const { MoonPayEngine } = require('../integrations/dapp/moonPayEngine');
const { CoinbaseSpotEngine } = require('../integrations/dapp/coinbaseSpotEngine');
const { CoinbaseTreasuryBridge } = require('../integrations/dapp/coinbaseTreasuryBridge');
const { FinOpsAgent } = require('../integrations/agents/finOpsAgent');
const { CalendarEngine } = require('../integrations/calendar/calendarEngine');
const { MessagingEngine } = require('../integrations/messaging/messagingEngine');
const { DocumentEngine } = require('../integrations/documents/documentEngine');
const { ModuleFundingEngine } = require('../integrations/dapp/moduleFundingEngine');
const { SovereignTrustEngine } = require('../integrations/dapp/sovereignTrustEngine');
const { AccountAbstractionEngine } = require('../integrations/dapp/accountAbstractionEngine');
const { OperatorGasTank } = require('../integrations/dapp/operatorGasTank');
const { ExpenseManagementEngine } = require('../integrations/accounting/expenseManagementEngine');
const { DisbursementAutomationEngine } = require('../integrations/dapp/disbursementAutomationEngine');
const { FundingEngine } = require('../integrations/dapp/fundingEngine');
const { PayoutCenterEngine } = require('../integrations/dapp/payoutCenterEngine');
const { StripeTreasuryBatchEngine } = require('../integrations/payments/stripeTreasuryBatchEngine');
const { DepositAndSettlementEngine } = require('../integrations/payments/depositAndSettlementEngine');
const { ClearingApiEngine } = require('../integrations/payments/clearingApiEngine');
const { PaymentProcessorServerEngine } = require('../integrations/payments/paymentProcessorServerEngine');
const { PaymentGatewayServerEngine } = require('../integrations/payments/paymentGatewayServerEngine');
const { OrchestrEngine } = require('../integrations/payments/orchestrEngine');
const { WalletEngine } = require('../integrations/dapp/walletEngine');
const { BitPayEngine } = require('../integrations/dapp/bitpayEngine');
const { WalletFundingEngine } = require('../integrations/dapp/walletFundingEngine');
const { MasterWalletEngine } = require('../integrations/dapp/masterWalletEngine');
const { PtcPortalEngine } = require('../integrations/dapp/ptcPortalEngine');
let BondEngine, LiveBondEngine;
try { BondEngine = require('../integrations/bonds/bondEngine').BondEngine; } catch (e) { BondEngine = null; }
try { LiveBondEngine = require('../integrations/bonds/liveEngine').LiveBondEngine; } catch (e) { LiveBondEngine = null; }
let BondTrustReconciliation;
try { BondTrustReconciliation = require('../integrations/bonds/bondTrustReconciliation').BondTrustReconciliation; } catch (e) { BondTrustReconciliation = null; }
let CustomerIdentificationEngine;
try { ({ CustomerIdentificationEngine } = require('../integrations/compliance/customerIdentificationEngine')); } catch (e) { CustomerIdentificationEngine = null; }
const { requireAuth, writeRateLimiter, authRateLimiter } = require('../integrations/auth/securityMiddleware');

const router = express.Router();
const operatorAuth = requireAuth({ role: 'operator' });
const portalAuth = requireAuth({ role: 'viewer' });
const adminAuth = requireAuth({ role: 'admin' });

function sendError(res, err) {
  console.error('[dapp]', err);
  const message = err && (err.message || err.error || err.detail || err.title) ? (err.message || err.error || err.detail || err.title) : (typeof err === 'string' ? err : 'Unknown error');
  const safeRaw = typeof err === 'object' && err ? JSON.parse(JSON.stringify(err, (k, v) => typeof v === 'bigint' ? String(v) : v)) : undefined;
  res.status(500).json({ success: false, error: message, raw: safeRaw });
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
router.get('/users', adminAuth, async (req, res) => {
  try { res.json({ success: true, data: await DappEngine.listUsers() }); } catch (err) { sendError(res, err); }
});

router.get('/users/me', portalAuth, async (req, res) => {
  try {
    const email = req.user && req.user.email;
    const data = email ? await DappEngine.getUserByEmail(email).then(u => DappEngine._sanitizeUser(u)) : null;
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/users/:id', adminAuth, async (req, res) => {
  try { res.json({ success: true, data: await DappEngine.getUser(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/users', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await DappEngine.createUser(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/users/:id/roles', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const user = await DappEngine.getUser(req.params.id);
    const data = await DappEngine.setUserRoles({ email: user.email, roles: req.body.roles, activeRole: req.body.activeRole });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/users/:id/active', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const user = await DappEngine.getUser(req.params.id);
    const data = await DappEngine.setUserActive(user.email, req.body.isActive !== false);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/users/link-wallet', portalAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { email, walletAddress, provider, safeOwnerAddress } = req.body;
    const data = await DappEngine.linkWallet({ email, walletAddress, provider, safeOwnerAddress });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/auth/send-code', authRateLimiter(), async (req, res) => {
  try {
    const { email } = req.body;
    const data = await DappEngine.generateOtp(email);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/auth/verify', authRateLimiter(), async (req, res) => {
  try {
    const { email, code } = req.body;
    const data = await DappEngine.verifyOtp({ email, code });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/auth/me', portalAuth, async (req, res) => {
  try {
    const email = req.user && req.user.email;
    let dappUser = null;
    if (email) {
      dappUser = await DappEngine.getUserByEmail(email).then(u => DappEngine._sanitizeUser(u)).catch(() => null);
    }
    res.json({ success: true, data: { user: req.user, dappUser } });
  } catch (err) { sendError(res, err); }
});

router.post('/auth/switch-role', portalAuth, async (req, res) => {
  try {
    const { activeRole } = req.body;
    const email = req.user && req.user.email;
    if (!email) throw new Error('Not authenticated');
    const data = await DappEngine.switchActiveRole({ email, activeRole });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/auth/logout', portalAuth, async (req, res) => {
  res.json({ success: true, data: { message: 'Session cleared on client. Please remove dlb-dapp-token from storage.' } });
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

// Cash App Pay Partner Payouts (merchant -> customer push)
router.post('/payment-rails/cashapp/payout-request', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await CashAppEngine.createPayoutRequest(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/payment-rails/cashapp/payout', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await CashAppEngine.createPayout(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/payment-rails/cashapp/requests/:requestId', operatorAuth, async (req, res) => {
  try {
    const data = await CashAppEngine.getRequest(req.params.requestId);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/payment-rails/cashapp/payouts/:payoutId', operatorAuth, async (req, res) => {
  try {
    const data = await CashAppEngine.getPayout(req.params.payoutId);
    res.json({ success: true, data });
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

// ─── MoonPay On-Ramp ────────────────────────────────────────────────────────────
router.get('/moonpay/readiness', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: MoonPayEngine.readiness() }); } catch (err) { sendError(res, err); }
});

router.get('/moonpay/onramp', operatorAuth, async (req, res) => {
  try {
    const url = MoonPayEngine.buildUrl({
      currencyCode: req.query.currencyCode,
      walletAddress: req.query.walletAddress,
      fiatCurrency: req.query.fiatCurrency,
      amount: req.query.amount,
    });
    res.json({ success: true, data: { url, targetWallet: req.query.walletAddress || MoonPayEngine.getConfig().operatorAddress } });
  } catch (err) { sendError(res, err); }
});

router.post('/moonpay/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-moonpay-signature'] || '';
    const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : (Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {})));
    const parsed = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
    const result = await MoonPayEngine.webhook(parsed, signature, rawBody);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[moonpay webhook]', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
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

router.get('/calendar/events', portalAuth, async (req, res) => {
  try { res.json({ success: true, data: await CalendarEngine.listEvents(req.query) }); } catch (err) { sendError(res, err); }
});

router.post('/calendar/events', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await CalendarEngine.createEvent(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/calendar/events/:id', portalAuth, async (req, res) => {
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

router.get('/messaging/threads', portalAuth, async (req, res) => {
  try { res.json({ success: true, data: await MessagingEngine.listThreads(req.query) }); } catch (err) { sendError(res, err); }
});

router.post('/messaging/threads', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await MessagingEngine.createThread(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/messaging/threads/:id', portalAuth, async (req, res) => {
  try {
    const thread = await MessagingEngine.getThread(req.params.id);
    if (!thread) return res.status(404).json({ success: false, error: 'Thread not found' });
    const messages = await MessagingEngine.listMessages(req.params.id);
    res.json({ success: true, data: { thread, messages } });
  } catch (err) { sendError(res, err); }
});

router.post('/messaging/threads/:id/messages', portalAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await MessagingEngine.sendMessage({ threadId: req.params.id, ...req.body });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Document Vault (dApp wrappers)
// ═════════════════════════════════════════════════════════════════════════════

router.get('/documents', portalAuth, async (req, res) => {
  try { res.json({ success: true, data: await DocumentEngine.listDocuments(req.query) }); } catch (err) { sendError(res, err); }
});

router.post('/documents', portalAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await DocumentEngine.createDocument(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/documents/:id', portalAuth, async (req, res) => {
  try {
    const data = await DocumentEngine.getDocument(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Document not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Connected wallet balances & activity
// ═════════════════════════════════════════════════════════════════════════════

router.get('/wallet/balances', portalAuth, async (req, res) => {
  try {
    const { chain, address } = req.query;
    const data = await DappEngine.getWalletBalances({ chain, address });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/wallet/activity', portalAuth, async (req, res) => {
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

router.post('/sovereign-trust/transfer', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await SovereignTrustEngine.operatorTransfer(req.body) }); } catch (err) { sendError(res, err); }
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

// ═════════════════════════════════════════════════════════════════════════════
// Account Abstraction / Gas Abstraction (EIP-4337 v0.6)
// ═════════════════════════════════════════════════════════════════════════════

router.get('/aa/readiness', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await AccountAbstractionEngine.readiness() }); } catch (err) { sendError(res, err); }
});

router.post('/aa/deploy-paymaster', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await AccountAbstractionEngine.deployPaymaster() }); } catch (err) { sendError(res, err); }
});

router.post('/aa/fund-paymaster', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await AccountAbstractionEngine.fundPaymaster(req.body) }); } catch (err) { sendError(res, err); }
});

router.get('/aa/paymaster-balance', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await AccountAbstractionEngine.getPaymasterBalance() }); } catch (err) { sendError(res, err); }
});

router.post('/aa/seed-paymaster', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await AccountAbstractionEngine.seedPaymaster(req.body) }); } catch (err) { sendError(res, err); }
});

// ─── Operator Gas Tank (auto ETH replenishment) ───────────────────────────────────
router.get('/operator-gas-tank/status', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await OperatorGasTank.getStatus() }); } catch (err) { sendError(res, err); }
});

router.post('/operator-gas-tank/check-and-topup', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await OperatorGasTank.checkAndTopUp(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/operator-gas-tank/topups/:id/execute', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await OperatorGasTank.executePending(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/aa/whitelist-sender', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await AccountAbstractionEngine.whitelistSender(req.body.address, req.body.allowed !== false) }); } catch (err) { sendError(res, err); }
});

router.post('/aa/smart-account', operatorAuth, async (req, res) => {
  try {
    const { owner, index } = req.body;
    const address = await AccountAbstractionEngine.getSmartAccountAddress(owner, index ? BigInt(index) : 0n);
    res.json({ success: true, data: { owner, index: index || 0, smartAccountAddress: address } });
  } catch (err) { sendError(res, err); }
});

router.post('/aa/prepare-transfer', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await AccountAbstractionEngine.prepareGaslessTransfer(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/aa/submit-transfer', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await AccountAbstractionEngine.submitGaslessTransfer(req.body) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Asset-to-Debt Proof Engine
// ═════════════════════════════════════════════════════════════════════════════
const { AssetDebtProofEngine } = require('../integrations/accounting/assetDebtProofEngine');

router.get('/asset-debt-proofs', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await AssetDebtProofEngine.listProofs(Number(req.query.limit) || 50) }); } catch (err) { sendError(res, err); }
});

router.get('/asset-debt-proofs/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await AssetDebtProofEngine.getProof(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/asset-debt-proofs/compute', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await AssetDebtProofEngine.computeProof(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/asset-debt-proofs/:id/sign', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await AssetDebtProofEngine.signProof(req.params.id, req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/asset-debt-proofs/:id/reject', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await AssetDebtProofEngine.rejectProof(req.params.id, req.body) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Distribution / Disbursement Requests with 2-trustee approval
// ═════════════════════════════════════════════════════════════════════════════
const { DistributionRequestEngine } = require('../integrations/dapp/distributionRequestEngine');

function optionalAuth(req, res, next) {
  // Beneficiary view may be public or admin-gated depending on deployment.
  return operatorAuth(req, res, next);
}

router.get('/distribution-requests', portalAuth, async (req, res) => {
  try { res.json({ success: true, data: await DistributionRequestEngine.listRequests({ status: req.query.status, beneficiaryEmail: req.query.beneficiaryEmail, limit: Number(req.query.limit) || 50 }) }); } catch (err) { sendError(res, err); }
});

router.get('/distribution-requests/:id', portalAuth, async (req, res) => {
  try { res.json({ success: true, data: await DistributionRequestEngine.getRequest(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/distribution-requests', portalAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await DistributionRequestEngine.createRequest(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/distribution-requests/:id/approve', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await DistributionRequestEngine.approveRequest({ requestId: req.params.id, ...req.body }) }); } catch (err) { sendError(res, err); }
});

router.post('/distribution-requests/:id/reject', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await DistributionRequestEngine.rejectRequest({ requestId: req.params.id, ...req.body }) }); } catch (err) { sendError(res, err); }
});

router.post('/distribution-requests/:id/execute', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await DistributionRequestEngine.executeRequest(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.get('/beneficiary/activity', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await DistributionRequestEngine.getBeneficiaryActivity(req.query.email) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Asset / Liability / Expense Management
// ═════════════════════════════════════════════════════════════════════════════

router.get('/assets', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await ExpenseManagementEngine.listRecords({ type: 'asset', category: req.query.category, status: req.query.status, limit: Number(req.query.limit) || 100 }) }); } catch (err) { sendError(res, err); }
});

router.post('/assets', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await ExpenseManagementEngine.createRecord({ ...req.body, type: 'asset', createdBy: req.user?.email }) }); } catch (err) { sendError(res, err); }
});

router.get('/liabilities', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await ExpenseManagementEngine.listRecords({ type: 'liability', category: req.query.category, status: req.query.status, limit: Number(req.query.limit) || 100 }) }); } catch (err) { sendError(res, err); }
});

router.post('/liabilities', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await ExpenseManagementEngine.createRecord({ ...req.body, type: 'liability', createdBy: req.user?.email }) }); } catch (err) { sendError(res, err); }
});

router.get('/assets/:id', operatorAuth, async (req, res) => {
  try {
    const rec = await ExpenseManagementEngine.getRecord(req.params.id);
    if (!rec) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: rec });
  } catch (err) { sendError(res, err); }
});

router.put('/assets/:id', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await ExpenseManagementEngine.updateRecord(req.params.id, req.body) }); } catch (err) { sendError(res, err); }
});

router.delete('/assets/:id', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await ExpenseManagementEngine.deleteRecord(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.get('/expenses', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await ExpenseManagementEngine.listExpenses({ status: req.query.status, assetLiabilityId: req.query.assetLiabilityId, limit: Number(req.query.limit) || 100 }) }); } catch (err) { sendError(res, err); }
});

router.post('/expenses', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await ExpenseManagementEngine.createExpense({ ...req.body, createdBy: req.user?.email }) }); } catch (err) { sendError(res, err); }
});

router.get('/expenses/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await ExpenseManagementEngine.getExpense(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/expenses/:id/approve', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await ExpenseManagementEngine.approveExpense(req.params.id, { ...req.body, approvedBy: req.user?.email }) }); } catch (err) { sendError(res, err); }
});

router.post('/expenses/:id/reject', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await ExpenseManagementEngine.rejectExpense(req.params.id, req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/expenses/:id/pay', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await ExpenseManagementEngine.payExpense(req.params.id, { ...req.body, createdBy: req.user?.email }) }); } catch (err) { sendError(res, err); }
});

router.get('/expense-totals', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await ExpenseManagementEngine.getTotals() }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// One-Click Distribution / Disbursement Automation
// ═════════════════════════════════════════════════════════════════════════════

router.get('/automations/templates', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await DisbursementAutomationEngine.listTemplates(Number(req.query.limit) || 100) }); } catch (err) { sendError(res, err); }
});

router.post('/automations/templates', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await DisbursementAutomationEngine.createTemplate({ ...req.body, createdBy: req.user?.email }) }); } catch (err) { sendError(res, err); }
});

router.get('/automations/runs', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await DisbursementAutomationEngine.listRuns(Number(req.query.limit) || 100) }); } catch (err) { sendError(res, err); }
});

router.get('/automations/runs/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await DisbursementAutomationEngine.getRun(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/automations/one-click-distribution', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await DisbursementAutomationEngine.runOneClickDistribution({ ...req.body, createdBy: req.user?.email }) }); } catch (err) { sendError(res, err); }
});

router.post('/automations/runs/:id/approve-execute', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await DisbursementAutomationEngine.approveAndExecuteRun(req.params.id, req.body) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Funding Orchestrator
// ═════════════════════════════════════════════════════════════════════════════

router.get('/funding/status', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await FundingEngine.getStatus(req.query) }); } catch (err) { sendError(res, err); }
});

router.post('/funding/plan', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await FundingEngine.buildPlan(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/funding/execute', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await FundingEngine.executePlan(req.body) }); } catch (err) { sendError(res, err); }
});

router.get('/funding/deposit-invoice', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await FundingEngine.getDepositInvoice(req.query) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Public landing / beneficiary request entry point
// ═════════════════════════════════════════════════════════════════════════════

router.post('/public/message', writeRateLimiter(), async (req, res) => {
  try {
    const { name, email, body } = req.body || {};
    if (!name || !email || !body) throw new Error('Name, email and message body are required');
    if (!MessagingEngine) throw new Error('Messaging engine unavailable');
    const thread = await MessagingEngine.notify({
      subject: `Landing page message from ${name}`,
      body: `From: ${name} <${email}>\n\n${body}`,
      participants: [
        { name: 'Malissa Robinson', email: 'annrobinson9800@yahoo.com', role: 'trustee_maker' },
        { name: 'Checker Trust', email: 'dbnettrust@gmail.com', role: 'trustee_checker' },
      ],
      sender: email,
      metadata: { source: 'landing', name, email },
    });
    res.json({ success: true, data: thread });
  } catch (err) { sendError(res, err); }
});

router.post('/public/request', writeRateLimiter(), async (req, res) => {
  try {
    const { beneficiaryName, beneficiaryEmail, beneficiaryPhone, beneficiaryWallet, amountUsd, message } = req.body || {};
    if (!beneficiaryEmail) throw new Error('Beneficiary email is required');
    if (!amountUsd || Number(amountUsd) <= 0) throw new Error('A positive amount is required');

    // Ensure beneficiary user exists
    let beneficiary = await DappEngine.getUserByEmail(beneficiaryEmail).catch(() => null);
    if (!beneficiary) {
      beneficiary = await DappEngine.createUser({ email: beneficiaryEmail, name: beneficiaryName || beneficiaryEmail.split('@')[0], phone: beneficiaryPhone, roles: ['beneficiary'], activeRole: 'beneficiary' });
    }
    if (beneficiaryWallet) {
      await DappEngine.linkWallet({ email: beneficiaryEmail, walletAddress: beneficiaryWallet, provider: 'manual' }).catch(() => {});
    } else {
      // Create a system wallet for the beneficiary so funds can be released automatically
      const wallets = await WalletEngine.getWalletsByUser(beneficiary.id);
      if (!wallets.length) {
        const wallet = await WalletEngine.createWallet({ userId: beneficiary.id, name: `${beneficiary.name || beneficiaryEmail} Wallet`, type: 'internal' });
        await DappEngine.linkWallet({ email: beneficiaryEmail, walletAddress: wallet.address, provider: 'system' }).catch(() => null);
      }
    }

    const refreshed = await DappEngine.getUserByEmail(beneficiaryEmail);
    const destinationAddress = refreshed.wallet_address || beneficiaryWallet || beneficiaryEmail;

    // Ensure maker and checker portal users exist
    const makerEmail = 'annrobinson9800@yahoo.com';
    const checkerEmail = 'dbnettrust@gmail.com';
    let maker = await DappEngine.getUserByEmail(makerEmail).catch(() => null);
    let checker = await DappEngine.getUserByEmail(checkerEmail).catch(() => null);
    if (!maker) maker = await DappEngine.createUser({ email: makerEmail, name: 'Malissa Robinson', roles: ['trustee_maker', 'beneficiary'], activeRole: 'trustee_maker' });
    if (!checker) checker = await DappEngine.createUser({ email: checkerEmail, name: 'Checker Trust', roles: ['trustee_checker', 'beneficiary'], activeRole: 'trustee_checker' });

    // Kick off the full automation pipeline: proof -> request -> sequential approval/execution
    // DistributionRequestEngine.createRequest emails the maker trustee with a one-time PIN.
    const run = await DisbursementAutomationEngine.runOneClickDistribution({
      name: `Landing request from ${beneficiaryName || beneficiaryEmail}`,
      type: 'distribution',
      beneficiaryEmail,
      beneficiaryName: beneficiaryName || beneficiaryEmail.split('@')[0],
      amountUsd: Number(amountUsd).toFixed(2),
      destinationAddress,
      requesterRole: 'beneficiary',
      memo: message || `Landing request submitted by ${beneficiaryEmail}`,
      autoExecute: false,
      createdBy: beneficiaryEmail,
    });

    const requestId = run && run.requests && run.requests[0] && run.requests[0].id;
    res.json({ success: true, data: { run, beneficiary, requestId, message: 'Request submitted. The maker trustee has been notified by email.' } });
  } catch (err) { sendError(res, err); }
});

// ─── Simplified Payout Center ─────────────────────────────────────────────────
router.get('/payout-center/recipients', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await PayoutCenterEngine.listRecipients({ role: req.query.role }) }); } catch (err) { sendError(res, err); }
});

router.get('/payout-center/payments', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await PayoutCenterEngine.listPayments({ limit: Number(req.query.limit) || 50 }) }); } catch (err) { sendError(res, err); }
});

router.post('/payout-center/pay', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const {
      paymentType, sourceType, sourceAccountId,
      recipientType, recipientIdentifier, amount, asset, description,
      rail, railOptions,
    } = req.body;
    const allowedRails = ['sit','dex','cashapp','cash_app','cash','fund_rail','module','stablecoin_dex','btcpay','lili','lili_bank'];
    const allowedAssets = ['SIT','USDC','USD','ETH','WETH','DAI','CASH','BTC'];
    if (!sourceType || !sourceAccountId) throw new Error('sourceType and sourceAccountId are required');
    if (!recipientIdentifier) throw new Error('recipientIdentifier is required');
    if (amount === undefined || amount === null || isNaN(Number(amount))) throw new Error('amount is required and must be numeric');
    if (!asset || !allowedAssets.includes(String(asset).toUpperCase())) throw new Error('asset must be one of: ' + allowedAssets.join(', '));
    if (rail && !allowedRails.includes(String(rail).toLowerCase())) throw new Error('rail is not supported');
    const sanitizedRailOptions = typeof railOptions === 'object' && railOptions !== null ? railOptions : {};
    const data = await PayoutCenterEngine.createPayment({
      paymentType, sourceType, sourceAccountId,
      recipientType: recipientType || 'external',
      recipientIdentifier,
      amount: Number(amount),
      asset: String(asset).toUpperCase(),
      description,
      rail,
      railOptions: {
        ...sanitizedRailOptions,
        createPoolIfMissing: Boolean(sanitizedRailOptions.createPoolIfMissing),
        poolSeedUsdc: Number(sanitizedRailOptions.poolSeedUsdc) || 0.005,
        poolSeedDlbusd: Number(sanitizedRailOptions.poolSeedDlbusd) || 10,
        poolAddress: sanitizedRailOptions.poolAddress || undefined,
      },
    });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Wallets — simple wallet cards, balances, internal & external transfers
// ═════════════════════════════════════════════════════════════════════════════

router.get('/wallets', operatorAuth, async (req, res) => {
  try { await WalletEngine.ensureWalletsForAllUsers(); res.json({ success: true, data: await WalletEngine.listWallets() }); } catch (err) { sendError(res, err); }
});

router.post('/wallets', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { userId, name, type, address, privateKey } = req.body;
    const data = await WalletEngine.createWallet({ userId, name, type, address, privateKey });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/wallets/:id', operatorAuth, async (req, res) => {
  try { const data = await WalletEngine.getWallet(req.params.id); res.json({ success: true, data }); } catch (err) { sendError(res, err); }
});

router.get('/wallets/:id/balance', operatorAuth, async (req, res) => {
  try { const data = await WalletEngine.getBalance(req.params.id); res.json({ success: true, data }); } catch (err) { sendError(res, err); }
});

router.get('/wallets/:id/transactions', operatorAuth, async (req, res) => {
  try { const data = await WalletEngine.listTransactions(req.params.id); res.json({ success: true, data }); } catch (err) { sendError(res, err); }
});

router.get('/wallets/:id/swap/quote', operatorAuth, async (req, res) => {
  try {
    const { assetIn, assetOut, amount } = req.query;
    const data = await WalletEngine.quoteSwap({ walletId: req.params.id, assetIn, assetOut, amount });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/wallets/:id/swap', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { assetIn, assetOut, amount, slippageBps } = req.body || {};
    const data = await WalletEngine.swapTokens({ walletId: req.params.id, assetIn, assetOut, amount, slippageBps });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/wallets/:id/fund', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { amount, asset, sourceType, sourceAccountId, memo } = req.body;
    const data = await WalletEngine.fundWallet({ walletId: req.params.id, amount, asset: asset || 'SIT', sourceType: sourceType || 'treasury', sourceAccountId: sourceAccountId || 'TREASURY_HOT', memo });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/wallets/transfer', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { fromWalletId, toWalletId, toAddress, amount, asset, memo, reconcile } = req.body;
    if (!fromWalletId || (!toWalletId && !toAddress)) throw new Error('fromWalletId and toWalletId or toAddress required');
    const data = await WalletEngine.transfer({ fromWalletId, toWalletId, toAddress, amount, asset: asset || 'SIT', memo, reconcile });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Wallet Funding from Core Banking / General Ledger ────────────────────────
router.get('/wallets/fund-all/preview', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await WalletFundingEngine.preview() }); } catch (err) { sendError(res, err); }
});

router.post('/wallets/fund-all', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { asset, autoConvert, dryRun } = req.body || {};
    const data = await WalletFundingEngine.fundAll({ asset: asset || 'SIT', autoConvert: autoConvert !== false, dryRun: dryRun === true });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Master Wallets & Fixed-Income Automation ─────────────────────────────────
router.get('/master-wallets', adminAuth, async (req, res) => {
  try { res.json({ success: true, data: await MasterWalletEngine.getAll() }); } catch (err) { sendError(res, err); }
});

router.post('/master-wallets/ensure', adminAuth, async (req, res) => {
  try { res.json({ success: true, data: await MasterWalletEngine.ensureMasterWallets() }); } catch (err) { sendError(res, err); }
});

router.post('/master-wallets/:subtype/transfer', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { toSubtype, amount, asset, memo } = req.body;
    const data = await MasterWalletEngine.transfer({ fromSubtype: req.params.subtype, toSubtype, amount, asset: asset || 'SIT', memo });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/master-wallets/:subtype/external-send', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { toAddress, amount, asset, tokenAddress, decimals, memo } = req.body;
    const data = await MasterWalletEngine.externalSend({ fromSubtype: req.params.subtype, toAddress, amount, asset: asset || 'SIT', tokenAddress, decimals, memo });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/master-wallets/distribute-fixed-income', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { bondId, amount, targetAsset, memo } = req.body;
    const data = await MasterWalletEngine.distributeFixedIncome({ bondId, amount, targetAsset, memo });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/bonds/:id/distribute-interest', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { amount, targetAsset, memo } = req.body || {};
    const data = await MasterWalletEngine.distributeFixedIncome({ bondId: req.params.id, amount, targetAsset, memo });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/master-wallets/backfill', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { bondId, backfillPrincipal, backfillInterest } = req.body || {};
    const data = await MasterWalletEngine.backfillMasterWallets({ bondId, backfillPrincipal, backfillInterest });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/bonds/portfolio', adminAuth, async (req, res) => {
  try {
    if (!BondEngine) throw new Error('BondEngine not available');
    const bonds = await BondEngine.listBonds();
    const metrics = [];
    for (const bond of bonds) {
      try { metrics.push(await LiveBondEngine.getBondLiveMetrics(bond.id)); } catch (e) { metrics.push({ bond_id: bond.id, bond_name: bond.bond_name, error: e.message }); }
    }
    res.json({ success: true, data: { bonds, metrics } });
  } catch (err) { sendError(res, err); }
});

// ─── Reconcile trust accounting / sub-ledgers / cash with the BondEngine ──────
router.post('/bonds/reconcile-trust', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    if (!BondTrustReconciliation) throw new Error('BondTrustReconciliation not available');
    const data = await BondTrustReconciliation.sync(req.body.bondId || 'DLB-PRB');
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Operator Wallet (for direct funding of gas / pool liquidity) ───────────────
router.get('/operator/wallet', operatorAuth, async (req, res) => {
  try {
    const cfg = StablecoinDexEngine.getConfig();
    if (!cfg.operatorAddress) throw new Error('Operator wallet not configured');
    res.json({ success: true, data: { address: cfg.operatorAddress, network: cfg.chainId === 1 ? 'ethereum-mainnet' : 'sepolia', assets: ['ETH', 'WETH', 'DAI', 'USDC', 'DLBUSD'] } });
  } catch (err) { sendError(res, err); }
});

// ─── Fund operator wallet from a DLB Trust source ledger ──────────────────────
router.post('/operator/fund', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { sourceType, sourceAccountId, asset, amount, description, railOptions } = req.body;
    if (!sourceType || !sourceAccountId || !asset || amount === undefined || amount === null) {
      throw new Error('sourceType, sourceAccountId, asset, and amount are required');
    }
    const cfg = StablecoinDexEngine.getConfig();
    if (!cfg.operatorAddress) throw new Error('Operator wallet not configured');
    const data = await PayoutCenterEngine.createPayment({
      paymentType: 'operator_fund',
      sourceType,
      sourceAccountId,
      recipientType: 'external',
      recipientIdentifier: cfg.operatorAddress,
      amount,
      asset,
      description: description || `Fund operator wallet from ${sourceType}`,
      rail: 'dex',
      railOptions: railOptions || {},
    });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Mobile Beneficiary PWA API ─────────────────────────────────────────────────
// Public routes (no auth) are handled by /auth/send-code and /auth/verify.
// /auth/me already returns the logged-in dApp user.

function sanitizeWallet(w) {
  if (!w) return w;
  const safe = { ...w };
  delete safe.private_key_encrypted;
  delete safe.seed_phrase_encrypted;
  return safe;
}

router.get('/beneficiary/wallet', portalAuth, async (req, res) => {
  try {
    const email = req.user && req.user.email;
    if (!email) throw new Error('Not authenticated');
    const user = await DappEngine.getUserByEmail(email);
    const wallets = await WalletEngine.getWalletsByUser(user.id);
    const wallet = wallets.find(w => w.is_primary) || wallets[0];
    if (!wallet) throw new Error('No wallet found for this beneficiary');
    const balance = await WalletEngine.getBalance(wallet.id);
    res.json({ success: true, data: { user: DappEngine._sanitizeUser ? DappEngine._sanitizeUser(user) : user, wallet: sanitizeWallet(wallet), balance } });
  } catch (err) { sendError(res, err); }
});

router.get('/beneficiary/transactions', portalAuth, async (req, res) => {
  try {
    const email = req.user && req.user.email;
    if (!email) throw new Error('Not authenticated');
    const user = await DappEngine.getUserByEmail(email);
    const wallets = await WalletEngine.getWalletsByUser(user.id);
    const wallet = wallets.find(w => w.is_primary) || wallets[0];
    if (!wallet) throw new Error('No wallet found');
    const data = await WalletEngine.listTransactions(wallet.id);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/beneficiary/transfer', portalAuth, writeRateLimiter(), async (req, res) => {
  try {
    const email = req.user && req.user.email;
    if (!email) throw new Error('Not authenticated');
    const { toAddress, amount, asset = 'SIT', memo = '' } = req.body;
    if (!toAddress || amount === undefined || amount === null) throw new Error('toAddress and amount required');
    const user = await DappEngine.getUserByEmail(email);
    const wallets = await WalletEngine.getWalletsByUser(user.id);
    const wallet = wallets.find(w => w.is_primary) || wallets[0];
    if (!wallet) throw new Error('No wallet found');
    const data = await WalletEngine.transfer({ fromWalletId: wallet.id, toAddress, amount, asset: asset.toUpperCase(), memo });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/beneficiary/bitpay/invoice', portalAuth, async (req, res) => {
  try {
    const email = req.user && req.user.email;
    if (!email) throw new Error('Not authenticated');
    const { invoiceUrl } = req.body;
    if (!invoiceUrl) throw new Error('invoiceUrl required');
    const url = BitPayEngine.normalizeInvoiceUrl(invoiceUrl);
    if (!url) throw new Error('Invalid BitPay invoice URL');
    const options = await BitPayEngine.getPaymentOptions(url);
    const selected = (options.paymentOptions || []).find(o => o.chain === 'ETH') || (options.paymentOptions || [])[0] || null;
    res.json({
      success: true,
      data: {
        url,
        memo: options.memo,
        paymentId: options.paymentId,
        expires: options.expires,
        options: options.paymentOptions || [],
        selectedOption: selected,
      }
    });
  } catch (err) { sendError(res, err); }
});

router.post('/beneficiary/bitpay/pay', portalAuth, writeRateLimiter(), async (req, res) => {
  try {
    const email = req.user && req.user.email;
    if (!email) throw new Error('Not authenticated');
    const { invoiceUrl, asset } = req.body;
    if (!invoiceUrl || !asset) throw new Error('invoiceUrl and asset required');
    const user = await DappEngine.getUserByEmail(email);
    const wallets = await WalletEngine.getWalletsByUser(user.id);
    const wallet = wallets.find(w => w.is_primary) || wallets[0];
    if (!wallet) throw new Error('No wallet found');
    const data = await BitPayEngine.payInvoice({ fromWalletId: wallet.id, invoiceUrl, asset: asset.toUpperCase() });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── PTC Private Trust Portal ───────────────────────────────────────────────────
router.get('/ptc/dashboard', portalAuth, async (req, res) => {
  try {
    const email = req.user && req.user.email;
    const data = await PtcPortalEngine.getDashboard(email);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/ptc/members', portalAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await PtcPortalEngine.listMembers() });
  } catch (err) { sendError(res, err); }
});

router.post('/ptc/seed', operatorAuth, async (req, res) => {
  try {
    const data = await PtcPortalEngine.ensureMembers();
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/ptc/request', portalAuth, writeRateLimiter(), async (req, res) => {
  try {
    const email = req.user && req.user.email;
    if (!email) throw new Error('Not authenticated');
    const { amount, purpose, railPreference, recipientDetails } = req.body || {};
    const data = await PtcPortalEngine.requestDistribution({ email, amount, purpose, railPreference, recipientDetails });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/ptc/requests/:id/approve', portalAuth, writeRateLimiter(), async (req, res) => {
  try {
    const email = req.user && req.user.email;
    if (!email) throw new Error('Not authenticated');
    const data = await PtcPortalEngine.approveRequest({ requestId: req.params.id, email });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/ptc/requests/:id/execute', portalAuth, writeRateLimiter(), async (req, res) => {
  try {
    const email = req.user && req.user.email;
    if (!email) throw new Error('Not authenticated');
    const member = await PtcPortalEngine.getMemberByEmail(email);
    if (!member || !String(member.type).includes('trustee')) throw new Error('Only trustees can execute payouts');
    const { rail, recipientIdentifier, options } = req.body || {};
    const data = await PtcPortalEngine.executeRequest({ requestId: req.params.id, rail, recipientIdentifier, options, initiatedBy: email });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Stripe Treasury Batch Bridge ─────────────────────────────────────────────
router.post('/ptc/stripe-treasury/deposit', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { amount, financialAccountId, creditAccountCode, depositType, description, reference } = req.body || {};
    const data = await StripeTreasuryBatchEngine.recordDeposit({ amount, financialAccountId, creditAccountCode, depositType, description, reference });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/ptc/stripe-treasury/batch-payouts', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { file, sourceCashAccountCode, sourceAccountId, financialAccountId, network, skipPrefund } = req.body || {};
    const data = await StripeTreasuryBatchEngine.processPaymentFile({
      file,
      sourceCashAccountCode,
      sourceAccountId,
      financialAccountId,
      initiatedBy: req.user && (req.user.email || req.user.username || 'batch'),
      network,
      skipPrefund,
    });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Customer Identification Program (CIP) ────────────────────────────────────
router.get('/ptc/cip/records', operatorAuth, async (req, res) => {
  try {
    if (!CustomerIdentificationEngine) throw new Error('CustomerIdentificationEngine not available');
    const data = await CustomerIdentificationEngine.list(req.query);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/ptc/cip/records/:id', operatorAuth, async (req, res) => {
  try {
    if (!CustomerIdentificationEngine) throw new Error('CustomerIdentificationEngine not available');
    const data = await CustomerIdentificationEngine.getRecord(req.params.id);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/ptc/cip/records', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    if (!CustomerIdentificationEngine) throw new Error('CustomerIdentificationEngine not available');
    const data = await CustomerIdentificationEngine.createRecord({ ...req.body, screenedBy: req.user && (req.user.email || req.user.username) });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/ptc/cip/records/:id/approve', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    if (!CustomerIdentificationEngine) throw new Error('CustomerIdentificationEngine not available');
    const data = await CustomerIdentificationEngine.approve(req.params.id, { reviewedBy: req.user && (req.user.email || req.user.username), notes: req.body && req.body.notes });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/ptc/cip/records/:id/block', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    if (!CustomerIdentificationEngine) throw new Error('CustomerIdentificationEngine not available');
    const data = await CustomerIdentificationEngine.block(req.params.id, { reviewedBy: req.user && (req.user.email || req.user.username), notes: req.body && req.body.notes });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/ptc/cip/status', portalAuth, async (req, res) => {
  try {
    if (!CustomerIdentificationEngine) throw new Error('CustomerIdentificationEngine not available');
    const email = req.user && req.user.email;
    if (!email) throw new Error('No email in session');
    const data = await CustomerIdentificationEngine.getRecordByEmail(email);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Deposit & Settlement Engine ────────────────────────────────────────────────
router.get('/ptc/deposit-settlement/orders', operatorAuth, async (req, res) => {
  try {
    if (!DepositAndSettlementEngine) throw new Error('DepositAndSettlementEngine not available');
    const data = await DepositAndSettlementEngine.list(req.query);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/ptc/deposit-settlement/orders/:id', operatorAuth, async (req, res) => {
  try {
    if (!DepositAndSettlementEngine) throw new Error('DepositAndSettlementEngine not available');
    const data = await DepositAndSettlementEngine.get(req.params.id);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/ptc/deposit-settlement/deposit', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    if (!DepositAndSettlementEngine) throw new Error('DepositAndSettlementEngine not available');
    const data = await DepositAndSettlementEngine.recordDeposit({ ...req.body, initiatedBy: req.user && (req.user.email || req.user.username) });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/ptc/deposit-settlement/settle', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    if (!DepositAndSettlementEngine) throw new Error('DepositAndSettlementEngine not available');
    const data = await DepositAndSettlementEngine.initiateSettlement({ ...req.body, initiatedBy: req.user && (req.user.email || req.user.username) });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/ptc/deposit-settlement/reconcile', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    if (!DepositAndSettlementEngine) throw new Error('DepositAndSettlementEngine not available');
    const data = await DepositAndSettlementEngine.reconcile({ ...req.body, initiatedBy: req.user && (req.user.email || req.user.username) });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Clearing API Engine ────────────────────────────────────────────────────────
router.get('/ptc/clearing/list', operatorAuth, async (req, res) => {
  try {
    if (!ClearingApiEngine) throw new Error('ClearingApiEngine not available');
    const data = await ClearingApiEngine.list(req.query);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/ptc/clearing/status/:id', operatorAuth, async (req, res) => {
  try {
    if (!ClearingApiEngine) throw new Error('ClearingApiEngine not available');
    const data = await ClearingApiEngine.getStatus(req.params.id);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/ptc/clearing/submit', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    if (!ClearingApiEngine) throw new Error('ClearingApiEngine not available');
    const data = await ClearingApiEngine.submit({ ...req.body, initiatedBy: req.user && (req.user.email || req.user.username) });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/ptc/clearing/reconcile', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    if (!ClearingApiEngine) throw new Error('ClearingApiEngine not available');
    const data = await ClearingApiEngine.reconcileFromWebhook(req.body);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Payment Processor Server Engine ──────────────────────────────────────────
router.get('/payment-processor/processors', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: PaymentProcessorServerEngine.getProcessors() }); } catch (err) { sendError(res, err); }
});

router.get('/payment-processor/balance/:processor', operatorAuth, async (req, res) => {
  try {
    const data = await PaymentProcessorServerEngine.getBalance(req.params.processor, req.query.accountId);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/payment-processor/process', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await PaymentProcessorServerEngine.processPayment({ ...req.body, initiatedBy: req.user && (req.user.email || req.user.username) });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/payment-processor/refund', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await PaymentProcessorServerEngine.refund({ ...req.body, initiatedBy: req.user && (req.user.email || req.user.username) });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/payment-processor/reconcile', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await PaymentProcessorServerEngine.reconcile({ ...req.body, initiatedBy: req.user && (req.user.email || req.user.username) });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/payment-processor/list', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await PaymentProcessorServerEngine.list(req.query) }); } catch (err) { sendError(res, err); }
});

router.get('/payment-processor/status/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await PaymentProcessorServerEngine.getStatus(req.params.id) }); } catch (err) { sendError(res, err); }
});

// ─── Payment Gateway Server Engine ────────────────────────────────────────────
router.get('/payment-gateway/methods', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await PaymentGatewayServerEngine.listMethods(req.query) }); } catch (err) { sendError(res, err); }
});

router.post('/payment-gateway/tokenize', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await PaymentGatewayServerEngine.tokenizePaymentMethod({ ...req.body, initiatedBy: req.user && (req.user.email || req.user.username) });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/payment-gateway/sale', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await PaymentGatewayServerEngine.sale({ ...req.body, initiatedBy: req.user && (req.user.email || req.user.username) });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/payment-gateway/authorize', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await PaymentGatewayServerEngine.authorize({ ...req.body, initiatedBy: req.user && (req.user.email || req.user.username) });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/payment-gateway/capture/:id', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await PaymentGatewayServerEngine.capture({ gatewayTxId: req.params.id, ...req.body, initiatedBy: req.user && (req.user.email || req.user.username) });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/payment-gateway/void/:id', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await PaymentGatewayServerEngine.void({ gatewayTxId: req.params.id, ...req.body, initiatedBy: req.user && (req.user.email || req.user.username) });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/payment-gateway/refund', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await PaymentGatewayServerEngine.refund({ ...req.body, initiatedBy: req.user && (req.user.email || req.user.username) });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/payment-gateway/status/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await PaymentGatewayServerEngine.getStatus(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.get('/payment-gateway/transactions', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await PaymentGatewayServerEngine.list(req.query) }); } catch (err) { sendError(res, err); }
});

router.post('/payment-gateway/webhook', writeRateLimiter(), async (req, res) => {
  try {
    const data = await PaymentGatewayServerEngine.reconcileWebhook(req.body);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Orchestr Payment Engine ──────────────────────────────────────────────────
router.post('/payment-processor/orchestr/checkout', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await OrchestrEngine.createCheckoutSession({ ...req.body, initiatedBy: req.user && (req.user.email || req.user.username) });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/payment-processor/orchestr/callback', writeRateLimiter(), async (req, res) => {
  try {
    const data = await OrchestrEngine.validateCallback(req.body);
    res.status(200).send(data.valid ? 'OK' : 'ERROR');
  } catch (err) { res.status(200).send('ERROR'); }
});

module.exports = router;
