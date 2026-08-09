'use strict';

/**
 * Transactional & Settlement Server Engine
 *
 * A unified payment-gateway and settlement-orchestration layer for the DLB Trust.
 *
 * Responsibilities:
 *   - Accept inbound (deposits/collections) and outbound (payments/settlement) orders.
 *   - Route each order to the correct underlying engine based on rail:
 *       • Fiat rails: SettlementEngine / LiveMoneyMovementEngine / HostToHostEngine / LiliBankEngine / ElectronicSettlementEngine
 *       • Digital/decentralized rails: PayoutCenterEngine / ClearingAndSettlementEngine / StablecoinEngine
 *   - Reserve source-of-funds before submission and release on failure/cancellation.
 *   - Maintain one auditable order queue for the entire trust platform.
 *
 * Rails supported:
 *   outbound: wire, ach, open_banking, iso20022, mft_sftp, as2, host_to_host,
 *             external_endpoint, live_fintech, lili, bill, stablecoin, sovereign,
 *             dex, cross_chain, btcpay, cashapp, module, manual
 *   inbound:  deposit (credit a trust cash/sub-ledger account)
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

function identifier(prefix = 'TXS') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error('amount must be a positive number');
  return Math.round(Math.round(n * 100));
}

function safeJson(obj) {
  try { return JSON.stringify(obj); } catch { return '{}'; }
}

const HOLD_ACCOUNT_ID = 'TXS-HOLD';
const SETTLED_ACCOUNT_ID = 'TXS-SETTLED';

let CashEngine;
try { ({ CashEngine } = require('../cash/cashEngine')); } catch (e) { CashEngine = null; }

let SettlementEngine;
try { SettlementEngine = require('./settlementEngine').SettlementEngine; } catch (e) { SettlementEngine = null; }

let PayoutCenterEngine;
try { ({ PayoutCenterEngine } = require('./payoutCenterEngine')); } catch (e) { PayoutCenterEngine = null; }

let ClearingAndSettlementEngine;
try { ({ ClearingAndSettlementEngine } = require('../stablecoin/clearingAndSettlementEngine')); } catch (e) { ClearingAndSettlementEngine = null; }

let LiliBankEngine;
try { ({ LiliBankEngine } = require('../payments/liliBankEngine')); } catch (e) { LiliBankEngine = null; }

let ElectronicSettlementEngine;
try { ElectronicSettlementEngine = require('../payments/electronicSettlementEngine'); } catch (e) { ElectronicSettlementEngine = null; }

let LiveMoneyMovementEngine;
try { ({ LiveMoneyMovementEngine } = require('./liveMoneyMovementEngine')); } catch (e) { LiveMoneyMovementEngine = null; }

let HostToHostEngine;
try { ({ HostToHostEngine } = require('./hostToHostEngine')); } catch (e) { HostToHostEngine = null; }

let StablecoinEngine;
try { StablecoinEngine = require('./stablecoinEngine').StablecoinEngine; } catch (e) { StablecoinEngine = null; }

let StablecoinDexEngine;
try { ({ StablecoinDexEngine } = require('./stablecoinDexEngine')); } catch (e) { StablecoinDexEngine = null; }

let CrossChainConversionEngine;
try { ({ CrossChainConversionEngine } = require('./crossChainConversionEngine')); } catch (e) { CrossChainConversionEngine = null; }

let SubLedgerEngine;
try { ({ SubLedgerEngine } = require('../accounting/subLedgerEngine')); } catch (e) { SubLedgerEngine = null; }

const VALID_DIRECTIONS = new Set(['inbound', 'outbound']);
const VALID_RAILS = new Set([
  'wire', 'ach', 'open_banking', 'iso20022', 'mft_sftp', 'as2', 'host_to_host',
  'external_endpoint', 'live_fintech', 'lili', 'bill', 'manual',
  'stablecoin', 'sovereign', 'dex', 'stablecoin_dex', 'cross_chain', 'btcpay', 'cashapp', 'module', 'deposit'
]);

const SETTLEMENT_RAILS = new Set(['wire', 'ach', 'open_banking', 'iso20022', 'mft_sftp', 'as2', 'host_to_host', 'external_endpoint', 'live_fintech', 'stablecoin', 'sovereign', 'manual']);

async function query(sql, params) {
  if (!pool || !pool.query) throw new Error('Postgres pool unavailable');
  return pool.query(sql, params);
}

async function withFallback(fn, fallback) {
  try { return await fn(); } catch (e) { if (!pool) return fallback(e); throw e; }
}

class TransactionalSettlementServerEngine {
  static async ensureTables() {
    if (!pool) return;
    await query(`
      CREATE TABLE IF NOT EXISTS transactional_settlements (
        order_id TEXT PRIMARY KEY,
        direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
        rail TEXT NOT NULL,
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        asset TEXT NOT NULL DEFAULT 'USD',
        source_type TEXT,
        source_account_id TEXT,
        destination_type TEXT,
        destination_account_id TEXT,
        beneficiary_name TEXT,
        beneficiary_email TEXT,
        beneficiary_address TEXT,
        beneficiary_account TEXT,
        beneficiary_routing TEXT,
        beneficiary_bank TEXT,
        debtor_name TEXT,
        debtor_account TEXT,
        debtor_routing TEXT,
        debtor_bank TEXT,
        memo TEXT,
        priority TEXT DEFAULT 'standard',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('draft','pending','reserved','submitted','originated','settled','completed','failed','cancelled')),
        external_id TEXT,
        raw_request TEXT,
        raw_response TEXT,
        error_message TEXT,
        reserve_tx_id TEXT,
        reserve_released BOOLEAN DEFAULT FALSE,
        metadata JSONB NOT NULL DEFAULT '{}',
        endpoint_id TEXT,
        connector TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        settled_at TIMESTAMPTZ
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_txs_status ON transactional_settlements(status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_txs_rail ON transactional_settlements(rail)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_txs_direction ON transactional_settlements(direction)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_txs_external_id ON transactional_settlements(external_id)`);

    if (CashEngine) {
      for (const [id, name] of [[HOLD_ACCOUNT_ID, 'Transactional Settlement Hold'], [SETTLED_ACCOUNT_ID, 'Transactional Settlement Settled']]) {
        try {
          const existing = await CashEngine.getAccount(id);
          if (!existing) await CashEngine.createAccount({ accountId: id, accountName: name, accountType: 'escrow', notes: 'Transactional Settlement Server clearing account' });
        } catch (e) { console.warn('[txs] hold account setup:', e.message); }
      }
    }

    if (SettlementEngine) try { await SettlementEngine.ensureTables(); } catch (e) { console.warn('[txs] SettlementEngine ensure failed:', e.message); }
    if (PayoutCenterEngine) try { await PayoutCenterEngine.ensureTables(); } catch (e) { console.warn('[txs] PayoutCenterEngine ensure failed:', e.message); }
  }

  static _rowToObject(row) {
    if (!row) return null;
    const out = { ...row };
    out.amount = (row.amount_cents || 0) / 100;
    if (row.metadata && typeof row.metadata === 'object') out.metadata = row.metadata;
    return out;
  }

  static async createOrder(opts = {}) {
    await this.ensureTables();
    const {
      direction = 'outbound',
      rail,
      amount,
      currency = 'USD',
      asset = currency || 'USD',
      sourceType,
      sourceAccountId,
      destinationType,
      destinationAccountId,
      beneficiaryName,
      beneficiaryEmail,
      beneficiaryAddress,
      beneficiaryAccount,
      beneficiaryRouting,
      beneficiaryBank,
      debtorName,
      debtorAccount,
      debtorRouting,
      debtorBank,
      memo,
      priority = 'standard',
      metadata = {},
      endpointId,
      connector,
      reserveFunds = true,
    } = opts;

    if (!VALID_DIRECTIONS.has(direction)) throw new Error('direction must be inbound or outbound');
    if (!rail || !VALID_RAILS.has(rail)) throw new Error(`rail must be one of: ${[...VALID_RAILS].join(', ')}`);
    const amountCents = toCents(amount);

    const orderId = identifier('TXS');
    const status = 'pending';

    await query(`
      INSERT INTO transactional_settlements
        (order_id, direction, rail, amount_cents, currency, asset, source_type, source_account_id, destination_type, destination_account_id,
         beneficiary_name, beneficiary_email, beneficiary_address, beneficiary_account, beneficiary_routing, beneficiary_bank,
         debtor_name, debtor_account, debtor_routing, debtor_bank, memo, priority, status, metadata, endpoint_id, connector)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
    `, [
      orderId, direction, rail, amountCents, currency, asset, sourceType || null, sourceAccountId || null,
      destinationType || null, destinationAccountId || null,
      beneficiaryName || null, beneficiaryEmail || null, beneficiaryAddress || null, beneficiaryAccount || null,
      beneficiaryRouting || null, beneficiaryBank || null,
      debtorName || null, debtorAccount || null, debtorRouting || null, debtorBank || null,
      memo || null, priority, status, safeJson(metadata), endpointId || null, connector || null
    ]);

    let order = await this.getOrder(orderId);

    if (direction === 'outbound' && reserveFunds && sourceAccountId && CashEngine) {
      try {
        const reserve = await CashEngine.transfer({
          fromAccountId: sourceAccountId,
          toAccountId: HOLD_ACCOUNT_ID,
          amountCents,
          movementType: 'transfer',
          memo: `Reserve for ${orderId}`,
          referenceId: orderId,
          referenceType: 'transactional_settlement'
        });
        await query(`UPDATE transactional_settlements SET status='reserved', reserve_tx_id=$1, updated_at=NOW() WHERE order_id=$2`, [reserve.movement_id || reserve.id, orderId]);
      } catch (e) {
        await query(`UPDATE transactional_settlements SET status='failed', error_message=$1, updated_at=NOW() WHERE order_id=$2`, [e.message, orderId]);
      }
      order = await this.getOrder(orderId);
    }

    return order;
  }

  static async getOrder(orderId) {
    await this.ensureTables();
    const res = await query('SELECT * FROM transactional_settlements WHERE order_id = $1', [orderId]);
    return this._rowToObject(res.rows[0]);
  }

  static async listOrders({ status, rail, direction, limit = 50, offset = 0 } = {}) {
    await this.ensureTables();
    const conditions = [];
    const params = [];
    let idx = 1;
    if (status) { conditions.push(`status = $${idx}`); params.push(status); idx++; }
    if (rail) { conditions.push(`rail = $${idx}`); params.push(rail); idx++; }
    if (direction) { conditions.push(`direction = $${idx}`); params.push(direction); idx++; }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Math.min(limit, 200), offset);
    const res = await query(`SELECT * FROM transactional_settlements ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`, params);
    return res.rows.map(r => this._rowToObject(r));
  }

  static async getSummary() {
    await this.ensureTables();
    const counts = await query(`
      SELECT status, COUNT(*) as cnt, SUM(amount_cents) as total_cents
      FROM transactional_settlements
      GROUP BY status
    `);
    const rails = await query(`
      SELECT rail, COUNT(*) as cnt, SUM(amount_cents) as total_cents
      FROM transactional_settlements
      GROUP BY rail
    `);
    return {
      byStatus: Object.fromEntries(counts.rows.map(r => [r.status, { count: parseInt(r.cnt), usd: (parseInt(r.total_cents || 0) / 100) }])),
      byRail: Object.fromEntries(rails.rows.map(r => [r.rail, { count: parseInt(r.cnt), usd: (parseInt(r.total_cents || 0) / 100) }]))
    };
  }

  static async executeOrder(orderId) {
    await this.ensureTables();
    const order = await this.getOrder(orderId);
    if (!order) throw new Error('Order not found');
    if (['completed', 'settled', 'failed', 'cancelled'].includes(order.status)) throw new Error(`Order already ${order.status}`);

    try {
      let result;
      if (order.direction === 'inbound') {
        result = await this._executeInbound(order);
      } else {
        result = await this._executeOutbound(order);
      }
      return result;
    } catch (e) {
      await query(`UPDATE transactional_settlements SET status='failed', error_message=$1, updated_at=NOW() WHERE order_id=$2`, [e.message, orderId]);
      if (order.reserve_tx_id && !order.reserve_released) await this._releaseReserve(orderId);
      throw e;
    }
  }

  static async _executeInbound(order) {
    const { destination_account_id, amount_cents, memo, order_id } = order;
    if (destination_account_id && CashEngine) {
      await CashEngine.deposit({ toAccountId: destination_account_id, amountCents: amount_cents, memo: memo || `Inbound ${order_id}`, referenceId: order_id });
    }
    if (destination_account_id && SubLedgerEngine && !CashEngine) {
      await SubLedgerEngine.postTransaction({
        subLedgerId: destination_account_id,
        transactionType: 'credit',
        amount: amount_cents / 100,
        description: memo || `Inbound ${order_id}`,
        referenceType: 'transactional_settlement',
        referenceId: order_id
      });
    }
    const raw = { direction: 'inbound', destination: destination_account_id, amount: amount_cents / 100 };
    await query(`
      UPDATE transactional_settlements SET status='settled', settled_at=NOW(), raw_response=$1, updated_at=NOW() WHERE order_id=$2
    `, [safeJson(raw), order_id]);
    return this.getOrder(order_id);
  }

  static async _executeOutbound(order) {
    const { rail, order_id, amount_cents, currency, asset, source_account_id, endpoint_id } = order;
    if (order.status === 'pending' && CashEngine) {
      // reserve if not already reserved
      try {
        const reserve = await CashEngine.transfer({
          fromAccountId: source_account_id,
          toAccountId: HOLD_ACCOUNT_ID,
          amountCents: amount_cents,
          movementType: 'transfer',
          memo: `Reserve for ${order_id}`,
          referenceId: order_id,
          referenceType: 'transactional_settlement'
        });
        await query(`UPDATE transactional_settlements SET status='reserved', reserve_tx_id=$1, updated_at=NOW() WHERE order_id=$2`, [reserve.movement_id || reserve.id, order_id]);
      } catch (e) { throw new Error(`Reserve failed: ${e.message}`); }
    }

    let result = null;
    let status = 'failed';
    let externalId = null;
    let rawRequest = null;
    let rawResponse = null;
    let error = null;

    try {
      if (SETTLEMENT_RAILS.has(rail)) {
        const settlement = await SettlementEngine.createSettlement({
          sourceType: order.source_type || 'manual',
          sourceId: order.order_id,
          sourceAccountId,
          rail,
          endpointId: endpoint_id,
          connector: order.connector,
          amount: amount_cents / 100,
          currency,
          debtorName: order.debtor_name,
          debtorAccount: order.debtor_account,
          debtorRouting: order.debtor_routing,
          debtorBank: order.debtor_bank,
          creditorName: order.beneficiary_name,
          creditorAccount: order.beneficiary_account,
          creditorRouting: order.beneficiary_routing,
          creditorBank: order.beneficiary_bank,
          paymentType: 'payment',
          description: order.memo || `${rail} ${order_id}`,
          config: { ...order.metadata, endpoint_id }
        });
        const executed = await SettlementEngine.executeSettlement(settlement.settlement_id);
        result = executed;
        status = executed.status;
        externalId = executed.external_id;
        rawRequest = executed.raw_request;
        rawResponse = executed.raw_response;
      } else if (rail === 'lili' && LiliBankEngine) {
        result = await LiliBankEngine.createPayment({
          amount: amount_cents / 100,
          currency,
          recipientName: order.beneficiary_name,
          recipientAccount: order.beneficiary_account,
          recipientRouting: order.beneficiary_routing,
          recipientBank: order.beneficiary_bank,
          recipientEmail: order.beneficiary_email,
          sourceAccountId,
          initiatedBy: 'transactional_settlement'
        });
        status = result.status || 'manual_pending';
        externalId = result.payment_id;
        rawRequest = safeJson(result.request || result);
        rawResponse = safeJson(result.response || result);
      } else if (rail === 'bill' && ElectronicSettlementEngine) {
        result = await ElectronicSettlementEngine.submitElectronicPayment({
          amount: amount_cents / 100,
          payee_name: order.beneficiary_name,
          payee_account: order.beneficiary_account,
          payee_routing: order.beneficiary_routing,
          payee_bank_name: order.beneficiary_bank,
          payment_type: order.metadata.payment_type || 'vendor_payment',
          priority: order.priority,
          source_account_code: source_account_id,
          description: order.memo || `${rail} ${order_id}`,
          initiated_by: 'transactional_settlement'
        });
        status = result.status || 'submitted';
        externalId = result.settlement_id;
        rawRequest = safeJson(result);
        rawResponse = safeJson(result);
      } else if (rail === 'deposit') {
        status = 'completed';
      } else {
        // Digital / decentralized rails: PayoutCenterEngine handles dex, stablecoin_dex, sit, cashapp, fund_rail, btcpay, module, lili
        const railOptions = { ...order.metadata, rail };
        if (order.beneficiary_account) railOptions.accountNumber = order.beneficiary_account;
        if (order.beneficiary_routing) railOptions.routingNumber = order.beneficiary_routing;
        if (order.beneficiary_bank) railOptions.bankName = order.beneficiary_bank;
        if (order.beneficiary_email) railOptions.email = order.beneficiary_email;
        if (order.beneficiary_address) railOptions.address = order.beneficiary_address;

        const recipient = order.beneficiary_address || order.beneficiary_email || order.beneficiary_account;
        result = await PayoutCenterEngine.createPayment({
          paymentType: 'payout',
          sourceType: order.source_type || 'treasury',
          sourceAccountId,
          recipientType: order.beneficiary_address ? 'address' : 'external',
          recipientIdentifier: recipient,
          amount: amount_cents / 100,
          asset: asset.toUpperCase(),
          description: order.memo || `${rail} ${order_id}`,
          rail: rail === 'sovereign' ? 'sit' : rail,
          railOptions
        });
        status = result.status;
        externalId = result.id;
        rawRequest = safeJson(result);
        rawResponse = safeJson(result.tx_data || result);
      }

      const finalStatus = this._mapStatus(status);
      if (finalStatus === 'completed' || finalStatus === 'settled') {
        await this._moveHoldToSettled(order_id, amount_cents);
      }

      await query(`
        UPDATE transactional_settlements
        SET status=$2, external_id=$3, raw_request=$4, raw_response=$5, error_message=$6, updated_at=NOW()
        WHERE order_id=$1
      `, [order_id, finalStatus, externalId, rawRequest, rawResponse, error]);

      return this.getOrder(order_id);
    } catch (e) {
      error = e.message;
      await query(`
        UPDATE transactional_settlements SET status='failed', error_message=$1, raw_response=$2, updated_at=NOW() WHERE order_id=$3
      `, [error, rawResponse, order_id]);
      throw e;
    }
  }

  static _mapStatus(status) {
    if (!status) return 'submitted';
    const s = String(status).toLowerCase();
    if (['completed', 'settled', 'success', 'successed', 'done', 'finished'].includes(s)) return 'completed';
    if (['settled'].includes(s)) return 'settled';
    if (['pending', 'submitted', 'originated', 'queued', 'api_pending', 'awaiting_sender', 'awaiting_payment', 'manual_pending', 'reserved', 'transmitted'].includes(s)) return 'submitted';
    if (['failed', 'failure', 'error', 'rejected'].includes(s)) return 'failed';
    if (['cancelled', 'canceled'].includes(s)) return 'cancelled';
    return 'submitted';
  }

  static async _moveHoldToSettled(orderId, amountCents) {
    if (!CashEngine) return;
    try {
      await CashEngine.transfer({
        fromAccountId: HOLD_ACCOUNT_ID,
        toAccountId: SETTLED_ACCOUNT_ID,
        amountCents,
        movementType: 'transfer',
        memo: `Settle ${orderId}`,
        referenceId: orderId,
        referenceType: 'transactional_settlement'
      });
    } catch (e) { console.warn('[txs] move hold to settled failed:', e.message); }
  }

  static async _releaseReserve(orderId) {
    const order = await this.getOrder(orderId);
    if (!order || order.reserve_released || !order.reserve_tx_id) return;
    if (!CashEngine) return;
    try {
      await CashEngine.transfer({
        fromAccountId: HOLD_ACCOUNT_ID,
        toAccountId: order.source_account_id,
        amountCents: order.amount_cents,
        movementType: 'reversal',
        memo: `Release reserve for ${orderId}`,
        referenceId: orderId,
        referenceType: 'transactional_settlement'
      });
      await query(`UPDATE transactional_settlements SET reserve_released=TRUE, updated_at=NOW() WHERE order_id=$1`, [orderId]);
    } catch (e) { console.warn('[txs] reserve release failed:', e.message); }
  }

  static async cancelOrder(orderId) {
    await this.ensureTables();
    const order = await this.getOrder(orderId);
    if (!order) throw new Error('Order not found');
    if (['completed', 'settled', 'failed', 'cancelled'].includes(order.status)) throw new Error(`Order already ${order.status}`);
    await this._releaseReserve(orderId);
    await query(`UPDATE transactional_settlements SET status='cancelled', updated_at=NOW() WHERE order_id=$1`, [orderId]);
    return this.getOrder(orderId);
  }

  static async batchExecute(orderIds) {
    const results = [];
    for (const id of orderIds) {
      try { results.push({ orderId: id, ok: true, order: await this.executeOrder(id) }); }
      catch (e) { results.push({ orderId: id, ok: false, error: e.message }); }
    }
    return results;
  }

  static async reconcile(orderId) {
    const order = await this.getOrder(orderId);
    if (!order) throw new Error('Order not found');
    // Best-effort status refresh from child engines. For now, return current state.
    return { order, refreshedAt: new Date().toISOString(), note: 'Reconciliation polling is rail-specific; implement per adapter as needed.' };
  }

  static async deleteOrder(orderId) {
    await this.ensureTables();
    const order = await this.getOrder(orderId);
    if (!order) throw new Error('Order not found');
    if (!['draft', 'pending', 'failed', 'cancelled'].includes(order.status)) throw new Error('Only draft/pending/failed/cancelled orders may be deleted');
    await this._releaseReserve(orderId);
    await query('DELETE FROM transactional_settlements WHERE order_id=$1', [orderId]);
    return { deleted: true };
  }
}

module.exports = { TransactionalSettlementServerEngine };
