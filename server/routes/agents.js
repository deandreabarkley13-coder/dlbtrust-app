'use strict';

/**
 * Agent Routes — DLB Trust
 * Mounts at: /api/agents
 *
 * Trustee Agent: fiduciary oversight, compliance, asset reviews, distributions
 * Bookkeeping Agent: reconciliation, journal automation, reporting, anomalies
 */

var express = require('express');
var router = express.Router();
var path = require('path');

// Auth middleware — require admin token, JWT, or API key
var requireAdmin = async function(req, res, next) {
  var adminToken = req.headers['x-admin-token'] || req.query.adminToken;
  if (adminToken && adminToken === process.env.ADMIN_SECRET_TOKEN) {
    req.user = 'admin';
    return next();
  }
  var authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    var token = authHeader.slice(7).trim();
    try {
      var UserAuth = require(path.join(__dirname, '../integrations/auth/userAuth')).UserAuth;
      var decoded = await UserAuth.verifyToken(token);
      if (decoded && decoded.role === 'admin') {
        req.user = decoded;
        return next();
      }
    } catch(e) {}
    try {
      var ApiCredentials = require(path.join(__dirname, '../integrations/ach/apiCredentials')).ApiCredentials;
      var cred = await ApiCredentials.validate(token);
      if (cred) { req.user = cred.label || 'api_key'; return next(); }
    } catch(e) {}
  }
  return res.status(401).json({ error: 'Authentication required' });
};

// ═════════════════════════════════════════════════════════════════════════════
// TRUSTEE AGENT
// ═════════════════════════════════════════════════════════════════════════════

