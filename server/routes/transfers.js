/**
 * Internal Transfer Routes
 * DEANDREA LAVAR BARKLEY TRUST -- Core Banking Engine
 *
 * Endpoints:
 *   GET    /api/transfers              - List transfers
 *   POST   /api/transfers              - Create transfer
 *   GET    /api/transfers/:id          - Transfer detail
 *   POST   /api/transfers/:id/approve  - Approve transfer
 *   POST   /api/transfers/:id/execute  - Execute approved transfer
 *   POST   /api/transfers/:id/cancel   - Cancel transfer
 *   POST   /api/transfers/:id/reverse  - Reverse completed transfer
 *   GET    /api/transfers/reconciliation - Daily reconciliation snapshot
 *   POST   /api/transfers/reconciliation/snapshot - Create recon snapshot
 */

'use strict';

const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const Database = require('better-sqlite3');

const {
  validateTransfer,
  canTransitionTransfer,
  generateTransferNumber,
  determineTransferApproval,
  checkDailyLimit,
  buildAuditEntry,
  calculateDiscrepancy,
  toDollars,
} = require('../engines/banking-engine');

// --- DB Setup ---------------------------------------------------------------

function getDb() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'dlbtrust.db');
  return new Database(dbPath);
}

let schemaInitialized = false;

