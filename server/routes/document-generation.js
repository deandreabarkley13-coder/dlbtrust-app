/**
 * Document Generation Routes
 * DEANDREA LAVAR BARKLEY TRUST — Automated Document Production
 *
 * Endpoints:
 *   GET    /api/document-generation/report-types    - Available report types
 *   POST   /api/document-generation/generate        - Generate a document
 *   GET    /api/document-generation/log             - Generation history
 *   GET    /api/document-generation/preview/:id     - Preview generated document content
 */

'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const { docGenEngine, REPORT_TYPES } = require('../engines/document-generation-engine');

// --- DB Setup ---------------------------------------------------------------

function getDb() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'dlbtrust.db');
  return new Database(dbPath);
}

function ensureTables(db) {
  const migrations = [
    'banking-schema.sql', 'trust-accounting-schema.sql', 'fixed-income-schema.sql',
    'blockchain-schema.sql', 'cash-management-schema.sql', 'document-management-schema.sql',
    'external-transfers-schema.sql',
  ];
  for (const file of migrations) {
    const p = path.join(__dirname, '..', 'db', 'migrations', file);
    if (fs.existsSync(p)) db.exec(fs.readFileSync(p, 'utf8'));
  }
}

let tablesReady = false;

function initDb() {
  const db = getDb();
  if (!tablesReady) {
    ensureTables(db);
    tablesReady = true;
  }
  return db;
}

// --- Routes -----------------------------------------------------------------

// GET /api/document-generation/report-types — list all available report types
router.get('/report-types', (req, res) => {
  try {
    const types = docGenEngine.getReportTypes();
    res.json({ report_types: types, count: types.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/document-generation/generate — generate a document
router.post('/generate', async (req, res) => {
  let db;
  try {
    db = initDb();
    const { report_type, params } = req.body;

    if (!report_type) {
      return res.status(400).json({ error: 'report_type is required' });
    }
    if (!REPORT_TYPES[report_type]) {
      return res.status(400).json({
        error: `Invalid report_type: ${report_type}`,
        valid_types: Object.keys(REPORT_TYPES),
      });
    }

    const result = await docGenEngine.generate(db, report_type, params || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (db) try { db.close(); } catch (_) { /* */ }
  }
});

// GET /api/document-generation/log — recent generation history
router.get('/log', (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const log = docGenEngine.getGenerationLog(limit);
    res.json({ log, count: log.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/document-generation/preview/:id — get generated document content
router.get('/preview/:id', (req, res) => {
  let db;
  try {
    db = initDb();
    const doc = db.prepare('SELECT * FROM dms_documents WHERE id = ?').get(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    // Return HTML content directly
    if (doc.file_content) {
      const content = Buffer.isBuffer(doc.file_content)
        ? doc.file_content.toString('utf8')
        : doc.file_content;
      res.setHeader('Content-Type', 'text/html');
      res.send(content);
    } else {
      res.status(404).json({ error: 'No content stored for this document' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (db) try { db.close(); } catch (_) { /* */ }
  }
});

module.exports = router;
