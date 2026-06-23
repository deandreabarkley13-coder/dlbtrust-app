'use strict';

/**
 * API Credential Management — DLBTrust Platform API Keys
 *
 * Generates, validates, and manages API key pairs for authenticating
 * to the DLBTrust ACH pipeline REST API. Keys use the format:
 *   API Key:    dlb_key_<32 hex chars>
 *   API Secret: dlb_secret_<64 hex chars>
 *
 * Secrets are hashed (SHA-256) before storage — the plaintext is only
 * returned once at generation time.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');

class ApiCredentials {

  /**
   * Generate a new API key pair.
   *
   * @param {Object} opts
   * @param {string} opts.label — human-readable name (e.g. "Production Key")
   * @param {string[]} opts.scopes — allowed scopes (default: all)
   * @param {string} opts.expiresIn — optional expiry like "90d", "1y"
   * @param {string} opts.createdBy — who created this key
   * @returns {Object} { keyId, apiKey, apiSecret, label, scopes, expiresAt }
   */
  static async generate(opts = {}) {
    const {
      label = 'API Key',
      scopes = ['batches', 'partners', 'pipeline', 'webhooks'],
      expiresIn,
      createdBy = 'admin',
    } = opts;

    if (!label) throw new Error('label is required');

    const keyId = 'cred_' + crypto.randomBytes(8).toString('hex');
    const apiKey = 'dlb_key_' + crypto.randomBytes(16).toString('hex');
    const apiSecret = 'dlb_secret_' + crypto.randomBytes(32).toString('hex');
    const secretHash = crypto.createHash('sha256').update(apiSecret).digest('hex');

    let expiresAt = null;
    if (expiresIn) {
      const match = expiresIn.match(/^(\d+)(d|h|m|y)$/);
      if (match) {
        const val = parseInt(match[1], 10);
        const unit = match[2];
        const ms = { d: 86400000, h: 3600000, m: 60000, y: 31536000000 }[unit];
        expiresAt = new Date(Date.now() + val * ms).toISOString();
      }
    }

    const result = await pool.query(
      `INSERT INTO api_credentials
        (key_id, api_key, api_secret_hash, label, scopes, active,
         expires_at, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7, NOW())
       RETURNING *`,
      [keyId, apiKey, secretHash, label, scopes, expiresAt, createdBy]
    );

    return {
      key_id: keyId,
      api_key: apiKey,
      api_secret: apiSecret,
      label,
      scopes,
      expires_at: expiresAt,
      created_at: result.rows[0].created_at,
      message: 'Save your API secret now — it cannot be retrieved again.',
    };
  }

  /**
   * Validate an API key + secret pair.
   * Returns the credential record if valid, null otherwise.
   * Also updates last_used_at.
   *
   * @param {string} apiKey
   * @param {string} apiSecret — optional; if omitted, validates key-only (for Bearer auth)
   * @returns {Object|null} credential record or null
   */
  static async validate(apiKey, apiSecret) {
    if (!apiKey) return null;

    const result = await pool.query(
      'SELECT * FROM api_credentials WHERE api_key = $1 AND active = TRUE',
      [apiKey]
    );
    if (!result.rows.length) return null;

    const cred = result.rows[0];

    // Check expiry
    if (cred.expires_at && new Date(cred.expires_at) < new Date()) {
      return null;
    }

    // If secret provided, verify it
    if (apiSecret) {
      const hash = crypto.createHash('sha256').update(apiSecret).digest('hex');
      if (hash !== cred.api_secret_hash) return null;
    }

    // Update last_used_at (fire-and-forget)
    pool.query(
      'UPDATE api_credentials SET last_used_at = NOW() WHERE key_id = $1',
      [cred.key_id]
    ).catch(() => {});

    return {
      key_id: cred.key_id,
      label: cred.label,
      scopes: cred.scopes,
      created_by: cred.created_by,
    };
  }

  /**
   * List all API credentials (secrets never returned).
   */
  static async list(opts = {}) {
    const { activeOnly = false } = opts;
    let sql = 'SELECT key_id, api_key, label, scopes, active, last_used_at, expires_at, created_by, created_at, revoked_at FROM api_credentials';
    if (activeOnly) sql += ' WHERE active = TRUE';
    sql += ' ORDER BY created_at DESC';
    const result = await pool.query(sql);
    return result.rows.map(row => ({
      ...row,
      api_key_preview: row.api_key.substring(0, 16) + '...',
    }));
  }

  /**
   * Revoke an API credential.
   */
  static async revoke(keyId) {
    const result = await pool.query(
      `UPDATE api_credentials SET active = FALSE, revoked_at = NOW()
       WHERE key_id = $1 RETURNING key_id, label, active`,
      [keyId]
    );
    if (!result.rows.length) throw new Error(`Credential not found: ${keyId}`);
    return { ...result.rows[0], message: 'API key revoked' };
  }

  /**
   * Rotate a credential — revoke the old one and generate a new one with same config.
   */
  static async rotate(keyId) {
    const old = await pool.query(
      'SELECT * FROM api_credentials WHERE key_id = $1', [keyId]
    );
    if (!old.rows.length) throw new Error(`Credential not found: ${keyId}`);

    const row = old.rows[0];

    // Revoke old
    await pool.query(
      'UPDATE api_credentials SET active = FALSE, revoked_at = NOW() WHERE key_id = $1',
      [keyId]
    );

    // Generate new with same config
    const newCred = await ApiCredentials.generate({
      label: row.label + ' (rotated)',
      scopes: row.scopes,
      createdBy: row.created_by,
    });

    return {
      revoked: { key_id: keyId, label: row.label },
      new_credential: newCred,
    };
  }
}

module.exports = { ApiCredentials };
