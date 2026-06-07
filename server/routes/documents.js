/**
 * Document Management System Routes
 * DEANDREA LAVAR BARKLEY TRUST
 *
 * REST API for trust document lifecycle management.
 */

'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

// --- Database & Schema Setup ------------------------------------------------

function getDb(req, res) {
  if (req.app.locals && req.app.locals.db) return req.app.locals.db;
  const db = require('better-sqlite3')(
    process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'dlbtrust.db')
  );
  if (res) res.on('finish', () => { try { db.close(); } catch (_) { /* */ } });
  return db;
}

function ensureSchema(db) {
  const schemaPath = path.join(__dirname, '..', 'db', 'migrations', 'document-management-schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);
}

let schemaInitialized = false;

function initDb(req, res) {
  const db = getDb(req, res);
  if (!schemaInitialized) {
    ensureSchema(db);
    schemaInitialized = true;
  }
  return db;
}

// --- Engine -----------------------------------------------------------------

const dmsEngine = require('../engines/document-management-engine');

// --- Routes -----------------------------------------------------------------

// GET /api/documents — list/search documents
router.get('/', (req, res) => {
  try {
    const db = initDb(req, res);
    const filters = {
      category: req.query.category || null,
      status: req.query.status || null,
      search: req.query.search || null,
      entity_type: req.query.entity_type || null,
      entity_id: req.query.entity_id ? Number(req.query.entity_id) : null,
      limit: req.query.limit ? Number(req.query.limit) : 50,
    };
    const docs = dmsEngine.listDocuments(db, filters);
    res.json({ documents: docs, count: docs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/stats — dashboard statistics
router.get('/stats', (req, res) => {
  try {
    const db = initDb(req, res);
    const stats = dmsEngine.getDocumentStats(db);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/search?q=... — full-text search
router.get('/search', (req, res) => {
  try {
    const db = initDb(req, res);
    const query = req.query.q || '';
    if (!query) return res.json({ documents: [], count: 0 });
    const docs = dmsEngine.searchDocuments(db, query);
    res.json({ documents: docs, count: docs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/templates — list templates
router.get('/templates', (req, res) => {
  try {
    const db = initDb(req, res);
    const templates = dmsEngine.listTemplates(db);
    res.json({ templates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/documents/templates — create template
router.post('/templates', (req, res) => {
  try {
    const db = initDb(req, res);
    const result = dmsEngine.createTemplate(db, req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/documents/retention-check — check retention policies
router.get('/retention-check', (req, res) => {
  try {
    const db = initDb(req, res);
    const alerts = dmsEngine.checkRetentionPolicies(db);
    res.json({ alerts, count: alerts.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/categories — list available categories
router.get('/categories', (req, res) => {
  res.json({ categories: dmsEngine.DOCUMENT_CATEGORIES });
});

// POST /api/documents — upload new document
router.post('/', (req, res) => {
  try {
    const db = initDb(req, res);
    const { title, description, category, sub_category, file_name, file_type,
            file_content, tags, related_entity_type, related_entity_id,
            requires_signature, effective_date, expiration_date, status } = req.body;

    if (!title || !file_name) {
      return res.status(400).json({ error: 'title and file_name are required' });
    }

    let fileBuffer = null;
    let fileSizeBytes = 0;

    if (file_content) {
      // file_content is base64 encoded
      fileBuffer = Buffer.from(file_content, 'base64');
      fileSizeBytes = fileBuffer.length;
    }

    const result = dmsEngine.createDocument(db, {
      title,
      description,
      category: category || 'general',
      sub_category,
      file_name,
      file_type: file_type || dmsEngine.extractFileType(file_name),
      file_size_bytes: fileSizeBytes,
      mime_type: dmsEngine.guessMimeType(file_name),
      storage_type: 'database',
      file_content: fileBuffer,
      tags,
      related_entity_type,
      related_entity_id,
      requires_signature: requires_signature || false,
      effective_date,
      expiration_date,
      status: status || 'active',
      uploaded_by: 'user',
    });

    dmsEngine.logAccess(db, result.id, 'upload', 'user');

    res.json({ success: true, document_id: result.id, message: `Document "${title}" uploaded successfully` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/documents/:id — get document metadata
router.get('/:id', (req, res) => {
  try {
    const db = initDb(req, res);
    const doc = dmsEngine.getDocumentWithoutContent(db, Number(req.params.id));
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    dmsEngine.logAccess(db, doc.id, 'view', 'user');
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/:id/download — download document file
router.get('/:id/download', (req, res) => {
  try {
    const db = initDb(req, res);
    const doc = dmsEngine.getDocument(db, Number(req.params.id));
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    dmsEngine.logAccess(db, doc.id, 'download', 'user');

    if (doc.file_content) {
      res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${doc.file_name}"`);
      res.send(doc.file_content);
    } else {
      res.status(404).json({ error: 'File content not available' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/:id/versions — version history
router.get('/:id/versions', (req, res) => {
  try {
    const db = initDb(req, res);
    const versions = dmsEngine.getVersionHistory(db, Number(req.params.id));
    res.json({ versions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/documents/:id/version — upload new version
router.post('/:id/version', (req, res) => {
  try {
    const db = initDb(req, res);
    const { file_name, file_content, title, description, tags } = req.body;

    if (!file_name) {
      return res.status(400).json({ error: 'file_name is required' });
    }

    let fileBuffer = null;
    let fileSizeBytes = 0;

    if (file_content) {
      fileBuffer = Buffer.from(file_content, 'base64');
      fileSizeBytes = fileBuffer.length;
    }

    const result = dmsEngine.createNewVersion(db, Number(req.params.id), {
      title,
      description,
      file_name,
      file_size_bytes: fileSizeBytes,
      file_content: fileBuffer,
      tags,
      uploaded_by: 'user',
    });

    dmsEngine.logAccess(db, result.id, 'version_upload', 'user');

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/documents/:id/status — update document status
router.patch('/:id/status', (req, res) => {
  try {
    const db = initDb(req, res);
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status is required' });

    dmsEngine.updateDocumentStatus(db, Number(req.params.id), status, 'user');
    dmsEngine.logAccess(db, Number(req.params.id), `status_change:${status}`, 'user');

    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/documents/:id/sign — sign a document
router.post('/:id/sign', (req, res) => {
  try {
    const db = initDb(req, res);
    const { signed_by } = req.body;
    if (!signed_by) return res.status(400).json({ error: 'signed_by is required' });

    dmsEngine.signDocument(db, Number(req.params.id), signed_by);
    dmsEngine.logAccess(db, Number(req.params.id), 'sign', signed_by);

    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/documents/:id/access-log — document access history
router.get('/:id/access-log', (req, res) => {
  try {
    const db = initDb(req, res);
    const log = dmsEngine.getAccessLog(db, Number(req.params.id));
    res.json({ log });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/documents/:id — archive a document
router.delete('/:id', (req, res) => {
  try {
    const db = initDb(req, res);
    dmsEngine.updateDocumentStatus(db, Number(req.params.id), 'archived', 'user');
    dmsEngine.logAccess(db, Number(req.params.id), 'archive', 'user');
    res.json({ success: true, message: 'Document archived' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
