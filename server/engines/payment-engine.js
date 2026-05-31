/**
 * Payment Processing Engine
 * DEANDREA LAVAR BARKLEY TRUST — Private Trust Payment Processing
 *
 * Core payment logic: validation, fee calculation, lifecycle management,
 * approval workflow, recurring scheduling, and ledger integration.
 */

'use strict';

// ─── Payment Status Lifecycle ─────────────────────────────────────────────────

const VALID_STATUSES = ['draft', 'pending_approval', 'approved', 'processing', 'completed', 'failed', 'cancelled', 'returned'];

const ALLOWED_TRANSITIONS = {
  draft:            ['pending_approval', 'cancelled'],
  pending_approval: ['approved', 'cancelled'],
  approved:         ['processing', 'cancelled'],
  processing:       ['completed', 'failed'],
  completed:        ['returned'],
  failed:           ['draft', 'cancelled'],
  cancelled:        [],
  returned:         ['draft'],
};

function canTransition(currentStatus, newStatus) {
  const allowed = ALLOWED_TRANSITIONS[currentStatus];
  return allowed ? allowed.includes(newStatus) : false;
}

// ─── Fee Calculation ──────────────────────────────────────────────────────────

const FEE_SCHEDULE = {
  ach:               { flat_cents: 0,    pct: 0 },
  wire:              { flat_cents: 2500, pct: 0 },         // $25 flat fee
  check:             { flat_cents: 500,  pct: 0 },         // $5 flat fee
  internal_transfer: { flat_cents: 0,    pct: 0 },
};

function calculateFee(amountCents, paymentMethod) {
  const schedule = FEE_SCHEDULE[paymentMethod] || FEE_SCHEDULE.ach;
  const pctFee = Math.round(amountCents * schedule.pct);
  return schedule.flat_cents + pctFee;
}

// ─── Payment Validation ──────────────────────────────────────────────────────

function validatePayout(data) {
  const errors = [];

  if (!data.payee_name || !data.payee_name.trim()) {
    errors.push('payee_name is required');
  }
  if (!data.amount_cents || data.amount_cents <= 0) {
    errors.push('amount_cents must be a positive integer');
  }
  if (data.amount_cents && !Number.isInteger(data.amount_cents)) {
    errors.push('amount_cents must be an integer (cents)');
  }

  const validPayoutTypes = ['distribution', 'trustee_fee', 'expense_reimbursement', 'loan', 'gift', 'tax_payment'];
  if (data.payout_type && !validPayoutTypes.includes(data.payout_type)) {
    errors.push(`Invalid payout_type. Must be one of: ${validPayoutTypes.join(', ')}`);
  }

  const validPayeeTypes = ['beneficiary', 'trustee', 'vendor', 'government', 'other'];
  if (data.payee_type && !validPayeeTypes.includes(data.payee_type)) {
    errors.push(`Invalid payee_type. Must be one of: ${validPayeeTypes.join(', ')}`);
  }

  const validMethods = ['ach', 'wire', 'check', 'internal_transfer'];
  if (data.payment_method && !validMethods.includes(data.payment_method)) {
    errors.push(`Invalid payment_method. Must be one of: ${validMethods.join(', ')}`);
  }

  if (data.bank_routing_number && !/^\d{9}$/.test(String(data.bank_routing_number))) {
    errors.push('bank_routing_number must be exactly 9 digits');
  }

  if (data.scheduled_date) {
    const d = new Date(data.scheduled_date);
    if (isNaN(d.getTime())) {
      errors.push('scheduled_date must be a valid date (YYYY-MM-DD)');
    }
  }

  const validPriorities = ['low', 'normal', 'high', 'urgent'];
  if (data.priority && !validPriorities.includes(data.priority)) {
    errors.push(`Invalid priority. Must be one of: ${validPriorities.join(', ')}`);
  }

  return errors;
}

function validateVendor(data) {
  const errors = [];

  if (!data.vendor_name || !data.vendor_name.trim()) {
    errors.push('vendor_name is required');
  }

  const validTypes = ['service', 'contractor', 'supplier', 'legal', 'accounting', 'financial', 'government', 'utility', 'other'];
  if (data.vendor_type && !validTypes.includes(data.vendor_type)) {
    errors.push(`Invalid vendor_type. Must be one of: ${validTypes.join(', ')}`);
  }

  const validTerms = ['due_on_receipt', 'net_15', 'net_30', 'net_45', 'net_60', 'net_90'];
  if (data.payment_terms && !validTerms.includes(data.payment_terms)) {
    errors.push(`Invalid payment_terms. Must be one of: ${validTerms.join(', ')}`);
  }

  if (data.tax_id && data.tax_id_type === 'ein' && !/^\d{2}-?\d{7}$/.test(data.tax_id)) {
    errors.push('EIN must be in format XX-XXXXXXX');
  }

  if (data.bank_routing_number && !/^\d{9}$/.test(String(data.bank_routing_number))) {
    errors.push('bank_routing_number must be exactly 9 digits');
  }

  return errors;
}

