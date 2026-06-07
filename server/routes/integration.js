/**
 * Integration API Routes — Cross-Engine Orchestration
 * DEANDREA LAVAR BARKLEY TRUST — Private Wealth Management Platform
 *
 * Endpoints:
 *   GET    /api/integration/status              - Integration engine status
 *   GET    /api/integration/pipelines           - List all pipelines
 *   POST   /api/integration/execute             - Execute a pipeline
 *   GET    /api/integration/executions          - Recent pipeline executions
 *   GET    /api/integration/executions/:id      - Execution detail
 *   POST   /api/integration/coupon-to-cash      - Coupon → Bank → GL pipeline
 *   POST   /api/integration/internal-transfer   - Internal transfer pipeline
 *   POST   /api/integration/external-payment    - External payment pipeline
 *   POST   /api/integration/crypto-send         - USDC send pipeline
 *   POST   /api/integration/dex-swap            - POL→USDC swap pipeline
 *   POST   /api/integration/reconcile           - Full system reconciliation
 *   POST   /api/integration/daily-sweep         - Execute daily cash sweep
 *   GET    /api/integration/data-map            - Cross-engine data flow map
 *   GET    /api/integration/health              - Cross-engine health check
 *   GET    /api/integration/events              - Recent event bus events
 *   GET    /api/integration/reconciliation-log  - Reconciliation history
 */

'use strict';

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const { engine, PIPELINES, TRIGGER_TYPES } = require('../engines/integration-engine');
const { bus, EVENTS } = require('../engines/event-bus');

// --- DB Setup ---------------------------------------------------------------

function getDb() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'dlbtrust.db');
  return new Database(dbPath);
}

