-- ─── ACH Batch Tracking ──────────────────────────────────────────────────────
-- Tracks NACHA file generation, AS2 transmission, and settlement status

CREATE TABLE IF NOT EXISTS ach_batches (
  id                  SERIAL PRIMARY KEY,
  batch_id            TEXT UNIQUE NOT NULL,
  filename            TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','transmitting','transmitted','accepted','settled','returned','failed','cancelled')),
  sec_code            TEXT NOT NULL DEFAULT 'CCD'
                        CHECK (sec_code IN ('CCD','PPD','CTX','WEB','TEL')),
  entry_description   TEXT DEFAULT 'PAYMENT',
  effective_date      DATE NOT NULL,
  entry_count         INTEGER NOT NULL DEFAULT 0,
  total_amount_cents  BIGINT NOT NULL DEFAULT 0,
  nacha_content       TEXT,
  file_path           TEXT,
  error_message       TEXT,
  created_by          TEXT DEFAULT 'system',
  transmitted_at      TIMESTAMPTZ,
  accepted_at         TIMESTAMPTZ,
  settled_at          TIMESTAMPTZ,
  returned_at         TIMESTAMPTZ,
  settlement_date     DATE,
  return_code         TEXT,
  return_reason       TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ─── ACH Entry Details ───────────────────────────────────────────────────────
-- Individual entries within a NACHA batch

CREATE TABLE IF NOT EXISTS ach_entries (
  id                  SERIAL PRIMARY KEY,
  batch_id            TEXT NOT NULL REFERENCES ach_batches(batch_id) ON DELETE CASCADE,
  entry_sequence      INTEGER NOT NULL,
  transaction_code    TEXT NOT NULL DEFAULT '22',
  receiving_routing   TEXT NOT NULL,
  account_number      TEXT NOT NULL,
  amount_cents        BIGINT NOT NULL,
  individual_id       TEXT,
  individual_name     TEXT,
  memo                TEXT,
  trace_number        TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','transmitted','accepted','settled','returned')),
  return_code         TEXT,
  return_reason       TEXT,
  returned_at         TIMESTAMPTZ,
  settled_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ─── ACH Transmission Log ────────────────────────────────────────────────────
-- Records each AS2 transmission attempt

CREATE TABLE IF NOT EXISTS ach_transmissions (
  id                  SERIAL PRIMARY KEY,
  batch_id            TEXT NOT NULL REFERENCES ach_batches(batch_id) ON DELETE CASCADE,
  transmission_id     TEXT UNIQUE NOT NULL,
  message_id          TEXT,
  status_code         INTEGER,
  mdn_received        BOOLEAN DEFAULT FALSE,
  mdn_content         TEXT,
  response_body       TEXT,
  error_message       TEXT,
  transmitted_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── ACH Bank Acknowledgements ───────────────────────────────────────────────
-- Records bank acceptance / delivery acknowledgement (MDN) separately from settlement

CREATE TABLE IF NOT EXISTS ach_acknowledgements (
  id                  SERIAL PRIMARY KEY,
  batch_id            TEXT NOT NULL REFERENCES ach_batches(batch_id) ON DELETE CASCADE,
  transmission_id     TEXT REFERENCES ach_transmissions(transmission_id),
  ack_type            TEXT NOT NULL DEFAULT 'mdn'
                        CHECK (ack_type IN ('mdn','file_ack','bank_ack','rejection')),
  ack_status          TEXT NOT NULL DEFAULT 'accepted'
                        CHECK (ack_status IN ('accepted','rejected','partial')),
  message_id          TEXT,
  raw_response        TEXT,
  disposition         TEXT,
  error_description   TEXT,
  received_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ─── ACH Returns ─────────────────────────────────────────────────────────────
-- Tracks ACH returns from the bank at the entry level

CREATE TABLE IF NOT EXISTS ach_returns (
  id                  SERIAL PRIMARY KEY,
  batch_id            TEXT NOT NULL REFERENCES ach_batches(batch_id) ON DELETE CASCADE,
  entry_id            INTEGER REFERENCES ach_entries(id),
  original_trace      TEXT,
  return_code         TEXT NOT NULL,
  return_reason       TEXT NOT NULL,
  return_amount_cents BIGINT,
  return_date         DATE,
  addenda_info        TEXT,
  return_file_ref     TEXT,
  processed_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ─── ACH Reconciliation Runs ─────────────────────────────────────────────────
-- Records settlement reconciliation job results

CREATE TABLE IF NOT EXISTS ach_reconciliations (
  id                  SERIAL PRIMARY KEY,
  reconciliation_id   TEXT UNIQUE NOT NULL,
  run_date            TIMESTAMPTZ DEFAULT NOW(),
  batches_checked     INTEGER NOT NULL DEFAULT 0,
  batches_settled     INTEGER NOT NULL DEFAULT 0,
  batches_returned    INTEGER NOT NULL DEFAULT 0,
  entries_settled     INTEGER NOT NULL DEFAULT 0,
  entries_returned    INTEGER NOT NULL DEFAULT 0,
  total_settled_cents BIGINT NOT NULL DEFAULT 0,
  total_returned_cents BIGINT NOT NULL DEFAULT 0,
  discrepancies       TEXT,
  status              TEXT NOT NULL DEFAULT 'completed'
                        CHECK (status IN ('running','completed','failed')),
  completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ach_batches_status ON ach_batches(status);
CREATE INDEX IF NOT EXISTS idx_ach_batches_created ON ach_batches(created_at);
CREATE INDEX IF NOT EXISTS idx_ach_entries_batch ON ach_entries(batch_id);
CREATE INDEX IF NOT EXISTS idx_ach_entries_status ON ach_entries(status);
CREATE INDEX IF NOT EXISTS idx_ach_transmissions_batch ON ach_transmissions(batch_id);
CREATE INDEX IF NOT EXISTS idx_ach_acknowledgements_batch ON ach_acknowledgements(batch_id);
CREATE INDEX IF NOT EXISTS idx_ach_returns_batch ON ach_returns(batch_id);
CREATE INDEX IF NOT EXISTS idx_ach_returns_entry ON ach_returns(entry_id);
CREATE INDEX IF NOT EXISTS idx_ach_reconciliations_date ON ach_reconciliations(run_date);
