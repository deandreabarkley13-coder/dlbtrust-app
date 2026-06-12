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
const pool = require('./server/db');
pool.query('SELECT 1').then(() => {
  console.log('[DB] PostgreSQL connected via Supabase');
}).catch(err => {
  console.warn('[DB] PostgreSQL connection failed:', err.message);
});

// ─── OpenACH Integration ──────────────────────────────────────────────────────
require('./server/openach-patch')(app, pool);

// ─── Analytics Routes ─────────────────────────────────────────────────────────
app.use('/api/analytics', require('./server/routes/analytics'));

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[dlbtrust] Server running on port ${PORT}`);
  console.log(`[dlbtrust] Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
