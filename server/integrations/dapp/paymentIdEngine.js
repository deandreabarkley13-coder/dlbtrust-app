'use strict';

/**
 * Payment ID Engine
 *
 * Generates and tracks canonical payment IDs across all trust payment rails.
 * - Every payment intent gets a stable `PAY-{ts}-{rand}` id.
 * - Rail-specific child IDs (settlement, external payment, wire payout, etc.)
 *   are registered against the canonical id.
 * - External ids returned by banks/fintechs are also stored.
 * - Status lifecycle is tracked with an event log for audit.
 */

const pool = require('../bonds/pgPool');

function generateId(prefix = 'PAY') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function generateKey() {
  return `k-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

const VALID_STATUSES = new Set([
  'created','reserved','submitted','transmitted','originated','queued','manual_pending',
  'settled','completed','failed','cancelled'
]);

class PaymentIdEngine {
  static async ensureTables() {
    if (!pool) throw new Error('Database pool not available');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payment_ids (
        payment_id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE NOT NULL,
        source_type TEXT DEFAULT 'manual',
        source_id TEXT,
        rail TEXT,
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        creditor_name TEXT,
        creditor_account TEXT,
        creditor_routing TEXT,
        creditor_bank TEXT,
        debtor_name TEXT,
        debtor_account TEXT,
        debtor_routing TEXT,
        debtor_bank TEXT,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','reserved','submitted','transmitted','originated','queued','manual_pending','settled','completed','failed','cancelled')),
        child_type TEXT,
        child_id TEXT,
        external_id TEXT,
        external_status TEXT,
        raw_request TEXT,
        raw_response TEXT,
        error_message TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_ids_status ON payment_ids(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_ids_source ON payment_ids(source_type, source_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_ids_child ON payment_ids(child_type, child_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_ids_external ON payment_ids(external_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_ids_idempotency ON payment_ids(idempotency_key)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payment_id_events (
        event_id TEXT PRIMARY KEY,
        payment_id TEXT NOT NULL REFERENCES payment_ids(payment_id) ON DELETE CASCADE,
        event TEXT NOT NULL,
        status TEXT,
        child_type TEXT,
        child_id TEXT,
        external_id TEXT,
        external_status TEXT,
        raw_request TEXT,
        raw_response TEXT,
        error_message TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_id_events_payment ON payment_id_events(payment_id)`);
  }

  static async createPaymentId(opts = {}) {
    await this.ensureTables();
    const {
      idempotencyKey,
      sourceType = 'manual', sourceId,
      rail,
      amount, currency = 'USD',
      debtorName, debtorAccount, debtorRouting, debtorBank,
      creditorName, creditorAccount, creditorRouting, creditorBank,
      description,
      metadata = {}
    } = opts;

    const amountCents = toCents(amount);
    if (amountCents <= 0) throw new Error('amount must be positive');

    const key = idempotencyKey || generateKey();
    const existing = await this.getByIdempotencyKey(key);
    if (existing) return existing;

    const paymentId = generateId('PAY');
    await pool.query(
      `INSERT INTO payment_ids
       (payment_id, idempotency_key, source_type, source_id, rail, amount_cents, currency,
        debtor_name, debtor_account, debtor_routing, debtor_bank,
        creditor_name, creditor_account, creditor_routing, creditor_bank,
        description, status, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        paymentId, key, sourceType, sourceId || null, rail || null, amountCents, currency,
        debtorName || null, debtorAccount || null, debtorRouting || null, debtorBank || null,
        creditorName || null, creditorAccount || null, creditorRouting || null, creditorBank || null,
        description || null, 'created', JSON.stringify(metadata)
      ]
    );
    await this._addEvent({ paymentId, event: 'created', status: 'created', metadata });
    return this.getPaymentId(paymentId);
  }

  static async getPaymentId(id) {
    await this.ensureTables();
    const res = await pool.query('SELECT * FROM payment_ids WHERE payment_id = $1', [id]);
    if (!res.rows[0]) return null;
    return this._hydrate(res.rows[0]);
  }

  static async getByIdempotencyKey(key) {
    await this.ensureTables();
    const res = await pool.query('SELECT * FROM payment_ids WHERE idempotency_key = $1', [key]);
    if (!res.rows[0]) return null;
    return this._hydrate(res.rows[0]);
  }

  static async updateStatus(paymentId, { status, externalStatus, rawRequest, rawResponse, errorMessage, metadata } = {}) {
    await this.ensureTables();
    if (status && !VALID_STATUSES.has(status)) throw new Error(`Invalid status: ${status}`);
    await pool.query(
      `UPDATE payment_ids
       SET status = COALESCE($2, status),
           external_status = COALESCE($3, external_status),
           raw_request = COALESCE($4, raw_request),
           raw_response = COALESCE($5, raw_response),
           error_message = COALESCE($6, error_message),
           metadata = COALESCE($7, metadata),
           updated_at = NOW()
       WHERE payment_id = $1`,
      [paymentId, status, externalStatus, rawRequest, rawResponse, errorMessage, metadata ? JSON.stringify(metadata) : null]
    );
    await this._addEvent({ paymentId, event: 'status_update', status, externalStatus, rawRequest, rawResponse, errorMessage, metadata });
    return this.getPaymentId(paymentId);
  }

  static async registerChild(paymentId, { childType, childId, externalId, externalStatus, status, rawRequest, rawResponse, errorMessage, metadata } = {}) {
    await this.ensureTables();
    if (!childType || !childId) throw new Error('childType and childId required');
    await pool.query(
      `UPDATE payment_ids
       SET child_type = COALESCE($2, child_type),
           child_id = COALESCE($3, child_id),
           external_id = COALESCE($4, external_id),
           external_status = COALESCE($5, external_status),
           status = COALESCE($6, status),
           raw_request = COALESCE($7, raw_request),
           raw_response = COALESCE($8, raw_response),
           error_message = COALESCE($9, error_message),
           metadata = COALESCE($10, metadata),
           updated_at = NOW()
       WHERE payment_id = $1`,
      [paymentId, childType, childId, externalId, externalStatus, status, rawRequest, rawResponse, errorMessage, metadata ? JSON.stringify(metadata) : null]
    );
    await this._addEvent({ paymentId, event: 'child_registered', childType, childId, externalId, externalStatus, status, rawRequest, rawResponse, errorMessage, metadata });
    return this.getPaymentId(paymentId);
  }

  static async linkChildToSource(sourceType, sourceId, { childType, childId, externalId, externalStatus, status, rawRequest, rawResponse, errorMessage, metadata } = {}) {
    await this.ensureTables();
    const rows = await this.lookup({ sourceId });
    if (!rows || !rows.length) return null;
    const payment = rows.find(r => r.source_type === sourceType) || rows[0];
    return this.registerChild(payment.payment_id, { childType, childId, externalId, externalStatus, status, rawRequest, rawResponse, errorMessage, metadata });
  }

  static async listPaymentIds({ status, rail, sourceType, limit = 50 } = {}) {
    await this.ensureTables();
    const conditions = [];
    const params = [];
    if (status) { conditions.push(`status = $${params.length + 1}`); params.push(status); }
    if (rail) { conditions.push(`rail = $${params.length + 1}`); params.push(rail); }
    if (sourceType) { conditions.push(`source_type = $${params.length + 1}`); params.push(sourceType); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const res = await pool.query(`SELECT * FROM payment_ids ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return res.rows.map(r => this._hydrate(r));
  }

  static async lookup({ childId, externalId, idempotencyKey, sourceId } = {}) {
    await this.ensureTables();
    if (idempotencyKey) {
      const res = await pool.query('SELECT * FROM payment_ids WHERE idempotency_key = $1', [idempotencyKey]);
      return res.rows.map(r => this._hydrate(r));
    }
    if (childId) {
      const res = await pool.query('SELECT * FROM payment_ids WHERE child_id = $1', [childId]);
      return res.rows.map(r => this._hydrate(r));
    }
    if (externalId) {
      const res = await pool.query('SELECT * FROM payment_ids WHERE external_id = $1', [externalId]);
      return res.rows.map(r => this._hydrate(r));
    }
    if (sourceId) {
      const res = await pool.query('SELECT * FROM payment_ids WHERE source_id = $1', [sourceId]);
      return res.rows.map(r => this._hydrate(r));
    }
    throw new Error('One of idempotencyKey, childId, externalId, or sourceId required');
  }

  static async getEvents(paymentId) {
    await this.ensureTables();
    const res = await pool.query('SELECT * FROM payment_id_events WHERE payment_id = $1 ORDER BY created_at ASC', [paymentId]);
    return res.rows;
  }

  static async poll(paymentId) {
    await this.ensureTables();
    const payment = await this.getPaymentId(paymentId);
    if (!payment) throw new Error('Payment ID not found');
    if (!payment.child_id || !payment.rail) return payment;
    let currentStatus = payment.status;
    let externalStatus = payment.external_status;
    let rawResponse = payment.raw_response;
    let error = payment.error_message;

    // Poll child engine if available
    try {
      const SettlementEngine = require('./settlementEngine').SettlementEngine;
      const ExternalEndpointEngine = require('./externalEndpointEngine').ExternalEndpointEngine;
      const WireOriginationEngine = require('./wireOriginationEngine').WireOriginationEngine;
      const OpenBankingEngine = require('./openBankingEngine').OpenBankingEngine;

      if (payment.child_type === 'settlement') {
        const s = await SettlementEngine.getSettlement(payment.child_id);
        if (s) {
          currentStatus = SettlementEngine._mapChildStatus(s.rail, s.status);
          externalStatus = s.status;
          rawResponse = s.raw_response;
          error = s.error_message;
        }
      } else if (payment.child_type === 'external_payment') {
        const ep = await ExternalEndpointEngine.getPayment(payment.child_id);
        if (ep) {
          currentStatus = ep.status;
          externalStatus = ep.status;
          rawResponse = ep.raw_response;
          error = ep.error_message;
        }
      } else if (payment.child_type === 'wire_payout') {
        const wp = await WireOriginationEngine.getPayout(payment.child_id);
        if (wp) {
          currentStatus = WireOriginationEngine._mapStatus ? WireOriginationEngine._mapStatus(wp.status) : wp.status;
          externalStatus = wp.status;
          rawResponse = wp.raw_response;
          error = wp.error_message;
        }
      } else if (payment.child_type === 'open_banking_payment') {
        const ob = await OpenBankingEngine.getPayment(payment.child_id);
        if (ob) {
          currentStatus = OpenBankingEngine._mapStatus ? OpenBankingEngine._mapStatus(ob.status) : ob.status;
          externalStatus = ob.status;
          rawResponse = ob.raw_response;
          error = ob.error_message;
        }
      }
    } catch (e) {
      error = e.message;
    }

    if (currentStatus !== payment.status || externalStatus !== payment.external_status || error !== payment.error_message) {
      await this.updateStatus(paymentId, { status: currentStatus, externalStatus, rawResponse, errorMessage: error });
    }
    return this.getPaymentId(paymentId);
  }

  static async _addEvent({ paymentId, event, status, externalStatus, childType, childId, externalId, rawRequest, rawResponse, errorMessage, metadata } = {}) {
    const eventId = `EVT-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    await pool.query(
      `INSERT INTO payment_id_events
       (event_id, payment_id, event, status, external_status, child_type, child_id, external_id,
        raw_request, raw_response, error_message, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        eventId, paymentId, event, status || null, externalStatus || null,
        childType || null, childId || null, externalId || null,
        rawRequest || null, rawResponse || null, errorMessage || null,
        metadata ? JSON.stringify(metadata) : null
      ]
    );
  }

  static _hydrate(row) {
    const r = { ...row };
    try { r.metadata = r.metadata ? JSON.parse(r.metadata) : {}; } catch {}
    return r;
  }
}

module.exports = { PaymentIdEngine };
