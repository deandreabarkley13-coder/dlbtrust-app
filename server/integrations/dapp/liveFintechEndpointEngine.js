'use strict';

/**
 * Live FinTech Endpoint Engine
 *
 * Purpose-built adapter for live fintech/bank payment APIs (Column, Increase,
 * Lili, Mercury, Plaid, Wise, Stripe, Spritz, Cash App, Skrill, etc.).
 *
 * Each endpoint is registered with a provider type, live URL, credentials, and
 * optional payload/response mapping. The engine then builds the provider-specific
 * outbound request, sends it, and reconciles the trust ledger.
 *
 * Like the External Endpoint Engine, this does NOT create sovereign money — it
 * needs a real fintech/bank account and valid credentials to move external cash.
 */

const crypto = require('crypto');
const {
  httpRequest,
  buildAuthHeaders,
  renderTemplate,
  maskSecret,
  resolveStatusFromResponse,
} = require('./externalEndpointEngine');

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

let CashEngine;
try { ({ CashEngine } = require('../cash/cashEngine')); } catch (e) { CashEngine = null; }

let PaymentComplianceGate;
try { ({ PaymentComplianceGate } = require('../compliance/paymentComplianceGate')); } catch (e) { PaymentComplianceGate = null; }

const { adapterFromEndpoint: moneyGramAdapterFromEndpoint } = require('../payments/moneyGramAdapter');

const HOLD_ACCOUNT = 'LIVE_FINTECH_HOLD';
const SETTLED_ACCOUNT = 'LIVE_FINTECH_SETTLED';

const PROVIDERS = {
  generic: { label: 'Generic REST/JSON', method: 'POST' },
  column: { label: 'Column', method: 'POST' },
  increase: { label: 'Increase', method: 'POST' },
  lili: { label: 'Lili', method: 'POST' },
  mercury: { label: 'Mercury', method: 'POST' },
  plaid: { label: 'Plaid', method: 'POST' },
  wise: { label: 'Wise', method: 'POST' },
  stripe: { label: 'Stripe', method: 'POST' },
  spritz: { label: 'Spritz', method: 'POST' },
  cashapp: { label: 'Cash App', method: 'POST' },
  skrill: { label: 'Skrill', method: 'POST' },
  moneygram: { label: 'MoneyGram', method: 'POST' },
};

const PROVIDER_VALUES = Object.keys(PROVIDERS);
const AUTH_TYPES = ['none', 'bearer', 'basic', 'api_key', 'lili', 'hmac', 'oauth2_client_credentials'];
const sqlList = (vals) => vals.map((v) => `'${v}'`).join(',');

// Providers whose outbound payment is a multi-step partner flow (not the
// single-shot httpRequest path) and must clear the compliance gate first.
const GATED_PROVIDERS = new Set(['moneygram']);