// ─── GET /api/agents/trustee/dashboard ───────────────────────────────────────
router.get('/trustee/dashboard', async function(req, res) {
  try {
    var { TrusteeAgent } = require(path.join(__dirname, '../integrations/agents/trusteeAgent'));
    var dashboard = await TrusteeAgent.getDashboard();
    res.json({ success: true, data: dashboard });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/agents/trustee/asset-review ──────────────────────────────────
router.post('/trustee/asset-review', requireAdmin, async function(req, res) {
  try {
    var { TrusteeAgent } = require(path.join(__dirname, '../integrations/agents/trusteeAgent'));
    var review = await TrusteeAgent.runAssetReview();
    res.json({ success: true, data: review });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/agents/trustee/compliance-check ──────────────────────────────
router.post('/trustee/compliance-check', requireAdmin, async function(req, res) {
  try {
    var { TrusteeAgent } = require(path.join(__dirname, '../integrations/agents/trusteeAgent'));
    var result = await TrusteeAgent.runComplianceCheck();
    res.json({ success: true, data: result });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/agents/trustee/distributions ──────────────────────────────────
router.get('/trustee/distributions', async function(req, res) {
  try {
    var { TrusteeAgent } = require(path.join(__dirname, '../integrations/agents/trusteeAgent'));
    var result = await TrusteeAgent.reviewDistributions();
    res.json({ success: true, data: result });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/agents/trustee/generate-duties ───────────────────────────────
router.post('/trustee/generate-duties', requireAdmin, async function(req, res) {
  try {
    var { TrusteeAgent } = require(path.join(__dirname, '../integrations/agents/trusteeAgent'));
    var result = await TrusteeAgent.generateDuties();
    res.json({ success: true, data: result });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/agents/trustee/execute/:taskId ───────────────────────────────
router.post('/trustee/execute/:taskId', requireAdmin, async function(req, res) {
  try {
    var { TrusteeAgent } = require(path.join(__dirname, '../integrations/agents/trusteeAgent'));
    var result = await TrusteeAgent.executeTask(req.params.taskId);
    res.json({ success: true, data: result });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/agents/trustee/tasks ──────────────────────────────────────────
router.get('/trustee/tasks', async function(req, res) {
  try {
    var { TrusteeAgent } = require(path.join(__dirname, '../integrations/agents/trusteeAgent'));
    var tasks = await TrusteeAgent.listTasks({
      status: req.query.status,
      category: req.query.category,
      limit: req.query.limit,
    });
    res.json({ success: true, count: tasks.length, data: tasks });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/agents/trustee/reviews ────────────────────────────────────────
router.get('/trustee/reviews', async function(req, res) {
  try {
    var { TrusteeAgent } = require(path.join(__dirname, '../integrations/agents/trusteeAgent'));
    var reviews = await TrusteeAgent.listReviews({
      reviewType: req.query.reviewType,
      limit: req.query.limit,
    });
    res.json({ success: true, count: reviews.length, data: reviews });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/agents/trustee/reviews/:id ────────────────────────────────────
router.get('/trustee/reviews/:id', async function(req, res) {
  try {
    var { TrusteeAgent } = require(path.join(__dirname, '../integrations/agents/trusteeAgent'));
    var review = await TrusteeAgent.getReview(req.params.id);
    if (!review) return res.status(404).json({ success: false, error: 'Review not found' });
    res.json({ success: true, data: review });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// BOOKKEEPING AGENT
// ═════════════════════════════════════════════════════════════════════════════

// ─── GET /api/agents/bookkeeping/dashboard ──────────────────────────────────
router.get('/bookkeeping/dashboard', async function(req, res) {
  try {
    var { BookkeepingAgent } = require(path.join(__dirname, '../integrations/agents/bookkeepingAgent'));
    var dashboard = await BookkeepingAgent.getDashboard();
    res.json({ success: true, data: dashboard });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/agents/bookkeeping/reconcile-ach ─────────────────────────────
router.post('/bookkeeping/reconcile-ach', requireAdmin, async function(req, res) {
  try {
    var { BookkeepingAgent } = require(path.join(__dirname, '../integrations/agents/bookkeepingAgent'));
    var result = await BookkeepingAgent.reconcileACH();
    res.json({ success: true, data: result });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/agents/bookkeeping/reconcile-wires ───────────────────────────
router.post('/bookkeeping/reconcile-wires', requireAdmin, async function(req, res) {
  try {
    var { BookkeepingAgent } = require(path.join(__dirname, '../integrations/agents/bookkeepingAgent'));
    var result = await BookkeepingAgent.reconcileWires();
    res.json({ success: true, data: result });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/agents/bookkeeping/auto-post ─────────────────────────────────
router.post('/bookkeeping/auto-post', requireAdmin, async function(req, res) {
  try {
    var { BookkeepingAgent } = require(path.join(__dirname, '../integrations/agents/bookkeepingAgent'));
    var result = await BookkeepingAgent.autoPostUnreconciled();
    res.json({ success: true, data: result });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/agents/bookkeeping/financial-summary ──────────────────────────
router.get('/bookkeeping/financial-summary', async function(req, res) {
  try {
    var { BookkeepingAgent } = require(path.join(__dirname, '../integrations/agents/bookkeepingAgent'));
    var result = await BookkeepingAgent.generateFinancialSummary();
    res.json({ success: true, data: result });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/agents/bookkeeping/anomaly-scan ──────────────────────────────
router.post('/bookkeeping/anomaly-scan', requireAdmin, async function(req, res) {
  try {
    var { BookkeepingAgent } = require(path.join(__dirname, '../integrations/agents/bookkeepingAgent'));
    var result = await BookkeepingAgent.detectAnomalies();
    res.json({ success: true, data: result });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/agents/bookkeeping/generate-duties ───────────────────────────
router.post('/bookkeeping/generate-duties', requireAdmin, async function(req, res) {
  try {
    var { BookkeepingAgent } = require(path.join(__dirname, '../integrations/agents/bookkeepingAgent'));
    var result = await BookkeepingAgent.generateDuties();
    res.json({ success: true, data: result });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/agents/bookkeeping/execute/:taskId ───────────────────────────
router.post('/bookkeeping/execute/:taskId', requireAdmin, async function(req, res) {
  try {
    var { BookkeepingAgent } = require(path.join(__dirname, '../integrations/agents/bookkeepingAgent'));
    var result = await BookkeepingAgent.executeTask(req.params.taskId);
    res.json({ success: true, data: result });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/agents/bookkeeping/tasks ──────────────────────────────────────
router.get('/bookkeeping/tasks', async function(req, res) {
  try {
    var { BookkeepingAgent } = require(path.join(__dirname, '../integrations/agents/bookkeepingAgent'));
    var tasks = await BookkeepingAgent.listTasks({
      status: req.query.status,
      category: req.query.category,
      limit: req.query.limit,
    });
    res.json({ success: true, count: tasks.length, data: tasks });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/agents/bookkeeping/reconciliations ────────────────────────────
router.get('/bookkeeping/reconciliations', async function(req, res) {
  try {
    var { BookkeepingAgent } = require(path.join(__dirname, '../integrations/agents/bookkeepingAgent'));
    var recons = await BookkeepingAgent.listReconciliations({
      reconType: req.query.reconType,
      limit: req.query.limit,
    });
    res.json({ success: true, count: recons.length, data: recons });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/agents/bookkeeping/post-ach/:batchId ─────────────────────────
router.post('/bookkeeping/post-ach/:batchId', requireAdmin, async function(req, res) {
  try {
    var { BookkeepingAgent } = require(path.join(__dirname, '../integrations/agents/bookkeepingAgent'));
    var result = await BookkeepingAgent.postACHJournalEntry(req.params.batchId);
    res.json({ success: true, data: result });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/agents/bookkeeping/post-wire/:wireId ─────────────────────────
router.post('/bookkeeping/post-wire/:wireId', requireAdmin, async function(req, res) {
  try {
    var { BookkeepingAgent } = require(path.join(__dirname, '../integrations/agents/bookkeepingAgent'));
    var result = await BookkeepingAgent.postWireJournalEntry(req.params.wireId);
    res.json({ success: true, data: result });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/agents/bookkeeping/reverse/:entryId ──────────────────────────
router.post('/bookkeeping/reverse/:entryId', requireAdmin, async function(req, res) {
  try {
    var { BookkeepingAgent } = require(path.join(__dirname, '../integrations/agents/bookkeepingAgent'));
    var result = await BookkeepingAgent.reverseTransaction(req.params.entryId, {
      reason: req.body.reason,
      approvedBy: req.body.approvedBy || 'admin',
    });
    res.json({ success: true, data: result });
  } catch(err) {
    var status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ─── POST /api/agents/bookkeeping/adjustment ────────────────────────────────
router.post('/bookkeeping/adjustment', requireAdmin, async function(req, res) {
  try {
    var { BookkeepingAgent } = require(path.join(__dirname, '../integrations/agents/bookkeepingAgent'));
    var result = await BookkeepingAgent.postAdjustment({
      description: req.body.description,
      lines: req.body.lines,
      reason: req.body.reason,
      adjustmentType: req.body.adjustmentType,
      originalEntryId: req.body.originalEntryId,
      approvedBy: req.body.approvedBy || 'admin',
    });
    res.json({ success: true, data: result });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/agents/bookkeeping/adjustments ────────────────────────────────
router.get('/bookkeeping/adjustments', async function(req, res) {
  try {
    var { BookkeepingAgent } = require(path.join(__dirname, '../integrations/agents/bookkeepingAgent'));
    var adjustments = await BookkeepingAgent.listAdjustments({
      status: req.query.status,
      adjustmentType: req.query.type,
      limit: req.query.limit,
    });
    res.json({ success: true, count: adjustments.length, data: adjustments });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/agents/bookkeeping/detect-duplicates ─────────────────────────
router.post('/bookkeeping/detect-duplicates', requireAdmin, async function(req, res) {
  try {
    var { BookkeepingAgent } = require(path.join(__dirname, '../integrations/agents/bookkeepingAgent'));
    var result = await BookkeepingAgent.detectDuplicates({
      amount: req.body.amount,
      windowHours: req.body.windowHours,
      minAmount: req.body.minAmount,
    });
    res.json({ success: true, data: result });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/agents/bookkeeping/reverse-duplicate ─────────────────────────
router.post('/bookkeeping/reverse-duplicate', requireAdmin, async function(req, res) {
  try {
    var { BookkeepingAgent } = require(path.join(__dirname, '../integrations/agents/bookkeepingAgent'));
    var result = await BookkeepingAgent.reverseDuplicate(req.body.amount, {
      reason: req.body.reason,
      keepEntryId: req.body.keepEntryId,
    });
    res.json({ success: true, data: result });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/agents/bookkeeping/reconcile-bill ────────────────────────────
router.post('/bookkeeping/reconcile-bill', requireAdmin, async function(req, res) {
  try {
    var { BookkeepingAgent } = require(path.join(__dirname, '../integrations/agents/bookkeepingAgent'));
    var result = await BookkeepingAgent.reconcileBILLCash();
    res.json({ success: true, data: result });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/agents/bookkeeping/monthly-close ─────────────────────────────
router.post('/bookkeeping/monthly-close', requireAdmin, async function(req, res) {
  try {
    var { BookkeepingAgent } = require(path.join(__dirname, '../integrations/agents/bookkeepingAgent'));
    var result = await BookkeepingAgent.monthlyClose({
      periodName: req.body.periodName,
      closedBy: req.body.closedBy || 'admin',
    });
    res.json({ success: true, data: result });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/agents/bookkeeping/approve-payment/:paymentId ────────────────
router.post('/bookkeeping/approve-payment/:paymentId', requireAdmin, async function(req, res) {
  try {
    var { BookkeepingAgent } = require(path.join(__dirname, '../integrations/agents/bookkeepingAgent'));
    var result = await BookkeepingAgent.approvePayment(req.params.paymentId, {
      approvedBy: req.body.approvedBy || 'admin',
    });
    res.json({ success: true, data: result });
  } catch(err) {
    var status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ─── POST /api/agents/bookkeeping/reject-payment/:paymentId ─────────────────
router.post('/bookkeeping/reject-payment/:paymentId', requireAdmin, async function(req, res) {
  try {
    var { BookkeepingAgent } = require(path.join(__dirname, '../integrations/agents/bookkeepingAgent'));
    var result = await BookkeepingAgent.rejectPayment(req.params.paymentId, {
      rejectedBy: req.body.rejectedBy || 'admin',
      reason: req.body.reason,
    });
    res.json({ success: true, data: result });
  } catch(err) {
    var status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ─── POST /api/agents/bookkeeping/process-payment/:paymentId ────────────────
router.post('/bookkeeping/process-payment/:paymentId', requireAdmin, async function(req, res) {
  try {
    var { BookkeepingAgent } = require(path.join(__dirname, '../integrations/agents/bookkeepingAgent'));
    var result = await BookkeepingAgent.processVendorPayment(req.params.paymentId);
    res.json({ success: true, data: result });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/agents/bookkeeping/pending-payments ───────────────────────────
router.get('/bookkeeping/pending-payments', async function(req, res) {
  try {
    var { BookkeepingAgent } = require(path.join(__dirname, '../integrations/agents/bookkeepingAgent'));
    var result = await BookkeepingAgent.getPendingPayments();
    res.json({ success: true, count: result.length, data: result });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/agents/bookkeeping/process-pending ───────────────────────────
router.post('/bookkeeping/process-pending', requireAdmin, async function(req, res) {
  try {
    var { BookkeepingAgent } = require(path.join(__dirname, '../integrations/agents/bookkeepingAgent'));
    var result = await BookkeepingAgent.processPendingPayments();
    res.json({ success: true, data: result });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// NATURAL LANGUAGE PROMPT
// ═════════════════════════════════════════════════════════════════════════════

// ─── POST /api/agents/trustee/prompt ─────────────────────────────────────────
router.post('/trustee/prompt', requireAdmin, async function(req, res) {
  try {
    var prompt = (req.body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ success: false, error: 'Prompt is required' });
    var { AgentPromptRouter } = require(path.join(__dirname, '../integrations/agents/agentPromptRouter'));
    var response = await AgentPromptRouter.routeTrustee(prompt);
    res.json({ success: true, data: response });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/agents/bookkeeping/prompt ─────────────────────────────────────
router.post('/bookkeeping/prompt', requireAdmin, async function(req, res) {
  try {
    var prompt = (req.body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ success: false, error: 'Prompt is required' });
    var { AgentPromptRouter } = require(path.join(__dirname, '../integrations/agents/agentPromptRouter'));
    var response = await AgentPromptRouter.routeBookkeeping(prompt);
    res.json({ success: true, data: response });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
