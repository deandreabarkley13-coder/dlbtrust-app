-- ─────────────────────────────────────────────────────────────────────────────
-- Tax Engine Migration — DLB Trust Platform
-- Creates tables for Form 1041 tax returns, K-1 schedules, and trust config.
-- Run against fineract_tenants database.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Trust Configuration ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trust_config (
  id              SERIAL PRIMARY KEY,
  config_key      TEXT UNIQUE NOT NULL,
  config_value    TEXT NOT NULL,
  description     TEXT,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Seed trust EIN
INSERT INTO trust_config (config_key, config_value, description)
VALUES ('ein', '99-6411566', 'Trust Employer Identification Number')
ON CONFLICT (config_key) DO NOTHING;

INSERT INTO trust_config (config_key, config_value, description)
VALUES ('trust_name', 'DEANDREA LAVAR BARKLEY TRUST', 'Legal trust name for tax filings')
ON CONFLICT (config_key) DO NOTHING;

INSERT INTO trust_config (config_key, config_value, description)
VALUES ('trust_type', 'complex', 'Trust type: simple or complex')
ON CONFLICT (config_key) DO NOTHING;

INSERT INTO trust_config (config_key, config_value, description)
VALUES ('fiscal_year_end', '12-31', 'Fiscal year end (MM-DD)')
ON CONFLICT (config_key) DO NOTHING;

INSERT INTO trust_config (config_key, config_value, description)
VALUES ('state', 'GA', 'Trust domicile state')
ON CONFLICT (config_key) DO NOTHING;

-- ─── Tax Returns (Form 1041) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tax_returns_1041 (
  id                      SERIAL PRIMARY KEY,
  return_id               TEXT UNIQUE NOT NULL,
  tax_year                INTEGER NOT NULL,
  status                  TEXT DEFAULT 'draft' CHECK (status IN ('draft','computed','filed','amended')),
  -- Income (Part I of Form 1041)
  interest_income         NUMERIC(18,2) DEFAULT 0,
  dividend_income         NUMERIC(18,2) DEFAULT 0,
  capital_gains           NUMERIC(18,2) DEFAULT 0,
  rental_income           NUMERIC(18,2) DEFAULT 0,
  other_income            NUMERIC(18,2) DEFAULT 0,
  total_income            NUMERIC(18,2) DEFAULT 0,
  -- Deductions
  trustee_fees            NUMERIC(18,2) DEFAULT 0,
  legal_fees              NUMERIC(18,2) DEFAULT 0,
  tax_prep_fees           NUMERIC(18,2) DEFAULT 0,
  other_deductions        NUMERIC(18,2) DEFAULT 0,
  total_deductions        NUMERIC(18,2) DEFAULT 0,
  -- Distribution deduction & DNI
  distributable_net_income NUMERIC(18,2) DEFAULT 0,
  income_distribution_deduction NUMERIC(18,2) DEFAULT 0,
  -- Tax computation
  adjusted_total_income   NUMERIC(18,2) DEFAULT 0,
  personal_exemption      NUMERIC(18,2) DEFAULT 0,
  taxable_income          NUMERIC(18,2) DEFAULT 0,
  tax_liability           NUMERIC(18,2) DEFAULT 0,
  estimated_payments      NUMERIC(18,2) DEFAULT 0,
  tax_due                 NUMERIC(18,2) DEFAULT 0,
  -- Metadata
  ein                     TEXT DEFAULT '99-6411566',
  trust_name              TEXT DEFAULT 'DEANDREA LAVAR BARKLEY TRUST',
  computed_at             TIMESTAMPTZ,
  filed_at                TIMESTAMPTZ,
  notes                   TEXT,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tax_returns_year ON tax_returns_1041(tax_year);

-- ─── K-1 Schedules (per beneficiary) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS k1_schedules (
  id                      SERIAL PRIMARY KEY,
  k1_id                   TEXT UNIQUE NOT NULL,
  return_id               TEXT NOT NULL REFERENCES tax_returns_1041(return_id) ON DELETE CASCADE,
  tax_year                INTEGER NOT NULL,
  beneficiary_contact_id  TEXT NOT NULL,
  beneficiary_name        TEXT NOT NULL,
  beneficiary_tin_last4   TEXT,
  -- Allocation
  allocation_percentage   NUMERIC(10,6) NOT NULL DEFAULT 0,
  -- K-1 income items (Part III)
  interest_income         NUMERIC(18,2) DEFAULT 0,
  dividend_income         NUMERIC(18,2) DEFAULT 0,
  capital_gains           NUMERIC(18,2) DEFAULT 0,
  rental_income           NUMERIC(18,2) DEFAULT 0,
  other_income            NUMERIC(18,2) DEFAULT 0,
  total_income            NUMERIC(18,2) DEFAULT 0,
  -- K-1 deduction items
  deductions              NUMERIC(18,2) DEFAULT 0,
  -- Distributions
  distributions_paid      NUMERIC(18,2) DEFAULT 0,
  -- Status
  status                  TEXT DEFAULT 'draft' CHECK (status IN ('draft','computed','issued','amended')),
  issued_at               TIMESTAMPTZ,
  notes                   TEXT,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_k1_return ON k1_schedules(return_id);
CREATE INDEX IF NOT EXISTS idx_k1_beneficiary ON k1_schedules(beneficiary_contact_id);
CREATE INDEX IF NOT EXISTS idx_k1_year ON k1_schedules(tax_year);

-- Clean up any duplicate K-1 rows from prior buggy upsert (ON CONFLICT k1_id never triggered)
DELETE FROM k1_schedules a USING k1_schedules b
WHERE a.return_id = b.return_id
  AND a.beneficiary_contact_id = b.beneficiary_contact_id
  AND a.id < b.id;

-- Unique constraint for upsert on K-1 regeneration (prevents duplicate rows per beneficiary per return)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_k1_return_beneficiary') THEN
    ALTER TABLE k1_schedules ADD CONSTRAINT uq_k1_return_beneficiary UNIQUE (return_id, beneficiary_contact_id);
  END IF;
END $$;

-- ─── Tax Payments / Estimated Payments ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS tax_payments (
  id              SERIAL PRIMARY KEY,
  payment_id      TEXT UNIQUE NOT NULL,
  tax_year        INTEGER NOT NULL,
  quarter         INTEGER CHECK (quarter IN (1, 2, 3, 4)),
  payment_type    TEXT NOT NULL CHECK (payment_type IN ('estimated','extension','final','overpayment')),
  amount          NUMERIC(18,2) NOT NULL,
  payment_date    DATE NOT NULL,
  reference       TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tax_payments_year ON tax_payments(tax_year);
