-- ─────────────────────────────────────────────────────────────────────────────
-- Payment Engine Schema
-- DEANDREA LAVAR BARKLEY TRUST — Private Trust Payment Processing
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Trust Payouts ───────────────────────────────────────────────────────────
-- Covers beneficiary distributions, trustee payouts, and general disbursements
CREATE TABLE IF NOT EXISTS trust_payouts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  payout_type           TEXT NOT NULL DEFAULT 'distribution',  -- distribution, trustee_fee, expense_reimbursement, loan, gift, tax_payment
  payee_name            TEXT NOT NULL,
  payee_type            TEXT NOT NULL DEFAULT 'beneficiary',   -- beneficiary, trustee, vendor, government, other
  wallet_id             INTEGER,                               -- optional link to wallets table
  amount_cents          INTEGER NOT NULL,
  fee_cents             INTEGER NOT NULL DEFAULT 0,
  net_amount_cents      INTEGER NOT NULL,                      -- amount_cents - fee_cents
  currency              TEXT NOT NULL DEFAULT 'USD',
  payment_method        TEXT NOT NULL DEFAULT 'ach',           -- ach, wire, check, internal_transfer
  status                TEXT NOT NULL DEFAULT 'draft',         -- draft, pending_approval, approved, processing, completed, failed, cancelled, returned
  priority              TEXT NOT NULL DEFAULT 'normal',        -- low, normal, high, urgent
  scheduled_date        TEXT,                                  -- when to send
  executed_date         TEXT,                                  -- when actually sent
  completed_date        TEXT,                                  -- when confirmed received
  description           TEXT,
  memo                  TEXT,                                  -- memo line on payment
  reference_number      TEXT,                                  -- external reference/confirmation
  bank_routing_number   TEXT,
  bank_account_number   TEXT,
  bank_account_type     TEXT DEFAULT 'checking',               -- checking, savings
  bank_name             TEXT,
  recurring_schedule_id INTEGER,                               -- if part of recurring
  source_bill_id        INTEGER,                               -- if paying a bill
  tax_reportable        INTEGER NOT NULL DEFAULT 1,            -- 1 = yes, 0 = no
  tax_category          TEXT,                                  -- 1099-MISC, 1099-NEC, 1099-INT, etc.
  fiscal_year           INTEGER,
  created_by            TEXT DEFAULT 'system',
  approved_by           TEXT,
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payouts_status ON trust_payouts(status);
CREATE INDEX IF NOT EXISTS idx_payouts_payee ON trust_payouts(payee_name);
CREATE INDEX IF NOT EXISTS idx_payouts_type ON trust_payouts(payout_type);
CREATE INDEX IF NOT EXISTS idx_payouts_scheduled ON trust_payouts(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_payouts_wallet ON trust_payouts(wallet_id);

-- ─── Payout Approvals ────────────────────────────────────────────────────────
-- Audit trail for approval workflow
CREATE TABLE IF NOT EXISTS payout_approvals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  payout_id       INTEGER NOT NULL,
  action          TEXT NOT NULL,      -- submitted, approved, rejected, cancelled, escalated
  actor           TEXT NOT NULL,      -- who performed the action
  notes           TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (payout_id) REFERENCES trust_payouts(id)
);

CREATE INDEX IF NOT EXISTS idx_approvals_payout ON payout_approvals(payout_id);

