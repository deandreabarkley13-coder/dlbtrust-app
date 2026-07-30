'use strict';

/**
 * Clearing & Settlement Engine
 *
 * Links every source ledger (Core Banking, Treasury, Bond, Fixed Income,
 * Cash Management, Trust Accounting) to a wallet hierarchy so funds can be
 * cleared from a source account and settled to a destination wallet in a
 * single, auditable, rollback-safe transaction.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const { StablecoinGateway } = require('./stablecoinGateway');
const { SourceOfFundsAdapter } = require('./sourceOfFundsAdapter');
const { getConfig } = require('./config');

const memoryWallets = new Map();
const memoryOrders = new Map();

async function query(sql, params) {
  if (!pool || !pool.query) throw new Error('Postgres pool unavailable');
  return pool.query(sql, params);
}

async function withFallback(fn, fallback) {
  try { return await fn(); } catch (e) { if (!pool) return fallback(e); throw e; }
}

function identifier(prefix = 'CSE') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(num) {
  const n = Number(num);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n * 100)) {
    throw new Error('amount must be a positive USD value with at most two decimals');
  }
  return Math.round(n * 100);
}

class WalletRegistry {
  static async ensureTables() {
    if (!pool) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS stablecoin_wallet_registry (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL DEFAULT '',
          source_type TEXT NOT NULL DEFAULT 'treasury',
          source_account_id TEXT NOT NULL DEFAULT 'TREASURY_HOT',
          address TEXT NOT NULL,
          network TEXT NOT NULL DEFAULT 'testnet',
          wallet_provider TEXT NOT NULL DEFAULT 'direct',
          parent_wallet_id TEXT,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
          metadata JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await query('CREATE INDEX IF NOT EXISTS idx_swr_source ON stablecoin_wallet_registry(source_type, source_account_id);');
      await query('CREATE INDEX IF NOT EXISTS idx_swr_parent ON stablecoin_wallet_registry(parent_wallet_id) WHERE parent_wallet_id IS NOT NULL;');

      await query(`
        CREATE TABLE IF NOT EXISTS stablecoin_clearing_orders (
          id TEXT PRIMARY KEY,
          wallet_id TEXT,
          source_type TEXT NOT NULL,
          source_account_id TEXT NOT NULL,
          destination_wallet TEXT NOT NULL,
          amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
          fee_cents BIGINT NOT NULL DEFAULT 0,
          total_cents BIGINT NOT NULL,
          asset_code TEXT NOT NULL DEFAULT 'USDC',
          network TEXT NOT NULL DEFAULT 'testnet',
          wallet_provider TEXT NOT NULL DEFAULT 'direct',
          payment_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','settled','failed')),
          tx_hash TEXT,
          tx_explorer TEXT,
          error_message TEXT,
          metadata JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await query('CREATE INDEX IF NOT EXISTS idx_sco_status ON stablecoin_clearing_orders(status);');
      await query('CREATE INDEX IF NOT EXISTS idx_sco_payment ON stablecoin_clearing_orders(payment_id);');
    } catch (e) {
      console.warn('[clearingAndSettlement] Postgres table ensure failed:', e.message);
    }
  }

  static async register({ label, sourceType, sourceAccountId, address, network, walletProvider, parentWalletId, metadata = {} }) {
    if (!address) throw new Error('address is required');
    const record = {
      id: identifier('WAL'),
      label: label || '',
      source_type: String(sourceType || 'treasury').toLowerCase(),
      source_account_id: sourceAccountId || 'TREASURY_HOT',
      address: String(address).trim(),
      network: String(network || getConfig().network || 'testnet').toLowerCase(),
      wallet_provider: String(walletProvider || 'direct').toLowerCase(),
      parent_wallet_id: parentWalletId || null,
      status: 'active',
      metadata,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await withFallback(async () => {
      await query(`
        INSERT INTO stablecoin_wallet_registry
          (id, label, source_type, source_account_id, address, network, wallet_provider, parent_wallet_id, status, metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `, [record.id, record.label, record.source_type, record.source_account_id, record.address, record.network, record.wallet_provider, record.parent_wallet_id, record.status, JSON.stringify(record.metadata)]);
    }, () => { memoryWallets.set(record.id, record); });
    return record;
  }

  static async list({ sourceType, sourceAccountId, walletProvider, status = 'active' } = {}) {
    return withFallback(async () => {
      const conditions = ['1=1'];
      const params = [];
      let idx = 1;
      if (sourceType) { conditions.push(`source_type = $${idx}`); params.push(String(sourceType).toLowerCase()); idx++; }
      if (sourceAccountId) { conditions.push(`source_account_id = $${idx}`); params.push(sourceAccountId); idx++; }
      if (walletProvider) { conditions.push(`wallet_provider = $${idx}`); params.push(String(walletProvider).toLowerCase()); idx++; }
      if (status) { conditions.push(`status = $${idx}`); params.push(status); idx++; }
      const rows = await query(`SELECT * FROM stablecoin_wallet_registry WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`, params);
      return rows.rows;
    }, () => {
      let all = Array.from(memoryWallets.values());
      if (sourceType) all = all.filter(w => w.source_type === sourceType.toLowerCase());
      if (sourceAccountId) all = all.filter(w => w.source_account_id === sourceAccountId);
      if (walletProvider) all = all.filter(w => w.wallet_provider === walletProvider.toLowerCase());
      if (status) all = all.filter(w => w.status === status);
      return all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    });
  }

  static async get(id) {
    return withFallback(async () => {
      const rows = await query('SELECT * FROM stablecoin_wallet_registry WHERE id = $1', [id]);
      if (!rows.rows.length) throw new Error(`Wallet not found: ${id}`);
      return rows.rows[0];
    }, () => {
      if (!memoryWallets.has(id)) throw new Error(`Wallet not found: ${id}`);
      return memoryWallets.get(id);
    });
  }

  static async getBySource(sourceType, sourceAccountId) {
    const rows = await WalletRegistry.list({ sourceType, sourceAccountId });
    return rows[0] || null;
  }
}

class ClearingAndSettlementEngine {
  static async ensureTables() {
    await WalletRegistry.ensureTables();
  }

  static async createWallet(input) {
    return WalletRegistry.register(input);
  }

  static async listWallets(filters) {
    return WalletRegistry.list(filters);
  }

  static async getWallet(id) {
    return WalletRegistry.get(id);
  }

  static async _createOrder(input) {
    const cfg = getConfig();
    const amountCents = typeof input.amountCents === 'number' ? input.amountCents : toCents(input.amount);
    const quote = StablecoinGateway.quote({ amountCents, assetCode: input.assetCode, network: input.network });
    const order = {
      id: identifier('CSO'),
      wallet_id: input.walletId || null,
      source_type: String(input.sourceType || 'treasury').toLowerCase(),
      source_account_id: input.sourceAccountId || 'TREASURY_HOT',
      destination_wallet: input.destinationWallet || input.destination || input.address,
      amount_cents: quote.amountCents,
      fee_cents: quote.feeCents,
      total_cents: quote.totalCents,
      asset_code: quote.assetCode,
      network: String(quote.network).toLowerCase(),
      wallet_provider: String(input.walletProvider || 'direct').toLowerCase(),
      payment_id: null,
      status: 'pending',
      tx_hash: null,
      tx_explorer: null,
      error_message: null,
      metadata: input.metadata || {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (!order.destination_wallet) throw new Error('destination wallet address is required');
    await withFallback(async () => {
      await query(`
        INSERT INTO stablecoin_clearing_orders
          (id, wallet_id, source_type, source_account_id, destination_wallet, amount_cents, fee_cents, total_cents, asset_code, network, wallet_provider, payment_id, status, metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      `, [order.id, order.wallet_id, order.source_type, order.source_account_id, order.destination_wallet, order.amount_cents, order.fee_cents, order.total_cents, order.asset_code, order.network, order.wallet_provider, order.payment_id, order.status, JSON.stringify(order.metadata)]);
    }, () => { memoryOrders.set(order.id, order); });
    return order;
  }

  static async _updateOrder(order) {
    await withFallback(async () => {
      await query(`
        UPDATE stablecoin_clearing_orders
        SET status = $2, payment_id = $3, tx_hash = $4, tx_explorer = $5, error_message = $6, metadata = $7, updated_at = NOW()
        WHERE id = $1
      `, [order.id, order.status, order.payment_id, order.tx_hash, order.tx_explorer, order.error_message, JSON.stringify(order.metadata)]);
    }, () => { memoryOrders.set(order.id, order); });
  }

  static async clearAndSettle(input) {
    const order = await ClearingAndSettlementEngine._createOrder(input);
    try {
      const payment = await StablecoinGateway.createPayment({
        amountCents: order.amount_cents,
        assetCode: order.asset_code,
        network: order.network,
        destinationWallet: order.destination_wallet,
        walletProvider: order.wallet_provider,
        sourceType: order.source_type,
        sourceAccountId: order.source_account_id,
        memo: input.memo || `Clearing order ${order.id}`,
        beneficiaryName: input.beneficiaryName || '',
        metadata: { clearingOrderId: order.id, ...order.metadata },
      });
      order.payment_id = payment.id;
      order.status = 'approved';
      await ClearingAndSettlementEngine._updateOrder(order);

      await StablecoinGateway.approvePayment(payment.id, order.source_account_id);
      const settled = await StablecoinGateway.settlePayment(payment.id, { memo: input.memo || `Clearing order ${order.id}` });

      order.status = 'settled';
      order.tx_hash = settled.tx_hash;
      order.tx_explorer = settled.tx_explorer;
      order.metadata = { ...order.metadata, payment, settled };
      await ClearingAndSettlementEngine._updateOrder(order);
      return order;
    } catch (err) {
      order.status = 'failed';
      order.error_message = err.message || 'clearing failed';
      try { await ClearingAndSettlementEngine._updateOrder(order); } catch (e) { console.warn('[clearingAndSettlement] update failed:', e.message); }
      throw err;
    }
  }

  static async fundWallet({ walletId, amount, amountCents, sourceType, sourceAccountId, memo }) {
    const wallet = await WalletRegistry.get(walletId);
    if (wallet.status !== 'active') throw new Error(`Wallet is not active: ${walletId}`);
    return ClearingAndSettlementEngine.clearAndSettle({
      walletId: wallet.id,
      amount: amount || amountCents,
      amountCents,
      sourceType: sourceType || wallet.source_type,
      sourceAccountId: sourceAccountId || wallet.source_account_id,
      destinationWallet: wallet.address,
      network: wallet.network,
      walletProvider: wallet.wallet_provider,
      memo: memo || `Fund wallet ${wallet.label || wallet.id}`,
    });
  }

  static async batchClearAndSettle(items) {
    const results = [];
    for (const item of items) {
      try {
        results.push({ ok: true, order: await ClearingAndSettlementEngine.clearAndSettle(item) });
      } catch (err) {
        results.push({ ok: false, error: err.message, item });
      }
    }
    return results;
  }

  static async getOrder(id) {
    return withFallback(async () => {
      const rows = await query('SELECT * FROM stablecoin_clearing_orders WHERE id = $1', [id]);
      if (!rows.rows.length) throw new Error(`Clearing order not found: ${id}`);
      return rows.rows[0];
    }, () => {
      if (!memoryOrders.has(id)) throw new Error(`Clearing order not found: ${id}`);
      return memoryOrders.get(id);
    });
  }

  static async listOrders({ status, limit = 50, offset = 0 } = {}) {
    return withFallback(async () => {
      const params = [Math.min(limit, 200), offset];
      const rows = await query(`SELECT * FROM stablecoin_clearing_orders ${status ? 'WHERE status = $3' : ''} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        status ? [params[0], params[1], status] : params);
      return rows.rows;
    }, () => {
      const capped = Math.min(Number(limit) || 50, 200);
      let all = Array.from(memoryOrders.values()).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      if (status) all = all.filter(o => o.status === status);
      return all.slice(offset, offset + capped);
    });
  }
}

module.exports = { ClearingAndSettlementEngine, WalletRegistry };
