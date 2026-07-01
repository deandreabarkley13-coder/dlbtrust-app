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

// ─── Admin Auth Middleware ────────────────────────────────────────────────────
const requireAdmin = async (req, res, next) => {
  // 1. Check legacy x-admin-token
  const legacyToken = req.headers['x-admin-token'] || req.query.adminToken;
  if (legacyToken && legacyToken === process.env.ADMIN_SECRET_TOKEN) {
    return next();
  }
  // 2. Check JWT Bearer token (admin role required)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const { UserAuth } = require('../integrations/auth/userAuth');
      const decoded = await UserAuth.verifyToken(authHeader.slice(7));
      if (decoded && decoded.role === 'admin') {
        req.user = decoded;
        return next();
      }
    } catch (e) { /* fall through to 401 */ }
  }
  return res.status(401).json({ error: 'Admin authentication required' });
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

  // Payment system mode
  const paymentMode = process.env.PAYMENT_MODE || 'sandbox';
  health.payment_system = {
    mode: paymentMode,
    as2_configured: !!process.env.AS2_PARTNER_URL,
    admin_token_secure: process.env.ADMIN_SECRET_TOKEN !== 'test-admin-token-123',
  };

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
    const bonds = await pool.query(`SELECT id, bond_name FROM bonds WHERE status = 'active'`);
    const results = [];
    for (const bond of bonds.rows) {
      try {
        const r = await BondEngine.accrueInterest(bond.id);
        results.push({ bond_id: bond.id, bond_name: bond.bond_name, accrued: r.accrued, days: r.days });
      } catch (err) {
        results.push({ bond_id: bond.id, bond_name: bond.bond_name, error: err.message });
      }
    }
    await logAdminAction(req, 'accrue_all', 'bonds', null, null, { count: results.length });
    res.json({ success: true, data: results });
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
        usage: 1,
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

// ─── Fineract GL Cleanup & Resync ────────────────────────────────────────────

const { DataBridge } = require('../integrations/accounting/dataBridge');

/**
 * POST /api/admin/fineract/reverse-entry — Reverse a specific Fineract journal entry
 */
