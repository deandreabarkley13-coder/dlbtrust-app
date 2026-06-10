/**
 * Trustee Approval Routes
 * DEANDREA LAVAR BARKLEY TRUST — Fiduciary Governance & Approval Workflows
 *
 * Endpoints:
 *   GET    /api/approval/requests           - List approval requests (filter by status, entity_type)
 *   GET    /api/approval/requests/:id       - Get request details with decisions + audit log
 *   POST   /api/approval/requests/:id/approve - Approve a pending request
 *   POST   /api/approval/requests/:id/reject  - Reject a pending request
 *   GET    /api/approval/stats              - Dashboard stats (pending count, etc.)
 *   GET    /api/approval/policies           - List all approval policies
 *   PUT    /api/approval/policies/:id       - Update a policy
 *   GET    /api/approval/audit-log          - Full audit trail
 *   POST   /api/approval/check              - Check if an action requires approval
 *   GET    /api/approval/config             - Get platform configuration
 *   PUT    /api/approval/config/:key        - Update platform configuration (may need approval)
 *
 * Data Retention Endpoints:
 *   GET    /api/approval/retention/stats    - Data retention statistics
 *   POST   /api/approval/retention/backup   - Create a manual backup
 *   GET    /api/approval/retention/backups  - List all backups
 *   POST   /api/approval/retention/verify/:id - Verify backup integrity
 *   GET    /api/approval/retention/integrity - Check data integrity
 *   POST   /api/approval/retention/migrate  - Run pending migrations
 */
'use strict';

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const Database = require('better-sqlite3');

const {
  initApprovalSchema,
  submitApprovalRequest,
  approveRequest,
  rejectRequest,
  listApprovalRequests,
  getApprovalRequest,
  listPolicies,
  updatePolicy,
  getAuditLog,
  expireStaleRequests,
  getApprovalStats,
  getPlatformConfig,
  requiresApproval,
} = require('../engines/approval-engine');

const {
  createBackup,
  listBackups,
  verifyBackup,
  runMigrations,
  checkDataIntegrity,
  getRetentionStats,
} = require('../engines/data-retention-engine');

// --- DB Setup ---------------------------------------------------------------

function getDb() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'dlbtrust.db');
  return new Database(dbPath);
}

let schemaInitialized = false;

router.use((req, res, next) => {
  try {
    req.db = getDb();
    if (!schemaInitialized) {
      initApprovalSchema(req.db);
      schemaInitialized = true;
    }
    res.on('finish', () => { try { req.db.close(); } catch (_) {} });
    res.on('close',  () => { try { req.db.close(); } catch (_) {} });
    next();
  } catch (err) {
    res.status(500).json({ error: 'Database connection failed', detail: err.message });
  }
});

// ============================================================================
// APPROVAL REQUESTS
// ============================================================================

