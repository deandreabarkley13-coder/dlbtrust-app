'use strict';

/**
 * DEX Swap Engine
 *
 * Provides a minimal Uniswap V3 swap path for tokenized bonds -> USDC.
 * In shadow mode it simulates quotes and returns a shadow tx hash.
 *
 * Real usage needs:
 *  - tokenIn deployed and approved for the Uniswap V3 SwapRouter
 *  - a liquidity pool with tokenIn/USDC (or tokenIn/WETH -> USDC)
 *  - gas in the operator wallet
 */

const { getConfig } = require('./config');

function str(name, fallback = '') { return (process.env[name] || fallback).trim(); }
function bool(name, fallback = false) { const v = process.env[name]; return v ? String(v).toLowerCase() === 'true' : fallback; }
function num(name, fallback = 0) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : fallback; }

// Uniswap V3 SwapRouter02 on mainnet; same on most EVM chains
const SWAP_ROUTER_02 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';

class DexSwapEngine {
  static getConfig() {
    const cfg = getConfig();
    return {
      enabled: bool('DEX_SWAP_ENABLED', true),
      shadow: bool('DEX_SWAP_SHADOW', cfg.dappShadow !== false ? true : cfg.dappShadow),
      chainId: cfg.chainId,
      rpcUrl: cfg.rpcUrl,
      privateKey: cfg.privateKey,
      router: str('DEX_SWAP_ROUTER', SWAP_ROUTER_02),
      usdcAddress: cfg.usdcAddress,
      slippageBps: num('DEX_SLIPPAGE_BPS', 100), // 1%
    };
  }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.enabled) issues.push('DEX_SWAP_ENABLED is not true');
    if (!cfg.shadow) {
      if (!cfg.privateKey) issues.push('DAPP_PRIVATE_KEY not configured');
      if (!cfg.rpcUrl) issues.push('DAPP_RPC_URL not configured');
      if (!str('DEX_SWAP_ROUTER')) issues.push('DEX_SWAP_ROUTER not configured');
    }
    return { ready: issues.length === 0, mode: cfg.shadow ? 'shadow' : 'live', issues };
  }

  /**
   * Return a simulated quote. Real implementation would call the Uniswap V3
   * QuoterV2 contract or an aggregator API.
   */
  static async quote({ tokenIn, tokenOut, amountIn, decimalsIn = 18, decimalsOut = 6, fee = 3000 } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw new Error('DEX swap not enabled');
    const amount = Number(amountIn) || 0;
    if (amount <= 0) throw new Error('amountIn must be positive');

    // Simple constant-product simulation for shadow quoting.
    // amountIn is treated as a human-unit token quantity.
    const price = 0.95 + Math.random() * 0.05;
    const outHuman = amount * price;
    const minOutHuman = outHuman * (1 - cfg.slippageBps / 10000);
    return {
      tokenIn,
      tokenOut: tokenOut || cfg.usdcAddress,
      amountIn: amount,
      amountOut: outHuman.toFixed(decimalsOut),
      amountOutMinimum: minOutHuman.toFixed(decimalsOut),
      fee,
      price,
      mode: cfg.shadow ? 'shadow' : 'live',
    };
  }

  /**
   * Execute an exact-input single swap. Shadow mode returns a synthetic tx hash.
   * Live mode would approve the router and call swapExactInputSingle on
   * Uniswap V3 SwapRouter02.
   */
  static async swap({ tokenIn, tokenOut, amountIn, amountOutMinimum, recipient, fee = 3000, path = null } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw new Error('DEX swap not enabled');
    if (!amountIn || Number(amountIn) <= 0) throw new Error('amountIn required');

    const outputToken = tokenOut || cfg.usdcAddress;
    const quote = await this.quote({ tokenIn, tokenOut: outputToken, amountIn, fee });

    if (cfg.shadow) {
      return {
        status: 'executed',
        mode: 'shadow',
        txHash: `shadow-dex-${Date.now()}`,
        tokenIn,
        tokenOut: outputToken,
        amountIn,
        amountOut: quote.amountOut,
        amountOutMinimum: amountOutMinimum || quote.amountOutMinimum,
        recipient: recipient || 'operator',
        note: 'Shadow DEX swap; real swap requires token approval, liquidity pool, and gas.',
      };
    }

    // Live implementation outline (requires viem wallet client, contract ABIs, and gas)
    throw new Error('Live DEX swap not implemented in this build. Set DEX_SWAP_SHADOW=true to simulate.');
  }
}

module.exports = { DexSwapEngine };
