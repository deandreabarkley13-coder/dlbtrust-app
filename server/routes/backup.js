/**
 * Backup & System Resilience API Routes
 *
 * Endpoints:
 * - GET  /api/backup/status          — Backup system status + watchdog info
 * - POST /api/backup/run             — Trigger manual backup (PostgreSQL + SQLite)
 * - POST /api/backup/export          — Export full system state as JSON
 * - GET  /api/backup/list            — List available backups
 * - POST /api/backup/restore         — Restore from a backup file
 * - GET  /api/backup/journal         — Read transaction journal entries
 * - GET  /api/backup/journal/stats   — Journal statistics
 * - GET  /api/backup/journal/verify  — Verify journal integrity (hash chain)
 */

'use strict';

var express = require('express');
var router = express.Router();
var path = require('path');

var backupEngine = require(path.join(__dirname, '../integrations/backup/backupEngine'));
var journal = require(path.join(__dirname, '../integrations/backup/transactionJournal'));

// Auth middleware — require admin token or API key for all backup operations
var requireAdmin = async function(req, res, next) {
  var adminToken = req.headers['x-admin-token'] || req.query.adminToken;
  if (adminToken && adminToken === process.env.ADMIN_SECRET_TOKEN) {
    req.user = 'admin';
    return next();
  }
  var authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      var ApiCredentials = require(path.join(__dirname, '../integrations/ach/apiCredentials')).ApiCredentials;
      var cred = await ApiCredentials.validate(authHeader.slice(7).trim());
      if (cred) { req.user = cred.name || 'api_key'; return next(); }
    } catch(e) {}
  }
  return res.status(401).json({ success: false, error: 'Authentication required' });
};

// ─── Backup Status ────────────────────────────────────────────────────────────
router.get('/status', requireAdmin, function(req, res) {
  var backups = backupEngine.listBackups();
  var journalStats = journal.getStats();

  res.json({
    success: true,
    data: {
      backup_system: 'active',
      scheduled: true,
      schedule_interval: '6 hours',
      retention_policy: '7 daily + 4 weekly',
      backups_available: {
        postgres: backups.postgres.length,
        sqlite: backups.sqlite.length,
        exports: backups.exports.length,
      },
      latest_backup: backups.postgres.length > 0 ? backups.postgres[0] : null,
      journal: journalStats,
      watchdog: {
        status: 'active',
        interval: '30s',
        failures_threshold: 3,
      },
      graceful_shutdown: 'enabled',
      recovery_state: global.__dlb_recovery_state || null,
    },
  });
});

// ─── Trigger Manual Backup ────────────────────────────────────────────────────
router.post('/run', requireAdmin, async function(req, res) {
  try {
    var result = await backupEngine.runFullBackup();
    journal.record('backup_manual', { postgres: result.postgres.success, sqlite: result.sqlite.success }, req.user || 'admin');
    res.json({ success: true, data: result });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Export Full System State ─────────────────────────────────────────────────
router.post('/export', requireAdmin, async function(req, res) {
  try {
    var result = await backupEngine.exportSystemState();
    if (result.success) {
      journal.record('system_export', { file: result.file, counts: result.counts }, req.user || 'admin');
    }
    res.json({ success: result.success, data: result });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── List Backups ─────────────────────────────────────────────────────────────
router.get('/list', requireAdmin, function(req, res) {
  var backups = backupEngine.listBackups();
  res.json({ success: true, data: backups });
});

// ─── Restore from Backup ──────────────────────────────────────────────────────
router.post('/restore', requireAdmin, function(req, res) {
  var file = req.body.file;
  if (!file) return res.status(400).json({ success: false, error: 'Required: file (backup filename)' });

  // Security: prevent path traversal
  if (file.includes('..') || file.includes('/')) {
    return res.status(400).json({ success: false, error: 'Invalid filename' });
  }

  var result = backupEngine.restorePostgres(file);
  if (result.success) {
    journal.record('backup_restore', { file: file }, req.user || 'admin');
  }
  res.json(result);
});

// ─── Transaction Journal ──────────────────────────────────────────────────────
router.get('/journal', requireAdmin, function(req, res) {
  var options = {
    limit: parseInt(req.query.limit || '50', 10),
    type: req.query.type || null,
    since: req.query.since || null,
  };
  var entries = journal.readEntries(options);
  res.json({ success: true, data: entries, count: entries.length });
});

router.get('/journal/stats', requireAdmin, function(req, res) {
  res.json({ success: true, data: journal.getStats() });
});

router.get('/journal/verify', requireAdmin, function(req, res) {
  var result = journal.verifyIntegrity();
  res.json({ success: true, data: result });
});

module.exports = router;
