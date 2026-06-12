/**
 * Document Management System Client
 * Handles upload/retrieval of bond-related documents.
 */

'use strict';

const fetch = require('node-fetch');
const fs    = require('fs');
const path  = require('path');
const pool  = require('../../db/postgres');

const DMS_URL = process.env.DMS_URL || 'http://localhost:8090';

/**
 * Upload a document for a bond
 */
async function uploadDocument(bond_id, doc_type, filePath) {
  const fileName = path.basename(filePath);

  // Store metadata in the bond_documents table
  const { rows: [doc] } = await pool.query(
    `INSERT INTO bond_documents (bond_id, doc_type, file_path)
     VALUES ($1, $2, $3) RETURNING *`,
    [bond_id, doc_type, filePath]
  );

  // Attempt to push to external DMS if configured
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const res = await fetch(`${DMS_URL}/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': fileName },
      body: fileBuffer,
    });
    if (!res.ok) console.warn(`[dms] external upload returned ${res.status}`);
  } catch (err) {
    console.warn('[dms] external DMS unreachable, stored locally:', err.message);
  }

  return doc;
}

/**
 * Get document metadata by ID
 */
async function getDocument(doc_id) {
  const { rows: [doc] } = await pool.query(
    'SELECT * FROM bond_documents WHERE id = $1',
    [doc_id]
  );
  return doc || null;
}

module.exports = { uploadDocument, getDocument };
