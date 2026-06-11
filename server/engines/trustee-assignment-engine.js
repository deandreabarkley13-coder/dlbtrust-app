/**
 * Trustee Assignment & Beneficiary Expense Management Engine
 * DEANDREA LAVAR BARKLEY TRUST — Fiduciary Account Governance
 *
 * Allows the primary trustee to:
 *   - Assign trustees/beneficiaries to specific trust accounts
 *   - Set per-assignment spending limits and permissions
 *   - Manage expense budgets by category
 *   - Approve/reject beneficiary expense requests
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// --- Schema Initialization --------------------------------------------------

function initAssignmentSchema(db) {
  const schemaFile = path.join(__dirname, '..', 'db', 'migrations', 'trustee-assignment-schema.sql');
  const sql = fs.readFileSync(schemaFile, 'utf8');
  try { db.exec(sql); } catch (_) { /* tables already exist */ }
}

// --- Constants --------------------------------------------------------------

const VALID_ROLES = ['primary_trustee', 'co_trustee', 'successor_trustee', 'beneficiary', 'expense_manager'];

const VALID_PERMISSIONS = [
  'view_balance',
  'view_transactions',
  'request_expense',
  'approve_expense',
  'manage_distributions',
  'manage_assignments',
  'full_control',
];

const EXPENSE_CATEGORIES = [
  'housing', 'medical', 'education', 'transportation', 'living',
  'legal', 'insurance', 'maintenance', 'general', 'discretionary',
];

const ROLE_DEFAULT_PERMISSIONS = {
  primary_trustee:    ['full_control'],
  co_trustee:         ['view_balance', 'view_transactions', 'approve_expense', 'manage_distributions'],
  successor_trustee:  ['view_balance', 'view_transactions'],
  beneficiary:        ['view_balance', 'request_expense'],
  expense_manager:    ['view_balance', 'view_transactions', 'request_expense', 'approve_expense'],
};

// --- Helpers ----------------------------------------------------------------

function generateRequestNumber() {
  const d = new Date();
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
  const seq = String(Math.floor(Math.random() * 9999)).padStart(4, '0');
  return `EXP-${ymd}-${seq}`;
}

function auditLog(db, eventType, entityType, entityId, actor, details) {
  try {
    db.prepare(`
      INSERT INTO assignment_audit_log (event_type, entity_type, entity_id, actor, details)
      VALUES (?, ?, ?, ?, ?)
    `).run(eventType, entityType, entityId, actor, JSON.stringify(details));
  } catch (_) { /* non-critical */ }
}

function toDollars(cents) {
  return (cents / 100).toFixed(2);
}

// --- Assignment CRUD --------------------------------------------------------

function createAssignment(db, {
  contact_id,
  account_id,
  role,
  permissions,
  spending_limit_cents,
  monthly_limit_cents,
  allowed_categories,
  requires_approval = 1,
  approval_threshold_cents,
  assigned_by = 'primary_trustee',
  effective_date,
  expiry_date,
  notes,
}) {
  if (!VALID_ROLES.includes(role)) {
    throw new Error(`Invalid role: ${role}. Valid: ${VALID_ROLES.join(', ')}`);
  }

  // Verify contact exists
  const contact = db.prepare('SELECT id, contact_type, display_name FROM crm_contacts WHERE id = ?').get(contact_id);
  if (!contact) throw new Error(`Contact ${contact_id} not found`);

  // Verify account exists
  const account = db.prepare('SELECT id, account_name, account_number FROM trust_accounts WHERE id = ?').get(account_id);
  if (!account) throw new Error(`Account ${account_id} not found`);

  // Check for existing active assignment
  const existing = db.prepare(`
    SELECT id FROM trustee_assignments WHERE contact_id = ? AND account_id = ? AND role = ? AND status = 'active'
  `).get(contact_id, account_id, role);
  if (existing) throw new Error(`Active assignment already exists (ID ${existing.id})`);

  const perms = permissions || ROLE_DEFAULT_PERMISSIONS[role] || ['view_balance'];
  const cats = allowed_categories ? JSON.stringify(allowed_categories) : null;

  const result = db.prepare(`
    INSERT INTO trustee_assignments (
      contact_id, account_id, role, permissions, spending_limit_cents, monthly_limit_cents,
      allowed_categories, requires_approval, approval_threshold_cents, assigned_by,
      effective_date, expiry_date, notes, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(
    contact_id, account_id, role, JSON.stringify(perms),
    spending_limit_cents || null, monthly_limit_cents || null,
    cats, requires_approval ? 1 : 0, approval_threshold_cents || null,
    assigned_by, effective_date || new Date().toISOString().slice(0, 10),
    expiry_date || null, notes || null,
  );

  const assignment = db.prepare('SELECT * FROM trustee_assignments WHERE id = ?').get(result.lastInsertRowid);

  // Also create/update CRM relationship
  const relType = role.includes('trustee') ? 'trustee_of' : (role === 'beneficiary' ? 'beneficiary_of' : 'advisor_to');
  try {
    const existingRel = db.prepare(
      "SELECT id FROM crm_relationships WHERE contact_id = ? AND account_id = ? AND relationship_type = ?"
    ).get(contact_id, account_id, relType);
    if (!existingRel) {
      db.prepare(`
        INSERT INTO crm_relationships (contact_id, account_id, relationship_type, role_detail, authorized_actions, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(contact_id, account_id, relType, role, JSON.stringify(perms));
    }
  } catch (_) { /* CRM table may not exist */ }

  auditLog(db, 'assigned', 'assignment', assignment.id, assigned_by, {
    contact: contact.display_name,
    account: account.account_name,
    role,
    permissions: perms,
  });

  return {
    ...assignment,
    contact_name: contact.display_name,
    account_name: account.account_name,
    permissions: perms,
  };
}

