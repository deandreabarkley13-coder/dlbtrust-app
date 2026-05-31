/**
 * Payout & Distribution Routes
 * DEANDREA LAVAR BARKLEY TRUST — Private Trust Payment Processing
 *
 * Endpoints:
 *   GET    /api/payouts                     — List all payouts (filterable)
 *   GET    /api/payouts/summary             — Payment engine summary dashboard
 *   GET    /api/payouts/:id                 — Single payout with approval history
 *   POST   /api/payouts                     — Create a new payout
 *   PUT    /api/payouts/:id                 — Update a draft/pending payout
 *   POST   /api/payouts/:id/submit          — Submit for approval
 *   POST   /api/payouts/:id/approve         — Approve a pending payout
 *   POST   /api/payouts/:id/reject          — Reject a pending payout
 *   POST   /api/payouts/:id/cancel          — Cancel a payout
 *   POST   /api/payouts/:id/process         — Mark as processing (send to bank)
 *   POST   /api/payouts/:id/complete        — Mark as completed
 *   DELETE /api/payouts/:id                 — Cancel a draft payout
 *   GET    /api/payouts/recurring           — List recurring schedules
 *   POST   /api/payouts/recurring           — Create recurring schedule
 *   PUT    /api/payouts/recurring/:id       — Update recurring schedule
 *   DELETE /api/payouts/recurring/:id       — Cancel recurring schedule
 */

'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const Database = require('better-sqlite3');
const {
  validatePayout,
  calculateFee,
  canTransition,
  determineApprovalRequirement,
  createLedgerEntry,
  getPaymentSummary,
  calculateNextPaymentDate,
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
    console.warn('[payouts] Schema init warning:', err.message);
  }
}

// ─── Middleware ────────────────────────────────────────────────────────────────

router.use((req, res, next) => {
  try {
    req.payDb = req.app.locals.db || getDb();
    initSchema(req.payDb);
    next();
  } catch (err) {
    res.status(500).json({ error: 'Payment DB connection failed', detail: err.message });
  }
});

const toDollars = (cents) => (cents !== null && cents !== undefined) ? Math.round(cents) / 100 : null;

// ─── GET /summary ─────────────────────────────────────────────────────────────

