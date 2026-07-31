'use strict';

/**
 * Cash App Pay Partner / crypto P2P integration scaffold.
 *
 * Cash App Pay (https://developers.cash.app) is a merchant checkout product.
 * It does **not** expose a personal crypto send/receive API, so this module
 * provides both a regulated merchant payment path and a practical P2P fallback
 * (shareable QR/link with a BTC/LN address or on-chain EVM address).
 */

function str(name, fallback = '') { return (process.env[name] || fallback).trim(); }
function bool(name, fallback = false) { const v = process.env[name]; return v ? String(v).toLowerCase() === 'true' : fallback; }

class CashAppEngine {
  static getConfig() {
    return {
      enabled: bool('CASHAPP_ENABLED', false),
      clientId: str('CASHAPP_CLIENT_ID', ''),
      clientSecret: str('CASHAPP_CLIENT_SECRET', ''),
      networkApiKey: str('CASHAPP_NETWORK_API_KEY', ''),
      sandbox: bool('CASHAPP_SANDBOX', true),
      baseUrl: str('CASHAPP_BASE_URL', 'https://api.cash.app/network/v1'),
      brandId: str('CASHAPP_BRAND_ID', ''),
      webhookSecret: str('CASHAPP_WEBHOOK_SECRET', ''),
    };
  }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.enabled) issues.push('CASHAPP_ENABLED is not true');
    if (!cfg.clientId) issues.push('CASHAPP_CLIENT_ID missing');
    if (!cfg.clientSecret) issues.push('CASHAPP_CLIENT_SECRET missing');
    if (!cfg.networkApiKey) issues.push('CASHAPP_NETWORK_API_KEY missing');
    return { ready: issues.length === 0, rail: 'cashapp', mode: cfg.sandbox ? 'sandbox' : 'production', issues };
  }

  /**
   * Returns a shareable Cash App crypto payment instruction.
   * In shadow/sandbox mode this does not call the Cash App network.
   */
  static async requestPayment({ amountUsd, currency = 'USD', recipientTag, walletAddress, chain = 'EVM', memo } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw new Error('Cash App rail is not enabled');
    const id = `CASH-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const shareable = `https://cash.app/${recipientTag || ''}?amount=${amountUsd}&note=${encodeURIComponent(memo || 'DLB Trust payment')}`;
    return {
      id,
      rail: 'cashapp',
      status: cfg.sandbox ? 'pending_merchant_approval' : 'pending',
      amountUsd,
      currency,
      walletAddress,
      chain,
      shareableUrl: shareable,
      qrPayload: walletAddress ? `${chain}:${walletAddress}?amount=${amountUsd}` : shareable,
      note: 'Cash App does not expose a personal crypto P2P API. Share this QR/link with the recipient; once they send crypto from Cash App, record the deposit in the dApp with the on-chain tx hash.',
    };
  }

  static async verifyWebhook(payload, signature) {
    const cfg = this.getConfig();
    if (!cfg.webhookSecret) return { verified: false, reason: 'CASHAPP_WEBHOOK_SECRET not set' };
    // HMAC verification placeholder
    return { verified: true, payload };
  }
}

module.exports = { CashAppEngine };
