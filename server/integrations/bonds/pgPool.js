/**
 * PostgreSQL Connection Pool — Shared by the Fixed Income Engine
 *
 * Connects via DATABASE_URL (Fly.io, Render, etc.) or individual env vars.
 * Bond tables live alongside Fineract's tenant metadata.
 *
 * Resilience features:
 * - 3-tier retry: pool → rebuild pool → fresh one-off client
 * - Circuit breaker: fast-fails when Postgres is known-down (prevents 15s hangs)
 * - Auto-recovery probe: 3s rapid polling when circuit is OPEN (vs 15s normal)
 * - Auto pool rebuild on half-open transition for clean connections
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
  _wasOpen: false,    // track state transitions for auto-recovery
  isOpen() {
    if (this.failures < this.threshold) return false;
    if (Date.now() - this.lastFailure > this.cooldown) {
      // Half-open: rebuild pool for clean connections before allowing request
      console.log('[BondDB] Circuit breaker HALF-OPEN — rebuilding pool for recovery attempt');
      rebuildPool();
      this.failures = 0;
      return false;
    }
    return true;
  },
  recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures === this.threshold) {
      this._wasOpen = true;
      console.error('[BondDB] Circuit breaker OPEN — Postgres unreachable, fast-failing for ' + (this.cooldown / 1000) + 's');
      console.error('[BondDB] Auto-recovery probe activated (every 3s)');
      startRecoveryProbe();
    }
  },
  recordSuccess() {
    if (this.failures > 0 || this._wasOpen) {
      console.log('[BondDB] Circuit breaker CLOSED — Postgres recovered');
      this._wasOpen = false;
      stopRecoveryProbe();
    }
    this.failures = 0;
  },
  forceReset() {
    console.log('[BondDB] Circuit breaker FORCE RESET by admin');
    this.failures = 0;
    this.lastFailure = 0;
    this._wasOpen = false;
    stopRecoveryProbe();
    rebuildPool();
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

// ─── Auto-Recovery Probe ──────────────────────────────────────────────────────
// When circuit is OPEN, probe every 3s to detect DB recovery ASAP.
// Replaces the normal 15s keepalive during outages for faster recovery.
let recoveryTimer = null;
function startRecoveryProbe() {
  if (recoveryTimer) return; // already running
  recoveryTimer = setInterval(async () => {
    try {
      rebuildPool();
      await pool.query('SELECT 1');
      console.log('[BondDB] Recovery probe: Postgres is back!');
      dbCircuit.recordSuccess();
    } catch (e) {
      console.warn('[BondDB] Recovery probe: still down —', e.message);
    }
  }, 3000);
  recoveryTimer.unref();
}
function stopRecoveryProbe() {
  if (recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
  }
}

// Keepalive ping every 15s (normal operation)
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
    const secsLeft = Math.max(0, Math.ceil((dbCircuit.cooldown - (Date.now() - dbCircuit.lastFailure)) / 1000));
    const err = new Error('Database temporarily unavailable — auto-recovering (retry in ' + secsLeft + 's)');
    err.code = 'CIRCUIT_OPEN';
    err.retryAfter = secsLeft;
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
  end: () => { clearInterval(keepAliveTimer); stopRecoveryProbe(); return pool.end(); },
  on: (event, handler) => pool.on(event, handler),
  getCircuitStatus: () => ({
    failures: dbCircuit.failures,
    isOpen: dbCircuit.isOpen(),
    lastFailure: dbCircuit.lastFailure ? new Date(dbCircuit.lastFailure).toISOString() : null,
    recoveryProbeActive: !!recoveryTimer,
    cooldownSeconds: dbCircuit.cooldown / 1000,
  }),
  resetCircuit: () => { dbCircuit.forceReset(); },
};
