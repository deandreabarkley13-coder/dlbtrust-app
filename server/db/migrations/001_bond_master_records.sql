-- 001_bond_master_records.sql
-- Private Placement Bond Master Record schema

-- Trust Accounts
CREATE TABLE IF NOT EXISTS trust_accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trust_name    TEXT NOT NULL,
  trustee_name  TEXT NOT NULL,
  beneficiary_ids JSONB DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bond Master Records
CREATE TABLE IF NOT EXISTS bond_master_records (
  bond_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cusip             VARCHAR(9),
  issuer_name       TEXT NOT NULL,
  trust_account_id  UUID REFERENCES trust_accounts(id),
  face_value        NUMERIC(18,2) NOT NULL,
  coupon_rate       NUMERIC(8,6) NOT NULL,
  maturity_date     DATE NOT NULL,
  issue_date        DATE NOT NULL,
  fineract_loan_id  TEXT,
  fineract_gl_id    TEXT,
  obp_account_id    TEXT,
  cash_position     NUMERIC(18,2) DEFAULT 0,
  accrued_interest  NUMERIC(18,2) DEFAULT 0,
  last_payment_date DATE,
  next_payment_date DATE,
  prospectus_doc_id UUID,
  indenture_doc_id  UUID,
  last_sftp_file    TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_module TEXT
);

-- Bond Documents
CREATE TABLE IF NOT EXISTS bond_documents (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bond_id   UUID NOT NULL REFERENCES bond_master_records(bond_id) ON DELETE CASCADE,
  doc_type  TEXT NOT NULL,
  file_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Audit log for bond updates
CREATE TABLE IF NOT EXISTS bond_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  bond_id     UUID NOT NULL REFERENCES bond_master_records(bond_id) ON DELETE CASCADE,
  source      TEXT NOT NULL,
  changes     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_bond_cusip ON bond_master_records(cusip);
CREATE INDEX IF NOT EXISTS idx_bond_trust_account ON bond_master_records(trust_account_id);
CREATE INDEX IF NOT EXISTS idx_bond_docs_bond_id ON bond_documents(bond_id);
CREATE INDEX IF NOT EXISTS idx_bond_audit_bond_id ON bond_audit_log(bond_id);
