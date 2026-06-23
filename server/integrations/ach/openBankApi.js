'use strict';

/**
 * Open Banking API Client — REST-based ACH File Transmission
 *
 * Provides REST API transmission as an alternative to AS2 for partners
 * that support HTTP-based file exchange. Each partner can have its own
 * API credentials (api_key, api_secret, api_base_url).
 *
 * Supports multiple authentication schemes:
 *   bearer   — Authorization: Bearer <api_key>
 *   basic    — Authorization: Basic base64(api_key:api_secret)
 *   api_key  — X-API-Key: <api_key>
 *   hmac     — HMAC-SHA256 signature in X-Signature header
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

class OpenBankApi {

  /**
   * Transmit a NACHA file to a partner's REST API endpoint.
   *
   * @param {string} nachaContent — the NACHA file string
   * @param {string} filename — the filename (e.g. "ACH-2026-06-21-001.ach")
   * @param {Object} partnerConfig — partner config with REST API credentials
   * @returns {Promise<Object>} transmission result
   */
  static async transmit(nachaContent, filename, partnerConfig) {
    const baseUrl = partnerConfig.apiBaseUrl || partnerConfig.partnerUrl;
    if (!baseUrl) {
      throw new Error('REST API base URL not configured for this partner.');
    }

    const transmitUrl = baseUrl.endsWith('/') ? `${baseUrl}ach/transmit` : `${baseUrl}/ach/transmit`;
    const parsed = new URL(transmitUrl);

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

    OpenBankApi._applyAuth(headers, payload, partnerConfig);

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
   *
   * @param {string} remoteBatchId — the batch ID returned by the partner's API
   * @param {Object} partnerConfig — partner config with REST API credentials
   * @returns {Promise<Object>} status result
   */
  static async checkStatus(remoteBatchId, partnerConfig) {
    const baseUrl = partnerConfig.apiBaseUrl || partnerConfig.partnerUrl;
    if (!baseUrl) throw new Error('REST API base URL not configured.');

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
   *
   * @param {Object} partnerConfig — partner config with REST API credentials
   * @returns {Promise<Object>} connectivity result
   */
  static async testConnection(partnerConfig) {
    const baseUrl = partnerConfig.apiBaseUrl || partnerConfig.partnerUrl;
    if (!baseUrl) {
      return { connected: false, error: 'REST API base URL not configured' };
    }

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
            response: data.substring(0, 200),
          });
        });
      });

      req.on('error', (err) => {
        resolve({ connected: false, error: err.message, protocol: 'rest_api' });
      });

      req.setTimeout(10000, () => {
        req.destroy();
        resolve({ connected: false, error: 'Connection timed out', protocol: 'rest_api' });
      });

      req.end();
    });
  }

  /**
   * Process an incoming webhook from a partner's bank API.
   * Maps the webhook payload to internal ACH lifecycle events.
   *
   * @param {string} partnerId — which partner sent the webhook
   * @param {Object} payload — the webhook body
   * @param {string} signature — the X-Signature header (for HMAC verification)
   * @param {Object} partnerConfig — partner config (for webhook_secret)
   * @returns {Object} parsed webhook event
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

  /**
   * Apply authentication headers based on the partner's auth type.
   * @private
   */
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

  /**
   * @private
   */
  static _generateRequestId() {
    return `REQ-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  }
}

module.exports = { OpenBankApi };