-- ─── Recurring Payment Schedules ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recurring_schedules (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_name         TEXT NOT NULL,
  payee_name            TEXT NOT NULL,
  payee_type            TEXT NOT NULL DEFAULT 'beneficiary',
  wallet_id             INTEGER,
  amount_cents          INTEGER NOT NULL,
  payment_method        TEXT NOT NULL DEFAULT 'ach',
  frequency             TEXT NOT NULL DEFAULT 'monthly',       -- weekly, bi_weekly, monthly, quarterly, semi_annual, annual
  day_of_month          INTEGER,                               -- 1-28 for monthly+
  day_of_week           INTEGER,                               -- 0-6 for weekly/bi_weekly
  start_date            TEXT NOT NULL,
  end_date              TEXT,                                  -- null = indefinite
  next_payment_date     TEXT,
  last_payment_date     TEXT,
  total_paid_cents      INTEGER NOT NULL DEFAULT 0,
  payment_count         INTEGER NOT NULL DEFAULT 0,
  max_payments          INTEGER,                               -- null = unlimited
  status                TEXT NOT NULL DEFAULT 'active',        -- active, paused, completed, cancelled
  payout_type           TEXT NOT NULL DEFAULT 'distribution',
  description           TEXT,
  bank_routing_number   TEXT,
  bank_account_number   TEXT,
  bank_account_type     TEXT DEFAULT 'checking',
  bank_name             TEXT,
  auto_approve          INTEGER NOT NULL DEFAULT 0,            -- 1 = skip approval for this schedule
  created_by            TEXT DEFAULT 'system',
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_recurring_status ON recurring_schedules(status);
CREATE INDEX IF NOT EXISTS idx_recurring_next ON recurring_schedules(next_payment_date);

-- ─── Vendors ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendors (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_name           TEXT NOT NULL,
  vendor_type           TEXT NOT NULL DEFAULT 'service',       -- service, contractor, supplier, legal, accounting, financial, government, utility, other
  contact_name          TEXT,
  contact_email         TEXT,
  contact_phone         TEXT,
  address_line1         TEXT,
  address_line2         TEXT,
  city                  TEXT,
  state                 TEXT,
  zip_code              TEXT,
  tax_id                TEXT,                                  -- EIN/SSN for 1099 reporting
  tax_id_type           TEXT DEFAULT 'ein',                    -- ein, ssn
  payment_terms         TEXT DEFAULT 'net_30',                 -- due_on_receipt, net_15, net_30, net_45, net_60, net_90
  default_payment_method TEXT DEFAULT 'ach',                   -- ach, wire, check
  bank_routing_number   TEXT,
  bank_account_number   TEXT,
  bank_account_type     TEXT DEFAULT 'checking',
  bank_name             TEXT,
  w9_on_file            INTEGER NOT NULL DEFAULT 0,
  preferred             INTEGER NOT NULL DEFAULT 0,            -- preferred vendor flag
  status                TEXT NOT NULL DEFAULT 'active',        -- active, inactive, suspended
  notes                 TEXT,
  total_paid_cents      INTEGER NOT NULL DEFAULT 0,
  payment_count         INTEGER NOT NULL DEFAULT 0,
  last_payment_date     TEXT,
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_vendors_name ON vendors(vendor_name);
CREATE INDEX IF NOT EXISTS idx_vendors_type ON vendors(vendor_type);
CREATE INDEX IF NOT EXISTS idx_vendors_status ON vendors(status);

-- ─── Vendor Payments ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendor_payments (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id             INTEGER NOT NULL,
  payout_id             INTEGER,                               -- links to trust_payouts for execution
  bill_id               INTEGER,                               -- links to bills if paying a bill
  amount_cents          INTEGER NOT NULL,
  payment_method        TEXT NOT NULL DEFAULT 'ach',
  status                TEXT NOT NULL DEFAULT 'pending',       -- pending, processing, completed, failed, cancelled
  invoice_number        TEXT,
  payment_date          TEXT,
  description           TEXT,
  category              TEXT DEFAULT 'operating',              -- operating, legal, accounting, tax, insurance, management, advisory, other
  fiscal_year           INTEGER,
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (vendor_id) REFERENCES vendors(id)
);

CREATE INDEX IF NOT EXISTS idx_vpayments_vendor ON vendor_payments(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vpayments_status ON vendor_payments(status);
CREATE INDEX IF NOT EXISTS idx_vpayments_bill ON vendor_payments(bill_id);

-- ─── Bills / Invoices ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bills (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id             INTEGER,
  bill_number           TEXT,                                  -- invoice/bill number from vendor
  bill_type             TEXT NOT NULL DEFAULT 'invoice',       -- invoice, recurring_charge, tax_notice, legal_fee, management_fee, insurance_premium, utility, other
  amount_cents          INTEGER NOT NULL,
  tax_cents             INTEGER NOT NULL DEFAULT 0,
  total_cents           INTEGER NOT NULL,                      -- amount_cents + tax_cents
  paid_cents            INTEGER NOT NULL DEFAULT 0,
  balance_cents         INTEGER NOT NULL,                      -- total_cents - paid_cents
  currency              TEXT NOT NULL DEFAULT 'USD',
  status                TEXT NOT NULL DEFAULT 'received',      -- received, approved, scheduled, partially_paid, paid, overdue, disputed, cancelled
  priority              TEXT NOT NULL DEFAULT 'normal',        -- low, normal, high, urgent
  received_date         TEXT NOT NULL,
  due_date              TEXT NOT NULL,
  scheduled_pay_date    TEXT,
  paid_date             TEXT,
  description           TEXT,
  line_items            TEXT,                                  -- JSON array of line items
  category              TEXT DEFAULT 'operating',              -- operating, legal, accounting, tax, insurance, management, advisory, other
  fiscal_year           INTEGER,
  attachment_url        TEXT,                                  -- link to scanned bill
  approved_by           TEXT,
  approved_date         TEXT,
  notes                 TEXT,
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (vendor_id) REFERENCES vendors(id)
);

CREATE INDEX IF NOT EXISTS idx_bills_vendor ON bills(vendor_id);
CREATE INDEX IF NOT EXISTS idx_bills_status ON bills(status);
CREATE INDEX IF NOT EXISTS idx_bills_due ON bills(due_date);
CREATE INDEX IF NOT EXISTS idx_bills_type ON bills(bill_type);

-- ─── Payment Ledger ──────────────────────────────────────────────────────────
-- Immutable audit log of all payment engine transactions
CREATE TABLE IF NOT EXISTS payment_ledger (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_type            TEXT NOT NULL,                         -- payout, vendor_payment, bill_payment, fee, refund, adjustment
  reference_type        TEXT,                                  -- payout, vendor_payment, bill
  reference_id          INTEGER,                               -- ID in the reference table
  debit_cents           INTEGER NOT NULL DEFAULT 0,
  credit_cents          INTEGER NOT NULL DEFAULT 0,
  balance_after_cents   INTEGER,                               -- running balance after this entry
  description           TEXT NOT NULL,
  category              TEXT,
  fiscal_year           INTEGER,
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pledger_type ON payment_ledger(entry_type);
CREATE INDEX IF NOT EXISTS idx_pledger_ref ON payment_ledger(reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_pledger_date ON payment_ledger(created_at);
