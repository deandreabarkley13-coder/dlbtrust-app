#!/usr/bin/env node
/**
 * Copy the legacy SQLite trust database into PostgreSQL.
 *
 * The SQLite file lives on the service's ReadWriteOnce volume, which pins the
 * app to a single instance and cannot be shared safely by two writers. This
 * moves its contents into the Postgres addon under a dedicated schema, keeping
 * table and column names so existing SQL only needs the schema prefix.
 *
 * Faithful copy: SQLite declared types are mapped 1:1, no constraints beyond
 * primary keys are recreated, and values are written unchanged (timestamps stay
 * ISO text, exactly as SQLite stored them).
 *
 *   node server/scripts/migrateSqliteToPostgres.js                # dry run
 *   node server/scripts/migrateSqliteToPostgres.js --confirm      # copy
 *   node server/scripts/migrateSqliteToPostgres.js --confirm --replace
 *
 * Env:
 *   SQLITE_DB_PATH        source file (default /data/dlbtrust.db)
 *   LEGACY_SQLITE_SCHEMA  target schema (default legacy_sqlite)
 *   DATABASE_URL          Postgres target (see server/integrations/bonds/pgPool)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const pool = require(path.join(__dirname, '..', 'integrations', 'bonds', 'pgPool'));

const DB_PATH = process.env.SQLITE_DB_PATH || '/data/dlbtrust.db';
const SCHEMA = process.env.LEGACY_SQLITE_SCHEMA || 'legacy_sqlite';
const MAX_ROWS_PER_INSERT = 200;
const MAX_PARAMS_PER_INSERT = 30000; // Postgres caps a statement at 65535 bind parameters

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
const REPLACE = args.includes('--replace');

/** SQLite is dynamically typed; map the declared type to the closest Postgres one. */
function pgType(declared) {
  const t = String(declared || '').toUpperCase();
  if (!t) return 'text';
  if (t.includes('INT')) return 'bigint';
  if (t.includes('BOOL')) return 'boolean';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'double precision';
  if (t.includes('NUMERIC') || t.includes('DECIMAL')) return 'numeric';
  if (t.includes('BLOB')) return 'bytea';
  return 'text';
}

function quote(ident) {
  return '"' + String(ident).replace(/"/g, '""') + '"';
}

function coerce(value, type) {
  if (value === null || value === undefined) return null;
  if (type === 'boolean') return value === 1 || value === '1' || value === true;
  if (type === 'bigint' && typeof value === 'string') {
    // SQLite tolerates text in an INTEGER column; keep the row rather than fail.
    return /^-?\d+$/.test(value.trim()) ? value.trim() : null;
  }
  if (type === 'text' && typeof value !== 'string') {
    return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  }
  return value;
}

function readSqlite() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error('SQLite database not found at ' + DB_PATH);
  }
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH, { readonly: true });
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);

  const plan = tables.map((name) => {
    const columns = db.prepare('PRAGMA table_info(' + quote(name) + ')').all().map((c) => ({
      name: c.name,
      type: pgType(c.type),
      sqliteType: c.type,
      pk: c.pk,
    }));
    const rows = db.prepare('SELECT * FROM ' + quote(name)).all();
    return { name, columns, rows };
  });

  db.close();
  return plan;
}

function createTableSql(table) {
  const cols = table.columns.map((c) => '  ' + quote(c.name) + ' ' + c.type);
  const pk = table.columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
  if (pk.length) {
    cols.push('  PRIMARY KEY (' + pk.map((c) => quote(c.name)).join(', ') + ')');
  }
  return 'CREATE TABLE ' + quote(SCHEMA) + '.' + quote(table.name) + ' (\n' + cols.join(',\n') + '\n)';
}

async function targetCount(name) {
  const res = await pool.query(
    'SELECT to_regclass($1) AS reg',
    [SCHEMA + '.' + name]
  );
  if (!res.rows[0].reg) return null;
  const count = await pool.query('SELECT count(*)::int AS c FROM ' + quote(SCHEMA) + '.' + quote(name));
  return count.rows[0].c;
}

