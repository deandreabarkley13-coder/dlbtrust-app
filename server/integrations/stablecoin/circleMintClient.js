'use strict';

/**
 * Circle Mint client for regulated fiat on-ramp and on-chain USDC transfers.
 *
 * Wraps Circle Mint business-account endpoints:
 *  - bank wire linking / instructions
 *  - business account balances
 *  - recipient addresses
 *  - on-chain transfers
 */

const crypto = require('crypto');

function getConfig() {
  return {
    apiKey: process.env.CIRCLE_MINT_API_KEY || '',
    baseUrl: (process.env.CIRCLE_MINT_BASE_URL || 'https://api.circle.com').replace(/\/$/, ''),
  };
}

class CircleMintClient {
  constructor(cfg = getConfig()) {
    this.cfg = cfg;
    this.cfg.baseUrl = (this.cfg.baseUrl || 'https://api.circle.com').replace(/\/$/, '');
  }

  _idempotencyKey() {
    return crypto.randomUUID();
  }

  _headers() {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.cfg.apiKey}`,
      'X-Request-Id': crypto.randomUUID(),
    };
    return headers;
  }

  async _request(method, path, body) {
    const url = `${this.cfg.baseUrl}${path}`;
    const opts = { method, headers: this._headers() };
    if (body) opts.body = JSON.stringify(body);

    let text = '';
    try {
      const res = await fetch(url, opts);
      text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
      if (!res.ok) {
        const msg = (json && (json.message || json.error)) || text || `${res.status}`;
        const err = new Error(`Circle Mint ${method} ${path} failed: ${res.status} ${msg}`);
        err.status = res.status;
        err.response = json;
        throw err;
      }
      return json;
    } catch (e) {
      if (e.status) throw e;
      throw new Error(`Circle Mint ${method} ${path} request failed: ${e.message}`);
    }
  }

  readiness() {
    const issues = [];
    if (!this.cfg.apiKey) issues.push('CIRCLE_MINT_API_KEY not configured');
    return { ready: issues.length === 0, issues, baseUrl: this.cfg.baseUrl };
  }

  async getBusinessAccount() {
    return this._request('GET', '/v1/businessAccount');
  }

  async getBalances() {
    return this._request('GET', '/v1/businessAccount/balances');
  }

  async createWireBankAccount({ accountNumber, routingNumber, billingDetails, bankAddress, idempotencyKey }) {
    const body = {
      idempotencyKey: idempotencyKey || this._idempotencyKey(),
      accountNumber,
      routingNumber,
      billingDetails,
      bankAddress,
    };
    return this._request('POST', '/v1/businessAccount/banks/wires', body);
  }

  async getWireInstructions(bankAccountId, { currency = 'USD', walletId } = {}) {
    const qs = new URLSearchParams();
    if (currency) qs.set('currency', currency);
    if (walletId) qs.set('walletId', walletId);
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return this._request('GET', `/v1/businessAccount/banks/wires/${encodeURIComponent(bankAccountId)}/instructions${query}`);
  }

  async listWireBankAccounts({ pageSize, pageBefore, pageAfter } = {}) {
    const qs = new URLSearchParams();
    if (pageSize) qs.set('pageSize', String(pageSize));
    if (pageBefore) qs.set('pageBefore', pageBefore);
    if (pageAfter) qs.set('pageAfter', pageAfter);
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return this._request('GET', `/v1/businessAccount/banks/wires${query}`);
  }

  async createRecipientAddress({ address, chain = 'ETH', currency = 'USD', description, idempotencyKey }) {
    const body = {
      idempotencyKey: idempotencyKey || this._idempotencyKey(),
      address,
      chain,
      currency,
    };
    if (description) body.description = description;
    return this._request('POST', '/v1/businessAccount/wallets/addresses/recipient', body);
  }

  async createTransfer({ destinationAddressId, amount, currency = 'USD', idempotencyKey }) {
    const body = {
      idempotencyKey: idempotencyKey || this._idempotencyKey(),
      destination: {
        type: 'verified_blockchain',
        addressId: destinationAddressId,
      },
      amount: {
        currency,
        amount: String(amount),
      },
    };
    return this._request('POST', '/v1/businessAccount/transfers', body);
  }

  async listTransfers({ from, to, status, type, pageSize, pageBefore, pageAfter } = {}) {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    if (status) qs.set('status', status);
    if (type) qs.set('type', type);
    if (pageSize) qs.set('pageSize', String(pageSize));
    if (pageBefore) qs.set('pageBefore', pageBefore);
    if (pageAfter) qs.set('pageAfter', pageAfter);
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return this._request('GET', `/v1/businessAccount/transfers${query}`);
  }

  async getTransfer(transferId) {
    return this._request('GET', `/v1/businessAccount/transfers/${encodeURIComponent(transferId)}`);
  }
}

module.exports = { CircleMintClient, getConfig };
