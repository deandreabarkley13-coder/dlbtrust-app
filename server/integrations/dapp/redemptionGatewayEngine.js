'use strict';

const pool = require('../bonds/pgPool');
const { RedemptionEngine } = require('./redemptionEngine');
const { ClearingEngine } = require('./clearingEngine');
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
        status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','clearing','external','completed','failed')),
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

    await pool.query(
      "UPDATE redemption_gateway_requests SET status='completed', metadata=jsonb_set(metadata, '{result}', $1::jsonb), updated_at=NOW() WHERE id=$2",
      [JSON.stringify(result), requestId]
    );
    return this.get(requestId);
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
