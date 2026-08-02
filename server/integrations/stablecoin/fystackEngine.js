'use strict';

/**
 * FyStack Engine — self-hosted MPC custody and stablecoin payment rail.
 *
 * Talks to the FyStack Apex API (default http://localhost:8150/api/v1)
 * using HMAC-SHA256 API-key authentication. Supports wallet creation,
 * deposit addresses, balance checks, withdrawals, and sweep tasks.
 */

const crypto = require('crypto');
const { getConfig, isProduction } = require('./config');

function normalizeBaseUrl(url) {
  if (!url) return '';
  let base = url.trim();
  if (base.endsWith('/')) base = base.slice(0, -1);
  if (!base.includes('/api/v1')) base = `${base}/api/v1`;
  return base;
}

function computeSignature(apiSecret, method, path, timestamp, body = '') {
  const canonical = `method=${method}&path=${path}&timestamp=${timestamp}&body=${body}`;
  const digest = crypto.createHmac('sha256', apiSecret).update(canonical).digest('hex');
  return Buffer.from(digest, 'utf8').toString('base64');
}

class FyStackClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.baseUrl = normalizeBaseUrl(cfg.fyStackBaseUrl || 'http://localhost:8150');
    this.apiKey = cfg.fyStackApiKey || '';
    this.apiSecret = cfg.fyStackApiSecret || '';
  }

  async headers(method, endpoint, body = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (!this.apiSecret) return headers;

    let path;
    try {
      path = new URL(endpoint).pathname;
    } catch (e) {
      path = endpoint.replace(this.baseUrl, '');
    }
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bodyString = Object.keys(body).length ? JSON.stringify(body) : '';
    const signature = computeSignature(this.apiSecret, method, path, timestamp, bodyString);
    headers['ACCESS-API-KEY'] = this.apiKey;
    headers['ACCESS-TIMESTAMP'] = timestamp;
    headers['ACCESS-SIGN'] = signature;
    return headers;
  }

  async request(method, path, body) {
    const url = `${this.baseUrl}${path}`;
    const headers = await this.headers(method, url, body || {});
    const options = { method, headers };
    if (body && (method === 'POST' || method === 'PUT')) {
      options.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(url, options);
    } catch (e) {
      throw new Error(`FyStack request failed: ${e.message}`);
    }

    let data;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { message: text }; }

    if (!res.ok || (data && data.success === false)) {
      throw new Error(data.message || `FyStack ${method} ${path} failed: ${res.status}`);
    }
    return data && data.data !== undefined ? data.data : data;
  }

  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, body); }
}

function centsToDecimal(cents) {
  const value = Number(cents);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('amountCents must be a non-negative safe integer');
  }
  return (value / 100).toFixed(2);
}

class FyStackEngine {
  constructor() {
    this.cfg = getConfig();
    this.client = new FyStackClient(this.cfg);
  }

  _inShadow() {
    return this.cfg.mode === 'shadow' || this.cfg.fyStackShadow === true;
  }

  _assertReady() {
    if (!this.cfg.fyStackEnabled) throw new Error('FyStack is not enabled (FYSTACK_ENABLED)');
    if (!this.cfg.fyStackApiKey) throw new Error('FYSTACK_API_KEY is required');
    if (!this.cfg.fyStackApiSecret) throw new Error('FYSTACK_API_SECRET is required');
  }

  async readiness() {
    const cfg = this.cfg;
    const issues = [];
    const warnings = [];

    if (!cfg.fyStackEnabled) issues.push('FYSTACK_ENABLED is not true');
    if (!cfg.fyStackApiKey) issues.push('FYSTACK_API_KEY is required');
    if (!cfg.fyStackApiSecret) issues.push('FYSTACK_API_SECRET is required');
    if (!cfg.fyStackNetwork) issues.push('FYSTACK_NETWORK is required (e.g. ETHEREUM_SEPOLIA, TRON_TESTNET)');
    if (!cfg.fyStackAsset && !cfg.fyStackAssetId) issues.push('FYSTACK_ASSET or FYSTACK_ASSET_ID is required');

    if (cfg.fyStackShadow || cfg.mode === 'shadow') {
      warnings.push('FyStack engine is running in shadow/simulation mode');
      return { ready: true, issues, warnings, network: cfg.fyStackNetwork, assetCode: cfg.assetCode, simulated: true };
    }

    let apexOk = false;
    if (cfg.fyStackApiKey && cfg.fyStackApiSecret) {
      try {
        // Public assets endpoint; requires signature but is a lightweight probe.
        await this.client.get('/assets?search=USDC');
        apexOk = true;
      } catch (e) {
        issues.push(`FyStack Apex unreachable: ${e.message}`);
      }
    }

    return {
      ready: issues.length === 0,
      issues,
      warnings,
      network: cfg.fyStackNetwork,
      assetCode: cfg.assetCode,
      baseUrl: cfg.fyStackBaseUrl || 'http://localhost:8150',
      apexOk,
    };
  }

