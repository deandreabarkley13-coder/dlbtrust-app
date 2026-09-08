'use strict';

/**
 * Transaction journal validation — run with
 *   `node server/integrations/backup/transactionJournal.test.js`
 *
 * The Postgres phase needs a reachable database (DATABASE_URL, or the local
 * dlbtrust database) and runs in a scratch schema that is dropped afterwards.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://dlbtrust:dlbtrust@localhost:5432/dlbtrust';
}

const SCHEMA = 'journal_test_' + process.pid;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
const JOURNAL_MODULE = path.join(__dirname, 'transactionJournal.js');
const GENESIS = '0'.repeat(64);

function loadJournal(backend, schema) {
  process.env.PERSISTENT_DATA_DIR = scratch;
  process.env.STATE_STORE_BACKEND = backend;
  process.env.STATE_STORE_SCHEMA = schema || SCHEMA;
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/integrations/backup/transactionJournal') || key.includes('/integrations/cluster/')) {
      delete require.cache[key];
    }
  }
  return require(JOURNAL_MODULE);
}

function hashOf(entry) {
  return crypto.createHash('sha256').update(JSON.stringify({
    seq: entry.seq, ts: entry.ts, type: entry.type, actor: entry.actor, data: entry.data, prev_hash: entry.prev_hash,
  })).digest('hex');
}

function testFileBackend() {
  const journal = loadJournal('file');
  const first = journal.record('ach_transmit', { batch_id: 'B1' }, 'api');
  const second = journal.record('wire_initiate', { wire_id: 'W1' }, 'operator');
  assert.strictEqual(first.seq, 1);
  assert.strictEqual(first.prev_hash, GENESIS);
  assert.strictEqual(second.prev_hash, first.hash);
  assert.strictEqual(hashOf(second), second.hash);

  const entries = journal.readEntries({ limit: 10 });
  assert.deepStrictEqual(entries.map((e) => e.seq), [2, 1]);
  assert.deepStrictEqual(journal.readEntries({ type: 'wire_initiate' }).map((e) => e.seq), [2]);

  const integrity = journal.verifyIntegrity();
  assert.strictEqual(integrity.valid, true);
  assert.strictEqual(integrity.entries, 2);
  console.log('✓ file backend chains entries and verifies');

  // A tampered payload must break verification.
  const file = path.join(scratch, 'journal', 'transactions.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const forged = JSON.parse(lines[1]);
  forged.data.wire_id = 'W-FORGED';
  lines[1] = JSON.stringify(forged);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const tampered = loadJournal('file').verifyIntegrity();
  assert.strictEqual(tampered.valid, false);
  assert.ok(/Hash mismatch/.test(JSON.stringify(tampered.errors)));
  console.log('✓ an edited entry fails verification');
  fs.rmSync(path.join(scratch, 'journal'), { recursive: true, force: true });
}

function testPostgresBackend() {
  const journal = loadJournal('postgres');
  const pgSync = require('../cluster/pgSync');
  pgSync.query('CREATE SCHEMA IF NOT EXISTS ' + SCHEMA, []);

  const first = journal.record('mode_switch', { mode: 'live' }, 'admin');
  const second = journal.record('config_change', { key: 'RATE' }, 'admin');
  assert.strictEqual(first.seq, 1);
  assert.strictEqual(first.prev_hash, GENESIS);
  assert.strictEqual(second.prev_hash, first.hash);
  assert.strictEqual(hashOf(second), second.hash);
  // Nothing may go to the volume while Postgres is the backend.
  assert.strictEqual(fs.existsSync(path.join(scratch, 'journal', 'transactions.jsonl')), false);

  assert.deepStrictEqual(journal.readEntries({ limit: 10 }).map((e) => e.seq), [2, 1]);
  assert.deepStrictEqual(journal.readEntries({ type: 'mode_switch' }).map((e) => e.seq), [1]);
  const integrity = journal.verifyIntegrity();
  assert.strictEqual(integrity.valid, true);
  assert.strictEqual(integrity.entries, 2);
  assert.strictEqual(journal.getStats().entries, 2);
  console.log('✓ postgres backend chains entries and verifies');
  return pgSync;
}

function testConcurrentAppends(pgSync) {
  const script = `
    process.env.DATABASE_URL = ${JSON.stringify(process.env.DATABASE_URL)};
    process.env.STATE_STORE_BACKEND = 'postgres';
    process.env.STATE_STORE_SCHEMA = ${JSON.stringify(SCHEMA)};
    process.env.PERSISTENT_DATA_DIR = ${JSON.stringify(scratch)};
    const journal = require(${JSON.stringify(JOURNAL_MODULE)});
    const tag = process.argv[process.argv.length - 1];
    for (let i = 0; i < 15; i++) journal.record('ach_transmit', { writer: tag, i }, tag);
  `;
  const writers = ['a', 'b', 'c', 'd'].map((tag) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, tag], { stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(tag + ' exited ' + code))));
  }));
  return Promise.all(writers).then(() => {
    const journal = loadJournal('postgres');
    const integrity = journal.verifyIntegrity();
    assert.strictEqual(integrity.entries, 62, 'expected 2 + 60 entries, got ' + integrity.entries);
    assert.deepStrictEqual(integrity.errors, [], 'chain must stay intact across instances');
    assert.strictEqual(integrity.valid, true);
    console.log('✓ four instances appending concurrently keep one unbroken chain');
    return pgSync;
  });
}

function testMigration() {
  // A chain written on the volume must import with its sequence and hashes.
  const fileJournal = loadJournal('file');
  fileJournal.record('legacy_event', { n: 1 }, 'system');
  fileJournal.record('legacy_event', { n: 2 }, 'system');
  const migrated = SCHEMA + '_import';
  const pgSync = require('../cluster/pgSync');
  pgSync.query('CREATE SCHEMA IF NOT EXISTS ' + migrated, []);
  require('child_process').execFileSync(process.execPath, [
    path.join(__dirname, '../../scripts/migrateJournalToPostgres.js'),
    '--dir', path.join(scratch, 'journal'), '--confirm',
  ], { env: Object.assign({}, process.env, { STATE_STORE_SCHEMA: migrated }), stdio: 'inherit' });

  const imported = loadJournal('postgres', migrated);
  const integrity = imported.verifyIntegrity();
  assert.strictEqual(integrity.entries, 2);
  assert.strictEqual(integrity.valid, true, 'imported chain must verify: ' + JSON.stringify(integrity.errors));
  // Appending after an import continues the same chain.
  const next = imported.record('post_migration', { ok: true }, 'system');
  assert.strictEqual(next.seq, 3);
  assert.strictEqual(imported.verifyIntegrity().valid, true);
  console.log('✓ an imported file chain verifies and keeps growing in Postgres');
  require('../cluster/pgSync').query('DROP SCHEMA IF EXISTS ' + migrated + ' CASCADE', []);
}

function testSpillOnUnreachablePostgres() {
  // An unreachable database must not silently extend the local chain.
  const spillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-spill-'));
  const script = `
    process.env.DATABASE_URL = 'postgres://nobody:nobody@127.0.0.1:1/none';
    process.env.STATE_STORE_BACKEND = 'postgres';
    process.env.PERSISTENT_DATA_DIR = ${JSON.stringify(spillDir)};
    process.env.PG_SYNC_TIMEOUT_MS = '4000';
    const journal = require(${JSON.stringify(JOURNAL_MODULE)});
    const entry = journal.record('ach_transmit', { batch_id: 'B9' }, 'api');
    if (entry.hash !== null || entry.unchained !== true) { console.error('expected an unchained entry'); process.exit(2); }
    process.exit(0);
  `;
  require('child_process').execFileSync(process.execPath, ['-e', script], { stdio: 'inherit', timeout: 90000 });
  const spillFile = path.join(spillDir, 'journal', 'transactions.spill.jsonl');
  const spilled = JSON.parse(fs.readFileSync(spillFile, 'utf8').trim());
  assert.strictEqual(spilled.seq, null);
  assert.strictEqual(spilled.hash, null);
  assert.strictEqual(spilled.unchained, true);
  assert.strictEqual(fs.existsSync(path.join(spillDir, 'journal', 'transactions.jsonl')), false);
  fs.rmSync(spillDir, { recursive: true, force: true });
  console.log('✓ an unreachable database spills the entry instead of forking the chain');
}

(async () => {
  try {
    testFileBackend();
    const pgSync = testPostgresBackend();
    await testConcurrentAppends(pgSync);
    testMigration();
    testSpillOnUnreachablePostgres();
    console.log('transaction journal: all checks passed');
  } finally {
    process.env.STATE_STORE_SCHEMA = SCHEMA;
    try {
      const pgSync = require('./../cluster/pgSync');
      pgSync.query('DROP SCHEMA IF EXISTS ' + SCHEMA + ' CASCADE', []);
      pgSync.stop();
    } catch (e) {
      console.warn('cleanup failed: ' + e.message);
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
