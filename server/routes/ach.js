/**
 * ACH Disbursement Routes — dlbtrust.cloud Live Server
 * Mounts at: /api/ach
 * 
 * Integrates with self-hosted OpenACH at ach.dlbtrust.cloud
 * Works with the existing wallet/transaction database model
 * 
 * ODFI: Eaton Family Credit Union (routing: 241075470)
 * Originator: DEANDREA LAVAR BARKLEY TRUST
 */

'use strict';

const express = require('express');
const router  = express.Router();
const { OpenACHClient } = require('../integrations/openach/openachClient');

// ─── Middleware: require admin auth ──────────────────────────────────────────
function requireAdmin(req, res, next) {
  // Compatible with whatever auth the live server uses
  // If no auth middleware, skip — tighten later
  if (typeof req.user !== 'undefined' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ─── GET /api/ach/health ──────────────────────────────────────────────────────
// Verify OpenACH API is reachable and credentials work
router.get('/health', async (req, res) => {
  try {
    const types = await OpenACHClient.getPaymentTypes();
    res.json({
      success: true,
      openach_connected: true,
      payment_types: types,
      message: 'OpenACH API is live and authenticated',
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      openach_connected: false,
      error: err.message,
    });
  }
});

// ─── GET /api/ach/payment-types ───────────────────────────────────────────────
router.get('/payment-types', async (req, res) => {
  try {
    const types = await OpenACHClient.getPaymentTypes();
    res.json({ success: true, data: types });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/ach/disburse ───────────────────────────────────────────────────
// Disburse funds from the trust to a beneficiary's bank account
// Body: {
//   wallet_id         - beneficiary wallet ID (1–8 from /api/wallets)
//   amount            - dollars (e.g. 500.00)
//   routing_number    - recipient's 9-digit ABA routing number
//   account_number    - recipient's bank account number
//   account_type      - "Checking" or "Savings"
//   payment_type_id   - from /api/ach/payment-types (Trust Dist type)
//   send_date         - YYYY-MM-DD (optional, defaults to next business day)
//   description       - memo/description
//   billing_address   - optional
//   billing_city      - optional
//   billing_state     - optional, default OH
//   billing_zip       - optional
// }
router.post('/disburse', requireAdmin, async (req, res) => {
  const {
    wallet_id,
    amount,
    routing_number,
    account_number,
    account_type = 'Checking',
    payment_type_id,
    send_date,
    description = 'Trust disbursement',
    billing_address = '',
    billing_city = '',
    billing_state = 'OH',
    billing_zip = '',
  } = req.body;

  // Validation
  if (!wallet_id || !amount || !routing_number || !account_number || !payment_type_id) {
    return res.status(400).json({
      error: 'Required: wallet_id, amount, routing_number, account_number, payment_type_id',
    });
  }

  if (!/^\d{9}$/.test(String(routing_number))) {
    return res.status(400).json({ error: 'routing_number must be 9 digits' });
  }

  const amountNum = parseFloat(amount);
  if (isNaN(amountNum) || amountNum <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  // Determine send date
  const disbursementDate = send_date || getNextBusinessDay();
  const dateObj = new Date(disbursementDate);
  if (dateObj < new Date(new Date().setHours(0,0,0,0))) {
    return res.status(400).json({ error: 'send_date must be today or future' });
  }

  // Look up wallet to get beneficiary info
  let db;
  let wallet;
  try {
    // Try to get DB from app locals (set by server.js)
    db = req.app.locals.db;
    if (db) {
      wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(wallet_id);
    }
  } catch (_) { /* db access optional */ }

  // Parse beneficiary name from wallet or use generic
  let firstName = 'Beneficiary';
  let lastName  = String(wallet_id);
  let email     = '';

  if (wallet) {
    const nameParts = (wallet.holder_name || wallet.name || '').replace(/^Beneficiary \d+ - /, '').trim().split(' ');
    firstName = nameParts[0] || 'Beneficiary';
    lastName  = nameParts.slice(1).join(' ') || String(wallet_id);
    email     = wallet.email || '';
  }

  try {
    const result = await OpenACHClient.disburseToBeneficiary({
      // Beneficiary
      first_name:  firstName,
      last_name:   lastName,
      email,
      external_id: `wallet_${wallet_id}`,

      // Bank
      bank_name:       'Recipient Bank',
      routing_number,
      account_number,
      account_type,
      billing_address,
      billing_city,
      billing_state,
      billing_zip,

      // Payment
      amount:          amountNum,
      send_date:       disbursementDate,
      payment_type_id,
      frequency:       'once',
      occurrences:     1,
    });

    // Log the disbursement to the transactions table if DB is available
    if (db) {
      try {
        // Get trust primary wallet (id=1) for debit
        const trustWallet = db.prepare('SELECT * FROM wallets WHERE role = ? LIMIT 1').get('trust_entity');

        if (trustWallet) {
          const balanceBefore = trustWallet.fiat_balance;
          const amountCents   = Math.round(amountNum * 100);
          const balanceAfter  = balanceBefore - amountCents;

          // Debit trust wallet
          db.prepare(`
            UPDATE wallets SET fiat_balance = ? WHERE id = ?
          `).run(balanceAfter, trustWallet.id);

          // Record debit transaction for trust
          db.prepare(`
            INSERT INTO transactions 
              (wallet_id, type, amount, balance_before, balance_after, description, 
               counterparty_wallet_id, reference_id, status, created_at)
            VALUES (?, 'transfer_out', ?, ?, ?, ?, ?, ?, 'completed', datetime('now'))
          `).run(
            trustWallet.id,
            amountCents,
            balanceBefore,
            balanceAfter,
            `ACH disbursement to ${firstName} ${lastName}: ${description}`,
            wallet_id,
            result.payment_schedule_id,
            'completed',
          );

          // Credit beneficiary wallet
          if (wallet_id) {
            const benWallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(wallet_id);
            if (benWallet) {
              const benBefore = benWallet.fiat_balance;
              const benAfter  = benBefore + amountCents;
              db.prepare('UPDATE wallets SET fiat_balance = ? WHERE id = ?').run(benAfter, wallet_id);
              db.prepare(`
                INSERT INTO transactions 
                  (wallet_id, type, amount, balance_before, balance_after, description,
                   counterparty_wallet_id, reference_id, status, created_at)
                VALUES (?, 'transfer_in', ?, ?, ?, ?, ?, ?, 'completed', datetime('now'))
              `).run(
                wallet_id,
                amountCents,
                benBefore,
                benAfter,
                `ACH disbursement from DEANDREA LAVAR BARKLEY TRUST`,
                trustWallet.id,
                result.payment_schedule_id,
                'completed',
              );
            }
          }
        }
      } catch (dbErr) {
        console.warn('[ach/disburse] DB log failed (non-fatal):', dbErr.message);
      }
    }

    res.json({
      success: true,
      ...result,
      send_date: disbursementDate,
      beneficiary: `${firstName} ${lastName}`,
      amount_dollars: amountNum,
    });

  } catch (err) {
    console.error('[ach/disburse]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/ach/schedules/:walletId ─────────────────────────────────────────
// Get all ACH payment schedules for a beneficiary by wallet ID
router.get('/schedules/:walletId', async (req, res) => {
  try {
    const profile = await OpenACHClient.getPaymentProfileByExternalId(
      `wallet_${req.params.walletId}`
    );
    if (!profile.success || !profile.payment_profile_id) {
      return res.json({ success: true, data: [], message: 'No ACH profile found for this wallet' });
    }
    const schedules = await OpenACHClient.getPaymentSchedules(profile.payment_profile_id);
    res.json({ success: true, data: schedules });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getNextBusinessDay() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

module.exports = router;
