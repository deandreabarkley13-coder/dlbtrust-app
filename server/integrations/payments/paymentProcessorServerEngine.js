'use strict';

/**
 * Payment Processor Server Engine
 *
 * A unified server-side processor dispatcher for the DLB Trust Private Trust
 * Company.  It exposes one interface to route payments to the correct back-end
 * engine (Stripe Treasury, Clearing API, Deposit & Settlement, Lili, Skrill,
 * Payout Center, Web Payment Rail, etc.) while recording every transaction in a
 * single auditable table.
 */

const crypto = require('crypto');
const pg = require('../bonds/pgPool');

function generateId(prefix = 'PPS') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error('amount must be positive');
  return Math.round(n * 100);
}

function safeJson(obj) {
  try { return JSON.stringify(obj || {}, (k, v) => typeof v === 'bigint' ? String(v) : v); } catch { return '{}'; }
}

let StripeTreasuryEngine;
let ClearingApiEngine;
let PDCflowEngine;
let KafkaEventBus;
let EVENT_TOPICS;
let DepositAndSettlementEngine;
let PayoutCenterEngine;
let LiliBankEngine;
let SkrillLinkEngine;
let WebPaymentRailEngine;
let CashEngine;
let PaymentHubEngine;
let ReserveEngine;

function loadDeps() {
  try { ({ StripeTreasuryEngine } = require('./stripeTreasuryEngine')); } catch {}
  try { ({ ClearingApiEngine } = require('./clearingApiEngine')); } catch {}
  try { ({ DepositAndSettlementEngine } = require('./depositAndSettlementEngine')); } catch {}
  try { ({ PayoutCenterEngine } = require('../dapp/payoutCenterEngine')); } catch {}
  try { ({ LiliBankEngine } = require('./liliBankEngine')); } catch {}
  try { ({ SkrillLinkEngine } = require('./skrillLinkEngine')); } catch {}
  try { ({ WebPaymentRailEngine } = require('./webPaymentRailEngine')); } catch {}
  try { ({ CashEngine } = require('../cash/cashEngine')); } catch {}
  try { ({ PaymentHubEngine } = require('../paymentHub/paymentHubEngine')); } catch {}
  try { ({ PDCflowEngine } = require('./pdcflowEngine')); } catch {}
  try { ({ ReserveEngine } = require('../finops/reserveEngine')); } catch {}
  try {
    ({ KafkaEventBus, TOPICS: EVENT_TOPICS } = require('../events/kafkaEventBus'));
  } catch {}
}

/** Publishing must never break a payment: the ledger row is authoritative. */
async function emit(topic, payload, key) {
  if (!KafkaEventBus || !topic) return;
  try {
    await KafkaEventBus.publish(topic, payload, { key });
  } catch (e) {
    console.warn('[processor] event publish failed:', e.message);
  }
}

const TABLE = 'payment_processor_transactions';

/**
 * Processors that move value outside the trust's own books. These are the only
 * ones that require reserve backing; internal clearing and book transfers do
 * not leave the ledger.
 */
const EXTERNAL_PROCESSORS = [
  'stripe_treasury',
  'stripe_ach',
  'stripe_wire',
  'lili',
  'lili_bank',
  'skrill',
  'pdcflow',
  'payout_center',
];

class PaymentProcessorServerEngine {
  static async ensureTables() {
    if (!pg || !pg.query) return;
    await pg.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id SERIAL PRIMARY KEY,
        processor_tx_id TEXT UNIQUE NOT NULL,
        processor TEXT NOT NULL,
        rail TEXT NOT NULL,
        direction TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('inbound','outbound')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','authorized','completed','failed','manual','refunded','voided')),
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        source_account_id TEXT,
        destination JSONB DEFAULT '{}',
        external_reference TEXT,
        raw_request JSONB DEFAULT '{}',
        raw_response JSONB DEFAULT '{}',
        metadata JSONB DEFAULT '{}',
        initiated_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pg.query(`CREATE INDEX IF NOT EXISTS idx_pp_status ON ${TABLE}(status)`);
    await pg.query(`CREATE INDEX IF NOT EXISTS idx_pp_processor ON ${TABLE}(processor)`);
    await pg.query(`CREATE INDEX IF NOT EXISTS idx_pp_external ON ${TABLE}(external_reference)`);
  }

