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
 * live-value-runbook, live-money, enterprise-network, private-payment-network,
 * and fraud-compliance.
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
  FundingOsPlatformEngine,
  PaymentProcessorPlatformEngine,
  PaymentGatewayPlatformEngine,
  EnterpriseNetworkPlatformEngine,
  PrivatePaymentNetworkPlatformEngine,
} = require('../integrations/os/osEngine');
const { EngineWiringReadiness } = require('../integrations/os/engineWiringReadiness');
const { ClearingAgentNetworkEndpoint } = require('../integrations/os/clearingAgentNetworkEndpoint');

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
  // Direct processor calls never run from the OS route: money moves only through
  // the maker/checker submit → approve flow of PaymentProcessorOsEngine.
  'payment-processor': new Set(['processPayment', 'process-payment', 'sale', 'authorize', 'capture', 'refund', 'void', 'clearPayment', 'clearAndSettle', 'sendPayment', 'createIntent', 'submitIntent', 'execute', 'dispatch']),
  // Disbursements leave through PaymentGatewayOsEngine submit → approve only; the
  // raw PaymentGatewayServerEngine operations are never reachable as OS actions.
  'payment-gateway': new Set(['sale', 'authorize', 'capture', 'refund', 'void', 'processPayment', 'process-payment', 'createSession', 'clearPayment', 'clearAndSettle', 'sendPayment', 'execute', 'dispatch', 'payout', 'disburse']),
  // Registry changes apply only through EnterpriseNetworkOsEngine submit → approve;
  // the engine never moves money, so money-movement actions are refused outright.
  'enterprise-network': new Set(['onboard', 'onboardParticipant', 'activate', 'activateParticipant', 'reinstate', 'setRoutingPolicy', 'setExposureLimit', 'apply', '_apply', 'admit', 'execute', 'dispatch', 'sale', 'payout', 'transfer', 'sendPayment', 'disburse']),
  // Network clearing / settlement runs only through PrivatePaymentNetworkOsEngine
  // submit → approve; ledger transfers and gateway sales are never OS actions.
  'private-payment-network': new Set(['sale', 'authorize', 'capture', 'refund', 'void', 'processPayment', 'process-payment', 'payout', 'disburse', 'transfer', 'bookTransfer', 'clear', 'settle', 'clearPayment', 'clearAndSettle', 'sendPayment', 'execute', 'dispatch', '_dispatch']),
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
  'funding-os': FundingOsPlatformEngine,
  'payment-processor': PaymentProcessorPlatformEngine,
  'payment-gateway': PaymentGatewayPlatformEngine,
  'enterprise-network': EnterpriseNetworkPlatformEngine,
  'private-payment-network': PrivatePaymentNetworkPlatformEngine,
  'h2h-discovery': require('../integrations/os/h2hDiscoveryOsEngine').H2hDiscoveryOsEngine,
  'open-bank-rest-api': require('../integrations/os/openBankRestApiOsEngine').OpenBankRestApiOsEngine,
  egress: require('../integrations/os/egressOsEngine').EgressOsEngine,
  'idp-ocr': require('../integrations/os/idpOcrOsEngine').IdpOcrOsEngine,
  'tax-os': require('../integrations/os/taxOsEngine').TaxOsEngine,
  'private-entity': require('../integrations/os/privateEntityOsEngine').PrivateEntityOsEngine,
  'clearing-agent': require('../integrations/os/clearingAgentOsEngine').ClearingAgentOsEngine,
  'enterprise-odfi': require('../integrations/os/enterpriseOdfiOsEngine').EnterpriseOdfiOsEngine,
  'transfer-api': require('../integrations/os/transferApiOsEngine').TransferApiOsEngine,
  'fraud-compliance': require('../integrations/os/fraudComplianceOsEngine').FraudComplianceOsEngine,
};

