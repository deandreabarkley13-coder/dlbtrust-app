'use strict';

/**
 * Coinbase Spot Off-Ramp Engine
 *
 * Reserves a source-of-funds ledger balance, market-buys USDC/ETH on Coinbase
 * Advanced Trade with USD from the linked Coinbase account, then sends the
 * purchased crypto to the operator / Safe wallet via the Coinbase App API.
 *
 * This creates a real on-chain funding event from an internal ledger entry,
 * but requires the Coinbase account to hold or be able to settle USD for the
 * buy order (bank deposit, existing fiat balance, etc.).
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const { getConfig } = require('./config');
const { SourceOfFundsAdapter } = require('../stablecoin/sourceOfFundsAdapter');

let coinbaseApi;
try { coinbaseApi = require('coinbase-api'); } catch (e) { coinbaseApi = null; }

let viem, privateKeyToAccount;
try { ({ default: viem, privateKeyToAccount } = require('viem')); } catch (e) { }

const memoryOrders = new Map();

function identifier(prefix = 'CBS') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

async function query(sql, params) {
  if (!pool || !pool.query) throw new Error('Postgres pool unavailable');
  return pool.query(sql, params);
}

async function withFallback(fn, fallback) {
  try { return await fn(); } catch (e) { if (!pool) return fallback(e); throw e; }
}

function getOperatorAddress(cfg) {
  try {
    if (viem && privateKeyToAccount && cfg.privateKey) return privateKeyToAccount(cfg.privateKey).address;
  } catch (e) { /* fall through */ }
  return cfg.operatorAddress || '';
}

function productIdFor(asset) {
  // Coinbase Advanced Trade stablecoin-to-fiat pairs (e.g. USDC-USD) are not
  // available for every key/region. Direct USD pairs like ETH-USD / BTC-USD are
  // the most reliable way to convert fiat into on-chain value.
  const map = { ETH: 'ETH-USD', BTC: 'BTC-USD' };
  const a = asset.toUpperCase();
  return map[a] || `${a}-USD`;
}

class CoinbaseSpotEngine {
  static getConfig() { return getConfig(); }

  static enabled() {
    const cfg = getConfig();
    return !!(cfg.coinbaseCdpKeyName && cfg.coinbaseCdpPrivateKey);
  }

  static _getAdvancedClient() {
    const cfg = getConfig();
    if (!coinbaseApi) throw new Error('coinbase-api dependency is not installed');
    if (!cfg.coinbaseCdpKeyName || !cfg.coinbaseCdpPrivateKey) throw new Error('Coinbase CDP API key not configured');
    return new coinbaseApi.CBAdvancedTradeClient({
      apiKey: cfg.coinbaseCdpKeyName,
      apiSecret: cfg.coinbaseCdpPrivateKey,
    });
  }

  static _getAppClient() {
    const cfg = getConfig();
    if (!coinbaseApi) throw new Error('coinbase-api dependency is not installed');
    if (!cfg.coinbaseCdpKeyName || !cfg.coinbaseCdpPrivateKey) throw new Error('Coinbase CDP API key not configured');
    return new coinbaseApi.CBAppClient({
      apiKey: cfg.coinbaseCdpKeyName,
      apiSecret: cfg.coinbaseCdpPrivateKey,
    });
  }

  static async ensureTables() {
    await withFallback(async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS coinbase_spot_orders (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','previewing','buying','sending','completed','failed','needs_deposit')),
          source_type TEXT,
          source_account_id TEXT,
          reserve_id TEXT,
          fiat_amount NUMERIC(16,2),
          fiat_currency TEXT DEFAULT 'USD',
          target_asset TEXT,
          target_network TEXT,
          target_address TEXT,
          target_amount TEXT,
          order_id TEXT,
          order_response JSONB DEFAULT '{}',
          withdrawal_id TEXT,
          withdrawal_response JSONB DEFAULT '{}',
          tx_hash TEXT,
          tx_explorer TEXT,
          error TEXT,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await query('CREATE INDEX IF NOT EXISTS idx_cbspot_status ON coinbase_spot_orders(status);');
    }, () => { /* memory fallback */ });
  }

