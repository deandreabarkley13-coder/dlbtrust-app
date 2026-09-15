'use strict';

/**
 * MoneyGram disbursement adapter.
 *
 * OAuth2 client-credentials against `{tokenUrl}` (default
 * `{baseUrl}/oauth/accesstoken`), then MoneyGram's multi-step send flow:
 *
 *   quote  → POST {quotePath}
 *   send   → PUT  {sendPath}/{transactionId}
 *   commit → PUT  {sendPath}/{transactionId}/commit
 *   status → GET  {statusPath}/{transactionId}
 *
 * Every value (URLs, credentials, partner id, X-MG-* headers, paths) comes from
 * the caller — the Live FinTech engine reads them from the endpoint row. This
 * module never reads process.env.
 *
 * MoneyGram is a disbursement rail: it pays out of a pre-funded MoneyGram
 * partner balance. It does not replace the trust's ODFI/bank settlement
 * relationship, and the engine still reserves/settles trust cash around it.
 */

const crypto = require('crypto');
const { httpRequest, maskSecret } = require('../dapp/externalEndpointEngine');

const DEFAULT_TOKEN_PATH = '/oauth/accesstoken';
const DEFAULT_QUOTE_PATH = '/disbursement/v1/transactions/quote';
const DEFAULT_SEND_PATH = '/disbursement/v1/transactions';
const DEFAULT_STATUS_PATH = '/status/v1/transactions';
const TOKEN_REFRESH_SKEW_MS = 60000;

// Status values reported by MoneyGram's transaction status resource, mapped to
// the Live FinTech engine's status enum.
const COMPLETED_STATUSES = new Set(['SENT', 'AVAILABLE', 'RECEIVED', 'DELIVERED', 'COMPLETED', 'SETTLED', 'COMMITTED']);
const FAILED_STATUSES = new Set(['REJECTED', 'CANCELLED', 'CANCELED', 'REFUNDED', 'FAILED', 'DECLINED', 'EXPIRED']);

