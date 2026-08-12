'use strict';

/**
 * Clearing API Engine
 *
 * Generic clearing adapter that submits settlement instructions to external
 * clearing rails and receives inbound settlement/credit callbacks.  Rails:
 *   - stripe_treasury / stripe_ach / stripe_wire  -> Stripe Treasury OutboundPayments
 *   - ach / wire / iso20022 / open_banking          -> SettlementEngine queue
 *   - generic                                       -> Configured HTTPS endpoint
 *   - manual                                        -> Operator-held instruction
 *
 * All submissions are persisted in clearing_settlements for reconciliation.
 */

const pg = require('../bonds/pgPool');
const https = require('https');
const http = require('http');
const { URL } = require('url');

function id(prefix = 'CLR') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

function safeJson(obj) {
  try { return JSON.stringify(obj || {}, (k, v) => typeof v === 'bigint' ? String(v) : v); } catch { return '{}'; }
}

let StripeTreasuryEngine;
let SettlementEngine;
function loadDeps() {
  try { ({ StripeTreasuryEngine } = require('./stripeTreasuryEngine')); } catch {}
  try { SettlementEngine = require('../dapp/settlementEngine').SettlementEngine; } catch {}
}

class ClearingApiEngine {
  static async ensureTables() {
    if (!pg || !pg.query) return;
    await pg.query(`
      CREATE TABLE IF NOT EXISTS clearing_settlements (
        id SERIAL PRIMARY KEY,
        clearing_id TEXT UNIQUE NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
        rail TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','posted','completed','failed','returned','manual_pending','manual')),
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
    await pg.query(`CREATE INDEX IF NOT EXISTS idx_clearing_status ON clearing_settlements(status)`);
    await pg.query(`CREATE INDEX IF NOT EXISTS idx_clearing_external ON clearing_settlements(external_reference)`);
  }

  static async submit({
    direction = 'outbound',
    rail,
    amount,
    currency = 'USD',
    sourceAccountId,
    destination = {},
    reference,
    metadata = {},
    initiatedBy,
    ...railOptions
  } = {}) {
    loadDeps();
    if (!rail) throw new Error('rail required');
    const amountCents = toCents(amount);
    if (!amountCents || amountCents <= 0) throw new Error('amount must be positive');

    const clearingId = id('CLR');
    const base = {
      clearing_id: clearingId,
      direction,
      rail,
      status: 'pending',
      amount_cents: amountCents,
      currency,
      source_account_id: sourceAccountId || null,
      destination: safeJson(destination),
      external_reference: reference || null,
      raw_request: safeJson({ rail, amount, currency, sourceAccountId, destination, reference, metadata, railOptions, initiatedBy }),
      raw_response: '{}',
      metadata: safeJson(metadata || {}),
      initiated_by: initiatedBy || 'system',
    };

    if (pg && pg.query) {
      const cols = Object.keys(base).join(',');
      const vals = Object.keys(base).map((_, i) => `$${i + 1}`).join(',');
      await pg.query(`INSERT INTO clearing_settlements (${cols}) VALUES (${vals})`, Object.values(base));
    }

    let result = { status: 'pending' };
    const railNorm = String(rail).toLowerCase();

    try {
      if (railNorm === 'stripe_treasury' || railNorm.startsWith('stripe_')) {
        if (!StripeTreasuryEngine || !StripeTreasuryEngine.isConfigured()) throw new Error('StripeTreasuryEngine not configured');
        const network = railNorm === 'stripe_wire' ? 'us_domestic_wire' : 'ach';
        result = await StripeTreasuryEngine.createPayment({
          amount,
          financialAccountId: destination.financialAccountId || railOptions.financialAccountId || process.env.STRIPE_TREASURY_FINANCIAL_ACCOUNT_ID,
          routingNumber: destination.routingNumber || destination.routing || railOptions.routingNumber || railOptions.routing,
          accountNumber: destination.accountNumber || destination.account || railOptions.accountNumber || railOptions.account,
          accountHolderName: destination.accountHolderName || destination.recipientName || destination.fullName || railOptions.accountHolderName || railOptions.recipientName || railOptions.fullName,
          accountHolderType: destination.accountHolderType || railOptions.accountHolderType || 'individual',
          accountType: destination.accountType || railOptions.accountType || 'checking',
          network,
          description: railOptions.description || `Clearing ${clearingId}`,
          statementDescriptor: railOptions.statementDescriptor || 'PTC SETTLEMENT',
          billingAddress: destination.billingAddress || destination.address || railOptions.billingAddress || railOptions.address,
          metadata: { ...metadata, clearing_id: clearingId, initiatedBy },
        });
      } else if (railNorm === 'ach' || railNorm === 'wire' || railNorm === 'iso20022' || railNorm === 'open_banking') {
        result = await this._submitSettlementEngine({
          rail: railNorm, amount, currency, destination, reference, sourceAccountId, initiatedBy, ...railOptions,
        });
      } else if (railNorm === 'generic') {
        result = await this._submitGeneric({ amount, currency, destination, reference, ...railOptions });
      } else if (railNorm === 'manual') {
        result = { status: 'manual_pending', instruction: `Manually send ${(amountCents / 100).toFixed(2)} ${currency} to the destination specified.` };
      } else {
        throw new Error(`Unsupported rail: ${rail}`);
      }
    } catch (err) {
      result = { status: 'failed', error: err.message };
    }

    const status = result.status === 'posted' ? 'completed' : (result.status === 'failed' ? 'failed' : (result.status === 'manual_pending' ? 'manual_pending' : 'pending'));
    const externalRef = result.stripe_outbound_payment_id || result.settlement_id || result.external_id || result.reference || reference || null;

    if (pg && pg.query) {
      await pg.query(
        `UPDATE clearing_settlements SET status=$1, external_reference=$2, raw_response=$3::jsonb, updated_at=NOW() WHERE clearing_id=$4`,
        [status, externalRef, safeJson(result), clearingId]
      );
    }

    return { clearingId, status, externalReference: externalRef, amount: amountCents / 100, rail, result };
  }

  static async _submitSettlementEngine(opts = {}) {
    if (!SettlementEngine) throw new Error('SettlementEngine not available');
    const settlement = await SettlementEngine.createSettlement({
      rail: opts.rail,
      sourceAccountId: opts.sourceAccountId,
      amount: opts.amount,
      currency: opts.currency,
      creditorName: opts.destination.accountHolderName || opts.destination.recipientName || opts.destination.fullName || 'Beneficiary',
      creditorAccount: opts.destination.accountNumber || opts.destination.account,
      creditorRouting: opts.destination.routingNumber || opts.destination.routing,
      creditorBank: opts.destination.bankName || opts.destination.bank,
      debtorName: opts.debtorName || 'PTC',
      description: opts.description || `Clearing ${opts.reference}`,
      config: opts.railOptions || {},
    });
    if (!settlement || !settlement.settlement_id) throw new Error('SettlementEngine did not return settlement_id');
    const executed = await SettlementEngine.executeSettlement(settlement.settlement_id).catch(() => ({}));
    return {
      status: executed.status || settlement.status || 'pending',
      settlement_id: settlement.settlement_id,
      external_id: executed.external_id || settlement.settlement_id,
      reference: settlement.settlement_id,
      ...executed,
    };
  }

  static async _submitGeneric({ amount, currency, destination, reference, ...railOptions } = {}) {
    const endpoint = process.env.CLEARING_API_ENDPOINT;
    if (!endpoint) throw new Error('CLEARING_API_ENDPOINT not configured for generic rail');
    const apiKey = process.env.CLEARING_API_KEY;
    const body = JSON.stringify({
      amount,
      currency,
      destination,
      reference,
      ...railOptions,
    });
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint);
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request({
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
        },
        timeout: 30000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ status: json.status || 'pending', external_id: json.id || json.reference, reference, response: json });
            } else {
              resolve({ status: 'failed', error: json.error || data, statusCode: res.statusCode });
            }
          } catch {
            resolve({ status: res.statusCode === 200 ? 'pending' : 'failed', raw: data, statusCode: res.statusCode });
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Clearing API request timeout')); });
      req.write(body);
      req.end();
    });
  }

  static async getStatus(clearingId) {
    if (!pg || !pg.query) return null;
    const res = await pg.query('SELECT * FROM clearing_settlements WHERE clearing_id=$1', [clearingId]);
    const row = res.rows[0];
    if (!row) return null;

    const railNorm = String(row.rail).toLowerCase();
    if ((railNorm.startsWith('stripe_') || railNorm === 'stripe_treasury') && StripeTreasuryEngine) {
      try {
        const raw = (typeof row.raw_response === 'string' ? JSON.parse(row.raw_response) : row.raw_response) || {};
        const internalPayoutId = raw.payout_id || row.external_reference;
        if (!internalPayoutId) throw new Error('No internal payout id to poll');
        const fresh = await StripeTreasuryEngine.getStatus(internalPayoutId);
        if (fresh) {
          const status = fresh.status === 'completed' ? 'completed' : (fresh.status === 'failed' ? 'failed' : (fresh.status === 'posted' ? 'completed' : 'pending'));
          await pg.query(`UPDATE clearing_settlements SET status=$1, raw_response=$2::jsonb, updated_at=NOW() WHERE clearing_id=$3`, [status, safeJson(fresh), clearingId]);
          row.status = status;
          row.raw_response = fresh;
        }
      } catch (e) { console.warn('[ClearingApiEngine] getStatus stripe failed:', e.message); }
    }
    return row;
  }

  static async list({ direction, status, rail, limit = 50 } = {}) {
    if (!pg || !pg.query) return [];
    const conditions = [];
    const params = [];
    if (direction) { conditions.push(`direction=$${params.length + 1}`); params.push(direction); }
    if (status) { conditions.push(`status=$${params.length + 1}`); params.push(status); }
    if (rail) { conditions.push(`rail=$${params.length + 1}`); params.push(rail); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const res = await pg.query(`SELECT * FROM clearing_settlements ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return res.rows;
  }

  static async reconcileFromWebhook({ clearingId, externalReference, status, rawResponse } = {}) {
    if (!pg || !pg.query) throw new Error('Database unavailable');
    let row;
    if (clearingId) {
      const res = await pg.query('SELECT * FROM clearing_settlements WHERE clearing_id=$1', [clearingId]);
      row = res.rows[0];
    } else if (externalReference) {
      const res = await pg.query('SELECT * FROM clearing_settlements WHERE external_reference=$1 ORDER BY created_at DESC LIMIT 1', [externalReference]);
      row = res.rows[0];
    }
    if (!row) return null;
    const newStatus = status === 'posted' ? 'completed' : (['failed','returned'].includes(status) ? status : (status || row.status));
    await pg.query(
      `UPDATE clearing_settlements SET status=$1, raw_response=$2::jsonb, updated_at=NOW() WHERE clearing_id=$3`,
      [newStatus, safeJson(rawResponse), row.clearing_id]
    );
    return { clearingId: row.clearing_id, status: newStatus, row };
  }
}

module.exports = { ClearingApiEngine };
