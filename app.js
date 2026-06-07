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

// ─── Integration API Routes (Cross-Engine Orchestration) ─────────────────────
app.use('/api/integration', require('./server/routes/integration'));

// ─── Frontend Dashboard ───────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'frontend')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'frontend', 'index.html')));

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[dlbtrust] Server running on port ${PORT}`);
  console.log(`[dlbtrust] Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
