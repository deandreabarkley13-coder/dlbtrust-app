-- ---------------------------------------------------------------------------
-- Payment Rail Engine Schema
-- DEANDREA LAVAR BARKLEY TRUST — Real Money Movement via Increase
-- ---------------------------------------------------------------------------

-- --- Increase Accounts (Mirrors Increase accounts linked to trust) ----------
CREATE TABLE IF NOT EXISTS increase_accounts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  increase_account_id   TEXT NOT NULL UNIQUE,               -- Increase's account ID (account_xxx)
  trust_account_id      INTEGER,                            -- Link to local trust_accounts
  account_name          TEXT NOT NULL,
  account_number        TEXT,                               -- Bank account number
  routing_number        TEXT,                               -- Bank routing number
  status                TEXT NOT NULL DEFAULT 'open',       -- open, closed
  currency              TEXT NOT NULL DEFAULT 'USD',
  balance_cents         INTEGER NOT NULL DEFAULT 0,         -- Last known balance from Increase
  available_balance_cents INTEGER NOT NULL DEFAULT 0,
  bank                  TEXT,                               -- first_internet_bank, grasshopper_bank, etc.
  interest_rate         TEXT,
  entity_id             TEXT,                               -- Increase entity ID
  program_id            TEXT,                               -- Increase program ID
  last_synced_at        TEXT,
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (trust_account_id) REFERENCES trust_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_inc_acct_increase ON increase_accounts(increase_account_id);
CREATE INDEX IF NOT EXISTS idx_inc_acct_trust ON increase_accounts(trust_account_id);

-- --- Increase External Accounts (Counterparty bank details on Increase) -----
CREATE TABLE IF NOT EXISTS increase_external_accounts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  increase_ext_acct_id  TEXT NOT NULL UNIQUE,               -- Increase external_account_xxx
  contact_id            INTEGER,                            -- Link to crm_contacts
  payment_method_id     INTEGER,                            -- Link to crm_payment_methods
  account_holder        TEXT NOT NULL DEFAULT 'individual', -- individual, business, unknown
  account_number        TEXT,                               -- Destination account (masked)
  routing_number        TEXT,                               -- ABA routing
  description           TEXT,
  funding               TEXT DEFAULT 'checking',            -- checking, savings, general_ledger, other
  status                TEXT NOT NULL DEFAULT 'active',     -- active, archived
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (contact_id) REFERENCES crm_contacts(id),
  FOREIGN KEY (payment_method_id) REFERENCES crm_payment_methods(id)
);

CREATE INDEX IF NOT EXISTS idx_inc_ext_increase ON increase_external_accounts(increase_ext_acct_id);
CREATE INDEX IF NOT EXISTS idx_inc_ext_contact ON increase_external_accounts(contact_id);

-- --- Rail Transactions (All real money movements via Increase) --------------
CREATE TABLE IF NOT EXISTS rail_transactions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  rail_tx_number        TEXT NOT NULL UNIQUE,               -- RAIL-YYYYMMDD-XXXX
  -- Link to internal transfer
  external_transfer_id  INTEGER,                            -- Link to external_transfers
  -- Increase references
  increase_tx_id        TEXT,                               -- Increase transaction ID
  increase_transfer_id  TEXT,                               -- Increase transfer ID (ach_transfer_xxx, wire_transfer_xxx, etc.)
  increase_account_id   TEXT,                               -- Increase source account
  increase_ext_acct_id  TEXT,                               -- Increase external account (destination)
  -- Rail details
  rail                  TEXT NOT NULL DEFAULT 'ach',        -- ach, wire, rtp, check
  direction             TEXT NOT NULL DEFAULT 'credit',     -- credit (send), debit (pull)
  amount_cents          INTEGER NOT NULL,
  currency              TEXT NOT NULL DEFAULT 'USD',
  -- ACH-specific
  sec_code              TEXT,                               -- PPD, CCD, WEB, TEL
  ach_trace_number      TEXT,
  ach_effective_date    TEXT,
  ach_company_name      TEXT,
  ach_return_code       TEXT,                               -- R01, R02, R03, etc.
  -- Wire-specific
  wire_imad             TEXT,                               -- Input Message Accountability Data
  wire_omad             TEXT,                               -- Output Message Accountability Data
  wire_beneficiary_name TEXT,
  wire_remittance       TEXT,
  -- RTP-specific
  rtp_transaction_id    TEXT,
  rtp_creditor_name     TEXT,
  rtp_debtor_name       TEXT,
  -- Check-specific
  check_number          TEXT,
  check_mailing_address TEXT,
  check_mailed_date     TEXT,
  check_tracking        TEXT,
  -- Recipient
  recipient_name        TEXT,
  recipient_routing     TEXT,
  recipient_account     TEXT,                               -- Masked (****1234)
  recipient_bank        TEXT,
  -- Status lifecycle
  status                TEXT NOT NULL DEFAULT 'pending_submission',
  -- pending_submission, submitted, pending_approval, approved, processing,
  -- sent, completed, failed, returned, reversed, cancelled
  submitted_at          TEXT,
  approved_at           TEXT,
  sent_at               TEXT,
  settled_at            TEXT,
  failed_at             TEXT,
  returned_at           TEXT,
  -- Settlement
  expected_settlement   TEXT,                               -- When we expect funds to settle
  actual_settlement     TEXT,
  settlement_schedule   TEXT,                               -- same_day, future_dated
  -- Fees
  fee_cents             INTEGER NOT NULL DEFAULT 0,
  -- Idempotency
  idempotency_key       TEXT UNIQUE,
  -- Error
  failure_reason        TEXT,
  return_reason         TEXT,
  -- Audit
  initiated_by          TEXT DEFAULT 'system',
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (external_transfer_id) REFERENCES external_transfers(id)
);

