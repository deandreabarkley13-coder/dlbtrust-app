'use strict';

/**
 * HollaEx Kit REST client.
 *
 * Wraps the HollaEx Pro/V2 API for fiat-crypto conversion via quick trade.
 * Authentication uses HMAC-SHA256 with api-key, api-signature, api-expires.
 */

const crypto = require('crypto');

function getConfig() {
  return {
    baseUrl: (process.env.HOLLAEX_BASE_URL || 'https://api.hollaex.com').replace(/\/$/, ''),
    apiKey: process.env.HOLLAEX_API_KEY || '',
    apiSecret: process.env.HOLLAEX_API_SECRET || '',
  };
}

class HollaExClient {
  constructor(cfg = getConfig()) {
    this.cfg = cfg;
  }

  _headers(method, path, body) {
    const cfg = this.cfg;
    const headers = {
      'Content-Type': 'application/json',
      'api-key': cfg.apiKey,
    };
    if (!cfg.apiSecret) return headers;

    const expires = Math.floor(Date.now() / 1000) + 60;
    const bodyString = body ? JSON.stringify(body) : '';
    const string = `${method.toUpperCase()}${path}${expires}${bodyString}`;
    const signature = crypto.createHmac('sha256', cfg.apiSecret).update(string).digest('hex');
    headers['api-signature'] = signature;
    headers['api-expires'] = String(expires);
    return headers;
  }

  async request(method, path, body) {
    const url = `${this.cfg.baseUrl}${path}`;
    const headers = this._headers(method, path, body);
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`HollaEx ${method} ${path} failed: ${res.status} ${json.message || text}`);
      err.status = res.status;
      err.response = json;
      throw err;
    }
    return json;
  }

  async getQuote({ spendingCurrency, receivingCurrency, spendingAmount, receivingAmount }) {
    if (!spendingCurrency || !receivingCurrency) {
      throw new Error('spendingCurrency and receivingCurrency are required');
    }
    if (spendingAmount == null && receivingAmount == null) {
      throw new Error('spendingAmount or receivingAmount is required');
    }
    const params = new URLSearchParams();
    params.set('spending_currency', String(spendingCurrency).toLowerCase());
    params.set('receiving_currency', String(receivingCurrency).toLowerCase());
    if (spendingAmount != null) params.set('spending_amount', String(spendingAmount));
    if (receivingAmount != null) params.set('receiving_amount', String(receivingAmount));
    return this.request('GET', `/v2/quick-trade?${params.toString()}`);
  }

  async executeQuote(token) {
    if (!token) throw new Error('token is required');
    return this.request('POST', '/v2/order/execute', { token });
  }

  async getConstants() {
    return this.request('GET', '/v2/constants');
  }

  readiness() {
    const issues = [];
    if (!this.cfg.apiKey) issues.push('HOLLAEX_API_KEY not configured');
    if (!this.cfg.apiSecret) issues.push('HOLLAEX_API_SECRET not configured');
    return { ready: issues.length === 0, issues, baseUrl: this.cfg.baseUrl };
  }
}

module.exports = { HollaExClient, getConfig };
