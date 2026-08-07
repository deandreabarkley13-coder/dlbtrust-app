'use strict';

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { FinOpsAgent } = require('../integrations/finops/finopsAgent');
const { ModuleSmartAccountEngine } = require('../integrations/dapp/moduleSmartAccountEngine');
const { ModuleP2PSwapEngine } = require('../integrations/dapp/moduleP2PSwapEngine');
const { SpritzEngine } = require('../integrations/spritz/spritzEngine');
const { PeerOnRampEngine } = require('../integrations/peer/peerOnRampEngine');
const { PtcStablecoinEngine } = require('../integrations/dapp/ptcStablecoinEngine');
const { CanonicalConsensusEngine } = require('../integrations/dapp/canonicalConsensusEngine');

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

// ═════════════════════════════════════════════════════════════════════════════
// Canonical Consensus Engine (Maker / Checker approvals)
// ═════════════════════════════════════════════════════════════════════════════

function getUserEmail(req) {
  const u = req.user || {};
  return u.email || u.username || u.userId || 'operator';
}

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

module.exports = router;
