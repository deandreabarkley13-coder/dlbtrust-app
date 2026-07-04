'use strict';
var path = require('path');
var fs = require('fs');

// HD = repo root (httpdocs on production, __dirname/.. locally)
var HD = path.resolve(__dirname, '..');

// Use local express (installed via npm install in HD)
var express = require('express');
var app = express();
var PORT = process.env.PORT || 3002;

// ─── Security Middleware ──────────────────────────────────────────────────────
var security = require(path.join(HD, 'server', 'integrations', 'auth', 'securityMiddleware'));

// Helmet.js security headers (XSS, clickjacking, MIME sniffing, CSP, HSTS)
app.use(security.helmetMiddleware());

// CORS lockdown
app.use(security.corsMiddleware());

// Global rate limiting (200 requests/min per IP)
app.use(security.globalRateLimiter());

// Request logging (slow requests and errors)
app.use(security.requestLogger);

// Body parsing
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Input sanitization (null bytes, oversized strings)
app.use(security.sanitizeInput);

// ─── Auth Routes (login, logout, user management) ────────────────────────────
try { app.use('/api/auth', require(path.join(HD, 'server', 'routes', 'auth'))); console.log('[auth] loaded'); } catch(e) { console.warn('[auth]', e.message); }

// V2 wealth management routes REMOVED — treasury system is the only platform now

// OpenACH routes (legacy — kept for backward compat)
try { require(path.join(HD, 'server', 'openach-patch'))(app, null); console.log('[openach] loaded'); } catch(e) { console.warn('[openach]', e.message); }

// Analytics routes
try { app.use('/api/analytics', require(path.join(HD, 'server', 'routes', 'analytics'))); console.log('[analytics] loaded'); } catch(e) { console.warn('[analytics]', e.message); }

// Fineract core banking routes
try { app.use('/api/fineract', require(path.join(HD, 'server', 'routes', 'fineract'))); console.log('[fineract] loaded'); } catch(e) { console.warn('[fineract]', e.message); }

// Fixed Income / Bond routes
try { app.use('/api/bonds', require(path.join(HD, 'server', 'routes', 'bonds'))); console.log('[bonds] loaded'); } catch(e) { console.warn('[bonds]', e.message); }

// Cash Management routes
try { app.use('/api/cash', require(path.join(HD, 'server', 'routes', 'cash'))); console.log('[cash] loaded'); } catch(e) { console.warn('[cash]', e.message); }

// CRM Engine routes
try { app.use('/api/crm', require(path.join(HD, 'server', 'routes', 'crm'))); console.log('[crm] loaded'); } catch(e) { console.warn('[crm]', e.message); }

// Admin Control routes
try { app.use('/api/admin', require(path.join(HD, 'server', 'routes', 'admin'))); console.log('[admin] loaded'); } catch(e) { console.warn('[admin]', e.message); }

// Document Management routes
try { app.use('/api/documents', require(path.join(HD, 'server', 'routes', 'documents'))); console.log('[documents] loaded'); } catch(e) { console.warn('[documents]', e.message); }

// Trust Accounting routes
try { app.use('/api/accounting', require(path.join(HD, 'server', 'routes', 'accounting'))); console.log('[accounting] loaded'); } catch(e) { console.warn('[accounting]', e.message); }

// Payments & Disbursements — OpenACH-powered ACH disbursements
try { app.use('/api/payments', require(path.join(HD, 'server', 'routes', 'payments'))); console.log('[payments] loaded'); } catch(e) { console.warn('[payments]', e.message); }

// ACH Pipeline — NACHA generation + AS2 transmission
try { app.use('/api/ach-pipeline', require(path.join(HD, 'server', 'routes', 'achPipeline'))); console.log('[ach-pipeline] loaded'); } catch(e) { console.warn('[ach-pipeline]', e.message); }

// Wire Transfers — Fedwire origination + dual-approval workflow
try { app.use('/api/wire', require(path.join(HD, 'server', 'routes', 'wire'))); console.log('[wire] loaded'); } catch(e) { console.warn('[wire]', e.message); }

// AS2 Server — open source AS2 messaging (certs, partners, send/receive)
try { app.use('/api/as2', require(path.join(HD, 'server', 'routes', 'as2'))); console.log('[as2] loaded'); } catch(e) { console.warn('[as2]', e.message); }

