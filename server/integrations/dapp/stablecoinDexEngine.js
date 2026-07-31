'use strict';

/**
 * Stablecoin DEX Engine
 *
 * Mints a DLBUSD ERC-20 stablecoin from any source-of-funds ledger and swaps it
 * on a DEX for USDC or USDS. The operator hot wallet / relayer pays gas, so the
 * dApp user does not need native tokens ("gasless" experience).
 */

const { getConfig } = require('./config');
const { SourceOfFundsAdapter } = require('../stablecoin/sourceOfFundsAdapter');

let BondTokenizationEngine = null;
try { BondTokenizationEngine = require('./bondTokenizationEngine').BondTokenizationEngine; } catch (e) { /* optional */ }

let DexSwapEngine = null;
try { DexSwapEngine = require('./dexSwapEngine').DexSwapEngine; } catch (e) { /* optional */ }

let viem, privateKeyToAccount;
try { ({ default: viem, privateKeyToAccount } = require('viem')); } catch (e) { }

function str(name, fallback = '') { return (process.env[name] || fallback).trim(); }
function bool(name, fallback = false) { const v = process.env[name]; return v ? String(v).toLowerCase() === 'true' : fallback; }

function id(prefix = 'SDEX') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }

function getOperatorAddress(cfg) {
  try {
    if (viem && privateKeyToAccount && cfg.privateKey) return privateKeyToAccount(cfg.privateKey).address;
  } catch (e) { /* fall through */ }
  return str('DAPP_OPERATOR_ADDRESS', '');
}

