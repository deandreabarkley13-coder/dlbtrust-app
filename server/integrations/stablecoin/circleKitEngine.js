'use strict';

/**
 * Circle App Kit Engine — mainnet stablecoin send/payout rail.
 *
 * Uses the @circle-fin/app-kit SDK with either a Viem private-key adapter or a
 * Circle Wallets (developer-controlled) adapter. A Circle Kit key is optional
 * for `send` (it is required for swap/bridge operations), but can be supplied
 * for rate-limiting and telemetry.
 */

const { getConfig } = require('./config');

let AppKit;
let createViemAdapterFromPrivateKey;
let createCircleWalletsAdapter;
let resolveChainIdentifier;

function loadModules() {
  if (AppKit) return;
  const appKit = require('@circle-fin/app-kit');
  const viemAdapter = require('@circle-fin/adapter-viem-v2');
  const cwAdapter = require('@circle-fin/adapter-circle-wallets');
  AppKit = appKit.AppKit;
  createViemAdapterFromPrivateKey = viemAdapter.createViemAdapterFromPrivateKey;
  createCircleWalletsAdapter = cwAdapter.createCircleWalletsAdapter;
  resolveChainIdentifier = viemAdapter.resolveChainIdentifier;
}

function centsToDecimal(cents) {
  const value = Number(cents);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('amountCents must be a non-negative safe integer');
  }
  return (value / 100).toFixed(2);
}

class CircleKitEngine {
  constructor() {
    this.cfg = getConfig();
    this.adapter = null;
  }

  _inShadow() {
    return this.cfg.mode === 'shadow' || this.cfg.circleShadow === true;
  }

  _adapterType() {
    return (this.cfg.circleAdapterType || 'viem').toLowerCase();
  }

  _getAdapter() {
    if (this.adapter) return this.adapter;
    loadModules();

    const type = this._adapterType();
    if (type === 'circle-wallets') {
      if (!this.cfg.circleApiKey) throw new Error('CIRCLE_API_KEY is required for Circle Wallets adapter');
      if (!this.cfg.circleEntitySecret) throw new Error('CIRCLE_ENTITY_SECRET is required for Circle Wallets adapter');
      this.adapter = createCircleWalletsAdapter({
        apiKey: this.cfg.circleApiKey,
        entitySecret: this.cfg.circleEntitySecret,
      });
    } else {
      if (!this.cfg.circlePrivateKey) throw new Error('CIRCLE_PRIVATE_KEY is required for Viem adapter');
      this.adapter = createViemAdapterFromPrivateKey({
        privateKey: this.cfg.circlePrivateKey,
      });
    }
    return this.adapter;
  }

  async _sourceAddress() {
    const cfg = this.cfg;
    if (cfg.circleSourceAddress) return cfg.circleSourceAddress;

    if (this._adapterType() === 'circle-wallets') {
      throw new Error('CIRCLE_SOURCE_ADDRESS is required for Circle Wallets adapter');
    }

    loadModules();
    const adapter = this._getAdapter();
    if (adapter.getAddress) {
      const chainDef = resolveChainIdentifier(cfg.circleChain || 'Ethereum');
      return adapter.getAddress(chainDef);
    }
    throw new Error('CIRCLE_SOURCE_ADDRESS is required (or adapter must support getAddress)');
  }

  async readiness() {
    const cfg = this.cfg;
    const issues = [];
    const warnings = [];

    if (!cfg.circleEnabled) issues.push('CIRCLE_ENABLED is not true');
    if (!cfg.circleChain) issues.push('CIRCLE_CHAIN is required (e.g. Ethereum, Base, Arbitrum)');

    if (!this._inShadow()) {
      if (this._adapterType() === 'circle-wallets') {
        if (!cfg.circleApiKey) issues.push('CIRCLE_API_KEY is required');
        if (!cfg.circleEntitySecret) issues.push('CIRCLE_ENTITY_SECRET is required');
        if (!cfg.circleSourceAddress) issues.push('CIRCLE_SOURCE_ADDRESS is required for Circle Wallets adapter');
      } else {
        if (!cfg.circlePrivateKey) issues.push('CIRCLE_PRIVATE_KEY is required for Viem adapter');
      }
    }

    if (!cfg.circleKitKey) warnings.push('CIRCLE_KIT_KEY is not set (optional for send, required for swap/bridge)');

    if (this._inShadow()) {
      warnings.push('Circle App Kit engine is running in shadow/simulation mode');
      return { ready: issues.length === 0, issues, warnings, network: cfg.circleChain, assetCode: cfg.assetCode, simulated: true };
    }

    let address = null;
    if (issues.length === 0) {
      try {
        loadModules();
        address = await this._sourceAddress();
      } catch (e) {
        issues.push(`Adapter failed to resolve source address: ${e.message}`);
      }
    }

    return {
      ready: issues.length === 0,
      issues,
      warnings,
      network: cfg.circleChain,
      assetCode: cfg.assetCode,
      sourceAddress: address,
    };
  }

  async getBalance(walletId) {
    if (this._inShadow()) return '0.00';
    const cfg = this.cfg;
    const adapter = this._getAdapter();
    const chain = walletId || cfg.circleChain || 'Ethereum';
    if (adapter.readNativeBalance) {
      const native = await adapter.readNativeBalance({ chain });
      return String(native || '0');
    }
    return null;
  }

  async getSourceAddress() {
    if (this._inShadow()) return '0xCircleShadow' + Date.now().toString(16);
    return this._sourceAddress();
  }

  async settle({ destination, amountCents, memo, walletId } = {}) {
    const cfg = this.cfg;
    if (this._inShadow()) {
      return {
        hash: `circle-shadow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        status: 'success',
        amount: centsToDecimal(amountCents),
        memo: memo || null,
        latencyMs: 0,
        explorer: '',
        simulated: true,
      };
    }

    if (!destination) throw new Error('destination wallet address is required');
    const chain = cfg.circleChain || 'Ethereum';
    const amount = centsToDecimal(amountCents);

    loadModules();
    const adapter = this._getAdapter();
    const sourceAddress = walletId || (await this._sourceAddress());
    const kit = new AppKit();

    const from = { adapter, chain, address: sourceAddress };

    const start = Date.now();
    let result;
    try {
      result = await kit.send({
        from,
        to: destination,
        amount,
        token: cfg.circleToken || cfg.assetCode || 'USDC',
      });
    } catch (err) {
      throw new Error(`Circle App Kit send failed: ${err.message || err}`);
    }
    const latencyMs = Date.now() - start;

    const tx = result && (result.result || result);
    const txHash = tx && (tx.txHash || tx.transactionHash);
    const status = tx && (tx.state || 'success');
    const explorer = tx && (tx.explorerUrl || '');

    return {
      hash: txHash || `circle-${Date.now()}`,
      status,
      amount,
      memo: memo || null,
      latencyMs,
      explorer,
      simulated: false,
    };
  }
}

module.exports = { CircleKitEngine, centsToDecimal };
