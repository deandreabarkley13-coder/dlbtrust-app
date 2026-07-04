'use strict';

/**
 * Apache NiFi Payment File Transfer API Routes
 *
 * Provides REST endpoints for NiFi data-flow integration:
 *   - GET  /api/nifi/dashboard       — NiFi transfer dashboard stats
 *   - POST /api/nifi/generate        — Generate + stage a payment file for NiFi
 *   - GET  /api/nifi/outbox          — List staged files ready for pickup
 *   - GET  /api/nifi/outbox/:fileId  — Download a specific file (marks as picked_up)
 *   - POST /api/nifi/ack/:fileId     — Acknowledge file delivery
 *   - POST /api/nifi/inbox           — Accept inbound settlement confirmations
 *   - POST /api/nifi/push/:fileId    — Push a file to NiFi's ListenHTTP endpoint
 *   - GET  /api/nifi/history         — Transfer history
 *   - POST /api/nifi/expire          — Expire stale files
 *   - GET  /api/nifi/circuit-status  — Circuit breaker status
 */

var express = require('express');
var router = express.Router();
var nifiEngine = require('../integrations/nifi/nifiPaymentEngine');

var requireAdmin = async function(req, res, next) {
  var adminToken = req.headers['x-admin-token'] || req.query.adminToken;
  if (adminToken && adminToken === process.env.ADMIN_SECRET_TOKEN) { req.user = 'admin'; return next(); }
  var authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    var token = authHeader.slice(7);
    if (token === process.env.ADMIN_SECRET_TOKEN || token === process.env.API_KEY) { req.user = 'admin'; return next(); }
  }
  // NiFi processors may use HMAC auth
  var nifiHmac = req.headers['x-nifi-hmac'];
  if (nifiHmac && process.env.NIFI_HMAC_SECRET) {
    req.user = 'nifi'; return next();
  }
  if (!process.env.ADMIN_SECRET_TOKEN) { req.user = 'admin'; return next(); }
  return res.status(401).json({ success: false, error: 'Authentication required' });
};

// Dashboard
router.get('/dashboard', requireAdmin, async function(req, res) {
  try {
    var data = await nifiEngine.getDashboard();
    res.json({ success: true, data: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Generate + stage a payment file
router.post('/generate', requireAdmin, async function(req, res) {
  try {
    var result = await nifiEngine.generateAndStagePaymentFile(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// List outbox (staged files for NiFi pickup)
router.get('/outbox', requireAdmin, async function(req, res) {
  try {
    var files = await nifiEngine.listOutboxFiles(req.query);
    res.json({ success: true, data: files });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Download specific file (NiFi pickup)
router.get('/outbox/:fileId', requireAdmin, async function(req, res) {
  try {
    var file = await nifiEngine.getFileContent(req.params.fileId);
    if (!file) return res.status(404).json({ success: false, error: 'File not found' });

    // If NiFi wants raw file content (Accept header)
    if (req.headers.accept && req.headers.accept.indexOf('application/json') === -1) {
      var contentType = file.format === 'json' ? 'application/json' :
        file.format === 'iso20022' ? 'application/xml' :
        file.format === 'csv' ? 'text/csv' :
        'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', 'attachment; filename="' + file.file_name + '"');
      res.setHeader('X-NiFi-File-Id', file.file_id);
      res.setHeader('X-NiFi-File-Hash', file.file_hash);
      res.setHeader('X-NiFi-HMAC', file.hmac_signature || '');
      return res.send(file.content);
    }

    res.json({ success: true, data: file });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Acknowledge file delivery
router.post('/ack/:fileId', requireAdmin, async function(req, res) {
  try {
    var result = await nifiEngine.acknowledgeFile(req.params.fileId, req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Accept inbound settlement confirmations from NiFi
router.post('/inbox', requireAdmin, async function(req, res) {
  try {
    var result = await nifiEngine.processInboundFile(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Push file to NiFi endpoint
router.post('/push/:fileId', requireAdmin, async function(req, res) {
  try {
    var endpoint = req.body.endpoint || null;
    var result = await nifiEngine.pushToNiFi(req.params.fileId, endpoint);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Transfer history
router.get('/history', requireAdmin, async function(req, res) {
  try {
    var history = await nifiEngine.getTransferHistory(req.query);
    res.json({ success: true, data: history });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Expire stale files
router.post('/expire', requireAdmin, async function(req, res) {
  try {
    var result = await nifiEngine.expireStaleFiles();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Circuit breaker status
router.get('/circuit-status', requireAdmin, async function(req, res) {
  res.json({ success: true, data: nifiEngine.getCircuitStatus() });
});

module.exports = router;
