/**
 * PostgreSQL Connection Pool — Shared by the Fixed Income Engine
 *
 * Connects via DATABASE_URL (Fly.io, Render, etc.) or individual env vars.
 * Bond tables live alongside Fineract's tenant metadata.
 *
 * Exports a resilient pool wrapper that automatically retries queries when
 * Fly.io's Postgres proxy terminates idle connections.
 */

'use strict';

const { Pool } = require('pg');

const RETRY_ERRORS = [
  'Connection terminated unexpectedly',
  'Connection terminated',
  'connection is insecure',
  'Client has encountered a connection error',
  'terminating connection due to administrator command',
  'sorry, too many clients already',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
];

function isRetryable(err) {
  if (!err) return false;
  const msg = err.message || '';
  const code = err.code || '';
  return RETRY_ERRORS.some(e => msg.includes(e)) ||
    code === 'ECONNRESET' || code === 'ECONNREFUSED' ||
    code === '57P01' /* admin shutdown */ ||
    code === '57P03' /* cannot connect now */;
}

let poolConfig;
if (process.env.DATABASE_URL) {
  poolConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: 8,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5000,
  };
} else {
  poolConfig = {
    host:     process.env.FINERACT_DB_HOST || 'localhost',
    port:     parseInt(process.env.FINERACT_DB_PORT || '5432', 10),
    user:     process.env.FINERACT_DB_USER || 'postgres',
    password: process.env.FINERACT_DB_PASSWORD || 'postgres',
    database: process.env.BOND_DB_NAME || 'fineract_tenants',
    max:      8,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5000,
  };
}

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('[BondDB] Unexpected pool error:', err.message);
});

// Resilient wrapper: retries once on connection-level errors
const resilientPool = {
  async query(text, params) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      if (isRetryable(err)) {
        console.warn('[BondDB] Retrying query after:', err.message);
        return await pool.query(text, params);
      }
      throw err;
    }
  },
  async connect() {
    try {
      return await pool.connect();
    } catch (err) {
      if (isRetryable(err)) {
        console.warn('[BondDB] Retrying connect after:', err.message);
        return await pool.connect();
      }
      throw err;
    }
  },
  get _pool() { return pool; },
  end: () => { clearInterval(keepAliveTimer); return pool.end(); },
  on: (...args) => pool.on(...args),
};

// Periodic keepalive prevents Fly.io proxy from killing idle connections
const keepAliveTimer = setInterval(() => {
  pool.query('SELECT 1').catch(() => {});
}, 30000);
keepAliveTimer.unref();

module.exports = resilientPool;
