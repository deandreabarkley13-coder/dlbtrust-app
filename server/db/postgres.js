/**
 * PostgreSQL Connection Pool — dlbtrust-app
 * Uses DATABASE_URL from .env for connection configuration.
 */

'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[postgres] Unexpected pool error:', err.message);
});

module.exports = pool;
