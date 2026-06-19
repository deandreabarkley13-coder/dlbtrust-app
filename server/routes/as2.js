'use strict';

/**
 * AS2 Server Routes — Open Source AS2 for DLB Trust Treasury
 * Mounts at: /api/as2
 *
 * Provides:
 *   - Certificate management (generate keypairs, import partner certs)
 *   - Trading partner CRUD
 *   - Outbound AS2 messaging (send files to bank)
 *   - Inbound AS2 receive endpoint
 *   - Message tracking and MDN handling
 *   - Dashboard / status overview
 */

const express = require('express');
const router = express.Router();
const { AS2Server } = require('../integrations/as2/as2Server');
const { CertManager } = require('../integrations/as2/certManager');
const { PartnerManager } = require('../integrations/as2/partnerManager');

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/as2/dashboard — AS2 system overview
router.get('/dashboard', async (req, res) => {
  try {
    const data = await AS2Server.getDashboard();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CERTIFICATES
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/as2/certs/generate — generate a new RSA keypair + self-signed cert
// Body: { alias, commonName, organization, country, keySize, validDays }
router.post('/certs/generate', async (req, res) => {
  try {
    const result = await CertManager.generateKeypair(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/as2/certs/import — import a partner's public certificate
// Body: { alias, certificatePem }
router.post('/certs/import', async (req, res) => {
  try {
    const { alias, certificatePem } = req.body;
    if (!alias || !certificatePem) {
      return res.status(400).json({ success: false, error: 'alias and certificatePem required' });
    }
    const result = await CertManager.importPartnerCert(alias, certificatePem);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/as2/certs — list all certificates
router.get('/certs', async (req, res) => {
  try {
    const certs = await CertManager.listCerts({ certType: req.query.type });
    res.json({ success: true, count: certs.length, data: certs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/as2/certs/:alias — get certificate details
router.get('/certs/:alias', async (req, res) => {
  try {
    const cert = await CertManager.getCert(req.params.alias);
    if (!cert) return res.status(404).json({ success: false, error: 'Certificate not found' });
    res.json({ success: true, data: cert });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/as2/certs/:alias/export — export public certificate PEM (for sharing with partner)
router.get('/certs/:alias/export', async (req, res) => {
  try {
    const pem = await CertManager.exportPublicCert(req.params.alias);
    if (req.query.format === 'pem') {
      res.setHeader('Content-Type', 'application/x-pem-file');
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.alias}.pem"`);
      return res.send(pem);
    }
    res.json({ success: true, data: { alias: req.params.alias, certificate_pem: pem } });
  } catch (err) {
    res.status(404).json({ success: false, error: err.message });
  }
});

// POST /api/as2/certs/:alias/revoke — revoke a certificate
router.post('/certs/:alias/revoke', async (req, res) => {
  try {
    const cert = await CertManager.revokeCert(req.params.alias);
    res.json({ success: true, data: cert });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TRADING PARTNERS
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/as2/partners — create a trading partner
// Body: { as2Id, name, url, certAlias, encryptionAlg, signingAlg, requestMdn, signedMdn, mdnUrl, notes }
router.post('/partners', async (req, res) => {
  try {
    const partner = await PartnerManager.createPartner(req.body);
    res.json({ success: true, data: partner });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /api/as2/partners — list trading partners
router.get('/partners', async (req, res) => {
  try {
    const partners = await PartnerManager.listPartners({ status: req.query.status });
    res.json({ success: true, count: partners.length, data: partners });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/as2/partners/:id — get partner details
router.get('/partners/:id', async (req, res) => {
  try {
    const partner = await PartnerManager.getPartner(req.params.id);
    if (!partner) return res.status(404).json({ success: false, error: 'Partner not found' });
    res.json({ success: true, data: partner });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/as2/partners/:id — update partner
router.put('/partners/:id', async (req, res) => {
  try {
    const partner = await PartnerManager.updatePartner(req.params.id, req.body);
    res.json({ success: true, data: partner });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/as2/partners/:id/deactivate — deactivate partner
router.post('/partners/:id/deactivate', async (req, res) => {
  try {
    const partner = await PartnerManager.deactivatePartner(req.params.id);
    res.json({ success: true, data: partner });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGING — OUTBOUND
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/as2/send — send a file to a partner
// Body: { partnerId, payload (base64 or text), filename, contentType }
router.post('/send', async (req, res) => {
  try {
    const { partnerId, payload, filename, contentType } = req.body;
    if (!partnerId || !payload || !filename) {
      return res.status(400).json({ success: false, error: 'partnerId, payload, and filename required' });
    }

    // Decode base64 if flagged
    const content = req.body.base64 ? Buffer.from(payload, 'base64').toString('utf8') : payload;
    const result = await AS2Server.sendMessage(partnerId, content, filename, contentType);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGING — INBOUND (AS2 receive endpoint)
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/as2/receive — AS2 inbound endpoint (bank sends files here)
router.post('/receive', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
  try {
    const result = await AS2Server.receiveMessage(req.headers, req.body);

    if (result.mdn) {
      res.setHeader('Content-Type', result.mdn.contentType);
      res.setHeader('Message-ID', result.mdn.messageId);
      res.setHeader('AS2-From', process.env.AS2_LOCAL_AS2_ID || 'DLBTRUST-AS2');
      res.setHeader('AS2-To', req.headers['as2-from'] || '');
      return res.status(200).send(result.mdn.body);
    }

    res.status(200).json({ success: true, data: result });
  } catch (err) {
    console.error('[AS2] Receive error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE HISTORY
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/as2/messages — list AS2 messages
router.get('/messages', async (req, res) => {
  try {
    const { direction, partnerId, status, limit, offset } = req.query;
    const messages = await AS2Server.listMessages({
      direction, partnerId, status,
      limit: parseInt(limit, 10) || 50,
      offset: parseInt(offset, 10) || 0,
    });
    res.json({ success: true, count: messages.length, data: messages });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/as2/messages/:id — get specific message
router.get('/messages/:id', async (req, res) => {
  try {
    const msg = await AS2Server.getMessage(req.params.id);
    if (!msg) return res.status(404).json({ success: false, error: 'Message not found' });
    res.json({ success: true, data: msg });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
