/**
 * PostgreSQL Connection Pool — Shared by the Fixed Income Engine
 *
 * Connects via DATABASE_URL (Fly.io, Render, etc.) or individual env vars.
 * Bond tables live alongside Fineract's tenant metadata.
 *
 * Resilient pool: auto-rebuilds on dead connections, 3-tier retry,
 * keepalive ping to prevent Fly.io proxy from killing idle connections.
 */

'use strict';

const { Pool, Client } = require('pg');

let poolConfig;
if (process.env.DATABASE_URL) {
  poolConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: 8,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
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
    connectionTimeoutMillis: 5000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  };
}

let pool = new Pool(poolConfig);
let lastRebuild = 0;

pool.on('error', (err) => {
  console.error('[BondDB] Pool error:', err.message);
});

function rebuildPool() {
  const now = Date.now();
  if (now - lastRebuild < 1000) return;
  lastRebuild = now;
  console.warn('[BondDB] Rebuilding connection pool');
  try { pool.end().catch(() => {}); } catch (e) { /* ignore */ }
  pool = new Pool(poolConfig);
  pool.on('error', (err) => {
    console.error('[BondDB] Pool error (rebuilt):', err.message);
  });
}

// Keepalive ping every 15s
const keepAliveTimer = setInterval(async () => {
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    console.warn('[BondDB] Keepalive ping failed, rebuilding pool:', e.message);
    rebuildPool();
  }
}, 15000);
keepAliveTimer.unref();

function isReadOnly(text) {
  const trimmed = text.trim().toUpperCase();
  return trimmed.startsWith('SELECT') || trimmed.startsWith('WITH');
}

// Resilient query with 3-tier retry (reads only; writes throw on first error)
async function resilientQuery(text, params) {
  // Tier 1: normal pool query
  try {
    return await pool.query(text, params);
  } catch (err) {
    if (!isReadOnly(text)) throw err;
    if (!err.message.includes('terminated') && !err.message.includes('Connection') && !err.message.includes('ECONNREFUSED')) {
      throw err;
    }
    console.warn('[BondDB] Tier 1 failed:', err.message);
  }

  // Tier 2: rebuild pool and retry
  rebuildPool();
  try {
    return await pool.query(text, params);
  } catch (err2) {
    if (!err2.message.includes('terminated') && !err2.message.includes('Connection') && !err2.message.includes('ECONNREFUSED')) {
      throw err2;
    }
    console.warn('[BondDB] Tier 2 failed:', err2.message);
  }

  // Tier 3: fresh one-off client
  console.warn('[BondDB] Tier 3: using fresh client');
  const client = new Client(poolConfig.connectionString ? { connectionString: poolConfig.connectionString, ssl: poolConfig.ssl } : poolConfig);
  try {
    await client.connect();
    const result = await client.query(text, params);
    return result;
  } finally {
    try { await client.end(); } catch (e) { /* ignore */ }
  }
}

module.exports = {
  query: resilientQuery,
  // Expose pool for callers that need connect() for transactions
  connect: () => pool.connect(),
  end: () => { clearInterval(keepAliveTimer); return pool.end(); },
  on: (event, handler) => pool.on(event, handler),
};