  async createWallet({ name, walletType = 'mpc', walletPurpose = 'general', sweepTaskParams } = {}) {
    if (this._inShadow()) {
      const id = `fys-wallet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return { wallet_id: id, status: 'success', name, simulated: true };
    }
    this._assertReady();
    const payload = { name, wallet_type: walletType, wallet_purpose: walletPurpose };
    if (sweepTaskParams) payload.sweep_task_params = sweepTaskParams;
    return this.client.post('/wallets', payload);
  }

  async getWallets(workspaceId) {
    if (this._inShadow()) return [];
    this._assertReady();
    if (!workspaceId && !this.cfg.fyStackWorkspaceId) throw new Error('FYSTACK_WORKSPACE_ID is required to list wallets');
    const ws = workspaceId || this.cfg.fyStackWorkspaceId;
    return this.client.get(`/workspaces/${ws}/wallets`);
  }

  async getWalletAssets(walletId) {
    if (this._inShadow()) return [];
    this._assertReady();
    if (!walletId) throw new Error('walletId is required');
    return this.client.get(`/wallets/${walletId}/assets`);
  }

  async getBalance(walletId, assetSymbol) {
    const assets = await this.getWalletAssets(walletId);
    const sym = (assetSymbol || this.cfg.assetCode || 'USDC').toUpperCase();
    const match = Array.isArray(assets)
      ? assets.find(a => (a.symbol || '').toUpperCase() === sym)
      : null;
    return match ? String(match.balance || '0') : '0';
  }

  async getDepositAddress(walletId, addressType = 'evm') {
    if (this._inShadow()) {
      return { address: `0xShadow${Date.now().toString(16).padStart(40, '0')}`, address_type: addressType, simulated: true };
    }
    this._assertReady();
    if (!walletId) throw new Error('walletId is required');
    return this.client.get(`/wallets/${walletId}/deposit-address?address_type=${encodeURIComponent(addressType)}`);
  }

  async requestWithdrawal(walletId, { asset, network, assetId, amount, recipientAddress, notes }) {
    if (this._inShadow()) {
      return {
        auto_approved: true,
        withdrawal: {
          id: `fys-withdrawal-${Date.now()}`,
          status: 'COMPLETED',
          tx_hash: `0xshadow${Date.now().toString(16)}`,
          amount,
          recipient_address: recipientAddress,
        },
        simulated: true,
      };
    }
    this._assertReady();
    if (!walletId) throw new Error('walletId is required');
    const payload = { amount, recipient_address: recipientAddress };
    if (assetId) payload.asset_id = assetId;
    if (asset) payload.asset = asset;
    if (network) payload.network = network;
    if (notes) payload.notes = notes;
    return this.client.post(`/wallets/${walletId}/request-withdrawal`, payload);
  }

  async getWithdrawalStatus(withdrawalId) {
    if (this._inShadow()) return { id: withdrawalId, status: 'COMPLETED', simulated: true };
    this._assertReady();
    if (!withdrawalId) throw new Error('withdrawalId is required');
    return this.client.get(`/withdrawals/${withdrawalId}`);
  }

  async createSweepTask(workspaceId, params) {
    if (this._inShadow()) {
      return { sweep_task_id: `fys-sweep-${Date.now()}`, simulated: true };
    }
    this._assertReady();
    const ws = workspaceId || this.cfg.fyStackWorkspaceId;
    if (!ws) throw new Error('FYSTACK_WORKSPACE_ID is required to create a sweep task');
    return this.client.post(`/workspaces/${ws}/automation/sweep-task`, params);
  }

  async settle({ destination, amountCents, memo, walletId } = {}) {
    const cfg = this.cfg;
    if (this._inShadow()) {
      return {
        hash: `fys-shadow-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        status: 'COMPLETED',
        amount: centsToDecimal(amountCents),
        memo: memo || null,
        latencyMs: 0,
        explorer: '',
        simulated: true,
      };
    }

    if (!destination) throw new Error('destination wallet address is required');
    if (!walletId && !cfg.fyStackTreasuryWalletId) {
      throw new Error('FyStack source wallet is required (provide walletId or set FYSTACK_TREASURY_WALLET_ID)');
    }

    const sourceWalletId = walletId || cfg.fyStackTreasuryWalletId;
    const amount = centsToDecimal(amountCents);
    const start = Date.now();
    const result = await this.requestWithdrawal(sourceWalletId, {
      asset: cfg.fyStackAsset || cfg.assetCode,
      assetId: cfg.fyStackAssetId,
      network: cfg.fyStackNetwork,
      amount,
      recipientAddress: destination,
      notes: memo || `DLB Trust FyStack payout ${cfg.fyStackNetwork}`,
    });
    const latencyMs = Date.now() - start;

    const withdrawal = result && (result.withdrawal || result);
    const withdrawalId = withdrawal && (withdrawal.id || withdrawal.withdrawal_id);
    const txHash = withdrawal && (withdrawal.tx_hash || withdrawal.txHash);
    const status = withdrawal && (withdrawal.status || 'PENDING_APPROVAL');
    const autoApproved = result && result.auto_approved;

    let explorer = '';
    if (txHash && cfg.fyStackExplorerTx) {
      explorer = cfg.fyStackExplorerTx.replace('%s', txHash);
    }

    return {
      hash: txHash || withdrawalId || `fys-${Date.now()}`,
      withdrawalId,
      status,
      autoApproved,
      amount,
      memo: memo || null,
      latencyMs,
      explorer,
      simulated: false,
    };
  }
}

module.exports = { FyStackEngine, FyStackClient, centsToDecimal };
