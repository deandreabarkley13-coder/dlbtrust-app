'use strict';

/**
 * Postgres-backed state store validation — run with
 *   `node server/integrations/cluster/pgStateStore.test.js`
 *
 * Needs a reachable Postgres (DATABASE_URL, or the local dlbtrust database).
 * Everything happens in a scratch schema that is dropped again, so no real
 * state document or table is touched.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://dlbtrust:dlbtrust@localhost:5432/dlbtrust';
}

const SCHEMA = 'state_store_test_' + process.pid;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-state-store-'));
process.env.PERSISTENT_DATA_DIR = scratch;
process.env.STATE_STORE_BACKEND = 'postgres';
process.env.STATE_STORE_SCHEMA = SCHEMA;

const pgSync = require('./pgSync');
const store = require('./jsonStateStore');

const FILE = 'engine-state.json';

function testSyncBridge() {
  const res = pgSync.query('SELECT $1::int AS n, $2::text AS label', [7, 'seven']);
  assert.deepStrictEqual(res.rows, [{ n: 7, label: 'seven' }]);
  assert.throws(() => pgSync.query('SELECT * FROM a_table_that_does_not_exist', []), /does not exist/);
  // A failed query must not poison the bridge.
  assert.strictEqual(pgSync.query('SELECT 1 AS ok', []).rows[0].ok, 1);
  console.log('✓ synchronous bridge answers queries and survives a failure');
}

function testRoundTrip() {
  assert.deepStrictEqual(store.read(FILE, () => ({ items: [] })), { items: [] });
  store.write(FILE, { items: ['a'] });
  assert.deepStrictEqual(store.read(FILE, () => ({ items: [] })), { items: ['a'] });
  const stored = pgSync.query('SELECT doc, revision FROM ' + SCHEMA + '.cluster_state WHERE doc_name = $1', [FILE]);
  assert.deepStrictEqual(stored.rows[0].doc, { items: ['a'] });
  // Nothing may be written to the volume in this mode.
  assert.strictEqual(fs.existsSync(path.join(scratch, FILE)), false);
  console.log('✓ documents round trip through Postgres, not the volume');
}

function testSeedsFromVolume() {
  // A document the single-instance era left behind is the starting value.
  fs.writeFileSync(path.join(scratch, 'legacy.json'), JSON.stringify({ carried: 'over' }));
  assert.deepStrictEqual(store.read('legacy.json', () => ({})), { carried: 'over' });
  store.write('legacy.json', { carried: 'over', then: 'changed' });
  // Once imported, the row wins and the stale file is ignored.
  fs.writeFileSync(path.join(scratch, 'legacy.json'), JSON.stringify({ carried: 'stale' }));
  assert.deepStrictEqual(store.read('legacy.json', () => ({})), { carried: 'over', then: 'changed' });
  console.log('✓ an existing volume document seeds the table once, then the row wins');
}

function testUpdateSerialisesAcrossProcesses() {
  store.write('counter.json', { n: 0, writers: [] });
  const script = `
    process.env.DATABASE_URL = ${JSON.stringify(process.env.DATABASE_URL)};
    process.env.STATE_STORE_BACKEND = 'postgres';
    process.env.STATE_STORE_SCHEMA = ${JSON.stringify(SCHEMA)};
    process.env.PERSISTENT_DATA_DIR = ${JSON.stringify(scratch)};
    const store = require(${JSON.stringify(path.join(__dirname, 'jsonStateStore.js'))});
    const tag = process.argv[process.argv.length - 1];
    for (let i = 0; i < 25; i++) {
      store.update('counter.json', () => ({ n: 0, writers: [] }), (doc) => {
        doc.n += 1;
        doc.writers.push(tag + ':' + i);
        return doc;
      });
    }
  `;
  const writers = ['w1', 'w2', 'w3', 'w4'].map((tag) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, tag], { stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(tag + ' exited ' + code))));
  }));
  return Promise.all(writers).then(() => {
    const doc = store.read('counter.json', () => null);
    assert.strictEqual(doc.n, 100, 'every increment must survive: got ' + doc.n);
    assert.strictEqual(new Set(doc.writers).size, 100, 'no writer entry may be lost');
    console.log('✓ concurrent updates from four processes lose nothing');
  });
}

function testConflictingWriteIsReported() {
  store.write('shared.json', { v: 1 });
  // Another instance changes the row behind this process's back.
  pgSync.query('UPDATE ' + SCHEMA + '.cluster_state SET doc = $2::jsonb, revision = revision + 5 WHERE doc_name = $1',
    ['shared.json', JSON.stringify({ v: 99 })]);
  const before = store.stats().conflicts;
  store.write('shared.json', { v: 2 });
  assert.ok(store.stats().conflicts > before, 'an overwrite of a changed document must be counted');
  assert.deepStrictEqual(store.read('shared.json', () => null), { v: 2 });
  console.log('✓ overwriting a document another instance changed is reported');
}

function cleanup() {
  try {
    pgSync.query('DROP SCHEMA IF EXISTS ' + SCHEMA + ' CASCADE', []);
  } catch (e) {
    console.warn('cleanup failed: ' + e.message);
  }
  pgSync.stop();
  fs.rmSync(scratch, { recursive: true, force: true });
}

(async () => {
  pgSync.query('CREATE SCHEMA IF NOT EXISTS ' + SCHEMA, []);
  try {
    testSyncBridge();
    testRoundTrip();
    testSeedsFromVolume();
    await testUpdateSerialisesAcrossProcesses();
    testConflictingWriteIsReported();
    console.log('postgres state store: all checks passed');
  } finally {
    cleanup();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
