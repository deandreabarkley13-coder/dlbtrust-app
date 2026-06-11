/**
 * Trustee Assignment & Beneficiary Expense Management Routes
 * DEANDREA LAVAR BARKLEY TRUST — Fiduciary Account Governance
 *
 * Endpoints:
 *   -- Assignments --
 *   GET    /api/trustee-assignments                - List all assignments (filterable)
 *   POST   /api/trustee-assignments                - Create assignment (primary trustee only)
 *   GET    /api/trustee-assignments/:id            - Get assignment detail
 *   PUT    /api/trustee-assignments/:id            - Update assignment limits/permissions
 *   POST   /api/trustee-assignments/:id/revoke     - Revoke assignment
 *   GET    /api/trustee-assignments/account/:id    - All assignments for an account
 *   GET    /api/trustee-assignments/contact/:id    - All assignments for a contact
 *   -- Expenses --
 *   GET    /api/trustee-assignments/expenses        - List expense requests (filterable)
 *   POST   /api/trustee-assignments/expenses        - Submit expense request
 *   GET    /api/trustee-assignments/expenses/:id    - Expense detail
 *   POST   /api/trustee-assignments/expenses/:id/approve  - Approve expense
 *   POST   /api/trustee-assignments/expenses/:id/reject   - Reject expense
 *   POST   /api/trustee-assignments/expenses/:id/pay      - Mark expense paid
 *   GET    /api/trustee-assignments/expenses/pending       - Pending expenses
 *   -- Budgets --
 *   GET    /api/trustee-assignments/budgets/:accountId     - Get budgets for account
 *   POST   /api/trustee-assignments/budgets                - Set/update budget
 *   -- Dashboard --
 *   GET    /api/trustee-assignments/dashboard               - Summary dashboard
 */

'use strict';

const express = require('express');
const router  = express.Router();
const path    = require('path');
const Database = require('better-sqlite3');

const {
  initAssignmentSchema,
  createAssignment,
  revokeAssignment,
  updateAssignment,
  submitExpense,
  approveExpense,
  rejectExpense,
  markExpensePaid,
  setBudget,
  getAccountAssignments,
  getContactAssignments,
  getPendingExpenses,
  getExpenseHistory,
  getAccountBudgets,
  getDashboardSummary,
  VALID_ROLES,
  VALID_PERMISSIONS,
  EXPENSE_CATEGORIES,
} = require('../engines/trustee-assignment-engine');

// --- DB Setup ---------------------------------------------------------------

function getDb() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'dlbtrust.db');
  return new Database(dbPath);
}

// DB middleware
router.use((req, _res, next) => {
  req.db = getDb();
  initAssignmentSchema(req.db);
  next();
});

// Cleanup
router.use((_req, res, next) => {
  res.on('finish', () => { try { _req.db.close(); } catch (_) {} });
  next();
});

// ── Dashboard ───────────────────────────────────────────────────────────────