// --- GET /requests -- List approval requests --------------------------------
router.get('/requests', (req, res) => {
  try {
    const { status, entity_type, limit } = req.query;
    // Auto-expire stale requests
    expireStaleRequests(req.db);
    const requests = listApprovalRequests(req.db, { status, entityType: entity_type, limit: parseInt(limit) || 50 });
    res.json({ count: requests.length, requests });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /requests/:id -- Request details -----------------------------------
router.get('/requests/:id', (req, res) => {
  try {
    const request = getApprovalRequest(req.db, req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    res.json(request);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /requests/:id/approve -- Approve a request ------------------------
router.post('/requests/:id/approve', (req, res) => {
  try {
    const { decided_by = 'trustee', decided_role = 'trustee', reason } = req.body;
    const result = approveRequest(req.db, parseInt(req.params.id), {
      decidedBy: decided_by,
      decidedRole: decided_role,
      reason,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- POST /requests/:id/reject -- Reject a request --------------------------
router.post('/requests/:id/reject', (req, res) => {
  try {
    const { decided_by = 'trustee', decided_role = 'trustee', reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Rejection reason is required' });
    const result = rejectRequest(req.db, parseInt(req.params.id), {
      decidedBy: decided_by,
      decidedRole: decided_role,
      reason,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================================
// DASHBOARD & STATS
// ============================================================================

// --- GET /stats -- Approval dashboard stats ---------------------------------
router.get('/stats', (req, res) => {
  try {
    expireStaleRequests(req.db);
    const stats = getApprovalStats(req.db);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// POLICIES
// ============================================================================

// --- GET /policies -- List all policies -------------------------------------
router.get('/policies', (req, res) => {
  try {
    const policies = listPolicies(req.db);
    res.json({ count: policies.length, policies });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- PUT /policies/:id -- Update a policy -----------------------------------
router.put('/policies/:id', (req, res) => {
  try {
    const updated = updatePolicy(req.db, parseInt(req.params.id), req.body);
    if (!updated) return res.status(400).json({ error: 'No valid fields to update' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// AUDIT LOG
// ============================================================================

// --- GET /audit-log -- Full approval audit trail ----------------------------
router.get('/audit-log', (req, res) => {
  try {
    const { request_id, event_type, limit } = req.query;
    const log = getAuditLog(req.db, { requestId: request_id ? parseInt(request_id) : null, eventType: event_type, limit: parseInt(limit) || 100 });
    res.json({ count: log.length, entries: log });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// APPROVAL CHECK
// ============================================================================

// --- POST /check -- Check if an action requires approval --------------------
router.post('/check', (req, res) => {
  try {
    const { entity_type, action, amount_cents } = req.body;
    if (!entity_type || !action) return res.status(400).json({ error: 'entity_type and action are required' });
    const result = requiresApproval(req.db, entity_type, action, amount_cents || null);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// PLATFORM CONFIG
// ============================================================================

// --- GET /config -- Get platform configuration ------------------------------
router.get('/config', (req, res) => {
  try {
    const { category } = req.query;
    let rows;
    if (category) {
      rows = req.db.prepare('SELECT * FROM platform_config WHERE category = ? ORDER BY config_key').all(category);
    } else {
      rows = req.db.prepare('SELECT * FROM platform_config ORDER BY category, config_key').all();
    }
    const config = {};
    for (const row of rows) {
      config[row.config_key] = {
        value: row.config_type === 'number' ? parseInt(row.config_value) :
               row.config_type === 'boolean' ? row.config_value === 'true' :
               row.config_type === 'json' ? JSON.parse(row.config_value) : row.config_value,
        type: row.config_type,
        category: row.category,
        description: row.description,
        requires_approval: !!row.requires_approval,
      };
    }
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- PUT /config/:key -- Update platform configuration ----------------------
router.put('/config/:key', (req, res) => {
  try {
    const { value, updated_by = 'admin' } = req.body;
    if (value === undefined) return res.status(400).json({ error: 'value is required' });

    const existing = req.db.prepare('SELECT * FROM platform_config WHERE config_key = ?').get(req.params.key);
    if (!existing) return res.status(404).json({ error: 'Config key not found' });

    // Check if approval is needed
    if (existing.requires_approval) {
      const result = submitApprovalRequest(req.db, {
        entityType: 'config',
        entityId: existing.id,
        action: 'update',
        summary: `Change ${req.params.key} from "${existing.config_value}" to "${value}"`,
        details: JSON.stringify({ config_key: req.params.key, old_value: existing.config_value, config_value: String(value) }),
        submittedBy: updated_by,
      });
      if (result.pending) {
        return res.json({ message: 'Config change submitted for trustee approval', approval: result });
      }
    }

    // Direct update (no approval needed or auto-approved)
    req.db.prepare("UPDATE platform_config SET config_value = ?, updated_by = ?, updated_at = datetime('now') WHERE config_key = ?")
      .run(String(value), updated_by, req.params.key);
    const updated = req.db.prepare('SELECT * FROM platform_config WHERE config_key = ?').get(req.params.key);
    res.json({ message: 'Config updated', config: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// DATA RETENTION
// ============================================================================

// --- GET /retention/stats -- Data retention statistics -----------------------
router.get('/retention/stats', (req, res) => {
  try {
    const stats = getRetentionStats(req.db);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /retention/backup -- Create a manual backup -----------------------
router.post('/retention/backup', (req, res) => {
  try {
    const { notes } = req.body;
    const result = createBackup(req.db, { backupType: 'manual', triggeredBy: 'admin', notes });
    res.json({ message: 'Backup created', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /retention/backups -- List all backups ------------------------------
router.get('/retention/backups', (req, res) => {
  try {
    const { limit } = req.query;
    const backups = listBackups(req.db, { limit: parseInt(limit) || 20 });
    res.json({ count: backups.length, backups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /retention/verify/:id -- Verify backup integrity ------------------
router.post('/retention/verify/:id', (req, res) => {
  try {
    const result = verifyBackup(req.db, req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- GET /retention/integrity -- Check data integrity -----------------------
router.get('/retention/integrity', (req, res) => {
  try {
    const result = checkDataIntegrity(req.db);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /retention/migrate -- Run pending migrations ----------------------
router.post('/retention/migrate', (req, res) => {
  try {
    const result = runMigrations(req.db);
    res.json({ message: 'Migrations complete', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
