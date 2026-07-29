-- ─────────────────────────────────────────────────────────────────────────────
-- OFX Clearing Migration — statement import and payment origination
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ofx_institutions (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  org             TEXT,
  fid             TEXT,
  base_url        TEXT,
  ofx_version     TEXT DEFAULT '200',
  username        TEXT,
  password        TEXT,
  bank_id         TEXT,
  account_id      TEXT,
  account_type    TEXT DEFAULT 'CHECKING',
  routing_number  TEXT,
  status          TEXT DEFAULT 'active' CHECK (status IN ('active','paused')),
  mode            TEXT DEFAULT 'simulate' CHECK (mode IN ('simulate','live')),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ofx_statements (
  id                  SERIAL PRIMARY KEY,
  institution_id      INTEGER REFERENCES ofx_institutions(id),
  account_id          TEXT,
  currency            TEXT,
  start_date          DATE,
  end_date            DATE,
  ledger_balance_cents BIGINT,
  ledger_balance_date DATE,
  raw_content         TEXT,
  parsed_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ofx_transactions (
  id              SERIAL PRIMARY KEY,
  statement_id    INTEGER REFERENCES ofx_statements(id),
  fit_id          TEXT,
  posted_at       DATE,
  type            TEXT,
  amount_cents    BIGINT,
  name            TEXT,
  memo            TEXT,
  check_number    TEXT,
  ref_num         TEXT,
  reference       TEXT,
  reconciled      BOOLEAN DEFAULT FALSE,
  UNIQUE(statement_id, fit_id)
);

CREATE TABLE IF NOT EXISTS ofx_payments (
  id              SERIAL PRIMARY KEY,
  institution_id  INTEGER REFERENCES ofx_institutions(id),
  payment_type    TEXT NOT NULL CHECK (payment_type IN ('billpay','wire','intrabank','interbank','ach')),
  reference       TEXT UNIQUE NOT NULL,
  amount_cents    BIGINT NOT NULL,
  currency        TEXT DEFAULT 'USD',
  source_account_id TEXT,
  source_type     TEXT,
  payee_name      TEXT,
  payee_account   TEXT,
  payee_bank_id   TEXT,
  payee_routing   TEXT,
  payee_address1  TEXT,
  payee_address2  TEXT,
  payee_city      TEXT,
  payee_state     TEXT,
  payee_postal    TEXT,
  payee_country   TEXT DEFAULT 'USA',
  due_date        DATE,
  memo            TEXT,
  ofx_request     TEXT,
  ofx_response    TEXT,
  server_id       TEXT,
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending','submitted','accepted','rejected','cleared','cancelled')),
  status_detail   TEXT,
  submitted_at    TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ofx_txn_statement ON ofx_transactions(statement_id);
CREATE INDEX IF NOT EXISTS idx_ofx_txn_ref ON ofx_transactions(reference);
CREATE INDEX IF NOT EXISTS idx_ofx_payments_inst ON ofx_payments(institution_id);
CREATE INDEX IF NOT EXISTS idx_ofx_payments_status ON ofx_payments(status);

ALTER TABLE ofx_payments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
