'use strict';

/**
 * Trust Deposit Engine — script fiat and token deposits to beneficiaries.
 *
 * Supports:
 *   - External bank deposits via wire, ACH, or Open Banking credit push
 *   - Internal platform deposits to e-money / SIT wallet
 *
 * The engine creates a `trust_deposits` record, reserves the source funds,
 * calls the appropriate downstream engine, and records the result. Real money
 * only moves externally when a live bank/payment connector is configured.
 */

let pool;
let CashEngine;
try { pool = require('../bonds/pgPool'); } catch (e) { /* optional */ }
try { ({ CashEngine } = require('../cash/cashEngine')); } catch (e) { /* optional */ }

let WireOriginationEngine, OpenBankingEngine, ElectronicMoneyEngine, PayoutCenterEngine;
function loadDeps() {
  try { ({ WireOriginationEngine } = require('./wireOriginationEngine')); } catch (e) { WireOriginationEngine = null; }
  try { ({ OpenBankingEngine } = require('./openBankingEngine')); } catch (e) { OpenBankingEngine = null; }
  try { ({ ElectronicMoneyEngine } = require('./electronicMoneyEngine')); } catch (e) { ElectronicMoneyEngine = null; }
  try { ({ PayoutCenterEngine } = require('../payments/payoutCenterEngine')); } catch (e) { PayoutCenterEngine = null; }
}



function generateId(prefix = 'TDE') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