class MoneyGramError extends Error {
  constructor(step, message, { statusCode, body } = {}) {
    super(`MoneyGram ${step} failed: ${message}`);
    this.name = 'MoneyGramError';
    this.step = step;
    this.statusCode = statusCode;
    this.body = body;
  }
}

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function joinUrl(base, path) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${trimSlash(base)}${path.startsWith('/') ? path : `/${path}`}`;
}

function errorMessageFromBody(json, fallback) {
  if (!json || typeof json !== 'object') return fallback;
  const errs = Array.isArray(json.errors) ? json.errors : null;
  if (errs && errs.length) {
    return errs.map((e) => [e.code || e.errorCode, e.message || e.description].filter(Boolean).join(' ')).join('; ');
  }
  if (json.error && typeof json.error === 'object') {
    return [json.error.code, json.error.message].filter(Boolean).join(' ') || fallback;
  }
  return json.error_description || json.message || json.error || json.errorMessage || fallback;
}

function mapMoneyGramStatus(mgStatus) {
  const s = String(mgStatus || '').toUpperCase();
  if (!s) return 'manual_pending';
  if (COMPLETED_STATUSES.has(s)) return 'completed';
  if (FAILED_STATUSES.has(s)) return 'failed';
  return 'manual_pending';
}

class MoneyGramAdapter {
  /**
   * @param {object} cfg
   * @param {string} cfg.baseUrl
   * @param {string} [cfg.tokenUrl]           defaults to `${baseUrl}/oauth/accesstoken`
   * @param {string} cfg.clientId
   * @param {string} cfg.clientSecret
   * @param {boolean} [cfg.credentialsInBody] client_id/secret in the form body instead of Basic auth
   * @param {string} [cfg.scope]
   * @param {string} [cfg.agentPartnerId]     sent as `agentPartnerId` on quote/send and as X-MG-AgentPartnerId
   * @param {string} [cfg.partnerName]
   * @param {object} [cfg.headers]            extra `X-MG-*` / version headers attached to every API call
   * @param {string} [cfg.quotePath] [cfg.sendPath] [cfg.statusPath]
   * @param {number} [cfg.timeoutMs]
   */
  constructor(cfg = {}) {
    if (!cfg.baseUrl) throw new Error('MoneyGram baseUrl is required');
    if (!cfg.clientId || !cfg.clientSecret) throw new Error('MoneyGram clientId and clientSecret are required');
    this.baseUrl = trimSlash(cfg.baseUrl);
    this.tokenUrl = cfg.tokenUrl || joinUrl(this.baseUrl, DEFAULT_TOKEN_PATH);
    this.clientId = cfg.clientId;
    this.clientSecret = cfg.clientSecret;
    this.credentialsInBody = cfg.credentialsInBody === true;
    this.scope = cfg.scope || '';
    this.agentPartnerId = cfg.agentPartnerId || '';
    this.partnerName = cfg.partnerName || '';
    this.headers = { ...(cfg.headers || {}) };
    this.quotePath = cfg.quotePath || DEFAULT_QUOTE_PATH;
    this.sendPath = cfg.sendPath || DEFAULT_SEND_PATH;
    this.statusPath = cfg.statusPath || DEFAULT_STATUS_PATH;
    this.timeoutMs = Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 60000;
    this.accessToken = null;
    this.expiresAt = 0;
  }

  describe() {
    return {
      baseUrl: this.baseUrl,
      tokenUrl: this.tokenUrl,
      clientId: maskSecret(this.clientId),
      clientSecret: maskSecret(this.clientSecret),
      agentPartnerId: this.agentPartnerId,
      credentialsInBody: this.credentialsInBody,
    };
  }

  clearTokenCache() {
    this.accessToken = null;
    this.expiresAt = 0;
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.expiresAt - TOKEN_REFRESH_SKEW_MS) return this.accessToken;

    const form = new URLSearchParams();
    form.append('grant_type', 'client_credentials');
    if (this.scope) form.append('scope', this.scope);
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (this.credentialsInBody) {
      form.append('client_id', this.clientId);
      form.append('client_secret', this.clientSecret);
    } else {
      headers.Authorization = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`;
    }

    let res;
    try {
      res = await httpRequest({ url: this.tokenUrl, method: 'POST', headers, body: form.toString(), timeoutMs: this.timeoutMs });
    } catch (err) {
      throw new MoneyGramError('token', err.message);
    }
    const json = res.json || {};
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new MoneyGramError('token', `${res.statusCode} ${errorMessageFromBody(json, res.body.slice(0, 200))}`, { statusCode: res.statusCode, body: json });
    }
    const token = json.access_token || json.accessToken;
    if (!token) throw new MoneyGramError('token', 'token endpoint did not return an access_token', { statusCode: res.statusCode, body: json });
    const expiresIn = Number(json.expires_in || json.expiresIn);
    this.accessToken = token;
    this.expiresAt = Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000;
    return this.accessToken;
  }

  _apiHeaders(token, clientRequestId) {
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-MG-ClientRequestId': clientRequestId || crypto.randomUUID(),
      ...this.headers,
    };
    if (this.agentPartnerId && !headers['X-MG-AgentPartnerId']) headers['X-MG-AgentPartnerId'] = this.agentPartnerId;
    return headers;
  }

  async _call(step, { method, path, body, clientRequestId }) {
    const token = await this.getAccessToken();
    const url = joinUrl(this.baseUrl, path);
    const headers = this._apiHeaders(token, clientRequestId);
    let res;
    try {
      res = await httpRequest({ url, method, headers, body: body ? JSON.stringify(body) : undefined, timeoutMs: this.timeoutMs });
    } catch (err) {
      throw new MoneyGramError(step, err.message);
    }
    const json = res.json;
    const hasErrorBody = json && typeof json === 'object' && (
      (Array.isArray(json.errors) && json.errors.length > 0) || (json.error && !json.transactionId && !json.referenceNumber)
    );
    if (res.statusCode < 200 || res.statusCode >= 300 || hasErrorBody) {
      throw new MoneyGramError(step, `${res.statusCode} ${errorMessageFromBody(json, res.body.slice(0, 200) || 'no response body')}`, { statusCode: res.statusCode, body: json });
    }
    return { statusCode: res.statusCode, body: json != null ? json : res.body, request: { method, url, body: body || null } };
  }

  /** Fee/FX quote for a send. */
  async quote({ amount, sourceCurrency = 'USD', destinationCurrency, receiveCountry = 'USA', deliveryOption = 'BANK_DEPOSIT', serviceOptionCode, clientRequestId } = {}) {
    if (!(Number(amount) > 0)) throw new MoneyGramError('quote', 'amount must be positive');
    const body = {
      agentPartnerId: this.agentPartnerId || undefined,
      destinationCountryCode: receiveCountry,
      serviceOptionCode: serviceOptionCode || deliveryOption,
      sendAmount: { currencyCode: sourceCurrency, value: Number(Number(amount).toFixed(2)) },
      receiveCurrencyCode: destinationCurrency || sourceCurrency,
    };
    return this._call('quote', { method: 'POST', path: this.quotePath, body, clientRequestId });
  }

  /** Create the transaction from an accepted quote (sender = the trust). */
  async send({ transactionId, sender, receiver, reference, clientRequestId } = {}) {
    if (!transactionId) throw new MoneyGramError('send', 'transactionId from quote is required');
    if (!receiver || !(receiver.firstName || receiver.lastName || receiver.fullName || receiver.businessName)) {
      throw new MoneyGramError('send', 'receiver name is required');
    }
    const body = {
      agentPartnerId: this.agentPartnerId || undefined,
      partnerTransactionId: reference || undefined,
      sender,
      receiver,
    };
    return this._call('send', { method: 'PUT', path: `${this.sendPath}/${encodeURIComponent(transactionId)}`, body, clientRequestId });
  }

  /** Commit/confirm the created transaction so funds are released. */
  async commit({ transactionId, clientRequestId } = {}) {
    if (!transactionId) throw new MoneyGramError('commit', 'transactionId is required');
    return this._call('commit', {
      method: 'PUT',
      path: `${this.sendPath}/${encodeURIComponent(transactionId)}/commit`,
      body: { agentPartnerId: this.agentPartnerId || undefined },
      clientRequestId,
    });
  }

  /** Poll transaction status by MoneyGram transaction / reference identifier. */
  async status({ transactionId, referenceNumber, clientRequestId } = {}) {
    const id = transactionId || referenceNumber;
    if (!id) throw new MoneyGramError('status', 'transactionId or referenceNumber is required');
    const qs = transactionId ? '' : `?referenceNumber=${encodeURIComponent(referenceNumber)}`;
    const path = transactionId ? `${this.statusPath}/${encodeURIComponent(transactionId)}` : `${this.statusPath}${qs}`;
    const res = await this._call('status', { method: 'GET', path, clientRequestId });
    const b = res.body && typeof res.body === 'object' ? res.body : {};
    return {
      ...res,
      transactionId: b.transactionId || transactionId || null,
      referenceNumber: b.referenceNumber || referenceNumber || null,
      mgStatus: b.transactionStatus || b.status || null,
      status: mapMoneyGramStatus(b.transactionStatus || b.status),
    };
  }

  /**
   * quote → send → commit. Never throws for MoneyGram-side failures; returns
   * the engine-shaped result so the caller can persist and reconcile.
   */
  async disburse({ amount, sourceCurrency = 'USD', destinationCurrency, receiveCountry, deliveryOption, serviceOptionCode, sender, receiver, reference } = {}) {
    const steps = [];
    const record = (step, res) => steps.push({ step, request: res.request, statusCode: res.statusCode, response: res.body });
    const fail = (err) => ({
      status: 'failed',
      externalId: null,
      transactionId: steps.length ? (steps[0].response && steps[0].response.transactionId) || null : null,
      errorMessage: err instanceof MoneyGramError ? err.message : `MoneyGram request failed: ${err.message}`,
      failedStep: err instanceof MoneyGramError ? err.step : 'unknown',
      steps,
      rawRequest: JSON.stringify(steps.map((s) => ({ step: s.step, ...s.request }))),
      rawResponse: JSON.stringify({ steps: steps.map((s) => ({ step: s.step, statusCode: s.statusCode, body: s.response })), error: err.body || null }),
    });

    let transactionId;
    try {
      const q = await this.quote({ amount, sourceCurrency, destinationCurrency, receiveCountry, deliveryOption, serviceOptionCode, clientRequestId: reference ? `${reference}-quote` : undefined });
      record('quote', q);
      const qb = q.body || {};
      const first = Array.isArray(qb.transactions) ? qb.transactions[0] : qb;
      transactionId = first && (first.transactionId || first.id);
      if (!transactionId) throw new MoneyGramError('quote', 'quote did not return a transactionId', { statusCode: q.statusCode, body: qb });

      const s = await this.send({ transactionId, sender, receiver, reference, clientRequestId: reference ? `${reference}-send` : undefined });
      record('send', s);

      const c = await this.commit({ transactionId, clientRequestId: reference ? `${reference}-commit` : undefined });
      record('commit', c);
      const cb = c.body || {};
      const referenceNumber = cb.referenceNumber || cb.mgiReferenceNumber || null;
      const mgStatus = cb.transactionStatus || cb.status || null;
      const status = referenceNumber ? (mgStatus ? mapMoneyGramStatus(mgStatus) : 'completed') : 'manual_pending';
      return {
        status: status === 'failed' ? 'failed' : status,
        externalId: referenceNumber,
        transactionId,
        mgStatus,
        errorMessage: status === 'failed' ? `MoneyGram commit returned ${mgStatus}` : (referenceNumber ? null : 'MoneyGram commit did not return a referenceNumber'),
        steps,
        rawRequest: JSON.stringify(steps.map((x) => ({ step: x.step, ...x.request }))),
        rawResponse: JSON.stringify({ steps: steps.map((x) => ({ step: x.step, statusCode: x.statusCode, body: x.response })) }),
      };
    } catch (err) {
      const out = fail(err);
      if (transactionId) out.transactionId = transactionId;
      return out;
    }
  }
}

