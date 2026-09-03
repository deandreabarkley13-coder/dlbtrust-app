'use strict';

/**
 * MFT OS API — /api/mft-os
 *
 * Building a file is a read of the trust's own intent, so operators may do
 * it. Releasing, transmitting and settling move or confirm money, so they are
 * operator-gated and rate-limited, and the engine enforces that the builder
 * is never the releaser. Channels are infrastructure: admin only.
 */

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { MftOsEngine } = require('../integrations/os/mftOsEngine');

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
  try { res.json({ success: true, data: await MftOsEngine.status() }); } catch (err) { sendError(res, err); }
});

// ── Channels ───────────────────────────────────────────────────────────────

router.get('/channels', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await MftOsEngine.channels() }); } catch (err) { sendError(res, err); }
});

router.get('/channels/:channelId', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await MftOsEngine.channel(req.params.channelId) }); } catch (err) { sendError(res, err); }
});

router.post('/channels', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    const data = await MftOsEngine.registerChannel({
      channelId: body.channelId || null,
      name: body.name,
      bankName: body.bankName || null,
      fileTypes: Array.isArray(body.fileTypes) ? body.fileTypes : undefined,
      config: body.config || {},
      createdBy: principal(req),
    });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/channels/:channelId/status', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    res.json({ success: true, data: await MftOsEngine.setChannelStatus(req.params.channelId, (req.body || {}).status, principal(req)) });
  } catch (err) { sendError(res, err); }
});

/** Read the bank's acknowledgements and returns off the channel. */
router.post('/channels/:channelId/collect', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    res.json({ success: true, data: await MftOsEngine.collect(req.params.channelId, { actor: principal(req) }) });
  } catch (err) { sendError(res, err); }
});

// ── Files ──────────────────────────────────────────────────────────────────

router.get('/files', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await MftOsEngine.list({
      channelId: req.query.channelId || null,
      fileType: req.query.fileType || null,
      status: req.query.status || null,
      sourceRef: req.query.sourceRef || null,
      limit: req.query.limit,
    }) });
  } catch (err) { sendError(res, err); }
});

router.get('/files/:fileId', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await MftOsEngine.get(req.params.fileId) }); } catch (err) { sendError(res, err); }
});

router.get('/files/:fileId/content', operatorAuth, async (req, res) => {
  try {
    const file = await MftOsEngine.get(req.params.fileId, { withContent: true });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('X-Content-SHA256', file.contentHash);
    res.send(file.content);
  } catch (err) { sendError(res, err); }
});

router.get('/files/:fileId/events', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await MftOsEngine.events(req.params.fileId) }); } catch (err) { sendError(res, err); }
});

router.get('/files/:fileId/verify', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await MftOsEngine.verify(req.params.fileId) }); } catch (err) { sendError(res, err); }
});

router.post('/files', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    const data = await MftOsEngine.build({
      channelId: body.channelId || 'default',
      fileType: body.fileType,
      entries: body.entries,
      effectiveDate: body.effectiveDate || null,
      entryDescription: body.entryDescription || null,
      memo: body.memo || null,
      builtBy: principal(req),
    });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/files/:fileId/approve', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await MftOsEngine.approve(req.params.fileId, principal(req)) }); } catch (err) { sendError(res, err); }
});

router.post('/files/:fileId/transmit', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    res.json({ success: true, data: await MftOsEngine.transmit(req.params.fileId, { actor: principal(req), force: (req.body || {}).force === true }) });
  } catch (err) { sendError(res, err); }
});

router.post('/files/:fileId/settle', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    res.json({ success: true, data: await MftOsEngine.settle(req.params.fileId, { actor: principal(req), bankReference: (req.body || {}).bankReference }) });
  } catch (err) { sendError(res, err); }
});

router.post('/files/:fileId/reject', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    res.json({ success: true, data: await MftOsEngine.reject(req.params.fileId, principal(req), (req.body || {}).reason || null) });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
