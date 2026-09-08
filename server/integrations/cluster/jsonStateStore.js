'use strict';

/**
 * Shared JSON state store for the DApp engines that keep their records in files
 * on the persistent volume.
 *
 * With more than one instance those files are read and written by several
 * processes at once, so plain readFileSync/writeFileSync is unsafe in two ways:
 * a reader can observe a half-written file, and two writers can each save a
 * document built from the same starting point, dropping one of the two changes.
 *
 * This module removes both:
 *   - write() writes a temporary file and renames it over the target, so a
 *     reader sees either the old document or the new one, never a partial one.
 *   - update() holds an exclusive lock file for the whole read-modify-write, so
 *     concurrent mutations of the same document serialise instead of racing.
 *
 * Everything is synchronous, matching the engines' existing call signatures.
 *
 * With STATE_STORE_BACKEND=postgres the documents live in a Postgres table
 * instead of the volume, which is what lets the service run more than one
 * instance: the volume is ReadWriteOnce, so a second instance cannot mount it
 * at all. The file layout stays the seed for that table — the first read of a
 * document that has no row yet imports the file — and stays the store for
 * local development.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const pgSync = require('./pgSync');

const LOCK_TIMEOUT_MS = parseInt(process.env.STATE_LOCK_TIMEOUT_MS || '5000', 10);
const LOCK_STALE_MS = parseInt(process.env.STATE_LOCK_STALE_MS || '30000', 10);
const LOCK_POLL_MS = 25;
const OWNER = (process.env.HOSTNAME || os.hostname()) + ':' + process.pid;

const PG_SCHEMA = process.env.STATE_STORE_SCHEMA || 'public';
if (!/^[a-z_][a-z0-9_]*$/.test(PG_SCHEMA)) {
  throw new Error('STATE_STORE_SCHEMA must be a plain lowercase identifier, got: ' + PG_SCHEMA);
}
const PG_TABLE = PG_SCHEMA + '.cluster_state';

function usePostgres() {
  return String(process.env.STATE_STORE_BACKEND || 'file').toLowerCase() === 'postgres';
}

let tableReady = false;

function ensureTable() {
  if (tableReady) return;
  try {
    pgSync.query('CREATE TABLE IF NOT EXISTS ' + PG_TABLE + ' ('
      + 'doc_name text PRIMARY KEY,'
      + 'doc jsonb NOT NULL,'
      + 'revision bigint NOT NULL DEFAULT 1,'
      + 'updated_at timestamptz NOT NULL DEFAULT now(),'
      + 'updated_by text)', []);
  } catch (e) {
    // Two instances starting together can both pass IF NOT EXISTS and race on
    // the catalogue; the loser's error means the table is there.
    if (e.code !== '23505' && e.code !== '42P07') throw e;
  }
  tableReady = true;
}

// Revision of each document as this process last saw it in Postgres, so a
// write can tell whether another instance changed it in between.
const lastRevision = new Map();

function pgRead(fileName, fallback) {
  ensureTable();
  const found = pgSync.query('SELECT doc, revision FROM ' + PG_TABLE + ' WHERE doc_name = $1', [fileName]);
  if (found.rows.length) {
    lastRevision.set(fileName, String(found.rows[0].revision));
    return found.rows[0].doc;
  }
  // No row yet: a document left on the volume by the single-instance era is the
  // starting value, so the move to Postgres does not lose it.
  const seed = fileRead(fileName, null);
  if (seed !== null && seed !== undefined) {
    console.log('[state-store] seeding ' + fileName + ' into ' + PG_TABLE + ' from the volume');
    const seeded = pgSync.query('INSERT INTO ' + PG_TABLE + ' (doc_name, doc, updated_by) VALUES ($1, $2::jsonb, $3)'
      + ' ON CONFLICT (doc_name) DO NOTHING RETURNING revision', [fileName, JSON.stringify(seed), OWNER]);
    if (seeded.rows.length) {
      lastRevision.set(fileName, String(seeded.rows[0].revision));
      return seed;
    }
    return pgRead(fileName, fallback);
  }
  lastRevision.delete(fileName);
  return typeof fallback === 'function' ? fallback() : fallback;
}

function pgWrite(fileName, doc) {
  ensureTable();
  const seen = lastRevision.get(fileName);
  const written = pgSync.query('INSERT INTO ' + PG_TABLE + ' (doc_name, doc, updated_by) VALUES ($1, $2::jsonb, $3)'
    + ' ON CONFLICT (doc_name) DO UPDATE SET doc = EXCLUDED.doc, revision = ' + PG_TABLE + '.revision + 1,'
    + ' updated_at = now(), updated_by = EXCLUDED.updated_by'
    + ' RETURNING revision', [fileName, JSON.stringify(doc), OWNER]);
  const revision = String(written.rows[0].revision);
  if (seen !== undefined && String(Number(seen) + 1) !== revision) {
    conflicts += 1;
    console.warn('[state-store] CONFLICT on ' + fileName + ' — it changed since this instance read it; overwriting with this instance\'s version');
  }
  lastRevision.set(fileName, revision);
  return true;
}

/**
 * Read-modify-write against Postgres, holding a row lock for the whole
 * operation, so a concurrent mutation on another instance waits its turn
 * instead of building on a value that is about to be replaced.
 */
