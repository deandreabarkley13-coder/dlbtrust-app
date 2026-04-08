-- OpenACH Disbursement Logging Table
-- Add to dlbtrust.cloud SQLite database
-- Run once on the server: sqlite3 /path/to/dlbtrust.db < db-migration.sql

CREATE TABLE IF NOT EXISTS disbursements (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_schedule_id   TEXT NOT NULL,
  external_account_id   TEXT NOT NULL,
  payment_profile_id    TEXT NOT NULL,
  amount                REAL NOT NULL,
  send_date             TEXT NOT NULL,
  beneficiary_name      TEXT,
  status                TEXT DEFAULT 'scheduled',  -- scheduled, processed, returned, cancelled
  created_by            TEXT,
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_disbursements_profile ON disbursements(payment_profile_id);
CREATE INDEX IF NOT EXISTS idx_disbursements_status  ON disbursements(status);
CREATE INDEX IF NOT EXISTS idx_disbursements_date    ON disbursements(send_date);
