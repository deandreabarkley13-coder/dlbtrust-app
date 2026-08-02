'use strict';

/**
 * Coinbase HBAR funding engine.
 *
 * Bridges fiat (USD cash in a Coinbase account) into HBAR on Hedera:
 * 1. Check/preview Coinbase USD balance.
 * 2. Submit a market buy order for HBAR-USD.
 * 3. Send the purchased HBAR to a target Hedera EVM address/account.
 *
 * Also supports direct withdrawal of HBAR already held in Coinbase.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const { getConfig } = require('./config');
const { TreasuryEngine } = require('./treasuryEngine');

let coinbaseApi;

try {
  coinbaseApi = require('coinbase-api');
} catch (e) {
  coinbaseApi = null;
}

const memoryOrders = new Map();

function identifier() {
  return `CHB-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

async function query(sql, params) {
  if (!pool || !pool.query) throw new Error('Postgres pool unavailable');
  return pool.query(sql, params);
}

async function withFallback(fn, fallback) {
  try { return await fn(); } catch (e) { if (!pool) return fallback(e); throw e; }
}

class CoinbaseHbarEngine {
  static getConfig() {
    return getConfig();
  }

  static enabled() {
    const cfg = getConfig();
    return cfg.coinbaseHbarEnabled && cfg.coinbaseCdpKeyName && cfg.coinbaseCdpPrivateKey;
  }

  static _getAdvancedClient() {
    const cfg = getConfig();
    if (!coinbaseApi) throw new Error('coinbase-api dependency is not installed');
    if (!cfg.coinbaseCdpKeyName || !cfg.coinbaseCdpPrivateKey) {
      throw new Error('Coinbase CDP API key is not configured');
    }
    return new coinbaseApi.CBAdvancedTradeClient({
      apiKey: cfg.coinbaseCdpKeyName,
      apiSecret: cfg.coinbaseCdpPrivateKey,
    });
  }

  static _getAppClient() {
    const cfg = getConfig();
    if (!coinbaseApi) throw new Error('coinbase-api dependency is not installed');
    if (!cfg.coinbaseCdpKeyName || !cfg.coinbaseCdpPrivateKey) {
      throw new Error('Coinbase CDP API key is not configured');
    }
    return new coinbaseApi.CBAppClient({
      apiKey: cfg.coinbaseCdpKeyName,
      apiSecret: cfg.coinbaseCdpPrivateKey,
    });
  }

  static async ensureTables() {
    await withFallback(async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS coinbase_hbar_orders (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','buying','withdrawing','completed','failed','needs_deposit')),
          direction TEXT NOT NULL DEFAULT 'fund' CHECK (direction IN ('fund','withdraw')),
          fiat_amount NUMERIC(16,2),
          fiat_currency TEXT DEFAULT 'USD',
          hbar_amount TEXT,
          target_address TEXT NOT NULL,
          source_type TEXT,
          source_account_id TEXT,
          reserve_id TEXT,
          order_id TEXT,
          withdrawal_id TEXT,
          tx_hash TEXT,
          tx_explorer TEXT,
          error TEXT,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await query('CREATE INDEX IF NOT EXISTS idx_cbhbar_status ON coinbase_hbar_orders(status);');
      await query('CREATE INDEX IF NOT EXISTS idx_cbhbar_address ON coinbase_hbar_orders(target_address);');
    }, () => { /* memory fallback */ });
  }

  static async _listMemory() { return Array.from(memoryOrders.values()); }
  static async _getMemory(id) { return memoryOrders.get(id); }
  static _setMemory(order) { memoryOrders.set(order.id, order); }

  static async listOrders({ status, limit = 50, offset = 0 } = {}) {
    return withFallback(async () => {
      const params = [Math.min(limit, 200), offset];
      const rows = await query(`SELECT * FROM coinbase_hbar_orders ${status ? 'WHERE status = $3' : ''} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        status ? [params[0], params[1], status] : params);
      return rows.rows;
    }, async () => {
      const all = await this._listMemory();
      if (status) return all.filter(o => o.status === status).slice(offset, offset + limit);
      return all.slice(offset, offset + limit);
    });
  }

  static async getOrder(id) {
    return withFallback(async () => {
      const rows = await query('SELECT * FROM coinbase_hbar_orders WHERE id = $1', [id]);
      if (!rows.rows.length) throw new Error(`Coinbase HBAR order not found: ${id}`);
      return rows.rows[0];
    }, async () => {
      const o = this._getMemory(id);
      if (!o) throw new Error(`Coinbase HBAR order not found: ${id}`);
      return o;
    });
  }

  static async _updateOrder(order) {
    order.updated_at = new Date().toISOString();
    return withFallback(async () => {
      await query(`
        INSERT INTO coinbase_hbar_orders
        (id, status, direction, fiat_amount, fiat_currency, hbar_amount, target_address,
         source_type, source_account_id, reserve_id, order_id, withdrawal_id, tx_hash, tx_explorer, error, metadata, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          hbar_amount = EXCLUDED.hbar_amount,
          reserve_id = EXCLUDED.reserve_id,
          order_id = EXCLUDED.order_id,
          withdrawal_id = EXCLUDED.withdrawal_id,
          tx_hash = EXCLUDED.tx_hash,
          tx_explorer = EXCLUDED.tx_explorer,
          error = EXCLUDED.error,
          metadata = EXCLUDED.metadata,
          updated_at = EXCLUDED.updated_at
      `, [order.id, order.status, order.direction, order.fiat_amount, order.fiat_currency, order.hbar_amount,
          order.target_address, order.source_type, order.source_account_id, order.reserve_id, order.order_id,
          order.withdrawal_id, order.tx_hash, order.tx_explorer, order.error, order.metadata,
          order.created_at, order.updated_at]);
    }, () => { this._setMemory(order); });
  }

  static async getBalances() {
    const app = this._getAppClient();
    const accounts = await app.getAccounts();
    const list = (accounts.data || []).map(a => ({
      id: a.id,
      currency: a.currency?.code || a.currency,
      balance: a.balance?.amount || '0',
      allowDeposits: a.allow_deposits,
      allowWithdrawals: a.allow_withdrawals,
    }));
    const hbar = list.find(a => a.currency === 'HBAR') || { balance: '0' };
    const usd = list.find(a => a.currency === 'USD') || { balance: '0' };
    return { accounts: list, hbar: hbar.balance, usd: usd.balance };
  }

  static async quote({ fiatAmount, fiatCurrency = 'USD' } = {}) {
    if (!fiatAmount || Number(fiatAmount) <= 0) throw new Error('fiatAmount required');
    const app = this._getAppClient();
    const price = await app.getSpotPrice({ currencyPair: 'HBAR-USD' });
    const spot = Number(price.data?.amount || 0);
    if (!spot) throw new Error('Could not fetch HBAR spot price');
    const hbar = Number(fiatAmount) / spot;
    return {
      fiatAmount: Number(fiatAmount).toFixed(2),
      fiatCurrency,
      spotPrice: spot.toFixed(6),
      estimatedHbar: hbar.toFixed(6),
    };
  }

  static async previewBuy({ fiatAmount } = {}) {
    if (!fiatAmount || Number(fiatAmount) <= 0) throw new Error('fiatAmount required');
    const adv = this._getAdvancedClient();
    return adv.previewOrder({
      product_id: 'HBAR-USD',
      side: 'BUY',
      order_configuration: { market_market_ioc: { quote_size: Number(fiatAmount).toFixed(2) } },
      client_order_id: adv.generateNewOrderId(),
    });
  }

  static async _buyHbar(fiatAmount) {
    const adv = this._getAdvancedClient();
    const result = await adv.submitOrder({
      product_id: 'HBAR-USD',
      side: 'BUY',
      order_configuration: { market_market_ioc: { quote_size: Number(fiatAmount).toFixed(2) } },
      client_order_id: adv.generateNewOrderId(),
    });
    return result;
  }

  static async _sendHbar({ accountId, amount, targetAddress }) {
    const app = this._getAppClient();
    const result = await app.sendMoney({
      account_id: accountId,
      type: 'send',
      to: targetAddress,
      amount: amount,
      currency: 'HBAR',
    });
    return result;
  }

  static async _findAccount(currency) {
    const balances = await this.getBalances();
    const account = balances.accounts.find(a => a.currency === currency);
    if (!account) throw new Error(`No Coinbase ${currency} account found`);
    return account;
  }

  static async fund({ fiatAmount, targetAddress, sourceType = 'treasury', sourceAccountId = 'TREASURY_HOT', autoBuy = true } = {}) {
    if (!fiatAmount || Number(fiatAmount) <= 0) throw new Error('fiatAmount required');
    if (!targetAddress) throw new Error('targetAddress required');
    if (!this.enabled()) throw new Error('Coinbase HBAR funding is not configured');

    const cfg = getConfig();
    const order = {
      id: identifier(),
      status: 'pending',
      direction: 'fund',
      fiat_amount: Number(fiatAmount).toFixed(2),
      fiat_currency: 'USD',
      hbar_amount: null,
      target_address: targetAddress,
      source_type: sourceType,
      source_account_id: sourceAccountId,
      reserve_id: null,
      order_id: null,
      withdrawal_id: null,
      tx_hash: null,
      tx_explorer: null,
      error: null,
      metadata: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    try {
      const balances = await this.getBalances();
      const usdAccount = balances.accounts.find(a => a.currency === 'USD');
      if (!usdAccount) throw new Error('No USD account in Coinbase');
      const usdAvailable = Number(usdAccount.balance || 0);

      if (cfg.coinbaseHbarShadow) {
        order.status = 'completed';
        order.hbar_amount = (Number(fiatAmount) / 0.15).toFixed(6); // rough mock
        order.tx_hash = `shadow-${Date.now()}`;
        order.tx_explorer = `https://hashscan.io/mainnet/transaction/${order.tx_hash}`;
        await this._updateOrder(order);
        return order;
      }

      if (usdAvailable < Number(fiatAmount)) {
        order.status = 'needs_deposit';
        order.error = `USD cash balance ${usdAvailable} is less than requested ${fiatAmount}. Deposit USD to Coinbase first.`;
        await this._updateOrder(order);
        return order;
      }

      // Reserve source ledger if configured
      if (sourceType && sourceAccountId) {
        try {
          const reserve = await TreasuryEngine.reserve(sourceType, sourceAccountId, Math.round(Number(fiatAmount) * 100), `cbhbar:${order.id}`);
          order.reserve_id = reserve?.reserveId || `RES-${order.id}`;
        } catch (e) {
          console.warn('[CoinbaseHbarEngine] source reserve skipped:', e.message);
        }
      }

      order.status = 'buying';
      await this._updateOrder(order);

      let buyResult = null;
      if (autoBuy) {
        buyResult = await this._buyHbar(fiatAmount);
        order.order_id = buyResult?.order_id || buyResult?.data?.order_id || null;
        order.metadata = { ...order.metadata, buyResult };
      }

      // Wait a moment for HBAR settlement, then fetch HBAR account
      await new Promise(r => setTimeout(r, 2000));
      const hbarAccount = await this._findAccount('HBAR');
      const hbarBalance = Number(hbarAccount.balance || 0);
      if (!hbarBalance) throw new Error('HBAR purchase did not settle in time');

      order.status = 'withdrawing';
      order.hbar_amount = String(hbarBalance);
      await this._updateOrder(order);

      const send = await this._sendHbar({ accountId: hbarAccount.id, amount: String(hbarBalance), targetAddress });
      order.withdrawal_id = send?.data?.id || send?.data?.transaction?.id || null;
      order.tx_hash = send?.data?.id || send?.data?.transaction?.network || `coinbase-${Date.now()}`;
      order.tx_explorer = `https://hashscan.io/mainnet/transaction/${order.tx_hash}`;
      order.status = 'completed';

      if (order.reserve_id) {
        try { await TreasuryEngine.post(sourceType, sourceAccountId, Math.round(Number(fiatAmount) * 100), `cbhbar:${order.id}`); } catch (e) { /* no-op */ }
      }
    } catch (e) {
      order.status = 'failed';
      order.error = e.message;
      if (order.reserve_id) {
        try { await TreasuryEngine.rollback(order.reserve_id); } catch (err) { /* no-op */ }
      }
    }

    await this._updateOrder(order);
    return order;
  }

  static async withdraw({ amount, targetAddress } = {}) {
    if (!amount || Number(amount) <= 0) throw new Error('amount required');
    if (!targetAddress) throw new Error('targetAddress required');
    if (!this.enabled()) throw new Error('Coinbase HBAR funding is not configured');

    const order = {
      id: identifier(),
      status: 'pending',
      direction: 'withdraw',
      fiat_amount: null,
      fiat_currency: null,
      hbar_amount: String(amount),
      target_address: targetAddress,
      source_type: null,
      source_account_id: null,
      reserve_id: null,
      order_id: null,
      withdrawal_id: null,
      tx_hash: null,
      tx_explorer: null,
      error: null,
      metadata: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    try {
      const hbarAccount = await this._findAccount('HBAR');
      const send = await this._sendHbar({ accountId: hbarAccount.id, amount: String(amount), targetAddress });
      order.withdrawal_id = send?.data?.id || send?.data?.transaction?.id || null;
      order.tx_hash = send?.data?.id || `coinbase-${Date.now()}`;
      order.tx_explorer = `https://hashscan.io/mainnet/transaction/${order.tx_hash}`;
      order.status = 'completed';
    } catch (e) {
      order.status = 'failed';
      order.error = e.message;
    }

    await this._updateOrder(order);
    return order;
  }
}

module.exports = { CoinbaseHbarEngine };
