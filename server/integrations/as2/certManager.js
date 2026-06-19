'use strict';

/**
 * AS2 Certificate Manager
 *
 * Generates and manages X.509 certificates and RSA keypairs for AS2 messaging.
 * Stores certificates in PostgreSQL and on the filesystem.
 * Uses Node.js built-in crypto — no external dependencies.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const pool = require('../bonds/pgPool');

const CERTS_DIR = process.env.AS2_CERTS_DIR || path.join(__dirname, '..', '..', '..', 'data', 'as2-certs');

class CertManager {
  static ensureCertsDir() {
    if (!fs.existsSync(CERTS_DIR)) {
      fs.mkdirSync(CERTS_DIR, { recursive: true });
    }
  }

  /**
   * Generate an RSA keypair and self-signed X.509 certificate.
   * Uses openssl CLI (available on all Linux/Mac systems).
   *
   * @param {Object} opts
   * @param {string} opts.commonName — CN for the certificate (e.g. "DLBTRUST-AS2")
   * @param {string} opts.organization — O field (e.g. "DEANDREA LAVAR BARKLEY TRUST")
   * @param {string} opts.country — C field (default: "US")
   * @param {number} opts.keySize — RSA key size (default: 2048)
   * @param {number} opts.validDays — certificate validity in days (default: 3650 = 10 years)
   * @param {string} opts.alias — friendly name for this keypair
   * @returns {Object} { alias, privateKeyPath, certificatePath, fingerprint, subject, validFrom, validTo }
   */
  static async generateKeypair(opts = {}) {
    CertManager.ensureCertsDir();

    const alias = opts.alias || 'dlbtrust-as2-' + Date.now();
    const cn = opts.commonName || 'DLBTRUST-AS2';
    const org = opts.organization || 'DEANDREA LAVAR BARKLEY TRUST';
    const country = opts.country || 'US';
    const keySize = opts.keySize || 2048;
    const validDays = opts.validDays || 3650;

    const keyPath = path.join(CERTS_DIR, `${alias}.key`);
    const certPath = path.join(CERTS_DIR, `${alias}.pem`);
    const subject = `/C=${country}/O=${org}/CN=${cn}`;

    // Generate private key
    execSync(
      `openssl genrsa -out "${keyPath}" ${keySize} 2>/dev/null`,
      { timeout: 30000 }
    );

    // Generate self-signed certificate
    execSync(
      `openssl req -new -x509 -key "${keyPath}" -out "${certPath}" -days ${validDays} -subj "${subject}" 2>/dev/null`,
      { timeout: 30000 }
    );

    // Read fingerprint
    const fingerprint = execSync(
      `openssl x509 -in "${certPath}" -noout -fingerprint -sha256 2>/dev/null`,
      { encoding: 'utf8', timeout: 10000 }
    ).trim().replace('sha256 Fingerprint=', '').replace('SHA256 Fingerprint=', '');

    // Read validity dates
    const dates = execSync(
      `openssl x509 -in "${certPath}" -noout -startdate -enddate 2>/dev/null`,
      { encoding: 'utf8', timeout: 10000 }
    ).trim();

    const notBefore = dates.match(/notBefore=(.*)/)?.[1] || '';
    const notAfter = dates.match(/notAfter=(.*)/)?.[1] || '';

    const certPem = fs.readFileSync(certPath, 'utf8');

    // Store in database
    await pool.query(
      `INSERT INTO as2_certificates
        (alias, cert_type, subject_cn, subject_org, country, key_size,
         fingerprint_sha256, certificate_pem, private_key_path, certificate_path,
         valid_from, valid_to, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
       ON CONFLICT (alias) DO UPDATE SET
         certificate_pem = EXCLUDED.certificate_pem,
         fingerprint_sha256 = EXCLUDED.fingerprint_sha256,
         private_key_path = EXCLUDED.private_key_path,
         certificate_path = EXCLUDED.certificate_path,
         valid_from = EXCLUDED.valid_from,
         valid_to = EXCLUDED.valid_to,
         updated_at = NOW()
       RETURNING *`,
      [alias, 'local', cn, org, country, keySize,
       fingerprint, certPem, keyPath, certPath,
       notBefore ? new Date(notBefore) : new Date(),
       notAfter ? new Date(notAfter) : new Date(Date.now() + validDays * 86400000),
       'active']
    );

    // Set restrictive permissions on private key
    try { fs.chmodSync(keyPath, 0o600); } catch (_) {}

    return {
      alias,
      private_key_path: keyPath,
      certificate_path: certPath,
      fingerprint,
      subject,
      valid_from: notBefore,
      valid_to: notAfter,
    };
  }

  /**
   * Import a partner's public certificate.
   */
  static async importPartnerCert(alias, certPem) {
    CertManager.ensureCertsDir();

    const certPath = path.join(CERTS_DIR, `${alias}.pem`);
    fs.writeFileSync(certPath, certPem);

    // Extract info from certificate
    let fingerprint = '', cn = '', org = '', notBefore = '', notAfter = '';
    try {
      fingerprint = execSync(
        `openssl x509 -in "${certPath}" -noout -fingerprint -sha256 2>/dev/null`,
        { encoding: 'utf8', timeout: 10000 }
      ).trim().replace(/.*Fingerprint=/, '');

      const subjectStr = execSync(
        `openssl x509 -in "${certPath}" -noout -subject 2>/dev/null`,
        { encoding: 'utf8', timeout: 10000 }
      ).trim();
      cn = subjectStr.match(/CN\s*=\s*([^/,]+)/)?.[1]?.trim() || alias;
      org = subjectStr.match(/O\s*=\s*([^/,]+)/)?.[1]?.trim() || '';

      const dates = execSync(
        `openssl x509 -in "${certPath}" -noout -startdate -enddate 2>/dev/null`,
        { encoding: 'utf8', timeout: 10000 }
      ).trim();
      notBefore = dates.match(/notBefore=(.*)/)?.[1] || '';
      notAfter = dates.match(/notAfter=(.*)/)?.[1] || '';
    } catch (_) {}

    await pool.query(
      `INSERT INTO as2_certificates
        (alias, cert_type, subject_cn, subject_org, fingerprint_sha256,
         certificate_pem, certificate_path, valid_from, valid_to, status, created_at)
       VALUES ($1, 'partner', $2, $3, $4, $5, $6, $7, $8, 'active', NOW())
       ON CONFLICT (alias) DO UPDATE SET
         certificate_pem = EXCLUDED.certificate_pem,
         fingerprint_sha256 = EXCLUDED.fingerprint_sha256,
         certificate_path = EXCLUDED.certificate_path,
         valid_from = EXCLUDED.valid_from,
         valid_to = EXCLUDED.valid_to,
         updated_at = NOW()
       RETURNING *`,
      [alias, cn, org, fingerprint, certPem, certPath,
       notBefore ? new Date(notBefore) : null,
       notAfter ? new Date(notAfter) : null]
    );

    return { alias, certificate_path: certPath, fingerprint, subject_cn: cn };
  }

  /**
   * List all certificates.
   */
  static async listCerts({ certType } = {}) {
    let sql = 'SELECT alias, cert_type, subject_cn, subject_org, fingerprint_sha256, key_size, certificate_path, private_key_path, valid_from, valid_to, status, created_at FROM as2_certificates';
    const params = [];
    if (certType) {
      sql += ' WHERE cert_type = $1';
      params.push(certType);
    }
    sql += ' ORDER BY created_at DESC';
    const result = await pool.query(sql, params);
    return result.rows;
  }

  /**
   * Get a specific certificate by alias.
   */
  static async getCert(alias) {
    const result = await pool.query(
      'SELECT * FROM as2_certificates WHERE alias = $1',
      [alias]
    );
    return result.rows[0] || null;
  }

  /**
   * Get the public certificate PEM for export (to give to trading partner).
   */
  static async exportPublicCert(alias) {
    const cert = await CertManager.getCert(alias);
    if (!cert) throw new Error(`Certificate not found: ${alias}`);
    return cert.certificate_pem;
  }

  /**
   * Revoke / deactivate a certificate.
   */
  static async revokeCert(alias) {
    const result = await pool.query(
      "UPDATE as2_certificates SET status = 'revoked', updated_at = NOW() WHERE alias = $1 RETURNING *",
      [alias]
    );
    if (!result.rows.length) throw new Error(`Certificate not found: ${alias}`);
    return result.rows[0];
  }

  /**
   * Load the local (our) signing key and certificate for outbound AS2.
   */
  static async getLocalSigningMaterial(alias) {
    const cert = await CertManager.getCert(alias);
    if (!cert) throw new Error(`Certificate not found: ${alias}`);
    if (cert.cert_type !== 'local') throw new Error('Not a local certificate');

    const privateKey = cert.private_key_path ? fs.readFileSync(cert.private_key_path, 'utf8') : null;
    const certificate = cert.certificate_pem;
    return { privateKey, certificate };
  }
}

module.exports = { CertManager };
