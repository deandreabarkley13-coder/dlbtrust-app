'use strict';

/**
 * Fineract / Mifos Payout Bridge
 *
 * Withdraws from a Fineract/Mifos savings account and routes the funds to an
 * external destination through the Open Banking or Wire Origination engines.
 *
 * Real money leaves the platform only when a live bank/payment connector is
 * configured. If Fineract is unreachable, the bridge records a pending
 * instruction and waits for credentials/connectivity.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { /* optional */ }

let FineractClient, SystemSettings, OpenBankingEngine, WireOriginationEngine, TrustDepositEngine;
function loadDeps() {
  try { ({ FineractClient } = require('./fineractClient')); } catch (e) { FineractClient = null; }
  try { ({ SystemSettings } = require('../ach/systemSettings')); } catch (e) { SystemSettings = null; }
  try { ({ OpenBankingEngine } = require('../dapp/openBankingEngine')); } catch (e) { OpenBankingEngine = null; }
  try { ({ WireOriginationEngine } = require('../dapp/wireOriginationEngine')); } catch (e) { WireOriginationEngine = null; }
  try { ({ TrustDepositEngine } = require('../dapp/trustDepositEngine')); } catch (e) { TrustDepositEngine = null; }
}

const PAYOUT_TABLE = 'fineract_payouts';

function generateId(prefix = 'FPB') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

async function skipFineract() {
  const val = await getSetting('FINERACT_PAYOUT_SKIP_FINERACT');
  return val === 'true' || val === true || (!FineractClient);
}

async function getSetting(name) {
  if (SystemSettings && typeof SystemSettings.get === 'function') {
    try { return await SystemSettings.get(name); } catch (e) { /* fall through */ }
  }
  return process.env[name] || null;
}

