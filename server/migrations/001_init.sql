-- Migration 001: Initial PostgreSQL schema for dlbtrust-app
-- Run against the Supabase PostgreSQL database
-- Tables: wallets, transactions, disbursements

CREATE TABLE IF NOT EXISTS wallets (
  id SERIAL PRIMARY KEY,
  wallet_id TEXT UNIQUE NOT NULL,
  name TEXT,
  role TEXT,
  fiat_balance BIGINT DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  status TEXT DEFAULT 'active',
  email TEXT,
  phone TEXT,
  holder_name TEXT,
  public_address TEXT,
  routing_number TEXT,
  account_number TEXT,
  account_type TEXT DEFAULT 'checking',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  wallet_id TEXT REFERENCES wallets(wallet_id),
  type TEXT,
  category TEXT,
  description TEXT,
  amount BIGINT DEFAULT 0,
  balance_before BIGINT,
  balance_after BIGINT,
  payment_method TEXT,
  from_wallet_id TEXT,
  to_wallet_id TEXT,
  counterparty_wallet_id TEXT,
  reference_id TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS disbursements (
  id SERIAL PRIMARY KEY,
  payment_schedule_id TEXT,
  external_account_id TEXT,
  payment_profile_id TEXT,
  amount NUMERIC(12,2),
  send_date DATE,
  beneficiary_name TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Additional tables referenced by api-routes-patched.cjs
CREATE TABLE IF NOT EXISTS trust_profile (
  id SERIAL PRIMARY KEY,
  name TEXT,
  balance BIGINT DEFAULT 0,
  total_corpus BIGINT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS distributions (
  id SERIAL PRIMARY KEY,
  amount BIGINT,
  description TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS distribution_items (
  id SERIAL PRIMARY KEY,
  distribution_id INTEGER REFERENCES distributions(id),
  wallet_id TEXT,
  amount BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id SERIAL PRIMARY KEY,
  wallet_id TEXT,
  type TEXT,
  description TEXT,
  amount BIGINT,
  balance_after BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bonds (
  id SERIAL PRIMARY KEY,
  name TEXT,
  value BIGINT,
  maturity_date DATE,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bank_transfers (
  id SERIAL PRIMARY KEY,
  from_account TEXT,
  to_account TEXT,
  amount BIGINT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS debit_cards (
  id SERIAL PRIMARY KEY,
  card_number TEXT,
  holder_name TEXT,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS external_bank_accounts (
  id SERIAL PRIMARY KEY,
  bank_name TEXT,
  routing_number TEXT,
  account_number TEXT,
  account_type TEXT DEFAULT 'checking',
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fund_rules (
  id SERIAL PRIMARY KEY,
  name TEXT,
  rule_type TEXT,
  conditions JSONB,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  action TEXT,
  user_id TEXT,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  description TEXT,
  amount BIGINT,
  category TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE,
  role TEXT DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_transactions_wallet_id ON transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_from_wallet ON transactions(from_wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_to_wallet ON transactions(to_wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_wallets_role ON wallets(role);
CREATE INDEX IF NOT EXISTS idx_disbursements_created_at ON disbursements(created_at);
