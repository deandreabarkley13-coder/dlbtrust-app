'use strict';

/**
 * Web HTTPS Payment Rail Engine
 *
 * A configurable, generic engine that sends payment instructions over HTTPS to
 * any REST/SOAP/ISO-20022 endpoint, tracks the lifecycle, and reconciles the
 * trust ledger.
 *
 * No specific provider is required; the operator configures the endpoint,
 * authentication, payload template, and response mapping in system_settings.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

let SystemSettings, CashEngine;
function loadDeps() {
  try { ({ SystemSettings } = require('../ach/systemSettings')); } catch (e) { SystemSettings = null; }
  try { CashEngine = require('../cash/cashEngine'); } catch (e) { CashEngine = null; }
}

const https = require('https');
const http = require('http');
const { URL } = require('url');

const TABLE = 'web_payment_rails';

function generateId(prefix = 'WPR') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

async function getSetting(name) {
  loadDeps();
  if (SystemSettings && typeof SystemSettings.get === 'function') {
    try { return await SystemSettings.get(name); } catch (e) { /* fall through */ }
  }
  return process.env[name] || null;
}

function interpolate(template, context) {
  if (!template) return '';
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => context[key] || '');
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

function parseAmountFromResponse(map, body) {
  if (!map) return null;
  if (map.jsonPath) {
    try {
      const obj = JSON.parse(body);
      const parts = map.jsonPath.split('.');
      let cur = obj;
      for (const p of parts) { if (cur == null) break; cur = cur[p]; }
      return cur;
    } catch (e) { return null; }
  }
  if (map.regex) {
    const m = body.match(new RegExp(map.regex, 'i'));
    return m ? m[1] : null;
  }
  return null;
}

