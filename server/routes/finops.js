'use strict';

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { FinOpsAgent } = require('../integrations/finops/finopsAgent');
const { ModuleSmartAccountEngine } = require('../integrations/dapp/moduleSmartAccountEngine');
const { ModuleP2PSwapEngine } = require('../integrations/dapp/moduleP2PSwapEngine');
const { SpritzEngine } = require('../integrations/spritz/spritzEngine');
const { PeerOnRampEngine } = require('../integrations/peer/peerOnRampEngine');
const { PtcStablecoinEngine } = require('../integrations/dapp/ptcStablecoinEngine');
const { StablecoinEngine } = require('../integrations/dapp/stablecoinEngine');
const { RedemptionEngine } = require('../integrations/dapp/redemptionEngine');
const { AccountAbstractionEngine } = require('../integrations/dapp/accountAbstractionEngine');
const { CanonicalConsensusEngine } = require('../integrations/dapp/canonicalConsensusEngine');
const { FinOpsCoordinationEngine } = require('../integrations/finops/finopsCoordinationEngine');
const { HyperledgerBesuEngine } = require('../integrations/dapp/hyperledgerBesuEngine');
const { ClearingEngine } = require('../integrations/dapp/clearingEngine');
const { RedemptionGatewayEngine } = require('../integrations/dapp/redemptionGatewayEngine');
const { CanonicalLiquidityEngine } = require('../integrations/dapp/canonicalLiquidityEngine');
const { CanonicalMoneyEngine } = require('../integrations/dapp/canonicalMoneyEngine');
const { LiquidityPoolEngine } = require('../integrations/dapp/liquidityPoolEngine');
const { CrossChainConversionEngine } = require('../integrations/dapp/crossChainConversionEngine');
const { PairedAssetEngine } = require('../integrations/dapp/pairedAssetEngine');
const { OnOffRampEngine } = require('../integrations/dapp/onOffRampEngine');
const { TrustMarketEngine } = require('../integrations/dapp/trustMarketEngine');
const { IntentRoutingEngine } = require('../integrations/dapp/intentRoutingEngine');
const { ExternalWalletEngine } = require('../integrations/dapp/externalWalletEngine');
const { JournalEntryEngine } = require('../integrations/dapp/journalEntryEngine');
const { DlbCanonicalSwapEngine } = require('../integrations/dapp/dlbCanonicalSwapEngine');
const { TrustComputingEngine } = require('../integrations/dapp/trustComputingEngine');
const { HoldingManagementEngine } = require('../integrations/dapp/holdingManagementEngine');
const { CapitalFundEngine } = require('../integrations/dapp/capitalFundEngine');
const { VirtualAccountEngine } = require('../integrations/dapp/virtualAccountEngine');
const { WireOriginationEngine } = require('../integrations/dapp/wireOriginationEngine');
const { ElectronicMoneyEngine } = require('../integrations/dapp/electronicMoneyEngine');
const { OpenBankingEngine } = require('../integrations/dapp/openBankingEngine');
const { TrustDepositEngine } = require('../integrations/dapp/trustDepositEngine');
const { SkrillLinkEngine } = require('../integrations/payments/skrillLinkEngine');
const { BarcodeDepositEngine } = require('../integrations/payments/barcodeDepositEngine');
const { WebPaymentRailEngine } = require('../integrations/payments/webPaymentRailEngine');
const { LiliBankEngine } = require('../integrations/payments/liliBankEngine');
const { LiliMcpEngine } = require('../integrations/payments/liliMcpEngine');
const { ComplianceEngine } = require('../integrations/compliance/complianceEngine');
const { IssuerEngine } = require('../integrations/dapp/issuerEngine');
const { BankTransferEngine } = require('../integrations/dapp/bankTransferEngine');
const { VendorPaymentEngine } = require('../integrations/dapp/vendorPaymentEngine');
const { TrustBankEngine } = require('../integrations/dapp/trustBankEngine');
const { WealthManagementEngine } = require('../integrations/dapp/wealthManagementEngine');
const { TrustAggregatorEngine } = require('../integrations/dapp/trustAggregatorEngine');
const { ExternalEndpointEngine } = require('../integrations/dapp/externalEndpointEngine');
const { LiveFinTechEndpointEngine } = require('../integrations/dapp/liveFintechEndpointEngine');
const { CorporateTreasuryEngine } = require('../integrations/finops/corporateTreasuryEngine');
const { SettlementEngine } = require('../integrations/dapp/settlementEngine');
const { PaymentIdEngine } = require('../integrations/dapp/paymentIdEngine');
const { HostToHostEngine } = require('../integrations/dapp/hostToHostEngine');
const { LiveMoneyMovementEngine } = require('../integrations/dapp/liveMoneyMovementEngine');
let CashEngine;
try { ({ CashEngine } = require('../integrations/cash/cashEngine')); } catch (e) { CashEngine = null; }

const router = express.Router();
const operatorAuth = requireAuth({ role: 'operator' });

function sendError(res, err) {
  console.error('[finops]', err.message || err);
  res.status(400).json({ success: false, error: err.message || 'FinOps error' });
}

function getUserId(req) {
  const u = req.user || {};
  return String(u.username || u.userId || u.id || u.email || 'operator');
}

// Chat/NL command endpoint
router.post('/agent', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { command } = req.body || {};
    if (!command || typeof command !== 'string') throw new Error('command string required');
    const result = await FinOpsAgent.process({ command, userId: getUserId(req) });
    res.json({ success: true, data: result });
  } catch (err) { sendError(res, err); }
});

// Get pending approvals
router.get('/approvals/pending', operatorAuth, async (req, res) => {
  try {
    const rows = await FinOpsAgent.listPending({ limit: 20 });
    res.json({ success: true, data: rows });
  } catch (err) { sendError(res, err); }
});

// Approve or reject an approval
router.post('/approvals/:id/execute', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { id } = req.params;
    const { approved, reason } = req.body || {};
    if (typeof approved !== 'boolean') throw new Error('approved boolean required');
    const result = await FinOpsAgent.execute(id, { userId: getUserId(req), approved, reason });
    res.json({ success: true, data: result });
  } catch (err) { sendError(res, err); }
});

