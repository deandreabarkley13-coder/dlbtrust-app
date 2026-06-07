-- ---------------------------------------------------------------------------
-- AI Agent Schema
-- DEANDREA LAVAR BARKLEY TRUST — Platform AI Assistant
-- ---------------------------------------------------------------------------

-- --- Agent Task History -------------------------------------------------------
-- Records of all tasks executed by the AI agent
CREATE TABLE IF NOT EXISTS agent_task_history (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  task_type             TEXT NOT NULL,      -- reconciliation, forecast, snapshot, compliance_check, report, document_search, etc.
  prompt                TEXT NOT NULL,      -- what the user asked
  parsed_intent         TEXT,              -- JSON: { action, parameters, confidence }
  status                TEXT NOT NULL DEFAULT 'pending',  -- pending, running, completed, failed, cancelled
  result_summary        TEXT,              -- human-readable result
  result_data           TEXT,              -- JSON with full result
  error_message         TEXT,
  execution_time_ms     INTEGER,
  created_at            TEXT DEFAULT (datetime('now')),
  completed_at          TEXT,
  created_by            TEXT NOT NULL DEFAULT 'user'
);

CREATE INDEX IF NOT EXISTS idx_agent_task_status ON agent_task_history(status);
CREATE INDEX IF NOT EXISTS idx_agent_task_type ON agent_task_history(task_type);
CREATE INDEX IF NOT EXISTS idx_agent_task_time ON agent_task_history(created_at);

-- --- Agent Scheduled Tasks ----------------------------------------------------
-- Recurring tasks the agent runs automatically
CREATE TABLE IF NOT EXISTS agent_scheduled_tasks (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  name                  TEXT NOT NULL,
  task_type             TEXT NOT NULL,
  schedule_cron         TEXT NOT NULL,      -- cron expression (e.g. '0 9 * * *' for daily 9am)
  parameters            TEXT,              -- JSON parameters for the task
  is_active             INTEGER NOT NULL DEFAULT 1,
  last_run_at           TEXT,
  next_run_at           TEXT,
  last_result           TEXT,              -- success/failed
  run_count             INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_sched_active ON agent_scheduled_tasks(is_active);

-- --- Agent Conversation Log ---------------------------------------------------
-- Chat-style conversation history
CREATE TABLE IF NOT EXISTS agent_conversations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  role                  TEXT NOT NULL,      -- user, agent, system
  content               TEXT NOT NULL,
  task_id               INTEGER,           -- links to agent_task_history if this triggered a task
  metadata              TEXT,              -- JSON with context (tokens, model info, etc.)
  created_at            TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES agent_task_history(id)
);

CREATE INDEX IF NOT EXISTS idx_agent_conv_time ON agent_conversations(created_at);
CREATE INDEX IF NOT EXISTS idx_agent_conv_task ON agent_conversations(task_id);
