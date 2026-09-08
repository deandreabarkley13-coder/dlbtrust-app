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
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const LOCK_TIMEOUT_MS = parseInt(process.env.STATE_LOCK_TIMEOUT_MS || '5000', 10);
const LOCK_STALE_MS = parseInt(process.env.STATE_LOCK_STALE_MS || '30000', 10);
const LOCK_POLL_MS = 25;
const OWNER = (process.env.HOSTNAME || os.hostname()) + ':' + process.pid;

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

function read(fileName, fallback) {
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

function write(fileName, doc) {
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
function update(fileName, fallback, mutator) {
  const locked = acquire(fileName);
  try {
    const current = read(fileName, fallback);
    const next = mutator(current);
    const doc = next === undefined ? current : next;
    write(fileName, doc);
    return doc;
  } finally {
    if (locked) release(fileName);
  }
}

function stats() {
  return { dir: dataDir(), documents: lastSeen.size, conflicts: conflicts };
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