class WebPaymentRailEngine {
  static async ensureTables() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id SERIAL PRIMARY KEY,
        payment_id TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','completed','failed','cancelled')),
        adapter_name TEXT,
        endpoint TEXT NOT NULL,
        method TEXT NOT NULL DEFAULT 'POST',
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        recipient_name TEXT,
        recipient_account TEXT,
        recipient_bank TEXT,
        recipient_routing TEXT,
        source_account_id TEXT,
        source_type TEXT,
        request_body TEXT,
        response_body TEXT,
        external_tx_id TEXT,
        external_status TEXT,
        raw_request JSONB,
        raw_response JSONB,
        error_message TEXT,
        initiated_by TEXT NOT NULL DEFAULT 'system',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_status ON ${TABLE}(status)`);
  }

  static async getConfig(name = 'default') {
    const prefix = name === 'default' ? 'WEB_PAYMENT_RAIL' : `WEB_PAYMENT_RAIL_${name.toUpperCase()}`;
    return {
      adapterName: name,
      endpoint: await getSetting(`${prefix}_ENDPOINT`),
      method: (await getSetting(`${prefix}_METHOD`)) || 'POST',
      contentType: (await getSetting(`${prefix}_CONTENT_TYPE`)) || 'application/json',
      authType: (await getSetting(`${prefix}_AUTH_TYPE`)) || 'api_key',
      apiKey: await getSetting(`${prefix}_API_KEY`),
      apiSecret: await getSetting(`${prefix}_API_SECRET`),
      username: await getSetting(`${prefix}_USERNAME`),
      password: await getSetting(`${prefix}_PASSWORD`),
      payloadTemplate: await getSetting(`${prefix}_PAYLOAD_TEMPLATE`),
      headersTemplate: await getSetting(`${prefix}_HEADERS_TEMPLATE`),
      successRegex: await getSetting(`${prefix}_SUCCESS_REGEX`),
      txIdMap: (await getSetting(`${prefix}_TX_ID_MAP`)) ? JSON.parse(await getSetting(`${prefix}_TX_ID_MAP`)) : { regex: '<id>([^<]+)</id>' },
      statusMap: (await getSetting(`${prefix}_STATUS_MAP`)) ? JSON.parse(await getSetting(`${prefix}_STATUS_MAP`)) : {},
    };
  }

  static async listConfigs() {
    // Return the default plus any env vars with prefix pattern
    const names = new Set(['default']);
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('WEB_PAYMENT_RAIL_') && key.endsWith('_ENDPOINT')) {
        const mid = key.replace(/^WEB_PAYMENT_RAIL_/, '').replace(/_ENDPOINT$/, '');
        if (mid && mid !== 'DEFAULT') names.add(mid.toLowerCase());
      }
    }
    const list = [];
    for (const n of names) {
      const cfg = await this.getConfig(n);
      cfg.ready = !!cfg.endpoint;
      list.push(cfg);
    }
    return list;
  }

  static async createPayment({
    adapterName = 'default',
    amount,
    currency = 'USD',
    recipientName,
    recipientAccount,
    recipientBank,
    recipientRouting,
    sourceType = 'cash',
    sourceAccountId,
    description,
    initiatedBy = 'system',
  } = {}) {
    await this.ensureTables();
    const cfg = await this.getConfig(adapterName);
    if (!cfg.endpoint) throw new Error(`Web payment rail ${adapterName} has no endpoint configured`);
    const cents = toCents(amount);
    if (cents <= 0) throw new Error('amount must be positive');

    const paymentId = generateId('WPR');
    const context = {
      paymentId,
      amount: (cents / 100).toFixed(2),
      amountCents: cents,
      currency: String(currency).toUpperCase(),
      recipientName: recipientName || '',
      recipientAccount: recipientAccount || '',
      recipientBank: recipientBank || '',
      recipientRouting: recipientRouting || '',
      description: description || `Web payment ${paymentId}`,
      apiKey: cfg.apiKey || '',
      timestamp: new Date().toISOString(),
    };

    const body = interpolate(cfg.payloadTemplate || '{"amount":"{{amount}}","currency":"{{currency}}","reference":"{{paymentId}}"}', context);
    const headers = { 'Content-Type': cfg.contentType };
    if (cfg.authType === 'api_key' && cfg.apiKey) {
      headers.Authorization = `Bearer ${cfg.apiKey}`;
    } else if (cfg.authType === 'basic' && cfg.username && cfg.password) {
      const token = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
      headers.Authorization = `Basic ${token}`;
    }
    if (cfg.headersTemplate) {
      try {
        const parsed = JSON.parse(interpolate(cfg.headersTemplate, context));
        Object.assign(headers, parsed);
      } catch (e) { /* ignore */ }
    }

    await pool.query(
      `INSERT INTO ${TABLE} (payment_id, status, adapter_name, endpoint, method, amount_cents, currency, recipient_name, recipient_account, recipient_bank, recipient_routing, source_account_id, source_type, request_body, raw_request, initiated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [paymentId, 'pending', cfg.adapterName, cfg.endpoint, cfg.method, cents, context.currency, recipientName || null, recipientAccount || null, recipientBank || null, recipientRouting || null, sourceAccountId || null, sourceType || null, body, JSON.stringify({ headers, body, context, cfg: { ...cfg, apiKey: cfg.apiKey ? '***' : undefined, apiSecret: cfg.apiSecret ? '***' : undefined, password: cfg.password ? '***' : undefined } }), initiatedBy]
    );

