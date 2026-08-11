'use strict';

/**
 * Wire Origination Engine — fiat payout origination API
 *
 * Queues and originates fiat payouts through bank wire, ACH, check, and
 * (optionally) crypto rails. Keeps funds in fiat (USD). For crypto-rail use the
 * payout is explicitly converted to a stablecoin only when the caller opts in.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

let pool;
let CashEngine;
let WireEngine;
let ACHEngine;
let SystemSettings;
let PayoutCenterEngine;
let { buildMtlsOptions } = { buildMtlsOptions: () => ({}) };

try { pool = require('../bonds/pgPool'); } catch (e) { /* optional */ }
try { ({ CashEngine } = require('../cash/cashEngine')); } catch (e) { /* optional */ }
try { ({ WireEngine } = require('../wire/wireEngine')); } catch (e) { /* optional */ }
try { ({ ACHEngine } = require('../ach/achEngine')); } catch (e) { /* optional */ }
try { ({ SystemSettings } = require('../ach/systemSettings')); } catch (e) { /* optional */ }
try { ({ PayoutCenterEngine } = require('./payoutCenterEngine')); } catch (e) { /* optional */ }
try { ({ buildMtlsOptions } = require('../ach/openBankApi')); } catch (e) { /* optional */ }

const HOLD_ACCOUNTS = {
  wire: 'WIRE_ORIG_HOLD',
  ach: 'ACH_ORIG_HOLD',
  check: 'CHECK_ORIG_HOLD',
};

const SETTLED_ACCOUNTS = {
  wire: 'WIRE_SETTLED',
  ach: 'ACH_SETTLED',
  check: 'CHECK_SETTLED',
};

function generateId(prefix = 'WOP') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

