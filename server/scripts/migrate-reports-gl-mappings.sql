-- ---------------------------------------------------------------------------
-- Report Jobs & Fineract GL Account Mappings Migration
-- DLB Trust Platform
-- Run against the fineract_tenants database.
-- ---------------------------------------------------------------------------

-- === Report Jobs ============================================================
-- Stores generated report / statement outputs for retrieval and delivery.

CREATE TABLE IF NOT EXISTS report_jobs (
  id              SERIAL PRIMARY KEY,
  job_id          TEXT UNIQUE NOT NULL,
  report_type     TEXT NOT NULL CHECK (report_type IN (
    'balance_sheet','income_statement','cashflow',
    'trial_balance','bond_statement'
  )),
  parameters      JSONB DEFAULT '{}',
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
  output_format   TEXT DEFAULT 'html' CHECK (output_format IN ('html','json','csv','pdf')),
  rendered_output TEXT,
  error_message   TEXT,
  generated_by    TEXT,
  generated_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_report_jobs_type ON report_jobs(report_type);
CREATE INDEX IF NOT EXISTS idx_report_jobs_status ON report_jobs(status);
CREATE INDEX IF NOT EXISTS idx_report_jobs_generated ON report_jobs(generated_at);

-- === Fineract GL Account Mappings ===========================================
-- Maps internal trust account codes to Fineract GL account IDs so the engines
-- can look up the correct GL posting targets automatically.

CREATE TABLE IF NOT EXISTS fineract_gl_mappings (
  id                  SERIAL PRIMARY KEY,
  mapping_type        TEXT NOT NULL CHECK (mapping_type IN (
    'bond_accrual_debit','bond_accrual_credit',
    'bond_interest_debit','bond_interest_credit',
    'bond_principal_debit','bond_principal_credit',
    'cash_transfer_debit','cash_transfer_credit',
    'trust_journal','custom'
  )),
  trust_account_code  TEXT,
  bond_id             INTEGER REFERENCES bonds(id),
  cash_account_id     TEXT,
  fineract_gl_id      INTEGER NOT NULL,
  description         TEXT,
  is_active           BOOLEAN DEFAULT TRUE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gl_mappings_type ON fineract_gl_mappings(mapping_type);
CREATE INDEX IF NOT EXISTS idx_gl_mappings_bond ON fineract_gl_mappings(bond_id);
CREATE INDEX IF NOT EXISTS idx_gl_mappings_trust ON fineract_gl_mappings(trust_account_code);
CREATE INDEX IF NOT EXISTS idx_gl_mappings_active ON fineract_gl_mappings(is_active);
