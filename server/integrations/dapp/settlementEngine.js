'use strict';

/**
 * Settlement Engine
 *
 * Unified settlement queue for all outbound payment rails. A settlement is a
 * payment instruction that the engine routes to the correct child adapter:
 *   - external_endpoint  -> ExternalEndpointEngine
 *   - wire / ach         -> WireOriginationEngine
 *   - open_banking       -> OpenBankingEngine
 *   - manual             -> held in SETTLEMENT_HOLD awaiting operator action
 *   - mft_sftp / as2     -> queued for file generation / transmission
 *   - stablecoin         -> StablecoinEngine on-chain settle (when configured)
 *
 * The engine does NOT duplicate the child ledger holds; the child adapter
 * reserves and settles cash. SettlementEngine tracks the lifecycle and gives
 * the dashboard a single queue to monitor.
 */

const pool = require('../bonds/pgPool');

let CashEngine;
try { ({ CashEngine } = require('../cash/cashEngine')); } catch (e) { CashEngine = null; }

let ExternalEndpointEngine;
try { ExternalEndpointEngine = require('./externalEndpointEngine').ExternalEndpointEngine; } catch (e) { ExternalEndpointEngine = null; }

let WireOriginationEngine;
try { WireOriginationEngine = require('./wireOriginationEngine').WireOriginationEngine; } catch (e) { WireOriginationEngine = null; }

let WireEngine;
try { WireEngine = require('../wire/wireEngine').WireEngine; } catch (e) { WireEngine = null; }

let OpenBankingEngine;
try { OpenBankingEngine = require('./openBankingEngine').OpenBankingEngine; } catch (e) { OpenBankingEngine = null; }

let ACHEngine;
try { ({ ACHEngine } = require('../ach/achEngine')); } catch (e) { ACHEngine = null; }

let StablecoinEngine;
try { StablecoinEngine = require('./stablecoinEngine').StablecoinEngine; } catch (e) { StablecoinEngine = null; }

let SystemSettings;
try { SystemSettings = require('../ach/systemSettings').SystemSettings; } catch (e) { SystemSettings = null; }

let PaymentIdEngine;
try { PaymentIdEngine = require('./paymentIdEngine').PaymentIdEngine; } catch (e) { PaymentIdEngine = null; }

const HOLD_ACCOUNT = 'SETTLEMENT_HOLD';
const SETTLED_ACCOUNT = 'SETTLEMENT_SETTLED';

const VALID_RAILS = new Set([
  'external_endpoint', 'wire', 'ach', 'open_banking', 'iso20022',
  'mft_sftp', 'as2', 'stablecoin', 'manual'
]);

function generateId(prefix = 'SETL') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

