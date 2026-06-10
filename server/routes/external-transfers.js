/**
 * External Transfer Routes — Outbound Payment Processing
 * DEANDREA LAVAR BARKLEY TRUST — Private Wealth Management Platform
 *
 * Endpoints:
 *   GET    /api/external-transfers              - List external transfers
 *   POST   /api/external-transfers              - Create external transfer
 *   GET    /api/external-transfers/summary      - Payment summary/dashboard
 *   GET    /api/external-transfers/:id          - Transfer detail
 *   POST   /api/external-transfers/:id/submit   - Submit draft for approval
 *   POST   /api/external-transfers/:id/approve  - Approve transfer
 *   POST   /api/external-transfers/:id/reject   - Reject transfer
 *   POST   /api/external-transfers/:id/process  - Mark as processing/sent
 *   POST   /api/external-transfers/:id/complete - Mark as completed
 *   POST   /api/external-transfers/:id/cancel   - Cancel transfer
 *   POST   /api/external-transfers/:id/fail     - Mark as failed
 *   POST   /api/external-transfers/:id/retry    - Retry failed/returned transfer
 *   GET    /api/external-transfers/recurring     - List recurring schedules
 *   POST   /api/external-transfers/recurring     - Create recurring schedule
 *   PUT    /api/external-transfers/recurring/:id - Update recurring schedule
 *   DELETE /api/external-transfers/recurring/:id - Cancel recurring schedule
 */

'use strict';

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const {
  generateTransferNumber,
  validateExternalTransfer,
  calculateFee,
  determineApprovalTier,
  calculateETA,
  canTransition,
  buildAuditEntry,
  toDollars,
} = require('../engines/external-transfer-engine');

const { generateSingleACH, generateBatchACH, validateRoutingNumber } = require('../engines/nacha-engine');
const { generateWireMessage } = require('../engines/wire-engine');
const { deliverPayment, deliverWire, checkOpenACHHealth, checkOBPHealth, getAvailableDeliveryMethod, getAllDeliveryMethods } = require('../engines/payment-delivery-engine');
const { initApprovalSchema, submitApprovalRequest } = require('../engines/approval-engine');

// --- DB Setup ---------------------------------------------------------------

function getDb() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'dlbtrust.db');
  return new Database(dbPath);
}

let schemaInitialized = false;

function initSchema(db) {
  if (schemaInitialized) return;
  // Ensure CRM + banking schemas exist first
  for (const file of ['crm-schema.sql', 'banking-schema.sql', 'external-transfers-schema.sql']) {
    const p = path.join(__dirname, '..', 'db', 'migrations', file);
    if (fs.existsSync(p)) db.exec(fs.readFileSync(p, 'utf8'));
  }
  try { initApprovalSchema(db); } catch (_) {}
  schemaInitialized = true;
}

// --- Middleware --------------------------------------------------------------

router.use((req, res, next) => {
  try {
    req.db = getDb();
    initSchema(req.db);
    res.on('finish', () => { try { req.db.close(); } catch (_) {} });
    res.on('close',  () => { try { req.db.close(); } catch (_) {} });
    next();
  } catch (err) {
    res.status(500).json({ error: 'Database connection failed', detail: err.message });
  }
});

// --- Helpers ----------------------------------------------------------------

