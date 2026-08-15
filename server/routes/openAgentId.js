/**
 * Open Agent ID Routes — /api/open-agent-id
 *
 * Endpoints for registering an OpenAgentID DID, checking agent/credit records,
 * and signing or verifying agent-authenticated HTTP requests.
 */

'use strict';

const express = require('express');
const { OpenAgentIdEngine } = require('../integrations/openAgentId/openAgentIdEngine');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');

const router = express.Router();
const operatorAuth = requireAuth({ role: 'operator' });
const adminAuth = requireAuth({ role: 'admin' });

function sendError(res, err) {
  const status = err.status || (err.message && err.message.includes('not found') ? 404 : 400);
  res.status(status).json({ success: false, error: err.message || 'OpenAgentID operation failed' });
}

// ─── GET /api/open-agent-id/status ──────────────────────────────────────────
router.get('/status', operatorAuth, async (req, res) => {
  try {
    const data = await OpenAgentIdEngine.status();
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── POST /api/open-agent-id/register ─────────────────────────────────────────
router.post('/register', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { name, capabilities } = req.body || {};
    const identity = await OpenAgentIdEngine.registerIdentity({ name, capabilities });
    const data = OpenAgentIdEngine._formatIdentity(identity);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── GET /api/open-agent-id/agents ────────────────────────────────────────────
router.get('/agents', operatorAuth, async (req, res) => {
  try {
    const data = await OpenAgentIdEngine.listAgents();
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── GET /api/open-agent-id/agent/:did ────────────────────────────────────────
router.get('/agent/:did', operatorAuth, async (req, res) => {
  try {
    const data = await OpenAgentIdEngine.getAgent(req.params.did);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── GET /api/open-agent-id/credit/:did ───────────────────────────────────────
router.get('/credit/:did', operatorAuth, async (req, res) => {
  try {
    const data = await OpenAgentIdEngine.getCredit(req.params.did);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── POST /api/open-agent-id/sign-request ─────────────────────────────────────
router.post('/sign-request', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { method, url, body } = req.body || {};
    if (!method || !url) throw new Error('method and url are required');
    const data = await OpenAgentIdEngine.signHttpRequest({ method, url, body });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── POST /api/open-agent-id/verify-signature ───────────────────────────────────
router.post('/verify-signature', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { did, method, url, body, timestamp, nonce, signature } = req.body || {};
    if (!did || !method || !url || timestamp === undefined || !nonce || !signature) {
      throw new Error('did, method, url, timestamp, nonce, and signature are required');
    }
    const data = await OpenAgentIdEngine.verifyHttpSignature({ did, method, url, body, timestamp, nonce, signature });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