// Module data endpoints (used by dashboard cards)
router.get('/source-of-funds', operatorAuth, async (req, res) => {
  try {
    const data = await FinOpsAgent.executeRead('showSourceOfFunds');
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/wallets', operatorAuth, async (req, res) => {
  try {
    const data = await FinOpsAgent.executeRead('showWallets');
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/bonds', operatorAuth, async (req, res) => {
  try {
    const data = await FinOpsAgent.executeRead('showBonds');
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/crm', operatorAuth, async (req, res) => {
  try {
    const data = await FinOpsAgent.executeRead('showCrm');
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Module Smart Accounts (PTC tokenized custody) ───────────────────────────
router.get('/module-accounts', operatorAuth, async (req, res) => {
  try {
    const data = await ModuleSmartAccountEngine.listModules();
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/module-accounts/:module/init', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await ModuleSmartAccountEngine.initializeModule(req.params.module);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/module-accounts/:module/tokenize', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await ModuleSmartAccountEngine.tokenizeModule(req.params.module);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/module-accounts/:module/settle-to-operator', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { amount } = req.body || {};
    const data = await ModuleSmartAccountEngine.settleToOperator(req.params.module, amount);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/module-accounts/settle-all-to-operator', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await ModuleSmartAccountEngine.settleAllToOperator();
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Module P2P Swap (OTC order book, no WETH required) ───────────────────────
router.get('/module-p2p/orders', operatorAuth, async (req, res) => {
  try {
    const data = await ModuleP2PSwapEngine.listOrders({ maker: req.query.maker, activeOnly: req.query.active !== 'false' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/module-p2p/orders', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { moduleKey, amountIn, pricePerToken, tokenIn, tokenOut, amountOut, recipient } = req.body;
    let data;
    if (moduleKey) {
      data = await ModuleP2PSwapEngine.createModuleOrder({ moduleKey, amountIn, pricePerToken, recipient });
    } else {
      data = await ModuleP2PSwapEngine.createOrder({ tokenIn, amountIn, tokenOut, amountOut, recipient });
    }
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/module-p2p/orders/:id/fill', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await ModuleP2PSwapEngine.fillOrder({ orderId: req.params.id });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/module-p2p/orders/:id/cancel', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await ModuleP2PSwapEngine.cancelOrder({ orderId: req.params.id });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Spritz off-ramp rails ────────────────────────────────────────────────────
router.get('/spritz/user', operatorAuth, async (req, res) => {
  try {
    const data = await SpritzEngine.getUser();
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/spritz/bank-accounts', operatorAuth, async (req, res) => {
  try {
    const data = await SpritzEngine.listBankAccounts();
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/spritz/bank-accounts', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { routingNumber, accountNumber, accountSubtype, ownership, label } = req.body;
    const data = await SpritzEngine.createUSBankAccount({ routingNumber, accountNumber, accountSubtype, ownership, label });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.delete('/spritz/bank-accounts/:id', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await SpritzEngine.deleteBankAccount(req.params.id);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/spritz/quotes', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { accountId, amount, chain, tokenAddress, amountMode, rail, memo } = req.body;
    if (!accountId || amount === undefined || amount === null) throw new Error('accountId and amount required');
    const data = await SpritzEngine.createOffRampQuote({ accountId, amount, chain, tokenAddress, amountMode, rail, memo });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/spritz/quotes/:id', operatorAuth, async (req, res) => {
  try {
    const data = await SpritzEngine.getOffRampQuote(req.params.id);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/spritz/quotes/:id/transaction', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { senderAddress, feePayer } = req.body;
    const data = await SpritzEngine.getTransactionParams(req.params.id, { senderAddress, feePayer });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/spritz/quotes/:id/execute', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await SpritzEngine.executeQuote(req.params.id);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/spritz/off-ramps', operatorAuth, async (req, res) => {
  try {
    const data = await SpritzEngine.listOffRamps();
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/spritz/off-ramps/:id', operatorAuth, async (req, res) => {
  try {
    const data = await SpritzEngine.getOffRamp(req.params.id);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Spritz Bill Pay ─────────────────────────────────────────────────────────
router.get('/spritz/bills', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await SpritzEngine.listBills() }); } catch (err) { sendError(res, err); }
});

router.post('/spritz/bills/activate', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await SpritzEngine.activateBills(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/spritz/bills/:id/verify', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await SpritzEngine.startBillVerification(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/spritz/bills/:id/verify-submit', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await SpritzEngine.submitBillVerification(req.params.id, req.body.responses) }); } catch (err) { sendError(res, err); }
});

router.delete('/spritz/bills/:id', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await SpritzEngine.deleteBill(req.params.id) }); } catch (err) { sendError(res, err); }
});

// ─── Spritz Cards ────────────────────────────────────────────────────────────
router.get('/spritz/cards', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await SpritzEngine.listCards() }); } catch (err) { sendError(res, err); }
});

router.get('/spritz/cards/balance', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await SpritzEngine.getCardBalance() }); } catch (err) { sendError(res, err); }
});

router.post('/spritz/cards/:id/status', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await SpritzEngine.updateCardStatus(req.params.id, req.body.status) }); } catch (err) { sendError(res, err); }
});

router.post('/spritz/cards/:id/limit', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await SpritzEngine.updateCardLimit(req.params.id, req.body) }); } catch (err) { sendError(res, err); }
});

router.get('/spritz/debit-cards', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await SpritzEngine.listDebitCards() }); } catch (err) { sendError(res, err); }
});

router.post('/spritz/debit-cards', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await SpritzEngine.createDebitCard(req.body) }); } catch (err) { sendError(res, err); }
});

router.get('/spritz/integrator-token', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: { token: await SpritzEngine.getIntegratorToken() } }); } catch (err) { sendError(res, err); }
});

// ─── Peer / ZKP2P P2P fiat on-ramp (Base settlement, CashApp/Venmo/Wise/etc.) ───
router.post('/peer-onramp/quote', operatorAuth, async (req, res) => {
  try {
    const { platform, fiatCurrency, amountUsdc, recipient } = req.body || {};
    const data = await PeerOnRampEngine.getQuote({ platform, fiatCurrency, amountUsdc, recipient });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/peer-onramp/prepare', operatorAuth, async (req, res) => {
  try {
    const data = await PeerOnRampEngine.prepareSignal(req.body || {});
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/peer-onramp/execute', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await PeerOnRampEngine.executeSignal(req.body || {});
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/peer-onramp/intents', operatorAuth, async (req, res) => {
  try {
    const data = await PeerOnRampEngine.listIntents();
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/peer-onramp/intents/:hash', operatorAuth, async (req, res) => {
  try {
    const data = await PeerOnRampEngine.getIntentStatus(req.params.hash);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// PTC-backed Stablecoin (reserve vault)
// ═════════════════════════════════════════════════════════════════════════════
router.get('/ptc-stablecoin', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await PtcStablecoinEngine.info() }); } catch (err) { sendError(res, err); }
});

router.post('/ptc-stablecoin/deploy', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await PtcStablecoinEngine.deploy(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/ptc-stablecoin/reserve-tokens', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await PtcStablecoinEngine.addReserveToken(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/ptc-stablecoin/reserve-tokens/default', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await PtcStablecoinEngine.addDefaultReserveTokens() }); } catch (err) { sendError(res, err); }
});

router.post('/ptc-stablecoin/deposit', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await PtcStablecoinEngine.approveAndDeposit(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/ptc-stablecoin/deposit-all', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await PtcStablecoinEngine.depositAll(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/ptc-stablecoin/redeem', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await PtcStablecoinEngine.redeem(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/ptc-stablecoin/whitelist', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await PtcStablecoinEngine.whitelist(req.body.address, req.body.allowed !== false) }); } catch (err) { sendError(res, err); }
});

router.post('/ptc-stablecoin/transfer', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await PtcStablecoinEngine.transfer(req.body) }); } catch (err) { sendError(res, err); }
});

router.get('/ptc-stablecoin/balance/:address', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: { address: req.params.address, balance: await PtcStablecoinEngine.balanceOf(req.params.address) } }); } catch (err) { sendError(res, err); }
});

function getUserEmail(req) {
  const u = req.user || {};
  return u.email || u.username || u.userId || 'operator';
}

// ═════════════════════════════════════════════════════════════════════════════
// Stablecoin Engine (trust-owned, multi-collateral, auditable)
// ═════════════════════════════════════════════════════════════════════════════

router.get('/stablecoin', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await StablecoinEngine.info() }); } catch (err) { sendError(res, err); }
});

router.get('/stablecoin/collateral-ratio', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await StablecoinEngine.collateralRatio() }); } catch (err) { sendError(res, err); }
});

router.get('/stablecoin/audit', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await StablecoinEngine.getAuditLog(req.query.limit ? Number(req.query.limit) : 100) }); } catch (err) { sendError(res, err); }
});

router.post('/stablecoin/mint', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await StablecoinEngine.mint({ ...req.body, operatorEmail: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/stablecoin/redeem', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await StablecoinEngine.redeem({ ...req.body, operatorEmail: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/stablecoin/transfer', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await StablecoinEngine.transfer({ ...req.body, operatorEmail: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/stablecoin/settle', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await StablecoinEngine.settle({ ...req.body, operatorEmail: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/stablecoin/collateral', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await StablecoinEngine.addCollateral(req.body.moduleKey, req.body.price, req.body.token, req.body.decimals) }); } catch (err) { sendError(res, err); }
});

router.post('/stablecoin/pause', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await StablecoinEngine.pause() }); } catch (err) { sendError(res, err); }
});

router.post('/stablecoin/unpause', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await StablecoinEngine.unpause() }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Redemption Engine (DLB-PTCUSD / module tokens -> fiat payout)
// ═════════════════════════════════════════════════════════════════════════════

router.get('/redemptions', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await RedemptionEngine.list(req.query) }); } catch (err) { sendError(res, err); }
});

router.get('/redemptions/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await RedemptionEngine.get(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/redemptions', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await RedemptionEngine.create({ ...req.body, requesterEmail: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/redemptions/:id/execute', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await RedemptionEngine.execute(req.params.id, { operatorEmail: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/redemptions/:id/approve', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await RedemptionEngine.approve(req.params.id, getUserEmail(req)) }); } catch (err) { sendError(res, err); }
});

router.delete('/redemptions/:id', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await RedemptionEngine.cancel(req.params.id) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Canonical Consensus Engine (Maker / Checker approvals)
// ═════════════════════════════════════════════════════════════════════════════

router.get('/consensus', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CanonicalConsensusEngine.listProposals(req.query) }); } catch (err) { sendError(res, err); }
});