  static _inferProcessor(rail, direction) {
    const r = String(rail || '').toLowerCase();
    if (r.startsWith('stripe_') || r === 'stripe_treasury') return 'stripe_treasury';
    if (['ach','wire','iso20022','open_banking','generic','manual'].includes(r)) return 'clearing';
    if (['deposit','inbound','credit','received'].includes(String(direction || '').toLowerCase()) || r === 'deposit_settlement') return 'deposit_settlement';
    if (r === 'lili' || r === 'lili_bank') return 'lili';
    if (r === 'skrill') return 'skrill';
    if (r === 'web' || r === 'web_payment_rail' || r === 'https') return 'web_payment_rail';
    if (r === 'payout_center' || r === 'payout') return 'payout_center';
    if (r === 'payment_hub' || r === 'payment_intent') return 'payment_hub';
    if (r === 'pdcflow' || r === 'pdcflow_ach' || r === 'gateway_ach') return 'pdcflow';
    return 'payout_center';
  }

  /**
   * An outbound rail can only send reserves held for the trust at an external
   * custodian. In strict mode this throws before the provider is contacted.
   */
  static async _assertReserveBacked({ amountCents, rail, processor, source = {} }) {
    if (!ReserveEngine) return null;
    const decision = await ReserveEngine.assertSpendable({
      amountCents,
      rail: `${processor}:${rail}`,
      accountId: source.accountId || source.account_id || null,
    });
    if (decision && decision.warning) {
      console.warn('[processor] reserve check:', decision.warning);
    }
    return decision;
  }

  static async _insert(base) {
    if (!pg || !pg.query) return;
    const keys = Object.keys(base).filter(k => base[k] !== undefined);
    const cols = keys.join(',');
    const vals = keys.map((_, i) => `$${i + 1}`).join(',');
    await pg.query(`INSERT INTO ${TABLE} (${cols}) VALUES (${vals})`, Object.values(base));
  }

  static async _update(txId, fields) {
    if (!pg || !pg.query) return;
    const keys = Object.keys(fields).filter(k => fields[k] !== undefined);
    if (!keys.length) return;
    const set = keys.map((k, i) => `${k}=$${i + 1}`).join(',');
    await pg.query(`UPDATE ${TABLE} SET ${set}, updated_at=NOW() WHERE processor_tx_id=$${keys.length + 1}`, [...Object.values(fields), txId]);
  }

  static async _find(txId) {
    if (!pg || !pg.query) return null;
    const res = await pg.query(`SELECT * FROM ${TABLE} WHERE processor_tx_id=$1`, [txId]);
    return res.rows[0] || null;
  }

