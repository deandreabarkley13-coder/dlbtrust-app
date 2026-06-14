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

// ─── Bond Portfolio Table + Seed ──────────────────────────────────────────────
if (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bond_portfolio (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instrument_name TEXT NOT NULL DEFAULT 'DeAndrea Lavar Barkley Trust Bond',
      face_value_cents INTEGER NOT NULL,
      coupon_rate_pct REAL NOT NULL,
      issue_date TEXT NOT NULL,
      maturity_date TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  const existing = db.prepare('SELECT id FROM bond_portfolio LIMIT 1').get();
  if (!existing) {
    db.prepare(`
      INSERT INTO bond_portfolio (instrument_name, face_value_cents, coupon_rate_pct, issue_date, maturity_date)
      VALUES (?, ?, ?, ?, ?)
    `).run('DeAndrea Lavar Barkley Trust Bond', 10000000000, 1.0, '2024-02-28', '2124-02-28');
  }
}

// ─── Share DB with routes ─────────────────────────────────────────────────────
if (db) {
  app.locals.db = db;
}

// ─── OpenACH Integration ──────────────────────────────────────────────────────
require('./server/openach-patch')(app, typeof db !== 'undefined' ? db : null);

// ─── Analytics Routes ─────────────────────────────────────────────────────────
app.use('/api/analytics', require('./server/routes/analytics'));

// ─── ACH File Queue Routes ────────────────────────────────────────────────────
app.use('/api/ach-queue', require('./server/routes/ach-queue'));

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[dlbtrust] Server running on port ${PORT}`);
  console.log(`[dlbtrust] Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
