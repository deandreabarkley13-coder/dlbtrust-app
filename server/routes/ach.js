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
const pool = require('../db');

// ─── Middleware: require admin auth ──────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (typeof req.user !== 'undefined' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ─── GET /api/ach/health ──────────────────────────────────────────────────────
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
  let wallet;
  try {
    const { rows: [row] } = await pool.query('SELECT * FROM wallets WHERE id = $1', [wallet_id]);
    wallet = row;
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

    // Log the disbursement to the transactions table (wrapped in a transaction)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get trust primary wallet with row lock
      const { rows: [trustWallet] } = await client.query(
        'SELECT * FROM wallets WHERE role = $1 LIMIT 1 FOR UPDATE', ['trust_entity']
      );

      if (trustWallet) {
        const balanceBefore = trustWallet.fiat_balance;
        const amountCents   = Math.round(amountNum * 100);
        const balanceAfter  = balanceBefore - amountCents;

        // Debit trust wallet
        await client.query(
          'UPDATE wallets SET fiat_balance = $1 WHERE id = $2',
          [balanceAfter, trustWallet.id]
        );

        // Record debit transaction for trust
        await client.query(`
          INSERT INTO transactions 
            (wallet_id, type, amount, balance_before, balance_after, description, 
             counterparty_wallet_id, reference_id, status, created_at)
          VALUES ($1, 'transfer_out', $2, $3, $4, $5, $6, $7, 'completed', NOW())
        `, [
          trustWallet.id,
          amountCents,
          balanceBefore,
          balanceAfter,
          `ACH disbursement to ${firstName} ${lastName}: ${description}`,
          wallet_id,
          result.payment_schedule_id,
        ]);

        // Credit beneficiary wallet
        if (wallet_id) {
          const { rows: [benWallet] } = await client.query(
            'SELECT * FROM wallets WHERE id = $1 FOR UPDATE', [wallet_id]
          );
          if (benWallet) {
            const benBefore = benWallet.fiat_balance;
            const benAfter  = benBefore + amountCents;
            await client.query('UPDATE wallets SET fiat_balance = $1 WHERE id = $2', [benAfter, wallet_id]);
            await client.query(`
              INSERT INTO transactions 
                (wallet_id, type, amount, balance_before, balance_after, description,
                 counterparty_wallet_id, reference_id, status, created_at)
              VALUES ($1, 'transfer_in', $2, $3, $4, $5, $6, $7, 'completed', NOW())
            `, [
              wallet_id,
              amountCents,
              benBefore,
              benAfter,
              'ACH disbursement from DEANDREA LAVAR BARKLEY TRUST',
              trustWallet.id,
              result.payment_schedule_id,
            ]);
          }
        }
      }

      await client.query('COMMIT');
    } catch (dbErr) {
      await client.query('ROLLBACK');
      console.warn('[ach/disburse] DB log failed (non-fatal):', dbErr.message);
    } finally {
      client.release();
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
