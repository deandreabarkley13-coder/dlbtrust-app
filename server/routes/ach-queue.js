/**
 * ACH File Queue — Manual Submission Portal
 * Mounts at: /api/ach-queue
 *
 * Flow:
 *   1. POST /generate  — calls OpenACH export, stores file in ach_file_queue table
 *   2. GET  /pending   — lists all queued files not yet submitted
 *   3. GET  /download/:id — returns the raw .ach file for download
 *   4. POST /mark-submitted/:id — marks file as submitted, logs timestamp
 */

'use strict';

const express = require('express');
const router  = express.Router();
const { OpenACHClient } = require('../integrations/openach/openachClient');

function requireAdmin(req, res, next) {
  if (typeof req.user !== 'undefined' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function getDb(req) {
  return req.app.locals.db;
}

// Ensure ach_file_queue table exists
function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ach_file_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name TEXT NOT NULL,
      file_content TEXT NOT NULL,
      batch_description TEXT,
      total_amount_cents INTEGER,
      entry_count INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      generated_at TEXT DEFAULT (datetime('now')),
      submitted_at TEXT,
      submitted_by TEXT,
      notes TEXT
    );
  `);
}

// POST /api/ach-queue/generate
// Calls OpenACH to export the pending ACH file and stores it in the queue
router.post('/generate', requireAdmin, async (req, res) => {
  const db = getDb(req);
  if (!db) return res.status(500).json({ error: 'Database not available' });
  ensureTable(db);

  try {
    // Request file export from OpenACH
    const exportResult = await OpenACHClient.exportAchFile();

    const fileName = `dlbtrust_ach_${new Date().toISOString().replace(/[:.]/g, '-')}.ach`;
    const fileContent = exportResult.file_content || exportResult.ach_file || '';

    if (!fileContent) {
      return res.status(502).json({ error: 'OpenACH returned empty file content', raw: exportResult });
    }

    const result = db.prepare(`
      INSERT INTO ach_file_queue (file_name, file_content, batch_description, total_amount_cents, entry_count, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(
      fileName,
      fileContent,
      req.body.description || 'Trust disbursement batch',
      req.body.total_amount_cents || null,
      req.body.entry_count || 0,
    );

    res.json({
      success: true,
      queue_id: result.lastInsertRowid,
      file_name: fileName,
      message: 'ACH file generated and queued. Download and upload to Eaton Family CU online banking portal.',
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/ach-queue/pending
// List all files not yet submitted
router.get('/pending', requireAdmin, (req, res) => {
  const db = getDb(req);
  if (!db) return res.status(500).json({ error: 'Database not available' });
  ensureTable(db);

  const files = db.prepare(`
    SELECT id, file_name, batch_description, total_amount_cents, entry_count, status, generated_at, submitted_at, notes
    FROM ach_file_queue
    ORDER BY generated_at DESC
  `).all();

  res.json({
    success: true,
    count: files.length,
    pending_count: files.filter(f => f.status === 'pending').length,
    submitted_count: files.filter(f => f.status === 'submitted').length,
    files: files.map(f => ({
      ...f,
      total_amount_usd: f.total_amount_cents ? f.total_amount_cents / 100 : null,
      download_url: `/api/ach-queue/download/${f.id}`,
    })),
  });
});

// GET /api/ach-queue/download/:id
// Download the raw .ach file
router.get('/download/:id', requireAdmin, (req, res) => {
  const db = getDb(req);
  if (!db) return res.status(500).json({ error: 'Database not available' });
  ensureTable(db);

  const file = db.prepare('SELECT * FROM ach_file_queue WHERE id = ?').get(req.params.id);
  if (!file) return res.status(404).json({ error: 'File not found' });

  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="${file.file_name}"`);
  res.send(file.file_content);
});

// POST /api/ach-queue/mark-submitted/:id
// Mark a file as submitted to the credit union
router.post('/mark-submitted/:id', requireAdmin, (req, res) => {
  const db = getDb(req);
  if (!db) return res.status(500).json({ error: 'Database not available' });
  ensureTable(db);

  const file = db.prepare('SELECT * FROM ach_file_queue WHERE id = ?').get(req.params.id);
  if (!file) return res.status(404).json({ error: 'File not found' });
  if (file.status === 'submitted') {
    return res.status(409).json({ error: 'File already marked as submitted' });
  }

  db.prepare(`
    UPDATE ach_file_queue
    SET status = 'submitted', submitted_at = datetime('now'), submitted_by = ?, notes = ?
    WHERE id = ?
  `).run(
    req.body.submitted_by || 'admin',
    req.body.notes || null,
    req.params.id,
  );

  res.json({
    success: true,
    id: parseInt(req.params.id),
    status: 'submitted',
    message: 'File marked as submitted to Eaton Family Credit Union',
  });
});

module.exports = router;
