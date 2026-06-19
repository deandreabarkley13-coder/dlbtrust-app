-- ─────────────────────────────────────────────────────────────────────────────
-- Full PostgreSQL Migration — DLB Trust Platform
-- Run against the fineract_tenants database.
-- Creates CRM, Cash Management, Trustee, and Admin tables + seeds DLB-PRB bond.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Bonds (core table) ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bonds (
  id              SERIAL PRIMARY KEY,
  bond_name       TEXT UNIQUE NOT NULL,
  isin            TEXT,
  face_value      NUMERIC(18,2) NOT NULL DEFAULT 0,
  coupon_rate     NUMERIC(10,6) NOT NULL DEFAULT 0,
  issue_date      DATE NOT NULL,
  maturity_date   DATE NOT NULL,
  payment_freq    TEXT DEFAULT 'monthly' CHECK (payment_freq IN ('monthly','quarterly','semi-annual','annual')),
  day_count       TEXT DEFAULT '30/360',
  currency        TEXT DEFAULT 'USD',
  status          TEXT DEFAULT 'active' CHECK (status IN ('active','matured','called','defaulted')),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Bond Balances ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bond_balances (
  id                SERIAL PRIMARY KEY,
  bond_id           INTEGER NOT NULL REFERENCES bonds(id) ON DELETE CASCADE,
  principal_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  accrued_interest  NUMERIC(18,2) NOT NULL DEFAULT 0,
  last_accrual_date DATE,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Bond Transactions ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bond_transactions (
  id                SERIAL PRIMARY KEY,
  bond_id           INTEGER NOT NULL REFERENCES bonds(id) ON DELETE CASCADE,
  transaction_type  TEXT NOT NULL,
  amount            NUMERIC(18,2) NOT NULL,
  running_balance   NUMERIC(18,2),
  description       TEXT,
  transaction_date  DATE NOT NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Bond Trustees ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bond_trustees (
  id              SERIAL PRIMARY KEY,
  bond_id         INTEGER NOT NULL REFERENCES bonds(id) ON DELETE CASCADE,
  trustee_id      TEXT NOT NULL,
  trustee_name    TEXT,
  trustee_role    TEXT DEFAULT 'primary' CHECK (trustee_role IN ('primary','co-trustee','successor','special')),
  effective_date  DATE NOT NULL,
  end_date        DATE,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Cash Accounts ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cash_accounts (
  id                          SERIAL PRIMARY KEY,
  account_id                  TEXT UNIQUE NOT NULL,
  account_name                TEXT NOT NULL,
  account_type                TEXT NOT NULL CHECK (account_type IN ('operating','reserve','distribution','bond_proceeds','escrow','fee')),
  linked_fineract_account_id  TEXT,
  balance_cents               BIGINT DEFAULT 0,
  currency                    TEXT DEFAULT 'USD',
  status                      TEXT DEFAULT 'active' CHECK (status IN ('active','frozen','closed')),
  notes                       TEXT,
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Cash Movements ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cash_movements (
  id                SERIAL PRIMARY KEY,
  movement_id       TEXT UNIQUE NOT NULL,
  from_account_id   TEXT REFERENCES cash_accounts(account_id),
  to_account_id     TEXT REFERENCES cash_accounts(account_id),
  amount_cents      BIGINT NOT NULL CHECK (amount_cents > 0),
  movement_type     TEXT NOT NULL CHECK (movement_type IN ('transfer','bond_proceeds','interest_payment','principal_payment','distribution','fee','sweep','deposit','withdrawal')),
  reference_id      TEXT,
  reference_type    TEXT,
  gl_journal_id     TEXT,
  status            TEXT DEFAULT 'settled' CHECK (status IN ('pending','settled','reversed','failed')),
  memo              TEXT,
  initiated_by      TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  settled_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ─── CRM Contacts ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_contacts (
  id                    SERIAL PRIMARY KEY,
  contact_id            TEXT UNIQUE NOT NULL,
  contact_type          TEXT NOT NULL CHECK (contact_type IN ('investor','trustee','beneficiary','counterparty','advisor','legal','admin')),
  first_name            TEXT NOT NULL,
  last_name             TEXT NOT NULL,
  company               TEXT,
  email                 TEXT,
  phone                 TEXT,
  mailing_address       TEXT,
  date_of_birth         DATE,
  ssn_last4             TEXT,
  kyc_status            TEXT DEFAULT 'pending' CHECK (kyc_status IN ('pending','verified','failed','expired')),
  kyc_verified_at       TIMESTAMPTZ,
  aml_status            TEXT DEFAULT 'clear' CHECK (aml_status IN ('clear','flagged','blocked')),
  fineract_client_id    TEXT,
  linked_wallet_id      TEXT,
  preferred_payment     TEXT DEFAULT 'ach' CHECK (preferred_payment IN ('ach','wire','check','internal')),
  routing_number        TEXT,
  account_number        TEXT,
  bank_account_type     TEXT DEFAULT 'checking' CHECK (bank_account_type IN ('checking','savings')),
  bank_name             TEXT,
  status                TEXT DEFAULT 'active' CHECK (status IN ('active','inactive','blocked')),
  notes                 TEXT,
  tags                  TEXT[],
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ─── CRM Interactions ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_interactions (
  id              SERIAL PRIMARY KEY,
  interaction_id  TEXT UNIQUE NOT NULL,
  contact_id      TEXT NOT NULL REFERENCES crm_contacts(contact_id) ON DELETE CASCADE,
  interaction_type TEXT NOT NULL CHECK (interaction_type IN ('call','email','meeting','note','document','distribution','payment')),
  subject         TEXT,
  body            TEXT,
  direction       TEXT CHECK (direction IN ('inbound','outbound','internal')),
  outcome         TEXT,
  follow_up_date  DATE,
  created_by      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── CRM Bond Subscriptions ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_bond_subscriptions (
  id                  SERIAL PRIMARY KEY,
  subscription_id     TEXT UNIQUE NOT NULL,
  contact_id          TEXT NOT NULL REFERENCES crm_contacts(contact_id),
  bond_id             INTEGER NOT NULL REFERENCES bonds(id),
  subscription_amount NUMERIC(18,2) NOT NULL,
  offering_price      NUMERIC(10,6) DEFAULT 1.0,
  settlement_date     DATE NOT NULL,
  status              TEXT DEFAULT 'active' CHECK (status IN ('pending','active','redeemed','cancelled')),
  cash_account_id     TEXT REFERENCES cash_accounts(account_id),
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Admin Audit Log ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id            SERIAL PRIMARY KEY,
  admin_user    TEXT,
  action        TEXT NOT NULL,
  resource_type TEXT,
  resource_id   TEXT,
  payload       JSONB,
  result        JSONB,
  ip_address    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Seed DLB-PRB Bond ────────────────────────────────────────────────────────
-- Only insert if it doesn't already exist
INSERT INTO bonds (bond_name, isin, face_value, coupon_rate, issue_date, maturity_date, payment_freq, day_count, currency, status)
SELECT 'DLB-PRB', 'US-DLB-PRB-2024', 100000000.00, 0.01, '2024-02-28', '2124-02-28', 'monthly', '30/360', 'USD', 'active'
WHERE NOT EXISTS (SELECT 1 FROM bonds WHERE bond_name = 'DLB-PRB');

-- Initialize bond_balances for DLB-PRB
INSERT INTO bond_balances (bond_id, principal_balance, accrued_interest, last_accrual_date)
SELECT id, 100000000.00, 0, '2024-02-28'
FROM bonds WHERE bond_name = 'DLB-PRB'
AND NOT EXISTS (SELECT 1 FROM bond_balances WHERE bond_id = (SELECT id FROM bonds WHERE bond_name = 'DLB-PRB'));

-- Record initial issuance transaction for DLB-PRB
INSERT INTO bond_transactions (bond_id, transaction_type, amount, running_balance, description, transaction_date)
SELECT id, 'issuance', 100000000.00, 100000000.00, 'DLB-PRB Private Placement Bond — Initial Issuance $100M face value @ 1% coupon, 100-year term', '2024-02-28'
FROM bonds WHERE bond_name = 'DLB-PRB'
AND NOT EXISTS (SELECT 1 FROM bond_transactions WHERE bond_id = (SELECT id FROM bonds WHERE bond_name = 'DLB-PRB') AND transaction_type = 'issuance');

-- Seed default cash accounts for DLB-PRB operations
INSERT INTO cash_accounts (account_id, account_name, account_type, balance_cents, notes)
VALUES
  ('CA-BOND-PROCEEDS', 'DLB-PRB Bond Proceeds', 'bond_proceeds', 10000000000, 'Primary bond proceeds account — $100M face value'),
  ('CA-OPERATING',     'Trust Operating Account', 'operating', 0, 'Day-to-day trust operations'),
  ('CA-RESERVE',       'Trust Reserve Account', 'reserve', 0, 'Liquidity reserve'),
  ('CA-DISTRIBUTION',  'Beneficiary Distribution Account', 'distribution', 0, 'Staging account for beneficiary distributions'),
  ('CA-ESCROW',        'Trustee Escrow Account', 'escrow', 0, 'Trustee-controlled escrow'),
  ('CA-FEE',           'Management Fee Account', 'fee', 0, 'Trust management fees')
ON CONFLICT (account_id) DO NOTHING;