router.post('/fineract/reverse-entry', async (req, res) => {
  try {
    const { transactionId } = req.body;
    if (!transactionId) return res.status(400).json({ success: false, error: 'transactionId required' });
    const result = await FineractClient.reverseJournalEntry(transactionId);
    await logAdminAction(req, 'reverse_fineract_entry', 'fineract', transactionId, null, result);
    res.json({ success: true, transactionId, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/admin/fineract/cleanup-duplicates — Reverse duplicate Fineract JEs
 */
router.post('/fineract/cleanup-duplicates', async (req, res) => {
  try {
    const result = await DataBridge.cleanupFineractDuplicates();
    await logAdminAction(req, 'cleanup_fineract_duplicates', 'fineract', null, null, result);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/admin/fineract/post-opening-balances — Post missing opening balance JEs
 */
router.post('/fineract/post-opening-balances', async (req, res) => {
  try {
    const result = await DataBridge.postOpeningBalances();
    await logAdminAction(req, 'post_opening_balances', 'trust_accounting', null, null, result);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/admin/fineract/resync-all — Cleanup duplicates, post opening balances,
 * sync bond accruals, and push everything to Fineract GL.
 */
router.post('/fineract/resync-all', async (req, res) => {
  try {
    const steps = {};

    // Step 1: Reverse wrong trust JEs (the old coupon payment that debited 1200)
    try {
      const { TrustAccountingEngine } = require('../integrations/accounting/trustAccountingEngine');
      const wrongJEs = await pool.query(`
        SELECT je.entry_id FROM trust_journal_entries je
        JOIN trust_journal_lines jl ON jl.entry_id = je.entry_id
        WHERE je.status = 'posted'
          AND je.reference_type = 'ach_disbursement'
          AND jl.account_code = '1200'
          AND jl.debit_amount > 0
      `);
      let reversed = 0;
      for (const row of wrongJEs.rows) {
        try {
          await TrustAccountingEngine.reverseJournalEntry(row.entry_id, { postedBy: 'admin-resync' });
          reversed++;
        } catch (revErr) {
          // Already reversed or other issue — skip
        }
      }
      steps.reversedWrongJEs = reversed;
    } catch (e) { steps.reversedWrongJEs = { error: e.message }; }

    // Step 2: Clean up duplicate Fineract JEs + stale entries
    try {
      steps.fineractCleanup = await DataBridge.cleanupFineractDuplicates();

      // Also reverse any Fineract entries not originating from trust accounting
      const journalRes = await FineractClient.getJournalEntries({ limit: 10000 });
      const fEntries = (journalRes && journalRes.pageItems) || [];
      let staleReversed = 0;
      for (const fe of fEntries) {
        if (fe.reversed) continue;
        const comment = (fe.comments || '').trim();
        // Reverse entries posted directly to Fineract (not via trust JE push)
        if (comment && !comment.startsWith('Trust JE ') && !comment.startsWith('Reversal entry')) {
          try {
            await FineractClient.reverseJournalEntry(fe.transactionId);
            staleReversed++;
          } catch (revErr) { /* already reversed or other issue */ }
        }
      }
      steps.fineractCleanup.staleReversed = staleReversed;
    } catch (e) { steps.fineractCleanup = { error: e.message }; }

    // Step 3: Post opening balances
    try { steps.openingBalances = await DataBridge.postOpeningBalances(); }
    catch (e) { steps.openingBalances = { error: e.message }; }

    // Step 4: Sync bond accruals to trust accounting
    try { steps.bondSync = await DataBridge.syncBondsToAccounting(); }
    catch (e) { steps.bondSync = { error: e.message }; }

    // Step 5: Push all trust JEs to Fineract
    try { steps.fineractPush = await DataBridge.pushToFineract(); }
    catch (e) { steps.fineractPush = { error: e.message }; }

    // Step 6: Correct Fineract GL balances if opening balance was disrupted
    try {
      // Get GL account IDs from mappings
      const mappings = await pool.query(
        "SELECT trust_account_code, fineract_gl_id FROM fineract_gl_mappings WHERE mapping_type = 'trust_journal'"
      );
      const glMap = {};
      for (const m of mappings.rows) glMap[m.trust_account_code] = parseInt(m.fineract_gl_id);

      const bondInvId = glMap['1100'];
      const corpusId = glMap['3000'];

      if (!bondInvId || !corpusId) {
        steps.balanceCorrection = { corrected: false, error: 'Missing GL mappings for 1100 or 3000' };
      } else {
        // Compute current Fineract balance for these accounts from journal entries
        const journalRes = await FineractClient.getJournalEntries({ limit: 10000 });
        const entries = (journalRes && journalRes.pageItems) || [];
        let bondInvBal = 0;
        for (const je of entries) {
          if (je.reversed) continue;
          if (je.glAccountId === bondInvId) {
            const isDebit = je.entryType && je.entryType.value === 'DEBIT';
            bondInvBal += isDebit ? je.amount : -je.amount;
          }
        }

        const bonds = await pool.query("SELECT SUM(face_value) AS total FROM bonds WHERE status = 'active'");
        const expectedFaceValue = parseFloat(bonds.rows[0].total || 0);
        const diff = expectedFaceValue - bondInvBal;

        if (diff > 1) {
          const correctionResult = await FineractClient.postJournalEntry({
            officeId: 1,
            transactionDate: new Date(),
            debits: [{ glAccountId: bondInvId, amount: diff }],
            credits: [{ glAccountId: corpusId, amount: diff }],
            comments: 'Balance correction: restore opening balance for active bonds',
          });
          steps.balanceCorrection = { corrected: true, diff, currentBal: bondInvBal, expected: expectedFaceValue, result: correctionResult };
        } else {
          steps.balanceCorrection = { corrected: false, currentBal: bondInvBal, expected: expectedFaceValue };
        }
      }
    } catch (e) { steps.balanceCorrection = { error: e.message }; }

    await logAdminAction(req, 'fineract_resync_all', 'fineract', null, null, steps);
    res.json({ success: true, steps });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── System Settings (Production/Sandbox Mode) ──────────────────────────────

const { SystemSettings, BANK_REGISTRY } = require('../integrations/ach/systemSettings');

/**
 * GET /api/admin/system/settings — Get all system settings including mode
 */
router.get('/system/settings', async (req, res) => {
  try {
    const settings = await SystemSettings.getAll();
    const mode = settings.system_mode || 'production';
    const productionConfig = await SystemSettings.getProductionPartnerConfig();

    res.json({
      success: true,
      system_mode: mode,
      is_production: mode === 'production',
      settings,
      production_bank: productionConfig ? {
        name: productionConfig.partnerName,
        endpoint: productionConfig.apiBaseUrl,
        auth_type: productionConfig.apiAuthType,
        configured: true,
      } : { configured: false },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/admin/system/settings — Update system settings
 */
router.post('/system/settings', async (req, res) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ error: 'Request body must be a JSON object of key-value pairs' });
    }

    await SystemSettings.setMany(updates, req.headers['x-admin-user'] || 'admin');
    await logAdminAction(req, 'update_system_settings', 'system', null, updates, { updated: Object.keys(updates) });

    const settings = await SystemSettings.getAll();
    res.json({ success: true, message: 'Settings updated', settings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/admin/system/mode — Switch system mode (production/sandbox)
 */
router.post('/system/mode', async (req, res) => {
  try {
    const { mode } = req.body;
    if (!mode) return res.status(400).json({ error: 'mode is required (production or sandbox)' });

    const result = await SystemSettings.setMode(mode, req.headers['x-admin-user'] || 'admin');
    await logAdminAction(req, 'switch_system_mode', 'system', null, { mode }, { new_mode: result });

    res.json({ success: true, system_mode: result, message: `System switched to ${result.toUpperCase()} mode` });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/admin/system/bank-registry — Get pre-configured bank templates
 */
router.get('/system/bank-registry', (req, res) => {
  res.json({ success: true, banks: BANK_REGISTRY });
});

/**
 * POST /api/admin/system/bank-registry/apply — Apply a bank template
 */
router.post('/system/bank-registry/apply', async (req, res) => {
  try {
    const { templateId, overrides } = req.body;
    if (!templateId) return res.status(400).json({ error: 'templateId is required' });

    const result = await SystemSettings.applyBankTemplate(templateId, overrides || {});
    await logAdminAction(req, 'apply_bank_template', 'system', templateId, { overrides }, result);

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/admin/system/test-connection — Test connectivity to configured bank endpoint
 */
router.post('/system/test-connection', async (req, res) => {
  try {
    const result = await SystemSettings.testBankConnection();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
