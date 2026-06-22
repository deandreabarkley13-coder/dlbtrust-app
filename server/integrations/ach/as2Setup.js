'use strict';

/**
 * AS2 Credential & Certificate Setup — DLB Trust Platform
 *
 * Manages AS2 partner configuration for ACH file transmission.
 * Stores connection details in the database and writes certificates
 * to disk so the AS2 client can use them at runtime.
 *
 * All setup operations require admin authentication.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pool = require('../bonds/pgPool');

const CERTS_DIR = path.join(__dirname, '..', '..', '..', 'data', 'as2-certs');

class AS2Setup {

  /**
   * Ensure the certificates directory exists.
   */
  static ensureCertsDir() {
    if (!fs.existsSync(CERTS_DIR)) {
      fs.mkdirSync(CERTS_DIR, { recursive: true });
    }
    return CERTS_DIR;
  }

  /**
   * Save or update AS2 partner configuration.
   * Persists to DB and writes certs to disk, then updates env vars for the running process.
   *
   * @param {Object} config
   * @param {string} config.partnerUrl - Bank's AS2 endpoint URL
   * @param {string} config.partnerAs2Id - Bank's AS2 identifier
   * @param {string} config.localAs2Id - Our AS2 identifier (default: DLBTRUST-AS2)
   * @param {string} config.signingCert - PEM content of our signing certificate
   * @param {string} config.signingKey - PEM content of our private key
   * @param {string} config.partnerCert - PEM content of bank's public certificate
   * @param {string} config.encryptionAlg - Encryption algorithm (default: aes256-cbc)
   * @param {string} config.signingAlg - Signing algorithm (default: sha256)
   * @param {boolean} config.requestMdn - Request MDN receipt (default: true)
   * @param {string} config.mdnUrl - URL for async MDN callbacks
   */
  static async saveConfig(config) {
    const {
      partnerUrl, partnerAs2Id, localAs2Id,
      signingCert, signingKey, partnerCert,
      encryptionAlg, signingAlg, requestMdn, mdnUrl,
    } = config;

    if (!partnerUrl) throw new Error('partnerUrl is required');
    if (!partnerAs2Id) throw new Error('partnerAs2Id is required');

    AS2Setup.ensureCertsDir();

    // Write certificates to disk if provided
    const certPaths = {};
    if (signingCert) {
      certPaths.signingCert = path.join(CERTS_DIR, 'signing-cert.pem');
      fs.writeFileSync(certPaths.signingCert, signingCert, 'utf8');
      fs.chmodSync(certPaths.signingCert, 0o600);
    }
    if (signingKey) {
      certPaths.signingKey = path.join(CERTS_DIR, 'signing-key.pem');
      fs.writeFileSync(certPaths.signingKey, signingKey, 'utf8');
      fs.chmodSync(certPaths.signingKey, 0o600);
    }
    if (partnerCert) {
      certPaths.partnerCert = path.join(CERTS_DIR, 'partner-cert.pem');
      fs.writeFileSync(certPaths.partnerCert, partnerCert, 'utf8');
      fs.chmodSync(certPaths.partnerCert, 0o600);
    }

    // Persist config to database
    await pool.query(
      `CREATE TABLE IF NOT EXISTS as2_config (
        id            SERIAL PRIMARY KEY,
        config_key    TEXT UNIQUE NOT NULL,
        config_value  TEXT,
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )`
    );

    const entries = [
      ['partner_url', partnerUrl],
      ['partner_as2_id', partnerAs2Id],
      ['local_as2_id', localAs2Id || 'DLBTRUST-AS2'],
      ['signing_cert_path', certPaths.signingCert || ''],
      ['signing_key_path', certPaths.signingKey || ''],
      ['partner_cert_path', certPaths.partnerCert || ''],
      ['encryption_alg', encryptionAlg || 'aes256-cbc'],
      ['signing_alg', signingAlg || 'sha256'],
      ['request_mdn', requestMdn !== false ? 'true' : 'false'],
      ['mdn_url', mdnUrl || ''],
    ];

    for (const [key, value] of entries) {
      await pool.query(
        `INSERT INTO as2_config (config_key, config_value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (config_key) DO UPDATE SET config_value = $2, updated_at = NOW()`,
        [key, value]
      );
    }

    // Update environment variables for the running process
    process.env.AS2_PARTNER_URL = partnerUrl;
    process.env.AS2_PARTNER_AS2_ID = partnerAs2Id;
    process.env.AS2_LOCAL_AS2_ID = localAs2Id || 'DLBTRUST-AS2';
    if (certPaths.signingCert) process.env.AS2_SIGNING_CERT = certPaths.signingCert;
    if (certPaths.signingKey) process.env.AS2_SIGNING_KEY = certPaths.signingKey;
    if (certPaths.partnerCert) process.env.AS2_PARTNER_CERT = certPaths.partnerCert;
    process.env.AS2_ENCRYPTION_ALG = encryptionAlg || 'aes256-cbc';
    process.env.AS2_SIGNING_ALG = signingAlg || 'sha256';
    process.env.AS2_REQUEST_MDN = requestMdn !== false ? 'true' : 'false';
    if (mdnUrl) process.env.AS2_MDN_URL = mdnUrl;

    return {
      partner_url: partnerUrl,
      partner_as2_id: partnerAs2Id,
      local_as2_id: localAs2Id || 'DLBTRUST-AS2',
      has_signing_cert: !!signingCert || !!certPaths.signingCert,
      has_signing_key: !!signingKey || !!certPaths.signingKey,
      has_partner_cert: !!partnerCert || !!certPaths.partnerCert,
      encryption_alg: encryptionAlg || 'aes256-cbc',
      signing_alg: signingAlg || 'sha256',
      request_mdn: requestMdn !== false,
      mdn_url: mdnUrl || '',
      certs_dir: CERTS_DIR,
    };
  }

  /**
   * Load saved AS2 configuration from the database and apply to environment.
   * Called on server startup to restore previously saved config.
   */
  static async loadSavedConfig() {
    try {
      const tableCheck = await pool.query(
        `SELECT EXISTS (
          SELECT FROM information_schema.tables WHERE table_name = 'as2_config'
        ) as exists`
      );
      if (!tableCheck.rows[0].exists) return null;

      const result = await pool.query('SELECT config_key, config_value FROM as2_config');
      if (!result.rows.length) return null;

      const config = {};
      for (const row of result.rows) {
        config[row.config_key] = row.config_value;
      }

      // Apply to environment if not already set via env vars
      const envMap = {
        partner_url: 'AS2_PARTNER_URL',
        partner_as2_id: 'AS2_PARTNER_AS2_ID',
        local_as2_id: 'AS2_LOCAL_AS2_ID',
        signing_cert_path: 'AS2_SIGNING_CERT',
        signing_key_path: 'AS2_SIGNING_KEY',
        partner_cert_path: 'AS2_PARTNER_CERT',
        encryption_alg: 'AS2_ENCRYPTION_ALG',
        signing_alg: 'AS2_SIGNING_ALG',
        request_mdn: 'AS2_REQUEST_MDN',
        mdn_url: 'AS2_MDN_URL',
      };

      for (const [dbKey, envKey] of Object.entries(envMap)) {
        if (config[dbKey] && !process.env[envKey]) {
          process.env[envKey] = config[dbKey];
        }
      }

      return config;
    } catch (err) {
      console.warn('[AS2Setup] Could not load saved config:', err.message);
      return null;
    }
  }

  /**
   * Get current AS2 configuration (from DB, without exposing secrets).
   */
  static async getConfig() {
    try {
      const tableCheck = await pool.query(
        `SELECT EXISTS (
          SELECT FROM information_schema.tables WHERE table_name = 'as2_config'
        ) as exists`
      );
      if (!tableCheck.rows[0].exists) return { configured: false };

      const result = await pool.query('SELECT config_key, config_value, updated_at FROM as2_config');
      if (!result.rows.length) return { configured: false };

      const config = {};
      let lastUpdated = null;
      for (const row of result.rows) {
        // Don't expose file paths for private keys
        if (row.config_key === 'signing_key_path') {
          config.has_signing_key = !!row.config_value;
        } else if (row.config_key === 'signing_cert_path') {
          config.has_signing_cert = !!row.config_value;
        } else if (row.config_key === 'partner_cert_path') {
          config.has_partner_cert = !!row.config_value;
        } else {
          config[row.config_key] = row.config_value;
        }
        if (!lastUpdated || row.updated_at > lastUpdated) lastUpdated = row.updated_at;
      }

      config.configured = !!(config.partner_url && config.partner_as2_id);
      config.last_updated = lastUpdated;
      return config;
    } catch (err) {
      return { configured: false, error: err.message };
    }
  }

  /**
   * Generate a self-signed certificate pair for AS2 signing.
   * Useful for initial setup before getting a CA-signed cert.
   */
  static async generateSelfSignedCert(opts = {}) {
    const { commonName = 'DLB Trust AS2', orgName = 'DLB Trust', validDays = 365 } = opts;

    return new Promise((resolve, reject) => {
      const { generateKeyPairSync, createSign } = crypto;

      // Generate RSA key pair
      const { publicKey, privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      AS2Setup.ensureCertsDir();

      const certPath = path.join(CERTS_DIR, 'signing-cert.pem');
      const keyPath = path.join(CERTS_DIR, 'signing-key.pem');

      // For a proper self-signed X.509 cert we'd use openssl or a library.
      // For now, store the public key PEM as a placeholder cert and the private key.
      fs.writeFileSync(certPath, publicKey, 'utf8');
      fs.chmodSync(certPath, 0o600);
      fs.writeFileSync(keyPath, privateKey, 'utf8');
      fs.chmodSync(keyPath, 0o600);

      // Update env
      process.env.AS2_SIGNING_CERT = certPath;
      process.env.AS2_SIGNING_KEY = keyPath;

      // Persist paths to DB
      pool.query(
        `CREATE TABLE IF NOT EXISTS as2_config (
          id SERIAL PRIMARY KEY, config_key TEXT UNIQUE NOT NULL, config_value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW()
        )`
      ).then(() => Promise.all([
        pool.query(
          `INSERT INTO as2_config (config_key, config_value, updated_at) VALUES ('signing_cert_path', $1, NOW())
           ON CONFLICT (config_key) DO UPDATE SET config_value = $1, updated_at = NOW()`,
          [certPath]
        ),
        pool.query(
          `INSERT INTO as2_config (config_key, config_value, updated_at) VALUES ('signing_key_path', $1, NOW())
           ON CONFLICT (config_key) DO UPDATE SET config_value = $1, updated_at = NOW()`,
          [keyPath]
        ),
      ])).then(() => {
        resolve({
          cert_path: certPath,
          key_path: keyPath,
          common_name: commonName,
          valid_days: validDays,
          fingerprint: crypto.createHash('sha256').update(publicKey).digest('hex').substring(0, 40),
        });
      }).catch(reject);
    });
  }

  /**
   * Validate the current AS2 configuration is complete enough for transmission.
   */
  static validateConfig() {
    const issues = [];

    if (!process.env.AS2_PARTNER_URL) {
      issues.push('AS2_PARTNER_URL not set — configure bank AS2 endpoint');
    }
    if (!process.env.AS2_PARTNER_AS2_ID || process.env.AS2_PARTNER_AS2_ID === 'BANK-AS2-ID') {
      issues.push('AS2_PARTNER_AS2_ID not set — configure bank AS2 identifier');
    }
    if (!process.env.AS2_SIGNING_CERT || !fs.existsSync(process.env.AS2_SIGNING_CERT || '')) {
      issues.push('Signing certificate not found — upload or generate one');
    }
    if (!process.env.AS2_SIGNING_KEY || !fs.existsSync(process.env.AS2_SIGNING_KEY || '')) {
      issues.push('Signing private key not found — upload or generate one');
    }
    if (!process.env.AS2_PARTNER_CERT || !fs.existsSync(process.env.AS2_PARTNER_CERT || '')) {
      issues.push('Partner certificate not found — upload bank certificate');
    }

    return {
      ready: issues.length === 0,
      issues,
      config: {
        partner_url: process.env.AS2_PARTNER_URL || '(not set)',
        partner_as2_id: process.env.AS2_PARTNER_AS2_ID || '(not set)',
        local_as2_id: process.env.AS2_LOCAL_AS2_ID || 'DLBTRUST-AS2',
        has_signing_cert: !!(process.env.AS2_SIGNING_CERT && fs.existsSync(process.env.AS2_SIGNING_CERT)),
        has_signing_key: !!(process.env.AS2_SIGNING_KEY && fs.existsSync(process.env.AS2_SIGNING_KEY)),
        has_partner_cert: !!(process.env.AS2_PARTNER_CERT && fs.existsSync(process.env.AS2_PARTNER_CERT)),
      },
    };
  }
}

module.exports = { AS2Setup };
