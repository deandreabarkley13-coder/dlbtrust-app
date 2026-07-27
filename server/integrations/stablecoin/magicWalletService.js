'use strict';

/**
 * Magic Labs Wallet as a Service (WaaS) integration.
 *
 * Uses the Magic Core API v2 for wallet creation and signing.
 * Wraps fetch calls so the gateway can resolve user wallet addresses
 * and, when configured, sign transactions for EVM/Solana/Bitcoin.
 */

const { getConfig } = require('./config');

class MagicWalletService {
  constructor() {
    this.cfg = getConfig();
  }

  _headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.cfg.magicSecretKey) h['x-magic-secret-key'] = this.cfg.magicSecretKey;
    if (this.cfg.magicApiKey) h['X-Magic-API-Key'] = this.cfg.magicApiKey;
    return h;
  }

  _url(path) {
    const base = this.cfg.magicBaseUrl.replace(/\/$/, '');
    return `${base}${path}`;
  }

  async request(method, path, body) {
    const url = this._url(path);
    const opts = { method, headers: this._headers() };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`Magic API ${method} ${path} failed: ${res.status} ${json.message || text}`);
      err.status = res.status;
      err.response = json;
      throw err;
    }
    return json;
  }

  async createWalletGroup(metadata = {}) {
    return this.request('POST', '/v1/api/wallet_group', { metadata });
  }

  async listWalletGroups() {
    return this.request('GET', '/v1/api/wallet_groups');
  }

  /**
   * Create a Magic WaaS wallet bound to a user identity.
   * authJwt must be a JWT from the trust's identity provider.
   * network examples: 'mainnet' (EVM), 'SOL_MAINNET', 'BTC_MAINNET'.
   */
  async createWallet({ authJwt, network = 'mainnet', walletGroupId, metadata = {} }) {
    if (!this.cfg.magicSecretKey) throw new Error('MAGIC_SECRET_KEY not configured');
    if (!authJwt) throw new Error('authJwt is required to bind wallet to user identity');
    return this.request('POST', '/v2/api/wallet', {
      auth_jwt: authJwt,
      network,
      wallet_group_id: walletGroupId || this.cfg.magicWalletGroupId,
      metadata,
    });
  }

  async getWallet(walletId) {
    return this.request('GET', `/v2/api/wallet/${walletId}`);
  }

  /**
   * Sign a transaction via Magic Core API.
   * For EVM: payload is an object matching the Magic transaction schema.
   * For Solana: payload is a base64-encoded transaction string.
   * For Bitcoin: payload is an inputs/outputs object.
   */
  async signTransaction({ opJwt, walletId, accessKey, payload, network = 'mainnet' }) {
    if (!this.cfg.magicSecretKey) throw new Error('MAGIC_SECRET_KEY not configured');
    if (!opJwt) throw new Error('opJwt is required for signing operations');
    return this.request('POST', '/v2/api/wallet/sign_transaction', {
      op_jwt: opJwt,
      wallet_id: walletId,
      access_key: accessKey,
      payload,
    });
  }

  readiness() {
    const issues = [];
    if (!this.cfg.magicSecretKey) issues.push('MAGIC_SECRET_KEY not configured');
    if (!this.cfg.magicWalletGroupId) issues.push('MAGIC_WALLET_GROUP_ID not configured');
    return { ready: issues.length === 0, issues, baseUrl: this.cfg.magicBaseUrl };
  }
}

module.exports = { MagicWalletService };
