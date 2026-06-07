/**
 * Document Management System Engine
 * DEANDREA LAVAR BARKLEY TRUST — Trust Document Repository
 *
 * Full lifecycle management of trust documents:
 *   - Upload, store, and retrieve documents
 *   - Version control (new versions replace old, history preserved)
 *   - Category and tag-based organization
 *   - Search across all documents
 *   - Access logging for audit trail
 *   - Retention policy enforcement
 *   - Document templates for common trust documents
 */

'use strict';

const { bus, EVENTS } = require('./event-bus');

const DOCUMENT_CATEGORIES = [
  'trust_agreement',
  'amendment',
  'certificate',
  'offering_memorandum',
  'compliance',
  'tax',
  'financial_statement',
  'correspondence',
  'board_resolution',
  'beneficiary',
  'vendor',
  'regulatory',
  'general',
];

const DOCUMENT_STATUSES = ['draft', 'active', 'under_review', 'approved', 'archived', 'superseded'];

// --- Document CRUD ----------------------------------------------------------

function createDocument(db, doc) {
  const stmt = db.prepare(`
    INSERT INTO dms_documents (
      title, description, category, sub_category,
      file_name, file_type, file_size_bytes, mime_type,
      storage_type, file_content, file_path,
      related_entity_type, related_entity_id,
      status, requires_signature, tags,
      effective_date, expiration_date, uploaded_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    doc.title,
    doc.description || null,
    doc.category || 'general',
    doc.sub_category || null,
    doc.file_name,
    doc.file_type || extractFileType(doc.file_name),
    doc.file_size_bytes || 0,
    doc.mime_type || guessMimeType(doc.file_name),
    doc.storage_type || 'database',
    doc.file_content || null,
    doc.file_path || null,
    doc.related_entity_type || null,
    doc.related_entity_id || null,
    doc.status || 'draft',
    doc.requires_signature ? 1 : 0,
    doc.tags || null,
    doc.effective_date || null,
    doc.expiration_date || null,
    doc.uploaded_by || 'system'
  );

  bus.emit(EVENTS.DOCUMENT_UPLOADED, {
    document_id: result.lastInsertRowid,
    title: doc.title,
    category: doc.category,
  });

  return { id: result.lastInsertRowid };
}

function getDocument(db, id) {
  return db.prepare('SELECT * FROM dms_documents WHERE id = ?').get(id);
}

function getDocumentWithoutContent(db, id) {
  return db.prepare(`
    SELECT id, title, description, category, sub_category,
           file_name, file_type, file_size_bytes, mime_type,
           storage_type, version, parent_document_id, is_latest,
           related_entity_type, related_entity_id,
           status, requires_signature, signed_by, signed_at,
           approved_by, approved_at, tags,
           effective_date, expiration_date,
           uploaded_by, created_at, updated_at
    FROM dms_documents WHERE id = ?
  `).get(id);
}

function listDocuments(db, filters = {}) {
  let sql = `
    SELECT id, title, description, category, sub_category,
           file_name, file_type, file_size_bytes, mime_type,
           storage_type, version, parent_document_id, is_latest,
           related_entity_type, related_entity_id,
           status, requires_signature, signed_by, signed_at,
           approved_by, approved_at, tags,
           effective_date, expiration_date,
           uploaded_by, created_at, updated_at
    FROM dms_documents WHERE 1=1
  `;
  const params = [];

  if (filters.category) {
    sql += ' AND category = ?';
    params.push(filters.category);
  }
  if (filters.status) {
    sql += ' AND status = ?';
    params.push(filters.status);
  }
  if (filters.latest_only !== false) {
    sql += ' AND is_latest = 1';
  }
  if (filters.entity_type && filters.entity_id) {
    sql += ' AND related_entity_type = ? AND related_entity_id = ?';
    params.push(filters.entity_type, filters.entity_id);
  }
  if (filters.search) {
    sql += ' AND (title LIKE ? OR description LIKE ? OR tags LIKE ?)';
    const term = `%${filters.search}%`;
    params.push(term, term, term);
  }
  if (filters.expiring_within_days) {
    sql += ` AND expiration_date IS NOT NULL AND expiration_date <= date('now', '+' || ? || ' days')`;
    params.push(filters.expiring_within_days);
  }

  sql += ' ORDER BY updated_at DESC';

  if (filters.limit) {
    sql += ' LIMIT ?';
    params.push(filters.limit);
  }

  return db.prepare(sql).all(...params);
}

// --- Versioning -------------------------------------------------------------

function createNewVersion(db, originalId, newDoc) {
  const original = getDocumentWithoutContent(db, originalId);
  if (!original) throw new Error('Original document not found');

  // Mark old version as not latest
  db.prepare('UPDATE dms_documents SET is_latest = 0, status = ? WHERE id = ?')
    .run('superseded', originalId);

  const stmt = db.prepare(`
    INSERT INTO dms_documents (
      title, description, category, sub_category,
      file_name, file_type, file_size_bytes, mime_type,
      storage_type, file_content, file_path,
      version, parent_document_id, is_latest,
      related_entity_type, related_entity_id,
      status, requires_signature, tags,
      effective_date, expiration_date, uploaded_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    newDoc.title || original.title,
    newDoc.description || original.description,
    original.category,
    original.sub_category,
    newDoc.file_name,
    newDoc.file_type || extractFileType(newDoc.file_name),
    newDoc.file_size_bytes || 0,
    newDoc.mime_type || guessMimeType(newDoc.file_name),
    newDoc.storage_type || 'database',
    newDoc.file_content || null,
    newDoc.file_path || null,
    original.version + 1,
    originalId,
    original.related_entity_type,
    original.related_entity_id,
    'draft',
    newDoc.requires_signature ? 1 : 0,
    newDoc.tags || original.tags,
    newDoc.effective_date || original.effective_date,
    newDoc.expiration_date || original.expiration_date,
    newDoc.uploaded_by || 'system'
  );

  bus.emit(EVENTS.DOCUMENT_VERSIONED, {
    document_id: result.lastInsertRowid,
    parent_id: originalId,
    version: original.version + 1,
  });

  return { id: result.lastInsertRowid, version: original.version + 1 };
}

function getVersionHistory(db, documentId) {
  // Walk up the parent chain to find the root, then get all versions
  let current = db.prepare('SELECT * FROM dms_documents WHERE id = ?').get(documentId);
  if (!current) return [];

  // Find root
  while (current.parent_document_id) {
    current = db.prepare('SELECT * FROM dms_documents WHERE id = ?').get(current.parent_document_id);
  }

  // Get all versions from root down
  const versions = [current];
  const children = db.prepare(`
    SELECT id, title, version, status, file_name, file_size_bytes,
           uploaded_by, created_at, is_latest
    FROM dms_documents WHERE parent_document_id = ? ORDER BY version ASC
  `);

  function collectChildren(parentId) {
    const kids = children.all(parentId);
    for (const kid of kids) {
      versions.push(kid);
      collectChildren(kid.id);
    }
  }
  collectChildren(current.id);

  return versions;
}

// --- Status Updates ---------------------------------------------------------

function updateDocumentStatus(db, id, status, updatedBy = 'system') {
  const updates = { status, updated_at: new Date().toISOString() };
  if (status === 'approved') {
    updates.approved_by = updatedBy;
    updates.approved_at = new Date().toISOString();
  }

  db.prepare(`
    UPDATE dms_documents
    SET status = ?, approved_by = COALESCE(?, approved_by),
        approved_at = COALESCE(?, approved_at),
        updated_at = ?
    WHERE id = ?
  `).run(status, updates.approved_by || null, updates.approved_at || null, updates.updated_at, id);

  return { success: true };
}

function signDocument(db, id, signedBy) {
  db.prepare(`
    UPDATE dms_documents
    SET signed_by = ?, signed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(signedBy, id);

  return { success: true };
}

// --- Access Logging ---------------------------------------------------------

function logAccess(db, documentId, action, performedBy = 'system', details = null) {
  db.prepare(`
    INSERT INTO dms_access_log (document_id, action, performed_by, details)
    VALUES (?, ?, ?, ?)
  `).run(documentId, action, performedBy, details ? JSON.stringify(details) : null);
}

function getAccessLog(db, documentId, limit = 50) {
  return db.prepare(`
    SELECT * FROM dms_access_log WHERE document_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(documentId, limit);
}

// --- Search -----------------------------------------------------------------

function searchDocuments(db, query) {
  return db.prepare(`
    SELECT id, title, description, category, sub_category,
           file_name, file_type, file_size_bytes,
           status, tags, version, is_latest,
           uploaded_by, created_at, updated_at
    FROM dms_documents
    WHERE is_latest = 1
      AND (title LIKE ? OR description LIKE ? OR tags LIKE ? OR file_name LIKE ?)
    ORDER BY
      CASE WHEN title LIKE ? THEN 0 ELSE 1 END,
      updated_at DESC
    LIMIT 50
  `).all(`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`);
}

// --- Templates --------------------------------------------------------------

function listTemplates(db) {
  return db.prepare('SELECT * FROM dms_templates WHERE is_active = 1 ORDER BY usage_count DESC').all();
}

function getTemplate(db, id) {
  return db.prepare('SELECT * FROM dms_templates WHERE id = ?').get(id);
}

function createTemplate(db, template) {
  const result = db.prepare(`
    INSERT INTO dms_templates (name, description, category, template_content, placeholders)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    template.name,
    template.description || null,
    template.category,
    template.template_content || null,
    template.placeholders ? JSON.stringify(template.placeholders) : null
  );
  return { id: result.lastInsertRowid };
}

// --- Retention Policies -----------------------------------------------------

function checkRetentionPolicies(db) {
  const policies = db.prepare('SELECT * FROM dms_retention_policies WHERE is_active = 1').all();
  const alerts = [];

  for (const policy of policies) {
    const expiring = db.prepare(`
      SELECT id, title, expiration_date FROM dms_documents
      WHERE category = ? AND is_latest = 1 AND status = 'active'
        AND expiration_date IS NOT NULL
        AND expiration_date <= date('now', '+' || ? || ' days')
    `).all(policy.category, policy.notification_days);

    for (const doc of expiring) {
      alerts.push({
        type: 'document_expiring',
        severity: 'warning',
        document_id: doc.id,
        title: doc.title,
        expiration_date: doc.expiration_date,
        policy: policy.name,
        action: policy.action_on_expiry,
      });
    }
  }

  return alerts;
}

// --- Dashboard Stats --------------------------------------------------------

function getDocumentStats(db) {
  const total = db.prepare('SELECT COUNT(*) as count FROM dms_documents WHERE is_latest = 1').get();
  const byCategory = db.prepare(`
    SELECT category, COUNT(*) as count FROM dms_documents
    WHERE is_latest = 1 GROUP BY category ORDER BY count DESC
  `).all();
  const byStatus = db.prepare(`
    SELECT status, COUNT(*) as count FROM dms_documents
    WHERE is_latest = 1 GROUP BY status ORDER BY count DESC
  `).all();
  const recentUploads = db.prepare(`
    SELECT id, title, category, file_type, file_size_bytes, uploaded_by, created_at
    FROM dms_documents WHERE is_latest = 1
    ORDER BY created_at DESC LIMIT 5
  `).all();
  const expiringDocs = db.prepare(`
    SELECT id, title, category, expiration_date FROM dms_documents
    WHERE is_latest = 1 AND status = 'active'
      AND expiration_date IS NOT NULL
      AND expiration_date <= date('now', '+30 days')
    ORDER BY expiration_date ASC
  `).all();

  return {
    total_documents: total.count,
    by_category: byCategory,
    by_status: byStatus,
    recent_uploads: recentUploads,
    expiring_soon: expiringDocs,
  };
}

// --- Helpers ----------------------------------------------------------------

function extractFileType(filename) {
  const parts = (filename || '').split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : 'unknown';
}

function guessMimeType(filename) {
  const ext = extractFileType(filename);
  const mimeMap = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    txt: 'text/plain',
    csv: 'text/csv',
    html: 'text/html',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

module.exports = {
  DOCUMENT_CATEGORIES,
  DOCUMENT_STATUSES,
  createDocument,
  getDocument,
  getDocumentWithoutContent,
  listDocuments,
  createNewVersion,
  getVersionHistory,
  updateDocumentStatus,
  signDocument,
  logAccess,
  getAccessLog,
  searchDocuments,
  listTemplates,
  getTemplate,
  createTemplate,
  checkRetentionPolicies,
  getDocumentStats,
  extractFileType,
  guessMimeType,
};
