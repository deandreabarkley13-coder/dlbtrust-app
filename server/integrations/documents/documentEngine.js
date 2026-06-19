/**
 * Document Management Engine — DLB Trust Platform
 *
 * Manages document records with versioning, tagging, categorization,
 * and cross-referencing to bonds, contacts, and cash accounts.
 * All storage via PostgreSQL (fineract_tenants).
 */

'use strict';

const pool = require('../bonds/pgPool');

class DocumentEngine {

  static async createDocument({
    documentName, documentType, category, content, contentType,
    bondId, contactId, cashAccountId, referenceType, referenceId,
    tags, metadata, status, createdBy,
  }) {
    const documentId = 'DOC-' + Date.now() + '-'
      + Math.random().toString(36).slice(2, 8).toUpperCase();

    const fileSizeBytes = content ? Buffer.byteLength(content, 'utf8') : 0;

    const result = await pool.query(
      `INSERT INTO documents
         (document_id, document_name, document_type, category, content, content_type,
          file_size_bytes, bond_id, contact_id, cash_account_id,
          reference_type, reference_id, tags, metadata, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        documentId, documentName, documentType, category || 'general',
        content || null, contentType || 'text/plain', fileSizeBytes,
        bondId || null, contactId || null, cashAccountId || null,
        referenceType || null, referenceId || null,
        tags || null, JSON.stringify(metadata || {}),
        status || 'active', createdBy || null,
      ]
    );
    return result.rows[0];
  }

  static async getDocument(documentId) {
    const result = await pool.query(
      `SELECT * FROM documents WHERE document_id = $1`,
      [documentId]
    );
    return result.rows[0] || null;
  }

  static async listDocuments({
    documentType, category, bondId, contactId, status,
    search, limit, offset,
  } = {}) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (documentType) { conditions.push(`document_type = $${idx++}`); params.push(documentType); }
    if (category) { conditions.push(`category = $${idx++}`); params.push(category); }
    if (bondId) { conditions.push(`bond_id = $${idx++}`); params.push(bondId); }
    if (contactId) { conditions.push(`contact_id = $${idx++}`); params.push(contactId); }
    if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
    if (search) {
      conditions.push(`(document_name ILIKE $${idx} OR content ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const lim = parseInt(limit) || 100;
    const off = parseInt(offset) || 0;

    const result = await pool.query(
      `SELECT id, document_id, document_name, document_type, category, content_type,
              file_size_bytes, bond_id, contact_id, cash_account_id,
              reference_type, reference_id, tags, metadata, status, version,
              created_by, created_at, updated_at
       FROM documents ${where}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, lim, off]
    );
    return result.rows;
  }

  static async updateDocument(documentId, updates) {
    const fields = [];
    const params = [];
    let idx = 1;

    const allowed = [
      'document_name', 'document_type', 'category', 'content',
      'content_type', 'status', 'updated_by',
    ];

    const fieldMap = {
      documentName: 'document_name', documentType: 'document_type',
      contentType: 'content_type', updatedBy: 'updated_by',
    };

    for (const [key, val] of Object.entries(updates)) {
      const col = fieldMap[key] || key;
      if (allowed.includes(col) && val !== undefined) {
        fields.push(`${col} = $${idx++}`);
        params.push(val);
      }
    }

    if (updates.tags !== undefined) {
      fields.push(`tags = $${idx++}`);
      params.push(updates.tags);
    }
    if (updates.metadata !== undefined) {
      fields.push(`metadata = $${idx++}`);
      params.push(JSON.stringify(updates.metadata));
    }
    if (updates.content !== undefined) {
      fields.push(`file_size_bytes = $${idx++}`);
      params.push(Buffer.byteLength(updates.content, 'utf8'));
    }

    if (fields.length === 0) throw new Error('No valid fields to update');

    fields.push(`version = version + 1`);
    fields.push(`updated_at = NOW()`);
    params.push(documentId);

    const result = await pool.query(
      `UPDATE documents SET ${fields.join(', ')}
       WHERE document_id = $${idx}
       RETURNING *`,
      params
    );
    if (result.rows.length === 0) throw new Error(`Document ${documentId} not found`);
    return result.rows[0];
  }

  static async archiveDocument(documentId) {
    const result = await pool.query(
      `UPDATE documents SET status = 'archived', updated_at = NOW()
       WHERE document_id = $1 RETURNING *`,
      [documentId]
    );
    if (result.rows.length === 0) throw new Error(`Document ${documentId} not found`);
    return result.rows[0];
  }

  static async getDocumentsByBond(bondId, { limit, offset } = {}) {
    const lim = parseInt(limit) || 100;
    const off = parseInt(offset) || 0;
    const result = await pool.query(
      `SELECT * FROM documents WHERE bond_id = $1 AND status != 'deleted'
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [bondId, lim, off]
    );
    return result.rows;
  }

  static async getDocumentsByContact(contactId, { limit, offset } = {}) {
    const lim = parseInt(limit) || 100;
    const off = parseInt(offset) || 0;
    const result = await pool.query(
      `SELECT * FROM documents WHERE contact_id = $1 AND status != 'deleted'
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [contactId, lim, off]
    );
    return result.rows;
  }

  static async getStats() {
    const result = await pool.query(`
      SELECT
        COUNT(*) AS total_documents,
        COUNT(CASE WHEN status = 'active' THEN 1 END) AS active_documents,
        COUNT(CASE WHEN status = 'draft' THEN 1 END) AS draft_documents,
        COUNT(CASE WHEN status = 'archived' THEN 1 END) AS archived_documents,
        COALESCE(SUM(file_size_bytes), 0) AS total_size_bytes
      FROM documents WHERE status != 'deleted'
    `);
    const stats = result.rows[0];

    const byType = await pool.query(`
      SELECT document_type, COUNT(*) AS count
      FROM documents WHERE status != 'deleted'
      GROUP BY document_type ORDER BY count DESC
    `);

    return {
      total_documents: parseInt(stats.total_documents),
      active_documents: parseInt(stats.active_documents),
      draft_documents: parseInt(stats.draft_documents),
      archived_documents: parseInt(stats.archived_documents),
      total_size_bytes: parseInt(stats.total_size_bytes),
      by_type: byType.rows.reduce((acc, r) => { acc[r.document_type] = parseInt(r.count); return acc; }, {}),
    };
  }
}

module.exports = { DocumentEngine };
