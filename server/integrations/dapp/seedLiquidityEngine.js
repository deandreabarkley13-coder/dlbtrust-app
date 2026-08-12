'use strict';

/**
 * SeedLiquidityEngine
 *
 * Operator helper to create and seed BondDex liquidity pools for DLB-PTCUSD
 * (or any token) against a paired asset such as DAI, WETH, or USDC.
 *
 * - Finds an existing pool from the canonical_liquidity_pools table.
 * - Wraps ETH to WETH when seeding a PTC/WETH pool and the operator is short.
 * - Best-effort mints DLB-PTCUSD from a reserve module if a moduleKey is supplied.
 * - Uses DexSwapEngine / LiquidityPoolEngine to deploy the pool and add liquidity.
 */

const { getConfig } = require('./config');
const { query } = require('../bonds/pgPool');

let DexSwapEngine, LiquidityPoolEngine, PtcStablecoinEngine;
try { ({ DexSwapEngine } = require('./dexSwapEngine')); } catch (e) {}
try { ({ LiquidityPoolEngine } = require('./liquidityPoolEngine')); } catch (e) {}
try { ({ PtcStablecoinEngine } = require('./ptcStablecoinEngine')); } catch (e) {}

let viem, privateKeyToAccount, chains;
try {
  viem = require('viem');
  ({ privateKeyToAccount } = require('viem/accounts'));
  chains = require('viem/chains');
} catch (e) {}

function str(name, fallback = '') { return (process.env[name] || fallback).trim(); }
function bool(name, fallback = false) { const v = process.env[name]; return v ? String(v).toLowerCase() === 'true' : fallback; }

const DEFAULT_PTC = '0xb01e6280ffe6faac679a17b029df8e065e8d0002';
const DEFAULT_WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

const erc20Abi = [
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'transfer', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
];

const whitelistAbi = [
  { type: 'function', name: 'whitelisted', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'setWhitelisted', inputs: [{ type: 'address' }, { type: 'bool' }], outputs: [], stateMutability: 'nonpayable' },
];

function id(prefix = 'SL') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }

class SeedLiquidityEngine {
  static getConfig() {
    const cfg = getConfig();
    return {
      ...cfg,
      enabled: bool('SEED_LIQUIDITY_ENABLED', true),
      shadow: bool('SEED_LIQUIDITY_SHADOW', cfg.dappShadow !== false ? true : cfg.dappShadow),
    };
  }

  static async getPtcTokenAddress() {
    let addr = process.env.DLB_PTCUSD_ADDRESS || '';
    if (!addr && PtcStablecoinEngine) {
      const info = await PtcStablecoinEngine.info().catch(() => ({}));
      addr = info.tokenAddress || '';
    }
    return addr || DEFAULT_PTC;
  }

