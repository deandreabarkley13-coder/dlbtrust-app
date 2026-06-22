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
const { validateRouting } = require('../integrations/ach/nachaGenerator');

// ─── Admin Auth Middleware ────────────────────────────────────────────────────
// Protects sensitive ACH operations (transmit, accept, settle, returns, reconciliation, AS2 config)
const requireAdmin = (req, res, next) => {
  const token = req.headers['x-admin-token'] || req.query.adminToken;
  if (!token || token !== process.env.ADMIN_SECRET_TOKEN) {
    return res.status(401).json({ success: false, error: 'Admin authentication required. Provide x-admin-token header.' });
  }
  next();
};

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
    const { effectiveDate, secCode, description, entries, createdBy, paymentType } = req.body;
    if (!entries || !Array.isArray(entries) || !entries.length) {
      return res.status(400).json({ success: false, error: 'entries array is required' });
    }

    const result = await PaymentOrchestrator.createDisbursementWithAccounting({
      entries, effectiveDate, secCode, description,
      paymentType: paymentType || 'vendor_payment',
      createdBy,
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
    res.json({ success: true, data: result });
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

module.exports = router;
