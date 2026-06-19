/**
 * Admin Control Routes — dlbtrust.cloud
 * Mounts at: /api/admin
 *
 * System health, Fineract client/account management, bond administration,
 * cash position, CRM dashboard, and audit logging.
 */

'use strict';

const express = require('express');
const router  = express.Router();
const pool = require('../integrations/bonds/pgPool');
const { FineractClient } = require('../integrations/fineract/fineractClient');
const { CashEngine } = require('../integrations/cash/cashEngine');
const { CrmEngine } = require('../integrations/crm/crmEngine');
const { LiveBondEngine } = require('../integrations/bonds/liveEngine');
const { BondEngine } = require('../integrations/bonds/bondEngine');
const { FixedIncomeOrchestrator } = require('../integrations/bonds/fixedIncomeOrchestrator');

// ─── Admin Auth Middleware ────────────────────────────────────────────────────
const requireAdmin = (req, res, next) => {
  const token = req.headers['x-admin-token'] || req.query.adminToken;
  if (!token || token !== process.env.ADMIN_SECRET_TOKEN) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  next();
};
router.use(requireAdmin);

// ─── Audit Logger ─────────────────────────────────────────────────────────────
async function logAdminAction(req, action, resourceType, resourceId, payload, result) {
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (admin_user, action, resource_type, resource_id, payload, result, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.headers['x-admin-user'] || 'admin',
        action,
        resourceType || null,
        resourceId || null,
        payload ? JSON.stringify(payload) : null,
        result ? JSON.stringify(result) : null,
        req.ip || req.connection.remoteAddress || null,
      ]
    );
  } catch (err) {
    console.warn('[admin] audit log failed:', err.message);
  }
}

// ─── GET /api/admin/system/health ─────────────────────────────────────────────
router.get('/system/health', async (req, res) => {
  const health = { generated_at: new Date().toISOString() };

  // PostgreSQL
  try {
    await pool.query('SELECT 1');
    health.postgresql = { status: 'connected' };
  } catch (err) {
    health.postgresql = { status: 'error', message: err.message };
  }

  // Fineract
  try {
    await FineractClient.healthCheck();
    health.fineract = { status: 'connected' };
  } catch (err) {
    health.fineract = { status: 'error', message: err.message };
  }

  // Bond engine
  try {
    const bonds = await BondEngine.listBonds();
    health.bond_engine = { status: 'ok', active_bonds: bonds.length };
  } catch (err) {
    health.bond_engine = { status: 'error', message: err.message };
  }

  // Cash engine
  try {
    const tables = await CashEngine.init();
    health.cash_engine = { status: 'ok', tables };
  } catch (err) {
    health.cash_engine = { status: 'error', message: err.message };
  }

  // CRM
  try {
    const dashboard = await CrmEngine.getDashboard();
    health.crm = { status: 'ok', total_contacts: dashboard.total_contacts };
  } catch (err) {
    health.crm = { status: 'error', message: err.message };
  }

  await logAdminAction(req, 'health_check', 'system', null, null, health);
  res.json({ success: true, data: health });
});