router.post('/consensus/proposals', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await CanonicalConsensusEngine.createProposal({ ...req.body, createdBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.get('/consensus/proposals/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CanonicalConsensusEngine.getProposal(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/consensus/proposals/:id/approve', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CanonicalConsensusEngine.approveProposal({ proposalId: req.params.id, ...req.body }) }); } catch (err) { sendError(res, err); }
});

router.post('/consensus/proposals/:id/reject', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CanonicalConsensusEngine.rejectProposal({ proposalId: req.params.id, ...req.body }) }); } catch (err) { sendError(res, err); }
});

router.post('/consensus/proposals/:id/execute', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CanonicalConsensusEngine.executeProposal(req.params.id) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Canonical Liquidity Engine (governed DEX liquidity for trust assets)
// ═════════════════════════════════════════════════════════════════════════════

router.get('/liquidity', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CanonicalLiquidityEngine.listPools() }); } catch (err) { sendError(res, err); }
});

router.get('/liquidity/proposals', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CanonicalLiquidityEngine.listProposals(req.query) }); } catch (err) { sendError(res, err); }
});

router.post('/liquidity/proposals', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { action, title, payload } = req.body;
    const data = await CanonicalLiquidityEngine.propose({ action, title, createdBy: getUserEmail(req), payload });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/liquidity/proposals/:id/approve', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CanonicalLiquidityEngine.approve({ proposalId: req.params.id, ...req.body }) }); } catch (err) { sendError(res, err); }
});

router.post('/liquidity/proposals/:id/execute', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CanonicalLiquidityEngine.executeProposal(req.params.id) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Canonical Money Engine (turn trust assets/income into canonical stablecoins)
// ═════════════════════════════════════════════════════════════════════════════

router.get('/canonical-money', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CanonicalMoneyEngine.listRequests(req.query) }); } catch (err) { sendError(res, err); }
});

router.post('/canonical-money/quote', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CanonicalMoneyEngine.quote(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/canonical-money/requests', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await CanonicalMoneyEngine.propose({ ...req.body, createdBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/canonical-money/requests/:id/approve', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CanonicalMoneyEngine.approve({ proposalId: req.params.id, ...req.body }) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Liquidity Pool Engine (BondDex pool creation, liquidity, swaps)
// ═════════════════════════════════════════════════════════════════════════════

router.get('/liquidity-pool', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await LiquidityPoolEngine.listPools() }); } catch (err) { sendError(res, err); }
});

router.get('/liquidity-pool/:address', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await LiquidityPoolEngine.getPool(req.params.address) }); } catch (err) { sendError(res, err); }
});

router.post('/liquidity-pool/create', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await LiquidityPoolEngine.createPool(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/liquidity-pool/add-liquidity', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await LiquidityPoolEngine.addLiquidity(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/liquidity-pool/remove-liquidity', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await LiquidityPoolEngine.removeLiquidity(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/liquidity-pool/quote', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await LiquidityPoolEngine.quote(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/liquidity-pool/swap', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await LiquidityPoolEngine.swap(req.body) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Account Abstraction (gas sponsorship for operator / trustee smart accounts)
// ═════════════════════════════════════════════════════════════════════════════

router.get('/account-abstraction', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await AccountAbstractionEngine.readiness() }); } catch (err) { sendError(res, err); }
});

router.get('/account-abstraction/balance', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await AccountAbstractionEngine.getPaymasterBalance() }); } catch (err) { sendError(res, err); }
});

router.post('/account-abstraction/deploy-paymaster', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await AccountAbstractionEngine.deployPaymaster({ force: req.body?.force }) }); } catch (err) { sendError(res, err); }
});

router.post('/account-abstraction/seed-paymaster', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await AccountAbstractionEngine.seedPaymaster(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/account-abstraction/fund-paymaster', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await AccountAbstractionEngine.fundPaymaster(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/account-abstraction/whitelist', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await AccountAbstractionEngine.whitelistSender(req.body.address, req.body.allowed !== false) }); } catch (err) { sendError(res, err); }
});

router.get('/account-abstraction/smart-account/:owner', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: { smartAccountAddress: await AccountAbstractionEngine.getSmartAccountAddress(req.params.owner, req.query.index ? BigInt(req.query.index) : 0n) } }); } catch (err) { sendError(res, err); }
});

router.post('/account-abstraction/prepare-transfer', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await AccountAbstractionEngine.prepareGaslessTransfer(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/account-abstraction/submit-transfer', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await AccountAbstractionEngine.submitGaslessTransfer(req.body) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// FinOps Coordination Engine (AI agent stability & operation queue)
// ═════════════════════════════════════════════════════════════════════════════

router.get('/coordination/health', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await FinOpsCoordinationEngine.systemHealth() }); } catch (err) { sendError(res, err); }
});

router.get('/coordination/queue', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await FinOpsCoordinationEngine.listQueue(req.query) }); } catch (err) { sendError(res, err); }
});

router.post('/coordination/command', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await FinOpsCoordinationEngine.runCommand({ ...req.body, userId: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/coordination/jobs/:id/run', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await FinOpsCoordinationEngine.processJob(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/coordination/retry-failed', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await FinOpsCoordinationEngine.retryFailed() }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Hyperledger Besu Clearing & Redemption Gateway
// ═════════════════════════════════════════════════════════════════════════════

router.get('/besu/status', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await HyperledgerBesuEngine.status() }); } catch (err) { sendError(res, err); }
});

router.post('/besu/deploy-clearing', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await HyperledgerBesuEngine.deployClearingContract() }); } catch (err) { sendError(res, err); }
});

router.get('/clearing', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await ClearingEngine.list(req.query) }); } catch (err) { sendError(res, err); }
});

router.get('/clearing/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await ClearingEngine.get(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/clearing', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await ClearingEngine.submit(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/clearing/:id/approve', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await ClearingEngine.approve(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/clearing/:id/settle', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await ClearingEngine.settle(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.delete('/clearing/:id', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await ClearingEngine.cancel(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.get('/clearing/net-positions', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await ClearingEngine.netPositions() }); } catch (err) { sendError(res, err); }
});

router.get('/redemption-gateway', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await RedemptionGatewayEngine.list(req.query) }); } catch (err) { sendError(res, err); }
});

router.get('/redemption-gateway/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await RedemptionGatewayEngine.get(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/redemption-gateway', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await RedemptionGatewayEngine.create(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/redemption-gateway/:id/execute', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await RedemptionGatewayEngine.execute(req.params.id) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Cross-Chain Conversion & Interoperability Engine
// ═════════════════════════════════════════════════════════════════════════════

router.get('/cross-chain', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CrossChainConversionEngine.listRequests(req.query) }); } catch (err) { sendError(res, err); }
});

router.get('/cross-chain/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CrossChainConversionEngine.getRequest(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/cross-chain/quote', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CrossChainConversionEngine.quote(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/cross-chain/requests', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await CrossChainConversionEngine.propose({ ...req.body, createdBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/cross-chain/requests/:id/approve', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CrossChainConversionEngine.approve({ proposalId: req.params.id, ...req.body }) }); } catch (err) { sendError(res, err); }
});

router.post('/cross-chain/requests/:id/execute', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CrossChainConversionEngine.executeRequest(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.get('/cross-chain/adapters/chains', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: CrossChainConversionEngine.listChains() }); } catch (err) { sendError(res, err); }
});

router.get('/cross-chain/adapters/assets', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: CrossChainConversionEngine.listAssets() }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Paired Asset Engine (source real canonical assets to seed DEX pools)
// ═════════════════════════════════════════════════════════════════════════════

router.get('/paired-assets', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await PairedAssetEngine.listRequests(req.query) }); } catch (err) { sendError(res, err); }
});

router.get('/paired-assets/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await PairedAssetEngine.getRequest(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.get('/paired-assets/sources/list', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await PairedAssetEngine.listSources() }); } catch (err) { sendError(res, err); }
});

router.post('/paired-assets/quote', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await PairedAssetEngine.quote(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/paired-assets/requests', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await PairedAssetEngine.propose({ ...req.body, createdBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/paired-assets/requests/:id/approve', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await PairedAssetEngine.approve({ proposalId: req.params.id, ...req.body }) }); } catch (err) { sendError(res, err); }
});

