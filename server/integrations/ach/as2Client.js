'use strict';

/**
 * AS2 Client — Applicability Statement 2
 *
 * Transmits NACHA ACH files to the receiving bank's AS2 endpoint.
 * AS2 is the standard protocol used by financial institutions for
 * secure, reliable EDI file exchange over HTTP/S.
 *
 * Configuration via environment variables:
 *   AS2_PARTNER_URL       — bank's AS2 endpoint URL
 *   AS2_PARTNER_AS2_ID    — bank's AS2 identifier
 *   AS2_LOCAL_AS2_ID      — our AS2 identifier (DLB Trust)
 *   AS2_SIGNING_CERT      — path to our signing certificate (PEM)
 *   AS2_SIGNING_KEY       — path to our private key (PEM)
 *   AS2_PARTNER_CERT      — path to partner's public certificate (PEM)
 *   AS2_ENCRYPTION_ALG    — encryption algorithm (default: aes256-cbc)
 *   AS2_SIGNING_ALG       — signing algorithm (default: sha256)
 *   AS2_REQUEST_MDN       — request MDN receipt (default: true)
 *   AS2_MDN_URL           — URL for async MDN (optional)
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const AS2_CONFIG = {
  partnerUrl:      process.env.AS2_PARTNER_URL || '',
  partnerAs2Id:    process.env.AS2_PARTNER_AS2_ID || 'BANK-AS2-ID',
  localAs2Id:      process.env.AS2_LOCAL_AS2_ID || 'DLBTRUST-AS2',
  signingCertPath: process.env.AS2_SIGNING_CERT || '',
  signingKeyPath:  process.env.AS2_SIGNING_KEY || '',
  partnerCertPath: process.env.AS2_PARTNER_CERT || '',
  encryptionAlg:   process.env.AS2_ENCRYPTION_ALG || 'aes256-cbc',
  signingAlg:      process.env.AS2_SIGNING_ALG || 'sha256',
  requestMdn:      process.env.AS2_REQUEST_MDN !== 'false',
  mdnUrl:          process.env.AS2_MDN_URL || '',
};

function loadCert(certPath) {
  if (!certPath) return null;
  try {
    return fs.readFileSync(certPath, 'utf8');
  } catch (e) {
    console.warn('[AS2] Cannot load cert:', certPath, e.message);
    return null;
  }
}

function generateMessageId() {
  const rand = crypto.randomBytes(12).toString('hex');
  return `<${rand}@dlbtrust-app.fly.dev>`;
}

class AS2Client {
  /**
   * Reload AS2 configuration from current process.env values.
   * Must be called after updating env vars at runtime (e.g. via AS2Setup.saveConfig).
   */
  static reloadConfig() {
    AS2_CONFIG.partnerUrl      = process.env.AS2_PARTNER_URL || '';
    AS2_CONFIG.partnerAs2Id    = process.env.AS2_PARTNER_AS2_ID || 'BANK-AS2-ID';
    AS2_CONFIG.localAs2Id      = process.env.AS2_LOCAL_AS2_ID || 'DLBTRUST-AS2';
    AS2_CONFIG.signingCertPath = process.env.AS2_SIGNING_CERT || '';
    AS2_CONFIG.signingKeyPath  = process.env.AS2_SIGNING_KEY || '';
    AS2_CONFIG.partnerCertPath = process.env.AS2_PARTNER_CERT || '';
    AS2_CONFIG.encryptionAlg   = process.env.AS2_ENCRYPTION_ALG || 'aes256-cbc';
    AS2_CONFIG.signingAlg      = process.env.AS2_SIGNING_ALG || 'sha256';
    AS2_CONFIG.requestMdn      = process.env.AS2_REQUEST_MDN !== 'false';
    AS2_CONFIG.mdnUrl          = process.env.AS2_MDN_URL || '';
  }

  /**
   * Get current AS2 configuration status.
   */
  static getConfigStatus() {
    return {
      configured: !!(AS2_CONFIG.partnerUrl && AS2_CONFIG.partnerAs2Id),
      partner_url: AS2_CONFIG.partnerUrl || '(not set)',
      partner_as2_id: AS2_CONFIG.partnerAs2Id,
      local_as2_id: AS2_CONFIG.localAs2Id,
      has_signing_cert: !!AS2_CONFIG.signingCertPath && fs.existsSync(AS2_CONFIG.signingCertPath),
      has_signing_key: !!AS2_CONFIG.signingKeyPath && fs.existsSync(AS2_CONFIG.signingKeyPath),
      has_partner_cert: !!AS2_CONFIG.partnerCertPath && fs.existsSync(AS2_CONFIG.partnerCertPath),
      encryption_alg: AS2_CONFIG.encryptionAlg,
      signing_alg: AS2_CONFIG.signingAlg,
      request_mdn: AS2_CONFIG.requestMdn,
    };
  }

  /**
   * Sign the NACHA file content using our private key.
   * Returns a detached PKCS#7 signature (base64).
   * @param {string} content
   * @param {Object} [config] - partner-specific config; falls back to global AS2_CONFIG
   */
  static signPayload(content, config) {
    const cfg = config || AS2_CONFIG;
    const key = loadCert(cfg.signingKeyPath);
    if (!key) return null;

    const sign = crypto.createSign(cfg.signingAlg || 'sha256');
    sign.update(content);
    return sign.sign(key, 'base64');
  }

  /**
   * Build the MIME multipart body for AS2 transmission.
   * Includes the NACHA file as application/octet-stream with
   * optional S/MIME signing.
   * @param {string} nachaContent
   * @param {string} filename
   * @param {Object} [config] - partner-specific config; falls back to global AS2_CONFIG
   */
  static buildAS2Body(nachaContent, filename, config) {
    const cfg = config || AS2_CONFIG;
    const boundary = 'AS2-BOUNDARY-' + crypto.randomBytes(8).toString('hex');
    const messageId = generateMessageId();
    const signature = AS2Client.signPayload(nachaContent, cfg);

    let body = '';
    body += `--${boundary}\r\n`;
    body += `Content-Type: application/octet-stream; name="${filename}"\r\n`;
    body += `Content-Transfer-Encoding: binary\r\n`;
    body += `Content-Disposition: attachment; filename="${filename}"\r\n`;
    body += `\r\n`;
    body += nachaContent;
    body += `\r\n`;

    if (signature) {
      body += `--${boundary}\r\n`;
      body += `Content-Type: application/pkcs7-signature; name="smime.p7s"\r\n`;
      body += `Content-Transfer-Encoding: base64\r\n`;
      body += `Content-Disposition: attachment; filename="smime.p7s"\r\n`;
      body += `\r\n`;
      body += signature + '\r\n';
    }

    body += `--${boundary}--\r\n`;

    const contentType = signature
      ? `multipart/signed; protocol="application/pkcs7-signature"; micalg=${cfg.signingAlg || 'sha256'}; boundary="${boundary}"`
      : `application/octet-stream; name="${filename}"`;

    return { body: signature ? body : nachaContent, contentType, messageId, boundary };
  }

  /**
   * Transmit a NACHA file to an AS2 endpoint.
   *
   * @param {string} nachaContent — the NACHA file string
   * @param {string} filename — the filename (e.g. "ACH-2026-06-19-001.ach")
   * @param {Object} [partnerConfig] — partner-specific config from AS2Partners.getPartnerConfig();
   *                                   if omitted, uses global AS2_CONFIG (legacy single-partner mode)
   * @returns {Promise<Object>} transmission result
   */
  static async transmit(nachaContent, filename, partnerConfig) {
    const cfg = partnerConfig || AS2_CONFIG;
    if (!cfg.partnerUrl) {
      throw new Error('AS2 partner URL not configured. Register a partner or set AS2_PARTNER_URL.');
    }

    const { body, contentType, messageId } = AS2Client.buildAS2Body(nachaContent, filename, cfg);
    const parsed = new URL(cfg.partnerUrl);

    const headers = {
      'Content-Type': contentType,
      'Content-Length': Buffer.byteLength(body),
      'AS2-From': cfg.localAs2Id || 'DLBTRUST-AS2',
      'AS2-To': cfg.partnerAs2Id,
      'AS2-Version': '1.2',
      'Message-ID': messageId,
      'Subject': filename,
      'MIME-Version': '1.0',
      'Date': new Date().toUTCString(),
    };

    if (cfg.requestMdn !== false) {
      headers['Disposition-Notification-To'] = cfg.mdnUrl || cfg.partnerUrl;
      headers['Disposition-Notification-Options'] =
        `signed-receipt-protocol=required, pkcs7-signature; signed-receipt-micalg=required, ${cfg.signingAlg || 'sha256'}`;
    }

    return new Promise((resolve, reject) => {
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + (parsed.search || ''),
        method: 'POST',
        headers,
        rejectUnauthorized: true,
      };

      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          const result = {
            success: res.statusCode >= 200 && res.statusCode < 300,
            status_code: res.statusCode,
            message_id: messageId,
            filename,
            response_headers: res.headers,
            mdn_received: !!(res.headers['content-type'] && res.headers['content-type'].includes('disposition-notification')),
            response_body: data.substring(0, 500),
            transmitted_at: new Date().toISOString(),
          };
          resolve(result);
        });
      });

      req.on('error', (err) => {
        reject(new Error(`AS2 transmission failed: ${err.message}`));
      });

      req.setTimeout(60000, () => {
        req.destroy(new Error('AS2 transmission timed out after 60s'));
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Test connectivity to an AS2 partner endpoint (HEAD request).
   * @param {Object} [partnerConfig] — partner config; if omitted, uses global AS2_CONFIG
   */
  static async testConnection(partnerConfig) {
    const cfg = partnerConfig || AS2_CONFIG;
    if (!cfg.partnerUrl) {
      return { connected: false, error: 'Partner URL not configured' };
    }

    const parsed = new URL(cfg.partnerUrl);
    return new Promise((resolve) => {
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname,
        method: 'HEAD',
        timeout: 10000,
        rejectUnauthorized: false,
      }, (res) => {
        resolve({
          connected: true,
          status_code: res.statusCode,
          partner_url: cfg.partnerUrl,
          partner_as2_id: cfg.partnerAs2Id,
          partner_id: cfg.partnerId || null,
        });
      });

      req.on('error', (err) => {
        resolve({ connected: false, error: err.message });
      });

      req.setTimeout(10000, () => {
        req.destroy();
        resolve({ connected: false, error: 'Connection timed out' });
      });

      req.end();
    });
  }
}

module.exports = { AS2Client };
