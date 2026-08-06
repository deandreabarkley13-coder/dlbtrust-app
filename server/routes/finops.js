'use strict';

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { FinOpsAgent } = require('../integrations/finops/finopsAgent');
const { ModuleSmartAccountEngine } = require('../integrations/dapp/moduleSmartAccountEngine');

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

module.exports = router;