router.post('/paired-assets/requests/:id/execute', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await PairedAssetEngine.executeRequest(req.params.id) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Trust Market Maker Engine (reserve-backed tokens <-> canonical stablecoins)
// ═════════════════════════════════════════════════════════════════════════════

router.get('/trust-market/quote', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TrustMarketEngine.quote(req.query) }); } catch (err) { sendError(res, err); }
});

router.post('/trust-market/quote', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TrustMarketEngine.quote(req.body) }); } catch (err) { sendError(res, err); }
});

router.get('/trust-market/orders', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TrustMarketEngine.listOffers(req.query) }); } catch (err) { sendError(res, err); }
});

router.post('/trust-market/orders', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await TrustMarketEngine.createOffer({ ...req.body }) }); } catch (err) { sendError(res, err); }
});

router.post('/trust-market/orders/:id/cancel', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await TrustMarketEngine.cancelOffer({ orderId: req.params.id }) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// On/Off Ramp Engine (fiat <-> crypto and counterparty rails)
// ═════════════════════════════════════════════════════════════════════════════

router.get('/ramps/providers', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await OnOffRampEngine.providers() }); } catch (err) { sendError(res, err); }
});

router.post('/ramps/quote', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await OnOffRampEngine.quote(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/ramps/requests', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await OnOffRampEngine.propose({ ...req.body, createdBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.get('/ramps/requests/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CanonicalConsensusEngine.getProposal(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.get('/ramps/requests', operatorAuth, async (req, res) => {
  try {
    const rows = await CanonicalConsensusEngine.listProposals({ category: 'ramp', limit: req.query.limit, offset: req.query.offset });
    res.json({ success: true, data: rows });
  } catch (err) { sendError(res, err); }
});

router.post('/ramps/requests/:id/approve', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CanonicalConsensusEngine.approveProposal({ proposalId: req.params.id, ...req.body }) }); } catch (err) { sendError(res, err); }
});

router.post('/ramps/requests/:id/execute', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CanonicalConsensusEngine.executeProposal(req.params.id) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Intent Routing Engine (natural-language orchestration of on/off ramp flows)
// ═════════════════════════════════════════════════════════════════════════════

router.get('/intents', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await IntentRoutingEngine.listRequests(req.query) }); } catch (err) { sendError(res, err); }
});

router.get('/intents/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await IntentRoutingEngine.getRequest(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/intents/quote', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await IntentRoutingEngine.quote(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/intents/requests', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await IntentRoutingEngine.propose({ ...req.body, createdBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/intents/requests/:id/approve', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CanonicalConsensusEngine.approveProposal({ proposalId: req.params.id, ...req.body }) }); } catch (err) { sendError(res, err); }
});

router.post('/intents/requests/:id/execute', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CanonicalConsensusEngine.executeProposal(req.params.id) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// External Wallet Integration (hardware/MetaMask/GridPlus ledger source + swaps)
// ═════════════════════════════════════════════════════════════════════════════

router.get('/external-wallets', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await ExternalWalletEngine.list(req.query) }); } catch (err) { sendError(res, err); }
});

router.post('/external-wallets', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await ExternalWalletEngine.register({ ...req.body, createdBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.get('/external-wallets/:id/balances', operatorAuth, async (req, res) => {
  try {
    const wallet = await ExternalWalletEngine.getWallet(req.params.id);
    const data = await ExternalWalletEngine.balances(wallet.address);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/external-wallets/:id/quote', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await ExternalWalletEngine.quote({ walletId: req.params.id, ...req.body }) }); } catch (err) { sendError(res, err); }
});

router.post('/external-wallets/swaps', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await ExternalWalletEngine.propose({ ...req.body, createdBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.get('/external-wallets/swaps', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await ExternalWalletEngine.listSwaps(req.query) }); } catch (err) { sendError(res, err); }
});

router.post('/external-wallets/swaps/:id/approve', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CanonicalConsensusEngine.approveProposal({ proposalId: req.params.id, ...req.body }) }); } catch (err) { sendError(res, err); }
});

router.post('/external-wallets/swaps/:id/execute', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CanonicalConsensusEngine.executeProposal(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/external-wallets/swaps/:id/submit', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await ExternalWalletEngine.submitTx({ requestId: req.params.id, ...req.body }) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Journal Entries — principal and coupon interest income credits
// ═════════════════════════════════════════════════════════════════════════════

router.get('/journal-entries/accounts', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await JournalEntryEngine.listAccounts() }); } catch (err) { sendError(res, err); }
});

router.get('/journal-entries', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await JournalEntryEngine.listEntries({ bondId: req.query.bondId, limit: req.query.limit ? Number(req.query.limit) : 50 }) }); } catch (err) { sendError(res, err); }
});

router.post('/journal-entries/principal-interest', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await JournalEntryEngine.postPrincipalAndInterest({ ...req.body, postedBy: getUserEmail(req) || 'operator' });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// DlbCanonicalSwap — audited-style P2P swap into canonical stablecoins
// ═════════════════════════════════════════════════════════════════════════════

router.get('/canonical-swap/readiness', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: DlbCanonicalSwapEngine.readiness() }); } catch (err) { sendError(res, err); }
});

router.post('/canonical-swap/deploy', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await DlbCanonicalSwapEngine.deploy({ ...req.body }) }); } catch (err) { sendError(res, err); }
});

router.post('/canonical-swap/quote', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await DlbCanonicalSwapEngine.quote(req.body) }); } catch (err) { sendError(res, err); }
});

router.get('/canonical-swap/orders', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await DlbCanonicalSwapEngine.listOrders(req.query) }); } catch (err) { sendError(res, err); }
});

router.get('/canonical-swap/orders/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await DlbCanonicalSwapEngine.getOrder({ orderId: req.params.id }) }); } catch (err) { sendError(res, err); }
});

router.post('/canonical-swap/orders', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await DlbCanonicalSwapEngine.createOrder(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/canonical-swap/orders/:id/fill', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await DlbCanonicalSwapEngine.fillOrder({ orderId: req.params.id }) }); } catch (err) { sendError(res, err); }
});

router.post('/canonical-swap/orders/:id/cancel', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await DlbCanonicalSwapEngine.cancelOrder({ orderId: req.params.id }) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Trust Computing Engine — off-chain valuation, yield, accrual and quote jobs
// ═════════════════════════════════════════════════════════════════════════════

router.get('/computing/functions', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: TrustComputingEngine.listFunctions() }); } catch (err) { sendError(res, err); }
});

router.get('/computing/jobs', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TrustComputingEngine.listJobs(req.query) }); } catch (err) { sendError(res, err); }
});

router.get('/computing/jobs/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TrustComputingEngine.getJob(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/computing/jobs', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await TrustComputingEngine.compute({ ...req.body, createdBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Holding Management Engine — hold ledger funds and canonize to stablecoins
// ═════════════════════════════════════════════════════════════════════════════

router.get('/holdings/accounts', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await HoldingManagementEngine.listSourceAccounts() }); } catch (err) { sendError(res, err); }
});

router.get('/holdings', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: HoldingManagementEngine.listHoldings(req.query) }); } catch (err) { sendError(res, err); }
});

router.get('/holdings/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await HoldingManagementEngine.getHoldingDetail(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/holdings', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await HoldingManagementEngine.createHolding({ ...req.body, createdBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/holdings/:id/canonize', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await HoldingManagementEngine.canonizeHolding({ holdingId: req.params.id, createdBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/holdings/:id/cancel', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await HoldingManagementEngine.cancelHolding({ holdingId: req.params.id, createdBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/holdings/:id/sync', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await HoldingManagementEngine.syncHoldingStatus(req.params.id) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Capital Fund Engine — fiat-to-stablecoin conversion and pool allocation
// ═════════════════════════════════════════════════════════════════════════════

router.get('/capital-fund/accounts', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CapitalFundEngine.listSourceAccounts() }); } catch (err) { sendError(res, err); }
});

router.get('/capital-fund', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: CapitalFundEngine.listFunds(req.query) }); } catch (err) { sendError(res, err); }
});

router.get('/capital-fund/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CapitalFundEngine.getFundDetail(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/capital-fund', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await CapitalFundEngine.createFund({ ...req.body, createdBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/capital-fund/:id/approve', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CapitalFundEngine.approveFund({ fundId: req.params.id, ...req.body }) }); } catch (err) { sendError(res, err); }
});

router.post('/capital-fund/:id/execute', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await CapitalFundEngine.executeFund(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/capital-fund/:id/sync', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CapitalFundEngine.syncFund(req.params.id) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Virtual Account Engine — ledger-backed virtual accounts for fiat+on-chain
// ═════════════════════════════════════════════════════════════════════════════

router.get('/virtual-accounts/accounts', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await VirtualAccountEngine.listSourceAccounts() }); } catch (err) { sendError(res, err); }
});