function insertAudit(db, entry) {
  try {
    db.prepare(`
      INSERT INTO banking_audit_log (event_type, entity_type, entity_id, actor, action, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(entry.event_type, entry.entity_type, entry.entity_id, entry.actor, entry.action, entry.details);
  } catch (_) {}
}

function maskAccount(num) {
  if (!num || num.length <= 4) return num;
  return '****' + num.slice(-4);
}

function enrichTransfer(t, db) {
  // Attach contact info
  try {
    const contact = db.prepare('SELECT display_name, contact_type, email FROM crm_contacts WHERE id = ?').get(t.contact_id);
    if (contact) {
      t.contact_name = contact.display_name;
      t.contact_type = contact.contact_type;
      t.contact_email = contact.email;
    }
  } catch (_) {}

  // Attach payment method info
  if (t.payment_method_id) {
    try {
      const pm = db.prepare('SELECT label, method_type, bank_name, account_number, account_type FROM crm_payment_methods WHERE id = ?').get(t.payment_method_id);
      if (pm) {
        t.pm_label = pm.label;
        t.pm_bank = pm.bank_name;
        t.pm_account = maskAccount(pm.account_number);
        t.pm_account_type = pm.account_type;
      }
    } catch (_) {}
  }

  // Attach source account info
  try {
    const acct = db.prepare('SELECT account_number, account_name, balance_cents FROM trust_accounts WHERE id = ?').get(t.from_account_id);
    if (acct) {
      t.from_account_number = acct.account_number;
      t.from_account_name = acct.account_name;
      t.from_account_balance = acct.balance_cents;
    }
  } catch (_) {}

  t.amount_usd = toDollars(t.amount_cents);
  t.fee_usd = toDollars(t.fee_cents);
  t.total_usd = toDollars(t.total_cents);
  return t;
}

// ============================================================================
// ROUTES
// ============================================================================

// --- GET /summary -- Payment dashboard metrics ------------------------------
router.get('/summary', (req, res) => {
  try {
    const total = req.db.prepare('SELECT COUNT(*) as count FROM external_transfers').get();
    const byStatus = req.db.prepare('SELECT status, COUNT(*) as count, SUM(amount_cents) as total_cents FROM external_transfers GROUP BY status').all();
    const byType = req.db.prepare('SELECT payment_type, COUNT(*) as count, SUM(amount_cents) as total_cents FROM external_transfers GROUP BY payment_type').all();
    const byMethod = req.db.prepare('SELECT payment_method, COUNT(*) as count, SUM(amount_cents) as total_cents FROM external_transfers GROUP BY payment_method').all();

    const pending = byStatus.find(s => s.status === 'pending_approval');
    const completed = byStatus.find(s => s.status === 'completed');
    const processing = byStatus.filter(s => ['processing', 'sent'].includes(s.status));
    const processingTotal = processing.reduce((sum, s) => sum + (s.total_cents || 0), 0);

    const totalPaid = req.db.prepare("SELECT COALESCE(SUM(amount_cents), 0) as total FROM external_transfers WHERE status = 'completed'").get();
    const totalFees = req.db.prepare("SELECT COALESCE(SUM(fee_cents), 0) as total FROM external_transfers WHERE status IN ('completed', 'processing', 'sent')").get();

    res.json({
      total_transfers: total.count,
      pending_approval: pending?.count || 0,
      pending_amount_usd: toDollars(pending?.total_cents || 0),
      in_transit: processing.reduce((sum, s) => sum + s.count, 0),
      in_transit_amount_usd: toDollars(processingTotal),
      total_paid_usd: toDollars(totalPaid.total),
      total_fees_usd: toDollars(totalFees.total),
      completed_count: completed?.count || 0,
      by_status: byStatus,
      by_type: byType,
      by_method: byMethod,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /recurring -- List recurring schedules -----------------------------
router.get('/recurring', (req, res) => {
  try {
    const { status, contact_id } = req.query;
    let sql = 'SELECT * FROM recurring_payment_schedules WHERE 1=1';
    const params = [];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (contact_id) { sql += ' AND contact_id = ?'; params.push(contact_id); }
    sql += ' ORDER BY next_run_date ASC';

    const schedules = req.db.prepare(sql).all(...params);

    // Enrich with contact names
    for (const s of schedules) {
      try {
        const c = req.db.prepare('SELECT display_name FROM crm_contacts WHERE id = ?').get(s.contact_id);
        if (c) s.contact_name = c.display_name;
      } catch (_) {}
    }

    res.json({ count: schedules.length, schedules });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /recurring -- Create recurring schedule ---------------------------
router.post('/recurring', (req, res) => {
  try {
    const { contact_id, from_account_id, payment_method_id, amount_cents, amount,
            payment_type, payment_method, frequency, description, memo,
            start_date, end_date, max_runs } = req.body;

    const amtCents = amount_cents || (amount ? Math.round(parseFloat(amount) * 100) : 0);
    if (!contact_id || !from_account_id || amtCents <= 0) {
      return res.status(400).json({ error: 'contact_id, from_account_id, and positive amount required' });
    }

    const result = req.db.prepare(`
      INSERT INTO recurring_payment_schedules
        (contact_id, from_account_id, payment_method_id, amount_cents,
         payment_type, payment_method, frequency, description, memo,
         start_date, end_date, next_run_date, max_runs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      contact_id, from_account_id, payment_method_id || null, amtCents,
      payment_type || 'vendor_payment', payment_method || 'ach',
      frequency || 'monthly', description || null, memo || null,
      start_date || new Date().toISOString().slice(0, 10),
      end_date || null,
      start_date || new Date().toISOString().slice(0, 10),
      max_runs || null
    );

    res.status(201).json({ id: result.lastInsertRowid, message: 'Recurring schedule created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- PUT /recurring/:id -- Update recurring schedule ------------------------
router.put('/recurring/:id', (req, res) => {
  try {
    const schedule = req.db.prepare('SELECT * FROM recurring_payment_schedules WHERE id = ?').get(req.params.id);
    if (!schedule) return res.status(404).json({ error: 'Schedule not found' });

    const fields = ['amount_cents', 'frequency', 'description', 'memo', 'end_date', 'status', 'next_run_date'];
    const updates = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
    }
    if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

    updates.push("updated_at = datetime('now')");
    params.push(req.params.id);
    req.db.prepare(`UPDATE recurring_payment_schedules SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    res.json({ message: 'Schedule updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- DELETE /recurring/:id -- Cancel recurring schedule ----------------------
router.delete('/recurring/:id', (req, res) => {
  try {
    const schedule = req.db.prepare('SELECT * FROM recurring_payment_schedules WHERE id = ?').get(req.params.id);
    if (!schedule) return res.status(404).json({ error: 'Schedule not found' });

    req.db.prepare("UPDATE recurring_payment_schedules SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(req.params.id);
    res.json({ message: 'Schedule cancelled' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET / -- List external transfers ---------------------------------------
router.get('/', (req, res) => {
  try {
    const { status, contact_id, payment_type, payment_method, from_date, to_date, limit = 100, offset = 0 } = req.query;
    let sql = 'SELECT * FROM external_transfers WHERE 1=1';
    const params = [];

    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (contact_id) { sql += ' AND contact_id = ?'; params.push(contact_id); }
    if (payment_type) { sql += ' AND payment_type = ?'; params.push(payment_type); }
    if (payment_method) { sql += ' AND payment_method = ?'; params.push(payment_method); }
    if (from_date) { sql += ' AND created_at >= ?'; params.push(from_date); }
    if (to_date) { sql += ' AND created_at <= ?'; params.push(to_date); }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const transfers = req.db.prepare(sql).all(...params);
    transfers.forEach(t => enrichTransfer(t, req.db));

    res.json({ count: transfers.length, transfers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST / -- Create external transfer -------------------------------------
router.post('/', (req, res) => {
  try {
    const errors = validateExternalTransfer(req.body);
    if (errors.length) return res.status(400).json({ error: 'Validation failed', errors });

    const amountCents = req.body.amount_cents || Math.round(parseFloat(req.body.amount) * 100);
    const method = req.body.payment_method || 'ach';
    const feeCents = calculateFee(method);
    const totalCents = amountCents + feeCents;
    const priority = req.body.priority || 'normal';

    // Verify source account exists, is active, and has sufficient funds
    const account = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(req.body.from_account_id);
    if (!account) return res.status(400).json({ error: 'Source account not found' });
    if (account.status !== 'active') return res.status(400).json({ error: 'Source account is not active' });
    if (account.available_cents < totalCents) {
      return res.status(400).json({
        error: 'Insufficient funds',
        available: toDollars(account.available_cents),
        required: toDollars(totalCents),
      });
    }

    // Verify contact exists and is active
    const contact = req.db.prepare('SELECT * FROM crm_contacts WHERE id = ?').get(req.body.contact_id);
    if (!contact) return res.status(400).json({ error: 'Contact not found' });
    if (contact.status !== 'active') return res.status(400).json({ error: 'Contact is not active' });

    // Resolve payment method
    let pmId = req.body.payment_method_id;
    if (!pmId) {
      const defaultPm = req.db.prepare(
        'SELECT id, method_type FROM crm_payment_methods WHERE contact_id = ? AND is_default = 1 AND status = ? LIMIT 1'
      ).get(req.body.contact_id, 'active');
      if (defaultPm) {
        pmId = defaultPm.id;
      } else {
        const anyPm = req.db.prepare(
          'SELECT id, method_type FROM crm_payment_methods WHERE contact_id = ? AND status = ? LIMIT 1'
        ).get(req.body.contact_id, 'active');
        if (anyPm) pmId = anyPm.id;
      }
    }

    // Determine approval tier
    const tier = determineApprovalTier(amountCents);
    const autoApprove = tier === 'auto';
    const transferNumber = generateTransferNumber();
    const eta = calculateETA(method, priority);
    const initialStatus = autoApprove ? 'approved' : 'draft';

    const result = req.db.prepare(`
      INSERT INTO external_transfers
        (transfer_number, from_account_id, contact_id, payment_method_id,
         amount_cents, fee_cents, total_cents, currency,
         payment_type, payment_method, status, priority,
         requires_approval, approval_tier, estimated_arrival,
         scheduled_date, description, memo, invoice_number, reference_id,
         created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      transferNumber, req.body.from_account_id, req.body.contact_id, pmId,
      amountCents, feeCents, totalCents, 'USD',
      req.body.payment_type || 'vendor_payment', method, initialStatus, priority,
      autoApprove ? 0 : 1, tier, eta,
      req.body.scheduled_date || null,
      req.body.description || null, req.body.memo || null,
      req.body.invoice_number || null, req.body.reference_id || null,
      'dashboard_user'
    );

    // Check trustee approval for external transfers
    const approvalCheck = submitApprovalRequest(req.db, {
      entityType: 'external_transfer',
      entityId: result.lastInsertRowid,
      action: 'create',
      summary: `${method.toUpperCase()} payment: $${(amountCents / 100).toFixed(2)} to ${contact.display_name}`,
      details: { amount_cents: amountCents, method, contact: contact.display_name, transfer_number: transferNumber },
      amountCents,
      submittedBy: 'dashboard_user',
      priority,
    });

    if (approvalCheck.pending) {
      // Trustee approval required — mark as pending_approval
      req.db.prepare("UPDATE external_transfers SET status = 'pending_approval', requires_approval = 1, approval_tier = ? WHERE id = ?")
        .run(approvalCheck.tier, result.lastInsertRowid);
    } else if (autoApprove || approvalCheck.auto) {
      req.db.prepare("UPDATE external_transfers SET approved_by = 'auto', approved_date = datetime('now') WHERE id = ?")
        .run(result.lastInsertRowid);
    }

    insertAudit(req.db, buildAuditEntry('external_transfer', result.lastInsertRowid,
      approvalCheck.pending ? 'created_pending_approval' : (autoApprove ? 'created_and_auto_approved' : 'created'),
      'dashboard_user',
      { amount: toDollars(amountCents), method, tier, contact: contact.display_name }
    ));

    const transfer = req.db.prepare('SELECT * FROM external_transfers WHERE id = ?').get(result.lastInsertRowid);
    enrichTransfer(transfer, req.db);

    res.status(201).json({
      ...transfer,
      auto_approved: !approvalCheck.pending && (autoApprove || approvalCheck.auto),
      approval_tier: approvalCheck.tier || tier,
      approval: approvalCheck,
      message: approvalCheck.pending ? `Transfer created — ${approvalCheck.message}` : (autoApprove ? 'Transfer created and auto-approved' : `Transfer created — requires ${tier} approval`),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// PAYMENT FILE ROUTES (must be before /:id catch-all)
// ============================================================================

// --- GET /files -- List payment files ----------------------------------------
router.get('/files', (req, res) => {
  try {
    const { file_type, transfer_id, batch_id, status } = req.query;
    let sql = 'SELECT id, transfer_id, transfer_number, batch_id, file_type, filename, metadata, status, created_at FROM payment_files WHERE 1=1';
    const params = [];

    if (file_type) { sql += ' AND file_type = ?'; params.push(file_type); }
    if (transfer_id) { sql += ' AND transfer_id = ?'; params.push(transfer_id); }
    if (batch_id) { sql += ' AND batch_id = ?'; params.push(batch_id); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY created_at DESC LIMIT 100';

    const files = req.db.prepare(sql).all(...params);
    files.forEach(f => { if (f.metadata) f.metadata = JSON.parse(f.metadata); });
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /files/:id/download -- Download a payment file ----------------------
router.get('/files/:fileId/download', (req, res) => {
  try {
    const file = req.db.prepare('SELECT * FROM payment_files WHERE id = ?').get(req.params.fileId);
    if (!file) return res.status(404).json({ error: 'File not found' });

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.content);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /files/:id/content -- View file content (JSON) ----------------------
router.get('/files/:fileId/content', (req, res) => {
  try {
    const file = req.db.prepare('SELECT * FROM payment_files WHERE id = ?').get(req.params.fileId);
    if (!file) return res.status(404).json({ error: 'File not found' });

    res.json({
      id: file.id,
      filename: file.filename,
      file_type: file.file_type,
      content: file.content,
      metadata: file.metadata ? JSON.parse(file.metadata) : null,
      status: file.status,
      created_at: file.created_at,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /batch-process -- Process multiple approved transfers as batch ------
router.post('/batch-process', (req, res) => {
  try {
    const { transfer_ids, payment_method } = req.body;
    if (!transfer_ids || !transfer_ids.length) {
      return res.status(400).json({ error: 'transfer_ids array is required' });
    }

    const method = payment_method || 'ach';
    const batchId = `BATCH-${Date.now()}`;
    const results = { processed: [], failed: [], batch_id: batchId };

    if (method === 'ach') {
      const payments = [];
      const transferRows = [];

      for (const id of transfer_ids) {
        const transfer = req.db.prepare('SELECT * FROM external_transfers WHERE id = ?').get(id);
        if (!transfer) { results.failed.push({ id, error: 'Not found' }); continue; }
        if (transfer.status !== 'approved') { results.failed.push({ id, error: `Status is ${transfer.status}` }); continue; }

        const account = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(transfer.from_account_id);
        if (account.available_cents < transfer.total_cents) {
          results.failed.push({ id, error: 'Insufficient funds' }); continue;
        }

        const contact = req.db.prepare('SELECT * FROM crm_contacts WHERE id = ?').get(transfer.contact_id);
        let pm = {};
        if (transfer.payment_method_id) {
          pm = req.db.prepare('SELECT * FROM crm_payment_methods WHERE id = ?').get(transfer.payment_method_id) || {};
        }

        if (!pm.routing_number || !pm.account_number) {
          results.failed.push({ id, error: 'Missing routing/account number' }); continue;
        }

        payments.push({
          routingNumber: pm.routing_number,
          accountNumber: pm.account_number,
          amountCents: transfer.amount_cents,
          accountType: (pm.account_type || 'checking').toLowerCase(),
          recipientName: (contact ? contact.display_name : 'UNKNOWN').slice(0, 22),
          referenceId: transfer.transfer_number,
        });
        transferRows.push({ transfer, account });
      }

      if (payments.length > 0) {
        const nachaFile = generateBatchACH(payments, { entryDescription: 'TRUST DIST' });

        const batchProcess = req.db.transaction(() => {
          req.db.prepare(`
            INSERT INTO payment_files (batch_id, file_type, filename, content, metadata, created_at)
            VALUES (?, 'nacha', ?, ?, ?, datetime('now'))
          `).run(batchId, nachaFile.filename, nachaFile.content, JSON.stringify(nachaFile.metadata));

          for (const { transfer, account } of transferRows) {
            req.db.prepare(`
              UPDATE trust_accounts SET balance_cents = balance_cents - ?, available_cents = available_cents - ?, updated_at = datetime('now')
              WHERE id = ?
            `).run(transfer.total_cents, transfer.total_cents, transfer.from_account_id);

            req.db.prepare(`
              UPDATE external_transfers SET status = 'processing', sent_date = datetime('now'), batch_id = ?, updated_at = datetime('now')
              WHERE id = ?
            `).run(batchId, transfer.id);

            results.processed.push({ id: transfer.id, transfer_number: transfer.transfer_number });
          }
        });
        batchProcess();

        results.file = { filename: nachaFile.filename, entries: payments.length, metadata: nachaFile.metadata };
      }
    } else {
      for (const id of transfer_ids) {
        results.failed.push({ id, error: 'Wire transfers must be processed individually' });
      }
    }

    res.json({
      message: `Batch processed: ${results.processed.length} succeeded, ${results.failed.length} failed`,
      ...results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /delivery-status -- Check payment delivery configuration ------------
router.get('/delivery-status', async (req, res) => {
  try {
    const achMethod = getAvailableDeliveryMethod('ach');
    const wireMethod = getAvailableDeliveryMethod('wire');
    let health = { delivery_method: achMethod, wire_method: wireMethod };

    if (achMethod === 'openach') {
      health = { ...health, ...(await checkOpenACHHealth()) };
    } else if (achMethod === 'obp') {
      health.connected = true;
      health.message = 'OBP (self-hosted) connected — ACH/Wire submitted via Open Banking API';
    } else if (achMethod === 'column') {
      health.connected = true;
      health.message = 'Column Bank API connected — ACH/Wire submitted via REST API (no SFTP)';
    } else if (achMethod === 'dwolla') {
      health.connected = true;
      health.message = 'Dwolla API connected — ACH/RTP/FedNow via REST API';
    } else if (achMethod === 'sftp') {
      health.connected = true;
      health.message = 'SFTP configured — files will auto-upload to bank';
    } else {
      health.connected = false;
      health.message = 'Manual delivery — download files and submit to bank portal';
    }

    // Include all available delivery methods
    try {
      health.all_methods = await getAllDeliveryMethods();
    } catch (_) {}

    res.json(health);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /files/:id/mark-submitted -- Mark file as submitted to bank --------
router.post('/files/:fileId/mark-submitted', (req, res) => {
  try {
    const file = req.db.prepare('SELECT * FROM payment_files WHERE id = ?').get(req.params.fileId);
    if (!file) return res.status(404).json({ error: 'File not found' });

    req.db.prepare(`
      UPDATE payment_files SET status = 'submitted', submitted_at = datetime('now') WHERE id = ?
    `).run(req.params.fileId);

    if (file.transfer_id) {
      req.db.prepare(`
        UPDATE external_transfers SET status = 'sent', updated_at = datetime('now') WHERE id = ? AND status = 'processing'
      `).run(file.transfer_id);
    }
    if (file.batch_id) {
      req.db.prepare(`
        UPDATE external_transfers SET status = 'sent', updated_at = datetime('now') WHERE batch_id = ? AND status = 'processing'
      `).run(file.batch_id);
    }

    res.json({ message: 'File marked as submitted to bank' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /:id -- Transfer detail --------------------------------------------
router.get('/:id', (req, res) => {
  try {
    const transfer = req.db.prepare('SELECT * FROM external_transfers WHERE id = ?').get(req.params.id);
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });

    enrichTransfer(transfer, req.db);

    // Attach approval history
    transfer.approvals = req.db.prepare('SELECT * FROM external_transfer_approvals WHERE transfer_id = ? ORDER BY created_at').all(req.params.id);

    res.json(transfer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /:id/submit -- Submit draft for approval --------------------------
router.post('/:id/submit', (req, res) => {
  try {
    const transfer = req.db.prepare('SELECT * FROM external_transfers WHERE id = ?').get(req.params.id);
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    if (!canTransition(transfer.status, 'pending_approval')) {
      return res.status(400).json({ error: `Cannot submit from status '${transfer.status}'` });
    }

    req.db.prepare("UPDATE external_transfers SET status = 'pending_approval', updated_at = datetime('now') WHERE id = ?").run(req.params.id);

    insertAudit(req.db, buildAuditEntry('external_transfer', req.params.id, 'submitted', 'dashboard_user', {}));
    res.json({ message: 'Transfer submitted for approval' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /:id/approve -- Approve transfer ----------------------------------
router.post('/:id/approve', (req, res) => {
  try {
    const transfer = req.db.prepare('SELECT * FROM external_transfers WHERE id = ?').get(req.params.id);
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });

    const actor = req.body.approved_by || 'dashboard_user';

    if (transfer.status === 'draft') {
      // Auto-submit then approve in one step
      req.db.prepare("UPDATE external_transfers SET status = 'pending_approval', updated_at = datetime('now') WHERE id = ?").run(req.params.id);
      transfer.status = 'pending_approval';
    }

    if (!canTransition(transfer.status, 'approved')) {
      return res.status(400).json({ error: `Cannot approve from status '${transfer.status}'` });
    }

    // Handle dual approval
    if (transfer.approval_tier === 'dual' && !transfer.approved_by) {
      // First approval
      req.db.prepare("UPDATE external_transfers SET approved_by = ?, approved_date = datetime('now'), updated_at = datetime('now') WHERE id = ?")
        .run(actor, req.params.id);

      req.db.prepare("INSERT INTO external_transfer_approvals (transfer_id, action, actor, tier) VALUES (?, 'approved', ?, 'first')")
        .run(req.params.id, actor);

      insertAudit(req.db, buildAuditEntry('external_transfer', req.params.id, 'first_approval', actor, {}));
      return res.json({ message: 'First approval recorded — requires second approval', needs_second: true });
    }

    if (transfer.approval_tier === 'dual' && transfer.approved_by && !transfer.second_approved_by) {
      if (transfer.approved_by === actor) {
        return res.status(400).json({ error: 'Second approver must be different from first approver' });
      }
      // Second approval — fully approve
      req.db.prepare(`
        UPDATE external_transfers SET second_approved_by = ?, second_approved_date = datetime('now'),
        status = 'approved', updated_at = datetime('now') WHERE id = ?
      `).run(actor, req.params.id);

      req.db.prepare("INSERT INTO external_transfer_approvals (transfer_id, action, actor, tier) VALUES (?, 'approved', ?, 'second')")
        .run(req.params.id, actor);

      insertAudit(req.db, buildAuditEntry('external_transfer', req.params.id, 'second_approval_and_approved', actor, {}));
      return res.json({ message: 'Transfer fully approved (dual approval complete)' });
    }

    // Single approval
    req.db.prepare(`
      UPDATE external_transfers SET status = 'approved', approved_by = ?, approved_date = datetime('now'), updated_at = datetime('now') WHERE id = ?
    `).run(actor, req.params.id);

    req.db.prepare("INSERT INTO external_transfer_approvals (transfer_id, action, actor, tier) VALUES (?, 'approved', ?, 'single')")
      .run(req.params.id, actor);

    insertAudit(req.db, buildAuditEntry('external_transfer', req.params.id, 'approved', actor, {}));
    res.json({ message: 'Transfer approved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /:id/reject -- Reject transfer ------------------------------------
router.post('/:id/reject', (req, res) => {
  try {
    const transfer = req.db.prepare('SELECT * FROM external_transfers WHERE id = ?').get(req.params.id);
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    if (!['pending_approval', 'draft'].includes(transfer.status)) {
      return res.status(400).json({ error: `Cannot reject from status '${transfer.status}'` });
    }

    const actor = req.body.rejected_by || 'dashboard_user';
    req.db.prepare(`
      UPDATE external_transfers SET status = 'cancelled', rejected_by = ?, rejected_date = datetime('now'),
      rejection_reason = ?, updated_at = datetime('now') WHERE id = ?
    `).run(actor, req.body.reason || null, req.params.id);

    req.db.prepare("INSERT INTO external_transfer_approvals (transfer_id, action, actor, reason) VALUES (?, 'rejected', ?, ?)")
      .run(req.params.id, actor, req.body.reason || null);

    insertAudit(req.db, buildAuditEntry('external_transfer', req.params.id, 'rejected', actor, { reason: req.body.reason }));
    res.json({ message: 'Transfer rejected' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /:id/process -- Execute payment (generate NACHA/Wire, debit account, post GL) ---
router.post('/:id/process', async (req, res) => {
  try {
    const transfer = req.db.prepare('SELECT * FROM external_transfers WHERE id = ?').get(req.params.id);
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    if (!canTransition(transfer.status, 'processing')) {
      return res.status(400).json({ error: `Cannot process from status '${transfer.status}'` });
    }

    // Check trustee approval for processing
    const processApproval = submitApprovalRequest(req.db, {
      entityType: 'external_transfer',
      entityId: transfer.id,
      action: 'process',
      summary: `Process ${transfer.payment_method.toUpperCase()} $${(transfer.amount_cents / 100).toFixed(2)} (${transfer.transfer_number})`,
      details: { transfer_number: transfer.transfer_number, amount_cents: transfer.amount_cents, method: transfer.payment_method },
      amountCents: transfer.amount_cents,
      submittedBy: req.body.processed_by || 'dashboard_user',
    });

    if (processApproval.pending) {
      req.db.prepare("UPDATE external_transfers SET status = 'pending_approval', updated_at = datetime('now') WHERE id = ?").run(transfer.id);
      return res.json({ message: processApproval.message, approval: processApproval, transfer });
    }

    // Verify funds again
    const account = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(transfer.from_account_id);
    if (account.available_cents < transfer.total_cents) {
      return res.status(400).json({ error: 'Insufficient funds', available: toDollars(account.available_cents) });
    }

    // Get payment method details for file generation
    let paymentDetails = {};
    if (transfer.payment_method_id) {
      const pm = req.db.prepare('SELECT * FROM crm_payment_methods WHERE id = ?').get(transfer.payment_method_id);
      if (pm) paymentDetails = pm;
    }

    // Get contact for recipient name
    const contact = req.db.prepare('SELECT * FROM crm_contacts WHERE id = ?').get(transfer.contact_id);
    const recipientName = contact ? contact.display_name : 'UNKNOWN';

    // Generate payment file based on method
    let paymentFile = null;
    let confirmationId = null;

    if (transfer.payment_method === 'ach') {
      // Generate NACHA ACH file
      const routingNumber = paymentDetails.routing_number || req.body.routing_number;
      const accountNumber = paymentDetails.account_number || req.body.account_number;
      const accountType = paymentDetails.account_type || req.body.account_type || 'checking';

      if (!routingNumber || !accountNumber) {
        return res.status(400).json({ error: 'Routing number and account number required for ACH. Provide via payment method or request body.' });
      }
      if (!validateRoutingNumber(routingNumber)) {
        return res.status(400).json({ error: `Invalid routing number: ${routingNumber}` });
      }

      paymentFile = generateSingleACH({
        routingNumber,
        accountNumber,
        amountCents: transfer.amount_cents,
        accountType: accountType.toLowerCase(),
        recipientName: recipientName.slice(0, 22),
        referenceId: transfer.transfer_number,
        description: (transfer.memo || transfer.description || 'PAYMENT').slice(0, 10),
        paymentType: transfer.payment_type,
      });
      confirmationId = `ACH-${transfer.transfer_number}-${Date.now()}`;

    } else if (transfer.payment_method === 'wire') {
      // Generate Fedwire or SWIFT message
      const receiverRouting = paymentDetails.routing_number || req.body.routing_number;
      const receiverAccount = paymentDetails.account_number || req.body.account_number;
      const receiverBIC = paymentDetails.swift_bic || req.body.swift_bic;

      if (!receiverAccount) {
        return res.status(400).json({ error: 'Account number required for wire transfer.' });
      }
      if (!receiverRouting && !receiverBIC) {
        return res.status(400).json({ error: 'Routing number (domestic) or SWIFT BIC (international) required for wire.' });
      }

      paymentFile = generateWireMessage({
        amountCents: transfer.amount_cents,
        senderAccount: account.account_number,
        senderName: 'DEANDREA LAVAR BARKLEY TRUST',
        receiverRoutingNumber: receiverRouting || undefined,
        receiverBankName: paymentDetails.bank_name || req.body.bank_name || '',
        receiverAccount,
        receiverName: recipientName,
        receiverAddress: req.body.receiver_address || '',
        receiverSwiftBIC: receiverBIC || undefined,
        purpose: transfer.memo || transfer.description || `Payment ${transfer.transfer_number}`,
      });
      confirmationId = `WIRE-${paymentFile.metadata.imad || paymentFile.metadata.reference}`;
    }

    // Debit source account, update status, store file, post GL — all atomically
    const processTransfer = req.db.transaction(() => {
      // 1. Debit source account
      req.db.prepare(`
        UPDATE trust_accounts SET
          balance_cents = balance_cents - ?,
          available_cents = available_cents - ?,
          last_activity_date = date('now'),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(transfer.total_cents, transfer.total_cents, transfer.from_account_id);

      // 2. Update transfer status with confirmation
      req.db.prepare(`
        UPDATE external_transfers SET
          status = 'processing',
          sent_date = datetime('now'),
          reference_id = COALESCE(?, reference_id),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(confirmationId, req.params.id);

      // 3. Store payment file
      if (paymentFile) {
        req.db.prepare(`
          INSERT OR IGNORE INTO payment_files
            (transfer_id, transfer_number, file_type, filename, content, metadata, created_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
          transfer.id,
          transfer.transfer_number,
          transfer.payment_method === 'ach' ? 'nacha' : 'wire',
          paymentFile.filename,
          paymentFile.content,
          JSON.stringify(paymentFile.metadata)
        );
      }

      // 4. Post GL journal entry (Debit: Accounts Payable/Expense, Credit: Cash)
      try {
        const entryNumber = `GL-PAY-${transfer.transfer_number}`;
        const entryResult = req.db.prepare(`
          INSERT INTO trust_journal_entries
            (entry_number, entry_date, entry_type, description, source_engine, is_posted,
             total_debit_cents, total_credit_cents, created_by, reference_type, reference_id)
          VALUES (?, date('now'), 'standard', ?, 'payments', 1, ?, ?, 'system', 'payment', ?)
        `).run(
          entryNumber,
          `${transfer.payment_method.toUpperCase()} payment to ${recipientName}: $${toDollars(transfer.amount_cents)}`,
          transfer.amount_cents, transfer.amount_cents, String(transfer.id)
        );
        const entryId = entryResult.lastInsertRowid;

        // Debit: 5000 (Expenses/Distributions) or 2000 (Accounts Payable)
        const debitCode = transfer.payment_type === 'beneficiary_distribution' ? '5000' : '2000';
        req.db.prepare(`
          INSERT INTO trust_journal_lines (journal_entry_id, line_number, account_id, account_code, debit_cents, credit_cents, description)
          VALUES (?, 1, (SELECT id FROM trust_chart_of_accounts WHERE account_code = ?), ?, ?, 0, ?)
        `).run(entryId, debitCode, debitCode, transfer.amount_cents, `${transfer.payment_method.toUpperCase()} to ${recipientName}`);

        // Credit: 1000 (Cash/Bank)
        req.db.prepare(`
          INSERT INTO trust_journal_lines (journal_entry_id, line_number, account_id, account_code, debit_cents, credit_cents, description)
          VALUES (?, 2, (SELECT id FROM trust_chart_of_accounts WHERE account_code = '1000'), '1000', 0, ?, ?)
        `).run(entryId, transfer.amount_cents, `Payment sent: ${transfer.transfer_number}`);
      } catch (glErr) {
        // GL posting is best-effort — don't fail the payment
        console.warn('[payments] GL posting failed:', glErr.message);
      }

      // 5. Log to activity/audit
      try {
        req.db.prepare(`
          INSERT INTO banking_audit_log (event_type, entity_type, entity_id, actor, action, details, created_at)
          VALUES ('payment_executed', 'external_transfer', ?, 'system', 'execute_payment', ?, datetime('now'))
        `).run(String(transfer.id), JSON.stringify({
          method: transfer.payment_method,
          amount_usd: toDollars(transfer.amount_cents),
          recipient: recipientName,
          confirmation_id: confirmationId,
          file_generated: paymentFile ? paymentFile.filename : null,
        }));
      } catch (_) {}
    });
    processTransfer();

    insertAudit(req.db, buildAuditEntry('external_transfer', req.params.id, 'processing',
      'dashboard_user', { amount: toDollars(transfer.total_cents), account: account.account_number, confirmation: confirmationId }));

    // After committing the transaction, attempt auto-delivery (async, non-blocking)
    let deliveryResult = null;
    try {
      if (transfer.payment_method === 'ach') {
        const pmForDelivery = {
          routing_number: paymentDetails.routing_number || req.body.routing_number,
          account_number: paymentDetails.account_number || req.body.account_number,
          account_type: paymentDetails.account_type || req.body.account_type || 'checking',
          bank_name: paymentDetails.bank_name || req.body.bank_name || '',
        };
        deliveryResult = await deliverPayment(transfer, contact || {}, pmForDelivery, paymentFile);
      } else if (transfer.payment_method === 'wire') {
        deliveryResult = await deliverWire(transfer, paymentFile);
      }

      // Update status based on delivery result
      if (deliveryResult && deliveryResult.success && deliveryResult.status === 'submitted') {
        req.db.prepare(`UPDATE external_transfers SET status = 'sent', updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
        if (paymentFile) {
          req.db.prepare(`UPDATE payment_files SET status = 'submitted', submitted_at = datetime('now') WHERE transfer_id = ?`).run(transfer.id);
        }
      }
    } catch (deliveryErr) {
      // Delivery failure is non-fatal — payment is still processed, file still stored
      deliveryResult = { success: false, delivery_method: 'manual', error: deliveryErr.message };
    }

    res.json({
      message: `${transfer.payment_method.toUpperCase()} payment executed — funds debited`,
      debited: toDollars(transfer.total_cents),
      confirmation_id: confirmationId,
      payment_file: paymentFile ? {
        filename: paymentFile.filename,
        format: paymentFile.format || (transfer.payment_method === 'ach' ? 'nacha' : 'fedwire'),
        metadata: paymentFile.metadata,
      } : null,
      gl_posted: true,
      delivery: deliveryResult,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /:id/complete -- Mark as completed --------------------------------
router.post('/:id/complete', (req, res) => {
  try {
    const transfer = req.db.prepare('SELECT * FROM external_transfers WHERE id = ?').get(req.params.id);
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });

    // Allow completing from processing or sent
    if (!['processing', 'sent'].includes(transfer.status)) {
      return res.status(400).json({ error: `Cannot complete from status '${transfer.status}'` });
    }

    req.db.prepare(`
      UPDATE external_transfers SET status = 'completed', completed_date = datetime('now'),
      reference_id = COALESCE(?, reference_id), updated_at = datetime('now') WHERE id = ?
    `).run(req.body.reference_id || null, req.params.id);

    insertAudit(req.db, buildAuditEntry('external_transfer', req.params.id, 'completed', 'dashboard_user', {}));
    res.json({ message: 'Transfer completed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /:id/cancel -- Cancel transfer ------------------------------------
router.post('/:id/cancel', (req, res) => {
  try {
    const transfer = req.db.prepare('SELECT * FROM external_transfers WHERE id = ?').get(req.params.id);
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    if (!canTransition(transfer.status, 'cancelled')) {
      return res.status(400).json({ error: `Cannot cancel from status '${transfer.status}'` });
    }

    // Refund if funds were already debited
    if (['processing', 'sent'].includes(transfer.status)) {
      req.db.prepare(`
        UPDATE trust_accounts SET
          balance_cents = balance_cents + ?,
          available_cents = available_cents + ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(transfer.total_cents, transfer.total_cents, transfer.from_account_id);
    }

    req.db.prepare(`
      UPDATE external_transfers SET status = 'cancelled', rejection_reason = ?, updated_at = datetime('now') WHERE id = ?
    `).run(req.body.reason || 'Cancelled by user', req.params.id);

    insertAudit(req.db, buildAuditEntry('external_transfer', req.params.id, 'cancelled', 'dashboard_user', { reason: req.body.reason }));
    res.json({ message: 'Transfer cancelled' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /:id/fail -- Mark as failed ---------------------------------------
router.post('/:id/fail', (req, res) => {
  try {
    const transfer = req.db.prepare('SELECT * FROM external_transfers WHERE id = ?').get(req.params.id);
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    if (!canTransition(transfer.status, 'failed')) {
      return res.status(400).json({ error: `Cannot fail from status '${transfer.status}'` });
    }

    // Refund if funds were debited
    if (['processing', 'sent'].includes(transfer.status)) {
      req.db.prepare(`
        UPDATE trust_accounts SET
          balance_cents = balance_cents + ?,
          available_cents = available_cents + ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(transfer.total_cents, transfer.total_cents, transfer.from_account_id);
    }

    req.db.prepare(`
      UPDATE external_transfers SET status = 'failed',
      failure_reason = ?, return_code = ?, return_date = datetime('now'), updated_at = datetime('now') WHERE id = ?
    `).run(req.body.reason || 'Payment failed', req.body.return_code || null, req.params.id);

    insertAudit(req.db, buildAuditEntry('external_transfer', req.params.id, 'failed', 'system', { reason: req.body.reason }));
    res.json({ message: 'Transfer marked as failed — funds refunded' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /:id/retry -- Retry failed/returned transfer ----------------------
router.post('/:id/retry', (req, res) => {
  try {
    const transfer = req.db.prepare('SELECT * FROM external_transfers WHERE id = ?').get(req.params.id);
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    if (!canTransition(transfer.status, 'draft')) {
      return res.status(400).json({ error: `Cannot retry from status '${transfer.status}'` });
    }

    req.db.prepare(`
      UPDATE external_transfers SET status = 'draft', failure_reason = NULL, return_code = NULL,
      return_date = NULL, sent_date = NULL, completed_date = NULL, updated_at = datetime('now') WHERE id = ?
    `).run(req.params.id);

    insertAudit(req.db, buildAuditEntry('external_transfer', req.params.id, 'retried', 'dashboard_user', {}));
    res.json({ message: 'Transfer reset to draft for retry' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
