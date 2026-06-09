/**
 * Payment Gateway Routes — Self-Contained External Payment Processing
 * 
 * Mounts at: /api/gateway
 * 
 * Provides a complete payment gateway with:
 * - API key management (self-issued, no external deps)
 * - External payment processing (ACH/Wire)
 * - SFTP file staging + delivery
 * - Gateway health/status monitoring
 * 
 * No external API key dependencies required.
 * 
 * ODFI: Eaton Family Credit Union (ABA 241075470)
 * Originator: DEANDREA LAVAR BARKLEY TRUST
 */

'use strict';

const express = require('express');
const router = express.Router();
const {
  generateApiKey,
  validateApiKey,
  revokeApiKey,
  listApiKeys,
  stagePaymentFile,
  listOutgoingFiles,
  markFileDelivered,
  getPaymentFile,
  processExternalPayment,
  getGatewayStatus,
  moovConfigured,
} = require('../engines/payment-gateway-engine');

// ─── API Key Authentication Middleware ────────────────────────────────────────

function authenticateGateway(req, res, next) {
  // Allow unauthenticated access to status and key generation (admin bootstrap)
  const openPaths = ['/status', '/keys/generate', '/keys', '/health'];
  if (openPaths.some(p => req.path === p || req.path.startsWith(p))) {
    return next();
  }

  const authHeader = req.headers['authorization'] || '';
  const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : req.headers['x-api-key'] || req.query.api_key || '';

  if (!apiKey) {
    return res.status(401).json({ 
      error: 'API key required',
      help: 'Include your gateway API key as: Authorization: Bearer sk_live_...',
      generate: 'POST /api/gateway/keys/generate to create a new key',
    });
  }

  const keyData = validateApiKey(apiKey);
  if (!keyData) {
    return res.status(403).json({ error: 'Invalid or revoked API key' });
  }

  req.gatewayKey = keyData;
  next();
}

router.use(authenticateGateway);

// ─── Gateway Status ───────────────────────────────────────────────────────────

/**
 * GET /api/gateway/status
 * Returns full gateway status including all channels and configuration
 */
router.get('/status', async (req, res) => {
  try {
    const status = await getGatewayStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/health', async (req, res) => {
  res.json({ 
    status: 'operational', 
    gateway: 'DLB Trust Payment Gateway',
    self_hosted: true,
    timestamp: new Date().toISOString(),
  });
});

// ─── API Key Management ───────────────────────────────────────────────────────

/**
 * POST /api/gateway/keys/generate
 * Generate a new platform API key
 * Body: { name: "My Integration", permissions: ["payments:create"] }
 */
router.post('/keys/generate', (req, res) => {
  const { name, permissions } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }

  const result = generateApiKey(name, permissions);
  res.json({
    success: true,
    ...result,
    usage: {
      header: `Authorization: Bearer ${result.api_key}`,
      example: `curl -H "Authorization: Bearer ${result.api_key}" https://dlbtrust.cloud/api/gateway/status`,
    },
  });
});

/**
 * GET /api/gateway/keys
 * List all API keys (secrets masked)
 */
router.get('/keys', (req, res) => {
  res.json({ keys: listApiKeys() });
});

/**
 * POST /api/gateway/keys/:id/revoke
 * Revoke an API key
 */
router.post('/keys/:id/revoke', (req, res) => {
  const result = revokeApiKey(req.params.id);
  res.json(result);
});

// ─── External Payment Processing ──────────────────────────────────────────────

/**
 * POST /api/gateway/payments
 * Process an external payment through the self-contained gateway
 * 
 * Body: {
 *   recipient_name: "John Smith",
 *   routing_number: "021000021",      // 9-digit ABA routing number
 *   account_number: "123456789",       // Recipient's bank account
 *   account_type: "checking",          // checking or savings
 *   amount: "500.00",                  // Dollar amount (or amount_cents: 50000)
 *   description: "Vendor payment",     // Optional description
 *   payment_type: "ach",              // ach or wire
 *   reference: "INV-2026-001"         // Optional reference number
 * }
 * 
 * Response includes transaction ID, delivery channel used, and confirmation details.
 */