class StablecoinDexEngine {
  static getConfig() {
    const cfg = getConfig();
    return {
      enabled: bool('STABLECOIN_DEX_ENABLED', true),
      shadow: bool('STABLECOIN_DEX_SHADOW', cfg.dappShadow !== false ? true : cfg.dappShadow),
      chainId: cfg.chainId,
      rpcUrl: cfg.rpcUrl,
      privateKey: cfg.privateKey,
      usdcAddress: cfg.usdcAddress,
      usdsAddress: str('DAPP_USDS_ADDRESS', ''),
      operatorAddress: cfg.operatorAddress || getOperatorAddress(cfg),
      slippageBps: Number(str('STABLECOIN_DEX_SLIPPAGE_BPS', '100')) || 100,
    };
  }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.enabled) issues.push('STABLECOIN_DEX_ENABLED is not true');
    if (!cfg.shadow) {
      if (!cfg.privateKey) issues.push('DAPP_PRIVATE_KEY not configured');
      if (!cfg.rpcUrl) issues.push('DAPP_RPC_URL not configured');
      if (!cfg.usdcAddress) issues.push('DAPP_USDC_ADDRESS not configured');
      if (!BondTokenizationEngine) issues.push('BondTokenizationEngine not available');
      if (!DexSwapEngine) issues.push('DexSwapEngine not available');
    }
    return { ready: issues.length === 0, mode: cfg.shadow ? 'shadow' : 'live', issues };
  }

  static async getOrCreateDLBUSDToken() {
    if (!BondTokenizationEngine) throw new Error('BondTokenizationEngine not available');
    let token = await BondTokenizationEngine.getTokenBySymbol('DLBUSD');
    if (!token) {
      token = await BondTokenizationEngine.createToken({
        tokenName: 'DLBUSD',
        tokenSymbol: 'DLBUSD',
        decimals: 6,
      });
    }
    return token;
  }

  static targetTokenAddress(targetAsset) {
    const cfg = this.getConfig();
    const t = String(targetAsset).toUpperCase();
    if (t === 'USD' || t === 'USDC') return cfg.usdcAddress;
    if (t === 'USDS') return cfg.usdsAddress || cfg.usdcAddress;
    if (t === 'ETH' || t === 'WETH') return cfg.wethAddress || '';
    return '';
  }

  static async quote({ amount, targetAsset = 'USDC', poolAddress }) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw new Error('Stablecoin DEX not enabled');
    if (!amount || Number(amount) <= 0) throw new Error('amount must be positive');
    const token = await this.getOrCreateDLBUSDToken();
    const tokenOut = this.targetTokenAddress(targetAsset);
    if (!tokenOut) throw new Error(`Target asset ${targetAsset} has no token address configured`);
    const quote = await DexSwapEngine.quote({
      tokenIn: token.token_address,
      tokenOut,
      amountIn: amount,
      decimalsIn: 6,
      decimalsOut: 6,
      router: poolAddress,
    });
    return { tokenIn: token.token_address, tokenOut, ...quote };
  }

  static async createPool({ seedUsdcAmount = 0.2, seedDlbusdAmount = 0.2, targetAsset = 'USDC' } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw new Error('Stablecoin DEX not enabled');
    if (cfg.shadow) return { poolAddress: `shadow-pool-dlbusd-${Date.now()}`, mode: 'shadow' };
    const token = await this.getOrCreateDLBUSDToken();
    const tokenOut = this.targetTokenAddress(targetAsset);
    if (!tokenOut) throw new Error(`Target asset ${targetAsset} has no token address configured`);

    // First mint the seed DLBUSD to the operator wallet (no source debit; comes from treasury backing)
    await BondTokenizationEngine.mint({ tokenId: token.id, principal: seedDlbusdAmount, holderAddress: cfg.operatorAddress });

    return DexSwapEngine.createPool({
      tokenA: token.token_address,
      tokenB: tokenOut,
      amountA: seedDlbusdAmount,
      amountB: seedUsdcAmount,
      decimalsA: 6,
      decimalsB: 6,
    });
  }

  static async mintFromSource({ sourceType, sourceAccountId, amount, targetAddress } = {}) {
    if (!sourceType || !sourceAccountId || !amount) throw new Error('sourceType, sourceAccountId, and amount are required');
    const amountNum = Number(amount);
    if (amountNum <= 0) throw new Error('amount must be positive');
    const amountCents = Math.round(amountNum * 100);
    const cfg = this.getConfig();
    const operationId = id();

    // Reserve the source-of-funds ledger balance into the treasury
    const sweep = await SourceOfFundsAdapter._fundSourceToTreasury({
      sourceType,
      sourceAccountId,
      paymentId: operationId,
      amountCents,
    });

    const token = await this.getOrCreateDLBUSDToken();
    const holder = targetAddress || cfg.operatorAddress;
    const mint = await BondTokenizationEngine.mint({
      tokenId: token.id,
      principal: amountNum,
      holderAddress: holder,
    });

    return {
      operationId,
      sourceType,
      sourceAccountId,
      amount,
      tokenAddress: token.token_address,
      minted: mint.minted,
      mintTxHash: mint.txHash,
      sweep,
      holder,
    };
  }

  static async swap({ amount, targetAsset = 'USDC', poolAddress, recipient, minOut } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw new Error('Stablecoin DEX not enabled');
    const amountNum = Number(amount);
    if (amountNum <= 0) throw new Error('amount must be positive');
    const token = await this.getOrCreateDLBUSDToken();
    const tokenOut = this.targetTokenAddress(targetAsset);
    if (!tokenOut) throw new Error(`Target asset ${targetAsset} has no token address configured`);

    const quote = await DexSwapEngine.quote({
      tokenIn: token.token_address,
      tokenOut,
      amountIn: amount,
      decimalsIn: 6,
      decimalsOut: 6,
      router: poolAddress,
    });

    const swap = await DexSwapEngine.swap({
      tokenIn: token.token_address,
      tokenOut,
      amountIn: amount,
      amountOutMinimum: minOut || quote.amountOutMinimum,
      decimalsIn: 6,
      decimalsOut: 6,
      router: poolAddress,
      recipient: recipient || cfg.operatorAddress,
    });

    return { quote, swap };
  }

  static async depositAndSwap({
    sourceType,
    sourceAccountId,
    amount,
    targetAsset = 'USDC',
    recipient,
    poolAddress,
    createPoolIfMissing = false,
    poolSeedUsdc = 0.2,
    poolSeedDlbusd = 0.2,
  } = {}) {
    if (!sourceType || !sourceAccountId || !amount) throw new Error('sourceType, sourceAccountId, and amount are required');
    const cfg = this.getConfig();
    const operationId = id('DLBUSD-SWAP');
    const amountNum = Number(amount);

    // 1. Mint DLBUSD from the chosen source ledger
    const mint = await this.mintFromSource({ sourceType, sourceAccountId, amount, targetAddress: cfg.operatorAddress });

    // 2. Resolve or create the DEX pool
    let resolvedPool = poolAddress;
    let poolInfo = null;
    if (!resolvedPool && createPoolIfMissing) {
      poolInfo = await this.createPool({ seedUsdcAmount: poolSeedUsdc, seedDlbusdAmount: poolSeedDlbusd, targetAsset });
      resolvedPool = poolInfo && poolInfo.poolAddress;
    }
    if (!resolvedPool) throw new Error('No DEX pool address provided and createPoolIfMissing is false');

    // 3. Execute the DEX swap (operator relayer pays gas; user is gasless)
    const { quote, swap } = await this.swap({
      amount,
      targetAsset,
      poolAddress: resolvedPool,
      recipient: recipient || cfg.operatorAddress,
    });

    return {
      operationId,
      sourceType,
      sourceAccountId,
      amount,
      targetAsset,
      tokenAddress: mint.tokenAddress,
      minted: mint.minted,
      mintTxHash: mint.mintTxHash,
      poolAddress: resolvedPool,
      poolCreated: !!poolInfo,
      quote,
      swap,
      recipient: recipient || cfg.operatorAddress,
      mode: cfg.shadow ? 'shadow' : 'live',
      note: cfg.shadow
        ? 'Shadow swap completed. Real on-chain swap requires a deployed DLBUSD token, a funded DEX pool, and gas in the operator wallet.'
        : 'DLBUSD minted from source ledger and swapped on the DEX. The operator relayer paid gas; the user did not need native tokens.',
    };
  }
}

module.exports = { StablecoinDexEngine };
