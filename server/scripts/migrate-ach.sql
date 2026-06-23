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

-- ─── Partner Registry ────────────────────────────────────────────────────────
-- Stores connection configs for multiple bank/merchant partners.
-- Supports both AS2 (EDI) and REST API transmission protocols.

CREATE TABLE IF NOT EXISTS as2_partners (
  id                  SERIAL PRIMARY KEY,
  partner_id          TEXT UNIQUE NOT NULL,
  partner_name        TEXT NOT NULL,
  protocol            TEXT NOT NULL DEFAULT 'as2'
                        CHECK (protocol IN ('as2','rest_api')),
  -- AS2 fields
  partner_url         TEXT NOT NULL,
  partner_as2_id      TEXT,
  local_as2_id        TEXT NOT NULL DEFAULT 'DLBTRUST-AS2',
  signing_cert_path   TEXT,
  signing_key_path    TEXT,
  partner_cert_path   TEXT,
  encryption_alg      TEXT NOT NULL DEFAULT 'aes256-cbc',
  signing_alg         TEXT NOT NULL DEFAULT 'sha256',
  request_mdn         BOOLEAN NOT NULL DEFAULT TRUE,
  mdn_url             TEXT,
  -- REST API fields
  api_base_url        TEXT,
  api_key             TEXT,
  api_secret          TEXT,
  api_auth_type       TEXT DEFAULT 'bearer'
                        CHECK (api_auth_type IN ('bearer','basic','api_key','hmac')),
  webhook_secret      TEXT,
  -- Common fields
  is_default          BOOLEAN NOT NULL DEFAULT FALSE,
  active              BOOLEAN NOT NULL DEFAULT TRUE,
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Idempotent column additions ────────────────────────────────────────────
-- These handle the case where tables were created by older migration versions
-- or by migrate-as2.sql with a different schema.

-- Ensure ach_entries has status column (defensive — should exist from CREATE TABLE)
ALTER TABLE ach_entries ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';

-- Add missing ach_batches lifecycle columns (added in PR #98)
ALTER TABLE ach_batches ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
ALTER TABLE ach_batches ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ;
ALTER TABLE ach_batches ADD COLUMN IF NOT EXISTS settlement_date DATE;
ALTER TABLE ach_batches ADD COLUMN IF NOT EXISTS return_code TEXT;
ALTER TABLE ach_batches ADD COLUMN IF NOT EXISTS return_reason TEXT;
ALTER TABLE ach_batches ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;
ALTER TABLE ach_batches ADD COLUMN IF NOT EXISTS partner_id TEXT;

-- Add missing as2_partners columns (migrate-as2.sql creates a different schema)
ALTER TABLE as2_partners ADD COLUMN IF NOT EXISTS partner_name TEXT;
ALTER TABLE as2_partners ADD COLUMN IF NOT EXISTS protocol TEXT NOT NULL DEFAULT 'as2';
ALTER TABLE as2_partners ADD COLUMN IF NOT EXISTS partner_url TEXT;
ALTER TABLE as2_partners ADD COLUMN IF NOT EXISTS partner_as2_id TEXT;
ALTER TABLE as2_partners ADD COLUMN IF NOT EXISTS local_as2_id TEXT NOT NULL DEFAULT 'DLBTRUST-AS2';
ALTER TABLE as2_partners ADD COLUMN IF NOT EXISTS signing_cert_path TEXT;
ALTER TABLE as2_partners ADD COLUMN IF NOT EXISTS signing_key_path TEXT;
ALTER TABLE as2_partners ADD COLUMN IF NOT EXISTS partner_cert_path TEXT;
ALTER TABLE as2_partners ADD COLUMN IF NOT EXISTS encryption_alg TEXT NOT NULL DEFAULT 'aes256-cbc';
ALTER TABLE as2_partners ADD COLUMN IF NOT EXISTS signing_alg TEXT NOT NULL DEFAULT 'sha256';
ALTER TABLE as2_partners ADD COLUMN IF NOT EXISTS mdn_url TEXT;
ALTER TABLE as2_partners ADD COLUMN IF NOT EXISTS api_base_url TEXT;
ALTER TABLE as2_partners ADD COLUMN IF NOT EXISTS api_key TEXT;
ALTER TABLE as2_partners ADD COLUMN IF NOT EXISTS api_secret TEXT;
ALTER TABLE as2_partners ADD COLUMN IF NOT EXISTS api_auth_type TEXT DEFAULT 'bearer';
ALTER TABLE as2_partners ADD COLUMN IF NOT EXISTS webhook_secret TEXT;
ALTER TABLE as2_partners ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE as2_partners ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE as2_partners ADD COLUMN IF NOT EXISTS notes TEXT;

-- Backfill partner_name from 'name' column if it exists (migrate-as2.sql uses 'name')
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'as2_partners' AND column_name = 'name'
  ) THEN
    UPDATE as2_partners SET partner_name = name WHERE partner_name IS NULL;
  END IF;
END $$;

-- Backfill partner_url from 'endpoint_url' column if it exists (migrate-as2.sql uses 'endpoint_url')
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'as2_partners' AND column_name = 'endpoint_url'
  ) THEN
    UPDATE as2_partners SET partner_url = endpoint_url WHERE partner_url IS NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ach_batches_status ON ach_batches(status);
CREATE INDEX IF NOT EXISTS idx_ach_batches_created ON ach_batches(created_at);
CREATE INDEX IF NOT EXISTS idx_ach_batches_partner ON ach_batches(partner_id);
CREATE INDEX IF NOT EXISTS idx_ach_entries_batch ON ach_entries(batch_id);
CREATE INDEX IF NOT EXISTS idx_ach_entries_status ON ach_entries(status);
CREATE INDEX IF NOT EXISTS idx_ach_transmissions_batch ON ach_transmissions(batch_id);
CREATE INDEX IF NOT EXISTS idx_ach_acknowledgements_batch ON ach_acknowledgements(batch_id);
CREATE INDEX IF NOT EXISTS idx_ach_returns_batch ON ach_returns(batch_id);
CREATE INDEX IF NOT EXISTS idx_ach_returns_entry ON ach_returns(entry_id);
CREATE INDEX IF NOT EXISTS idx_ach_reconciliations_date ON ach_reconciliations(run_date);
CREATE INDEX IF NOT EXISTS idx_as2_partners_active ON as2_partners(active);
CREATE INDEX IF NOT EXISTS idx_as2_partners_default ON as2_partners(is_default) WHERE is_default = TRUE;

-- ─── API Credentials ────────────────────────────────────────────────────────
-- API keys for authenticating to the DLBTrust platform REST API.

CREATE TABLE IF NOT EXISTS api_credentials (
  id              SERIAL PRIMARY KEY,
  key_id          TEXT UNIQUE NOT NULL,
  api_key         TEXT UNIQUE NOT NULL,
  api_secret_hash TEXT NOT NULL,
  label           TEXT NOT NULL,
  scopes          TEXT[] NOT NULL DEFAULT '{batches,partners,pipeline}',
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  last_used_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  created_by      TEXT NOT NULL DEFAULT 'admin',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  revoked_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_credentials_key ON api_credentials(api_key) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_api_credentials_active ON api_credentials(active);
