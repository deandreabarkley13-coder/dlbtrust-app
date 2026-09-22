'use strict';

/**
 * OS Engine Routes — /api/os
 *
 * Provides a single, consistent interface to the operating-system engines:
 * bank, treasury, payment, clearing, settlement, compliance, security, rest-api,
 * bookkeeping, cash, asset-acquisition, bank-aggregator, funding, smart-router, back-office,
 * wallet-onramp, alchemy-wallet, issuer-bridge, conduit, tokenization, melio, ptc-bank,
 * ptc-treasury, settlement-endpoint, moov-paygate, apisix, apigee, nickel, canonical-money,
 * canonical-liquidity, canonical-consensus, canonical-funding, collateral-os,
 * live-value-runbook, and live-money.
 */

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const {
  BankEngine,
  TreasuryEngine,
  PaymentEngine,
  ClearingEngine,
  SettlementEngine,
  ComplianceEngine,
  SecurityEngine,
  RestApiEngine,
  BookkeepingEngine,
  CashOSEngine,
  AssetAcquisitionEngine,
  BankAccountAggregatorEngine,
  FundingOSEngine,
  SmartRouterEngine,
  BackOfficeEngine,
  WalletOnRampEngine,
  AlchemyWalletEngine,
  TokenizationEngine,
  ConduitEngine,
  IssuerBridgeEngine,
  MelioEngine,
  PtcBankEngine,
  PtcTreasuryEngine,
  SettlementEndpointEngine,
  MoovPaygateEngine,
  ApacheApisixEngine,
  ApigeeGatewayEngine,
  NickelMcpEngine,
  CanonicalMoneyOSEngine,
  CanonicalLiquidityOSEngine,
  CanonicalConsensusOSEngine,
  CanonicalFundingEngine,
  CollateralOSEngine,
  LiveValueRunbookOSEngine,
  LiveMoneyEngine,
  ReconciliationEngine,
  InteropEngine,
  CreditEngine,
  DebtEngine,
  LiquidityEngine,
} = require('../integrations/os/osEngine');
const { EngineWiringReadiness } = require('../integrations/os/engineWiringReadiness');

const router = express.Router();
const operatorAuth = requireAuth({ role: 'operator' });
const adminAuth = requireAuth({ role: 'admin' });
const APPROVAL_GATED_ACTIONS = {
  melio: new Set([
    'schedulePayment',
    'exportPayment',
    'exportBatch',
    'markSubmitted',
    'markPaid',
    'settle',
  ]),
  nickel: new Set(['payBill', 'submitInvoice', 'settlePayment', 'settle']),
  apisix: new Set(['sendPayment', 'sendWire', 'createPayment', 'sendPush', 'pushToCard']),
  apigee: new Set(['sendPayment', 'sendWire', 'createPayment', 'sendPush', 'pushToCard']),
};

const ENGINES = {
  bank: BankEngine,
  treasury: TreasuryEngine,
  payment: PaymentEngine,
  clearing: ClearingEngine,
  settlement: SettlementEngine,
  compliance: ComplianceEngine,
  security: SecurityEngine,
  'rest-api': RestApiEngine,
  bookkeeping: BookkeepingEngine,
  cash: CashOSEngine,
  'asset-acquisition': AssetAcquisitionEngine,
  'bank-aggregator': BankAccountAggregatorEngine,
  funding: FundingOSEngine,
  'smart-router': SmartRouterEngine,
  'back-office': BackOfficeEngine,
  'wallet-onramp': WalletOnRampEngine,
  'alchemy-wallet': AlchemyWalletEngine,
  tokenization: TokenizationEngine,
  conduit: ConduitEngine,
  'issuer-bridge': IssuerBridgeEngine,
  melio: MelioEngine,
  'ptc-bank': PtcBankEngine,
  'ptc-treasury': PtcTreasuryEngine,
  'settlement-endpoint': SettlementEndpointEngine,
  'moov-paygate': MoovPaygateEngine,
  apisix: ApacheApisixEngine,
  apigee: ApigeeGatewayEngine,
  nickel: NickelMcpEngine,
  'canonical-money': CanonicalMoneyOSEngine,
  'canonical-liquidity': CanonicalLiquidityOSEngine,
  'canonical-consensus': CanonicalConsensusOSEngine,
  'canonical-funding': CanonicalFundingEngine,
  'collateral-os': CollateralOSEngine,
  'live-value-runbook': LiveValueRunbookOSEngine,
  'live-money': LiveMoneyEngine,
  reconciliation: ReconciliationEngine,
  interop: InteropEngine,
  credit: CreditEngine,
  debt: DebtEngine,
  liquidity: LiquidityEngine,
};

