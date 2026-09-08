#!/usr/bin/env node
'use strict';

/**
 * Import an existing append-only journal file into the shared
 * `transaction_journal` table, preserving each entry's sequence number, hashes
 * and timestamps so the chain still verifies afterwards.
 *
 * Usage:
 *   node server/scripts/migrateJournalToPostgres.js [--dir <journal dir>] [--confirm]
 *
 * Entries whose hash is already present are skipped, so re-running is safe.
 * The source file is never modified or deleted.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pgSync = require('../integrations/cluster/pgSync');

const argv = process.argv.slice(2);
const confirm = argv.includes('--confirm');
const dirFlag = argv.indexOf('--dir');
const JOURNAL_DIR = dirFlag >= 0
  ? argv[dirFlag + 1]
  : path.join(process.env.PERSISTENT_DATA_DIR || '/data', 'journal');
const JOURNAL_FILE = path.join(JOURNAL_DIR, 'transactions.jsonl');

const SCHEMA = process.env.STATE_STORE_SCHEMA || 'public';
if (!/^[a-z_][a-z0-9_]*$/.test(SCHEMA)) {
  throw new Error('STATE_STORE_SCHEMA must be a plain lowercase identifier, got: ' + SCHEMA);
}
const TABLE = SCHEMA + '.transaction_journal';

function ensureTable() {
  pgSync.query('CREATE TABLE IF NOT EXISTS ' + TABLE + ' ('
    + 'seq bigint PRIMARY KEY,'
    + 'ts timestamptz NOT NULL,'
    + 'type text NOT NULL,'
    + 'actor text NOT NULL,'
    + 'data jsonb,'
    + 'prev_hash text NOT NULL,'
    + 'hash text NOT NULL UNIQUE,'
    + 'payload text NOT NULL)', []);
}

// JSON.parse preserves the key order of the source text, so re-serialising a
// parsed journal line reproduces the exact bytes the entry was hashed over.
function hashedPayload(entry) {
  return JSON.stringify({
    seq: entry.seq,
    ts: entry.ts,
    type: entry.type,
    actor: entry.actor,
    data: entry.data,
    prev_hash: entry.prev_hash,
  });
}

function hashEntry(entry) {
  return crypto.createHash('sha256').update(hashedPayload(entry)).digest('hex');
}

function main() {
  if (!fs.existsSync(JOURNAL_FILE)) {
    console.log('no journal file at ' + JOURNAL_FILE);
    return;
  }
  const lines = fs.readFileSync(JOURNAL_FILE, 'utf8').trim();
  const entries = (lines ? lines.split('\n') : []).map((line) => JSON.parse(line));
  if (!entries.length) {
    console.log('journal file is empty');
    return;
  }
  ensureTable();

  const tampered = entries.filter((entry) => hashEntry(entry) !== entry.hash);
  if (tampered.length) {
    console.warn('WARNING: ' + tampered.length + ' entr(ies) do not match their own hash and will be imported as-is'
      + ' (seq: ' + tampered.map((e) => e.seq).join(', ') + ')');
  }

  const present = new Set(pgSync.query('SELECT hash FROM ' + TABLE, []).rows.map((r) => r.hash));
  const highest = pgSync.query('SELECT max(seq) AS seq FROM ' + TABLE, []).rows[0].seq;
  const collides = entries.filter((entry) => !present.has(entry.hash))
    .filter((entry) => highest !== null && Number(entry.seq) <= Number(highest));
  if (collides.length) {
    throw new Error('the table already holds seq ' + highest + '; importing seq '
      + collides.map((e) => e.seq).join(', ') + ' would break the chain. Import into an empty table.');
  }

  let imported = 0;
  let skipped = 0;
  for (const entry of entries) {
    if (present.has(entry.hash)) { skipped += 1; continue; }
    console.log('IMPORT seq ' + entry.seq + ' ' + entry.type);
    if (!confirm) continue;
    pgSync.query('INSERT INTO ' + TABLE + ' (seq, ts, type, actor, data, prev_hash, hash, payload)'
      + ' VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) ON CONFLICT (hash) DO NOTHING',
    [entry.seq, entry.ts, entry.type, entry.actor || 'system',
      JSON.stringify(entry.data === undefined ? null : entry.data), entry.prev_hash, entry.hash,
      hashedPayload(entry)]);
    imported += 1;
  }
  console.log(confirm
    ? 'imported ' + imported + ' entr(ies), skipped ' + skipped + ' already present'
    : 'dry run: ' + (entries.length - skipped) + ' entr(ies) would be imported; re-run with --confirm');
}

try {
  main();
} finally {
  pgSync.stop();
}