function generateId(prefix = 'FTE') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function generatePaymentId() {
  return generateId('FTP');
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

function cleanEndpointRow(row) {
  if (!row) return row;
  const out = { ...row };
  if (out.api_key) out.api_key = maskSecret(out.api_key);
  if (out.api_secret) out.api_secret = maskSecret(out.api_secret);
  return out;
}

function buildGenericPayload(ctx, template) {
  if (template) return renderTemplate(template, ctx);
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

function buildColumnPayload(ctx) {
  return JSON.stringify({
    amount: ctx.cents,
    currency_code: ctx.currency,
    description: ctx.description || `Payment ${ctx.referenceId}`,
    counterparty: {
      name: ctx.creditorName,
      account_number: ctx.creditorAccount,
      routing_number: ctx.creditorRouting,
      account_type: 'checking',
    },
    reference: ctx.referenceId,
  }, null, 2);
}

function buildIncreasePayload(ctx, config) {
  return JSON.stringify({
    account_id: config.account_id || '',
    amount: ctx.cents,
    currency: ctx.currency,
    description: ctx.description || `ACH ${ctx.referenceId}`,
    destination_account_number: ctx.creditorAccount,
    destination_routing_number: ctx.creditorRouting,
    destination_account_type: 'checking',
    statement_descriptor: ctx.description ? ctx.description.slice(0, 16) : 'DLB Trust',
  }, null, 2);
}

function buildLiliPayload(ctx) {
  return JSON.stringify({
    amount: Number(ctx.dollars),
    currency: ctx.currency,
    description: ctx.description || `Transfer ${ctx.referenceId}`,
    toAccountNumber: ctx.creditorAccount,
    toRoutingNumber: ctx.creditorRouting,
    toBankName: ctx.creditorBank,
    reference: ctx.referenceId,
  }, null, 2);
}

function buildMercuryPayload(ctx) {
  return JSON.stringify({
    amount: Number(ctx.dollars),
    currency: ctx.currency,
    description: ctx.description || `Payment ${ctx.referenceId}`,
    recipient: {
      name: ctx.creditorName,
      account_number: ctx.creditorAccount,
      routing_number: ctx.creditorRouting,
      account_type: 'checking',
    },
    reference: ctx.referenceId,
  }, null, 2);
}

function buildPlaidPayload(ctx, config) {
  return JSON.stringify({
    amount: {
      currency: ctx.currency,
      value: ctx.dollars,
    },
    ach_class: 'ccd',
    description: ctx.description || `Payment ${ctx.referenceId}`,
    network: 'ACH',
    user: {
      legal_name: ctx.creditorName,
    },
    account_id: config.sender_account_id || '',
  }, null, 2);
}

function buildWisePayload(ctx, config) {
  return JSON.stringify({
    sourceCurrency: ctx.currency,
    targetCurrency: ctx.currency,
    targetAmount: Number(ctx.dollars),
    quoteUuid: config.quote_uuid || '',
    targetAccount: config.target_account || '',
    reference: ctx.referenceId,
    details: { reference: ctx.description || ctx.referenceId },
  }, null, 2);
}

function buildStripePayload(ctx, config) {
  return JSON.stringify({
    amount: ctx.cents,
    currency: ctx.currency.toLowerCase(),
    method: config.payout_method || 'standard',
    destination: config.destination || '',
    description: ctx.description || `Payout ${ctx.referenceId}`,
    statement_descriptor: 'DLB TRUST',
  }, null, 2);
}

function buildSpritzPayload(ctx, config) {
  return JSON.stringify({
    amount: Number(ctx.dollars),
    currency: ctx.currency,
    asset: config.asset || 'USDC',
    destination: {
      account_number: ctx.creditorAccount,
      routing_number: ctx.creditorRouting,
      account_name: ctx.creditorName,
    },
    reference: ctx.referenceId,
  }, null, 2);
}

function buildCashAppPayload(ctx) {
  return JSON.stringify({
    reference_id: ctx.referenceId,
    amount: {
      currency_code: ctx.currency,
      amount: Number(ctx.dollars),
    },
    note: ctx.description || `Payment ${ctx.referenceId}`,
    recipient: {
      $cashtag: ctx.creditorAccount || '',
      name: ctx.creditorName,
    },
  }, null, 2);
}

function buildSkrillPayload(ctx, config) {
  return JSON.stringify({
    pay_to_email: config.pay_to_email || ctx.creditorAccount,
    amount: Number(ctx.dollars),
    currency: ctx.currency,
    subject: ctx.description || `Payment ${ctx.referenceId}`,
    note: ctx.referenceId,
    action: 'prepare',
  }, null, 2);
}

function buildPayload(endpoint, ctx) {
  const { provider, payload_template: template, config = {} } = endpoint;
  if (template) return renderTemplate(template, ctx);
  switch (provider) {
    case 'column': return buildColumnPayload(ctx);
    case 'increase': return buildIncreasePayload(ctx, config);
    case 'lili': return buildLiliPayload(ctx);
    case 'mercury': return buildMercuryPayload(ctx);
    case 'plaid': return buildPlaidPayload(ctx, config);
    case 'wise': return buildWisePayload(ctx, config);
    case 'stripe': return buildStripePayload(ctx, config);
    case 'spritz': return buildSpritzPayload(ctx, config);
    case 'cashapp': return buildCashAppPayload(ctx);
    case 'skrill': return buildSkrillPayload(ctx, config);
    default: return buildGenericPayload(ctx, template);
  }
}

function extractExternalId(endpoint, response) {
  if (!response || !response.json) return null;
  const config = endpoint.config || {};
  const path = config.response_external_id_path || endpoint.response_external_id_path;
  if (path) {
    const parts = String(path).split('.');
    let val = response.json;
    for (const p of parts) { val = val == null ? undefined : val[p]; }
    if (val != null) return String(val);
  }
  const candidates = ['id', 'payment_id', 'transfer_id', 'transaction_id', 'reference', 'payout_id', 'ach_transfer_id'];
  for (const key of candidates) {
    if (response.json[key] != null) return String(response.json[key]);
  }
  return null;
}

function buildEndpointForAuth(endpoint) {
  return {
    api_key: endpoint.api_key,
    api_secret: endpoint.api_secret,
    auth_type: endpoint.auth_type,
    extra_headers: endpoint.extra_headers || {},
  };
}

class LiveFinTechEndpointEngine {
  static get providers() {
    return PROVIDERS;
  }

  static async ensureTables() {
    if (!pool) throw new Error('Database pool not available');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS live_fintech_endpoints (
        endpoint_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN (${sqlList(PROVIDER_VALUES)})),
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        auth_type TEXT NOT NULL DEFAULT 'none' CHECK (auth_type IN (${sqlList(AUTH_TYPES)})),
        api_key TEXT DEFAULT '',
        api_secret TEXT DEFAULT '',
        extra_headers JSONB DEFAULT '{}',
        payload_template TEXT DEFAULT '',
        response_success_path TEXT DEFAULT '',
        response_external_id_path TEXT DEFAULT '',
        config JSONB DEFAULT '{}',
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS live_fintech_payments (
        payment_id TEXT PRIMARY KEY,
        endpoint_id TEXT REFERENCES live_fintech_endpoints(endpoint_id),
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
    if (!this._constraintsMigrated) {
      await pool.query(`ALTER TABLE live_fintech_endpoints DROP CONSTRAINT IF EXISTS live_fintech_endpoints_provider_check`);
      await pool.query(`ALTER TABLE live_fintech_endpoints ADD CONSTRAINT live_fintech_endpoints_provider_check CHECK (provider IN (${sqlList(PROVIDER_VALUES)}))`);
      await pool.query(`ALTER TABLE live_fintech_endpoints DROP CONSTRAINT IF EXISTS live_fintech_endpoints_auth_type_check`);
      await pool.query(`ALTER TABLE live_fintech_endpoints ADD CONSTRAINT live_fintech_endpoints_auth_type_check CHECK (auth_type IN (${sqlList(AUTH_TYPES)}))`);
      this._constraintsMigrated = true;
    }
    await this._ensureHoldAccounts();
  }

  static async _ensureHoldAccounts() {
    if (!CashEngine) return;
    for (const [id, name] of [[HOLD_ACCOUNT, 'Live FinTech Hold'], [SETTLED_ACCOUNT, 'Live FinTech Settled']]) {
      try {
        const existing = await CashEngine.getAccount(id);
        if (existing) continue;
        await CashEngine.createAccount({ accountId: id, accountName: name, accountType: 'escrow', notes: 'Live FinTech Endpoint Engine clearing' });
      } catch (e) { console.warn('[live-fintech] hold account:', e.message); }
    }
  }

  static async createEndpoint(opts = {}) {
    await this.ensureTables();
    const {
      provider = 'generic', name, baseUrl, authType = 'none',
      apiKey = '', apiSecret = '', extraHeaders = {},
      payloadTemplate = '', responseSuccessPath = '', responseExternalIdPath = '',
      enabled = true, config = {},
    } = opts;
    if (!name) throw new Error('name is required');
    if (!baseUrl) throw new Error('baseUrl is required');
    if (!PROVIDERS[provider]) throw new Error(`Unknown provider: ${provider}`);
    if (!AUTH_TYPES.includes(authType)) throw new Error(`Unknown authType: ${authType}`);
    if (provider === 'moneygram') {
      const hasId = apiKey || config.clientId || config.client_id;
      const hasSecret = apiSecret || config.clientSecret || config.client_secret;
      if (!hasId || !hasSecret) throw new Error('moneygram endpoints require a client id (apiKey/config.clientId) and client secret (apiSecret/config.clientSecret)');
    }
    const id = generateId('FTE');
    const res = await pool.query(
      `INSERT INTO live_fintech_endpoints (endpoint_id, provider, name, base_url, auth_type, api_key, api_secret, extra_headers, payload_template, response_success_path, response_external_id_path, config, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [id, provider, name, baseUrl, authType, apiKey, apiSecret, JSON.stringify(extraHeaders), payloadTemplate, responseSuccessPath, responseExternalIdPath, JSON.stringify(config), enabled]
    );
    return cleanEndpointRow(res.rows[0]);
  }

  static async listEndpoints({ enabled, provider } = {}) {
    await this.ensureTables();
    const conditions = [];
    const params = [];
    if (enabled != null) { conditions.push(`enabled = $${params.length + 1}`); params.push(enabled); }
    if (provider) { conditions.push(`provider = $${params.length + 1}`); params.push(provider); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await pool.query(`SELECT * FROM live_fintech_endpoints ${where} ORDER BY created_at DESC`, params);
    return res.rows.map(cleanEndpointRow);
  }

  static async getEndpoint(endpointId) {
    await this.ensureTables();
    const res = await pool.query(`SELECT * FROM live_fintech_endpoints WHERE endpoint_id = $1`, [endpointId]);
    return cleanEndpointRow(res.rows[0] || null);
  }

  static async getEndpointWithSecrets(endpointId) {
    await this.ensureTables();
    const res = await pool.query(`SELECT * FROM live_fintech_endpoints WHERE endpoint_id = $1`, [endpointId]);
    return res.rows[0] || null;
  }

  static async updateEndpoint(endpointId, updates = {}) {
    await this.ensureTables();
    const allowed = ['provider','name','base_url','auth_type','api_key','api_secret','extra_headers','payload_template','response_success_path','response_external_id_path','config','enabled'];
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
    const res = await pool.query(`UPDATE live_fintech_endpoints SET ${sets.join(', ')} WHERE endpoint_id = $${vals.length} RETURNING *`, vals);
    return cleanEndpointRow(res.rows[0]);
  }

  static async deleteEndpoint(endpointId) {
    await this.ensureTables();
    await pool.query(`DELETE FROM live_fintech_endpoints WHERE endpoint_id = $1`, [endpointId]);
    return { deleted: true };
  }

  static async testConnection(endpointId) {
    const endpoint = await this.getEndpointWithSecrets(endpointId);
    if (!endpoint) throw new Error('Endpoint not found');
    if (!endpoint.enabled) throw new Error('Endpoint disabled');

    const config = endpoint.config || {};
    const testPath = config.test_path || '';
    const url = renderTemplate(`${endpoint.base_url}${testPath}`, { timestamp: new Date().toISOString() });
    const ctx = { referenceId: generatePaymentId(), dollars: '0.01', currency: 'USD', timestamp: new Date().toISOString() };
    const headers = buildAuthHeaders(buildEndpointForAuth(endpoint), ctx);
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
      paymentType = 'fintech_payment', description,
    } = opts;
    if (!endpointId) throw new Error('endpointId is required');
    const endpoint = await this.getEndpoint(endpointId);
    if (!endpoint) throw new Error('Endpoint not found');
    const cents = toCents(amount);
    if (cents <= 0) throw new Error('amount must be positive');

    const paymentId = generatePaymentId();
    await pool.query(
      `INSERT INTO live_fintech_payments (payment_id, endpoint_id, source_type, source_account_id, amount_cents, currency, debtor_name, debtor_account, debtor_routing, debtor_bank, creditor_name, creditor_account, creditor_routing, creditor_bank, payment_type, description, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [paymentId, endpointId, sourceType || null, sourceAccountId || null, cents, currency,
       debtorName || null, debtorAccount || null, debtorRouting || null, debtorBank || null,
       creditorName || null, creditorAccount || null, creditorRouting || null, creditorBank || null,
       paymentType, description || null, 'pending']
    );
    return { paymentId, endpointId, status: 'pending', endpoint: cleanEndpointRow(endpoint) };
  }

  static async getPayment(paymentId) {
    await this.ensureTables();
    const res = await pool.query(`SELECT * FROM live_fintech_payments WHERE payment_id = $1`, [paymentId]);
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
    const res = await pool.query(`SELECT * FROM live_fintech_payments ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return res.rows;
  }

  static async sendPayment(paymentId) {
    await this.ensureTables();
    const paymentRow = await pool.query(`SELECT * FROM live_fintech_payments WHERE payment_id = $1`, [paymentId]);
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
      description: payment.description || `Live fintech payment ${payment.payment_id}`,
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

    if (GATED_PROVIDERS.has(endpoint.provider)) {
      await this._screenOutbound(payment, endpoint);
    }

    let reserved = false;
    if (CashEngine && payment.source_account_id) {
      await this._ensureHoldAccounts();
      try {
        await CashEngine.transfer({
          fromAccountId: payment.source_account_id,
          toAccountId: HOLD_ACCOUNT,
          amountCents: payment.amount_cents,
          movementType: 'transfer',
          memo: `Reserve live fintech payment ${paymentId}`,
          referenceId: paymentId,
          referenceType: 'live_fintech',
        });
        reserved = true;
      } catch (e) {
        throw new Error(`Reserve failed: ${e.message}`);
      }
    }

    if (endpoint.provider === 'moneygram') {
      return await this._sendMoneyGram({ payment, endpoint, ctx, reserved });
    }

    const payload = buildPayload(endpoint, ctx);
    const authEndpoint = buildEndpointForAuth(endpoint);
    const headers = buildAuthHeaders(authEndpoint, { ...ctx, body: payload });
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';

    const config = endpoint.config || {};
    const method = config.method || PROVIDERS[endpoint.provider]?.method || 'POST';
    const path = config.path || '';
    const url = renderTemplate(`${endpoint.base_url}${path}`, ctx);

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
      const ep = {
        response_success_path: endpoint.response_success_path,
        config: { response_success_path: config.response_success_path },
      };
      const resolved = resolveStatusFromResponse(ep, response);
      status = resolved.status;
      errorMessage = resolved.error || null;
      externalId = extractExternalId(endpoint, response);
    }

    if (status === 'originated' && externalId) status = 'completed';
    else if (status === 'originated' && !externalId) status = 'manual_pending';

    await pool.query(
      `UPDATE live_fintech_payments SET status = $1, external_id = $2, raw_request = $3, raw_response = $4, error_message = $5, updated_at = NOW() WHERE payment_id = $6`,
      [status, externalId, payload, response ? JSON.stringify({ statusCode: response.statusCode, headers: response.headers, body: response.body }) : null, errorMessage, paymentId]
    );

    if (status === 'completed' && CashEngine) {
      try {
        await CashEngine.transfer({
          fromAccountId: HOLD_ACCOUNT,
          toAccountId: SETTLED_ACCOUNT,
          amountCents: payment.amount_cents,
          movementType: 'transfer',
          memo: `Live fintech settle ${paymentId}`,
          referenceId: externalId || paymentId,
          referenceType: 'live_fintech',
        });
      } catch (e) { console.warn('[live-fintech] settle ledger movement skipped:', e.message); }
    } else if (reserved && (status === 'failed' || status === 'manual_pending')) {
      try {
        await CashEngine.transfer({
          fromAccountId: HOLD_ACCOUNT,
          toAccountId: payment.source_account_id,
          amountCents: payment.amount_cents,
          movementType: 'transfer',
          memo: `Refund live fintech payment ${paymentId}`,
          referenceId: paymentId,
          referenceType: 'live_fintech',
        });
      } catch (e) { console.warn('[live-fintech] refund failed:', e.message); }
    }

    return { paymentId, endpointId: payment.endpoint_id, status, externalId, errorMessage };
  }

  /**
   * KYC/AML/OFAC gate for partner disbursement rails. Throws a compliance
   * error (payment row stays `pending`, error_message recorded) so the
   * operator can retry once the block is cleared.
   */
  static async _screenOutbound(payment, endpoint) {
    const gate = this._complianceGate || PaymentComplianceGate;
    if (!gate) throw new Error('PaymentComplianceGate not available; refusing outbound partner payment');
    const config = endpoint.config || {};
    try {
      const screening = await gate.screenVendorPayment({
        vendor: {
          fullName: payment.creditor_name,
          email: config.receiverEmail || undefined,
          bankAccount: payment.creditor_account || undefined,
          routingNumber: payment.creditor_routing || undefined,
          country: config.receiveCountry || config.receive_country || 'US',
        },
        amount: payment.amount_cents / 100,
        sourceAccountId: payment.source_account_id,
        rail: endpoint.provider,
        action: 'execute',
        screenedBy: 'live_fintech',
        reference: payment.payment_id,
      });
      return screening;
    } catch (err) {
      await pool.query(
        `UPDATE live_fintech_payments SET error_message = $1, updated_at = NOW() WHERE payment_id = $2`,
        [`Compliance gate: ${err.message}`, payment.payment_id]
      );
      throw err;
    }
  }

  static _settleOrRefund({ payment, status, externalId, reserved }) {
    const paymentId = payment.payment_id;
    if (status === 'completed' && CashEngine) {
      return CashEngine.transfer({
        fromAccountId: HOLD_ACCOUNT,
        toAccountId: SETTLED_ACCOUNT,
        amountCents: payment.amount_cents,
        movementType: 'transfer',
        memo: `Live fintech settle ${paymentId}`,
        referenceId: externalId || paymentId,
        referenceType: 'live_fintech',
      }).catch((e) => console.warn('[live-fintech] settle ledger movement skipped:', e.message));
    }
    if (reserved && (status === 'failed' || status === 'manual_pending')) {
      return CashEngine.transfer({
        fromAccountId: HOLD_ACCOUNT,
        toAccountId: payment.source_account_id,
        amountCents: payment.amount_cents,
        movementType: 'transfer',
        memo: `Refund live fintech payment ${paymentId}`,
        referenceId: paymentId,
        referenceType: 'live_fintech',
      }).catch((e) => console.warn('[live-fintech] refund failed:', e.message));
    }
    return Promise.resolve();
  }

  /** quote → send → commit via MoneyGramAdapter; `reserved` cash already sits in HOLD_ACCOUNT. */
  static async _sendMoneyGram({ payment, endpoint, ctx, reserved }) {
    const paymentId = payment.payment_id;
    const config = endpoint.config || {};
    const nameParts = String(ctx.creditorName || '').trim().split(/\s+/);
    const receiver = {
      firstName: nameParts.length > 1 ? nameParts.slice(0, -1).join(' ') : nameParts[0] || '',
      lastName: nameParts.length > 1 ? nameParts[nameParts.length - 1] : '',
      fullName: ctx.creditorName,
      bankAccount: ctx.creditorAccount ? {
        accountNumber: ctx.creditorAccount,
        routingNumber: ctx.creditorRouting || undefined,
        bankName: ctx.creditorBank || undefined,
      } : undefined,
    };
    const sender = {
      businessName: ctx.debtorName || 'DLB Trust',
      ...(config.sender || {}),
    };

    let result;
    try {
      const adapter = moneyGramAdapterFromEndpoint(endpoint);
      result = await adapter.disburse({
        amount: Number(ctx.dollars),
        sourceCurrency: ctx.currency,
        destinationCurrency: config.destinationCurrency || config.destination_currency || ctx.currency,
        receiveCountry: config.receiveCountry || config.receive_country || 'USA',
        deliveryOption: config.deliveryOption || config.delivery_option,
        serviceOptionCode: config.serviceOptionCode || config.service_option_code,
        sender,
        receiver,
        reference: paymentId,
      });
    } catch (err) {
      result = { status: 'failed', externalId: null, errorMessage: `MoneyGram adapter error: ${err.message}`, rawRequest: null, rawResponse: null };
    }

    const { status, externalId, errorMessage } = result;
    const rawResponse = result.rawResponse
      ? JSON.stringify({ provider: 'moneygram', transactionId: result.transactionId || null, mgStatus: result.mgStatus || null, ...JSON.parse(result.rawResponse) })
      : null;
    await pool.query(
      `UPDATE live_fintech_payments SET status = $1, external_id = $2, raw_request = $3, raw_response = $4, error_message = $5, updated_at = NOW() WHERE payment_id = $6`,
      [status, externalId, result.rawRequest, rawResponse, errorMessage, paymentId]
    );
    await this._settleOrRefund({ payment, status, externalId, reserved });
    return { paymentId, endpointId: payment.endpoint_id, status, externalId, errorMessage, transactionId: result.transactionId || null };
  }

  /**
   * Re-poll MoneyGram for a previously sent payment and update the row.
   * Only `manual_pending` payments change state; a completed payment is
   * settled from HOLD to SETTLED, a failed one refunded to the source.
   */
  static async refreshStatus(paymentId) {
    await this.ensureTables();
    const payment = await this.getPayment(paymentId);
    if (!payment) throw new Error('Payment not found');
    const endpoint = await this.getEndpointWithSecrets(payment.endpoint_id);
    if (!endpoint) throw new Error('Endpoint not found');
    if (endpoint.provider !== 'moneygram') throw new Error('refreshStatus is only supported for moneygram endpoints');

    let transactionId = null;
    try { transactionId = payment.raw_response ? JSON.parse(payment.raw_response).transactionId : null; } catch { /* ignore */ }
    if (!transactionId && !payment.external_id) throw new Error('Payment has no MoneyGram transactionId or referenceNumber to poll');

    const adapter = moneyGramAdapterFromEndpoint(endpoint);
    const polled = await adapter.status({ transactionId, referenceNumber: payment.external_id, clientRequestId: `${paymentId}-status-${Date.now()}` });
    const previous = payment.status;
    const externalId = payment.external_id || polled.referenceNumber || null;
    const nextStatus = previous === 'manual_pending' ? polled.status : previous;
    const errorMessage = nextStatus === 'failed' && previous !== 'failed' ? `MoneyGram status ${polled.mgStatus}` : payment.error_message;

    let rawResponse = {};
    try { rawResponse = payment.raw_response ? JSON.parse(payment.raw_response) : {}; } catch { rawResponse = { raw: payment.raw_response }; }
    rawResponse.lastStatusPoll = { at: new Date().toISOString(), statusCode: polled.statusCode, body: polled.body };
    rawResponse.mgStatus = polled.mgStatus;

    await pool.query(
      `UPDATE live_fintech_payments SET status = $1, external_id = $2, raw_response = $3, error_message = $4, updated_at = NOW() WHERE payment_id = $5`,
      [nextStatus, externalId, JSON.stringify(rawResponse), errorMessage, paymentId]
    );
    if (previous === 'manual_pending' && nextStatus !== 'manual_pending') {
      // The manual_pending refund already ran at send time; only settle here.
      if (nextStatus === 'completed' && CashEngine && payment.source_account_id) {
        try {
          await CashEngine.transfer({
            fromAccountId: payment.source_account_id,
            toAccountId: SETTLED_ACCOUNT,
            amountCents: payment.amount_cents,
            movementType: 'transfer',
            memo: `Live fintech settle (status refresh) ${paymentId}`,
            referenceId: externalId || paymentId,
            referenceType: 'live_fintech',
          });
        } catch (e) { console.warn('[live-fintech] settle ledger movement skipped:', e.message); }
      }
    }
    return { paymentId, endpointId: payment.endpoint_id, previousStatus: previous, status: nextStatus, mgStatus: polled.mgStatus, externalId, transactionId: polled.transactionId };
  }

  static async executePayment(opts = {}) {
    const created = await this.createPayment(opts);
    return await this.sendPayment(created.paymentId);
  }
}

module.exports = { LiveFinTechEndpointEngine };
