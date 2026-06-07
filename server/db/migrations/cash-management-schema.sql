-- ---------------------------------------------------------------------------
-- Cash Management System Schema
-- DEANDREA LAVAR BARKLEY TRUST — Treasury & Liquidity Management
-- ---------------------------------------------------------------------------

-- --- Cash Position Snapshots ------------------------------------------------
-- Periodic snapshots of the unified cash position (for historical tracking)
CREATE TABLE IF NOT EXISTS cms_position_snapshots (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_time         TEXT NOT NULL DEFAULT (datetime('now')),
  -- Bank accounts
  bank_balance_cents    INTEGER NOT NULL DEFAULT 0,
  bank_available_cents  INTEGER NOT NULL DEFAULT 0,
  bank_account_count    INTEGER NOT NULL DEFAULT 0,
  -- Crypto wallets
  crypto_usdc_cents     INTEGER NOT NULL DEFAULT 0,
  crypto_wallet_count   INTEGER NOT NULL DEFAULT 0,
  -- Fixed income
  fi_par_value_cents    INTEGER NOT NULL DEFAULT 0,
  fi_market_value_cents INTEGER NOT NULL DEFAULT 0,
  fi_accrued_cents      INTEGER NOT NULL DEFAULT 0,
  fi_holding_count      INTEGER NOT NULL DEFAULT 0,
  -- Pending
  pending_inflow_cents  INTEGER NOT NULL DEFAULT 0,
  pending_outflow_cents INTEGER NOT NULL DEFAULT 0,
  -- Totals
  total_liquid_cents    INTEGER NOT NULL DEFAULT 0,
  total_assets_cents    INTEGER NOT NULL DEFAULT 0,
  -- Metadata
  created_by            TEXT DEFAULT 'system',
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cms_snap_time ON cms_position_snapshots(snapshot_time);

-- --- Cash Forecasts ---------------------------------------------------------
-- Stored forecast results for comparison and tracking
CREATE TABLE IF NOT EXISTS cms_forecasts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  forecast_date         TEXT NOT NULL DEFAULT (date('now')),
  horizon_days          INTEGER NOT NULL DEFAULT 90,
  current_liquid_cents  INTEGER NOT NULL DEFAULT 0,
  projected_inflow_cents  INTEGER NOT NULL DEFAULT 0,
  projected_outflow_cents INTEGER NOT NULL DEFAULT 0,
  net_projected_cents   INTEGER NOT NULL DEFAULT 0,
  ending_balance_cents  INTEGER NOT NULL DEFAULT 0,
  shortfall_periods     INTEGER NOT NULL DEFAULT 0,
  forecast_data         TEXT,           -- JSON of full forecast detail
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cms_fc_date ON cms_forecasts(forecast_date);

-- --- Reconciliation Log -----------------------------------------------------
-- Records of each reconciliation run
CREATE TABLE IF NOT EXISTS cms_reconciliation_log (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  recon_time            TEXT NOT NULL DEFAULT (datetime('now')),
  total_checks          INTEGER NOT NULL DEFAULT 0,
  matched_count         INTEGER NOT NULL DEFAULT 0,
  mismatch_count        INTEGER NOT NULL DEFAULT 0,
  review_count          INTEGER NOT NULL DEFAULT 0,
  overall_status        TEXT NOT NULL DEFAULT 'matched',  -- matched, mismatch, pending_review
  recon_data            TEXT,           -- JSON of full reconciliation detail
  resolved_by           TEXT,
  resolved_at           TEXT,
  notes                 TEXT,
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cms_recon_status ON cms_reconciliation_log(overall_status);
CREATE INDEX IF NOT EXISTS idx_cms_recon_time ON cms_reconciliation_log(recon_time);

-- --- CMS Alerts -------------------------------------------------------------
-- System-generated alerts from cash position / forecast / reconciliation
CREATE TABLE IF NOT EXISTS cms_alerts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_type            TEXT NOT NULL,  -- low_balance, high_concentration, upcoming_maturity, recon_mismatch, forecast_shortfall, idle_cash, large_pending
  severity              TEXT NOT NULL DEFAULT 'info',  -- info, warning, critical
  message               TEXT NOT NULL,
  details               TEXT,           -- JSON with additional context
  status                TEXT NOT NULL DEFAULT 'active',  -- active, acknowledged, resolved, dismissed
  acknowledged_by       TEXT,
  acknowledged_at       TEXT,
  resolved_by           TEXT,
  resolved_at           TEXT,
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cms_alert_type ON cms_alerts(alert_type);
CREATE INDEX IF NOT EXISTS idx_cms_alert_status ON cms_alerts(status);
CREATE INDEX IF NOT EXISTS idx_cms_alert_severity ON cms_alerts(severity);

-- --- Event Log (Inter-Engine Events) ----------------------------------------
-- Persisted event bus history for audit trail
CREATE TABLE IF NOT EXISTS cms_event_log (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  event_name            TEXT NOT NULL,
  source_engine         TEXT,           -- banking, blockchain, fixed_income, accounting, cms
  event_data            TEXT,           -- JSON payload
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cms_event_name ON cms_event_log(event_name);
CREATE INDEX IF NOT EXISTS idx_cms_event_source ON cms_event_log(source_engine);
CREATE INDEX IF NOT EXISTS idx_cms_event_time ON cms_event_log(created_at);

-- --- Liquidity Rules (for future automation) --------------------------------
-- Configurable rules for automated cash management (Phase 2)
CREATE TABLE IF NOT EXISTS cms_liquidity_rules (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_name             TEXT NOT NULL,
  rule_type             TEXT NOT NULL,   -- sweep, rebalance, alert_threshold, auto_invest
  description           TEXT,
  -- Conditions
  trigger_condition     TEXT NOT NULL,   -- JSON: {field, operator, value}
  -- Action
  action_type           TEXT NOT NULL,   -- notify, transfer, swap, invest
  action_config         TEXT,            -- JSON: action parameters
  -- Status
  is_active             INTEGER NOT NULL DEFAULT 0,  -- 0 = disabled (Phase 2), 1 = active
  requires_approval     INTEGER NOT NULL DEFAULT 1,  -- 1 = suggest only, require trustee approval
  -- Metadata
  last_triggered_at     TEXT,
  trigger_count         INTEGER NOT NULL DEFAULT 0,
  created_by            TEXT DEFAULT 'system',
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cms_rule_type ON cms_liquidity_rules(rule_type);
CREATE INDEX IF NOT EXISTS idx_cms_rule_active ON cms_liquidity_rules(is_active);