function ensureTables(db) {
  // Run all schema migrations
  const migrations = [
    'banking-schema.sql', 'crm-schema.sql', 'external-transfers-schema.sql',
    'trust-accounting-schema.sql', 'fixed-income-schema.sql', 'blockchain-schema.sql',
    'cash-management-schema.sql', 'document-management-schema.sql', 'ai-agent-schema.sql',
  ];
  for (const file of migrations) {
    const p = path.join(__dirname, '..', 'db', 'migrations', file);
    if (fs.existsSync(p)) {
      try { db.exec(fs.readFileSync(p, 'utf8')); } catch (_) {}
    }
  }

  // Integration-specific tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_pipeline_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id TEXT NOT NULL,
      pipeline TEXT NOT NULL,
      trigger_type TEXT DEFAULT 'manual',
      params TEXT DEFAULT '{}',
      status TEXT DEFAULT 'pending',
      results TEXT DEFAULT '{}',
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS integration_reconciliation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date TEXT NOT NULL,
      total_checks INTEGER DEFAULT 0,
      matched INTEGER DEFAULT 0,
      mismatched INTEGER DEFAULT 0,
      overall_status TEXT DEFAULT 'unknown',
      details TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS integration_event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_name TEXT NOT NULL,
      source_engine TEXT,
      target_engine TEXT,
      payload TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

// --- Middleware --------------------------------------------------------------

router.use((req, res, next) => {
  try {
    req.db = getDb();
    ensureTables(req.db);
    res.on('finish', () => { try { req.db.close(); } catch (_) {} });
    res.on('close',  () => { try { req.db.close(); } catch (_) {} });
    next();
  } catch (err) {
    res.status(500).json({ error: 'Database connection failed', detail: err.message });
  }
});

// ============================================================================
// ROUTES
// ============================================================================

// --- GET /status -- Engine status -------------------------------------------
router.get('/status', (req, res) => {
  try {
    const status = engine.getStatus();

    // Add cross-engine connection status
    const engines = [];
    const checks = [
      { name: 'Banking', table: 'trust_accounts', query: 'SELECT COUNT(*) as c FROM trust_accounts' },
      { name: 'Fixed Income', table: 'fixed_income_holdings', query: 'SELECT COUNT(*) as c FROM fixed_income_holdings' },
      { name: 'Crypto Rails', table: 'blockchain_wallets', query: 'SELECT COUNT(*) as c FROM blockchain_wallets' },
      { name: 'Cash Management', table: 'cms_position_snapshots', query: "SELECT COUNT(*) as c FROM cms_position_snapshots" },
      { name: 'Trust Accounting', table: 'trust_journal_entries', query: 'SELECT COUNT(*) as c FROM trust_journal_entries' },
      { name: 'Documents', table: 'dms_documents', query: 'SELECT COUNT(*) as c FROM dms_documents' },
      { name: 'AI Agent', table: 'agent_conversations', query: 'SELECT COUNT(*) as c FROM agent_conversations' },
      { name: 'Transfers', table: 'internal_transfers', query: 'SELECT COUNT(*) as c FROM internal_transfers' },
      { name: 'External Payments', table: 'external_transfers', query: 'SELECT COUNT(*) as c FROM external_transfers' },
    ];

    for (const check of checks) {
      try {
        const result = req.db.prepare(check.query).get();
        engines.push({ name: check.name, status: 'connected', records: result.c });
      } catch (_) {
        engines.push({ name: check.name, status: 'disconnected', records: 0 });
      }
    }

    // Recent pipeline logs
    let recentLogs = [];
    try {
      recentLogs = req.db.prepare('SELECT * FROM integration_pipeline_log ORDER BY id DESC LIMIT 10').all();
    } catch (_) {}

    res.json({ ...status, engines, recent_logs: recentLogs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /pipelines -- List all available pipelines -------------------------
router.get('/pipelines', (req, res) => {
  const pipelines = Object.entries(PIPELINES).map(([key, val]) => ({
    id: key,
    name: val.name,
    steps: val.steps,
  }));
  res.json({ count: pipelines.length, pipelines });
});

// --- POST /execute -- Execute any pipeline by name --------------------------
router.post('/execute', async (req, res) => {
  try {
    const { pipeline, params, trigger_type } = req.body;
    if (!pipeline) return res.status(400).json({ error: 'pipeline name required' });

    const trigger = { type: trigger_type || TRIGGER_TYPES.UI, source: 'api' };
    const result = await engine.executePipeline(pipeline, req.db, params || {}, trigger);

    res.json(result.toJSON());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /executions -- Recent pipeline executions --------------------------
router.get('/executions', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const logs = req.db.prepare('SELECT * FROM integration_pipeline_log ORDER BY id DESC LIMIT ?').all(limit);

    const parsed = logs.map(l => ({
      ...l,
      params: JSON.parse(l.params || '{}'),
      results: JSON.parse(l.results || '{}'),
    }));

    res.json({ count: parsed.length, executions: parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /executions/:id -- Execution detail --------------------------------
router.get('/executions/:id', (req, res) => {
  try {
    const log = req.db.prepare('SELECT * FROM integration_pipeline_log WHERE execution_id = ?').get(req.params.id);
    if (!log) return res.status(404).json({ error: 'Execution not found' });
    log.params = JSON.parse(log.params || '{}');
    log.results = JSON.parse(log.results || '{}');
    res.json(log);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /coupon-to-cash -- Coupon → Bank → GL pipeline --------------------
router.post('/coupon-to-cash', async (req, res) => {
  try {
    const { bond_id, coupon_id, amount_cents } = req.body;
    if (!bond_id || !amount_cents) return res.status(400).json({ error: 'bond_id and amount_cents required' });

    const result = await engine.executePipeline('COUPON_TO_CASH', req.db,
      { bond_id, coupon_id, amount_cents },
      { type: req.body.trigger_type || TRIGGER_TYPES.UI, source: 'api' }
    );

    res.json(result.toJSON());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /internal-transfer -- Internal transfer pipeline ------------------
router.post('/internal-transfer', async (req, res) => {
  try {
    const { from_account_id, to_account_id, amount_cents, transfer_type, description, memo } = req.body;
    if (!from_account_id || !to_account_id || !amount_cents) {
      return res.status(400).json({ error: 'from_account_id, to_account_id, and amount_cents required' });
    }

    const result = await engine.executePipeline('INTERNAL_TRANSFER', req.db,
      { from_account_id, to_account_id, amount_cents, transfer_type, description, memo },
      { type: req.body.trigger_type || TRIGGER_TYPES.UI, source: 'api' }
    );

    res.json(result.toJSON());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /external-payment -- External payment pipeline --------------------
router.post('/external-payment', async (req, res) => {
  try {
    const { from_account_id, contact_id, amount_cents, rail, description, memo } = req.body;
    if (!from_account_id || !amount_cents) {
      return res.status(400).json({ error: 'from_account_id and amount_cents required' });
    }

    const result = await engine.executePipeline('EXTERNAL_PAYMENT', req.db,
      { from_account_id, contact_id, amount_cents, rail, description, memo },
      { type: req.body.trigger_type || TRIGGER_TYPES.UI, source: 'api' }
    );

    res.json(result.toJSON());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /crypto-send -- USDC send pipeline --------------------------------
router.post('/crypto-send', async (req, res) => {
  try {
    const { wallet_id, to_address, amount_usd } = req.body;
    if (!wallet_id || !to_address || !amount_usd) {
      return res.status(400).json({ error: 'wallet_id, to_address, and amount_usd required' });
    }

    const result = await engine.executePipeline('CRYPTO_SEND', req.db,
      { wallet_id, to_address, amount_usd },
      { type: req.body.trigger_type || TRIGGER_TYPES.UI, source: 'api' }
    );

    res.json(result.toJSON());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /dex-swap -- DEX swap pipeline ------------------------------------
router.post('/dex-swap', async (req, res) => {
  try {
    const { wallet_id, amount_pol, slippage_bps } = req.body;
    if (!wallet_id || !amount_pol) {
      return res.status(400).json({ error: 'wallet_id and amount_pol required' });
    }

    const result = await engine.executePipeline('DEX_SWAP', req.db,
      { wallet_id, amount_pol, slippage_bps },
      { type: req.body.trigger_type || TRIGGER_TYPES.UI, source: 'api' }
    );

    res.json(result.toJSON());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /reconcile -- Full system reconciliation --------------------------
router.post('/reconcile', async (req, res) => {
  try {
    const result = await engine.executePipeline('FULL_RECONCILIATION', req.db, {},
      { type: req.body.trigger_type || TRIGGER_TYPES.MANUAL, source: 'api' }
    );

    res.json(result.toJSON());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /daily-sweep -- Execute daily cash sweep --------------------------
router.post('/daily-sweep', async (req, res) => {
  try {
    const result = await engine.executePipeline('DAILY_SWEEP', req.db, {},
      { type: req.body.trigger_type || TRIGGER_TYPES.SCHEDULED, source: 'api' }
    );

    res.json(result.toJSON());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /data-map -- Cross-engine data flow map ----------------------------
router.get('/data-map', (req, res) => {
  try {
    const map = {
      engines: [
        { id: 'banking', name: 'Core Banking', tables: ['trust_accounts', 'internal_transfers', 'account_holds'] },
        { id: 'fixed_income', name: 'Fixed Income', tables: ['fixed_income_holdings', 'coupon_schedule'] },
        { id: 'crypto', name: 'Crypto Rails', tables: ['blockchain_wallets', 'blockchain_transactions', 'blockchain_config'] },
        { id: 'cms', name: 'Cash Management', tables: ['cms_position_snapshots', 'cms_liquidity_rules'] },
        { id: 'accounting', name: 'Trust Accounting', tables: ['trust_journal_entries', 'trust_journal_lines', 'trust_chart_of_accounts'] },
        { id: 'documents', name: 'Documents', tables: ['dms_documents'] },
        { id: 'agent', name: 'AI Agent', tables: ['agent_conversations', 'agent_task_history'] },
        { id: 'transfers', name: 'Transfers', tables: ['internal_transfers'] },
        { id: 'payments', name: 'External Payments', tables: ['external_transfers', 'external_transfer_approvals'] },
      ],
      flows: [
        { from: 'fixed_income', to: 'banking', trigger: 'coupon_received', data: 'Coupon payment credits operating account' },
        { from: 'fixed_income', to: 'accounting', trigger: 'coupon_received', data: 'GL journal: Debit Cash / Credit Interest Income' },
        { from: 'banking', to: 'accounting', trigger: 'transfer_completed', data: 'GL journal: Debit/Credit inter-account transfer' },
        { from: 'banking', to: 'cms', trigger: 'balance_changed', data: 'CMS aggregates bank balances into total liquid' },
        { from: 'crypto', to: 'accounting', trigger: 'usdc_sent', data: 'GL journal: Credit Digital Assets / Debit Payable' },
        { from: 'crypto', to: 'cms', trigger: 'balance_synced', data: 'CMS aggregates wallet USDC into total position' },
        { from: 'payments', to: 'banking', trigger: 'payment_processing', data: 'Debit source account for external payment' },
        { from: 'payments', to: 'accounting', trigger: 'payment_completed', data: 'GL journal: Debit AP / Credit Cash + Fee' },
        { from: 'cms', to: 'banking', trigger: 'sweep_rule', data: 'Auto-sweep excess cash between accounts' },
        { from: 'agent', to: '*', trigger: 'task_executed', data: 'AI Agent can query/trigger any engine' },
        { from: 'documents', to: 'accounting', trigger: 'doc_approved', data: 'Compliance attestation for audit trail' },
      ],
      trigger_types: Object.values(TRIGGER_TYPES),
    };

    // Add live record counts
    for (const eng of map.engines) {
      for (let i = 0; i < eng.tables.length; i++) {
        try {
          const count = req.db.prepare(`SELECT COUNT(*) as c FROM ${eng.tables[i]}`).get();
          eng.tables[i] = { name: eng.tables[i], records: count.c };
        } catch (_) {
          eng.tables[i] = { name: eng.tables[i], records: 0 };
        }
      }
    }

    res.json(map);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /health -- Cross-engine health check -------------------------------
router.get('/health', (req, res) => {
  try {
    const health = { status: 'healthy', engines: [], timestamp: new Date().toISOString() };

    const checks = [
      { name: 'Banking', query: "SELECT COUNT(*) as c FROM trust_accounts WHERE status = 'active'" },
      { name: 'Fixed Income', query: "SELECT COUNT(*) as c FROM fixed_income_holdings WHERE status = 'active'" },
      { name: 'Crypto Rails', query: 'SELECT COUNT(*) as c FROM blockchain_wallets' },
      { name: 'GL (Accounting)', query: 'SELECT COUNT(*) as c FROM trust_journal_entries' },
      { name: 'CMS', query: 'SELECT COUNT(*) as c FROM cms_position_snapshots' },
      { name: 'Transfers', query: "SELECT COUNT(*) as c FROM internal_transfers WHERE status = 'completed'" },
      { name: 'External Payments', query: 'SELECT COUNT(*) as c FROM external_transfers' },
      { name: 'Documents', query: 'SELECT COUNT(*) as c FROM dms_documents' },
      { name: 'AI Agent', query: 'SELECT COUNT(*) as c FROM agent_conversations' },
    ];

    for (const check of checks) {
      try {
        const result = req.db.prepare(check.query).get();
        health.engines.push({ name: check.name, status: 'ok', active_records: result.c });
      } catch (err) {
        health.engines.push({ name: check.name, status: 'error', error: err.message });
        health.status = 'degraded';
      }
    }

    // Check integration layer
    try {
      const pipelineCount = req.db.prepare('SELECT COUNT(*) as c FROM integration_pipeline_log').get();
      health.integration = { pipelines_executed: pipelineCount.c };
    } catch (_) {
      health.integration = { pipelines_executed: 0 };
    }

    res.json(health);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /events -- Recent event bus events ---------------------------------
router.get('/events', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const eventFilter = req.query.event || null;
  const events = bus.getHistory({ event: eventFilter, limit });
  res.json({ count: events.length, events });
});

// --- GET /reconciliation-log -- Reconciliation history ----------------------
router.get('/reconciliation-log', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const logs = req.db.prepare('SELECT * FROM integration_reconciliation_log ORDER BY id DESC LIMIT ?').all(limit);
    const parsed = logs.map(l => ({ ...l, details: JSON.parse(l.details || '{}') }));
    res.json({ count: parsed.length, logs: parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
