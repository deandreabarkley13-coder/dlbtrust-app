'use strict';

/**
 * Internal Market Maker Engine
 *
 * Tokenizes internal trust reserves (DLB-PTCUSD via reserve modules, DLBUSD via
 * ledger sources) and pairs them with canonical stablecoins or other trust
 * tokens to deepen BondDex/AMM liquidity. Tracks LP positions and accrued yield.
 */

const { getConfig } = require('./config');

let StablecoinDexEngine = null;
let PtcStablecoinEngine = null;
let LiquidityPoolEngine = null;
let DexSwapEngine = null;
let ModuleSmartAccountEngine = null;
let TrustAccountingEngine = null;
let TreasuryEngine = null;

try { StablecoinDexEngine = require('./stablecoinDexEngine').StablecoinDexEngine; } catch (e) { /* optional */ }
try { PtcStablecoinEngine = require('./ptcStablecoinEngine').PtcStablecoinEngine; } catch (e) { /* optional */ }
try { LiquidityPoolEngine = require('./liquidityPoolEngine').LiquidityPoolEngine; } catch (e) { /* optional */ }
try { DexSwapEngine = require('./dexSwapEngine').DexSwapEngine; } catch (e) { /* optional */ }
try { ModuleSmartAccountEngine = require('./moduleSmartAccountEngine').ModuleSmartAccountEngine; } catch (e) { /* optional */ }
try { TrustAccountingEngine = require('../accounting/trustAccountingEngine').TrustAccountingEngine; } catch (e) { /* optional */ }
try { TreasuryEngine = require('../stablecoin/treasuryEngine').TreasuryEngine; } catch (e) { /* optional */ }

let viem;
try { viem = require('viem'); } catch (e) { viem = null; }

let query = null;
try { ({ query } = require('../bonds/pgPool')); } catch (e) { query = null; }

const KNOWN_ASSETS = {
  'DLB-PTCUSD': 'dlbPtcusdAddress',
  'PTC': 'dlbPtcusdAddress',
  'DLBUSD': 'dlbusdAddress',
  'DAI': 'daiAddress',
  'USDC': 'usdcAddress',
  'USDS': 'usdsAddress',
  'WETH': 'wethAddress',
  'ETH': 'wethAddress',
};

function str(name, def = '') { return (process.env[name] || def).trim(); }
function safeJson(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v); }
function id(prefix = 'IMM') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }

class InternalMarketMakerEngine {
  static getConfig() {
    const cfg = getConfig();
    return {
      ...cfg,
      enabled: str('INTERNAL_MM_ENABLED', 'true').toLowerCase() !== 'false',
      operatorAddress: cfg.operatorAddress || str('DAPP_OPERATOR_ADDRESS'),
      dlbPtcusdAddress: process.env.DLB_PTCUSD_ADDRESS || '0xb01e6280ffe6faac679a17b029df8e065e8d0002',
      dlbusdAddress: process.env.DLBUSD_ADDRESS || process.env.DAPP_DLBUSD_ADDRESS || '',
      interestIncomeAccount: str('INTERNAL_MM_INTEREST_ACCOUNT', '4000'),
      stablecoinAssetAccount: str('STABLECOIN_ASSET_ACCOUNT', '1210'),
      trustCorpusAccount: str('TRUST_CORPUS_ACCOUNT', '3000'),
    };
  }

  static async _withLowFees(fn) {
    const prevMax = process.env.DAPP_MAX_FEE_GWEI;
    const prevPriority = process.env.DAPP_PRIORITY_FEE_GWEI;
    process.env.DAPP_MAX_FEE_GWEI = '1';
    process.env.DAPP_PRIORITY_FEE_GWEI = '0.05';
    try {
      return await fn();
    } finally {
      if (prevMax !== undefined) process.env.DAPP_MAX_FEE_GWEI = prevMax;
      else delete process.env.DAPP_MAX_FEE_GWEI;
      if (prevPriority !== undefined) process.env.DAPP_PRIORITY_FEE_GWEI = prevPriority;
      else delete process.env.DAPP_PRIORITY_FEE_GWEI;
    }
  }