// Engines whose actions are attributed to the authenticated trustee (maker/checker).
const ACTOR_STAMPED_ENGINES = new Set(['h2h-discovery', 'open-bank-rest-api', 'egress', 'idp-ocr', 'tax-os', 'private-entity', 'clearing-agent', 'enterprise-odfi', 'transfer-api', 'fraud-compliance']);

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
      if (typeof req.osEngine._log === 'function') {
        await req.osEngine._log(payload.action, payload, { rejected: true, reason: 'direct money movement outside maker-checker workflow', actor: req.user?.username || req.user?.email || req.user?.userId || null }, 'rejected');
      }
      return res.status(409).json({
        success: false,
        error: 'Money movement must use the authenticated maker-checker workflow (distribution requests, vendor bills, Payer OS or settlement orders)',
      });
    }
    if (ACTOR_STAMPED_ENGINES.has(req.params.engine)) {
      payload.actor = req.user?.email || req.user?.username || req.user?.userId || req.user?.sub || 'admin';
    }
    const data = await req.osEngine.process(payload);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// Clearing Agent participant endpoint served by the trust's own PPN. Admits only
// the configured CLEARING_AGENT_ID with an HMAC request signature made with the
// shared PRIVATE_PAYMENT_NETWORK_AGENT_SECRET (verified by the endpoint module);
// bodies are bank-format text/XML/JSON so they are read raw.
const agentRaw = express.raw({ type: () => true, limit: '1mb' });
function agentRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  return req.rawBody || Buffer.from(req.body && typeof req.body === 'object' ? JSON.stringify(req.body) : String(req.body || ''), 'utf8');
}
router.post('/private-payment-network/agent/handshake', writeRateLimiter(), agentRaw, async (req, res) => {
  try {
    const rawBody = agentRawBody(req);
    let payload = {};
    try { payload = JSON.parse(rawBody.toString('utf8') || '{}'); } catch { payload = {}; }
    const data = await ClearingAgentNetworkEndpoint.handshake({ headers: req.headers, path: req.baseUrl + req.path, rawBody, payload });
    res.json(data);
  } catch (err) { sendError(res, err); }
});
router.post('/private-payment-network/agent/clear', writeRateLimiter(), agentRaw, async (req, res) => {
  try {
    const data = await ClearingAgentNetworkEndpoint.clear({ headers: req.headers, path: req.baseUrl + req.path, rawBody: agentRawBody(req) });
    res.status(data.idempotent ? 200 : 201).json(data);
  } catch (err) { sendError(res, err); }
});

// Public payment gateway processor callback (HMAC-SHA256 over the raw body with
// PAYMENT_GATEWAY_WEBHOOK_SECRET, verified by PaymentGatewayOsEngine).
router.post('/payment-gateway/webhook', writeRateLimiter(), async (req, res) => {
  try {
    const payload = req.body || {};
    const signature = req.get('x-gateway-signature') || req.get('x-signature') || payload.signature;
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(payload);
    const data = await PaymentGatewayPlatformEngine.process({ action: 'webhook', rawBody, signature, payload });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// Public enterprise-network screening / partner callback (HMAC-SHA256 over the raw
// body with ENTERPRISE_NETWORK_WEBHOOK_SECRET, verified by EnterpriseNetworkOsEngine).
router.post('/enterprise-network/webhook', writeRateLimiter(), async (req, res) => {
  try {
    const payload = req.body || {};
    const signature = req.get('x-network-signature') || req.get('x-signature') || payload.signature;
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(payload);
    const data = await EnterpriseNetworkPlatformEngine.process({ action: 'webhook', rawBody, signature, payload });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// Public private-payment-network processor callback (HMAC-SHA256 over the raw body
// with PRIVATE_PAYMENT_NETWORK_WEBHOOK_SECRET, verified by PrivatePaymentNetworkOsEngine).
router.post('/private-payment-network/webhook', writeRateLimiter(), async (req, res) => {
  try {
    const payload = req.body || {};
    const signature = req.get('x-network-signature') || req.get('x-signature') || payload.signature;
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(payload);
    const data = await PrivatePaymentNetworkPlatformEngine.process({ action: 'webhook', rawBody, signature, payload });
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
