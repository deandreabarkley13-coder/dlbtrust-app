'use strict';

/**
 * Source → DEX Bridge
 *
 * Converts legacy source-of-funds ledger balances into on-chain tokens and swaps
 * them on a DEX for USDC/ETH so the operator Safe can be funded with real crypto.
 *
 * Current support:
 *   - bond / fixed_income: tokenize bond principal, mint bond tokens, use/create a
 *     BondDex pool, swap for the target asset (USDC or WETH).
 *
 * Non-bond sources (cash, trust, sub_ledger, core_banking) are fiat accounting
 * entries and cannot be directly tokenized; the bridge records a deposit to the
 * stablecoin treasury (internal backing) and returns a `requires_off_ramp` step.
 *
 * Real mainnet swaps require:
 *   - the bond token deployed and minted
 *   - a DEX pool with a counterparty / liquidity provider
 *   - gas in the operator wallet
 */

const { getConfig } = require('./config');
const { SourceOfFundsAdapter } = require('../stablecoin/sourceOfFundsAdapter');

let viem, privateKeyToAccount;
try { ({ default: viem, privateKeyToAccount } = require('viem')); } catch (e) { }

let BondEngine = null;
try { BondEngine = require('../bonds/bondEngine').BondEngine; } catch (e) { /* optional */ }

let BondTokenizationEngine = null;
try { BondTokenizationEngine = require('./bondTokenizationEngine').BondTokenizationEngine; } catch (e) { /* optional */ }

let DexSwapEngine = null;
try { DexSwapEngine = require('./dexSwapEngine').DexSwapEngine; } catch (e) { /* optional */ }

let SafeEngine = null;
try { SafeEngine = require('./safeEngine').SafeEngine; } catch (e) { /* optional */ }

function identifier(prefix = 'SDB') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function getOperatorAddress(cfg) {
  try {
    if (SafeEngine && cfg.privateKey) return SafeEngine._account().address;
  } catch (e) { /* fall through */ }
  try {
    if (viem && privateKeyToAccount && cfg.privateKey) return privateKeyToAccount(cfg.privateKey).address;
  } catch (e) { /* fall through */ }
  return '';
}

function jsonbValue(raw) {
  if (raw == null) return {};
  if (typeof raw === 'string') return JSON.parse(raw || '{}');
  return raw;
}

class SourceToDexBridge {
  static readiness() {
    return {
      bondTokenization: !!BondTokenizationEngine,
      dexSwap: !!DexSwapEngine,
      safeEngine: !!SafeEngine,
      bondEngine: !!BondEngine,
    };
  }