function validateBill(data) {
  const errors = [];

  if (!data.amount_cents || data.amount_cents <= 0) {
    errors.push('amount_cents must be a positive integer');
  }
  if (!data.due_date) {
    errors.push('due_date is required');
  }
  if (!data.received_date) {
    errors.push('received_date is required');
  }

  const validTypes = ['invoice', 'recurring_charge', 'tax_notice', 'legal_fee', 'management_fee', 'insurance_premium', 'utility', 'other'];
  if (data.bill_type && !validTypes.includes(data.bill_type)) {
    errors.push(`Invalid bill_type. Must be one of: ${validTypes.join(', ')}`);
  }

  return errors;
}

// ─── Approval Workflow ────────────────────────────────────────────────────────

const APPROVAL_THRESHOLDS = {
  auto_approve_below_cents: 100000,     // Auto-approve payouts under $1,000
  require_dual_above_cents: 10000000,   // Dual approval for payouts over $100,000
};

function determineApprovalRequirement(amountCents) {
  if (amountCents < APPROVAL_THRESHOLDS.auto_approve_below_cents) {
    return { auto_approve: true, approvals_required: 0 };
  }
  if (amountCents >= APPROVAL_THRESHOLDS.require_dual_above_cents) {
    return { auto_approve: false, approvals_required: 2 };
  }
  return { auto_approve: false, approvals_required: 1 };
}

// ─── Recurring Schedule Helpers ───────────────────────────────────────────────

function calculateNextPaymentDate(schedule) {
  const now = new Date();
  const today = now.toISOString().split('T')[0];

  if (schedule.end_date && schedule.end_date <= today) {
    return null; // schedule ended
  }
  if (schedule.max_payments && schedule.payment_count >= schedule.max_payments) {
    return null; // max payments reached
  }

  const lastDate = schedule.last_payment_date
    ? new Date(schedule.last_payment_date)
    : new Date(schedule.start_date);

  const next = new Date(lastDate);

  switch (schedule.frequency) {
    case 'weekly':
      next.setDate(next.getDate() + 7);
      break;
    case 'bi_weekly':
      next.setDate(next.getDate() + 14);
      break;
    case 'monthly':
      next.setMonth(next.getMonth() + 1);
      if (schedule.day_of_month) {
        next.setDate(Math.min(schedule.day_of_month, daysInMonth(next)));
      }
      break;
    case 'quarterly':
      next.setMonth(next.getMonth() + 3);
      if (schedule.day_of_month) {
        next.setDate(Math.min(schedule.day_of_month, daysInMonth(next)));
      }
      break;
    case 'semi_annual':
      next.setMonth(next.getMonth() + 6);
      if (schedule.day_of_month) {
        next.setDate(Math.min(schedule.day_of_month, daysInMonth(next)));
      }
      break;
    case 'annual':
      next.setFullYear(next.getFullYear() + 1);
      break;
    default:
      next.setMonth(next.getMonth() + 1);
  }

  // Don't schedule in the past
  if (next <= now && !schedule.last_payment_date) {
    return schedule.start_date;
  }

  const nextStr = next.toISOString().split('T')[0];

  if (schedule.end_date && nextStr > schedule.end_date) {
    return null;
  }

  return nextStr;
}

function daysInMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

// ─── Due Date Calculation ─────────────────────────────────────────────────────

const PAYMENT_TERM_DAYS = {
  due_on_receipt: 0,
  net_15: 15,
  net_30: 30,
  net_45: 45,
  net_60: 60,
  net_90: 90,
};

