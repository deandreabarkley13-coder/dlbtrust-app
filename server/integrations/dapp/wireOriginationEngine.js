'use strict';

/**
 * Wire Origination Engine — fiat payout origination API
 *
 * Queues and originates fiat payouts through bank wire, ACH, check, and
 * (optionally) crypto rails. Keeps funds in fiat (USD). For crypto-rail use the
 * payout is explicitly converted to a stablecoin only when the caller opts in.
 */

let pool;
let CashEngine;
let WireEngine;
let ACHEngine;
let SystemSettings;
let PayoutCenterEngine;

try { pool = require('../bonds/pgPool'); } catch (e) { /* optional */ }
try { ({ CashEngine } = require('../cash/cashEngine')); } catch (e) { /* optional */ }
try { ({ WireEngine } = require('../wire/wireEngine')); } catch (e) { /* optional */ }
try { ({ ACHEngine } = require('../ach/achEngine')); } catch (e) { /* optional */ }
try { ({ SystemSettings } = require('../ach/systemSettings')); } catch (e) { /* optional */ }
try { ({ PayoutCenterEngine } = require('./payoutCenterEngine')); } catch (e) { /* optional */ }

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

  static async _sendWire(row) {
    if (!WireEngine) throw new Error('WireEngine not available');
    if (!row.wire_id) throw new Error('No canonical wire record for payout');

    let wire = await WireEngine.getWire(row.wire_id);
    if (!wire) throw new Error(`Wire not found: ${row.wire_id}`);
    if (wire.status === 'pending_approval') {
      if (!row.approved_by) throw new Error('Independent payout approval is required');
      wire = await WireEngine.approveWire(row.wire_id, row.approved_by);
    }
    if (wire.status !== 'approved') {
      throw new Error(`Wire cannot be transmitted from status ${wire.status}`);
    }

    const sentWire = await WireEngine.sendWire(row.wire_id);
    const meta = typeof row.metadata === 'string'
      ? JSON.parse(row.metadata || '{}')
      : (row.metadata || {});
    const wireMetadata = typeof sentWire.metadata === 'string'
      ? JSON.parse(sentWire.metadata || '{}')
      : (sentWire.metadata || {});
    const transmissionMetadata = {
      ...meta,
      externalProviderReference: wireMetadata.externalProviderReference || null,
      transmittedAt: sentWire.sent_at || new Date().toISOString(),
      settled_at: null,
    };
    try {
      await pool.query(
        `UPDATE wire_origination_payouts
         SET status = 'sent', error_message = NULL, metadata = $2::jsonb, updated_at = NOW()
         WHERE payout_id = $1`,
        [row.payout_id, JSON.stringify(transmissionMetadata)]
      );
      return this.getPayout(row.payout_id);
    } catch (err) {
      console.warn(
        `[WireOriginationEngine] Payout projection update failed for sent wire ${row.wire_id}:`,
        err.message
      );
      return {
        ...row,
        status: 'originating',
        metadata: {
          ...transmissionMetadata,
          projectionReconciliationRequired: true,
          projectionError: err.message,
        },
      };
    }
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

  static async syncWireConfirmation(wire, evidence = {}) {
    if (!wire?.wire_id) return null;
    await this.ensureTables();
    const result = await pool.query(
      `UPDATE wire_origination_payouts
       SET status = 'confirmed',
           metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
           error_message = NULL, updated_at = NOW()
       WHERE wire_id = $1 AND status IN ('originating','sent','confirmed')
       RETURNING *`,
      [
        wire.wire_id,
        JSON.stringify({
          providerConfirmationReference: evidence.confirmationReference
            || evidence.confirmation_reference
            || null,
          confirmedAt: evidence.confirmedAt || evidence.confirmed_at || new Date().toISOString(),
        }),
      ]
    );
    return result.rows[0] || null;
  }

  static async syncWireSettlement(wire, evidence = {}) {
    if (!wire?.wire_id) return null;
    await this.ensureTables();
    const result = await pool.query(
      `SELECT * FROM wire_origination_payouts WHERE wire_id = $1 LIMIT 1`,
      [wire.wire_id]
    );
    const row = result.rows[0];
    if (!row || row.status === 'settled') return row || null;

    if (row.hold_movement_id && CashEngine) {
      const movement = await pool.query(
        `SELECT movement_id FROM cash_movements
         WHERE reference_id = $1 AND reference_type = 'wire_origination_settled'
         LIMIT 1`,
        [row.payout_id]
      );
      if (!movement.rows.length) {
        await CashEngine.transfer({
          fromAccountId: HOLD_ACCOUNTS.wire,
          toAccountId: SETTLED_ACCOUNTS.wire,
          amountCents: Number(row.amount_cents),
          movementType: 'transfer',
          memo: `Settled wire payout ${row.payout_id}`,
          referenceId: row.payout_id,
          referenceType: 'wire_origination_settled',
          initiatedBy: evidence.settledBy || 'authenticated_operator',
        });
      }
    }

    const meta = typeof row.metadata === 'string'
      ? JSON.parse(row.metadata || '{}')
      : (row.metadata || {});
    const updated = await pool.query(
      `UPDATE wire_origination_payouts
       SET status = 'settled', metadata = $2::jsonb, error_message = NULL, updated_at = NOW()
       WHERE payout_id = $1
       RETURNING *`,
      [
        row.payout_id,
        JSON.stringify({
          ...meta,
          providerSettlementReference: evidence.settlementReference
            || evidence.settlement_reference
            || null,
          settled_at: evidence.settledAt || evidence.settled_at || new Date().toISOString(),
        }),
      ]
    );
    return updated.rows[0] || null;
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
      const systemMode = await SystemSettings.getMode();
      const productionConfig = await SystemSettings.getProductionPartnerConfig();
      adapters.find(a => a.id === 'wire').ready = Boolean(
        wireEndpoint
        && systemMode === 'production'
        && !productionConfig?.isBill
      );

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
