-- DLB Trust PostgreSQL Schema Migration
-- Idempotent — safe to run multiple times (uses IF NOT EXISTS)

CREATE TABLE IF NOT EXISTS wallets (
  id              SERIAL PRIMARY KEY,
  wallet_id       TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  holder_name     TEXT,
  role            TEXT NOT NULL DEFAULT 'beneficiary',
  fiat_balance    BIGINT NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'USD',
  status          TEXT NOT NULL DEFAULT 'active',
  email           TEXT,
  phone           TEXT,
  public_address  TEXT,
  routing_number  TEXT,
  account_number  TEXT,
  account_type    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id                      SERIAL PRIMARY KEY,
  wallet_id               TEXT REFERENCES wallets(wallet_id),
  type                    TEXT NOT NULL,
  category                TEXT,
  amount                  BIGINT NOT NULL,
  balance_before          BIGINT,
  balance_after           BIGINT,
  description             TEXT,
  payment_method          TEXT,
  from_wallet_id          TEXT,
  to_wallet_id            TEXT,
  counterparty_wallet_id  TEXT,
  reference_id            TEXT,
  status                  TEXT NOT NULL DEFAULT 'pending',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS disbursements (
  id                    SERIAL PRIMARY KEY,
  payment_schedule_id   TEXT NOT NULL,
  external_account_id   TEXT NOT NULL,
  payment_profile_id    TEXT NOT NULL,
  amount                NUMERIC(12,2) NOT NULL,
  send_date             DATE NOT NULL,
  beneficiary_name      TEXT,
  status                TEXT NOT NULL DEFAULT 'scheduled',
  created_by            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bonds (
  id              SERIAL PRIMARY KEY,
  bond_name       TEXT NOT NULL,
  issuer          TEXT NOT NULL DEFAULT 'DEANDREA LAVAR BARKLEY TRUST',
  face_value      NUMERIC(14,2) NOT NULL,
  coupon_rate     NUMERIC(6,4) NOT NULL,
  frequency       TEXT NOT NULL DEFAULT 'semi-annual',
  issue_date      DATE NOT NULL,
  maturity_date   DATE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bond_allocations (
  id              SERIAL PRIMARY KEY,
  bond_id         INTEGER NOT NULL REFERENCES bonds(id),
  wallet_id       TEXT NOT NULL,
  beneficiary_name TEXT,
  allocation_pct  NUMERIC(5,2) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bond_payments (
  id              SERIAL PRIMARY KEY,
  bond_id         INTEGER NOT NULL REFERENCES bonds(id),
  allocation_id   INTEGER REFERENCES bond_allocations(id),
  payment_date    DATE NOT NULL,
  interest_amount NUMERIC(12,2) NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  reference_id    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_transactions_wallet    ON transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status    ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_category  ON transactions(category);
CREATE INDEX IF NOT EXISTS idx_transactions_created   ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_disbursements_profile  ON disbursements(payment_profile_id);
CREATE INDEX IF NOT EXISTS idx_disbursements_status   ON disbursements(status);
CREATE INDEX IF NOT EXISTS idx_disbursements_date     ON disbursements(send_date);
CREATE INDEX IF NOT EXISTS idx_bonds_status           ON bonds(status);
CREATE INDEX IF NOT EXISTS idx_bond_alloc_bond        ON bond_allocations(bond_id);
CREATE INDEX IF NOT EXISTS idx_bond_payments_bond     ON bond_payments(bond_id);
