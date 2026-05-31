/**
 * Vendor Management Routes
 * DEANDREA LAVAR BARKLEY TRUST — Private Trust Payment Processing
 *
 * Endpoints:
 *   GET    /api/vendors                  — List all vendors (filterable)
 *   GET    /api/vendors/:id              — Single vendor with payment history
 *   POST   /api/vendors                  — Register a new vendor
 *   PUT    /api/vendors/:id              — Update vendor details
 *   DELETE /api/vendors/:id              — Deactivate a vendor
 *   GET    /api/vendors/:id/payments     — Vendor payment history
 *   POST   /api/vendors/:id/pay          — Create a vendor payment
 *   GET    /api/vendors/report/1099      — 1099 reporting data for fiscal year
 */

'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const Database = require('better-sqlite3');
const {
  validateVendor,
  calculateFee,
  createLedgerEntry,
} = require('../engines/payment-engine');

// ─── Database Setup ───────────────────────────────────────────────────────────

function getDb() {
  const dbPaths = [
    path.join(__dirname, '..', '..', 'data', 'dlbtrust.db'),
    path.join(__dirname, '..', 'trust.db'),
    path.join(__dirname, '..', '..', 'trust.db'),
    '/app/trust.db',
  ];
  for (const p of dbPaths) {
    try { return new Database(p); } catch (_) {}
  }
  const memDb = new Database(':memory:');
  initSchema(memDb);
  return memDb;
}

function initSchema(db) {
  const schemaPath = path.join(__dirname, '..', 'db', 'migrations', 'payment-schema.sql');
  try {
    const sql = fs.readFileSync(schemaPath, 'utf8');
    db.exec(sql);
  } catch (err) {
    console.warn('[vendors] Schema init warning:', err.message);
  }
}

// ─── Middleware ────────────────────────────────────────────────────────────────

router.use((req, res, next) => {
  try {
    req.payDb = req.app.locals.db || getDb();
    initSchema(req.payDb);
    next();
  } catch (err) {
    res.status(500).json({ error: 'Vendor DB connection failed', detail: err.message });
  }
});

const toDollars = (cents) => (cents !== null && cents !== undefined) ? Math.round(cents) / 100 : null;

// ─── GET /report/1099 ─────────────────────────────────────────────────────────