  static async processPayment({
    processor,
    rail,
    direction = 'outbound',
    amount,
    currency = 'USD',
    source = {},
    destination = {},
    reference,
    metadata = {},
    initiatedBy,
    ...extras
  } = {}) {
    loadDeps();
    const amountCents = toCents(amount);
    const chosenRail = String(rail || processor || 'payout_center').toLowerCase();
    const chosenProcessor = String(processor || this._inferProcessor(chosenRail, direction)).toLowerCase();
    const txId = generateId('PPS');

    const base = {
      processor_tx_id: txId,
      processor: chosenProcessor,
      rail: chosenRail,
      direction: String(direction).toLowerCase(),
      status: 'pending',
      amount_cents: amountCents,
      currency: String(currency).toUpperCase(),
      source_account_id: source.accountId || source.account_id || source.accountCode || null,
      destination: safeJson(destination),
      external_reference: reference || null,
      raw_request: safeJson({ processor, rail, direction, amount, currency, source, destination, reference, metadata, initiatedBy, extras }),
      raw_response: '{}',
      metadata: safeJson(metadata || {}),
      initiated_by: initiatedBy || 'system',
    };
    await this._insert(base);
    await emit(EVENT_TOPICS && EVENT_TOPICS.paymentRequested, {
      paymentId: txId,
      processor: chosenProcessor,
      rail: chosenRail,
      direction: base.direction,
      amountCents,
      currency: base.currency,
      reference: reference || null,
      initiatedBy: base.initiated_by,
    }, txId);

    let reserveDecision = null;
    let result = { status: 'pending' };
    try {
      if (base.direction === 'outbound' && EXTERNAL_PROCESSORS.includes(chosenProcessor) && !extras.dryRun) {
        reserveDecision = await this._assertReserveBacked({
          amountCents,
          rail: chosenRail,
          processor: chosenProcessor,
          source,
        });
      }
      if (base.direction === 'inbound') {
        result = await this._processInbound({ amount, currency, rail: chosenRail, source, destination, reference, metadata, initiatedBy, extras, txId });
      } else {
        switch (chosenProcessor) {
          case 'stripe_treasury':
          case 'stripe_ach':
          case 'stripe_wire':
            result = await this._processStripe({ amount, currency, destination, reference, metadata, initiatedBy, extras, txId });
            break;
          case 'clearing':
            result = await this._processClearing({ rail: chosenRail, amount, currency, source, destination, reference, metadata, initiatedBy });
            break;
          case 'deposit_settlement':
            result = await this._processDepositSettlement({ amount, rail: chosenRail, source, destination, reference, metadata, initiatedBy, extras });
            break;
          case 'lili':
          case 'lili_bank':
            result = await this._processLili({ amount, currency, source, destination, reference, metadata, initiatedBy });
            break;
          case 'skrill':
            result = await this._processSkrill({ destination, initiatedBy });
            break;
          case 'web_payment_rail':
          case 'web':
            result = await this._processWebPaymentRail({ amount, currency, source, destination, reference, metadata, initiatedBy, extras });
            break;
          case 'payment_hub':
            result = await this._processPaymentHub({ amount, currency, source, destination, reference, metadata, initiatedBy, extras, rail: chosenRail });
            break;
          case 'pdcflow':
            result = await this._processPdcflow({ amountCents, destination, reference, metadata, extras, txId });
            break;
          case 'payout_center':
          default:
            result = await this._processPayoutCenter({ amount, currency, source, destination, rail: chosenRail, reference, metadata, initiatedBy });
        }
      }
    } catch (err) {
      // A reserve shortfall fails the request before any provider call, so the
      // row lands in failed rather than staying pending on an untransmitted row.
      result = {
        status: 'failed',
        error: err.message,
        code: err.code || null,
        reserveBlocked: err.code === 'RESERVE_SHORTFALL',
        detail: err.detail || err,
      };
    }

    const status =
      result.status === 'completed' ? 'completed' :
      result.status === 'failed' ? 'failed' :
      (result.status === 'manual' || result.status === 'manual_pending') ? 'manual' :
      'pending';
    const externalRef = result.externalReference || result.transactionId || result.tx_hash || result.payout_id || result.orderId || result.clearingId || result.payment_id || result.processorTxId || reference || null;
    await this._update(txId, { status, external_reference: externalRef, raw_response: safeJson(result) });
    const outcomeTopic = EVENT_TOPICS && (
      status === 'completed' ? EVENT_TOPICS.paymentSettled
        : status === 'failed' ? EVENT_TOPICS.paymentFailed
          : EVENT_TOPICS.paymentTransmitted
    );
    await emit(outcomeTopic, {
      paymentId: txId,
      processor: chosenProcessor,
      rail: chosenRail,
      direction: base.direction,
      amountCents,
      currency: base.currency,
      status,
      externalReference: externalRef,
      error: result.error || null,
    }, txId);

    return { processorTxId: txId, processor: chosenProcessor, rail: chosenRail, status, amount: (amountCents / 100).toFixed(2), currency: base.currency, externalReference: externalRef, reserve: reserveDecision, result };
  }

  static async _processInbound({ amount, currency, rail, source, destination, reference, metadata, initiatedBy, extras, txId }) {
    if (DepositAndSettlementEngine) {
      const deposit = await DepositAndSettlementEngine.recordDeposit({
        amount,
        rail: rail || 'gateway',
        source: source.description || reference || 'Payment gateway inbound',
        cashAccountId: source.accountId || source.cashAccountId || 'CA-STRIPE-TREASURY',
        trustAccountCode: source.trustAccountCode || destination.trustAccountCode || 'PTC-DEPOSIT-CLEARING',
        externalReference: reference || txId,
        description: metadata.description || `Gateway inbound ${txId}`,
        initiatedBy,
        metadata: { ...metadata, gatewayTx: txId },
      });
      return { status: 'completed', orderId: deposit.orderId, transactionId: deposit.orderId, externalReference: reference || txId };
    }
    return { status: 'manual', instruction: 'Deposit & Settlement engine unavailable; record this inbound deposit manually' };
  }

