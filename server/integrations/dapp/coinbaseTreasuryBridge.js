'use strict';

/**
 * Coinbase Treasury Bridge
 *
 * Closes the gap between Treasury Management / Core Banking / Bond / Fixed Income
 * / Trust / Cash / Sub-Ledger ledgers and Coinbase by staging a real fiat
 * deposit to Coinbase, then executing a market buy + on-chain send.
 *
 * Ledger flow:
 *   1. Source ledger -> Treasury (done by SourceOfFundsAdapter._fundSourceToTreasury)
 *   2. Treasury -> Coinbase USD Receivable (when the deposit is initiated)
 *   3. Coinbase USD Receivable -> Coinbase USD (when the deposit lands)
 *   4. Coinbase USD -> Crypto Asset (when the market buy completes)
 *   5. Crypto Asset -> Operator / Safe wallet (when the on-chain send completes)
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const { getConfig } = require('./config');
const { CoinbaseSpotEngine } = require('./coinbaseSpotEngine');
const { SourceOfFundsAdapter } = require('../stablecoin/sourceOfFundsAdapter');
const { TreasuryEngine, DEFAULT_ACCOUNT } = require('../stablecoin/treasuryEngine');

let coinbaseApi;
try { coinbaseApi = require('coinbase-api'); } catch (e) { coinbaseApi = null; }

async function query(sql, params) {
  if (!pool || !pool.query) throw new Error('Postgres pool unavailable');
  return pool.query(sql, params);
}

async function withFallback(fn, fallback) {
  try { return await fn(); } catch (e) { if (!pool) return fallback(e); throw e; }
}

function identifier(prefix = 'CBTB') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

const COINBASE_USD_PENDING = 'COINBASE_USD_PENDING';
const COINBASE_USD = 'COINBASE_USD';

class CoinbaseTreasuryBridge {
  static getConfig() { return getConfig(); }

  static enabled() {
    return CoinbaseSpotEngine.enabled();
  }

  static async ensureTables() {
    await withFallback(async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS coinbase_treasury_transfers (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reserved','deposit_initiated','deposited','buying','sending','completed','failed','needs_deposit','needs_payment_method')),
          source_type TEXT,
          source_account_id TEXT,
          reserve_id TEXT,
          amount_cents NUMERIC NOT NULL,
          fiat_currency TEXT DEFAULT 'USD',
          target_asset TEXT,
          target_network TEXT,
          target_address TEXT,
          coinbase_payment_method_id TEXT,
          coinbase_deposit_id TEXT,
          coinbase_deposit_response JSONB DEFAULT '{}',
          coinbase_order_id TEXT,
          target_amount TEXT,
          withdrawal_id TEXT,
          tx_hash TEXT,
          tx_explorer TEXT,
          ledger_entries JSONB DEFAULT '[]'::jsonb,
          error TEXT,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await query('CREATE INDEX IF NOT EXISTS idx_cbtb_status ON coinbase_treasury_transfers(status);');
    }, () => { /* memory fallback */ });
  }

  static async listTransfers({ status, limit = 50, offset = 0 } = {}) {
    return withFallback(async () => {
      const params = [Math.min(limit, 200), offset];
      const rows = await query(`SELECT * FROM coinbase_treasury_transfers ${status ? 'WHERE status = $3' : ''} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        status ? [params[0], params[1], status] : params);
      return rows.rows;
    }, async () => []);
  }

  static async getTransfer(id) {
    return withFallback(async () => {
      const rows = await query('SELECT * FROM coinbase_treasury_transfers WHERE id = $1', [id]);
      return rows.rows[0] || null;
    }, async () => null);
  }

  static async _insert(transfer) {
    await withFallback(async () => {
      await query(`
        INSERT INTO coinbase_treasury_transfers (id, status, source_type, source_account_id, reserve_id, amount_cents, fiat_currency, target_asset, target_network, target_address, coinbase_payment_method_id, coinbase_deposit_id, coinbase_deposit_response, coinbase_order_id, target_amount, withdrawal_id, tx_hash, tx_explorer, ledger_entries, error, metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
        ON CONFLICT (id) DO UPDATE SET
          status=EXCLUDED.status,
          reserve_id=EXCLUDED.reserve_id,
          coinbase_deposit_id=EXCLUDED.coinbase_deposit_id,
          coinbase_deposit_response=EXCLUDED.coinbase_deposit_response,
          coinbase_order_id=EXCLUDED.coinbase_order_id,
          target_amount=EXCLUDED.target_amount,
          withdrawal_id=EXCLUDED.withdrawal_id,
          tx_hash=EXCLUDED.tx_hash,
          tx_explorer=EXCLUDED.tx_explorer,
          ledger_entries=EXCLUDED.ledger_entries,
          error=EXCLUDED.error,
          metadata=EXCLUDED.metadata,
          updated_at=NOW()
      `, [
        transfer.id, transfer.status, transfer.source_type, transfer.source_account_id, transfer.reserve_id,
        transfer.amount_cents, transfer.fiat_currency, transfer.target_asset, transfer.target_network, transfer.target_address,
        transfer.coinbase_payment_method_id, transfer.coinbase_deposit_id, JSON.stringify(transfer.coinbase_deposit_response || {}),
        transfer.coinbase_order_id, transfer.target_amount, transfer.withdrawal_id, transfer.tx_hash, transfer.tx_explorer,
        JSON.stringify(transfer.ledger_entries || []), transfer.error, JSON.stringify(transfer.metadata || {})
      ]);
    }, () => { /* best effort */ });
  }

  static _addLedger(transfer, entry) {
    transfer.ledger_entries = transfer.ledger_entries || [];
    entry.at = new Date().toISOString();
    transfer.ledger_entries.push(entry);
  }

  static async _ensureAccounts() {
    await TreasuryEngine.getOrCreateAccount(COINBASE_USD_PENDING, { type: 'receivable', assetCode: 'USD' });
    await TreasuryEngine.getOrCreateAccount(COINBASE_USD, { type: 'exchange', assetCode: 'USD' });
  }

  /**
   * Stage a transfer from a source ledger into Coinbase.
   * 1. Reserve / sweep the source ledger balance into the Treasury.
   * 2. Move Treasury USD to a Coinbase USD receivable account (deposit in transit).
   * 3. If a payment_method is supplied, create the Coinbase fiat deposit.
   * 4. If the preview shows no Coinbase USD, return status needs_deposit with instructions.
   */
  static async stageFromSource({
    sourceType,
    sourceAccountId,
    amount,
    targetAsset = 'ETH',
    targetNetwork = 'ethereum',
    targetAddress,
    coinbasePaymentMethodId,
  } = {}) {
    if (!sourceType || !sourceAccountId || !amount) throw new Error('sourceType, sourceAccountId, and amount are required');
    const amountNum = Number(amount);
    if (amountNum <= 0) throw new Error('amount must be positive');
    const amountCents = Math.round(amountNum * 100);

    await this.ensureTables();
    await this._ensureAccounts();
    const cfg = getConfig();
    const transferId = identifier('CBTB');
    const resolvedTarget = targetAddress || (cfg.operatorAddress || '');
    if (!resolvedTarget) throw new Error('targetAddress or DAPP_OPERATOR_ADDRESS required');

    const transfer = {
      id: transferId,
      status: 'pending',
      source_type: sourceType,
      source_account_id: sourceAccountId,
      reserve_id: null,
      amount_cents: amountCents,
      fiat_currency: 'USD',
      target_asset: String(targetAsset).toUpperCase(),
      target_network: targetNetwork,
      target_address: resolvedTarget,
      coinbase_payment_method_id: coinbasePaymentMethodId || '',
      coinbase_deposit_id: '',
      coinbase_deposit_response: {},
      coinbase_order_id: '',
      target_amount: '',
      withdrawal_id: '',
      tx_hash: '',
      tx_explorer: '',
      ledger_entries: [],
      error: '',
      metadata: {},
    };
    await this._insert(transfer);

    // 1. Reserve / sweep the source ledger balance into Treasury
    let reserve;
    try {
      reserve = await SourceOfFundsAdapter._fundSourceToTreasury({
        sourceType,
        sourceAccountId,
        paymentId: transferId,
        amountCents,
      });
      transfer.reserve_id = reserve && (reserve.bondTransactionId || reserve.cashTransactionId || reserve.subLedgerTransactionId || reserve.treasuryId || transferId);
      transfer.status = 'reserved';
      this._addLedger(transfer, { type: 'debit', account: `${sourceType}:${sourceAccountId}`, amount_cents: amountCents, memo: `Sweep to Treasury for Coinbase deposit ${transferId}` });
      this._addLedger(transfer, { type: 'credit', account: DEFAULT_ACCOUNT, amount_cents: amountCents, memo: `Source sweep for Coinbase deposit ${transferId}` });
      await this._insert(transfer);
    } catch (err) {
      transfer.status = 'failed';
      transfer.error = `Source sweep failed: ${(err && err.message) || err}`;
      await this._insert(transfer);
      throw err;
    }

    // 2. Move Treasury USD to Coinbase USD Receivable (deposit in transit)
    try {
      await TreasuryEngine.debit(DEFAULT_ACCOUNT, amountCents, { reason: `Coinbase deposit staging ${transferId}`, source: 'coinbase_treasury' });
      await TreasuryEngine.credit(COINBASE_USD_PENDING, amountCents, { source: 'coinbase_treasury', txHash: '', metadata: { transferId, stage: 'deposit_in_transit' } });
      this._addLedger(transfer, { type: 'debit', account: DEFAULT_ACCOUNT, amount_cents: amountCents, memo: `Move USD to Coinbase deposit in transit ${transferId}` });
      this._addLedger(transfer, { type: 'credit', account: COINBASE_USD_PENDING, amount_cents: amountCents, memo: `Coinbase USD receivable ${transferId}` });
      transfer.status = 'deposit_initiated';
      await this._insert(transfer);
    } catch (err) {
      transfer.status = 'failed';
      transfer.error = `Treasury ledger move failed: ${(err && err.message) || err}`;
      await this._insert(transfer);
      throw err;
    }

    // 3. Optionally initiate the fiat deposit with the Coinbase App API
    if (coinbasePaymentMethodId) {
      try {
        const appClient = CoinbaseSpotEngine._getAppClient();
        const accounts = await appClient.getAccounts();
        const usdAccount = accounts && accounts.data && accounts.data.find(a => a.currency === 'USD' || (a.balance && a.balance.currency === 'USD'));
        if (!usdAccount) throw new Error('No Coinbase USD fiat account found for deposit');

        const deposit = await appClient.depositFunds({
          account_id: usdAccount.id,
          amount: amountNum.toFixed(2),
          currency: 'USD',
          payment_method: coinbasePaymentMethodId,
          commit: false,
        });
        transfer.coinbase_deposit_id = deposit && deposit.id;
        transfer.coinbase_deposit_response = deposit || {};
        transfer.metadata.deposit_status = 'pending_commit';
        if (transfer.coinbase_deposit_id) {
          try {
            const committed = await appClient.commitDeposit({ account_id: usdAccount.id, deposit_id: transfer.coinbase_deposit_id });
            transfer.coinbase_deposit_response = committed || transfer.coinbase_deposit_response;
            transfer.metadata.deposit_status = 'committed';
          } catch (commitErr) {
            transfer.metadata.deposit_status = 'commit_failed';
            transfer.metadata.commit_error = (commitErr && commitErr.message) || String(commitErr);
          }
        }
        await this._insert(transfer);
      } catch (err) {
        transfer.error = `Coinbase deposit initiation failed: ${(err && err.message) || err}; manual wire required`;
        transfer.metadata.deposit_error = (err && err.message) || String(err);
        // Do not fail; the operator can still send a bank wire to Coinbase.
      }
    }

    // 4. Preview the buy to determine whether Coinbase has USD available
    try {
      const preview = await CoinbaseSpotEngine.preview({ amount: amountNum, targetAsset: transfer.target_asset });
      transfer.metadata.preview = preview;
      // Preview succeeded (no errors) — execute immediately
      return this.executeBuyFromTransfer(transfer);
    } catch (err) {
      if (err && err.code === 'needs_deposit') {
        transfer.status = 'needs_deposit';
        transfer.metadata.preview = err.preview || {};
        transfer.error = `Source reserved and deposit staged; Coinbase account needs USD to complete the buy. ${err.message}`;
        await this._insert(transfer);
        return {
          transfer,
          status: 'needs_deposit',
          instructions: {
            amount: amountNum.toFixed(2),
            currency: 'USD',
            method: coinbasePaymentMethodId ? 'coinbase_deposit' : 'manual_wire',
            depositId: transfer.coinbase_deposit_id,
            message: 'Send USD to the connected Coinbase account, then call POST /api/dapp/coinbase-treasury/:id/execute to complete the buy and on-chain send.',
          },
        };
      }
      transfer.status = 'failed';
      transfer.error = (err && err.message) || String(err);
      await this._insert(transfer);
      throw err;
    }
  }

  /**
   * Execute the buy + on-chain send for a transfer whose Coinbase USD deposit has arrived.
   * Moves COINBASE_USD_PENDING -> COINBASE_USD, then calls CoinbaseSpotEngine.executeBuySend.
   */
  static async executeBuyFromTransfer(transfer) {
    if (typeof transfer === 'string') transfer = await this.getTransfer(transfer);
    if (!transfer) throw new Error('Transfer not found');
    const amountNum = Number(transfer.amount_cents) / 100;

    // Move pending USD to Coinbase USD (deposit cleared)
    await TreasuryEngine.debit(COINBASE_USD_PENDING, transfer.amount_cents, { reason: `Coinbase deposit cleared ${transfer.id}`, source: 'coinbase_treasury' });
    await TreasuryEngine.credit(COINBASE_USD, transfer.amount_cents, { source: 'coinbase_treasury', metadata: { transferId: transfer.id, stage: 'deposit_cleared' } });
    this._addLedger(transfer, { type: 'debit', account: COINBASE_USD_PENDING, amount_cents: transfer.amount_cents, memo: `Coinbase deposit cleared ${transfer.id}` });
    this._addLedger(transfer, { type: 'credit', account: COINBASE_USD, amount_cents: transfer.amount_cents, memo: `Coinbase USD balance ${transfer.id}` });
    transfer.status = 'deposited';
    await this._insert(transfer);

    // Create the CoinbaseSpotEngine order (it will record itself in coinbase_spot_orders)
    const order = await CoinbaseSpotEngine._buildOrder({
      sourceType: 'treasury',
      sourceAccountId: COINBASE_USD,
      amount: amountNum,
      targetAsset: transfer.target_asset,
      targetNetwork: transfer.target_network,
      targetAddress: transfer.target_address,
      transferId: transfer.id,
    });

    try {
      const result = await CoinbaseSpotEngine.executeBuySend(order, { amountNum, skipRefund: true });
      transfer.status = result.status;
      transfer.coinbase_order_id = result.order_id || result.id || '';
      transfer.target_amount = result.target_amount || '';
      transfer.withdrawal_id = result.withdrawal_id || '';
      transfer.tx_hash = result.tx_hash || '';
      transfer.tx_explorer = result.tx_explorer || '';
      transfer.error = result.error || '';
      transfer.metadata.coinbase_order_id = result.id || result.order_id || '';

      // Post ledger: Coinbase USD -> Crypto Asset -> Wallet
      this._addLedger(transfer, { type: 'debit', account: COINBASE_USD, amount_cents: transfer.amount_cents, memo: `Buy ${transfer.target_asset} on Coinbase ${transfer.id}` });
      this._addLedger(transfer, { type: 'credit', account: `CRYPTO_${transfer.target_asset}`, amount_crypto: transfer.target_amount, memo: `Crypto asset from Coinbase buy ${transfer.id}` });
      this._addLedger(transfer, { type: 'debit', account: `CRYPTO_${transfer.target_asset}`, amount_crypto: transfer.target_amount, memo: `Send ${transfer.target_asset} to wallet ${transfer.target_address}` });
      this._addLedger(transfer, { type: 'credit', account: `WALLET_${transfer.target_address}`, amount_crypto: transfer.target_amount, memo: `Wallet receipt ${transfer.tx_hash || ''}` });

      await this._insert(transfer);
      return { transfer, order: result };
    } catch (err) {
      transfer.status = 'failed';
      transfer.error = `Buy/send failed: ${(err && err.message) || err}`;
      await this._insert(transfer);
      throw err;
    }
  }

  /**
   * Complete a transfer after an external USD deposit has arrived at Coinbase.
   */
  static async completeDepositAndExecute(transferId) {
    const transfer = await this.getTransfer(transferId);
    if (!transfer) throw new Error('Transfer not found');
    if (transfer.status === 'completed' || transfer.status === 'sending') return this.getTransfer(transferId);
    return this.executeBuyFromTransfer(transfer);
  }
}

module.exports = { CoinbaseTreasuryBridge };
