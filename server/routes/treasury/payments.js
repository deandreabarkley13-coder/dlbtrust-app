'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db-postgres');

// GET /api/treasury/payments — List payment instructions
router.get('/', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT id FROM trusts LIMIT 1');
    const { status, limit } = req.query;
    let sql = `
      SELECT pi.*, b.name as beneficiary_name_lookup
      FROM payment_instructions pi
      LEFT JOIN distribution_payments dp ON dp.id = pi.distribution_payment_id
      LEFT JOIN beneficiaries b ON b.id = dp.beneficiary_id
      WHERE pi.trust_id = $1
    `;
    const params = [trust.id];
    if (status) {
      sql += ' AND pi.status = $2';
      params.push(status);
    }
    sql += ' ORDER BY pi.created_at DESC';
    if (limit) sql += ` LIMIT ${parseInt(limit)}`;

    const payments = await db.queryAll(sql, params);
    res.json({ success: true, data: payments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/treasury/payments/submit — Submit approved payments for processing
router.post('/submit', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT id FROM trusts LIMIT 1');
    const { distribution_id } = req.body;

    // Get approved payments ready for submission
    let sql = `
      SELECT dp.*, b.name as beneficiary_name, ba.bank_name, ba.routing_number, ba.account_number_encrypted, ba.account_type, ba.account_last4
      FROM distribution_payments dp
      JOIN beneficiaries b ON b.id = dp.beneficiary_id
      LEFT JOIN bank_accounts ba ON ba.id = dp.bank_account_id
      WHERE dp.status = 'approved'
    `;
    const params = [];
    if (distribution_id) {
      sql += ' AND dp.distribution_id = $1';
      params.push(distribution_id);
    }

    const approvedPayments = await db.queryAll(sql, params);
    if (approvedPayments.length === 0) {
      return res.status(400).json({ error: 'No approved payments to submit' });
    }

    // Create payment instructions for each
    const instructions = [];
    await db.transaction(async (client) => {
      for (const payment of approvedPayments) {
        let paymentRail = 'ach_credit';
        if (payment.payment_method === 'wire') paymentRail = 'wire';
        else if (payment.payment_method === 'internal') paymentRail = 'internal';

        const { rows: [instruction] } = await client.query(`
          INSERT INTO payment_instructions (
            trust_id, distribution_payment_id, payment_rail, amount, currency,
            beneficiary_name, bank_name, routing_number, account_number_encrypted, account_type,
            memo, effective_date, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          RETURNING *
        `, [
          trust.id, payment.id, paymentRail, payment.net_amount, 'USD',
          payment.beneficiary_name, payment.bank_name, payment.routing_number,
          payment.account_number_encrypted, payment.account_type,
          `Trust distribution - ${payment.beneficiary_name}`,
          new Date().toISOString().split('T')[0],
          'queued',
        ]);
        instructions.push(instruction);

        // Update payment status
        await client.query("UPDATE distribution_payments SET status = 'submitted', submitted_at = NOW() WHERE id = $1", [payment.id]);
      }

      // Update distribution status
      if (distribution_id) {
        await client.query("UPDATE distributions SET status = 'processing' WHERE id = $1", [distribution_id]);
      }
    });

    res.json({
      success: true,
      message: `${instructions.length} payment instructions created and queued`,
      instructions: instructions.map(i => ({ id: i.id, amount: i.amount, beneficiary: i.beneficiary_name, rail: i.payment_rail, status: i.status })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/treasury/payments/:id/process — Process a single payment via ACH/wire
router.post('/:id/process', async (req, res) => {
  try {
    const instruction = await db.queryOne('SELECT * FROM payment_instructions WHERE id = $1', [req.params.id]);
    if (!instruction) return res.status(404).json({ error: 'Payment instruction not found' });
    if (!['queued', 'created'].includes(instruction.status)) {
      return res.status(400).json({ error: `Cannot process payment in "${instruction.status}" status` });
    }

    // Attempt to process via OpenACH or configured payment rail
    const openachBaseUrl = process.env.OPENACH_BASE_URL || 'https://ach.dlbtrust.cloud/api';
    const openachToken = process.env.OPENACH_API_TOKEN;

    if (instruction.payment_rail === 'ach_credit' && openachToken) {
      // Submit to OpenACH
      try {
        const response = await fetch(`${openachBaseUrl}/paymentSchedules`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openachToken}`,
          },
          body: JSON.stringify({
            payment_type_id: 'pt-ach-credit-001',
            amount: instruction.amount / 100,
            routing_number: instruction.routing_number,
            account_number: instruction.account_number_encrypted,
            account_type: instruction.account_type || 'checking',
            effective_date: instruction.effective_date,
            description: instruction.memo,
          }),
        });

        if (response.ok) {
          const result = await response.json();
          await db.query(`
            UPDATE payment_instructions SET status = 'submitted', external_ref = $1, submitted_at = NOW(), updated_at = NOW()
            WHERE id = $2
          `, [result.id || result.payment_schedule_id, instruction.id]);

          res.json({ success: true, status: 'submitted', external_ref: result.id || result.payment_schedule_id });
        } else {
          const errBody = await response.text();
          await db.query(`
            UPDATE payment_instructions SET status = 'failed', failure_reason = $1, retry_count = retry_count + 1, updated_at = NOW()
            WHERE id = $2
          `, [`OpenACH error: ${response.status} ${errBody}`, instruction.id]);

          res.status(502).json({ error: 'Payment submission failed', details: errBody });
        }
      } catch (fetchErr) {
        await db.query(`
          UPDATE payment_instructions SET failure_reason = $1, retry_count = retry_count + 1, updated_at = NOW()
          WHERE id = $2
        `, [`Network error: ${fetchErr.message}`, instruction.id]);
        res.status(502).json({ error: 'Payment processor unreachable', details: fetchErr.message });
      }
    } else {
      // Mark as submitted without processor (manual processing)
      await db.query(`
        UPDATE payment_instructions SET status = 'submitted', submitted_at = NOW(), updated_at = NOW() WHERE id = $1
      `, [instruction.id]);
      res.json({ success: true, status: 'submitted', note: 'No automated processor configured — manual processing required' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/treasury/payments/:id/settle — Mark a payment as settled
router.post('/:id/settle', async (req, res) => {
  try {
    const instruction = await db.queryOne('SELECT * FROM payment_instructions WHERE id = $1', [req.params.id]);
    if (!instruction) return res.status(404).json({ error: 'Payment instruction not found' });

    await db.transaction(async (client) => {
      await client.query(`
        UPDATE payment_instructions SET status = 'settled', settled_at = NOW(), updated_at = NOW() WHERE id = $1
      `, [instruction.id]);

      if (instruction.distribution_payment_id) {
        await client.query(`
          UPDATE distribution_payments SET status = 'settled', settled_at = NOW() WHERE id = $1
        `, [instruction.distribution_payment_id]);

        // Check if all payments for the distribution are settled
        const dp = await client.query('SELECT distribution_id FROM distribution_payments WHERE id = $1', [instruction.distribution_payment_id]);
        if (dp.rows.length > 0) {
          const pending = await client.query(`
            SELECT COUNT(*) as count FROM distribution_payments WHERE distribution_id = $1 AND status != 'settled'
          `, [dp.rows[0].distribution_id]);
          if (parseInt(pending.rows[0].count) === 0) {
            await client.query("UPDATE distributions SET status = 'completed', completed_at = NOW() WHERE id = $1", [dp.rows[0].distribution_id]);
          }
        }
      }

      // Ledger entry for settled payment
      await client.query(`
        INSERT INTO ledger_entries (trust_id, entry_date, entry_type, amount, description, reference_type, reference_id, status, posted_by)
        VALUES ($1, CURRENT_DATE, 'distribution', $2, $3, 'payment_instruction', $4, 'posted', 'system')
      `, [instruction.trust_id, instruction.amount, `Payment settled: ${instruction.beneficiary_name} via ${instruction.payment_rail}`, instruction.id]);
    });

    res.json({ success: true, message: 'Payment marked as settled' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
