'use strict';

/**
 * Operational Utilities API — Live system orchestration endpoints.
 */

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { OperationalUtilitiesEngine } = require('../integrations/utilities/operationalUtilitiesEngine');

const router = express.Router();
const adminAuth = requireAuth({ role: 'admin' });
const operatorAuth = requireAuth({ role: 'operator' });

function sendError(res, err) {
  console.error('[utilities-route]', err.message || err);
  res.status(400).json({ success: false, error: err.message || 'Utilities error' });
}

function getUserId(req) {
  const u = req.user || {};
  return String(u.username || u.userId || u.id || u.email || 'operator');
}

function isAdmin(req) {
  const u = req.user || {};
  if (u.role === 'admin') return true;
  if (Array.isArray(u.roles) && u.roles.includes('admin')) return true;
  return false;
}

// Live aggregated system status
router.get('/status', operatorAuth, async (req, res) => {
  try {
    let data = await OperationalUtilitiesEngine.getLiveStatus();
    if (!isAdmin(req)) data = OperationalUtilitiesEngine.redactForOperator(data);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// Quick health snapshot
router.get('/health', operatorAuth, async (req, res) => {
  try {
    let data = await OperationalUtilitiesEngine.getHealthSnapshot();
    if (!isAdmin(req)) data = OperationalUtilitiesEngine.redactForOperator(data);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// Module-by-module status
router.get('/modules', operatorAuth, async (req, res) => {
  try {
    let data = await OperationalUtilitiesEngine.getModuleStatus();
    if (!isAdmin(req)) data = OperationalUtilitiesEngine.redactForOperator(data);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// Recent utility run log
router.get('/runs', operatorAuth, async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 50;
    const data = await OperationalUtilitiesEngine.listRuns(limit);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// Scheduler configuration
router.get('/schedule', operatorAuth, async (req, res) => {
  try {
    const data = await OperationalUtilitiesEngine.getSchedule();
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/schedule/:utility', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { utility } = req.params;
    const { enabled, interval_ms } = req.body || {};
    const data = await OperationalUtilitiesEngine.updateSchedule(utility, {
      enabled: typeof enabled === 'boolean' ? enabled : null,
      interval_ms: Number(interval_ms) > 0 ? Number(interval_ms) : null,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// Run a single operational utility
router.post('/run/:utility', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { utility } = req.params;
    const data = await OperationalUtilitiesEngine.runUtility(utility, req.body || {}, getUserId(req));
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// Run the safe default suite
router.post('/run-all', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { includeDangerous } = req.body || {};
    const data = await OperationalUtilitiesEngine.runAll({ includeDangerous: includeDangerous === true }, getUserId(req));
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// Cross-module reconciliation
router.post('/reconcile', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await OperationalUtilitiesEngine.runUtility('reconcile_all', req.body || {}, getUserId(req));
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// Full system export
router.post('/export', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await OperationalUtilitiesEngine.runUtility('export_system', req.body || {}, getUserId(req));
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// Scheduler control
router.post('/scheduler', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { action, interval_ms } = req.body || {};
    if (action === 'start') {
      OperationalUtilitiesEngine.startScheduler(Number(interval_ms) || undefined);
      res.json({ success: true, data: OperationalUtilitiesEngine.getSchedulerStatus() });
    } else if (action === 'stop') {
      OperationalUtilitiesEngine.stopScheduler();
      res.json({ success: true, data: OperationalUtilitiesEngine.getSchedulerStatus() });
    } else {
      res.json({ success: true, data: OperationalUtilitiesEngine.getSchedulerStatus() });
    }
  } catch (err) { sendError(res, err); }
});

router.get('/scheduler', operatorAuth, async (req, res) => {
  res.json({ success: true, data: OperationalUtilitiesEngine.getSchedulerStatus() });
});

module.exports = router;
