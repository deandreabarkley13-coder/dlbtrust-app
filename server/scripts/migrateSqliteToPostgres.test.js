#!/usr/bin/env node
/**
 * Checks the SQLite → Postgres migration against a throwaway fixture database.
 * Needs a reachable Postgres (DATABASE_URL or FINERACT_DB_* env), and writes
 * only into the schema named below.
 *
 *   node server/scripts/migrateSqliteToPostgres.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCHEMA = 'legacy_sqlite_test';
const SCRIPT = path.join(__dirname, 'migrateSqliteToPostgres.js');
const pool = require(path.join(__dirname, '..', 'integrations', 'bonds', 'pgPool'));

const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-migrate-')), 'legacy.db');

function buildFixture() {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE wallets (
      id INTEGER PRIMARY KEY,
      name TEXT,
      role TEXT,
      fiat_balance INTEGER,
      created_at TEXT
    );
    CREATE TABLE trust_users (
      trust_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT,
      active BOOLEAN,
      weight REAL,
      payload BLOB,
      PRIMARY KEY (trust_id, user_id)
    );
    CREATE TABLE empty_audit (id INTEGER PRIMARY KEY, note TEXT);
  `);
  db.prepare('INSERT INTO wallets VALUES (?,?,?,?,?)').run(1, 'Trust Entity', 'trust_entity', 50000000, '2026-01-02T03:04:05Z');
  db.prepare('INSERT INTO wallets VALUES (?,?,?,?,?)').run(2, 'Bob', 'beneficiary', null, null);
  db.prepare('INSERT INTO trust_users VALUES (?,?,?,?,?,?)')
    .run('t-1', 'u-1', 'trustee', 1, 0.5, Buffer.from('blob-bytes'));
  db.prepare('INSERT INTO trust_users VALUES (?,?,?,?,?,?)')
    .run('t-1', 'u-2', 'beneficiary', 0, null, null);
  db.close();
}

function run(extra) {
  const opts = {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { SQLITE_DB_PATH: dbPath, LEGACY_SQLITE_SCHEMA: SCHEMA }),
  };
  try {
    return execFileSync('node', [SCRIPT].concat(extra), opts);
  } catch (err) {
    // A reported mismatch exits non-zero on purpose; the report is the assertion.
    return String(err.stdout || '') + String(err.stderr || '');
  }
}

async function main() {
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    console.log('skipped: no Postgres reachable (' + err.message + ')');
    return;
  }

  buildFixture();
  await pool.query('DROP SCHEMA IF EXISTS ' + SCHEMA + ' CASCADE');

  const dry = run([]);
  assert.match(dry, /DRY RUN/, 'default run must be a dry run');
  assert.match(dry, /would copy wallets \(2 rows/, 'dry run lists populated tables');
  const dryCheck = await pool.query('SELECT to_regclass($1) AS reg', [SCHEMA + '.wallets']);
  assert.strictEqual(dryCheck.rows[0].reg, null, 'dry run must not create tables');
  console.log('  ✓ dry run reports the plan and writes nothing');

  run(['--confirm']);
  const wallets = await pool.query('SELECT * FROM ' + SCHEMA + '.wallets ORDER BY id');
  assert.strictEqual(wallets.rowCount, 2);
  assert.strictEqual(wallets.rows[0].name, 'Trust Entity');
  assert.strictEqual(wallets.rows[0].fiat_balance, '50000000', 'INTEGER copies as bigint');
  assert.strictEqual(wallets.rows[0].created_at, '2026-01-02T03:04:05Z', 'timestamps stay ISO text');
  assert.strictEqual(wallets.rows[1].fiat_balance, null, 'nulls survive');

  const users = await pool.query('SELECT * FROM ' + SCHEMA + '.trust_users ORDER BY user_id');
  assert.strictEqual(users.rows[0].active, true, 'BOOLEAN 1 becomes true');
  assert.strictEqual(users.rows[1].active, false, 'BOOLEAN 0 becomes false');
  assert.strictEqual(users.rows[0].weight, 0.5, 'REAL copies as double precision');
  assert.strictEqual(users.rows[0].payload.toString('utf8'), 'blob-bytes', 'BLOB copies as bytea');
  console.log('  ✓ rows, types, nulls and blobs copy faithfully');

  const pk = await pool.query(
    `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY a.attname`,
    [SCHEMA + '.trust_users']
  );
  assert.deepStrictEqual(pk.rows.map((r) => r.attname), ['trust_id', 'user_id'], 'composite primary key preserved');
  const empty = await pool.query('SELECT count(*)::int AS c FROM ' + SCHEMA + '.empty_audit');
  assert.strictEqual(empty.rows[0].c, 0, 'empty tables are created so existing SQL keeps working');
  console.log('  ✓ primary keys and empty tables preserved');

  const second = run(['--confirm']);
  assert.match(second, /already-migrated/, 'a second run is a no-op');
  const unchanged = await pool.query('SELECT count(*)::int AS c FROM ' + SCHEMA + '.wallets');
  assert.strictEqual(unchanged.rows[0].c, 2, 'rerun must not duplicate rows');
  console.log('  ✓ rerunning is idempotent');

  await pool.query('DELETE FROM ' + SCHEMA + '.wallets WHERE id = 2');
  const drifted = run(['--confirm']);
  assert.match(drifted, /skipped-mismatch/, 'drift is reported, not silently overwritten');
  const stillDrifted = await pool.query('SELECT count(*)::int AS c FROM ' + SCHEMA + '.wallets');
  assert.strictEqual(stillDrifted.rows[0].c, 1, 'mismatched table left alone without --replace');
  run(['--confirm', '--replace']);
  const repaired = await pool.query('SELECT count(*)::int AS c FROM ' + SCHEMA + '.wallets');
  assert.strictEqual(repaired.rows[0].c, 2, '--replace re-copies the table');
  console.log('  ✓ drift is flagged and repaired only with --replace');

  await pool.query('DROP SCHEMA IF EXISTS ' + SCHEMA + ' CASCADE');
  console.log('migrateSqliteToPostgres: all checks passed');
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    if (typeof pool.end === 'function') pool.end().catch(() => {});
  });