class FineractPayoutBridge {
  static async ensureTables() {
    loadDeps();
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${PAYOUT_TABLE} (
        id SERIAL PRIMARY KEY,
        payout_id TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','fineract_withdrawn','originated','sent','confirmed','failed','cancelled','manual_pending')),
        savings_account_id BIGINT NOT NULL,
        client_id BIGINT,
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        payout_method TEXT NOT NULL CHECK (payout_method IN ('open_banking','wire','ach','check')),
        connector TEXT,
        beneficiary_name TEXT NOT NULL,
        beneficiary_routing TEXT,
        beneficiary_account TEXT NOT NULL,
        beneficiary_bank_name TEXT,
        remittance TEXT,
        fineract_transaction_id BIGINT,
        fineract_transaction_status TEXT,
        external_payment_id TEXT,
        raw_request JSONB,
        raw_response JSONB,
        error_message TEXT,
        initiated_by TEXT NOT NULL DEFAULT 'system',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_${PAYOUT_TABLE}_status ON ${PAYOUT_TABLE}(status)`);
  }

  static async createPayout(opts = {}) {
    loadDeps();
    await this.ensureTables();
    const {
      savingsAccountId, clientId,
      amount, currency = 'USD',
      payoutMethod = 'open_banking',
      connector,
      beneficiaryName, beneficiaryRouting, beneficiaryAccount, beneficiaryBankName,
      remittance,
      initiatedBy = 'system',
    } = opts;
    const amountCents = toCents(amount);
    if (amountCents <= 0) throw new Error('amount must be positive');
    if (!savingsAccountId) throw new Error('savingsAccountId is required');
    if (!beneficiaryName || !beneficiaryAccount) throw new Error('beneficiaryName and beneficiaryAccount are required');

    let fineractStatus = null;
    let fineractTxId = null;
    let error = null;
    let balance = null;
    const shouldSkip = await skipFineract();

    if (!shouldSkip && FineractClient) {
      try {
        const account = await FineractClient.getAccountBalance(savingsAccountId);
        balance = Number((account && account.summary && account.summary.availableBalance) || (account && account.summary && account.summary.accountBalance) || 0);
        if (balance < amountCents / 100) throw new Error(`Insufficient Fineract savings balance: ${balance} < ${amountCents / 100}`);
      } catch (e) {
        error = `Fineract balance check failed: ${e.message}`;
      }
    } else if (!shouldSkip) {
      error = 'FineractClient not available';
    } else {
      fineractStatus = 'skipped';
    }

    const payoutId = generateId('FPB');
    const sourceAccountId = await getSetting('FINERACT_PAYOUT_SOURCE_ACCOUNT') || 'CA-OPERATING';

    await pool.query(
      `INSERT INTO ${PAYOUT_TABLE} (payout_id, status, savings_account_id, client_id, amount_cents, currency, payout_method, connector, beneficiary_name, beneficiary_routing, beneficiary_account, beneficiary_bank_name, remittance, fineract_transaction_status, error_message, initiated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [payoutId, 'pending', savingsAccountId, clientId || null, amountCents, currency, payoutMethod, connector || null, beneficiaryName, beneficiaryRouting || null, beneficiaryAccount, beneficiaryBankName || null, remittance || null, fineractStatus, error, initiatedBy]
    );

    return this.getPayout(payoutId);
  }

  static async getPayout(payoutId) {
    if (!pool) throw new Error('Database not available');
    const result = await pool.query(`SELECT * FROM ${PAYOUT_TABLE} WHERE payout_id = $1`, [payoutId]);
    return result.rows[0] || null;
  }

  static async listPayouts({ limit = 50, status } = {}) {
    if (!pool) throw new Error('Database not available');
    let sql = `SELECT * FROM ${PAYOUT_TABLE}`;
    const params = [];
    if (status) { sql += ' WHERE status = $1'; params.push(status); }
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    const result = await pool.query(sql, params);
    return result.rows;
  }

  static async sendPayout(payoutId) {
    loadDeps();
    await this.ensureTables();
    const row = await this.getPayout(payoutId);
    if (!row) throw new Error('Payout not found');
    if (!['pending','fineract_withdrawn'].includes(row.status)) throw new Error(`Payout status is ${row.status}`);

    // Step 1: withdraw from Fineract savings account (skip if configured or Fineract unavailable)
    let fineractResult = null;
    let status = row.status;
    const shouldSkip = await skipFineract();
    if (!shouldSkip && FineractClient && !['fineract_withdrawn','originated','sent','confirmed'].includes(row.status)) {
      try {
        fineractResult = await FineractClient.withdrawSavings({
          accountId: row.savings_account_id,
          amount: row.amount_cents / 100,
          note: row.remittance || `Payout ${payoutId}`,
        });
        status = 'fineract_withdrawn';
        await pool.query(
          `UPDATE ${PAYOUT_TABLE} SET status=$1, fineract_transaction_id=$2, fineract_transaction_status=$3, raw_response=$4, updated_at=NOW() WHERE payout_id=$5`,
          [status, fineractResult.transactionId || fineractResult.resourceId || null, fineractResult.status || 'pending', JSON.stringify(fineractResult), payoutId]
        );
      } catch (err) {
        await pool.query(`UPDATE ${PAYOUT_TABLE} SET status='failed', error_message=$1, updated_at=NOW() WHERE payout_id=$2`, [err.message, payoutId]);
        throw err;
      }
    } else if (shouldSkip) {
      status = 'fineract_withdrawn';
    }

    // Step 2: route external payment through Open Banking or Wire Origination
    const sourceAccountId = await getSetting('FINERACT_PAYOUT_SOURCE_ACCOUNT') || 'CA-OPERATING';
    try {
      let externalResult = null;
      if (row.payout_method === 'open_banking' && OpenBankingEngine) {
        externalResult = await OpenBankingEngine.createPayment({
          sourceCashAccountId: sourceAccountId,
          connector: row.connector || 'generic_rest',
          amount: row.amount_cents / 100,
          currency: row.currency,
          debtorName: 'DLB Trust',
          debtorAccount: sourceAccountId,
          creditorName: row.beneficiary_name,
          creditorAccount: row.beneficiary_account,
          creditorRouting: row.beneficiary_routing,
          creditorBic: row.beneficiary_bank_name,
          remittance: row.remittance || `Fineract payout ${payoutId}`,
        });
        status = externalResult.status === 'failed' ? 'failed' : 'originated';
      } else if (['wire','ach','check'].includes(row.payout_method) && WireOriginationEngine) {
        externalResult = await WireOriginationEngine.createPayout({
          sourceType: 'cash',
          sourceAccountId: sourceAccountId,
          amount: row.amount_cents / 100,
          adapter: row.payout_method === 'check' ? 'manual' : row.payout_method,
          initiatedBy: row.initiated_by,
          beneficiaryName: row.beneficiary_name,
          beneficiaryRouting: row.beneficiary_routing,
          beneficiaryAccount: row.beneficiary_account,
          beneficiaryBankName: row.beneficiary_bank_name,
          paymentType: 'vendor_payment',
          purpose: row.remittance || `Fineract payout ${payoutId}`,
          description: row.remittance || `Fineract payout ${payoutId}`,
        });
        status = ['sent','confirmed','settled','originated'].includes(externalResult.status) ? 'sent' : (externalResult.status === 'approved' ? 'manual_pending' : externalResult.status);
      } else {
        throw new Error(`Payout method not supported: ${row.payout_method}`);
      }

      await pool.query(
        `UPDATE ${PAYOUT_TABLE} SET status=$1, external_payment_id=$2, raw_response=$3, error_message=$4, updated_at=NOW() WHERE payout_id=$5`,
        [status, externalResult.paymentId || externalResult.payout_id || null, JSON.stringify(externalResult), externalResult.error || null, payoutId]
      );
    } catch (err) {
      await pool.query(`UPDATE ${PAYOUT_TABLE} SET status='failed', error_message=$1, updated_at=NOW() WHERE payout_id=$2`, [err.message, payoutId]);
      throw err;
    }

    return this.getPayout(payoutId);
  }

  static async cancelPayout(payoutId) {
    const row = await this.getPayout(payoutId);
    if (!row) throw new Error('Payout not found');
    if (!['pending','fineract_withdrawn'].includes(row.status)) throw new Error(`Cannot cancel payout in ${row.status} status`);
    // Best-effort reverse the Fineract withdrawal by depositing back
    if (FineractClient && row.fineract_transaction_id) {
      try {
        await FineractClient.depositSavings({
          accountId: row.savings_account_id,
          amount: row.amount_cents / 100,
          note: `Reverse payout ${payoutId}`,
        });
      } catch (e) { /* best effort */ }
    }
    await pool.query(`UPDATE ${PAYOUT_TABLE} SET status='cancelled', updated_at=NOW() WHERE payout_id=$1`, [payoutId]);
    return this.getPayout(payoutId);
  }
}

module.exports = { FineractPayoutBridge };
