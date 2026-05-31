-- ═══════════════════════════════════════════════════════════════════════════════
-- Fixed Income Engine — Database Schema Migration
-- DEANDREA LAVAR BARKLEY TRUST — Private Trust Fixed Income Management
-- Generated: 2026-05-31
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── Fixed Income Holdings ────────────────────────────────────────────────────
-- Core table for bond/CD/treasury positions
CREATE TABLE IF NOT EXISTS fixed_income_holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cusip TEXT,
  isin TEXT,
  security_name TEXT NOT NULL,
  security_type TEXT NOT NULL CHECK(security_type IN ('treasury', 'corporate', 'municipal', 'agency', 'cd', 'mbs', 'tips')),
  issuer TEXT,
  par_value_cents INTEGER NOT NULL,
  purchase_price_cents INTEGER NOT NULL,
  purchase_date TEXT NOT NULL,
  settlement_date TEXT,
  coupon_rate REAL NOT NULL,
  coupon_frequency TEXT NOT NULL DEFAULT 'semi-annual' CHECK(coupon_frequency IN ('monthly', 'quarterly', 'semi-annual', 'annual', 'zero')),
  maturity_date TEXT NOT NULL,
  call_date TEXT,
  call_price_cents INTEGER,
  day_count_convention TEXT NOT NULL DEFAULT '30/360' CHECK(day_count_convention IN ('30/360', 'actual/365', 'actual/360', 'actual/actual')),
  credit_rating TEXT,
  credit_rating_agency TEXT,
  yield_to_maturity REAL,
  yield_to_call REAL,
  current_yield REAL,
  book_value_cents INTEGER,
  market_value_cents INTEGER,
  accrued_interest_cents INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'matured', 'called', 'sold', 'defaulted')),
  wallet_id INTEGER,
  tax_status TEXT DEFAULT 'taxable' CHECK(tax_status IN ('taxable', 'tax_exempt', 'tax_deferred')),
  sector TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fi_holdings_status ON fixed_income_holdings(status);
CREATE INDEX IF NOT EXISTS idx_fi_holdings_maturity ON fixed_income_holdings(maturity_date);
CREATE INDEX IF NOT EXISTS idx_fi_holdings_type ON fixed_income_holdings(security_type);
CREATE INDEX IF NOT EXISTS idx_fi_holdings_cusip ON fixed_income_holdings(cusip);

-- ─── Coupon Payment Schedule ──────────────────────────────────────────────────
-- Tracks individual coupon payments (scheduled, received, missed)
CREATE TABLE IF NOT EXISTS coupon_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  holding_id INTEGER NOT NULL REFERENCES fixed_income_holdings(id) ON DELETE CASCADE,
  payment_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled', 'received', 'missed', 'accrued')),
  accrued_from TEXT,
  accrued_to TEXT,
  received_at TEXT,
  transaction_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_coupon_holding ON coupon_payments(holding_id);
CREATE INDEX IF NOT EXISTS idx_coupon_date ON coupon_payments(payment_date);
CREATE INDEX IF NOT EXISTS idx_coupon_status ON coupon_payments(status);

-- ─── Bond Ladder Strategies ───────────────────────────────────────────────────
-- Configurable ladder strategies for managing maturity distribution
CREATE TABLE IF NOT EXISTS ladder_strategies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  target_total_cents INTEGER NOT NULL,
  min_rung_cents INTEGER,
  max_rung_cents INTEGER,
  ladder_start_year INTEGER NOT NULL,
  ladder_end_year INTEGER NOT NULL,
  rung_interval_months INTEGER DEFAULT 12,
  target_yield REAL,
  reinvest_at_maturity INTEGER DEFAULT 1,
  status TEXT DEFAULT 'active' CHECK(status IN ('draft', 'active', 'completed', 'archived')),
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ─── Trust Investment Policy ──────────────────────────────────────────────────
-- IPS constraints for fixed income allocation
CREATE TABLE IF NOT EXISTS trust_investment_policy (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_name TEXT NOT NULL,
  effective_date TEXT NOT NULL,
  max_single_issuer_pct REAL DEFAULT 0.05,
  max_sector_pct REAL DEFAULT 0.25,
  min_credit_rating TEXT DEFAULT 'BBB',
  max_maturity_years REAL DEFAULT 30,
  min_portfolio_yield REAL,
  max_portfolio_duration REAL,
  allowed_security_types TEXT DEFAULT 'treasury,corporate,municipal,agency,cd',
  require_tax_exempt_pct REAL DEFAULT 0,
  max_below_investment_grade_pct REAL DEFAULT 0,
  income_distribution_pct REAL DEFAULT 1.0,
  principal_preservation INTEGER DEFAULT 1,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ─── Maturity Events ──────────────────────────────────────────────────────────
-- Track upcoming and past maturity/call events
CREATE TABLE IF NOT EXISTS maturity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  holding_id INTEGER NOT NULL REFERENCES fixed_income_holdings(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('maturity', 'call', 'put', 'reset')),
  event_date TEXT NOT NULL,
  par_amount_cents INTEGER NOT NULL,
  reinvestment_status TEXT DEFAULT 'pending' CHECK(reinvestment_status IN ('pending', 'reinvested', 'distributed', 'held_cash')),
  reinvested_holding_id INTEGER,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_maturity_date ON maturity_events(event_date);
CREATE INDEX IF NOT EXISTS idx_maturity_holding ON maturity_events(holding_id);

-- ─── Fixed Income Cash Flows ──────────────────────────────────────────────────
-- Projected and actual cash flows for reporting
CREATE TABLE IF NOT EXISTS fi_cash_flows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  holding_id INTEGER REFERENCES fixed_income_holdings(id) ON DELETE SET NULL,
  flow_type TEXT NOT NULL CHECK(flow_type IN ('coupon', 'maturity', 'call', 'purchase', 'sale')),
  flow_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  projected INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fi_cf_date ON fi_cash_flows(flow_date);
CREATE INDEX IF NOT EXISTS idx_fi_cf_type ON fi_cash_flows(flow_type);
