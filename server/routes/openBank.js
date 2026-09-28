'use strict';

/**
 * Open Bank REST API — /api/open-bank/v1
 *
 * OBP-style resource surface over the trust's Fineract core bank plus the Open
 * Banking Tracker directory. Reads are operator-gated; registering or verifying
 * a bank file drop is admin-gated and maker/checker (registrar != verifier).
 * No credentials are accepted on any route.
 */

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { OpenBankRestApiOsEngine, API_VERSION } = require('../integrations/os/openBankRestApiOsEngine');

const router = express.Router();
const operatorAuth = requireAuth({ role: 'operator' });
const adminAuth = requireAuth({ role: 'admin' });

function principal(req) {
  const user = req.user || {};
  return user.email || user.username || user.userId || user.sub || 'admin';
}

function sendError(res, err) {
  const status = err.status || err.statusCode || 400;
  res.status(status).json({ success: false, error: err.message, code: err.code || null, details: err.details || undefined });
}

const v = `/${API_VERSION}`;

router.get(`${v}`, operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: { apiVersion: API_VERSION, resources: ['banks', 'accounts', 'providers', 'providers/:id', 'file-drops', 'file-drops/:id/verify', 'tracker/index'] } });
  } catch (err) { sendError(res, err); }
});

router.get(`${v}/banks`, operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await OpenBankRestApiOsEngine.banks() }); } catch (err) { sendError(res, err); }
});

router.get(`${v}/accounts`, operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await OpenBankRestApiOsEngine.accounts() }); } catch (err) { sendError(res, err); }
});

router.get(`${v}/tracker/index`, operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await OpenBankRestApiOsEngine.trackerIndex({ limit: Number(req.query.limit) || 500 }) }); } catch (err) { sendError(res, err); }
});

router.get(`${v}/providers`, operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await OpenBankRestApiOsEngine.providers() }); } catch (err) { sendError(res, err); }
});

router.get(`${v}/providers/:id`, operatorAuth, async (req, res) => {
  try {
    const [p] = await OpenBankRestApiOsEngine.providers({ providerId: req.params.id });
    if (!p) return res.status(404).json({ success: false, error: 'Provider not imported' });
    res.json({ success: true, data: p });
  } catch (err) { sendError(res, err); }
});

router.post(`${v}/providers/:id/import`, adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await OpenBankRestApiOsEngine.importProvider({ providerId: req.params.id, actor: principal(req) }) }); } catch (err) { sendError(res, err); }
});

router.post(`${v}/providers/:id/seed-discovery`, adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await OpenBankRestApiOsEngine.seedDiscovery({ providerId: req.params.id, actor: principal(req) }) }); } catch (err) { sendError(res, err); }
});

router.get(`${v}/file-drops`, operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await OpenBankRestApiOsEngine.fileDrops({ providerId: req.query.providerId || null, status: req.query.status || null }) }); } catch (err) { sendError(res, err); }
});

router.post(`${v}/file-drops`, adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const b = req.body || {};
    res.status(201).json({ success: true, data: await OpenBankRestApiOsEngine.registerFileDrop({
      providerId: b.providerId, protocol: b.protocol, endpoint: b.endpoint, as2Id: b.as2Id, clientId: b.clientId, mdnUrl: b.mdnUrl, notes: b.notes,
      fromDiscovery: b.fromDiscovery === true, actor: principal(req),
    }) });
  } catch (err) { sendError(res, err); }
});

router.post(`${v}/file-drops/:id/verify`, adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await OpenBankRestApiOsEngine.verifyFileDrop({ fileDropId: req.params.id, actor: principal(req) }) }); } catch (err) { sendError(res, err); }
});

module.exports = router;
