/**
 * Trust Accounting Routes
 * DEANDREA LAVAR BARKLEY TRUST — Fiduciary Compliance Accounting
 *
 * Endpoints:
 *   GET    /api/trust-accounting/chart-of-accounts        - List chart of accounts
 *   POST   /api/trust-accounting/chart-of-accounts        - Create new account
 *   PUT    /api/trust-accounting/chart-of-accounts/:id    - Update account
 *   DELETE /api/trust-accounting/chart-of-accounts/:id    - Deactivate account
 *
 *   GET    /api/trust-accounting/periods                  - List accounting periods
 *   POST   /api/trust-accounting/periods                  - Create period
 *   POST   /api/trust-accounting/periods/:id/close        - Close period
 *
 *   GET    /api/trust-accounting/journal-entries           - List journal entries
 *   POST   /api/trust-accounting/journal-entries           - Create journal entry
 *   GET    /api/trust-accounting/journal-entries/:id       - Journal entry detail
 *   POST   /api/trust-accounting/journal-entries/:id/reverse - Reverse an entry
 *
 *   GET    /api/trust-accounting/general-ledger           - General ledger
 *   GET    /api/trust-accounting/trial-balance            - Trial balance
 *
 *   GET    /api/trust-accounting/income-principal          - Income/principal allocations
 *   POST   /api/trust-accounting/income-principal          - Record allocation
 *
 *   GET    /api/trust-accounting/reports/balance-sheet     - Balance sheet
 *   GET    /api/trust-accounting/reports/income-statement  - Income statement
 *   GET    /api/trust-accounting/reports/k1-data           - K-1 beneficiary data
 *   GET    /api/trust-accounting/reports/dni               - Distributable net income
 *
 *   GET    /api/trust-accounting/dashboard                - Trust accounting dashboard
 */

'use strict';

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const {
  ACCOUNT_TYPES,
  NORMAL_BALANCES,
  ENTRY_TYPES,
  REFERENCE_TYPES,
  ALLOCATION_CATEGORIES,
  ALLOCATION_CLASSES,
  PERIOD_STATUSES,
  UPIA_DEFAULTS,
  validateChartOfAccount,
  validateJournalEntry,
  validateAllocation,
  generateEntryNumber,
  calculateGLBalance,
  buildAccountingTrialBalance,
  buildBalanceSheet,
  buildIncomeStatement,
  calculateDNI,
  buildK1Data,
  toDollars,
} = require('../engines/trust-accounting-engine');

// --- DB Setup ---------------------------------------------------------------

function getDb() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'dlbtrust.db');
  return new Database(dbPath);
}

let schemaInitialized = false;

