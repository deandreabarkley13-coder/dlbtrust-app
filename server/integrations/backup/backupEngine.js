/**
 * Backup Engine — Automated PostgreSQL & SQLite backups with retention
 *
 * Features:
 * - Scheduled PostgreSQL pg_dump backups (every 6 hours by default)
 * - SQLite WAL checkpoint + file copy
 * - Retention policy: keep last 7 daily + 4 weekly backups
 * - Manual backup trigger via API
 * - Restore from any backup point
 * - Full system state export (JSON)
 */

'use strict';

var fs = require('fs');
var path = require('path');
var { execSync, execFileSync, exec } = require('child_process');

var BACKUP_DIR = process.env.BACKUP_DIR || path.resolve(__dirname, '../../../backups');
var PG_HOST = process.env.FINERACT_DB_HOST || 'localhost';
var PG_PORT = process.env.FINERACT_DB_PORT || '5432';
var PG_USER = process.env.FINERACT_DB_USER || 'postgres';
var PG_PASS = process.env.FINERACT_DB_PASSWORD || 'postgres';
var PG_DB = process.env.BOND_DB_NAME || 'fineract_tenants';

// Ensure backup directory exists
function ensureBackupDir() {
  var dirs = [BACKUP_DIR, path.join(BACKUP_DIR, 'pg'), path.join(BACKUP_DIR, 'sqlite'), path.join(BACKUP_DIR, 'exports')];
  dirs.forEach(function(d) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

/**
 * Backup PostgreSQL database using pg_dump
 */
function backupPostgres() {
  ensureBackupDir();
  var timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  var filename = 'pg-backup-' + timestamp + '.sql';
  var filepath = path.join(BACKUP_DIR, 'pg', filename);

  var env = Object.assign({}, process.env, { PGPASSWORD: PG_PASS });
  var args = ['-h', PG_HOST, '-p', PG_PORT, '-U', PG_USER, '-d', PG_DB, '--no-owner', '--no-acl', '-f', filepath];

  try {
    execFileSync('pg_dump', args, { env: env, timeout: 60000 });
    var stats = fs.statSync(filepath);
    console.log('[backup] PostgreSQL backup complete: ' + filename + ' (' + (stats.size / 1024).toFixed(1) + ' KB)');
    return { success: true, file: filename, path: filepath, size: stats.size, timestamp: new Date().toISOString() };
  } catch (err) {
    console.error('[backup] PostgreSQL backup failed:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Backup SQLite databases (trust accounting, etc.)
 */
function backupSQLite() {
  ensureBackupDir();
  var timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  var sqliteDir = path.resolve(__dirname, '../../../data');
  var results = [];

  if (!fs.existsSync(sqliteDir)) {
    return { success: true, message: 'No SQLite databases found', files: [] };
  }

  var files = fs.readdirSync(sqliteDir).filter(function(f) { return f.endsWith('.db') || f.endsWith('.sqlite'); });

  files.forEach(function(dbFile) {
    var src = path.join(sqliteDir, dbFile);
    var dest = path.join(BACKUP_DIR, 'sqlite', dbFile.replace(/\.(db|sqlite)$/, '') + '-' + timestamp + '.db');
    try {
      // WAL checkpoint before copy
      try { execFileSync('sqlite3', [src, 'PRAGMA wal_checkpoint(TRUNCATE);'], { timeout: 10000 }); } catch(e) {}
      fs.copyFileSync(src, dest);
      var stats = fs.statSync(dest);
      results.push({ file: dbFile, backup: path.basename(dest), size: stats.size });
    } catch (err) {
      results.push({ file: dbFile, error: err.message });
    }
  });

  console.log('[backup] SQLite backup complete: ' + results.length + ' file(s)');
  return { success: true, files: results, timestamp: new Date().toISOString() };
}

/**
 * Export full system state as JSON
 */
async function exportSystemState() {
  ensureBackupDir();
  var timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  var filename = 'system-export-' + timestamp + '.json';
  var filepath = path.join(BACKUP_DIR, 'exports', filename);

  try {
    var pool = require(path.join(__dirname, '../../integrations/bonds/pgPool'));

    // Export all critical tables
    var [bonds, cashAccounts, trustAccounts, users, achBatches, contacts, settings, journalEntries] = await Promise.all([
      pool.query('SELECT * FROM bonds'),
      pool.query('SELECT * FROM cash_accounts'),
      pool.query('SELECT * FROM trust_accounts'),
      pool.query('SELECT username, role, created_at, is_locked FROM auth_users'),
      pool.query('SELECT * FROM ach_batches ORDER BY created_at DESC LIMIT 100'),
      pool.query('SELECT * FROM crm_contacts'),
      pool.query('SELECT * FROM system_settings'),
      pool.query('SELECT * FROM journal_entries ORDER BY created_at DESC LIMIT 500'),
    ]);

    var exportData = {
      version: '1.0',
      exported_at: new Date().toISOString(),
      system: 'DLB Trust Treasury Management',
      data: {
        bonds: bonds.rows,
        cash_accounts: cashAccounts.rows,
        trust_accounts: trustAccounts.rows,
        auth_users: users.rows,
        ach_batches: achBatches.rows,
        crm_contacts: contacts.rows,
        system_settings: settings.rows,
        journal_entries: journalEntries.rows,
      },
      counts: {
        bonds: bonds.rowCount,
        cash_accounts: cashAccounts.rowCount,
        trust_accounts: trustAccounts.rowCount,
        auth_users: users.rowCount,
        ach_batches: achBatches.rowCount,
        crm_contacts: contacts.rowCount,
        system_settings: settings.rowCount,
        journal_entries: journalEntries.rowCount,
      },
    };

    fs.writeFileSync(filepath, JSON.stringify(exportData, null, 2));
    var stats = fs.statSync(filepath);
    console.log('[backup] System export complete: ' + filename + ' (' + (stats.size / 1024).toFixed(1) + ' KB)');
    return { success: true, file: filename, path: filepath, size: stats.size, counts: exportData.counts, timestamp: exportData.exported_at };
  } catch (err) {
    console.error('[backup] System export failed:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Restore PostgreSQL from a backup file
 */
function restorePostgres(backupFile) {
  var filepath = path.join(BACKUP_DIR, 'pg', backupFile);
  if (!fs.existsSync(filepath)) {
    return { success: false, error: 'Backup file not found: ' + backupFile };
  }

  var env = Object.assign({}, process.env, { PGPASSWORD: PG_PASS });
  var args = ['-h', PG_HOST, '-p', PG_PORT, '-U', PG_USER, '-d', PG_DB, '-f', filepath];

  try {
    execFileSync('psql', args, { env: env, timeout: 120000 });
    console.log('[backup] PostgreSQL restore complete from: ' + backupFile);
    return { success: true, restored_from: backupFile, timestamp: new Date().toISOString() };
  } catch (err) {
    console.error('[backup] PostgreSQL restore failed:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * List available backups
 */
function listBackups() {
  ensureBackupDir();
  var pgDir = path.join(BACKUP_DIR, 'pg');
  var sqliteDir = path.join(BACKUP_DIR, 'sqlite');
  var exportsDir = path.join(BACKUP_DIR, 'exports');

  var pgFiles = fs.existsSync(pgDir) ? fs.readdirSync(pgDir).filter(function(f) { return f.endsWith('.sql'); }).map(function(f) {
    var s = fs.statSync(path.join(pgDir, f));
    return { file: f, size: s.size, created: s.mtime.toISOString() };
  }).sort(function(a, b) { return b.created.localeCompare(a.created); }) : [];

  var sqliteFiles = fs.existsSync(sqliteDir) ? fs.readdirSync(sqliteDir).filter(function(f) { return f.endsWith('.db'); }).map(function(f) {
    var s = fs.statSync(path.join(sqliteDir, f));
    return { file: f, size: s.size, created: s.mtime.toISOString() };
  }).sort(function(a, b) { return b.created.localeCompare(a.created); }) : [];

  var exportFiles = fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir).filter(function(f) { return f.endsWith('.json'); }).map(function(f) {
    var s = fs.statSync(path.join(exportsDir, f));
    return { file: f, size: s.size, created: s.mtime.toISOString() };
  }).sort(function(a, b) { return b.created.localeCompare(a.created); }) : [];

  return { postgres: pgFiles, sqlite: sqliteFiles, exports: exportFiles };
}

/**
 * Apply retention policy — keep last 7 daily + 4 weekly
 */
function applyRetention() {
  ensureBackupDir();
  var pgDir = path.join(BACKUP_DIR, 'pg');
  if (!fs.existsSync(pgDir)) return { deleted: 0 };

  var files = fs.readdirSync(pgDir).filter(function(f) { return f.endsWith('.sql'); }).map(function(f) {
    var s = fs.statSync(path.join(pgDir, f));
    return { file: f, mtime: s.mtime };
  }).sort(function(a, b) { return b.mtime - a.mtime; });

  var now = Date.now();
  var DAY = 86400000;
  var deleted = 0;

  files.forEach(function(f, i) {
    var ageInDays = (now - f.mtime.getTime()) / DAY;
    if (ageInDays <= 7) return; // keep all from last 7 days
    if (ageInDays <= 28 && f.mtime.getDay() === 0) return; // keep Sunday backups for 4 weeks
    // Delete everything else (non-Sunday 8-28 days old + anything >28 days)
    try {
      fs.unlinkSync(path.join(pgDir, f.file));
      deleted++;
    } catch(e) {}
  });

  if (deleted > 0) console.log('[backup] Retention: deleted ' + deleted + ' old backup(s)');
  return { deleted: deleted };
}

/**
 * Run full backup (PostgreSQL + SQLite + retention)
 */
async function runFullBackup() {
  var pg = backupPostgres();
  var sqlite = backupSQLite();
  var retention = applyRetention();
  return { postgres: pg, sqlite: sqlite, retention: retention, timestamp: new Date().toISOString() };
}

// Scheduled backup interval (default: every 6 hours)
var _backupInterval = null;

function startScheduledBackups(intervalMs) {
  var interval = intervalMs || 6 * 60 * 60 * 1000; // 6 hours
  console.log('[backup] Scheduled backups enabled: every ' + (interval / 3600000).toFixed(1) + ' hours');
  // Run first backup 60s after startup
  setTimeout(function() { runFullBackup(); }, 60000);
  _backupInterval = setInterval(function() { runFullBackup(); }, interval);
}

function stopScheduledBackups() {
  if (_backupInterval) { clearInterval(_backupInterval); _backupInterval = null; }
}

module.exports = {
  backupPostgres: backupPostgres,
  backupSQLite: backupSQLite,
  exportSystemState: exportSystemState,
  restorePostgres: restorePostgres,
  listBackups: listBackups,
  applyRetention: applyRetention,
  runFullBackup: runFullBackup,
  startScheduledBackups: startScheduledBackups,
  stopScheduledBackups: stopScheduledBackups,
};
