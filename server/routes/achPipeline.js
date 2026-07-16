'use strict';

/**
 * ACH Pipeline Routes — NACHA generation + AS2 transmission
 * Mounts at: /api/ach-pipeline
 *
 * Replaces OpenACH Docker dependency with direct NACHA file generation
 * and AS2 protocol delivery to the bank.
 */

const express = require('express');
const router = express.Router();
const { ACHEngine } = require('../integrations/ach/achEngine');
const { AS2Client } = require('../integrations/ach/as2Client');
const { PaymentOrchestrator } = require('../integrations/ach/paymentOrchestrator');
const { ACHAcknowledgement } = require('../integrations/ach/achAcknowledgement');
const { ACHReconciliation } = require('../integrations/ach/achReconciliation');
const { AS2Setup } = require('../integrations/ach/as2Setup');
const { AS2Partners } = require('../integrations/ach/as2Partners');
const { OpenBankApi } = require('../integrations/ach/openBankApi');
const pool = require('../integrations/bonds/pgPool');
const { validateRouting } = require('../integrations/ach/nachaGenerator');
const { ApiCredentials } = require('../integrations/ach/apiCredentials');

// ─── Auth Middleware ─────────────────────────────────────────────────────────
// Accepts: x-admin-token header, Authorization: Bearer <api_key>, or X-API-Key header.
const requireAuth = async (req, res, next) => {
  // 1. Try admin token (legacy)
  const adminToken = req.headers['x-admin-token'] || req.query.adminToken;
  if (adminToken && adminToken === process.env.ADMIN_SECRET_TOKEN) {
    req.authMethod = 'admin_token';
    return next();
  }

  // 2. Try API key (Bearer or X-API-Key)
  let apiKey = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    apiKey = authHeader.slice(7).trim();
  } else if (req.headers['x-api-key']) {
    apiKey = req.headers['x-api-key'];
  }

  if (apiKey) {
    try {
      const cred = await ApiCredentials.validate(apiKey);
      if (cred) {
        req.authMethod = 'api_key';
        req.apiCredential = cred;
        return next();
      }
    } catch (err) { /* fall through to 401 */ }
  }

  return res.status(401).json({
    success: false,
    error: 'Authentication required. Use x-admin-token, Authorization: Bearer <api_key>, or X-API-Key header.',
  });
};

// Keep requireAdmin as alias for backwards compat
const requireAdmin = requireAuth;