router.get('/virtual-accounts', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await Promise.all(VirtualAccountEngine.listAccounts(req.query).map(a => VirtualAccountEngine.getAccountWithBalance(a.id))) }); } catch (err) { sendError(res, err); }
});

router.get('/virtual-accounts/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await VirtualAccountEngine.getAccountWithBalance(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.get('/virtual-accounts/:id/transactions', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: VirtualAccountEngine.listTransactions({ virtualAccountId: req.params.id, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.post('/virtual-accounts', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await VirtualAccountEngine.createAccount({ ...req.body, createdBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/virtual-accounts/:id/fund', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await VirtualAccountEngine.fundAccount({ virtualAccountId: req.params.id, ...req.body, createdBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/virtual-accounts/transfer', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await VirtualAccountEngine.transfer({ ...req.body, createdBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/virtual-accounts/:id/payout', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await VirtualAccountEngine.payout({ virtualAccountId: req.params.id, ...req.body, createdBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/virtual-accounts/:id/reconcile', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await VirtualAccountEngine.reconcileDeposit({ ...req.body, createdBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Wire Origination Engine — fiat payout origination API
// ═════════════════════════════════════════════════════════════════════════════

router.get('/wire-origination/adapters', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await WireOriginationEngine.readiness() }); } catch (err) { sendError(res, err); }
});

router.get('/wire-origination/accounts', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CashEngine.listAccounts() }); } catch (err) { sendError(res, err); }
});

router.get('/wire-origination', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await WireOriginationEngine.listPayouts(req.query) }); } catch (err) { sendError(res, err); }
});

router.get('/wire-origination/:id', operatorAuth, async (req, res) => {
  try {
    const data = await WireOriginationEngine.getPayout(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Payout not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/wire-origination/:id/message', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await WireOriginationEngine.getMessage(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/wire-origination', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await WireOriginationEngine.createPayout({ ...req.body, initiatedBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/wire-origination/:id/approve', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await WireOriginationEngine.approvePayout(req.params.id, getUserEmail(req)) }); } catch (err) { sendError(res, err); }
});

router.post('/wire-origination/:id/cancel', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await WireOriginationEngine.cancelPayout(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/wire-origination/:id/send', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await WireOriginationEngine.sendPayout(req.params.id) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Electronic Money Engine — stored-value fiat ledger for P2P transfers
// ═════════════════════════════════════════════════════════════════════════════

router.get('/electronic-money/summary', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await ElectronicMoneyEngine.getSummary() }); } catch (err) { sendError(res, err); }
});

router.get('/electronic-money/accounts', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await ElectronicMoneyEngine.listAccounts(req.query) }); } catch (err) { sendError(res, err); }
});

router.get('/electronic-money/accounts/:id', operatorAuth, async (req, res) => {
  try {
    const data = await ElectronicMoneyEngine.getAccount(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Account not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/electronic-money/accounts/:id/transactions', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await ElectronicMoneyEngine.listTransactions({ accountId: req.params.id, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.post('/electronic-money/accounts', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await ElectronicMoneyEngine.createAccount({ ...req.body, createdBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/electronic-money/issue', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await ElectronicMoneyEngine.issue({ ...req.body, createdBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/electronic-money/transfer', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await ElectronicMoneyEngine.transfer({ ...req.body, createdBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/electronic-money/redeem', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await ElectronicMoneyEngine.redeem({ ...req.body, createdBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/electronic-money/payout', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await ElectronicMoneyEngine.payout({ ...req.body, createdBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Open Banking Engine — ISO 20022 + bank connectors for direct payouts
// ═════════════════════════════════════════════════════════════════════════════

router.get('/open-banking/connectors', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await OpenBankingEngine.getConnectors() }); } catch (err) { sendError(res, err); }
});

router.get('/open-banking/payments', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await OpenBankingEngine.listPayments(req.query) }); } catch (err) { sendError(res, err); }
});

router.get('/open-banking/payments/:id', operatorAuth, async (req, res) => {
  try {
    const data = await OpenBankingEngine.getPayment(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Payment not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/open-banking/payments/:id/iso20022', operatorAuth, async (req, res) => {
  try {
    const data = await OpenBankingEngine.getPayment(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Payment not found' });
    res.set('Content-Type', 'application/xml');
    res.send(data.iso20022_message || '<error>No message</error>');
  } catch (err) { sendError(res, err); }
});

router.post('/open-banking/payments', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await OpenBankingEngine.createPayment(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/open-banking/payments/:id/cancel', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await OpenBankingEngine.cancelPayment(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/open-banking/verify-account', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await OpenBankingEngine.verifyAccount(req.body) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Trust Deposit Engine — script deposits to bank accounts, e-money, or wallets
// ═════════════════════════════════════════════════════════════════════════════

router.get('/trust-deposits', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TrustDepositEngine.listDeposits(req.query) }); } catch (err) { sendError(res, err); }
});

router.get('/trust-deposits/:id', operatorAuth, async (req, res) => {
  try {
    const data = await TrustDepositEngine.getDeposit(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Deposit not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/trust-deposits/:id/message', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TrustDepositEngine.getMessage(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/trust-deposits', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await TrustDepositEngine.createDeposit({ ...req.body, initiatedBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/trust-deposits/:id/send', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await TrustDepositEngine.sendDeposit(req.params.id, req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/trust-deposits/:id/cancel', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await TrustDepositEngine.cancelDeposit(req.params.id) }); } catch (err) { sendError(res, err); }
});

// ─── Skrill.me/rq Payment Links ─────────────────────────────────────────────

router.get('/skrill-links', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await SkrillLinkEngine.listPayments(req.query) }); } catch (err) { sendError(res, err); }
});

router.get('/skrill-links/:id', operatorAuth, async (req, res) => {
  try {
    const data = await SkrillLinkEngine.getPayment(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Skrill payment not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/skrill-links', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await SkrillLinkEngine.createPayment({ ...req.body, initiatedBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/skrill-links/:id/pay', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await SkrillLinkEngine.pay(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/skrill-links/:id/mark-paid', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await SkrillLinkEngine.markPaidManually(req.params.id, req.body || {}) }); } catch (err) { sendError(res, err); }
});

router.post('/skrill-links/:id/cancel', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await SkrillLinkEngine.cancel(req.params.id) }); } catch (err) { sendError(res, err); }
});

// ─── Barcode Deposit Engine ───────────────────────────────────────────────────

router.get('/barcode-deposits', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await BarcodeDepositEngine.listDeposits(req.query) }); } catch (err) { sendError(res, err); }
});

router.get('/barcode-deposits/:id', operatorAuth, async (req, res) => {
  try {
    const data = await BarcodeDepositEngine.getDeposit(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Barcode deposit not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/barcode-deposits', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await BarcodeDepositEngine.scan({ ...req.body, initiatedBy: getUserEmail(req) }) }); }
  catch (err) { sendError(res, err); }
});

router.post('/barcode-deposits/:id/approve', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await BarcodeDepositEngine.approveDeposit(req.params.id, { ...req.body, initiatedBy: getUserEmail(req) }) }); }
  catch (err) { sendError(res, err); }
});

router.post('/barcode-deposits/:id/cancel', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await BarcodeDepositEngine.cancelDeposit(req.params.id) }); } catch (err) { sendError(res, err); }
});

// ─── Web HTTPS Payment Rail Engine ───────────────────────────────────────────────

router.get('/web-payment-rails/configs', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await WebPaymentRailEngine.listConfigs() }); } catch (err) { sendError(res, err); }
});

router.get('/web-payment-rails', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await WebPaymentRailEngine.listPayments(req.query) }); } catch (err) { sendError(res, err); }
});

