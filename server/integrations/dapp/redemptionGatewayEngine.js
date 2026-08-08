'use strict';

const pool = require('../bonds/pgPool');
const { RedemptionEngine } = require('./redemptionEngine');
const { ClearingEngine } = require('./clearingEngine');
const { StablecoinEngine } = require('./stablecoinEngine');
const { SpritzEngine } = require('../spritz/spritzEngine');
let StablecoinDexEngine;
try { ({ StablecoinDexEngine } = require('./stablecoinDexEngine')); } catch (e) { /* optional */ }
let HyperledgerBesuEngine;
try { ({ HyperledgerBesuEngine } = require('./hyperledgerBesuEngine')); } catch (e) { /* optional */ }

function id(prefix = 'RGW') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

class RedemptionGatewayEngine {
  static async ensureTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS redemption_gateway_requests (
        id            TEXT PRIMARY KEY,
        status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','clearing','external','awaiting_funds','completed','failed')),
        stablecoin    TEXT DEFAULT 'DLB-PTCUSD',
        amount        TEXT NOT NULL,
        beneficiary   TEXT,
        external_rail TEXT DEFAULT 'clearing' CHECK (external_rail IN ('clearing','besu','spritz','dex','p2p','bank_wire')),
        destination   JSONB NOT NULL DEFAULT '{}',
        metadata      JSONB NOT NULL DEFAULT '{}',
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_redemption_gw_status ON redemption_gateway_requests(status)`);
  }

  static async create({ amount, beneficiary, externalRail = 'clearing', destination = {}, metadata = {} } = {}) {
    await this.ensureTable();
    if (!amount || Number(amount) <= 0) throw new Error('amount required');
    if (!beneficiary) throw new Error('beneficiary required');
    if (externalRail === 'spritz') {
      if (!destination || !destination.accountId) throw new Error('Spritz payout requires destination.accountId');
    }
    const req = {
      id: id(),
      status: 'pending',
      stablecoin: metadata.stablecoin || 'DLB-PTCUSD',
      amount: String(amount),
      beneficiary,
      external_rail: externalRail,
      destination: JSON.stringify(destination || {}),
      metadata: JSON.stringify(metadata || {}),
    };
    await pool.query(
      `INSERT INTO redemption_gateway_requests (id, status, stablecoin, amount, beneficiary, external_rail, destination, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [req.id, req.status, req.stablecoin, req.amount, req.beneficiary, req.external_rail, req.destination, req.metadata]
    );
    return this.get(req.id);
  }

  static async get(requestId) {
    await this.ensureTable();
    const result = await pool.query('SELECT * FROM redemption_gateway_requests WHERE id = $1', [requestId]);
    if (!result.rows.length) return null;
    return this._format(result.rows[0]);
  }

