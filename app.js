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
const fs      = require('fs');
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

// ─── Public website and Treasury Dashboard (before express.static) ──────────
const businessHosts = (process.env.BUSINESS_HOSTS || 'dlbtrustcompany.com,www.dlbtrustcompany.com')
  .split(',')
  .map(host => host.trim().toLowerCase())
  .filter(Boolean);

function sendNoCacheFile(res, filename) {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', filename));
}

app.get('/business', (req, res) => {
  sendNoCacheFile(res, 'business.html');
});
app.get('/', (req, res) => {
  const hostname = String(req.hostname || '').toLowerCase();
  const filename = businessHosts.includes(hostname) ? 'business.html' : 'dashboard.html';
  sendNoCacheFile(res, filename);
});
app.get('/treasury', (req, res) => {
  sendNoCacheFile(res, 'dashboard.html');
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  const idx = path.join(__dirname, 'public', 'index.html');
  fs.existsSync(idx) ? res.sendFile(idx) : res.status(404).send('Not found');
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[dlbtrust] Server running on port ${PORT}`);
  console.log(`[dlbtrust] Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
