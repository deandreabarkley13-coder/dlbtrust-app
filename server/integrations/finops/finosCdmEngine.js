'use strict';

/**
 * FinosCdmEngine
 *
 * FINOS Common Domain Model (CDM) adapter for the trust's private banking
 * ecosystem. Converts internal transactions (push-to-card, treasury on-ramp,
 * vendor payments) into canonical CDM event representations that can be
 * exchanged with banks and counterparties.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

function id(prefix = 'CDM') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function safeJson(obj) {
  return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v);
}

async function query(text, params) {
  if (!pool) throw new Error('Postgres pool not available');
  return pool.query(text, params);
}

class FinosCdmEngine {
  static async ensureTables() {
    if (!pool) return;
    await query(`
      CREATE TABLE IF NOT EXISTS cdm_events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        event_date TIMESTAMPTZ NOT NULL,
        intent TEXT,
        party_id TEXT,
        counterparty_id TEXT,
        asset TEXT,
        amount_cents BIGINT,
        currency TEXT,
        reference_id TEXT,
        status TEXT,
        payload JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }

  static _rowToObject(row) {
    if (!row) return null;
    return { ...row, amount: Number(row.amount_cents) / 100 };
  }

  static toCdmPayment({ referenceId, partyId = 'DLB_TRUST', counterpartyId, amount, currency = 'USD', cardholder, last4, network, status, intent = 'PAYMENT' }) {
    const cents = Math.round((Number(amount) || 0) * 100);
    const eventDate = new Date().toISOString();
    return {
      meta: {
        externalKey: referenceId,
        globalKey: id('CDM-EVT'),
        eventDate,
      },
      eventIdentifier: [{
        issuerReference: { externalReference: partyId },
        assignedIdentifier: { identifier: { value: referenceId } },
      }],
      eventDate,
      intent,
      functionEvent: {
        primitive: {
          cashTransfer: {
            quantity: [{ amount: cents }],
            payerReceiver: {
              payerPartyReference: { externalReference: partyId },
              receiverPartyReference: { externalReference: counterpartyId },
            },
            settlementTerms: {
              settlementCurrency: { value: currency },
              cashSettlementTerms: {
                settlementAmount: {
                  currency: { value: currency },
                  amount: amount,
                },
              },
            },
            status: status || 'PENDING',
          },
        },
      },
      party: [
        { partyId: [{ identifier: { value: partyId } }] },
        { partyId: [{ identifier: { value: counterpartyId } }] },
      ],
      metadata: { cardholder, last4, network },
    };
  }

  static async createEvent({
    eventType = 'CashTransfer',
    intent,
    partyId,
    counterpartyId,
    asset,
    amount,
    currency,
    referenceId,
    status,
    payload,
  }) {
    await this.ensureTables();
    const amountCents = Math.round((Number(amount) || 0) * 100);
    const eventId = id();
    await query(`
      INSERT INTO cdm_events (event_id, event_type, event_date, intent, party_id, counterparty_id, asset, amount_cents, currency, reference_id, status, payload)
      VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
    `, [eventId, eventType, intent || null, partyId || null, counterpartyId || null, asset || null, amountCents, currency || null, referenceId || null, status || 'PENDING', safeJson(payload || {})]);
    return this.getEvent(eventId);
  }

  static async getEvent(eventId) {
    await this.ensureTables();
    const res = await query('SELECT * FROM cdm_events WHERE event_id = $1', [eventId]);
    return this._rowToObject(res.rows[0]);
  }

  static async listEvents({ referenceId, limit = 50, offset = 0 } = {}) {
    await this.ensureTables();
    const conditions = []; const params = []; let idx = 1;
    if (referenceId) { conditions.push(`reference_id = $${idx++}`); params.push(referenceId); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Math.min(limit, 200), offset);
    const res = await query(`SELECT * FROM cdm_events ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`, params);
    return res.rows.map(r => this._rowToObject(r));
  }

  static async recordPushToCard(payment, result = {}) {
    const payload = this.toCdmPayment({
      referenceId: payment.payment_id,
      counterpartyId: payment.cardholder_name || payment.recipient_name || 'CARDHOLDER',
      amount: Number(payment.amount_cents) / 100,
      currency: payment.currency,
      cardholder: payment.cardholder_name,
      last4: payment.card_last4,
      network: payment.card_network,
      status: result.status || payment.status,
      intent: 'PUSH_TO_CARD_PAYMENT',
    });
    return this.createEvent({
      eventType: 'CashTransfer',
      intent: 'PUSH_TO_CARD_PAYMENT',
      partyId: 'DLB_TRUST',
      counterpartyId: payload.party[1].partyId[0].identifier.value,
      asset: `${payment.currency}/2`,
      amount: Number(payment.amount_cents) / 100,
      currency: payment.currency,
      referenceId: payment.payment_id,
      status: result.status || payment.status,
      payload,
    });
  }

  static async validateEvent(eventId) {
    const event = await this.getEvent(eventId);
    if (!event) throw new Error('Event not found');
    const payload = event.payload || {};
    const valid = !!(payload.meta && payload.eventIdentifier && payload.eventDate);
    await query(`UPDATE cdm_events SET status=$1 WHERE event_id=$2`, [valid ? 'VALID' : 'INVALID', eventId]);
    return { ...event, status: valid ? 'VALID' : 'INVALID', valid };
  }
}

module.exports = { FinosCdmEngine };
