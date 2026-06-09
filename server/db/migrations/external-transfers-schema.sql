-- ---------------------------------------------------------------------------
-- External Transfers Engine Schema
-- DEANDREA LAVAR BARKLEY TRUST — External Payment Processing
-- ---------------------------------------------------------------------------

-- --- External Transfers (Outbound Payments) --------------------------------
-- Payments from trust accounts to external recipients (vendors, beneficiaries, expenses)
CREATE TABLE IF NOT EXISTS external_transfers (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_number       TEXT NOT NULL UNIQUE,               -- EXT-YYYYMMDD-XXXX
  -- Source
  from_account_id       INTEGER NOT NULL,                   -- trust account to debit
  -- Recipient (CRM contact)
  contact_id            INTEGER NOT NULL,                   -- crm_contacts.id
  payment_method_id     INTEGER,                            -- crm_payment_methods.id (null = use default)
  -- Amount
  amount_cents          INTEGER NOT NULL,
  fee_cents             INTEGER NOT NULL DEFAULT 0,         -- processing fee (ACH=0, wire=$25, check=$5)
  total_cents           INTEGER NOT NULL DEFAULT 0,         -- amount_cents + fee_cents
  currency              TEXT NOT NULL DEFAULT 'USD',
  -- Classification
  payment_type          TEXT NOT NULL DEFAULT 'vendor_payment',
    -- vendor_payment, beneficiary_distribution, expense, bill_payment, tax_payment, trustee_fee
  payment_method        TEXT NOT NULL DEFAULT 'ach',        -- ach, wire, check, zelle
  -- Lifecycle
  status                TEXT NOT NULL DEFAULT 'draft',
    -- draft, pending_approval, approved, processing, sent, completed, failed, returned, cancelled
  priority              TEXT NOT NULL DEFAULT 'normal',     -- low, normal, high, urgent
  -- Approval
  requires_approval     INTEGER NOT NULL DEFAULT 1,
  approval_tier         TEXT,                               -- auto, single, dual
  approved_by           TEXT,
  approved_date         TEXT,
  second_approved_by    TEXT,                               -- for dual approval
  second_approved_date  TEXT,
  rejected_by           TEXT,
  rejected_date         TEXT,
  rejection_reason      TEXT,
  -- Processing
  scheduled_date        TEXT,                               -- future-dated payments
  sent_date             TEXT,                               -- when sent to payment processor
  completed_date        TEXT,
  estimated_arrival     TEXT,                               -- ETA for recipient
  -- Reference
  description           TEXT,
  memo                  TEXT,                               -- memo line on check/ACH
  invoice_number        TEXT,                               -- vendor invoice reference
  reference_id          TEXT,                               -- external reference (confirmation #)
  batch_id              TEXT,                               -- for batch payments
  -- Recurring
  recurring_schedule_id INTEGER,                            -- link to recurring schedule
  is_recurring          INTEGER NOT NULL DEFAULT 0,
  -- Failure/Return
  failure_reason        TEXT,
  return_code           TEXT,                               -- ACH return codes (R01-R85)
  return_date           TEXT,
  -- Audit
  created_by            TEXT DEFAULT 'system',
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (from_account_id)   REFERENCES trust_accounts(id),
  FOREIGN KEY (contact_id)        REFERENCES crm_contacts(id),
  FOREIGN KEY (payment_method_id) REFERENCES crm_payment_methods(id)
);

CREATE INDEX IF NOT EXISTS idx_ext_xfer_status ON external_transfers(status);
CREATE INDEX IF NOT EXISTS idx_ext_xfer_contact ON external_transfers(contact_id);
CREATE INDEX IF NOT EXISTS idx_ext_xfer_account ON external_transfers(from_account_id);
CREATE INDEX IF NOT EXISTS idx_ext_xfer_type ON external_transfers(payment_type);
CREATE INDEX IF NOT EXISTS idx_ext_xfer_date ON external_transfers(created_at);
CREATE INDEX IF NOT EXISTS idx_ext_xfer_batch ON external_transfers(batch_id);
CREATE INDEX IF NOT EXISTS idx_ext_xfer_scheduled ON external_transfers(scheduled_date);

-- --- External Transfer Approvals -------------------------------------------
-- Audit trail of approval decisions
CREATE TABLE IF NOT EXISTS external_transfer_approvals (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id           INTEGER NOT NULL,
  action                TEXT NOT NULL,                      -- approved, rejected
  actor                 TEXT NOT NULL,
  reason                TEXT,
  tier                  TEXT,                               -- first, second
  created_at            TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (transfer_id) REFERENCES external_transfers(id)
);

CREATE INDEX IF NOT EXISTS idx_ext_approval_xfer ON external_transfer_approvals(transfer_id);

-- --- Recurring Payment Schedules -------------------------------------------
-- Scheduled recurring external payments
CREATE TABLE IF NOT EXISTS recurring_payment_schedules (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id            INTEGER NOT NULL,
  from_account_id       INTEGER NOT NULL,
  payment_method_id     INTEGER,
  amount_cents          INTEGER NOT NULL,
  payment_type          TEXT NOT NULL DEFAULT 'vendor_payment',
  payment_method        TEXT NOT NULL DEFAULT 'ach',
  frequency             TEXT NOT NULL DEFAULT 'monthly',    -- weekly, bi_weekly, monthly, quarterly, annual
  description           TEXT,
  memo                  TEXT,
  invoice_prefix        TEXT,
  -- Schedule
  start_date            TEXT NOT NULL,
  end_date              TEXT,                               -- null = indefinite
  next_run_date         TEXT,
  last_run_date         TEXT,
  run_count             INTEGER NOT NULL DEFAULT 0,
  max_runs              INTEGER,                            -- null = unlimited
  -- Status
  status                TEXT NOT NULL DEFAULT 'active',     -- active, paused, completed, cancelled
  created_by            TEXT DEFAULT 'system',
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (contact_id)        REFERENCES crm_contacts(id),
  FOREIGN KEY (from_account_id)   REFERENCES trust_accounts(id),
  FOREIGN KEY (payment_method_id) REFERENCES crm_payment_methods(id)
);

CREATE INDEX IF NOT EXISTS idx_recurring_contact ON recurring_payment_schedules(contact_id);
CREATE INDEX IF NOT EXISTS idx_recurring_status ON recurring_payment_schedules(status);
CREATE INDEX IF NOT EXISTS idx_recurring_next ON recurring_payment_schedules(next_run_date);

-- --- Payment Files -----------------------------------------------------------
-- Generated NACHA ACH files and Wire messages stored for download/submission
CREATE TABLE IF NOT EXISTS payment_files (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id           INTEGER,                             -- external_transfers.id
  transfer_number       TEXT,                                -- EXT-YYYYMMDD-XXXX
  batch_id              TEXT,                                -- for batch files
  file_type             TEXT NOT NULL,                       -- nacha, wire, swift_mt103, fedwire
  filename              TEXT NOT NULL,                       -- generated filename
  content               TEXT NOT NULL,                       -- file content (NACHA/SWIFT/Fedwire text)
  metadata              TEXT,                                -- JSON metadata
  status                TEXT NOT NULL DEFAULT 'generated',   -- generated, submitted, acknowledged, rejected
  submitted_at          TEXT,
  acknowledged_at       TEXT,
  created_at            TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (transfer_id) REFERENCES external_transfers(id)
);

CREATE INDEX IF NOT EXISTS idx_payment_files_transfer ON payment_files(transfer_id);
CREATE INDEX IF NOT EXISTS idx_payment_files_batch ON payment_files(batch_id);
CREATE INDEX IF NOT EXISTS idx_payment_files_type ON payment_files(file_type);
