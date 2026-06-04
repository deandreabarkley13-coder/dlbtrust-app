-- ---------------------------------------------------------------------------
-- Core Banking Engine Schema
-- DEANDREA LAVAR BARKLEY TRUST -- Private Wealth Management Platform
-- ---------------------------------------------------------------------------

-- --- Trust Accounts --------------------------------------------------------
-- Master account registry for the trust entity
CREATE TABLE IF NOT EXISTS trust_accounts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  account_number        TEXT NOT NULL UNIQUE,              -- e.g. DLB-TRUST-001
  account_name          TEXT NOT NULL,
  account_type          TEXT NOT NULL DEFAULT 'operating', -- corpus, operating, reserve, beneficiary, trustee_fee, tax_escrow, investment, petty_cash
  owner_type            TEXT NOT NULL DEFAULT 'trust',     -- trust, beneficiary, trustee
  owner_name            TEXT,
  wallet_id             INTEGER,                           -- optional link to existing wallets table
  currency              TEXT NOT NULL DEFAULT 'USD',
  balance_cents         INTEGER NOT NULL DEFAULT 0,
  available_cents       INTEGER NOT NULL DEFAULT 0,        -- balance_cents minus holds
  hold_cents            INTEGER NOT NULL DEFAULT 0,
  interest_rate_bps     INTEGER NOT NULL DEFAULT 0,        -- annual rate in basis points (e.g. 425 = 4.25%)
  interest_accrued_cents INTEGER NOT NULL DEFAULT 0,       -- accrued but not yet credited
  interest_method       TEXT NOT NULL DEFAULT 'daily',     -- daily, monthly, none
  daily_transfer_limit_cents  INTEGER,                     -- null = unlimited
  single_transfer_limit_cents INTEGER,                     -- null = unlimited
  overdraft_allowed     INTEGER NOT NULL DEFAULT 0,        -- 0 = no, 1 = yes
  overdraft_limit_cents INTEGER NOT NULL DEFAULT 0,
  kyc_status            TEXT NOT NULL DEFAULT 'pending',   -- pending, verified, expired, failed
  kyc_verified_date     TEXT,
  kyc_expiry_date       TEXT,
  aml_risk_rating       TEXT NOT NULL DEFAULT 'low',       -- low, medium, high
  status                TEXT NOT NULL DEFAULT 'pending',   -- pending, active, frozen, dormant, closed
  status_reason         TEXT,
  opened_date           TEXT DEFAULT (date('now')),
  closed_date           TEXT,
  last_activity_date    TEXT,
  last_interest_date    TEXT,                               -- last date interest was calculated
  last_statement_date   TEXT,
  notes                 TEXT,
  created_by            TEXT DEFAULT 'system',
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_accounts_type ON trust_accounts(account_type);
CREATE INDEX IF NOT EXISTS idx_accounts_status ON trust_accounts(status);
CREATE INDEX IF NOT EXISTS idx_accounts_owner ON trust_accounts(owner_type, owner_name);
CREATE INDEX IF NOT EXISTS idx_accounts_wallet ON trust_accounts(wallet_id);

