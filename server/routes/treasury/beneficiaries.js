'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db-postgres');

// GET /api/treasury/beneficiaries — List all beneficiaries with bank accounts
router.get('/', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT id FROM trusts LIMIT 1');
    const beneficiaries = await db.queryAll(`
      SELECT b.*,
        (SELECT COUNT(*) FROM bank_accounts ba WHERE ba.beneficiary_id = b.id AND ba.status = 'active') as bank_account_count,
        (SELECT COALESCE(SUM(dp.net_amount), 0) FROM distribution_payments dp WHERE dp.beneficiary_id = b.id AND dp.status = 'settled') as total_received
      FROM beneficiaries b
      WHERE b.trust_id = $1
      ORDER BY b.name
    `, [trust.id]);
    res.json({ success: true, data: beneficiaries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/treasury/beneficiaries/:id — Single beneficiary with full details
router.get('/:id', async (req, res) => {
  try {
    const beneficiary = await db.queryOne('SELECT * FROM beneficiaries WHERE id = $1', [req.params.id]);
    if (!beneficiary) return res.status(404).json({ error: 'Beneficiary not found' });

    const [bankAccounts, payments, taxRecords] = await Promise.all([
      db.queryAll('SELECT id, bank_name, account_type, account_last4, is_verified, is_primary, status FROM bank_accounts WHERE beneficiary_id = $1', [beneficiary.id]),
      db.queryAll(`
        SELECT dp.*, d.distribution_date FROM distribution_payments dp
        JOIN distributions d ON d.id = dp.distribution_id
        WHERE dp.beneficiary_id = $1
        ORDER BY d.distribution_date DESC LIMIT 20
      `, [beneficiary.id]),
      db.queryAll('SELECT * FROM tax_records WHERE beneficiary_id = $1 ORDER BY tax_year DESC', [beneficiary.id]),
    ]);

    res.json({ success: true, beneficiary, bank_accounts: bankAccounts, recent_payments: payments, tax_records: taxRecords });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/treasury/beneficiaries — Create a new beneficiary
router.post('/', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT id FROM trusts LIMIT 1');
    const { name, beneficiary_type, classification, email, phone, address, city, state, zip, distribution_pct, distribution_fixed } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const result = await db.queryOne(`
      INSERT INTO beneficiaries (trust_id, name, beneficiary_type, classification, email, phone, address, city, state, zip, distribution_pct, distribution_fixed)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `, [trust.id, name, beneficiary_type || 'income', classification || 'individual', email, phone, address, city, state, zip, distribution_pct || 0, distribution_fixed || 0]);

    res.status(201).json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/treasury/beneficiaries/:id — Update beneficiary
router.put('/:id', async (req, res) => {
  try {
    const { name, email, phone, address, city, state, zip, distribution_pct, distribution_fixed, status } = req.body;
    const result = await db.queryOne(`
      UPDATE beneficiaries SET
        name = COALESCE($2, name),
        email = COALESCE($3, email),
        phone = COALESCE($4, phone),
        address = COALESCE($5, address),
        city = COALESCE($6, city),
        state = COALESCE($7, state),
        zip = COALESCE($8, zip),
        distribution_pct = COALESCE($9, distribution_pct),
        distribution_fixed = COALESCE($10, distribution_fixed),
        status = COALESCE($11, status),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [req.params.id, name, email, phone, address, city, state, zip, distribution_pct, distribution_fixed, status]);

    if (!result) return res.status(404).json({ error: 'Beneficiary not found' });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/treasury/beneficiaries/:id/bank-accounts — Add bank account
router.post('/:id/bank-accounts', async (req, res) => {
  try {
    const beneficiary = await db.queryOne('SELECT id FROM beneficiaries WHERE id = $1', [req.params.id]);
    if (!beneficiary) return res.status(404).json({ error: 'Beneficiary not found' });

    const { bank_name, routing_number, account_number, account_type, is_primary } = req.body;
    if (!bank_name || !routing_number || !account_number) {
      return res.status(400).json({ error: 'bank_name, routing_number, account_number required' });
    }
    if (!/^\d{9}$/.test(routing_number)) {
      return res.status(400).json({ error: 'routing_number must be 9 digits' });
    }

    const accountLast4 = account_number.slice(-4);
    // In production, encrypt account_number with pgcrypto
    const encrypted = account_number; // TODO: Use pgp_sym_encrypt

    // If setting as primary, unset existing primary
    if (is_primary) {
      await db.query("UPDATE bank_accounts SET is_primary = FALSE WHERE beneficiary_id = $1", [req.params.id]);
    }

    const result = await db.queryOne(`
      INSERT INTO bank_accounts (beneficiary_id, bank_name, routing_number, account_number_encrypted, account_type, account_last4, is_primary)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, bank_name, routing_number, account_type, account_last4, is_primary, status
    `, [req.params.id, bank_name, routing_number, encrypted, account_type || 'checking', accountLast4, is_primary || false]);

    res.status(201).json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