router.get('/web-payment-rails/:id', operatorAuth, async (req, res) => {
  try {
    const data = await WebPaymentRailEngine.getPayment(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Web payment not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/web-payment-rails', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await WebPaymentRailEngine.createPayment({ ...req.body, initiatedBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/web-payment-rails/:id/send', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await WebPaymentRailEngine.sendPayment(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/web-payment-rails/:id/cancel', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await WebPaymentRailEngine.cancelPayment(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/web-payment-rails/webhook/:id', async (req, res) => {
  try { res.json({ success: true, data: await WebPaymentRailEngine.processWebhook({ paymentId: req.params.id, raw: req.body, ...req.body }) }); }
  catch (err) { sendError(res, err); }
});

// ─── Lili Bank Engine ───────────────────────────────────────────────────────

router.get('/lili/config', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await LiliBankEngine.getConfig() }); } catch (err) { sendError(res, err); }
});

router.get('/lili/payments', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await LiliBankEngine.listPayments(req.query) }); } catch (err) { sendError(res, err); }
});

router.get('/lili/payments/:id', operatorAuth, async (req, res) => {
  try {
    const data = await LiliBankEngine.getPayment(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Lili payment not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/lili/payments', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await LiliBankEngine.createPayment({ ...req.body, initiatedBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/lili/payments/:id/mark-paid', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await LiliBankEngine.markPaid(req.params.id, req.body.externalTxId, { initiatedBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/lili/payments/:id/cancel', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await LiliBankEngine.cancelPayment(req.params.id) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Compliance Engine — KYC, AML, and sanctions screening
// ═════════════════════════════════════════════════════════════════════════════

router.get('/compliance/screenings', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await ComplianceEngine.list(req.query) }); } catch (err) { sendError(res, err); }
});

router.get('/compliance/screenings/:id', operatorAuth, async (req, res) => {
  try {
    const data = await ComplianceEngine.getScreening(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Screening not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/compliance/screenings', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await ComplianceEngine.screen({ ...req.body, screenedBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/compliance/screenings/:id/approve', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await ComplianceEngine.approve(req.params.id, { ...req.body, reviewedBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/compliance/screenings/:id/block', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await ComplianceEngine.block(req.params.id, { ...req.body, reviewedBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Lili MCP Engine — machine-to-machine tool calls and Bill Pay
// ═════════════════════════════════════════════════════════════════════════════

router.get('/lili/mcp/status', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await LiliMcpEngine.getPublicConfig() }); } catch (err) { sendError(res, err); }
});

router.post('/lili/mcp/initialize', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await LiliMcpEngine.initialize() }); } catch (err) { sendError(res, err); }
});

router.post('/lili/mcp/tools', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await LiliMcpEngine.listTools() }); } catch (err) { sendError(res, err); }
});

router.post('/lili/mcp/tool', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { tool, args = {}, businessUserId } = req.body;
    if (businessUserId) args.businessUserId = businessUserId;
    const data = await LiliMcpEngine.callTool(tool, args);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/lili/mcp/pay', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await LiliMcpEngine.payToPayee({ ...req.body }) }); } catch (err) { sendError(res, err); }
});

router.post('/lili/mcp/oauth/start', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await LiliMcpEngine.startOAuth({ ...req.body });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/lili/mcp/oauth/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    if (error) throw new Error(`OAuth error: ${error} ${error_description || ''}`);
    if (!code || !state) throw new Error('Missing code or state');
    const data = await LiliMcpEngine.handleCallback(code, state);
    res.json({ success: true, data });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── Issuer Engine (trust custodian/issuer) ─────────────────────────────────

router.get('/issuer/assets', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await IssuerEngine.listAssets() }); } catch (err) { sendError(res, err); }
});

router.post('/issuer/assets', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await IssuerEngine.createAsset(req.body) }); } catch (err) { sendError(res, err); }
});

router.get('/issuer/assets/:code/balances', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await IssuerEngine.listBalances(req.params.code) }); } catch (err) { sendError(res, err); }
});

router.post('/issuer/issue', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await IssuerEngine.issue(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/issuer/redeem', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await IssuerEngine.redeem(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/issuer/transfer', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await IssuerEngine.transfer(req.body) }); } catch (err) { sendError(res, err); }
});

router.get('/issuer/operations', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await IssuerEngine.listOperations({ assetCode: req.query.assetCode, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

// ─── Bank Transfer Engine (push/receive bank credits) ─────────────────────────

router.get('/bank-accounts', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await BankTransferEngine.listBankAccounts() }); } catch (err) { sendError(res, err); }
});

router.post('/bank-accounts', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await BankTransferEngine.createBankAccount(req.body) }); } catch (err) { sendError(res, err); }
});

router.get('/bank-transfers', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await BankTransferEngine.listBankTransfers({ direction: req.query.direction, status: req.query.status, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.post('/bank-transfers/push-credit', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await BankTransferEngine.pushCredit(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/bank-transfers/:id/send', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await BankTransferEngine.sendPushCredit(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/bank-transfers/receive-credit', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await BankTransferEngine.receiveCredit(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/bank-transfers/:id/cancel', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await BankTransferEngine.cancelPushCredit(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.get('/bank-transfers/lili/reconcile', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await BankTransferEngine.reconcileWithLili(req.query.bankAccountId) }); } catch (err) { sendError(res, err); }
});

// ─── Vendor Payments (direct fiat, excluding Lili) ──────────────────────────

router.post('/vendors', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await VendorPaymentEngine.createVendor(req.body) }); } catch (err) { sendError(res, err); }
});

router.get('/vendors', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await VendorPaymentEngine.listVendors({ status: req.query.status, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.get('/vendors/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await VendorPaymentEngine.getVendor(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/vendors/:id/bills', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await VendorPaymentEngine.createBill({ vendorId: req.params.id, ...req.body }) }); } catch (err) { sendError(res, err); }
});

router.get('/vendors/:id/bills', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await VendorPaymentEngine.listBills({ vendorId: req.params.id, status: req.query.status, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.post('/vendor-bills/:id/pay', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await VendorPaymentEngine.payBill({ billId: req.params.id, ...req.body, initiatedBy: getUserEmail(req) }) }); } catch (err) { sendError(res, err); }
});

