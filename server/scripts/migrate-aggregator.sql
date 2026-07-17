-- ═══════════════════════════════════════════════════════════════════════════
--  Banking Aggregator — bi-directional financial data hub
-- ═══════════════════════════════════════════════════════════════════════════
-- Provider-agnostic hub for exchanging financial data with external
-- institutions/providers: inbound PULL (accounts, balances, transactions,
-- statements), outbound PUSH (payments/financial data), and webhooks.
--
-- Tables are also created idempotently at runtime by
-- BankingAggregator.ensureTables(); this script mirrors that schema so the
-- database can be provisioned ahead of first use. All statements are safe to
-- re-run.

CREATE TABLE IF NOT EXISTS aggregator_connections (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  connector_type    TEXT NOT NULL,
  direction         TEXT NOT NULL DEFAULT 'both'
                      CHECK (direction IN ('inbound','outbound','both')),
  config            JSONB NOT NULL DEFAULT '{}'::jsonb,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  last_pull_at      TIMESTAMPTZ,
  last_push_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS aggregator_accounts (
  id                  TEXT PRIMARY KEY,
  connection_id       TEXT NOT NULL REFERENCES aggregator_connections(id) ON DELETE CASCADE,
  external_account_id TEXT NOT NULL,
  name                TEXT,
  account_type        TEXT,
  currency            TEXT DEFAULT 'USD',
  mask                TEXT,
  balance_available   NUMERIC(20,2),
  balance_current     NUMERIC(20,2),
  raw                 JSONB,
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (connection_id, external_account_id)
);

CREATE TABLE IF NOT EXISTS aggregator_transactions (
  id                  TEXT PRIMARY KEY,
  connection_id       TEXT NOT NULL REFERENCES aggregator_connections(id) ON DELETE CASCADE,
  external_account_id TEXT,
  external_txn_id     TEXT NOT NULL,
  posted_date         DATE,
  amount              NUMERIC(20,2) NOT NULL,
  currency            TEXT DEFAULT 'USD',
  direction           TEXT CHECK (direction IN ('credit','debit')),
  description         TEXT,
  category            TEXT,
  status              TEXT DEFAULT 'posted',
  raw                 JSONB,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (connection_id, external_txn_id)
);

CREATE TABLE IF NOT EXISTS aggregator_statements (
  id                    TEXT PRIMARY KEY,
  connection_id         TEXT NOT NULL REFERENCES aggregator_connections(id) ON DELETE CASCADE,
  external_account_id   TEXT,
  external_statement_id TEXT NOT NULL,
  period_start          DATE,
  period_end            DATE,
  format                TEXT,
  uri                   TEXT,
  raw                   JSONB,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (connection_id, external_statement_id)
);

CREATE TABLE IF NOT EXISTS aggregator_events (
  id            TEXT PRIMARY KEY,
  connection_id TEXT REFERENCES aggregator_connections(id) ON DELETE SET NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  event_type    TEXT NOT NULL,
  payload       JSONB,
  status        TEXT NOT NULL DEFAULT 'received'
                  CHECK (status IN ('received','processed','failed','sent')),
  error         TEXT,
  provider_ref  TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agg_txn_conn ON aggregator_transactions (connection_id, posted_date DESC);
CREATE INDEX IF NOT EXISTS idx_agg_acct_conn ON aggregator_accounts (connection_id);
CREATE INDEX IF NOT EXISTS idx_agg_events_conn ON aggregator_events (connection_id, created_at DESC);
