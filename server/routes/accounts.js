/**
 * Account Management Routes
 * DEANDREA LAVAR BARKLEY TRUST -- Core Banking Engine
 *
 * Endpoints:
 *   GET    /api/accounts              - List all trust accounts
 *   POST   /api/accounts              - Open a new account
 *   GET    /api/accounts/:id          - Account detail
 *   PUT    /api/accounts/:id          - Update account settings
 *   POST   /api/accounts/:id/freeze   - Freeze account
 *   POST   /api/accounts/:id/activate - Activate (or unfreeze) account
 *   POST   /api/accounts/:id/close    - Close account
 *   POST   /api/accounts/:id/kyc      - Update KYC status
 *   GET    /api/accounts/:id/holds    - List holds on account
 *   POST   /api/accounts/:id/holds    - Place a hold
 *   POST   /api/accounts/:id/holds/:holdId/release - Release a hold
 *   GET    /api/accounts/:id/statements - List statements
 *   POST   /api/accounts/:id/statements/generate - Generate statement for a period
 *   GET    /api/accounts/:id/interest  - Interest accrual history
 *   POST   /api/accounts/:id/interest/accrue - Accrue interest for today
 *   GET    /api/accounts/audit-log     - Banking audit log
 *   GET    /api/accounts/trial-balance - GL trial balance
 */

'use strict';

const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const Database = require('better-sqlite3');

