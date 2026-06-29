/**
 * Transaction Journal — Append-only audit log for all state changes
 *
 * Every critical operation (transmit, wire, mode switch, config change, backup)
 * is recorded in an append-only JSONL file. Even if the database corrupts,
 * this journal can reconstruct the state.
 *
 * Properties:
 * - Append-only (no updates, no deletes)
 * - Each entry has a monotonic sequence number
 * - SHA-256 hash chain (each entry references previous hash)
 * - Human-readable JSONL format
 */

'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var JOURNAL_DIR = path.resolve(__dirname, '../../../data/journal');
var JOURNAL_FILE = path.join(JOURNAL_DIR, 'transactions.jsonl');
var _sequence = 0;
var _lastHash = '0000000000000000000000000000000000000000000000000000000000000000';

// Ensure journal directory
if (!fs.existsSync(JOURNAL_DIR)) fs.mkdirSync(JOURNAL_DIR, { recursive: true });

// Initialize sequence from existing journal
function initJournal() {
  if (!fs.existsSync(JOURNAL_FILE)) {
    _sequence = 0;
    _lastHash = '0000000000000000000000000000000000000000000000000000000000000000';
    return;
  }

  try {
    var content = fs.readFileSync(JOURNAL_FILE, 'utf8').trim();
    if (!content) return;

    var lines = content.split('\n');
    var lastLine = lines[lines.length - 1];
    var lastEntry = JSON.parse(lastLine);
    _sequence = lastEntry.seq || 0;
    _lastHash = lastEntry.hash || _lastHash;
    console.log('[journal] Initialized from existing journal: seq=' + _sequence + ', entries=' + lines.length);
  } catch(e) {
    console.warn('[journal] Init error (starting fresh):', e.message);
  }
}

/**
 * Record a transaction in the journal
 *
 * @param {string} type - Event type (e.g. 'ach_transmit', 'wire_initiate', 'mode_switch')
 * @param {object} data - Event payload
 * @param {string} actor - Who performed the action (username or 'system')
 */
function record(type, data, actor) {
  _sequence++;

  var entry = {
    seq: _sequence,
    ts: new Date().toISOString(),
    type: type,
    actor: actor || 'system',
    data: data,
    prev_hash: _lastHash,
  };

  // Compute hash of this entry (excluding hash field itself)
  var hashContent = JSON.stringify(entry);
  entry.hash = crypto.createHash('sha256').update(hashContent).digest('hex');
  _lastHash = entry.hash;

  // Append to journal
  try {
    fs.appendFileSync(JOURNAL_FILE, JSON.stringify(entry) + '\n');
  } catch(e) {
    console.error('[journal] Write failed:', e.message);
  }

  return entry;
}

/**
 * Read journal entries (with optional filtering)
 */
function readEntries(options) {
  options = options || {};
  var limit = options.limit || 100;
  var type = options.type || null;
  var since = options.since ? new Date(options.since) : null;

  if (!fs.existsSync(JOURNAL_FILE)) return [];

  try {
    var content = fs.readFileSync(JOURNAL_FILE, 'utf8').trim();
    if (!content) return [];

    var lines = content.split('\n');
    var entries = [];

    // Read from end (most recent first)
    for (var i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
      try {
        var entry = JSON.parse(lines[i]);
        if (type && entry.type !== type) continue;
        if (since && new Date(entry.ts) < since) break;
        entries.push(entry);
      } catch(e) { continue; }
    }

    return entries;
  } catch(e) {
    console.error('[journal] Read error:', e.message);
    return [];
  }
}

/**
 * Verify journal integrity (hash chain)
 */
function verifyIntegrity() {
  if (!fs.existsSync(JOURNAL_FILE)) return { valid: true, entries: 0 };

  try {
    var content = fs.readFileSync(JOURNAL_FILE, 'utf8').trim();
    if (!content) return { valid: true, entries: 0 };

    var lines = content.split('\n');
    var prevHash = '0000000000000000000000000000000000000000000000000000000000000000';
    var errors = [];

    for (var i = 0; i < lines.length; i++) {
      var entry = JSON.parse(lines[i]);

      // Check sequence
      if (entry.seq !== i + 1) {
        errors.push({ line: i + 1, error: 'Sequence gap: expected ' + (i + 1) + ', got ' + entry.seq });
      }

      // Check hash chain
      if (entry.prev_hash !== prevHash) {
        errors.push({ line: i + 1, error: 'Hash chain broken at seq ' + entry.seq });
      }

      // Verify hash
      var stored_hash = entry.hash;
      var verify_entry = Object.assign({}, entry);
      delete verify_entry.hash;
      var computed_hash = crypto.createHash('sha256').update(JSON.stringify(verify_entry)).digest('hex');
      if (computed_hash !== stored_hash) {
        errors.push({ line: i + 1, error: 'Hash mismatch at seq ' + entry.seq + ' (tampered?)' });
      }

      prevHash = stored_hash;
    }

    return {
      valid: errors.length === 0,
      entries: lines.length,
      errors: errors,
      last_seq: _sequence,
      last_hash: _lastHash.substring(0, 16) + '...',
    };
  } catch(e) {
    return { valid: false, error: e.message };
  }
}

/**
 * Get journal stats
 */
function getStats() {
  if (!fs.existsSync(JOURNAL_FILE)) {
    return { entries: 0, file_size: 0, last_entry: null };
  }

  try {
    var stats = fs.statSync(JOURNAL_FILE);
    var content = fs.readFileSync(JOURNAL_FILE, 'utf8').trim();
    var lines = content ? content.split('\n') : [];
    var lastEntry = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null;

    return {
      entries: lines.length,
      file_size: stats.size,
      file_size_human: (stats.size / 1024).toFixed(1) + ' KB',
      last_entry: lastEntry ? { seq: lastEntry.seq, type: lastEntry.type, ts: lastEntry.ts } : null,
      sequence: _sequence,
    };
  } catch(e) {
    return { error: e.message };
  }
}

// Initialize on load
initJournal();

module.exports = {
  record: record,
  readEntries: readEntries,
  verifyIntegrity: verifyIntegrity,
  getStats: getStats,
};
