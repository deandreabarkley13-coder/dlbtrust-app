/**
 * PostgreSQL Connection Pool — Shared by the Fixed Income Engine
 *
 * Connects via DATABASE_URL (Fly.io, Render, etc.) or individual env vars.
 * Bond tables live alongside Fineract's tenant metadata.
 *
 * Fly.io's Postgres proxy aggressively kills idle connections. This module:
 * 1. Rebuilds the pool (debounced) when connections die
 * 2. Retries failed queries with a one-off Client for guaranteed fresh connection
 * 3. Pings every 15s to keep connections alive
 */

'use strict';

const { Pool, Client } = require('pg');

const RETRY_ERRORS = [
  'Connection terminated unexpectedly',
  'Connection terminated',
  'Client has encountered a connection error',
  'terminating connection due to administrator command',
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
    code === '57P01' || code === '57P03';
}

// Separate pool config from client config
const clientConfig = {};
if (process.env.DATABASE_URL) {
  clientConfig.connectionString = process.env.DATABASE_URL;
  clientConfig.ssl = process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false;
} else {
  clientConfig.host = process.env.FINERACT_DB_HOST || 'localhost';
  clientConfig.port = parseInt(process.env.FINERACT_DB_PORT || '5432', 10);
  clientConfig.user = process.env.FINERACT_DB_USER || 'postgres';
  clientConfig.password = process.env.FINERACT_DB_PASSWORD || 'postgres';
  clientConfig.database = process.env.BOND_DB_NAME || 'fineract_tenants';
}

const poolConfig = {
  ...clientConfig,
  max: 8,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 5000,
};

let pool = new Pool(poolConfig);
pool.on('error', (err) => {
  console.error('[BondDB] Pool error:', err.message);
});

// Debounced pool rebuild — only one rebuild per second no matter how many requests fail
let rebuildInFlight = null;
function rebuildPool() {
  if (rebuildInFlight) return rebuildInFlight;
  rebuildInFlight = (async () => {
    console.warn('[BondDB] Rebuilding connection pool');
    const oldPool = pool;
    pool = new Pool(poolConfig);
    pool.on('error', (err) => {
      console.error('[BondDB] Pool error:', err.message);
    });
    // Verify the new pool works
    try {
      await pool.query('SELECT 1');
      console.log('[BondDB] New pool verified');
    } catch (e) {
      console.warn('[BondDB] New pool verification failed:', e.message);
    }
    oldPool.end().catch(() => {});
    // Clear debounce after 1s
    setTimeout(() => { rebuildInFlight = null; }, 1000);
  })();
  return rebuildInFlight;
}

// Retry using a one-off Client (bypasses pool entirely)
async function queryWithFreshClient(text, params) {
  const client = new Client(clientConfig);
  try {
    await client.connect();
    return await client.query(text, params);
  } finally {
    client.end().catch(() => {});
  }
}

const resilientPool = {
  async query(text, params) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      if (isRetryable(err)) {
        console.warn('[BondDB] Query failed:', err.message, '— retrying with fresh client');
        await rebuildPool();
        try {
          return await pool.query(text, params);
        } catch (err2) {
          if (isRetryable(err2)) {
            return await queryWithFreshClient(text, params);
          }
          throw err2;
        }
      }
      throw err;
    }
  },
  async connect() {
    try {
      return await pool.connect();
    } catch (err) {
      if (isRetryable(err)) {
        console.warn('[BondDB] Connect failed:', err.message, '— rebuilding pool');
        await rebuildPool();
        return await pool.connect();
      }
      throw err;
    }
  },
  get _pool() { return pool; },
  end: () => { clearInterval(keepAliveTimer); return pool.end(); },
  on: (...args) => pool.on(...args),
};

// Keepalive ping — also triggers rebuild if connections have died
const keepAliveTimer = setInterval(() => {
  pool.query('SELECT 1').catch(() => { rebuildPool(); });
}, 15000);
keepAliveTimer.unref();

module.exports = resilientPool;
