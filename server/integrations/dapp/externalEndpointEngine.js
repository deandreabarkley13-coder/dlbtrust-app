'use strict';

/**
 * External Endpoint Engine
 *
 * Generic, configurable payment endpoint adapter. Operators register an external
 * bank/fintech endpoint (REST JSON/XML, SOAP, ISO 20022 XML, gRPC, MFT/AS2/SFTP,
 * or manual) with credentials and a payload template. Payments are then routed
 * through that endpoint from the trust bank/ledger rails.
 *
 * The engine does NOT create sovereign money; it still needs a real ODFI/bank
 * endpoint and valid credentials to settle external cash.
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

let CashEngine;
try { ({ CashEngine } = require('../cash/cashEngine')); } catch (e) { CashEngine = null; }

let OpenBankingEngine;
let ISO20022;
try { ({ OpenBankingEngine, ISO20022 } = require('./openBankingEngine')); } catch (e) { OpenBankingEngine = null; ISO20022 = null; }

const HOLD_ACCOUNT = 'EXTERNAL_ENDPOINT_HOLD';
const SETTLED_ACCOUNT = 'EXTERNAL_ENDPOINT_SETTLED';

function generateId(prefix = 'EEP') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

function escapeXml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function httpRequest({ url, method = 'GET', headers = {}, body, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const reqHeaders = { ...headers };
    if (payload) reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search || ''}`,
      method,
      headers: reqHeaders,
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* leave null */ }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function maskSecret(value) {
  if (!value) return '';
  const s = String(value);
  if (s.length <= 8) return '*'.repeat(s.length);
  return s.slice(0, 4) + '...' + s.slice(-4);
}

function renderTemplate(template, ctx) {
  if (!template) return '';
  return String(template).replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (match, key) => {
    const parts = key.split('.');
    let val = ctx;
    for (const p of parts) { val = val == null ? undefined : val[p]; }
    if (val == null) return '';
    return String(val);
  });
}

function buildAuthHeaders(endpoint, ctx = {}) {
  const headers = {};
  const { api_key: apiKey, api_secret: apiSecret, auth_type: authType } = endpoint;
  if (authType === 'bearer' && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  } else if (authType === 'basic' && apiKey) {
    headers.Authorization = 'Basic ' + Buffer.from(`${apiKey}:${apiSecret || ''}`).toString('base64');
  } else if (authType === 'api_key' && apiKey) {
    headers['X-API-Key'] = apiKey;
  } else if (authType === 'lili' && apiKey) {
    headers.Authorization = `Lili ${apiKey}:${apiSecret || ''}`;
  } else if (authType === 'hmac' && apiKey && apiSecret) {
    const body = ctx.body || '';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = crypto.createHmac('sha256', apiSecret).update(`${timestamp}.${body}`).digest('hex');
    headers['X-API-Key'] = apiKey;
    headers['X-Timestamp'] = timestamp;
    headers['X-Signature'] = sig;
  }
  const extra = endpoint.extra_headers || {};
  for (const [k, v] of Object.entries(extra)) {
    headers[k] = renderTemplate(String(v), ctx);
  }
  return headers;
}

function buildDefaultPayload(endpoint, ctx) {
  const protocol = endpoint.protocol;
  if (protocol === 'rest_json' || protocol === 'rest' || protocol === 'webhook') {
    return JSON.stringify({
      reference_id: ctx.referenceId,
      amount: ctx.dollars,
      currency: ctx.currency,
      payment_type: ctx.paymentType,
      description: ctx.description,
      debtor: {
        name: ctx.debtorName,
        account: ctx.debtorAccount,
        routing: ctx.debtorRouting,
        bank: ctx.debtorBank,
      },
      creditor: {
        name: ctx.creditorName,
        account: ctx.creditorAccount,
        routing: ctx.creditorRouting,
        bank: ctx.creditorBank,
      },
    }, null, 2);
  }
  if (protocol === 'iso20022_xml') {
    return ISO20022 ? ISO20022.generatePain001({
      paymentId: ctx.referenceId,
      amount: ctx.dollars,
      currency: ctx.currency,
      debtorName: ctx.debtorName,
      debtorAccount: ctx.debtorAccount,
      debtorBic: ctx.debtorRouting,
      creditorName: ctx.creditorName,
      creditorAccount: ctx.creditorAccount,
      creditorBic: ctx.creditorRouting,
      remittance: ctx.description,
    }) : buildSimplePain001(ctx);
  }
  if (protocol === 'rest_xml' || protocol === 'soap') {
    return buildSimpleXmlPayload(ctx);
  }
  return '';
}