  static async ensureTables() {
    if (!query) return;
    await query(`
      CREATE TABLE IF NOT EXISTS internal_market_maker_pools (
        id                 TEXT PRIMARY KEY,
        pool_address       TEXT,
        name               TEXT,
        trust_asset        TEXT,
        canonical_asset    TEXT,
        trust_source_type  TEXT,
        trust_source_account_id TEXT,
        trust_module_key   TEXT,
        canonical_source_type TEXT,
        canonical_source_account_id TEXT,
        apy_bps            INTEGER DEFAULT 0,
        status             TEXT DEFAULT 'active',
        metadata           JSONB DEFAULT '{}',
        created_at         TIMESTAMPTZ DEFAULT NOW(),
        updated_at         TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_internal_mm_pools_address') THEN
          DROP INDEX IF EXISTS idx_internal_mm_pools_address;
          CREATE UNIQUE INDEX idx_internal_mm_pools_address ON internal_market_maker_pools(pool_address);
          ALTER TABLE internal_market_maker_pools ADD CONSTRAINT uq_internal_mm_pools_address UNIQUE (pool_address);
        END IF;
      END $$;
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS market_maker_positions (
        id            TEXT PRIMARY KEY,
        pool_id       TEXT NOT NULL,
        holder        TEXT NOT NULL,
        lp_balance    TEXT,
        token0_balance TEXT,
        token1_balance TEXT,
        accrued_yield TEXT,
        metadata      JSONB DEFAULT '{}',
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_market_maker_positions_pool ON market_maker_positions(pool_id)`);
  }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.enabled) issues.push('Internal Market Maker disabled');
    if (!cfg.privateKey) issues.push('DAPP_PRIVATE_KEY not configured');
    if (!cfg.rpcUrl) issues.push('DAPP_RPC_URL not configured');
    if (!StablecoinDexEngine) issues.push('StablecoinDexEngine not available');
    if (!PtcStablecoinEngine) issues.push('PtcStablecoinEngine not available');
    if (!LiquidityPoolEngine) issues.push('LiquidityPoolEngine not available');
    if (!DexSwapEngine) issues.push('DexSwapEngine not available');
    if (!query) issues.push('Postgres query not available');
    return { ready: issues.length === 0, mode: cfg.dappShadow ? 'shadow' : 'live', issues };
  }

  static _resolveTokenAddress(asset) {
    const cfg = this.getConfig();
    const key = String(asset || '').toUpperCase();
    if (KNOWN_ASSETS[key]) return cfg[KNOWN_ASSETS[key]] || '';
    if (viem && viem.isAddress && viem.isAddress(asset)) return asset;
    return asset;
  }

  static async _resolveTokenAddressAsync(asset) {
    const key = String(asset || '').toUpperCase();
    if (key === 'DLBUSD' || key === 'DLB-USD') {
      if (!StablecoinDexEngine) throw new Error('StablecoinDexEngine not available');
      const token = await StablecoinDexEngine.getOrCreateDLBUSDToken();
      return token.token_address || token.tokenAddress || '';
    }
    return this._resolveTokenAddress(asset);
  }

  static async _resolveDecimals(tokenAddress) {
    if (!viem || !tokenAddress) return 18;
    const cfg = this.getConfig();
    if (tokenAddress.toLowerCase() === cfg.dlbusdAddress.toLowerCase()) return 6;
    if (tokenAddress.toLowerCase() === cfg.usdcAddress.toLowerCase()) return 6;
    const publicClient = viem.createPublicClient({ chain: viem.mainnet, transport: viem.http(cfg.rpcUrl) });
    try {
      const d = await publicClient.readContract({ address: tokenAddress, abi: [{ type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' }], functionName: 'decimals' });
      return Number(d);
    } catch (e) { return 18; }
  }

  static async _getOrFindPool({ trustAsset, canonicalAsset, createIfMissing = false }) {
    const cfg = this.getConfig();
    const tokenA = await this._resolveTokenAddressAsync(trustAsset);
    const tokenB = await this._resolveTokenAddressAsync(canonicalAsset);
    if (!tokenA || !tokenB) throw new Error(`Cannot resolve token addresses for ${trustAsset} / ${canonicalAsset}`);

    if (query) {
      const rows = await query(`
        SELECT * FROM internal_market_maker_pools
        WHERE (trust_asset = $1 AND canonical_asset = $2) OR (trust_asset = $2 AND canonical_asset = $1)
        ORDER BY created_at DESC LIMIT 1
      `, [trustAsset, canonicalAsset]);
      if (rows.rows.length) {
        const pool = rows.rows[0];
        if (pool.pool_address) {
          const info = await DexSwapEngine.getPoolInfo({ poolAddress: pool.pool_address }).catch(() => null);
          return { ...pool, info };
        }
        return pool;
      }
    }

    const allPools = await LiquidityPoolEngine.listPools();
    const match = allPools.find(p => {
      const a = String(p.token0).toLowerCase();
      const b = String(p.token1).toLowerCase();
      return (a === tokenA.toLowerCase() && b === tokenB.toLowerCase()) || (a === tokenB.toLowerCase() && b === tokenA.toLowerCase());
    });
    if (match) return match;

    if (createIfMissing) {
      return null;
    }
    throw new Error(`No internal market maker pool found for ${trustAsset} / ${canonicalAsset}`);
  }

  static async _quoteFromPool({ poolAddress, tokenIn, amountIn, decimalsIn }) {
    if (!poolAddress || !tokenIn || !amountIn) throw new Error('poolAddress, tokenIn, and amountIn required');
    return LiquidityPoolEngine.quote({ poolAddress, tokenIn, amountIn, decimalsIn });
  }

  static async _getPoolInfo(poolAddress) {
    if (!DexSwapEngine || !poolAddress) return null;
    return DexSwapEngine.getPoolInfo({ poolAddress }).catch(() => null);
  }

  static async _mintTrustSide({ trustAsset, trustAmount, sourceType, sourceAccountId, moduleKey }) {
    const cfg = this.getConfig();
    const upper = String(trustAsset || '').toUpperCase();
    if (upper === 'DLBUSD' || upper === 'DLB-USD') {
      if (!StablecoinDexEngine) throw new Error('StablecoinDexEngine not available');
      if (!sourceType || !sourceAccountId) throw new Error('sourceType and sourceAccountId required to mint DLBUSD');
      return this._withLowFees(() => StablecoinDexEngine.mintFromSource({ sourceType, sourceAccountId, amount: trustAmount, targetAddress: cfg.operatorAddress }));
    }
    if (upper === 'DLB-PTCUSD' || upper === 'PTC') {
      if (!PtcStablecoinEngine) throw new Error('PtcStablecoinEngine not available');
      if (!moduleKey) throw new Error('moduleKey required to mint DLB-PTCUSD');
      return this._withLowFees(() => PtcStablecoinEngine.approveAndDeposit({ moduleKey, amount: String(trustAmount), recipient: cfg.operatorAddress }));
    }
    throw new Error(`Unsupported trust asset: ${trustAsset}`);
  }

  static async _ensureCanonicalSide({ canonicalAsset, canonicalAmount, canonicalSourceType, canonicalSourceAccountId, operatorAddress }) {
    const cfg = this.getConfig();
    const upper = String(canonicalAsset || '').toUpperCase();
    const tokenAddress = await this._resolveTokenAddressAsync(canonicalAsset);

    if (upper === 'ETH' || upper === 'WETH') {
      if (!viem || !tokenAddress) throw new Error('WETH not configured');
      const publicClient = viem.createPublicClient({ chain: viem.mainnet, transport: viem.http(cfg.rpcUrl) });
      const bal = await publicClient.readContract({ address: tokenAddress, abi: [{ type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }], functionName: 'balanceOf', args: [operatorAddress] }).catch(() => 0n);
      const needed = viem.parseEther(String(canonicalAmount));
      if (BigInt(bal) < BigInt(needed)) {
        const wrapAmount = Number((needed - BigInt(bal)) / (10n ** 18n)) / 1;
        if (wrapAmount > 0) {
          if (!StablecoinDexEngine || !StablecoinDexEngine.wrapEth) throw new Error('Not enough WETH to seed pool');
          await this._withLowFees(() => StablecoinDexEngine.wrapEth({ amount: wrapAmount }));
        }
      }
      return { tokenAddress, amount: canonicalAmount, decimals: 18 };
    }

    if (upper === 'DLBUSD' && canonicalSourceType && canonicalSourceAccountId) {
      if (!StablecoinDexEngine) throw new Error('StablecoinDexEngine not available');
      await this._withLowFees(() => StablecoinDexEngine.mintFromSource({ sourceType: canonicalSourceType, sourceAccountId: canonicalSourceAccountId, amount: canonicalAmount, targetAddress: operatorAddress }));
      return { tokenAddress, amount: canonicalAmount, decimals: 6 };
    }

    if (upper === 'DLB-PTCUSD' || upper === 'PTC') {
      const ptcAddress = this._resolveTokenAddress('DLB-PTCUSD');
      const publicClient = viem.createPublicClient({ chain: viem.mainnet, transport: viem.http(cfg.rpcUrl) });
      const bal = await publicClient.readContract({ address: ptcAddress, abi: [{ type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }], functionName: 'balanceOf', args: [operatorAddress] }).catch(() => 0n);
      const needed = viem.parseEther(String(canonicalAmount));
      if (BigInt(bal) < BigInt(needed)) throw new Error(`Insufficient PTC balance: ${bal} < ${needed}`);
      return { tokenAddress: ptcAddress, amount: canonicalAmount, decimals: 18 };
    }

    const decimals = await this._resolveDecimals(tokenAddress);
    const publicClient = viem.createPublicClient({ chain: viem.mainnet, transport: viem.http(cfg.rpcUrl) });
    const bal = await publicClient.readContract({ address: tokenAddress, abi: [{ type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }], functionName: 'balanceOf', args: [operatorAddress] }).catch(() => 0n);
    const needed = viem.parseUnits(String(canonicalAmount), decimals);
    if (BigInt(bal) < BigInt(needed)) throw new Error(`Insufficient ${canonicalAsset} balance: ${bal} < ${needed}`);
    return { tokenAddress, amount: canonicalAmount, decimals };
  }

  static async tokenizeAndSeed({
    name,
    trustAsset = 'DLBUSD',
    canonicalAsset = 'DLB-PTCUSD',
    trustAmount,
    canonicalAmount,
    sourceType,
    sourceAccountId,
    moduleKey,
    canonicalSourceType,
    canonicalSourceAccountId,
    poolAddress,
    apyBps = 0,
    createIfMissing = true,
  } = {}) {
    if (!trustAmount || Number(trustAmount) <= 0) throw new Error('trustAmount must be positive');
    const cfg = this.getConfig();
    const operator = cfg.operatorAddress;

    const trustSide = await this._mintTrustSide({ trustAsset, trustAmount, sourceType, sourceAccountId, moduleKey });
    const canonical = await this._ensureCanonicalSide({ canonicalAsset, canonicalAmount: canonicalAmount || trustAmount, canonicalSourceType, canonicalSourceAccountId, operatorAddress: operator });

    const trustAddress = await this._resolveTokenAddressAsync(trustAsset);
    const canonicalAddress = canonical.tokenAddress;

    if (!poolAddress) {
      const existing = await this._getOrFindPool({ trustAsset, canonicalAsset, createIfMissing: false }).catch(() => null);
      if (existing && existing.pool_address) poolAddress = existing.pool_address;
    }

    let poolResult;
    const trustDecimals = trustAsset.toUpperCase() === 'DLBUSD' ? 6 : 18;
    const canonicalDecimals = canonical.decimals;

    if (poolAddress) {
      poolResult = await this._withLowFees(() => LiquidityPoolEngine.addLiquidity({
        poolAddress,
        tokenA: trustAddress,
        tokenB: canonicalAddress,
        amountA: trustAmount,
        amountB: canonical.amount,
        decimalsA: trustDecimals,
        decimalsB: canonicalDecimals,
      }));
    } else if (createIfMissing) {
      poolResult = await this._withLowFees(() => LiquidityPoolEngine.createPool({
        tokenA: trustAddress,
        tokenB: canonicalAddress,
        amountA: trustAmount,
        amountB: canonical.amount,
        decimalsA: trustDecimals,
        decimalsB: canonicalDecimals,
      }));
      poolAddress = poolResult.poolAddress;
    } else {
      throw new Error('No pool address and createIfMissing=false');
    }

    await this.ensureTables();
    const poolId = id('IMMP');
    const meta = { trustSide, canonical, poolResult };
    if (query) {
      await query(`
        INSERT INTO internal_market_maker_pools
          (id, pool_address, name, trust_asset, canonical_asset, trust_source_type, trust_source_account_id, trust_module_key, canonical_source_type, canonical_source_account_id, apy_bps, status, metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (pool_address) DO UPDATE SET
          name = EXCLUDED.name,
          trust_asset = EXCLUDED.trust_asset,
          canonical_asset = EXCLUDED.canonical_asset,
          trust_source_type = EXCLUDED.trust_source_type,
          trust_source_account_id = EXCLUDED.trust_source_account_id,
          trust_module_key = EXCLUDED.trust_module_key,
          canonical_source_type = EXCLUDED.canonical_source_type,
          canonical_source_account_id = EXCLUDED.canonical_source_account_id,
          apy_bps = EXCLUDED.apy_bps,
          metadata = internal_market_maker_pools.metadata || EXCLUDED.metadata,
          updated_at = NOW()
      `, [poolId, poolAddress || poolResult.poolAddress, name || `${trustAsset}/${canonicalAsset} Internal MM`, trustAsset, canonicalAsset, sourceType || null, sourceAccountId || null, moduleKey || null, canonicalSourceType || null, canonicalSourceAccountId || null, apyBps || 0, 'active', JSON.stringify(meta)]);
    }

    await this._recordPosition({ poolId: poolAddress || poolResult.poolAddress, holder: operator, poolResult });

    return {
      success: true,
      poolAddress: poolAddress || poolResult.poolAddress,
      trustAsset,
      canonicalAsset,
      trustAmount,
      canonicalAmount: canonical.amount,
      trustSide,
      canonical,
      poolResult,
      apyBps,
    };
  }

  static async _recordPosition({ poolId, holder, poolResult }) {
    if (!query) return;
    const poolRow = await query('SELECT id FROM internal_market_maker_pools WHERE pool_address = $1', [poolId]).catch(() => ({ rows: [] }));
    const dbPoolId = poolRow.rows[0]?.id || poolId;
    const lpBalance = await this._getLpBalance(poolId, holder);
    await query(`
      INSERT INTO market_maker_positions (id, pool_id, holder, lp_balance, metadata, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (id) DO UPDATE SET
        lp_balance = EXCLUDED.lp_balance,
        metadata = market_maker_positions.metadata || EXCLUDED.metadata,
        updated_at = NOW()
    `, [id('IMMPOS'), dbPoolId, holder, lpBalance, JSON.stringify({ poolResult })]);
  }

  static async _getLpBalance(poolAddress, holder) {
    if (!viem || !poolAddress || !holder) return '0';
    const cfg = this.getConfig();
    try {
      const publicClient = viem.createPublicClient({ chain: viem.mainnet, transport: viem.http(cfg.rpcUrl) });
      const bal = await publicClient.readContract({
        address: poolAddress,
        abi: [{ type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
        functionName: 'balanceOf',
        args: [holder],
      });
      return String(bal);
    } catch (e) { return '0'; }
  }

  static async addLiquidity({ poolAddress, tokenA, tokenB, amountA, amountB, decimalsA = 6, decimalsB = 18 }) {
    if (!poolAddress) throw new Error('poolAddress required');
    const result = await this._withLowFees(() => LiquidityPoolEngine.addLiquidity({ poolAddress, tokenA, tokenB, amountA, amountB, decimalsA, decimalsB }));
    const cfg = this.getConfig();
    await this._recordPosition({ poolId: poolAddress, holder: cfg.operatorAddress, poolResult: result });
    return result;
  }

  static async removeLiquidity({ poolAddress, lpAmount, recipient }) {
    if (!poolAddress || !lpAmount) throw new Error('poolAddress and lpAmount required');
    return this._withLowFees(() => LiquidityPoolEngine.removeLiquidity({ poolAddress, lpAmount, recipient }));
  }

  static async quote({ poolAddress, tokenIn, amountIn, decimalsIn } = {}) {
    if (!poolAddress || !tokenIn || !amountIn) throw new Error('poolAddress, tokenIn, and amountIn required');
    const resolved = await this._resolveTokenAddressAsync(tokenIn);
    const dec = decimalsIn || await this._resolveDecimals(resolved);
    return LiquidityPoolEngine.quote({ poolAddress, tokenIn: resolved, amountIn, decimalsIn: dec });
  }

  static async swap({ poolAddress, tokenIn, amountIn, minOut, recipient, decimalsIn } = {}) {
    if (!poolAddress || !tokenIn || !amountIn) throw new Error('poolAddress, tokenIn, and amountIn required');
    const resolved = await this._resolveTokenAddressAsync(tokenIn);
    const dec = decimalsIn || await this._resolveDecimals(resolved);
    const result = await this._withLowFees(() => LiquidityPoolEngine.swap({ poolAddress, tokenIn: resolved, amountIn, minOut, recipient, decimalsIn: dec }));
    return result;
  }

  static async listPools() {
    await this.ensureTables();
    if (!query) return [];
    const rows = (await query('SELECT * FROM internal_market_maker_pools ORDER BY created_at DESC')).rows;
    const out = [];
    for (const row of rows) {
      const info = row.pool_address ? await this._getPoolInfo(row.pool_address).catch(() => null) : null;
      out.push({ ...row, info });
    }
    return out;
  }

  static async getPool(poolAddress) {
    await this.ensureTables();
    if (!query) return null;
    const rows = (await query('SELECT * FROM internal_market_maker_pools WHERE pool_address = $1 OR id = $1', [poolAddress])).rows;
    if (!rows.length) return null;
    const info = rows[0].pool_address ? await this._getPoolInfo(rows[0].pool_address).catch(() => null) : null;
    return { ...rows[0], info };
  }

  static async listPositions({ holder } = {}) {
    await this.ensureTables();
    if (!query) return [];
    const sql = holder
      ? 'SELECT * FROM market_maker_positions WHERE holder = $1 ORDER BY updated_at DESC'
      : 'SELECT * FROM market_maker_positions ORDER BY updated_at DESC';
    const params = holder ? [holder] : [];
    return (await query(sql, params)).rows;
  }

  static async accrueYield({ poolAddress, apyBps } = {}) {
    if (!query) throw new Error('Postgres not available');
    const pool = await this.getPool(poolAddress);
    if (!pool) throw new Error('Pool not found');
    const rate = apyBps || pool.apy_bps || 0;
    if (rate <= 0) return { updated: 0 };
    const positions = await query('SELECT * FROM market_maker_positions WHERE pool_id = $1', [pool.id]);
    let updated = 0;
    for (const pos of positions.rows) {
      const lp = Number(pos.lp_balance || 0);
      if (lp <= 0) continue;
      const seconds = Math.max(0, (Date.now() - new Date(pos.updated_at).getTime()) / 1000);
      const accrued = lp * (rate / 10000) * (seconds / (365 * 24 * 3600));
      const newAccrued = String(BigInt(Math.floor(Number(pos.accrued_yield || 0) + accrued)));
      await query('UPDATE market_maker_positions SET accrued_yield = $1, updated_at = NOW() WHERE id = $2', [newAccrued, pos.id]);
      updated++;
    }
    return { updated };
  }
}

module.exports = { InternalMarketMakerEngine };