async function copyTable(table) {
  const existing = await targetCount(table.name);

  if (existing !== null && !REPLACE) {
    if (existing === table.rows.length) return { status: 'already-migrated', rows: existing };
    return {
      status: 'skipped-mismatch',
      rows: existing,
      detail: 'target holds ' + existing + ' rows, source has ' + table.rows.length + '; rerun with --replace',
    };
  }

  if (existing !== null) {
    await pool.query('DROP TABLE ' + quote(SCHEMA) + '.' + quote(table.name));
  }
  await pool.query(createTableSql(table));

  const cols = table.columns;
  const batch = Math.max(1, Math.min(MAX_ROWS_PER_INSERT, Math.floor(MAX_PARAMS_PER_INSERT / cols.length)));
  for (let i = 0; i < table.rows.length; i += batch) {
    const slice = table.rows.slice(i, i + batch);
    const params = [];
    const tuples = slice.map((row) => {
      const placeholders = cols.map((c) => {
        params.push(coerce(row[c.name], c.type));
        return '$' + params.length;
      });
      return '(' + placeholders.join(', ') + ')';
    });
    await pool.query(
      'INSERT INTO ' + quote(SCHEMA) + '.' + quote(table.name) +
        ' (' + cols.map((c) => quote(c.name)).join(', ') + ') VALUES ' + tuples.join(', '),
      params
    );
  }

  const after = await targetCount(table.name);
  if (after !== table.rows.length) {
    throw new Error(
      'row count mismatch for ' + table.name + ': copied ' + after + ' of ' + table.rows.length
    );
  }
  return { status: 'migrated', rows: after };
}

async function main() {
  const plan = readSqlite();
  const populated = plan.filter((t) => t.rows.length > 0);
  const sourceRows = populated.reduce((sum, t) => sum + t.rows.length, 0);

  console.log('Source     : ' + DB_PATH);
  console.log('Target     : schema ' + SCHEMA + ' (' + (process.env.DATABASE_URL ? 'DATABASE_URL' : 'FINERACT_DB_* env') + ')');
  console.log('Tables     : ' + plan.length + ' (' + populated.length + ' with rows)');
  console.log('Rows       : ' + sourceRows);
  console.log('Mode       : ' + (CONFIRM ? (REPLACE ? 'copy (replacing existing tables)' : 'copy') : 'DRY RUN — pass --confirm to write'));
  console.log('');

  if (!CONFIRM) {
    for (const t of populated) {
      console.log('  would copy ' + t.name + ' (' + t.rows.length + ' rows, ' + t.columns.length + ' columns)');
    }
    console.log('\nEmpty tables are created too, so existing SQL keeps working: ' + (plan.length - populated.length) + ' of them.');
    return;
  }

  await pool.query('CREATE SCHEMA IF NOT EXISTS ' + quote(SCHEMA));

  const failures = [];
  let copiedRows = 0;
  for (const table of plan) {
    try {
      const result = await copyTable(table);
      copiedRows += result.rows || 0;
      if (result.status !== 'already-migrated' || table.rows.length) {
        console.log('  ' + result.status.padEnd(17) + ' ' + table.name + ' (' + result.rows + ' rows)' +
          (result.detail ? ' — ' + result.detail : ''));
      }
      if (result.status === 'skipped-mismatch') failures.push(table.name + ': ' + result.detail);
    } catch (err) {
      failures.push(table.name + ': ' + err.message);
      console.error('  FAILED            ' + table.name + ' — ' + err.message);
    }
  }

  console.log('\nSchema ' + SCHEMA + ' now holds ' + copiedRows + ' rows; source held ' + sourceRows + '.');
  if (failures.length) {
    console.error('\n' + failures.length + ' table(s) need attention:\n  ' + failures.join('\n  '));
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    if (typeof pool.end === 'function') pool.end().catch(() => {});
  });
