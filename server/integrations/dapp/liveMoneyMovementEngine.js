'use strict';

/**
 * Live Money Movement Engine
 *
 * One API to move real fiat from the trust ledger to an external beneficiary.
 * It validates source-of-funds, picks the cheapest/fastest available rail
 * (host-to-host, live fintech, external endpoint, wire/ACH, open banking,
 * stablecoin, or manual), reserves cash, executes via the Settlement Engine,
 * and tracks the full lifecycle with Payment ID correlation.
 */

const pool = require('../bonds/pgPool');

let SettlementEngine;
let PaymentIdEngine;
let CashEngine;
let StablecoinEngine;
let HostToHostEngine;
let LiveFinTechEndpointEngine;
let ExternalEndpointEngine;
let OpenBankingEngine;
let WireOriginationEngine;
let ComplianceEngine;

function loadDeps() {
  try { SettlementEngine = require('./settlementEngine').SettlementEngine; } catch (e) { SettlementEngine = null; }
  try { PaymentIdEngine = require('./paymentIdEngine').PaymentIdEngine; } catch (e) { PaymentIdEngine = null; }
  try { ({ CashEngine } = require('../cash/cashEngine')); } catch (e) { CashEngine = null; }
  try { StablecoinEngine = require('./stablecoinEngine').StablecoinEngine; } catch (e) { StablecoinEngine = null; }
  try { HostToHostEngine = require('./hostToHostEngine').HostToHostEngine; } catch (e) { HostToHostEngine = null; }
  try { LiveFinTechEndpointEngine = require('./liveFintechEndpointEngine').LiveFinTechEndpointEngine; } catch (e) { LiveFinTechEndpointEngine = null; }
  try { ExternalEndpointEngine = require('./externalEndpointEngine').ExternalEndpointEngine; } catch (e) { ExternalEndpointEngine = null; }
  try { OpenBankingEngine = require('./openBankingEngine').OpenBankingEngine; } catch (e) { OpenBankingEngine = null; }
  try { WireOriginationEngine = require('./wireOriginationEngine').WireOriginationEngine; } catch (e) { WireOriginationEngine = null; }
  try { ComplianceEngine = require('../compliance/complianceEngine').ComplianceEngine; } catch (e) { ComplianceEngine = null; }
}

const VALID_RAILS = new Set([
  'auto', 'trust_bank', 'host_to_host', 'live_fintech', 'external_endpoint',
  'wire', 'ach', 'open_banking', 'iso20022', 'stablecoin', 'manual'
]);

function generateId(prefix = 'LMM') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

function dollars(cents) {
  return Number(cents || 0) / 100;
}

