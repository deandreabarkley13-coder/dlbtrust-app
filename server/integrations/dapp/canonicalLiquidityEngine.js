'use strict';

const { query } = require('../bonds/pgPool');
const { CanonicalConsensusEngine } = require('./canonicalConsensusEngine');
let DexSwapEngine;
try { ({ DexSwapEngine } = require('./dexSwapEngine')); } catch (e) { /* optional */ }

function safeJson(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v); }
function id(prefix = 'CL') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }

/**
 * CanonicalLiquidityEngine — governance-wrapped DEX liquidity for trust assets.
 *
 * Proposals are created in the Canonical Consensus Engine (category `liquidity`)
 * so a Maker/Checker attestation is required before a pool is created, liquidity
 * is added, or a swap is executed.
 */
class CanonicalLiquidityEngine {
  static async ensureTables() {
    await query(`
      CREATE TABLE IF NOT EXISTS canonical_liquidity_pools (
        id            TEXT PRIMARY KEY,
        pool_address  TEXT UNIQUE,
        token0        TEXT,
        token1        TEXT,
        decimals0     INTEGER DEFAULT 6,
        decimals1     INTEGER DEFAULT 6,
        reserve0      TEXT,
        reserve1      TEXT,
        status        TEXT DEFAULT 'active',
        metadata      JSONB DEFAULT '{}',
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_canonical_liquidity_pools_address ON canonical_liquidity_pools(pool_address)`);
  }

  static async propose({ action, title, createdBy, payload }) {
    await this.ensureTables();
    if (!action || !title || !createdBy) throw new Error('action, title, and createdBy are required');
    if (!['create_pool', 'add_liquidity', 'swap'].includes(action)) throw new Error(`Unsupported liquidity action: ${action}`);
    const proposal = await CanonicalConsensusEngine.createProposal({
      category: 'liquidity',
      title,
      description: `Canonical liquidity ${action}`,
      payload: { ...payload, action },
      createdBy,
    });
    return { proposalId: proposal.id, ...proposal };
  }

  static async approve({ proposalId, role, approverEmail }) {
    return CanonicalConsensusEngine.approveProposal({ proposalId, role, approverEmail });
  }

  static async executeProposal(proposalId) {
    return CanonicalConsensusEngine.executeProposal(proposalId);
  }