  static _walletClient() {
    if (!viem) throw new Error('viem not installed');
    const cfg = this.getConfig();
    if (!cfg.privateKey) throw new Error('DAPP_PRIVATE_KEY not configured');
    const pk = cfg.privateKey.startsWith('0x') ? cfg.privateKey : `0x${cfg.privateKey}`;
    const account = privateKeyToAccount(pk);
    const chain = cfg.chainId === 1 ? chains.mainnet : (chains.sepolia || undefined);
    const feeFn = cfg.getFees || (() => ({ maxFeePerGas: viem.parseGwei('1'), maxPriorityFeePerGas: viem.parseGwei('0.05') }));
    const fees = feeFn() || { maxFeePerGas: viem.parseGwei('1'), maxPriorityFeePerGas: viem.parseGwei('0.05') };
    return {
      account,
      wallet: viem.createWalletClient({ account, chain, transport: viem.http(cfg.rpcUrl) }),
      publicClient: viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) }),
      fees,
    };
  }

  static async _withLowerFees(fn) {
    const oldMax = process.env.DAPP_MAX_FEE_GWEI;
    const oldPri = process.env.DAPP_PRIORITY_FEE_GWEI;
    process.env.DAPP_MAX_FEE_GWEI = '1';
    process.env.DAPP_PRIORITY_FEE_GWEI = '0.05';
    try {
      return await fn();
    } finally {
      if (oldMax !== undefined) process.env.DAPP_MAX_FEE_GWEI = oldMax;
      else delete process.env.DAPP_MAX_FEE_GWEI;
      if (oldPri !== undefined) process.env.DAPP_PRIORITY_FEE_GWEI = oldPri;
      else delete process.env.DAPP_PRIORITY_FEE_GWEI;
    }
  }

  static async _operatorAddress() {
    const cfg = this.getConfig();
    if (cfg.operatorAddress) return cfg.operatorAddress;
    return this._walletClient().account.address;
  }

  static async _tokenDecimals(tokenAddress) {
    if (!viem || !tokenAddress) return 18;
    try {
      const { publicClient } = this._walletClient();
      return Number(await publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'decimals' })) || 18;
    } catch (e) { return 18; }
  }

  static async _tokenBalance(tokenAddress, holder) {
    if (!viem || !tokenAddress || !holder) return 0n;
    try {
      const { publicClient } = this._walletClient();
      return BigInt(await publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [holder] })) || 0n;
    } catch (e) { return 0n; }
  }

  static async _ethBalance() {
    if (!viem) return 0n;
    const { publicClient } = this._walletClient();
    const addr = await this._operatorAddress();
    return BigInt(await publicClient.getBalance({ address: addr })) || 0n;
  }

  static async ensureTables() {
    if (LiquidityPoolEngine) await LiquidityPoolEngine.ensureTables();
  }

  static async listPools() {
    await this.ensureTables();
    const rows = (await query('SELECT id, pool_address, token0, token1, decimals0, decimals1, reserve0, reserve1, status, metadata FROM canonical_liquidity_pools ORDER BY created_at DESC')).rows;
    const out = [];
    for (const row of rows) {
      let info = null;
      if (DexSwapEngine && row.pool_address) info = await DexSwapEngine.getPoolInfo({ poolAddress: row.pool_address }).catch(() => null);
      out.push({
        ...row,
        ...(info || {}),
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata || '{}') : (row.metadata || {}),
      });
    }
    return out;
  }

  static async findPool({ tokenA, tokenB }) {
    await this.ensureTables();
    if (!tokenA || !tokenB) return null;
    const a = String(tokenA).toLowerCase();
    const b = String(tokenB).toLowerCase();
    const rows = (await query(
      'SELECT * FROM canonical_liquidity_pools WHERE ((LOWER(token0)=$1 AND LOWER(token1)=$2) OR (LOWER(token0)=$2 AND LOWER(token1)=$1)) AND status=$3 LIMIT 1',
      [a, b, 'active']
    )).rows;
    if (rows.length) return rows[0];

    const envPool = str('BOND_DEX_ADDRESS', '');
    if (envPool && DexSwapEngine) {
      const info = await DexSwapEngine.getPoolInfo({ poolAddress: envPool }).catch(() => null);
      if (info) {
        const t0 = String(info.token0).toLowerCase();
        const t1 = String(info.token1).toLowerCase();
        if ((t0 === a && t1 === b) || (t0 === b && t1 === a)) return { pool_address: envPool, ...info };
      }
    }
    return null;
  }

  static async wrapEth({ amount } = {}) {
    const cfg = this.getConfig();
    if (!cfg.wethAddress) throw new Error('DAPP_WETH_ADDRESS not configured');
    if (cfg.shadow) return { wrapped: amount, mode: 'shadow' };
    if (!amount || Number(amount) <= 0) throw new Error('amount must be positive');
    const raw = viem.parseEther(String(amount));
    const { wallet, publicClient, fees } = this._walletClient();
    const hash = await wallet.writeContract({
      address: cfg.wethAddress,
      abi: [{ type: 'function', name: 'deposit', inputs: [], outputs: [], stateMutability: 'payable' }],
      functionName: 'deposit',
      value: raw,
      gas: 100000n,
      ...fees,
    });
    await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    return { wrapped: amount, txHash: hash, mode: 'live' };
  }

  static async ensurePtcPool({ targetAsset = 'DAI', seedPtcAmount, seedPairedAmount, moduleKey, createIfMissing = true } = {}) {
    const cfg = this.getConfig();
    if (cfg.shadow) return { poolAddress: `shadow-ptc-${targetAsset.toLowerCase()}-${Date.now()}`, mode: 'shadow' };

    const ptcAddress = await this.getPtcTokenAddress();
    const targetUpper = String(targetAsset).toUpperCase();
    const pairedAddress = this._resolvePairedAddress(targetAsset);
    if (!pairedAddress) throw new Error(`Cannot resolve token address for ${targetAsset}`);
    const pairedDecimals = await this._tokenDecimals(pairedAddress);

    const seedPtc = seedPtcAmount !== undefined ? Number(seedPtcAmount) : 0.01;
    const seedPaired = seedPairedAmount !== undefined ? Number(seedPairedAmount) : (targetUpper === 'WETH' || targetUpper === 'ETH' ? 0.000005 : 0.01);
    if (seedPtc <= 0 || seedPaired <= 0) throw new Error('Seed amounts must be positive');

    let existing = await this.findPool({ tokenA: ptcAddress, tokenB: pairedAddress });
    if (existing && existing.pool_address) return { ...existing, created: false, mode: 'live' };
    if (!createIfMissing) throw new Error(`No PTC/${targetAsset} pool found and createIfMissing is false`);

    const operator = await this._operatorAddress();

    // Ensure PTC balance / mint
    const ptcDecimals = 18;
    const rawPtcNeed = viem.parseUnits(String(seedPtc), ptcDecimals);
    if (moduleKey && PtcStablecoinEngine) {
      const deposit = await PtcStablecoinEngine.approveAndDeposit({ moduleKey, amount: String(seedPtc), recipient: operator });
      const minted = BigInt(deposit?.mintedStablecoin || 0);
      if (minted < rawPtcNeed) throw new Error(`Minted ${minted} PTC, need ${rawPtcNeed}`);
    } else {
      const ptcBal = await this._tokenBalance(ptcAddress, operator);
      if (BigInt(ptcBal || 0) < rawPtcNeed) throw new Error(`Operator PTC balance insufficient to seed ${seedPtc} DLB-PTCUSD`);
    }

    // Ensure paired asset balance
    if (targetUpper === 'WETH' || targetUpper === 'ETH') {
      const wethAddress = cfg.wethAddress || DEFAULT_WETH;
      const wethBal = await this._tokenBalance(wethAddress, operator);
      const rawWethNeed = viem.parseUnits(String(seedPaired), 18);
      if (BigInt(wethBal || 0) < rawWethNeed) {
        const ethNeed = rawWethNeed + viem.parseEther('0.0001');
        const ethBal = await this._ethBalance();
        if (ethBal < ethNeed) throw new Error(`Operator ETH balance insufficient to wrap ${seedPaired} WETH for seed`);
        await this.wrapEth({ amount: seedPaired });
      }
    } else {
      const rawPairedNeed = viem.parseUnits(String(seedPaired), pairedDecimals);
      const pairedBal = await this._tokenBalance(pairedAddress, operator);
      if (BigInt(pairedBal || 0) < rawPairedNeed) throw new Error(`Operator ${targetAsset} balance insufficient to seed ${seedPaired} ${targetAsset}`);
    }

    if (!LiquidityPoolEngine) throw new Error('LiquidityPoolEngine not available');
    return this._withLowerFees(() => LiquidityPoolEngine.createPool({
      tokenA: ptcAddress,
      tokenB: pairedAddress,
      amountA: seedPtc,
      amountB: seedPaired,
      decimalsA: 18,
      decimalsB: pairedDecimals,
    })).then(r => ({ ...r, targetAsset, created: true, mode: 'live' }));
  }

  static _resolvePairedAddress(targetAsset) {
    const cfg = this.getConfig();
    const t = String(targetAsset).toUpperCase();
    if (t === 'DAI') return cfg.daiAddress || '0x6B175474E89094C44Da98b954EedeAC495271d0F';
    if (t === 'USDC') return cfg.usdcAddress || '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    if (t === 'USDS') return cfg.usdsAddress || '0xDC035D45d973E3EC169d2276DDab16f1e407384F';
    if (t === 'WETH' || t === 'ETH') return cfg.wethAddress || DEFAULT_WETH;
    if (t.startsWith('0X')) return targetAsset;
    return '';
  }

  static async seedPool({ tokenA, tokenB, amountA, amountB, decimalsA = 18, decimalsB = 18, poolAddress, createIfMissing = true } = {}) {
    const cfg = this.getConfig();
    if (cfg.shadow) return { poolAddress: poolAddress || `shadow-pool-${Date.now()}`, mode: 'shadow' };
    if (!tokenA || !tokenB || amountA === undefined || amountB === undefined) throw new Error('tokenA, tokenB, amountA, amountB required');
    if (!poolAddress) {
      const existing = await this.findPool({ tokenA, tokenB });
      if (existing && existing.pool_address) poolAddress = existing.pool_address;
    }
    if (!poolAddress && createIfMissing) {
      if (!LiquidityPoolEngine) throw new Error('LiquidityPoolEngine not available');
      return this._withLowerFees(() => LiquidityPoolEngine.createPool({ tokenA, tokenB, amountA, amountB, decimalsA, decimalsB }));
    }
    if (!poolAddress) throw new Error('poolAddress required or pool not found');
    if (!LiquidityPoolEngine) throw new Error('LiquidityPoolEngine not available');
    return this._withLowerFees(() => LiquidityPoolEngine.addLiquidity({ poolAddress, tokenA, tokenB, amountA, amountB, decimalsA, decimalsB }));
  }
}

module.exports = { SeedLiquidityEngine };