function initSchema(db) {
  if (schemaInitialized) return;

  // Run trust accounting schema
  const schemaPath = path.join(__dirname, '..', 'db', 'migrations', 'trust-accounting-schema.sql');
  if (fs.existsSync(schemaPath)) {
    const sql = fs.readFileSync(schemaPath, 'utf8');
    db.exec(sql);
  }

  // Also ensure banking schema exists (we reference trust_accounts)
  const bankingPath = path.join(__dirname, '..', 'db', 'migrations', 'banking-schema.sql');
  if (fs.existsSync(bankingPath)) {
    const sql = fs.readFileSync(bankingPath, 'utf8');
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

// Safe query helpers
function safeQuery(db, sql, params = []) {
  try { return db.prepare(sql).all(...params); } catch (_) { return []; }
}
function safeGet(db, sql, params = []) {
  try { return db.prepare(sql).get(...params) || {}; } catch (_) { return {}; }
}

// ============================================================================
// CHART OF ACCOUNTS
// ============================================================================

// GET /chart-of-accounts
router.get('/chart-of-accounts', (req, res) => {
  try {
    const { type, active } = req.query;
    let sql = 'SELECT * FROM trust_chart_of_accounts WHERE 1=1';
    const params = [];

    if (type) {
      sql += ' AND account_type = ?';
      params.push(type);
    }
    if (active !== undefined) {
      sql += ' AND is_active = ?';
      params.push(active === 'true' ? 1 : 0);
    }
    sql += ' ORDER BY display_order, account_code';

    const accounts = req.db.prepare(sql).all(...params);
    res.json({ count: accounts.length, accounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /chart-of-accounts
router.post('/chart-of-accounts', (req, res) => {
  try {
    const data = req.body;
    const errors = validateChartOfAccount(data);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    // Check for duplicate code
    const existing = req.db.prepare('SELECT id FROM trust_chart_of_accounts WHERE account_code = ?').get(data.account_code);
    if (existing) return res.status(409).json({ error: `Account code ${data.account_code} already exists` });

    const normalBalance = data.normal_balance || NORMAL_BALANCES[data.account_type] || 'debit';

    const result = req.db.prepare(`
      INSERT INTO trust_chart_of_accounts (account_code, account_name, account_type, sub_type, normal_balance, parent_code, description, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.account_code,
      data.account_name,
      data.account_type,
      data.sub_type || null,
      normalBalance,
      data.parent_code || null,
      data.description || null,
      data.display_order || 0,
    );

    const account = req.db.prepare('SELECT * FROM trust_chart_of_accounts WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(account);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /chart-of-accounts/:id
router.put('/chart-of-accounts/:id', (req, res) => {
  try {
    const account = req.db.prepare('SELECT * FROM trust_chart_of_accounts WHERE id = ?').get(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (account.is_system) return res.status(403).json({ error: 'Cannot modify system accounts' });

    const data = req.body;
    req.db.prepare(`
      UPDATE trust_chart_of_accounts SET
        account_name = COALESCE(?, account_name),
        sub_type = COALESCE(?, sub_type),
        description = COALESCE(?, description),
        parent_code = COALESCE(?, parent_code),
        display_order = COALESCE(?, display_order),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      data.account_name || null,
      data.sub_type || null,
      data.description || null,
      data.parent_code || null,
      data.display_order || null,
      req.params.id,
    );

    const updated = req.db.prepare('SELECT * FROM trust_chart_of_accounts WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /chart-of-accounts/:id (soft delete — deactivate)
router.delete('/chart-of-accounts/:id', (req, res) => {
  try {
    const account = req.db.prepare('SELECT * FROM trust_chart_of_accounts WHERE id = ?').get(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (account.is_system) return res.status(403).json({ error: 'Cannot delete system accounts' });

    // Check for journal lines referencing this account
    const usage = req.db.prepare('SELECT COUNT(*) AS count FROM trust_journal_lines WHERE account_id = ?').get(req.params.id);
    if (usage.count > 0) return res.status(409).json({ error: `Cannot delete: account has ${usage.count} journal entries` });

    req.db.prepare('UPDATE trust_chart_of_accounts SET is_active = 0, updated_at = datetime(\'now\') WHERE id = ?').run(req.params.id);
    res.json({ message: 'Account deactivated', id: parseInt(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// ACCOUNTING PERIODS
// ============================================================================

// GET /periods
router.get('/periods', (req, res) => {
  try {
    const { status } = req.query;
    let sql = 'SELECT * FROM trust_accounting_periods';
    const params = [];
    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }
    sql += ' ORDER BY start_date DESC';
    const periods = req.db.prepare(sql).all(...params);
    res.json({ count: periods.length, periods });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /periods
router.post('/periods', (req, res) => {
  try {
    const { period_name, period_type, start_date, end_date, notes } = req.body;
    if (!period_name || !start_date || !end_date) {
      return res.status(400).json({ error: 'period_name, start_date, and end_date are required' });
    }

    // Check overlap
    const overlap = req.db.prepare(`
      SELECT id FROM trust_accounting_periods
      WHERE start_date <= ? AND end_date >= ? AND status != 'locked'
    `).get(end_date, start_date);

    const result = req.db.prepare(`
      INSERT INTO trust_accounting_periods (period_name, period_type, start_date, end_date, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(period_name, period_type || 'monthly', start_date, end_date, notes || null);

    const period = req.db.prepare('SELECT * FROM trust_accounting_periods WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(period);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Period name already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// POST /periods/:id/close
router.post('/periods/:id/close', (req, res) => {
  try {
    const period = req.db.prepare('SELECT * FROM trust_accounting_periods WHERE id = ?').get(req.params.id);
    if (!period) return res.status(404).json({ error: 'Period not found' });
    if (period.status === 'closed') return res.status(400).json({ error: 'Period is already closed' });
    if (period.status === 'locked') return res.status(400).json({ error: 'Period is locked' });

    req.db.prepare(`
      UPDATE trust_accounting_periods SET status = 'closed', closed_by = ?, closed_date = datetime('now'), updated_at = datetime('now') WHERE id = ?
    `).run(req.body.closed_by || 'system', req.params.id);

    const updated = req.db.prepare('SELECT * FROM trust_accounting_periods WHERE id = ?').get(req.params.id);
    res.json({ message: 'Period closed', period: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// JOURNAL ENTRIES
// ============================================================================

// GET /journal-entries
router.get('/journal-entries', (req, res) => {
  try {
    const { start_date, end_date, entry_type, source_engine, limit: lim } = req.query;
    let sql = 'SELECT * FROM trust_journal_entries WHERE 1=1';
    const params = [];

    if (start_date) { sql += ' AND entry_date >= ?'; params.push(start_date); }
    if (end_date) { sql += ' AND entry_date <= ?'; params.push(end_date); }
    if (entry_type) { sql += ' AND entry_type = ?'; params.push(entry_type); }
    if (source_engine) { sql += ' AND source_engine = ?'; params.push(source_engine); }

    sql += ' ORDER BY entry_date DESC, id DESC';
    if (lim) { sql += ' LIMIT ?'; params.push(parseInt(lim)); }

    const entries = req.db.prepare(sql).all(...params);
    res.json({ count: entries.length, entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /journal-entries/:id
router.get('/journal-entries/:id', (req, res) => {
  try {
    const entry = req.db.prepare('SELECT * FROM trust_journal_entries WHERE id = ?').get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Journal entry not found' });

    const lines = req.db.prepare(`
      SELECT jl.*, coa.account_name, coa.account_type
      FROM trust_journal_lines jl
      JOIN trust_chart_of_accounts coa ON jl.account_id = coa.id
      WHERE jl.journal_entry_id = ?
      ORDER BY jl.line_number
    `).all(entry.id);

    res.json({ ...entry, lines });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /journal-entries
router.post('/journal-entries', (req, res) => {
  try {
    const { lines, ...entryData } = req.body;
    const errors = validateJournalEntry(entryData, lines);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    // Check period is open
    if (entryData.period_id) {
      const period = req.db.prepare('SELECT * FROM trust_accounting_periods WHERE id = ?').get(entryData.period_id);
      if (period && period.status !== 'open') {
        return res.status(400).json({ error: `Cannot post to ${period.status} period (${period.period_name})` });
      }
    }

    // Resolve account IDs from codes if needed, and validate accounts exist
    const resolvedLines = [];
    let totalDebits = 0;
    let totalCredits = 0;

    for (const line of lines) {
      let account;
      if (line.account_id) {
        account = req.db.prepare('SELECT * FROM trust_chart_of_accounts WHERE id = ?').get(line.account_id);
      } else if (line.account_code) {
        account = req.db.prepare('SELECT * FROM trust_chart_of_accounts WHERE account_code = ?').get(line.account_code);
      }
      if (!account) {
        return res.status(400).json({ error: `Account not found: ${line.account_id || line.account_code}` });
      }
      if (!account.is_active) {
        return res.status(400).json({ error: `Account ${account.account_code} is inactive` });
      }

      const debit = line.debit_cents || 0;
      const credit = line.credit_cents || 0;
      totalDebits += debit;
      totalCredits += credit;

      resolvedLines.push({
        ...line,
        account_id: account.id,
        account_code: account.account_code,
        debit_cents: debit,
        credit_cents: credit,
      });
    }

    const entryNumber = generateEntryNumber();

    // Insert in transaction
    const insertEntry = req.db.prepare(`
      INSERT INTO trust_journal_entries (entry_number, entry_date, period_id, entry_type, description, memo, reference_type, reference_id, source_engine, is_posted, total_debit_cents, total_credit_cents, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertLine = req.db.prepare(`
      INSERT INTO trust_journal_lines (journal_entry_id, line_number, account_id, account_code, debit_cents, credit_cents, description, allocation_type, contact_id, trust_account_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const txn = req.db.transaction(() => {
      const entryResult = insertEntry.run(
        entryNumber,
        entryData.entry_date,
        entryData.period_id || null,
        entryData.entry_type || 'standard',
        entryData.description,
        entryData.memo || null,
        entryData.reference_type || null,
        entryData.reference_id || null,
        entryData.source_engine || null,
        entryData.is_posted !== false ? 1 : 0,
        totalDebits,
        totalCredits,
        entryData.created_by || 'system',
      );

      const entryId = entryResult.lastInsertRowid;

      for (let i = 0; i < resolvedLines.length; i++) {
        const l = resolvedLines[i];
        insertLine.run(
          entryId,
          i + 1,
          l.account_id,
          l.account_code,
          l.debit_cents,
          l.credit_cents,
          l.description || null,
          l.allocation_type || null,
          l.contact_id || null,
          l.trust_account_id || null,
        );
      }

      return entryId;
    });

    const entryId = txn();
    const entry = req.db.prepare('SELECT * FROM trust_journal_entries WHERE id = ?').get(entryId);
    const savedLines = req.db.prepare(`
      SELECT jl.*, coa.account_name, coa.account_type
      FROM trust_journal_lines jl
      JOIN trust_chart_of_accounts coa ON jl.account_id = coa.id
      WHERE jl.journal_entry_id = ?
      ORDER BY jl.line_number
    `).all(entryId);

    res.status(201).json({
      ...entry,
      lines: savedLines,
      message: `Journal entry ${entryNumber} created`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /journal-entries/:id/reverse
router.post('/journal-entries/:id/reverse', (req, res) => {
  try {
    const original = req.db.prepare('SELECT * FROM trust_journal_entries WHERE id = ?').get(req.params.id);
    if (!original) return res.status(404).json({ error: 'Journal entry not found' });
    if (original.is_reversed) return res.status(400).json({ error: 'Entry is already reversed' });

    const originalLines = req.db.prepare('SELECT * FROM trust_journal_lines WHERE journal_entry_id = ? ORDER BY line_number').all(original.id);

    const reverseNumber = generateEntryNumber();
    const today = new Date().toISOString().slice(0, 10);

    const txn = req.db.transaction(() => {
      // Create reversal entry (swap debits and credits)
      const result = req.db.prepare(`
        INSERT INTO trust_journal_entries (entry_number, entry_date, period_id, entry_type, description, memo, reference_type, reference_id, source_engine, is_posted, reversal_of, total_debit_cents, total_credit_cents, created_by)
        VALUES (?, ?, ?, 'reversing', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(
        reverseNumber,
        req.body.entry_date || today,
        original.period_id,
        `Reversal of ${original.entry_number}: ${original.description}`,
        req.body.memo || `Reversing entry ${original.entry_number}`,
        original.reference_type,
        original.reference_id,
        original.source_engine,
        original.id,
        original.total_credit_cents, // swap
        original.total_debit_cents,
        req.body.created_by || 'system',
      );

      const reversalId = result.lastInsertRowid;

      // Reverse each line (swap debit/credit)
      for (const line of originalLines) {
        req.db.prepare(`
          INSERT INTO trust_journal_lines (journal_entry_id, line_number, account_id, account_code, debit_cents, credit_cents, description, allocation_type, contact_id, trust_account_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          reversalId,
          line.line_number,
          line.account_id,
          line.account_code,
          line.credit_cents, // swap
          line.debit_cents,
          `Reversal: ${line.description || ''}`,
          line.allocation_type,
          line.contact_id,
          line.trust_account_id,
        );
      }

      // Mark original as reversed
      req.db.prepare('UPDATE trust_journal_entries SET is_reversed = 1, updated_at = datetime(\'now\') WHERE id = ?').run(original.id);

      return reversalId;
    });

    const reversalId = txn();
    const reversal = req.db.prepare('SELECT * FROM trust_journal_entries WHERE id = ?').get(reversalId);
    res.status(201).json({ message: `Entry ${original.entry_number} reversed`, reversal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// GENERAL LEDGER
// ============================================================================

// GET /general-ledger
router.get('/general-ledger', (req, res) => {
  try {
    const { account_id, account_code, start_date, end_date } = req.query;
    const asOf = end_date || new Date().toISOString().slice(0, 10);
    const from = start_date || '2000-01-01';

    let accounts;
    if (account_id) {
      accounts = [req.db.prepare('SELECT * FROM trust_chart_of_accounts WHERE id = ?').get(account_id)].filter(Boolean);
    } else if (account_code) {
      accounts = [req.db.prepare('SELECT * FROM trust_chart_of_accounts WHERE account_code = ?').get(account_code)].filter(Boolean);
    } else {
      accounts = req.db.prepare('SELECT * FROM trust_chart_of_accounts WHERE is_active = 1 ORDER BY account_code').all();
    }

    const ledger = accounts.map(acct => {
      const entries = req.db.prepare(`
        SELECT jl.*, je.entry_number, je.entry_date, je.description AS entry_description, je.reference_type, je.source_engine
        FROM trust_journal_lines jl
        JOIN trust_journal_entries je ON jl.journal_entry_id = je.id
        WHERE jl.account_id = ? AND je.is_posted = 1 AND je.entry_date BETWEEN ? AND ?
        ORDER BY je.entry_date, je.id, jl.line_number
      `).all(acct.id, from, asOf);

      // Running balance
      let runningBalance = 0;
      const enriched = entries.map(e => {
        runningBalance += e.debit_cents - e.credit_cents;
        return {
          ...e,
          running_balance_cents: runningBalance,
          running_balance_usd: toDollars(
            acct.normal_balance === 'debit' ? runningBalance : -runningBalance
          ),
        };
      });

      const bal = calculateGLBalance(req.db, acct.id, asOf);
      const displayBalance = acct.normal_balance === 'debit' ? bal.balance : -bal.balance;

      return {
        account_id: acct.id,
        account_code: acct.account_code,
        account_name: acct.account_name,
        account_type: acct.account_type,
        normal_balance: acct.normal_balance,
        balance_cents: displayBalance,
        balance_usd: toDollars(displayBalance),
        entry_count: entries.length,
        entries: enriched,
      };
    });

    res.json({ period: { start_date: from, end_date: asOf }, accounts: ledger });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// TRIAL BALANCE
// ============================================================================

// GET /trial-balance
router.get('/trial-balance', (req, res) => {
  try {
    const asOfDate = req.query.as_of || new Date().toISOString().slice(0, 10);
    const tb = buildAccountingTrialBalance(req.db, asOfDate);
    res.json(tb);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// INCOME / PRINCIPAL ALLOCATIONS
// ============================================================================

// GET /income-principal
router.get('/income-principal', (req, res) => {
  try {
    const { start_date, end_date, classification, category } = req.query;
    let sql = 'SELECT * FROM trust_income_allocations WHERE 1=1';
    const params = [];

    if (start_date) { sql += ' AND allocation_date >= ?'; params.push(start_date); }
    if (end_date) { sql += ' AND allocation_date <= ?'; params.push(end_date); }
    if (classification) { sql += ' AND classification = ?'; params.push(classification); }
    if (category) { sql += ' AND category = ?'; params.push(category); }

    sql += ' ORDER BY allocation_date DESC';
    const allocations = req.db.prepare(sql).all(...params);

    // Summaries
    const principalTotal = allocations.filter(a => a.classification === 'principal').reduce((s, a) => s + a.amount_cents, 0);
    const incomeTotal = allocations.filter(a => a.classification === 'income').reduce((s, a) => s + a.amount_cents, 0);

    res.json({
      count: allocations.length,
      principal_total_cents: principalTotal,
      principal_total_usd: toDollars(principalTotal),
      income_total_cents: incomeTotal,
      income_total_usd: toDollars(incomeTotal),
      allocations,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /income-principal
router.post('/income-principal', (req, res) => {
  try {
    const data = req.body;
    const errors = validateAllocation(data);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    // Apply UPIA default if classification not specified
    const classification = data.classification || UPIA_DEFAULTS[data.category] || 'income';
    const allocationDate = data.allocation_date || new Date().toISOString().slice(0, 10);
    const ruleApplied = data.rule_applied || (data.classification ? null : `UPIA default: ${data.category} → ${classification}`);

    const result = req.db.prepare(`
      INSERT INTO trust_income_allocations (journal_entry_id, allocation_date, category, classification, amount_cents, beneficiary_id, trust_account_id, description, rule_applied, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.journal_entry_id || null,
      allocationDate,
      data.category,
      classification,
      data.amount_cents,
      data.beneficiary_id || null,
      data.trust_account_id || null,
      data.description || null,
      ruleApplied,
      data.created_by || 'system',
    );

    const allocation = req.db.prepare('SELECT * FROM trust_income_allocations WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({
      ...allocation,
      classification_rule: ruleApplied,
      message: `Allocation recorded: ${data.category} → ${classification}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// FINANCIAL REPORTS
// ============================================================================

// GET /reports/balance-sheet
router.get('/reports/balance-sheet', (req, res) => {
  try {
    const asOfDate = req.query.as_of || new Date().toISOString().slice(0, 10);
    const bs = buildBalanceSheet(req.db, asOfDate);
    res.json(bs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /reports/income-statement
router.get('/reports/income-statement', (req, res) => {
  try {
    const year = req.query.year || new Date().getFullYear();
    const startDate = req.query.start_date || `${year}-01-01`;
    const endDate = req.query.end_date || `${year}-12-31`;
    const is = buildIncomeStatement(req.db, startDate, endDate);
    res.json(is);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /reports/k1-data
router.get('/reports/k1-data', (req, res) => {
  try {
    const year = req.query.year || new Date().getFullYear();
    const startDate = req.query.start_date || `${year}-01-01`;
    const endDate = req.query.end_date || `${year}-12-31`;
    const k1 = buildK1Data(req.db, startDate, endDate);
    res.json(k1);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /reports/dni
router.get('/reports/dni', (req, res) => {
  try {
    const year = req.query.year || new Date().getFullYear();
    const startDate = req.query.start_date || `${year}-01-01`;
    const endDate = req.query.end_date || `${year}-12-31`;
    const dni = calculateDNI(req.db, startDate, endDate);
    res.json(dni);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// DASHBOARD
// ============================================================================

// GET /dashboard
router.get('/dashboard', (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const yearStart = `${new Date().getFullYear()}-01-01`;

    // COA summary
    const coaSummary = req.db.prepare(`
      SELECT account_type, COUNT(*) AS count FROM trust_chart_of_accounts WHERE is_active = 1 GROUP BY account_type
    `).all();

    // Journal entry counts
    const jeCount = safeGet(req.db, 'SELECT COUNT(*) AS count FROM trust_journal_entries');
    const jeThisYear = safeGet(req.db, 'SELECT COUNT(*) AS count FROM trust_journal_entries WHERE entry_date >= ?', [yearStart]);

    // Open periods
    const openPeriods = safeQuery(req.db, "SELECT * FROM trust_accounting_periods WHERE status = 'open' ORDER BY start_date");

    // Trial balance check
    const tb = buildAccountingTrialBalance(req.db, today);

    // Income vs Principal this year
    const principalYTD = safeGet(req.db, "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM trust_income_allocations WHERE classification = 'principal' AND allocation_date >= ?", [yearStart]);
    const incomeYTD = safeGet(req.db, "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM trust_income_allocations WHERE classification = 'income' AND allocation_date >= ?", [yearStart]);

    // Recent journal entries
    const recentEntries = safeQuery(req.db, 'SELECT * FROM trust_journal_entries ORDER BY created_at DESC LIMIT 10');

    res.json({
      generated_at: new Date().toISOString(),
      trust_name: 'DeAndrea Lavar Barkley Trust',

      chart_of_accounts: {
        total: coaSummary.reduce((s, r) => s + r.count, 0),
        by_type: Object.fromEntries(coaSummary.map(r => [r.account_type, r.count])),
      },

      journal_entries: {
        total: jeCount.count || 0,
        this_year: jeThisYear.count || 0,
      },

      open_periods: openPeriods,

      trial_balance: {
        balanced: tb.balanced,
        total_debit_usd: tb.total_debit_usd,
        total_credit_usd: tb.total_credit_usd,
      },

      ytd_allocations: {
        principal_cents: principalYTD.total || 0,
        principal_usd: toDollars(principalYTD.total || 0),
        income_cents: incomeYTD.total || 0,
        income_usd: toDollars(incomeYTD.total || 0),
      },

      recent_entries: recentEntries,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
