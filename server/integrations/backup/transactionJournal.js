/**
 * Transaction Journal — Append-only audit log for all state changes
 *
 * Every critical operation (transmit, wire, mode switch, config change, backup)
 * is recorded as an append-only entry. Even if the database corrupts, this
 * journal can reconstruct the state.
 *
 * Properties:
 * - Append-only (no updates, no deletes)
 * - Each entry has a monotonic sequence number
 * - SHA-256 hash chain (each entry references previous hash)
 * - Two backends: JSONL on disk, or a shared Postgres table when
 *   STATE_STORE_BACKEND=postgres, so replicas write one chain instead of one
 *   chain each. The entry shape and hash computation are identical in both, so
 *   a chain written by one backend verifies under the other.
 */

'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var stateStore = require('../cluster/jsonStateStore');
var pgSync = require('../cluster/pgSync');

var GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

var PG_SCHEMA = process.env.STATE_STORE_SCHEMA || 'public';
if (!/^[a-z_][a-z0-9_]*$/.test(PG_SCHEMA)) {
  throw new Error('STATE_STORE_SCHEMA must be a plain lowercase identifier, got: ' + PG_SCHEMA);
}
var PG_TABLE = PG_SCHEMA + '.transaction_journal';
// Namespace for the advisory lock that serialises appends across instances.
var APPEND_LOCK_KEY = 8123401;

var JOURNAL_DIR = path.join(stateStore.dataDir(), 'journal');
var JOURNAL_FILE = path.join(JOURNAL_DIR, 'transactions.jsonl');
var SPILL_FILE = path.join(JOURNAL_DIR, 'transactions.spill.jsonl');
var _sequence = 0;
var _lastHash = GENESIS_HASH;
var _tableReady = false;
var _spilled = 0;

function usePostgres() {
  return String(process.env.STATE_STORE_BACKEND || 'file').toLowerCase() === 'postgres';
}

function ensureJournalDir() {
  if (!fs.existsSync(JOURNAL_DIR)) fs.mkdirSync(JOURNAL_DIR, { recursive: true });
}

function ensureTable() {
  if (_tableReady) return;
  try {
    pgSync.query('CREATE TABLE IF NOT EXISTS ' + PG_TABLE + ' ('
      + 'seq bigint PRIMARY KEY,'
      + 'ts timestamptz NOT NULL,'
      + 'type text NOT NULL,'
      + 'actor text NOT NULL,'
      + 'data jsonb,'
      + 'prev_hash text NOT NULL,'
      + 'hash text NOT NULL UNIQUE,'
      // The exact bytes the hash was taken over. jsonb does not preserve key
      // order, so the chain cannot be re-verified from the `data` column alone.
      + 'payload text NOT NULL)', []);
  } catch (e) {
    // Replicas starting together can both pass IF NOT EXISTS and race on the
    // catalogue; the loser's error means the table is there.
    if (e.code !== '23505' && e.code !== '42P07') throw e;
  }
  _tableReady = true;
}

/**
 * Hash of an entry, computed over the entry without its own hash field. The
 * key order below is the order the entry is built in, and the hash depends on
 * it, so it must not be reordered.
 */
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

function buildEntry(seq, type, data, actor, prevHash) {
  var entry = {
    seq: seq,
    ts: new Date().toISOString(),
    type: type,
    actor: actor || 'system',
    data: data,
    prev_hash: prevHash,
  };
  entry.hash = hashEntry(entry);
  return entry;
}

// ---------------------------------------------------------------------------
// File backend
// ---------------------------------------------------------------------------

function readLines() {
  if (!fs.existsSync(JOURNAL_FILE)) return [];
  var content = fs.readFileSync(JOURNAL_FILE, 'utf8').trim();
  return content ? content.split('\n') : [];
}

function initJournalFile() {
  try {
    var lines = readLines();
    if (!lines.length) return;
    var lastEntry = JSON.parse(lines[lines.length - 1]);
    _sequence = lastEntry.seq || 0;
    _lastHash = lastEntry.hash || _lastHash;
    console.log('[journal] Initialized from existing journal: seq=' + _sequence + ', entries=' + lines.length);
  } catch (e) {
    console.warn('[journal] Init error (starting fresh):', e.message);
  }
}

function fileRecord(type, data, actor) {
  var entry = buildEntry(_sequence + 1, type, data, actor, _lastHash);
  try {
    ensureJournalDir();
    fs.appendFileSync(JOURNAL_FILE, JSON.stringify(entry) + '\n');
    _sequence = entry.seq;
    _lastHash = entry.hash;
  } catch (e) {
    console.error('[journal] Write failed:', e.message);
  }
  return entry;
}