router.get('/dashboard', (req, res) => {
  try {
    const summary = getDashboardSummary(req.db);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Pending Expenses (must be before /expenses/:id) ─────────────────────────

router.get('/expenses/pending', (req, res) => {
  try {
    const accountId = req.query.account_id;
    if (accountId) {
      return res.json(getPendingExpenses(req.db, parseInt(accountId)));
    }
    // All pending across all accounts
    const pending = req.db.prepare(`
      SELECT er.*, cc.display_name as requester_name, acct.account_name
      FROM expense_requests er
      JOIN crm_contacts cc ON cc.id = er.requested_by_id
      JOIN trust_accounts acct ON acct.id = er.account_id
      WHERE er.status = 'pending'
      ORDER BY er.priority DESC, er.submitted_at ASC
    `).all();
    res.json(pending);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Expense CRUD ────────────────────────────────────────────────────────────

router.get('/expenses', (req, res) => {
  try {
    const filters = {
      account_id: req.query.account_id ? parseInt(req.query.account_id) : null,
      contact_id: req.query.contact_id ? parseInt(req.query.contact_id) : null,
      status: req.query.status || null,
      category: req.query.category || null,
      limit: req.query.limit ? parseInt(req.query.limit) : 50,
    };
    res.json(getExpenseHistory(req.db, filters));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/expenses', (req, res) => {
  try {
    const expense = submitExpense(req.db, req.body);
    res.status(201).json(expense);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/expenses/:id', (req, res) => {
  try {
    const expense = req.db.prepare(`
      SELECT er.*, cc.display_name as requester_name, acct.account_name,
             ta.role, ta.spending_limit_cents, ta.monthly_limit_cents
      FROM expense_requests er
      JOIN crm_contacts cc ON cc.id = er.requested_by_id
      JOIN trust_accounts acct ON acct.id = er.account_id
      LEFT JOIN trustee_assignments ta ON ta.id = er.assignment_id
      WHERE er.id = ?
    `).get(req.params.id);
    if (!expense) return res.status(404).json({ error: 'Expense not found' });
    res.json(expense);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/expenses/:id/approve', (req, res) => {
  try {
    const expense = approveExpense(req.db, parseInt(req.params.id), req.body.actor || 'primary_trustee', req.body.notes);
    res.json({ ...expense, message: 'Expense approved' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/expenses/:id/reject', (req, res) => {
  try {
    const expense = rejectExpense(req.db, parseInt(req.params.id), req.body.actor || 'primary_trustee', req.body.reason);
    res.json({ ...expense, message: 'Expense rejected' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/expenses/:id/pay', (req, res) => {
  try {
    const expense = markExpensePaid(req.db, parseInt(req.params.id), req.body.transfer_id);
    res.json({ ...expense, message: 'Expense marked as paid' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Budgets ─────────────────────────────────────────────────────────────────

router.get('/budgets/:accountId', (req, res) => {
  try {
    res.json(getAccountBudgets(req.db, parseInt(req.params.accountId)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/budgets', (req, res) => {
  try {
    const budget = setBudget(req.db, req.body);
    res.status(201).json(budget);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Assignment CRUD ─────────────────────────────────────────────────────────

// By account
router.get('/account/:id', (req, res) => {
  try {
    res.json(getAccountAssignments(req.db, parseInt(req.params.id)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// By contact
router.get('/contact/:id', (req, res) => {
  try {
    res.json(getContactAssignments(req.db, parseInt(req.params.id)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all (with filters)
router.get('/', (req, res) => {
  try {
    let where = '1=1';
    const params = [];

    if (req.query.role) { where += ' AND ta.role = ?'; params.push(req.query.role); }
    if (req.query.status) { where += ' AND ta.status = ?'; params.push(req.query.status); }
    if (req.query.account_id) { where += ' AND ta.account_id = ?'; params.push(parseInt(req.query.account_id)); }

    const assignments = req.db.prepare(`
      SELECT ta.*, cc.display_name as contact_name, cc.contact_type, cc.email,
             acct.account_name, acct.account_number, acct.account_type, acct.balance_cents
      FROM trustee_assignments ta
      JOIN crm_contacts cc ON cc.id = ta.contact_id
      JOIN trust_accounts acct ON acct.id = ta.account_id
      WHERE ${where}
      ORDER BY ta.created_at DESC
    `).all(...params);

    res.json({
      assignments,
      meta: {
        valid_roles: VALID_ROLES,
        valid_permissions: VALID_PERMISSIONS,
        expense_categories: EXPENSE_CATEGORIES,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create
router.post('/', (req, res) => {
  try {
    const assignment = createAssignment(req.db, req.body);
    res.status(201).json({ ...assignment, message: `${assignment.role} assigned to account ${assignment.account_name}` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Detail
router.get('/:id', (req, res) => {
  try {
    const assignment = req.db.prepare(`
      SELECT ta.*, cc.display_name as contact_name, cc.contact_type, cc.email,
             acct.account_name, acct.account_number, acct.balance_cents
      FROM trustee_assignments ta
      JOIN crm_contacts cc ON cc.id = ta.contact_id
      JOIN trust_accounts acct ON acct.id = ta.account_id
      WHERE ta.id = ?
    `).get(req.params.id);
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

    // Include expenses for this assignment
    const expenses = req.db.prepare(`
      SELECT * FROM expense_requests WHERE assignment_id = ? ORDER BY submitted_at DESC LIMIT 20
    `).all(req.params.id);

    res.json({ ...assignment, recent_expenses: expenses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update
router.put('/:id', (req, res) => {
  try {
    const assignment = updateAssignment(req.db, parseInt(req.params.id), req.body, req.body.actor || 'primary_trustee');
    res.json({ ...assignment, message: 'Assignment updated' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Revoke
router.post('/:id/revoke', (req, res) => {
  try {
    const assignment = revokeAssignment(req.db, parseInt(req.params.id), req.body.actor || 'primary_trustee', req.body.reason);
    res.json({ ...assignment, message: 'Assignment revoked' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