  static async listProposals({ status, limit = 50, offset = 0 } = {}) {
    await this.ensureTables();
    let sql = "SELECT * FROM canonical_proposals WHERE category = 'liquidity'";
    const params = [];
    if (status) { sql += ' AND status = $1'; params.push(status); }
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));
    const res = await query(sql, params);
    return res.rows.map(r => CanonicalConsensusEngine._format ? CanonicalConsensusEngine._format(r) : r);
  }

  static async listPools() {
    await this.ensureTables();
    const res = await query('SELECT * FROM canonical_liquidity_pools ORDER BY created_at DESC');
    return res.rows.map(r => this._formatPool(r));
  }

  static async getPool(poolAddress) {
    await this.ensureTables();
    const res = await query('SELECT * FROM canonical_liquidity_pools WHERE pool_address = $1', [poolAddress]);
    if (!res.rows.length) return null;
    return this._formatPool(res.rows[0]);
  }

  static async _execute(proposal) {
    if (!DexSwapEngine) throw new Error('DexSwapEngine not available');
    const { payload } = proposal;
    const action = payload.action;
    const cfg = DexSwapEngine.getConfig ? DexSwapEngine.getConfig() : {};

    if (cfg.shadow) {
      const result = { mode: 'shadow', action, payload, poolAddress: payload.poolAddress || `shadow-pool-${Date.now()}` };
      await this._recordPool(action, result);
      return result;
    }

    let result;
    switch (action) {
      case 'create_pool':
        result = await DexSwapEngine.createPool({
          tokenA: payload.tokenA,
          tokenB: payload.tokenB,
          amountA: payload.amountA,
          amountB: payload.amountB,
          decimalsA: payload.decimalsA || 6,
          decimalsB: payload.decimalsB || 6,
        });
        await this._recordPool(action, result);
        return result;
      case 'add_liquidity':
        result = await DexSwapEngine.addLiquidity({
          poolAddress: payload.poolAddress,
          tokenA: payload.tokenA,
          tokenB: payload.tokenB,
          amountA: payload.amountA,
          amountB: payload.amountB,
          decimalsA: payload.decimalsA || 6,
          decimalsB: payload.decimalsB || 6,
        });
        if (payload.poolAddress) await this._refreshPool(payload.poolAddress);
        return result;
      case 'swap':
        result = await DexSwapEngine.swap({
          tokenIn: payload.tokenIn,
          tokenOut: payload.tokenOut,
          amountIn: payload.amountIn,
          router: payload.poolAddress,
          decimalsIn: payload.decimalsIn || 6,
          decimalsOut: payload.decimalsOut || 6,
          recipient: payload.recipient,
        });
        if (payload.poolAddress) await this._refreshPool(payload.poolAddress);
        return result;
      default:
        throw new Error(`Unknown liquidity action: ${action}`);
    }
  }

  static async _recordPool(action, result) {
    if (!result || !result.poolAddress) return;
    await this.ensureTables();
    const existing = await query('SELECT id FROM canonical_liquidity_pools WHERE pool_address = $1', [result.poolAddress]);
    const metadata = { action, ...result };
    if (existing.rows.length) {
      await query(
        'UPDATE canonical_liquidity_pools SET token0=$1, token1=$2, status=$3, metadata=$4, updated_at=NOW() WHERE pool_address=$5',
        [result.token0 || result.tokenA, result.token1 || result.tokenB, 'active', safeJson(metadata), result.poolAddress]
      );
    } else {
      await query(
        'INSERT INTO canonical_liquidity_pools (id, pool_address, token0, token1, status, metadata) VALUES ($1,$2,$3,$4,$5,$6)',
        [id(), result.poolAddress, result.token0 || result.tokenA, result.token1 || result.tokenB, 'active', safeJson(metadata)]
      );
    }
  }

  static async _refreshPool(poolAddress) {
    if (!DexSwapEngine || !poolAddress) return;
    const info = await DexSwapEngine.getPoolInfo({ poolAddress }).catch((e) => {
      console.warn('[CanonicalLiquidityEngine] getPoolInfo failed:', e.message);
      return null;
    });
    if (!info) return;
    await this.ensureTables();
    const existing = await query('SELECT id FROM canonical_liquidity_pools WHERE pool_address = $1', [poolAddress]);
    const row = {
      token0: info.token0,
      token1: info.token1,
      decimals0: info.decimals0 || 6,
      decimals1: info.decimals1 || 6,
      reserve0: String(info.reserve0 || 0),
      reserve1: String(info.reserve1 || 0),
    };
    if (existing.rows.length) {
      await query(
        'UPDATE canonical_liquidity_pools SET token0=$1, token1=$2, decimals0=$3, decimals1=$4, reserve0=$5, reserve1=$6, metadata=$7, updated_at=NOW() WHERE pool_address=$8',
        [row.token0, row.token1, row.decimals0, row.decimals1, row.reserve0, row.reserve1, safeJson(info), poolAddress]
      );
    } else {
      await query(
        'INSERT INTO canonical_liquidity_pools (id, pool_address, token0, token1, decimals0, decimals1, reserve0, reserve1, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [id(), poolAddress, row.token0, row.token1, row.decimals0, row.decimals1, row.reserve0, row.reserve1, safeJson(info)]
      );
    }
  }

  static _formatPool(row) {
    return {
      ...row,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata || '{}') : (row.metadata || {}),
    };
  }
}

module.exports = { CanonicalLiquidityEngine };
