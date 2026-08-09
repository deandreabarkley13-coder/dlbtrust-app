'use strict';

/**
 * Lili Bank Engine
 *
 * Bridges the DLB Trust ledger to Lili business banking.
 *
 * Lili exposes:
 *   - Application API (onboarding / lead creation)
 *   - Customer Management API
 *   - Webhooks API
 *   - MCP server (read-only data, bill/supplier lookups)
 *
 * Outbound ACH/wire payments are not exposed by a public REST endpoint; Lili
 * expects them to be initiated inside the Lili app or via Bill Pay. This engine
 * therefore supports two flows:
 *
 *   1. Direct API calls to the Lili Connect Application API for onboarding.
 *   2. A manual bill-pay flow that gathers the payment details, checks
 *      supplier/payment-method data via MCP if credentials are provided, and
 *      produces a payment instruction that can be submitted through the Lili
 *      web/mobile app or exported to the Web HTTPS Payment Rail.
 *
 * To enable live payment origination, set the LILI_PAYMENT_ENDPOINT override
 * and LILI_ACCESS_KEY / LILI_SECRET_KEY; the engine will POST to that endpoint.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const https = require('https');
const http = require('http');
const { URL } = require('url');

let SystemSettings;
let LiliMcpEngine;
function loadDeps() {
  try { ({ SystemSettings } = require('../ach/systemSettings')); } catch (e) { SystemSettings = null; }
  try { ({ LiliMcpEngine } = require('./liliMcpEngine')); } catch (e) { LiliMcpEngine = null; }
}

async function getSetting(name) {
  loadDeps();
  if (SystemSettings && typeof SystemSettings.get === 'function') {
    try {
      const v = await SystemSettings.get(name);
      if (v !== null && v !== undefined) return v;
    } catch (e) { /* fall through */ }
  }
  return process.env[name] || null;
}

function liliAuthHeader() {
  const access = process.env.LILI_ACCESS_KEY;
  const secret = process.env.LILI_SECRET_KEY;
  if (!access || !secret) return null;
  return `Lili ${access}:${secret}`;
}

