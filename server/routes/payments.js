/**
 * Payment Routes — dlbtrust.cloud
 * ACH disbursement endpoints powered by OpenACH
 * 
 * All routes require JWT authentication (existing auth middleware)
 */

const express = require('express');
const router = express.Router();
const { OpenACHClient } = require('../integrations/openach/openachClient');

// ─── GET /api/payments/types ────────────────────────────────────────────────
// Returns configured payment types (e.g. "Trust Dist")
// Frontend uses these IDs when scheduling disbursements
router.get('/types', async (req, res) => {
  try {
    const types = await OpenACHClient.getPaymentTypes();
    res.json({ success: true, payment_types: types });
  } catch (err) {
    console.error('[payments/types]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/payments/disburse ────────────────────────────────────────────
// Full one-step disbursement: creates profile + bank account + schedules ACH
// Body: {
//   first_name, last_name, email, external_id,
//   bank_name, routing_number, account_number, account_type,
//   billing_address, billing_city, billing_state, billing_zip,
//   amount, send_date, payment_type_id, frequency, occurrences
// }
router.post('/disburse', async (req, res) => {
  try {
    const {
      first_name, last_name, email, external_id,
      bank_name, routing_number, account_number, account_type,
      billing_address, billing_city, billing_state, billing_zip,
      amount, send_date, payment_type_id,
      frequency = 'once', occurrences = 1,
    } = req.body;

    // Validate required fields
    const required = { first_name, last_name, bank_name, routing_number, account_number, amount, send_date, payment_type_id };
    const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      return res.status(400).json({ success: false, error: `Missing required fields: ${missing.join(', ')}` });
    }

    // Validate routing number (9 digits)
    if (!/^\d{9}$/.test(String(routing_number))) {
      return res.status(400).json({ success: false, error: 'routing_number must be exactly 9 digits' });
    }

    // Validate amount
    if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      return res.status(400).json({ success: false, error: 'amount must be a positive number' });
    }

    // Validate send_date is a future date
    const sendDateObj = new Date(send_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (sendDateObj < today) {
      return res.status(400).json({ success: false, error: 'send_date must be today or a future date' });
    }

    const result = await OpenACHClient.disburseToBeneficiary({
      first_name, last_name, email, external_id,
      bank_name, routing_number, account_number, account_type,
      billing_address, billing_city, billing_state, billing_zip,
      amount, send_date, payment_type_id, frequency, occurrences,
    });

    // Log disbursement to local DB if db is available
    if (req.app.locals.db) {
      try {
        req.app.locals.db.prepare(`
          INSERT INTO disbursements 
            (payment_schedule_id, external_account_id, payment_profile_id, amount, send_date, beneficiary_name, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
          result.payment_schedule_id,
          result.external_account_id,
          result.payment_profile_id,
          amount,
          send_date,
          `${first_name} ${last_name}`,
          req.user?.id || 'system',
        );
      } catch (dbErr) {
        console.warn('[payments/disburse] DB log failed:', dbErr.message);
        // Non-fatal — ACH was already scheduled
      }
    }

    res.json(result);

  } catch (err) {
    console.error('[payments/disburse]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/payments/profile ─────────────────────────────────────────────
// Create a payment profile only (no bank account yet)
router.post('/profile', async (req, res) => {
  try {
    const { first_name, last_name, email, external_id } = req.body;
    if (!first_name || !last_name) {
      return res.status(400).json({ success: false, error: 'first_name and last_name are required' });
    }
    const result = await OpenACHClient.createPaymentProfile({ first_name, last_name, email, external_id });
    res.json(result);
  } catch (err) {
    console.error('[payments/profile]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/payments/bank-account ────────────────────────────────────────
// Add a bank account to an existing payment profile
router.post('/bank-account', async (req, res) => {
  try {
    const result = await OpenACHClient.addExternalAccount(req.body);
    res.json(result);
  } catch (err) {
    console.error('[payments/bank-account]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/payments/schedule ────────────────────────────────────────────
// Schedule an ACH payment for an existing external account
router.post('/schedule', async (req, res) => {
  try {
    const result = await OpenACHClient.schedulePayment(req.body);
    res.json(result);
  } catch (err) {
    console.error('[payments/schedule]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/payments/schedules/:profileId ─────────────────────────────────
// Get all payment schedules for a profile
router.get('/schedules/:profileId', async (req, res) => {
  try {
    const result = await OpenACHClient.getPaymentSchedules(req.params.profileId);
    res.json(result);
  } catch (err) {
    console.error('[payments/schedules]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/payments/accounts/:profileId ──────────────────────────────────
// Get all bank accounts for a profile
router.get('/accounts/:profileId', async (req, res) => {
  try {
    const result = await OpenACHClient.getExternalAccounts(req.params.profileId);
    res.json(result);
  } catch (err) {
    console.error('[payments/accounts]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/payments/profile/by-external/:externalId ──────────────────────
// Look up a payment profile by your internal ID
router.get('/profile/by-external/:externalId', async (req, res) => {
  try {
    const result = await OpenACHClient.getPaymentProfileByExternalId(req.params.externalId);
    res.json(result);
  } catch (err) {
    console.error('[payments/profile/by-external]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/payments/health ───────────────────────────────────────────────
// Confirms OpenACH API is reachable and credentials are valid
router.get('/health', async (req, res) => {
  try {
    const types = await OpenACHClient.getPaymentTypes();
    res.json({
      success: true,
      openach_reachable: true,
      payment_types_count: Array.isArray(types) ? types.length : 1,
      message: 'OpenACH API is connected and responding',
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      openach_reachable: false,
      error: err.message,
    });
  }
});

module.exports = router;
