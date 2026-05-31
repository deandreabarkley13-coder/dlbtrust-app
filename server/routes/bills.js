/**
 * Bill / Invoice Management Routes
 * DEANDREA LAVAR BARKLEY TRUST — Private Trust Payment Processing
 *
 * Endpoints:
 *   GET    /api/bills                   — List all bills (filterable)
 *   GET    /api/bills/upcoming          — Bills due within a horizon
 *   GET    /api/bills/overdue           — Overdue bills
 *   GET    /api/bills/summary           — Bill summary/aging report
 *   GET    /api/bills/:id               — Single bill detail
 *   POST   /api/bills                   — Create a new bill
 *   PUT    /api/bills/:id               — Update a bill
 *   POST   /api/bills/:id/approve       — Approve a bill for payment
 *   POST   /api/bills/:id/schedule      — Schedule bill payment
 *   POST   /api/bills/:id/pay           — Pay a bill (creates vendor payment + payout)
 *   POST   /api/bills/:id/dispute       — Dispute a bill
 *   DELETE /api/bills/:id               — Cancel a bill
 */

'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const Database = require('better-sqlite3');
const {
  validateBill,
  calculateFee,
  calculateDueDate,
  determineBillStatus,
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
    console.warn('[bills] Schema init warning:', err.message);
  }
}

// ─── Middleware ────────────────────────────────────────────────────────────────

router.use((req, res, next) => {
  try {
    req.payDb = req.app.locals.db || getDb();
    initSchema(req.payDb);
    next();
  } catch (err) {
    res.status(500).json({ error: 'Bills DB connection failed', detail: err.message });
  }
});

const toDollars = (cents) => (cents !== null && cents !== undefined) ? Math.round(cents) / 100 : null;

function billToJson(b) {
  return {
    ...b,
    amount_usd: toDollars(b.amount_cents),
    tax_usd: toDollars(b.tax_cents),
    total_usd: toDollars(b.total_cents),
    paid_usd: toDollars(b.paid_cents),
    balance_usd: toDollars(b.balance_cents),
  };
}

// ─── GET /upcoming ────────────────────────────────────────────────────────────