  /**
   * Fund the operator wallet / Safe from a source-of-funds ledger via DEX.
   * Returns a funding operation record; on mainnet the actual target asset only
   * lands if the DEX pool has a buyer / liquidity.
   */
  static async fundSafeFromSource({
    sourceType,
    sourceAccountId,
    amount,
    targetAsset = 'USDC',
    safeId,
    poolAddress,
    createPoolIfMissing = false,
    poolSeedAmount,
    issuanceId = null,
  } = {}) {
    sourceType = String(sourceType || '').toLowerCase();
    if (!sourceType || !sourceAccountId || !amount) throw new Error('sourceType, sourceAccountId, and amount are required');
    const amountNum = Number(amount);
    if (amountNum <= 0) throw new Error('amount must be positive');
    const amountCents = Math.round(amountNum * 100);

    const operationId = identifier('SDB');
    const cfg = getConfig();
    const operatorAddress = getOperatorAddress(cfg);

    // 1. Reserve the source ledger balance
    const sweep = await SourceOfFundsAdapter._fundSourceToTreasury({
      sourceType,
      sourceAccountId,
      paymentId: operationId,
      amountCents,
    });

    // 2. Bond / fixed income → tokenize + DEX swap
    if (sourceType === 'bond' || sourceType === 'fixed_income') {
      if (!BondEngine || !BondTokenizationEngine || !DexSwapEngine) {
        throw new Error('Bond tokenization/DEX engines not available');
      }

      const bond = await BondEngine.getBond(sourceAccountId);
      if (!bond) throw new Error(`Bond not found: ${sourceAccountId}`);

      const target = String(targetAsset).toUpperCase();
      const isEth = target === 'ETH' || target === 'WETH';
      const tokenOut = isEth ? (cfg.wethAddress || '') : (cfg.usdcAddress || '');
      if (!tokenOut) throw new Error(`Target asset ${targetAsset} has no token address configured`);
      const decimalsOut = isEth ? 18 : 6;

      // Find or create the bond token for this bond
      let token = await BondTokenizationEngine.getTokenByBondId(sourceAccountId);
      if (!token) {
        token = await BondTokenizationEngine.createToken({
          bondId: sourceAccountId,
          tokenName: `${bond.bond_name} Token`,
          tokenSymbol: `DLB${bond.id}`,
        });
      }
      const tokenMeta = jsonbValue(token.metadata);
      const decimalsIn = tokenMeta.decimals ? Number(tokenMeta.decimals) : 6;

      // Mint the tokenized amount to the operator wallet
      const mint = await BondTokenizationEngine.mint({
        issuanceId,
        expect: { tokenId: token.id, principalCents: amountCents, holderAddress: operatorAddress },
      });

      // Resolve pool address: explicit > auto-create > missing
      let resolvedPool = poolAddress || '';
      let poolCreated = false;
      let poolInfo = null;

      if (!resolvedPool && createPoolIfMissing) {
        const seed = Number(poolSeedAmount);
        if (!seed || seed <= 0) {
          throw new Error('poolSeedAmount required to create a new DEX pool');
        }
        poolInfo = await DexSwapEngine.createPool({
          tokenA: token.token_address,
          tokenB: tokenOut,
          amountA: amountNum,
          amountB: seed,
          decimalsA: decimalsIn,
          decimalsB: decimalsOut,
        });
        resolvedPool = poolInfo.poolAddress || '';
        poolCreated = !!resolvedPool;
      }

      // Quote / swap if a pool exists, otherwise report needs_pool
      let quote = null;
      let swap = null;
      let swapError = null;

      if (resolvedPool) {
        try {
          quote = await DexSwapEngine.quote({
            tokenIn: token.token_address,
            tokenOut,
            amountIn: amountNum,
            decimalsIn,
            decimalsOut,
            router: resolvedPool,
          });

          swap = await DexSwapEngine.swap({
            tokenIn: token.token_address,
            tokenOut,
            amountIn: amountNum,
            amountOutMinimum: quote.amountOutMinimum,
            decimalsIn,
            decimalsOut,
            router: resolvedPool,
            recipient: operatorAddress,
          });
        } catch (err) {
          swapError = err.message;
        }
      }

      return {
        operationId,
        sourceType,
        sourceAccountId,
        amount,
        targetAsset: target,
        sweep,
        token: {
          tokenId: token.id,
          tokenAddress: token.token_address,
          minted: mint.minted,
          mintTxHash: mint.txHash,
        },
        pool: {
          poolAddress: resolvedPool,
          created: poolCreated,
          createInfo: poolInfo,
        },
        quote,
        swap,
        swapError,
        status: swap && swap.txHash ? 'swapped' : (resolvedPool ? 'quoted' : 'needs_pool'),
        operatorAddress,
        safeId: safeId || null,
        note: swap && swap.txHash
          ? `Bond ledger balance tokenized and swapped on-chain. Net new ${target} only arrived if the pool was funded by a counterparty/LP.`
          : 'No pool available. Provide poolAddress or set createPoolIfMissing with poolSeedAmount (requires the operator wallet to hold the target asset for seeding).',
      };
    }

    // 3. Cash / trust / sub_ledger / core_banking are fiat-accounting ledgers.
    return {
      operationId,
      sourceType,
      sourceAccountId,
      amount,
      targetAsset: String(targetAsset).toUpperCase(),
      sweep,
      status: 'requires_off_ramp',
      note: `Source ${sourceType} is an internal ledger balance. To receive real ${String(targetAsset).toUpperCase()} it must be tokenized as a bond, sold through an exchange, or wired through an on-ramp (Coinbase, Circle, etc.). The treasury now holds the internal stablecoin backing.`,
      operatorAddress,
      safeId: safeId || null,
    };
  }
}

module.exports = { SourceToDexBridge };
