'use strict';

/**
 * Banking Aggregator Routes — bi-directional financial data hub.
 * Mounts at: /api/aggregator
 *
 * Inbound  (PULL): GET accounts/transactions/statements after syncing.
 * Outbound (PUSH): POST payments/financial data to a provider.
 * Webhooks (PUSH-in): provider-initiated events at /webhooks/:id (public, signed).
 * Handshake: POST/GET /connections/:id/handshake (register with provider,
 *            negotiate pull/push/webhook capabilities).
 *
 * Connection responses carry the handshake lifecycle fields:
 *   handshake_state        pending | challenged | verified | failed
 *   handshake_at           timestamp of the last state change
 *   external_connection_id provider-side id returned by the handshake
 *   capabilities           { pull, push, webhook } negotiated during the handshake
 *   mode                   live | shadow (effective outbound mode)
 * Secrets in config are never returned (see credentials.has_* flags).
 */

const express = require('express');
const router = express.Router();
const { BankingAggregator } = require('../integrations/aggregator/bankingAggregator');
const { verifySchedulerToken } = require('../integrations/aggregator/schedulerAuth');

// ─── Auth Middleware ─────────────────────────────────────────────────────────
// Admin token via x-admin-token header or adminToken query param.
const requireAdmin = (req, res, next) => {
  const adminToken = req.headers['x-admin-token'] || req.query.adminToken;
  if (adminToken && adminToken === process.env.ADMIN_SECRET_TOKEN) return next();
  return res.status(401).json({ success: false, error: 'Authentication required (x-admin-token).' });
};

// Cloud Scheduler pull jobs (infra/gcp/aggregator_cron.tf) authenticate with a
// Google-signed OIDC token instead of the admin secret.
const requireAdminOrScheduler = async (req, res, next) => {
  const adminToken = req.headers['x-admin-token'] || req.query.adminToken;
  if (adminToken && adminToken === process.env.ADMIN_SECRET_TOKEN) return next();
  const auth = req.headers.authorization || '';
  if (/^Bearer\s+/i.test(auth)) {
    try {
      const claims = await verifySchedulerToken(auth.replace(/^Bearer\s+/i, '').trim());
      if (claims) { req.schedulerPrincipal = claims.email; return next(); }
    } catch (e) { /* fall through to 401 */ }
  }
  return res.status(401).json({ success: false, error: 'Authentication required (x-admin-token or scheduler OIDC token).' });
};

function fail(res, err) {
  const code = err.status || (/not found/i.test(err.message) ? 404 : /required|must be|unknown|does not support|inactive|only/i.test(err.message) ? 400 : 500);
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

// ─── Handshake: register with the provider / negotiate capabilities ──────────
// POST initiates or retries; GET returns state + negotiated capabilities.
router.post('/connections/:id/handshake', requireAdmin, async (req, res) => {
  try {
    const hs = await BankingAggregator.handshake(req.params.id);
    const ok = hs.handshake_state === 'verified';
    res.status(ok ? 200 : 502).json({ success: ok, data: hs });
  } catch (err) { fail(res, err); }
});

router.get('/connections/:id/handshake', requireAdmin, async (req, res) => {
  try { res.json({ success: true, data: await BankingAggregator.getHandshake(req.params.id) }); }
  catch (err) { fail(res, err); }
});

// ─── Account linking bootstrap (Plaid Link) ──────────────────────────────────
// POST link-token → open Plaid Link with data.linkToken; POST link-exchange
// with the public_token → one-time access token to store in Secret Manager.
router.post('/connections/:id/link-token', requireAdmin, async (req, res) => {
  try { res.json({ success: true, data: await BankingAggregator.createLinkToken(req.params.id, req.body || {}) }); }
  catch (err) { fail(res, err); }
});

router.post('/connections/:id/link-exchange', requireAdmin, async (req, res) => {
  try {
    const publicToken = req.body && (req.body.publicToken || req.body.public_token);
    res.json({ success: true, data: await BankingAggregator.exchangeLinkToken(req.params.id, publicToken) });
  } catch (err) { fail(res, err); }
});

// ─── Inbound: trigger a pull/sync ────────────────────────────────────────────
// Pull refuses (409) until the handshake is verified when the connector
// declares one. Accepts the Cloud Scheduler OIDC token as well as the admin token.
router.post('/connections/:id/pull', requireAdminOrScheduler, async (req, res) => {
  try {
    const summary = await BankingAggregator.pull(req.params.id, req.body || {});
    res.json({ success: summary.errors.length === 0, data: summary });
  } catch (err) { fail(res, err); }
});

// ─── Outbound: push payment / financial data ─────────────────────────────────
// Fail-closed: live-mode connections require body.approvalRef (maker/checker)
// and body.screeningRef (PaymentComplianceGate) or the push is refused with
// 409. Shadow-mode connections journal the event and never call the provider.
router.post('/connections/:id/push', requireAdmin, async (req, res) => {
  try {
    const result = await BankingAggregator.push(req.params.id, req.body || {});
    res.json({ success: true, data: result });
  } catch (err) { fail(res, err); }
});

// ─── Payment-file exchange (connectors that support it) ─────────────────────
// Transmit a payment file: POST /connections/:id/push with body
//   { kind: 'ach_file', ach_batch_id } or { kind: 'ach_file', content, filename }
// Status + returns are separate pulls:
router.get('/connections/:id/file-status', requireAdmin, async (req, res) => {
  try {
    const result = await BankingAggregator.pullFileStatus(req.params.id, { submissionId: req.query.submissionId });
    res.json({ success: true, data: result });
  } catch (err) { fail(res, err); }
});

router.post('/connections/:id/returns', requireAdmin, async (req, res) => {
  try {
    const result = await BankingAggregator.pullReturns(req.params.id, req.body || {});
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
    // Prefer the exact received bytes. Depending on the entrypoint the raw body
    // arrives either as req.rawBody (server-3002.js captures it in express.json's
    // verify callback) or as a Buffer in req.body (server-new-fixed.js mounts
    // express.raw for this path before the global JSON parser).
    const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody
      : Buffer.isBuffer(req.body) ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
    const result = await BankingAggregator.handleWebhook(req.params.id, req.headers, rawBody);
    if (!result.verified) return res.status(401).json({ success: false, error: 'Signature verification failed' });
    res.json({ success: true, data: result });
  } catch (err) { fail(res, err); }
});

module.exports = router;
