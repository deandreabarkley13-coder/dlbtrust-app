#!/usr/bin/env node
'use strict';

/**
 * Import the JSON state documents left on the data volume into the shared
 * `cluster_state` table, so a second instance starts from the real values
 * instead of waiting for application traffic to touch each document.
 *
 * Usage:
 *   node server/scripts/migrateJsonStateToPostgres.js [--dir /data] [--confirm] [--replace]
 *
 * Without --confirm this only reports what it would import. Source files are
 * never modified or deleted, so a rollback is a matter of flipping
 * STATE_STORE_BACKEND back to `file`.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const pgSync = require('../integrations/cluster/pgSync');

const argv = process.argv.slice(2);
const confirm = argv.includes('--confirm');
const replace = argv.includes('--replace');
const dirFlag = argv.indexOf('--dir');
const DATA_DIR = dirFlag >= 0 ? argv[dirFlag + 1] : (process.env.PERSISTENT_DATA_DIR || '/data');

const SCHEMA = process.env.STATE_STORE_SCHEMA || 'public';
if (!/^[a-z_][a-z0-9_]*$/.test(SCHEMA)) {
  throw new Error('STATE_STORE_SCHEMA must be a plain lowercase identifier, got: ' + SCHEMA);
}
const TABLE = SCHEMA + '.cluster_state';
const OWNER = 'migrateJsonStateToPostgres:' + (process.env.HOSTNAME || os.hostname());

function ensureTable() {
  pgSync.query('CREATE TABLE IF NOT EXISTS ' + TABLE + ' ('
    + 'doc_name text PRIMARY KEY,'
    + 'doc jsonb NOT NULL,'
    + 'revision bigint NOT NULL DEFAULT 1,'
    + 'updated_at timestamptz NOT NULL DEFAULT now(),'
    + 'updated_by text)', []);
}

function candidates() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR)
    .filter((name) => name.endsWith('.json'))
    .filter((name) => fs.statSync(path.join(DATA_DIR, name)).isFile())
    .sort();
}

function main() {
  const files = candidates();
  if (!files.length) {
    console.log('no JSON state documents found in ' + DATA_DIR);
    return;
  }
  ensureTable();
  const existing = new Set(pgSync.query('SELECT doc_name FROM ' + TABLE, []).rows.map((r) => r.doc_name));
  let imported = 0;
  let skipped = 0;
  for (const name of files) {
    const raw = fs.readFileSync(path.join(DATA_DIR, name), 'utf8');
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (e) {
      console.warn('SKIP ' + name + ': not valid JSON (' + e.message + ')');
      skipped += 1;
      continue;
    }
    if (existing.has(name) && !replace) {
      console.log('SKIP ' + name + ': already in ' + TABLE + ' (pass --replace to overwrite)');
      skipped += 1;
      continue;
    }
    const action = existing.has(name) ? 'REPLACE' : 'IMPORT';
    console.log(action + ' ' + name + ' (' + raw.length + ' bytes)');
    if (!confirm) continue;
    pgSync.query('INSERT INTO ' + TABLE + ' (doc_name, doc, updated_by) VALUES ($1, $2::jsonb, $3)'
      + ' ON CONFLICT (doc_name) DO UPDATE SET doc = EXCLUDED.doc, revision = ' + TABLE + '.revision + 1,'
      + ' updated_at = now(), updated_by = EXCLUDED.updated_by', [name, JSON.stringify(doc), OWNER]);
    imported += 1;
  }
  console.log(confirm
    ? 'imported ' + imported + ' document(s), skipped ' + skipped
    : 'dry run: ' + (files.length - skipped) + ' document(s) would be imported; re-run with --confirm');
}

try {
  main();
} finally {
  pgSync.stop();
}
