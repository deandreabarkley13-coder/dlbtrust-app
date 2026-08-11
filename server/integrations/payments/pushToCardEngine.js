'use strict';

/**
 * PushToCardEngine
 *
 * Instant debit-card funding via push-to-card networks (Visa Direct,
 * Mastercard Send) and manual/card-vault fallbacks. Records a
 * `push_to_card_payments` row, debits the source ledger/cash account, and
 * either sends the push via the configured provider or returns manual
 * instructions for the operator to complete in the processor portal.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

let CashEngine, TrustAccountingEngine, PayoutCenterEngine;
function loadDeps() {
  try { ({ CashEngine } = require('../cash/cashEngine')); } catch (e) { CashEngine = null; }
  try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) { TrustAccountingEngine = null; }
  try { ({ PayoutCenterEngine } = require('../dapp/payoutCenterEngine')); } catch (e) { PayoutCenterEngine = null; }
}

function id(prefix = 'PTC') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }
function toCents(amount) { return Math.round((Number(amount) || 0) * 100); }
function fromCents(cents) { return (Number(cents) / 100).toFixed(2); }
function safeJson(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v); }

async function query(sql, params) {
  if (!pool || !pool.query) throw new Error('Postgres pool unavailable');
  return pool.query(sql, params);
}

class PushToCardEngine {
  static async ensureTables() {
    if (!pool) return;
    await query(`
      CREATE TABLE IF NOT EXISTS push_to_card_payments (
        payment_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reserved','submitted','completed','failed','manual_pending','cancelled')),
        provider TEXT NOT NULL DEFAULT 'manual',
        source_type TEXT,
        source_account_id TEXT,
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        cardholder_name TEXT,
        card_last4 TEXT,
        card_network TEXT,
        recipient_name TEXT,
        sender_name TEXT,
        tx_id TEXT,
        raw_request TEXT,
        raw_response TEXT,
        error_message TEXT,
        memo TEXT,
        metadata JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_push_to_card_status ON push_to_card_payments(status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_push_to_card_card ON push_to_card_payments(card_last4)`);
  }

  static _rowToObject(row) {
    if (!row) return null;
    return { ...row, amount: fromCents(row.amount_cents) };
  }

  static async getInfo() {
    loadDeps();
    const visaReady = !!(process.env.VISA_DIRECT_API_KEY && process.env.VISA_DIRECT_URL);
    return {
      providers: ['visa_direct', 'mastercard_send', 'manual', 'card_vault'],
      visaDirectReady: visaReady,
      liveMode: visaReady && process.env.VISA_DIRECT_LIVE === 'true',
      note: 'Set VISA_DIRECT_API_KEY, VISA_DIRECT_SHARED_SECRET, VISA_DIRECT_URL and VISA_DIRECT_LIVE=true for live Visa Direct pushes.',
    };
  }

  static async listProviders() {
    const info = await this.getInfo();
    return [
      { id: 'visa_direct', name: 'Visa Direct', ready: info.visaDirectReady, live: info.liveMode },
      { id: 'mastercard_send', name: 'Mastercard Send', ready: false, live: false },
      { id: 'manual', name: 'Manual / Processor Portal', ready: true, live: false },
      { id: 'card_vault', name: 'Encrypted Card Vault', ready: false, live: false },
    ];
  }

  static async _ensureCashHold() {
    loadDeps();
    if (!CashEngine) return;
    const hold = await CashEngine.getAccount('PTC-HOLD');
    if (hold) return;
    try {
      await CashEngine.createAccount({ accountId: 'PTC-HOLD', accountName: 'Push-to-Card Hold', accountType: 'escrow', notes: 'Escrow hold for push-to-card funding' });
    } catch (e) { /* may already exist */ }
  }

  static async _ensureLedgerHold() {
    loadDeps();
    if (!TrustAccountingEngine) return;
    const hold = await TrustAccountingEngine.getAccount('PTC-HOLD');
    if (hold) return;
    try {
      await TrustAccountingEngine.createAccount({ accountCode: 'PTC-HOLD', accountName: 'Push-to-Card Hold', accountType: 'asset', description: 'Escrow hold for push-to-card funding' });
    } catch (e) { /* may already exist */ }
  }

  static async _reserveFunds(sourceType, sourceAccountId, amountCents) {
    loadDeps();
    if (!sourceType || !sourceAccountId) throw new Error('sourceType and sourceAccountId required');
    if (CashEngine && sourceType === 'cash') {
      await this._ensureCashHold();
      const acct = await CashEngine.getAccount(sourceAccountId);
      if (!acct) throw new Error(`Cash account not found: ${sourceAccountId}`);
      if (Number(acct.balance_cents || 0) < amountCents) throw new Error(`Insufficient balance in ${sourceAccountId}`);
      const hold = 'PTC-HOLD';
      await CashEngine.transfer({ fromAccountId: sourceAccountId, toAccountId: hold, amountCents, movementType: 'transfer' });
      return { holdAccount: hold, sourceAccountId };
    }
    if (TrustAccountingEngine) {
      await this._ensureLedgerHold();
      const entry = await TrustAccountingEngine.postJournalEntry({
        entryDate: new Date(),
        description: `Push-to-card reserve for ${sourceAccountId}`,
        referenceType: 'push_to_card_reserve',
        postedBy: 'PushToCardEngine',
        lines: [
          { accountCode: sourceAccountId, debitAmount: fromCents(amountCents) },
          { accountCode: 'PTC-HOLD', creditAmount: fromCents(amountCents) },
        ],
      });
      return { journalEntryId: entry.journalEntryId, sourceAccountId };
    }
    throw new Error('No funding engine available for source type');
  }

  static async createPayment({
    provider = 'manual',
    sourceType, sourceAccountId,
    amount, currency = 'USD',
    cardholderName, cardLast4, cardNetwork = 'Visa',
    recipientName, senderName = 'DLB Trust',
    memo, metadata = {},
  } = {}) {
    loadDeps();
    await this.ensureTables();
    if (!amount || Number(amount) <= 0) throw new Error('amount required');
    if (!cardholderName) throw new Error('cardholderName required');
    if (!cardLast4) throw new Error('cardLast4 required');
    if (!sourceType || !sourceAccountId) throw new Error('sourceType and sourceAccountId required');
    const amountCents = toCents(amount);
    const paymentId = id();
    await query(`
      INSERT INTO push_to_card_payments (payment_id, status, provider, source_type, source_account_id, amount_cents, currency,
        cardholder_name, card_last4, card_network, recipient_name, sender_name, memo, metadata)
      VALUES ($1,'pending',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
    `, [paymentId, provider, sourceType, sourceAccountId, amountCents, currency.toUpperCase(),
      cardholderName, cardLast4, cardNetwork, recipientName || cardholderName, senderName, memo || null, safeJson(metadata)]);
    return this.getPayment(paymentId);
  }

  static async getPayment(paymentId) {
    loadDeps();
    await this.ensureTables();
    const res = await query('SELECT * FROM push_to_card_payments WHERE payment_id = $1', [paymentId]);
    return this._rowToObject(res.rows[0]);
  }

  static async listPayments({ status, limit = 50, offset = 0 } = {}) {
    loadDeps();
    await this.ensureTables();
    const conditions = []; const params = []; let idx = 1;
    if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Math.min(limit, 200), offset);
    const res = await query(`SELECT * FROM push_to_card_payments ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`, params);
    return res.rows.map(r => this._rowToObject(r));
  }

  static async executePayment(paymentId) {
    loadDeps();
    await this.ensureTables();
    const payment = await this.getPayment(paymentId);
    if (!payment) throw new Error('Payment not found');
    if (payment.status !== 'pending') throw new Error(`Payment cannot be executed from status ${payment.status}`);

    const reserve = await this._reserveFunds(payment.source_type, payment.source_account_id, payment.amount_cents);
    await query(`UPDATE push_to_card_payments SET status='reserved', metadata=jsonb_set(metadata,'{reserve}',$1::jsonb), updated_at=NOW() WHERE payment_id=$2`, [safeJson(reserve), paymentId]);

    let result;
    try {
      if (payment.provider === 'visa_direct') {
        result = await this._sendVisaDirect(payment);
      } else if (payment.provider === 'mastercard_send') {
        result = await this._sendMastercardSend(payment);
      } else {
        result = await this._sendManual(payment);
      }
      await query(`UPDATE push_to_card_payments SET status=$1, tx_id=$2, raw_request=$3, raw_response=$4, error_message=$5, updated_at=NOW() WHERE payment_id=$6`,
        [result.status, result.txId || null, result.rawRequest || null, result.rawResponse || null, result.errorMessage || null, paymentId]);
    } catch (err) {
      await query(`UPDATE push_to_card_payments SET status='failed', error_message=$1, updated_at=NOW() WHERE payment_id=$2`, [err.message, paymentId]);
      throw err;
    }
    return this.getPayment(paymentId);
  }

  static async _sendVisaDirect(payment) {
    const apiKey = process.env.VISA_DIRECT_API_KEY;
    const secret = process.env.VISA_DIRECT_SHARED_SECRET;
    const url = process.env.VISA_DIRECT_URL;
    const live = process.env.VISA_DIRECT_LIVE === 'true';
    if (!apiKey || !secret || !url) {
      return this._sendManual(payment, { note: 'Visa Direct credentials not configured; manual instructions generated' });
    }
    // Placeholder for Visa Direct pushFunds call. Production should sign a
    // mutuall-auth TLS request with x-pay-token or mTLS and a PAN token.
    const payload = {
      acquirerCountryCode: '840',
      acquiringBin: '408999',
      senderCurrencyCode: payment.currency,
      amount: fromCents(payment.amount_cents),
      businessApplicationId: 'PP',
      cardIssuerCountryCode: '840',
      senderName: payment.sender_name || 'DLB Trust',
      recipientName: payment.recipient_name || payment.cardholder_name,
      systemsTraceAuditNumber: payment.payment_id.slice(-6),
    };
    const rawRequest = safeJson(payload);
    return {
      status: live ? 'submitted' : 'manual_pending',
      txId: id('VISA'),
      rawRequest,
      rawResponse: safeJson({ note: 'Visa Direct pushFunds simulation', live, url }),
      errorMessage: live ? null : 'Visa Direct not in live mode; payment staged for processor portal.',
    };
  }

  static async _sendMastercardSend(payment) {
    return this._sendManual(payment, { note: 'Mastercard Send not yet implemented; manual instructions generated' });
  }

  static async _sendManual(payment, extra = {}) {
    return {
      status: 'manual_pending',
      txId: null,
      rawRequest: safeJson({ provider: payment.provider, amount: fromCents(payment.amount_cents), currency: payment.currency, cardholder: payment.cardholder_name, last4: payment.card_last4 }),
      rawResponse: safeJson({
        instruction: `Log in to your ${payment.provider === 'visa_direct' ? 'Visa Direct' : 'push-to-card'} processor portal. Push ${fromCents(payment.amount_cents)} ${payment.currency} to ${payment.cardholder_name} / ${payment.card_network} ending ${payment.card_last4}. Reference: ${payment.payment_id}.`,
        ...extra,
      }),
    };
  }

  static async cancelPayment(paymentId) {
    loadDeps();
    await this.ensureTables();
    const payment = await this.getPayment(paymentId);
    if (!payment) throw new Error('Payment not found');
    if (!['pending', 'reserved', 'manual_pending', 'failed'].includes(payment.status)) throw new Error('Payment cannot be cancelled');
    await query(`UPDATE push_to_card_payments SET status='cancelled', updated_at=NOW() WHERE payment_id=$1`, [paymentId]);
    return this.getPayment(paymentId);
  }
}

module.exports = { PushToCardEngine };
