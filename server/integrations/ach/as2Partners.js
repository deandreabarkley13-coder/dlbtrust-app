'use strict';

/**
 * AS2 Partner Registry — Multi-Partner AS2 Configuration
 *
 * Manages multiple AS2 partner connections for ACH file transmission.
 * Each partner has its own endpoint URL, AS2 identifiers, certificates,
 * and signing/encryption settings. Batches are routed to partners at
 * creation time via partner_id.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pool = require('../bonds/pgPool');

const CERTS_BASE_DIR = path.join(__dirname, '..', '..', '..', 'data', 'as2-certs');

class AS2Partners {

  /**
   * Ensure the certificates directory exists for a partner.
   */
  static ensureCertsDir(partnerId) {
    const dir = path.join(CERTS_BASE_DIR, partnerId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  /**
   * Register a new AS2 partner.
   *
   * @param {Object} opts
   * @param {string} opts.partnerId - Unique identifier (e.g. "EATONFCU", "MERCHANT-A")
   * @param {string} opts.partnerName - Display name
   * @param {string} opts.partnerUrl - AS2 endpoint URL
   * @param {string} opts.partnerAs2Id - Bank/merchant AS2 identifier
   * @param {string} opts.localAs2Id - Our AS2 identifier for this partner (default: DLBTRUST-AS2)
   * @param {string} opts.signingCert - PEM content of our signing certificate
   * @param {string} opts.signingKey - PEM content of our private key
   * @param {string} opts.partnerCert - PEM content of partner's public certificate
   * @param {string} opts.encryptionAlg - Encryption algorithm (default: aes256-cbc)
   * @param {string} opts.signingAlg - Signing algorithm (default: sha256)
   * @param {boolean} opts.requestMdn - Request MDN receipt (default: true)
   * @param {string} opts.mdnUrl - URL for async MDN callbacks
   * @param {boolean} opts.isDefault - Set as default partner
   * @param {string} opts.notes - Optional notes
   */
  static async register(opts) {
    const {
      partnerId, partnerName, protocol,
      partnerUrl, partnerAs2Id,
      localAs2Id, signingCert, signingKey, partnerCert,
      encryptionAlg, signingAlg, requestMdn, mdnUrl,
      apiBaseUrl, apiKey, apiSecret, apiAuthType, webhookSecret,
      useMtls, clientCert, clientKey, clientCa,
      clientCertPath, clientKeyPath, clientCaPath, clientKeyPassphrase,
      isDefault, notes,
    } = opts;

    const proto = protocol || 'as2';
    if (!partnerId) throw new Error('partnerId is required');
    if (!partnerName) throw new Error('partnerName is required');

    if (proto === 'as2') {
      if (!partnerUrl) throw new Error('partnerUrl is required for AS2 partners');
    } else if (proto === 'rest_api') {
      if (!apiBaseUrl && !partnerUrl) throw new Error('apiBaseUrl or partnerUrl is required for REST API partners');
    }

    // Check for duplicate
    const existing = await pool.query(
      'SELECT partner_id FROM as2_partners WHERE partner_id = $1', [partnerId]
    );
    if (existing.rows.length) {
      throw new Error(`Partner already exists: ${partnerId}. Use update instead.`);
    }

    // Write certificates to disk
    const certPaths = AS2Partners._writeCerts(partnerId, {
      signingCert, signingKey, partnerCert, clientCert, clientKey, clientCa,
    });

    // Resolve mTLS paths: prefer uploaded content (written to disk), else direct path
    const resolvedClientCert = certPaths.clientCert || clientCertPath || null;
    const resolvedClientKey = certPaths.clientKey || clientKeyPath || null;
    const resolvedClientCa = certPaths.clientCa || clientCaPath || null;

    // If setting as default, clear existing default
    if (isDefault) {
      await pool.query('UPDATE as2_partners SET is_default = FALSE WHERE is_default = TRUE');
    }

    const result = await pool.query(
      `INSERT INTO as2_partners
        (partner_id, partner_name, protocol, partner_url, partner_as2_id, local_as2_id,
         signing_cert_path, signing_key_path, partner_cert_path,
         encryption_alg, signing_alg, request_mdn, mdn_url,
         api_base_url, api_key, api_secret, api_auth_type, webhook_secret,
         use_mtls, client_cert_path, client_key_path, client_ca_path, client_key_passphrase,
         is_default, active, notes, name, as2_identifier, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, TRUE, $25, $26, $27, NOW(), NOW())
       RETURNING *`,
      [
        partnerId, partnerName, proto,
        partnerUrl || apiBaseUrl || '',
        partnerAs2Id || null,
        localAs2Id || 'DLBTRUST-AS2',
        certPaths.signingCert || null,
        certPaths.signingKey || null,
        certPaths.partnerCert || null,
        encryptionAlg || 'aes256-cbc',
        signingAlg || 'sha256',
        requestMdn !== false,
        mdnUrl || null,
        apiBaseUrl || null,
        apiKey || null,
        apiSecret || null,
        apiAuthType || 'bearer',
        webhookSecret || null,
        useMtls === true || useMtls === 'true',
        resolvedClientCert,
        resolvedClientKey,
        resolvedClientCa,
        clientKeyPassphrase || null,
        isDefault || false,
        notes || null,
        // Legacy columns from migrate-as2.sql (backfill for compatibility)
        partnerName || partnerId,
        partnerAs2Id || partnerId,
      ]
    );

    return AS2Partners._redactRow(result.rows[0]);
  }

  /**
   * Update an existing partner's configuration.
   * Only provided fields are updated; omitted fields are preserved.
   */
  static async update(partnerId, updates) {
    const partner = await AS2Partners.getPartner(partnerId);
    if (!partner) throw new Error(`Partner not found: ${partnerId}`);

    const {
      partnerName, partnerUrl, partnerAs2Id, localAs2Id, protocol,
      signingCert, signingKey, partnerCert,
      encryptionAlg, signingAlg, requestMdn, mdnUrl,
      apiBaseUrl, apiKey, apiSecret, apiAuthType, webhookSecret,
      useMtls, clientCert, clientKey, clientCa,
      clientCertPath, clientKeyPath, clientCaPath, clientKeyPassphrase,
      isDefault, active, notes,
    } = updates;

    // Write new certs if provided
    const certPaths = AS2Partners._writeCerts(partnerId, {
      signingCert, signingKey, partnerCert, clientCert, clientKey, clientCa,
    });

    // If setting as default, clear existing default
    if (isDefault === true) {
      await pool.query(
        'UPDATE as2_partners SET is_default = FALSE WHERE is_default = TRUE AND partner_id != $1',
        [partnerId]
      );
    }

    const setClauses = [];
    const params = [];
    let idx = 1;

    const fields = {
      partner_name: partnerName,
      protocol: protocol,
      partner_url: partnerUrl,
      partner_as2_id: partnerAs2Id,
      local_as2_id: localAs2Id,
      encryption_alg: encryptionAlg,
      signing_alg: signingAlg,
      request_mdn: requestMdn,
      mdn_url: mdnUrl,
      api_base_url: apiBaseUrl,
      api_key: apiKey,
      api_secret: apiSecret,
      api_auth_type: apiAuthType,
      webhook_secret: webhookSecret,
      use_mtls: useMtls === undefined ? undefined : (useMtls === true || useMtls === 'true'),
      client_key_passphrase: clientKeyPassphrase,
      is_default: isDefault,
      active: active,
      notes: notes,
    };

    for (const [col, val] of Object.entries(fields)) {
      if (val !== undefined) {
        setClauses.push(`${col} = $${idx++}`);
        params.push(val);
      }
    }

    // Only update cert paths if new certs were provided
    if (certPaths.signingCert) {
      setClauses.push(`signing_cert_path = $${idx++}`);
      params.push(certPaths.signingCert);
    }
    if (certPaths.signingKey) {
      setClauses.push(`signing_key_path = $${idx++}`);
      params.push(certPaths.signingKey);
    }
    if (certPaths.partnerCert) {
      setClauses.push(`partner_cert_path = $${idx++}`);
      params.push(certPaths.partnerCert);
    }

    // mTLS cert paths: prefer newly uploaded content, else accept a direct path
    const newClientCert = certPaths.clientCert || clientCertPath;
    const newClientKey = certPaths.clientKey || clientKeyPath;
    const newClientCa = certPaths.clientCa || clientCaPath;
    if (newClientCert !== undefined) {
      setClauses.push(`client_cert_path = $${idx++}`);
      params.push(newClientCert);
    }
    if (newClientKey !== undefined) {
      setClauses.push(`client_key_path = $${idx++}`);
      params.push(newClientKey);
    }
    if (newClientCa !== undefined) {
      setClauses.push(`client_ca_path = $${idx++}`);
      params.push(newClientCa);
    }

    if (!setClauses.length) throw new Error('No fields to update');

    setClauses.push(`updated_at = NOW()`);
    params.push(partnerId);

    const result = await pool.query(
      `UPDATE as2_partners SET ${setClauses.join(', ')} WHERE partner_id = $${idx} RETURNING *`,
      params
    );

    return AS2Partners._redactRow(result.rows[0]);
  }

  /**
   * Get a partner by ID (with cert paths redacted).
   */
  static async getPartner(partnerId) {
    const result = await pool.query(
      'SELECT * FROM as2_partners WHERE partner_id = $1', [partnerId]
    );
    return result.rows[0] ? AS2Partners._redactRow(result.rows[0]) : null;
  }

  /**
   * Get a partner's raw config (with cert paths) for AS2 transmission.
   * Internal use only — not exposed via API.
   */
  static async getPartnerConfig(partnerId) {
    const result = await pool.query(
      'SELECT * FROM as2_partners WHERE partner_id = $1 AND active = TRUE', [partnerId]
    );
    if (!result.rows.length) return null;

    const row = result.rows[0];
    return AS2Partners._buildConfig(row);
  }

  /**
   * Get the default partner's config. Falls back to first active partner.
   */
  static async getDefaultPartnerConfig() {
    let result = await pool.query(
      'SELECT * FROM as2_partners WHERE is_default = TRUE AND active = TRUE LIMIT 1'
    );
    if (!result.rows.length) {
      result = await pool.query(
        'SELECT * FROM as2_partners WHERE active = TRUE ORDER BY created_at ASC LIMIT 1'
      );
    }
    if (!result.rows.length) return null;

    return AS2Partners._buildConfig(result.rows[0]);
  }

  /**
   * List all partners (with cert paths redacted).
   */
  static async listPartners(opts = {}) {
    const { activeOnly = false } = opts;
    let sql = 'SELECT * FROM as2_partners';
    const params = [];
    if (activeOnly) {
      sql += ' WHERE active = TRUE';
    }
    sql += ' ORDER BY is_default DESC, created_at ASC';
    const result = await pool.query(sql, params);
    return result.rows.map(AS2Partners._redactRow);
  }

  /**
   * Deactivate a partner (soft delete).
   */
  static async deactivate(partnerId) {
    const result = await pool.query(
      `UPDATE as2_partners SET active = FALSE, updated_at = NOW()
       WHERE partner_id = $1 RETURNING *`,
      [partnerId]
    );
    if (!result.rows.length) throw new Error(`Partner not found: ${partnerId}`);
    return AS2Partners._redactRow(result.rows[0]);
  }

  /**
   * Reactivate a partner.
   */
  static async activate(partnerId) {
    const result = await pool.query(
      `UPDATE as2_partners SET active = TRUE, updated_at = NOW()
       WHERE partner_id = $1 RETURNING *`,
      [partnerId]
    );
    if (!result.rows.length) throw new Error(`Partner not found: ${partnerId}`);
    return AS2Partners._redactRow(result.rows[0]);
  }

  /**
   * Validate a partner's configuration is complete for transmission.
   */
  static async validatePartner(partnerId) {
    const result = await pool.query(
      'SELECT * FROM as2_partners WHERE partner_id = $1', [partnerId]
    );
    if (!result.rows.length) throw new Error(`Partner not found: ${partnerId}`);

    const row = result.rows[0];
    const issues = [];
    const proto = row.protocol || 'as2';

    if (!row.active) issues.push('Partner is deactivated');

    if (proto === 'as2') {
      if (!row.partner_url) issues.push('Partner URL not set');
      if (!row.partner_as2_id) issues.push('Partner AS2 ID not set');
      if (!row.signing_cert_path || !fs.existsSync(row.signing_cert_path)) {
        issues.push('Signing certificate not found — upload or generate one');
      }
      if (!row.signing_key_path || !fs.existsSync(row.signing_key_path)) {
        issues.push('Signing private key not found — upload or generate one');
      }
      if (!row.partner_cert_path || !fs.existsSync(row.partner_cert_path)) {
        issues.push('Partner certificate not found — upload partner certificate');
      }
    } else if (proto === 'rest_api') {
      const baseUrl = row.api_base_url || row.partner_url || '';
      const mode = (!baseUrl || baseUrl === 'direct' || baseUrl === 'local') ? 'direct'
        : baseUrl.startsWith('sftp://') ? 'sftp' : 'remote';
      // Direct/empty URL partners auto-upgrade to remote via platform HTTPS — no URL validation needed
      if (mode === 'remote' && !row.api_key) issues.push('API key not set — required for remote REST API');
      if (mode === 'sftp' && !row.api_key && !row.api_secret) issues.push('SFTP credentials not set (use apiKey for password or apiSecret for key path)');
    }

    return {
      partner_id: partnerId,
      partner_name: row.partner_name,
      protocol: proto,
      ready: issues.length === 0,
      issues,
    };
  }

  /**
   * Generate a self-signed certificate pair for a specific partner.
   */
  static async generateCert(partnerId, opts = {}) {
    const partner = await pool.query(
      'SELECT partner_id FROM as2_partners WHERE partner_id = $1', [partnerId]
    );
    if (!partner.rows.length) throw new Error(`Partner not found: ${partnerId}`);

    const { commonName = `DLB Trust AS2 - ${partnerId}` } = opts;
    const dir = AS2Partners.ensureCertsDir(partnerId);

    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const certPath = path.join(dir, 'signing-cert.pem');
    const keyPath = path.join(dir, 'signing-key.pem');

    fs.writeFileSync(certPath, publicKey, 'utf8');
    fs.chmodSync(certPath, 0o600);
    fs.writeFileSync(keyPath, privateKey, 'utf8');
    fs.chmodSync(keyPath, 0o600);

    await pool.query(
      `UPDATE as2_partners SET signing_cert_path = $1, signing_key_path = $2, updated_at = NOW()
       WHERE partner_id = $3`,
      [certPath, keyPath, partnerId]
    );

    return {
      partner_id: partnerId,
      cert_generated: true,
      common_name: commonName,
      fingerprint: crypto.createHash('sha256').update(publicKey).digest('hex').substring(0, 40),
    };
  }

  /**
   * Migrate existing as2_config table data into as2_partners as the default partner.
   * Called once on startup if as2_config exists but as2_partners is empty.
   */
  static async migrateFromLegacyConfig() {
    try {
      const tableCheck = await pool.query(
        `SELECT EXISTS (
          SELECT FROM information_schema.tables WHERE table_name = 'as2_config'
        ) as exists`
      );
      if (!tableCheck.rows[0].exists) return null;

      const partnersCheck = await pool.query('SELECT COUNT(*) as count FROM as2_partners');
      if (parseInt(partnersCheck.rows[0].count, 10) > 0) return null;

      const configRows = await pool.query('SELECT config_key, config_value FROM as2_config');
      if (!configRows.rows.length) return null;

      const config = {};
      for (const row of configRows.rows) {
        config[row.config_key] = row.config_value;
      }

      if (!config.partner_url) return null;

      await pool.query(
        `INSERT INTO as2_partners
          (partner_id, partner_name, partner_url, partner_as2_id, local_as2_id,
           signing_cert_path, signing_key_path, partner_cert_path,
           encryption_alg, signing_alg, request_mdn, mdn_url,
           is_default, active, notes, name, as2_identifier)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, TRUE, TRUE, $13, $14, $15)
         ON CONFLICT (partner_id) DO NOTHING`,
        [
          'LEGACY-DEFAULT',
          'Default Partner (migrated from as2_config)',
          config.partner_url,
          config.partner_as2_id || 'BANK-AS2-ID',
          config.local_as2_id || 'DLBTRUST-AS2',
          config.signing_cert_path || null,
          config.signing_key_path || null,
          config.partner_cert_path || null,
          config.encryption_alg || 'aes256-cbc',
          config.signing_alg || 'sha256',
          config.request_mdn !== 'false',
          config.mdn_url || null,
          'Auto-migrated from single-partner as2_config table',
          'Default Partner (migrated from as2_config)',
          config.partner_as2_id || 'LEGACY-DEFAULT',
        ]
      );

      console.log('[AS2Partners] Migrated legacy as2_config → as2_partners (LEGACY-DEFAULT)');
      return 'LEGACY-DEFAULT';
    } catch (err) {
      console.warn('[AS2Partners] Legacy migration skipped:', err.message);
      return null;
    }
  }

  /**
   * Write certificate PEM content to disk for a partner.
   * @private
   */
  static _writeCerts(partnerId, certs) {
    const paths = {};
    if (!certs.signingCert && !certs.signingKey && !certs.partnerCert &&
        !certs.clientCert && !certs.clientKey && !certs.clientCa) return paths;

    const dir = AS2Partners.ensureCertsDir(partnerId);

    if (certs.signingCert) {
      paths.signingCert = path.join(dir, 'signing-cert.pem');
      fs.writeFileSync(paths.signingCert, certs.signingCert, 'utf8');
      fs.chmodSync(paths.signingCert, 0o600);
    }
    if (certs.signingKey) {
      paths.signingKey = path.join(dir, 'signing-key.pem');
      fs.writeFileSync(paths.signingKey, certs.signingKey, 'utf8');
      fs.chmodSync(paths.signingKey, 0o600);
    }
    if (certs.partnerCert) {
      paths.partnerCert = path.join(dir, 'partner-cert.pem');
      fs.writeFileSync(paths.partnerCert, certs.partnerCert, 'utf8');
      fs.chmodSync(paths.partnerCert, 0o600);
    }
    // mTLS client credentials (presented during the TLS handshake)
    if (certs.clientCert) {
      paths.clientCert = path.join(dir, 'client-cert.pem');
      fs.writeFileSync(paths.clientCert, certs.clientCert, 'utf8');
      fs.chmodSync(paths.clientCert, 0o600);
    }
    if (certs.clientKey) {
      paths.clientKey = path.join(dir, 'client-key.pem');
      fs.writeFileSync(paths.clientKey, certs.clientKey, 'utf8');
      fs.chmodSync(paths.clientKey, 0o600);
    }
    if (certs.clientCa) {
      paths.clientCa = path.join(dir, 'client-ca.pem');
      fs.writeFileSync(paths.clientCa, certs.clientCa, 'utf8');
      fs.chmodSync(paths.clientCa, 0o600);
    }
    return paths;
  }

  /**
   * Redact sensitive paths from a partner row for API responses.
   * @private
   */
  /**
   * Build internal config object from a DB row.
   * @private
   */
  static _buildConfig(row) {
    return {
      partnerId: row.partner_id,
      partnerName: row.partner_name,
      protocol: row.protocol || 'as2',
      partnerUrl: row.partner_url,
      partnerAs2Id: row.partner_as2_id,
      localAs2Id: row.local_as2_id,
      signingCertPath: row.signing_cert_path,
      signingKeyPath: row.signing_key_path,
      partnerCertPath: row.partner_cert_path,
      encryptionAlg: row.encryption_alg,
      signingAlg: row.signing_alg,
      requestMdn: row.request_mdn,
      mdnUrl: row.mdn_url,
      apiBaseUrl: row.api_base_url,
      apiKey: row.api_key,
      apiSecret: row.api_secret,
      apiAuthType: row.api_auth_type,
      webhookSecret: row.webhook_secret,
      useMtls: row.use_mtls === true,
      clientCertPath: row.client_cert_path,
      clientKeyPath: row.client_key_path,
      clientCaPath: row.client_ca_path,
      clientKeyPassphrase: row.client_key_passphrase,
    };
  }

  static _redactRow(row) {
    if (!row) return null;
    const redacted = {
      partner_id: row.partner_id,
      partner_name: row.partner_name,
      protocol: row.protocol || 'as2',
      partner_url: row.partner_url,
      partner_as2_id: row.partner_as2_id,
      local_as2_id: row.local_as2_id,
      has_signing_cert: !!(row.signing_cert_path && fs.existsSync(row.signing_cert_path)),
      has_signing_key: !!(row.signing_key_path && fs.existsSync(row.signing_key_path)),
      has_partner_cert: !!(row.partner_cert_path && fs.existsSync(row.partner_cert_path)),
      // mTLS status booleans only — never expose key/cert material or paths
      use_mtls: row.use_mtls === true,
      has_client_cert: !!(row.client_cert_path && fs.existsSync(row.client_cert_path)),
      has_client_key: !!(row.client_key_path && fs.existsSync(row.client_key_path)),
      has_client_ca: !!(row.client_ca_path && fs.existsSync(row.client_ca_path)),
      encryption_alg: row.encryption_alg,
      signing_alg: row.signing_alg,
      request_mdn: row.request_mdn,
      mdn_url: row.mdn_url,
      is_default: row.is_default,
      active: row.active,
      notes: row.notes,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    if ((row.protocol || 'as2') === 'rest_api') {
      redacted.api_base_url = row.api_base_url;
      redacted.has_api_key = !!row.api_key;
      redacted.has_api_secret = !!row.api_secret;
      redacted.api_auth_type = row.api_auth_type;
      redacted.has_webhook_secret = !!row.webhook_secret;
    }
    return redacted;
  }
}

module.exports = { AS2Partners };
