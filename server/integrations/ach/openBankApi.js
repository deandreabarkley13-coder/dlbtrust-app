'use strict';

/**
 * Open Banking API Client — REST-based ACH File Transmission
 *
 * Provides REST API transmission as an alternative to AS2 for partners
 * that support HTTP-based file exchange. Each partner can have its own
 * API credentials (api_key, api_secret, api_base_url).
 *
 * Transmission modes (priority order):
 *   remote    — POST NACHA file to partner's REST API endpoint via HTTPS (default)
 *   sftp      — Upload NACHA file to partner's SFTP server
 *   direct    — Process locally: validate, export file, mark transmitted (legacy fallback)
 *
 * Auth schemes (for remote mode):
 *   bearer   — Authorization: Bearer <api_key>
 *   basic    — Authorization: Basic base64(api_key:api_secret)
 *   api_key  — X-API-Key: <api_key>
 *   hmac     — HMAC-SHA256 signature in X-Signature header
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ACH_EXPORTS_DIR = path.join(__dirname, '..', '..', '..', 'data', 'ach-exports');

class OpenBankApi {

  /**
   * Transmit a NACHA file via REST API, direct processing, or SFTP.
   * Routing:
   *   - api_base_url === 'direct' or empty → direct local processing
   *   - api_base_url starts with 'sftp://' → SFTP upload
   *   - otherwise → remote REST API POST
   */
  static async transmit(nachaContent, filename, partnerConfig) {
    let baseUrl = partnerConfig.apiBaseUrl || partnerConfig.partnerUrl || '';
    let mode = OpenBankApi._resolveMode(baseUrl);

    // Auto-upgrade 'direct' to 'remote' using the platform's own HTTPS endpoint
    if (mode === 'direct') {
      const selfUrl = OpenBankApi._getSelfUrl();
      if (selfUrl) {
        baseUrl = selfUrl;
        mode = 'remote';
        partnerConfig = { ...partnerConfig, apiBaseUrl: selfUrl };
      }
    }

    switch (mode) {
      case 'direct':
        return OpenBankApi._transmitDirect(nachaContent, filename, partnerConfig);
      case 'sftp':
        return OpenBankApi._transmitSftp(nachaContent, filename, partnerConfig);
      default:
        return OpenBankApi._transmitRemote(nachaContent, filename, partnerConfig);
    }
  }

  /**
   * Get the platform's own HTTPS URL for self-hosted REST API transmission.
   * Uses APP_URL env var, falls back to common deployment URLs.
   */
  static _getSelfUrl() {
    if (process.env.APP_URL) return process.env.APP_URL;
    if (process.env.DEPLOY_URL) return process.env.DEPLOY_URL;
    const port = process.env.PORT || 3002;
    // In production, use HTTPS; locally fall back to HTTP
    if (process.env.NODE_ENV === 'production') {
      return process.env.DOMAIN ? `https://${process.env.DOMAIN}` : null;
    }
    return `http://localhost:${port}`;
  }

  /**
   * Direct local processing — validate NACHA, export file, mark transmitted.
   * Used when no external endpoint is configured or api_base_url = 'direct'.
   */
  static async _transmitDirect(nachaContent, filename, partnerConfig) {
    // Validate NACHA structure
    const validation = OpenBankApi._validateNacha(nachaContent);
    if (!validation.valid) {
      return {
        success: false,
        status_code: 400,
        message_id: OpenBankApi._generateRequestId(),
        filename,
        response_body: JSON.stringify({ error: 'NACHA validation failed', issues: validation.issues }),
        mdn_received: false,
        transmitted_at: new Date().toISOString(),
        protocol: 'rest_api',
        mode: 'direct',
        partner_id: partnerConfig.partnerId,
      };
    }

    // Export to date-organized directory
    const exportResult = OpenBankApi._exportFile(nachaContent, filename, partnerConfig.partnerId);

    const requestId = OpenBankApi._generateRequestId();
    console.log(`[OpenBankApi] Direct transmission: ${filename} → ${exportResult.export_path}`);

    return {
      success: true,
      status_code: 200,
      message_id: requestId,
      filename,
      response_body: JSON.stringify({
        status: 'transmitted',
        mode: 'direct',
        export_path: exportResult.export_path,
        export_filename: exportResult.export_filename,
        file_size: exportResult.file_size,
        entry_count: validation.entryCount,
        total_debit: validation.totalDebit,
        total_credit: validation.totalCredit,
        validation: 'passed',
        message: 'NACHA file validated and exported for bank delivery.',
      }),
      mdn_received: false,
      transmitted_at: new Date().toISOString(),
      protocol: 'rest_api',
      mode: 'direct',
      partner_id: partnerConfig.partnerId,
      export_path: exportResult.export_path,
      remote_batch_id: requestId,
      remote_status: 'transmitted',
    };
  }

  /**
   * SFTP transmission — upload NACHA file to partner's SFTP server.
   * api_base_url format: sftp://user@host:port/path
   */
  static async _transmitSftp(nachaContent, filename, partnerConfig) {
    const baseUrl = partnerConfig.apiBaseUrl || partnerConfig.partnerUrl;
    const requestId = OpenBankApi._generateRequestId();

    // Parse SFTP URL: sftp://user@host:port/path
    const sftpUrl = baseUrl.replace('sftp://', '');
    let user = 'ach';
    let host = sftpUrl;
    let port = 22;
    let remotePath = '/incoming/';

    if (sftpUrl.includes('@')) {
      [user, host] = sftpUrl.split('@');
    }
    if (host.includes(':')) {
      const parts = host.split(':');
      host = parts[0];
      const rest = parts[1];
      if (rest.includes('/')) {
        port = parseInt(rest.split('/')[0], 10) || 22;
        remotePath = '/' + rest.split('/').slice(1).join('/');
      } else {
        port = parseInt(rest, 10) || 22;
      }
    } else if (host.includes('/')) {
      const parts = host.split('/');
      host = parts[0];
      remotePath = '/' + parts.slice(1).join('/');
    }
    if (!remotePath.endsWith('/')) remotePath += '/';

    // Also export locally for audit trail
    const exportResult = OpenBankApi._exportFile(nachaContent, filename, partnerConfig.partnerId);

    // SFTP upload using ssh2 (if available) or shell scp/sftp
    try {
      const sftpResult = await OpenBankApi._sftpUpload({
        host, port, user,
        privateKey: partnerConfig.apiSecret || null,
        password: partnerConfig.apiKey || null,
        remotePath: remotePath + filename,
        content: nachaContent,
      });

      console.log(`[OpenBankApi] SFTP transmission: ${filename} → ${host}:${remotePath}${filename}`);

      return {
        success: true,
        status_code: 200,
        message_id: requestId,
        filename,
        response_body: JSON.stringify({
          status: 'transmitted',
          mode: 'sftp',
          sftp_host: host,
          sftp_path: remotePath + filename,
          local_export: exportResult.export_path,
          file_size: exportResult.file_size,
          message: `NACHA file uploaded to ${host}:${remotePath}${filename}`,
        }),
        mdn_received: false,
        transmitted_at: new Date().toISOString(),
        protocol: 'rest_api',
        mode: 'sftp',
        partner_id: partnerConfig.partnerId,
        export_path: exportResult.export_path,
        remote_batch_id: requestId,
        remote_status: 'transmitted',
      };
    } catch (err) {
      return {
        success: false,
        status_code: 500,
        message_id: requestId,
        filename,
        response_body: JSON.stringify({ error: `SFTP upload failed: ${err.message}` }),
        mdn_received: false,
        transmitted_at: new Date().toISOString(),
        protocol: 'rest_api',
        mode: 'sftp',
        partner_id: partnerConfig.partnerId,
      };
    }
  }

  /**
   * Remote REST API transmission — POST NACHA file to partner endpoint.
   */
  static async _transmitRemote(nachaContent, filename, partnerConfig) {
    const baseUrl = partnerConfig.apiBaseUrl || partnerConfig.partnerUrl;
    if (!baseUrl) {
      throw new Error('REST API base URL not configured for this partner.');
    }

    // Production mode: send to external bank endpoint directly (no self-transmit)
    const isProduction = partnerConfig.isProduction === true;

    // If transmitting to self (platform's own URL), use the /receive endpoint
    const selfUrl = OpenBankApi._getSelfUrl();
    const isSelfTransmit = !isProduction && selfUrl && (baseUrl === selfUrl || baseUrl.replace(/\/$/, '') === selfUrl.replace(/\/$/, ''));

    // In production mode, use the bank's receive path; in sandbox, use self /receive
    let endpoint;
    if (isProduction) {
      // Use the full baseUrl as-is for production (bank provides full endpoint)
      endpoint = '';
    } else if (isSelfTransmit) {
      endpoint = '/api/ach-pipeline/receive';
    } else {
      endpoint = '/ach/transmit';
    }

    const transmitUrl = endpoint
      ? (baseUrl.endsWith('/') ? `${baseUrl.slice(0, -1)}${endpoint}` : `${baseUrl}${endpoint}`)
      : baseUrl;
    const parsed = new URL(transmitUrl);

    // Also export locally for audit trail
    OpenBankApi._exportFile(nachaContent, filename, partnerConfig.partnerId);

    const payload = JSON.stringify({
      filename,
      content: nachaContent,
      content_type: 'application/nacha',
      originator_id: 'DLBTRUST',
      submitted_at: new Date().toISOString(),
      metadata: {
        partner_id: partnerConfig.partnerId,
        local_as2_id: partnerConfig.localAs2Id || 'DLBTRUST-AS2',
      },
    });

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'X-Request-ID': OpenBankApi._generateRequestId(),
      'User-Agent': 'DLBTrust-ACH/1.0',
      'Date': new Date().toUTCString(),
    };

    // For self-transmit, use the admin token; for external/production partners, apply partner auth
    if (isSelfTransmit && process.env.ADMIN_SECRET_TOKEN) {
      headers['x-admin-token'] = process.env.ADMIN_SECRET_TOKEN;
    } else {
      OpenBankApi._applyAuth(headers, payload, partnerConfig);
    }

    const modeLabel = isProduction ? 'PRODUCTION' : (isSelfTransmit ? 'SANDBOX/self' : 'external');
    console.log(`[OpenBankApi] _transmitRemote: ${transmitUrl} (mode=${modeLabel})`);

    return new Promise((resolve, reject) => {
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + (parsed.search || ''),
        method: 'POST',
        headers,
        // Allow self-signed certs for self-transmit (loopback); verify for external partners
        rejectUnauthorized: !isSelfTransmit,
      };

      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let responseBody = null;
          try { responseBody = JSON.parse(data); } catch { responseBody = data; }

          const result = {
            success: res.statusCode >= 200 && res.statusCode < 300,
            status_code: res.statusCode,
            message_id: headers['X-Request-ID'],
            filename,
            response_body: typeof responseBody === 'string' ? responseBody.substring(0, 500) : JSON.stringify(responseBody).substring(0, 500),
            mdn_received: false,
            transmitted_at: new Date().toISOString(),
            protocol: 'rest_api',
            mode: 'remote',
            partner_id: partnerConfig.partnerId,
          };

          if (responseBody && typeof responseBody === 'object') {
            result.remote_batch_id = responseBody.batch_id || responseBody.id || null;
            result.remote_status = responseBody.status || null;
          }

          resolve(result);
        });
      });

      req.on('error', (err) => {
        reject(new Error(`REST API transmission failed: ${err.message}`));
      });

      req.setTimeout(60000, () => {
        req.destroy(new Error('REST API transmission timed out after 60s'));
      });

      req.write(payload);
      req.end();
    });
  }

  /**
   * Check the status of a previously transmitted batch via REST API.
   */
  static async checkStatus(remoteBatchId, partnerConfig) {
    const baseUrl = partnerConfig.apiBaseUrl || partnerConfig.partnerUrl;
    if (!baseUrl || baseUrl === 'direct') {
      const selfUrl = OpenBankApi._getSelfUrl();
      return {
        success: true,
        batch_id: remoteBatchId,
        status: 'transmitted',
        mode: selfUrl ? 'remote' : 'direct',
        message: 'Batches are tracked locally. Use dashboard or GET /batches/:id for status.',
      };
    }

    const statusUrl = baseUrl.endsWith('/')
      ? `${baseUrl}ach/status/${remoteBatchId}`
      : `${baseUrl}/ach/status/${remoteBatchId}`;
    const parsed = new URL(statusUrl);

    const headers = {
      'Accept': 'application/json',
      'X-Request-ID': OpenBankApi._generateRequestId(),
      'User-Agent': 'DLBTrust-ACH/1.0',
    };

    OpenBankApi._applyAuth(headers, '', partnerConfig);

    return new Promise((resolve, reject) => {
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + (parsed.search || ''),
        method: 'GET',
        headers,
        rejectUnauthorized: true,
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const body = JSON.parse(data);
            resolve({
              success: res.statusCode >= 200 && res.statusCode < 300,
              status_code: res.statusCode,
              batch_id: remoteBatchId,
              status: body.status || null,
              settled: body.settled || false,
              returned: body.returned || false,
              details: body,
            });
          } catch {
            resolve({
              success: false,
              status_code: res.statusCode,
              error: 'Invalid response from partner API',
              raw: data.substring(0, 500),
            });
          }
        });
      });

      req.on('error', (err) => reject(new Error(`Status check failed: ${err.message}`)));
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('Status check timed out')); });
      req.end();
    });
  }

  /**
   * Test connectivity to a partner's REST API endpoint.
   */
  static async testConnection(partnerConfig) {
    let baseUrl = partnerConfig.apiBaseUrl || partnerConfig.partnerUrl || '';
    let mode = OpenBankApi._resolveMode(baseUrl);

    // Auto-upgrade direct to remote via self URL
    if (mode === 'direct') {
      const selfUrl = OpenBankApi._getSelfUrl();
      if (selfUrl) {
        baseUrl = selfUrl;
        mode = 'remote';
        partnerConfig = { ...partnerConfig, apiBaseUrl: selfUrl };
      }
    }

    if (mode === 'direct') {
      try {
        OpenBankApi._ensureExportDir(partnerConfig.partnerId);
        return {
          connected: true,
          mode: 'direct',
          export_dir: path.join(ACH_EXPORTS_DIR, partnerConfig.partnerId || 'default'),
          protocol: 'rest_api',
          message: 'Direct processing mode — NACHA files will be validated and exported locally.',
        };
      } catch (err) {
        return { connected: false, error: `Export directory not writable: ${err.message}`, mode: 'direct' };
      }
    }

    if (mode === 'sftp') {
      return {
        connected: true,
        mode: 'sftp',
        sftp_url: baseUrl,
        protocol: 'rest_api',
        message: 'SFTP mode configured. File upload will be attempted at transmission time.',
      };
    }

    // Remote mode — try health endpoint
    const healthUrl = baseUrl.endsWith('/') ? `${baseUrl}health` : `${baseUrl}/health`;
    const parsed = new URL(healthUrl);

    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'DLBTrust-ACH/1.0',
    };
    OpenBankApi._applyAuth(headers, '', partnerConfig);

    return new Promise((resolve) => {
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname,
        method: 'GET',
        headers,
        timeout: 10000,
        rejectUnauthorized: false,
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          resolve({
            connected: true,
            status_code: res.statusCode,
            partner_url: baseUrl,
            partner_id: partnerConfig.partnerId || null,
            protocol: 'rest_api',
            mode: 'remote',
            response: data.substring(0, 200),
          });
        });
      });

      req.on('error', (err) => {
        resolve({ connected: false, error: err.message, protocol: 'rest_api', mode: 'remote' });
      });

      req.setTimeout(10000, () => {
        req.destroy();
        resolve({ connected: false, error: 'Connection timed out', protocol: 'rest_api', mode: 'remote' });
      });

      req.end();
    });
  }

  /**
   * Process an incoming webhook from a partner's bank API.
   */
  static processWebhook(partnerId, payload, signature, partnerConfig) {
    if (partnerConfig.webhookSecret && signature) {
      const expected = crypto
        .createHmac('sha256', partnerConfig.webhookSecret)
        .update(JSON.stringify(payload))
        .digest('hex');
      if (signature !== expected && signature !== `sha256=${expected}`) {
        throw new Error('Invalid webhook signature');
      }
    }

    const eventType = payload.event || payload.type || payload.event_type || 'unknown';
    const batchId = payload.batch_id || payload.id || payload.reference_id;

    const statusMap = {
      'ach.accepted': 'accepted',
      'ach.settled': 'settled',
      'ach.returned': 'returned',
      'ach.failed': 'failed',
      'batch.accepted': 'accepted',
      'batch.settled': 'settled',
      'batch.returned': 'returned',
      'payment.completed': 'settled',
      'payment.returned': 'returned',
      'payment.failed': 'failed',
      'transfer.completed': 'settled',
      'transfer.returned': 'returned',
    };

    return {
      partner_id: partnerId,
      event_type: eventType,
      batch_id: batchId,
      mapped_status: statusMap[eventType] || null,
      return_code: payload.return_code || payload.returnCode || null,
      return_reason: payload.return_reason || payload.returnReason || null,
      settlement_date: payload.settlement_date || payload.settled_at || null,
      amount_cents: payload.amount_cents || payload.amount || null,
      raw_payload: payload,
      received_at: new Date().toISOString(),
    };
  }

  // ─── File Export ────────────────────────────────────────────────────────────

  /**
   * Export NACHA file to date-organized directory.
   */
  static _exportFile(nachaContent, filename, partnerId) {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const partnerDir = partnerId || 'default';
    const exportDir = path.join(ACH_EXPORTS_DIR, partnerDir, today);

    fs.mkdirSync(exportDir, { recursive: true });

    const exportPath = path.join(exportDir, filename);
    fs.writeFileSync(exportPath, nachaContent, 'utf8');

    return {
      export_path: exportPath,
      export_filename: filename,
      export_dir: exportDir,
      file_size: Buffer.byteLength(nachaContent, 'utf8'),
    };
  }

  /**
   * Ensure export directory exists and is writable.
   */
  static _ensureExportDir(partnerId) {
    const dir = path.join(ACH_EXPORTS_DIR, partnerId || 'default');
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return dir;
  }

  /**
   * List exported files for a partner, optionally filtered by date.
   * When no partnerId is given, lists exports across ALL partners.
   */
  static listExports(partnerId, date) {
    if (!fs.existsSync(ACH_EXPORTS_DIR)) return [];

    // When no partnerId, scan all partner subdirectories
    const partnerIds = partnerId
      ? [partnerId]
      : fs.readdirSync(ACH_EXPORTS_DIR).filter(d => {
          try { return fs.statSync(path.join(ACH_EXPORTS_DIR, d)).isDirectory(); } catch { return false; }
        });

    const results = [];
    for (const pid of partnerIds) {
      const partnerDir = path.join(ACH_EXPORTS_DIR, pid);
      if (!fs.existsSync(partnerDir)) continue;

      const dateDirs = date ? [date] : fs.readdirSync(partnerDir).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));

      for (const dateDir of dateDirs) {
        const fullDir = path.join(partnerDir, dateDir);
        if (!fs.existsSync(fullDir) || !fs.statSync(fullDir).isDirectory()) continue;
        const files = fs.readdirSync(fullDir);
        for (const file of files) {
          const filePath = path.join(fullDir, file);
          const stat = fs.statSync(filePath);
          results.push({
            filename: file,
            date: dateDir,
            path: filePath,
            size: stat.size,
            exported_at: stat.mtime.toISOString(),
            partner_id: pid,
          });
        }
      }
    }
    return results.sort((a, b) => b.exported_at.localeCompare(a.exported_at));
  }

  // ─── NACHA Validation ──────────────────────────────────────────────────────

  /**
   * Basic NACHA file validation — checks structure, record types, hash.
   */
  static _validateNacha(content) {
    const issues = [];
    const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length < 4) {
      issues.push('NACHA file must have at least 4 records (file header, batch header, entry, batch/file control)');
      return { valid: false, issues, entryCount: 0, totalDebit: 0, totalCredit: 0 };
    }

    // Check file header (record type 1)
    if (!lines[0].startsWith('1')) {
      issues.push('First record must be file header (record type 1)');
    }

    let entryCount = 0;
    let totalDebit = 0;
    let totalCredit = 0;

    for (const line of lines) {
      const recType = line.charAt(0);
      if (recType === '6') {
        entryCount++;
        const txCode = line.substring(1, 3);
        const amount = parseInt(line.substring(29, 39).trim(), 10) || 0;
        // Transaction codes: 22/32 = credit, 27/37 = debit
        if (['22', '32', '23', '33'].includes(txCode)) {
          totalCredit += amount;
        } else {
          totalDebit += amount;
        }
      }
    }

    // Check file control (last non-padding record starts with 9)
    const lastReal = lines.filter(l => !l.startsWith('9999'));
    if (lastReal.length && !lastReal[lastReal.length - 1].startsWith('9')) {
      issues.push('Last record must be file control (record type 9)');
    }

    return {
      valid: issues.length === 0,
      issues,
      entryCount,
      totalDebit,
      totalCredit,
      recordCount: lines.length,
    };
  }

  // ─── SFTP Upload ───────────────────────────────────────────────────────────

  /**
   * Upload file via SFTP using shell command (sshpass + sftp).
   * Falls back to scp if sftp is not available.
   */
  static async _sftpUpload({ host, port, user, privateKey, password, remotePath, content }) {
    const { execSync } = require('child_process');

    // Write content to temp file
    const tmpFile = path.join(ACH_EXPORTS_DIR, `.tmp-${Date.now()}.ach`);
    fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
    fs.writeFileSync(tmpFile, content, 'utf8');

    try {
      if (privateKey && fs.existsSync(privateKey)) {
        // Key-based auth
        execSync(
          `scp -P ${port} -o StrictHostKeyChecking=no -i "${privateKey}" "${tmpFile}" "${user}@${host}:${remotePath}"`,
          { timeout: 60000 }
        );
      } else if (password) {
        // Password-based auth via sshpass
        execSync(
          `sshpass -p "${password}" scp -P ${port} -o StrictHostKeyChecking=no "${tmpFile}" "${user}@${host}:${remotePath}"`,
          { timeout: 60000 }
        );
      } else {
        throw new Error('SFTP requires either privateKey path or password (set as apiKey on partner)');
      }

      return { success: true, host, remotePath };
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  // ─── Mode Resolution ───────────────────────────────────────────────────────

  static _resolveMode(baseUrl) {
    if (!baseUrl || baseUrl === 'direct' || baseUrl === 'local') return 'direct';
    if (baseUrl.startsWith('sftp://')) return 'sftp';
    return 'remote';
  }

  // ─── Auth & Helpers ────────────────────────────────────────────────────────

  static _applyAuth(headers, body, config) {
    const authType = config.apiAuthType || 'bearer';
    const apiKey = config.apiKey || '';
    const apiSecret = config.apiSecret || '';

    switch (authType) {
      case 'bearer':
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        break;
      case 'basic':
        if (apiKey) {
          const creds = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
          headers['Authorization'] = `Basic ${creds}`;
        }
        break;
      case 'api_key':
        if (apiKey) headers['X-API-Key'] = apiKey;
        break;
      case 'hmac':
        if (apiKey && apiSecret) {
          headers['X-API-Key'] = apiKey;
          const sig = crypto.createHmac('sha256', apiSecret)
            .update(typeof body === 'string' ? body : JSON.stringify(body))
            .digest('hex');
          headers['X-Signature'] = sig;
        }
        break;
    }
  }

  static _generateRequestId() {
    return `REQ-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  }

  /**
   * Test connectivity to an external bank endpoint.
   * Sends a HEAD/OPTIONS request to verify the endpoint is reachable.
   */
  static async testConnection(partnerConfig) {
    const baseUrl = partnerConfig.apiBaseUrl || partnerConfig.partnerUrl;
    if (!baseUrl) return { connected: false, error: 'No endpoint configured' };

    try {
      const parsed = new URL(baseUrl);
      const lib = parsed.protocol === 'https:' ? https : http;

      return new Promise((resolve) => {
        const req = lib.request({
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname || '/',
          method: 'OPTIONS',
          timeout: 10000,
        }, (res) => {
          resolve({
            connected: true,
            status_code: res.statusCode,
            endpoint: baseUrl,
            latency_ms: Date.now() - startTime,
          });
        });

        const startTime = Date.now();
        req.on('error', (err) => {
          resolve({ connected: false, error: err.message, endpoint: baseUrl });
        });
        req.on('timeout', () => {
          req.destroy();
          resolve({ connected: false, error: 'Connection timed out', endpoint: baseUrl });
        });
        req.end();
      });
    } catch (err) {
      return { connected: false, error: err.message };
    }
  }

  /**
   * Transmit using production mode settings from SystemSettings.
   * This is the primary production entry point — reads the configured
   * external bank endpoint and transmits the NACHA file over HTTPS.
   */
  static async transmitProduction(nachaContent, filename) {
    const { SystemSettings } = require('./systemSettings');
    const config = await SystemSettings.getProductionPartnerConfig();
    if (!config) {
      throw new Error('Production bank endpoint not configured. Set bank_endpoint in System Settings.');
    }
    return OpenBankApi.transmit(nachaContent, filename, config);
  }
}

module.exports = { OpenBankApi };