  static async _processStripe({ amount, currency, destination, reference, metadata, initiatedBy, extras, txId }) {
    if (!StripeTreasuryEngine || !StripeTreasuryEngine.isConfigured()) {
      return { status: 'manual', instruction: 'Stripe Treasury is not configured' };
    }
    const network = (extras.network || destination.network || String(extras.rail || '').replace('stripe_', '') || 'ach') === 'us_domestic_wire' ? 'us_domestic_wire' : 'ach';
    const result = await StripeTreasuryEngine.createPayment({
      amount,
      financialAccountId: destination.financialAccountId || extras.financialAccountId || null,
      routingNumber: destination.routingNumber || destination.routing || destination.routing_number,
      accountNumber: destination.accountNumber || destination.account || destination.account_number,
      accountHolderName: destination.accountHolderName || destination.recipientName || destination.fullName || destination.name,
      accountHolderType: destination.accountHolderType || destination.account_holder_type || 'individual',
      accountType: destination.accountType || destination.account_type || 'checking',
      network,
      description: metadata.description || reference || `Processor ${txId}`,
      statementDescriptor: (metadata.statementDescriptor || 'PTC PAYOUT').substring(0, 22),
      billingAddress: destination.billingAddress || destination.address,
      metadata: { ...metadata, processor_tx_id: txId, initiatedBy },
    });
    return { status: result.status || 'pending', transactionId: result.payout_id, externalReference: result.stripe_outbound_payment_id, result };
  }

  static async _processClearing({ rail, amount, currency, source, destination, reference, metadata, initiatedBy }) {
    if (!ClearingApiEngine) return { status: 'manual', instruction: 'Clearing API engine unavailable' };
    const validRails = ['ach','wire','iso20022','open_banking','generic','manual'];
    const clearingRail = validRails.includes(rail) ? rail : 'ach';
    return await ClearingApiEngine.submit({
      direction: 'outbound',
      rail: clearingRail,
      amount,
      currency,
      sourceAccountId: source.accountId || source.account_id || source.cashAccountId || 'CA-OPERATING',
      destination,
      reference,
      metadata: { ...metadata, initiatedBy },
      initiatedBy,
    });
  }

  static async _processDepositSettlement({ amount, rail, source, destination, reference, metadata, initiatedBy, extras }) {
    if (!DepositAndSettlementEngine) return { status: 'manual', instruction: 'Deposit & Settlement engine unavailable' };
    const railNorm = String(rail || '').toLowerCase();
    if (railNorm === 'deposit' || railNorm === 'inbound') {
      return await this._processInbound({ amount, rail: railNorm, source, destination, reference, metadata, initiatedBy, extras, txId: reference });
    }
    return await DepositAndSettlementEngine.initiateSettlement({
      amount,
      rail,
      sourceCashAccountId: source.accountId || source.cashAccountId || 'CA-OPERATING',
      sourceTrustAccountCode: source.trustAccountCode || '1100',
      clearingTrustAccountCode: destination.clearingTrustAccountCode || 'PTC-SETTLEMENT-CLEARING',
      destination,
      description: metadata.description || reference,
      initiatedBy,
      requireCip: extras.requireCip !== false && process.env.STRIPE_TREASURY_CIP_REQUIRED !== 'false',
      prefund: extras.prefund !== false,
      metadata: { ...metadata, processor: 'payment_processor_server' },
    });
  }

  static async _processPayoutCenter({ amount, currency, source, destination, rail, reference, metadata, initiatedBy }) {
    if (!PayoutCenterEngine) return { status: 'manual', instruction: 'Payout Center engine unavailable' };
    const recipient = destination.identifier || destination.accountNumber || destination.address || destination.cashtag || destination.wallet;
    if (!recipient) return { status: 'failed', error: 'destination.identifier or accountNumber required' };
    return await PayoutCenterEngine.createPayment({
      paymentType: metadata.paymentType || 'payout',
      sourceType: source.type || 'trust_account',
      sourceAccountId: source.accountId || source.accountCode || '1100',
      recipientType: destination.type || 'external',
      recipientIdentifier: recipient,
      amount,
      asset: currency,
      description: metadata.description || reference,
      rail,
      railOptions: { ...destination, initiatedBy, description: metadata.description || reference },
    });
  }

