-- PostgreSQL Schema for dlbtrust-app
-- Run against Supabase: psql $DATABASE_URL -f db-migration.sql

-- ─── Wallets ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallets (
  id                SERIAL PRIMARY KEY,
  wallet_id         TEXT UNIQUE NOT NULL,
  name              TEXT NOT NULL,
  holder_name       TEXT,
  role              TEXT NOT NULL DEFAULT 'beneficiary',  -- trust_entity, trustee, beneficiary
  fiat_balance      BIGINT NOT NULL DEFAULT 0,            -- cents
  currency          TEXT NOT NULL DEFAULT 'USD',
  status            TEXT NOT NULL DEFAULT 'active',
  email             TEXT,
  phone             TEXT,
  public_address    TEXT,
  routing_number    TEXT,
  account_number    TEXT,
  account_type      TEXT DEFAULT 'checking',
  kyc_verified      BOOLEAN DEFAULT FALSE,
  ssn_encrypted     TEXT,
  date_of_birth     TEXT,
  mailing_address   TEXT,
  preferred_payment_method TEXT DEFAULT 'ach',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallets_role ON wallets(role);
CREATE INDEX IF NOT EXISTS idx_wallets_wallet_id ON wallets(wallet_id);

-- ─── Transactions ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id                    SERIAL PRIMARY KEY,
  wallet_id             INTEGER REFERENCES wallets(id),
  type                  TEXT NOT NULL,                       -- transfer_in, transfer_out, deposit, etc.
  amount                BIGINT NOT NULL,                     -- cents; negative = debit
  balance_before        BIGINT,
  balance_after         BIGINT,
  description           TEXT,
  category              TEXT,                                -- distribution, corpus, fee, interest, investment
  payment_method        TEXT,                                -- ach, wire, internal, check
  from_wallet_id        TEXT,
  to_wallet_id          TEXT,
  counterparty_wallet_id TEXT,
  reference_id          TEXT,
  status                TEXT NOT NULL DEFAULT 'pending',     -- pending, completed, failed, cancelled
  is_test               BOOLEAN DEFAULT FALSE,
  beneficiary_split     JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_wallet_id ON transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_from_wallet ON transactions(from_wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_to_wallet ON transactions(to_wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);

-- ─── Disbursements ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS disbursements (
  id                    SERIAL PRIMARY KEY,
  payment_schedule_id   TEXT NOT NULL,
  external_account_id   TEXT NOT NULL,
  payment_profile_id    TEXT NOT NULL,
  amount                NUMERIC(12,2) NOT NULL,
  send_date             TEXT NOT NULL,
  beneficiary_name      TEXT,
  status                TEXT DEFAULT 'scheduled',            -- scheduled, processed, returned, cancelled
  created_by            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_disbursements_profile ON disbursements(payment_profile_id);
CREATE INDEX IF NOT EXISTS idx_disbursements_status  ON disbursements(status);
CREATE INDEX IF NOT EXISTS idx_disbursements_date    ON disbursements(send_date);

-- ─── Bonds ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bonds (
  id                SERIAL PRIMARY KEY,
  bond_name         TEXT NOT NULL,
  issuer            TEXT,
  face_value        NUMERIC(14,2) NOT NULL DEFAULT 0,
  coupon_rate       NUMERIC(6,4),                            -- e.g. 0.0525 = 5.25%
  maturity_date     DATE,
  purchase_date     DATE,
  purchase_price    NUMERIC(14,2),
  current_value     NUMERIC(14,2),
  status            TEXT NOT NULL DEFAULT 'active',           -- active, matured, sold
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Bond Allocations ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bond_allocations (
  id                SERIAL PRIMARY KEY,
  bond_id           INTEGER REFERENCES bonds(id),
  wallet_id         INTEGER REFERENCES wallets(id),
  allocation_pct    NUMERIC(5,2) NOT NULL,                   -- e.g. 25.00 = 25%
  allocated_value   NUMERIC(14,2),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bond_allocations_bond ON bond_allocations(bond_id);
CREATE INDEX IF NOT EXISTS idx_bond_allocations_wallet ON bond_allocations(wallet_id);

-- ─── Bond Payments ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bond_payments (
  id                SERIAL PRIMARY KEY,
  bond_id           INTEGER REFERENCES bonds(id),
  payment_date      DATE NOT NULL,
  payment_amount    NUMERIC(14,2) NOT NULL,
  payment_type      TEXT NOT NULL DEFAULT 'coupon',           -- coupon, principal, maturity
  status            TEXT NOT NULL DEFAULT 'pending',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bond_payments_bond ON bond_payments(bond_id);
CREATE INDEX IF NOT EXISTS idx_bond_payments_date ON bond_payments(payment_date);
