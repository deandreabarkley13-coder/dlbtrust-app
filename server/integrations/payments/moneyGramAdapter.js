'use strict';

/**
 * MoneyGram disbursement adapter.
 *
 * Follows the MoneyGram Transfer API (developer.moneygram.com):
 *
 *   token  → GET  {tokenUrl}?grant_type=client_credentials   (Basic client_id:client_secret)
 *   quote  → POST /transfer/v1/transactions/quote
 *   send   → PUT  /transfer/v1/transactions/{transactionId}  ("Update a Transaction"; must return readyForCommit: true)
 *   commit → PUT  /transfer/v1/transactions/{transactionId}/commit → referenceNumber
 *   status → GET  /status/v1/transactions/{transactionId} | ?referenceNumber=
 *
 * Every call carries `X-MG-ClientRequestId` and every body carries
 * `targetAudience` + `userLanguage`. Hosts: sandboxapi.moneygram.com /
 * api.moneygram.com. `tokenMethod: 'POST'` + `credentialsInBody` are kept for
 * gateways that front the same flow with a form-encoded token endpoint.
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
const DEFAULT_QUOTE_PATH = '/transfer/v1/transactions/quote';
const DEFAULT_SEND_PATH = '/transfer/v1/transactions';
const DEFAULT_STATUS_PATH = '/status/v1/transactions';
const DEFAULT_TARGET_AUDIENCE = 'AGENT_FACING';
const DEFAULT_USER_LANGUAGE = 'en-US';
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
   * @param {string}  [cfg.tokenMethod]       'GET' (MoneyGram default, grant_type as query) or 'POST' (form body)
   * @param {boolean} [cfg.credentialsInBody] with POST: client_id/secret in the form body instead of Basic auth
   * @param {string}  [cfg.targetAudience]    default AGENT_FACING
   * @param {string}  [cfg.userLanguage]      default en-US
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
    this.tokenMethod = String(cfg.tokenMethod || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
    this.credentialsInBody = cfg.credentialsInBody === true;
    this.targetAudience = cfg.targetAudience || DEFAULT_TARGET_AUDIENCE;
    this.userLanguage = cfg.userLanguage || DEFAULT_USER_LANGUAGE;
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
    const headers = { Accept: 'application/json' };
    const basic = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`;
    let url = this.tokenUrl;
    let body;
    if (this.tokenMethod === 'GET') {
      headers.Authorization = basic;
      url = `${this.tokenUrl}${this.tokenUrl.includes('?') ? '&' : '?'}${form.toString()}`;
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      if (this.credentialsInBody) {
        form.append('client_id', this.clientId);
        form.append('client_secret', this.clientSecret);
      } else {
        headers.Authorization = basic;
      }
      body = form.toString();
    }

    let res;
    try {
      res = await httpRequest({ url, method: this.tokenMethod, headers, body, timeoutMs: this.timeoutMs });
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

  _audience() {
    return { targetAudience: this.targetAudience, userLanguage: this.userLanguage };
  }

  _quoteFields({ amount, sourceCurrency = 'USD', destinationCurrency, receiveCountry = 'USA', receiveCountrySubdivision, deliveryOption, serviceOptionCode } = {}) {
    return {
      ...this._audience(),
      agentPartnerId: this.agentPartnerId || undefined,
      destinationCountryCode: receiveCountry,
      destinationCountrySubdivisionCode: receiveCountrySubdivision || undefined,
      serviceOptionCode: serviceOptionCode || deliveryOption || undefined,
      sendAmount: { currencyCode: sourceCurrency, value: Number(Number(amount).toFixed(2)) },
      receiveCurrencyCode: destinationCurrency || sourceCurrency,
    };
  }

  /** Fee/FX quote; returns an array of quoted `transactions`, one per service option. */
  async quote(opts = {}) {
    if (!(Number(opts.amount) > 0)) throw new MoneyGramError('quote', 'amount must be positive');
    return this._call('quote', { method: 'POST', path: this.quotePath, body: this._quoteFields(opts), clientRequestId: opts.clientRequestId });
  }

  /**
   * "Update a Transaction": attach sender (the trust's registered sender
   * profile), receiver, targetAccount and transactionInformation to the
   * quoted transactionId. Fails unless MoneyGram answers readyForCommit: true.
   */
  async send({ transactionId, quote, sender, receiver, targetAccount, transactionInformation, reference, clientRequestId } = {}) {
    if (!transactionId) throw new MoneyGramError('send', 'transactionId from quote is required');
    const rn = (receiver && receiver.name) || {};
    if (!(rn.firstName && rn.lastName)) throw new MoneyGramError('send', 'receiver.name.firstName and receiver.name.lastName are required');
    const body = {
      ...(quote ? this._quoteFields(quote) : this._audience()),
      agentPartnerId: this.agentPartnerId || undefined,
      sender,
      receiver,
      targetAccount: targetAccount || undefined,
      transactionInformation: { ...(transactionInformation || {}), ...(reference ? { partnerTransactionId: reference } : {}) },
    };
    const res = await this._call('send', { method: 'PUT', path: `${this.sendPath}/${encodeURIComponent(transactionId)}`, body, clientRequestId });
    const b = res.body && typeof res.body === 'object' ? res.body : {};
    if (b.readyForCommit !== true && b.readyToCommit !== true) {
      throw new MoneyGramError('send', 'transaction is not readyForCommit (MoneyGram requires more sender/receiver data)', { statusCode: res.statusCode, body: b });
    }
    return res;
  }

  /** Commit/confirm the created transaction so funds are released; returns referenceNumber + expectedPayoutDate. */
  async commit({ transactionId, clientRequestId } = {}) {
    if (!transactionId) throw new MoneyGramError('commit', 'transactionId is required');
    return this._call('commit', {
      method: 'PUT',
      path: `${this.sendPath}/${encodeURIComponent(transactionId)}/commit`,
      body: this._audience(),
      clientRequestId,
    });
  }

  /** Poll transaction status by MoneyGram transaction / reference identifier. */
  async status({ transactionId, referenceNumber, clientRequestId } = {}) {
    const id = transactionId || referenceNumber;
    if (!id) throw new MoneyGramError('status', 'transactionId or referenceNumber is required');
    const qs = new URLSearchParams(this._audience());
    if (!transactionId) qs.append('referenceNumber', referenceNumber);
    const path = transactionId
      ? `${this.statusPath}/${encodeURIComponent(transactionId)}?${qs}`
      : `${this.statusPath}/?${qs}`;
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
  async disburse({ amount, sourceCurrency = 'USD', destinationCurrency, receiveCountry, receiveCountrySubdivision, deliveryOption, serviceOptionCode, sender, receiver, targetAccount, transactionInformation, reference } = {}) {
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
      const quoteArgs = { amount, sourceCurrency, destinationCurrency, receiveCountry, receiveCountrySubdivision, deliveryOption, serviceOptionCode };
      const q = await this.quote({ ...quoteArgs, clientRequestId: reference ? `${reference}-quote` : undefined });
      record('quote', q);
      const qb = q.body || {};
      const quotes = Array.isArray(qb.transactions) ? qb.transactions : [qb];
      const wanted = serviceOptionCode || deliveryOption;
      const chosen = (wanted && quotes.find((t) => t && t.serviceOptionCode === wanted)) || quotes[0];
      transactionId = chosen && (chosen.transactionId || chosen.id);
      if (!transactionId) throw new MoneyGramError('quote', 'quote did not return a transactionId', { statusCode: q.statusCode, body: qb });
      if (chosen.serviceOptionCode) quoteArgs.serviceOptionCode = chosen.serviceOptionCode;

      const s = await this.send({ transactionId, quote: quoteArgs, sender, receiver, targetAccount, transactionInformation, reference, clientRequestId: reference ? `${reference}-send` : undefined });
      record('send', s);

      const c = await this.commit({ transactionId, clientRequestId: reference ? `${reference}-commit` : undefined });
      record('commit', c);
      const cb = c.body || {};
      const referenceNumber = cb.referenceNumber || cb.mgiReferenceNumber || null;
      const mgStatus = cb.transactionStatus || cb.status || null;
      const expectedPayoutDate = cb.expectedPayoutDate || null;
      const status = referenceNumber ? (mgStatus ? mapMoneyGramStatus(mgStatus) : 'completed') : 'manual_pending';
      return {
        status: status === 'failed' ? 'failed' : status,
        externalId: referenceNumber,
        transactionId,
        mgStatus,
        expectedPayoutDate,
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
    tokenMethod: config.tokenMethod || config.token_method,
    credentialsInBody: config.credentialsInBody === true || config.credentials_in_body === true,
    targetAudience: config.targetAudience || config.target_audience,
    userLanguage: config.userLanguage || config.user_language,
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
  DEFAULT_TARGET_AUDIENCE,
  DEFAULT_USER_LANGUAGE,
};
