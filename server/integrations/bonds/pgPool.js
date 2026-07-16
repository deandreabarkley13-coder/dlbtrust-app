/**
 * PostgreSQL Connection Pool — Shared by the Fixed Income Engine
 *
 * Connects via DATABASE_URL (Fly.io, Render, etc.) or individual env vars.
 * Bond tables live alongside Fineract's tenant metadata.
 *
 * Resilience features:
 * - 3-tier retry: pool → rebuild pool → fresh one-off client
 * - Circuit breaker: fast-fails when Postgres is known-down (prevents 15s hangs)
 * - Keepalive ping every 15s to detect and recover from idle disconnections
 * - connectionTimeoutMillis: 3s (fail fast on unreachable DB)
 * - statement_timeout: 15s (prevent runaway queries from blocking)
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
    connectionTimeoutMillis: 3000,
    statement_timeout: 15000,
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
    connectionTimeoutMillis: 3000,
    statement_timeout: 15000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  };
}

let pool = new Pool(poolConfig);
let lastRebuild = 0;

pool.on('error', (err) => {
  console.error('[BondDB] Pool error:', err.message);
});

// ─── Circuit Breaker ──────────────────────────────────────────────────────────
// When all 3 tiers fail repeatedly, stop trying for a cooldown period.
// Prevents 15s+ hangs when Postgres is completely unreachable.
const dbCircuit = {
  failures: 0,
  lastFailure: 0,
  threshold: 3,       // open after 3 full 3-tier failures
  cooldown: 10000,    // try again after 10s
  isOpen() {
    if (this.failures < this.threshold) return false;
    if (Date.now() - this.lastFailure > this.cooldown) {
      this.failures = 0; // half-open: allow one request through
      return false;
    }
    return true;
  },
  recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures === this.threshold) {
      console.error('[BondDB] Circuit breaker OPEN — Postgres unreachable, fast-failing for ' + (this.cooldown / 1000) + 's');
    }
  },
  recordSuccess() {
    if (this.failures > 0) {
      console.log('[BondDB] Circuit breaker CLOSED — Postgres recovered');
    }
    this.failures = 0;
  },
};

function rebuildPool() {
  const now = Date.now();
  if (now - lastRebuild < 2000) return; // debounce: max 1 rebuild per 2s
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
    dbCircuit.recordSuccess();
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

function isConnectionError(err) {
  const msg = err.message || '';
  return msg.includes('terminated') || msg.includes('Connection') ||
         msg.includes('ECONNREFUSED') || msg.includes('timeout') ||
         msg.includes('ECONNRESET');
}

// Resilient query with 3-tier retry + circuit breaker
async function resilientQuery(text, params) {
  // Circuit breaker: fast-fail if Postgres is known-down
  if (dbCircuit.isOpen()) {
    const err = new Error('Database circuit breaker OPEN — Postgres temporarily unavailable');
    err.code = 'CIRCUIT_OPEN';
    throw err;
  }

  // Tier 1: normal pool query
  try {
    const result = await pool.query(text, params);
    dbCircuit.recordSuccess();
    return result;
  } catch (err) {
    if (!isReadOnly(text)) throw err;
    if (!isConnectionError(err)) throw err;
    console.warn('[BondDB] Tier 1 failed:', err.message);
  }

  // Tier 2: rebuild pool and retry
  rebuildPool();
  try {
    const result = await pool.query(text, params);
    dbCircuit.recordSuccess();
    return result;
  } catch (err2) {
    if (!isConnectionError(err2)) throw err2;
    console.warn('[BondDB] Tier 2 failed:', err2.message);
  }

  // Tier 3: fresh one-off client with shorter timeout
  console.warn('[BondDB] Tier 3: using fresh client');
  const clientConfig = poolConfig.connectionString
    ? { connectionString: poolConfig.connectionString, ssl: poolConfig.ssl, connectionTimeoutMillis: 3000 }
    : { ...poolConfig, connectionTimeoutMillis: 3000 };
  const client = new Client(clientConfig);
  try {
    await client.connect();
    const result = await client.query(text, params);
    dbCircuit.recordSuccess();
    return result;
  } catch (err3) {
    dbCircuit.recordFailure();
    throw err3;
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
  getCircuitStatus: () => ({ failures: dbCircuit.failures, isOpen: dbCircuit.isOpen(), lastFailure: dbCircuit.lastFailure ? new Date(dbCircuit.lastFailure).toISOString() : null }),
};
