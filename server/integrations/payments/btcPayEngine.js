'use strict';

/**
 * BTCPay Server payout rail.
 *
 * Uses the BTCPay Greenfield API to create pull-payments + on-chain BTC payouts.
 * Requires environment variables:
 *   BTCPAY_URL           - Base URL of the BTCPay instance (e.g. https://dlbtrust-btcpay.fly.dev/)
 *   BTCPAY_API_KEY       - Server admin / store API key
 *   BTCPAY_STORE_ID      - Store under which payouts are created
 *   BTCPAY_WEBHOOK_SECRET - (optional) secret used to validate payout webhooks
 */

const BTCPAY_URL = (process.env.BTCPAY_URL || 'https://dlbtrust-btcpay.fly.dev/').replace(/\/$/, '');
const BTCPAY_API_KEY = process.env.BTCPAY_API_KEY || '';
const BTCPAY_STORE_ID = process.env.BTCPAY_STORE_ID || '';
const BTCPAY_WEBHOOK_SECRET = process.env.BTCPAY_WEBHOOK_SECRET || '';

class BtcPayEngine {
  static isConfigured() {
    return Boolean(BTCPAY_URL && BTCPAY_API_KEY && BTCPAY_STORE_ID);
  }

  static extractError(data) {
    if (!data) return '';
    if (typeof data === 'string') return data;
    if (Array.isArray(data)) return data.map(e => e.message || e.path || JSON.stringify(e)).join('; ');
    return data.message || data.title || data.detail || (data.errors && JSON.stringify(data.errors)) || (data.modelState && JSON.stringify(data.modelState)) || '';
  }

  static async request(path, opts = {}) {
    if (!this.isConfigured()) throw new Error('BTCPay engine not configured (BTCPAY_URL, BTCPAY_API_KEY, BTCPAY_STORE_ID)');
    const url = `${BTCPAY_URL}/api/v1${path.startsWith('/') ? path : '/' + path}`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `token ${BTCPAY_API_KEY}`,
      ...(opts.headers || {}),
    };
    const res = await fetch(url, { ...opts, headers });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = this.extractError(data) || `BTCPay HTTP ${res.status}`;
      throw new Error(`BTCPay ${res.status}: ${err}`);
    }
    return data;
  }

  static async getInfo() {
    return this.request('/server/info');
  }

  static async getStore() {
    return this.request(`/stores/${BTCPAY_STORE_ID}`);
  }

  static async createPullPayment({ name, amount, currency = 'USD', description, payoutMethods = ['BTC-CHAIN'], autoApproveClaims = false, expiresAt } = {}) {
    if (!amount || Number(amount) <= 0) throw new Error('amount must be positive');
    const body = {
      name: name || 'DLB Trust Payout',
      description: description || 'BTCPay payout initiated from DLB Trust Payout Center',
      amount: String(amount),
      currency,
      payoutMethods,
      autoApproveClaims,
    };
    if (expiresAt) body.expiresAt = Math.floor(expiresAt / 1000);
    return this.request(`/stores/${BTCPAY_STORE_ID}/pull-payments`, { method: 'POST', body: JSON.stringify(body) });
  }

  static async createPayout({ destination, amount, payoutMethodId = 'BTC-CHAIN', pullPaymentId } = {}) {
    if (!destination) throw new Error('destination address required');
    if (!amount || Number(amount) <= 0) throw new Error('amount must be positive');
    const body = { destination, amount: String(amount), payoutMethodId };
    if (pullPaymentId) body.pullPaymentId = pullPaymentId;
    return this.request(`/stores/${BTCPAY_STORE_ID}/payouts`, { method: 'POST', body: JSON.stringify(body) });
  }

  static async approvePayout(payoutId, revision = 0, rateRule = null) {
    return this.request(`/stores/${BTCPAY_STORE_ID}/payouts/${payoutId}`, {
      method: 'POST',
      body: JSON.stringify({ revision, rateRule }),
    });
  }

  static async payoutBtc({ destination, amountUsd, description, memo, autoApprove = true } = {}) {
    const pull = await this.createPullPayment({
      name: memo || description || 'DLB Trust BTC payout',
      description,
      amount: String(amountUsd),
      currency: 'USD',
      payoutMethods: ['BTC-CHAIN'],
      autoApproveClaims: false,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });

    const payout = await this.createPayout({
      destination,
      amount: String(amountUsd),
      payoutMethodId: 'BTC-CHAIN',
      pullPaymentId: pull.id,
    });

    if (autoApprove) {
      try {
        await this.approvePayout(payout.id, payout.revision != null ? payout.revision : 0, null);
      } catch (e) {
        console.warn('[BtcPayEngine] payout approval failed:', e.message);
      }
    }

    return {
      pullPaymentId: pull.id,
      payoutId: payout.id,
      destination,
      amountUsd: String(amountUsd),
      state: payout.state,
      payout,
    };
  }

  static validateWebhook(rawBody, signature) {
    if (!BTCPAY_WEBHOOK_SECRET) return { valid: false, verified: false };
    const crypto = require('crypto');
    const hmac = crypto.createHmac('sha256', BTCPAY_WEBHOOK_SECRET).update(rawBody, 'utf8').digest('hex');
    const sig = (signature || '').replace(/^sha256=/, '');
    const a = Buffer.from(hmac, 'hex');
    const b = Buffer.from(sig, 'hex');
    if (a.length !== b.length) return { valid: false, verified: true };
    return { valid: crypto.timingSafeEqual(a, b), verified: true };
  }
}

module.exports = { BtcPayEngine };
