'use strict';

/**
 * Stablecoin Payment Gateway.
 *
 * Orchestrates treasury holds, on-chain settlement, and Magic wallet resolution.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const { getConfig, isProduction } = require('./config');
const { TreasuryEngine, DEFAULT_ACCOUNT } = require('./treasuryEngine');
const { BlockchainEngine } = require('./blockchainEngine');
const { MagicWalletService } = require('./magicWalletService');
const { SourceOfFundsAdapter } = require('./sourceOfFundsAdapter');

const memoryPayments = new Map();

function identifier(prefix = 'SCP') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(num) {
  const n = Number(num);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n * 100)) {
    throw new Error('amount must be a positive USD value with at most two decimals');
  }
  return Math.round(n * 100);
}

function totalCents(amountCents, feeCents) {
  return amountCents + feeCents;
}

async function query(sql, params) {
  if (!pool || !pool.query) throw new Error('Postgres pool unavailable');
  return pool.query(sql, params);
}

async function withFallback(fn, fallback) {
  try { return await fn(); } catch (e) { if (!pool) return fallback(e); throw e; }
}

class StablecoinGateway {
  static async ensureTables() {
    await TreasuryEngine.ensureTables();
    if (!pool) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS stablecoin_payments (
          id TEXT PRIMARY KEY,
          payment_hub_intent_id TEXT UNIQUE,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','settled','failed')),
          amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
          fee_cents BIGINT NOT NULL DEFAULT 0,
          total_cents BIGINT NOT NULL,
          asset_code TEXT NOT NULL DEFAULT 'USDC',
          network TEXT NOT NULL DEFAULT 'testnet',
          destination_wallet TEXT,
          wallet_provider TEXT,
          source_type TEXT DEFAULT 'treasury',
          source_account_id TEXT,
          source_ref JSONB DEFAULT '{}',
          reserve_id TEXT,
          tx_hash TEXT,
          tx_ledger TEXT,
          tx_explorer TEXT,
          latency_ms INTEGER,
          memo TEXT,
          metadata JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await query('CREATE INDEX IF NOT EXISTS idx_scp_status ON stablecoin_payments(status);');
      await query(`ALTER TABLE stablecoin_payments ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'treasury';`);
      await query(`ALTER TABLE stablecoin_payments ADD COLUMN IF NOT EXISTS source_ref JSONB DEFAULT '{}';`);
    } catch (e) {
      console.warn('[stablecoinGateway] Postgres table ensure failed:', e.message);
    }
  }

  static async readiness({ publicHealth } = {}) {
    const cfg = getConfig();
    if (publicHealth) {
      const blockchain = await new BlockchainEngine().readiness();
      return {
        ready: cfg.enabled && blockchain.ready,
        mode: cfg.mode,
        network: cfg.network,
        assetCode: cfg.assetCode,
      };
    }
    const treasury = await TreasuryEngine.getPosition(DEFAULT_ACCOUNT).catch(err => ({ ready: false, error: err.message }));
    const blockchain = await new BlockchainEngine().readiness();
    const magic = new MagicWalletService().readiness();
    const issues = [];
    if (!cfg.enabled) issues.push('STABLECOIN_ENABLED is not true');
    if (!blockchain.ready) issues.push(...blockchain.issues);
    return {
      ready: cfg.enabled && blockchain.ready,
      issues,
      treasury: { ok: typeof treasury.balanceCents === 'number', ...treasury },
      blockchain,
      magic,
    };
  }

  static quote({ amountCents, assetCode = 'USDC', network = 'testnet' }) {
    const cfg = getConfig();
    const fee = cfg.gatewayFeeCents;
    return {
      assetCode: assetCode.toUpperCase(),
      network,
      amountCents,
      feeCents: fee,
      totalCents: totalCents(amountCents, fee),
    };
  }

  static async createPayment(input) {
    const cfg = getConfig();
    const amountCents = typeof input.amountCents === 'number' ? input.amountCents : toCents(input.amount);
    const quote = StablecoinGateway.quote({ amountCents, assetCode: input.assetCode, network: input.network });
    if (quote.network !== cfg.network) throw new Error(`Payment network ${quote.network} does not match configured stablecoin network ${cfg.network}`);
    if (quote.assetCode.toUpperCase() !== cfg.assetCode.toUpperCase()) throw new Error(`Payment asset ${quote.assetCode} does not match configured asset ${cfg.assetCode}`);
    const id = identifier('SCP');
    const destination = input.destinationWallet || input.walletAddress || '';
    if (!destination) throw new Error('destinationWallet is required');

    const record = {
      id,
      payment_hub_intent_id: input.paymentHubIntentId || null,
      status: 'pending',
      amount_cents: quote.amountCents,
      fee_cents: quote.feeCents,
      total_cents: quote.totalCents,
      asset_code: quote.assetCode,
      network: quote.network,
      destination_wallet: destination,
      wallet_provider: input.walletProvider || 'direct',
      source_type: String(input.sourceType || 'treasury').toLowerCase(),
      source_account_id: input.sourceAccountId || input.sourceAccount || DEFAULT_ACCOUNT,
      source_ref: {},
      memo: input.memo || `DLB Trust stablecoin payment ${id}`,
      metadata: { beneficiaryName: input.beneficiaryName || '', ...input.metadata },
      reserve_id: null,
      tx_hash: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await withFallback(async () => {
      await query(`
        INSERT INTO stablecoin_payments
        (id, payment_hub_intent_id, status, amount_cents, fee_cents, total_cents, asset_code, network,
         destination_wallet, wallet_provider, source_type, source_account_id, source_ref, memo, metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      `, [record.id, record.payment_hub_intent_id, record.status, record.amount_cents, record.fee_cents,
          record.total_cents, record.asset_code, record.network, record.destination_wallet,
          record.wallet_provider, record.source_type, record.source_account_id, JSON.stringify(record.source_ref),
          record.memo, JSON.stringify(record.metadata)]);
    }, () => { memoryPayments.set(id, record); });

    return { id: record.id, ...record };
  }

  static async getPayment(id) {
    return withFallback(async () => {
      const rows = await query('SELECT * FROM stablecoin_payments WHERE id = $1', [id]);
      if (!rows.rows.length) throw new Error(`Stablecoin payment not found: ${id}`);
      return rows.rows[0];
    }, () => {
      if (!memoryPayments.has(id)) throw new Error(`Stablecoin payment not found: ${id}`);
      return memoryPayments.get(id);
    });
  }

  static async listPayments({ status, limit = 50, offset = 0 } = {}) {
    return withFallback(async () => {
      const params = [Math.min(limit, 200), offset];
      const rows = await query(`SELECT * FROM stablecoin_payments ${status ? 'WHERE status = $3' : ''} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        status ? [params[0], params[1], status] : params);
      return rows.rows;
    }, () => {
      const capped = Math.min(Number(limit) || 50, 200);
      const all = Array.from(memoryPayments.values()).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      let filtered = status ? all.filter(p => p.status === status) : all;
      return filtered.slice(offset, offset + capped);
    });
  }

  static async approvePayment(id, accountId = DEFAULT_ACCOUNT) {
    const payment = await StablecoinGateway.getPayment(id);
    if (payment.status !== 'pending') throw new Error(`Cannot approve payment in ${payment.status} status`);
    // Only override the source account for treasury payments; non-treasury sources
    // keep the account they were created with so the real balance can be swept.
    if (accountId && (payment.source_type === 'treasury' || payment.source_type === undefined || payment.source_type === null)) {
      payment.source_account_id = accountId;
    }
    const reserve = await SourceOfFundsAdapter.reserve(payment);
    payment.status = 'approved';
    payment.source_ref = reserve;
    payment.reserve_id = reserve.reserveId || null;
    payment.updated_at = new Date().toISOString();
    await StablecoinGateway._update(payment);
    return payment;
  }

  static async settlePayment(id, { memo, destinationSecret } = {}) {
    let payment = await StablecoinGateway.getPayment(id);
    if (payment.status === 'settled') return payment;
    if (!['pending', 'approved'].includes(payment.status)) {
      throw new Error(`Cannot settle payment in ${payment.status} status`);
    }
    if (payment.status === 'pending') payment = await StablecoinGateway.approvePayment(id, payment.source_account_id);

    const blockchain = new BlockchainEngine();
    let result;
    try {
      result = await blockchain.settle({
        destination: payment.destination_wallet,
        amountCents: payment.amount_cents,
        memo: memo || payment.memo,
        destinationSecret,
      });
    } catch (err) {
      await StablecoinGateway.failPayment(id, err.message || 'blockchain settlement failed');
      throw err;
    }

    // Persist the on-chain result before finalizing source ledgers so a retry
    // cannot trigger a second blockchain send if source posting fails.
    payment.status = 'settled';
    payment.tx_hash = result.hash;
    payment.tx_ledger = String(result.ledger);
    payment.tx_explorer = result.explorer;
    payment.latency_ms = result.latencyMs;
    payment.updated_at = new Date().toISOString();

    try {
      const sourcePost = await SourceOfFundsAdapter.post(payment, result.hash, { settledAmountCents: payment.amount_cents });
      payment.source_ref = { ...payment.source_ref, post: sourcePost };
    } catch (postErr) {
      payment.metadata = { ...payment.metadata, postError: postErr.message };
      console.warn(`[stablecoinGateway] source post failed after on-chain send for ${payment.id}:`, postErr.message);
    }
    await SourceOfFundsAdapter.recordCrmAndDocuments(payment, result.hash);
    await StablecoinGateway._update(payment);
    return payment;
  }

  static async failPayment(id, error) {
    const payment = await StablecoinGateway.getPayment(id);
    await SourceOfFundsAdapter.release(payment);
    payment.status = 'failed';
    payment.metadata = { ...payment.metadata, error };
    payment.updated_at = new Date().toISOString();
    await StablecoinGateway._update(payment);
    return payment;
  }

  static async _update(payment) {
    await withFallback(async () => {
      await query(`
        UPDATE stablecoin_payments
        SET status = $2, reserve_id = $3, tx_hash = $4, tx_ledger = $5, tx_explorer = $6,
            latency_ms = $7, source_type = $8, source_account_id = $9, source_ref = $10,
            metadata = $11, updated_at = NOW()
        WHERE id = $1
      `, [payment.id, payment.status, payment.reserve_id || null, payment.tx_hash || null,
          payment.tx_ledger || null, payment.tx_explorer || null, payment.latency_ms || null,
          payment.source_type || 'treasury', payment.source_account_id || DEFAULT_ACCOUNT,
          JSON.stringify(payment.source_ref || {}), JSON.stringify(payment.metadata)]);
    }, () => { memoryPayments.set(payment.id, payment); });
  }

  /* ─── Payment Hub integration ─────────────────────────────────────────── */

  static async createFromIntent(intent) {
    const cfg = getConfig();
    const destination = intent.metadata && intent.metadata.destination_wallet;
    const network = intent.metadata && intent.metadata.network || cfg.network;
    const assetCode = intent.metadata && intent.metadata.asset_code || cfg.assetCode;
    const walletProvider = intent.metadata && intent.metadata.wallet_provider || 'direct';
    if (!destination) throw new Error('Stablecoin intent requires metadata.destination_wallet');
    if (network !== cfg.network) throw new Error(`Payment network ${network} does not match configured stablecoin network ${cfg.network}`);
    if (String(assetCode).toUpperCase() !== cfg.assetCode.toUpperCase()) throw new Error(`Payment asset ${assetCode} does not match configured asset ${cfg.assetCode}`);
    const sourceType = intent.metadata && intent.metadata.source_type || 'treasury';
    const sourceAccountId = intent.metadata && intent.metadata.source_account_id || DEFAULT_ACCOUNT;
    return StablecoinGateway.createPayment({
      paymentHubIntentId: intent.intent_id,
      amountCents: Number(intent.amount_cents),
      assetCode,
      network,
      destinationWallet: destination,
      walletProvider,
      sourceType,
      sourceAccountId,
      beneficiaryName: intent.beneficiary_name,
      memo: `PaymentHub ${intent.intent_id}`,
      metadata: { paymentHubIntentId: intent.intent_id, rail: 'stablecoin' },
    });
  }

  static async settleFromIntent(intent) {
    const rows = await withFallback(async () => {
      const r = await query('SELECT * FROM stablecoin_payments WHERE payment_hub_intent_id = $1', [intent.intent_id]);
      return r.rows;
    }, () => Array.from(memoryPayments.values()).filter(p => p.payment_hub_intent_id === intent.intent_id));

    let payment = rows[0];
    if (!payment) payment = await StablecoinGateway.createFromIntent(intent);
    return StablecoinGateway.settlePayment(payment.id);
  }
}

module.exports = { StablecoinGateway, DEFAULT_ACCOUNT };
