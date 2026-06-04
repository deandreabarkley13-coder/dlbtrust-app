/**
 * Core Banking Engine
 * DEANDREA LAVAR BARKLEY TRUST -- Private Wealth Management Platform
 *
 * Account lifecycle, interest calculation, transfer validation,
 * reconciliation, KYC/AML, and audit trail management.
 */

'use strict';

// --- Account Lifecycle -----------------------------------------------------

const VALID_ACCOUNT_STATUSES = ['pending', 'active', 'frozen', 'dormant', 'closed'];

const ALLOWED_ACCOUNT_TRANSITIONS = {
  pending:  ['active', 'closed'],
  active:   ['frozen', 'dormant', 'closed'],
  frozen:   ['active', 'closed'],
  dormant:  ['active', 'closed'],
  closed:   [],
};

function canTransitionAccount(currentStatus, newStatus) {
  const allowed = ALLOWED_ACCOUNT_TRANSITIONS[currentStatus];
  return allowed ? allowed.includes(newStatus) : false;
}

const VALID_ACCOUNT_TYPES = [
  'corpus', 'operating', 'reserve', 'beneficiary',
  'trustee_fee', 'tax_escrow', 'investment', 'petty_cash',
];

const VALID_KYC_STATUSES = ['pending', 'verified', 'expired', 'failed'];
const VALID_AML_RATINGS  = ['low', 'medium', 'high'];

// --- Transfer Lifecycle ----------------------------------------------------

const VALID_TRANSFER_STATUSES = ['pending', 'approved', 'executing', 'completed', 'failed', 'cancelled', 'reversed'];

const ALLOWED_TRANSFER_TRANSITIONS = {
  pending:    ['approved', 'cancelled'],
  approved:   ['executing', 'cancelled'],
  executing:  ['completed', 'failed'],
  completed:  ['reversed'],
  failed:     ['pending', 'cancelled'],
  cancelled:  [],
  reversed:   [],
};

function canTransitionTransfer(currentStatus, newStatus) {
  const allowed = ALLOWED_TRANSFER_TRANSITIONS[currentStatus];
  return allowed ? allowed.includes(newStatus) : false;
}

const VALID_TRANSFER_TYPES = [
  'standard', 'interest_sweep', 'fee_collection',
  'distribution', 'rebalance', 'tax_payment',
];

// --- Account Validation ----------------------------------------------------

function validateAccount(data) {
  const errors = [];

  if (!data.account_name || !data.account_name.trim()) {
    errors.push('account_name is required');
  }

  if (data.account_type && !VALID_ACCOUNT_TYPES.includes(data.account_type)) {
    errors.push(`Invalid account_type. Must be one of: ${VALID_ACCOUNT_TYPES.join(', ')}`);
  }

  const validOwnerTypes = ['trust', 'beneficiary', 'trustee'];
  if (data.owner_type && !validOwnerTypes.includes(data.owner_type)) {
    errors.push(`Invalid owner_type. Must be one of: ${validOwnerTypes.join(', ')}`);
  }

  if (data.interest_rate_bps !== undefined) {
    if (!Number.isInteger(data.interest_rate_bps) || data.interest_rate_bps < 0 || data.interest_rate_bps > 10000) {
      errors.push('interest_rate_bps must be an integer between 0 and 10000');
    }
  }

  if (data.daily_transfer_limit_cents !== undefined && data.daily_transfer_limit_cents !== null) {
    if (!Number.isInteger(data.daily_transfer_limit_cents) || data.daily_transfer_limit_cents <= 0) {
      errors.push('daily_transfer_limit_cents must be a positive integer');
    }
  }

  if (data.single_transfer_limit_cents !== undefined && data.single_transfer_limit_cents !== null) {
    if (!Number.isInteger(data.single_transfer_limit_cents) || data.single_transfer_limit_cents <= 0) {
      errors.push('single_transfer_limit_cents must be a positive integer');
    }
  }

  if (data.kyc_status && !VALID_KYC_STATUSES.includes(data.kyc_status)) {
    errors.push(`Invalid kyc_status. Must be one of: ${VALID_KYC_STATUSES.join(', ')}`);
  }

  if (data.aml_risk_rating && !VALID_AML_RATINGS.includes(data.aml_risk_rating)) {
    errors.push(`Invalid aml_risk_rating. Must be one of: ${VALID_AML_RATINGS.join(', ')}`);
  }

  return errors;
}

// --- Transfer Validation ---------------------------------------------------

