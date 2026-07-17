'use strict';

/**
 * Banking Aggregator Routes — bi-directional financial data hub.
 * Mounts at: /api/aggregator
 *
 * Inbound  (PULL): GET accounts/transactions/statements after syncing.
 * Outbound (PUSH): POST payments/financial data to a provider.
 * Webhooks (PUSH-in): provider-initiated events at /webhooks/:id (public, signed).
 */

const express = require('express');
const router = express.Router();
const { BankingAggregator } = require('../integrations/aggregator/bankingAggregator');

// ─── Auth Middleware ─────────────────────────────────────────────────────────
// Admin token via x-admin-token header or adminToken query param.
const requireAdmin = (req, res, next) => {
  const adminToken = req.headers['x-admin-token'] || req.query.adminToken;
  if (adminToken && adminToken === process.env.ADMIN_SECRET_TOKEN) return next();
  return res.status(401).json({ success: false, error: 'Authentication required (x-admin-token).' });
};

function fail(res, err) {
  const code = /not found/i.test(err.message) ? 404 : /required|must be|unknown|does not support|inactive|only/i.test(err.message) ? 400 : 500;
  return res.status(code).json({ success: false, error: err.message });
}

// ─── Status ──────────────────────────────────────────────────────────────────
router.get('/status', requireAdmin, async (req, res) => {
  try { res.json({ success: true, data: await BankingAggregator.status() }); }
  catch (err) { fail(res, err); }
});

// ─── Connections CRUD ────────────────────────────────────────────────────────
router.get('/connections', requireAdmin, async (req, res) => {
  try { res.json({ success: true, data: await BankingAggregator.listConnections() }); }
  catch (err) { fail(res, err); }
});

router.get('/connections/:id', requireAdmin, async (req, res) => {
  try {
    const conn = await BankingAggregator.getConnection(req.params.id);
    if (!conn) return res.status(404).json({ success: false, error: 'Connection not found' });
    res.json({ success: true, data: conn });
  } catch (err) { fail(res, err); }
});

router.post('/connections', requireAdmin, async (req, res) => {
  try { res.json({ success: true, data: await BankingAggregator.createConnection(req.body || {}) }); }
  catch (err) { fail(res, err); }
});

router.put('/connections/:id', requireAdmin, async (req, res) => {
  try { res.json({ success: true, data: await BankingAggregator.updateConnection(req.params.id, req.body || {}) }); }
  catch (err) { fail(res, err); }
});

router.delete('/connections/:id', requireAdmin, async (req, res) => {
  try {
    const ok = await BankingAggregator.deleteConnection(req.params.id);
    res.json({ success: ok, deleted: ok });
  } catch (err) { fail(res, err); }
});

// ─── Inbound: trigger a pull/sync ────────────────────────────────────────────
router.post('/connections/:id/pull', requireAdmin, async (req, res) => {
  try {
    const summary = await BankingAggregator.pull(req.params.id, req.body || {});
    res.json({ success: summary.errors.length === 0, data: summary });
  } catch (err) { fail(res, err); }
});

// ─── Outbound: push payment / financial data ─────────────────────────────────
router.post('/connections/:id/push', requireAdmin, async (req, res) => {
  try {
    const result = await BankingAggregator.push(req.params.id, req.body || {});
    res.json({ success: true, data: result });
  } catch (err) { fail(res, err); }
});

// ─── Normalized data queries ─────────────────────────────────────────────────
router.get('/accounts', requireAdmin, async (req, res) => {
  try { res.json({ success: true, data: await BankingAggregator.listAccounts(req.query.connectionId) }); }
  catch (err) { fail(res, err); }
});

router.get('/transactions', requireAdmin, async (req, res) => {
  try {
    res.json({ success: true, data: await BankingAggregator.listTransactions({
      connectionId: req.query.connectionId, accountId: req.query.accountId, limit: req.query.limit,
    }) });
  } catch (err) { fail(res, err); }
});

router.get('/statements', requireAdmin, async (req, res) => {
  try { res.json({ success: true, data: await BankingAggregator.listStatements(req.query.connectionId) }); }
  catch (err) { fail(res, err); }
});

router.get('/events', requireAdmin, async (req, res) => {
  try {
    res.json({ success: true, data: await BankingAggregator.listEvents({
      connectionId: req.query.connectionId, direction: req.query.direction, limit: req.query.limit,
    }) });
  } catch (err) { fail(res, err); }
});

// ─── Inbound webhooks (public; verified via connector signature) ─────────────
// Uses raw body so the connector can verify an HMAC signature over the exact bytes.
router.post('/webhooks/:id', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    const result = await BankingAggregator.handleWebhook(req.params.id, req.headers, rawBody);
    if (!result.verified) return res.status(401).json({ success: false, error: 'Signature verification failed' });
    res.json({ success: true, data: result });
  } catch (err) { fail(res, err); }
});

module.exports = router;