// Tax Engine — Form 1041 & K-1 generation
try { app.use('/api/tax', require(path.join(HD, 'server', 'routes', 'tax'))); console.log('[tax] loaded'); } catch(e) { console.warn('[tax]', e.message); }

// Backup & System Resilience routes
try { app.use('/api/backup', require(path.join(HD, 'server', 'routes', 'backup'))); console.log('[backup] loaded'); } catch(e) { console.warn('[backup]', e.message); }

// BILL Cash Account integration
try { app.use('/api/bill', require(path.join(HD, 'server', 'routes', 'bill'))); console.log('[bill] loaded'); } catch(e) { console.warn('[bill]', e.message); }

// Sub-Ledger Accounts (per-client accounts within Core Banking)
try { app.use('/api/sub-ledgers', require(path.join(HD, 'server', 'routes', 'subLedger'))); console.log('[sub-ledgers] loaded'); } catch(e) { console.warn('[sub-ledgers]', e.message); }

// Vendor Payments (registry, approval workflow, ACH/Wire/BILL execution)
try { app.use('/api/vendors', require(path.join(HD, 'server', 'routes', 'vendors'))); console.log('[vendors] loaded'); } catch(e) { console.warn('[vendors]', e.message); }

// Electronic Payment & Settlement System
try { app.use('/api/electronic-settlement', require(path.join(HD, 'server', 'routes', 'electronicSettlement'))); console.log('[electronic-settlement] loaded'); } catch(e) { console.warn('[electronic-settlement]', e.message); }

// Apache NiFi Payment File Transfer
try { app.use('/api/nifi', require(path.join(HD, 'server', 'routes', 'nifi'))); console.log('[nifi] loaded'); } catch(e) { console.warn('[nifi]', e.message); }

// Trustee Agent & Bookkeeping Agent
try { app.use('/api/agents', require(path.join(HD, 'server', 'routes', 'agents'))); console.log('[agents] loaded'); } catch(e) { console.warn('[agents]', e.message); }

// Treasury Management System — serve dashboard at root, static files from public/
app.get('/', function(req, res) {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(HD, 'public', 'dashboard.html'));
});
app.get('/treasury', function(req, res) {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(HD, 'public', 'dashboard.html'));
});
// ─── Health / Data Integrity Endpoint ──────────────────────────────────────
app.get('/api/health', async function(req, res) {
  try {
    var pool = require(path.join(HD, 'server', 'integrations', 'bonds', 'pgPool'));
    var checks = {};

    var [bondRes, cashRes, trustRes, userRes] = await Promise.all([
      pool.query("SELECT COUNT(*) as c, COALESCE(SUM(face_value),0) as total FROM bonds WHERE status = 'active'"),
      pool.query("SELECT COUNT(*) as c FROM cash_accounts WHERE status = 'active'"),
      pool.query("SELECT COUNT(*) as c FROM trust_accounts"),
      pool.query("SELECT COUNT(*) as c FROM auth_users"),
    ]);
    checks.bonds = { ok: bondRes.rows[0].c > 0, count: parseInt(bondRes.rows[0].c), totalValue: Number(bondRes.rows[0].total) };
    checks.cashAccounts = { ok: cashRes.rows[0].c > 0, count: parseInt(cashRes.rows[0].c) };
    checks.trustAccounts = { ok: trustRes.rows[0].c > 0, count: parseInt(trustRes.rows[0].c) };
    checks.authUsers = { ok: userRes.rows[0].c > 0, count: parseInt(userRes.rows[0].c) };
    checks.database = { ok: true };

    var fineractOk = false;
    try {
      var FineractClient = require(path.join(HD, 'server', 'integrations', 'fineract', 'fineractClient')).FineractClient;
      await FineractClient.healthCheck();
      fineractOk = true;
    } catch(e) {}
    checks.fineract = { ok: fineractOk };

    var billOk = false;
    try {
      var billClient = require(path.join(HD, 'server', 'integrations', 'bill', 'billClient'));
      if (billClient.isConfigured()) {
        var billStatus = await billClient.getStatus();
        billOk = billStatus.connected;
        checks.bill = { ok: billOk, configured: true };
      } else {
        checks.bill = { ok: false, configured: false };
      }
    } catch(e) { checks.bill = { ok: false, configured: false, error: e.message }; }

    // Include DB circuit breaker status
    if (pool.getCircuitStatus) {
      checks.dbCircuit = pool.getCircuitStatus();
    }

    var coreOk = checks.bonds.ok && checks.cashAccounts.ok && checks.trustAccounts.ok && checks.authUsers.ok && checks.database.ok;
    res.json({
      status: coreOk ? 'healthy' : 'degraded',
      uptime: process.uptime(),
      startedAt: global.__dlb_startup || new Date().toISOString(),
      checks: checks,
    });
  } catch (e) {
    var pool2 = null;
    try { pool2 = require(path.join(HD, 'server', 'integrations', 'bonds', 'pgPool')); } catch(x) {}
    var circuitInfo = (pool2 && pool2.getCircuitStatus) ? pool2.getCircuitStatus() : null;
    res.status(503).json({ status: 'unhealthy', error: e.message, dbCircuit: circuitInfo });
  }
});