/** Build an adapter from a live_fintech_endpoints row (api_key = clientId, api_secret = clientSecret). */
function adapterFromEndpoint(endpoint = {}) {
  const config = endpoint.config || {};
  return new MoneyGramAdapter({
    baseUrl: endpoint.base_url,
    tokenUrl: config.tokenUrl || config.token_url,
    clientId: config.clientId || config.client_id || endpoint.api_key,
    clientSecret: config.clientSecret || config.client_secret || endpoint.api_secret,
    credentialsInBody: config.credentialsInBody === true || config.credentials_in_body === true,
    scope: config.scope,
    agentPartnerId: config.agentPartnerId || config.agent_partner_id,
    partnerName: config.partnerName || config.partner_name,
    headers: { ...(endpoint.extra_headers || {}), ...(config.headers || {}) },
    quotePath: config.quotePath || config.quote_path,
    sendPath: config.sendPath || config.send_path,
    statusPath: config.statusPath || config.status_path,
    timeoutMs: config.timeoutMs || config.timeout_ms,
  });
}

module.exports = {
  MoneyGramAdapter,
  MoneyGramError,
  adapterFromEndpoint,
  mapMoneyGramStatus,
  DEFAULT_TOKEN_PATH,
  DEFAULT_QUOTE_PATH,
  DEFAULT_SEND_PATH,
  DEFAULT_STATUS_PATH,
};
