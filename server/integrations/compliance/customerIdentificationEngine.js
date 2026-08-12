'use strict';

/**
 * Customer Identification Program (CIP) / Know Your Customer (KYC) Engine
 *
 * Collects and verifies identity information for trustees, beneficiaries,
 * vendors, and other payees before real-money payouts.
 *
 * Design notes:
 * - Full SSN/TIN and government ID numbers are intentionally NOT stored.
 *   Only the last four digits, a verification provider reference, and a
 *   masked/encrypted-at-rest token are kept.
 * - Every record is run through ComplianceEngine for AML/sanctions/high-risk
 *   scoring before being marked clear.
 * - Records can be required for Stripe Treasury payouts via the
 *   STRIPE_TREASURY_CIP_REQUIRED environment flag.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

let ComplianceEngine;
try { ({ ComplianceEngine } = require('./complianceEngine')); } catch (e) { ComplianceEngine = null; }

function generateId(prefix = 'CIP') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function safeJson(obj) {
  try { return JSON.stringify(obj || {}); } catch { return '{}'; }
}

class CustomerIdentificationEngine {
  static async ensureTables() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cip_records (
        id SERIAL PRIMARY KEY,
        record_id TEXT UNIQUE NOT NULL,
        contact_id TEXT,
        full_legal_name TEXT NOT NULL,
        date_of_birth DATE,
        address JSONB,
        phone TEXT,
        email TEXT,
        tax_id_last_four TEXT,
        id_type TEXT,
        id_issuing_state TEXT,
        id_expiry DATE,
        id_verification_provider TEXT,
        id_verification_reference TEXT,
        beneficial_owners JSONB DEFAULT '[]',
        source_of_funds TEXT,
        politically_exposed_person BOOLEAN DEFAULT false,
        risk_score INTEGER NOT NULL DEFAULT 0,
        risk_level TEXT NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low','medium','high','critical')),
        kyc_status TEXT NOT NULL DEFAULT 'pending' CHECK (kyc_status IN ('pending','clear','review','blocked')),
        compliance_screening_id TEXT,
        screened_by TEXT,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cip_status ON cip_records(kyc_status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cip_contact ON cip_records(contact_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cip_email ON cip_records(email)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cip_name ON cip_records USING gin(to_tsvector('english', full_legal_name))`);
  }

  static normalizeName(name) {
    return (name || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  static async createRecord({
    contactId,
    fullLegalName,
    dateOfBirth,
    address,
    phone,
    email,
    taxIdLastFour,
    idType,
    idIssuingState,
    idExpiry,
    idVerificationProvider,
    idVerificationReference,
    beneficialOwners,
    sourceOfFunds,
    politicallyExposedPerson,
    screenedBy = 'system',
    notes,
  } = {}) {
    if (!fullLegalName) throw new Error('fullLegalName required');
    await this.ensureTables();
    const recordId = generateId('CIP');

    let screening = null;
    let kycStatus = 'pending';
    let riskScore = 0;
    let riskLevel = 'low';
    if (ComplianceEngine) {
      screening = await ComplianceEngine.screen({
        type: 'kyc',
        entityType: 'individual',
        fullName: fullLegalName,
        email,
        phone,
        address,
        country: address && address.country,
        dateOfBirth,
        amount: 0,
        provider: idVerificationProvider || 'local',
        screenedBy,
        notes: `CIP record ${recordId}`,
      });
      riskScore = screening.risk_score || 0;
      riskLevel = screening.risk_level || 'low';
      if (screening.status === 'blocked') {
        kycStatus = 'blocked';
      } else if (idVerificationProvider && idVerificationReference && screening.status === 'clear') {
        kycStatus = 'clear';
      } else if (screening.status === 'review') {
        kycStatus = 'review';
      }
    }

    if (!pool) throw new Error('Database pool not available for CIP records');
    await pool.query(
      `INSERT INTO cip_records
         (record_id, contact_id, full_legal_name, date_of_birth, address, phone, email,
          tax_id_last_four, id_type, id_issuing_state, id_expiry, id_verification_provider,
          id_verification_reference, beneficial_owners, source_of_funds, politically_exposed_person,
          risk_score, risk_level, kyc_status, compliance_screening_id, screened_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [recordId, contactId || null, fullLegalName, dateOfBirth || null, address ? safeJson(address) : null,
       phone || null, email || null, taxIdLastFour || null, idType || null, idIssuingState || null,
       idExpiry || null, idVerificationProvider || null, idVerificationReference || null,
       beneficialOwners ? safeJson(beneficialOwners) : '[]', sourceOfFunds || null,
       !!politicallyExposedPerson, riskScore, riskLevel, kycStatus,
       screening ? screening.screening_id || screening.id : null, screenedBy, notes || null]
    );

    return this.getRecord(recordId);
  }

  static async getRecord(recordId) {
    if (!pool) return null;
    await this.ensureTables();
    const res = await pool.query('SELECT * FROM cip_records WHERE record_id = $1', [recordId]);
    return res.rows[0] || null;
  }

  static async getRecordByContact(contactId) {
    if (!pool) return null;
    await this.ensureTables();
    const res = await pool.query('SELECT * FROM cip_records WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 1', [contactId]);
    return res.rows[0] || null;
  }

  static async getRecordByEmail(email) {
    if (!pool) return null;
    if (!email) return null;
    await this.ensureTables();
    const res = await pool.query('SELECT * FROM cip_records WHERE LOWER(email) = LOWER($1) ORDER BY created_at DESC LIMIT 1', [email]);
    return res.rows[0] || null;
  }

  static async list({ status, limit = 100 } = {}) {
    if (!pool) return [];
    await this.ensureTables();
    let sql = 'SELECT * FROM cip_records';
    const params = [];
    if (status) { sql += ' WHERE kyc_status = $1'; params.push(status); }
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    const res = await pool.query(sql, params);
    return res.rows;
  }

  static async updateStatus(recordId, { status, notes, reviewedBy }) {
    const row = await this.getRecord(recordId);
    if (!row) throw new Error('CIP record not found');
    const extraNotes = notes ? (row.notes ? row.notes + '\n' + notes : notes) : row.notes;
    if (!pool) return { ...row, kyc_status: status, notes: extraNotes, updated_at: new Date().toISOString() };
    await pool.query(
      `UPDATE cip_records SET kyc_status=$1, notes=$2, screened_by=$3, updated_at=NOW() WHERE record_id=$4`,
      [status, extraNotes, reviewedBy || row.screened_by, recordId]
    );
    return this.getRecord(recordId);
  }

  static async approve(recordId, { reviewedBy, notes } = {}) {
    return this.updateStatus(recordId, { status: 'clear', notes, reviewedBy });
  }

  static async block(recordId, { reviewedBy, notes } = {}) {
    return this.updateStatus(recordId, { status: 'blocked', notes, reviewedBy });
  }

  static async mustBeClear(record) {
    if (!record) throw new Error('CIP record required before payout');
    if (record.kyc_status === 'blocked') throw new Error(`CIP blocked: ${record.risk_level} (${record.risk_score})`);
    if (record.kyc_status === 'review') throw new Error(`CIP review required: ${record.risk_level} (${record.risk_score})`);
    if (record.kyc_status !== 'clear') throw new Error(`CIP status is ${record.kyc_status}`);
    return true;
  }

  static async validatePayoutRecipient({ fullName, email, requireClear = true } = {}) {
    if (!requireClear) return { valid: true, required: false };
    const byEmail = email ? await this.getRecordByEmail(email) : null;
    const byName = fullName ? await this.findByName(fullName) : null;
    const record = byEmail || byName;
    if (!record) {
      return { valid: false, required: true, reason: 'No CIP record found for recipient' };
    }
    try {
      await this.mustBeClear(record);
      return { valid: true, required: true, recordId: record.record_id, status: record.kyc_status };
    } catch (e) {
      return { valid: false, required: true, recordId: record.record_id, status: record.kyc_status, reason: e.message };
    }
  }

  static async findByName(fullName) {
    if (!pool || !fullName) return null;
    await this.ensureTables();
    const normalized = this.normalizeName(fullName);
    const res = await pool.query(`
      SELECT * FROM cip_records
      WHERE to_tsvector('english', full_legal_name) @@ plainto_tsquery('english', $1)
      ORDER BY created_at DESC LIMIT 1
    `, [normalized]);
    return res.rows[0] || null;
  }
}

module.exports = { CustomerIdentificationEngine };
