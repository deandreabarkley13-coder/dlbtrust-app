'use strict';

/**
 * Master Wallet Engine
 *
 * Creates and manages the trust's system-level master wallets:
 *   - Principal Token Master      (bond principal tokens / SIT)
 *   - Interest Income Master      (accrued interest tokens / SIT)
 *   - Trust Operating Wallet      (day-to-day trust ops)
 *   - Income Distribution Master  (swapped stablecoin ready for payouts)
 *
 * All master wallets support internal ledger transfers and external on-chain
 * sends. Fixed-income interest is automatically swapped to DLBUSD/USDC (or ETH
 * if no USDC pool exists) and swept to the Income Distribution Master Wallet.
 */

const { WalletEngine } = require('./walletEngine');
let BondEngine, LiveBondEngine, StablecoinDexEngine, EmailEngine, DistributionRequestEngine, DappEngine;
function loadDeps() {
  try { BondEngine = require('../bonds/bondEngine').BondEngine; } catch (e) { BondEngine = null; }
  try { LiveBondEngine = require('../bonds/liveEngine').LiveBondEngine; } catch (e) { LiveBondEngine = null; }
  try { StablecoinDexEngine = require('./stablecoinDexEngine').StablecoinDexEngine; } catch (e) { StablecoinDexEngine = null; }
  try { EmailEngine = require('./emailEngine').EmailEngine; } catch (e) { EmailEngine = null; }
  try { DistributionRequestEngine = require('./distributionRequestEngine').DistributionRequestEngine; } catch (e) { DistributionRequestEngine = null; }
  try { DappEngine = require('./dappEngine').DappEngine; } catch (e) { DappEngine = null; }
}
loadDeps();

const MASTER_DEFS = [
  { subtype: 'principal', name: 'Principal Token Master', description: 'Holds tokenized bond principal' },
  { subtype: 'interest', name: 'Interest Income Master', description: 'Holds tokenized interest income' },
  { subtype: 'operating', name: 'Trust Operating Wallet', description: 'Trust operations and expenses' },
  { subtype: 'distribution', name: 'Income Distribution Master', description: 'Stablecoin ready for beneficiary payouts' },
];

const GAS_SEED_ETH = process.env.MASTER_WALLET_GAS_SEED ? Number(process.env.MASTER_WALLET_GAS_SEED) : 0.003;

class MasterWalletEngine {

  static async ensureMasterWallets() {
    await WalletEngine.ensureTables();
    const systemUser = await WalletEngine.getSystemUser();
    const wallets = [];
    for (const def of MASTER_DEFS) {
      let wallet = await WalletEngine.getWalletBySubtype(def.subtype);
      if (!wallet) {
        wallet = await WalletEngine.createWallet({
          userId: systemUser.id,
          name: def.name,
          type: 'internal',
          subtype: def.subtype,
          metadata: { description: def.description, isMaster: true },
        });
        try {
          await WalletEngine.fundWalletEth({ walletId: wallet.id, amountEth: GAS_SEED_ETH });
        } catch (e) {
          console.warn(`[MasterWalletEngine] Could not fund ${def.subtype} gas:`, e.message);
        }
      }
      wallets.push(wallet);
    }
    return wallets;
  }

  static async getMasterWallet(subtype) {
    await WalletEngine.ensureTables();
    return WalletEngine.getWalletBySubtype(subtype);
  }

  static async getAll() {
    const result = {};
    for (const def of MASTER_DEFS) {
      const wallet = await this.getMasterWallet(def.subtype);
      if (wallet) result[def.subtype] = { ...wallet, balances: await WalletEngine.getBalance(wallet.id) };
    }
    return result;
  }

  static async getDistributionWallet() {
    return this.getMasterWallet('distribution');
  }

  static async transfer({ fromSubtype, toSubtype, amount, asset = 'SIT', memo } = {}) {
    const fromWallet = await this.getMasterWallet(fromSubtype);
    const toWallet = await this.getMasterWallet(toSubtype);
    if (!fromWallet || !toWallet) throw new Error('Master wallet not found');
    return WalletEngine.transfer({ fromWalletId: fromWallet.id, toWalletId: toWallet.id, amount, asset, memo });
  }

  static async externalSend({ fromSubtype, toAddress, amount, asset = 'SIT', tokenAddress, decimals = 6, memo } = {}) {
    const fromWallet = await this.getMasterWallet(fromSubtype);
    if (!fromWallet) throw new Error('Master wallet not found');
    const assetUpper = asset.toUpperCase();
    if (assetUpper === 'SIT') {
      return WalletEngine.externalSend({ fromWalletId: fromWallet.id, toAddress, amount, asset, memo });
    }
    if (assetUpper === 'ETH') {
      return WalletEngine.externalEthSend({ fromWalletId: fromWallet.id, toAddress, amount, memo });
    }
    return WalletEngine.externalTokenSend({ fromWalletId: fromWallet.id, toAddress, amount, asset, tokenAddress: tokenAddress || this._tokenAddress(assetUpper), decimals, memo });
  }