router.get('/report/1099', (req, res) => {
  try {
    const db = req.payDb;
    const fiscalYear = parseInt(req.query.year) || new Date().getFullYear();
    const threshold = parseInt(req.query.threshold_cents) || 60000; // $600 default IRS threshold

    const vendors = db.prepare(`
      SELECT v.id, v.vendor_name, v.tax_id, v.tax_id_type, v.vendor_type,
             v.address_line1, v.city, v.state, v.zip_code,
             COALESCE(SUM(vp.amount_cents), 0) as total_paid_cents,
             COUNT(vp.id) as payment_count
      FROM vendors v
      LEFT JOIN vendor_payments vp ON v.id = vp.vendor_id AND vp.status = 'completed' AND vp.fiscal_year = ?
      GROUP BY v.id
      HAVING total_paid_cents >= ?
      ORDER BY total_paid_cents DESC
    `).all(fiscalYear, threshold);

    res.json({
      fiscal_year: fiscalYear,
      threshold_cents: threshold,
      threshold_usd: toDollars(threshold),
      reportable_vendors: vendors.length,
      vendors: vendors.map(v => ({
        ...v,
        total_paid_usd: toDollars(v.total_paid_cents),
        requires_1099: v.total_paid_cents >= threshold,
        w9_on_file: v.tax_id ? true : false,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate 1099 report', detail: err.message });
  }
});

// ─── GET / ────────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  try {
    const db = req.payDb;
    const { status, vendor_type, search } = req.query;

    let sql = 'SELECT * FROM vendors WHERE 1=1';
    const params = [];

    if (status)      { sql += ' AND status = ?';      params.push(status); }
    if (vendor_type) { sql += ' AND vendor_type = ?';  params.push(vendor_type); }
    if (search) {
      sql += ' AND (vendor_name LIKE ? OR contact_name LIKE ? OR contact_email LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s);
    }

    sql += ' ORDER BY vendor_name ASC';

    const vendors = db.prepare(sql).all(...params);

    res.json({
      count: vendors.length,
      vendors: vendors.map(v => ({
        ...v,
        total_paid_usd: toDollars(v.total_paid_cents),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch vendors', detail: err.message });
  }
});

// ─── POST / ───────────────────────────────────────────────────────────────────

router.post('/', (req, res) => {
  try {
    const db = req.payDb;
    const errors = validateVendor(req.body);
    if (errors.length) {
      return res.status(400).json({ error: errors.join('; ') });
    }

    const {
      vendor_name, vendor_type = 'service',
      contact_name, contact_email, contact_phone,
      address_line1, address_line2, city, state, zip_code,
      tax_id, tax_id_type = 'ein',
      payment_terms = 'net_30', default_payment_method = 'ach',
      bank_routing_number, bank_account_number, bank_account_type = 'checking', bank_name,
      w9_on_file = 0, preferred = 0, notes,
    } = req.body;

    const result = db.prepare(`
      INSERT INTO vendors (
        vendor_name, vendor_type,
        contact_name, contact_email, contact_phone,
        address_line1, address_line2, city, state, zip_code,
        tax_id, tax_id_type,
        payment_terms, default_payment_method,
        bank_routing_number, bank_account_number, bank_account_type, bank_name,
        w9_on_file, preferred, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      vendor_name, vendor_type,
      contact_name || null, contact_email || null, contact_phone || null,
      address_line1 || null, address_line2 || null, city || null, state || null, zip_code || null,
      tax_id || null, tax_id_type,
      payment_terms, default_payment_method,
      bank_routing_number || null, bank_account_number || null, bank_account_type, bank_name || null,
      w9_on_file ? 1 : 0, preferred ? 1 : 0, notes || null
    );

    const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(result.lastInsertRowid);

    res.status(201).json({
      success: true,
      vendor: { ...vendor, total_paid_usd: toDollars(vendor.total_paid_cents) },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create vendor', detail: err.message });
  }
});

// ─── PUT /:id ─────────────────────────────────────────────────────────────────

router.put('/:id', (req, res) => {
  try {
    const db = req.payDb;
    const existing = db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Vendor not found' });

    const updatable = [
      'vendor_name', 'vendor_type',
      'contact_name', 'contact_email', 'contact_phone',
      'address_line1', 'address_line2', 'city', 'state', 'zip_code',
      'tax_id', 'tax_id_type',
      'payment_terms', 'default_payment_method',
      'bank_routing_number', 'bank_account_number', 'bank_account_type', 'bank_name',
      'w9_on_file', 'preferred', 'status', 'notes',
    ];

    const sets = [];
    const params = [];

    for (const field of updatable) {
      if (req.body[field] !== undefined) {
        sets.push(`${field} = ?`);
        params.push(req.body[field]);
      }
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    sets.push("updated_at = datetime('now')");
    params.push(req.params.id);

    db.prepare(`UPDATE vendors SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    const updated = db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);

    res.json({
      success: true,
      vendor: { ...updated, total_paid_usd: toDollars(updated.total_paid_cents) },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update vendor', detail: err.message });
  }
});

// ─── DELETE /:id ──────────────────────────────────────────────────────────────

router.delete('/:id', (req, res) => {
  try {
    const db = req.payDb;
    const existing = db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Vendor not found' });

    db.prepare("UPDATE vendors SET status = 'inactive', updated_at = datetime('now') WHERE id = ?").run(req.params.id);

    res.json({ success: true, message: `Vendor '${existing.vendor_name}' deactivated` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to deactivate vendor', detail: err.message });
  }
});

// ─── GET /:id/payments ────────────────────────────────────────────────────────

router.get('/:id/payments', (req, res) => {
  try {
    const db = req.payDb;
    const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    const payments = db.prepare(
      'SELECT * FROM vendor_payments WHERE vendor_id = ? ORDER BY created_at DESC'
    ).all(req.params.id);

    res.json({
      vendor_id: vendor.id,
      vendor_name: vendor.vendor_name,
      count: payments.length,
      total_paid_cents: vendor.total_paid_cents,
      total_paid_usd: toDollars(vendor.total_paid_cents),
      payments: payments.map(p => ({
        ...p,
        amount_usd: toDollars(p.amount_cents),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch vendor payments', detail: err.message });
  }
});

// ─── POST /:id/pay ────────────────────────────────────────────────────────────

router.post('/:id/pay', (req, res) => {
  try {
    const db = req.payDb;
    const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    if (vendor.status !== 'active') return res.status(400).json({ error: 'Vendor is not active' });

    const {
      amount_cents, description, invoice_number, category = 'operating',
      payment_method, bill_id,
    } = req.body;

    if (!amount_cents || amount_cents <= 0) {
      return res.status(400).json({ error: 'amount_cents must be a positive integer' });
    }

    const method = payment_method || vendor.default_payment_method || 'ach';
    const feeCents = calculateFee(amount_cents, method);
    const netAmount = amount_cents - feeCents;

    // Create the vendor payment record
    const vpResult = db.prepare(`
      INSERT INTO vendor_payments (vendor_id, amount_cents, payment_method, invoice_number, description, category, fiscal_year, bill_id, status, payment_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', date('now'))
    `).run(
      vendor.id, amount_cents, method, invoice_number || null,
      description || null, category, new Date().getFullYear(), bill_id || null
    );

    // Create a trust payout for execution
    const payoutResult = db.prepare(`
      INSERT INTO trust_payouts (
        payout_type, payee_name, payee_type, amount_cents, fee_cents, net_amount_cents,
        payment_method, status, description,
        bank_routing_number, bank_account_number, bank_account_type, bank_name,
        tax_reportable, fiscal_year
      ) VALUES ('expense_reimbursement', ?, 'vendor', ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, 1, ?)
    `).run(
      vendor.vendor_name, amount_cents, feeCents, netAmount, method,
      description || `Payment to ${vendor.vendor_name}`,
      vendor.bank_routing_number || null, vendor.bank_account_number || null,
      vendor.bank_account_type || 'checking', vendor.bank_name || null,
      new Date().getFullYear()
    );

    // Link vendor payment to payout
    db.prepare('UPDATE vendor_payments SET payout_id = ? WHERE id = ?')
      .run(payoutResult.lastInsertRowid, vpResult.lastInsertRowid);

    // Update vendor totals
    db.prepare(`
      UPDATE vendors SET total_paid_cents = total_paid_cents + ?, payment_count = payment_count + 1,
        last_payment_date = date('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(amount_cents, vendor.id);

    // Create ledger entry
    createLedgerEntry(db, {
      entry_type: 'vendor_payment',
      reference_type: 'vendor_payment',
      reference_id: vpResult.lastInsertRowid,
      debit_cents: amount_cents,
      credit_cents: 0,
      description: `Vendor payment to ${vendor.vendor_name}: ${description || invoice_number || 'payment'}`,
      category,
      fiscal_year: new Date().getFullYear(),
    });

    // If paying a bill, update bill
    if (bill_id) {
      const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(bill_id);
      if (bill) {
        const newPaidCents = bill.paid_cents + amount_cents;
        const newBalanceCents = bill.total_cents - newPaidCents;
        const newStatus = newBalanceCents <= 0 ? 'paid' : 'partially_paid';
        db.prepare(`
          UPDATE bills SET paid_cents = ?, balance_cents = ?, status = ?, paid_date = date('now'), updated_at = datetime('now')
          WHERE id = ?
        `).run(newPaidCents, Math.max(0, newBalanceCents), newStatus, bill_id);
      }
    }

    const payment = db.prepare('SELECT * FROM vendor_payments WHERE id = ?').get(vpResult.lastInsertRowid);

    res.status(201).json({
      success: true,
      payment: { ...payment, amount_usd: toDollars(payment.amount_cents) },
      payout_id: payoutResult.lastInsertRowid,
      fee_cents: feeCents,
      fee_usd: toDollars(feeCents),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create vendor payment', detail: err.message });
  }
});

// ─── GET /:id ─────────────────────────────────────────────────────────────────
// Registered AFTER /report/1099 to avoid param shadowing

router.get('/:id', (req, res) => {
  try {
    const db = req.payDb;
    const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    const recentPayments = db.prepare(
      'SELECT * FROM vendor_payments WHERE vendor_id = ? ORDER BY created_at DESC LIMIT 10'
    ).all(vendor.id);

    const openBills = db.prepare(
      "SELECT * FROM bills WHERE vendor_id = ? AND status NOT IN ('paid', 'cancelled') ORDER BY due_date ASC"
    ).all(vendor.id);

    res.json({
      ...vendor,
      total_paid_usd: toDollars(vendor.total_paid_cents),
      recent_payments: recentPayments.map(p => ({
        ...p,
        amount_usd: toDollars(p.amount_cents),
      })),
      open_bills: openBills.map(b => ({
        ...b,
        amount_usd: toDollars(b.amount_cents),
        total_usd: toDollars(b.total_cents),
        balance_usd: toDollars(b.balance_cents),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch vendor', detail: err.message });
  }
});

module.exports = router;