  static async _processLili({ amount, currency, source, destination, reference, metadata, initiatedBy }) {
    if (!LiliBankEngine) return { status: 'manual', instruction: 'Lili Bank engine unavailable' };
    return await LiliBankEngine.createPayment({
      amount,
      currency,
      recipientName: destination.accountHolderName || destination.recipientName || destination.name,
      recipientAccount: destination.accountNumber || destination.account,
      recipientRouting: destination.routingNumber || destination.routing,
      recipientBank: destination.bankName || destination.bank,
      recipientEmail: destination.email,
      sourceAccountId: source.accountId || source.cashAccountId || 'CA-OPERATING',
      liliAccountId: destination.liliAccountId || source.liliAccountId,
      liliBusinessUserId: destination.liliBusinessUserId || source.liliBusinessUserId,
      speed: destination.speed || 'standard',
      initiatedBy,
    });
  }

  static async _processSkrill({ destination, initiatedBy }) {
    if (!SkrillLinkEngine) return { status: 'manual', instruction: 'Skrill engine unavailable' };
    if (!destination.linkUrl) return { status: 'failed', error: 'destination.linkUrl required for Skrill processor' };
    const created = await SkrillLinkEngine.createPayment({ linkUrl: destination.linkUrl, recipientEmail: destination.email, initiatedBy });
    const paid = await SkrillLinkEngine.pay(created.payment_id);
    return { status: paid.status || 'pending', transactionId: paid.payment_id, externalReference: paid.external_tx_id, result: paid };
  }

  static async _processWebPaymentRail({ amount, currency, source, destination, reference, metadata, initiatedBy, extras }) {
    if (!WebPaymentRailEngine) return { status: 'manual', instruction: 'Web Payment Rail engine unavailable' };
    const created = await WebPaymentRailEngine.createPayment({
      adapterName: extras.adapterName || 'default',
      amount,
      currency,
      recipientName: destination.accountHolderName || destination.recipientName || destination.name,
      recipientAccount: destination.accountNumber || destination.account,
      recipientBank: destination.bankName || destination.bank,
      recipientRouting: destination.routingNumber || destination.routing,
      recipientCountry: destination.country,
      sourceType: source.type || 'cash',
      sourceAccountId: source.accountId || source.cashAccountId || 'CA-OPERATING',
      description: metadata.description || reference,
      initiatedBy,
    });
    const sent = await WebPaymentRailEngine.sendPayment(created.payment_id);
    return { status: sent.status || 'pending', transactionId: sent.payment_id, externalReference: sent.external_tx_id, result: sent };
  }

  static async _processPaymentHub({ amount, currency, source, destination, reference, metadata, initiatedBy, extras, rail }) {
    if (!PaymentHubEngine) return { status: 'manual', instruction: 'Payment Hub engine unavailable' };
    return await PaymentHubEngine.createIntent({
      idempotencyKey: reference || generateId('PPI'),
      paymentType: metadata.paymentType || 'payout',
      beneficiaryName: destination.accountHolderName || destination.recipientName || destination.name,
      beneficiaryRouting: destination.routingNumber || destination.routing,
      beneficiaryAccount: destination.accountNumber || destination.account,
      beneficiaryAccountType: destination.accountType || 'checking',
      sourceType: source.type || 'trust_account',
      sourceAccountCode: source.accountCode || source.accountId || '1100',
      sourceSubLedgerId: source.subLedgerId,
      amount: (Number(amount) * 100).toFixed(0),
      currency,
      rail: rail === 'payment_hub' ? 'ach' : rail,
      effectiveDate: extras.effectiveDate || new Date().toISOString().slice(0, 10),
      description: metadata.description || reference,
      secCode: extras.secCode || 'CCD',
      metadata: { ...metadata, initiatedBy },
    }, initiatedBy);
  }