router.get('/vendor-payments', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await VendorPaymentEngine.listPaymentRuns({ billId: req.query.billId, vendorId: req.query.vendorId, status: req.query.status, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Trust Bank API Engine — internal bank accounts and external payments
// ═════════════════════════════════════════════════════════════════════════════

router.post('/trust-bank/customers', operatorAuth, async (req, res) => {
  try { res.status(201).json({ success: true, data: await TrustBankEngine.createCustomer(req.body) }); } catch (err) { sendError(res, err); }
});

router.get('/trust-bank/customers', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TrustBankEngine.listCustomers({ limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.post('/trust-bank/customers/:id/accounts', operatorAuth, async (req, res) => {
  try { res.status(201).json({ success: true, data: await TrustBankEngine.createAccount({ customerId: req.params.id, ...req.body }) }); } catch (err) { sendError(res, err); }
});

router.get('/trust-bank/accounts', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TrustBankEngine.listAccounts({ customerId: req.query.customerId, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.post('/trust-bank/accounts/:id/deposit', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TrustBankEngine.deposit({ accountId: req.params.id, ...req.body }) }); } catch (err) { sendError(res, err); }
});

router.post('/trust-bank/accounts/:id/payments', operatorAuth, async (req, res) => {
  try { res.status(201).json({ success: true, data: await TrustBankEngine.originatePayment({ fromAccountId: req.params.id, ...req.body }) }); } catch (err) { sendError(res, err); }
});

router.post('/trust-bank/payments/:id/send', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TrustBankEngine.sendPayment(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/trust-bank/payments/:id/settle', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TrustBankEngine.settlePayment(req.params.id, req.body.externalTxId) }); } catch (err) { sendError(res, err); }
});

router.get('/trust-bank/payments', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TrustBankEngine.listPayments({ status: req.query.status, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.get('/trust-bank/accounts/:id/transactions', operatorAuth, async (req, res) => {
  // Simple transaction list by account
  try {
    const result = await require('../integrations/dapp/trustBankEngine').TrustBankEngine.getAccount(req.params.id);
    if (!result) return res.status(404).json({ success: false, error: 'Account not found' });
    const tx = await (await require('../bonds/pgPool').query('SELECT * FROM trust_bank_transactions WHERE account_id = $1 ORDER BY created_at DESC LIMIT 100', [req.params.id])).rows;
    res.json({ success: true, data: { account: result, transactions: tx } });
  } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Open Finance — Wealth Management Engine
// ═════════════════════════════════════════════════════════════════════════════

router.post('/wealth/portfolios', operatorAuth, async (req, res) => {
  try { res.status(201).json({ success: true, data: await WealthManagementEngine.createPortfolio(req.body) }); } catch (err) { sendError(res, err); }
});

router.get('/wealth/portfolios', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await WealthManagementEngine.listPortfolios({ ownerId: req.query.ownerId, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.get('/wealth/portfolios/:id', operatorAuth, async (req, res) => {
  try { const data = await WealthManagementEngine.getPortfolio(req.params.id); if (!data) return res.status(404).json({ success: false, error: 'Not found' }); res.json({ success: true, data }); } catch (err) { sendError(res, err); }
});

router.post('/wealth/portfolios/:id/holdings', operatorAuth, async (req, res) => {
  try { res.status(201).json({ success: true, data: await WealthManagementEngine.addHolding({ portfolioId: req.params.id, ...req.body }) }); } catch (err) { sendError(res, err); }
});

router.get('/wealth/portfolios/:id/allocation', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await WealthManagementEngine.computeAllocation(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/wealth/portfolios/:id/rebalances', operatorAuth, async (req, res) => {
  try { res.status(201).json({ success: true, data: await WealthManagementEngine.generateRebalance(req.params.id, req.body.driftThreshold || 5) }); } catch (err) { sendError(res, err); }
});

router.post('/wealth/rebalances/:id/approve', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await WealthManagementEngine.approveRebalance(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/wealth/rebalances/:id/execute', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await WealthManagementEngine.executeRebalance(req.params.id, req.user?.email || req.body.executedBy || 'operator') }); } catch (err) { sendError(res, err); }
});

router.post('/wealth/portfolios/:id/goals', operatorAuth, async (req, res) => {
  try { res.status(201).json({ success: true, data: await WealthManagementEngine.createGoal({ portfolioId: req.params.id, ...req.body }) }); } catch (err) { sendError(res, err); }
});

router.get('/wealth/goals/:id/track', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await WealthManagementEngine.trackGoal(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/wealth/portfolios/:id/aggregate', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await WealthManagementEngine.aggregateFromTrust(req.params.id, req.body.ownerIdentifier) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Open Finance — Trust Aggregator Engine
// ═════════════════════════════════════════════════════════════════════════════

router.post('/aggregator/connections', operatorAuth, async (req, res) => {
  try { res.status(201).json({ success: true, data: await TrustAggregatorEngine.addConnection(req.body) }); } catch (err) { sendError(res, err); }
});

router.get('/aggregator/connections', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TrustAggregatorEngine.listConnections({ sourceType: req.query.sourceType, status: req.query.status, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.post('/aggregator/connections/:id/sync', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TrustAggregatorEngine.sync(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/aggregator/sync-all', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TrustAggregatorEngine.syncAll() }); } catch (err) { sendError(res, err); }
});

router.get('/aggregator/balances', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TrustAggregatorEngine.aggregateBalances() }); } catch (err) { sendError(res, err); }
});

router.get('/aggregator/net-worth', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TrustAggregatorEngine.getNetWorth() }); } catch (err) { sendError(res, err); }
});

router.get('/aggregator/transactions', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TrustAggregatorEngine.listTransactions({ connectionId: req.query.connectionId, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.post('/aggregator/auto-connect', operatorAuth, async (req, res) => {
  try { res.status(201).json({ success: true, data: await TrustAggregatorEngine.autoConnectInternalSources() }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// External Endpoint Engine
// ═════════════════════════════════════════════════════════════════════════════

router.post('/external-endpoints', operatorAuth, async (req, res) => {
  try { res.status(201).json({ success: true, data: await ExternalEndpointEngine.createEndpoint(req.body) }); } catch (err) { sendError(res, err); }
});

router.get('/external-endpoints', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await ExternalEndpointEngine.listEndpoints({ enabled: req.query.enabled }) }); } catch (err) { sendError(res, err); }
});

router.get('/external-endpoints/:id', operatorAuth, async (req, res) => {
  try {
    const data = await ExternalEndpointEngine.getEndpoint(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.patch('/external-endpoints/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await ExternalEndpointEngine.updateEndpoint(req.params.id, req.body) }); } catch (err) { sendError(res, err); }
});

router.delete('/external-endpoints/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await ExternalEndpointEngine.deleteEndpoint(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/external-endpoints/:id/test', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await ExternalEndpointEngine.testConnection(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/external-endpoints/:id/payments', operatorAuth, async (req, res) => {
  try { res.status(201).json({ success: true, data: await ExternalEndpointEngine.executePayment({ endpointId: req.params.id, ...req.body }) }); } catch (err) { sendError(res, err); }
});

router.get('/external-endpoints/:id/payments', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await ExternalEndpointEngine.listPayments({ endpointId: req.params.id, status: req.query.status, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.get('/external-payments', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await ExternalEndpointEngine.listPayments({ status: req.query.status, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.get('/external-payments/:id', operatorAuth, async (req, res) => {
  try {
    const data = await ExternalEndpointEngine.getPayment(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/external-payments/:id/send', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await ExternalEndpointEngine.sendPayment(req.params.id) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Live FinTech Endpoint Engine
// ═════════════════════════════════════════════════════════════════════════════

router.get('/live-fintech/providers', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: LiveFinTechEndpointEngine.providers }); } catch (err) { sendError(res, err); }
});

router.post('/live-fintech-endpoints', operatorAuth, async (req, res) => {
  try { res.status(201).json({ success: true, data: await LiveFinTechEndpointEngine.createEndpoint(req.body) }); } catch (err) { sendError(res, err); }
});

router.get('/live-fintech-endpoints', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await LiveFinTechEndpointEngine.listEndpoints({ enabled: req.query.enabled, provider: req.query.provider }) }); } catch (err) { sendError(res, err); }
});

router.get('/live-fintech-endpoints/:id', operatorAuth, async (req, res) => {
  try {
    const data = await LiveFinTechEndpointEngine.getEndpoint(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.patch('/live-fintech-endpoints/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await LiveFinTechEndpointEngine.updateEndpoint(req.params.id, req.body) }); } catch (err) { sendError(res, err); }
});

router.delete('/live-fintech-endpoints/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await LiveFinTechEndpointEngine.deleteEndpoint(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/live-fintech-endpoints/:id/test', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await LiveFinTechEndpointEngine.testConnection(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/live-fintech-endpoints/:id/payments', operatorAuth, async (req, res) => {
  try { res.status(201).json({ success: true, data: await LiveFinTechEndpointEngine.executePayment({ endpointId: req.params.id, ...req.body }) }); } catch (err) { sendError(res, err); }
});

router.get('/live-fintech-endpoints/:id/payments', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await LiveFinTechEndpointEngine.listPayments({ endpointId: req.params.id, status: req.query.status, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.get('/live-fintech-payments', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await LiveFinTechEndpointEngine.listPayments({ status: req.query.status, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.get('/live-fintech-payments/:id', operatorAuth, async (req, res) => {
  try {
    const data = await LiveFinTechEndpointEngine.getPayment(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/live-fintech-payments/:id/send', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await LiveFinTechEndpointEngine.sendPayment(req.params.id) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Corporate Treasury Management System Engine
// ═════════════════════════════════════════════════════════════════════════════

router.get('/corporate-treasury', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CorporateTreasuryEngine.getDashboard() }); } catch (err) { sendError(res, err); }
});

router.post('/corporate-treasury/setup-ptc', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CorporateTreasuryEngine.setupPTCDefaultAccounts(req.body) }); } catch (err) { sendError(res, err); }
});

router.get('/corporate-treasury/ptc-report', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CorporateTreasuryEngine.getPTCReport(req.query) }); } catch (err) { sendError(res, err); }
});

router.post('/corporate-treasury/segregate-beneficiary', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CorporateTreasuryEngine.segregateBeneficiaryFunds(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/corporate-treasury/allocate-capital-call', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CorporateTreasuryEngine.allocateCapitalCall(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/corporate-treasury/sync', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CorporateTreasuryEngine.syncBalances() }); } catch (err) { sendError(res, err); }
});

router.get('/corporate-treasury/forecast', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CorporateTreasuryEngine.getLiquidityForecast({ days: Number(req.query.days) || 30 }) }); } catch (err) { sendError(res, err); }
});

router.get('/corporate-treasury/accounts', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CorporateTreasuryEngine.listAccounts(req.query) }); } catch (err) { sendError(res, err); }
});

router.post('/corporate-treasury/accounts', operatorAuth, async (req, res) => {
  try { res.status(201).json({ success: true, data: await CorporateTreasuryEngine.createAccount(req.body) }); } catch (err) { sendError(res, err); }
});

router.get('/corporate-treasury/accounts/:id', operatorAuth, async (req, res) => {
  try {
    const data = await CorporateTreasuryEngine.getAccount(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.patch('/corporate-treasury/accounts/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CorporateTreasuryEngine.updateAccount(req.params.id, req.body) }); } catch (err) { sendError(res, err); }
});

router.delete('/corporate-treasury/accounts/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CorporateTreasuryEngine.deleteAccount(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.get('/corporate-treasury/pools', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CorporateTreasuryEngine.listCashPools(req.query) }); } catch (err) { sendError(res, err); }
});

router.post('/corporate-treasury/pools', operatorAuth, async (req, res) => {
  try { res.status(201).json({ success: true, data: await CorporateTreasuryEngine.createCashPool(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/corporate-treasury/pools/:id/sweep', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CorporateTreasuryEngine.sweepCashPool(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.get('/corporate-treasury/cash-flows', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CorporateTreasuryEngine.listCashFlows(req.query) }); } catch (err) { sendError(res, err); }
});

router.post('/corporate-treasury/cash-flows', operatorAuth, async (req, res) => {
  try { res.status(201).json({ success: true, data: await CorporateTreasuryEngine.createCashFlow(req.body) }); } catch (err) { sendError(res, err); }
});

router.patch('/corporate-treasury/cash-flows/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CorporateTreasuryEngine.updateCashFlow(req.params.id, req.body) }); } catch (err) { sendError(res, err); }
});

router.delete('/corporate-treasury/cash-flows/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CorporateTreasuryEngine.deleteCashFlow(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.get('/corporate-treasury/investments', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CorporateTreasuryEngine.listInvestments(req.query) }); } catch (err) { sendError(res, err); }
});

router.post('/corporate-treasury/investments', operatorAuth, async (req, res) => {
  try { res.status(201).json({ success: true, data: await CorporateTreasuryEngine.createInvestment(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/corporate-treasury/investments/:id/redeem', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CorporateTreasuryEngine.redeemInvestment(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.get('/corporate-treasury/transactions', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CorporateTreasuryEngine.listTransactions(req.query) }); } catch (err) { sendError(res, err); }
});

router.post('/corporate-treasury/transactions', operatorAuth, async (req, res) => {
  try { res.status(201).json({ success: true, data: await CorporateTreasuryEngine.createTransaction(req.body) }); } catch (err) { sendError(res, err); }
});

router.get('/corporate-treasury/policies', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CorporateTreasuryEngine.listPolicies(req.query) }); } catch (err) { sendError(res, err); }
});

router.post('/corporate-treasury/policies', operatorAuth, async (req, res) => {
  try { res.status(201).json({ success: true, data: await CorporateTreasuryEngine.createPolicy(req.body) }); } catch (err) { sendError(res, err); }
});

router.delete('/corporate-treasury/policies/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CorporateTreasuryEngine.deletePolicy(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/corporate-treasury/evaluate', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CorporateTreasuryEngine.evaluatePayment(req.body) }); } catch (err) { sendError(res, err); }
});

router.get('/corporate-treasury/workflows', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CorporateTreasuryEngine.listWorkflows(req.query) }); } catch (err) { sendError(res, err); }
});

router.post('/corporate-treasury/workflows', operatorAuth, async (req, res) => {
  try { res.status(201).json({ success: true, data: await CorporateTreasuryEngine.createWorkflow(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/corporate-treasury/workflows/:id/approve', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CorporateTreasuryEngine.approveWorkflow(req.params.id, req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/corporate-treasury/workflows/:id/execute', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await CorporateTreasuryEngine.executeWorkflow(req.params.id) }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Settlement Engine
// ═════════════════════════════════════════════════════════════════════════════

router.get('/settlements/dashboard', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await SettlementEngine.getDashboard() }); } catch (err) { sendError(res, err); }
});

router.get('/settlements/rails', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await SettlementEngine.getRails() }); } catch (err) { sendError(res, err); }
});

router.post('/settlements', operatorAuth, async (req, res) => {
  try { res.status(201).json({ success: true, data: await SettlementEngine.createSettlement(req.body) }); } catch (err) { sendError(res, err); }
});

router.get('/settlements', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await SettlementEngine.listSettlements({ status: req.query.status, rail: req.query.rail, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.get('/settlements/:id', operatorAuth, async (req, res) => {
  try {
    const data = await SettlementEngine.getSettlement(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/settlements/:id/execute', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await SettlementEngine.executeSettlement(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/settlements/:id/cancel', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await SettlementEngine.cancelSettlement(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/settlements/:id/confirm', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await SettlementEngine.confirmSettlement(req.params.id, req.body || {}) }); } catch (err) { sendError(res, err); }
});

router.post('/settlements/poll', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await SettlementEngine.pollSettlements() }); } catch (err) { sendError(res, err); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Payment ID Engine
// ═════════════════════════════════════════════════════════════════════════════

router.get('/payment-ids', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await PaymentIdEngine.listPaymentIds({ status: req.query.status, rail: req.query.rail, sourceType: req.query.source_type, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.post('/payment-ids', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await PaymentIdEngine.createPaymentId(req.body) }); } catch (err) { sendError(res, err); }
});

router.get('/payment-ids/lookup', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await PaymentIdEngine.lookup({ childId: req.query.child_id, externalId: req.query.external_id, idempotencyKey: req.query.idempotency_key, sourceId: req.query.source_id }) }); } catch (err) { sendError(res, err); }
});

router.get('/payment-ids/:id', operatorAuth, async (req, res) => {
  try {
    const data = await PaymentIdEngine.getPaymentId(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/payment-ids/:id/events', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await PaymentIdEngine.getEvents(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/payment-ids/:id/poll', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await PaymentIdEngine.poll(req.params.id) }); } catch (err) { sendError(res, err); }
});

