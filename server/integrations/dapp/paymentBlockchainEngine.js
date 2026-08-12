'use strict';

/**
 * PaymentBlockchainEngine
 *
 * Payment API for blockchain rails. Records a payment intent in
 * `blockchain_payments`, executes via WalletEngine (wallet-to-wallet or
 * wallet-to-address) or StablecoinEngine/SettlementEngine (on-chain stablecoin
 * settle), and reconciles the result.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const { getConfig } = require('./config');

let WalletEngine, StablecoinEngine, SettlementEngine, Web3Engine, TrustAccountingEngine;
function loadDeps() {
  try { ({ WalletEngine } = require('./walletEngine')); } catch (e) { WalletEngine = null; }
  try { ({ StablecoinEngine } = require('./stablecoinEngine')); } catch (e) { StablecoinEngine = null; }
  try { ({ SettlementEngine } = require('./settlementEngine')); } catch (e) { SettlementEngine = null; }
  try { ({ Web3Engine } = require('./web3Engine')); } catch (e) { Web3Engine = null; }
  try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) { TrustAccountingEngine = null; }
}

function id(prefix = 'BPAY') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }
function toCents(amount) { return Math.round((Number(amount) || 0) * 100); }
function safeJson(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v); }

async function query(sql, params) {
  if (!pool || !pool.query) throw new Error('Postgres pool unavailable');
  return pool.query(sql, params);
}

class PaymentBlockchainEngine {
  static async ensureTables() {
    if (!pool) return;
    await query(`
      CREATE TABLE IF NOT EXISTS blockchain_payments (
        payment_id TEXT PRIMARY KEY,
        rail TEXT NOT NULL CHECK (rail IN ('wallet','stablecoin','ptc','manual')),
        source_type TEXT,
        source_account_id TEXT,
        from_wallet_id TEXT,
        to_address TEXT,
        asset TEXT NOT NULL DEFAULT 'SIT',
        amount_cents BIGINT NOT NULL,
        memo TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reserved','submitted','settled','completed','failed','cancelled')),
        settlement_id TEXT,
        tx_hash TEXT,
        error_message TEXT,
        metadata JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_blockchain_payments_status ON blockchain_payments(status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_blockchain_payments_rail ON blockchain_payments(rail)`);
  }

  static _rowToObject(row) {
    if (!row) return null;
    const out = { ...row, amount: (row.amount_cents || 0) / 100 };
    if (row.metadata && typeof row.metadata === 'object') out.metadata = row.metadata;
    return out;
  }

  static async createPayment({ rail = 'wallet', sourceType, sourceAccountId, fromWalletId, to, asset = 'SIT', amount, memo = '', metadata = {} } = {}) {
    loadDeps();
    await this.ensureTables();
    if (!to || !amount) throw new Error('to and amount required');
    if (rail === 'wallet' && !fromWalletId) throw new Error('fromWalletId required for wallet rail');
    const paymentId = id();
    const amountCents = toCents(amount);
    if (amountCents <= 0) throw new Error('amount must be positive');

    let settlementId = null;
    if (rail === 'stablecoin' && SettlementEngine) {
      const settlement = await SettlementEngine.createSettlement({
        rail: 'stablecoin',
        sourceType: sourceType || 'manual',
        sourceAccountId,
        creditorName: 'Blockchain Recipient',
        creditorAccount: to,
        amount,
        currency: 'USD',
        description: memo || `Blockchain payment ${paymentId}`,
        config: metadata || {},
      });
      settlementId = settlement.settlement_id;
    }

    await query(`
      INSERT INTO blockchain_payments (payment_id, rail, source_type, source_account_id, from_wallet_id, to_address, asset, amount_cents, memo, status, settlement_id, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11::jsonb)
    `, [paymentId, rail, sourceType || null, sourceAccountId || null, fromWalletId || null, to, asset.toUpperCase(), amountCents, memo || null, settlementId, safeJson({ ...metadata, settlementId })]);

    return this.getPayment(paymentId);
  }

  static async getPayment(paymentId) {
    loadDeps();
    await this.ensureTables();
    const res = await query('SELECT * FROM blockchain_payments WHERE payment_id = $1', [paymentId]);
    return this._rowToObject(res.rows[0]);
  }

  static async listPayments({ status, rail, limit = 50, offset = 0 } = {}) {
    loadDeps();
    await this.ensureTables();
    const conditions = []; const params = []; let idx = 1;
    if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
    if (rail) { conditions.push(`rail = $${idx++}`); params.push(rail); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Math.min(limit, 200), offset);
    const res = await query(`SELECT * FROM blockchain_payments ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`, params);
    return res.rows.map(r => this._rowToObject(r));
  }

  static async executePayment(paymentId) {
    loadDeps();
    await this.ensureTables();
    const payment = await this.getPayment(paymentId);
    if (!payment) throw new Error('Payment not found');
    if (!['pending', 'reserved'].includes(payment.status)) throw new Error(`Payment cannot be executed from status ${payment.status}`);

    try {
      if (payment.rail === 'wallet') {
        if (!WalletEngine) throw new Error('WalletEngine not available');
        if (payment.source_account_id && payment.asset.toUpperCase() === 'SIT') {
          await WalletEngine.fundWallet({
            walletId: payment.from_wallet_id,
            amount: payment.amount,
            asset: 'SIT',
            sourceType: payment.source_type || 'treasury',
            sourceAccountId: payment.source_account_id,
            memo: `Fund for ${paymentId}`,
          });
        }
        const result = await WalletEngine.transfer({
          fromWalletId: payment.from_wallet_id,
          toAddress: payment.to_address,
          amount: payment.amount,
          asset: payment.asset,
          memo: payment.memo || `Blockchain payment ${paymentId}`,
        });
        await query(`UPDATE blockchain_payments SET status='completed', tx_hash=$1, metadata=jsonb_set(metadata,'{result}',$2::jsonb), updated_at=NOW() WHERE payment_id=$3`, [result.txHash || null, safeJson(result), paymentId]);
      } else if (payment.rail === 'stablecoin') {
        if (!SettlementEngine) throw new Error('SettlementEngine not available');
        const settlement = await SettlementEngine.executeSettlement(payment.settlement_id);
        const status = settlement.status === 'settled' ? 'completed' : (settlement.status === 'submitted' ? 'submitted' : 'failed');
        await query(`UPDATE blockchain_payments SET status=$1, tx_hash=$2, metadata=jsonb_set(metadata,'{settlement}',$3::jsonb), updated_at=NOW() WHERE payment_id=$4`, [status, settlement.external_id || null, safeJson(settlement), paymentId]);
      } else if (payment.rail === 'ptc') {
        if (!StablecoinEngine) throw new Error('StablecoinEngine not available');
        const result = await StablecoinEngine.settle({ to: payment.to_address, amount: payment.amount, memo: payment.memo, operatorEmail: 'payment-blockchain-engine' });
        await query(`UPDATE blockchain_payments SET status='completed', tx_hash=$1, metadata=jsonb_set(metadata,'{settlement}',$2::jsonb), updated_at=NOW() WHERE payment_id=$3`, [result.txHash || null, safeJson(result), paymentId]);
      } else {
        throw new Error(`Unsupported rail: ${payment.rail}`);
      }
    } catch (err) {
      await query(`UPDATE blockchain_payments SET status='failed', error_message=$1, updated_at=NOW() WHERE payment_id=$2`, [err.message, paymentId]);
      throw err;
    }

    return this.getPayment(paymentId);
  }

  static async cancelPayment(paymentId) {
    loadDeps();
    await this.ensureTables();
    const payment = await this.getPayment(paymentId);
    if (!payment) throw new Error('Payment not found');
    if (!['pending', 'reserved'].includes(payment.status)) throw new Error('Payment cannot be cancelled');
    if (payment.settlement_id && SettlementEngine) {
      try { await SettlementEngine.cancelSettlement(payment.settlement_id); } catch (e) { /* best effort */ }
    }
    await query(`UPDATE blockchain_payments SET status='cancelled', updated_at=NOW() WHERE payment_id=$1`, [paymentId]);
    return this.getPayment(paymentId);
  }

  static async getInfo() {
    loadDeps();
    return {
      rails: ['wallet', 'ptc', 'stablecoin'],
      walletReady: !!WalletEngine,
      stablecoinReady: !!StablecoinEngine,
      settlementReady: !!SettlementEngine,
      operatorAddress: getConfig().operatorAddress,
    };
  }
}

module.exports = { PaymentBlockchainEngine };