function calculateDueDate(receivedDate, paymentTerms) {
  const days = PAYMENT_TERM_DAYS[paymentTerms] || 30;
  const d = new Date(receivedDate);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

// ─── Bill Status Helpers ──────────────────────────────────────────────────────

function determineBillStatus(bill) {
  if (bill.status === 'cancelled' || bill.status === 'disputed') {
    return bill.status;
  }

  const today = new Date().toISOString().split('T')[0];

  if (bill.paid_cents >= bill.total_cents) {
    return 'paid';
  }
  if (bill.paid_cents > 0 && bill.paid_cents < bill.total_cents) {
    return 'partially_paid';
  }
  if (bill.scheduled_pay_date) {
    return 'scheduled';
  }
  if (bill.due_date < today && bill.status !== 'paid') {
    return 'overdue';
  }
  if (bill.approved_by) {
    return 'approved';
  }
  return 'received';
}

// ─── Ledger Entry Creation ────────────────────────────────────────────────────

function createLedgerEntry(db, entry) {
  const lastBalance = db.prepare(
    'SELECT balance_after_cents FROM payment_ledger ORDER BY id DESC LIMIT 1'
  ).get();

  const currentBalance = lastBalance ? lastBalance.balance_after_cents : 0;
  const newBalance = currentBalance - entry.debit_cents + entry.credit_cents;

  db.prepare(`
    INSERT INTO payment_ledger (entry_type, reference_type, reference_id, debit_cents, credit_cents, balance_after_cents, description, category, fiscal_year)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.entry_type,
    entry.reference_type || null,
    entry.reference_id || null,
    entry.debit_cents || 0,
    entry.credit_cents || 0,
    newBalance,
    entry.description,
    entry.category || null,
    entry.fiscal_year || new Date().getFullYear()
  );

  return newBalance;
}

// ─── Payment Summary ─────────────────────────────────────────────────────────

function getPaymentSummary(db) {
  const payoutStats = db.prepare(`
    SELECT
      COUNT(*) as total_count,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_count,
      SUM(CASE WHEN status = 'pending_approval' THEN 1 ELSE 0 END) as pending_count,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count,
      SUM(CASE WHEN status = 'completed' THEN net_amount_cents ELSE 0 END) as total_paid_cents,
      SUM(CASE WHEN status = 'pending_approval' THEN net_amount_cents ELSE 0 END) as pending_amount_cents,
      SUM(CASE WHEN status = 'completed' THEN fee_cents ELSE 0 END) as total_fees_cents
    FROM trust_payouts
  `).get();

  const billStats = db.prepare(`
    SELECT
      COUNT(*) as total_count,
      SUM(CASE WHEN status = 'overdue' THEN 1 ELSE 0 END) as overdue_count,
      SUM(CASE WHEN status IN ('received', 'approved') THEN 1 ELSE 0 END) as unpaid_count,
      SUM(balance_cents) as total_outstanding_cents,
      SUM(CASE WHEN status = 'overdue' THEN balance_cents ELSE 0 END) as overdue_amount_cents
    FROM bills
    WHERE status NOT IN ('paid', 'cancelled')
  `).get();

  const vendorStats = db.prepare(`
    SELECT COUNT(*) as total_vendors, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_vendors
    FROM vendors
  `).get();

  return {
    payouts: {
      total: payoutStats.total_count,
      completed: payoutStats.completed_count,
      pending_approval: payoutStats.pending_count,
      processing: payoutStats.processing_count,
      failed: payoutStats.failed_count,
      total_paid_cents: payoutStats.total_paid_cents,
      total_paid_usd: Math.round(payoutStats.total_paid_cents || 0) / 100,
      pending_amount_cents: payoutStats.pending_amount_cents,
      pending_amount_usd: Math.round(payoutStats.pending_amount_cents || 0) / 100,
      total_fees_cents: payoutStats.total_fees_cents,
      total_fees_usd: Math.round(payoutStats.total_fees_cents || 0) / 100,
    },
    bills: {
      total: billStats.total_count,
      overdue: billStats.overdue_count,
      unpaid: billStats.unpaid_count,
      outstanding_cents: billStats.total_outstanding_cents,
      outstanding_usd: Math.round(billStats.total_outstanding_cents || 0) / 100,
      overdue_cents: billStats.overdue_amount_cents,
      overdue_usd: Math.round(billStats.overdue_amount_cents || 0) / 100,
    },
    vendors: {
      total: vendorStats.total_vendors,
      active: vendorStats.active_vendors,
    },
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  VALID_STATUSES,
  ALLOWED_TRANSITIONS,
  canTransition,
  FEE_SCHEDULE,
  calculateFee,
  validatePayout,
  validateVendor,
  validateBill,
  APPROVAL_THRESHOLDS,
  determineApprovalRequirement,
  calculateNextPaymentDate,
  calculateDueDate,
  PAYMENT_TERM_DAYS,
  determineBillStatus,
  createLedgerEntry,
  getPaymentSummary,
};
