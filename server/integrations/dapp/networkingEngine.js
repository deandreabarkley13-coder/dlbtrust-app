'use strict';

/**
 * NetworkingEngine
 *
 * Unified network and networking API for transmitting transactional financial
 * data across internal trust rails and external partner endpoints. Wraps
 * HostToHostEngine, ExternalEndpointEngine, and WebPaymentRailEngine so the
 * FinOps UI has a single "Network" panel to send, receive, track, and retry
 * transmissions.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

let HostToHostEngine, ExternalEndpointEngine, WebPaymentRailEngine, LiveMoneyMovementEngine;
function loadDeps() {
  try { ({ HostToHostEngine } = require('./hostToHostEngine')); } catch (e) { HostToHostEngine = null; }
  try { ({ ExternalEndpointEngine } = require('./externalEndpointEngine')); } catch (e) { ExternalEndpointEngine = null; }
  try { ({ WebPaymentRailEngine } = require('../payments/webPaymentRailEngine')); } catch (e) { WebPaymentRailEngine = null; }
  try { ({ LiveMoneyMovementEngine } = require('./liveMoneyMovementEngine')); } catch (e) { LiveMoneyMovementEngine = null; }
}

function id(prefix = 'NET') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }
function toCents(amount) { return Math.round((Number(amount) || 0) * 100); }
function safeJson(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v); }

async function query(sql, params) {
  if (!pool || !pool.query) throw new Error('Postgres pool unavailable');
  return pool.query(sql, params);
}

class NetworkingEngine {
  static async ensureTables() {
    if (!pool) return;
    await query(`
      CREATE TABLE IF NOT EXISTS network_transmissions (
        transmission_id TEXT PRIMARY KEY,
        network TEXT NOT NULL CHECK (network IN ('h2h','external_endpoint','web_payment','live_money','manual','internal')),
        endpoint_id TEXT,
        direction TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound','inbound')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','received','completed','failed','retrying','cancelled')),
        amount_cents BIGINT NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'USD',
        payload TEXT,
        reference_id TEXT,
        response JSONB,
        error_message TEXT,
        metadata JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_network_transmissions_status ON network_transmissions(status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_network_transmissions_endpoint ON network_transmissions(endpoint_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_network_transmissions_reference ON network_transmissions(reference_id)`);
  }

  static _rowToObject(row) {
    if (!row) return null;
    return { ...row, amount: (row.amount_cents || 0) / 100 };
  }

  static async listEndpoints({ enabled } = {}) {
    loadDeps();
    const out = [];
    if (HostToHostEngine) {
      const partners = await HostToHostEngine.listPartners({ enabled });
      out.push(...partners.map(p => ({ network: 'h2h', id: p.partner_id, name: p.name, protocol: p.protocol, enabled: p.enabled, messageType: p.message_type })));
    }
    if (ExternalEndpointEngine) {
      const endpoints = await ExternalEndpointEngine.listEndpoints({ enabled });
      out.push(...endpoints.map(e => ({ network: 'external_endpoint', id: e.endpoint_id, name: e.name, protocol: e.protocol || 'https', enabled: e.enabled })));
    }
    if (WebPaymentRailEngine) {
      const configs = await WebPaymentRailEngine.listConfigs();
      out.push(...configs.map(c => ({ network: 'web_payment', id: c.adapterName, name: c.adapterName, endpoint: c.endpoint, enabled: true })));
    }
    if (LiveMoneyMovementEngine) {
      const rails = await LiveMoneyMovementEngine.getAvailableRails().catch(() => []);
      if (rails) {
        out.push(...rails.map(r => ({ network: 'live_money', id: r.id, name: r.name || r.id, enabled: r.ready })));
      }
    }
    return out;
  }

  static async getInfo() {
    loadDeps();
    return {
      networks: ['h2h', 'external_endpoint', 'web_payment', 'live_money', 'manual', 'internal'],
      h2hReady: !!HostToHostEngine,
      externalEndpointReady: !!ExternalEndpointEngine,
      webPaymentReady: !!WebPaymentRailEngine,
      liveMoneyReady: !!LiveMoneyMovementEngine,
    };
  }

  static async transmit({ network, endpointId, amount = 0, currency = 'USD', payload = '', referenceId, sourceType, sourceAccountId, creditor = {}, metadata = {} } = {}) {
    loadDeps();
    await this.ensureTables();
    if (!network) throw new Error('network is required');
    if (!endpointId) throw new Error('endpointId is required');
    const transmissionId = id();
    const amountCents = toCents(amount);
    await query(`
      INSERT INTO network_transmissions (transmission_id, network, endpoint_id, direction, status, amount_cents, currency, payload, reference_id, metadata)
      VALUES ($1,$2,$3,'outbound','pending',$4,$5,$6,$7,$8::jsonb)
    `, [transmissionId, network, endpointId, amountCents, currency, payload, referenceId || null, safeJson(metadata)]);

    let result = null;
    try {
      if (network === 'h2h' && HostToHostEngine) {
        result = await HostToHostEngine.sendPayment({
          partnerId: endpointId,
          content: payload,
          messageType: metadata.messageType || 'network',
          amount,
          currency,
          settlementId: referenceId,
          creditor,
        });
      } else if (network === 'external_endpoint' && ExternalEndpointEngine) {
        result = await ExternalEndpointEngine.executePayment({
          endpointId,
          sourceType: sourceType || 'manual',
          sourceAccountId,
          amount,
          currency,
          description: payload,
          paymentType: 'network',
          creditorName: creditor.name,
          creditorAccount: creditor.account,
          creditorRouting: creditor.routing,
          creditorBank: creditor.bank,
        });
      } else if (network === 'web_payment' && WebPaymentRailEngine) {
        const payment = await WebPaymentRailEngine.createPayment({
          adapterName: endpointId,
          amount,
          currency,
          sourceType: sourceType || 'cash',
          sourceAccountId,
          description: payload,
          recipientName: creditor.name,
          recipientAccount: creditor.account,
          recipientBank: creditor.bank,
          recipientRouting: creditor.routing,
        });
        result = await WebPaymentRailEngine.sendPayment(payment.payment_id);
      } else if (network === 'live_money' && LiveMoneyMovementEngine) {
        const movement = await LiveMoneyMovementEngine.initiateMovement({
          rail: endpointId,
          amount,
          currency,
          sourceType: sourceType || 'manual',
          sourceAccountId,
          beneficiary: creditor,
          description: payload,
        });
        result = await LiveMoneyMovementEngine.executeMovement(movement.movement_id || movement.id);
      } else if (network === 'manual' || network === 'internal') {
        result = { status: 'pending', note: 'Transmission held for manual/internal processing', transmissionId };
      } else {
        throw new Error(`Unsupported network: ${network}`);
      }

      await query(`UPDATE network_transmissions SET status='sent', response=$1::jsonb, updated_at=NOW() WHERE transmission_id=$2`, [safeJson(result), transmissionId]);
      return { transmissionId, network, endpointId, status: 'sent', result };
    } catch (err) {
      await query(`UPDATE network_transmissions SET status='failed', error_message=$1, updated_at=NOW() WHERE transmission_id=$2`, [err.message, transmissionId]);
      throw err;
    }
  }

  static async receiveInbound({ network, endpointId, payload = '', referenceId, amount = 0, currency = 'USD', metadata = {} } = {}) {
    loadDeps();
    await this.ensureTables();
    const transmissionId = id();
    await query(`
      INSERT INTO network_transmissions (transmission_id, network, endpoint_id, direction, status, amount_cents, currency, payload, reference_id, metadata)
      VALUES ($1,$2,$3,'inbound','received',$4,$5,$6,$7,$8::jsonb)
    `, [transmissionId, network || 'manual', endpointId || '', toCents(amount), currency, payload, referenceId || null, safeJson(metadata)]);
    return { transmissionId, network, endpointId, direction: 'inbound', status: 'received' };
  }

  static async getTransmission(transmissionId) {
    loadDeps();
    await this.ensureTables();
    const res = await query('SELECT * FROM network_transmissions WHERE transmission_id = $1', [transmissionId]);
    return this._rowToObject(res.rows[0]);
  }

  static async listTransmissions({ status, network, limit = 50, offset = 0 } = {}) {
    loadDeps();
    await this.ensureTables();
    const conditions = []; const params = []; let idx = 1;
    if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
    if (network) { conditions.push(`network = $${idx++}`); params.push(network); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Math.min(limit, 200), offset);
    const res = await query(`SELECT * FROM network_transmissions ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`, params);
    return res.rows.map(r => this._rowToObject(r));
  }

  static async retryTransmission(transmissionId) {
    loadDeps();
    await this.ensureTables();
    const tx = await this.getTransmission(transmissionId);
    if (!tx) throw new Error('Transmission not found');
    if (tx.direction !== 'outbound') throw new Error('Only outbound transmissions can be retried');
    if (!['pending', 'failed'].includes(tx.status)) throw new Error(`Transmission cannot be retried from status ${tx.status}`);
    await query(`UPDATE network_transmissions SET status='retrying', updated_at=NOW() WHERE transmission_id=$1`, [transmissionId]);
    try {
      return await this.transmit({
        network: tx.network,
        endpointId: tx.endpoint_id,
        amount: tx.amount,
        currency: tx.currency,
        payload: tx.payload,
        referenceId: tx.reference_id,
        metadata: { ...(tx.metadata || {}), retryOf: transmissionId },
      });
    } catch (err) {
      await query(`UPDATE network_transmissions SET status='failed', error_message=$1, updated_at=NOW() WHERE transmission_id=$2`, [err.message, transmissionId]);
      throw err;
    }
  }

  static async cancelTransmission(transmissionId) {
    loadDeps();
    await this.ensureTables();
    const tx = await this.getTransmission(transmissionId);
    if (!tx) throw new Error('Transmission not found');
    if (!['pending', 'failed', 'retrying'].includes(tx.status)) throw new Error('Transmission cannot be cancelled');
    await query(`UPDATE network_transmissions SET status='cancelled', updated_at=NOW() WHERE transmission_id=$1`, [transmissionId]);
    return this.getTransmission(transmissionId);
  }
}

module.exports = { NetworkingEngine };