-- --- Account Holds ---------------------------------------------------------
-- Temporary holds that reduce available balance
CREATE TABLE IF NOT EXISTS account_holds (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id            INTEGER NOT NULL,
  hold_type             TEXT NOT NULL DEFAULT 'administrative', -- administrative, pending_transfer, legal, regulatory, tax_reserve
  amount_cents          INTEGER NOT NULL,
  reason                TEXT NOT NULL,
  reference_id          TEXT,                               -- link to transfer/payout that caused the hold
  status                TEXT NOT NULL DEFAULT 'active',     -- active, released, expired
  placed_date           TEXT DEFAULT (datetime('now')),
  release_date          TEXT,                               -- when to auto-release (null = manual)
  released_date         TEXT,                               -- actual release timestamp
  placed_by             TEXT DEFAULT 'system',
  released_by           TEXT,
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES trust_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_holds_account ON account_holds(account_id);
CREATE INDEX IF NOT EXISTS idx_holds_status ON account_holds(status);

-- --- Account Statements ----------------------------------------------------
-- Monthly statement snapshots
CREATE TABLE IF NOT EXISTS account_statements (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id            INTEGER NOT NULL,
  statement_period      TEXT NOT NULL,                      -- YYYY-MM
  opening_balance_cents INTEGER NOT NULL,
  closing_balance_cents INTEGER NOT NULL,
  total_credits_cents   INTEGER NOT NULL DEFAULT 0,
  total_debits_cents    INTEGER NOT NULL DEFAULT 0,
  interest_earned_cents INTEGER NOT NULL DEFAULT 0,
  fees_charged_cents    INTEGER NOT NULL DEFAULT 0,
  hold_balance_cents    INTEGER NOT NULL DEFAULT 0,
  transaction_count     INTEGER NOT NULL DEFAULT 0,
  generated_at          TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES trust_accounts(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_statements_unique ON account_statements(account_id, statement_period);

-- --- Interest Accrual Log --------------------------------------------------
-- Daily interest accrual entries
CREATE TABLE IF NOT EXISTS account_interest (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id            INTEGER NOT NULL,
  accrual_date          TEXT NOT NULL,                      -- YYYY-MM-DD
  balance_cents         INTEGER NOT NULL,                   -- balance used for calculation
  rate_bps              INTEGER NOT NULL,                   -- rate applied
  accrued_cents         INTEGER NOT NULL,                   -- interest accrued this day
  credited              INTEGER NOT NULL DEFAULT 0,         -- 0 = accrued only, 1 = credited to account
  credited_date         TEXT,
  created_at            TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES trust_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_interest_account ON account_interest(account_id);
CREATE INDEX IF NOT EXISTS idx_interest_date ON account_interest(accrual_date);

-- --- Internal Transfers ----------------------------------------------------
-- Transfers between trust accounts
CREATE TABLE IF NOT EXISTS internal_transfers (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_number       TEXT NOT NULL UNIQUE,               -- TRF-YYYYMMDD-XXXX
  from_account_id       INTEGER NOT NULL,
  to_account_id         INTEGER NOT NULL,
  amount_cents          INTEGER NOT NULL,
  fee_cents             INTEGER NOT NULL DEFAULT 0,
  currency              TEXT NOT NULL DEFAULT 'USD',
  transfer_type         TEXT NOT NULL DEFAULT 'standard',   -- standard, interest_sweep, fee_collection, distribution, rebalance, tax_payment
  status                TEXT NOT NULL DEFAULT 'pending',    -- pending, approved, executing, completed, failed, cancelled, reversed
  priority              TEXT NOT NULL DEFAULT 'normal',     -- low, normal, high, urgent
  description           TEXT,
  memo                  TEXT,
  reference_id          TEXT,                               -- external reference
  requires_approval     INTEGER NOT NULL DEFAULT 1,
  approved_by           TEXT,
  approved_date         TEXT,
  executed_date         TEXT,
  completed_date        TEXT,
  reversal_of           INTEGER,                            -- id of original transfer if this is a reversal
  created_by            TEXT DEFAULT 'system',
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (from_account_id) REFERENCES trust_accounts(id),
  FOREIGN KEY (to_account_id)   REFERENCES trust_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_transfers_from ON internal_transfers(from_account_id);
CREATE INDEX IF NOT EXISTS idx_transfers_to ON internal_transfers(to_account_id);
CREATE INDEX IF NOT EXISTS idx_transfers_status ON internal_transfers(status);
CREATE INDEX IF NOT EXISTS idx_transfers_type ON internal_transfers(transfer_type);

-- --- Reconciliation Snapshots ----------------------------------------------
-- Daily balance snapshots for reconciliation
CREATE TABLE IF NOT EXISTS reconciliation_snapshots (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date         TEXT NOT NULL,                      -- YYYY-MM-DD
  account_id            INTEGER NOT NULL,
  ledger_balance_cents  INTEGER NOT NULL,                   -- balance per our records
  available_balance_cents INTEGER NOT NULL,
  hold_balance_cents    INTEGER NOT NULL DEFAULT 0,
  accrued_interest_cents INTEGER NOT NULL DEFAULT 0,
  expected_balance_cents INTEGER,                           -- external/bank statement balance if known
  discrepancy_cents     INTEGER,                            -- ledger - expected
  reconciled            INTEGER NOT NULL DEFAULT 0,         -- 0 = pending, 1 = reconciled
  reconciled_by         TEXT,
  reconciled_date       TEXT,
  notes                 TEXT,
  created_at            TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES trust_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_recon_date ON reconciliation_snapshots(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_recon_account ON reconciliation_snapshots(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recon_unique ON reconciliation_snapshots(snapshot_date, account_id);

-- --- Audit Log -------------------------------------------------------------
-- Immutable audit trail for all banking operations
CREATE TABLE IF NOT EXISTS banking_audit_log (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type            TEXT NOT NULL,                      -- account_opened, account_frozen, transfer_created, transfer_executed, hold_placed, hold_released, interest_accrued, statement_generated, kyc_updated, balance_adjusted
  entity_type           TEXT NOT NULL,                      -- account, transfer, hold, statement
  entity_id             INTEGER NOT NULL,
  actor                 TEXT NOT NULL DEFAULT 'system',
  action                TEXT NOT NULL,                      -- create, update, delete, approve, reject, execute, reverse
  details               TEXT,                               -- JSON with old/new values
  ip_address            TEXT,
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON banking_audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_type ON banking_audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_date ON banking_audit_log(created_at);

-- --- Tax Events ------------------------------------------------------------
-- Tax-relevant events for reporting (1099, K-1, etc.)
CREATE TABLE IF NOT EXISTS tax_events (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  tax_year              INTEGER NOT NULL,
  event_type            TEXT NOT NULL,                      -- interest_income, distribution, capital_gain, capital_loss, fee_deduction, tax_payment
  entity_type           TEXT NOT NULL,                      -- account, transfer, payout
  entity_id             INTEGER NOT NULL,
  payee_name            TEXT,
  payee_tin             TEXT,                               -- tax ID (EIN/SSN) - encrypted at rest
  amount_cents          INTEGER NOT NULL,
  form_type             TEXT,                               -- 1099-INT, 1099-MISC, 1099-NEC, K-1, 1041
  reportable            INTEGER NOT NULL DEFAULT 1,
  reported              INTEGER NOT NULL DEFAULT 0,
  reported_date         TEXT,
  notes                 TEXT,
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tax_year ON tax_events(tax_year);
CREATE INDEX IF NOT EXISTS idx_tax_type ON tax_events(event_type);
CREATE INDEX IF NOT EXISTS idx_tax_payee ON tax_events(payee_name);
