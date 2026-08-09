'use strict';

const express = require('express');
const { requireAuth } = require('../integrations/auth/securityMiddleware');

const router = express.Router();
const operatorAuth = requireAuth({ role: 'operator' });

function sendError(res, err) {
  console.error('[trust-ops]', err.message || err);
  res.status(400).json({ success: false, error: err.message || 'Trust ops error' });
}

function toUsd(cents) {
  return Number(cents || 0) / 100;
}

// Lazy-load engines so optional modules do not break startup
let TrustAggregatorEngine, LiveBondEngine, DistributionRequestEngine, DappEngine, VendorPaymentEngine, TrustBankEngine;
function loadEngines() {
  try { ({ TrustAggregatorEngine } = require('../integrations/dapp/trustAggregatorEngine')); } catch (e) { TrustAggregatorEngine = null; }
  try { ({ LiveBondEngine } = require('../integrations/bonds/liveEngine')); } catch (e) { LiveBondEngine = null; }
  try { ({ DistributionRequestEngine } = require('../integrations/dapp/distributionRequestEngine')); } catch (e) { DistributionRequestEngine = null; }
  try { ({ DappEngine } = require('../integrations/dapp/dappEngine')); } catch (e) { DappEngine = null; }
  try { ({ VendorPaymentEngine } = require('../integrations/dapp/vendorPaymentEngine')); } catch (e) { VendorPaymentEngine = null; }
  try { ({ TrustBankEngine } = require('../integrations/dapp/trustBankEngine')); } catch (e) { TrustBankEngine = null; }
}

router.get('/summary', operatorAuth, async (req, res) => {
  try {
    loadEngines();
    const summary = {
      netWorth: 0,
      bySource: {},
      bondValue: 0,
      pendingApprovals: 0,
      distributions: [],
      vendors: [],
      holdAccounts: [],
      contacts: [],
      recentActivity: [],
    };

    if (TrustAggregatorEngine) {
      try {
        const nw = await TrustAggregatorEngine.getNetWorth();
        summary.netWorth = nw.total || 0;
        summary.bySource = nw.by_source || {};
      } catch (e) { console.warn('[trust-ops] net worth:', e.message); }
    }

    if (LiveBondEngine) {
      try {
        const snapshot = await LiveBondEngine.getPortfolioSnapshot();
        summary.bondValue = snapshot.total_market_value || snapshot.total_current_value || snapshot.total_face_value || 0;
      } catch (e) { console.warn('[trust-ops] bonds:', e.message); }
    }

    if (DistributionRequestEngine) {
      try {
        const requests = await DistributionRequestEngine.listRequests({ limit: 50 });
        summary.distributions = requests;
        summary.pendingApprovals = requests.filter(r => r.status === 'requested' || r.status === 'under_review').length;
        summary.recentActivity.push(...requests.slice(0, 10).map(r => ({ type: 'distribution', id: r.id, amount: toUsd(r.amount_cents), status: r.status, createdAt: r.created_at })));
      } catch (e) { console.warn('[trust-ops] requests:', e.message); }
    }

    if (DappEngine) {
      try {
        summary.contacts = await DappEngine.listUsers();
      } catch (e) { console.warn('[trust-ops] contacts:', e.message); }
    }

    if (VendorPaymentEngine) {
      try {
        summary.vendors = await VendorPaymentEngine.listVendors({ limit: 50 });
        const runs = await VendorPaymentEngine.listPaymentRuns({ limit: 20 });
        summary.recentActivity.push(...runs.map(r => ({ type: 'vendor_payment', id: r.run_id, amount: toUsd(r.amount_cents), status: r.status, createdAt: r.created_at })));
      } catch (e) { console.warn('[trust-ops] vendors:', e.message); }
    }

    if (TrustBankEngine) {
      try {
        summary.holdAccounts = await TrustBankEngine.listAccounts({ limit: 50 });
        const payments = await TrustBankEngine.listPayments({ limit: 20 });
        summary.recentActivity.push(...payments.map(p => ({ type: 'trust_bank_payment', id: p.payment_id, amount: toUsd(p.amount_cents), status: p.status, createdAt: p.created_at })));
      } catch (e) { console.warn('[trust-ops] trust bank:', e.message); }
    }

    summary.recentActivity.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    summary.recentActivity = summary.recentActivity.slice(0, 20);

    res.json({ success: true, data: summary });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