app.use(express.static(path.join(HD, 'public'), {
  etag: false,
  maxAge: 0,
  lastModified: true,
  setHeaders: function(res, filePath) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
  }
}));
app.get('*', function(req, res) {
  var idx = path.join(HD, 'public', 'index.html');
  fs.existsSync(idx) ? res.sendFile(idx) : res.status(404).send('Not found');
});

// ─── Sequential Database Initialization ───────────────────────────────────────
// Runs all migrations serially to avoid connection storms on Fly.io cold boot.
// Fly.io's Postgres proxy kills idle connections; simultaneous init queries from
// 12+ modules overwhelm it. Sequential init with warmup prevents this.
async function initializeDatabase() {
  var pool = require(path.join(HD, 'server', 'integrations', 'bonds', 'pgPool'));

  // Step 0: Warmup — establish a live connection before running migrations
  var warmupAttempts = 0;
  var MAX_WARMUP = 5;
  while (warmupAttempts < MAX_WARMUP) {
    try {
      await pool.query('SELECT 1');
      console.log('[startup] Database connection warm (' + (warmupAttempts + 1) + '/' + MAX_WARMUP + ' attempts)');
      break;
    } catch (e) {
      warmupAttempts++;
      if (warmupAttempts >= MAX_WARMUP) {
        console.error('[startup] Database warmup failed after ' + MAX_WARMUP + ' attempts:', e.message);
        return; // Skip migrations — app will still serve requests, pool will recover via keepalive
      }
      console.warn('[startup] Warmup attempt ' + warmupAttempts + ' failed: ' + e.message + ' — retrying in 2s');
      await new Promise(function(r) { setTimeout(r, 2000); });
    }
  }

  // Step 1: Core tables (auth, wire, agents)
  try {
    var UserAuth = require(path.join(HD, 'server', 'integrations', 'auth', 'userAuth')).UserAuth;
    await UserAuth.ensureTables();
    console.log('[auth] tables ensured');
  } catch(e) { console.warn('[auth] table init:', e.message); }

  try {
    var WireEngine = require(path.join(HD, 'server', 'integrations', 'wire', 'wireEngine')).WireEngine;
    await WireEngine.ensureTables();
    console.log('[wire] tables ensured');
  } catch(e) { console.warn('[wire] table init:', e.message); }

  try {
    var TrusteeAgent = require(path.join(HD, 'server', 'integrations', 'agents', 'trusteeAgent')).TrusteeAgent;
    var BookkeepingAgent = require(path.join(HD, 'server', 'integrations', 'agents', 'bookkeepingAgent')).BookkeepingAgent;
    await TrusteeAgent.ensureTables();
    await BookkeepingAgent.ensureTables();
    console.log('[agents] tables ensured (trustee + bookkeeping)');
  } catch(e) { console.warn('[agents] table init:', e.message); }

  // Electronic Settlement tables
  try {
    var esEngine = require(path.join(HD, 'server', 'integrations', 'payments', 'electronicSettlementEngine'));
    await esEngine.ensureTables();
    console.log('[electronic-settlement] tables ensured');
  } catch(e) { console.warn('[electronic-settlement] table init:', e.message); }

  // Step 2: Data infrastructure (DataBridge, system settings, bonds metadata)
  try {
    var DataBridge = require(path.join(HD, 'server', 'integrations', 'accounting', 'dataBridge')).DataBridge;
    await DataBridge.ensureTables();
    console.log('[data-bridge] tables ensured');
  } catch(e) { console.warn('[data-bridge] table init:', e.message); }

  try {
    var SystemSettings = require(path.join(HD, 'server', 'integrations', 'ach', 'systemSettings')).SystemSettings;
    await SystemSettings.ensureTable();
    var mode = await SystemSettings.getMode();
    console.log('[system-settings] table ensured, mode=' + mode);
  } catch(e) { console.warn('[system-settings] init:', e.message); }

  try {
    await pool.query(`
      ALTER TABLE bonds ADD COLUMN IF NOT EXISTS bond_identifier TEXT;
      ALTER TABLE bonds ADD COLUMN IF NOT EXISTS bond_type TEXT DEFAULT 'corporate';
      ALTER TABLE bonds ADD COLUMN IF NOT EXISTS tax_exempt BOOLEAN DEFAULT FALSE;
      ALTER TABLE bonds ADD COLUMN IF NOT EXISTS tax_exempt_type TEXT;
      ALTER TABLE bonds ADD COLUMN IF NOT EXISTS placement_type TEXT DEFAULT 'public';
      ALTER TABLE bonds ADD COLUMN IF NOT EXISTS issuer TEXT;
      ALTER TABLE bonds ADD COLUMN IF NOT EXISTS issuer_state TEXT;
    `);
    await pool.query(`
      UPDATE bonds SET
        bond_identifier = '19781443-DLB-PRB',
        bond_type = 'municipal',
        tax_exempt = TRUE,
        tax_exempt_type = 'interest',
        placement_type = 'private',
        issuer = 'DeAndrea Lavar Barkley Trust',
        issuer_state = 'CA'
      WHERE bond_name = 'DLB-PRB' AND bond_identifier IS NULL
    `);
    console.log('[bonds] metadata columns ensured (identifier, type, tax status)');
  } catch(e) { console.warn('[bonds] metadata migration:', e.message); }

  // Step 3: Module tables (sub-ledgers, vendors, BILL sync, CRM)
  try {
    var SubLedgerEngine = require(path.join(HD, 'server', 'integrations', 'accounting', 'subLedgerEngine')).SubLedgerEngine;
    await SubLedgerEngine.ensureTables();
    console.log('[sub-ledgers] tables ensured');
  } catch(e) { console.warn('[sub-ledgers] init:', e.message); }

  try {
    var VendorEngine = require(path.join(HD, 'server', 'integrations', 'vendors', 'vendorEngine')).VendorEngine;
    await VendorEngine.ensureTables();
    console.log('[vendors] tables ensured');
  } catch(e) { console.warn('[vendors] init:', e.message); }

  try {
    var BillSyncEngine = require(path.join(HD, 'server', 'integrations', 'bill', 'billSyncEngine')).BillSyncEngine;
    await BillSyncEngine.ensureTables();
    console.log('[bill-sync] tables ensured');
    var billClientCheck = require(path.join(HD, 'server', 'integrations', 'bill', 'billClient'));
    if (billClientCheck.isConfigured()) {
      BillSyncEngine.startAutoSync(5 * 60 * 1000);
    }
  } catch(e) { console.warn('[bill-sync] init:', e.message); }

  try {
    await pool.query(`
      ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'pending_approval';
      ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS approved_by TEXT;
      ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
      ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS rejected_by TEXT;
      ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
    `);
    console.log('[crm] approval workflow columns ensured');
  } catch(e) { console.warn('[crm] approval migration:', e.message); }

  // Step 4: Schedulers (bond accrual, coupon service)
  try {
    var LiveBondEngine = require(path.join(HD, 'server', 'integrations', 'bonds', 'liveEngine')).LiveBondEngine;
    LiveBondEngine.scheduleAccrualJob();
    console.log('[liveEngine] daily accrual scheduler started');
  } catch(e) { console.warn('[liveEngine]', e.message); }

  try {
    var CouponService = require(path.join(HD, 'server', 'integrations', 'bonds', 'couponService')).CouponService;
    await CouponService.ensureTable();
    console.log('[couponService] coupon_payments table ensured');
    var seedResult = await CouponService.seedBondholders();
    if (seedResult.seeded) console.log('[couponService] Seeded ' + seedResult.count + ' bondholder(s)');
    CouponService.scheduleCouponJob();
  } catch(e) { console.warn('[couponService] init:', e.message); }

  console.log('[startup] All database migrations complete');
}