class WireOriginationEngine {
  static async ensureTables() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wire_origination_payouts (
        id SERIAL PRIMARY KEY,
        payout_id TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','needs_setup','originating','sent','confirmed','settled','failed','cancelled','manual_pending')),
        source_type TEXT NOT NULL DEFAULT 'cash',
        source_account_id TEXT,
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        beneficiary_name TEXT NOT NULL,
        beneficiary_routing TEXT,
        beneficiary_account TEXT,
        beneficiary_bank_name TEXT,
        beneficiary_address TEXT,
        beneficiary_crypto_address TEXT,
        payment_type TEXT NOT NULL DEFAULT 'vendor_payment',
        purpose TEXT,
        description TEXT,
        adapter TEXT NOT NULL DEFAULT 'wire',
        wire_id TEXT,
        ach_batch_id TEXT,
        hold_movement_id TEXT,
        error_message TEXT,
        retry_count INTEGER DEFAULT 0,
        initiated_by TEXT NOT NULL DEFAULT 'system',
        approved_by TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_wop_status ON wire_origination_payouts(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_wop_source ON wire_origination_payouts(source_account_id)`);
    await this.ensureHoldAccounts();
  }

  static async ensureHoldAccounts() {
    if (!CashEngine) return;
    const ids = Object.values(HOLD_ACCOUNTS).concat(Object.values(SETTLED_ACCOUNTS));
    for (const accountId of ids) {
      try {
        const existing = await CashEngine.getAccount(accountId);
        if (existing) continue;
        await CashEngine.createAccount({
          accountId,
          accountName: accountId.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, l => l.toUpperCase()),
          accountType: 'escrow',
          notes: 'Wire Origination Engine clearing account',
        });
      } catch (e) { /* may already exist or engine has different API */ }
    }
  }

  static async getSourceBalance(sourceType, sourceAccountId) {
    if (sourceType === 'cash') {
      if (!CashEngine) throw new Error('CashEngine not available');
      const acct = await CashEngine.getAccount(sourceAccountId);
      if (!acct) throw new Error(`Cash account not found: ${sourceAccountId}`);
      return Number(acct.balance_cents || 0);
    }
    // Add trust/fineract/banksync later
    throw new Error(`Unsupported source type: ${sourceType}`);
  }

  static async createPayout(opts) {
    await this.ensureTables();
    const {
      sourceType = 'cash', sourceAccountId,
      amount, beneficiaryName, beneficiaryRouting, beneficiaryAccount,
      beneficiaryBankName, beneficiaryAddress,
      paymentType = 'vendor_payment', purpose, description,
      adapter = 'wire', initiatedBy = 'system', metadata = {},
      requiresApproval = false,
    } = opts;

    const amountCents = toCents(amount);
    if (amountCents <= 0) throw new Error('amount must be positive');
    if (!beneficiaryName) throw new Error('beneficiaryName is required');
    if (adapter !== 'crypto' && !beneficiaryRouting) throw new Error('beneficiaryRouting is required for fiat rails');
    if (adapter !== 'crypto' && !beneficiaryAccount) throw new Error('beneficiaryAccount is required for fiat rails');

    const balance = await this.getSourceBalance(sourceType, sourceAccountId);
    if (balance < amountCents) throw new Error(`Insufficient balance in ${sourceAccountId}: ${balance} < ${amountCents}`);

    // Reserve funds in hold account
    const holdAccount = HOLD_ACCOUNTS[adapter] || 'WIRE_ORIG_HOLD';
    let holdMovement = null;
    if (CashEngine) {
      holdMovement = await CashEngine.transfer({
        fromAccountId: sourceAccountId,
        toAccountId: holdAccount,
        amountCents,
        movementType: 'transfer',
        memo: `Reserve for ${adapter} payout`,
        referenceId: 'pending',
        referenceType: 'wire_origination',
      });
    }

    const payoutId = generateId();
    let wireId = null;
    let achBatchId = null;

    if (['wire','manual'].includes(adapter) && WireEngine) {
      const wire = await WireEngine.initiateWire({
        amountCents,
        beneficiaryName,
        beneficiaryRouting,
        beneficiaryAccount,
        beneficiaryBankName,
        beneficiaryAddress,
        paymentType,
        purpose: purpose || description,
        description,
        initiatedBy,
        requiresApproval: false,
      });
      wireId = wire.wire_id;
    }

    if (adapter === 'ach' && ACHEngine) {
      const batch = await ACHEngine.createBatch({
        description: description || `${adapter} payout`,
        secCode: 'CCD',
        createdBy: initiatedBy,
      }, [{
        receivingRouting: beneficiaryRouting,
        accountNumber: beneficiaryAccount,
        amountCents,
        transactionCode: '22',
        individualId: payoutId,
        individualName: beneficiaryName,
      }]);
      achBatchId = batch.batch_id;
    }

    const result = await pool.query(
      `INSERT INTO wire_origination_payouts
        (payout_id, status, source_type, source_account_id, amount_cents, currency,
         beneficiary_name, beneficiary_routing, beneficiary_account, beneficiary_bank_name, beneficiary_address,
         payment_type, purpose, description, adapter, wire_id, ach_batch_id, hold_movement_id, initiated_by, approved_by, metadata)
       VALUES ($1,$2,$3,$4,$5,'USD',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [
        payoutId,
        requiresApproval ? 'pending' : 'approved',
        sourceType,
        sourceAccountId,
        amountCents,
        beneficiaryName,
        beneficiaryRouting || null,
        beneficiaryAccount || null,
        beneficiaryBankName || null,
        beneficiaryAddress || null,
        paymentType,
        purpose || description || null,
        description || null,
        adapter,
        wireId,
        achBatchId,
        holdMovement ? holdMovement.movement_id : null,
        initiatedBy,
        requiresApproval ? null : initiatedBy,
        JSON.stringify(metadata),
      ]
    );

    return result.rows[0];
  }

  static async approvePayout(payoutId, approvedBy) {
    await this.ensureTables();
    const result = await pool.query(
      `UPDATE wire_origination_payouts SET status = 'approved', approved_by = $2, updated_at = NOW()
       WHERE payout_id = $1 AND status = 'pending' RETURNING *`,
      [payoutId, approvedBy]
    );
    if (!result.rows.length) throw new Error('Payout not found or not pending approval');
    return result.rows[0];
  }

  static async cancelPayout(payoutId) {
    await this.ensureTables();
    const row = await this.getPayout(payoutId);
    if (!row) throw new Error('Payout not found');
    if (['sent','confirmed','settled','originating'].includes(row.status)) throw new Error('Cannot cancel payout in current status');

    if (row.hold_movement_id && CashEngine && row.source_account_id) {
      try {
        await CashEngine.transfer({
          fromAccountId: HOLD_ACCOUNTS[row.adapter] || 'WIRE_ORIG_HOLD',
          toAccountId: row.source_account_id,
          amountCents: Number(row.amount_cents),
          movementType: 'transfer',
          memo: `Refund cancelled payout ${payoutId}`,
          referenceId: payoutId,
          referenceType: 'wire_origination_cancel',
        });
      } catch (e) { console.warn('[WireOriginationEngine] refund failed:', e.message); }
    }

    await pool.query(`UPDATE wire_origination_payouts SET status = 'cancelled', updated_at = NOW() WHERE payout_id = $1`, [payoutId]);
    return this.getPayout(payoutId);
  }

  static async sendPayout(payoutId) {
    await this.ensureTables();
    const row = await this.getPayout(payoutId);
    if (!row) throw new Error('Payout not found');
    if (!['approved','needs_setup'].includes(row.status)) throw new Error(`Payout cannot be sent from status ${row.status}`);

    await pool.query(`UPDATE wire_origination_payouts SET status = 'originating', updated_at = NOW() WHERE payout_id = $1`, [payoutId]);

    try {
      if (row.adapter === 'wire') return await this._sendWire(row);
      if (row.adapter === 'ach') return await this._sendACH(row);
      if (row.adapter === 'check' || row.adapter === 'manual') return await this._sendManual(row);
      if (row.adapter === 'crypto') return await this._sendCrypto(row);
      throw new Error(`Unsupported adapter: ${row.adapter}`);
    } catch (err) {
      await pool.query(`UPDATE wire_origination_payouts SET status = 'failed', error_message = $2, updated_at = NOW() WHERE payout_id = $1`, [payoutId, err.message]);
      throw err;
    }
  }

  static _resolveApacheFallbackUrl() {
    if (process.env.APACHE_WIRE_PUSH_URL) return process.env.APACHE_WIRE_PUSH_URL;
    const pushUrl = process.env.APACHE_HTTP_PUSH_URL;
    if (!pushUrl) return null;
    try {
      const u = new URL(pushUrl);
      const segments = u.pathname.split('/').filter(Boolean);
      const last = segments[segments.length - 1] || '';
      if (last === 'push.php' || last.endsWith('.php')) {
        segments[segments.length - 1] = 'wire.php';
      } else {
        segments.push('wire.php');
      }
      u.pathname = '/' + segments.join('/');
      u.search = '';
      return u.toString();
    } catch (e) { return null; }
  }

  static async _sendWire(row) {
    if (!SystemSettings || !WireEngine) throw new Error('System settings / WireEngine not available');
    let wireEndpoint = await SystemSettings.getWireEndpoint();
    let bankAuth = await SystemSettings.getBankAuth();

    // Fallback to a self-hosted Apache HTTP wire endpoint when no bank API is configured
    let useApacheFallback = false;
    if (!wireEndpoint || !bankAuth.apiKey) {
      const apacheUrl = this._resolveApacheFallbackUrl();
      const apacheKey = process.env.APACHE_WIRE_API_KEY || process.env.APACHE_HTTP_API_KEY || '';
      if (apacheUrl) {
        wireEndpoint = apacheUrl;
        bankAuth = { authType: 'api_key', apiKey: apacheKey, apiSecret: '', useMtls: false };
        useApacheFallback = true;
      }
    }

    if (!wireEndpoint) {
      await pool.query(`UPDATE wire_origination_payouts SET status = 'needs_setup', updated_at = NOW() WHERE payout_id = $1`, [row.payout_id]);
      return this.getPayout(row.payout_id);
    }

    // Approve wire record if it exists
    if (row.wire_id) {
      try { await WireEngine.approveWire(row.wire_id, row.approved_by || 'wire-origination'); } catch (e) { /* may already be approved */ }
    }

    const imad = WireEngine.generateIMAD ? WireEngine.generateIMAD() : `IMAD-${Date.now()}`;
    const omad = WireEngine.generateOMAD ? WireEngine.generateOMAD() : `OMAD-${Date.now()}`;
    const fedRef = `FED-${Date.now()}`;
    const confirmationNumber = `CNF-${row.payout_id}-${Date.now().toString(36).toUpperCase()}`;

    const payload = JSON.stringify({
      wire_id: row.wire_id,
      type: 'fedwire',
      amount_cents: row.amount_cents,
      sender_routing: '091000019',
      sender_account: 'DLB-TRUST-MAIN',
      beneficiary_name: row.beneficiary_name,
      beneficiary_routing: row.beneficiary_routing,
      beneficiary_account: row.beneficiary_account,
      beneficiary_bank: row.beneficiary_bank_name,
      purpose: row.payment_type,
      description: row.description,
      imad,
      omad,
      fed_reference: fedRef,
      submitted_at: new Date().toISOString(),
    });

    const parsed = new URL(wireEndpoint);
    const lib = parsed.protocol === 'https:' ? https : http;
    const reqHeaders = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'X-Request-ID': `WIRE-${row.payout_id}-${Date.now()}`,
      'User-Agent': 'DLBTrust-Wire/1.0',
    };
    if (bankAuth.authType === 'bearer' && bankAuth.apiKey) reqHeaders.Authorization = 'Bearer ' + bankAuth.apiKey;
    else if (bankAuth.authType === 'basic' && bankAuth.apiKey) reqHeaders.Authorization = 'Basic ' + Buffer.from(bankAuth.apiKey + ':' + (bankAuth.apiSecret || '')).toString('base64');
    else if (bankAuth.authType === 'api_key' && bankAuth.apiKey) reqHeaders['X-API-Key'] = bankAuth.apiKey;

    const mtlsOptions = buildMtlsOptions ? buildMtlsOptions(bankAuth) : {};

    let responseBody = '';
    let statusCode = 0;
    try {
      statusCode = await new Promise((resolve, reject) => {
        const req = lib.request({
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname,
          method: 'POST',
          headers: reqHeaders,
          timeout: 60000,
          ...mtlsOptions,
        }, (res) => {
          res.on('data', chunk => { responseBody += chunk; });
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Wire endpoint timeout')); });
        req.write(payload);
        req.end();
      });
    } catch (err) {
      await pool.query(`UPDATE wire_origination_payouts SET status = 'failed', error_message = $2 WHERE payout_id = $1`, [row.payout_id, err.message]);
      return this.getPayout(row.payout_id);
    }

    if (statusCode < 200 || statusCode >= 300) {
      await pool.query(`UPDATE wire_origination_payouts SET status = 'failed', error_message = $2 WHERE payout_id = $1`, [row.payout_id, `Wire endpoint returned ${statusCode}: ${responseBody.slice(0, 200)}`]);
      return this.getPayout(row.payout_id);
    }

    let externalReference = confirmationNumber;
    try {
      const parsedBody = JSON.parse(responseBody);
      if (parsedBody.referenceNumber) externalReference = parsedBody.referenceNumber;
    } catch (e) {}

    // Update wire_transfers record (best effort)
    if (row.wire_id) {
      try {
        await pool.query(
          `UPDATE wire_transfers SET status = 'sent', imad = $2, omad = $3, fed_reference = $4, confirmation_number = $5, sent_at = NOW(), updated_at = NOW() WHERE wire_id = $1`,
          [row.wire_id, imad, omad, fedRef, externalReference]
        );
      } catch (e) { console.warn('[WireOriginationEngine] wire_transfers update failed:', e.message); }
    }

    if (useApacheFallback) {
      // Apache fallback only logs the payload; keep funds in hold until a real bank confirms settlement
      const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata || '{}') : (row.metadata || {});
      await pool.query(
        `UPDATE wire_origination_payouts SET status = 'sent', metadata = $2::jsonb, updated_at = NOW() WHERE payout_id = $1`,
        [row.payout_id, JSON.stringify({ ...meta, externalReference, responseBody: responseBody.slice(0, 500), settled_at: null })]
      );
      return this.getPayout(row.payout_id);
    }

    await this._markSettled(row, { externalReference, responseBody: responseBody.slice(0, 1000) });
    return this.getPayout(row.payout_id);
  }

  static async _sendACH(row) {
    if (!ACHEngine) throw new Error('ACHEngine not available');
    if (!row.ach_batch_id) throw new Error('No ACH batch for payout');

    // Check partner config readiness
    let ready = false;
    try {
      const { AS2Partners } = require('../ach/as2Partners');
      const partner = await AS2Partners.getDefaultPartnerConfig();
      if (partner) ready = true;
    } catch (e) { /* no partner */ }

    if (!ready && !process.env.ACH_SFTP_URL) {
      await pool.query(`UPDATE wire_origination_payouts SET status = 'needs_setup', error_message = 'No ACH partner or SFTP configured' WHERE payout_id = $1`, [row.payout_id]);
      return this.getPayout(row.payout_id);
    }

    try {
      await ACHEngine.transmitBatch(row.ach_batch_id);
    } catch (err) {
      await pool.query(`UPDATE wire_origination_payouts SET status = 'failed', error_message = $2 WHERE payout_id = $1`, [row.payout_id, err.message]);
      return this.getPayout(row.payout_id);
    }

    await this._markSettled(row);
    return this.getPayout(row.payout_id);
  }

  static async _sendManual(row) {
    await pool.query(`UPDATE wire_origination_payouts SET status = 'manual_pending', error_message = NULL WHERE payout_id = $1`, [row.payout_id]);
    return this.getPayout(row.payout_id);
  }

  static async _sendCrypto(row) {
    if (!PayoutCenterEngine) throw new Error('PayoutCenterEngine not available');
    const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
    if (!meta.cryptoAsset) throw new Error('cryptoAsset is required for crypto adapter');
    if (!meta.cryptoAddress) throw new Error('cryptoAddress is required for crypto adapter');

    const result = await PayoutCenterEngine.createPayment({
      paymentType: 'payout',
      sourceType: 'cash',
      sourceAccountId: HOLD_ACCOUNTS[row.adapter] || 'WIRE_ORIG_HOLD',
      recipientIdentifier: meta.cryptoAddress,
      amount: Number(row.amount_cents) / 100,
      asset: meta.cryptoAsset,
      rail: meta.cryptoRail || 'dex',
      description: row.description,
      railOptions: meta.railOptions || {},
    });

    await pool.query(
      `UPDATE wire_origination_payouts SET status = 'settled', metadata = metadata || $2::jsonb, updated_at = NOW() WHERE payout_id = $1`,
      [row.payout_id, JSON.stringify({ payoutCenterPaymentId: result.id, txHash: result.tx_hash })]
    );
    return this.getPayout(row.payout_id);
  }

  static async _markSettled(row, extra = {}) {
    if (CashEngine) {
      try {
        await CashEngine.transfer({
          fromAccountId: HOLD_ACCOUNTS[row.adapter] || 'WIRE_ORIG_HOLD',
          toAccountId: SETTLED_ACCOUNTS[row.adapter] || 'WIRE_SETTLED',
          amountCents: Number(row.amount_cents),
          movementType: 'transfer',
          memo: `Settled ${row.adapter} payout ${row.payout_id}`,
          referenceId: row.payout_id,
          referenceType: 'wire_origination_settled',
        });
      } catch (e) { console.warn('[WireOriginationEngine] settle transfer failed:', e.message); }
    }
    const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata || '{}') : (row.metadata || {});
    const merged = JSON.stringify({ ...meta, ...extra, settled_at: new Date().toISOString() });
    await pool.query(`UPDATE wire_origination_payouts SET status = 'settled', metadata = $2::jsonb, updated_at = NOW() WHERE payout_id = $1`, [row.payout_id, merged]);
  }