function revokeAssignment(db, assignmentId, actor, reason) {
  const assignment = db.prepare('SELECT * FROM trustee_assignments WHERE id = ?').get(assignmentId);
  if (!assignment) throw new Error('Assignment not found');
  if (assignment.status !== 'active') throw new Error(`Cannot revoke — status is '${assignment.status}'`);

  db.prepare(`
    UPDATE trustee_assignments SET status = 'revoked', notes = COALESCE(notes || ' | ', '') || ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(`Revoked by ${actor}: ${reason || 'no reason given'}`, assignmentId);

  auditLog(db, 'revoked', 'assignment', assignmentId, actor, { reason });
  return db.prepare('SELECT * FROM trustee_assignments WHERE id = ?').get(assignmentId);
}

function updateAssignment(db, assignmentId, updates, actor) {
  const assignment = db.prepare('SELECT * FROM trustee_assignments WHERE id = ?').get(assignmentId);
  if (!assignment) throw new Error('Assignment not found');

  const fields = [];
  const values = [];

  if (updates.permissions) {
    fields.push('permissions = ?');
    values.push(JSON.stringify(updates.permissions));
  }
  if (updates.spending_limit_cents !== undefined) {
    fields.push('spending_limit_cents = ?');
    values.push(updates.spending_limit_cents);
  }
  if (updates.monthly_limit_cents !== undefined) {
    fields.push('monthly_limit_cents = ?');
    values.push(updates.monthly_limit_cents);
  }
  if (updates.allowed_categories) {
    fields.push('allowed_categories = ?');
    values.push(JSON.stringify(updates.allowed_categories));
  }
  if (updates.requires_approval !== undefined) {
    fields.push('requires_approval = ?');
    values.push(updates.requires_approval ? 1 : 0);
  }
  if (updates.approval_threshold_cents !== undefined) {
    fields.push('approval_threshold_cents = ?');
    values.push(updates.approval_threshold_cents);
  }
  if (updates.status) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) throw new Error('No fields to update');

  fields.push("updated_at = datetime('now')");
  values.push(assignmentId);

  db.prepare(`UPDATE trustee_assignments SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  auditLog(db, 'limit_changed', 'assignment', assignmentId, actor, updates);
  return db.prepare('SELECT * FROM trustee_assignments WHERE id = ?').get(assignmentId);
}

// --- Expense Requests -------------------------------------------------------

function submitExpense(db, {
  assignment_id,
  amount_cents,
  category = 'general',
  subcategory,
  payee_name,
  payee_account,
  description,
  receipt_path,
  payment_method = 'ach',
  priority = 'normal',
}) {
  const assignment = db.prepare(`
    SELECT ta.*, cc.display_name as contact_name, ta2.account_name, ta2.balance_cents
    FROM trustee_assignments ta
    JOIN crm_contacts cc ON cc.id = ta.contact_id
    JOIN trust_accounts ta2 ON ta2.id = ta.account_id
    WHERE ta.id = ? AND ta.status = 'active'
  `).get(assignment_id);

  if (!assignment) throw new Error('Assignment not found or not active');

  const perms = JSON.parse(assignment.permissions || '[]');
  if (!perms.includes('request_expense') && !perms.includes('full_control')) {
    throw new Error('No permission to request expenses on this account');
  }

  // Check spending limit
  if (assignment.spending_limit_cents && amount_cents > assignment.spending_limit_cents) {
    throw new Error(`Amount $${toDollars(amount_cents)} exceeds per-transaction limit of $${toDollars(assignment.spending_limit_cents)}`);
  }

  // Check monthly limit
  if (assignment.monthly_limit_cents) {
    const monthStart = new Date().toISOString().slice(0, 7) + '-01';
    const monthSpent = db.prepare(`
      SELECT COALESCE(SUM(amount_cents), 0) as total
      FROM expense_requests
      WHERE assignment_id = ? AND status IN ('approved', 'processing', 'paid')
      AND submitted_at >= ?
    `).get(assignment_id, monthStart);

    if ((monthSpent.total + amount_cents) > assignment.monthly_limit_cents) {
      throw new Error(`Monthly limit exceeded: spent $${toDollars(monthSpent.total)}, requesting $${toDollars(amount_cents)}, limit $${toDollars(assignment.monthly_limit_cents)}`);
    }
  }

  // Check allowed categories
  if (assignment.allowed_categories) {
    const allowed = JSON.parse(assignment.allowed_categories);
    if (allowed.length > 0 && !allowed.includes(category)) {
      throw new Error(`Category '${category}' not allowed. Permitted: ${allowed.join(', ')}`);
    }
  }

  // Check budget
  const monthStart = new Date().toISOString().slice(0, 7) + '-01';
  const budget = db.prepare(`
    SELECT * FROM expense_budgets
    WHERE account_id = ? AND category = ? AND period_start <= ? AND period_end >= ? AND status = 'active'
  `).get(assignment.account_id, category, monthStart, monthStart);

  let budgetWarning = null;
  if (budget) {
    const newSpent = budget.spent_cents + amount_cents;
    if (newSpent > budget.budget_cents) {
      budgetWarning = `Budget exceeded: ${category} budget $${toDollars(budget.budget_cents)}, current $${toDollars(budget.spent_cents)}, requesting $${toDollars(amount_cents)}`;
    } else if (budget.alert_threshold_pct && (newSpent / budget.budget_cents * 100) >= budget.alert_threshold_pct) {
      budgetWarning = `Budget alert: ${category} at ${Math.round(newSpent / budget.budget_cents * 100)}% of $${toDollars(budget.budget_cents)}`;
    }
  }

  // Determine if auto-approve
  let status = 'pending';
  let approvedBy = null;
  let approvedAt = null;

  if (!assignment.requires_approval) {
    status = 'approved';
    approvedBy = 'auto';
    approvedAt = new Date().toISOString();
  } else if (assignment.approval_threshold_cents && amount_cents < assignment.approval_threshold_cents) {
    status = 'approved';
    approvedBy = 'auto_threshold';
    approvedAt = new Date().toISOString();
  }

  const requestNumber = generateRequestNumber();

  const result = db.prepare(`
    INSERT INTO expense_requests (
      request_number, assignment_id, account_id, requested_by_id, amount_cents,
      category, subcategory, payee_name, payee_account, description, receipt_path,
      payment_method, status, priority, approved_by, approved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    requestNumber, assignment_id, assignment.account_id, assignment.contact_id,
    amount_cents, category, subcategory || null, payee_name || null,
    payee_account ? JSON.stringify(payee_account) : null,
    description, receipt_path || null, payment_method, status, priority,
    approvedBy, approvedAt,
  );

  const expense = db.prepare('SELECT * FROM expense_requests WHERE id = ?').get(result.lastInsertRowid);

  auditLog(db, 'expense_submitted', 'expense', expense.id, assignment.contact_name, {
    amount: toDollars(amount_cents),
    category,
    status,
    account: assignment.account_name,
  });

  return {
    ...expense,
    contact_name: assignment.contact_name,
    account_name: assignment.account_name,
    budget_warning: budgetWarning,
    auto_approved: status === 'approved',
  };
}

function approveExpense(db, expenseId, actor, notes) {
  const expense = db.prepare(`
    SELECT er.*, ta.account_name, ta.balance_cents
    FROM expense_requests er
    JOIN trust_accounts ta ON ta.id = er.account_id
    WHERE er.id = ?
  `).get(expenseId);

  if (!expense) throw new Error('Expense request not found');
  if (expense.status !== 'pending') throw new Error(`Cannot approve — status is '${expense.status}'`);

  // Verify account has sufficient funds
  if (expense.amount_cents > expense.balance_cents) {
    throw new Error(`Insufficient funds: need $${toDollars(expense.amount_cents)}, available $${toDollars(expense.balance_cents)}`);
  }

  db.prepare(`
    UPDATE expense_requests SET status = 'approved', approved_by = ?, approved_at = datetime('now'),
    updated_at = datetime('now') WHERE id = ?
  `).run(actor, expenseId);

  // Update budget spent
  const monthStart = new Date().toISOString().slice(0, 7) + '-01';
  db.prepare(`
    UPDATE expense_budgets SET spent_cents = spent_cents + ?, updated_at = datetime('now')
    WHERE account_id = ? AND category = ? AND period_start <= ? AND period_end >= ? AND status = 'active'
  `).run(expense.amount_cents, expense.account_id, expense.category, monthStart, monthStart);

  auditLog(db, 'expense_approved', 'expense', expenseId, actor, {
    amount: toDollars(expense.amount_cents),
    notes,
  });

  return db.prepare('SELECT * FROM expense_requests WHERE id = ?').get(expenseId);
}

function rejectExpense(db, expenseId, actor, reason) {
  const expense = db.prepare('SELECT * FROM expense_requests WHERE id = ?').get(expenseId);
  if (!expense) throw new Error('Expense request not found');
  if (expense.status !== 'pending') throw new Error(`Cannot reject — status is '${expense.status}'`);

  db.prepare(`
    UPDATE expense_requests SET status = 'rejected', approved_by = ?, rejection_reason = ?,
    updated_at = datetime('now') WHERE id = ?
  `).run(actor, reason || 'Rejected by trustee', expenseId);

  auditLog(db, 'expense_rejected', 'expense', expenseId, actor, { reason });
  return db.prepare('SELECT * FROM expense_requests WHERE id = ?').get(expenseId);
}

function markExpensePaid(db, expenseId, transferId) {
  db.prepare(`
    UPDATE expense_requests SET status = 'paid', transfer_id = ?, paid_at = datetime('now'),
    updated_at = datetime('now') WHERE id = ?
  `).run(transferId, expenseId);
  auditLog(db, 'expense_paid', 'expense', expenseId, 'system', { transfer_id: transferId });
  return db.prepare('SELECT * FROM expense_requests WHERE id = ?').get(expenseId);
}

// --- Budget Management ------------------------------------------------------

function setBudget(db, { account_id, category, budget_period, budget_cents, alert_threshold_pct, created_by }) {
  if (!EXPENSE_CATEGORIES.includes(category)) {
    throw new Error(`Invalid category: ${category}. Valid: ${EXPENSE_CATEGORIES.join(', ')}`);
  }

  const now = new Date();
  let periodStart, periodEnd;

  if (budget_period === 'monthly') {
    periodStart = now.toISOString().slice(0, 7) + '-01';
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    periodEnd = nextMonth.toISOString().slice(0, 10);
  } else if (budget_period === 'quarterly') {
    const q = Math.floor(now.getMonth() / 3);
    periodStart = new Date(now.getFullYear(), q * 3, 1).toISOString().slice(0, 10);
    periodEnd = new Date(now.getFullYear(), (q + 1) * 3, 0).toISOString().slice(0, 10);
  } else {
    periodStart = now.getFullYear() + '-01-01';
    periodEnd = now.getFullYear() + '-12-31';
  }

  // Upsert
  const existing = db.prepare(`
    SELECT id FROM expense_budgets WHERE account_id = ? AND category = ? AND period_start = ?
  `).get(account_id, category, periodStart);

  if (existing) {
    db.prepare(`
      UPDATE expense_budgets SET budget_cents = ?, alert_threshold_pct = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(budget_cents, alert_threshold_pct || 80, existing.id);
    auditLog(db, 'budget_set', 'budget', existing.id, created_by || 'primary_trustee', { category, budget_cents, updated: true });
    return db.prepare('SELECT * FROM expense_budgets WHERE id = ?').get(existing.id);
  }

  const result = db.prepare(`
    INSERT INTO expense_budgets (account_id, category, budget_period, budget_cents, period_start, period_end, alert_threshold_pct, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(account_id, category, budget_period || 'monthly', budget_cents, periodStart, periodEnd, alert_threshold_pct || 80, created_by || 'primary_trustee');

  auditLog(db, 'budget_set', 'budget', result.lastInsertRowid, created_by || 'primary_trustee', { category, budget_cents });
  return db.prepare('SELECT * FROM expense_budgets WHERE id = ?').get(result.lastInsertRowid);
}

// --- Query Helpers ----------------------------------------------------------

function getAccountAssignments(db, accountId) {
  return db.prepare(`
    SELECT ta.*, cc.display_name as contact_name, cc.contact_type, cc.email,
           cc.trustee_role, cc.beneficiary_class
    FROM trustee_assignments ta
    JOIN crm_contacts cc ON cc.id = ta.contact_id
    WHERE ta.account_id = ? AND ta.status = 'active'
    ORDER BY
      CASE ta.role
        WHEN 'primary_trustee' THEN 1
        WHEN 'co_trustee' THEN 2
        WHEN 'successor_trustee' THEN 3
        WHEN 'expense_manager' THEN 4
        WHEN 'beneficiary' THEN 5
      END
  `).all(accountId);
}

function getContactAssignments(db, contactId) {
  return db.prepare(`
    SELECT ta.*, acct.account_name, acct.account_number, acct.account_type,
           acct.balance_cents, acct.status as account_status
    FROM trustee_assignments ta
    JOIN trust_accounts acct ON acct.id = ta.account_id
    WHERE ta.contact_id = ? AND ta.status = 'active'
  `).all(contactId);
}

function getPendingExpenses(db, accountId) {
  return db.prepare(`
    SELECT er.*, cc.display_name as requester_name
    FROM expense_requests er
    JOIN crm_contacts cc ON cc.id = er.requested_by_id
    WHERE er.account_id = ? AND er.status = 'pending'
    ORDER BY er.priority DESC, er.submitted_at ASC
  `).all(accountId);
}

function getExpenseHistory(db, filters = {}) {
  let where = '1=1';
  const params = [];

  if (filters.account_id) { where += ' AND er.account_id = ?'; params.push(filters.account_id); }
  if (filters.contact_id) { where += ' AND er.requested_by_id = ?'; params.push(filters.contact_id); }
  if (filters.status) { where += ' AND er.status = ?'; params.push(filters.status); }
  if (filters.category) { where += ' AND er.category = ?'; params.push(filters.category); }

  return db.prepare(`
    SELECT er.*, cc.display_name as requester_name, acct.account_name
    FROM expense_requests er
    JOIN crm_contacts cc ON cc.id = er.requested_by_id
    JOIN trust_accounts acct ON acct.id = er.account_id
    WHERE ${where}
    ORDER BY er.submitted_at DESC
    LIMIT ?
  `).all(...params, filters.limit || 50);
}

function getAccountBudgets(db, accountId) {
  return db.prepare(`
    SELECT * FROM expense_budgets WHERE account_id = ? AND status = 'active' ORDER BY category
  `).all(accountId);
}

function getDashboardSummary(db) {
  const totalAssignments = db.prepare("SELECT COUNT(*) as count FROM trustee_assignments WHERE status = 'active'").get();
  const trusteeCount = db.prepare("SELECT COUNT(*) as count FROM trustee_assignments WHERE status = 'active' AND role LIKE '%trustee%'").get();
  const beneficiaryCount = db.prepare("SELECT COUNT(*) as count FROM trustee_assignments WHERE status = 'active' AND role = 'beneficiary'").get();
  const pendingExpenses = db.prepare("SELECT COUNT(*) as count FROM expense_requests WHERE status = 'pending'").get();
  const monthStart = new Date().toISOString().slice(0, 7) + '-01';
  const monthlySpend = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) as total FROM expense_requests
    WHERE status IN ('approved', 'paid') AND submitted_at >= ?
  `).get(monthStart);

  return {
    total_assignments: totalAssignments.count,
    trustee_assignments: trusteeCount.count,
    beneficiary_assignments: beneficiaryCount.count,
    pending_expenses: pendingExpenses.count,
    monthly_spend_cents: monthlySpend.total,
    monthly_spend: toDollars(monthlySpend.total),
  };
}

module.exports = {
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
};