function fileReadEntries(limit, type, since) {
  var lines = readLines();
  var entries = [];
  for (var i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
    try {
      var entry = JSON.parse(lines[i]);
      if (type && entry.type !== type) continue;
      if (since && new Date(entry.ts) < since) break;
      entries.push(entry);
    } catch (e) { continue; }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Postgres backend
// ---------------------------------------------------------------------------

/**
 * Append under an advisory lock, so two instances cannot claim the same
 * sequence number or chain onto the same predecessor.
 */
function pgRecord(type, data, actor) {
  ensureTable();
  return pgSync.transaction(function(query) {
    query('SELECT pg_advisory_xact_lock($1)', [APPEND_LOCK_KEY]);
    var tip = query('SELECT seq, hash FROM ' + PG_TABLE + ' ORDER BY seq DESC LIMIT 1', []);
    var seq = tip.rows.length ? Number(tip.rows[0].seq) + 1 : 1;
    var prevHash = tip.rows.length ? tip.rows[0].hash : GENESIS_HASH;
    var entry = buildEntry(seq, type, data, actor, prevHash);
    query('INSERT INTO ' + PG_TABLE + ' (seq, ts, type, actor, data, prev_hash, hash, payload)'
      + ' VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)',
    [entry.seq, entry.ts, entry.type, entry.actor, JSON.stringify(entry.data === undefined ? null : entry.data),
      entry.prev_hash, entry.hash, hashedPayload(entry)]);
    _sequence = entry.seq;
    _lastHash = entry.hash;
    return entry;
  });
}

// jsonb neither preserves key order nor distinguishes `undefined`, so entries
// are reconstructed from the bytes that were hashed rather than from the
// queryable columns.
function pgRowToEntry(row) {
  var entry = JSON.parse(row.payload);
  entry.hash = row.hash;
  return entry;
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) || 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(function(key) {
    return JSON.stringify(key) + ':' + canonical(value[key]);
  }).join(',') + '}';
}

function pgReadEntries(limit, type, since) {
  ensureTable();
  var clauses = [];
  var params = [];
  if (type) { params.push(type); clauses.push('type = $' + params.length); }
  if (since) { params.push(since.toISOString()); clauses.push('ts >= $' + params.length); }
  params.push(limit);
  var sql = 'SELECT * FROM ' + PG_TABLE
    + (clauses.length ? ' WHERE ' + clauses.join(' AND ') : '')
    + ' ORDER BY seq DESC LIMIT $' + params.length;
  return pgSync.query(sql, params).rows.map(pgRowToEntry);
}

function pgVerifyIntegrity() {
  ensureTable();
  var rows = pgSync.query('SELECT * FROM ' + PG_TABLE + ' ORDER BY seq ASC', []).rows;
  var prevHash = GENESIS_HASH;
  var errors = [];
  rows.forEach(function(row, i) {
    var seq = Number(row.seq);
    if (seq !== i + 1) {
      errors.push({ line: i + 1, error: 'Sequence gap: expected ' + (i + 1) + ', got ' + seq });
    }
    if (row.prev_hash !== prevHash) {
      errors.push({ line: i + 1, error: 'Hash chain broken at seq ' + seq });
    }
    if (crypto.createHash('sha256').update(row.payload).digest('hex') !== row.hash) {
      errors.push({ line: i + 1, error: 'Hash mismatch at seq ' + seq + ' (tampered?)' });
    }
    // The queryable copy of the entry must still say what the hashed bytes say.
    var hashed = JSON.parse(row.payload);
    if (hashed.seq !== seq || hashed.prev_hash !== row.prev_hash || hashed.type !== row.type
      || hashed.actor !== row.actor || canonical(hashed.data) !== canonical(row.data)) {
      errors.push({ line: i + 1, error: 'Row disagrees with hashed payload at seq ' + seq });
    }
    prevHash = row.hash;
  });
  return {
    valid: errors.length === 0,
    entries: rows.length,
    errors: errors,
    last_seq: rows.length ? Number(rows[rows.length - 1].seq) : 0,
    last_hash: (rows.length ? rows[rows.length - 1].hash : GENESIS_HASH).substring(0, 16) + '...',
  };
}

/**
 * Entries that could not reach the shared journal are written to a separate
 * spill file with no sequence number or hash: an instance-local file cannot
 * extend the shared chain, and appending to it as if it could would let two
 * instances mint conflicting successors to the same entry.
 */
function spillRecord(type, data, actor, reason) {
  var entry = {
    seq: null,
    ts: new Date().toISOString(),
    type: type,
    actor: actor || 'system',
    data: data,
    prev_hash: null,
    hash: null,
    unchained: true,
    spill_reason: reason,
  };
  console.error('[journal] SHARED JOURNAL APPEND FAILED (' + reason + ') — entry spilled to '
    + SPILL_FILE + ' and must be reconciled manually');
  try {
    ensureJournalDir();
    fs.appendFileSync(SPILL_FILE, JSON.stringify(entry) + '\n');
    _spilled += 1;
  } catch (e) {
    console.error('[journal] Spill write failed, entry lost:', e.message, JSON.stringify(entry));
  }
  return entry;
}

function spillCount() {
  try {
    if (!fs.existsSync(SPILL_FILE)) return 0;
    var content = fs.readFileSync(SPILL_FILE, 'utf8').trim();
    return content ? content.split('\n').length : 0;
  } catch (e) {
    return _spilled;
  }
}

function pgStats() {
  ensureTable();
  var counted = pgSync.query('SELECT count(*)::int AS entries, max(seq) AS last_seq FROM ' + PG_TABLE, []).rows[0];
  var last = pgSync.query('SELECT seq, type, ts FROM ' + PG_TABLE + ' ORDER BY seq DESC LIMIT 1', []).rows[0] || null;
  return {
    entries: counted.entries,
    storage: PG_TABLE,
    last_entry: last ? { seq: Number(last.seq), type: last.type, ts: new Date(last.ts).toISOString() } : null,
    sequence: counted.last_seq === null ? 0 : Number(counted.last_seq),
    spilled_entries: spillCount(),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a transaction in the journal
 *
 * @param {string} type - Event type (e.g. 'ach_transmit', 'wire_initiate', 'mode_switch')
 * @param {object} data - Event payload
 * @param {string} actor - Who performed the action (username or 'system')
 */
function record(type, data, actor) {
  if (!usePostgres()) return fileRecord(type, data, actor);
  try {
    return pgRecord(type, data, actor);
  } catch (first) {
    try {
      return pgRecord(type, data, actor);
    } catch (e) {
      return spillRecord(type, data, actor, e.message);
    }
  }
}

/**
 * Read journal entries (with optional filtering)
 */
function readEntries(options) {
  options = options || {};
  var limit = options.limit || 100;
  var type = options.type || null;
  var since = options.since ? new Date(options.since) : null;
  try {
    return usePostgres() ? pgReadEntries(limit, type, since) : fileReadEntries(limit, type, since);
  } catch (e) {
    console.error('[journal] Read error:', e.message);
    return [];
  }
}

/**
 * Verify journal integrity (hash chain)
 */
function verifyIntegrity() {
  try {
    if (usePostgres()) return pgVerifyIntegrity();
    var lines = readLines();
    var prevHash = GENESIS_HASH;
    var errors = [];
    for (var i = 0; i < lines.length; i++) {
      var entry = JSON.parse(lines[i]);
      if (entry.seq !== i + 1) {
        errors.push({ line: i + 1, error: 'Sequence gap: expected ' + (i + 1) + ', got ' + entry.seq });
      }
      if (entry.prev_hash !== prevHash) {
        errors.push({ line: i + 1, error: 'Hash chain broken at seq ' + entry.seq });
      }
      if (hashEntry(entry) !== entry.hash) {
        errors.push({ line: i + 1, error: 'Hash mismatch at seq ' + entry.seq + ' (tampered?)' });
      }
      prevHash = entry.hash;
    }
    return {
      valid: errors.length === 0,
      entries: lines.length,
      errors: errors,
      last_seq: _sequence,
      last_hash: _lastHash.substring(0, 16) + '...',
    };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

/**
 * Get journal stats
 */
function getStats() {
  try {
    if (usePostgres()) return pgStats();
    if (!fs.existsSync(JOURNAL_FILE)) return { entries: 0, file_size: 0, last_entry: null, storage: JOURNAL_FILE };
    var stats = fs.statSync(JOURNAL_FILE);
    var lines = readLines();
    var lastEntry = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null;
    return {
      entries: lines.length,
      storage: JOURNAL_FILE,
      file_size: stats.size,
      file_size_human: (stats.size / 1024).toFixed(1) + ' KB',
      last_entry: lastEntry ? { seq: lastEntry.seq, type: lastEntry.type, ts: lastEntry.ts } : null,
      sequence: _sequence,
    };
  } catch (e) {
    return { error: e.message };
  }
}

if (!usePostgres()) {
  ensureJournalDir();
  initJournalFile();
}

module.exports = {
  record: record,
  readEntries: readEntries,
  verifyIntegrity: verifyIntegrity,
  getStats: getStats,
};
