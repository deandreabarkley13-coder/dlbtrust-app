-- ============================================================================
-- Migration: cashflow_events — Fixed Income Cashflow Tracking
-- ============================================================================
-- Tracks all cashflow events from bonds, cash movements, and other engines
-- in a unified table for integrated reporting.
--
-- Usage:  psql -f server/scripts/migrate-cashflow-events.sql fineract_tenants
-- ============================================================================

CREATE TABLE IF NOT EXISTS cashflow_events (
  id                SERIAL PRIMARY KEY,
  event_type        TEXT NOT NULL CHECK (event_type IN (
    'bond_accrual', 'interest_payment', 'principal_payment',
    'bond_issuance', 'bond_maturity',
    'cash_deposit', 'cash_transfer', 'cash_withdrawal',
    'fee_payment', 'distribution', 'other'
  )),
  category          TEXT NOT NULL CHECK (category IN (
    'operating', 'investing', 'financing'
  )),
  amount            NUMERIC(18,2) NOT NULL DEFAULT 0,
  direction         TEXT NOT NULL CHECK (direction IN ('inflow', 'outflow')),
  bond_id           INTEGER REFERENCES bonds(id),
  cash_account_id   TEXT,
  journal_entry_id  TEXT,
  description       TEXT,
  event_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cashflow_events_type ON cashflow_events(event_type);
CREATE INDEX IF NOT EXISTS idx_cashflow_events_category ON cashflow_events(category);
CREATE INDEX IF NOT EXISTS idx_cashflow_events_date ON cashflow_events(event_date);
CREATE INDEX IF NOT EXISTS idx_cashflow_events_bond ON cashflow_events(bond_id);