  static _tokenAddress(asset) {
    const { getConfig } = require('./config');
    const cfg = getConfig();
    if (asset === 'USDC') return cfg.usdcAddress;
    if (asset === 'USDS') return cfg.usdsAddress || cfg.usdcAddress;
    if (asset === 'DLBUSD') {
      try { return require('./bondTokenizationEngine').BondTokenizationEngine.getTokenBySymbol('DLBUSD').token_address; } catch (e) { return ''; }
    }
    return '';
  }

  /**
   * Distribute fixed income from a bond.
   * 1. Pay interest on the bond (reduces accrued interest).
   * 2. Mint DLBUSD from Treasury and swap to the target asset (default USDC, fallback ETH).
   * 3. Sweep the output to the Income Distribution Master Wallet and credit its internal ledger.
   */
  static async distributeFixedIncome({ bondId, amount, targetAsset = 'USDC', memo } = {}) {
    if (!BondEngine || !StablecoinDexEngine) throw new Error('BondEngine or StablecoinDexEngine not available');
    if (!bondId) throw new Error('bondId required');

    const distribution = await this.getDistributionWallet();
    if (!distribution) throw new Error('Distribution master wallet not found. Run ensureMasterWallets first.');

    const bond = await BondEngine.getBond(bondId);
    if (!bond) throw new Error(`Bond ${bondId} not found`);

    // Bring accrued interest up to date before paying
    await BondEngine.accrueInterest(bondId, new Date().toISOString().split('T')[0]);
    const live = await LiveBondEngine.getBondLiveMetrics(bondId);
    const payAmount = amount || parseFloat(live.accrued_interest_total);
    if (payAmount <= 0) throw new Error('No fixed income to distribute');

    // 1. Reduce bond accrued interest
    const payResult = await BondEngine.payInterest(bondId, payAmount);

    // 2. Try DLBUSD -> targetAsset swap; fall back to ETH if USDC pool is unavailable
    let swap;
    let usedAsset = targetAsset;
    try {
      swap = await StablecoinDexEngine.depositAndSwap({
        sourceType: 'treasury',
        sourceAccountId: 'TREASURY_HOT',
        amount: payAmount,
        targetAsset,
        recipient: distribution.address,
        createPoolIfMissing: true,
        poolSeedUsdc: 0.005,
        poolSeedDlbusd: 10,
      });
    } catch (firstErr) {
      if (String(targetAsset).toUpperCase() !== 'ETH') {
        console.warn('[MasterWalletEngine] USDC swap failed, falling back to ETH:', firstErr.message);
        usedAsset = 'ETH';
        swap = await StablecoinDexEngine.depositAndSwap({
          sourceType: 'treasury',
          sourceAccountId: 'TREASURY_HOT',
          amount: payAmount,
          targetAsset: 'ETH',
          recipient: distribution.address,
          createPoolIfMissing: true,
          poolSeedUsdc: 0.005,
          poolSeedDlbusd: 10,
        });
      } else {
        throw firstErr;
      }
    }

    // 3. Credit internal ledger of the distribution master wallet
    const outAmount = parseFloat(swap.swap && swap.swap.amountOut || 0);
    if (outAmount > 0) {
      await WalletEngine.credit(distribution.id, usedAsset, outAmount, {
        memo: memo || `Fixed income from bond ${bond.bond_name} (${usedAsset})`,
        bond_id: bondId,
        swap: swap.operationId,
      });
    }

    const result = {
      bond_id: bondId,
      bond_name: bond.bond_name,
      interest_paid: payResult.paid,
      target_asset: usedAsset,
      amount_out: outAmount,
      distribution_wallet: distribution.address,
      swap,
      pay_result: payResult,
    };

    if (EmailEngine) {
      try {
        await EmailEngine.send({
          to: 'deandreabarkley13@gmail.com',
          subject: 'Fixed income distributed to Income Distribution Master Wallet',
          body: `Bond ${bond.bond_name}: $${payResult.paid} interest was swapped to ${usedAsset} and swept to ${distribution.address}.`,
        });
      } catch (e) { console.warn('[MasterWalletEngine] notification error:', e.message); }
    }

    return result;
  }

  /**
   * Spend from the Income Distribution Master Wallet to a beneficiary/user wallet.
   */
  static async spendToWallet({ toWalletId, amount, asset = 'SIT', memo } = {}) {
    const distribution = await this.getDistributionWallet();
    if (!distribution) throw new Error('Distribution master wallet not found');
    return WalletEngine.transfer({ fromWalletId: distribution.id, toWalletId, amount, asset, memo });
  }

  /**
   * Spend from the Income Distribution Master Wallet to an external address.
   */
  static async spendToExternal({ toAddress, amount, asset = 'SIT', memo } = {}) {
    const distribution = await this.getDistributionWallet();
    if (!distribution) throw new Error('Distribution master wallet not found');
    return this.externalSend({ fromSubtype: 'distribution', toAddress, amount, asset, memo });
  }
}

module.exports = { MasterWalletEngine };
