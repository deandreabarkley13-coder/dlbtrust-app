'use strict';

const pool = require('../bonds/pgPool');
const { StablecoinEngine } = require('./stablecoinEngine');
const { AccountAbstractionEngine } = require('./accountAbstractionEngine');
let HyperledgerBesuEngine;
try { ({ HyperledgerBesuEngine } = require('./hyperledgerBesuEngine')); } catch (e) { /* optional */ }

function id(prefix = 'CLR') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

class ClearingEngine {
  static async ensureTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clearing_operations (
        id            TEXT PRIMARY KEY,
        type          TEXT NOT NULL DEFAULT 'bilateral' CHECK (type IN ('bilateral','multilateral','netting')),
        status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','settled','failed','cancelled')),
        payer         TEXT,
        payee         TEXT,
        token_address TEXT,
        amount        TEXT NOT NULL,
        asset_symbol  TEXT DEFAULT 'DLB-PTCUSD',
        rail          TEXT DEFAULT 'besu' CHECK (rail IN ('besu','ethereum','shadow')),
        metadata      JSONB NOT NULL DEFAULT '{}',
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_clearing_status ON clearing_operations(status)`);
  }

  static async submit({ payer, payee, amount, tokenAddress, assetSymbol = 'DLB-PTCUSD', rail = 'besu', metadata = {} } = {}) {
    await this.ensureTable();
    if (!payer || !payee) throw new Error('payer and payee required');
    if (!amount || Number(amount) <= 0) throw new Error('amount must be positive');
    const op = {
      id: id(),
      type: 'bilateral',
      status: 'pending',
      payer,
      payee,
      token_address: tokenAddress,
      amount: String(amount),
      asset_symbol: assetSymbol,
      rail,
      metadata: JSON.stringify(metadata || {}),
    };
    await pool.query(
      `INSERT INTO clearing_operations (id, type, status, payer, payee, token_address, amount, asset_symbol, rail, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [op.id, op.type, op.status, op.payer, op.payee, op.token_address, op.amount, op.asset_symbol, op.rail, op.metadata]
    );
    return this.get(op.id);
  }

  static async list({ status, limit = 50, offset = 0 } = {}) {
    await this.ensureTable();
    const where = status ? 'WHERE status = $1' : '';
    const params = status ? [status] : [];
    const result = await pool.query(
      `SELECT * FROM clearing_operations ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    return result.rows.map(r => this._format(r));
  }

  static async get(operationId) {
    await this.ensureTable();
    const result = await pool.query('SELECT * FROM clearing_operations WHERE id = $1', [operationId]);
    if (!result.rows.length) return null;
    return this._format(result.rows[0]);
  }

  static async approve(operationId) {
    await this.ensureTable();
    const op = await this.get(operationId);
    if (!op) throw new Error('operation not found');
    if (op.status !== 'pending') throw new Error('operation not pending');
    await pool.query("UPDATE clearing_operations SET status='approved', updated_at=NOW() WHERE id=$1", [operationId]);
    return this.get(operationId);
  }

  static async settle(operationId) {
    await this.ensureTable();
    const op = await this.get(operationId);
    if (!op) throw new Error('operation not found');
    if (op.status !== 'approved') throw new Error('operation must be approved before settlement');
    let result = {};
    if (op.rail === 'besu' && HyperledgerBesuEngine) {
      const besu = await HyperledgerBesuEngine.status();
      if (besu.enabled && !besu.shadow) {
        result = await HyperledgerBesuEngine.transferToken({
          tokenAddress: op.token_address || process.env.DAPP_PTCUSD_ADDRESS,
          to: op.payee,
          amount: op.amount,
        });
      } else {
        result = { shadow: true, rail: 'besu', message: 'Besu not connected; settlement recorded off-chain' };
      }
    } else if (op.rail === 'ethereum') {
      result = await AccountAbstractionEngine.prepareGaslessTransfer({
        owner: op.payer,
        to: op.payee,
        tokenAddress: op.token_address,
        amount: op.amount,
      });
    } else {
      result = { shadow: true, rail: op.rail || 'shadow' };
    }
    await pool.query(
      "UPDATE clearing_operations SET status='settled', metadata=jsonb_set(metadata, '{settlement}', $1::jsonb), updated_at=NOW() WHERE id=$2",
      [JSON.stringify(result), operationId]
    );
    return this.get(operationId);
  }

  static async cancel(operationId) {
    await this.ensureTable();
    await pool.query("UPDATE clearing_operations SET status='cancelled', updated_at=NOW() WHERE id=$1", [operationId]);
    return this.get(operationId);
  }

  static async netPositions() {
    await this.ensureTable();
    const result = await pool.query(`
      SELECT
        LEAST(payer, payee) as a,
        GREATEST(payer, payee) as b,
        SUM(CASE WHEN payer = LEAST(payer, payee) THEN amount::numeric ELSE -amount::numeric END) as net
      FROM clearing_operations
      WHERE status IN ('pending','approved','settled')
      GROUP BY LEAST(payer, payee), GREATEST(payer, payee)
    `);
    return result.rows.map(r => ({ partyA: r.a, partyB: r.b, net: r.net }));
  }

  static _format(row) {
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      payer: row.payer,
      payee: row.payee,
      tokenAddress: row.token_address,
      amount: row.amount,
      assetSymbol: row.asset_symbol,
      rail: row.rail,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

module.exports = { ClearingEngine };