function sendError(res, err) {
  const status = err.status || 400;
  res.status(status).json({ success: false, error: err.message || 'OS engine error' });
}

function getEngine(req, res, next) {
  const engine = ENGINES[req.params.engine];
  if (!engine) return res.status(404).json({ success: false, error: `Unknown OS engine: ${req.params.engine}` });
  req.osEngine = engine;
  next();
}

// ─── Engine registry and live status ──────────────────────────────────────────

router.get('/', operatorAuth, async (req, res) => {
  try {
    const statuses = await Promise.all(
      Object.entries(ENGINES).map(async ([name, Engine]) => {
        try {
          const data = await Engine.status();
          return { name, healthy: true, data };
        } catch (e) {
          return { name, healthy: false, error: e.message };
        }
      })
    );
    res.json({ success: true, data: statuses });
  } catch (err) { sendError(res, err); }
});

// ─── Consolidated GCP wiring readiness (dlb-treasury-management) ──────────────
// Five platform engines: payment, gateway, clearing, reconciliation, interop.

router.get('/readiness', operatorAuth, async (req, res) => {
  try {
    const data = await EngineWiringReadiness.readiness();
    res.status(data.ready ? 200 : 503).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/readiness/:platformEngine', operatorAuth, async (req, res) => {
  try {
    const data = await EngineWiringReadiness.engineReadiness(req.params.platformEngine);
    res.status(data.ready ? 200 : 503).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Per-engine status and health ─────────────────────────────────────────────

router.get('/:engine/readiness', operatorAuth, getEngine, async (req, res) => {
  try {
    const data = await req.osEngine.readiness();
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/:engine/status', operatorAuth, getEngine, async (req, res) => {
  try {
    const data = await req.osEngine.status();
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/:engine/health', operatorAuth, getEngine, async (req, res) => {
  try {
    const data = await req.osEngine.health();
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Recent operation log for an engine ───────────────────────────────────────

router.get('/:engine/list', operatorAuth, getEngine, async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 50;
    const data = await req.osEngine.list({ limit, status: req.query.status });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/:engine/get/:eventId', operatorAuth, getEngine, async (req, res) => {
  try {
    const data = await req.osEngine.get(req.params.eventId);
    if (!data) return res.status(404).json({ success: false, error: 'OS event not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Process an engine action ───────────────────────────────────────────────

router.post('/:engine/process', adminAuth, writeRateLimiter(), getEngine, async (req, res) => {
  try {
    const payload = req.body || {};
    if (APPROVAL_GATED_ACTIONS[req.params.engine]?.has(payload.action)) {
      return res.status(409).json({
        success: false,
        error: 'Money movement must use the authenticated maker-checker workflow (distribution requests, vendor bills, Payer OS or settlement orders)',
      });
    }
    const data = await req.osEngine.process(payload);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// Public Moov Paygate webhook endpoint (HMAC verified by the engine).
router.post('/moov-paygate/webhook', writeRateLimiter(), async (req, res) => {
  try {
    const payload = req.body || {};
    const signature = req.get('x-moov-signature') || payload.signature;
    const data = await MoovPaygateEngine.process({ ...payload, action: 'webhook', signature });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// Public Nickel webhook endpoint (HMAC verified by the engine).
router.post('/nickel/webhook', writeRateLimiter(), async (req, res) => {
  try {
    const payload = req.body || {};
    const signature = req.get('Nickel-Signature') || payload.signature;
    const data = await NickelMcpEngine.process({ ...payload, action: 'webhook', signature, headers: req.headers });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