const {
  validateAccount,
  canTransitionAccount,
  generateAccountNumber,
  calculateDailyInterest,
  buildAuditEntry,
  buildTrialBalance,
  toDollars,
  VALID_ACCOUNT_STATUSES,
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

// --- Middleware: DB per-request ---------------------------------------------

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

// --- GET /audit-log ---------------------------------------------------------
router.get('/audit-log', (req, res) => {
  try {
    const { entity_type, event_type, limit = 100 } = req.query;
    let where = [];
    let params = [];
    if (entity_type) { where.push('entity_type = ?'); params.push(entity_type); }
    if (event_type)  { where.push('event_type = ?');  params.push(event_type); }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const entries = req.db.prepare(`SELECT * FROM banking_audit_log ${clause} ORDER BY created_at DESC LIMIT ?`).all(...params, parseInt(limit));
    res.json({ count: entries.length, entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /trial-balance -----------------------------------------------------
router.get('/trial-balance', (req, res) => {
  try {
    const accounts = req.db.prepare(`SELECT * FROM trust_accounts WHERE status != 'closed' ORDER BY account_type, id`).all();
    const trialBalance = buildTrialBalance(accounts);
    trialBalance.total_assets_usd = toDollars(trialBalance.total_assets_cents);
    trialBalance.total_liabilities_usd = toDollars(trialBalance.total_liabilities_cents);
    trialBalance.net_position_usd = toDollars(trialBalance.net_position_cents);
    res.json(trialBalance);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET / -- List accounts -------------------------------------------------
router.get('/', (req, res) => {
  try {
    const { status, account_type, owner_type } = req.query;
    let where = [];
    let params = [];
    if (status)       { where.push('status = ?');       params.push(status); }
    if (account_type) { where.push('account_type = ?'); params.push(account_type); }
    if (owner_type)   { where.push('owner_type = ?');   params.push(owner_type); }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const accounts = req.db.prepare(`SELECT * FROM trust_accounts ${clause} ORDER BY id`).all(...params);
    res.json({
      count: accounts.length,
      accounts: accounts.map(a => ({ ...a, balance_usd: toDollars(a.balance_cents), available_usd: toDollars(a.available_cents) })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST / -- Open account -------------------------------------------------
router.post('/', (req, res) => {
  try {
    const errors = validateAccount(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const {
      account_name,
      account_type = 'operating',
      owner_type = 'trust',
      owner_name = null,
      wallet_id = null,
      currency = 'USD',
      balance_cents = 0,
      interest_rate_bps = 0,
      interest_method = 'daily',
      daily_transfer_limit_cents = null,
      single_transfer_limit_cents = null,
      overdraft_allowed = 0,
      overdraft_limit_cents = 0,
      notes = null,
    } = req.body;

    const account_number = generateAccountNumber(account_type);

    const result = req.db.prepare(`
      INSERT INTO trust_accounts
        (account_number, account_name, account_type, owner_type, owner_name, wallet_id,
         currency, balance_cents, available_cents, interest_rate_bps, interest_method,
         daily_transfer_limit_cents, single_transfer_limit_cents,
         overdraft_allowed, overdraft_limit_cents, notes, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      account_number, account_name, account_type, owner_type, owner_name, wallet_id,
      currency, balance_cents, balance_cents, interest_rate_bps, interest_method,
      daily_transfer_limit_cents, single_transfer_limit_cents,
      overdraft_allowed, overdraft_limit_cents, notes,
    );

    const account = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(result.lastInsertRowid);

    insertAudit(req.db, buildAuditEntry('account_opened', 'account', account.id, 'create', req.body.created_by || 'system', { account_number, account_type }));

    res.status(201).json(account);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /:id -- Account detail ---------------------------------------------
router.get('/:id', (req, res) => {
  try {
    const account = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const holds = req.db.prepare(`
      SELECT * FROM account_holds WHERE account_id = ? AND status = 'active' ORDER BY placed_date DESC
    `).all(req.params.id);

    const recentTransfers = req.db.prepare(`
      SELECT * FROM internal_transfers
      WHERE from_account_id = ? OR to_account_id = ?
      ORDER BY created_at DESC LIMIT 10
    `).all(req.params.id, req.params.id);

    res.json({
      ...account,
      balance_usd: toDollars(account.balance_cents),
      available_usd: toDollars(account.available_cents),
      active_holds: holds,
      recent_transfers: recentTransfers,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- PUT /:id -- Update account settings ------------------------------------
router.put('/:id', (req, res) => {
  try {
    const account = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (account.status === 'closed') return res.status(400).json({ error: 'Cannot update a closed account' });

    const errors = validateAccount(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const {
      account_name = account.account_name,
      interest_rate_bps = account.interest_rate_bps,
      interest_method = account.interest_method,
      daily_transfer_limit_cents = account.daily_transfer_limit_cents,
      single_transfer_limit_cents = account.single_transfer_limit_cents,
      overdraft_allowed = account.overdraft_allowed,
      overdraft_limit_cents = account.overdraft_limit_cents,
      aml_risk_rating = account.aml_risk_rating,
      notes = account.notes,
    } = req.body;

    req.db.prepare(`
      UPDATE trust_accounts SET
        account_name = ?, interest_rate_bps = ?, interest_method = ?,
        daily_transfer_limit_cents = ?, single_transfer_limit_cents = ?,
        overdraft_allowed = ?, overdraft_limit_cents = ?,
        aml_risk_rating = ?, notes = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      account_name, interest_rate_bps, interest_method,
      daily_transfer_limit_cents, single_transfer_limit_cents,
      overdraft_allowed, overdraft_limit_cents,
      aml_risk_rating, notes, req.params.id,
    );

    insertAudit(req.db, buildAuditEntry('account_updated', 'account', account.id, 'update', req.body.updated_by || 'system', { changed_fields: Object.keys(req.body) }));

    const updated = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /:id/freeze -------------------------------------------------------
router.post('/:id/freeze', (req, res) => {
  try {
    const account = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (!canTransitionAccount(account.status, 'frozen')) {
      return res.status(400).json({ error: `Cannot freeze account in ${account.status} status` });
    }

    req.db.prepare(`
      UPDATE trust_accounts SET status = 'frozen', status_reason = ?, updated_at = datetime('now') WHERE id = ?
    `).run(req.body.reason || 'Administrative freeze', req.params.id);

    insertAudit(req.db, buildAuditEntry('account_frozen', 'account', account.id, 'update', req.body.actor || 'system', { reason: req.body.reason }));

    const updated = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(req.params.id);
    res.json({ message: 'Account frozen', account: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /:id/activate -----------------------------------------------------
router.post('/:id/activate', (req, res) => {
  try {
    const account = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (!canTransitionAccount(account.status, 'active')) {
      return res.status(400).json({ error: `Cannot activate account in ${account.status} status` });
    }

    req.db.prepare(`
      UPDATE trust_accounts SET status = 'active', status_reason = NULL, updated_at = datetime('now') WHERE id = ?
    `).run(req.params.id);

    insertAudit(req.db, buildAuditEntry('account_activated', 'account', account.id, 'update', req.body.actor || 'system', { previous_status: account.status }));

    const updated = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(req.params.id);
    res.json({ message: 'Account activated', account: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /:id/close --------------------------------------------------------
router.post('/:id/close', (req, res) => {
  try {
    const account = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (!canTransitionAccount(account.status, 'closed')) {
      return res.status(400).json({ error: `Cannot close account in ${account.status} status` });
    }
    if (account.balance_cents !== 0) {
      return res.status(400).json({ error: `Account has non-zero balance (${account.balance_cents} cents). Transfer funds before closing.` });
    }

    const activeHolds = req.db.prepare(`
      SELECT COUNT(*) AS count FROM account_holds WHERE account_id = ? AND status = 'active'
    `).get(req.params.id);
    if (activeHolds.count > 0) {
      return res.status(400).json({ error: `Account has ${activeHolds.count} active hold(s). Release all holds before closing.` });
    }

    req.db.prepare(`
      UPDATE trust_accounts SET status = 'closed', status_reason = ?, closed_date = date('now'), updated_at = datetime('now') WHERE id = ?
    `).run(req.body.reason || 'Account closed', req.params.id);

    insertAudit(req.db, buildAuditEntry('account_closed', 'account', account.id, 'update', req.body.actor || 'system', { reason: req.body.reason }));

    const updated = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(req.params.id);
    res.json({ message: 'Account closed', account: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /:id/kyc ----------------------------------------------------------
router.post('/:id/kyc', (req, res) => {
  try {
    const account = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const { kyc_status, kyc_expiry_date, aml_risk_rating } = req.body;
    if (!kyc_status) return res.status(400).json({ error: 'kyc_status is required' });

    const validStatuses = ['pending', 'verified', 'expired', 'failed'];
    if (!validStatuses.includes(kyc_status)) {
      return res.status(400).json({ error: `Invalid kyc_status. Must be one of: ${validStatuses.join(', ')}` });
    }

    req.db.prepare(`
      UPDATE trust_accounts SET
        kyc_status = ?,
        kyc_verified_date = CASE WHEN ? = 'verified' THEN datetime('now') ELSE kyc_verified_date END,
        kyc_expiry_date = COALESCE(?, kyc_expiry_date),
        aml_risk_rating = COALESCE(?, aml_risk_rating),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(kyc_status, kyc_status, kyc_expiry_date || null, aml_risk_rating || null, req.params.id);

    insertAudit(req.db, buildAuditEntry('kyc_updated', 'account', account.id, 'update', req.body.actor || 'compliance', { kyc_status, aml_risk_rating }));

    const updated = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(req.params.id);
    res.json({ message: 'KYC status updated', account: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /:id/holds ---------------------------------------------------------
router.get('/:id/holds', (req, res) => {
  try {
    const account = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const status = req.query.status || null;
    let holds;
    if (status) {
      holds = req.db.prepare('SELECT * FROM account_holds WHERE account_id = ? AND status = ? ORDER BY placed_date DESC').all(req.params.id, status);
    } else {
      holds = req.db.prepare('SELECT * FROM account_holds WHERE account_id = ? ORDER BY placed_date DESC').all(req.params.id);
    }

    res.json({ count: holds.length, holds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /:id/holds --------------------------------------------------------
router.post('/:id/holds', (req, res) => {
  try {
    const account = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (account.status !== 'active') return res.status(400).json({ error: 'Can only place holds on active accounts' });

    const { amount_cents, reason, hold_type = 'administrative', release_date = null, reference_id = null } = req.body;
    if (!amount_cents || amount_cents <= 0) return res.status(400).json({ error: 'amount_cents must be a positive integer' });
    if (!reason) return res.status(400).json({ error: 'reason is required' });
    if (amount_cents > account.available_cents) {
      return res.status(400).json({ error: `Hold amount exceeds available balance. Available: ${account.available_cents}` });
    }

    const result = req.db.prepare(`
      INSERT INTO account_holds (account_id, hold_type, amount_cents, reason, reference_id, release_date, placed_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(req.params.id, hold_type, amount_cents, reason, reference_id, release_date, req.body.placed_by || 'system');

    recalcAvailable(req.db, parseInt(req.params.id));

    insertAudit(req.db, buildAuditEntry('hold_placed', 'hold', result.lastInsertRowid, 'create', req.body.placed_by || 'system', { amount_cents, reason }));

    const hold = req.db.prepare('SELECT * FROM account_holds WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(hold);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /:id/holds/:holdId/release ----------------------------------------
router.post('/:id/holds/:holdId/release', (req, res) => {
  try {
    const hold = req.db.prepare('SELECT * FROM account_holds WHERE id = ? AND account_id = ?').get(req.params.holdId, req.params.id);
    if (!hold) return res.status(404).json({ error: 'Hold not found' });
    if (hold.status !== 'active') return res.status(400).json({ error: `Hold is already ${hold.status}` });

    req.db.prepare(`
      UPDATE account_holds SET status = 'released', released_date = datetime('now'), released_by = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(req.body.released_by || 'system', hold.id);

    recalcAvailable(req.db, parseInt(req.params.id));

    insertAudit(req.db, buildAuditEntry('hold_released', 'hold', hold.id, 'update', req.body.released_by || 'system', { amount_cents: hold.amount_cents }));

    const updated = req.db.prepare('SELECT * FROM account_holds WHERE id = ?').get(hold.id);
    res.json({ message: 'Hold released', hold: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /:id/statements ----------------------------------------------------
router.get('/:id/statements', (req, res) => {
  try {
    const account = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const statements = req.db.prepare(`
      SELECT * FROM account_statements WHERE account_id = ? ORDER BY statement_period DESC
    `).all(req.params.id);

    res.json({
      count: statements.length,
      statements: statements.map(s => ({
        ...s,
        opening_balance_usd: toDollars(s.opening_balance_cents),
        closing_balance_usd: toDollars(s.closing_balance_cents),
        total_credits_usd: toDollars(s.total_credits_cents),
        total_debits_usd: toDollars(s.total_debits_cents),
        interest_earned_usd: toDollars(s.interest_earned_cents),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /:id/statements/generate -----------------------------------------
router.post('/:id/statements/generate', (req, res) => {
  try {
    const account = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const { period } = req.body; // YYYY-MM
    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
      return res.status(400).json({ error: 'period is required in YYYY-MM format' });
    }

    const existing = req.db.prepare('SELECT id FROM account_statements WHERE account_id = ? AND statement_period = ?').get(req.params.id, period);
    if (existing) return res.status(409).json({ error: `Statement already exists for ${period}` });

    // Gather transfers for the period
    const transfers = req.db.prepare(`
      SELECT * FROM internal_transfers
      WHERE (from_account_id = ? OR to_account_id = ?) AND status = 'completed'
        AND strftime('%Y-%m', completed_date) = ?
    `).all(req.params.id, req.params.id, period);

    let totalCredits = 0;
    let totalDebits = 0;
    for (const t of transfers) {
      if (t.to_account_id === parseInt(req.params.id)) {
        totalCredits += t.amount_cents;
      } else {
        totalDebits += t.amount_cents + t.fee_cents;
      }
    }

    // Interest for the period
    const interestRow = req.db.prepare(`
      SELECT COALESCE(SUM(accrued_cents), 0) AS total
      FROM account_interest WHERE account_id = ? AND strftime('%Y-%m', accrual_date) = ?
    `).get(req.params.id, period);

    const openingBalance = account.balance_cents - totalCredits + totalDebits - interestRow.total;
    const closingBalance = account.balance_cents;

    const result = req.db.prepare(`
      INSERT INTO account_statements
        (account_id, statement_period, opening_balance_cents, closing_balance_cents,
         total_credits_cents, total_debits_cents, interest_earned_cents,
         hold_balance_cents, transaction_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id, period, openingBalance, closingBalance,
      totalCredits, totalDebits, interestRow.total,
      account.hold_cents, transfers.length,
    );

    req.db.prepare(`UPDATE trust_accounts SET last_statement_date = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(req.params.id);

    insertAudit(req.db, buildAuditEntry('statement_generated', 'statement', result.lastInsertRowid, 'create', 'system', { period }));

    const stmt = req.db.prepare('SELECT * FROM account_statements WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(stmt);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /:id/interest ------------------------------------------------------
router.get('/:id/interest', (req, res) => {
  try {
    const account = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const entries = req.db.prepare(`
      SELECT * FROM account_interest WHERE account_id = ? ORDER BY accrual_date DESC LIMIT 90
    `).all(req.params.id);

    const totalAccrued = req.db.prepare(`
      SELECT COALESCE(SUM(accrued_cents), 0) AS total FROM account_interest WHERE account_id = ?
    `).get(req.params.id);

    res.json({
      account_id: account.id,
      current_rate_bps: account.interest_rate_bps,
      interest_method: account.interest_method,
      total_accrued_cents: totalAccrued.total,
      total_accrued_usd: toDollars(totalAccrued.total),
      pending_accrual_cents: account.interest_accrued_cents,
      entries,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /:id/interest/accrue ----------------------------------------------
router.post('/:id/interest/accrue', (req, res) => {
  try {
    const account = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (account.status !== 'active') return res.status(400).json({ error: 'Can only accrue interest on active accounts' });
    if (account.interest_rate_bps <= 0) return res.status(400).json({ error: 'Account has no interest rate configured' });

    const today = new Date().toISOString().slice(0, 10);
    const existing = req.db.prepare('SELECT id FROM account_interest WHERE account_id = ? AND accrual_date = ?').get(req.params.id, today);
    if (existing) return res.status(409).json({ error: `Interest already accrued for ${today}` });

    const accrued = calculateDailyInterest(account.balance_cents, account.interest_rate_bps);

    const result = req.db.prepare(`
      INSERT INTO account_interest (account_id, accrual_date, balance_cents, rate_bps, accrued_cents)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.params.id, today, account.balance_cents, account.interest_rate_bps, accrued);

    req.db.prepare(`
      UPDATE trust_accounts SET
        interest_accrued_cents = interest_accrued_cents + ?,
        last_interest_date = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(accrued, today, req.params.id);

    insertAudit(req.db, buildAuditEntry('interest_accrued', 'account', account.id, 'update', 'system', { accrual_date: today, accrued_cents: accrued, balance_cents: account.balance_cents, rate_bps: account.interest_rate_bps }));

    res.status(201).json({
      accrual_date: today,
      balance_cents: account.balance_cents,
      rate_bps: account.interest_rate_bps,
      accrued_cents: accrued,
      accrued_usd: toDollars(accrued),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