class TrustDepositEngine {
  static async ensureTables() {
    loadDeps();
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trust_deposits (
        id SERIAL PRIMARY KEY,
        deposit_id TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','sent','confirmed','failed','cancelled','manual_pending','originated')),
        source_type TEXT NOT NULL DEFAULT 'cash',
        source_account_id TEXT,
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        deposit_method TEXT NOT NULL CHECK (deposit_method IN ('wire','ach','open_banking','emoney','sit','check')),
        destination_type TEXT NOT NULL DEFAULT 'bank_account' CHECK (destination_type IN ('bank_account','emoney_account','wallet')),
        destination_name TEXT NOT NULL,
        destination_routing TEXT,
        destination_account TEXT,
        destination_bank_name TEXT,
        destination_emoney_account_id TEXT,
        destination_wallet_address TEXT,
        memo TEXT,
        reference_id TEXT,
        external_payment_id TEXT,
        iso20022_message TEXT,
        raw_response JSONB,
        error_message TEXT,
        initiated_by TEXT NOT NULL DEFAULT 'system',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_trust_deposits_status ON trust_deposits(status)`);
  }

  static async getSourceBalance(sourceType, sourceAccountId) {
    if (sourceType === 'cash') {
      if (!CashEngine) throw new Error('CashEngine not available');
      const acct = await CashEngine.getAccount(sourceAccountId);
      if (!acct) throw new Error(`Cash account not found: ${sourceAccountId}`);
      return parseInt(acct.balance_cents || 0, 10);
    }
    if (sourceType === 'emoney') {
      if (!ElectronicMoneyEngine) throw new Error('ElectronicMoneyEngine not available');
      const acct = await ElectronicMoneyEngine.getAccount(sourceAccountId);
      if (!acct) throw new Error(`E-money account not found: ${sourceAccountId}`);
      return parseInt(acct.balance_cents || 0, 10);
    }
    throw new Error(`Unsupported source type: ${sourceType}`);
  }

  static async createDeposit(opts = {}) {
    loadDeps();
    await this.ensureTables();
    const {
      sourceType = 'cash', sourceAccountId,
      amount, currency = 'USD',
      depositMethod = 'wire',
      destinationType = 'bank_account',
      destinationName, destinationRouting, destinationAccount, destinationBankName,
      destinationEmoneyAccountId, destinationWalletAddress,
      memo, referenceId, initiatedBy = 'system',
    } = opts;
    const amountCents = toCents(amount);
    if (amountCents <= 0) throw new Error('amount must be positive');
    if (!destinationName) throw new Error('destinationName is required');
    if (destinationType === 'bank_account') {
      if (depositMethod !== 'open_banking' && !destinationRouting) throw new Error('destinationRouting is required for bank deposits');
      if (!destinationAccount) throw new Error('destinationAccount is required for bank deposits');
    }
    if (destinationType === 'emoney_account' && !destinationEmoneyAccountId) throw new Error('destinationEmoneyAccountId is required');
    if (destinationType === 'wallet' && !destinationWalletAddress) throw new Error('destinationWalletAddress is required');

    const balance = await this.getSourceBalance(sourceType, sourceAccountId);
    if (balance < amountCents) throw new Error(`Insufficient balance in ${sourceAccountId}: ${balance} < ${amountCents}`);

    const depositId = generateId('TDE');
    let isoMessage = null;
    if (depositMethod === 'open_banking' && OpenBankingEngine) {
      try {
        const { ISO20022 } = require('./openBankingEngine');
        isoMessage = ISO20022.generatePain001({
          paymentId: depositId,
          amount: amountCents / 100,
          currency,
          debtorName: 'DLB Trust',
          debtorAccount: sourceAccountId,
          creditorName: destinationName,
          creditorAccount: destinationAccount,
          creditorBic: destinationBankName,
          remittance: memo || `Trust deposit ${depositId}`,
        });
      } catch (e) { /* best effort */ }
    }

    await pool.query(
      `INSERT INTO trust_deposits
         (deposit_id, status, source_type, source_account_id, amount_cents, currency, deposit_method, destination_type,
          destination_name, destination_routing, destination_account, destination_bank_name,
          destination_emoney_account_id, destination_wallet_address, memo, reference_id, iso20022_message, initiated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [depositId, 'pending', sourceType, sourceAccountId, amountCents, currency, depositMethod, destinationType,
       destinationName, destinationRouting || null, destinationAccount || null, destinationBankName || null,
       destinationEmoneyAccountId || null, destinationWalletAddress || null, memo || null, referenceId || null, isoMessage, initiatedBy]
    );

    return this.getDeposit(depositId);
  }

  static async getDeposit(depositId) {
    if (!pool) throw new Error('Database not available');
    const result = await pool.query('SELECT * FROM trust_deposits WHERE deposit_id = $1', [depositId]);
    return result.rows[0] || null;
  }

  static async listDeposits({ limit = 50, status } = {}) {
    if (!pool) throw new Error('Database not available');
    let sql = 'SELECT * FROM trust_deposits';
    const params = [];
    if (status) { sql += ' WHERE status = $1'; params.push(status); }
    sql += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
    params.push(limit);
    const result = await pool.query(sql, params);
    return result.rows;
  }

  static async sendDeposit(depositId, opts = {}) {
    loadDeps();
    await this.ensureTables();
    const row = await this.getDeposit(depositId);
    if (!row) throw new Error('Deposit not found');
    if (!['pending','approved'].includes(row.status)) throw new Error(`Deposit status is ${row.status}`);
    const getBalance = async () => this.getSourceBalance(row.source_type, row.source_account_id);
    if (await getBalance() < row.amount_cents) throw new Error(`Insufficient balance in ${row.source_account_id}`);

    try {
      if (row.deposit_method === 'emoney' && ElectronicMoneyEngine) {
        const result = await ElectronicMoneyEngine.transfer({
          fromAccountId: row.source_account_id,
          toAccountId: row.destination_emoney_account_id,
          amount: row.amount_cents / 100,
          memo: row.memo,
        });
        await pool.query(`UPDATE trust_deposits SET status='confirmed', external_payment_id=$1, raw_response=$2, updated_at=NOW() WHERE deposit_id=$3`,
          [result.transaction.tx_id, JSON.stringify(result), depositId]);
      } else if (row.deposit_method === 'sit' && PayoutCenterEngine) {
        const result = await PayoutCenterEngine.createPayment({
          paymentType: 'deposit',
          sourceType: row.source_type,
          sourceAccountId: row.source_account_id,
          recipientIdentifier: row.destination_wallet_address,
          amount: row.amount_cents / 100,
          asset: 'SIT',
          rail: 'sit',
          description: row.memo,
        });
        await pool.query(`UPDATE trust_deposits SET status='sent', external_payment_id=$1, raw_response=$2, updated_at=NOW() WHERE deposit_id=$3`,
          [result.payment_id || result.id || null, JSON.stringify(result), depositId]);
      } else if (row.deposit_method === 'wire' || row.deposit_method === 'ach' || row.deposit_method === 'check') {
        if (!WireOriginationEngine) throw new Error('WireOriginationEngine not available');
        const result = await WireOriginationEngine.createPayout({
          sourceType: row.source_type,
          sourceAccountId: row.source_account_id,
          amount: row.amount_cents / 100,
          adapter: row.deposit_method === 'check' ? 'manual' : row.deposit_method,
          initiatedBy: row.initiated_by,
          beneficiaryName: row.destination_name,
          beneficiaryRouting: row.destination_routing,
          beneficiaryAccount: row.destination_account,
          beneficiaryBankName: row.destination_bank_name,
          paymentType: 'vendor_payment',
          purpose: row.memo || `Trust deposit ${depositId}`,
          description: row.memo || `Trust deposit ${depositId}`,
        });
        const mappedStatus = ['sent','confirmed','settled','originated'].includes(result.status) ? 'sent' : (result.status === 'approved' ? 'manual_pending' : result.status);
        await pool.query(
          `UPDATE trust_deposits SET status=$1, external_payment_id=$2, raw_response=$3, updated_at=NOW() WHERE deposit_id=$4`,
          [mappedStatus, result.payout_id, JSON.stringify(result), depositId]
        );
      } else if (row.deposit_method === 'open_banking') {
        if (!OpenBankingEngine) throw new Error('OpenBankingEngine not available');
        const result = await OpenBankingEngine.createPayment({
          sourceCashAccountId: row.source_account_id,
          amount: row.amount_cents / 100,
          connector: opts.connector || 'generic_rest',
          currency: row.currency,
          debtorName: 'DLB Trust',
          debtorAccount: row.source_account_id,
          creditorName: row.destination_name,
          creditorAccount: row.destination_account,
          creditorRouting: row.destination_routing,
          creditorBic: row.destination_bank_name,
          remittance: row.memo || `Trust deposit ${depositId}`,
        });
        const status = result.status === 'failed' ? 'failed' : 'originated';
        await pool.query(
          `UPDATE trust_deposits SET status=$1, external_payment_id=$2, raw_response=$3, error_message=$4, updated_at=NOW() WHERE deposit_id=$5`,
          [status, result.paymentId || null, JSON.stringify(result), result.error || null, depositId]
        );
      } else {
        throw new Error(`Unsupported deposit method: ${row.deposit_method}`);
      }
    } catch (err) {
      await pool.query(`UPDATE trust_deposits SET status='failed', error_message=$1, updated_at=NOW() WHERE deposit_id=$2`, [err.message, depositId]);
      throw err;
    }

    return this.getDeposit(depositId);
  }

  static async cancelDeposit(depositId) {
    const row = await this.getDeposit(depositId);
    if (!row) throw new Error('Deposit not found');
    if (['sent','confirmed','manual_pending','originated'].includes(row.status)) {
      if (row.deposit_method === 'wire' || row.deposit_method === 'ach' || row.deposit_method === 'check') {
        if (WireOriginationEngine && row.external_payment_id) {
          try { await WireOriginationEngine.cancelPayout(row.external_payment_id); } catch (e) { /* best effort */ }
        }
      } else if (row.deposit_method === 'open_banking') {
        if (OpenBankingEngine && row.external_payment_id) {
          try { await OpenBankingEngine.cancelPayment(row.external_payment_id); } catch (e) { /* best effort */ }
        }
      }
    }
    if (!['pending','approved','sent','manual_pending','originated'].includes(row.status)) {
      throw new Error(`Cannot cancel deposit in ${row.status} status`);
    }
    await pool.query(`UPDATE trust_deposits SET status='cancelled', updated_at=NOW() WHERE deposit_id=$1`, [depositId]);
    return this.getDeposit(depositId);
  }

  static async getMessage(depositId) {
    const row = await this.getDeposit(depositId);
    if (!row) throw new Error('Deposit not found');
    if (row.iso20022_message) return { type: 'iso20022', content: row.iso20022_message };
    if (row.external_payment_id && WireOriginationEngine) {
      try { return await WireOriginationEngine.getMessage(row.external_payment_id); } catch (e) { /* fall through */ }
    }
    if (row.external_payment_id && OpenBankingEngine) {
      try {
        const payment = await OpenBankingEngine.getPayment(row.external_payment_id);
        return { type: 'open_banking', content: payment.iso20022_message };
      } catch (e) { /* fall through */ }
    }
    return { type: 'none', instructions: 'No message available' };
  }
}

module.exports = { TrustDepositEngine };
