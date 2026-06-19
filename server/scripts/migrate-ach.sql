-- ─── ACH Batch Tracking ──────────────────────────────────────────────────────
-- Tracks NACHA file generation, AS2 transmission, and settlement status

CREATE TABLE IF NOT EXISTS ach_batches (
  id                  SERIAL PRIMARY KEY,
  batch_id            TEXT UNIQUE NOT NULL,
  filename            TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','transmitting','transmitted','settled','returned','failed','cancelled')),
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
  settled_at          TIMESTAMPTZ,
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
  return_code         TEXT,
  return_reason       TEXT,
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

CREATE INDEX IF NOT EXISTS idx_ach_batches_status ON ach_batches(status);
CREATE INDEX IF NOT EXISTS idx_ach_batches_created ON ach_batches(created_at);
CREATE INDEX IF NOT EXISTS idx_ach_entries_batch ON ach_entries(batch_id);
CREATE INDEX IF NOT EXISTS idx_ach_transmissions_batch ON ach_transmissions(batch_id);
