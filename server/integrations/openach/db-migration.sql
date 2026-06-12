-- PostgreSQL schema for dlbtrust-app
-- Run once against your Supabase database

CREATE TABLE IF NOT EXISTS wallets (
  id                        SERIAL PRIMARY KEY,
  wallet_id                 TEXT UNIQUE NOT NULL,
  name                      TEXT,
  holder_name               TEXT,
  role                      TEXT,  -- 'trust_entity' | 'trustee' | 'beneficiary'
  fiat_balance              INTEGER DEFAULT 0,  -- cents
  currency                  TEXT DEFAULT 'USD',
  status                    TEXT DEFAULT 'active',
  email                     TEXT,
  phone                     TEXT,
  public_address            TEXT,
  routing_number            TEXT,
  account_number            TEXT,
  account_type              TEXT DEFAULT 'checking',
  kyc_verified              INTEGER DEFAULT 0,
  ssn_encrypted             TEXT,
  date_of_birth             TEXT,
  mailing_address           TEXT,
  preferred_payment_method  TEXT DEFAULT 'ach',
  created_at                TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id                      SERIAL PRIMARY KEY,
  wallet_id               INTEGER REFERENCES wallets(id),
  type                    TEXT,
  amount                  INTEGER,  -- cents; negative = debit
  balance_before          INTEGER,
  balance_after           INTEGER,
  description             TEXT,
  category                TEXT,
  payment_method          TEXT,
  from_wallet_id          TEXT,
  to_wallet_id            TEXT,
  counterparty_wallet_id  TEXT,
  reference_id            TEXT,
  status                  TEXT DEFAULT 'pending',
  is_test                 INTEGER DEFAULT 0,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS disbursements (
  id                    SERIAL PRIMARY KEY,
  payment_schedule_id   TEXT NOT NULL,
  external_account_id   TEXT NOT NULL,
  payment_profile_id    TEXT NOT NULL,
  amount                NUMERIC NOT NULL,
  send_date             TEXT NOT NULL,
  beneficiary_name      TEXT,
  status                TEXT DEFAULT 'scheduled',
  created_by            TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_disbursements_profile ON disbursements(payment_profile_id);
CREATE INDEX IF NOT EXISTS idx_disbursements_status  ON disbursements(status);
CREATE INDEX IF NOT EXISTS idx_disbursements_date    ON disbursements(send_date);
CREATE INDEX IF NOT EXISTS idx_transactions_from     ON transactions(from_wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_to       ON transactions(to_wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status   ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category);