// Kick off sequential init (non-blocking — server is already listening)
initializeDatabase().catch(function(e) {
  console.error('[startup] Fatal init error:', e.message);
});

// ─── Graceful Shutdown & Backup Initialization ─────────────────────────────
try {
  var gracefulShutdown = require(path.join(HD, 'server', 'integrations', 'backup', 'gracefulShutdown'));
  gracefulShutdown.install();
} catch(e) { console.warn('[graceful-shutdown]', e.message); }

var server = app.listen(PORT, function() {
  console.log('[dlbtrust-treasury] running on port ' + PORT);

  // Register server for graceful shutdown
  try { gracefulShutdown.registerServer(server); } catch(e) {}

  // Start scheduled backups (every 6 hours)
  try {
    var backupEngine = require(path.join(HD, 'server', 'integrations', 'backup', 'backupEngine'));
    backupEngine.startScheduledBackups();
  } catch(e) { console.warn('[backup-scheduler]', e.message); }

  // Record server start in transaction journal
  try {
    var journal = require(path.join(HD, 'server', 'integrations', 'backup', 'transactionJournal'));
    journal.record('server_start', { port: PORT, node_version: process.version, pid: process.pid }, 'system');
  } catch(e) {}

  // Auto-seed Fineract GL accounts and post opening balance on startup (with retry)
  async function initFineract(attempt) {
    attempt = attempt || 1;
    var MAX_ATTEMPTS = 5;
    var RETRY_DELAY = 10000; // 10 seconds between retries
    try {
      var FineractClient = require(path.join(HD, 'server', 'integrations', 'fineract', 'fineractClient')).FineractClient;
      var pool = require(path.join(HD, 'server', 'integrations', 'bonds', 'pgPool'));

      // Check Fineract connectivity
      await FineractClient.healthCheck();
      console.log('[fineract-init] Fineract connected — checking GL accounts');

      // Get existing GL accounts
      var existingAccounts = await FineractClient.getGLAccounts();
      var detailAccounts = Array.isArray(existingAccounts)
        ? existingAccounts.filter(function(a) { return a.usage && a.usage.id === 1; })
        : [];

      if (detailAccounts.length >= 15) {
        console.log('[fineract-init] GL accounts already seeded (' + detailAccounts.length + ' detail accounts)');
      } else {
        console.log('[fineract-init] Seeding GL accounts...');
        var TYPE_MAP = { asset: 1, liability: 2, equity: 3, income: 4, expense: 5 };
        var trustAcctsRes = await pool.query('SELECT account_code, account_name, account_type, sub_type FROM trust_accounts ORDER BY account_code');
        var existingCodes = new Set(detailAccounts.map(function(a) { return a.glCode; }));
        var created = 0;

        for (var i = 0; i < trustAcctsRes.rows.length; i++) {
          var acct = trustAcctsRes.rows[i];
          if (existingCodes.has(acct.account_code)) continue;
          var fType = TYPE_MAP[acct.account_type];
          if (!fType) continue;
          try {
            var result = await FineractClient.createGLAccount({
              name: acct.account_name, glCode: acct.account_code,
              type: fType, usage: 1,
              description: 'Trust account: ' + acct.account_name + ' (' + (acct.sub_type || acct.account_type) + ')',
            });
            var fId = result.resourceId || result.id;
            await pool.query(
              "INSERT INTO fineract_gl_mappings (mapping_type, trust_account_code, fineract_gl_id, description) SELECT $1, $2, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM fineract_gl_mappings WHERE mapping_type = $1 AND trust_account_code = $2)",
              ['trust_journal', acct.account_code, fId, acct.account_name + ' (' + acct.account_type + ')']
            );
            created++;
          } catch (seedErr) {
            console.warn('[fineract-init] skip ' + acct.account_code + ':', seedErr.message);
          }
        }
        console.log('[fineract-init] Created ' + created + ' GL accounts');
      }

      // Check if opening balance journal entry exists
      var journalRes = await FineractClient.getJournalEntries({ limit: 100 });
      var entries = (journalRes && journalRes.pageItems) || [];
      var hasOpeningBalance = entries.some(function(je) {
        return !je.reversed && je.amount === 100000000 && je.comments && je.comments.indexOf('Opening balance') >= 0;
      });

      if (hasOpeningBalance) {
        console.log('[fineract-init] Opening balance already posted');
      } else {
        // Find Bond Investments and Trust Corpus detail account IDs from mappings
        var mappingsRes = await pool.query("SELECT trust_account_code, fineract_gl_id FROM fineract_gl_mappings WHERE trust_account_code IN ('1100', '3000')");
        var bondGlId = null, corpusGlId = null;
        mappingsRes.rows.forEach(function(m) {
          if (m.trust_account_code === '1100') bondGlId = m.fineract_gl_id;
          if (m.trust_account_code === '3000') corpusGlId = m.fineract_gl_id;
        });
        if (bondGlId && corpusGlId) {
          await FineractClient.postJournalEntry({
            transactionDate: new Date(),
            debits: [{ glAccountId: bondGlId, amount: 100000000 }],
            credits: [{ glAccountId: corpusGlId, amount: 100000000 }],
            comments: 'Opening balance — DLB-PRB bond issuance $100M face value',
          });
          console.log('[fineract-init] Posted $100M opening balance (Bond Investments ↔ Trust Corpus)');
        } else {
          console.warn('[fineract-init] Could not find GL mappings for opening balance');
        }
      }

      // Pre-warm GL summary cache so it's available when Fineract disconnects
      try {
        await FineractClient.getGLSummary();
        console.log('[fineract-init] GL summary cache pre-warmed');
      } catch (cacheErr) {
        console.warn('[fineract-init] Cache pre-warm failed:', cacheErr.message);
      }
    } catch (initErr) {
      if (attempt < MAX_ATTEMPTS) {
        console.warn('[fineract-init] Attempt ' + attempt + '/' + MAX_ATTEMPTS + ' failed: ' + initErr.message + ' — retrying in ' + (RETRY_DELAY/1000) + 's');
        setTimeout(function() { initFineract(attempt + 1); }, RETRY_DELAY);
      } else {
        console.warn('[fineract-init] All ' + MAX_ATTEMPTS + ' attempts failed. GL will be managed by local Trust Accounting engine. (' + initErr.message + ')');
      }
    }
  }
  setTimeout(function() { initFineract(1); }, 5000);

  // ─── Fineract Resilience Monitoring ─────────────────────────────────────────
  try {
    var fineractResilience = require(path.join(HD, 'server', 'integrations', 'fineract', 'fineractResilience'));
    fineractResilience.startMonitoring();
    // Clear any stale Liquibase locks on startup
    fineractResilience.cleanLiquibaseLocks().then(function(result) {
      if (result && result.results) {
        var cleared = result.results.filter(function(r) { return r.action === 'cleared'; });
        if (cleared.length > 0) console.log('[fineract-resilience] Cleared stale Liquibase locks on startup');
      }
    }).catch(function(e) { /* non-critical */ });
  } catch(e) { console.warn('[fineract-resilience]', e.message); }

  // ─── Data Integrity Check on Startup ────────────────────────────────────────
  setTimeout(async function() {
    try {
      var pool = require(path.join(HD, 'server', 'integrations', 'bonds', 'pgPool'));
      var checks = { bonds: false, cashAccounts: false, trustAccounts: false, users: false };

      var bondRes = await pool.query("SELECT COUNT(*) as c, COALESCE(SUM(face_value),0) as total FROM bonds WHERE status = 'active'");
      checks.bonds = bondRes.rows[0].c > 0;
      console.log('[data-check] Bonds: ' + bondRes.rows[0].c + ' active ($' + Number(bondRes.rows[0].total).toLocaleString() + ')');

      var cashRes = await pool.query("SELECT COUNT(*) as c FROM cash_accounts WHERE status = 'active'");
      checks.cashAccounts = cashRes.rows[0].c > 0;
      console.log('[data-check] Cash accounts: ' + cashRes.rows[0].c + ' active');

      var trustRes = await pool.query("SELECT COUNT(*) as c FROM trust_accounts");
      checks.trustAccounts = trustRes.rows[0].c > 0;
      console.log('[data-check] Trust accounts: ' + trustRes.rows[0].c);

      var userRes = await pool.query("SELECT COUNT(*) as c FROM auth_users");
      checks.users = userRes.rows[0].c > 0;
      console.log('[data-check] Auth users: ' + userRes.rows[0].c);

      var allOk = Object.values(checks).every(function(v) { return v; });
      console.log('[data-check] Data integrity: ' + (allOk ? 'ALL OK' : 'ISSUES DETECTED — ' + JSON.stringify(checks)));

      // Store startup time for health endpoint
      global.__dlb_startup = new Date().toISOString();
      global.__dlb_data_integrity = checks;
    } catch (e) {
      console.warn('[data-check] Error:', e.message);
    }
  }, 3000);
});
