'use strict';

/**
 * Leader election validation — run with
 *   `node server/integrations/cluster/leaderElection.test.js`
 * Needs a reachable Postgres (DATABASE_URL or the FINERACT_DB_* vars); it takes
 * a throwaway advisory lock and posts nothing.
 */

const assert = require('assert');
const path = require('path');
const { Client } = require('pg');

// A key of its own so a real instance holding the production lock cannot
// influence the result.
const TEST_LOCK_KEY = 918273645;
process.env.LEADER_LOCK_KEY = String(TEST_LOCK_KEY);
process.env.LEADER_RETRY_MS = '250';
process.env.LEADER_HEARTBEAT_MS = '250';

const modulePath = path.join(__dirname, 'leaderElection.js');

function freshModule() {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function dbConfig() {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    };
  }
  return {
    host: process.env.FINERACT_DB_HOST || 'localhost',
    port: parseInt(process.env.FINERACT_DB_PORT || '5432', 10),
    user: process.env.FINERACT_DB_USER || 'postgres',
    password: process.env.FINERACT_DB_PASSWORD || 'postgres',
    database: process.env.BOND_DB_NAME || 'fineract_tenants',
  };
}

async function testDisabledRunsEverything() {
  process.env.LEADER_ELECTION_ENABLED = 'false';
  const leader = freshModule();
  const calls = [];
  leader.register('loop-a', () => calls.push('a'));
  await leader.start();
  assert.strictEqual(leader.isLeader(), true);
  assert.deepStrictEqual(calls, ['a']);
  // Registering after start still runs, so init order cannot silently skip a loop.
  leader.register('loop-b', () => calls.push('b'));
  assert.deepStrictEqual(calls, ['a', 'b']);
  assert.strictEqual(leader.status().role, 'leader');
  await leader.stop();
  delete process.env.LEADER_ELECTION_ENABLED;
}

async function testSingleWriter() {
  const first = freshModule();
  const firstStarted = [];
  first.register('sweep', () => firstStarted.push('start'), () => firstStarted.push('stop'));
  assert.strictEqual(await first.start(), true, 'first instance should win an uncontested lock');
  assert.deepStrictEqual(firstStarted, ['start']);

  // A second process is simulated by a second module instance on its own
  // connection — the same thing two containers do.
  const second = freshModule();
  const secondStarted = [];
  second.register('sweep', () => secondStarted.push('start'), () => secondStarted.push('stop'));
  assert.strictEqual(await second.start(), false, 'second instance must not become leader');
  assert.deepStrictEqual(secondStarted, [], 'follower must not start any loop');
  assert.strictEqual(second.status().role, 'follower');

  // Leader steps down: its loops stop and the lock frees for the follower.
  await first.stop();
  assert.deepStrictEqual(firstStarted, ['start', 'stop']);
  assert.strictEqual(await second._attempt(), true, 'follower must take over once the lock is free');
  assert.deepStrictEqual(secondStarted, ['start']);
  await second.stop();
}

async function testLockReleasedOnStop() {
  const leader = freshModule();
  leader.register('noop', () => {});
  await leader.start();
  await leader.stop();

  // An outside connection can take the lock, proving nothing still holds it.
  const client = new Client(dbConfig());
  await client.connect();
  try {
    const res = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [TEST_LOCK_KEY]);
    assert.strictEqual(res.rows[0].acquired, true, 'lock must be released on stop');
    await client.query('SELECT pg_advisory_unlock($1)', [TEST_LOCK_KEY]);
  } finally {
    await client.end();
  }
}

async function testUnreachableDbLeavesFollower() {
  const savedUrl = process.env.DATABASE_URL;
  const savedHost = process.env.FINERACT_DB_HOST;
  const savedPort = process.env.FINERACT_DB_PORT;
  process.env.DATABASE_URL = 'postgres://nobody:nobody@127.0.0.1:5499/nothing';
  try {
    const leader = freshModule();
    const started = [];
    leader.register('sweep', () => started.push('start'));
    assert.strictEqual(await leader.start(), false);
    assert.strictEqual(leader.isLeader(), false);
    assert.deepStrictEqual(started, [], 'no loop may run without a confirmed lock');
    assert.ok(leader.status().lastError, 'the failure reason must be reported');
    await leader.stop();
  } finally {
    if (savedUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedUrl;
    if (savedHost !== undefined) process.env.FINERACT_DB_HOST = savedHost;
    if (savedPort !== undefined) process.env.FINERACT_DB_PORT = savedPort;
  }
}

async function main() {
  await testDisabledRunsEverything();
  console.log('  ✓ election disabled runs every loop on this instance');
  await testSingleWriter();
  console.log('  ✓ exactly one instance leads, and handover starts the loops there');
  await testLockReleasedOnStop();
  console.log('  ✓ advisory lock released on stop');
  await testUnreachableDbLeavesFollower();
  console.log('  ✓ unreachable database leaves the instance a follower with no loops');
  console.log('leaderElection: all checks passed');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('leaderElection test failed:', e.message);
  process.exit(1);
});
