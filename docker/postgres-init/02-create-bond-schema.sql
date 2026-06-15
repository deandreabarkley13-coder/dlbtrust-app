-- Fixed Income Engine — Bond Schema
-- Creates tables in fineract_tenants DB for the private placement bond.
-- Runs during PostgreSQL container init (docker-entrypoint-initdb.d).

-- ─── Bonds ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bonds (
  id              SERIAL PRIMARY KEY,
  bond_name       VARCHAR(255) NOT NULL,
  isin            VARCHAR(20),
  face_value      NUMERIC(18,2) NOT NULL,
  coupon_rate     NUMERIC(8,6) NOT NULL,          -- annual rate as decimal (e.g. 0.055 = 5.5%)
  issue_date      DATE NOT NULL,
  maturity_date   DATE NOT NULL,
  payment_freq    VARCHAR(20) NOT NULL DEFAULT 'monthly',  -- daily|monthly|quarterly|semi_annual|annual
  day_count       VARCHAR(20) NOT NULL DEFAULT '30/360',   -- 30/360|ACT/ACT|ACT/360
  currency        VARCHAR(3) NOT NULL DEFAULT 'USD',
  status          VARCHAR(20) NOT NULL DEFAULT 'active',   -- active|matured|called|defaulted
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Bond Balances (running state) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bond_balances (
  id                   SERIAL PRIMARY KEY,
  bond_id              INTEGER NOT NULL REFERENCES bonds(id),
  principal_balance    NUMERIC(18,2) NOT NULL,
  accrued_interest     NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_interest_paid  NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_principal_paid NUMERIC(18,2) NOT NULL DEFAULT 0,
  last_accrual_date    DATE,
  last_payment_date    DATE,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(bond_id)
);

-- ─── Bond Transactions (immutable ledger) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS bond_transactions (
  id               SERIAL PRIMARY KEY,
  bond_id          INTEGER NOT NULL REFERENCES bonds(id),
  transaction_type VARCHAR(30) NOT NULL,           -- interest_accrual|interest_payment|principal_payment|maturity
  amount           NUMERIC(18,2) NOT NULL,
  running_balance  NUMERIC(18,2) NOT NULL,
  accrued_interest NUMERIC(18,2) NOT NULL DEFAULT 0,
  description      TEXT,
  fineract_txn_id  VARCHAR(100),                   -- links to Fineract journal entry
  transaction_date DATE NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_bond_txn_bond_id ON bond_transactions(bond_id);
CREATE INDEX IF NOT EXISTS idx_bond_txn_date ON bond_transactions(transaction_date);
CREATE INDEX IF NOT EXISTS idx_bond_txn_type ON bond_transactions(transaction_type);
