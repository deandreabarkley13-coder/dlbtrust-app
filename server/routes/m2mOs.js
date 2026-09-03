'use strict';

/**
 * M2M OS API — /api/m2m-os
 *
 * Identities and partners are infrastructure: admin only. Handshakes, cycles
 * and manifest verification are operational and operator-gated. The private
 * half of an identity is never served by any route.
 */

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { M2mOsEngine } = require('../integrations/os/m2mOsEngine');

const router = express.Router();
const operatorAuth = requireAuth({ role: 'operator' });
const adminAuth = requireAuth({ role: 'admin' });

function principal(req) {
  const user = req.user || {};
  return user.email || user.username || user.userId || user.sub || null;
}

function sendError(res, err) {
  const status = err.status || err.statusCode || 400;
  res.status(status).json({ success: false, error: err.message, code: err.code || null, details: err.details || undefined });
}

router.get('/status', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await M2mOsEngine.status() }); } catch (err) { sendError(res, err); }
});

router.get('/events', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await M2mOsEngine.events({ partnerId: req.query.partnerId || null, identityId: req.query.identityId || null, limit: req.query.limit }) });
  } catch (err) { sendError(res, err); }
});

// ── Identities ─────────────────────────────────────────────────────────────

router.get('/identities', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await M2mOsEngine.identities() }); } catch (err) { sendError(res, err); }
});

router.get('/identities/:identityId', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await M2mOsEngine.identity(req.params.identityId) }); } catch (err) { sendError(res, err); }
});

/** The `authorized_keys` line to hand a bank. */
router.get('/identities/:identityId/public-key', operatorAuth, async (req, res) => {
  try {
    const identity = await M2mOsEngine.identity(req.params.identityId);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Key-Fingerprint', identity.fingerprint);
    res.send(`${identity.publicKeyOpenssh}\n`);
  } catch (err) { sendError(res, err); }
});

router.post('/identities', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    res.status(201).json({ success: true, data: await M2mOsEngine.createIdentity({ label: body.label, bits: body.bits || null, status: body.status || 'active', createdBy: principal(req) }) });
  } catch (err) { sendError(res, err); }
});

router.post('/identities/:identityId/retire', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await M2mOsEngine.retireIdentity(req.params.identityId, principal(req)) }); } catch (err) { sendError(res, err); }
});

// ── Partners ───────────────────────────────────────────────────────────────

router.get('/partners', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await M2mOsEngine.partners() }); } catch (err) { sendError(res, err); }
});

router.get('/partners/:partnerId', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await M2mOsEngine.partner(req.params.partnerId) }); } catch (err) { sendError(res, err); }
});

router.post('/partners', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    const data = await M2mOsEngine.registerPartner({
      partnerId: body.partnerId || null,
      name: body.name,
      bankName: body.bankName || null,
      host: body.host,
      port: body.port || 22,
      username: body.username,
      hostKeyFingerprint: body.hostKeyFingerprint || '',
      identityId: body.identityId || null,
      fileTypes: Array.isArray(body.fileTypes) ? body.fileTypes : undefined,
      layout: body.layout || {},
      policy: body.policy || {},
      createdBy: principal(req),
    });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/partners/:partnerId/status', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await M2mOsEngine.setPartnerStatus(req.params.partnerId, (req.body || {}).status, principal(req)) }); } catch (err) { sendError(res, err); }
});

router.post('/partners/:partnerId/handshake', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    res.json({ success: true, data: await M2mOsEngine.handshake(req.params.partnerId, { actor: principal(req), identityId: (req.body || {}).identityId || null }) });
  } catch (err) { sendError(res, err); }
});

router.post('/partners/:partnerId/rotate', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await M2mOsEngine.rotate(req.params.partnerId, { actor: principal(req), bits: (req.body || {}).bits || null }) }); } catch (err) { sendError(res, err); }
});

router.post('/partners/:partnerId/promote', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await M2mOsEngine.promote(req.params.partnerId, { actor: principal(req) }) }); } catch (err) { sendError(res, err); }
});

// ── Cycle & manifests ──────────────────────────────────────────────────────

router.post('/run', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await M2mOsEngine.runCycle({ partnerId: (req.body || {}).partnerId || null, actor: principal(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/manifests/verify', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await M2mOsEngine.verifyManifest(req.body || {}) }); } catch (err) { sendError(res, err); }
});

module.exports = router;