function buildSimplePain001(ctx) {
  const docId = ctx.referenceId;
  const execDate = new Date().toISOString().slice(0, 10);
  const amt = Number(ctx.dollars || 0).toFixed(2);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${docId}</MsgId>
      <CreDtTm>${new Date().toISOString()}</CreDtTm>
      <NbOfTxs>1</NbOfTxs>
      <CtrlSum>${amt}</CtrlSum>
      <InitgPty><Nm>${escapeXml(ctx.debtorName)}</Nm></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${docId}-PI</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <BtchBookg>true</BtchBookg>
      <ReqdExctnDt>${execDate}</ReqdExctnDt>
      <Dbtr><Nm>${escapeXml(ctx.debtorName)}</Nm></Dbtr>
      <DbtrAcct><Id><Othr><Id>${escapeXml(ctx.debtorAccount)}</Id></Othr></Id></DbtrAcct>
      <DbtrAgt><FinInstnId><ClrSysMmbId><MmbId>${escapeXml(ctx.debtorRouting || '')}</MmbId></ClrSysMmbId></FinInstnId></DbtrAgt>
      <CdtTrfTxInf>
        <PmtId><EndToEndId>${docId}</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="${ctx.currency}">${amt}</InstdAmt></Amt>
        <CdtrAgt><FinInstnId><ClrSysMmbId><MmbId>${escapeXml(ctx.creditorRouting || '')}</MmbId></ClrSysMmbId></FinInstnId></CdtrAgt>
        <Cdtr><Nm>${escapeXml(ctx.creditorName)}</Nm></Cdtr>
        <CdtrAcct><Id><Othr><Id>${escapeXml(ctx.creditorAccount)}</Id></Othr></Id></CdtrAcct>
        <RmtInf><Ustrd>${escapeXml(ctx.description || 'Payment')}</Ustrd></RmtInf>
      </CdtTrfTxInf>
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>`;
}

function buildSimpleXmlPayload(ctx) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Payment>
  <ReferenceId>${escapeXml(ctx.referenceId)}</ReferenceId>
  <Amount>${Number(ctx.dollars || 0).toFixed(2)}</Amount>
  <Currency>${escapeXml(ctx.currency)}</Currency>
  <Type>${escapeXml(ctx.paymentType)}</Type>
  <Description>${escapeXml(ctx.description)}</Description>
  <Debtor>
    <Name>${escapeXml(ctx.debtorName)}</Name>
    <Account>${escapeXml(ctx.debtorAccount)}</Account>
    <Routing>${escapeXml(ctx.debtorRouting)}</Routing>
    <Bank>${escapeXml(ctx.debtorBank)}</Bank>
  </Debtor>
  <Creditor>
    <Name>${escapeXml(ctx.creditorName)}</Name>
    <Account>${escapeXml(ctx.creditorAccount)}</Account>
    <Routing>${escapeXml(ctx.creditorRouting)}</Routing>
    <Bank>${escapeXml(ctx.creditorBank)}</Bank>
  </Creditor>
</Payment>`;
}

function resolveStatusFromResponse(endpoint, response) {
  const sc = response.statusCode || 0;
  if (sc >= 200 && sc < 300) {
    if (endpoint.response_success_path && response.json) {
      const parts = endpoint.response_success_path.split('.');
      let val = response.json;
      for (const p of parts) { val = val == null ? undefined : val[p]; }
      if (val !== true && val !== 'success' && val !== 'approved' && val !== 'settled') {
        return { status: 'failed', error: `Unexpected response: ${JSON.stringify(val).slice(0, 100)}` };
      }
    }
    return { status: 'originated' };
  }
  if (sc === 202) return { status: 'originated', error: null };
  if (sc === 401 || sc === 403) return { status: 'failed', error: `Auth failed (${sc})` };
  return { status: 'failed', error: `Endpoint returned ${sc}: ${response.body.slice(0, 200)}` };
}