router.get('/upcoming', (req, res) => {
  try {
    const db = req.payDb;
    const horizonDays = parseInt(req.query.days) || 30;
    const today = new Date();
    const horizon = new Date(today);
    horizon.setDate(horizon.getDate() + horizonDays);

    const todayStr = today.toISOString().split('T')[0];
    const horizonStr = horizon.toISOString().split('T')[0];

    const bills = db.prepare(`
      SELECT b.*, v.vendor_name
      FROM bills b
      LEFT JOIN vendors v ON b.vendor_id = v.id
      WHERE b.due_date BETWEEN ? AND ?
        AND b.status NOT IN ('paid', 'cancelled')
      ORDER BY b.due_date ASC
    `).all(todayStr, horizonStr);

    const totalDueCents = bills.reduce((sum, b) => sum + b.balance_cents, 0);

    res.json({
      horizon_days: horizonDays,
      from: todayStr,
      to: horizonStr,
      count: bills.length,
      total_due_cents: totalDueCents,
      total_due_usd: toDollars(totalDueCents),
      bills: bills.map(billToJson),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch upcoming bills', detail: err.message });
  }
});

// ─── GET /overdue ─────────────────────────────────────────────────────────────

router.get('/overdue', (req, res) => {
  try {
    const db = req.payDb;
    const today = new Date().toISOString().split('T')[0];

    // Update overdue status
    db.prepare(`
      UPDATE bills SET status = 'overdue', updated_at = datetime('now')
      WHERE due_date < ? AND status IN ('received', 'approved') AND balance_cents > 0
    `).run(today);

    const bills = db.prepare(`
      SELECT b.*, v.vendor_name
      FROM bills b
      LEFT JOIN vendors v ON b.vendor_id = v.id
      WHERE b.due_date < ? AND b.status NOT IN ('paid', 'cancelled') AND b.balance_cents > 0
      ORDER BY b.due_date ASC
    `).all(today);

    const totalOverdueCents = bills.reduce((sum, b) => sum + b.balance_cents, 0);

    res.json({
      as_of: today,
      count: bills.length,
      total_overdue_cents: totalOverdueCents,
      total_overdue_usd: toDollars(totalOverdueCents),
      bills: bills.map(b => ({
        ...billToJson(b),
        days_overdue: Math.floor((new Date(today) - new Date(b.due_date)) / (1000 * 60 * 60 * 24)),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch overdue bills', detail: err.message });
  }
});

// ─── GET /summary ─────────────────────────────────────────────────────────────

router.get('/summary', (req, res) => {
  try {
    const db = req.payDb;
    const today = new Date().toISOString().split('T')[0];

    const aging = db.prepare(`
      SELECT
        SUM(CASE WHEN due_date >= ? THEN balance_cents ELSE 0 END) as current_cents,
        SUM(CASE WHEN due_date < ? AND due_date >= date(?, '-30 days') THEN balance_cents ELSE 0 END) as overdue_1_30_cents,
        SUM(CASE WHEN due_date < date(?, '-30 days') AND due_date >= date(?, '-60 days') THEN balance_cents ELSE 0 END) as overdue_31_60_cents,
        SUM(CASE WHEN due_date < date(?, '-60 days') AND due_date >= date(?, '-90 days') THEN balance_cents ELSE 0 END) as overdue_61_90_cents,
        SUM(CASE WHEN due_date < date(?, '-90 days') THEN balance_cents ELSE 0 END) as overdue_90_plus_cents
      FROM bills
      WHERE status NOT IN ('paid', 'cancelled')
    `).get(today, today, today, today, today, today, today, today);

    const byCategory = db.prepare(`
      SELECT category, COUNT(*) as count, SUM(balance_cents) as total_cents
      FROM bills
      WHERE status NOT IN ('paid', 'cancelled')
      GROUP BY category
      ORDER BY total_cents DESC
    `).all();

    const byStatus = db.prepare(`
      SELECT status, COUNT(*) as count, SUM(total_cents) as total_cents
      FROM bills
      GROUP BY status
      ORDER BY count DESC
    `).all();

    res.json({
      generated_at: new Date().toISOString(),
      aging: {
        current_cents: aging.current_cents || 0,
        current_usd: toDollars(aging.current_cents || 0),
        overdue_1_30_cents: aging.overdue_1_30_cents || 0,
        overdue_1_30_usd: toDollars(aging.overdue_1_30_cents || 0),
        overdue_31_60_cents: aging.overdue_31_60_cents || 0,
        overdue_31_60_usd: toDollars(aging.overdue_31_60_cents || 0),
        overdue_61_90_cents: aging.overdue_61_90_cents || 0,
        overdue_61_90_usd: toDollars(aging.overdue_61_90_cents || 0),
        overdue_90_plus_cents: aging.overdue_90_plus_cents || 0,
        overdue_90_plus_usd: toDollars(aging.overdue_90_plus_cents || 0),
      },
      by_category: byCategory.map(c => ({
        ...c,
        total_usd: toDollars(c.total_cents),
      })),
      by_status: byStatus.map(s => ({
        ...s,
        total_usd: toDollars(s.total_cents),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate bill summary', detail: err.message });
  }
});

// ─── GET / ────────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  try {
    const db = req.payDb;
    const { status, vendor_id, bill_type, category } = req.query;

    let sql = `
      SELECT b.*, v.vendor_name
      FROM bills b
      LEFT JOIN vendors v ON b.vendor_id = v.id
      WHERE 1=1
    `;
    const params = [];

    if (status)    { sql += ' AND b.status = ?';    params.push(status); }
    if (vendor_id) { sql += ' AND b.vendor_id = ?'; params.push(vendor_id); }
    if (bill_type) { sql += ' AND b.bill_type = ?'; params.push(bill_type); }
    if (category)  { sql += ' AND b.category = ?';  params.push(category); }

    sql += ' ORDER BY b.due_date ASC';

    const bills = db.prepare(sql).all(...params);

    res.json({
      count: bills.length,
      bills: bills.map(billToJson),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bills', detail: err.message });
  }
});

// ─── POST / ───────────────────────────────────────────────────────────────────

router.post('/', (req, res) => {
  try {
    const db = req.payDb;
    const errors = validateBill(req.body);
    if (errors.length) {
      return res.status(400).json({ error: errors.join('; ') });
    }

    const {
      vendor_id, bill_number,
      bill_type = 'invoice', amount_cents, tax_cents = 0,
      received_date, due_date,
      description, line_items, category = 'operating',
      priority = 'normal', attachment_url, notes,
    } = req.body;

    // Validate vendor exists if specified
    if (vendor_id) {
      const vendor = db.prepare('SELECT id FROM vendors WHERE id = ?').get(vendor_id);
      if (!vendor) return res.status(400).json({ error: 'Vendor not found' });
    }

    const totalCents = amount_cents + tax_cents;

    const result = db.prepare(`
      INSERT INTO bills (
        vendor_id, bill_number, bill_type, amount_cents, tax_cents, total_cents, balance_cents,
        received_date, due_date, description, line_items, category,
        priority, attachment_url, notes, fiscal_year
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      vendor_id || null, bill_number || null, bill_type,
      amount_cents, tax_cents, totalCents, totalCents,
      received_date, due_date, description || null,
      line_items ? JSON.stringify(line_items) : null,
      category, priority, attachment_url || null, notes || null,
      new Date().getFullYear()
    );

    const bill = db.prepare(`
      SELECT b.*, v.vendor_name
      FROM bills b
      LEFT JOIN vendors v ON b.vendor_id = v.id
      WHERE b.id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json({
      success: true,
      bill: billToJson(bill),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create bill', detail: err.message });
  }
});

// ─── PUT /:id ─────────────────────────────────────────────────────────────────

router.put('/:id', (req, res) => {
  try {
    const db = req.payDb;
    const existing = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Bill not found' });

    if (['paid', 'cancelled'].includes(existing.status)) {
      return res.status(400).json({ error: `Cannot edit a bill in '${existing.status}' status` });
    }

    const updatable = [
      'bill_number', 'bill_type', 'amount_cents', 'tax_cents',
      'due_date', 'description', 'line_items', 'category',
      'priority', 'attachment_url', 'notes',
    ];

    const sets = [];
    const params = [];

    for (const field of updatable) {
      if (req.body[field] !== undefined) {
        if (field === 'line_items' && typeof req.body[field] !== 'string') {
          sets.push(`${field} = ?`);
          params.push(JSON.stringify(req.body[field]));
        } else {
          sets.push(`${field} = ?`);
          params.push(req.body[field]);
        }
      }
    }

    // Recalculate totals if amount or tax changed
    const newAmount = req.body.amount_cents !== undefined ? req.body.amount_cents : existing.amount_cents;
    const newTax = req.body.tax_cents !== undefined ? req.body.tax_cents : existing.tax_cents;
    const newTotal = newAmount + newTax;
    const newBalance = newTotal - existing.paid_cents;

    sets.push('total_cents = ?');
    params.push(newTotal);
    sets.push('balance_cents = ?');
    params.push(Math.max(0, newBalance));

    sets.push("updated_at = datetime('now')");
    params.push(req.params.id);

    db.prepare(`UPDATE bills SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    const updated = db.prepare(`
      SELECT b.*, v.vendor_name
      FROM bills b
      LEFT JOIN vendors v ON b.vendor_id = v.id
      WHERE b.id = ?
    `).get(req.params.id);

    res.json({ success: true, bill: billToJson(updated) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update bill', detail: err.message });
  }
});

// ─── POST /:id/approve ────────────────────────────────────────────────────────

router.post('/:id/approve', (req, res) => {
  try {
    const db = req.payDb;
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id);
    if (!bill) return res.status(404).json({ error: 'Bill not found' });

    if (!['received', 'overdue'].includes(bill.status)) {
      return res.status(400).json({ error: `Cannot approve bill in '${bill.status}' status` });
    }

    db.prepare(`
      UPDATE bills SET status = 'approved', approved_by = ?, approved_date = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(req.body.actor || 'admin', req.params.id);

    res.json({ success: true, message: 'Bill approved for payment', status: 'approved' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve bill', detail: err.message });
  }
});

// ─── POST /:id/schedule ───────────────────────────────────────────────────────

router.post('/:id/schedule', (req, res) => {
  try {
    const db = req.payDb;
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id);
    if (!bill) return res.status(404).json({ error: 'Bill not found' });

    if (!['received', 'approved', 'overdue'].includes(bill.status)) {
      return res.status(400).json({ error: `Cannot schedule bill in '${bill.status}' status` });
    }

    const payDate = req.body.pay_date || bill.due_date;

    db.prepare(`
      UPDATE bills SET status = 'scheduled', scheduled_pay_date = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(payDate, req.params.id);

    res.json({ success: true, message: 'Bill payment scheduled', scheduled_pay_date: payDate, status: 'scheduled' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to schedule bill', detail: err.message });
  }
});

// ─── POST /:id/pay ────────────────────────────────────────────────────────────

router.post('/:id/pay', (req, res) => {
  try {
    const db = req.payDb;
    const bill = db.prepare(`
      SELECT b.*, v.vendor_name, v.bank_routing_number as v_routing, v.bank_account_number as v_account,
             v.bank_account_type as v_acct_type, v.bank_name as v_bank, v.default_payment_method as v_method
      FROM bills b
      LEFT JOIN vendors v ON b.vendor_id = v.id
      WHERE b.id = ?
    `).get(req.params.id);

    if (!bill) return res.status(404).json({ error: 'Bill not found' });

    if (['paid', 'cancelled', 'disputed'].includes(bill.status)) {
      return res.status(400).json({ error: `Cannot pay bill in '${bill.status}' status` });
    }

    const payAmountCents = req.body.amount_cents || bill.balance_cents;
    if (payAmountCents <= 0) {
      return res.status(400).json({ error: 'Payment amount must be positive' });
    }
    if (payAmountCents > bill.balance_cents) {
      return res.status(400).json({ error: `Payment amount (${payAmountCents}) exceeds balance (${bill.balance_cents})` });
    }

    const method = req.body.payment_method || bill.v_method || 'ach';
    const feeCents = calculateFee(payAmountCents, method);
    const netAmount = payAmountCents - feeCents;

    // Create payout for bill payment
    const payoutResult = db.prepare(`
      INSERT INTO trust_payouts (
        payout_type, payee_name, payee_type, amount_cents, fee_cents, net_amount_cents,
        payment_method, status, description, source_bill_id,
        bank_routing_number, bank_account_number, bank_account_type, bank_name,
        tax_reportable, fiscal_year
      ) VALUES ('expense_reimbursement', ?, 'vendor', ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      bill.vendor_name || 'Vendor', payAmountCents, feeCents, netAmount, method,
      `Bill #${bill.bill_number || bill.id}: ${bill.description || 'payment'}`,
      bill.id,
      bill.v_routing || null, bill.v_account || null,
      bill.v_acct_type || 'checking', bill.v_bank || null,
      new Date().getFullYear()
    );

    // Create vendor payment if vendor exists
    let vpId = null;
    if (bill.vendor_id) {
      const vpResult = db.prepare(`
        INSERT INTO vendor_payments (
          vendor_id, payout_id, bill_id, amount_cents, payment_method,
          status, invoice_number, description, category, fiscal_year, payment_date
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, date('now'))
      `).run(
        bill.vendor_id, payoutResult.lastInsertRowid, bill.id, payAmountCents, method,
        bill.bill_number || null, bill.description || null, bill.category || 'operating',
        new Date().getFullYear()
      );
      vpId = vpResult.lastInsertRowid;

      // Update vendor totals
      db.prepare(`
        UPDATE vendors SET total_paid_cents = total_paid_cents + ?, payment_count = payment_count + 1,
          last_payment_date = date('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(payAmountCents, bill.vendor_id);
    }

    // Update bill
    const newPaidCents = bill.paid_cents + payAmountCents;
    const newBalanceCents = bill.total_cents - newPaidCents;
    const newStatus = newBalanceCents <= 0 ? 'paid' : 'partially_paid';

    db.prepare(`
      UPDATE bills SET paid_cents = ?, balance_cents = ?, status = ?,
        paid_date = CASE WHEN ? <= 0 THEN date('now') ELSE paid_date END,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(newPaidCents, Math.max(0, newBalanceCents), newStatus, newBalanceCents, bill.id);

    // Ledger entry
    createLedgerEntry(db, {
      entry_type: 'bill_payment',
      reference_type: 'bill',
      reference_id: bill.id,
      debit_cents: payAmountCents,
      credit_cents: 0,
      description: `Bill payment #${bill.bill_number || bill.id} to ${bill.vendor_name || 'vendor'}`,
      category: bill.category || 'operating',
      fiscal_year: new Date().getFullYear(),
    });

    const updated = db.prepare('SELECT * FROM bills WHERE id = ?').get(bill.id);

    res.status(201).json({
      success: true,
      payment_amount_cents: payAmountCents,
      payment_amount_usd: toDollars(payAmountCents),
      fee_cents: feeCents,
      fee_usd: toDollars(feeCents),
      payout_id: payoutResult.lastInsertRowid,
      vendor_payment_id: vpId,
      bill: billToJson(updated),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to pay bill', detail: err.message });
  }
});

// ─── POST /:id/dispute ────────────────────────────────────────────────────────

router.post('/:id/dispute', (req, res) => {
  try {
    const db = req.payDb;
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id);
    if (!bill) return res.status(404).json({ error: 'Bill not found' });

    if (['paid', 'cancelled'].includes(bill.status)) {
      return res.status(400).json({ error: `Cannot dispute a bill in '${bill.status}' status` });
    }

    db.prepare(`
      UPDATE bills SET status = 'disputed', notes = COALESCE(notes || '; ', '') || ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(`DISPUTE (${new Date().toISOString().split('T')[0]}): ${req.body.reason || 'Disputed'}`, req.params.id);

    res.json({ success: true, message: 'Bill marked as disputed', status: 'disputed' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to dispute bill', detail: err.message });
  }
});

// ─── DELETE /:id ──────────────────────────────────────────────────────────────

router.delete('/:id', (req, res) => {
  try {
    const db = req.payDb;
    const existing = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Bill not found' });

    if (existing.status === 'paid') {
      return res.status(400).json({ error: 'Cannot cancel a paid bill' });
    }

    db.prepare("UPDATE bills SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(req.params.id);

    res.json({ success: true, message: `Bill ${req.params.id} cancelled` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel bill', detail: err.message });
  }
});

// ─── GET /:id ─────────────────────────────────────────────────────────────────
// Registered AFTER /upcoming, /overdue, /summary to avoid param shadowing

router.get('/:id', (req, res) => {
  try {
    const db = req.payDb;
    const bill = db.prepare(`
      SELECT b.*, v.vendor_name, v.vendor_type, v.contact_email
      FROM bills b
      LEFT JOIN vendors v ON b.vendor_id = v.id
      WHERE b.id = ?
    `).get(req.params.id);

    if (!bill) return res.status(404).json({ error: 'Bill not found' });

    // Get related payments
    const payments = db.prepare(
      'SELECT * FROM vendor_payments WHERE bill_id = ? ORDER BY created_at DESC'
    ).all(bill.id);

    // Parse line items JSON
    let lineItems = [];
    if (bill.line_items) {
      try { lineItems = JSON.parse(bill.line_items); } catch (_) {}
    }

    res.json({
      ...billToJson(bill),
      line_items_parsed: lineItems,
      payments: payments.map(p => ({
        ...p,
        amount_usd: toDollars(p.amount_cents),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bill', detail: err.message });
  }
});

module.exports = router;
