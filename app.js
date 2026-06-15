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

// ─── Fineract Core Banking Routes ─────────────────────────────────────────────
app.use('/api/fineract', require('./server/routes/fineract'));

// ─── Fixed Income / Bond Routes ───────────────────────────────────────────────
app.use('/api/bonds', require('./server/routes/bonds'));

// ─── Bond Schema Auto-Init ────────────────────────────────────────────────────
const bondPool = require('./server/integrations/bonds/pgPool');
(async () => {
  try {
    await bondPool.query(`
      CREATE TABLE IF NOT EXISTS bonds (
        id SERIAL PRIMARY KEY, bond_name VARCHAR(255) NOT NULL, isin VARCHAR(20),
        face_value NUMERIC(18,2) NOT NULL, coupon_rate NUMERIC(8,6) NOT NULL,
        issue_date DATE NOT NULL, maturity_date DATE NOT NULL,
        payment_freq VARCHAR(20) NOT NULL DEFAULT 'monthly',
        day_count VARCHAR(20) NOT NULL DEFAULT '30/360',
        currency VARCHAR(3) NOT NULL DEFAULT 'USD',
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await bondPool.query(`
      CREATE TABLE IF NOT EXISTS bond_balances (
        id SERIAL PRIMARY KEY, bond_id INTEGER NOT NULL,
        principal_balance NUMERIC(18,2) NOT NULL, accrued_interest NUMERIC(18,2) NOT NULL DEFAULT 0,
        total_interest_paid NUMERIC(18,2) NOT NULL DEFAULT 0, total_principal_paid NUMERIC(18,2) NOT NULL DEFAULT 0,
        last_accrual_date DATE, last_payment_date DATE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(bond_id)
      );
    `);
    await bondPool.query(`
      CREATE TABLE IF NOT EXISTS bond_transactions (
        id SERIAL PRIMARY KEY, bond_id INTEGER NOT NULL,
        transaction_type VARCHAR(30) NOT NULL, amount NUMERIC(18,2) NOT NULL,
        running_balance NUMERIC(18,2) NOT NULL, accrued_interest NUMERIC(18,2) NOT NULL DEFAULT 0,
        description TEXT, fineract_txn_id VARCHAR(100),
        transaction_date DATE NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await bondPool.query(`
      CREATE INDEX IF NOT EXISTS idx_bond_txn_bond_id ON bond_transactions(bond_id);
      CREATE INDEX IF NOT EXISTS idx_bond_txn_date ON bond_transactions(transaction_date);
      CREATE INDEX IF NOT EXISTS idx_bond_txn_type ON bond_transactions(transaction_type);
    `);
    console.log('[BondDB] Schema initialized successfully');
  } catch (err) {
    console.warn('[BondDB] Schema init skipped:', err.message);
  }
})();

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[dlbtrust] Server running on port ${PORT}`);
  console.log(`[dlbtrust] Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