function generateId(prefix = 'LILI') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function httpRequest({ method, url, headers = {}, body, timeout = 30000 }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const postData = body ? Buffer.from(body, 'utf8') : undefined;
    const reqHeaders = { ...headers };
    if (postData) reqHeaders['Content-Length'] = postData.length;
    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search || ''}`,
      method,
      headers: reqHeaders,
      timeout,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

class LiliBankEngine {
  static async ensureTables() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lili_payments (
        id SERIAL PRIMARY KEY,
        payment_id TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','api_pending','manual_pending','completed','failed','cancelled')),
        type TEXT NOT NULL DEFAULT 'ach' CHECK (type IN ('ach','wire','bill_pay')),
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        recipient_name TEXT,
        recipient_account TEXT,
        recipient_routing TEXT,
        recipient_bank TEXT,
        recipient_email TEXT,
        source_account_id TEXT,
        lili_account_id TEXT,
        lili_business_user_id TEXT,
        lili_supplier_id TEXT,
        lili_payment_method TEXT,
        request_body JSONB,
        response_body JSONB,
        external_tx_id TEXT,
        error_message TEXT,
        initiated_by TEXT NOT NULL DEFAULT 'system',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_lili_payments_status ON lili_payments(status)`);
  }

  static async getConfig() {
    const mcpConfig = LiliMcpEngine ? await LiliMcpEngine.getPublicConfig() : { mcpEnabled: false, configured: false };
    return {
      baseUrl: (await getSetting('LILI_BASE_URL')) || process.env.LILI_BASE_URL || 'https://prod.lili.co',
      applicationEndpoint: (await getSetting('LILI_APPLICATION_ENDPOINT')) || process.env.LILI_APPLICATION_ENDPOINT || '/lili/api/v1/lead',
      paymentEndpoint: (await getSetting('LILI_PAYMENT_ENDPOINT')) || process.env.LILI_PAYMENT_ENDPOINT || null,
      mcpUrl: (await getSetting('LILI_MCP_URL')) || process.env.LILI_MCP_URL || 'https://mcp.lili.co/mcp',
      mcpEnabled: mcpConfig.mcpEnabled,
      mcpConfigured: mcpConfig.configured,
      authHeader: liliAuthHeader(),
    };
  }

  static async createApplication(lead) {
    const cfg = await this.getConfig();
    if (!cfg.authHeader) throw new Error('LILI_ACCESS_KEY and LILI_SECRET_KEY required');
    const url = `${cfg.baseUrl}${cfg.applicationEndpoint}`;
    const body = JSON.stringify(lead);
    const response = await httpRequest({
      method: 'PUT',
      url,
      headers: { 'Authorization': cfg.authHeader, 'Content-Type': 'application/json' },
      body,
    });
    if (response.statusCode >= 400) throw new Error(`Lili create application failed: ${response.statusCode} ${response.body}`);
    return JSON.parse(response.body);
  }

  static async createPayment({
    amount,
    currency = 'USD',
    recipientName,
    recipientAccount,
    recipientRouting,
    recipientBank,
    recipientEmail,
    sourceAccountId,
    liliAccountId,
    liliBusinessUserId,
    speed = 'standard',
    initiatedBy = 'system',
  } = {}) {
    await this.ensureTables();
    const cents = Math.round((Number(amount) || 0) * 100);
    if (cents <= 0) throw new Error('amount must be positive');
    const cfg = await this.getConfig();
    const paymentId = generateId('LILIPAY');

    await pool.query(
      `INSERT INTO lili_payments (payment_id, status, type, amount_cents, currency, recipient_name, recipient_account, recipient_routing, recipient_bank, recipient_email, source_account_id, lili_account_id, lili_business_user_id, request_body, initiated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [paymentId, 'pending', 'ach', cents, String(currency).toUpperCase(), recipientName || null, recipientAccount || null, recipientRouting || null, recipientBank || null, recipientEmail || null, sourceAccountId || null, liliAccountId || null, liliBusinessUserId || null, JSON.stringify({ speed }), initiatedBy]
    );

    // If a Lili payment endpoint is configured, attempt the live call.
    if (cfg.paymentEndpoint && cfg.authHeader) {
      const url = cfg.paymentEndpoint.startsWith('http') ? cfg.paymentEndpoint : `${cfg.baseUrl}${cfg.paymentEndpoint}`;
      const payload = {
        amount: (cents / 100).toFixed(2),
        currency: String(currency).toUpperCase(),
        payee: {
          name: recipientName,
          accountNumber: recipientAccount,
          routingNumber: recipientRouting,
          bankName: recipientBank,
          email: recipientEmail,
        },
        speed,
        reference: paymentId,
      };
      try {
        const response = await httpRequest({
          method: 'POST',
          url,
          headers: { 'Authorization': cfg.authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const parsed = (response.body && response.body.trim()) ? JSON.parse(response.body) : {};
        const status = response.statusCode >= 200 && response.statusCode < 300 ? 'api_pending' : 'failed';
        await pool.query(
          `UPDATE lili_payments SET status=$1, response_body=$2, external_tx_id=$3, updated_at=NOW() WHERE payment_id=$4`,
          [status, JSON.stringify({ statusCode: response.statusCode, body: response.body }), parsed.paymentId || parsed.id || null, paymentId]
        );
      } catch (err) {
        await pool.query(
          `UPDATE lili_payments SET status='failed', error_message=$1, updated_at=NOW() WHERE payment_id=$2`,
          [err.message, paymentId]
        );
      }
    } else if (cfg.mcpEnabled && LiliMcpEngine) {
      try {
        const mcpResult = await LiliMcpEngine.payToPayee({
          amount: cents / 100,
          recipientName,
          recipientAccount,
          recipientRouting,
          recipientBank,
          recipientEmail,
          businessUserId: liliBusinessUserId,
          memo: `Lili payment ${paymentId}`,
        });
        const status = mcpResult.status === 'api_pending' ? 'api_pending' : 'manual_pending';
        await pool.query(
          `UPDATE lili_payments SET status=$1, response_body=$2, external_tx_id=$3, error_message=$4, updated_at=NOW() WHERE payment_id=$5`,
          [status, JSON.stringify(mcpResult), mcpResult.externalTxId || null, mcpResult.reason || null, paymentId]
        );
      } catch (err) {
        await pool.query(
          `UPDATE lili_payments SET status='manual_pending', error_message=$1, updated_at=NOW() WHERE payment_id=$2`,
          [`MCP payment attempt failed: ${err.message}; complete in Lili Bill Pay`, paymentId]
        );
      }
    } else {
      await pool.query(
        `UPDATE lili_payments SET status='manual_pending', error_message=$1, updated_at=NOW() WHERE payment_id=$2`,
        ['No LILI_PAYMENT_ENDPOINT or Lili MCP configured; payment requires manual completion in Lili Bill Pay', paymentId]
      );
    }

    return this.getPayment(paymentId);
  }

  static async getPayment(paymentId) {
    if (!pool) throw new Error('Database not available');
    const res = await pool.query('SELECT * FROM lili_payments WHERE payment_id = $1', [paymentId]);
    return res.rows[0] || null;
  }

  static async listPayments({ limit = 50, status } = {}) {
    if (!pool) throw new Error('Database not available');
    let sql = 'SELECT * FROM lili_payments';
    const params = [];
    if (status) { sql += ' WHERE status = $1'; params.push(status); }
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    const res = await pool.query(sql, params);
    return res.rows;
  }

  static async markPaid(paymentId, externalTxId, { initiatedBy = 'system' } = {}) {
    const row = await this.getPayment(paymentId);
    if (!row) throw new Error('Payment not found');
    await pool.query(
      `UPDATE lili_payments SET status='completed', external_tx_id=$1, updated_at=NOW() WHERE payment_id=$2`,
      [externalTxId || null, paymentId]
    );
    return this.getPayment(paymentId);
  }

  static async cancelPayment(paymentId) {
    const row = await this.getPayment(paymentId);
    if (!row) throw new Error('Payment not found');
    if (row.status === 'completed') throw new Error('Cannot cancel a completed payment');
    await pool.query(`UPDATE lili_payments SET status='cancelled', updated_at=NOW() WHERE payment_id=$1`, [paymentId]);
    return this.getPayment(paymentId);
  }
}

module.exports = { LiliBankEngine };