function pgUpdate(fileName, fallback, mutator) {
  ensureTable();
  return pgSync.transaction((query) => {
    let locked = query('SELECT doc, revision FROM ' + PG_TABLE + ' WHERE doc_name = $1 FOR UPDATE', [fileName]);
    if (!locked.rows.length) {
      const seed = fileRead(fileName, null);
      const initial = seed === null || seed === undefined
        ? (typeof fallback === 'function' ? fallback() : fallback)
        : seed;
      query('INSERT INTO ' + PG_TABLE + ' (doc_name, doc, updated_by) VALUES ($1, $2::jsonb, $3)'
        + ' ON CONFLICT (doc_name) DO NOTHING', [fileName, JSON.stringify(initial), OWNER]);
      locked = query('SELECT doc, revision FROM ' + PG_TABLE + ' WHERE doc_name = $1 FOR UPDATE', [fileName]);
    }
    const current = locked.rows[0].doc;
    const next = mutator(current);
    const doc = next === undefined ? current : next;
    const written = query('UPDATE ' + PG_TABLE + ' SET doc = $2::jsonb, revision = revision + 1,'
      + ' updated_at = now(), updated_by = $3 WHERE doc_name = $1 RETURNING revision',
    [fileName, JSON.stringify(doc), OWNER]);
    lastRevision.set(fileName, String(written.rows[0].revision));
    return doc;
  });
}

/**
 * Where persistent documents live: the mounted volume in production, a
 * repo-local directory otherwise.
 */
function dataDir() {
  if (process.env.PERSISTENT_DATA_DIR && fs.existsSync(process.env.PERSISTENT_DATA_DIR)) {
    return process.env.PERSISTENT_DATA_DIR;
  }
  if (fs.existsSync('/data')) return '/data';
  return path.join(process.cwd(), 'data');
}

function ensureDir() {
  const dir = dataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function resolve(fileName) {
  return path.join(ensureDir(), fileName);
}

// Fingerprint of each document as this process last saw it, so a write can tell
// whether another instance changed it in between.
const lastSeen = new Map();
let conflicts = 0;

function fingerprint(file) {
  try {
    const st = fs.statSync(file);
    return st.mtimeMs + ':' + st.size;
  } catch (e) {
    return 'absent';
  }
}

function fileRead(fileName, fallback) {
  const file = resolve(fileName);
  try {
    if (fs.existsSync(file)) {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      lastSeen.set(fileName, fingerprint(file));
      return doc;
    }
  } catch (e) {
    console.warn('[state-store] read ' + fileName + ' failed: ' + e.message);
  }
  lastSeen.set(fileName, fingerprint(file));
  return typeof fallback === 'function' ? fallback() : fallback;
}

function fileWrite(fileName, doc) {
  const file = resolve(fileName);
  // A document that moved since this process read it means a concurrent writer:
  // last write wins, but it must not do so silently.
  const seen = lastSeen.get(fileName);
  if (seen !== undefined && seen !== fingerprint(file)) {
    conflicts += 1;
    console.warn('[state-store] CONFLICT on ' + fileName + ' — it changed since this instance read it; overwriting with this instance\'s version');
  }
  // Unique temp name so two instances writing at once cannot share a temp file.
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, file);
    lastSeen.set(fileName, fingerprint(file));
    return true;
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (x) { /* temp file already gone */ }
    console.warn('[state-store] write ' + fileName + ' failed: ' + e.message);
    return false;
  }
}

function lockPath(fileName) {
  return resolve(fileName) + '.lock';
}

function acquire(fileName) {
  const lock = lockPath(fileName);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, OWNER + ' ' + Date.now());
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') {
        console.warn('[state-store] lock ' + fileName + ' failed: ' + e.message);
        return false;
      }
      // A crashed holder must not block writes forever.
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > LOCK_STALE_MS) {
          console.warn('[state-store] clearing stale lock on ' + fileName + ' (' + Math.round(age / 1000) + 's old)');
          fs.unlinkSync(lock);
          continue;
        }
      } catch (x) { /* holder released it, retry */ }
      if (Date.now() > deadline) {
        console.warn('[state-store] lock ' + fileName + ' timed out after ' + LOCK_TIMEOUT_MS + 'ms — writing unserialised');
        return false;
      }
      sleep(LOCK_POLL_MS);
    }
  }
}

function release(fileName) {
  try { fs.unlinkSync(lockPath(fileName)); } catch (e) { /* nothing to release */ }
}

// Blocking sleep: the callers are synchronous, and waits here are single-digit
// milliseconds on an uncontended document.
function sleep(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* spin */ }
}

/**
 * Read the document, apply `mutator`, and save the result under a lock, so a
 * concurrent mutation on another instance cannot overwrite this one. The
 * mutator's return value is what gets written; return undefined to write the
 * (mutated in place) document it was given. Returns the written document.
 */
function fileUpdate(fileName, fallback, mutator) {
  const locked = acquire(fileName);
  try {
    const current = fileRead(fileName, fallback);
    const next = mutator(current);
    const doc = next === undefined ? current : next;
    fileWrite(fileName, doc);
    return doc;
  } finally {
    if (locked) release(fileName);
  }
}

function read(fileName, fallback) {
  return usePostgres() ? pgRead(fileName, fallback) : fileRead(fileName, fallback);
}

function write(fileName, doc) {
  return usePostgres() ? pgWrite(fileName, doc) : fileWrite(fileName, doc);
}

function update(fileName, fallback, mutator) {
  return usePostgres() ? pgUpdate(fileName, fallback, mutator) : fileUpdate(fileName, fallback, mutator);
}

function stats() {
  const postgres = usePostgres();
  return {
    backend: postgres ? 'postgres' : 'file',
    table: postgres ? PG_TABLE : null,
    dir: dataDir(),
    documents: postgres ? lastRevision.size : lastSeen.size,
    conflicts: conflicts,
  };
}

module.exports = {
  stats: stats,
  dataDir: dataDir,
  ensureDir: ensureDir,
  resolve: resolve,
  read: read,
  write: write,
  update: update,
};