  static async getPayout(payoutId) {
    if (!pool) return null;
    const result = await pool.query('SELECT * FROM wire_origination_payouts WHERE payout_id = $1', [payoutId]);
    return result.rows[0] || null;
  }

  static async listPayouts({ limit = 50, status } = {}) {
    await this.ensureTables();
    let sql = 'SELECT * FROM wire_origination_payouts';
    const params = [];
    if (status) { sql += ' WHERE status = $1'; params.push(status); }
    sql += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
    params.push(limit);
    const result = await pool.query(sql, params);
    return result.rows;
  }

  static async getMessage(payoutId) {
    const row = await this.getPayout(payoutId);
    if (!row) throw new Error('Payout not found');
    if (['wire','manual'].includes(row.adapter) && WireEngine && row.wire_id) {
      const wire = await WireEngine.getWire(row.wire_id);
      if (!wire) throw new Error('Wire not found');
      return WireEngine.formatWireMessage(wire);
    }
    if (row.adapter === 'ach' && ACHEngine && row.ach_batch_id) {
      const batch = await ACHEngine.getBatch(row.ach_batch_id);
      return { type: 'ach_nacha', batchId: row.ach_batch_id, filename: batch.filename, content: batch.nacha_content };
    }
    return { type: 'manual', payoutId, instructions: 'Submit via your bank portal' };
  }

