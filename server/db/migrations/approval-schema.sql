-- ---------------------------------------------------------------------------
-- Trustee Approval Engine Schema
-- DEANDREA LAVAR BARKLEY TRUST — Fiduciary Governance & Approval Workflows
-- ---------------------------------------------------------------------------

-- --- Approval Policies -------------------------------------------------------
-- Configurable rules that determine what needs approval and by whom
CREATE TABLE IF NOT EXISTS approval_policies (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type       TEXT NOT NULL,                          -- account, transfer, transaction, contact, config, journal_entry, hold, distribution
  action            TEXT NOT NULL,                          -- create, update, delete, activate, close, freeze, process, approve
  policy_name       TEXT NOT NULL,
  description       TEXT,
  approval_required INTEGER NOT NULL DEFAULT 1,             -- 0 = auto-approve, 1 = requires approval
  approval_tier     TEXT NOT NULL DEFAULT 'single',         -- auto, single, dual, committee
  min_approvers     INTEGER NOT NULL DEFAULT 1,
  amount_threshold_cents INTEGER,                           -- only require approval above this amount (null = always)
  priority_override TEXT,                                   -- urgent/high priority may bypass (null = no bypass)
  allowed_roles     TEXT DEFAULT 'trustee,admin',           -- comma-separated roles that can approve
  auto_approve_below_cents INTEGER,                         -- auto-approve transactions below this amount
  escalation_hours  INTEGER DEFAULT 24,                     -- auto-escalate after N hours if not acted on
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_policy_unique ON approval_policies(entity_type, action);

-- --- Approval Requests -------------------------------------------------------
-- Items pending trustee approval
CREATE TABLE IF NOT EXISTS approval_requests (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  request_number    TEXT NOT NULL UNIQUE,                    -- APR-YYYYMMDD-XXXX
  policy_id         INTEGER,
  entity_type       TEXT NOT NULL,                          -- account, transfer, transaction, contact, config, journal_entry
  entity_id         INTEGER,                                -- ID of the entity needing approval
  action            TEXT NOT NULL,                          -- create, update, delete, activate, close, freeze, process
  status            TEXT NOT NULL DEFAULT 'pending',        -- pending, approved, rejected, escalated, expired, cancelled
  priority          TEXT NOT NULL DEFAULT 'normal',         -- low, normal, high, urgent
  amount_cents      INTEGER,                                -- amount involved (for threshold checks)
  summary           TEXT NOT NULL,                          -- human-readable summary of what needs approval
  details           TEXT,                                   -- JSON with full details of the change
  submitted_by      TEXT NOT NULL DEFAULT 'system',
  submitted_at      TEXT DEFAULT (datetime('now')),
  -- Resolution
  resolved_at       TEXT,
  resolved_by       TEXT,
  resolution_notes  TEXT,
  -- Escalation
  escalated_at      TEXT,
  escalated_to      TEXT,
  escalation_reason TEXT,
  -- Expiry
  expires_at        TEXT,                                   -- auto-expire if not acted on
  -- Audit
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (policy_id) REFERENCES approval_policies(id)
);

CREATE INDEX IF NOT EXISTS idx_approval_req_status ON approval_requests(status);
CREATE INDEX IF NOT EXISTS idx_approval_req_entity ON approval_requests(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_approval_req_date ON approval_requests(submitted_at);
CREATE INDEX IF NOT EXISTS idx_approval_req_priority ON approval_requests(priority);

-- --- Approval Decisions ------------------------------------------------------
-- Individual approver decisions (supports multi-approver workflows)
CREATE TABLE IF NOT EXISTS approval_decisions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id        INTEGER NOT NULL,
  decision          TEXT NOT NULL,                          -- approved, rejected
  decided_by        TEXT NOT NULL,                          -- trustee name/ID
  decided_role      TEXT,                                   -- trustee, admin, co-trustee
  reason            TEXT,
  tier              TEXT DEFAULT 'first',                   -- first, second, committee
  created_at        TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (request_id) REFERENCES approval_requests(id)
);

CREATE INDEX IF NOT EXISTS idx_approval_dec_req ON approval_decisions(request_id);

-- --- Approval Audit Log ------------------------------------------------------
-- Immutable log of all approval actions
CREATE TABLE IF NOT EXISTS approval_audit_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id        INTEGER,
  event_type        TEXT NOT NULL,                          -- submitted, approved, rejected, escalated, expired, cancelled, auto_approved
  actor             TEXT NOT NULL,
  details           TEXT,                                   -- JSON details
  ip_address        TEXT,
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_approval_audit_req ON approval_audit_log(request_id);
CREATE INDEX IF NOT EXISTS idx_approval_audit_event ON approval_audit_log(event_type);

-- --- Data Retention Configuration --------------------------------------------
-- Controls how long data is kept and when backups occur
CREATE TABLE IF NOT EXISTS data_retention_config (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  config_key        TEXT NOT NULL UNIQUE,
  config_value      TEXT NOT NULL,
  description       TEXT,
  updated_by        TEXT DEFAULT 'system',
  updated_at        TEXT DEFAULT (datetime('now'))
);

-- --- Data Backups ------------------------------------------------------------
-- Track all backup/restore operations
CREATE TABLE IF NOT EXISTS data_backups (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  backup_id         TEXT NOT NULL UNIQUE,                   -- BKP-YYYYMMDD-HHMMSS
  backup_type       TEXT NOT NULL DEFAULT 'full',           -- full, incremental, pre_deploy
  file_path         TEXT,
  file_size_bytes   INTEGER,
  tables_included   TEXT,                                   -- JSON array of table names
  row_counts        TEXT,                                   -- JSON object {table: count}
  checksum          TEXT,                                   -- SHA-256 of backup file
  status            TEXT NOT NULL DEFAULT 'completed',      -- in_progress, completed, failed, restored
  triggered_by      TEXT DEFAULT 'system',                  -- system, manual, pre_deploy, scheduled
  notes             TEXT,
  created_at        TEXT DEFAULT (datetime('now')),
  restored_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_backups_status ON data_backups(status);
CREATE INDEX IF NOT EXISTS idx_backups_type ON data_backups(backup_type);

-- --- Schema Migrations -------------------------------------------------------
-- Track which migrations have been applied
CREATE TABLE IF NOT EXISTS schema_migrations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  migration_name    TEXT NOT NULL UNIQUE,
  applied_at        TEXT DEFAULT (datetime('now')),
  checksum          TEXT,                                   -- hash of the migration file
  status            TEXT NOT NULL DEFAULT 'applied'         -- applied, rolled_back
);

CREATE INDEX IF NOT EXISTS idx_migrations_name ON schema_migrations(migration_name);

-- --- Platform Configuration --------------------------------------------------
-- Persistent platform settings that survive deployments
CREATE TABLE IF NOT EXISTS platform_config (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  config_key        TEXT NOT NULL UNIQUE,
  config_value      TEXT NOT NULL,
  config_type       TEXT NOT NULL DEFAULT 'string',         -- string, number, boolean, json
  category          TEXT NOT NULL DEFAULT 'general',        -- general, approval, retention, security, display
  description       TEXT,
  requires_approval INTEGER NOT NULL DEFAULT 0,             -- 1 = changing this needs trustee approval
  updated_by        TEXT DEFAULT 'system',
  updated_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_platform_config_cat ON platform_config(category);

-- --- Insert Default Approval Policies ----------------------------------------
INSERT OR IGNORE INTO approval_policies (entity_type, action, policy_name, description, approval_required, approval_tier, auto_approve_below_cents, amount_threshold_cents)
VALUES
  ('account',       'create',    'Account Creation',           'New trust account creation requires trustee approval',          1, 'single', NULL, NULL),
  ('account',       'close',     'Account Closure',            'Closing a trust account requires trustee approval',             1, 'single', NULL, NULL),
  ('account',       'freeze',    'Account Freeze',             'Freezing a trust account requires trustee approval',            1, 'single', NULL, NULL),
  ('account',       'activate',  'Account Activation',         'Activating a trust account requires trustee approval',          1, 'single', NULL, NULL),
  ('transfer',      'create',    'Internal Transfer',          'Internal fund transfers require approval above threshold',      1, 'single', 500000, NULL),
  ('transfer',      'process',   'Transfer Processing',        'Processing an approved transfer',                               0, 'auto',   NULL, NULL),
  ('external_transfer', 'create','External Transfer Creation', 'External payments require trustee approval above $5K',          1, 'single', 500000, NULL),
  ('external_transfer', 'process','External Transfer Process', 'Processing external payment delivery',                          1, 'single', NULL, 1000000),
  ('transaction',   'create',    'Transaction Recording',      'Manual journal entries require approval',                       1, 'single', NULL, NULL),
  ('contact',       'create',    'Contact Creation',           'New vendor/beneficiary contacts are auto-approved',             0, 'auto',   NULL, NULL),
  ('contact',       'update',    'Contact Update',             'Contact info changes are auto-approved',                        0, 'auto',   NULL, NULL),
  ('config',        'update',    'Platform Config Change',     'Changes to platform configuration require trustee approval',    1, 'single', NULL, NULL),
  ('distribution',  'create',    'Beneficiary Distribution',   'Trust distributions to beneficiaries require dual approval',    1, 'dual',   NULL, NULL),
  ('journal_entry', 'create',    'Journal Entry Creation',     'Manual accounting entries require trustee approval',             1, 'single', NULL, NULL),
  ('hold',          'create',    'Account Hold',               'Placing holds on accounts requires trustee approval',           1, 'single', NULL, NULL);

-- --- Insert Default Retention Config -----------------------------------------
INSERT OR IGNORE INTO data_retention_config (config_key, config_value, description)
VALUES
  ('backup_frequency',      'daily',    'How often automatic backups run (hourly, daily, weekly)'),
  ('backup_retention_days', '90',       'How many days to keep backup files'),
  ('pre_deploy_backup',     'true',     'Create backup before each deployment'),
  ('max_backups',           '30',       'Maximum number of backup files to retain'),
  ('backup_path',           '/opt/dlbtrust-app/backups', 'Where backup files are stored'),
  ('auto_migrate',          'true',     'Automatically apply new schema migrations on startup');

-- --- Insert Default Platform Config ------------------------------------------
INSERT OR IGNORE INTO platform_config (config_key, config_value, config_type, category, description, requires_approval)
VALUES
  ('approval_enabled',           'true',    'boolean', 'approval',  'Enable/disable the trustee approval system',              1),
  ('auto_approve_threshold',     '500000',  'number',  'approval',  'Auto-approve transactions below this amount (cents)',      1),
  ('dual_approval_threshold',    '5000000', 'number',  'approval',  'Require dual approval above this amount (cents)',          1),
  ('approval_expiry_hours',      '48',      'number',  'approval',  'Hours before unanswered approval requests expire',         0),
  ('require_approval_accounts',  'true',    'boolean', 'approval',  'Require trustee approval for new account creation',       1),
  ('require_approval_transfers', 'true',    'boolean', 'approval',  'Require trustee approval for external transfers',         1),
  ('require_approval_config',    'true',    'boolean', 'approval',  'Require trustee approval for platform config changes',    1),
  ('data_retention_enabled',     'true',    'boolean', 'retention', 'Enable automatic data backups',                            0),
  ('platform_name',              'DEANDREA LAVAR BARKLEY TRUST', 'string', 'general', 'Platform display name',                 1),
  ('default_currency',           'USD',     'string',  'general',   'Default currency for new accounts',                       0);
