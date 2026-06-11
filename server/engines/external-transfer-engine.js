/**
 * External Transfer Engine
 * DEANDREA LAVAR BARKLEY TRUST — Outbound Payment Processing
 *
 * Handles validation, fee calculation, approval tiers, and lifecycle
 * management for payments to external vendors, beneficiaries, and expenses.
 */

'use strict';

// --- Fee Schedule -----------------------------------------------------------

const FEES = {
  ach:   0,        // free
  wire:  2500,     // $25.00
  check: 500,      // $5.00
  zelle: 0,        // free
};

// --- Approval Tiers ---------------------------------------------------------
// auto:   < $1,000    (auto-approve)
// single: $1,000–$50,000
// dual:   > $50,000   (requires two approvals)

const APPROVAL_THRESHOLDS = {
  auto:   100000,   // 1,000.00 in cents
  dual:   5000000,  // 50,000.00 in cents
};

// --- ETA by method ----------------------------------------------------------

const ETA_DAYS = {
  ach:   { normal: 3, high: 2, urgent: 1 },
  wire:  { normal: 1, high: 1, urgent: 0 },
  check: { normal: 7, high: 5, urgent: 3 },
  zelle: { normal: 0, high: 0, urgent: 0 },
};

// --- Transfer Number Generator -----------------------------------------------

function generateTransferNumber() {
  const d = new Date();
  const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `EXT-${dateStr}-${rand}`;
}

// --- Validation --------------------------------------------------------------

function validateExternalTransfer(body) {
  const errors = [];
  if (!body.from_account_id) errors.push('from_account_id is required');
  if (!body.contact_id) errors.push('contact_id is required');
  if (!body.amount_cents && !body.amount) errors.push('amount is required');

  const amount = body.amount_cents || (body.amount ? Math.round(parseFloat(body.amount) * 100) : 0);
  if (amount <= 0) errors.push('amount must be positive');
  if (amount > 100000000) errors.push('amount exceeds single-transfer maximum ($1,000,000)');

  const validTypes = ['vendor_payment', 'beneficiary_distribution', 'expense', 'bill_payment', 'tax_payment', 'trustee_fee'];
  if (body.payment_type && !validTypes.includes(body.payment_type)) {
    errors.push(`payment_type must be one of: ${validTypes.join(', ')}`);
  }

  const validMethods = ['ach', 'wire', 'check', 'zelle'];
  if (body.payment_method && !validMethods.includes(body.payment_method)) {
    errors.push(`payment_method must be one of: ${validMethods.join(', ')}`);
  }

  const validPriorities = ['low', 'normal', 'high', 'urgent'];
  if (body.priority && !validPriorities.includes(body.priority)) {
    errors.push(`priority must be one of: ${validPriorities.join(', ')}`);
  }

  return errors;
}

// --- Fee Calculation ---------------------------------------------------------

function calculateFee(paymentMethod) {
  return FEES[paymentMethod] || 0;
}

// --- Approval Tier -----------------------------------------------------------

function determineApprovalTier(amountCents) {
  if (amountCents < APPROVAL_THRESHOLDS.auto) return 'auto';
  if (amountCents >= APPROVAL_THRESHOLDS.dual) return 'dual';
  return 'single';
}

// --- ETA Calculation ---------------------------------------------------------

function calculateETA(paymentMethod, priority) {
  const days = ETA_DAYS[paymentMethod]?.[priority] ?? ETA_DAYS[paymentMethod]?.normal ?? 3;
  const eta = new Date();
  eta.setDate(eta.getDate() + days);
  return eta.toISOString().slice(0, 10);
}

// --- Status Transitions ------------------------------------------------------

const VALID_TRANSITIONS = {
  draft:            ['pending_approval', 'approved', 'cancelled'],
  pending_approval: ['approved', 'cancelled'],
  approved:         ['processing', 'sent', 'cancelled'],
  processing:       ['sent', 'completed', 'failed', 'returned', 'cancelled'],
  sent:             ['completed', 'returned', 'failed'],
  completed:        [],
  failed:           ['draft'],   // can retry
  returned:         ['draft'],   // can retry
  cancelled:        [],
};

function canTransition(from, to) {
  return (VALID_TRANSITIONS[from] || []).includes(to);
}

// --- Audit Entry Builder -----------------------------------------------------

function buildAuditEntry(eventType, transferId, action, actor, details) {
  return {
    event_type:  eventType,
    entity_type: 'external_transfer',
    entity_id:   String(transferId),
    actor:       actor || 'system',
    action:      action,
    details:     typeof details === 'string' ? details : JSON.stringify(details),
  };
}

// --- Dollars/Cents -----------------------------------------------------------

function toDollars(cents) { return (cents / 100).toFixed(2); }

module.exports = {
  FEES,
  APPROVAL_THRESHOLDS,
  generateTransferNumber,
  validateExternalTransfer,
  calculateFee,
  determineApprovalTier,
  calculateETA,
  canTransition,
  buildAuditEntry,
  toDollars,
};
