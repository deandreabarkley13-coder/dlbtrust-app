'use strict';

/**
 * AS2 Trading Partner Manager
 *
 * Manages AS2 trading partner configurations — their AS2 IDs,
 * endpoint URLs, certificates, and messaging preferences.
 */

const pool = require('../bonds/pgPool');

class PartnerManager {
  /**
   * Create or update a trading partner.
   *
   * @param {Object} partner
   * @param {string} partner.as2Id — partner's AS2 identifier
   * @param {string} partner.name — display name
   * @param {string} partner.url — partner's AS2 receive URL
   * @param {string} partner.certAlias — alias of imported partner certificate
   * @param {string} partner.encryptionAlg — encryption algorithm (default: aes256-cbc)
   * @param {string} partner.signingAlg — signing algorithm (default: sha256)
   * @param {boolean} partner.requestMdn — whether to request MDN (default: true)
   * @param {boolean} partner.signedMdn — whether MDN should be signed (default: true)
   * @param {string} partner.mdnUrl — async MDN return URL (optional)
   * @param {string} partner.contentType — default content type (default: application/octet-stream)
   * @param {string} partner.notes — free-text notes
   */
  static async createPartner(partner) {
    if (!partner.as2Id || !partner.name) {
      throw new Error('as2Id and name are required');
    }

    const partnerId = 'PTR-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();

    const result = await pool.query(
      `INSERT INTO as2_partners
        (partner_id, as2_identifier, name, endpoint_url, cert_alias,
         encryption_algorithm, signing_algorithm, request_mdn, signed_mdn,
         mdn_url, content_type, notes, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'active', NOW())
       RETURNING *`,
      [partnerId, partner.as2Id, partner.name,
       partner.url || null, partner.certAlias || null,
       partner.encryptionAlg || 'aes256-cbc', partner.signingAlg || 'sha256',
       partner.requestMdn !== false, partner.signedMdn !== false,
       partner.mdnUrl || null, partner.contentType || 'application/octet-stream',
       partner.notes || null]
    );

    return result.rows[0];
  }

  /**
   * Get a partner by ID or AS2 identifier.
   */
  static async getPartner(idOrAs2Id) {
    const result = await pool.query(
      'SELECT * FROM as2_partners WHERE partner_id = $1 OR as2_identifier = $1',
      [idOrAs2Id]
    );
    return result.rows[0] || null;
  }

  /**
   * List all trading partners.
   */
  static async listPartners({ status } = {}) {
    let sql = 'SELECT * FROM as2_partners';
    const params = [];
    if (status) {
      sql += ' WHERE status = $1';
      params.push(status);
    }
    sql += ' ORDER BY created_at DESC';
    const result = await pool.query(sql, params);
    return result.rows;
  }

  /**
   * Update a partner.
   */
  static async updatePartner(partnerId, updates) {
    const fields = [];
    const values = [];
    let idx = 1;

    const allowed = ['name', 'endpoint_url', 'cert_alias', 'encryption_algorithm',
      'signing_algorithm', 'request_mdn', 'signed_mdn', 'mdn_url', 'content_type', 'notes', 'status'];

    const fieldMap = {
      name: 'name', url: 'endpoint_url', endpointUrl: 'endpoint_url',
      certAlias: 'cert_alias', encryptionAlg: 'encryption_algorithm',
      signingAlg: 'signing_algorithm', requestMdn: 'request_mdn',
      signedMdn: 'signed_mdn', mdnUrl: 'mdn_url', contentType: 'content_type',
      notes: 'notes', status: 'status',
    };

    for (const [key, val] of Object.entries(updates)) {
      const col = fieldMap[key] || key;
      if (allowed.includes(col) && val !== undefined) {
        fields.push(`${col} = $${idx++}`);
        values.push(val);
      }
    }

    if (!fields.length) throw new Error('No valid fields to update');

    fields.push(`updated_at = NOW()`);
    values.push(partnerId);

    const result = await pool.query(
      `UPDATE as2_partners SET ${fields.join(', ')} WHERE partner_id = $${idx} OR as2_identifier = $${idx} RETURNING *`,
      values
    );

    if (!result.rows.length) throw new Error(`Partner not found: ${partnerId}`);
    return result.rows[0];
  }

  /**
   * Delete (deactivate) a partner.
   */
  static async deactivatePartner(partnerId) {
    return PartnerManager.updatePartner(partnerId, { status: 'inactive' });
  }
}

module.exports = { PartnerManager };
