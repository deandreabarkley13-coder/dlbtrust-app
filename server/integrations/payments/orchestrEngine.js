'use strict';

/**
 * Orchestr Payment Engine
 *
 * Server-side integration for the Orchestr (TESS/MontyPay style) payment API:
 *   - Hosted checkout session creation (JSON → CHECKOUT_URL/api/v1/session)
 *   - Server-to-server payments (form-urlencoded → PAYMENT_URL)
 *   - Payouts via CREDIT2VIRTUAL to bank accounts
 *   - Refunds, voids, status checks, and callback validation
 *
 * Credentials are read from environment variables and are never committed.
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

let pg;
try { pg = require('../bonds/pgPool'); } catch (e) { pg = null; }

const TABLE = 'orchestr_transactions';

function generateId(prefix = 'ORCH') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

function formatAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) throw new Error('amount must be a non-negative number');
  return n.toFixed(2);
}

function safeJson(obj) {
  try { return JSON.stringify(obj || {}, (k, v) => typeof v === 'bigint' ? String(v) : v); } catch { return '{}'; }
}

function sha1Hex(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

function md5Hex(s) {
  return crypto.createHash('md5').update(String(s)).digest('hex');
}

function strReverse(s) {
  return String(s).split('').reverse().join('');
}

function getEnv(name) {
  return process.env[name] || null;
}

function getConfig() {
  const checkoutUrl = getEnv('ORCHESTR_CHECKOUT_URL');
  const paymentUrl = getEnv('ORCHESTR_PAYMENT_URL');
  const merchantKey = getEnv('ORCHESTR_MERCHANT_KEY');
  const password = getEnv('ORCHESTR_PASSWORD');
  if (!checkoutUrl && !paymentUrl) return null;
  if (!merchantKey || !password) return null;
  return { checkoutUrl, paymentUrl, merchantKey, password };
}

class OrchestrEngine {
  static isConfigured() {
    return !!getConfig();
  }

  static async ensureTables() {
    if (!pg || !pg.query) return;
    await pg.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id SERIAL PRIMARY KEY,
        orchestr_tx_id TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('checkout','s2s','callback')),
        action TEXT,
        order_id TEXT,
        external_id TEXT,
        amount_cents BIGINT,
        currency TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        raw_request JSONB DEFAULT '{}',
        raw_response JSONB DEFAULT '{}',
        metadata JSONB DEFAULT '{}',
        initiated_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pg.query(`CREATE INDEX IF NOT EXISTS idx_orchestr_order ON ${TABLE}(order_id)`);
    await pg.query(`CREATE INDEX IF NOT EXISTS idx_orchestr_external ON ${TABLE}(external_id)`);
    await pg.query(`CREATE INDEX IF NOT EXISTS idx_orchestr_status ON ${TABLE}(status)`);
  }

  static _hashCheckout({ orderNumber, amount, currency, description, password }) {
    const base = String(orderNumber) + String(amount) + String(currency) + String(description || '') + String(password);
    return sha1Hex(md5Hex(base.toUpperCase()));
  }

  static _hashS2S({ orderId, amount, currency, password }) {
    // md5(strtoupper(strrev(order_id . order_amount . order_currency)) . PASSWORD)
    const reversed = strReverse(String(orderId) + String(amount) + String(currency));
    return md5Hex(reversed.toUpperCase() + String(password));
  }

  static _hashStatus({ transId, password }) {
    return md5Hex(strReverse(String(transId)).toUpperCase() + String(password));
  }

  static _hashCallback({ transId, orderId, status, password }) {
    return md5Hex(strReverse(String(transId) + String(orderId) + String(status)).toUpperCase() + String(password));
  }

  static _httpPost({ url, body, contentType = 'application/x-www-form-urlencoded', timeout = 30000 }) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const client = parsed.protocol === 'https:' ? https : http;
      const postData = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf8');
      const req = client.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Content-Length': postData.length,
        },
        timeout,
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* leave raw */ }
          resolve({ statusCode: res.statusCode, body: data, json });
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
      req.write(postData);
      req.end();
    });
  }

  static _mapStatus(result, status) {
    const r = String(result || '').toUpperCase();
    const s = String(status || '').toUpperCase();
    if (r === 'SUCCESS' && (s === 'SETTLED' || s === 'SUCCESS')) return 'completed';
    if (['ACCEPTED', 'INIT', 'REDIRECT', 'PENDING', 'PREPARE'].includes(r)) return 'pending';
    if (['DECLINED', 'ERROR', 'FAIL'].includes(r)) return 'failed';
    if (s === 'SETTLED' || s === 'SUCCESS') return 'completed';
    if (s === 'DECLINED') return 'failed';
    return 'pending';
  }

  static async _insert(tx) {
    if (!pg || !pg.query) return;
    const cols = Object.keys(tx).filter(k => tx[k] !== undefined).join(',');
    const vals = Object.keys(tx).map((_, i) => `$${i + 1}`).join(',');
    await pg.query(`INSERT INTO ${TABLE} (${cols}) VALUES (${vals})`, Object.values(tx));
  }

  static async _update(txId, fields) {
    if (!pg || !pg.query) return;
    const keys = Object.keys(fields).filter(k => fields[k] !== undefined);
    if (!keys.length) return;
    const set = keys.map((k, i) => `${k}=$${i + 1}`).join(',');
    await pg.query(`UPDATE ${TABLE} SET ${set}, updated_at=NOW() WHERE orchestr_tx_id=$${keys.length + 1}`, [...Object.values(fields), txId]);
  }

  static async createCheckoutSession({
    amount,
    currency = 'USD',
    orderNumber,
    description,
    successUrl,
    cancelUrl,
    expiryUrl,
    methods,
    operation = 'purchase',
    sessionExpiry = 60,
    customer,
    billingAddress,
    cardToken,
    reqToken = false,
    recurringInit = false,
    initiatedBy,
    metadata = {},
  } = {}) {
    const cfg = getConfig();
    if (!cfg || !cfg.checkoutUrl) throw new Error('ORCHESTR_CHECKOUT_URL not configured');

    const orderId = orderNumber || generateId('ORCH-ORDER');
    const amountStr = formatAmount(amount);
    const currencyStr = String(currency).toUpperCase();
    const desc = description || `PTC checkout ${orderId}`;
    const hash = this._hashCheckout({ orderNumber: orderId, amount: amountStr, currency: currencyStr, description: desc, password: cfg.password });

    const payload = {
      merchant_key: cfg.merchantKey,
      operation,
      methods: Array.isArray(methods) ? methods : ['card'],
      session_expiry: sessionExpiry,
      order: {
        number: orderId,
        amount: amountStr,
        currency: currencyStr,
        description: desc,
      },
      cancel_url: cancelUrl || `${process.env.PUBLIC_APP_URL || ''}/payment/orchestr/cancel`,
      success_url: successUrl || `${process.env.PUBLIC_APP_URL || ''}/payment/orchestr/success`,
      hash,
    };

    if (expiryUrl) payload.expiry_url = expiryUrl;
    if (customer) payload.customer = customer;
    if (billingAddress) payload.billing_address = billingAddress;
    if (cardToken) payload.card_token = Array.isArray(cardToken) ? cardToken : [cardToken];
    if (reqToken) payload.req_token = true;
    if (recurringInit) payload.recurring_init = true;

    const txId = generateId('ORCH-CK');
    await this._insert({
      orchestr_tx_id: txId,
      type: 'checkout',
      action: operation,
      order_id: orderId,
      amount_cents: toCents(amount),
      currency: currencyStr,
      status: 'pending',
      raw_request: safeJson(payload),
      metadata: safeJson(metadata),
      initiated_by: initiatedBy || 'system',
    });

    const response = await this._httpPost({
      url: `${cfg.checkoutUrl.replace(/\/$/, '')}/api/v1/session`,
      body: JSON.stringify(payload),
      contentType: 'application/json',
    });

    const parsed = response.json || { raw: response.body };
    const mappedStatus = parsed.redirect_url ? 'pending' : 'failed';
    await this._update(txId, { status: mappedStatus, raw_response: safeJson(parsed) });

    return {
      orchestrTxId: txId,
      orderId,
      redirectUrl: parsed.redirect_url || null,
      paymentId: parsed.payment_id || null,
      status: mappedStatus,
      raw: parsed,
    };
  }

  static _buildParameters(destination = {}) {
    const params = {};
    const fieldMap = {
      country: 'country_code',
      countryCode: 'country_code',
      userName: 'user_name',
      customerName: 'user_name',
      name: 'account_name',
      accountName: 'account_name',
      accountNumber: 'account_number',
      bankName: 'bank_name',
      bankIfsc: 'bank_ifsc',
      ifsc: 'bank_ifsc',
      bankBranch: 'bank_branch',
      branch: 'bank_branch',
      bankAddress: 'bank_address',
      address: 'bank_address',
      routingNumber: 'routing_number',
      routing: 'routing_number',
      accountType: 'account_type',
      swift: 'swift_code',
      swiftCode: 'swift_code',
      iban: 'iban',
    };
    for (const [key, value] of Object.entries(destination)) {
      if (value === undefined || value === null) continue;
      if (['brand', 'type', 'card', 'processor', 'metadata'].includes(key)) continue;
      const mapped = fieldMap[key] || key;
      params[mapped] = value;
    }
    return params;
  }

  static async sale({
    action,
    amount,
    currency = 'USD',
    orderNumber,
    description,
    brand,
    identifier,
    channelId,
    parameters,
    card,
    customer,
    returnUrl,
    destination,
    initiatedBy,
    metadata = {},
  } = {}) {
    const cfg = getConfig();
    if (!cfg || !cfg.paymentUrl) throw new Error('ORCHESTR_PAYMENT_URL not configured');

    const orderId = orderNumber || generateId('ORCH-ORDER');
    const amountStr = formatAmount(amount);
    const currencyStr = String(currency).toUpperCase();
    const desc = description || `PTC ${orderId}`;

    const hasCard = card && (card.number || card.token);
    const hasBank = destination && (destination.accountNumber || destination.account_number || destination.iban);

    let act = action ? String(action).toUpperCase() : null;
    if (!act) {
      if (hasBank) act = 'CREDIT2VIRTUAL';
      else act = 'SALE';
    }

    const form = {
      action: act,
      client_key: cfg.merchantKey,
      order_id: orderId,
      order_amount: amountStr,
      order_currency: currencyStr,
      order_description: desc,
      identifier: identifier || orderId,
    };

    if (channelId) form.channel_id = channelId;

    // Card SALE fields
    if (act === 'SALE' || hasCard) {
      if (!form.brand) form.brand = brand || 'default';
      if (card && (card.number || card.cardNumber)) form.card_number = card.number || card.cardNumber;
      if (card && (card.expMonth || card.exp_month)) form.card_exp_month = card.expMonth || card.exp_month;
      if (card && (card.expYear || card.exp_year || card.card_exp_year)) form.card_exp_year = card.expYear || card.exp_year || card.card_exp_year;
      if (card && (card.cvv || card.cvv2 || card.cvc)) form.card_cvv2 = card.cvv || card.cvv2 || card.cvc;
      if (card && card.token) form.card_token = card.token;
      if (customer && customer.email) form.payer_email = customer.email;
      if (customer && customer.firstName) form.payer_first_name = customer.firstName;
      if (customer && customer.lastName) form.payer_last_name = customer.lastName;
      if (customer && customer.phone) form.payer_phone = customer.phone;
      if (customer && customer.ip) form.payer_ip = customer.ip;
      if (returnUrl) form.return_url = returnUrl;
    }

    // CREDIT2VIRTUAL / bank payout fields
    if (act === 'CREDIT2VIRTUAL' || hasBank) {
      form.brand = brand || destination.brand || 'netbanking-upi';
      const params = parameters || this._buildParameters(destination);
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) form[`parameters[${k}]`] = v;
      }
    }

    form.hash = this._hashS2S({ orderId, amount: amountStr, currency: currencyStr, password: cfg.password });

    const txId = generateId('ORCH-S2S');
    await this._insert({
      orchestr_tx_id: txId,
      type: 's2s',
      action: act,
      order_id: orderId,
      amount_cents: toCents(amount),
      currency: currencyStr,
      status: 'pending',
      raw_request: safeJson(form),
      metadata: safeJson(metadata),
      initiated_by: initiatedBy || 'system',
    });

    const response = await this._httpPost({
      url: cfg.paymentUrl,
      body: new URLSearchParams(form).toString(),
      contentType: 'application/x-www-form-urlencoded',
    });

    const parsed = response.json || this._parseFormBody(response.body);
    const mapped = this._mapStatus(parsed.result, parsed.status);
    await this._update(txId, {
      status: mapped,
      external_id: parsed.trans_id || parsed.payment_id || null,
      raw_response: safeJson(parsed),
    });

    return {
      orchestrTxId: txId,
      orderId,
      status: mapped,
      transId: parsed.trans_id || null,
      paymentId: parsed.payment_id || null,
      result: parsed.result || null,
      raw: parsed,
    };
  }

  static _parseFormBody(body) {
    const out = {};
    if (!body || typeof body !== 'string') return out;
    const params = new URLSearchParams(body);
    for (const [k, v] of params.entries()) out[k] = v;
    return out;
  }

  static async getStatus({ transId, orderId, initiatedBy } = {}) {
    const cfg = getConfig();
    if (!cfg || !cfg.paymentUrl) throw new Error('ORCHESTR_PAYMENT_URL not configured');
    if (!transId) throw new Error('transId is required');

    const form = {
      action: 'GET_TRANS_STATUS',
      client_key: cfg.merchantKey,
      trans_id: transId,
      hash: this._hashStatus({ transId, password: cfg.password }),
    };

    const response = await this._httpPost({
      url: cfg.paymentUrl,
      body: new URLSearchParams(form).toString(),
      contentType: 'application/x-www-form-urlencoded',
    });

    const parsed = response.json || this._parseFormBody(response.body);
    return {
      transId,
      orderId: parsed.order_id || orderId || null,
      status: this._mapStatus(parsed.result, parsed.status),
      result: parsed.result || null,
      raw: parsed,
    };
  }

  static async refund({ transId, amount, orderNumber, currency = 'USD', initiatedBy } = {}) {
    return this._modification({
      action: 'CREDITVOID',
      transId,
      amount,
      orderNumber,
      currency,
      initiatedBy,
    });
  }

  static async void({ transId, amount, orderNumber, currency = 'USD', initiatedBy } = {}) {
    return this._modification({
      action: 'VOID',
      transId,
      amount,
      orderNumber,
      currency,
      initiatedBy,
    });
  }

  static async _modification({ action, transId, amount, orderNumber, currency, initiatedBy }) {
    const cfg = getConfig();
    if (!cfg || !cfg.paymentUrl) throw new Error('ORCHESTR_PAYMENT_URL not configured');
    if (!transId) throw new Error('transId is required');

    const orderId = orderNumber || generateId('ORCH-ORDER');
    const amountStr = amount !== undefined ? formatAmount(amount) : '0.00';
    const currencyStr = String(currency).toUpperCase();

    const form = {
      action,
      client_key: cfg.merchantKey,
      trans_id: transId,
      order_id: orderId,
      order_amount: amountStr,
      order_currency: currencyStr,
      hash: this._hashS2S({ orderId, amount: amountStr, currency: currencyStr, password: cfg.password }),
    };

    const txId = generateId(`ORCH-${action}`);
    await this._insert({
      orchestr_tx_id: txId,
      type: 's2s',
      action,
      order_id: orderId,
      external_id: transId,
      amount_cents: toCents(amount || 0),
      currency: currencyStr,
      status: 'pending',
      raw_request: safeJson(form),
      initiated_by: initiatedBy || 'system',
    });

    const response = await this._httpPost({
      url: cfg.paymentUrl,
      body: new URLSearchParams(form).toString(),
      contentType: 'application/x-www-form-urlencoded',
    });

    const parsed = response.json || this._parseFormBody(response.body);
    const mapped = this._mapStatus(parsed.result, parsed.status);
    await this._update(txId, { status: mapped, raw_response: safeJson(parsed) });

    return { orchestrTxId: txId, orderId, transId, status: mapped, raw: parsed };
  }

  static validateCallback(payload) {
    const cfg = getConfig();
    if (!cfg) throw new Error('Orchestr not configured');

    const data = payload || {};
    const expected = this._hashCallback({
      transId: data.trans_id,
      orderId: data.order_id,
      status: data.status,
      password: cfg.password,
    });
    const valid = expected === String(data.hash || '');
    return { valid, expected, received: data.hash || null, data };
  }

  static async list({ limit = 50, status, type } = {}) {
    if (!pg || !pg.query) return [];
    const conditions = [];
    const params = [];
    if (status) { conditions.push('status = $' + (params.length + 1)); params.push(status); }
    if (type) { conditions.push('type = $' + (params.length + 1)); params.push(type); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await pg.query(`SELECT * FROM ${TABLE} ${where} ORDER BY created_at DESC LIMIT $${params.length + 1}`, [...params, limit]);
    return res.rows;
  }

  static async get(id) {
    if (!pg || !pg.query) return null;
    const res = await pg.query(`SELECT * FROM ${TABLE} WHERE orchestr_tx_id=$1`, [id]);
    return res.rows[0] || null;
  }
}

module.exports = { OrchestrEngine };