class LiveMoneyMovementEngine {
  static async ensureTables() {
    loadDeps();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS live_money_movements (
        movement_id TEXT PRIMARY KEY,
        source_type TEXT DEFAULT 'cash',
        source_account_id TEXT DEFAULT '',
        source_id TEXT DEFAULT '',
        rail TEXT NOT NULL,
        endpoint_id TEXT DEFAULT '',
        connector TEXT DEFAULT '',
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        debtor_name TEXT DEFAULT '',
        debtor_account TEXT DEFAULT '',
        debtor_routing TEXT DEFAULT '',
        debtor_bank TEXT DEFAULT '',
        creditor_name TEXT NOT NULL,
        creditor_account TEXT DEFAULT '',
        creditor_routing TEXT DEFAULT '',
        creditor_bank TEXT DEFAULT '',
        payment_type TEXT DEFAULT 'payment',
        description TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reserved','submitted','completed','failed','cancelled','manual_pending')),
        settlement_id TEXT DEFAULT '',
        payment_id TEXT DEFAULT '',
        external_id TEXT DEFAULT '',
        raw_request TEXT DEFAULT '',
        raw_response TEXT DEFAULT '',
        error_message TEXT DEFAULT '',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_live_money_status ON live_money_movements(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_live_money_settlement ON live_money_movements(settlement_id)`);
  }

  // ─── Core: initiate a live movement ────────────────────────────────────────────
  static async initiateMovement(opts = {}) {
    loadDeps();
    await this.ensureTables();

    const {
      sourceType = 'cash', sourceAccountId, sourceId,
      rail = 'auto', endpointId, connector,
      amount, currency = 'USD',
      debtorName, debtorAccount, debtorRouting, debtorBank,
      creditorName, creditorAccount, creditorRouting, creditorBank,
      paymentType = 'payment', description, skipCompliance,
      config = {}, metadata = {}
    } = opts;

    if (!creditorName) throw new Error('creditorName is required');
    const amountCents = toCents(amount);
    if (amountCents <= 0) throw new Error('amount must be positive');
    if (!VALID_RAILS.has(rail)) throw new Error('Valid rail is required');

    if (sourceAccountId && CashEngine) {
      const acct = await CashEngine.getAccount(sourceAccountId);
      if (!acct) throw new Error(`Source account not found: ${sourceAccountId}`);
      if (parseInt(acct.balance_cents || 0, 10) < amountCents) throw new Error(`Insufficient balance in ${sourceAccountId}`);
    }

    // Optional compliance check
    if (!skipCompliance && ComplianceEngine) {
      try {
        const screening = await ComplianceEngine.screen({
          type: 'combined', entityType: 'business',
          businessName: creditorName,
          bankAccount: creditorAccount,
          routingNumber: creditorRouting,
          amount: dollars(amountCents),
        });
        if (screening.status === 'blocked') throw new Error(`Compliance blocked: ${screening.risk_level} (${screening.risk_score})`);
      } catch (e) { if (e.message && e.message.includes('Compliance blocked')) throw e; console.warn('[live-money] compliance skipped:', e.message); }
    }

    const movementId = generateId('LMM');
    const selected = rail === 'auto' ? await this._selectRail({ creditorAccount, creditorRouting, endpointId }) : { rail, endpointId };

    await pool.query(`
      INSERT INTO live_money_movements
        (movement_id, source_type, source_account_id, source_id, rail, endpoint_id, connector,
         amount_cents, currency, debtor_name, debtor_account, debtor_routing, debtor_bank,
         creditor_name, creditor_account, creditor_routing, creditor_bank,
         payment_type, description, status, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
    `, [
      movementId, sourceType, sourceAccountId || '', sourceId || '',
      selected.rail, selected.endpointId || '', connector || '',
      amountCents, currency, debtorName || '', debtorAccount || '', debtorRouting || '', debtorBank || '',
      creditorName, creditorAccount || '', creditorRouting || '', creditorBank || '',
      paymentType, description || '', 'pending', JSON.stringify(metadata || {})
    ]);

    if (PaymentIdEngine) {
      try {
        await PaymentIdEngine.createPaymentId({
          sourceType: 'live_money', sourceId: movementId,
          rail: selected.rail, amount: dollars(amountCents), currency,
          debtorName, debtorAccount, debtorRouting, debtorBank,
          creditorName, creditorAccount, creditorRouting, creditorBank,
          description,
          metadata: { endpoint_id: selected.endpointId, connector }
        });
      } catch (e) { console.warn('[live-money] payment-id create:', e.message); }
    }

    return this.getMovement(movementId);
  }

  static async executeMovement(movementId) {
    loadDeps();
    await this.ensureTables();
    const movement = await this.getMovement(movementId);
    if (!movement) throw new Error('Movement not found');
    if (!['pending','reserved','manual_pending'].includes(movement.status)) throw new Error(`Movement cannot be executed from status ${movement.status}`);

    if (!SettlementEngine) throw new Error('SettlementEngine not available');

    let settlement;
    try {
      settlement = await SettlementEngine.createSettlement({
        sourceType: movement.source_type,
        sourceId: movement.source_id,
        sourceAccountId: movement.source_account_id,
        rail: movement.rail === 'iso20022' ? 'iso20022' : movement.rail,
        endpointId: movement.endpoint_id,
        connector: movement.connector,
        amount: dollars(movement.amount_cents),
        currency: movement.currency,
        debtorName: movement.debtor_name,
        debtorAccount: movement.debtor_account,
        debtorRouting: movement.debtor_routing,
        debtorBank: movement.debtor_bank,
        creditorName: movement.creditor_name,
        creditorAccount: movement.creditor_account,
        creditorRouting: movement.creditor_routing,
        creditorBank: movement.creditor_bank,
        paymentType: movement.payment_type,
        description: movement.description || `Live money movement ${movementId}`,
      });
    } catch (e) {
      await this._updateStatus(movementId, 'failed', { errorMessage: e.message, rawRequest: JSON.stringify({}) });
      throw e;
    }

    await pool.query(`UPDATE live_money_movements SET settlement_id = $2, status = 'reserved', updated_at = NOW() WHERE movement_id = $1`, [movementId, settlement.settlement_id]);

    let result;
    let status = 'failed';
    let error = null;
    try {
      result = await SettlementEngine.executeSettlement(settlement.settlement_id);
      status = this._mapSettlementStatus(result.status);
    } catch (e) {
      error = e.message;
      status = 'failed';
    }

    const updates = {
      status,
      rawRequest: result ? result.raw_request || '' : '',
      rawResponse: result ? result.raw_response || '' : '',
      errorMessage: error || (result ? result.error_message || '' : ''),
      externalId: result ? result.external_id || '' : ''
    };
    await this._updateStatus(movementId, status, updates);

    if (PaymentIdEngine && result) {
      try {
        await PaymentIdEngine.linkChildToSource('live_money', movementId, {
          childType: 'settlement', childId: result.settlement_id,
          externalId: result.external_id || null,
          externalStatus: result.status,
          status: result.status,
          rawRequest: result.raw_request || null,
          rawResponse: result.raw_response || null,
          errorMessage: result.error_message || null
        });
      } catch (e) { console.warn('[live-money] payment-id link:', e.message); }
    }

    if (error) throw new Error(error);
    return this.getMovement(movementId);
  }

  static _mapSettlementStatus(status) {
    if (['completed','settled'].includes(status)) return 'completed';
    if (['submitted','transmitted','originated','approved','queued'].includes(status)) return 'submitted';
    if (status === 'manual_pending') return 'manual_pending';
    return 'failed';
  }

  static async _updateStatus(movementId, status, { settlementId, externalId, rawRequest, rawResponse, errorMessage } = {}) {
    await pool.query(`
      UPDATE live_money_movements
      SET status = $2,
          settlement_id = COALESCE($3, settlement_id),
          external_id = COALESCE($4, external_id),
          raw_request = COALESCE($5, raw_request),
          raw_response = COALESCE($6, raw_response),
          error_message = COALESCE($7, error_message),
          updated_at = NOW()
      WHERE movement_id = $1
    `, [movementId, status, settlementId || null, externalId || null, rawRequest || null, rawResponse || null, errorMessage || null]);
  }

  // ─── Auto rail selection ─────────────────────────────────────────────────────
  static async _selectRail({ creditorAccount, creditorRouting, endpointId } = {}) {
    loadDeps();
    const isCrypto = /^0x[a-f0-9]{40}$/i.test(creditorAccount || '');
    if (isCrypto && StablecoinEngine) return { rail: 'stablecoin', endpointId: '' };

    if (endpointId) {
      if (HostToHostEngine) {
        const p = await HostToHostEngine.getPartner(endpointId);
        if (p && p.enabled) return { rail: 'host_to_host', endpointId };
      }
      if (LiveFinTechEndpointEngine) {
        const e = await LiveFinTechEndpointEngine.getEndpoint(endpointId);
        if (e && e.enabled) return { rail: 'live_fintech', endpointId };
      }
      if (ExternalEndpointEngine) {
        const e = await ExternalEndpointEngine.getEndpoint(endpointId);
        if (e && e.enabled) return { rail: 'external_endpoint', endpointId };
      }
    }

    if (HostToHostEngine) {
      const partners = await HostToHostEngine.listPartners({ enabled: true });
      if (partners.length) return { rail: 'host_to_host', endpointId: partners[0].partner_id };
    }

    if (LiveFinTechEndpointEngine) {
      const endpoints = await LiveFinTechEndpointEngine.listEndpoints({ enabled: true });
      if (endpoints.length) return { rail: 'live_fintech', endpointId: endpoints[0].endpoint_id };
    }

    if (ExternalEndpointEngine) {
      const endpoints = await ExternalEndpointEngine.listEndpoints({ enabled: true });
      if (endpoints.length) return { rail: 'external_endpoint', endpointId: endpoints[0].endpoint_id };
    }

    if (WireOriginationEngine) {
      const readiness = await WireOriginationEngine.readiness();
      const adapter = readiness.adapters.find(a => a.id === 'wire' && a.ready);
      if (adapter) return { rail: 'wire', endpointId: '' };
    }

    if (OpenBankingEngine) {
      const connectors = await OpenBankingEngine.getConnectors();
      if (connectors.some(c => c.ready)) return { rail: 'open_banking', endpointId: '' };
    }

    return { rail: 'manual', endpointId: '' };
  }

  // ─── CRUD ────────────────────────────────────────────────────────────────────
  static async getMovement(movementId) {
    const res = await pool.query('SELECT * FROM live_money_movements WHERE movement_id = $1', [movementId]);
    return res.rows[0] || null;
  }

  static async listMovements({ status, limit = 50 } = {}) {
    await this.ensureTables();
    const conditions = []; const params = []; let i = 1;
    if (status) { conditions.push(`status = $${i++}`); params.push(status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const res = await pool.query(`SELECT * FROM live_money_movements ${where} ORDER BY created_at DESC LIMIT $${i}`, params);
    return res.rows;
  }

  static async cancelMovement(movementId) {
    const movement = await this.getMovement(movementId);
    if (!movement) throw new Error('Movement not found');
    if (!['pending','reserved','manual_pending'].includes(movement.status)) throw new Error('Movement cannot be cancelled');
    await this._updateStatus(movementId, 'cancelled');
    if (SettlementEngine && movement.settlement_id) {
      try { await SettlementEngine.cancelSettlement ? SettlementEngine.cancelSettlement(movement.settlement_id) : Promise.resolve(); } catch (e) {}
    }
    return this.getMovement(movementId);
  }

  static async pollMovement(movementId) {
    const movement = await this.getMovement(movementId);
    if (!movement) throw new Error('Movement not found');
    if (movement.status === 'completed') return movement;
    if (['failed','cancelled'].includes(movement.status)) return movement;
    return await this.executeMovement(movementId);
  }

  static async getDashboard() {
    await this.ensureTables();
    const movements = await this.listMovements({ limit: 100 });
    const [totals, rails] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status IN ('pending','reserved')) AS pending,
          COUNT(*) FILTER (WHERE status = 'submitted') AS submitted,
          COUNT(*) FILTER (WHERE status = 'completed') AS completed,
          COUNT(*) FILTER (WHERE status = 'failed') AS failed,
          COALESCE(SUM(amount_cents) FILTER (WHERE status = 'completed'), 0) AS completed_cents
        FROM live_money_movements
      `).then(r => r.rows[0]),
      SettlementEngine ? SettlementEngine.getRails() : []
    ]);
    return {
      movements,
      counts: {
        pending: Number(totals.pending),
        submitted: Number(totals.submitted),
        completed: Number(totals.completed),
        failed: Number(totals.failed),
      },
      completedUsd: dollars(totals.completed_cents),
      rails
    };
  }

  static async getAvailableRails() {
    loadDeps();
    return SettlementEngine ? SettlementEngine.getRails() : [];
  }
}

module.exports = { LiveMoneyMovementEngine };
