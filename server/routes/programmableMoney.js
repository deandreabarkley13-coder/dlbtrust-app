/**
 * Programmable Money Routes — /api/programmable-money
 *
 * Provides REST endpoints for creating, approving, triggering, and auditing
 * programmable money programs.  All write operations require an operator or
 * admin token; approval endpoints additionally require a valid maker/checker
 * attestation.
 */

'use strict';

const express = require('express');
const { ProgrammableMoneyEngine } = require('../integrations/dapp/programmableMoneyEngine');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');

const router = express.Router();
const operatorAuth = requireAuth({ role: 'operator' });

function sendError(res, err) {
  const status = err.status || (err.message && err.message.includes('not found') ? 404 : 400);
  res.status(status).json({ success: false, error: err.message || 'Programmable money operation failed' });
}

// ─── GET /api/programmable-money/programs ─────────────────────────────────────
router.get('/programs', operatorAuth, async (req, res) => {
  try {
    const data = await ProgrammableMoneyEngine.listPrograms({
      status: req.query.status,
      limit: req.query.limit ? Number(req.query.limit) : 50,
      offset: req.query.offset ? Number(req.query.offset) : 0,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── POST /api/programmable-money/programs ────────────────────────────────────
router.post('/programs', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const {
      name, description, sourceType, sourceAccount, sourceToken, sourceModule,
      amount, targetAsset, action, conditions, schedule,
    } = req.body || {};
    const result = await ProgrammableMoneyEngine.createProgram({
      name,
      description,
      sourceType,
      sourceAccount,
      sourceToken,
      sourceModule,
      amount,
      targetAsset,
      action,
      conditions,
      schedule,
      createdBy: req.user ? req.user.username || req.user.email || 'operator' : 'operator',
    });
    res.status(201).json({ success: true, data: result });
  } catch (err) { sendError(res, err); }
});

// ─── GET /api/programmable-money/programs/:id ───────────────────────────────
router.get('/programs/:id', operatorAuth, async (req, res) => {
  try {
    const data = await ProgrammableMoneyEngine.getProgram(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Program not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── POST /api/programmable-money/programs/:id/approve ─────────────────────────
router.post('/programs/:id/approve', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { role, approverEmail } = req.body || {};
    const result = await ProgrammableMoneyEngine.approveProgram({ programId: req.params.id, role, approverEmail });
    res.json({ success: true, data: result });
  } catch (err) { sendError(res, err); }
});

// ─── POST /api/programmable-money/programs/:id/reject ─────────────────────────
router.post('/programs/:id/reject', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { role, rejectorEmail, reason } = req.body || {};
    const result = await ProgrammableMoneyEngine.rejectProgram({ programId: req.params.id, role, rejectorEmail, reason });
    res.json({ success: true, data: result });
  } catch (err) { sendError(res, err); }
});

// ─── POST /api/programmable-money/programs/:id/trigger ─────────────────────────
router.post('/programs/:id/trigger', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { trigger, payload } = req.body || {};
    const result = await ProgrammableMoneyEngine.triggerProgram({
      programId: req.params.id,
      trigger: trigger || 'manual',
      triggeredBy: req.user ? req.user.username || req.user.email || 'operator' : 'operator',
      payload,
    });
    res.json({ success: true, data: result });
  } catch (err) { sendError(res, err); }
});

// ─── GET /api/programmable-money/runs ─────────────────────────────────────────
router.get('/runs', operatorAuth, async (req, res) => {
  try {
    const data = await ProgrammableMoneyEngine.listRuns({
      programId: req.query.programId,
      status: req.query.status,
      limit: req.query.limit ? Number(req.query.limit) : 50,
      offset: req.query.offset ? Number(req.query.offset) : 0,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── GET /api/programmable-money/runs/:id ─────────────────────────────────────
router.get('/runs/:id', operatorAuth, async (req, res) => {
  try {
    const data = await ProgrammableMoneyEngine.getRun(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Run not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
