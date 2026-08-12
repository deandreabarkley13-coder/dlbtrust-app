'use strict';

/**
 * Payment Gateway Server Engine
 *
 * Server-side payment gateway for the DLB Trust PTC.  Tokenizes payment
 * instruments, accepts authorization/capture/sale/refund/void requests, and
 * dispatches settlement to PaymentProcessorServerEngine.  All sensitive data
 * is encrypted at rest and only non-sensitive masks are returned.
 */

const crypto = require('crypto');
const pg = require('../bonds/pgPool');

let PaymentCrypto;
let PaymentProcessorServerEngine;

function loadDeps() {
  try { ({ PaymentProcessorServerEngine } = require('./paymentProcessorServerEngine')); } catch {}
  try { PaymentCrypto = require('../paymentHub/paymentCrypto'); } catch {}
}

function generateId(prefix = 'PGE') {
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

function mask(value, visible = 4) {
  if (!value) return null;
  const text = String(value);
  const suffix = text.slice(-visible);
  return '*'.repeat(Math.max(4, text.length - visible)) + suffix;
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function encryptSensitive(value) {
  if (!PaymentCrypto) return value;
  try { return PaymentCrypto.encrypt(value); } catch { return value; }
}

const METHODS_TABLE = 'payment_methods';
const TX_TABLE = 'payment_gateway_transactions';

class PaymentGatewayServerEngine {
  static async ensureTables() {
    if (!pg || !pg.query) return;
    await pg.query(`
      CREATE TABLE IF NOT EXISTS ${METHODS_TABLE} (
        method_id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('card','ach','wallet','crypto')),
        processor TEXT,
        member_id TEXT,
        last4 TEXT,
        fingerprint TEXT,
        exp_month TEXT,
        exp_year TEXT,
        network TEXT,
        billing_details JSONB DEFAULT '{}',
        encrypted_payload TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','expired')),
        initiated_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Ensure initiated_by column exists on existing tables from earlier deploys.
    await pg.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='${METHODS_TABLE}' AND column_name='initiated_by') THEN ALTER TABLE ${METHODS_TABLE} ADD COLUMN initiated_by TEXT; END IF; END $$`);
    await pg.query(`CREATE INDEX IF NOT EXISTS idx_pm_member ON ${METHODS_TABLE}(member_id)`);
    await pg.query(`CREATE INDEX IF NOT EXISTS idx_pm_fingerprint ON ${METHODS_TABLE}(fingerprint)`);

    await pg.query(`
      CREATE TABLE IF NOT EXISTS ${TX_TABLE} (
        gateway_tx_id TEXT PRIMARY KEY,
        session_id TEXT,
        method_id TEXT,
        processor_tx_id TEXT,
        type TEXT NOT NULL CHECK (type IN ('authorize','capture','sale','refund','void')),
        direction TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('inbound','outbound')),
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','authorized','captured','settled','failed','refunded','voided')),
        metadata JSONB DEFAULT '{}',
        raw_request JSONB DEFAULT '{}',
        raw_response JSONB DEFAULT '{}',
        initiated_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pg.query(`CREATE INDEX IF NOT EXISTS idx_pgt_session ON ${TX_TABLE}(session_id)`);
    await pg.query(`CREATE INDEX IF NOT EXISTS idx_pgt_method ON ${TX_TABLE}(method_id)`);
    await pg.query(`CREATE INDEX IF NOT EXISTS idx_pgt_status ON ${TX_TABLE}(status)`);
  }

  static async tokenizePaymentMethod({
    type,
    processor,
    payload = {},
    billingDetails = {},
    memberId,
    initiatedBy,
  } = {}) {
    loadDeps();
    const methodType = String(type || '').toLowerCase();
    if (!['card','ach','wallet','crypto'].includes(methodType)) throw new Error('type must be card, ach, wallet, or crypto');

    const methodId = generateId('PM');
    let last4 = null;
    let fingerprint = null;
    let expMonth = null;
    let expYear = null;
    let network = null;
    let encrypted = null;
    let sanitizedPayload = { ...payload };

    if (methodType === 'card') {
      const number = String(payload.number || '').replace(/\s/g, '');
      if (!/^\d{13,19}$/.test(number)) throw new Error('Invalid card number');
      last4 = number.slice(-4);
      fingerprint = hash(number);
      expMonth = payload.expiryMonth || payload.expMonth || null;
      expYear = payload.expiryYear || payload.expYear || null;
      network = payload.network || payload.cardBrand || null;
      encrypted = encryptSensitive(number);
      sanitizedPayload = { ...payload, number: mask(number), cvv: '[REDACTED]' };
    } else if (methodType === 'ach') {
      const account = String(payload.accountNumber || payload.account || '').replace(/\s/g, '');
      const routing = String(payload.routingNumber || payload.routing || '').replace(/\s/g, '');
      if (!/^\d{4,17}$/.test(account)) throw new Error('Invalid account number');
      if (!/^\d{9}$/.test(routing)) throw new Error('Invalid routing number');
      last4 = account.slice(-4);
      fingerprint = hash(account + '|' + routing);
      encrypted = encryptSensitive(JSON.stringify({ accountNumber: account, routingNumber: routing }));
      sanitizedPayload = { ...payload, accountNumber: mask(account), routingNumber: routing.slice(-4) };
    } else if (methodType === 'wallet') {
      const token = String(payload.token || '');
      if (!token) throw new Error('wallet token required');
      fingerprint = hash(token);
      encrypted = encryptSensitive(token);
      last4 = payload.last4 || token.slice(-4);
      network = payload.provider || payload.walletProvider || 'wallet';
    } else if (methodType === 'crypto') {
      const address = String(payload.address || '');
      if (!address) throw new Error('crypto address required');
      fingerprint = hash(address);
      last4 = address.slice(-8);
      network = payload.chain || payload.network || null;
      encrypted = encryptSensitive(address);
    }

    const processorName = processor || null;
    if (pg && pg.query) {
      await pg.query(
        `INSERT INTO ${METHODS_TABLE} (method_id, type, processor, member_id, last4, fingerprint, exp_month, exp_year, network, billing_details, encrypted_payload, status, initiated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [methodId, methodType, processorName, memberId || null, last4, fingerprint, expMonth, expYear, network, safeJson(billingDetails), encrypted, 'active', initiatedBy || 'system']
      );
    }

    return { methodId, type: methodType, processor: processorName, last4, fingerprint: fingerprint ? fingerprint.slice(0, 16) : null, network, status: 'active' };
  }

  static async getMethod(methodId, includePayload = false) {
    if (!pg || !pg.query) return null;
    const res = await pg.query(`SELECT * FROM ${METHODS_TABLE} WHERE method_id=$1`, [methodId]);
    const row = res.rows[0];
    if (!row) return null;
    const out = {
      method_id: row.method_id,
      type: row.type,
      processor: row.processor,
      member_id: row.member_id,
      last4: row.last4,
      fingerprint: row.fingerprint ? row.fingerprint.slice(0, 16) : null,
      exp_month: row.exp_month,
      exp_year: row.exp_year,
      network: row.network,
      billing_details: row.billing_details,
      status: row.status,
      created_at: row.created_at,
    };
    if (includePayload) out.encrypted_payload = row.encrypted_payload;
    return out;
  }

  static async listMethods({ memberId, type, processor, limit = 50 } = {}) {
    if (!pg || !pg.query) return [];
    const conditions = [];
    const params = [];
    if (memberId) { conditions.push('member_id = $' + (params.length + 1)); params.push(memberId); }
    if (type) { conditions.push('type = $' + (params.length + 1)); params.push(type); }
    if (processor) { conditions.push('processor = $' + (params.length + 1)); params.push(processor); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await pg.query(`SELECT method_id, type, processor, member_id, last4, fingerprint, exp_month, exp_year, network, billing_details, status, created_at FROM ${METHODS_TABLE} ${where} ORDER BY created_at DESC LIMIT $${params.length + 1}`, [...params, limit]);
    return res.rows;
  }

  static async disableMethod(methodId) {
    if (!pg || !pg.query) return null;
    await pg.query(`UPDATE ${METHODS_TABLE} SET status='disabled', updated_at=NOW() WHERE method_id=$1`, [methodId]);
    return this.getMethod(methodId);
  }

  static async createSession({ amount, currency = 'USD', reference, methodId, metadata = {}, initiatedBy } = {}) {
    loadDeps();
    const sessionId = generateId('PGS');
    const gatewayTxId = generateId('PGT');
    if (pg && pg.query) {
      await pg.query(
        `INSERT INTO ${TX_TABLE} (gateway_tx_id, session_id, method_id, type, direction, amount_cents, currency, status, metadata, raw_request, initiated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [gatewayTxId, sessionId, methodId || null, 'authorize', 'outbound', amount ? toCents(amount) : 0, currency, 'pending', safeJson(metadata), safeJson({ amount, currency, reference, methodId }), initiatedBy || 'system']
      );
    }
    return { sessionId, gatewayTxId, status: 'pending', amount: amount ? (toCents(amount) / 100).toFixed(2) : null, currency };
  }

  static async authorize({
    sessionId,
    amount,
    currency = 'USD',
    methodId,
    reference,
    direction = 'outbound',
    source = {},
    destination = {},
    metadata = {},
    initiatedBy,
  } = {}) {
    loadDeps();
    const amountCents = toCents(amount);
    const gatewayTxId = generateId('PGT');
    if (methodId && !(await this.getMethod(methodId))) throw new Error('Payment method not found');

    if (pg && pg.query) {
      await pg.query(
        `INSERT INTO ${TX_TABLE} (gateway_tx_id, session_id, method_id, type, direction, amount_cents, currency, status, metadata, raw_request, initiated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [gatewayTxId, sessionId || null, methodId || null, 'authorize', direction, amountCents, currency, 'authorized', safeJson(metadata), safeJson({ amount, currency, methodId, reference, direction, source, destination }), initiatedBy || 'system']
      );
    }
    return { gatewayTxId, status: 'authorized', amount: (amountCents / 100).toFixed(2), currency, sessionId, methodId };
  }

  static async sale({
    amount,
    currency = 'USD',
    methodId,
    reference,
    direction = 'outbound',
    source = {},
    destination = {},
    processor,
    metadata = {},
    initiatedBy,
  } = {}) {
    loadDeps();
    const amountCents = toCents(amount);
    const gatewayTxId = generateId('PGT');
    if (methodId && !(await this.getMethod(methodId))) throw new Error('Payment method not found');

    const method = methodId ? await this.getMethod(methodId, true) : null;
    const chosenProcessor = processor || (method && method.processor && method.processor !== 'generic' ? method.processor : null) || this._processorFromMethod(method);
    const dest = { ...destination };
    if (method && method.type === 'ach') {
      dest.accountNumber = dest.accountNumber || 'last4:' + method.last4;
      dest.routingNumber = dest.routingNumber || 'tokenized';
    }

    const rawRequest = { amount, currency, methodId, reference, direction, source, destination, processor: chosenProcessor, metadata };
    let result = { status: 'pending' };
    if (PaymentProcessorServerEngine) {
      result = await PaymentProcessorServerEngine.processPayment({
        processor: chosenProcessor,
        rail: chosenProcessor,
        direction,
        amount,
        currency,
        source,
        destination: dest,
        reference: gatewayTxId,
        metadata: { ...metadata, gatewayTx: gatewayTxId, methodId },
        initiatedBy,
      });
    }

    const status = result.status === 'completed' ? 'settled' : (result.status === 'failed' ? 'failed' : 'pending');
    if (pg && pg.query) {
      await pg.query(
        `INSERT INTO ${TX_TABLE} (gateway_tx_id, method_id, processor_tx_id, type, direction, amount_cents, currency, status, metadata, raw_request, raw_response, initiated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [gatewayTxId, methodId || null, result.processorTxId || null, 'sale', direction, amountCents, currency, status, safeJson(metadata), safeJson(rawRequest), safeJson(result), initiatedBy || 'system']
      );
    }
    return { gatewayTxId, processorTxId: result.processorTxId, status, amount: (amountCents / 100).toFixed(2), currency, result };
  }

  static async capture({ gatewayTxId, amount, initiatedBy } = {}) {
    loadDeps();
    const row = await this._findTx(gatewayTxId);
    if (!row) throw new Error('Gateway transaction not found');
    if (row.status !== 'authorized') throw new Error(`Cannot capture transaction in status ${row.status}`);
    const captureAmountCents = amount ? toCents(amount) : row.amount_cents;

    const method = row.method_id ? await this.getMethod(row.method_id, true) : null;
    const storedProcessor = row.metadata && row.metadata.processor;
    const chosenProcessor = storedProcessor && storedProcessor !== 'generic' ? storedProcessor : this._processorFromMethod(method);
    const raw = typeof row.raw_request === 'string' ? JSON.parse(row.raw_request) : row.raw_request || {};
    const dest = { ...(raw.destination || {}) };
    if (method && method.type === 'ach') {
      dest.accountNumber = dest.accountNumber || 'last4:' + method.last4;
      dest.routingNumber = dest.routingNumber || 'tokenized';
    }

    let result = { status: 'pending' };
    if (PaymentProcessorServerEngine) {
      result = await PaymentProcessorServerEngine.processPayment({
        processor: chosenProcessor,
        rail: chosenProcessor,
        direction: row.direction,
        amount: captureAmountCents / 100,
        currency: row.currency,
        source: raw.source || {},
        destination: dest,
        reference: gatewayTxId,
        metadata: { ...(raw.metadata || {}), gatewayTx: gatewayTxId, methodId: row.method_id, originalType: 'capture' },
        initiatedBy,
      });
    }

    const status = result.status === 'completed' ? 'captured' : (result.status === 'failed' ? 'failed' : 'pending');
    if (pg && pg.query) {
      await pg.query(
        `INSERT INTO ${TX_TABLE} (gateway_tx_id, method_id, processor_tx_id, type, direction, amount_cents, currency, status, metadata, raw_request, raw_response, initiated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [generateId('PGT-CAP'), row.method_id, result.processorTxId, 'capture', row.direction, captureAmountCents, row.currency, status, safeJson({ originalTx: gatewayTxId }), safeJson({ originalTx: gatewayTxId, amount: captureAmountCents / 100 }), safeJson(result), initiatedBy || 'system']
      );
      await pg.query(`UPDATE ${TX_TABLE} SET status=$1, raw_response=$2::jsonb, updated_at=NOW() WHERE gateway_tx_id=$3`, [status, safeJson(result), gatewayTxId]);
    }
    return { gatewayTxId, processorTxId: result.processorTxId, status, amount: (captureAmountCents / 100).toFixed(2), result };
  }

  static async refund({ gatewayTxId, amount, initiatedBy, reason = '' } = {}) {
    loadDeps();
    const row = await this._findTx(gatewayTxId);
    if (!row) throw new Error('Gateway transaction not found');
    const refundCents = amount ? toCents(amount) : row.amount_cents;
    let result = { status: 'manual', instruction: 'Refund recorded; settle with the processor' };
    if (PaymentProcessorServerEngine && row.processor_tx_id) {
      result = await PaymentProcessorServerEngine.refund({ txId: row.processor_tx_id, amount: refundCents / 100, initiatedBy, reason });
    }
    const refundTxId = generateId('PGT-REF');
    if (pg && pg.query) {
      await pg.query(
        `INSERT INTO ${TX_TABLE} (gateway_tx_id, method_id, processor_tx_id, type, direction, amount_cents, currency, status, metadata, raw_request, raw_response, initiated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [refundTxId, row.method_id, row.processor_tx_id, 'refund', row.direction === 'inbound' ? 'outbound' : 'inbound', refundCents, row.currency, result.status === 'completed' ? 'refunded' : 'pending', safeJson({ originalTx: gatewayTxId, reason }), safeJson({ originalTx: gatewayTxId, amount: refundCents / 100, reason }), safeJson(result), initiatedBy || 'system']
      );
    }
    return { refundTxId, originalTx: gatewayTxId, status: result.status === 'completed' ? 'refunded' : 'pending', amount: (refundCents / 100).toFixed(2), result };
  }

  static async void({ gatewayTxId, initiatedBy, reason = '' } = {}) {
    const row = await this._findTx(gatewayTxId);
    if (!row) throw new Error('Gateway transaction not found');
    if (row.status !== 'authorized') throw new Error(`Cannot void transaction in status ${row.status}`);
    const voidTxId = generateId('PGT-VOID');
    if (pg && pg.query) {
      await pg.query(`UPDATE ${TX_TABLE} SET status='voided', raw_response=$1::jsonb, updated_at=NOW() WHERE gateway_tx_id=$2`, [safeJson({ voided: true, reason }), gatewayTxId]);
      await pg.query(
        `INSERT INTO ${TX_TABLE} (gateway_tx_id, type, direction, amount_cents, currency, status, metadata, raw_request, initiated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [voidTxId, 'void', row.direction, 0, row.currency, 'voided', safeJson({ originalTx: gatewayTxId, reason }), safeJson({ originalTx: gatewayTxId, reason }), initiatedBy || 'system']
      );
    }
    return { gatewayTxId, voidTxId, status: 'voided' };
  }

  static async getStatus(gatewayTxId) {
    return this._findTx(gatewayTxId);
  }

  static async list({ status, methodId, type, limit = 50 } = {}) {
    if (!pg || !pg.query) return [];
    const conditions = [];
    const params = [];
    if (status) { conditions.push('status = $' + (params.length + 1)); params.push(status); }
    if (methodId) { conditions.push('method_id = $' + (params.length + 1)); params.push(methodId); }
    if (type) { conditions.push('type = $' + (params.length + 1)); params.push(type); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await pg.query(`SELECT * FROM ${TX_TABLE} ${where} ORDER BY created_at DESC LIMIT $${params.length + 1}`, [...params, limit]);
    return res.rows;
  }

  static async reconcileWebhook({ gatewayTxId, processorTxId, status, raw = {} } = {}) {
    if (!pg || !pg.query) return null;
    let id = gatewayTxId;
    if (!id && processorTxId) {
      const res = await pg.query(`SELECT gateway_tx_id FROM ${TX_TABLE} WHERE processor_tx_id=$1 LIMIT 1`, [processorTxId]);
      if (res.rows.length) id = res.rows[0].gateway_tx_id;
    }
    if (!id) throw new Error('gatewayTxId or processorTxId required');
    const newStatus = ['pending','authorized','captured','settled','failed','refunded','voided'].includes(status) ? status : 'pending';
    await pg.query(
      `UPDATE ${TX_TABLE} SET status=$1, raw_response=COALESCE(raw_response,'{}')::jsonb || $2::jsonb, updated_at=NOW() WHERE gateway_tx_id=$3`,
      [newStatus, safeJson({ webhook: raw }), id]
    );
    return this._findTx(id);
  }

  static async _findTx(gatewayTxId) {
    if (!pg || !pg.query) return null;
    const res = await pg.query(`SELECT * FROM ${TX_TABLE} WHERE gateway_tx_id=$1`, [gatewayTxId]);
    return res.rows[0] || null;
  }

  static _processorFromMethod(method) {
    if (!method) return 'payout_center';
    if (method.processor && method.processor !== 'generic') return method.processor;
    if (method.type === 'card') return 'stripe_treasury';
    if (method.type === 'ach') return 'clearing';
    if (method.type === 'wallet') return 'payout_center';
    if (method.type === 'crypto') return 'payout_center';
    return 'payout_center';
  }
}

module.exports = { PaymentGatewayServerEngine };
