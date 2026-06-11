/**
 * dlbtrust.cloud — Express Application Entry Point
 * DEANDREA LAVAR BARKLEY TRUST — Secure Wealth Management Portal
 * 
 * This file is the fallback/reference app.js.
 * The live server may use server.js — both are patched identically.
 */

'use strict';

require('dotenv').config();

const express = require('express');
const path    = require('path');
const app     = express();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Request timeout — prevent hung requests from freezing the server
app.use((req, res, next) => {
  res.setTimeout(30000, () => {
    if (!res.headersSent) {
      res.status(504).json({ error: 'Request timed out' });
    }
  });
  next();
});

// ─── Database ─────────────────────────────────────────────────────────────────
let db = null;
try {
  const Database = require('better-sqlite3');
  const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'dlbtrust.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  console.log('[DB] SQLite connected:', dbPath);
} catch (err) {
  console.warn('[DB] SQLite not available:', err.message);
}

// ─── Data Retention — Run migrations on startup, auto-backup pre-deploy ──────
if (db) {
  try {
    const { runMigrations, createBackup } = require('./server/engines/data-retention-engine');
    const { initApprovalSchema } = require('./server/engines/approval-engine');
    initApprovalSchema(db);
    const migrationResult = runMigrations(db);
    console.log(`[retention] Migrations: ${migrationResult.applied} applied, ${migrationResult.skipped} skipped`);
    if (process.env.PRE_DEPLOY_BACKUP === 'true') {
      const backup = createBackup(db, { backupType: 'pre_deploy', triggeredBy: 'startup' });
      console.log(`[retention] Pre-deploy backup: ${backup.backup_id}`);
    }
  } catch (err) {
    console.warn('[retention] Startup init warning:', err.message);
  }
}

// ─── OpenACH Integration ──────────────────────────────────────────────────────
require('./server/openach-patch')(app, typeof db !== 'undefined' ? db : null);

// ─── Analytics Routes ─────────────────────────────────────────────────────────
app.use('/api/analytics', require('./server/routes/analytics'));

// ─── Core Banking Engine Routes ───────────────────────────────────────────────
app.use('/api/accounts',  require('./server/routes/accounts'));
app.use('/api/transfers', require('./server/routes/transfers'));
app.use('/api/wealth',    require('./server/routes/wealth'));

// ─── CRM Engine Routes ──────────────────────────────────────────────────────
app.use('/api/crm',       require('./server/routes/crm'));

// ─── External Transfer Routes ───────────────────────────────────────────────
app.use('/api/external-transfers', require('./server/routes/external-transfers'));

// ─── Trust Accounting Routes ────────────────────────────────────────────────
app.use('/api/trust-accounting', require('./server/routes/trust-accounting'));

// ─── Fixed Income Routes (Bond Portfolio + Private Placements) ──────────────
app.use('/api/fixed-income', require('./server/routes/fixed-income'));

// ─── Blockchain / Crypto Rails Routes (Circle + Polygon USDC) ──────────────
app.use('/api/blockchain', require('./server/routes/blockchain'));

// ─── Cash Management System Routes (Treasury & Liquidity) ──────────────────
app.use('/api/cash-management', require('./server/routes/cash-management'));

// ─── Document Management System Routes (Trust Documents) ────────────────────
app.use('/api/documents', require('./server/routes/documents'));

// ─── AI Agent Routes (Platform Assistant) ───────────────────────────────────
app.use('/api/agent', require('./server/routes/ai-agent'));

// ─── Document Generation Engine Routes (Automated Reports) ───────────────────
app.use('/api/document-generation', require('./server/routes/document-generation'));

// ─── Integration API Routes (Cross-Engine Orchestration) ─────────────────────
app.use('/api/integration', require('./server/routes/integration'));

// ─── Fineract Banking Routes (Open-Source Core Banking) ──────────────────────
app.use('/api/fineract', require('./server/routes/fineract'));

// ─── Banking ↔ Crypto Bridge Routes (MoonPay + Polygon Real Money) ───────────
app.use('/api/bridge', require('./server/routes/bridge'));

// ─── Polygon CDK Appchain Routes (Smart Contracts + Token Minting) ───────────
app.use('/api/cdk', require('./server/routes/cdk'));

// ─── Open Banking Project Routes (Self-Hosted OBP) ──────────────────────────
app.use('/api/obp', require('./server/routes/obp'));

// ─── Payment Gateway Routes (Self-Contained External Payments) ───────────────
app.use('/api/gateway', require('./server/routes/gateway'));

// ─── Virtual Account Routes (Auto-Generated Payment Accounts) ────────────────
app.use('/api/virtual-accounts', require('./server/routes/virtual-accounts'));

// ─── Trustee Approval & Data Retention Routes ────────────────────────────────
app.use('/api/approval', require('./server/routes/approval'));

// ─── Trustee Assignment & Beneficiary Expense Management ─────────────────────
app.use('/api/trustee-assignments', require('./server/routes/trustee-assignments'));

// ─── Frontend Dashboard ───────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'frontend')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'frontend', 'index.html')));

// ─── Settlement Auto-Check (every 30 minutes) ─────────────────────────────────
const { checkSettlements, initSettlementSchema } = require('./server/engines/settlement-engine');
setInterval(() => {
  try {
    const Database = require('better-sqlite3');
    const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'dlbtrust.db');
    const db = new Database(dbPath);
    initSettlementSchema(db);
    const results = checkSettlements(db);
    if (results.cleared.length > 0) {
      console.log(`[settlement] Auto-cleared ${results.cleared.length} payment(s)`);
    }
    db.close();
  } catch (err) {
    console.warn('[settlement] Auto-check error:', err.message);
  }
}, 30 * 60 * 1000); // every 30 minutes

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[dlbtrust] Server running on port ${PORT}`);
  console.log(`[dlbtrust] Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