  static getAdapters() {
    return [
      { id: 'wire', name: 'Fedwire Bank API', ready: false, needs: ['wire_endpoint', 'wire_api_key'] },
      { id: 'ach', name: 'ACH NACHA / AS2', ready: false, needs: ['ach_partner_config or ACH_SFTP_URL'] },
      { id: 'check', name: 'Manual Check', ready: true, needs: [] },
      { id: 'manual', name: 'Manual Wire/ACH Message', ready: true, needs: [] },
      { id: 'crypto', name: 'Crypto Rail (stablecoin/SIT — opt-in)', ready: !!PayoutCenterEngine, needs: ['cryptoAddress', 'cryptoAsset'] },
    ];
  }

  static async readiness() {
    const adapters = this.getAdapters();
    if (SystemSettings) {
      const wireEndpoint = await SystemSettings.getWireEndpoint();
      const bankAuth = await SystemSettings.getBankAuth();
      const apacheUrl = this._resolveApacheFallbackUrl();
      adapters.find(a => a.id === 'wire').ready = !!(wireEndpoint && bankAuth.apiKey) || !!apacheUrl;

      let achReady = false;
      try {
        const { AS2Partners } = require('../ach/as2Partners');
        const partner = await AS2Partners.getDefaultPartnerConfig();
        if (partner) achReady = true;
      } catch (e) {}
      if (process.env.ACH_SFTP_URL) achReady = true;
      adapters.find(a => a.id === 'ach').ready = achReady;
    }
    return { mode: process.env.NODE_ENV || 'production', adapters };
  }
}

module.exports = { WireOriginationEngine };