    return this.getPayment(paymentId);
  }

  static async getPayment(paymentId) {
    if (!pool) throw new Error('Database not available');
    const result = await pool.query(`SELECT * FROM ${TABLE} WHERE payment_id = $1`, [paymentId]);
    return result.rows[0] || null;
  }

  static async listPayments({ limit = 50, status } = {}) {
    if (!pool) throw new Error('Database not available');
    let sql = `SELECT * FROM ${TABLE}`;
    const params = [];
    if (status) { sql += ' WHERE status = $1'; params.push(status); }
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    const result = await pool.query(sql, params);
    return result.rows;
  }

  static async sendPayment(paymentId) {
    await this.ensureTables();
    const row = await this.getPayment(paymentId);
    if (!row) throw new Error('Payment not found');
    if (!['pending'].includes(row.status)) throw new Error(`Payment status is ${row.status}`);

    const cfg = await this.getConfig(row.adapter_name || 'default');
    if (!cfg.endpoint) throw new Error('Adapter endpoint not configured');

    const headers = { 'Content-Type': cfg.contentType };
    if (cfg.authType === 'api_key' && cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    else if (cfg.authType === 'basic' && cfg.username && cfg.password) {
      headers.Authorization = `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')}`;
    }

    let response;
    try {
      response = await httpRequest({ method: cfg.method, url: cfg.endpoint, headers, body: row.request_body });
    } catch (err) {
      await pool.query(`UPDATE ${TABLE} SET status='failed', error_message=$1, updated_at=NOW() WHERE payment_id=$2`, [err.message, paymentId]);
      throw err;
    }

    const raw = { statusCode: response.statusCode, headers: response.headers, body: response.body };
    const externalTxId = parseAmountFromResponse(cfg.txIdMap, response.body) || null;

    let status = 'sent';
    if (cfg.successRegex && new RegExp(cfg.successRegex, 'i').test(response.body)) status = 'completed';
    else if (response.statusCode >= 200 && response.statusCode < 300 && !cfg.successRegex) status = 'completed';

    const externalStatus = (cfg.statusMap && parseAmountFromResponse({ regex: cfg.statusMap.regex }, response.body)) || null;

    await pool.query(
      `UPDATE ${TABLE} SET status=$1, external_tx_id=$2, external_status=$3, response_body=$4, raw_response=$5, error_message=null, updated_at=NOW() WHERE payment_id=$6`,
      [status, externalTxId, externalStatus, response.body, JSON.stringify(raw), paymentId]
    );

    // Ledger movement: debit source, credit web-rail hold/settled
    if (status === 'completed' && row.source_account_id) {
      try {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const holdId = 'WEB-PAYMENT-HOLD';
          const settledId = 'WEB-PAYMENT-SETTLED';
          for (const id of [holdId, settledId]) {
            await client.query(
              `INSERT INTO cash_accounts (account_id, account_name, account_type, status, balance_cents, created_at, updated_at)
               VALUES ($1, $2, 'escrow', 'active', 0, NOW(), NOW())
               ON CONFLICT (account_id) DO NOTHING`,
              [id, id === holdId ? 'Web Payment Hold' : 'Web Payment Settled']
            );
          }
          await client.query(`UPDATE cash_accounts SET balance_cents = balance_cents - $1, updated_at = NOW() WHERE account_id = $2 AND status = 'active'`, [row.amount_cents, row.source_account_id]);
          await client.query(`UPDATE cash_accounts SET balance_cents = balance_cents + $1, updated_at = NOW() WHERE account_id = $2 AND status = 'active'`, [row.amount_cents, settledId]);
          const movementId = `MOV-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
          await client.query(
            `INSERT INTO cash_movements (movement_id, from_account_id, to_account_id, amount_cents, movement_type, reference_id, reference_type, memo, initiated_by)
             VALUES ($1,$2,$3,$4,'deposit',$5,'web_payment_rail',$6,$7)`,
            [movementId, row.source_account_id, settledId, row.amount_cents, paymentId, `Web rail payment ${paymentId}`, row.initiated_by]
          );
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          console.warn('[WebPaymentRail] ledger error:', e.message);
        } finally {
          client.release();
        }
      } catch (e) { console.warn('[WebPaymentRail] ledger connection error:', e.message); }
    }

    return this.getPayment(paymentId);
  }

  static async cancelPayment(paymentId) {
    const row = await this.getPayment(paymentId);
    if (!row) throw new Error('Payment not found');
    if (row.status === 'completed') throw new Error('Cannot cancel a completed payment');
    await pool.query(`UPDATE ${TABLE} SET status='cancelled', updated_at=NOW() WHERE payment_id=$1`, [paymentId]);
    return this.getPayment(paymentId);
  }

  static async processWebhook({ paymentId, externalTxId, status, raw }) {
    await this.ensureTables();
    const row = paymentId ? await this.getPayment(paymentId) : null;
    if (!row && !externalTxId) throw new Error('paymentId or externalTxId required');
    let id = row ? row.payment_id : null;
    if (!id) {
      const res = await pool.query(`SELECT payment_id FROM ${TABLE} WHERE external_tx_id = $1 LIMIT 1`, [externalTxId]);
      if (res.rows.length) id = res.rows[0].payment_id;
    }
    if (!id) throw new Error('Payment not found for webhook');
    await pool.query(
      `UPDATE ${TABLE} SET status=$1, external_status=$2, raw_response=COALESCE(raw_response,'{}')::jsonb || $3::jsonb, updated_at=NOW() WHERE payment_id=$4`,
      [status, status, JSON.stringify({ webhook: raw }), id]
    );
    return this.getPayment(id);
  }
}

module.exports = { WebPaymentRailEngine };
