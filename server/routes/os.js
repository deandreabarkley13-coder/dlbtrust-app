'use strict';

/**
 * OS Engine Routes — /api/os
 *
 * Provides a single, consistent interface to the operating-system engines:
 * bank, treasury, payment, clearing, settlement, compliance, security, rest-api,
 * bookkeeping, cash, asset-acquisition, bank-aggregator, funding, smart-router, back-office,
 * wallet-onramp, and alchemy-wallet.
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
} = require('../integrations/os/osEngine');

const router = express.Router();
const operatorAuth = requireAuth({ role: 'operator' });
const adminAuth = requireAuth({ role: 'admin' });

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

// ─── Per-engine status and health ─────────────────────────────────────────────

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
    const data = await req.osEngine.process(payload);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