class SettlementEngine {
  static async ensureTables() {
    if (!pool) throw new Error('Database pool not available');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settlements (
        settlement_id TEXT PRIMARY KEY,
        source_type TEXT DEFAULT 'manual',
        source_id TEXT,
        source_account_id TEXT,
        rail TEXT NOT NULL CHECK (rail IN ('external_endpoint','wire','ach','open_banking','iso20022','mft_sftp','as2','stablecoin','manual')),
        endpoint_id TEXT,
        connector TEXT,
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        debtor_name TEXT,
        debtor_account TEXT,
        debtor_routing TEXT,
        debtor_bank TEXT,
        creditor_name TEXT NOT NULL,
        creditor_account TEXT,
        creditor_routing TEXT,
        creditor_bank TEXT,
        payment_type TEXT DEFAULT 'payment',
        description TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reserved','submitted','transmitted','originated','queued','manual_pending','settled','completed','failed','cancelled')),
        external_id TEXT,
        raw_request TEXT,
        raw_response TEXT,
        error_message TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        config JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_settlements_status ON settlements(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_settlements_source_id ON settlements(source_id)`);
    await this._ensureHoldAccounts();
  }

  static async _ensureHoldAccounts() {
    if (!CashEngine) return;
    const accounts = [
      [HOLD_ACCOUNT, 'Settlement Hold'],
      [SETTLED_ACCOUNT, 'Settlement Settled']
    ];
    for (const [id, name] of accounts) {
      try {
        const existing = await CashEngine.getAccount(id);
        if (existing) continue;
        await CashEngine.createAccount({ accountId: id, accountName: name, accountType: 'escrow', notes: 'Settlement Engine clearing account' });
      } catch (e) { console.warn('[settlement] hold account:', e.message); }
    }
  }

  static async createSettlement(opts = {}) {
    await this.ensureTables();
    const {
      sourceType = 'manual', sourceId, sourceAccountId,
      rail, endpointId, connector,
      amount, currency = 'USD',
      debtorName, debtorAccount, debtorRouting, debtorBank,
      creditorName, creditorAccount, creditorRouting, creditorBank,
      paymentType = 'payment', description,
      config = {},
    } = opts;

    if (!rail || !VALID_RAILS.has(rail)) throw new Error('Valid rail is required');
    if (!creditorName) throw new Error('creditorName is required');
    const amountCents = toCents(amount);
    if (amountCents <= 0) throw new Error('amount must be positive');

    if (sourceAccountId && CashEngine) {
      const acct = await CashEngine.getAccount(sourceAccountId);
      if (!acct) throw new Error(`Source account not found: ${sourceAccountId}`);
      if (parseInt(acct.balance_cents || 0, 10) < amountCents) throw new Error(`Insufficient balance in ${sourceAccountId}`);
    }

    const settlementId = generateId('SETL');
    const status = rail === 'manual' ? 'manual_pending' : 'pending';

    await pool.query(
      `INSERT INTO settlements
       (settlement_id, source_type, source_id, source_account_id, rail, endpoint_id, connector,
        amount_cents, currency, debtor_name, debtor_account, debtor_routing, debtor_bank,
        creditor_name, creditor_account, creditor_routing, creditor_bank,
        payment_type, description, status, config)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        settlementId, sourceType, sourceId || null, sourceAccountId || null, rail, endpointId || null, connector || null,
        amountCents, currency, debtorName || null, debtorAccount || null, debtorRouting || null, debtorBank || null,
        creditorName, creditorAccount || null, creditorRouting || null, creditorBank || null,
        paymentType, description || null, status, JSON.stringify(config)
      ]
    );

    if (PaymentIdEngine) {
      try {
        await PaymentIdEngine.createPaymentId({
          sourceType: 'settlement', sourceId: settlementId,
          rail, amount: amountCents / 100, currency,
          debtorName, debtorAccount, debtorRouting, debtorBank,
          creditorName, creditorAccount, creditorRouting, creditorBank,
          description,
          metadata: { endpoint_id: endpointId, connector }
        });
      } catch (e) { console.warn('[settlement] payment-id create:', e.message); }
    }

    return this.getSettlement(settlementId);
  }

  static async getSettlement(settlementId) {
    await this.ensureTables();
    const res = await pool.query('SELECT * FROM settlements WHERE settlement_id = $1', [settlementId]);
    return res.rows[0] || null;
  }

