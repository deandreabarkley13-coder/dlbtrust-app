/**
 * PostgreSQL Connection Pool — Shared by the Fixed Income Engine
 *
 * Connects to the same PostgreSQL instance used by Fineract (fineract_tenants DB).
 * Bond tables live alongside Fineract's tenant metadata.
 */

'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.FINERACT_DB_HOST || 'localhost',
  port:     parseInt(process.env.FINERACT_DB_PORT || '5432', 10),
  user:     process.env.FINERACT_DB_USER || 'postgres',
  password: process.env.FINERACT_DB_PASSWORD || 'postgres',
  database: process.env.BOND_DB_NAME || 'fineract_tenants',
  max:      5,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[BondDB] Unexpected pool error:', err.message);
});

module.exports = pool;