  /**
   * PDCflow is the trust's own gateway/processor account: `outbound` becomes an
   * ACH CREDIT to the beneficiary, `inbound` an ACH DEBIT pulling funds in.
   */
  static async _processPdcflow({ amountCents, destination, reference, metadata, extras, txId }) {
    if (!PDCflowEngine) return { status: 'manual', instruction: 'PDCflow engine unavailable' };
    if (!PDCflowEngine.isConfigured()) {
      const st = PDCflowEngine.status();
      return { status: 'manual', instruction: st.note, missingConfiguration: st.missingConfiguration };
    }
    const direction = String(extras.pdcflowDirection || destination.direction || 'credit').toLowerCase();
    const instruction = {
      reference: reference || txId,
      amountCents,
      counterpartyName: destination.accountHolderName || destination.recipientName || destination.name,
      routingNumber: destination.routingNumber || destination.routing,
      accountNumber: destination.accountNumber || destination.account,
      accountType: destination.accountType || 'checking',
      bankAccountToken: destination.bankAccountToken,
      email: destination.email,
      description: metadata.description || reference,
      dateScheduled: extras.effectiveDate,
    };
    if (extras.dryRun) {
      return { status: 'manual', instruction: 'Dry run', prepared: PDCflowEngine.prepareAch(direction, instruction) };
    }
    const accepted = await PDCflowEngine.originateAch(direction, instruction);
    return {
      // Acceptance is not settlement: PDCflow's postback moves this to completed.
      status: accepted.settled ? 'completed' : 'pending',
      externalReference: accepted.providerReference,
      transactionId: accepted.providerReference,
      result: accepted,
    };
  }

  /**
   * Apply a PDCflow postback. This is the settlement evidence for a PDCflow
   * transaction: nothing here trusts the caller for an amount, only the status
   * of an already-recorded transaction matched by its provider reference.
   */
  static async applyPdcflowPostback(body = {}) {
    loadDeps();
    if (!PDCflowEngine) throw new Error('PDCflow engine unavailable');
    const outcome = PDCflowEngine.interpretPostback(body);
    if (!outcome.providerReference) throw new Error('Postback did not include a transactionId');
    if (!pg || !pg.query) return { matched: false, ...outcome };
    const found = await pg.query(
      `SELECT * FROM ${TABLE} WHERE processor = 'pdcflow' AND external_reference = $1 LIMIT 1`,
      [outcome.providerReference]
    );
    const row = found.rows[0];
    if (!row) return { matched: false, ...outcome };
    const status = outcome.settled ? 'completed' : outcome.failed ? 'failed' : 'pending';
    await this._update(row.processor_tx_id, { status, raw_response: safeJson(body) });
    await emit(EVENT_TOPICS && (status === 'completed'
      ? EVENT_TOPICS.paymentSettled
      : status === 'failed' ? EVENT_TOPICS.paymentFailed : EVENT_TOPICS.paymentTransmitted), {
      paymentId: row.processor_tx_id,
      processor: 'pdcflow',
      rail: row.rail,
      direction: row.direction,
      amountCents: Number(row.amount_cents),
      currency: row.currency,
      status,
      externalReference: outcome.providerReference,
      providerStatus: outcome.providerStatus,
    }, row.processor_tx_id);
    return { matched: true, processorTxId: row.processor_tx_id, status, ...outcome };
  }

  static async getStatus(txId) {
    return this._find(txId);
  }

