-- ---------------------------------------------------------------------------
-- Trustee Assignment & Beneficiary Expense Management Schema
-- DEANDREA LAVAR BARKLEY TRUST — Fiduciary Account Governance
-- ---------------------------------------------------------------------------

-- --- Trustee Assignments ----------------------------------------------------
-- Primary trustee assigns trustees and beneficiaries to specific accounts
CREATE TABLE IF NOT EXISTS trustee_assignments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id        INTEGER NOT NULL,                        -- CRM contact (trustee or beneficiary)
  account_id        INTEGER NOT NULL,                        -- trust_accounts FK
  role              TEXT NOT NULL,                            -- primary_trustee, co_trustee, successor_trustee, beneficiary, expense_manager
  permissions       TEXT NOT NULL DEFAULT '[]',               -- JSON array: view_balance, request_expense, approve_expense, manage_distributions, full_control
  spending_limit_cents INTEGER,                               -- max per-transaction for this assignment (null = use account limit)
  monthly_limit_cents  INTEGER,                               -- monthly spending cap (null = unlimited)
  allowed_categories   TEXT,                                  -- JSON array of allowed expense categories (null = all)
  requires_approval    INTEGER NOT NULL DEFAULT 1,            -- 1 = expenses need trustee approval, 0 = auto-approve within limits
  approval_threshold_cents INTEGER,                           -- auto-approve below this, require approval above (null = always require)
  assigned_by       TEXT NOT NULL DEFAULT 'primary_trustee',
  status            TEXT NOT NULL DEFAULT 'active',           -- active, suspended, revoked, pending
  effective_date    TEXT DEFAULT (date('now')),
  expiry_date       TEXT,                                     -- null = no expiry
  notes             TEXT,
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (contact_id) REFERENCES crm_contacts(id),
  FOREIGN KEY (account_id) REFERENCES trust_accounts(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ta_contact_account ON trustee_assignments(contact_id, account_id, role);
CREATE INDEX IF NOT EXISTS idx_ta_account ON trustee_assignments(account_id);
CREATE INDEX IF NOT EXISTS idx_ta_contact ON trustee_assignments(contact_id);
CREATE INDEX IF NOT EXISTS idx_ta_role ON trustee_assignments(role);
CREATE INDEX IF NOT EXISTS idx_ta_status ON trustee_assignments(status);

-- --- Expense Requests -------------------------------------------------------
-- Beneficiaries and assigned trustees submit expense requests against accounts
CREATE TABLE IF NOT EXISTS expense_requests (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  request_number    TEXT NOT NULL UNIQUE,                     -- EXP-YYYYMMDD-XXXX
  assignment_id     INTEGER NOT NULL,                         -- trustee_assignments FK
  account_id        INTEGER NOT NULL,                         -- trust_accounts FK
  requested_by_id   INTEGER NOT NULL,                         -- crm_contacts FK (who submitted)
  amount_cents      INTEGER NOT NULL,
  category          TEXT NOT NULL DEFAULT 'general',          -- housing, medical, education, transportation, living, legal, insurance, maintenance, general, discretionary
  subcategory       TEXT,
  payee_name        TEXT,                                     -- who gets paid
  payee_account     TEXT,                                     -- routing/account info (JSON)
  description       TEXT NOT NULL,
  receipt_path      TEXT,                                     -- uploaded receipt/documentation
  payment_method    TEXT DEFAULT 'ach',                       -- ach, wire, check, internal
  status            TEXT NOT NULL DEFAULT 'pending',          -- pending, approved, rejected, processing, paid, cancelled
  priority          TEXT NOT NULL DEFAULT 'normal',           -- low, normal, high, urgent
  -- Approval tracking
  approved_by       TEXT,
  approved_at       TEXT,
  rejection_reason  TEXT,
  -- Payment tracking
  transfer_id       INTEGER,                                  -- linked external_transfers FK after payment
  paid_at           TEXT,
  -- Audit
  submitted_at      TEXT DEFAULT (datetime('now')),
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (assignment_id) REFERENCES trustee_assignments(id),
  FOREIGN KEY (account_id) REFERENCES trust_accounts(id),
  FOREIGN KEY (requested_by_id) REFERENCES crm_contacts(id)
);

CREATE INDEX IF NOT EXISTS idx_exp_req_status ON expense_requests(status);
CREATE INDEX IF NOT EXISTS idx_exp_req_account ON expense_requests(account_id);
CREATE INDEX IF NOT EXISTS idx_exp_req_assignment ON expense_requests(assignment_id);
CREATE INDEX IF NOT EXISTS idx_exp_req_requester ON expense_requests(requested_by_id);
CREATE INDEX IF NOT EXISTS idx_exp_req_category ON expense_requests(category);

-- --- Expense Budgets --------------------------------------------------------
-- Per-account monthly/annual budgets by category
CREATE TABLE IF NOT EXISTS expense_budgets (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id        INTEGER NOT NULL,
  category          TEXT NOT NULL,                            -- matches expense_requests.category
  budget_period     TEXT NOT NULL DEFAULT 'monthly',          -- monthly, quarterly, annual
  budget_cents      INTEGER NOT NULL,
  spent_cents       INTEGER NOT NULL DEFAULT 0,
  period_start      TEXT NOT NULL,                            -- YYYY-MM-DD
  period_end        TEXT NOT NULL,
  alert_threshold_pct INTEGER DEFAULT 80,                    -- alert when spending reaches this % of budget
  status            TEXT NOT NULL DEFAULT 'active',
  created_by        TEXT DEFAULT 'primary_trustee',
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES trust_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_exp_budget_account ON expense_budgets(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_exp_budget_unique ON expense_budgets(account_id, category, period_start);

-- --- Assignment Audit Log ---------------------------------------------------
CREATE TABLE IF NOT EXISTS assignment_audit_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type        TEXT NOT NULL,                            -- assigned, revoked, suspended, expense_submitted, expense_approved, expense_rejected, expense_paid, budget_set, limit_changed
  entity_type       TEXT NOT NULL,                            -- assignment, expense, budget
  entity_id         INTEGER,
  actor             TEXT NOT NULL,
  details           TEXT,                                     -- JSON
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assign_audit_type ON assignment_audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_assign_audit_entity ON assignment_audit_log(entity_type, entity_id);