  static async listOrders({ status, limit = 50, offset = 0 } = {}) {
    return withFallback(async () => {
      const params = [Math.min(limit, 200), offset];
      const rows = await query(`SELECT * FROM coinbase_spot_orders ${status ? 'WHERE status = $3' : ''} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        status ? [params[0], params[1], status] : params);
      return rows.rows;
    }, async () => {
      const all = Array.from(memoryOrders.values());
      if (status) return all.filter(o => o.status === status).slice(offset, offset + limit);
      return all.slice(offset, offset + limit);
    });
  }

  static async getOrder(id) {
    return withFallback(async () => {
      const rows = await query('SELECT * FROM coinbase_spot_orders WHERE id = $1', [id]);
      return rows.rows[0] || null;
    }, async () => memoryOrders.get(id) || null);
  }

  static async _insert(order) {
    await withFallback(async () => {
      await query(`
        INSERT INTO coinbase_spot_orders (id, status, source_type, source_account_id, reserve_id, fiat_amount, fiat_currency, target_asset, target_network, target_address, target_amount, order_id, order_response, withdrawal_id, withdrawal_response, tx_hash, tx_explorer, error, metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        ON CONFLICT (id) DO UPDATE SET
          status=EXCLUDED.status,
          target_amount=EXCLUDED.target_amount,
          order_id=EXCLUDED.order_id,
          order_response=EXCLUDED.order_response,
          withdrawal_id=EXCLUDED.withdrawal_id,
          withdrawal_response=EXCLUDED.withdrawal_response,
          tx_hash=EXCLUDED.tx_hash,
          tx_explorer=EXCLUDED.tx_explorer,
          error=EXCLUDED.error,
          metadata=EXCLUDED.metadata,
          updated_at=NOW()
      `, [
        order.id, order.status, order.source_type, order.source_account_id, order.reserve_id,
        order.fiat_amount, order.fiat_currency, order.target_asset, order.target_network,
        order.target_address, order.target_amount, order.order_id, JSON.stringify(order.order_response || {}),
        order.withdrawal_id, JSON.stringify(order.withdrawal_response || {}), order.tx_hash,
        order.tx_explorer, order.error, JSON.stringify(order.metadata || {})
      ]);
    }, () => { memoryOrders.set(order.id, order); });
  }

  static _setError(order, err) {
    order.status = 'failed';
    order.error = err.message || String(err);
    return this._insert(order);
  }

  static async preview({ amount, targetAsset = 'ETH' } = {}) {
    const client = this._getAdvancedClient();
    const productId = productIdFor(targetAsset);
    try {
      const preview = await client.previewOrder({
        product_id: productId,
        side: 'BUY',
        order_configuration: { market_market_ioc: { quote_size: String(Number(amount).toFixed(2)) } },
      });
      const errors = preview && Array.isArray(preview.errs) ? preview.errs : [];
      const needsDeposit = errors.some(e => /INSUFFICIENT_FUND|TOO_SMALL/i.test(e));
      if (errors.length) {
        const code = needsDeposit ? 'needs_deposit' : 'preview_failed';
        const e = new Error(`Coinbase preview for ${productId}: ${errors.join(', ')}`);
        e.code = code;
        e.preview = { productId, supportedAssets: ['ETH', 'BTC'], needsDeposit, errors, ...preview };
        throw e;
      }
      return { productId, supportedAssets: ['ETH', 'BTC'], needsDeposit: false, errors: [], ...preview };
    } catch (err) {
      if (err && err.code === 'needs_deposit') throw err;
      const msg = err && (err.body && err.body.message) || err.message || String(err);
      throw new Error(`Coinbase preview failed for ${productId}: ${msg}. Supported on-ramp assets: ETH, BTC.`);
    }
  }

  /**
   * Fund the operator/Safe wallet by reserving an internal ledger balance and
   * buying the target asset on Coinbase with fiat, then sending it on-chain.
   */
  static async fundFromSource({
    sourceType,
    sourceAccountId,
    amount,
    targetAsset = 'USDC',
    targetNetwork = 'ethereum',
    targetAddress,
  } = {}) {
    sourceType = String(sourceType || '').toLowerCase();
    if (!sourceType || !sourceAccountId || !amount) throw new Error('sourceType, sourceAccountId, and amount are required');
    const amountNum = Number(amount);
    if (amountNum <= 0) throw new Error('amount must be positive');
    const amountCents = Math.round(amountNum * 100);

    await this.ensureTables();
    const cfg = getConfig();
    const orderId = identifier('CBS');
    const resolvedTarget = targetAddress || getOperatorAddress(cfg);
    if (!resolvedTarget) throw new Error('targetAddress or DAPP_PRIVATE_KEY required');

    const order = {
      id: orderId,
      status: 'pending',
      source_type: sourceType,
      source_account_id: sourceAccountId,
      reserve_id: null,
      fiat_amount: amountNum,
      fiat_currency: 'USD',
      target_asset: String(targetAsset).toUpperCase(),
      target_network: targetNetwork,
      target_address: resolvedTarget,
      target_amount: '',
      order_id: '',
      order_response: {},
      withdrawal_id: '',
      withdrawal_response: {},
      tx_hash: '',
      tx_explorer: '',
      error: '',
      metadata: {},
    };
    await this._insert(order);

    // 1. Reserve the source ledger balance
    let reserve;
    try {
      reserve = await SourceOfFundsAdapter._fundSourceToTreasury({
        sourceType,
        sourceAccountId,
        paymentId: orderId,
        amountCents,
      });
      order.reserve_id = reserve && (reserve.bondTransactionId || reserve.cashTransactionId || reserve.subLedgerTransactionId || reserve.treasuryId || orderId);
    } catch (err) { await this._setError(order, err); throw err; }

    // 2. Preview / submit the buy order on Coinbase Advanced Trade
    const advClient = this._getAdvancedClient();
    const productId = productIdFor(order.target_asset);
    if (!['ETH-USD', 'BTC-USD'].includes(productId)) {
      const err = new Error(`Coinbase Spot off-ramp supports ETH and BTC only (got ${order.target_asset}). USDC-USD is not available on this Advanced Trade key.`);
      await this._setError(order, err);
      throw err;
    }
    const quoteSize = String(amountNum.toFixed(2));
    let preview;
    try {
      preview = await advClient.previewOrder({
        product_id: productId,
        side: 'BUY',
        order_configuration: { market_market_ioc: { quote_size: quoteSize } },
      });
      order.metadata.preview = preview;
      const errors = preview && Array.isArray(preview.errs) ? preview.errs : [];
      if (errors.length) {
        const needsDeposit = errors.some(e => /INSUFFICIENT_FUND|TOO_SMALL/i.test(e));
        const err = new Error(`Coinbase preview for ${productId}: ${errors.join(', ')}`);
        err.code = needsDeposit ? 'needs_deposit' : 'preview_failed';
        order.status = needsDeposit ? 'needs_deposit' : 'failed';
        order.error = err.message;
        await this._refundSource(order, reserve, amountCents);
        await this._insert(order);
        throw err;
      }
    } catch (err) {
      if (err && err.code !== 'needs_deposit') await this._refundSource(order, reserve, amountCents);
      if (order.status !== 'needs_deposit') await this._setError(order, err);
      else await this._insert(order);
      throw err;
    }

    let submitted;
    try {
      order.status = 'buying';
      await this._insert(order);
      submitted = await advClient.submitOrder({
        product_id: productId,
        side: 'BUY',
        order_configuration: { market_market_ioc: { quote_size: quoteSize } },
      });
      order.order_response = submitted || {};
      if (!submitted || submitted.success === false || (submitted.error_response && submitted.error_response.error)) {
        const errorDetail = submitted && submitted.error_response;
        const err = new Error(`Coinbase buy failed for ${productId}: ${(errorDetail && (errorDetail.message || errorDetail.error || errorDetail.preview_failure_reason)) || 'unknown'}`);
        err.code = (errorDetail && errorDetail.error) || 'buy_failed';
        throw err;
      }
      order.order_id = submitted.order_id || submitted.id || '';
      order.target_amount = submitted.filled_size || (preview && preview.base_size) || '';
    } catch (err) {
      // If the buy fails because of insufficient USD, rollback the ledger reserve
      await this._refundSource(order, reserve, amountCents);
      await this._setError(order, err);
      throw err;
    }

    // 3. Send purchased crypto to the target wallet using the Coinbase App API
    try {
      order.status = 'sending';
      await this._insert(order);
      const appClient = this._getAppClient();
      const accounts = await appClient.getAccounts();
      const account = accounts && accounts.data && accounts.data.find(a => a.currency === order.target_asset || (a.balance && a.balance.currency === order.target_asset));
      if (!account) throw new Error(`No Coinbase ${order.target_asset} wallet account found for withdrawal`);
      if (!order.target_amount) throw new Error(`Coinbase buy did not return a filled size; cannot send ${order.target_asset}`);

      const send = await appClient.sendMoney({
        account_id: account.id,
        type: 'send',
        to: resolvedTarget,
        amount: order.target_amount || quoteSize,
        currency: order.target_asset,
        network: targetNetwork,
        idem: order.id,
      });
      order.withdrawal_id = send && send.data && send.data.id;
      order.withdrawal_response = send;
      order.tx_hash = send && send.data && (send.data.network || send.data.transaction ? (send.data.network && send.data.network.hash) || (send.data.transaction && send.data.transaction.id) : '') || '';
      order.tx_explorer = order.tx_hash ? `https://${targetNetwork === 'ethereum' ? '' : targetNetwork + '.'}etherscan.io/tx/${order.tx_hash}` : '';
      order.status = order.tx_hash ? 'completed' : 'sending';
    } catch (err) {
      const errMsg = (err && (err.message || err.error || err.detail || err.title)) || (typeof err === 'string' ? err : 'Unknown Coinbase send error');
      order.error = `Bought ${order.target_asset} but withdrawal failed: ${errMsg}`;
      order.status = 'failed';
      await this._insert(order);
      // Note: crypto is now held in Coinbase; manual send required.
      throw err || new Error(errMsg);
    }

    await this._insert(order);
    return order;
  }

  static async _refundSource(order, reserve, amountCents) {
    try {
      await SourceOfFundsAdapter._refundSourceFromTreasury({
        sourceType: order.source_type,
        sourceAccountId: order.source_account_id,
        sourceRef: { reserveId: order.reserve_id, ...(reserve || {}) },
        amountCents,
        payment: { id: order.id },
      });
    } catch (e) { /* best-effort rollback */ }
  }
}

module.exports = { CoinbaseSpotEngine };