function validateTransfer(data, fromAccount, toAccount) {
  const errors = [];

  if (!data.from_account_id) {
    errors.push('from_account_id is required');
  }
  if (!data.to_account_id) {
    errors.push('to_account_id is required');
  }
  if (data.from_account_id && data.to_account_id && data.from_account_id === data.to_account_id) {
    errors.push('from_account_id and to_account_id must be different');
  }
  if (!data.amount_cents || data.amount_cents <= 0) {
    errors.push('amount_cents must be a positive integer');
  }
  if (data.amount_cents && !Number.isInteger(data.amount_cents)) {
    errors.push('amount_cents must be an integer');
  }
  if (data.transfer_type && !VALID_TRANSFER_TYPES.includes(data.transfer_type)) {
    errors.push(`Invalid transfer_type. Must be one of: ${VALID_TRANSFER_TYPES.join(', ')}`);
  }

  if (fromAccount) {
    if (fromAccount.status !== 'active') {
      errors.push(`Source account is ${fromAccount.status}, must be active`);
    }
    if (data.amount_cents && !fromAccount.overdraft_allowed && data.amount_cents > fromAccount.available_cents) {
      errors.push(`Insufficient available funds. Available: ${fromAccount.available_cents}, requested: ${data.amount_cents}`);
    }
    if (data.amount_cents && fromAccount.overdraft_allowed) {
      const effectiveLimit = fromAccount.available_cents + fromAccount.overdraft_limit_cents;
      if (data.amount_cents > effectiveLimit) {
        errors.push(`Exceeds overdraft limit. Available + overdraft: ${effectiveLimit}, requested: ${data.amount_cents}`);
      }
    }
    if (fromAccount.single_transfer_limit_cents && data.amount_cents > fromAccount.single_transfer_limit_cents) {
      errors.push(`Exceeds single transfer limit of ${fromAccount.single_transfer_limit_cents} cents`);
    }
  }

  if (toAccount) {
    if (toAccount.status !== 'active') {
      errors.push(`Destination account is ${toAccount.status}, must be active`);
    }
  }

  return errors;
}

// --- Interest Calculation --------------------------------------------------

function calculateDailyInterest(balanceCents, annualRateBps) {
  if (balanceCents <= 0 || annualRateBps <= 0) return 0;
  const annualRate = annualRateBps / 10000;
  const dailyRate = annualRate / 365;
  return Math.round(balanceCents * dailyRate);
}

function calculateMonthlyInterest(balanceCents, annualRateBps) {
  if (balanceCents <= 0 || annualRateBps <= 0) return 0;
  const annualRate = annualRateBps / 10000;
  const monthlyRate = annualRate / 12;
  return Math.round(balanceCents * monthlyRate);
}

function projectInterest(balanceCents, annualRateBps, days) {
  if (balanceCents <= 0 || annualRateBps <= 0 || days <= 0) return 0;
  const annualRate = annualRateBps / 10000;
  return Math.round(balanceCents * annualRate * (days / 365));
}

// --- Transfer Number Generation --------------------------------------------

function generateTransferNumber() {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `TRF-${datePart}-${rand}`;
}

// --- Account Number Generation ---------------------------------------------

function generateAccountNumber(accountType) {
  const prefixes = {
    corpus:       'DLB-CRP',
    operating:    'DLB-OPS',
    reserve:      'DLB-RSV',
    beneficiary:  'DLB-BEN',
    trustee_fee:  'DLB-TFE',
    tax_escrow:   'DLB-TAX',
    investment:   'DLB-INV',
    petty_cash:   'DLB-PTY',
  };
  const prefix = prefixes[accountType] || 'DLB-ACC';
  const seq = String(Date.now()).slice(-6);
  return `${prefix}-${seq}`;
}

// --- Approval Thresholds ---------------------------------------------------

const TRANSFER_APPROVAL_THRESHOLDS = {
  auto_approve_below_cents: 50000,        // Auto-approve below $500
  require_dual_above_cents: 5000000,      // Dual approval above $50,000
};

function determineTransferApproval(amountCents, transferType) {
  if (transferType === 'interest_sweep' || transferType === 'fee_collection') {
    return { requires_approval: false, approval_level: 'auto' };
  }
  if (amountCents < TRANSFER_APPROVAL_THRESHOLDS.auto_approve_below_cents) {
    return { requires_approval: false, approval_level: 'auto' };
  }
  if (amountCents >= TRANSFER_APPROVAL_THRESHOLDS.require_dual_above_cents) {
    return { requires_approval: true, approval_level: 'dual' };
  }
  return { requires_approval: true, approval_level: 'single' };
}

// --- Daily Transfer Limit Check --------------------------------------------

function checkDailyLimit(account, todayTransfersCents, newAmountCents) {
  if (!account.daily_transfer_limit_cents) return { allowed: true };
  const totalAfter = todayTransfersCents + newAmountCents;
  if (totalAfter > account.daily_transfer_limit_cents) {
    return {
      allowed: false,
      limit_cents: account.daily_transfer_limit_cents,
      used_today_cents: todayTransfersCents,
      remaining_cents: Math.max(0, account.daily_transfer_limit_cents - todayTransfersCents),
    };
  }
  return { allowed: true };
}