function initSchema(db) {
  if (schemaInitialized) return;
  const schemaPath = path.join(__dirname, '..', 'db', 'migrations', 'banking-schema.sql');
  if (fs.existsSync(schemaPath)) {
    const sql = fs.readFileSync(schemaPath, 'utf8');
    db.exec(sql);
  }
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
  db.prepare(`
    INSERT INTO banking_audit_log (event_type, entity_type, entity_id, actor, action, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(entry.event_type, entry.entity_type, entry.entity_id, entry.actor, entry.action, entry.details);
}

function recalcAvailable(db, accountId) {
  const holds = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS total
    FROM account_holds WHERE account_id = ? AND status = 'active'
  `).get(accountId);
  db.prepare(`
    UPDATE trust_accounts
    SET hold_cents = ?, available_cents = balance_cents - ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(holds.total, holds.total, accountId);
}

// ============================================================================
// ROUTES
// ============================================================================

// --- GET /reconciliation -- Reconciliation snapshots -------------------------
router.get('/reconciliation', (req, res) => {
  try {
    const { date, account_id, reconciled } = req.query;
    let where = [];
    let params = [];
    if (date)       { where.push('snapshot_date = ?');  params.push(date); }
    if (account_id) { where.push('account_id = ?');     params.push(account_id); }
    if (reconciled !== undefined) { where.push('reconciled = ?'); params.push(parseInt(reconciled)); }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const snapshots = req.db.prepare(`SELECT * FROM reconciliation_snapshots ${clause} ORDER BY snapshot_date DESC, account_id LIMIT 200`).all(...params);
    res.json({ count: snapshots.length, snapshots });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /reconciliation/snapshot -- Create daily recon snapshot ------------
router.post('/reconciliation/snapshot', (req, res) => {
  try {
    const snapshotDate = req.body.date || new Date().toISOString().slice(0, 10);
    const accounts = req.db.prepare(`SELECT * FROM trust_accounts WHERE status != 'closed'`).all();

    const results = [];
    for (const acct of accounts) {
      const existing = req.db.prepare('SELECT id FROM reconciliation_snapshots WHERE snapshot_date = ? AND account_id = ?').get(snapshotDate, acct.id);
      if (existing) continue;

      const discrepancy = calculateDiscrepancy(acct.balance_cents, req.body.expected_balances?.[acct.id] || null);

      req.db.prepare(`
        INSERT INTO reconciliation_snapshots
          (snapshot_date, account_id, ledger_balance_cents, available_balance_cents,
           hold_balance_cents, accrued_interest_cents, expected_balance_cents, discrepancy_cents)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snapshotDate, acct.id, acct.balance_cents, acct.available_cents,
        acct.hold_cents, acct.interest_accrued_cents,
        req.body.expected_balances?.[acct.id] || null, discrepancy,
      );

      results.push({
        account_id: acct.id,
        account_number: acct.account_number,
        ledger_balance_cents: acct.balance_cents,
        discrepancy_cents: discrepancy,
      });
    }

    res.status(201).json({
      snapshot_date: snapshotDate,
      accounts_snapshot: results.length,
      snapshots: results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET / -- List transfers ------------------------------------------------
router.get('/', (req, res) => {
  try {
    const { status, transfer_type, account_id, limit = 100 } = req.query;
    let where = [];
    let params = [];
    if (status)        { where.push('status = ?');        params.push(status); }
    if (transfer_type) { where.push('transfer_type = ?'); params.push(transfer_type); }
    if (account_id)    { where.push('(from_account_id = ? OR to_account_id = ?)'); params.push(account_id, account_id); }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const transfers = req.db.prepare(`SELECT * FROM internal_transfers ${clause} ORDER BY created_at DESC LIMIT ?`).all(...params, parseInt(limit));
    res.json({
      count: transfers.length,
      transfers: transfers.map(t => ({ ...t, amount_usd: toDollars(t.amount_cents), fee_usd: toDollars(t.fee_cents) })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST / -- Create transfer ----------------------------------------------
router.post('/', (req, res) => {
  try {
    const { from_account_id, to_account_id, amount_cents, transfer_type = 'standard', description = null, memo = null, reference_id = null, priority = 'normal' } = req.body;

    const fromAccount = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(from_account_id);
    const toAccount   = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(to_account_id);

    if (from_account_id && !fromAccount) return res.status(404).json({ error: 'Source account not found' });
    if (to_account_id && !toAccount)     return res.status(404).json({ error: 'Destination account not found' });

    const errors = validateTransfer(req.body, fromAccount, toAccount);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    // Check daily limit
    if (fromAccount && fromAccount.daily_transfer_limit_cents) {
      const today = new Date().toISOString().slice(0, 10);
      const todayRow = req.db.prepare(`
        SELECT COALESCE(SUM(amount_cents), 0) AS total
        FROM internal_transfers
        WHERE from_account_id = ? AND status IN ('pending','approved','executing','completed')
          AND date(created_at) = ?
      `).get(from_account_id, today);

      const limitCheck = checkDailyLimit(fromAccount, todayRow.total, amount_cents);
      if (!limitCheck.allowed) {
        return res.status(400).json({
          error: `Daily transfer limit exceeded. Limit: ${limitCheck.limit_cents}, used: ${limitCheck.used_today_cents}, remaining: ${limitCheck.remaining_cents}`,
        });
      }
    }

    const approval = determineTransferApproval(amount_cents, transfer_type);
    const transfer_number = generateTransferNumber();

    let status = 'pending';
    let approved_by = null;
    let approved_date = null;

    if (!approval.requires_approval) {
      status = 'approved';
      approved_by = 'auto';
      approved_date = new Date().toISOString();
    }

    const result = req.db.prepare(`
      INSERT INTO internal_transfers
        (transfer_number, from_account_id, to_account_id, amount_cents, fee_cents,
         currency, transfer_type, status, priority, description, memo, reference_id,
         requires_approval, approved_by, approved_date, created_by)
      VALUES (?, ?, ?, ?, 0, 'USD', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      transfer_number, from_account_id, to_account_id, amount_cents,
      transfer_type, status, priority, description, memo, reference_id,
      approval.requires_approval ? 1 : 0, approved_by, approved_date,
      req.body.created_by || 'system',
    );

    insertAudit(req.db, buildAuditEntry('transfer_created', 'transfer', result.lastInsertRowid, 'create', req.body.created_by || 'system', {
      transfer_number, amount_cents, from: from_account_id, to: to_account_id, auto_approved: !approval.requires_approval,
    }));

    const transfer = req.db.prepare('SELECT * FROM internal_transfers WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ ...transfer, approval_level: approval.approval_level, auto_approved: !approval.requires_approval });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /:id -- Transfer detail --------------------------------------------
router.get('/:id', (req, res) => {
  try {
    const transfer = req.db.prepare('SELECT * FROM internal_transfers WHERE id = ?').get(req.params.id);
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });

    const fromAccount = req.db.prepare('SELECT account_number, account_name, balance_cents FROM trust_accounts WHERE id = ?').get(transfer.from_account_id);
    const toAccount   = req.db.prepare('SELECT account_number, account_name, balance_cents FROM trust_accounts WHERE id = ?').get(transfer.to_account_id);

    res.json({
      ...transfer,
      amount_usd: toDollars(transfer.amount_cents),
      fee_usd: toDollars(transfer.fee_cents),
      from_account: fromAccount,
      to_account: toAccount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /:id/approve -- Approve transfer ----------------------------------
router.post('/:id/approve', (req, res) => {
  try {
    const transfer = req.db.prepare('SELECT * FROM internal_transfers WHERE id = ?').get(req.params.id);
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    if (!canTransitionTransfer(transfer.status, 'approved')) {
      return res.status(400).json({ error: `Cannot approve transfer in ${transfer.status} status` });
    }

    const approver = req.body.approved_by || 'trustee';

    req.db.prepare(`
      UPDATE internal_transfers SET status = 'approved', approved_by = ?, approved_date = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(approver, transfer.id);

    insertAudit(req.db, buildAuditEntry('transfer_approved', 'transfer', transfer.id, 'approve', approver, { amount_cents: transfer.amount_cents }));

    const updated = req.db.prepare('SELECT * FROM internal_transfers WHERE id = ?').get(transfer.id);
    res.json({ message: 'Transfer approved', transfer: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /:id/execute -- Execute transfer ----------------------------------
router.post('/:id/execute', (req, res) => {
  try {
    const transfer = req.db.prepare('SELECT * FROM internal_transfers WHERE id = ?').get(req.params.id);
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    if (!canTransitionTransfer(transfer.status, 'executing')) {
      return res.status(400).json({ error: `Cannot execute transfer in ${transfer.status} status` });
    }

    const fromAccount = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(transfer.from_account_id);
    const toAccount   = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(transfer.to_account_id);

    // Re-validate balances at execution time
    if (!fromAccount.overdraft_allowed && transfer.amount_cents > fromAccount.available_cents) {
      req.db.prepare(`UPDATE internal_transfers SET status = 'failed', updated_at = datetime('now') WHERE id = ?`).run(transfer.id);
      return res.status(400).json({ error: 'Insufficient funds at time of execution' });
    }

    // Execute in transaction
    const exec = req.db.transaction(() => {
      // Mark as executing
      req.db.prepare(`UPDATE internal_transfers SET status = 'executing', executed_date = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(transfer.id);

      // Debit source
      req.db.prepare(`
        UPDATE trust_accounts SET
          balance_cents = balance_cents - ?,
          available_cents = available_cents - ?,
          last_activity_date = datetime('now'),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(transfer.amount_cents, transfer.amount_cents, fromAccount.id);

      // Credit destination
      req.db.prepare(`
        UPDATE trust_accounts SET
          balance_cents = balance_cents + ?,
          available_cents = available_cents + ?,
          last_activity_date = datetime('now'),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(transfer.amount_cents, transfer.amount_cents, toAccount.id);

      // Mark completed
      req.db.prepare(`UPDATE internal_transfers SET status = 'completed', completed_date = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(transfer.id);
    });

    exec();

    insertAudit(req.db, buildAuditEntry('transfer_executed', 'transfer', transfer.id, 'execute', req.body.executor || 'system', {
      amount_cents: transfer.amount_cents,
      from: fromAccount.account_number,
      to: toAccount.account_number,
    }));

    const completed = req.db.prepare('SELECT * FROM internal_transfers WHERE id = ?').get(transfer.id);
    const updatedFrom = req.db.prepare('SELECT balance_cents, available_cents FROM trust_accounts WHERE id = ?').get(fromAccount.id);
    const updatedTo   = req.db.prepare('SELECT balance_cents, available_cents FROM trust_accounts WHERE id = ?').get(toAccount.id);

    res.json({
      message: 'Transfer executed successfully',
      transfer: completed,
      from_balance_cents: updatedFrom.balance_cents,
      to_balance_cents: updatedTo.balance_cents,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /:id/cancel -- Cancel transfer ------------------------------------
router.post('/:id/cancel', (req, res) => {
  try {
    const transfer = req.db.prepare('SELECT * FROM internal_transfers WHERE id = ?').get(req.params.id);
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    if (!canTransitionTransfer(transfer.status, 'cancelled')) {
      return res.status(400).json({ error: `Cannot cancel transfer in ${transfer.status} status` });
    }

    req.db.prepare(`UPDATE internal_transfers SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).run(transfer.id);

    insertAudit(req.db, buildAuditEntry('transfer_cancelled', 'transfer', transfer.id, 'update', req.body.actor || 'system', { reason: req.body.reason }));

    const updated = req.db.prepare('SELECT * FROM internal_transfers WHERE id = ?').get(transfer.id);
    res.json({ message: 'Transfer cancelled', transfer: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /:id/reverse -- Reverse completed transfer ------------------------
router.post('/:id/reverse', (req, res) => {
  try {
    const transfer = req.db.prepare('SELECT * FROM internal_transfers WHERE id = ?').get(req.params.id);
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    if (!canTransitionTransfer(transfer.status, 'reversed')) {
      return res.status(400).json({ error: `Cannot reverse transfer in ${transfer.status} status` });
    }

    const reversal_number = generateTransferNumber();

    const exec = req.db.transaction(() => {
      // Mark original as reversed
      req.db.prepare(`UPDATE internal_transfers SET status = 'reversed', updated_at = datetime('now') WHERE id = ?`).run(transfer.id);

      // Create reversal transfer (swap from/to)
      req.db.prepare(`
        INSERT INTO internal_transfers
          (transfer_number, from_account_id, to_account_id, amount_cents, fee_cents,
           currency, transfer_type, status, priority, description, requires_approval,
           approved_by, approved_date, executed_date, completed_date, reversal_of, created_by)
        VALUES (?, ?, ?, ?, 0, 'USD', 'standard', 'completed', 'high', ?, 0, 'system', datetime('now'), datetime('now'), datetime('now'), ?, 'system')
      `).run(
        reversal_number, transfer.to_account_id, transfer.from_account_id,
        transfer.amount_cents, `Reversal of ${transfer.transfer_number}: ${req.body.reason || 'Reversal'}`,
        transfer.id,
      );

      // Reverse the balance changes
      req.db.prepare(`
        UPDATE trust_accounts SET
          balance_cents = balance_cents + ?,
          available_cents = available_cents + ?,
          last_activity_date = datetime('now'),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(transfer.amount_cents, transfer.amount_cents, transfer.from_account_id);

      req.db.prepare(`
        UPDATE trust_accounts SET
          balance_cents = balance_cents - ?,
          available_cents = available_cents - ?,
          last_activity_date = datetime('now'),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(transfer.amount_cents, transfer.amount_cents, transfer.to_account_id);
    });

    exec();

    insertAudit(req.db, buildAuditEntry('transfer_reversed', 'transfer', transfer.id, 'reverse', req.body.actor || 'system', {
      reversal_number,
      reason: req.body.reason,
      amount_cents: transfer.amount_cents,
    }));

    res.json({
      message: 'Transfer reversed',
      original_transfer: transfer.transfer_number,
      reversal_number,
      amount_cents: transfer.amount_cents,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
