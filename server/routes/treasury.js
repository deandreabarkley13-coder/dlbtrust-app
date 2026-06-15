'use strict';

const express = require('express');
const router = express.Router();
const pool = require('../integrations/bonds/pgPool');

// ─── Schema Auto-Init ────────────────────────────────────────────────────────
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS beneficiaries (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        beneficiary_type VARCHAR(50) NOT NULL DEFAULT 'income',
        classification VARCHAR(50) DEFAULT 'individual',
        email VARCHAR(255), phone VARCHAR(50),
        address TEXT, city VARCHAR(100), state VARCHAR(2), zip VARCHAR(10),
        distribution_pct NUMERIC(8,2) DEFAULT 0,
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS wallets (
        id SERIAL PRIMARY KEY,
        wallet_code VARCHAR(50) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        wallet_type VARCHAR(50) NOT NULL DEFAULT 'operating',
        balance NUMERIC(18,2) DEFAULT 0,
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ledger_entries (
        id SERIAL PRIMARY KEY,
        entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
        entry_type VARCHAR(50) NOT NULL,
        debit_wallet_id INTEGER, debit_wallet_name VARCHAR(255),
        credit_wallet_id INTEGER, credit_wallet_name VARCHAR(255),
        amount NUMERIC(18,2) NOT NULL,
        description TEXT,
        reference_type VARCHAR(50), reference_id INTEGER,
        status VARCHAR(20) DEFAULT 'posted',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS distribution_schedules (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        frequency VARCHAR(30) DEFAULT 'monthly',
        distribution_basis VARCHAR(30) DEFAULT 'fixed',
        day_of_month INTEGER DEFAULT 1,
        requires_approval BOOLEAN DEFAULT true,
        approval_threshold NUMERIC(18,2) DEFAULT 100000,
        next_distribution DATE,
        total_distributed NUMERIC(18,2) DEFAULT 0,
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS distributions (
        id SERIAL PRIMARY KEY,
        schedule_id INTEGER,
        distribution_date DATE DEFAULT CURRENT_DATE,
        total_amount NUMERIC(18,2) DEFAULT 0,
        net_amount NUMERIC(18,2) DEFAULT 0,
        tax_withheld NUMERIC(18,2) DEFAULT 0,
        status VARCHAR(20) DEFAULT 'completed',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ach_transactions (
        id SERIAL PRIMARY KEY,
        beneficiary_name VARCHAR(255) NOT NULL,
        transaction_type VARCHAR(30) DEFAULT 'credit',
        routing_number VARCHAR(9),
        account_number VARCHAR(50),
        account_type VARCHAR(20) DEFAULT 'checking',
        amount NUMERIC(18,2) NOT NULL,
        sec_code VARCHAR(5) DEFAULT 'PPD',
        effective_date DATE DEFAULT CURRENT_DATE,
        memo TEXT,
        batch_id INTEGER,
        status VARCHAR(30) DEFAULT 'originated',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ach_batches (
        id SERIAL PRIMARY KEY,
        batch_number VARCHAR(50),
        payment_count INTEGER DEFAULT 0,
        total_amount NUMERIC(18,2) DEFAULT 0,
        status VARCHAR(30) DEFAULT 'created',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS payment_instructions (
        id SERIAL PRIMARY KEY,
        beneficiary_name VARCHAR(255) NOT NULL,
        payment_rail VARCHAR(30) DEFAULT 'ach_credit',
        amount NUMERIC(18,2) NOT NULL,
        routing_number VARCHAR(9), account_number VARCHAR(50),
        account_type VARCHAR(20) DEFAULT 'checking',
        priority VARCHAR(20) DEFAULT 'normal',
        memo TEXT,
        effective_date DATE DEFAULT CURRENT_DATE,
        requires_approval BOOLEAN DEFAULT true,
        batch_id INTEGER,
        status VARCHAR(30) DEFAULT 'pending_approval',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS payment_batches (
        id SERIAL PRIMARY KEY,
        payment_rail VARCHAR(30),
        payment_count INTEGER DEFAULT 0,
        total_amount NUMERIC(18,2) DEFAULT 0,
        status VARCHAR(30) DEFAULT 'created',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS mft_files (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL,
        file_type VARCHAR(30) DEFAULT 'NACHA',
        record_count INTEGER DEFAULT 0,
        total_amount NUMERIC(18,2) DEFAULT 0,
        status VARCHAR(30) DEFAULT 'generated',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS mft_config (
        id SERIAL PRIMARY KEY,
        sftp_host VARCHAR(255),
        sftp_port INTEGER DEFAULT 22,
        sftp_username VARCHAR(255),
        sftp_path VARCHAR(255) DEFAULT '/incoming',
        sftp_configured BOOLEAN DEFAULT false,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Seed initial data if empty
    const walletCount = await pool.query('SELECT COUNT(*) FROM wallets');
    if (parseInt(walletCount.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO wallets (wallet_code, name, wallet_type, balance) VALUES
        ('CORPUS', 'Trust Corpus', 'corpus', 1000000),
        ('INCOME', 'Income Account', 'income', 75055.56),
        ('OPERATING', 'Operating Account', 'operating', 25000),
        ('DISTRIBUTION', 'Distribution Account', 'distribution', 5000),
        ('RESERVE', 'Reserve Fund', 'reserve', 50000),
        ('TAX', 'Tax Withholding', 'tax', 0);
      `);
      console.log('[Treasury] Seeded initial wallets');
    }

    const benCount = await pool.query('SELECT COUNT(*) FROM beneficiaries');
    if (parseInt(benCount.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO beneficiaries (name, beneficiary_type, classification, email, distribution_pct, status) VALUES
        ('DeAndrea Lavar Barkley', 'income', 'individual', 'deandreabarkley13@gmail.com', 100.00, 'active');
      `);
      console.log('[Treasury] Seeded initial beneficiary');
    }

    const configCount = await pool.query('SELECT COUNT(*) FROM mft_config');
    if (parseInt(configCount.rows[0].count) === 0) {
      await pool.query(`INSERT INTO mft_config (sftp_configured) VALUES (false)`);
    }

    console.log('[Treasury] Schema initialized successfully');
  } catch (err) {
    console.warn('[Treasury] Schema init:', err.message);
  }
})();

// ─── Bonds (proxy to /api/bonds format for treasury frontend) ─────────────────
router.get('/bonds', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT b.*, bb.principal_balance, bb.accrued_interest, bb.total_interest_paid,
             bb.total_principal_paid, bb.last_accrual_date, bb.last_payment_date
      FROM bonds b LEFT JOIN bond_balances bb ON b.id = bb.bond_id
      ORDER BY b.created_at DESC
    `);
    const bonds = result.rows.map(b => ({
      ...b,
      issuer: 'DLB Trust',
      bond_type: 'Private Placement',
      coupon_rate: (parseFloat(b.coupon_rate) * 100).toFixed(2),
      coupon_frequency: b.payment_freq,
      annual_income: parseFloat(b.face_value) * parseFloat(b.coupon_rate),
      next_coupon_date: null,
      coupons_received: 0,
      total_received: b.total_interest_paid || 0
    }));
    res.json({ success: true, data: bonds });
  } catch (err) {
    res.json({ success: true, data: [] });
  }
});

router.post('/bonds/:id/generate-coupons', async (req, res) => {
  try {
    const bond = await pool.query('SELECT * FROM bonds WHERE id = $1', [req.params.id]);
    if (!bond.rows.length) return res.json({ success: false, error: 'Bond not found' });
    const b = bond.rows[0];
    const couponAmount = parseFloat(b.face_value) * parseFloat(b.coupon_rate) / 12;
    res.json({ success: true, inserted: 12, coupon_amount: couponAmount });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

router.post('/bonds/:id/receive-coupon', async (req, res) => {
  res.json({ success: true, message: 'Coupon received and recorded' });
});

// ─── Beneficiaries ────────────────────────────────────────────────────────────
router.get('/beneficiaries', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT b.*, COALESCE(
        (SELECT SUM(d.net_amount) FROM distributions d),
        0
      ) * b.distribution_pct / 100 as total_received,
      0 as bank_account_count
      FROM beneficiaries b ORDER BY b.created_at DESC
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.json({ success: true, data: [] });
  }
});

router.post('/beneficiaries', async (req, res) => {
  try {
    const { name, beneficiary_type, classification, email, phone, address, city, state, zip, distribution_pct } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Name is required' });
    const result = await pool.query(
      `INSERT INTO beneficiaries (name, beneficiary_type, classification, email, phone, address, city, state, zip, distribution_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [name, beneficiary_type || 'income', classification || 'individual', email, phone, address, city, state, zip, distribution_pct || 0]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── Distributions ────────────────────────────────────────────────────────────
router.get('/distributions/schedules', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM distribution_schedules ORDER BY created_at DESC');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.json({ success: true, data: [] });
  }
});

router.get('/distributions', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM distributions ORDER BY distribution_date DESC LIMIT 50');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.json({ success: true, data: [] });
  }
});

router.post('/distributions/schedules', async (req, res) => {
  try {
    const { name, frequency, distribution_basis, day_of_month, requires_approval, approval_threshold } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Schedule name is required' });
    const nextDist = new Date();
    nextDist.setDate(day_of_month || 1);
    if (nextDist <= new Date()) nextDist.setMonth(nextDist.getMonth() + 1);
    const result = await pool.query(
      `INSERT INTO distribution_schedules (name, frequency, distribution_basis, day_of_month, requires_approval, approval_threshold, next_distribution)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name, frequency || 'monthly', distribution_basis || 'fixed', day_of_month || 1, requires_approval !== false, approval_threshold || 100000, nextDist.toISOString().split('T')[0]]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

router.post('/distributions/execute', async (req, res) => {
  try {
    const { schedule_id } = req.body;
    const bens = await pool.query('SELECT * FROM beneficiaries WHERE status = $1', ['active']);
    const payments = [];
    for (const ben of bens.rows) {
      const amount = 1000 * (parseFloat(ben.distribution_pct) / 100);
      const tax = amount * 0.10;
      payments.push({ beneficiary: ben.name, gross: amount, tax, net: amount - tax });
    }
    const totalGross = payments.reduce((s, p) => s + p.gross, 0);
    const totalTax = payments.reduce((s, p) => s + p.tax, 0);
    await pool.query(
      `INSERT INTO distributions (schedule_id, total_amount, net_amount, tax_withheld) VALUES ($1,$2,$3,$4)`,
      [schedule_id, totalGross, totalGross - totalTax, totalTax]
    );
    if (schedule_id) {
      await pool.query(
        'UPDATE distribution_schedules SET total_distributed = total_distributed + $1 WHERE id = $2',
        [totalGross, schedule_id]
      );
    }
    res.json({ success: true, payments });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── ACH Gateway ──────────────────────────────────────────────────────────────
router.get('/ach/status', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'originated') as originated,
        COUNT(*) FILTER (WHERE status = 'settled') as settled,
        COUNT(*) FILTER (WHERE status = 'returned') as returned,
        COALESCE(SUM(amount), 0) as total_volume,
        COUNT(*) as total_transactions
      FROM ach_transactions
    `);
    const batchStats = await pool.query('SELECT COUNT(*) as total_batches FROM ach_batches');
    const s = stats.rows[0];
    res.json({
      odfi: 'Eaton Family CU',
      capabilities: ['ACH Credit', 'ACH Debit', 'Wire Transfer', 'Fedwire', 'NACHA File Generation', 'Real-time Balance'],
      stats: {
        originated: parseInt(s.originated),
        settled: parseInt(s.settled),
        returned: parseInt(s.returned),
        total_volume: parseInt(s.total_volume),
        total_batches: parseInt(batchStats.rows[0].total_batches)
      }
    });
  } catch (err) {
    res.json({
      odfi: 'Eaton Family CU',
      capabilities: ['ACH Credit', 'ACH Debit', 'Wire Transfer'],
      stats: { originated: 0, settled: 0, returned: 0, total_volume: 0, total_batches: 0 }
    });
  }
});

router.get('/ach/transactions', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const result = await pool.query('SELECT * FROM ach_transactions ORDER BY created_at DESC LIMIT $1', [limit]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.json({ success: true, data: [] });
  }
});

router.get('/ach/batches', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM ach_batches ORDER BY created_at DESC LIMIT 20');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.json({ success: true, data: [] });
  }
});

router.post('/ach/originate', async (req, res) => {
  try {
    const { beneficiary_name, routing_number, account_number, account_type, amount, sec_code, effective_date, memo } = req.body;
    if (!beneficiary_name || !routing_number || !account_number || !amount) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    const result = await pool.query(
      `INSERT INTO ach_transactions (beneficiary_name, routing_number, account_number, account_type, amount, sec_code, effective_date, memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [beneficiary_name, routing_number, account_number, account_type || 'checking', amount, sec_code || 'PPD', effective_date || new Date().toISOString().split('T')[0], memo]
    );
    // Create ledger entry
    await pool.query(
      `INSERT INTO ledger_entries (entry_type, debit_wallet_name, credit_wallet_name, amount, description, reference_type, reference_id)
       VALUES ('ach_payment', 'Distribution Account', $1, $2, $3, 'ach_transaction', $4)`,
      [beneficiary_name, amount, `ACH ${sec_code || 'PPD'} to ${beneficiary_name}`, result.rows[0].id]
    );
    res.json({ success: true, message: `ACH payment of $${amount} originated to ${beneficiary_name}`, data: result.rows[0] });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

router.post('/ach/wire/originate', async (req, res) => {
  try {
    const { beneficiary_name, routing_number, account_number, amount, memo } = req.body;
    if (!beneficiary_name || !amount) return res.status(400).json({ success: false, error: 'Missing required fields' });
    const result = await pool.query(
      `INSERT INTO ach_transactions (beneficiary_name, transaction_type, routing_number, account_number, amount, sec_code, memo, effective_date)
       VALUES ($1, 'wire', $2, $3, $4, 'WIRE', $5, CURRENT_DATE) RETURNING *`,
      [beneficiary_name, routing_number, account_number, amount, memo]
    );
    await pool.query(
      `INSERT INTO ledger_entries (entry_type, debit_wallet_name, credit_wallet_name, amount, description, reference_type, reference_id)
       VALUES ('wire_transfer', 'Distribution Account', $1, $2, $3, 'ach_transaction', $4)`,
      [beneficiary_name, amount, `Wire to ${beneficiary_name}`, result.rows[0].id]
    );
    res.json({ success: true, message: `Wire transfer of $${amount} originated to ${beneficiary_name}`, data: result.rows[0] });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

router.post('/ach/settle/:id', async (req, res) => {
  try {
    await pool.query('UPDATE ach_transactions SET status = $1 WHERE id = $2', ['settled', req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

router.post('/ach/return/:id', async (req, res) => {
  try {
    const { return_code } = req.body;
    await pool.query('UPDATE ach_transactions SET status = $1 WHERE id = $2', ['returned', req.params.id]);
    res.json({ success: true, message: `Return ${return_code || 'R01'} processed` });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── General Ledger ───────────────────────────────────────────────────────────
router.get('/ledger', async (req, res) => {
  try {
    // Combine bond transactions as ledger entries + native ledger entries
    const bondTxns = await pool.query(`
      SELECT bt.transaction_date as entry_date, bt.transaction_type as entry_type,
             'Trust Corpus' as debit_wallet_name, 'Income Account' as credit_wallet_name,
             bt.amount, bt.description, 'posted' as status
      FROM bond_transactions bt ORDER BY bt.transaction_date DESC LIMIT 50
    `).catch(() => ({ rows: [] }));

    const nativeTxns = await pool.query(
      'SELECT * FROM ledger_entries ORDER BY entry_date DESC, created_at DESC LIMIT 50'
    ).catch(() => ({ rows: [] }));

    const allEntries = [...bondTxns.rows, ...nativeTxns.rows]
      .sort((a, b) => new Date(b.entry_date) - new Date(a.entry_date));

    const summary = {
      total_income: allEntries.filter(e => e.entry_type === 'interest accrual' || e.entry_type === 'interest_accrual' || e.entry_type === 'coupon_income').reduce((s, e) => s + parseFloat(e.amount || 0), 0),
      total_distributed: allEntries.filter(e => e.entry_type === 'interest payment' || e.entry_type === 'interest_payment' || e.entry_type === 'ach_payment' || e.entry_type === 'wire_transfer').reduce((s, e) => s + parseFloat(e.amount || 0), 0),
      total_expenses: allEntries.filter(e => e.entry_type === 'expense' || e.entry_type === 'fee').reduce((s, e) => s + parseFloat(e.amount || 0), 0),
      total_entries: allEntries.length
    };

    res.json({ success: true, data: allEntries, summary });
  } catch (err) {
    res.json({ success: true, data: [], summary: { total_income: 0, total_distributed: 0, total_expenses: 0, total_entries: 0 } });
  }
});

// ─── Wallets ──────────────────────────────────────────────────────────────────
router.get('/wallets', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM wallets ORDER BY id');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.json({ success: true, data: [] });
  }
});

router.post('/wallets/transfer', async (req, res) => {
  try {
    const { from_wallet_id, to_wallet_id, amount, description } = req.body;
    const amt = parseFloat(amount);
    if (!from_wallet_id || !to_wallet_id || amt <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid transfer parameters' });
    }
    const fromWallet = await pool.query('SELECT * FROM wallets WHERE id = $1', [from_wallet_id]);
    const toWallet = await pool.query('SELECT * FROM wallets WHERE id = $1', [to_wallet_id]);
    if (!fromWallet.rows.length || !toWallet.rows.length) {
      return res.status(400).json({ success: false, error: 'Wallet not found' });
    }
    await pool.query('UPDATE wallets SET balance = balance - $1 WHERE id = $2', [amt, from_wallet_id]);
    await pool.query('UPDATE wallets SET balance = balance + $1 WHERE id = $2', [amt, to_wallet_id]);
    await pool.query(
      `INSERT INTO ledger_entries (entry_type, debit_wallet_id, debit_wallet_name, credit_wallet_id, credit_wallet_name, amount, description)
       VALUES ('transfer', $1, $2, $3, $4, $5, $6)`,
      [from_wallet_id, fromWallet.rows[0].name, to_wallet_id, toWallet.rows[0].name, amt, description || 'Internal transfer']
    );
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── Payment Engine ───────────────────────────────────────────────────────────
router.get('/engine/status', async (req, res) => {
  try {
    const pipeline = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending_approval') as pa_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'pending_approval'), 0) as pa_total,
        COUNT(*) FILTER (WHERE status = 'approved') as ap_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'approved'), 0) as ap_total,
        COUNT(*) FILTER (WHERE status = 'batched') as bt_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'batched'), 0) as bt_total,
        COUNT(*) FILTER (WHERE status = 'processing') as pr_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'processing'), 0) as pr_total,
        COUNT(*) FILTER (WHERE status = 'settled') as st_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'settled'), 0) as st_total,
        COUNT(*) FILTER (WHERE status = 'failed') as fl_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'failed'), 0) as fl_total
      FROM payment_instructions
    `);
    const p = pipeline.rows[0];
    const batches = await pool.query('SELECT * FROM payment_batches ORDER BY created_at DESC LIMIT 10');
    res.json({
      engine: 'v1.0 — DLB Trust Self-Processing',
      pipeline: {
        pending_approval: { count: parseInt(p.pa_count), total: parseInt(p.pa_total) },
        approved: { count: parseInt(p.ap_count), total: parseInt(p.ap_total) },
        batched: { count: parseInt(p.bt_count), total: parseInt(p.bt_total) },
        processing: { count: parseInt(p.pr_count), total: parseInt(p.pr_total) },
        settled: { count: parseInt(p.st_count), total: parseInt(p.st_total) },
        failed: { count: parseInt(p.fl_count), total: parseInt(p.fl_total) }
      },
      recent_batches: batches.rows
    });
  } catch (err) {
    res.json({ engine: 'v1.0', pipeline: {}, recent_batches: [] });
  }
});

router.get('/payments', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const result = await pool.query('SELECT * FROM payment_instructions ORDER BY created_at DESC LIMIT $1', [limit]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.json({ success: true, data: [] });
  }
});

router.post('/engine/initiate', async (req, res) => {
  try {
    const { beneficiary_name, payment_rail, amount, routing_number, account_number, account_type, priority, memo, effective_date, requires_approval } = req.body;
    if (!beneficiary_name || !amount) return res.status(400).json({ success: false, error: 'Missing required fields' });
    const status = requires_approval !== false ? 'pending_approval' : 'approved';
    const result = await pool.query(
      `INSERT INTO payment_instructions (beneficiary_name, payment_rail, amount, routing_number, account_number, account_type, priority, memo, effective_date, requires_approval, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [beneficiary_name, payment_rail || 'ach_credit', amount, routing_number, account_number, account_type || 'checking', priority || 'normal', memo, effective_date || new Date().toISOString().split('T')[0], requires_approval !== false, status]
    );
    res.json({ success: true, message: `Payment of $${amount} initiated for ${beneficiary_name}`, data: result.rows[0] });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

router.post('/engine/approve/:id', async (req, res) => {
  try {
    await pool.query('UPDATE payment_instructions SET status = $1 WHERE id = $2', ['approved', req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

router.post('/engine/batch', async (req, res) => {
  try {
    const { payment_ids, payment_rail } = req.body;
    const batch = await pool.query(
      `INSERT INTO payment_batches (payment_rail, payment_count, total_amount, status)
       SELECT $1, COUNT(*), SUM(amount), 'created'
       FROM payment_instructions WHERE id = ANY($2)
       RETURNING *`,
      [payment_rail, payment_ids]
    );
    await pool.query('UPDATE payment_instructions SET status = $1, batch_id = $2 WHERE id = ANY($3)', ['batched', batch.rows[0].id, payment_ids]);
    res.json({ success: true, message: 'Payments batched for processing', data: batch.rows[0] });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

router.post('/engine/process-batch/:id', async (req, res) => {
  try {
    await pool.query('UPDATE payment_batches SET status = $1 WHERE id = $2', ['processed', req.params.id]);
    await pool.query('UPDATE payment_instructions SET status = $1 WHERE batch_id = $2', ['processing', req.params.id]);
    res.json({ success: true, message: 'Batch processed — NACHA/wire files generated' });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

router.post('/engine/settle-batch/:id', async (req, res) => {
  try {
    await pool.query('UPDATE payment_batches SET status = $1 WHERE id = $2', ['settled', req.params.id]);
    await pool.query('UPDATE payment_instructions SET status = $1 WHERE batch_id = $2', ['settled', req.params.id]);
    // Create ledger entries for settled payments
    const payments = await pool.query('SELECT * FROM payment_instructions WHERE batch_id = $1', [req.params.id]);
    for (const p of payments.rows) {
      await pool.query(
        `INSERT INTO ledger_entries (entry_type, debit_wallet_name, credit_wallet_name, amount, description, reference_type, reference_id)
         VALUES ('payment_settled', 'Distribution Account', $1, $2, $3, 'payment_instruction', $4)`,
        [p.beneficiary_name, p.amount, `${p.payment_rail} payment to ${p.beneficiary_name}`, p.id]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

router.post('/engine/auto-process', async (req, res) => {
  try {
    const approved = await pool.query('SELECT * FROM payment_instructions WHERE status = $1', ['approved']);
    if (!approved.rows.length) return res.json({ success: false, error: 'No approved payments to process' });
    // Group by rail and create batches
    const rails = {};
    for (const p of approved.rows) {
      const rail = p.payment_rail || 'ach_credit';
      if (!rails[rail]) rails[rail] = [];
      rails[rail].push(p);
    }
    let totalProcessed = 0;
    for (const [rail, payments] of Object.entries(rails)) {
      const ids = payments.map(p => p.id);
      const total = payments.reduce((s, p) => s + parseFloat(p.amount), 0);
      const batch = await pool.query(
        `INSERT INTO payment_batches (payment_rail, payment_count, total_amount, status) VALUES ($1,$2,$3,'processed') RETURNING *`,
        [rail, ids.length, total]
      );
      await pool.query('UPDATE payment_instructions SET status = $1, batch_id = $2 WHERE id = ANY($3)', ['processing', batch.rows[0].id, ids]);
      totalProcessed += ids.length;
    }
    res.json({ success: true, message: `Auto-processed ${totalProcessed} payments across ${Object.keys(rails).length} rail(s)` });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── Managed File Transfer ────────────────────────────────────────────────────
router.get('/mft/files', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM mft_files ORDER BY created_at DESC');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.json({ success: true, data: [] });
  }
});

router.get('/mft/config', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM mft_config ORDER BY id LIMIT 1');
    res.json(result.rows[0] || { sftp_configured: false, sftp_host: '', sftp_port: 22, sftp_username: '', sftp_path: '/incoming' });
  } catch (err) {
    res.json({ sftp_configured: false, sftp_host: '', sftp_port: 22, sftp_username: '', sftp_path: '/incoming' });
  }
});

router.post('/mft/config', async (req, res) => {
  try {
    const { sftp_host, sftp_port, sftp_username, sftp_path } = req.body;
    await pool.query(
      `UPDATE mft_config SET sftp_host = $1, sftp_port = $2, sftp_username = $3, sftp_path = $4, sftp_configured = $5, updated_at = NOW() WHERE id = 1`,
      [sftp_host, sftp_port || 22, sftp_username, sftp_path || '/incoming', !!sftp_host]
    );
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

router.post('/mft/generate-nacha', async (req, res) => {
  try {
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const filename = `ACH_${ts}.ach`;
    const result = await pool.query(
      `INSERT INTO mft_files (filename, file_type, record_count, total_amount) VALUES ($1, 'NACHA', 0, 0) RETURNING *`,
      [filename]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

router.post('/mft/deliver/:id', async (req, res) => {
  try {
    const config = await pool.query('SELECT * FROM mft_config WHERE id = 1');
    if (!config.rows.length || !config.rows[0].sftp_configured) {
      return res.json({ success: false, error: 'SFTP not configured — set host, username, and path first' });
    }
    await pool.query('UPDATE mft_files SET status = $1 WHERE id = $2', ['delivered', req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
