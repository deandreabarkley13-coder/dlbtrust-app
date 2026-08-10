'use strict';

/**
 * PtcDexEngine
 *
 * Swap DLB-PTCUSD through the BondDex (a Uniswap V2-style pool) into a paired
 * asset such as DAI, or through PTC/WETH -> Uniswap V2 for USDC/USDS/ETH.
 *
 * The engine pairs with SeedLiquidityEngine to create the pool on demand,
 * wraps ETH for WETH seeds, and uses the operator wallet as a gas relayer.
 */

const { getConfig } = require('./config');

let SeedLiquidityEngine, DexSwapEngine, PtcStablecoinEngine;
try { ({ SeedLiquidityEngine } = require('./seedLiquidityEngine')); } catch (e) {}
try { ({ DexSwapEngine } = require('./dexSwapEngine')); } catch (e) {}
try { ({ PtcStablecoinEngine } = require('./ptcStablecoinEngine')); } catch (e) {}

let viem;
try { viem = require('viem'); } catch (e) {}

const DEFAULT_PTC = '0xb01e6280ffe6faac679a17b029df8e065e8d0002';
const DEFAULT_WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

class PtcDexEngine {
  static getConfig() {
    const cfg = getConfig();
    return { ...cfg, enabled: true };
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

  static async getPtcTokenAddress() {
    let addr = process.env.DLB_PTCUSD_ADDRESS || '';
    if (!addr && PtcStablecoinEngine) {
      const info = await PtcStablecoinEngine.info().catch(() => ({}));
      addr = info.tokenAddress || '';
    }
    return addr || DEFAULT_PTC;
  }

  static _pairedAddress(asset) {
    const cfg = this.getConfig();
    const t = String(asset).toUpperCase();
    if (t === 'DAI') return cfg.daiAddress || '0x6B175474E89094C44Da98b954EedeAC495271d0F';
    if (t === 'USDC') return cfg.usdcAddress || '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    if (t === 'USDS') return cfg.usdsAddress || '0xDC035D45d973E3EC169d2276DDab16f1e407384F';
    if (t === 'WETH' || t === 'ETH') return cfg.wethAddress || DEFAULT_WETH;
    if (t.startsWith('0X')) return asset;
    return '';
  }

  static _pairedDecimals(asset) {
    const t = String(asset).toUpperCase();
    return ['WETH', 'ETH', 'DAI', 'USDS'].includes(t) ? 18 : 6;
  }

  static _isNativeEth(asset) { return String(asset).toUpperCase() === 'ETH'; }

  static async _findDirectPool(targetAsset) {
    if (!SeedLiquidityEngine) return null;
    const ptc = await this.getPtcTokenAddress();
    const paired = this._pairedAddress(targetAsset);
    if (!paired) return null;
    return SeedLiquidityEngine.findPool({ tokenA: ptc, tokenB: paired });
  }

  static async _findWethPool() {
    if (!SeedLiquidityEngine) return null;
    const ptc = await this.getPtcTokenAddress();
    const cfg = this.getConfig();
    const weth = cfg.wethAddress || DEFAULT_WETH;
    return SeedLiquidityEngine.findPool({ tokenA: ptc, tokenB: weth });
  }

  static async quote({ amount, targetAsset = 'DAI', autoCreatePool = false, seedPtcAmount = 0.01, seedPairedAmount } = {}) {
    if (!amount || Number(amount) <= 0) throw new Error('amount must be positive');
    if (!DexSwapEngine) throw new Error('DexSwapEngine not available');
    const ptcAddress = await this.getPtcTokenAddress();
    const cfg = this.getConfig();
    const wethAddress = cfg.wethAddress || DEFAULT_WETH;
    const targetUpper = String(targetAsset).toUpperCase();
    const finalAsset = this._isNativeEth(targetAsset) ? 'WETH' : targetAsset;
    const finalAddress = this._pairedAddress(finalAsset);
    if (!finalAddress) throw new Error(`Target asset ${targetAsset} has no token address configured`);

    // Prefer a direct PTC/<target> pool
    let directPool = await this._findDirectPool(finalAsset);
    if (!directPool && autoCreatePool && SeedLiquidityEngine) {
      await SeedLiquidityEngine.ensurePtcPool({
        targetAsset: finalAsset,
        seedPtcAmount: seedPtcAmount || 0.01,
        seedPairedAmount: seedPairedAmount,
      });
      directPool = await this._findDirectPool(finalAsset);
    }

    if (directPool && directPool.pool_address) {
      const poolAddr = directPool.pool_address || directPool.poolAddress;
      const decimalsOut = this._pairedDecimals(finalAsset);
      const q = await DexSwapEngine.quote({
        tokenIn: ptcAddress,
        tokenOut: finalAddress,
        amountIn: amount,
        decimalsIn: 18,
        decimalsOut,
        router: poolAddr,
      });
      const out = Number(q.amountOut) || 0;
      return {
        status: out > 0 ? 'ready' : 'no_liquidity',
        amountOut: q.amountOut,
        amountOutMinimum: q.amountOutMinimum,
        targetAsset: finalAsset,
        poolAddress: poolAddr,
        route: 'direct',
        bondQuote: q,
        instructions: out > 0 ? `Swap ${amount} DLB-PTCUSD for ~${q.amountOut} ${finalAsset} via direct BondDex pool` : 'Direct pool has no liquidity.',
      };
    }

    // Two-leg: PTC/WETH -> Uniswap V2 -> target
    if (finalAsset !== 'WETH') {
      const wethPool = await this._findWethPool();
      if (wethPool && wethPool.pool_address) {
        const poolAddr = wethPool.pool_address || wethPool.poolAddress;
        const q1 = await DexSwapEngine.quote({ tokenIn: ptcAddress, tokenOut: wethAddress, amountIn: amount, decimalsIn: 18, decimalsOut: 18, router: poolAddr });
        if (Number(q1.amountOut) > 0) {
          const decimalsOut = this._pairedDecimals(finalAsset);
          const q2 = await DexSwapEngine.quoteUniswapV2({
            tokenIn: wethAddress,
            tokenOut: finalAddress,
            amountIn: q1.amountOut,
            decimalsIn: 18,
            decimalsOut,
            path: [wethAddress, finalAddress],
          });
          return {
            status: Number(q2.amountOut) > 0 ? 'ready' : 'no_liquidity',
            amountOut: q2.amountOut,
            amountOutMinimum: q2.amountOutMinimum,
            targetAsset: finalAsset,
            poolAddress: poolAddr,
            route: 'two_leg',
            bondQuote: q1,
            uniQuote: q2,
            instructions: `Swap ${amount} DLB-PTCUSD for ~${q2.amountOut} ${finalAsset} via PTC/WETH BondDex + Uniswap V2`,
          };
        }
      }
    }

    return {
      status: 'needs_liquidity',
      amountOut: 0,
      targetAsset: finalAsset,
      route: 'none',
      instructions: `No PTC/${finalAsset} or PTC/WETH BondDex pool found. Seed liquidity first.`,
    };
  }

  static async swap({ amount, targetAsset = 'DAI', recipient, autoSeed = false, seedPtcAmount = 0.01, seedPairedAmount, minOut } = {}) {
    if (!amount || Number(amount) <= 0) throw new Error('amount must be positive');
    if (!DexSwapEngine) throw new Error('DexSwapEngine not available');
    return this._withLowerFees(async () => {
    const cfg = this.getConfig();
    const ptcAddress = await this.getPtcTokenAddress();
    const finalAsset = this._isNativeEth(targetAsset) ? 'WETH' : targetAsset;
    const finalAddress = this._pairedAddress(finalAsset);
    if (!finalAddress) throw new Error(`Target asset ${targetAsset} has no token address configured`);
    const operatorAddress = cfg.operatorAddress || (SeedLiquidityEngine ? (await SeedLiquidityEngine._operatorAddress()) : '');
    const finalRecipient = recipient || operatorAddress;

    // Ensure pool exists if autoSeed requested
    if (autoSeed && SeedLiquidityEngine) {
      await SeedLiquidityEngine.ensurePtcPool({
        targetAsset: finalAsset,
        seedPtcAmount: seedPtcAmount || 0.01,
        seedPairedAmount: seedPairedAmount,
      });
    }

    const directPool = await this._findDirectPool(finalAsset);
    if (directPool && directPool.pool_address) {
      const poolAddr = directPool.pool_address || directPool.poolAddress;
      const decimalsOut = this._pairedDecimals(finalAsset);
      const quote = await DexSwapEngine.quote({ tokenIn: ptcAddress, tokenOut: finalAddress, amountIn: amount, decimalsIn: 18, decimalsOut, router: poolAddr });
      const outMin = minOut || quote.amountOutMinimum;
      const bondSwap = await DexSwapEngine.swap({
        tokenIn: ptcAddress,
        tokenOut: finalAddress,
        amountIn: amount,
        amountOutMinimum: outMin,
        decimalsIn: 18,
        decimalsOut,
        router: poolAddr,
        recipient: finalRecipient,
      });
      const result = { status: 'executed', amountOut: bondSwap.amountOut, bondSwap, route: 'direct', recipient: finalRecipient };
      if (this._isNativeEth(targetAsset)) result.unwrap = await this._unwrapWeth(bondSwap.amountOut, finalRecipient);
      return result;
    }

    // Two-leg PTC/WETH -> Uniswap V2 -> target
    if (finalAsset !== 'WETH') {
      const wethPool = await this._findWethPool();
      if (!wethPool || !wethPool.pool_address) throw new Error(`No PTC/${finalAsset} or PTC/WETH pool found. Seed liquidity first.`);
      const poolAddr = wethPool.pool_address || wethPool.poolAddress;
      const q1 = await DexSwapEngine.quote({ tokenIn: ptcAddress, tokenOut: cfg.wethAddress || DEFAULT_WETH, amountIn: amount, decimalsIn: 18, decimalsOut: 18, router: poolAddr });
      const bondSwap = await DexSwapEngine.swap({
        tokenIn: ptcAddress,
        tokenOut: cfg.wethAddress || DEFAULT_WETH,
        amountIn: amount,
        amountOutMinimum: q1.amountOutMinimum,
        decimalsIn: 18,
        decimalsOut: 18,
        router: poolAddr,
        recipient: operatorAddress,
      });
      const decimalsOut = this._pairedDecimals(finalAsset);
      const q2 = await DexSwapEngine.quoteUniswapV2({ tokenIn: cfg.wethAddress || DEFAULT_WETH, tokenOut: finalAddress, amountIn: bondSwap.amountOut, decimalsIn: 18, decimalsOut, path: [cfg.wethAddress || DEFAULT_WETH, finalAddress] });
      const outMin = minOut || q2.amountOutMinimum;
      const uniSwap = await DexSwapEngine.swapOnUniswapV2({
        tokenIn: cfg.wethAddress || DEFAULT_WETH,
        tokenOut: finalAddress,
        amountIn: bondSwap.amountOut,
        amountOutMinimum: outMin,
        decimalsIn: 18,
        decimalsOut,
        recipient: finalRecipient,
        path: [cfg.wethAddress || DEFAULT_WETH, finalAddress],
      });
      const result = { status: 'executed', amountOut: uniSwap.amountOut, bondSwap, uniSwap, route: 'two_leg', recipient: finalRecipient };
      if (this._isNativeEth(targetAsset)) result.unwrap = await this._unwrapWeth(uniSwap.amountOut, finalRecipient);
      return result;
    }

    throw new Error(`Cannot find or create a PTC/${finalAsset} pool`);
    });
  }

  static async _unwrapWeth(amount, recipient) {
    if (!viem) return { skipped: true };
    const cfg = this.getConfig();
    if (!cfg.wethAddress) return { skipped: true, reason: 'no_weth_address' };
    const { wallet, publicClient, fees } = SeedLiquidityEngine ? SeedLiquidityEngine._walletClient() : (() => { throw new Error('SeedLiquidityEngine not available'); })();
    const raw = viem.parseUnits(String(amount), 18);
    const hash = await wallet.writeContract({
      address: cfg.wethAddress,
      abi: [{ type: 'function', name: 'withdraw', inputs: [{ type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' }],
      functionName: 'withdraw',
      args: [raw],
      gas: 100000n,
      ...fees,
    });
    await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    return { unwrapped: amount, txHash: hash, recipient };
  }
}

module.exports = { PtcDexEngine };
