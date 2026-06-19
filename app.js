/**
 * dlbtrust.cloud — Express Application Entry Point
 * DEANDREA LAVAR BARKLEY TRUST — Treasury Management System
 * 
 * This file is the fallback/reference app.js.
 * The live server uses server-new-fixed.js — both are patched identically.
 */

'use strict';

require('dotenv').config();

const express = require('express');
const path    = require('path');
const app     = express();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// ─── OpenACH Integration ──────────────────────────────────────────────────────
require('./server/openach-patch')(app, typeof db !== 'undefined' ? db : null);

// ─── Analytics Routes ─────────────────────────────────────────────────────────
app.use('/api/analytics', require('./server/routes/analytics'));

// ─── Fineract Core Banking Routes ─────────────────────────────────────────────
app.use('/api/fineract', require('./server/routes/fineract'));

// ─── Fixed Income / Bond Routes ───────────────────────────────────────────────
app.use('/api/bonds', require('./server/routes/bonds'));

// ─── Cash Management Routes ──────────────────────────────────────────────────
app.use('/api/cash', require('./server/routes/cash'));

// ─── CRM Engine Routes ──────────────────────────────────────────────────────
app.use('/api/crm', require('./server/routes/crm'));

// ─── Admin Control Routes ────────────────────────────────────────────────────
app.use('/api/admin', require('./server/routes/admin'));

// ─── Document Management Routes ──────────────────────────────────────────────
app.use('/api/documents', require('./server/routes/documents'));

// ─── Trust Accounting Routes ─────────────────────────────────────────────────
app.use('/api/accounting', require('./server/routes/accounting'));

// ─── ACH Pipeline — NACHA generation + AS2 transmission ─────────────────────
app.use('/api/ach-pipeline', require('./server/routes/achPipeline'));

// ─── AS2 Server — open source AS2 messaging ─────────────────────────────────
app.use('/api/as2', require('./server/routes/as2'));

// ─── Live Bond Accrual Scheduler ─────────────────────────────────────────────
try {
  const { LiveBondEngine } = require('./server/integrations/bonds/liveEngine');
  LiveBondEngine.scheduleAccrualJob();
} catch(e) { console.warn('[liveEngine]', e.message); }

// ─── Treasury Dashboard (must be before express.static) ────────────────────
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.get('/treasury', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[dlbtrust] Server running on port ${PORT}`);
  console.log(`[dlbtrust] Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