router.get('/summary', (req, res) => {
  try {
    const summary = getPaymentSummary(req.payDb);
    res.json({
      generated_at: new Date().toISOString(),
      trust_name: 'DeAndrea Lavar Barkley Trust',
      ...summary,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate summary', detail: err.message });
  }
});

// ─── GET /recurring ───────────────────────────────────────────────────────────

router.get('/recurring', (req, res) => {
  try {
    const db = req.payDb;
    const { status } = req.query;

    let sql = 'SELECT * FROM recurring_schedules WHERE 1=1';
    const params = [];

    if (status) { sql += ' AND status = ?'; params.push(status); }
    else { sql += " AND status != 'cancelled'"; }

    sql += ' ORDER BY next_payment_date ASC';

    const schedules = db.prepare(sql).all(...params);

    res.json({
      generated_at: new Date().toISOString(),
      count: schedules.length,
      schedules: schedules.map(s => ({
        ...s,
        amount_usd: toDollars(s.amount_cents),
        total_paid_usd: toDollars(s.total_paid_cents),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch recurring schedules', detail: err.message });
  }
});

// ─── POST /recurring ──────────────────────────────────────────────────────────

router.post('/recurring', (req, res) => {
  try {
    const db = req.payDb;
    const {
      schedule_name, payee_name, payee_type = 'beneficiary', wallet_id,
      amount_cents, payment_method = 'ach',
      frequency = 'monthly', day_of_month, day_of_week,
      start_date, end_date, max_payments,
      payout_type = 'distribution', description, auto_approve = 0,
      bank_routing_number, bank_account_number, bank_account_type, bank_name,
    } = req.body;

    const missing = [];
    if (!schedule_name) missing.push('schedule_name');
    if (!payee_name) missing.push('payee_name');
    if (!amount_cents || amount_cents <= 0) missing.push('amount_cents');
    if (!start_date) missing.push('start_date');
    if (missing.length) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    const validFreqs = ['weekly', 'bi_weekly', 'monthly', 'quarterly', 'semi_annual', 'annual'];
    if (!validFreqs.includes(frequency)) {
      return res.status(400).json({ error: `Invalid frequency. Must be one of: ${validFreqs.join(', ')}` });
    }

    const result = db.prepare(`
      INSERT INTO recurring_schedules (
        schedule_name, payee_name, payee_type, wallet_id, amount_cents, payment_method,
        frequency, day_of_month, day_of_week, start_date, end_date, next_payment_date,
        max_payments, payout_type, description, auto_approve,
        bank_routing_number, bank_account_number, bank_account_type, bank_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      schedule_name, payee_name, payee_type, wallet_id || null, amount_cents, payment_method,
      frequency, day_of_month || null, day_of_week || null, start_date, end_date || null, start_date,
      max_payments || null, payout_type, description || null, auto_approve ? 1 : 0,
      bank_routing_number || null, bank_account_number || null, bank_account_type || 'checking', bank_name || null
    );

    const schedule = db.prepare('SELECT * FROM recurring_schedules WHERE id = ?').get(result.lastInsertRowid);

    res.status(201).json({
      success: true,
      schedule: { ...schedule, amount_usd: toDollars(schedule.amount_cents) },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create recurring schedule', detail: err.message });
  }
});

// ─── PUT /recurring/:id ───────────────────────────────────────────────────────

router.put('/recurring/:id', (req, res) => {
  try {
    const db = req.payDb;
    const existing = db.prepare('SELECT * FROM recurring_schedules WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Recurring schedule not found' });
    }

    const updatable = [
      'schedule_name', 'payee_name', 'amount_cents', 'payment_method',
      'frequency', 'day_of_month', 'day_of_week', 'end_date', 'max_payments',
      'description', 'auto_approve', 'status',
      'bank_routing_number', 'bank_account_number', 'bank_account_type', 'bank_name',
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

    db.prepare(`UPDATE recurring_schedules SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    const updated = db.prepare('SELECT * FROM recurring_schedules WHERE id = ?').get(req.params.id);

    res.json({ success: true, schedule: { ...updated, amount_usd: toDollars(updated.amount_cents) } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update recurring schedule', detail: err.message });
  }
});

// ─── DELETE /recurring/:id ────────────────────────────────────────────────────

router.delete('/recurring/:id', (req, res) => {
  try {
    const db = req.payDb;
    const existing = db.prepare('SELECT * FROM recurring_schedules WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Recurring schedule not found' });
    }

    db.prepare("UPDATE recurring_schedules SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(req.params.id);

    res.json({ success: true, message: `Recurring schedule ${req.params.id} cancelled` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel recurring schedule', detail: err.message });
  }
});

// ─── GET / ────────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  try {
    const db = req.payDb;
    const { status, payout_type, payee_type, payment_method, sort_by, order } = req.query;

    let sql = 'SELECT * FROM trust_payouts WHERE 1=1';
    const params = [];

    if (status)         { sql += ' AND status = ?';         params.push(status); }
    if (payout_type)    { sql += ' AND payout_type = ?';    params.push(payout_type); }
    if (payee_type)     { sql += ' AND payee_type = ?';     params.push(payee_type); }
    if (payment_method) { sql += ' AND payment_method = ?'; params.push(payment_method); }

    const validSorts = ['created_at', 'scheduled_date', 'amount_cents', 'payee_name', 'status'];
    const sortCol = validSorts.includes(sort_by) ? sort_by : 'created_at';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
    sql += ` ORDER BY ${sortCol} ${sortOrder}`;

    const payouts = db.prepare(sql).all(...params);

    res.json({
      generated_at: new Date().toISOString(),
      count: payouts.length,
      payouts: payouts.map(p => ({
        ...p,
        amount_usd: toDollars(p.amount_cents),
        fee_usd: toDollars(p.fee_cents),
        net_amount_usd: toDollars(p.net_amount_cents),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payouts', detail: err.message });
  }
});

// ─── POST / ───────────────────────────────────────────────────────────────────

router.post('/', (req, res) => {
  try {
    const db = req.payDb;
    const {
      payout_type = 'distribution', payee_name, payee_type = 'beneficiary',
      wallet_id, amount_cents, payment_method = 'ach', priority = 'normal',
      scheduled_date, description, memo,
      bank_routing_number, bank_account_number, bank_account_type = 'checking', bank_name,
      tax_reportable = 1, tax_category, recurring_schedule_id, source_bill_id,
    } = req.body;

    const errors = validatePayout(req.body);
    if (errors.length) {
      return res.status(400).json({ error: errors.join('; ') });
    }

    const feeCents = calculateFee(amount_cents, payment_method);
    const netAmountCents = amount_cents - feeCents;
    const approval = determineApprovalRequirement(amount_cents);
    const initialStatus = approval.auto_approve ? 'approved' : 'draft';

    const result = db.prepare(`
      INSERT INTO trust_payouts (
        payout_type, payee_name, payee_type, wallet_id, amount_cents, fee_cents, net_amount_cents,
        payment_method, status, priority, scheduled_date, description, memo,
        bank_routing_number, bank_account_number, bank_account_type, bank_name,
        tax_reportable, tax_category, fiscal_year, recurring_schedule_id, source_bill_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      payout_type, payee_name, payee_type, wallet_id || null, amount_cents, feeCents, netAmountCents,
      payment_method, initialStatus, priority, scheduled_date || null, description || null, memo || null,
      bank_routing_number || null, bank_account_number || null, bank_account_type, bank_name || null,
      tax_reportable ? 1 : 0, tax_category || null, new Date().getFullYear(),
      recurring_schedule_id || null, source_bill_id || null
    );

    const payoutId = result.lastInsertRowid;

    // Log approval action
    db.prepare(`
      INSERT INTO payout_approvals (payout_id, action, actor, notes)
      VALUES (?, ?, ?, ?)
    `).run(payoutId, 'created', 'system', approval.auto_approve ? 'Auto-approved (below threshold)' : null);

    if (approval.auto_approve) {
      db.prepare(`
        INSERT INTO payout_approvals (payout_id, action, actor, notes)
        VALUES (?, 'approved', 'system', 'Auto-approved: amount below $1,000 threshold')
      `).run(payoutId);
    }

    const payout = db.prepare('SELECT * FROM trust_payouts WHERE id = ?').get(payoutId);

    res.status(201).json({
      success: true,
      auto_approved: approval.auto_approve,
      approvals_required: approval.approvals_required,
      payout: {
        ...payout,
        amount_usd: toDollars(payout.amount_cents),
        fee_usd: toDollars(payout.fee_cents),
        net_amount_usd: toDollars(payout.net_amount_cents),
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create payout', detail: err.message });
  }
});

// ─── POST /:id/submit ─────────────────────────────────────────────────────────

router.post('/:id/submit', (req, res) => {
  try {
    const db = req.payDb;
    const payout = db.prepare('SELECT * FROM trust_payouts WHERE id = ?').get(req.params.id);
    if (!payout) return res.status(404).json({ error: 'Payout not found' });

    if (!canTransition(payout.status, 'pending_approval')) {
      return res.status(400).json({ error: `Cannot submit payout in '${payout.status}' status` });
    }

    db.prepare("UPDATE trust_payouts SET status = 'pending_approval', updated_at = datetime('now') WHERE id = ?").run(req.params.id);

    db.prepare(`
      INSERT INTO payout_approvals (payout_id, action, actor, notes)
      VALUES (?, 'submitted', ?, ?)
    `).run(req.params.id, req.body.actor || 'system', req.body.notes || null);

    res.json({ success: true, message: 'Payout submitted for approval', status: 'pending_approval' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to submit payout', detail: err.message });
  }
});

// ─── POST /:id/approve ────────────────────────────────────────────────────────

router.post('/:id/approve', (req, res) => {
  try {
    const db = req.payDb;
    const payout = db.prepare('SELECT * FROM trust_payouts WHERE id = ?').get(req.params.id);
    if (!payout) return res.status(404).json({ error: 'Payout not found' });

    if (!canTransition(payout.status, 'approved')) {
      return res.status(400).json({ error: `Cannot approve payout in '${payout.status}' status` });
    }

    db.prepare("UPDATE trust_payouts SET status = 'approved', approved_by = ?, updated_at = datetime('now') WHERE id = ?")
      .run(req.body.actor || 'admin', req.params.id);

    db.prepare(`
      INSERT INTO payout_approvals (payout_id, action, actor, notes)
      VALUES (?, 'approved', ?, ?)
    `).run(req.params.id, req.body.actor || 'admin', req.body.notes || null);

    res.json({ success: true, message: 'Payout approved', status: 'approved' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve payout', detail: err.message });
  }
});

// ─── POST /:id/reject ─────────────────────────────────────────────────────────

router.post('/:id/reject', (req, res) => {
  try {
    const db = req.payDb;
    const payout = db.prepare('SELECT * FROM trust_payouts WHERE id = ?').get(req.params.id);
    if (!payout) return res.status(404).json({ error: 'Payout not found' });

    if (!canTransition(payout.status, 'cancelled')) {
      return res.status(400).json({ error: `Cannot reject payout in '${payout.status}' status` });
    }

    db.prepare("UPDATE trust_payouts SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(req.params.id);

    db.prepare(`
      INSERT INTO payout_approvals (payout_id, action, actor, notes)
      VALUES (?, 'rejected', ?, ?)
    `).run(req.params.id, req.body.actor || 'admin', req.body.reason || 'Rejected');

    res.json({ success: true, message: 'Payout rejected', status: 'cancelled' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reject payout', detail: err.message });
  }
});

// ─── POST /:id/process ────────────────────────────────────────────────────────

router.post('/:id/process', (req, res) => {
  try {
    const db = req.payDb;
    const payout = db.prepare('SELECT * FROM trust_payouts WHERE id = ?').get(req.params.id);
    if (!payout) return res.status(404).json({ error: 'Payout not found' });

    if (!canTransition(payout.status, 'processing')) {
      return res.status(400).json({ error: `Cannot process payout in '${payout.status}' status` });
    }

    const refNum = req.body.reference_number || `PAY-${Date.now()}`;

    db.prepare(`
      UPDATE trust_payouts SET status = 'processing', executed_date = datetime('now'), reference_number = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(refNum, req.params.id);

    // Create ledger entry for the debit
    createLedgerEntry(db, {
      entry_type: 'payout',
      reference_type: 'payout',
      reference_id: payout.id,
      debit_cents: payout.net_amount_cents,
      credit_cents: 0,
      description: `Payout to ${payout.payee_name}: ${payout.description || payout.payout_type}`,
      category: payout.payout_type,
      fiscal_year: payout.fiscal_year,
    });

    if (payout.fee_cents > 0) {
      createLedgerEntry(db, {
        entry_type: 'fee',
        reference_type: 'payout',
        reference_id: payout.id,
        debit_cents: payout.fee_cents,
        credit_cents: 0,
        description: `Processing fee for payout #${payout.id} (${payout.payment_method})`,
        category: 'fee',
        fiscal_year: payout.fiscal_year,
      });
    }

    res.json({ success: true, message: 'Payout sent for processing', status: 'processing', reference_number: refNum });
  } catch (err) {
    res.status(500).json({ error: 'Failed to process payout', detail: err.message });
  }
});

// ─── POST /:id/complete ───────────────────────────────────────────────────────

router.post('/:id/complete', (req, res) => {
  try {
    const db = req.payDb;
    const payout = db.prepare('SELECT * FROM trust_payouts WHERE id = ?').get(req.params.id);
    if (!payout) return res.status(404).json({ error: 'Payout not found' });

    if (!canTransition(payout.status, 'completed')) {
      return res.status(400).json({ error: `Cannot complete payout in '${payout.status}' status` });
    }

    db.prepare("UPDATE trust_payouts SET status = 'completed', completed_date = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .run(req.params.id);

    res.json({ success: true, message: 'Payout completed', status: 'completed' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to complete payout', detail: err.message });
  }
});

// ─── POST /:id/cancel ─────────────────────────────────────────────────────────

router.post('/:id/cancel', (req, res) => {
  try {
    const db = req.payDb;
    const payout = db.prepare('SELECT * FROM trust_payouts WHERE id = ?').get(req.params.id);
    if (!payout) return res.status(404).json({ error: 'Payout not found' });

    if (!canTransition(payout.status, 'cancelled')) {
      return res.status(400).json({ error: `Cannot cancel payout in '${payout.status}' status` });
    }

    db.prepare("UPDATE trust_payouts SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(req.params.id);

    db.prepare(`
      INSERT INTO payout_approvals (payout_id, action, actor, notes)
      VALUES (?, 'cancelled', ?, ?)
    `).run(req.params.id, req.body.actor || 'system', req.body.reason || null);

    res.json({ success: true, message: 'Payout cancelled', status: 'cancelled' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel payout', detail: err.message });
  }
});

// ─── PUT /:id ─────────────────────────────────────────────────────────────────

router.put('/:id', (req, res) => {
  try {
    const db = req.payDb;
    const existing = db.prepare('SELECT * FROM trust_payouts WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Payout not found' });

    if (existing.status !== 'draft' && existing.status !== 'pending_approval') {
      return res.status(400).json({ error: 'Can only edit payouts in draft or pending_approval status' });
    }

    const updatable = [
      'payee_name', 'payee_type', 'wallet_id', 'amount_cents', 'payment_method',
      'priority', 'scheduled_date', 'description', 'memo',
      'bank_routing_number', 'bank_account_number', 'bank_account_type', 'bank_name',
      'tax_reportable', 'tax_category',
    ];

    const sets = [];
    const params = [];

    for (const field of updatable) {
      if (req.body[field] !== undefined) {
        sets.push(`${field} = ?`);
        params.push(req.body[field]);
      }
    }

    // Recalculate fees if amount or method changed
    const newAmount = req.body.amount_cents || existing.amount_cents;
    const newMethod = req.body.payment_method || existing.payment_method;
    const newFee = calculateFee(newAmount, newMethod);
    sets.push('fee_cents = ?');
    params.push(newFee);
    sets.push('net_amount_cents = ?');
    params.push(newAmount - newFee);

    sets.push("updated_at = datetime('now')");
    params.push(req.params.id);

    db.prepare(`UPDATE trust_payouts SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    const updated = db.prepare('SELECT * FROM trust_payouts WHERE id = ?').get(req.params.id);

    res.json({
      success: true,
      payout: {
        ...updated,
        amount_usd: toDollars(updated.amount_cents),
        fee_usd: toDollars(updated.fee_cents),
        net_amount_usd: toDollars(updated.net_amount_cents),
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update payout', detail: err.message });
  }
});

// ─── DELETE /:id ──────────────────────────────────────────────────────────────

router.delete('/:id', (req, res) => {
  try {
    const db = req.payDb;
    const existing = db.prepare('SELECT * FROM trust_payouts WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Payout not found' });

    if (existing.status !== 'draft') {
      return res.status(400).json({ error: 'Can only delete draft payouts. Use /cancel for others.' });
    }

    db.prepare("UPDATE trust_payouts SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(req.params.id);

    res.json({ success: true, message: `Payout ${req.params.id} cancelled` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete payout', detail: err.message });
  }
});

// ─── GET /:id ─────────────────────────────────────────────────────────────────
// Registered AFTER /summary and /recurring to avoid param shadowing

router.get('/:id', (req, res) => {
  try {
    const db = req.payDb;
    const payout = db.prepare('SELECT * FROM trust_payouts WHERE id = ?').get(req.params.id);
    if (!payout) return res.status(404).json({ error: 'Payout not found' });

    const approvals = db.prepare(
      'SELECT * FROM payout_approvals WHERE payout_id = ? ORDER BY created_at'
    ).all(payout.id);

    res.json({
      ...payout,
      amount_usd: toDollars(payout.amount_cents),
      fee_usd: toDollars(payout.fee_cents),
      net_amount_usd: toDollars(payout.net_amount_cents),
      approval_history: approvals,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payout', detail: err.message });
  }
});

module.exports = router;