  static async listSettlements({ status, rail, limit = 50 } = {}) {
    await this.ensureTables();
    const conditions = [];
    const params = [];
    if (status) { conditions.push(`status = $${params.length + 1}`); params.push(status); }
    if (rail) { conditions.push(`rail = $${params.length + 1}`); params.push(rail); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const res = await pool.query(`SELECT * FROM settlements ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return res.rows;
  }

  static async executeSettlement(settlementId) {
    await this.ensureTables();
    const settlement = await this.getSettlement(settlementId);
    if (!settlement) throw new Error('Settlement not found');
    if (settlement.status !== 'pending') throw new Error(`Settlement cannot be executed from status ${settlement.status}`);

    let result;
    if (settlement.rail === 'manual') {
      result = await this._executeManual(settlement);
    } else if (settlement.rail === 'mft_sftp' || settlement.rail === 'as2') {
      result = await this._executeQueued(settlement);
    } else if (settlement.rail === 'stablecoin') {
      result = await this._executeStablecoin(settlement);
    } else if (settlement.rail === 'external_endpoint') {
      result = await this._executeExternalEndpoint(settlement);
    } else if (settlement.rail === 'wire' || settlement.rail === 'ach') {
      result = await this._executeWireOrAch(settlement);
    } else if (settlement.rail === 'open_banking' || settlement.rail === 'iso20022') {
      result = await this._executeOpenBanking(settlement);
    } else {
      throw new Error(`Unsupported rail: ${settlement.rail}`);
    }

    if (PaymentIdEngine && result) {
      try {
        const childType = 'settlement';
        const childId = result.settlement_id;
        await PaymentIdEngine.linkChildToSource('settlement', result.settlement_id, {
          childType, childId,
          externalId: result.external_id || null,
          externalStatus: result.status,
          status: result.status,
          rawRequest: result.raw_request || null,
          rawResponse: result.raw_response || null,
          errorMessage: result.error_message || null
        });
      } catch (e) { console.warn('[settlement] payment-id register:', e.message); }
    }

    return result;
  }

  static async _executeManual(settlement) {
    const rawRequest = this._buildInstructions(settlement);
    let status = 'manual_pending';
    if (settlement.source_account_id && CashEngine) {
      try {
        await CashEngine.transfer({
          fromAccountId: settlement.source_account_id,
          toAccountId: HOLD_ACCOUNT,
          amountCents: settlement.amount_cents,
          movementType: 'transfer',
          memo: `Reserve manual settlement ${settlement.settlement_id}`,
          referenceId: settlement.settlement_id,
          referenceType: 'settlement'
        });
        status = 'manual_pending';
      } catch (e) {
        throw new Error(`Reserve failed: ${e.message}`);
      }
    }
    await pool.query(
      `UPDATE settlements SET status = $2, raw_request = $3, updated_at = NOW() WHERE settlement_id = $1`,
      [settlement.settlement_id, status, rawRequest]
    );
    return this.getSettlement(settlement.settlement_id);
  }

  static async _executeQueued(settlement) {
    const rawRequest = this._buildInstructions(settlement);
    await pool.query(
      `UPDATE settlements SET status = 'queued', raw_request = $2, updated_at = NOW() WHERE settlement_id = $1`,
      [settlement.settlement_id, rawRequest]
    );
    return this.getSettlement(settlement.settlement_id);
  }

  static async _executeStablecoin(settlement) {
    let status = 'queued';
    let externalId = null;
    let rawResponse = null;
    let error = null;
    const rawRequest = this._buildInstructions(settlement);
    const to = settlement.creditor_account;
    if (StablecoinEngine && to) {
      try {
        const result = await StablecoinEngine.settle({
          to,
          amount: settlement.amount_cents / 100,
          memo: settlement.description || `Settlement ${settlement.settlement_id}`,
          operatorEmail: 'settlement-engine',
          requireConsensus: false
        });
        rawResponse = JSON.stringify(result);
        externalId = result.txHash || result.proposalId || null;
        status = result.txHash ? 'settled' : 'submitted';
      } catch (e) {
        error = e.message;
        status = 'failed';
      }
    } else {
      error = StablecoinEngine ? 'creditor_account (wallet address) required' : 'StablecoinEngine not available';
      status = 'failed';
    }
    await pool.query(
      `UPDATE settlements SET status = $2, external_id = $3, raw_request = $4, raw_response = $5, error_message = $6, updated_at = NOW() WHERE settlement_id = $1`,
      [settlement.settlement_id, status, externalId, rawRequest, rawResponse, error]
    );
    return this.getSettlement(settlement.settlement_id);
  }

  static async _executeExternalEndpoint(settlement) {
    if (!ExternalEndpointEngine) throw new Error('ExternalEndpointEngine not available');
    if (!settlement.endpoint_id) throw new Error('endpoint_id is required for external_endpoint rail');

    const rawRequest = JSON.stringify({
      endpoint_id: settlement.endpoint_id,
      sourceAccountId: settlement.source_account_id,
      amount: settlement.amount_cents / 100,
      currency: settlement.currency,
      creditorName: settlement.creditor_name,
      creditorAccount: settlement.creditor_account,
      creditorRouting: settlement.creditor_routing,
      creditorBank: settlement.creditor_bank,
      debtorName: settlement.debtor_name,
      debtorAccount: settlement.debtor_account,
      debtorRouting: settlement.debtor_routing,
      debtorBank: settlement.debtor_bank,
      paymentType: settlement.payment_type,
      description: settlement.description,
    });

    let result;
    let status = 'failed';
    let error = null;
    try {
      result = await ExternalEndpointEngine.executePayment({
        endpointId: settlement.endpoint_id,
        sourceAccountId: settlement.source_account_id,
        amount: settlement.amount_cents / 100,
        currency: settlement.currency,
        creditorName: settlement.creditor_name,
        creditorAccount: settlement.creditor_account,
        creditorRouting: settlement.creditor_routing,
        creditorBank: settlement.creditor_bank,
        debtorName: settlement.debtor_name,
        debtorAccount: settlement.debtor_account,
        debtorRouting: settlement.debtor_routing,
        debtorBank: settlement.debtor_bank,
        paymentType: settlement.payment_type,
        description: settlement.description,
        sourceType: 'settlement',
        settlementId: settlement.settlement_id,
      });
      status = this._mapExternalStatus(result.status);
    } catch (e) {
      error = e.message;
      status = 'failed';
    }

    await pool.query(
      `UPDATE settlements SET status = $2, source_id = $3, external_id = $4, raw_request = $5, raw_response = $6, error_message = $7, updated_at = NOW() WHERE settlement_id = $1`,
      [
        settlement.settlement_id, status, result && result.paymentId ? result.paymentId : null, result && result.externalId ? result.externalId : null,
        rawRequest, result ? JSON.stringify(result) : null, error || (result && result.errorMessage ? result.errorMessage : null)
      ]
    );
    if (error) throw new Error(error);
    return this.getSettlement(settlement.settlement_id);
  }

  static async _executeWireOrAch(settlement) {
    if (!WireOriginationEngine) throw new Error('WireOriginationEngine not available');
    const adapter = settlement.rail;
    const rawRequest = JSON.stringify({
      adapter,
      sourceType: 'cash',
      sourceAccountId: settlement.source_account_id,
      amount: settlement.amount_cents / 100,
      beneficiaryName: settlement.creditor_name,
      beneficiaryRouting: settlement.creditor_routing,
      beneficiaryAccount: settlement.creditor_account,
      beneficiaryBankName: settlement.creditor_bank,
      paymentType: settlement.payment_type,
      description: settlement.description,
      initiatedBy: 'settlement-engine'
    });

    const payout = await WireOriginationEngine.createPayout({
      sourceType: 'cash',
      sourceAccountId: settlement.source_account_id,
      amount: settlement.amount_cents / 100,
      beneficiaryName: settlement.creditor_name,
      beneficiaryRouting: settlement.creditor_routing,
      beneficiaryAccount: settlement.creditor_account,
      beneficiaryBankName: settlement.creditor_bank,
      adapter,
      paymentType: settlement.payment_type,
      description: settlement.description,
      initiatedBy: 'settlement-engine',
      requiresApproval: false,
    });

    let result = payout;
    let status = this._mapWireStatus(payout.status);
    let error = null;
    if (payout.status === 'approved') {
      try {
        result = await WireOriginationEngine.sendPayout(payout.payout_id);
        status = this._mapWireStatus(result.status);
      } catch (e) {
        error = e.message;
        status = 'failed';
        try { await WireOriginationEngine.cancelPayout(payout.payout_id); } catch (ce) {}
      }
    }

    await pool.query(
      `UPDATE settlements SET status = $2, source_id = $3, external_id = $4, raw_request = $5, raw_response = $6, error_message = $7, updated_at = NOW() WHERE settlement_id = $1`,
      [
        settlement.settlement_id, status, payout.payout_id, result && (result.wire_id || result.ach_batch_id) ? (result.wire_id || result.ach_batch_id) : null,
        rawRequest, JSON.stringify(result), error || (result && result.error_message ? result.error_message : null)
      ]
    );
    if (error) throw new Error(error);
    return this.getSettlement(settlement.settlement_id);
  }

  static async _executeOpenBanking(settlement) {
    if (!OpenBankingEngine) throw new Error('OpenBankingEngine not available');
    const connector = settlement.connector || 'generic_rest';
    const rawRequest = JSON.stringify({
      connector,
      sourceCashAccountId: settlement.source_account_id,
      amount: settlement.amount_cents / 100,
      currency: settlement.currency,
      debtorName: settlement.debtor_name || 'DLB Trust',
      debtorAccount: settlement.debtor_account,
      debtorBic: settlement.debtor_routing,
      creditorName: settlement.creditor_name,
      creditorAccount: settlement.creditor_account,
      creditorRouting: settlement.creditor_routing,
      creditorBic: settlement.creditor_routing,
      remittance: settlement.description,
      description: settlement.description,
    });

    let result;
    let status = 'failed';
    let error = null;
    try {
      result = await OpenBankingEngine.createPayment({
        connector,
        sourceCashAccountId: settlement.source_account_id,
        amount: settlement.amount_cents / 100,
        currency: settlement.currency,
        debtorName: settlement.debtor_name || 'DLB Trust',
        debtorAccount: settlement.debtor_account,
        debtorBic: settlement.debtor_routing,
        creditorName: settlement.creditor_name,
        creditorAccount: settlement.creditor_account,
        creditorRouting: settlement.creditor_routing,
        creditorBic: settlement.creditor_routing,
        remittance: settlement.description,
        description: settlement.description,
      });
      status = this._mapOpenBankingStatus(result.status);
    } catch (e) {
      error = e.message;
      status = 'failed';
    }

    await pool.query(
      `UPDATE settlements SET status = $2, source_id = $3, external_id = $4, raw_request = $5, raw_response = $6, error_message = $7, updated_at = NOW() WHERE settlement_id = $1`,
      [
        settlement.settlement_id, status, result && result.paymentId ? result.paymentId : null, result && result.externalId ? result.externalId : null,
        rawRequest, result ? JSON.stringify(result) : null, error || (result && result.error ? result.error : null)
      ]
    );
    if (error) throw new Error(error);
    return this.getSettlement(settlement.settlement_id);
  }

  static async cancelSettlement(settlementId) {
    await this.ensureTables();
    const settlement = await this.getSettlement(settlementId);
    if (!settlement) throw new Error('Settlement not found');
    if (['settled', 'completed', 'failed', 'cancelled'].includes(settlement.status)) {
      throw new Error(`Cannot cancel settlement in ${settlement.status} status`);
    }

    if (settlement.rail === 'manual' && settlement.source_account_id && CashEngine && settlement.status === 'manual_pending') {
      try {
        await CashEngine.transfer({
          fromAccountId: HOLD_ACCOUNT,
          toAccountId: settlement.source_account_id,
          amountCents: settlement.amount_cents,
          movementType: 'transfer',
          memo: `Cancel manual settlement ${settlementId}`,
          referenceId: settlementId,
          referenceType: 'settlement_cancel'
        });
      } catch (e) { console.warn('[settlement] manual refund failed:', e.message); }
    }

    if ((settlement.rail === 'wire' || settlement.rail === 'ach') && settlement.source_id && WireOriginationEngine) {
      try {
        await WireOriginationEngine.cancelPayout(settlement.source_id);
      } catch (e) { console.warn('[settlement] child payout cancel failed:', e.message); }
    }

    await pool.query(`UPDATE settlements SET status = 'cancelled', updated_at = NOW() WHERE settlement_id = $1`, [settlementId]);
    return this.getSettlement(settlementId);
  }

  static async confirmSettlement(settlementId, opts = {}) {
    await this.ensureTables();
    const settlement = await this.getSettlement(settlementId);
    if (!settlement) throw new Error('Settlement not found');
    if (settlement.status !== 'manual_pending' && settlement.status !== 'settled') {
      throw new Error(`Cannot confirm settlement in ${settlement.status} status`);
    }

    if (settlement.status === 'manual_pending' && CashEngine && settlement.source_account_id) {
      try {
        await CashEngine.transfer({
          fromAccountId: HOLD_ACCOUNT,
          toAccountId: SETTLED_ACCOUNT,
          amountCents: settlement.amount_cents,
          movementType: 'transfer',
          memo: `Confirm manual settlement ${settlementId}`,
          referenceId: settlementId,
          referenceType: 'settlement_confirm'
        });
      } catch (e) { console.warn('[settlement] manual confirm transfer failed:', e.message); }
    }

    const externalId = opts.externalId || settlement.external_id;
    await pool.query(
      `UPDATE settlements SET status = 'completed', external_id = $2, raw_response = COALESCE(raw_response,'') || $3, updated_at = NOW() WHERE settlement_id = $1`,
      [settlementId, externalId, JSON.stringify({ confirmedAt: new Date().toISOString(), ...opts })]
    );
    return this.getSettlement(settlementId);
  }

  static async pollSettlements() {
    await this.ensureTables();
    const res = await pool.query(
      `SELECT * FROM settlements WHERE source_id IS NOT NULL AND status IN ('submitted','transmitted','originated','manual_pending','queued') ORDER BY created_at ASC LIMIT 50`
    );
    const out = [];
    for (const s of res.rows) {
      try {
        const updated = await this._pollOne(s);
        if (updated) out.push({ settlement_id: s.settlement_id, status: updated.status });
      } catch (e) { console.warn('[settlement] poll failed for', s.settlement_id, e.message); }
    }
    return out;
  }

  static async _pollOne(settlement) {
    if (!settlement.source_id) return null;
    let childStatus = null;
    let rawResponse = null;
    let externalId = settlement.external_id;

    if (settlement.rail === 'external_endpoint' && ExternalEndpointEngine) {
      const payment = await ExternalEndpointEngine.getPayment(settlement.source_id);
      if (payment) {
        childStatus = payment.status;
        rawResponse = JSON.stringify(payment);
        externalId = payment.external_id || externalId;
      }
    } else if ((settlement.rail === 'wire' || settlement.rail === 'ach') && WireOriginationEngine) {
      const payout = await WireOriginationEngine.getPayout(settlement.source_id);
      if (payout) {
        childStatus = payout.status;
        rawResponse = JSON.stringify(payout);
        externalId = payout.wire_id || payout.ach_batch_id || externalId;
      }
    } else if ((settlement.rail === 'open_banking' || settlement.rail === 'iso20022') && OpenBankingEngine) {
      const payment = await OpenBankingEngine.getPayment(settlement.source_id);
      if (payment) {
        childStatus = payment.status;
        rawResponse = JSON.stringify(payment);
        externalId = payment.external_id || externalId;
      }
    }

    if (!childStatus) return null;
    const mapped = this._mapChildStatus(settlement.rail, childStatus);
    if (mapped !== settlement.status) {
      await pool.query(
        `UPDATE settlements SET status = $2, external_id = $3, raw_response = $4, updated_at = NOW() WHERE settlement_id = $1`,
        [settlement.settlement_id, mapped, externalId, rawResponse]
      );
      return this.getSettlement(settlement.settlement_id);
    }
    return settlement;
  }

  static async getDashboard() {
    await this.ensureTables();
    const stats = await pool.query(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(amount_cents), 0) as total_cents,
        COUNT(CASE WHEN status IN ('pending','reserved','submitted','transmitted','originated','queued','manual_pending') THEN 1 END) as open,
        COUNT(CASE WHEN status IN ('settled','completed') THEN 1 END) as completed,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
        COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled
      FROM settlements
    `);
    const recent = await pool.query(`SELECT * FROM settlements ORDER BY created_at DESC LIMIT 20`);
    const s = stats.rows[0];
    return {
      total: parseInt(s.total),
      total_cents: parseInt(s.total_cents),
      open: parseInt(s.open),
      completed: parseInt(s.completed),
      failed: parseInt(s.failed),
      cancelled: parseInt(s.cancelled),
      recent_settlements: recent.rows,
      rails: await this.getRails()
    };
  }

  static async getRails() {
    const rails = [
      { id: 'external_endpoint', name: 'External Endpoint Engine', needs: ['configured endpoint'] },
      { id: 'wire', name: 'Fedwire Bank API', needs: ['WIRE_ENDPOINT / bank API key'] },
      { id: 'ach', name: 'ACH NACHA / AS2', needs: ['ACH partner config or ACH_SFTP_URL'] },
      { id: 'open_banking', name: 'Open Banking / ISO 20022', needs: ['OPENBANKING_ENDPOINT and OPENBANKING_API_KEY'] },
      { id: 'iso20022', name: 'ISO 20022 Generic REST', needs: ['OPENBANKING_ENDPOINT and OPENBANKING_API_KEY'] },
      { id: 'mft_sftp', name: 'MFT / SFTP File Transfer', needs: ['SFTP credentials / partner'] },
      { id: 'as2', name: 'AS2 Secure EDI', needs: ['AS2 partner config and certificates'] },
      { id: 'stablecoin', name: 'Stablecoin On-Chain Settle', needs: ['StablecoinEngine / wallet address'] },
      { id: 'manual', name: 'Manual Wire/ACH/Check', needs: [] }
    ];

    for (const rail of rails) {
      rail.ready = false;
      try {
        if (rail.id === 'external_endpoint') {
          if (ExternalEndpointEngine) {
            const list = await ExternalEndpointEngine.listEndpoints({ enabled: true });
            rail.ready = list.length > 0;
          }
        } else if (rail.id === 'wire' || rail.id === 'ach') {
          if (WireOriginationEngine) {
            const readiness = await WireOriginationEngine.readiness();
            const adapter = readiness.adapters.find(a => a.id === rail.id);
            rail.ready = !!(adapter && adapter.ready);
          }
        } else if (rail.id === 'open_banking' || rail.id === 'iso20022') {
          if (OpenBankingEngine) {
            const connectors = await OpenBankingEngine.getConnectors();
            rail.ready = connectors.some(c => c.ready);
          }
        } else if (rail.id === 'mft_sftp' || rail.id === 'as2') {
          rail.ready = !!(ACHEngine && process.env.ACH_SFTP_URL);
        } else if (rail.id === 'stablecoin') {
          rail.ready = !!StablecoinEngine;
        } else if (rail.id === 'manual') {
          rail.ready = true;
        }
      } catch (e) { rail.ready = false; }
    }
    return rails;
  }

  static _mapExternalStatus(status) {
    if (status === 'completed') return 'completed';
    if (status === 'originated') return 'submitted';
    if (status === 'manual_pending') return 'manual_pending';
    return 'failed';
  }

  static _mapWireStatus(status) {
    if (['sent','confirmed','settled'].includes(status)) return 'completed';
    if (status === 'originating') return 'transmitted';
    if (status === 'approved') return 'submitted';
    if (status === 'manual_pending' || status === 'needs_setup') return 'manual_pending';
    return 'failed';
  }

  static _mapOpenBankingStatus(status) {
    if (status === 'settled') return 'completed';
    if (status === 'originated' || status === 'pending') return 'submitted';
    if (status === 'manual_pending') return 'manual_pending';
    return 'failed';
  }

  static _mapChildStatus(rail, status) {
    if (rail === 'external_endpoint') return this._mapExternalStatus(status);
    if (rail === 'wire' || rail === 'ach') return this._mapWireStatus(status);
    if (rail === 'open_banking' || rail === 'iso20022') return this._mapOpenBankingStatus(status);
    return status;
  }

  static _buildInstructions(settlement) {
    return JSON.stringify({
      settlement_id: settlement.settlement_id,
      rail: settlement.rail,
      amount_cents: settlement.amount_cents,
      currency: settlement.currency,
      debtor: { name: settlement.debtor_name, account: settlement.debtor_account, routing: settlement.debtor_routing, bank: settlement.debtor_bank },
      creditor: { name: settlement.creditor_name, account: settlement.creditor_account, routing: settlement.creditor_routing, bank: settlement.creditor_bank },
      instructions: 'Submit via bank portal, AS2/MFT gateway, or stablecoin wallet as configured.',
      generated_at: new Date().toISOString()
    });
  }
}

module.exports = { SettlementEngine };