// ─── GET /api/ach-pipeline/status ─────────────────────────────────────────────
// Full pipeline status: AS2 config, connectivity, batch stats
router.get('/status', async (req, res) => {
  try {
    const status = await ACHEngine.getPipelineStatus();
    res.json({ success: true, data: status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/ach-pipeline/as2/config ─────────────────────────────────────────
// AS2 configuration status (no secrets exposed)
router.get('/as2/config', (req, res) => {
  const config = AS2Client.getConfigStatus();
  res.json({ success: true, data: config });
});

// ─── GET /api/ach-pipeline/as2/test ───────────────────────────────────────────
// Test connectivity to bank's AS2 endpoint
router.get('/as2/test', async (req, res) => {
  try {
    const result = await AS2Client.testConnection();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/ach-pipeline/batches ───────────────────────────────────────────
// Create a new ACH batch with entries
// Body: {
//   effectiveDate: "2026-06-20",
//   secCode: "CCD" | "PPD",
//   description: "PAYMENT",
//   entries: [{
//     receivingRouting: "241075470",
//     accountNumber: "123456789",
//     amountCents: 50000,
//     transactionCode: "22",  // 22=credit checking, 27=debit checking, 32=credit savings
//     individualId: "EMP-001",
//     individualName: "John Doe",
//     memo: "Trust distribution"
//   }]
// }
router.post('/batches', requireAdmin, async (req, res) => {
  try {
    const { effectiveDate, secCode, description, entries, createdBy, paymentType, partnerId } = req.body;
    if (!entries || !Array.isArray(entries) || !entries.length) {
      return res.status(400).json({ success: false, error: 'entries array is required' });
    }

    const result = await PaymentOrchestrator.createDisbursementWithAccounting({
      entries, effectiveDate, secCode, description,
      paymentType: paymentType || 'vendor_payment',
      createdBy, partnerId,
    });
    res.json({
      success: true,
      data: result.batch,
      journal_entry: result.journal_entry ? { entry_id: result.journal_entry.entry_id } : null,
      accounting_integrated: result.accounting_integrated,
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── POST /api/ach-pipeline/batches/disburse ──────────────────────────────────
// Create a disbursement batch from CRM contacts
// Body: { contactIds: ["CRM-INV-..."], amountCents: 50000, description: "Trust Dist", effectiveDate: "..." }
router.post('/batches/disburse', requireAdmin, async (req, res) => {
  try {
    const batch = await ACHEngine.createDisbursementBatch(req.body);
    res.json({ success: true, data: batch });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── POST /api/ach-pipeline/k1-disburse ─────────────────────────────────────
// Disburse K-1 amounts to beneficiaries via ACH
// Body: { returnId, taxYear, effectiveDate }
router.post('/k1-disburse', requireAdmin, async (req, res) => {
  try {
    const { returnId, taxYear, effectiveDate } = req.body;
    if (!returnId) {
      return res.status(400).json({ success: false, error: 'returnId is required' });
    }
    const result = await PaymentOrchestrator.disburseK1({
      returnId,
      taxYear: taxYear || new Date().getFullYear(),
      effectiveDate,
      createdBy: 'admin',
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── POST /api/ach-pipeline/route-payment ────────────────────────────────────
// Smart payment routing — auto-selects ACH or Wire based on amount/urgency
// Body: { entries, effectiveDate, secCode, description, paymentType, urgent, forceChannel,
//         beneficiaryRouting, beneficiaryAccount, beneficiaryBankName }
router.post('/route-payment', requireAdmin, async (req, res) => {
  try {
    const result = await PaymentOrchestrator.routePayment({
      ...req.body,
      createdBy: 'admin',
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── GET /api/ach-pipeline/payment-summary ──────────────────────────────────
// Payment summary for dashboard
router.get('/payment-summary', async (req, res) => {
  try {
    const summary = await PaymentOrchestrator.getPaymentSummary();
    res.json({ success: true, data: summary });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/ach-pipeline/batches ────────────────────────────────────────────
// List all batches with optional filters
router.get('/batches', async (req, res) => {
  try {
    const { status, fromDate, toDate, limit, offset } = req.query;
    const batches = await ACHEngine.listBatches({
      status,
      fromDate,
      toDate,
      limit: parseInt(limit, 10) || 50,
      offset: parseInt(offset, 10) || 0,
    });
    res.json({ success: true, count: batches.length, data: batches });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/ach-pipeline/batches/:id ────────────────────────────────────────
// Get a specific batch with entries
router.get('/batches/:id', async (req, res) => {
  try {
    const batch = await ACHEngine.getBatch(req.params.id);
    if (!batch) return res.status(404).json({ success: false, error: 'Batch not found' });
    res.json({ success: true, data: batch });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/ach-pipeline/batches/:id/download ───────────────────────────────
// Download the NACHA file for a batch
router.get('/batches/:id/download', async (req, res) => {
  try {
    const batch = await ACHEngine.downloadBatch(req.params.id);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${batch.filename}"`);
    res.send(batch.nacha_content);
  } catch (err) {
    res.status(404).json({ success: false, error: err.message });
  }
});

// ─── POST /api/ach-pipeline/batches/:id/transmit ──────────────────────────────
// Transmit a batch via AS2 to the bank
router.post('/batches/:id/transmit', requireAdmin, async (req, res) => {
  try {
    const result = await ACHEngine.transmitBatch(req.params.id);
    try { var journal = require('../integrations/backup/transactionJournal'); journal.record('ach_transmit', { batch_id: req.params.id, result: result.status || 'transmitted' }, 'api'); } catch(e) {}
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/ach-pipeline/batches/:id/retry ──────────────────────────────────
// Reset a failed batch back to pending so it can be retransmitted
router.post('/batches/:id/retry', requireAdmin, async (req, res) => {
  try {
    const batch = await ACHEngine.getBatch(req.params.id);
    if (!batch) return res.status(404).json({ success: false, error: 'Batch not found' });
    if (batch.status !== 'failed') {
      return res.status(400).json({ success: false, error: `Cannot retry batch in '${batch.status}' status — only 'failed' batches can be retried` });
    }
    const result = await pool.query(
      `UPDATE ach_batches SET status = 'pending', error_message = NULL, updated_at = NOW() WHERE batch_id = $1 RETURNING *`,
      [req.params.id]
    );
    await pool.query(
      `UPDATE ach_entries SET status = 'pending' WHERE batch_id = $1 AND status != 'settled'`,
      [req.params.id]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/ach-pipeline/batches/:id/cancel ────────────────────────────────
// Cancel a pending batch
router.post('/batches/:id/cancel', requireAdmin, async (req, res) => {
  try {
    const batch = await ACHEngine.cancelBatch(req.params.id);
    res.json({ success: true, data: batch });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── GET /api/ach-pipeline/batches/:id/transmissions ──────────────────────────
// Get transmission history for a batch
router.get('/batches/:id/transmissions', async (req, res) => {
  try {
    const txns = await ACHEngine.getTransmissions(req.params.id);
    res.json({ success: true, data: txns });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/ach-pipeline/validate ──────────────────────────────────────────
// Validate a NACHA file content string
router.post('/validate', async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ success: false, error: 'content is required' });
    const result = ACHEngine.validateNACHA(content);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/ach-pipeline/validate-routing ──────────────────────────────────
// Validate a routing number
router.post('/validate-routing', (req, res) => {
  const { routingNumber } = req.body;
  if (!routingNumber) return res.status(400).json({ success: false, error: 'routingNumber required' });
  const valid = validateRouting(String(routingNumber));
  res.json({ success: true, data: { routing_number: routingNumber, valid } });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ACH LIFECYCLE — Acceptance, Settlement, Returns, Reconciliation
// ═══════════════════════════════════════════════════════════════════════════════

// ─── POST /api/ach-pipeline/batches/:id/accept ────────────────────────────────
// Record bank acceptance for a transmitted batch
router.post('/batches/:id/accept', requireAdmin, async (req, res) => {
  try {
    const { transmissionId, messageId, ackType, disposition, rawResponse } = req.body;
    const batch = await ACHEngine.acceptBatch(req.params.id, {
      transmissionId, messageId, ackType, disposition, rawResponse,
    });
    res.json({ success: true, data: batch });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── POST /api/ach-pipeline/batches/:id/settle ────────────────────────────────
// Record settlement for an accepted/transmitted batch
router.post('/batches/:id/settle', requireAdmin, async (req, res) => {
  try {
    const { settlementDate } = req.body;
    const batch = await ACHEngine.settleBatch(req.params.id, { settlementDate });
    res.json({ success: true, data: batch });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── POST /api/ach-pipeline/batches/:id/returns ───────────────────────────────
// Ingest return entries for a batch
// Body: { returns: [{ entrySequence, traceNumber, returnCode, returnReason, returnAmountCents, returnDate, addendaInfo }], returnFileRef }
router.post('/batches/:id/returns', requireAdmin, async (req, res) => {
  try {
    const { returns, returnFileRef } = req.body;
    if (!returns || !Array.isArray(returns) || !returns.length) {
      return res.status(400).json({ success: false, error: 'returns array is required' });
    }
    for (const ret of returns) {
      if (!ret.returnCode || !ret.returnReason) {
        return res.status(400).json({ success: false, error: 'Each return requires returnCode and returnReason' });
      }
    }
    const result = await ACHEngine.processReturns(req.params.id, returns, { returnFileRef });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── GET /api/ach-pipeline/batches/:id/returns ────────────────────────────────
// Get return history for a batch
router.get('/batches/:id/returns', async (req, res) => {
  try {
    const returns = await ACHEngine.getReturns(req.params.id);
    res.json({ success: true, data: returns });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/ach-pipeline/batches/:id/entries ────────────────────────────────
// Get entry-level status for a batch (including return info)
router.get('/batches/:id/entries', async (req, res) => {
  try {
    const entries = await ACHEngine.getEntryStatuses(req.params.id);
    res.json({ success: true, count: entries.length, data: entries });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/ach-pipeline/batches/:id/acknowledgements ───────────────────────
// Get acknowledgement history for a batch
router.get('/batches/:id/acknowledgements', async (req, res) => {
  try {
    const acks = await ACHAcknowledgement.listForBatch(req.params.id);
    res.json({ success: true, data: acks });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/ach-pipeline/acknowledgements/mdn ─────────────────────────────
// Ingest an AS2 MDN (delivery receipt) from the bank
// Body: { batchId, messageId, disposition, rawContent, transmissionId }
router.post('/acknowledgements/mdn', requireAdmin, async (req, res) => {
  try {
    const { batchId, messageId, disposition, rawContent, transmissionId } = req.body;
    if (!batchId || !disposition) {
      return res.status(400).json({ success: false, error: 'batchId and disposition are required' });
    }
    const ack = await ACHAcknowledgement.processMDN({
      batchId, messageId, disposition, rawContent, transmissionId,
    });
    res.json({ success: true, data: ack });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── POST /api/ach-pipeline/acknowledgements/file-ack ─────────────────────────
// Ingest a bank file-level acknowledgement
// Body: { batchId, status, rawResponse, errorDescription }
router.post('/acknowledgements/file-ack', requireAdmin, async (req, res) => {
  try {
    const { batchId, status, rawResponse, errorDescription } = req.body;
    if (!batchId) {
      return res.status(400).json({ success: false, error: 'batchId is required' });
    }
    const ack = await ACHAcknowledgement.processFileAck({
      batchId, status, rawResponse, errorDescription,
    });
    res.json({ success: true, data: ack });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── POST /api/ach-pipeline/acknowledgements/bank-ack ─────────────────────────
// Ingest a bank-level batch acknowledgement
// Body: { batchId, status, messageId, rawResponse, disposition, errorDescription }
router.post('/acknowledgements/bank-ack', requireAdmin, async (req, res) => {
  try {
    const { batchId, status, messageId, rawResponse, disposition, errorDescription } = req.body;
    if (!batchId) {
      return res.status(400).json({ success: false, error: 'batchId is required' });
    }
    const ack = await ACHAcknowledgement.processBankAck({
      batchId, status, messageId, rawResponse, disposition, errorDescription,
    });
    res.json({ success: true, data: ack });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── POST /api/ach-pipeline/returns/ingest ────────────────────────────────────
// Bulk ingest a return file containing returns for multiple batches
// Body: { returns: [{ batchId, entries: [{ entrySequence, traceNumber, returnCode, returnReason, ... }] }], returnFileRef }
router.post('/returns/ingest', requireAdmin, async (req, res) => {
  try {
    const { returns, returnFileRef } = req.body;
    if (!returns || !Array.isArray(returns) || !returns.length) {
      return res.status(400).json({ success: false, error: 'returns array is required' });
    }

    const results = [];
    const errors = [];

    for (const batch of returns) {
      if (!batch.batchId || !batch.entries || !batch.entries.length) {
        errors.push({ batchId: batch.batchId || 'unknown', error: 'batchId and entries are required' });
        continue;
      }
      try {
        const result = await ACHEngine.processReturns(batch.batchId, batch.entries, { returnFileRef });
        results.push(result);
      } catch (err) {
        errors.push({ batchId: batch.batchId, error: err.message });
      }
    }

    res.json({
      success: true,
      data: {
        processed: results.length,
        failed: errors.length,
        results,
        errors: errors.length ? errors : undefined,
      },
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── GET /api/ach-pipeline/settlement/status ──────────────────────────────────
// Settlement overview for dashboard
router.get('/settlement/status', async (req, res) => {
  try {
    const overview = await ACHReconciliation.getSettlementOverview();
    res.json({ success: true, data: overview });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/ach-pipeline/reconciliation/run ────────────────────────────────
// Trigger a settlement reconciliation job
// Body: { settledItems: [{ batchId, settlementDate, settledAmountCents }], returnedItems: [{ batchId, entries }] }
router.post('/reconciliation/run', requireAdmin, async (req, res) => {
  try {
    const { settledItems, returnedItems } = req.body;
    const result = await ACHReconciliation.runReconciliation({ settledItems, returnedItems });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/ach-pipeline/reconciliation/history ─────────────────────────────
// List reconciliation run history
router.get('/reconciliation/history', async (req, res) => {
  try {
    const { limit, offset } = req.query;
    const reconciliations = await ACHReconciliation.listReconciliations({
      limit: parseInt(limit, 10) || 20,
      offset: parseInt(offset, 10) || 0,
    });
    res.json({ success: true, count: reconciliations.length, data: reconciliations });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/ach-pipeline/reconciliation/:id ─────────────────────────────────
// Get details of a specific reconciliation run
router.get('/reconciliation/:id', async (req, res) => {
  try {
    const recon = await ACHReconciliation.getReconciliation(req.params.id);
    if (!recon) return res.status(404).json({ success: false, error: 'Reconciliation not found' });
    res.json({ success: true, data: recon });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AS2 SETUP & CREDENTIAL MANAGEMENT (admin-only)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /api/ach-pipeline/as2/setup ──────────────────────────────────────────
// Get saved AS2 configuration (no secrets exposed)
router.get('/as2/setup', requireAdmin, async (req, res) => {
  try {
    const config = await AS2Setup.getConfig();
    res.json({ success: true, data: config });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/ach-pipeline/as2/setup ─────────────────────────────────────────
// Save AS2 partner configuration and certificates
// Body: { partnerUrl, partnerAs2Id, localAs2Id?, signingCert?, signingKey?,
//         partnerCert?, encryptionAlg?, signingAlg?, requestMdn?, mdnUrl? }
router.post('/as2/setup', requireAdmin, async (req, res) => {
  try {
    const result = await AS2Setup.saveConfig(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── GET /api/ach-pipeline/as2/validate ───────────────────────────────────────
// Check if AS2 config is complete enough for transmission
router.get('/as2/validate', requireAdmin, async (req, res) => {
  try {
    const result = AS2Setup.validateConfig();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/ach-pipeline/as2/generate-cert ─────────────────────────────────
// Generate a self-signed certificate for AS2 signing (for initial setup)
router.post('/as2/generate-cert', requireAdmin, async (req, res) => {
  try {
    const { commonName, orgName, validDays } = req.body;
    const result = await AS2Setup.generateSelfSignedCert({ commonName, orgName, validDays });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/ach-pipeline/as2/load-saved ────────────────────────────────────
// Load previously saved AS2 config from DB into environment (normally called on startup)
router.post('/as2/load-saved', requireAdmin, async (req, res) => {
  try {
    const config = await AS2Setup.loadSavedConfig();
    res.json({
      success: true,
      data: config ? { loaded: true, config } : { loaded: false, message: 'No saved configuration found' },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Multi-Partner Management (AS2 + REST API) ───────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// ─── POST /api/ach-pipeline/partners ──────────────────────────────────────────
// Register a new AS2 partner
router.post('/partners', requireAdmin, async (req, res) => {
  try {
    const partner = await AS2Partners.register(req.body);
    res.json({ success: true, data: partner });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── GET /api/ach-pipeline/partners ───────────────────────────────────────────
// List all AS2 partners
router.get('/partners', async (req, res) => {
  try {
    const activeOnly = req.query.active === 'true';
    const partners = await AS2Partners.listPartners({ activeOnly });
    res.json({ success: true, data: partners, count: partners.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/ach-pipeline/partners/:partnerId ────────────────────────────────
// Get a specific partner's configuration
router.get('/partners/:partnerId', async (req, res) => {
  try {
    const partner = await AS2Partners.getPartner(req.params.partnerId);
    if (!partner) {
      return res.status(404).json({ success: false, error: `Partner not found: ${req.params.partnerId}` });
    }
    res.json({ success: true, data: partner });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── PUT /api/ach-pipeline/partners/:partnerId ────────────────────────────────
// Update an existing partner's configuration
router.put('/partners/:partnerId', requireAdmin, async (req, res) => {
  try {
    const partner = await AS2Partners.update(req.params.partnerId, req.body);
    res.json({ success: true, data: partner });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── DELETE /api/ach-pipeline/partners/:partnerId ─────────────────────────────
// Deactivate a partner (soft delete)
router.delete('/partners/:partnerId', requireAdmin, async (req, res) => {
  try {
    const partner = await AS2Partners.deactivate(req.params.partnerId);
    res.json({ success: true, data: partner, message: 'Partner deactivated' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── POST /api/ach-pipeline/partners/:partnerId/activate ──────────────────────
// Reactivate a deactivated partner
router.post('/partners/:partnerId/activate', requireAdmin, async (req, res) => {
  try {
    const partner = await AS2Partners.activate(req.params.partnerId);
    res.json({ success: true, data: partner, message: 'Partner reactivated' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── GET /api/ach-pipeline/partners/:partnerId/validate ───────────────────────
// Check if a partner's config is complete for transmission
router.get('/partners/:partnerId/validate', requireAdmin, async (req, res) => {
  try {
    const result = await AS2Partners.validatePartner(req.params.partnerId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── POST /api/ach-pipeline/partners/:partnerId/generate-cert ─────────────────
// Generate a self-signed signing keypair for a specific partner
router.post('/partners/:partnerId/generate-cert', requireAdmin, async (req, res) => {
  try {
    const { commonName } = req.body;
    const result = await AS2Partners.generateCert(req.params.partnerId, { commonName });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/ach-pipeline/partners/:partnerId/test ──────────────────────────
// Test connectivity to a partner's endpoint (AS2 or REST API)
router.post('/partners/:partnerId/test', requireAdmin, async (req, res) => {
  try {
    const config = await AS2Partners.getPartnerConfig(req.params.partnerId);
    if (!config) {
      return res.status(404).json({ success: false, error: `Partner not found or inactive: ${req.params.partnerId}` });
    }
    const result = (config.protocol === 'rest_api')
      ? await OpenBankApi.testConnection(config)
      : await AS2Client.testConnection(config);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/ach-pipeline/partners/migrate-legacy ───────────────────────────
// Migrate existing single-partner as2_config to the multi-partner registry
router.post('/partners/migrate-legacy', requireAdmin, async (req, res) => {
  try {
    const result = await AS2Partners.migrateFromLegacyConfig();
    if (result) {
      res.json({ success: true, data: { migrated: true, partner_id: result } });
    } else {
      res.json({ success: true, data: { migrated: false, message: 'Nothing to migrate (no legacy config or partners already exist)' } });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Webhook Receiver ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// ─── POST /api/ach-pipeline/webhooks/:partnerId ───────────────────────────────
// Receive status webhooks from bank/partner REST APIs.
// No admin auth — uses webhook signature verification instead.
router.post('/webhooks/:partnerId', async (req, res) => {
  try {
    const { partnerId } = req.params;
    const config = await AS2Partners.getPartnerConfig(partnerId);
    if (!config) {
      return res.status(404).json({ success: false, error: 'Unknown partner' });
    }

    const signature = req.headers['x-signature'] || req.headers['x-hub-signature-256'] || '';
    const event = OpenBankApi.processWebhook(partnerId, req.body, signature, config);

    if (event.mapped_status && event.batch_id) {
      const { ACHEngine: Engine } = require('../integrations/ach/achEngine');
      try {
        switch (event.mapped_status) {
          case 'accepted':
            await Engine.acceptBatch(event.batch_id, { source: 'webhook', skipAckRecord: false });
            break;
          case 'settled':
            await Engine.settleBatch(event.batch_id, {
              settlementDate: event.settlement_date || new Date().toISOString().split('T')[0],
              source: 'webhook',
            });
            break;
          case 'returned':
            if (event.return_code) {
              await Engine.processReturns(event.batch_id, [{
                returnCode: event.return_code,
                returnReason: event.return_reason || 'Bank return via webhook',
                amountCents: event.amount_cents,
              }], { source: 'webhook' });
            }
            break;
        }
      } catch (stateErr) {
        console.warn(`[Webhook] State transition failed for ${event.batch_id}:`, stateErr.message);
      }
    }

    res.json({ success: true, received: true, event_type: event.event_type, mapped_status: event.mapped_status });
  } catch (err) {
    if (err.message === 'Invalid webhook signature') {
      return res.status(401).json({ success: false, error: 'Invalid webhook signature' });
    }
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── API Credential Management ──────────────────────────────────────────────

// POST /api/ach-pipeline/credentials — Generate new API key pair
router.post('/credentials', requireAdmin, async (req, res) => {
  try {
    const { label, scopes, expiresIn } = req.body;
    const result = await ApiCredentials.generate({
      label: label || 'DLBTrust API Key',
      scopes,
      expiresIn,
      createdBy: req.apiCredential ? req.apiCredential.label : 'admin',
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /api/ach-pipeline/credentials — List all API credentials
router.get('/credentials', requireAdmin, async (req, res) => {
  try {
    const activeOnly = req.query.active === 'true';
    const credentials = await ApiCredentials.list({ activeOnly });
    res.json({ success: true, data: credentials });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/ach-pipeline/credentials/:keyId — Revoke an API credential
router.delete('/credentials/:keyId', requireAdmin, async (req, res) => {
  try {
    const result = await ApiCredentials.revoke(req.params.keyId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(404).json({ success: false, error: err.message });
  }
});

// POST /api/ach-pipeline/credentials/:keyId/rotate — Rotate a credential
router.post('/credentials/:keyId/rotate', requireAdmin, async (req, res) => {
  try {
    const result = await ApiCredentials.rotate(req.params.keyId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(404).json({ success: false, error: err.message });
  }
});

// ─── File Exports ───────────────────────────────────────────────────────────

// GET /api/ach-pipeline/exports — List exported NACHA files
router.get('/exports', requireAdmin, async (req, res) => {
  try {
    const { partnerId, date } = req.query;
    const exports = OpenBankApi.listExports(partnerId, date);
    res.json({ success: true, data: exports, count: exports.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/ach-pipeline/exports/:partnerId/:date/:filename — Download exported file
router.get('/exports/:partnerId/:date/:filename', requireAdmin, (req, res) => {
  const { partnerId, date, filename } = req.params;
  const nodePath = require('path');
  const nodeFs = require('fs');
  const exportBase = nodePath.resolve(nodePath.join(__dirname, '..', '..', 'data', 'ach-exports'));
  const safePath = nodePath.resolve(nodePath.join(exportBase, partnerId, date, filename));
  if (!safePath.startsWith(exportBase)) {
    return res.status(403).json({ success: false, error: 'Access denied' });
  }
  if (!nodeFs.existsSync(safePath)) {
    return res.status(404).json({ success: false, error: 'File not found' });
  }
  res.download(safePath, filename);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── HTTPS Receive Endpoint (Self-Hosted REST API) ───────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/ach-pipeline/receive — Accept NACHA file via HTTPS
// This is the platform's own secure REST API endpoint for receiving ACH files.
// Used when the default transmission mode is 'remote' and the partner URL
// points to the platform itself (self-transmit via HTTPS).
router.post('/receive', requireAdmin, async (req, res) => {
  try {
    const { filename, content, content_type, originator_id, submitted_at, metadata } = req.body;
    if (!content) {
      return res.status(400).json({ success: false, error: 'Missing NACHA file content' });
    }

    const nachaFilename = filename || `ACH-${Date.now()}.ach`;
    const partnerId = (metadata && metadata.partner_id) || originator_id || 'DLBTRUST-DIRECT';

    // Validate NACHA structure
    const validation = OpenBankApi._validateNacha ? OpenBankApi._validateNacha(content) : { valid: true };
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: 'NACHA validation failed',
        issues: validation.issues,
      });
    }

    // Export the file securely
    const exportResult = OpenBankApi._exportFile(content, nachaFilename, partnerId);

    const receiptId = `RCV-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    console.log(`[Receive] HTTPS file received: ${nachaFilename} from ${partnerId} → ${exportResult.export_path}`);

    res.json({
      success: true,
      status: 'received',
      receipt_id: receiptId,
      batch_id: receiptId,
      filename: nachaFilename,
      export_path: exportResult.export_path,
      file_size: exportResult.file_size,
      entry_count: validation.entryCount || 0,
      total_debit: validation.totalDebit || 0,
      total_credit: validation.totalCredit || 0,
      received_at: new Date().toISOString(),
      protocol: 'https',
      message: 'NACHA file received and exported via secure HTTPS REST API.',
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Startup: ensure default DLBTRUST-DIRECT partner exists ─────────────────
(async () => {
  try {
    await pool.query(`
      INSERT INTO as2_partners (partner_id, partner_name, protocol, partner_url, is_default, active)
      VALUES ('DLBTRUST-DIRECT', 'DLB Trust Direct', 'rest_api', 'direct', TRUE, TRUE)
      ON CONFLICT (partner_id) DO UPDATE SET active = TRUE, updated_at = NOW()
    `);
  } catch (e) { /* table may not exist yet — migration will create it */ }
})();

module.exports = router;
