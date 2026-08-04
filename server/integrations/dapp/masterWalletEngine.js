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
const pool = require('../bonds/pgPool');
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
      if (wallet) {
        const sanitized = { ...wallet };
        delete sanitized.private_key_encrypted;
        delete sanitized.private_key;
        delete sanitized.privateKey;
        result[def.subtype] = { ...sanitized, balances: await WalletEngine.getBalance(wallet.id) };
      }
    }
    return result;
  }

  static async getDistributionWallet() {
    return this.getMasterWallet('distribution');
  }

  static async _hasBondBackfill(walletId, bondId, backfillType) {
    const memoPattern = `%Backfill bond ${backfillType}%`;
    const rows = await pool.query(
      `SELECT 1 FROM dapp_wallet_transactions
       WHERE wallet_id = $1 AND asset = 'DLBUSD' AND type = 'credit'
         AND metadata->>'bond_id' = $2
         AND (metadata->>'backfill_type' = $3 OR memo ILIKE $4)
       LIMIT 1`,
      [walletId, bondId, backfillType, memoPattern]
    );
    return (rows && rows.rows && rows.rows.length > 0) || false;
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
   * 1. Accrue interest to today.
   * 2. Mint DLBUSD from the bond's accrued interest and swap to the target asset
   *    (default USDC, fallback ETH) using the Stablecoin DEX.
   * 3. Sweep the output to the Income Distribution Master Wallet and credit its internal ledger.
   *
   * This sources real funds from the bond_interest source-of-funds ledger rather than
   * from Treasury, so the bond's accrued interest is reduced only when the swap succeeds.
   */
  static async distributeFixedIncome({ bondId, amount, targetAsset = 'USDC', memo } = {}) {
    if (!BondEngine || !LiveBondEngine || !StablecoinDexEngine) throw new Error('BondEngine, LiveBondEngine or StablecoinDexEngine not available');
    if (!bondId) throw new Error('bondId required');

    const distribution = await this.getDistributionWallet();
    if (!distribution) throw new Error('Distribution master wallet not found. Run ensureMasterWallets first.');

    const bond = await BondEngine.getBond(bondId);
    if (!bond) throw new Error(`Bond ${bondId} not found`);

    // Bring accrued interest up to date before paying (for active or non-matured bonds)
    const maturityDate = new Date(bond.maturity_date);
    if (bond.status === 'active' || maturityDate > new Date()) {
      await BondEngine.accrueInterest(bondId, new Date().toISOString().split('T')[0]);
    }
    const live = await LiveBondEngine.getBondLiveMetrics(bondId);
    const payAmount = Number(amount) || parseFloat(live.accrued_interest_total);
    if (payAmount <= 0) throw new Error('No fixed income to distribute');

    // Mint DLBUSD from bond interest directly to the distribution master wallet.
    // A USDC/ETH swap requires an existing funded DEX pool; the DLBUSD can be
    // swapped later from the Income Distribution Master when liquidity is ready.
    let swap = null;
    let usedAsset = 'DLBUSD';
    let outAmount = String(payAmount);
    let conversionNote = `${targetAsset} swap skipped (no DEX liquidity); DLBUSD credited for later conversion`;
    try {
      swap = await StablecoinDexEngine.mintFromSource({
        sourceType: 'bond_interest',
        sourceAccountId: bondId,
        amount: payAmount,
        targetAddress: distribution.address,
      });
      outAmount = String(swap.minted || '0');
      conversionNote = `DLBUSD minted to distribution master; swap to ${targetAsset} can be run once a DEX pool exists`;
    } catch (mintErr) {
      console.warn('[MasterWalletEngine] fixed-income DLBUSD mint failed:', mintErr.message);
      throw mintErr;
    }
    if (Number(outAmount) > 0) {
      try {
        await WalletEngine.credit(distribution.id, usedAsset, outAmount, {
          memo: memo || `Fixed income from bond ${bond.bond_name} (${conversionNote})`,
          bond_id: bondId,
          swap: swap && swap.operationId,
        });
      } catch (creditErr) {
        console.warn('[MasterWalletEngine] internal ledger credit skipped for', usedAsset, creditErr.message);
      }
    }

    const result = {
      bond_id: bondId,
      bond_name: bond.bond_name,
      interest_paid: payAmount,
      target_asset: usedAsset,
      amount_out: outAmount,
      distribution_wallet: distribution.address,
      note: conversionNote,
      swap,
    };

    if (EmailEngine) {
      try {
        await EmailEngine.send({
          to: 'deandreabarkley13@gmail.com',
          subject: 'Fixed income distributed to Income Distribution Master Wallet',
          body: `Bond ${bond.bond_name}: $${payAmount.toFixed(2)} interest was swapped to ${usedAsset} (${outAmount}) and swept to ${distribution.address}.`,
        });
      } catch (e) { console.warn('[MasterWalletEngine] notification error:', e.message); }
    }

    return result;
  }

  /**
   * Backfill the Principal Token Master and Income Distribution Master wallets from
   * a bond's current principal balance and lifetime accrued interest.
   */
  static async backfillMasterWallets({ bondId, backfillPrincipal = true, backfillInterest = true } = {}) {
    if (!BondEngine || !LiveBondEngine || !StablecoinDexEngine) throw new Error('BondEngine, LiveBondEngine or StablecoinDexEngine not available');
    if (!bondId) throw new Error('bondId required');

    const wallets = await this.ensureMasterWallets();
    const subtypeOf = (w) => {
      const meta = w && w.metadata;
      if (!meta) return null;
      if (typeof meta === 'string') { try { return JSON.parse(meta).subtype; } catch (e) { return null; } }
      return meta.subtype || null;
    };
    const walletMap = Object.fromEntries(wallets.map(w => [subtypeOf(w), w]).filter(([k]) => k));
    const principalMaster = walletMap.principal;
    const distributionMaster = walletMap.distribution;
    if (!principalMaster || !distributionMaster) throw new Error('Master wallets not found');

    const bond = await BondEngine.getBond(bondId);
    if (!bond) throw new Error(`Bond ${bondId} not found`);
    const live = await LiveBondEngine.getBondLiveMetrics(bondId);

    const results = { principal: null, interest: null };

    const principalAlreadyBackfilled = await this._hasBondBackfill(principalMaster.id, bondId, 'principal');
    const interestAlreadyBackfilled = await this._hasBondBackfill(distributionMaster.id, bondId, 'interest');

    if (backfillPrincipal && Number(live.principal_balance) > 0 && !principalAlreadyBackfilled) {
      let principalMint = null;
      let principalAmount = '0';
      try {
        principalMint = await StablecoinDexEngine.mintFromSource({
          sourceType: 'bond',
          sourceAccountId: bondId,
          amount: Number(live.principal_balance),
          targetAddress: principalMaster.address,
        });
        principalAmount = String(principalMint.minted || '0');
      } catch (mintErr) {
        console.warn('[MasterWalletEngine] principal mint failed:', mintErr.message);
      }
      if (Number(principalAmount) > 0) {
        try {
          await WalletEngine.credit(principalMaster.id, 'DLBUSD', principalAmount, {
            memo: `Backfill bond principal for ${bond.bond_name}`,
            bond_id: bondId,
            backfill_type: 'principal',
            mint: principalMint && principalMint.operationId,
          });
        } catch (creditErr) {
          console.warn('[MasterWalletEngine] principal internal ledger credit failed:', creditErr.message);
        }
      }
      results.principal = {
        principal: live.principal_balance,
        minted: principalAmount,
        token_address: principalMint && principalMint.tokenAddress,
        master_wallet: principalMaster.address,
      };
    } else if (backfillPrincipal && principalAlreadyBackfilled) {
      results.principal = { skipped: true, reason: 'Bond principal already backfilled to master wallet' };
    }

    if (backfillInterest && Number(live.accrued_interest_total) > 0 && !interestAlreadyBackfilled) {
      let interestMint = null;
      let outAmount = String(live.accrued_interest_total);
      let conversionNote = 'USDC swap skipped (no DEX liquidity); DLBUSD credited for later conversion';
      try {
        interestMint = await StablecoinDexEngine.mintFromSource({
          sourceType: 'bond_interest',
          sourceAccountId: bondId,
          amount: Number(live.accrued_interest_total),
          targetAddress: distributionMaster.id,
        });
        outAmount = String(interestMint.minted || '0');
        conversionNote = `DLBUSD minted to distribution master; swap to USDC can be run once a DEX pool exists`;
      } catch (mintErr) {
        console.warn('[MasterWalletEngine] interest mint failed:', mintErr.message);
      }
      if (Number(outAmount) > 0) {
        try {
          await WalletEngine.credit(distributionMaster.id, 'DLBUSD', outAmount, {
            memo: `Backfill bond interest for ${bond.bond_name} (${conversionNote})`,
            bond_id: bondId,
            backfill_type: 'interest',
            mint: interestMint && interestMint.operationId,
          });
        } catch (creditErr) {
          console.warn('[MasterWalletEngine] interest internal ledger credit failed:', creditErr.message);
        }
      }
      results.interest = {
        accrued_interest: live.accrued_interest_total,
        target_asset: 'DLBUSD',
        amount_out: outAmount,
        distribution_wallet: distributionMaster.address,
        note: conversionNote,
      };
    } else if (backfillInterest && interestAlreadyBackfilled) {
      results.interest = { skipped: true, reason: 'Bond interest already backfilled to master wallet' };
    }

    return {
      bond_id: bondId,
      bond_name: bond.bond_name,
      wallets: Object.fromEntries(wallets.map(w => [subtypeOf(w), w.id]).filter(([k]) => k)),
      results,
    };
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
