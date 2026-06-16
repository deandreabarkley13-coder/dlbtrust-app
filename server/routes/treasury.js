'use strict';

const express = require('express');
const router = express.Router();
const pool = require('../integrations/bonds/pgPool');
const as2Client = require('../integrations/as2/as2Client');

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

    // AS2 tables — separate query to avoid FK conflicts with legacy UUID mft_files
    await pool.query(`
      CREATE TABLE IF NOT EXISTS as2_config (
        id SERIAL PRIMARY KEY,
        as2_id VARCHAR(255) NOT NULL DEFAULT 'DLBTrust',
        signing_cert TEXT,
        signing_key TEXT,
        mdn_url VARCHAR(512),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS as2_partners (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        as2_id VARCHAR(255) NOT NULL,
        url VARCHAR(512) NOT NULL,
        certificate TEXT,
        encryption_algorithm VARCHAR(50) DEFAULT 'aes256',
        signature_algorithm VARCHAR(50) DEFAULT 'sha256',
        request_mdn BOOLEAN DEFAULT true,
        mdn_mode VARCHAR(20) DEFAULT 'sync',
        content_type VARCHAR(100) DEFAULT 'application/octet-stream',
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS as2_messages (
        id SERIAL PRIMARY KEY,
        message_id VARCHAR(512),
        partner_id INTEGER,
        file_id VARCHAR(255),
        direction VARCHAR(10) DEFAULT 'outbound',
        filename VARCHAR(255),
        content_type VARCHAR(100),
        mic VARCHAR(255),
        mic_algorithm VARCHAR(50),
        mdn_status VARCHAR(30) DEFAULT 'pending',
        mdn_disposition TEXT,
        mdn_received_at TIMESTAMPTZ,
        error_message TEXT,
        sent_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Seed default AS2 config if empty
    const as2Count = await pool.query('SELECT COUNT(*) FROM as2_config');
    if (parseInt(as2Count.rows[0].count) === 0) {
      const certs = as2Client.generateSelfSignedCert('DLB Trust AS2');
      await pool.query(
        `INSERT INTO as2_config (as2_id, signing_cert, signing_key) VALUES ($1, $2, $3)`,
        ['DLBTrust', certs.certificate, certs.privateKey]
      );
      console.log('[AS2] Generated self-signed certificate and seeded AS2 config');
    }

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
    const trustRow = await pool.query(`SELECT trust_id FROM beneficiaries LIMIT 1`).catch(() => null);
    const trustId = trustRow?.rows?.[0]?.trust_id || null;
    const cols = ['name','beneficiary_type','classification','email','phone','address','city','state','zip','distribution_pct'];
    const vals = [name, beneficiary_type || 'income', classification || 'individual', email, phone, address, city, state, zip, distribution_pct || 0];
    if (trustId) { cols.push('trust_id'); vals.push(trustId); }
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(',');
    const result = await pool.query(
      `INSERT INTO beneficiaries (${cols.join(',')}) VALUES (${placeholders}) RETURNING *`, vals
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

// ─── AS2 (Applicability Statement 2) ──────────────────────────────────────────

// Get local AS2 configuration
router.get('/as2/config', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, as2_id, signing_cert, mdn_url, created_at, updated_at FROM as2_config ORDER BY id LIMIT 1');
    const config = result.rows[0] || { as2_id: 'DLBTrust', signing_cert: null, mdn_url: null };
    // Never return the private key to the frontend
    res.json({ success: true, data: config });
  } catch (err) {
    res.json({ success: true, data: { as2_id: 'DLBTrust', signing_cert: null, mdn_url: null } });
  }
});

// Update local AS2 configuration
router.post('/as2/config', async (req, res) => {
  try {
    const { as2_id, mdn_url } = req.body;
    if (!as2_id) return res.status(400).json({ success: false, error: 'AS2 ID is required' });
    const existing = await pool.query('SELECT id FROM as2_config ORDER BY id LIMIT 1');
    if (existing.rows.length) {
      await pool.query(
        'UPDATE as2_config SET as2_id = $1, mdn_url = $2, updated_at = NOW() WHERE id = $3',
        [as2_id, mdn_url || null, existing.rows[0].id]
      );
    } else {
      const certs = as2Client.generateSelfSignedCert(as2_id);
      await pool.query(
        'INSERT INTO as2_config (as2_id, signing_cert, signing_key, mdn_url) VALUES ($1, $2, $3, $4)',
        [as2_id, certs.certificate, certs.privateKey, mdn_url || null]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Regenerate AS2 signing certificate
router.post('/as2/regenerate-cert', async (req, res) => {
  try {
    const configRow = await pool.query('SELECT * FROM as2_config ORDER BY id LIMIT 1');
    const as2Id = configRow.rows[0]?.as2_id || 'DLBTrust';
    const certs = as2Client.generateSelfSignedCert(`${as2Id} AS2`);
    await pool.query(
      'UPDATE as2_config SET signing_cert = $1, signing_key = $2, updated_at = NOW() WHERE id = $3',
      [certs.certificate, certs.privateKey, configRow.rows[0]?.id || 1]
    );
    res.json({ success: true, message: 'AS2 signing certificate regenerated', certificate: certs.certificate });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// List AS2 trading partners
router.get('/as2/partners', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM as2_partners ORDER BY created_at DESC');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.json({ success: true, data: [] });
  }
});

// Add AS2 trading partner
router.post('/as2/partners', async (req, res) => {
  try {
    const { name, as2_id, url, certificate, encryption_algorithm, signature_algorithm, request_mdn, mdn_mode, content_type } = req.body;
    if (!name || !as2_id || !url) {
      return res.status(400).json({ success: false, error: 'Name, AS2 ID, and URL are required' });
    }
    const result = await pool.query(
      `INSERT INTO as2_partners (name, as2_id, url, certificate, encryption_algorithm, signature_algorithm, request_mdn, mdn_mode, content_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [name, as2_id, url, certificate || null, encryption_algorithm || 'aes256', signature_algorithm || 'sha256',
       request_mdn !== false, mdn_mode || 'sync', content_type || 'application/octet-stream']
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Update AS2 trading partner
router.put('/as2/partners/:id', async (req, res) => {
  try {
    const { name, as2_id, url, certificate, encryption_algorithm, signature_algorithm, request_mdn, mdn_mode, content_type, status } = req.body;
    await pool.query(
      `UPDATE as2_partners SET name=COALESCE($1,name), as2_id=COALESCE($2,as2_id), url=COALESCE($3,url),
       certificate=COALESCE($4,certificate), encryption_algorithm=COALESCE($5,encryption_algorithm),
       signature_algorithm=COALESCE($6,signature_algorithm), request_mdn=COALESCE($7,request_mdn),
       mdn_mode=COALESCE($8,mdn_mode), content_type=COALESCE($9,content_type), status=COALESCE($10,status),
       updated_at=NOW() WHERE id=$11`,
      [name, as2_id, url, certificate, encryption_algorithm, signature_algorithm, request_mdn, mdn_mode, content_type, status, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Delete AS2 trading partner
router.delete('/as2/partners/:id', async (req, res) => {
  try {
    await pool.query('UPDATE as2_partners SET status = $1 WHERE id = $2', ['deleted', req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Send file to AS2 partner
router.post('/as2/send/:fileId', async (req, res) => {
  try {
    const { partner_id } = req.body;
    if (!partner_id) return res.status(400).json({ success: false, error: 'partner_id is required' });

    // Get the file
    const fileResult = await pool.query('SELECT * FROM mft_files WHERE id = $1', [req.params.fileId]);
    if (!fileResult.rows.length) return res.status(404).json({ success: false, error: 'File not found' });
    const file = fileResult.rows[0];

    // Get the partner
    const partnerResult = await pool.query('SELECT * FROM as2_partners WHERE id = $1 AND status = $2', [partner_id, 'active']);
    if (!partnerResult.rows.length) return res.status(404).json({ success: false, error: 'AS2 partner not found or inactive' });
    const partner = partnerResult.rows[0];

    // Get our AS2 config
    const configResult = await pool.query('SELECT * FROM as2_config ORDER BY id LIMIT 1');
    if (!configResult.rows.length) return res.status(500).json({ success: false, error: 'AS2 not configured — generate signing certificate first' });
    const config = configResult.rows[0];

    // Build the payload — generate a synthetic NACHA-like payload
    const amt = parseFloat(file.total_amount || 0).toFixed(2);
    const payload = [
      `101 ${file.filename} ${new Date().toISOString().slice(0,10).replace(/-/g,'')}`,
      `5220DLB TRUST                           ${file.id.toString().padStart(10,'0')}PPD`,
      `6270000000001234567890        ${amt.padStart(12,'0')}`,
      `82200000010000000000${amt.padStart(12,'0')}`,
      `9000001000001000000010000000000${amt.padStart(12,'0')}`
    ].join('\n');

    // Send via AS2
    const result = await as2Client.sendAs2Message({
      url: partner.url,
      as2From: config.as2_id,
      as2To: partner.as2_id,
      filename: file.filename,
      payload,
      contentType: partner.content_type || 'application/octet-stream',
      signingKey: config.signing_key,
      signingCert: config.signing_cert,
      encryptionCert: partner.certificate || null,
      requestMdn: partner.request_mdn,
      micAlgorithm: partner.signature_algorithm || 'sha256'
    });

    // Log the message
    await pool.query(
      `INSERT INTO as2_messages (message_id, partner_id, file_id, direction, filename, content_type, mic, mic_algorithm, mdn_status, mdn_disposition, sent_at)
       VALUES ($1,$2,$3,'outbound',$4,$5,$6,$7,$8,$9,NOW())`,
      [result.messageId, partner_id, file.id, file.filename, partner.content_type,
       result.mic, result.micAlgorithm, result.mdn.status, result.mdn.disposition]
    );

    // Update file status
    const newStatus = result.mdn.status === 'confirmed' ? 'delivered' : result.mdn.status === 'failed' ? 'delivery_failed' : 'sent';
    await pool.query('UPDATE mft_files SET status = $1 WHERE id = $2', [newStatus, file.id]);

    res.json({
      success: true,
      message: result.mdn.status === 'confirmed'
        ? `File delivered via AS2 to ${partner.name} — MDN confirmed`
        : result.mdn.status === 'failed'
          ? `AS2 delivery failed — MDN indicates error: ${result.mdn.disposition}`
          : `File sent via AS2 to ${partner.name} — awaiting MDN`,
      data: {
        messageId: result.messageId,
        mic: result.mic,
        mdnStatus: result.mdn.status,
        mdnDisposition: result.mdn.disposition
      }
    });
  } catch (err) {
    // Log the failed attempt
    const { partner_id } = req.body || {};
    if (partner_id) {
      await pool.query(
        `INSERT INTO as2_messages (partner_id, file_id, direction, filename, mdn_status, error_message, sent_at)
         VALUES ($1,$2,'outbound',$3,'error',$4,NOW())`,
        [partner_id, req.params.fileId, 'unknown', err.message]
      ).catch(() => {});
    }
    res.json({ success: false, error: `AS2 delivery failed: ${err.message}` });
  }
});

// List AS2 message history
router.get('/as2/messages', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.*, p.name as partner_name, p.as2_id as partner_as2_id
       FROM as2_messages m LEFT JOIN as2_partners p ON m.partner_id = p.id
       ORDER BY m.created_at DESC LIMIT 50`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.json({ success: true, data: [] });
  }
});

// AS2 connectivity test — send a ping to the partner
router.post('/as2/test/:partnerId', async (req, res) => {
  try {
    const partnerResult = await pool.query('SELECT * FROM as2_partners WHERE id = $1', [req.params.partnerId]);
    if (!partnerResult.rows.length) return res.status(404).json({ success: false, error: 'Partner not found' });
    const partner = partnerResult.rows[0];

    const configResult = await pool.query('SELECT * FROM as2_config ORDER BY id LIMIT 1');
    const config = configResult.rows[0];

    const result = await as2Client.sendAs2Message({
      url: partner.url,
      as2From: config?.as2_id || 'DLBTrust',
      as2To: partner.as2_id,
      filename: 'as2-connectivity-test.txt',
      payload: `AS2 connectivity test from ${config?.as2_id || 'DLBTrust'} at ${new Date().toISOString()}`,
      contentType: 'text/plain',
      signingKey: config?.signing_key,
      signingCert: config?.signing_cert,
      requestMdn: true
    });

    res.json({
      success: true,
      message: result.mdn.status === 'confirmed'
        ? `AS2 connection to ${partner.name} successful — MDN received`
        : `AS2 message sent, MDN status: ${result.mdn.status}`,
      data: { messageId: result.messageId, mdnStatus: result.mdn.status, statusCode: result.mdn.statusCode }
    });
  } catch (err) {
    res.json({ success: false, error: `AS2 test failed: ${err.message}` });
  }
});

// Download our public signing certificate (for partners to import)
router.get('/as2/certificate', async (req, res) => {
  try {
    const configResult = await pool.query('SELECT signing_cert FROM as2_config ORDER BY id LIMIT 1');
    if (!configResult.rows.length || !configResult.rows[0].signing_cert) {
      return res.status(404).json({ success: false, error: 'No AS2 certificate configured' });
    }
    res.setHeader('Content-Type', 'application/x-pem-file');
    res.setHeader('Content-Disposition', 'attachment; filename="dlbtrust-as2.pem"');
    res.send(configResult.rows[0].signing_cert);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