class ExternalEndpointEngine {
  static async ensureTables() {
    if (!pool) throw new Error('Database pool not available');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS external_endpoints (
        endpoint_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL DEFAULT 'rest_json' CHECK (protocol IN ('rest_json','rest_xml','soap','iso20022_xml','grpc','mft_sftp','as2','manual')),
        base_url TEXT NOT NULL,
        auth_type TEXT NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none','bearer','basic','api_key','lili','hmac')),
        api_key TEXT DEFAULT '',
        api_secret TEXT DEFAULT '',
        extra_headers JSONB DEFAULT '{}',
        payload_template TEXT DEFAULT '',
        response_success_path TEXT DEFAULT '',
        enabled BOOLEAN NOT NULL DEFAULT true,
        config JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS external_endpoint_payments (
        payment_id TEXT PRIMARY KEY,
        endpoint_id TEXT REFERENCES external_endpoints(endpoint_id),
        source_type TEXT,
        source_account_id TEXT,
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        debtor_name TEXT,
        debtor_account TEXT,
        debtor_routing TEXT,
        debtor_bank TEXT,
        creditor_name TEXT,
        creditor_account TEXT,
        creditor_routing TEXT,
        creditor_bank TEXT,
        payment_type TEXT,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','originated','completed','failed','manual_pending','queued')),
        external_id TEXT,
        raw_request TEXT,
        raw_response TEXT,
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await this._ensureHoldAccounts();
  }

  static async _ensureHoldAccounts() {
    if (!CashEngine) return;
    for (const [id, name] of [[HOLD_ACCOUNT, 'External Endpoint Hold'], [SETTLED_ACCOUNT, 'External Endpoint Settled']]) {
      try {
        const existing = await CashEngine.getAccount(id);
        if (existing) continue;
        await CashEngine.createAccount({ accountId: id, accountName: name, accountType: 'escrow', notes: 'External Endpoint Engine clearing' });
      } catch (e) { console.warn('[external-endpoint] hold account:', e.message); }
    }
  }

  static _cleanEndpointRow(row) {
    if (!row) return row;
    const out = { ...row };
    if (out.api_key) out.api_key = maskSecret(out.api_key);
    if (out.api_secret) out.api_secret = maskSecret(out.api_secret);
    return out;
  }

  static async createEndpoint(opts = {}) {
    await this.ensureTables();
    const {
      name, protocol = 'rest_json', baseUrl, authType = 'none',
      apiKey = '', apiSecret = '', extraHeaders = {}, payloadTemplate = '',
      responseSuccessPath = '', enabled = true, config = {},
    } = opts;
    if (!name) throw new Error('name is required');
    if (!baseUrl) throw new Error('baseUrl is required');
    const id = generateId('EPT');
    const res = await pool.query(
      `INSERT INTO external_endpoints (endpoint_id, name, protocol, base_url, auth_type, api_key, api_secret, extra_headers, payload_template, response_success_path, enabled, config)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [id, name, protocol, baseUrl, authType, apiKey, apiSecret, JSON.stringify(extraHeaders), payloadTemplate, responseSuccessPath, enabled, JSON.stringify(config)]
    );
    return this._cleanEndpointRow(res.rows[0]);
  }

  static async listEndpoints({ enabled } = {}) {
    await this.ensureTables();
    let q = `SELECT * FROM external_endpoints ORDER BY created_at DESC`;
    const params = [];
    if (enabled != null) {
      q = `SELECT * FROM external_endpoints WHERE enabled = $1 ORDER BY created_at DESC`;
      params.push(enabled);
    }
    const res = await pool.query(q, params);
    return res.rows.map(r => this._cleanEndpointRow(r));
  }

  static async getEndpoint(endpointId) {
    await this.ensureTables();
    const res = await pool.query(`SELECT * FROM external_endpoints WHERE endpoint_id = $1`, [endpointId]);
    return this._cleanEndpointRow(res.rows[0] || null);
  }

  static async getEndpointWithSecrets(endpointId) {
    await this.ensureTables();
    const res = await pool.query(`SELECT * FROM external_endpoints WHERE endpoint_id = $1`, [endpointId]);
    return res.rows[0] || null;
  }

  static async updateEndpoint(endpointId, updates = {}) {
    await this.ensureTables();
    const allowed = ['name','protocol','base_url','auth_type','api_key','api_secret','extra_headers','payload_template','response_success_path','enabled','config'];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (updates[k] !== undefined) {
        sets.push(`${k} = $${sets.length + 1}`);
        vals.push(k === 'extra_headers' || k === 'config' ? JSON.stringify(updates[k]) : updates[k]);
      }
    }
    if (!sets.length) throw new Error('No updates provided');
    sets.push(`updated_at = NOW()`);
    vals.push(endpointId);
    const res = await pool.query(`UPDATE external_endpoints SET ${sets.join(', ')} WHERE endpoint_id = $${vals.length} RETURNING *`, vals);
    return this._cleanEndpointRow(res.rows[0]);
  }

  static async deleteEndpoint(endpointId) {
    await this.ensureTables();
    await pool.query(`DELETE FROM external_endpoints WHERE endpoint_id = $1`, [endpointId]);
    return { deleted: true };
  }

  static async testConnection(endpointId) {
    const endpoint = await this.getEndpointWithSecrets(endpointId);
    if (!endpoint) throw new Error('Endpoint not found');
    if (!endpoint.enabled) throw new Error('Endpoint disabled');

    const url = renderTemplate(endpoint.base_url, { timestamp: new Date().toISOString() });
    const ctx = { referenceId: generateId('TEST'), dollars: '0.01', currency: 'USD', timestamp: new Date().toISOString() };
    const headers = buildAuthHeaders(endpoint, ctx);
    try {
      const res = await httpRequest({ url, method: 'GET', headers, timeoutMs: 15000 });
      return { connected: res.statusCode < 400, statusCode: res.statusCode, bodyPreview: res.body.slice(0, 200) };
    } catch (err) {
      return { connected: false, error: err.message };
    }
  }

  static async createPayment(opts = {}) {
    await this.ensureTables();
    const {
      endpointId, sourceType, sourceAccountId, amount, currency = 'USD',
      debtorName, debtorAccount, debtorRouting, debtorBank,
      creditorName, creditorAccount, creditorRouting, creditorBank,
      paymentType = 'external_payment', description,
    } = opts;
    if (!endpointId) throw new Error('endpointId is required');
    const endpoint = await this.getEndpoint(endpointId);
    if (!endpoint) throw new Error('Endpoint not found');
    const cents = toCents(amount);
    if (cents <= 0) throw new Error('amount must be positive');

    const paymentId = generateId('EEP');
    await pool.query(
      `INSERT INTO external_endpoint_payments (payment_id, endpoint_id, source_type, source_account_id, amount_cents, currency, debtor_name, debtor_account, debtor_routing, debtor_bank, creditor_name, creditor_account, creditor_routing, creditor_bank, payment_type, description, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [paymentId, endpointId, sourceType || null, sourceAccountId || null, cents, currency,
       debtorName || null, debtorAccount || null, debtorRouting || null, debtorBank || null,
       creditorName || null, creditorAccount || null, creditorRouting || null, creditorBank || null,
       paymentType, description || null, 'pending']
    );
    return { paymentId, endpointId, status: 'pending', endpoint: this._cleanEndpointRow(endpoint) };
  }

  static async getPayment(paymentId) {
    await this.ensureTables();
    const res = await pool.query(`SELECT * FROM external_endpoint_payments WHERE payment_id = $1`, [paymentId]);
    return res.rows[0] || null;
  }

  static async listPayments({ endpointId, status, limit = 100 } = {}) {
    await this.ensureTables();
    const conditions = [];
    const params = [];
    if (endpointId) { conditions.push(`endpoint_id = $${params.length + 1}`); params.push(endpointId); }
    if (status) { conditions.push(`status = $${params.length + 1}`); params.push(status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const res = await pool.query(`SELECT * FROM external_endpoint_payments ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return res.rows;
  }

  static async sendPayment(paymentId) {
    await this.ensureTables();
    const paymentRow = await pool.query(`SELECT * FROM external_endpoint_payments WHERE payment_id = $1`, [paymentId]);
    const payment = paymentRow.rows[0];
    if (!payment) throw new Error('Payment not found');
    if (payment.status !== 'pending') throw new Error(`Payment already ${payment.status}`);

    const endpoint = await this.getEndpointWithSecrets(payment.endpoint_id);
    if (!endpoint) throw new Error('Endpoint not found');
    if (!endpoint.enabled) throw new Error('Endpoint disabled');

    const dollars = (payment.amount_cents / 100).toFixed(2);
    const ctx = {
      referenceId: payment.payment_id,
      dollars,
      cents: payment.amount_cents,
      currency: payment.currency,
      paymentType: payment.payment_type,
      description: payment.description || `External payment ${payment.payment_id}`,
      debtorName: payment.debtor_name || 'DLB Trust',
      debtorAccount: payment.debtor_account || '',
      debtorRouting: payment.debtor_routing || '',
      debtorBank: payment.debtor_bank || '',
      creditorName: payment.creditor_name || '',
      creditorAccount: payment.creditor_account || '',
      creditorRouting: payment.creditor_routing || '',
      creditorBank: payment.creditor_bank || '',
      timestamp: new Date().toISOString(),
    };

    let reserved = false;
    if (CashEngine && payment.source_account_id) {
      await this._ensureHoldAccounts();
      try {
        await CashEngine.transfer({
          fromAccountId: payment.source_account_id,
          toAccountId: HOLD_ACCOUNT,
          amountCents: payment.amount_cents,
          movementType: 'transfer',
          memo: `Reserve external payment ${paymentId}`,
          referenceId: paymentId,
          referenceType: 'external_endpoint',
        });
        reserved = true;
      } catch (e) {
        console.warn('[external-endpoint] reserve failed:', e.message);
        throw new Error(`Reserve failed: ${e.message}`);
      }
    }

    if (endpoint.protocol === 'manual') {
      await pool.query(`UPDATE external_endpoint_payments SET status = 'manual_pending', raw_request = $2, updated_at = NOW() WHERE payment_id = $1`, [paymentId, JSON.stringify(ctx)]);
      return { paymentId, endpointId: payment.endpoint_id, status: 'manual_pending' };
    }

    if (['grpc','mft_sftp','as2'].includes(endpoint.protocol)) {
      await pool.query(`UPDATE external_endpoint_payments SET status = 'queued', raw_request = $2, updated_at = NOW() WHERE payment_id = $1`, [paymentId, JSON.stringify(ctx)]);
      return { paymentId, endpointId: payment.endpoint_id, status: 'queued', note: `${endpoint.protocol} transmission not yet implemented` };
    }

    let payload;
    if (endpoint.payload_template) {
      payload = renderTemplate(endpoint.payload_template, ctx);
    } else {
      payload = buildDefaultPayload(endpoint, ctx);
    }

    const headers = buildAuthHeaders(endpoint, { ...ctx, body: payload });
    if (endpoint.protocol === 'rest_json' || endpoint.protocol === 'rest') {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    } else if (endpoint.protocol === 'iso20022_xml' || endpoint.protocol === 'rest_xml') {
      headers['Content-Type'] = headers['Content-Type'] || 'application/xml';
    } else if (endpoint.protocol === 'soap') {
      headers['Content-Type'] = headers['Content-Type'] || 'text/xml; charset=utf-8';
    }

    const method = (endpoint.config && endpoint.config.method) || 'POST';
    const url = renderTemplate(endpoint.base_url, ctx);
    let response;
    let errorMessage = null;
    let status = 'failed';
    let externalId = null;

    try {
      response = await httpRequest({ url, method, headers, body: payload, timeoutMs: 120000 });
    } catch (err) {
      errorMessage = `Request failed: ${err.message}`;
      status = 'failed';
    }

    if (response) {
      const resolved = resolveStatusFromResponse(endpoint, response);
      status = resolved.status;
      errorMessage = resolved.error || null;
      if (response.json && response.json.id) externalId = response.json.id;
      else if (response.json && response.json.payment_id) externalId = response.json.payment_id;
      else if (response.json && response.json.transaction_id) externalId = response.json.transaction_id;
    }

    if (status === 'originated' && externalId) {
      status = 'completed';
    } else if (status === 'originated' && !externalId) {
      status = 'manual_pending';
    }

    await pool.query(
      `UPDATE external_endpoint_payments SET status = $1, external_id = $2, raw_request = $3, raw_response = $4, error_message = $5, updated_at = NOW() WHERE payment_id = $6`,
      [status, externalId, payload, response ? JSON.stringify({ statusCode: response.statusCode, headers: response.headers, body: response.body }) : null, errorMessage, paymentId]
    );

    if (status === 'completed' && CashEngine) {
      try {
        await CashEngine.transfer({
          fromAccountId: HOLD_ACCOUNT,
          toAccountId: SETTLED_ACCOUNT,
          amountCents: payment.amount_cents,
          movementType: 'transfer',
          memo: `External endpoint settle ${paymentId}`,
          referenceId: externalId || paymentId,
          referenceType: 'external_endpoint',
        });
      } catch (e) { console.warn('[external-endpoint] settle ledger movement skipped:', e.message); }
    } else if (reserved && (status === 'failed' || status === 'manual_pending')) {
      try {
        await CashEngine.transfer({
          fromAccountId: HOLD_ACCOUNT,
          toAccountId: payment.source_account_id,
          amountCents: payment.amount_cents,
          movementType: 'transfer',
          memo: `Refund external payment ${paymentId}`,
          referenceId: paymentId,
          referenceType: 'external_endpoint',
        });
      } catch (e) { console.warn('[external-endpoint] refund failed:', e.message); }
    }

    return { paymentId, endpointId: payment.endpoint_id, status, externalId, errorMessage };
  }

  static async executePayment(opts = {}) {
    const created = await this.createPayment(opts);
    return await this.sendPayment(created.paymentId);
  }
}

module.exports = { ExternalEndpointEngine };