router.post('/payments', async (req, res) => {
  try {
    const { recipient_name, routing_number, account_number, amount, amount_cents } = req.body;

    // Validate required fields
    if (!recipient_name) return res.status(400).json({ error: 'recipient_name is required' });
    if (!routing_number || !/^\d{9}$/.test(routing_number)) {
      return res.status(400).json({ error: 'routing_number must be 9 digits' });
    }
    if (!account_number) return res.status(400).json({ error: 'account_number is required' });
    if (!amount && !amount_cents) return res.status(400).json({ error: 'amount or amount_cents is required' });

    const result = await processExternalPayment(req.body);
    
    const statusCode = result.status === 'submitted_to_fed' || result.status === 'delivered_to_bank' ? 200 : 
                       result.status === 'file_ready' || result.status === 'ledger_only' ? 202 : 200;
    
    res.status(statusCode).json({
      success: true,
      payment: result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/gateway/payments/wire
 * Process a wire transfer (domestic Fedwire or international SWIFT)
 * 
 * Body: {
 *   recipient_name: "ACME Corp",
 *   routing_number: "021000021",       // Fedwire routing (domestic)
 *   swift_bic: "CHASUS33",            // SWIFT BIC (international)
 *   account_number: "9876543210",
 *   amount: "25000.00",
 *   purpose: "Invoice payment",
 *   reference: "WIRE-2026-005"
 * }
 */
router.post('/payments/wire', async (req, res) => {
  try {
    const payment = { ...req.body, payment_type: 'wire' };
    const result = await processExternalPayment(payment);
    res.json({ success: true, payment: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/gateway/payments/:id
 * Get payment status by ID
 */
router.get('/payments/:id', (req, res) => {
  // Payment lookup from staged files or OBP
  res.json({
    id: req.params.id,
    message: 'Payment tracking — check OBP ledger or staged files for full status',
    lookup: {
      obp: `GET /api/obp/transactions`,
      files: `GET /api/gateway/files`,
    },
  });
});

// ─── SFTP File Management ─────────────────────────────────────────────────────

/**
 * GET /api/gateway/files
 * List all staged payment files
 */
router.get('/files', (req, res) => {
  const files = listOutgoingFiles();
  res.json({ files, count: files.length });
});

/**
 * GET /api/gateway/files/:filename
 * Download a payment file
 */
router.get('/files/:filename', (req, res) => {
  const file = getPaymentFile(req.params.filename);
  if (!file) {
    return res.status(404).json({ error: 'File not found' });
  }
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
  res.send(file.content);
});

/**
 * POST /api/gateway/files/:filename/deliver
 * Mark a file as delivered to the bank
 */
router.post('/files/:filename/deliver', (req, res) => {
  const result = markFileDelivered(req.params.filename);
  res.json(result);
});

/**
 * POST /api/gateway/files/upload
 * Upload a NACHA/Wire file for staging
 * Body: { filename: "batch_001.ach", content: "101 021000021..." }
 */
router.post('/files/upload', (req, res) => {
  const { filename, content } = req.body;
  if (!filename || !content) {
    return res.status(400).json({ error: 'filename and content are required' });
  }
  const result = stagePaymentFile(filename, content, { source: 'api_upload' });
  res.json({ success: true, ...result });
});

// ─── Moov ODFI Setup Guide ───────────────────────────────────────────────────

/**
 * GET /api/gateway/setup/moov
 * Instructions to activate Moov ODFI bridge (connects to Federal Reserve)
 */
router.get('/setup/moov', (req, res) => {
  res.json({
    configured: moovConfigured(),
    service: 'Moov Financial',
    description: 'Moov acts as your ODFI (Originating Depository Financial Institution). They connect directly to the Federal Reserve ACH network. Free tier allows up to $10K/month.',
    steps: [
      '1. Sign up at https://dashboard.moov.io/signup (free)',
      '2. Complete identity verification (KYC)',
      '3. Create a Moov account for your trust',
      '4. Get your API credentials (public key + secret key)',
      '5. Set environment variables on dlbtrust.cloud:',
      '   MOOV_ACCOUNT_ID=acc_xxxx',
      '   MOOV_PUBLIC_KEY=pk_xxxx',
      '   MOOV_SECRET_KEY=sk_xxxx',
      '6. Restart the app — Moov ODFI channel will activate',
    ],
    env_vars_needed: ['MOOV_ACCOUNT_ID', 'MOOV_PUBLIC_KEY', 'MOOV_SECRET_KEY'],
    free_tier_limit: '$10,000/month in ACH transfers',
    no_sftp_needed: true,
    no_bank_credentials_needed: true,
    signup_url: 'https://dashboard.moov.io/signup',
  });
});

module.exports = router;