CREATE INDEX IF NOT EXISTS idx_rail_tx_number ON rail_transactions(rail_tx_number);
CREATE INDEX IF NOT EXISTS idx_rail_tx_status ON rail_transactions(status);
CREATE INDEX IF NOT EXISTS idx_rail_tx_rail ON rail_transactions(rail);
CREATE INDEX IF NOT EXISTS idx_rail_tx_increase ON rail_transactions(increase_transfer_id);
CREATE INDEX IF NOT EXISTS idx_rail_tx_ext ON rail_transactions(external_transfer_id);
CREATE INDEX IF NOT EXISTS idx_rail_tx_idempotency ON rail_transactions(idempotency_key);

-- --- Webhook Events (Incoming Increase webhooks) ----------------------------
CREATE TABLE IF NOT EXISTS rail_webhook_events (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id              TEXT NOT NULL UNIQUE,               -- Increase event ID
  category              TEXT NOT NULL,                      -- e.g. ach_transfer.created, wire_transfer.updated
  associated_object_type TEXT,                              -- e.g. ach_transfer, wire_transfer
  associated_object_id  TEXT,                               -- e.g. ach_transfer_xxx
  payload               TEXT,                               -- Full JSON payload
  status                TEXT NOT NULL DEFAULT 'received',   -- received, processed, failed
  processed_at          TEXT,
  error_message         TEXT,
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_webhook_event_id ON rail_webhook_events(event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_category ON rail_webhook_events(category);
CREATE INDEX IF NOT EXISTS idx_webhook_status ON rail_webhook_events(status);

-- --- Rail Reconciliation (Daily settlement matching) ------------------------
CREATE TABLE IF NOT EXISTS rail_reconciliation (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  recon_date            TEXT NOT NULL,
  rail                  TEXT NOT NULL,
  total_sent_cents      INTEGER NOT NULL DEFAULT 0,
  total_received_cents  INTEGER NOT NULL DEFAULT 0,
  total_fees_cents      INTEGER NOT NULL DEFAULT 0,
  transactions_count    INTEGER NOT NULL DEFAULT 0,
  matched_count         INTEGER NOT NULL DEFAULT 0,
  unmatched_count       INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'pending',    -- pending, matched, exception
  notes                 TEXT,
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_recon_date ON rail_reconciliation(recon_date);

-- --- Rail Configuration (API keys, environment settings) --------------------
CREATE TABLE IF NOT EXISTS rail_config (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  config_key            TEXT NOT NULL UNIQUE,
  config_value          TEXT NOT NULL,
  encrypted             INTEGER NOT NULL DEFAULT 0,
  description           TEXT,
  updated_at            TEXT DEFAULT (datetime('now'))
);

-- Seed default configuration
INSERT OR IGNORE INTO rail_config (config_key, config_value, description)
VALUES
  ('provider', 'increase', 'Payment rail provider'),
  ('environment', 'sandbox', 'sandbox or production'),
  ('api_base_url', 'https://sandbox.increase.com', 'Increase API base URL'),
  ('webhook_secret', '', 'Webhook signature verification secret'),
  ('default_ach_sec_code', 'CCD', 'Default SEC code for ACH (CCD=corporate, PPD=personal)'),
  ('default_wire_statement', 'DLB Trust Payment', 'Default wire statement descriptor'),
  ('auto_submit_threshold_cents', '100000', 'Auto-submit payments under this amount (cents)'),
  ('require_dual_approval_cents', '5000000', 'Require dual approval above this amount (cents)'),
  ('daily_ach_limit_cents', '50000000', 'Daily ACH outgoing limit (cents)'),
  ('daily_wire_limit_cents', '100000000', 'Daily wire outgoing limit (cents)');
