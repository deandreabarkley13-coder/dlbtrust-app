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
const { validateRouting } = require('../integrations/ach/nachaGenerator');

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
router.post('/batches', async (req, res) => {
  try {
    const { effectiveDate, secCode, description, entries, createdBy } = req.body;
    if (!entries || !Array.isArray(entries) || !entries.length) {
      return res.status(400).json({ success: false, error: 'entries array is required' });
    }

    const batch = await ACHEngine.createBatch(
      { effectiveDate, secCode, description, createdBy },
      entries
    );
    res.json({ success: true, data: batch });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── POST /api/ach-pipeline/batches/disburse ──────────────────────────────────
// Create a disbursement batch from CRM contacts
// Body: { contactIds: ["CRM-INV-..."], amountCents: 50000, description: "Trust Dist", effectiveDate: "..." }
router.post('/batches/disburse', async (req, res) => {
  try {
    const batch = await ACHEngine.createDisbursementBatch(req.body);
    res.json({ success: true, data: batch });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
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
router.post('/batches/:id/transmit', async (req, res) => {
  try {
    const result = await ACHEngine.transmitBatch(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/ach-pipeline/batches/:id/cancel ────────────────────────────────
// Cancel a pending batch
router.post('/batches/:id/cancel', async (req, res) => {
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

module.exports = router;
