'use strict';

const { query } = require('../bonds/pgPool');
let DexSwapEngine;
try { ({ DexSwapEngine } = require('./dexSwapEngine')); } catch (e) { /* optional */ }
let PtcStablecoinEngine;
try { ({ PtcStablecoinEngine } = require('./ptcStablecoinEngine')); } catch (e) { /* optional */ }

function safeJson(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v); }
function id(prefix = 'LP') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }

/**
 * LiquidityPoolEngine — full BondDex liquidity pool lifecycle.
 *
 * Operators can create pairs, add/remove liquidity, swap, and inspect positions.
 * Pools are persisted in the same canonical_liquidity_pools table used by the
 * Canonical Liquidity Engine so both views stay in sync.
 */
class LiquidityPoolEngine {
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
    await query(`
      CREATE TABLE IF NOT EXISTS liquidity_positions (
        id            TEXT PRIMARY KEY,
        pool_address  TEXT NOT NULL,
        holder        TEXT NOT NULL,
        lp_balance    TEXT,
        token0_balance TEXT,
        token1_balance TEXT,
        metadata      JSONB DEFAULT '{}',
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_liquidity_positions_pool ON liquidity_positions(pool_address)`);
  }

  static async listPools() {
    await this.ensureTables();
    const rows = (await query('SELECT * FROM canonical_liquidity_pools ORDER BY created_at DESC')).rows;
    const out = [];
    for (const row of rows) {
      const info = row.pool_address && DexSwapEngine
        ? await DexSwapEngine.getPoolInfo({ poolAddress: row.pool_address }).catch(() => null)
        : null;
      out.push(this._formatPool({ ...row, ...(info || {}) }));
    }
    return out;
  }

  static async getPool(poolAddress) {
    await this.ensureTables();
    const rows = (await query('SELECT * FROM canonical_liquidity_pools WHERE pool_address = $1', [poolAddress])).rows;
    const info = DexSwapEngine ? await DexSwapEngine.getPoolInfo({ poolAddress }).catch(() => null) : null;
    return rows.length ? this._formatPool({ ...rows[0], ...(info || {}) }) : (info ? this._formatPool(info) : null);
  }

  static async createPool({ tokenA, tokenB, amountA, amountB, decimalsA = 6, decimalsB = 6 }) {
    if (!DexSwapEngine) throw new Error('DexSwapEngine not available');
    const result = await DexSwapEngine.createPool({ tokenA, tokenB, amountA, amountB, decimalsA, decimalsB });
    await this._persistPool(result, 'create');
    return result;
  }

  static async addLiquidity({ poolAddress, tokenA, tokenB, amountA, amountB, decimalsA = 6, decimalsB = 6 }) {
    if (!DexSwapEngine) throw new Error('DexSwapEngine not available');
    const result = await DexSwapEngine.addLiquidity({ poolAddress, tokenA, tokenB, amountA, amountB, decimalsA, decimalsB });
    await this._refreshPool(poolAddress);
    return result;
  }

  static async removeLiquidity({ poolAddress, lpAmount, recipient }) {
    if (!DexSwapEngine) throw new Error('DexSwapEngine not available');
    const result = await DexSwapEngine.removeLiquidity({ poolAddress, lpAmount, recipient });
    await this._refreshPool(poolAddress);
    return result;
  }

  static async quote({ poolAddress, tokenIn, amountIn, decimalsIn = 6 }) {
    if (!DexSwapEngine || !poolAddress) throw new Error('DexSwapEngine or poolAddress missing');
    const info = await DexSwapEngine.getPoolInfo({ poolAddress });
    const tokenOut = info.token0.toLowerCase() === tokenIn.toLowerCase() ? info.token1 : info.token0;
    const decimalsOut = Number(info.token0.toLowerCase() === tokenIn.toLowerCase() ? info.decimals1 : info.decimals0);
    return DexSwapEngine.quote({ tokenIn, tokenOut, amountIn, decimalsIn, decimalsOut, router: poolAddress });
  }

  static async swap({ poolAddress, tokenIn, amountIn, minOut, recipient, decimalsIn = 6 }) {
    if (!DexSwapEngine || !poolAddress) throw new Error('DexSwapEngine or poolAddress missing');
    const info = await DexSwapEngine.getPoolInfo({ poolAddress });
    const tokenOut = info.token0.toLowerCase() === tokenIn.toLowerCase() ? info.token1 : info.token0;
    const decimalsOut = Number(info.token0.toLowerCase() === tokenIn.toLowerCase() ? info.decimals1 : info.decimals0);
    return DexSwapEngine.swap({ tokenIn, tokenOut, amountIn, amountOutMinimum: minOut, decimalsIn, decimalsOut, router: poolAddress, recipient });
  }

  static async getPosition({ poolAddress, holder }) {
    if (!poolAddress || !holder) return null;
    let viem, chains;
    try { viem = require('viem'); chains = require('viem/chains'); } catch (e) { return { poolAddress, holder, lpBalance: '0' }; }
    const cfg = require('./config').getConfig();
    const chain = cfg.chainId === 1 ? (chains && chains.mainnet) : (chains && chains.sepolia) || undefined;
    const publicClient = viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) });
    const lpBalance = await publicClient.readContract({
      address: poolAddress,
      abi: [{ type:'function', name:'balanceOf', inputs:[{type:'address'}], outputs:[{type:'uint256'}], stateMutability:'view' }],
      functionName: 'balanceOf',
      args: [holder]
    }).catch(() => 0n);
    return { poolAddress, holder, lpBalance: String(lpBalance) };
  }

  static async depositModuleAndAddLiquidity({ moduleKey, amount, targetAsset, poolAddress, poolSeedUsdc = 0 }) {
    if (!PtcStablecoinEngine || !DexSwapEngine) throw new Error('PtcStablecoinEngine or DexSwapEngine not available');
    const deposit = await PtcStablecoinEngine.approveAndDeposit({ moduleKey, amount, recipient: undefined });
    const ptcAddress = process.env.DLB_PTCUSD_ADDRESS || '0xb01e6280ffe6faac679a17b029df8e065e8d0002';
    if (!poolAddress) {
      const targetAddress = process.env.DAPP_USDC_ADDRESS || '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
      const pool = await this.createPool({ tokenA: ptcAddress, tokenB: targetAddress, amountA: deposit.mintedStablecoin, amountB: poolSeedUsdc, decimalsA: 18, decimalsB: 6 });
      return { deposit, pool };
    }
    const add = await this.addLiquidity({ poolAddress, tokenA: ptcAddress, tokenB: targetAsset || 'USDC', amountA: deposit.mintedStablecoin, amountB: poolSeedUsdc, decimalsA: 18, decimalsB: 6 });
    return { deposit, add };
  }

  static async _persistPool(result, action) {
    if (!result || !result.poolAddress) return;
    await this.ensureTables();
    const existing = await query('SELECT id FROM canonical_liquidity_pools WHERE pool_address = $1', [result.poolAddress]);
    const metadata = { action, ...result };
    if (existing.rows.length) {
      await query('UPDATE canonical_liquidity_pools SET token0=$1, token1=$2, status=$3, metadata=$4, updated_at=NOW() WHERE pool_address=$5', [
        result.token0 || result.tokenA, result.token1 || result.tokenB, 'active', safeJson(metadata), result.poolAddress
      ]);
    } else {
      await query('INSERT INTO canonical_liquidity_pools (id, pool_address, token0, token1, status, metadata) VALUES ($1,$2,$3,$4,$5,$6)', [
        id(), result.poolAddress, result.token0 || result.tokenA, result.token1 || result.tokenB, 'active', safeJson(metadata)
      ]);
    }
  }

  static async _refreshPool(poolAddress) {
    if (!DexSwapEngine || !poolAddress) return;
    const info = await DexSwapEngine.getPoolInfo({ poolAddress }).catch(() => null);
    if (!info) return;
    await this.ensureTables();
    const existing = await query('SELECT id FROM canonical_liquidity_pools WHERE pool_address = $1', [poolAddress]);
    if (existing.rows.length) {
      await query('UPDATE canonical_liquidity_pools SET token0=$1, token1=$2, decimals0=$3, decimals1=$4, reserve0=$5, reserve1=$6, metadata=$7, updated_at=NOW() WHERE pool_address=$8', [
        info.token0, info.token1, info.decimals0 || 6, info.decimals1 || 6, String(info.reserve0 || 0), String(info.reserve1 || 0), safeJson(info), poolAddress
      ]);
    } else {
      await query('INSERT INTO canonical_liquidity_pools (id, pool_address, token0, token1, decimals0, decimals1, reserve0, reserve1, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
        id(), poolAddress, info.token0, info.token1, info.decimals0 || 6, info.decimals1 || 6, String(info.reserve0 || 0), String(info.reserve1 || 0), safeJson(info)
      ]);
    }
  }

  static _formatPool(row) {
    return { ...row, metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata || '{}') : (row.metadata || {}) };
  }
}

module.exports = { LiquidityPoolEngine };
