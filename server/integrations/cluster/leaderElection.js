'use strict';

/**
 * Single-writer leader election for horizontally scaled instances.
 *
 * Every background loop in this app posts to the ledger — accrual, sweeps,
 * aggregator pulls, Melio sync, clearing intake, backups. Running two
 * instances would run each loop twice and double-post, so the loops are
 * registered here instead of being started directly, and only the instance
 * holding the Postgres session advisory lock starts them.
 *
 * The lock lives on a dedicated connection, so it is released by Postgres the
 * moment that connection drops (crash, kill, network partition) — there is no
 * lease to expire and no fencing token to check. Followers retry on an
 * interval and take over within LEADER_RETRY_MS of the leader disappearing.
 *
 * Registered loops must be idempotent across a leadership handover: a
 * follower may start a loop mid-cycle after the previous leader died.
 */

const { Client } = require('pg');
const os = require('os');

const DEFAULT_RETRY_MS = 15000;
const DEFAULT_HEARTBEAT_MS = 10000;
// Namespace key for pg_try_advisory_lock — 'DLBT' as a 32-bit int, arbitrary
// but must be identical across instances and unused by anything else.
const DEFAULT_LOCK_KEY = 1146312020;

const INSTANCE_ID = process.env.NORTHFLANK_CONTAINER_ID || process.env.HOSTNAME || (os.hostname() + ':' + process.pid);

const tasks = [];
let client = null;
let retryTimer = null;
let heartbeatTimer = null;
let isLeader = false;
let leaderSince = null;
let lastError = null;
let started = false;
let acquiring = false;

function isEnabled() {
  return String(process.env.LEADER_ELECTION_ENABLED || 'true').toLowerCase() !== 'false';
}

function lockKey() {
  const fromEnv = parseInt(process.env.LEADER_LOCK_KEY || '', 10);
  return Number.isFinite(fromEnv) ? fromEnv : DEFAULT_LOCK_KEY;
}

function retryMs() {
  const fromEnv = parseInt(process.env.LEADER_RETRY_MS || '', 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_RETRY_MS;
}

function heartbeatMs() {
  const fromEnv = parseInt(process.env.LEADER_HEARTBEAT_MS || '', 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_HEARTBEAT_MS;
}

function clientConfig() {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 5000,
      keepAlive: true,
    };
  }
  return {
    host: process.env.FINERACT_DB_HOST || 'localhost',
    port: parseInt(process.env.FINERACT_DB_PORT || '5432', 10),
    user: process.env.FINERACT_DB_USER || 'postgres',
    password: process.env.FINERACT_DB_PASSWORD || 'postgres',
    database: process.env.BOND_DB_NAME || 'fineract_tenants',
    connectionTimeoutMillis: 5000,
    keepAlive: true,
  };
}

/**
 * Register a background loop that must run on exactly one instance.
 * `start` is invoked on leadership acquisition, `stop` (optional) on loss.
 */
function register(name, start, stop) {
  if (typeof name !== 'string' || !name) throw new Error('leader task name required');
  if (typeof start !== 'function') throw new Error('leader task ' + name + ' needs a start function');
  const task = { name: name, start: start, stop: stop || null, running: false };
  tasks.push(task);
  // A late registration on an instance that is already leader still runs.
  if (isLeader) runTask(task);
  return task;
}

function runTask(task) {
  if (task.running) return;
  try {
    task.start();
    task.running = true;
  } catch (e) {
    console.warn('[leader] ' + task.name + ' start failed:', e.message);
  }
}

function stopTask(task) {
  if (!task.running) return;
  task.running = false;
  if (!task.stop) {
    // No stop hook: the loop keeps its timer. Losing the lock means this
    // process is about to be replaced, but log it so a stuck loop is visible.
    console.warn('[leader] ' + task.name + ' has no stop hook — loop still armed after leadership loss');
    return;
  }
  try {
    task.stop();
  } catch (e) {
    console.warn('[leader] ' + task.name + ' stop failed:', e.message);
  }
}

function startTasks() {
  tasks.forEach(runTask);
}

function stopTasks() {
  tasks.forEach(stopTask);
}

function scheduleRetry() {
  if (retryTimer || !started) return;
  retryTimer = setTimeout(function() {
    retryTimer = null;
    attempt();
  }, retryMs());
  if (retryTimer.unref) retryTimer.unref();
}

async function releaseClient() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  const stale = client;
  client = null;
  if (!stale) return;
  try { await stale.end(); } catch (e) { /* connection already gone */ }
}

async function demote(reason) {
  const wasLeader = isLeader;
  isLeader = false;
  leaderSince = null;
  stopTasks();
  await releaseClient();
  if (wasLeader) console.warn('[leader] lost leadership (' + reason + ') — background loops stopped');
  scheduleRetry();
}

function startHeartbeat() {
  heartbeatTimer = setInterval(function() {
    if (!client) return;
    client.query('SELECT 1').catch(function(e) {
      lastError = e.message;
      demote('heartbeat failed: ' + e.message);
    });
  }, heartbeatMs());
  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

async function attempt() {
  if (!started || isLeader || acquiring) return isLeader;
  acquiring = true;
  const candidate = new Client(clientConfig());
  try {
    candidate.on('error', function(err) {
      lastError = err.message;
      if (client === candidate) demote('connection error: ' + err.message);
    });
    await candidate.connect();
    const res = await candidate.query('SELECT pg_try_advisory_lock($1) AS acquired', [lockKey()]);
    if (!res.rows[0].acquired) {
      try { await candidate.end(); } catch (e) { /* ignore */ }
      scheduleRetry();
      return false;
    }
    client = candidate;
    isLeader = true;
    leaderSince = new Date().toISOString();
    lastError = null;
    console.log('[leader] elected leader (' + INSTANCE_ID + ') — starting ' + tasks.length + ' background loop(s)');
    startHeartbeat();
    startTasks();
    return true;
  } catch (e) {
    lastError = e.message;
    try { await candidate.end(); } catch (endErr) { /* ignore */ }
    console.warn('[leader] election attempt failed:', e.message);
    scheduleRetry();
    return false;
  } finally {
    acquiring = false;
  }
}

/**
 * Begin campaigning. With election disabled the process behaves as it did
 * before (sole writer), so single-instance deployments are unaffected.
 */
async function start() {
  if (started) return isLeader;
  started = true;
  if (!isEnabled()) {
    isLeader = true;
    leaderSince = new Date().toISOString();
    console.log('[leader] election disabled — running all background loops on this instance');
    startTasks();
    return true;
  }
  return attempt();
}

/** Release the lock so a peer can take over immediately on shutdown. */
async function stop() {
  started = false;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  const wasLeader = isLeader;
  isLeader = false;
  leaderSince = null;
  stopTasks();
  if (wasLeader && client) {
    try { await client.query('SELECT pg_advisory_unlock($1)', [lockKey()]); } catch (e) { /* connection closing anyway */ }
  }
  await releaseClient();
}

function status() {
  return {
    enabled: isEnabled(),
    instanceId: INSTANCE_ID,
    role: isLeader ? 'leader' : (started ? 'follower' : 'idle'),
    leader: isLeader,
    leaderSince: leaderSince,
    lockKey: lockKey(),
    lastError: lastError,
    tasks: tasks.map(function(t) { return { name: t.name, running: t.running }; }),
  };
}

module.exports = {
  register: register,
  start: start,
  stop: stop,
  status: status,
  isLeader: function() { return isLeader; },
  // Test seam: campaign again without waiting out the retry interval.
  _attempt: attempt,
};
