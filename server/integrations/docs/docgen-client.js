/**
 * Document Generation Client
 * Generates bond-related PDFs (PPM, certificates, K-1) and uploads to DMS.
 */

'use strict';

const fetch = require('node-fetch');
const pool  = require('../../db/postgres');
const dms   = require('./dms-client');
const bus   = require('../../event-bus');

const DOCGEN_URL = process.env.DOCGEN_URL || 'http://localhost:8091';

async function callDocgen(endpoint, payload) {
  const res = await fetch(`${DOCGEN_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`docgen ${endpoint} failed (${res.status})`);
  return res.json();
}

/**
 * Generate Private Placement Memorandum PDF
 */
async function generatePPM(bondData) {
  const result = await callDocgen('/api/generate/ppm', bondData);
  if (result.file_path) {
    const doc = await dms.uploadDocument(bondData.bond_id, 'ppm', result.file_path);
    await pool.query(
      `UPDATE bond_master_records
       SET prospectus_doc_id = $1, updated_at = now(), updated_by_module = 'docgen'
       WHERE bond_id = $2`,
      [doc.id, bondData.bond_id]
    );
    bus.emit('bond:updated', {
      bond_id: bondData.bond_id,
      source: 'docgen',
      changes: { prospectus_doc_id: doc.id },
    });
  }
  return result;
}

/**
 * Generate Bond Certificate PDF
 */
async function generateBondCertificate(bondData) {
  const result = await callDocgen('/api/generate/bond-certificate', bondData);
  if (result.file_path) {
    await dms.uploadDocument(bondData.bond_id, 'bond_certificate', result.file_path);
  }
  return result;
}

/**
 * Generate K-1 Tax Document for a beneficiary
 */
async function generateK1(beneficiary, bondData) {
  const result = await callDocgen('/api/generate/k1', { beneficiary, bond: bondData });
  if (result.file_path) {
    await dms.uploadDocument(bondData.bond_id, 'k1', result.file_path);
  }
  return result;
}

module.exports = { generatePPM, generateBondCertificate, generateK1 };