// --- Reconciliation Helpers ------------------------------------------------

function calculateDiscrepancy(ledgerBalanceCents, expectedBalanceCents) {
  if (expectedBalanceCents === null || expectedBalanceCents === undefined) return null;
  return ledgerBalanceCents - expectedBalanceCents;
}

function buildTrialBalance(accounts) {
  let totalAssets = 0;
  let totalLiabilities = 0;
  const rows = [];

  for (const acct of accounts) {
    const entry = {
      account_id: acct.id,
      account_number: acct.account_number,
      account_name: acct.account_name,
      account_type: acct.account_type,
      balance_cents: acct.balance_cents,
      hold_cents: acct.hold_cents,
      available_cents: acct.available_cents,
    };

    if (acct.balance_cents >= 0) {
      totalAssets += acct.balance_cents;
    } else {
      totalLiabilities += Math.abs(acct.balance_cents);
    }

    rows.push(entry);
  }

  return {
    generated_at: new Date().toISOString(),
    total_assets_cents: totalAssets,
    total_liabilities_cents: totalLiabilities,
    net_position_cents: totalAssets - totalLiabilities,
    accounts: rows,
  };
}

// --- Audit Entry Builder ---------------------------------------------------

function buildAuditEntry(eventType, entityType, entityId, action, actor, details) {
  return {
    event_type: eventType,
    entity_type: entityType,
    entity_id: entityId,
    actor: actor || 'system',
    action,
    details: typeof details === 'string' ? details : JSON.stringify(details),
    created_at: new Date().toISOString(),
  };
}

// --- Tax Event Builder -----------------------------------------------------

function buildTaxEvent(taxYear, eventType, entityType, entityId, amountCents, opts = {}) {
  return {
    tax_year: taxYear,
    event_type: eventType,
    entity_type: entityType,
    entity_id: entityId,
    payee_name: opts.payee_name || null,
    payee_tin: opts.payee_tin || null,
    amount_cents: amountCents,
    form_type: opts.form_type || null,
    reportable: opts.reportable !== undefined ? opts.reportable : 1,
  };
}

// --- Net Worth Calculation -------------------------------------------------

function calculateNetWorth(accounts, holdings, payables) {
  const accountTotal = (accounts || []).reduce((s, a) => s + (a.balance_cents || 0), 0);
  const holdingsTotal = (holdings || []).reduce((s, h) => s + (h.market_value_cents || h.par_value_cents || 0), 0);
  const payablesTotal = (payables || []).reduce((s, p) => s + (p.balance_cents || 0), 0);

  return {
    calculated_at: new Date().toISOString(),
    cash_and_accounts_cents: accountTotal,
    investment_holdings_cents: holdingsTotal,
    outstanding_payables_cents: payablesTotal,
    total_assets_cents: accountTotal + holdingsTotal,
    net_worth_cents: accountTotal + holdingsTotal - payablesTotal,
  };
}

// --- Performance Metrics ---------------------------------------------------

function calculateTimeWeightedReturn(periodReturns) {
  if (!periodReturns || periodReturns.length === 0) return 0;
  let twr = 1;
  for (const r of periodReturns) {
    twr *= (1 + r);
  }
  return Math.round((twr - 1) * 10000) / 10000; // 4 decimal places
}

function calculateSimpleReturn(beginningCents, endingCents, cashFlowsCents) {
  if (beginningCents === 0) return 0;
  const netGain = endingCents - beginningCents - (cashFlowsCents || 0);
  return Math.round((netGain / beginningCents) * 10000) / 10000;
}

// --- Helpers ---------------------------------------------------------------

const toDollars = (cents) => (cents !== null && cents !== undefined) ? Math.round(cents) / 100 : null;

module.exports = {
  // Account lifecycle
  VALID_ACCOUNT_STATUSES,
  ALLOWED_ACCOUNT_TRANSITIONS,
  VALID_ACCOUNT_TYPES,
  VALID_KYC_STATUSES,
  VALID_AML_RATINGS,
  canTransitionAccount,
  validateAccount,
  generateAccountNumber,

  // Transfer lifecycle
  VALID_TRANSFER_STATUSES,
  ALLOWED_TRANSFER_TRANSITIONS,
  VALID_TRANSFER_TYPES,
  canTransitionTransfer,
  validateTransfer,
  generateTransferNumber,
  determineTransferApproval,
  checkDailyLimit,
  TRANSFER_APPROVAL_THRESHOLDS,

  // Interest
  calculateDailyInterest,
  calculateMonthlyInterest,
  projectInterest,

  // Reconciliation
  calculateDiscrepancy,
  buildTrialBalance,

  // Audit & Tax
  buildAuditEntry,
  buildTaxEvent,

  // Wealth
  calculateNetWorth,
  calculateTimeWeightedReturn,
  calculateSimpleReturn,

  // Helpers
  toDollars,
};