  static async list({ processor, rail, status, direction, limit = 50 } = {}) {
    if (!pg || !pg.query) return [];
    const conditions = [];
    const params = [];
    if (processor) { conditions.push('processor = $' + (params.length + 1)); params.push(processor); }
    if (rail) { conditions.push('rail = $' + (params.length + 1)); params.push(rail); }
    if (status) { conditions.push('status = $' + (params.length + 1)); params.push(status); }
    if (direction) { conditions.push('direction = $' + (params.length + 1)); params.push(direction); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await pg.query(`SELECT * FROM ${TABLE} ${where} ORDER BY created_at DESC LIMIT $${params.length + 1}`, [...params, limit]);
    return res.rows;
  }

  static async refund({ txId, amount, initiatedBy, reason = '' } = {}) {
    const row = await this._find(txId);
    if (!row) throw new Error('Transaction not found');
    const refundCents = amount ? toCents(amount) : row.amount_cents;
    const refundId = generateId('PPS-REF');
    await this._insert({
      processor_tx_id: refundId,
      processor: row.processor,
      rail: row.rail,
      direction: row.direction === 'inbound' ? 'outbound' : 'inbound',
      status: 'pending',
      amount_cents: refundCents,
      currency: row.currency,
      source_account_id: row.source_account_id,
      destination: safeJson({ originalTx: txId, reason }),
      external_reference: row.external_reference,
      raw_request: safeJson({ originalTx: txId, amount, reason, initiatedBy }),
      raw_response: '{}',
      metadata: safeJson({ refund: true, originalTx: txId }),
      initiated_by: initiatedBy || 'system',
    });
    let result = { status: 'manual', instruction: 'Refund must be initiated with the processor' };
    if (row.processor === 'stripe_treasury' && StripeTreasuryEngine) {
      // Stripe Treasury has no generic refund endpoint; the engine records the intent and returns manual status.
      result = { status: 'manual', instruction: `Initiate a return for Stripe payout ${row.external_reference} in the Stripe Dashboard or via treasury.ReceivedCredit` };
    }
    if (row.processor === 'lili' && LiliBankEngine) {
      result = { status: 'manual', instruction: `Initiate a reversal with Lili for payment ${row.external_reference}` };
    }
    await this._update(refundId, { status: result.status === 'completed' ? 'completed' : 'manual', raw_response: safeJson(result) });
    return { refundId, originalTx: txId, status: result.status === 'completed' ? 'completed' : 'manual', amount: (refundCents / 100).toFixed(2), result };
  }

  static async reconcile({ txId, externalReference, status, rawResponse, initiatedBy }) {
    const row = await this._find(txId);
    if (!row) throw new Error('Transaction not found');
    const newStatus = ['completed','failed','manual','refunded','voided','pending'].includes(status) ? status : 'pending';
    await this._update(txId, { status: newStatus, external_reference: externalReference || row.external_reference, raw_response: safeJson(rawResponse) });
    return { processorTxId: txId, status: newStatus, externalReference: externalReference || row.external_reference };
  }

  static async getBalance(processor, accountId) {
    loadDeps();
    const p = String(processor || '').toLowerCase();
    if (p === 'stripe_treasury' && StripeTreasuryEngine && StripeTreasuryEngine.isConfigured()) {
      try {
        const faId = process.env.STRIPE_TREASURY_FINANCIAL_ACCOUNT_ID;
        const client = StripeTreasuryEngine.getClient();
        const fa = await client.treasury.financialAccounts.retrieve(faId);
        const available = (fa.balance && fa.balance.cash && fa.balance.cash.usd) || 0;
        const pending = (fa.balance && fa.balance.pending && fa.balance.pending.usd) || 0;
        return { processor, financialAccountId: faId, available_cents: available, pending_cents: pending, currency: 'USD' };
      } catch (e) {
        return { processor, available_cents: null, pending_cents: null, error: e.message };
      }
    }
    if (CashEngine) {
      const acctId = accountId || (p === 'deposit_settlement' ? 'CA-OPERATING' : (p === 'clearing' ? 'CA-STRIPE-TREASURY' : 'CA-OPERATING'));
      try {
        const acct = await CashEngine.getAccount(acctId);
        return { processor, accountId: acctId, balance_cents: acct ? acct.balance_cents : null };
      } catch (e) {
        return { processor, accountId: acctId, balance_cents: null, error: e.message };
      }
    }
    return { processor, balance_cents: null };
  }

  static getProcessors() {
    loadDeps();
    return [
      { name: 'stripe_treasury', label: 'Stripe Treasury', available: !!(StripeTreasuryEngine && StripeTreasuryEngine.isConfigured()), rails: ['stripe_ach','stripe_wire'] },
      { name: 'clearing', label: 'Clearing API', available: !!ClearingApiEngine, rails: ['ach','wire','iso20022','open_banking','generic','manual'] },
      { name: 'deposit_settlement', label: 'Deposit & Settlement', available: !!DepositAndSettlementEngine, rails: ['deposit','inbound','settlement'] },
      { name: 'payout_center', label: 'Payout Center', available: !!PayoutCenterEngine, rails: ['wire','ach','push_to_card','vendor','wallet','stablecoin','dex','btcpay','cashapp','module'] },
      { name: 'lili', label: 'Lili Bank', available: !!LiliBankEngine, rails: ['ach','wire','bill_pay'] },
      { name: 'skrill', label: 'Skrill', available: !!SkrillLinkEngine, rails: ['skrill'] },
      { name: 'web_payment_rail', label: 'Web Payment Rail', available: !!WebPaymentRailEngine, rails: ['web','https'] },
      { name: 'payment_hub', label: 'Payment Hub', available: !!PaymentHubEngine, rails: ['payment_hub','ach','wire'] },
      { name: 'pdcflow', label: 'PDCflow Gateway', available: !!(PDCflowEngine && PDCflowEngine.isConfigured()), rails: ['pdcflow','pdcflow_ach','gateway_ach'] },
    ];
  }
}

module.exports = { PaymentProcessorServerEngine, EXTERNAL_PROCESSORS };