// Host-to-Host Engine routes
router.get('/host-to-host', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await HostToHostEngine.getDashboard() }); } catch (err) { sendError(res, err); }
});

router.post('/host-to-host/partners', operatorAuth, async (req, res) => {
  try { res.status(201).json({ success: true, data: await HostToHostEngine.createPartner(req.body) }); } catch (err) { sendError(res, err); }
});

router.get('/host-to-host/partners', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await HostToHostEngine.listPartners({ enabled: req.query.enabled }) }); } catch (err) { sendError(res, err); }
});

router.get('/host-to-host/partners/:id', operatorAuth, async (req, res) => {
  try {
    const data = await HostToHostEngine.getPartner(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/host-to-host/partners/:id/test', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await HostToHostEngine.testConnection(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.put('/host-to-host/partners/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await HostToHostEngine.updatePartner(req.params.id, req.body) }); } catch (err) { sendError(res, err); }
});

router.delete('/host-to-host/partners/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await HostToHostEngine.deletePartner(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/host-to-host/payments', operatorAuth, async (req, res) => {
  try { res.status(201).json({ success: true, data: await HostToHostEngine.sendPayment(req.body) }); } catch (err) { sendError(res, err); }
});

router.get('/host-to-host/transmissions', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await HostToHostEngine.listTransmissions({ status: req.query.status, partnerId: req.query.partner_id, direction: req.query.direction, limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.get('/host-to-host/transmissions/:id', operatorAuth, async (req, res) => {
  try {
    const data = await HostToHostEngine.getTransmission(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// Live Money Movement Engine routes
router.get('/live-money', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await LiveMoneyMovementEngine.getDashboard() }); } catch (err) { sendError(res, err); }
});

router.get('/live-money/rails', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await LiveMoneyMovementEngine.getAvailableRails() }); } catch (err) { sendError(res, err); }
});

router.post('/live-money', operatorAuth, async (req, res) => {
  try { res.status(201).json({ success: true, data: await LiveMoneyMovementEngine.initiateMovement(req.body) }); } catch (err) { sendError(res, err); }
});

router.post('/live-money/:id/execute', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await LiveMoneyMovementEngine.executeMovement(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/live-money/:id/poll', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await LiveMoneyMovementEngine.pollMovement(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.post('/live-money/:id/cancel', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await LiveMoneyMovementEngine.cancelMovement(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.get('/live-money/:id', operatorAuth, async (req, res) => {
  try {
    const data = await LiveMoneyMovementEngine.getMovement(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

module.exports = router;