  static async list({ status, limit = 50, offset = 0 } = {}) {
    await this.ensureTable();
    const where = status ? 'WHERE status = $1' : '';
    const params = status ? [status] : [];
    const result = await pool.query(
      `SELECT * FROM redemption_gateway_requests ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    return result.rows.map(r => this._format(r));
  }

  static async execute(requestId) {
    await this.ensureTable();
    const req = await this.get(requestId);
    if (!req) throw new Error('request not found');
    if (req.status !== 'pending') throw new Error('request not pending');

    let result = {};
    if (req.externalRail === 'clearing') {
      await this._transition(requestId, 'clearing');
      const clearing = await ClearingEngine.submit({
        payer: req.metadata?.payer || process.env.DAPP_OPERATOR_ADDRESS,
        payee: req.beneficiary,
        amount: req.amount,
        tokenAddress: req.metadata?.tokenAddress,
        assetSymbol: req.stablecoin,
        rail: 'besu',
        metadata: { redemptionGatewayRequestId: requestId },
      });
      await ClearingEngine.approve(clearing.id);
      await ClearingEngine.settle(clearing.id);
      result = { clearingOperationId: clearing.id };
    } else if (req.externalRail === 'besu' && HyperledgerBesuEngine) {
      result = await HyperledgerBesuEngine.transferToken({
        tokenAddress: req.metadata?.tokenAddress || process.env.DAPP_PTCUSD_ADDRESS,
        to: req.beneficiary,
        amount: req.amount,
      });
    } else if (req.externalRail === 'spritz') {
      result = await this._spritzPayout(req);
    } else if (req.externalRail === 'dex' && StablecoinDexEngine) {
      const swap = await StablecoinDexEngine.depositAndSwap({
        sourceType: req.metadata?.sourceType || 'module',
        sourceAccountId: req.metadata?.sourceAccountId || 'fixed_income',
        amount: req.amount,
        targetAsset: req.destination?.targetAsset || 'USDC',
        recipient: req.beneficiary,
        createPoolIfMissing: true,
      });
      result = { swap };
    } else {
      const redemption = await RedemptionEngine.create({
        fromAsset: req.stablecoin,
        amount: req.amount,
        destinationType: req.externalRail,
        destinationId: req.beneficiary,
        requesterEmail: req.metadata?.requesterEmail || 'gateway',
      });
      if (RedemptionEngine.execute) await RedemptionEngine.execute(redemption.id, { operatorEmail: req.metadata?.requesterEmail || 'gateway' });
      result = { redemptionId: redemption.id };
    }

    const status = result.awaitingFunds ? 'awaiting_funds' : (result.error ? 'failed' : 'completed');
    await pool.query(
      "UPDATE redemption_gateway_requests SET status=$1, metadata=jsonb_set(metadata, '{result}', $2::jsonb), updated_at=NOW() WHERE id=$3",
      [status, JSON.stringify(result), requestId]
    );
    return this.get(requestId);
  }

  static async _spritzPayout(req) {
    const dest = req.destination || {};
    const accountId = dest.accountId;
    if (!accountId) throw new Error('Spritz payout requires destination.accountId');
    const rail = dest.rail || 'ach_standard';
    const chain = dest.chain || 'ethereum';
    const tokenAddress = dest.tokenAddress || process.env.DAPP_USDC_ADDRESS || '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const amount = Number(req.amount);
    if (!amount || amount <= 0) throw new Error('invalid amount');

    const steps = [];
    // If the request is in DLB-PTCUSD, burn it and release backing reserves before the trust funds the payout.
    if (req.stablecoin === 'DLB-PTCUSD' && StablecoinEngine) {
      try {
        const reserveModule = req.metadata?.reserveModule || 'fixed_income';
        const redeemResult = await StablecoinEngine.redeem({
          moduleKey: reserveModule,
          amount: req.amount,
          operatorEmail: req.metadata?.requesterEmail || 'gateway',
        });
        steps.push({ step: 'redeem', result: redeemResult });
      } catch (e) {
        steps.push({ step: 'redeem', error: e.message });
      }
    }

    // Create Spritz off-ramp quote and execute from the operator wallet.
    const quote = await SpritzEngine.createOffRampQuote({
      accountId,
      amount: String(amount),
      chain,
      tokenAddress,
      amountMode: 'output',
      rail,
      memo: `Redemption gateway ${req.id}`,
    });

    try {
      const executed = await SpritzEngine.executeQuote(quote.id);
      return { quote, executed, steps, status: 'completed' };
    } catch (e) {
      // If the operator wallet lacks canonical stablecoin, surface the shortfall without failing the request.
      if (e.message && e.message.toLowerCase().includes('insufficient')) {
        return { quote, steps, awaitingFunds: true, error: e.message };
      }
      throw e;
    }
  }

  static async _transition(requestId, status) {
    await pool.query('UPDATE redemption_gateway_requests SET status=$1, updated_at=NOW() WHERE id=$2', [status, requestId]);
  }

  static _format(row) {
    return {
      id: row.id,
      status: row.status,
      stablecoin: row.stablecoin,
      amount: row.amount,
      beneficiary: row.beneficiary,
      externalRail: row.external_rail,
      destination: typeof row.destination === 'string' ? JSON.parse(row.destination) : (row.destination || {}),
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

module.exports = { RedemptionGatewayEngine };
