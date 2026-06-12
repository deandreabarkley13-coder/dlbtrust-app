'use strict';
require('dotenv').config();

const express = require('express');
const path    = require('path');
const app     = express();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Database (PostgreSQL via Supabase) ───────────────────────────────────────
const pool = require('./server/db');
pool.query('SELECT 1').then(() => {
  console.log('[DB] PostgreSQL connected');
  app.locals.db = pool;
}).catch(err => {
  console.warn('[DB] PostgreSQL connection failed:', err.message);
});

// ─── Routes ───────────────────────────────────────────────────────────────────
require('./server/openach-patch')(app, pool);                    // mounts /api/ach
app.use('/api/payments',  require('./server/routes/payments'));   // FIX: was never mounted
app.use('/api/analytics', require('./server/routes/analytics'));
app.use('/api/bonds',     require('./server/routes/bonds'));      // from Bond Master plan

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[dlbtrust] Server running on port ${PORT}`);
  console.log(`[dlbtrust] Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
