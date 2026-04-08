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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

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

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[dlbtrust] Server running on port ${PORT}`);
  console.log(`[dlbtrust] Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