// ─── GET /api/admin/system/gl-summary ─────────────────────────────────────────
router.get('/system/gl-summary', async (req, res) => {
  try {
    const summary = await FineractClient.getGLSummary();
    res.json({ success: true, data: summary });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/admin/system/accrue-all ────────────────────────────────────────
router.post('/system/accrue-all', async (req, res) => {
  try {
    const summary = await FixedIncomeOrchestrator.accrueAllWithGL(req.body.toDate);
    await logAdminAction(req, 'accrue_all', 'bonds', null, null, {
      count: summary.bonds_processed,
      total_accrued: summary.total_accrued,
    });
    res.json({ success: true, data: summary });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/admin/audit-log ─────────────────────────────────────────────────
router.get('/audit-log', async (req, res) => {
  try {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (req.query.action) { conditions.push(`action = $${idx++}`); params.push(req.query.action); }
    if (req.query.resourceType) { conditions.push(`resource_type = $${idx++}`); params.push(req.query.resourceType); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const lim = req.query.limit ? parseInt(req.query.limit, 10) : 100;
    const off = req.query.offset ? parseInt(req.query.offset, 10) : 0;

    params.push(lim, off);
    const result = await pool.query(
      `SELECT * FROM admin_audit_log ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      params
    );
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/admin/clients ───────────────────────────────────────────────────
router.get('/clients', async (req, res) => {
  try {
    const clients = await FineractClient.listClients({
      offset: req.query.offset ? parseInt(req.query.offset, 10) : 0,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 100,
    });
    res.json({ success: true, data: clients });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/admin/clients ──────────────────────────────────────────────────
router.post('/clients', async (req, res) => {
  try {
    const result = await FineractClient.createClient(req.body);
    await logAdminAction(req, 'create_client', 'client', result.resourceId ? String(result.resourceId) : null, req.body, result);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/admin/clients/:id ───────────────────────────────────────────────
router.get('/clients/:id', async (req, res) => {
  try {
    const result = await FineractClient.listClients(); // get all, filter
    const client = result && Array.isArray(result.pageItems)
      ? result.pageItems.find(c => String(c.id) === req.params.id)
      : null;
    if (!client) return res.status(404).json({ success: false, error: 'Client not found' });
    res.json({ success: true, data: client });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/admin/accounts ──────────────────────────────────────────────────
router.get('/accounts', async (req, res) => {
  try {
    const result = await FineractClient.listSavingsAccounts({
      clientId: req.query.clientId,
      offset: req.query.offset ? parseInt(req.query.offset, 10) : 0,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 100,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/admin/accounts ─────────────────────────────────────────────────
router.post('/accounts', async (req, res) => {
  try {
    const result = await FineractClient.createSavingsAccount(req.body);
    await logAdminAction(req, 'create_savings_account', 'account', result.resourceId ? String(result.resourceId) : null, req.body, result);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/admin/accounts/:id ──────────────────────────────────────────────
router.get('/accounts/:id', async (req, res) => {
  try {
    const result = await FineractClient.getAccountBalance(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/admin/accounts/:id/activate ────────────────────────────────────
router.post('/accounts/:id/activate', async (req, res) => {
  try {
    const result = await FineractClient.commandSavingsAccount(req.params.id, 'activate');
    await logAdminAction(req, 'activate_account', 'account', req.params.id, null, result);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/admin/accounts/:id/freeze ──────────────────────────────────────
router.post('/accounts/:id/freeze', async (req, res) => {
  try {
    const result = await FineractClient.commandSavingsAccount(req.params.id, 'block');
    await logAdminAction(req, 'freeze_account', 'account', req.params.id, null, result);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/admin/accounts/:id/close ───────────────────────────────────────
router.post('/accounts/:id/close', async (req, res) => {
  try {
    const result = await FineractClient.commandSavingsAccount(req.params.id, 'close');
    await logAdminAction(req, 'close_account', 'account', req.params.id, null, result);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/admin/bonds ─────────────────────────────────────────────────────
router.get('/bonds', async (req, res) => {
  try {
    const snapshot = await LiveBondEngine.getPortfolioSnapshot();
    res.json({ success: true, data: snapshot });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/admin/cash/position ─────────────────────────────────────────────
router.get('/cash/position', async (req, res) => {
  try {
    const position = await CashEngine.getPositionSummary();
    res.json({ success: true, data: position });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/admin/crm/dashboard ─────────────────────────────────────────────
router.get('/crm/dashboard', async (req, res) => {
  try {
    const dashboard = await CrmEngine.getDashboard();
    res.json({ success: true, data: dashboard });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/admin/fineract/seed-gl ──────────────────────────────────────────
// Creates GL accounts in Fineract mirroring trust chart of accounts,
// then populates fineract_gl_mappings table.
router.post('/fineract/seed-gl', async (req, res) => {
  const TYPE_MAP = { asset: 1, liability: 2, equity: 3, income: 4, expense: 5 };

  try {
    // Verify Fineract is reachable
    await FineractClient.healthCheck();

    // Get existing GL accounts to avoid duplicates
    const existingAccounts = await FineractClient.getGLAccounts();
    const existingCodes = new Set(
      Array.isArray(existingAccounts) ? existingAccounts.map(a => a.glCode) : []
    );

    // Read trust chart of accounts
    const { rows: trustAccounts } = await pool.query(
      'SELECT account_code, account_name, account_type, sub_type FROM trust_accounts ORDER BY account_code'
    );

    const results = [];
    let created = 0;
    let skipped = 0;

    for (const acct of trustAccounts) {
      const glCode = acct.account_code;

      if (existingCodes.has(glCode)) {
        const existing = existingAccounts.find(a => a.glCode === glCode);
        results.push({ glCode, name: acct.account_name, action: 'skipped', fineractGlId: existing.id });
        skipped++;

        // Still ensure mapping exists
        await pool.query(`
          INSERT INTO fineract_gl_mappings (mapping_type, trust_account_code, fineract_gl_id, description)
          SELECT $1, $2, $3, $4
          WHERE NOT EXISTS (
            SELECT 1 FROM fineract_gl_mappings WHERE mapping_type = $1 AND trust_account_code = $2
          )
        `, ['trust_journal', glCode, existing.id, `${acct.account_name} (${acct.account_type})`]);
        await pool.query(`
          UPDATE fineract_gl_mappings SET fineract_gl_id = $1, description = $2, updated_at = NOW()
          WHERE mapping_type = 'trust_journal' AND trust_account_code = $3
        `, [existing.id, `${acct.account_name} (${acct.account_type})`, glCode]);
        continue;
      }

      const fineractType = TYPE_MAP[acct.account_type];
      if (!fineractType) continue;

      const result = await FineractClient.createGLAccount({
        name: acct.account_name,
        glCode,
        type: fineractType,
        usage: 2,
        description: `Trust account: ${acct.account_name} (${acct.sub_type || acct.account_type})`,
      });

      const fineractGlId = result.resourceId || result.id;
      results.push({ glCode, name: acct.account_name, action: 'created', fineractGlId });
      created++;

      // Write mapping
      await pool.query(`
        INSERT INTO fineract_gl_mappings (mapping_type, trust_account_code, fineract_gl_id, description)
        SELECT $1, $2, $3, $4
        WHERE NOT EXISTS (
          SELECT 1 FROM fineract_gl_mappings WHERE mapping_type = $1 AND trust_account_code = $2
        )
      `, ['trust_journal', glCode, fineractGlId, `${acct.account_name} (${acct.account_type})`]);
    }

    await logAdminAction(req, 'seed_fineract_gl', 'fineract', null, null, { created, skipped });
    res.json({ success: true, created, skipped, total: results.length, data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
