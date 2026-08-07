'use strict';

/**
 * Module Smart Account Engine
 *
 * Predicts/deploys Safe smart accounts for each trust module (Bond Portfolio,
 * Fixed Income, Treasury, Trust Accounting, Core Banking, CRM) and tokenizes
 * the PTC-custodied module balances as ERC-20 tokens minted to the module
 * Safe address.
 */

const Safe = require('@safe-global/protocol-kit').default;
const { getConfig } = require('./config');
const { DappEngine } = require('./dappEngine');
const { BondTokenizationEngine } = require('./bondTokenizationEngine');
const { SafeEngine } = require('./safeEngine');
const { WalletEngine } = require('./walletEngine');
const { privateKeyToAccount } = require('viem/accounts');
const { createPublicClient, http, parseUnits } = require('viem');
const { mainnet, sepolia } = require('viem/chains');

let BondEngine;
try { BondEngine = require('../bonds/bondEngine').BondEngine; } catch (e) { BondEngine = null; }
let LiveBondEngine;
try { LiveBondEngine = require('../bonds/liveEngine').LiveBondEngine; } catch (e) { LiveBondEngine = null; }
let TrustAccountingEngine;
try { TrustAccountingEngine = require('../accounting/trustAccountingEngine').TrustAccountingEngine; } catch (e) { TrustAccountingEngine = null; }
let CashEngine;
try { CashEngine = require('../cash/cashEngine').CashEngine; } catch (e) { CashEngine = null; }
let CrmEngine;
try { CrmEngine = require('../crm/crmEngine').CrmEngine; } catch (e) { CrmEngine = null; }

let pool;
try {
  const db = require('../bonds/pgPool');
  pool = db?.query ? { query: db.query } : null;
} catch (e) { pool = null; }

const MODULES = {
  bond_portfolio: {
    name: 'DLB-PTC-BOND',
    tokenName: 'DLB PTC Bond Portfolio',
    tokenSymbol: 'DLB-BOND',
    sourceType: 'bond',
    sourceAccountId: '1',
    balanceFn: 'bondPrincipal',
    decimals: 6,
  },
  fixed_income: {
    name: 'DLB-PTC-FIXED-INCOME',
    tokenName: 'DLB PTC Fixed Income',
    tokenSymbol: 'DLB-FIXED-INCOME',
    sourceType: 'trust',
    sourceAccountId: '1200',
    balanceFn: 'bondInterest',
    decimals: 6,
  },
  treasury: {
    name: 'DLB-PTC-TREASURY',
    tokenName: 'DLB PTC Treasury',
    tokenSymbol: 'DLB-TREASURY',
    sourceType: 'treasury',
    sourceAccountId: 'TREASURY_HOT',
    balanceFn: 'treasury',
    decimals: 6,
  },
  trust_accounting: {
    name: 'DLB-PTC-TRUST',
    tokenName: 'DLB PTC Trust Accounting',
    tokenSymbol: 'DLB-TRUST',
    sourceType: 'trust',
    sourceAccountId: '1000',
    balanceFn: 'trust',
    decimals: 6,
  },
  core_banking: {
    name: 'DLB-PTC-CORE',
    tokenName: 'DLB PTC Core Banking',
    tokenSymbol: 'DLB-CORE',
    sourceType: 'cash',
    sourceAccountId: 'CA-OPERATING',
    balanceFn: 'cash',
    decimals: 6,
  },
  crm: {
    name: 'DLB-PTC-CRM',
    tokenName: 'DLB PTC CRM Registry',
    tokenSymbol: 'DLB-CRM',
    sourceType: 'crm',
    sourceAccountId: 'contacts',
    balanceFn: 'crm',
    decimals: 0,
  },
};

function id(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }

function chainById(id) {
  switch (id) {
    case 1: return mainnet;
    case 11155111: return sepolia;
    default: return mainnet;
  }
}

function ethSignOffset(sig) {
  const bytes = Buffer.from(sig.slice(2), 'hex');
  let v = bytes[64];
  if (v < 27) v += 27;
  v += 4; // Safe eth_sign v offset
  bytes[64] = v;
  return '0x' + bytes.toString('hex');
}

async function ensureTable() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS module_smart_accounts (
      id TEXT PRIMARY KEY,
      module_key TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      safe_address TEXT,
      owners JSONB DEFAULT '[]',
      threshold INTEGER DEFAULT 1,
      salt_nonce TEXT NOT NULL,
      token_id TEXT,
      token_address TEXT,
      ledger_source TEXT,
      balance_synced_at TIMESTAMPTZ,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function query(sql, params) {
  if (!pool) throw new Error('Database not available');
  return pool.query(sql, params);
}

class ModuleSmartAccountEngine {
  static getConfig() {
    const cfg = getConfig();
    return {
      rpcUrl: cfg.rpcUrl,
      privateKey: cfg.privateKey,
      operatorAddress: cfg.operatorAddress,
    };
  }

  static async listTrusteeAddresses() {
    try {
      const users = await DappEngine.listUsers();
      const trustees = users.filter(u => {
        const roles = Array.isArray(u.roles) ? u.roles : (u.roles ? JSON.parse(u.roles) : [u.role]);
        return roles.some(r => String(r).startsWith('trustee')) || String(u.role).startsWith('trustee');
      });
      return trustees.map(u => u.wallet_address).filter(Boolean);
    } catch (e) {
      console.warn('[ModuleSmartAccountEngine] listTrusteeAddresses failed:', e.message);
      return [this.getConfig().operatorAddress].filter(Boolean);
    }
  }

  static async predictSafeAddress({ moduleKey, owners, threshold = 2, saltNonce }) {
    const cfg = this.getConfig();
    if (!cfg.rpcUrl) throw new Error('DAPP_RPC_URL not configured');
    if (!owners || owners.length < threshold) throw new Error('Not enough owners for Safe threshold');
    const signer = cfg.privateKey || '0x0000000000000000000000000000000000000000000000000000000000000001';
    const kit = await Safe.init({
      provider: cfg.rpcUrl,
      signer,
      predictedSafe: {
        safeAccountConfig: { owners, threshold },
        safeDeploymentConfig: { saltNonce: BigInt(saltNonce).toString() },
      },
    });
    const address = await kit.getAddress();
    const deployed = await kit.isSafeDeployed();
    return { address, deployed };
  }

  static async initializeModule(moduleKey) {
    await ensureTable();
    const mod = MODULES[moduleKey];
    if (!mod) throw new Error(`Unknown module: ${moduleKey}`);

    const trustees = await this.listTrusteeAddresses();
    const owners = trustees.length ? trustees : [this.getConfig().operatorAddress].filter(Boolean);
    const threshold = owners.length >= 2 ? 2 : 1;
    const saltNonce = BigInt('0x' + Buffer.from(`${moduleKey}-ptc-v1`).slice(0, 16).toString('hex'));

    const { address, deployed } = await this.predictSafeAddress({ moduleKey, owners, threshold, saltNonce });

    const existing = (await query('SELECT * FROM module_smart_accounts WHERE module_key = $1', [moduleKey])).rows[0];
    const recordId = existing ? existing.id : id('MOD');
    if (existing) {
      await query(
        `UPDATE module_smart_accounts SET safe_address=$1, owners=$2, threshold=$3, salt_nonce=$4, metadata=$5, updated_at=NOW() WHERE id=$6`,
        [address, JSON.stringify(owners), threshold, saltNonce.toString(), JSON.stringify({ deployed }), recordId]
      );
    } else {
      await query(
        `INSERT INTO module_smart_accounts (id, module_key, name, safe_address, owners, threshold, salt_nonce, ledger_source, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [recordId, moduleKey, mod.name, address, JSON.stringify(owners), threshold, saltNonce.toString(), `${mod.sourceType}:${mod.sourceAccountId}`, JSON.stringify({ deployed })]
      );
    }
    return this.getModule(moduleKey);
  }

  static async getModule(moduleKey) {
    await ensureTable();
    const mod = MODULES[moduleKey];
    if (!mod) throw new Error(`Unknown module: ${moduleKey}`);
    const rows = (await query('SELECT * FROM module_smart_accounts WHERE module_key = $1', [moduleKey])).rows;
    if (!rows.length) return null;
    const row = rows[0];
    return { ...row, config: mod };
  }

  static async listModules() {
    await ensureTable();
    const result = {};
    for (const key of Object.keys(MODULES)) {
      result[key] = await this.getModule(key) || { moduleKey: key, config: MODULES[key], initialized: false };
    }
    return result;
  }

  static async getModuleBalance(moduleKey) {
    const mod = MODULES[moduleKey];
    if (!mod) throw new Error(`Unknown module: ${moduleKey}`);

    if (mod.balanceFn === 'bondPrincipal') {
      if (!BondEngine) throw new Error('BondEngine not available');
      const bond = await BondEngine.getBond(mod.sourceAccountId);
      return Number(bond.principal_balance || 0);
    }
    if (mod.balanceFn === 'bondInterest') {
      if (!TrustAccountingEngine) throw new Error('TrustAccountingEngine not available');
      const acct = await TrustAccountingEngine.getAccount('1200');
      return Number(acct ? acct.balance || 0 : 0);
    }
    if (mod.balanceFn === 'trust') {
      if (!TrustAccountingEngine) throw new Error('TrustAccountingEngine not available');
      const acct = await TrustAccountingEngine.getAccount(mod.sourceAccountId);
      return Number(acct.balance || 0);
    }
    if (mod.balanceFn === 'treasury') {
      const { TreasuryEngine } = require('../stablecoin/treasuryEngine');
      const pos = await TreasuryEngine.getPosition(mod.sourceAccountId);
      return (Number(pos.availableCents || 0) / 100);
    }
    if (mod.balanceFn === 'cash') {
      if (!CashEngine) throw new Error('CashEngine not available');
      const acct = await CashEngine.getAccount(mod.sourceAccountId);
      return Number(acct ? acct.balance_cents || 0 : 0) / 100;
    }
    if (mod.balanceFn === 'fineract') {
      return 0;
    }
    if (mod.balanceFn === 'crm') {
      if (!CrmEngine) return 0;
      const contacts = await CrmEngine.listContacts().catch(() => []);
      return contacts.length;
    }
    return 0;
  }

  static async _publicClient() {
    const cfg = this.getConfig();
    return createPublicClient({ chain: chainById(cfg.chainId), transport: http(cfg.rpcUrl) });
  }

  static async getTokenBalance(tokenAddress, holderAddress) {
    const publicClient = await this._publicClient();
    const raw = await publicClient.readContract({
      address: tokenAddress,
      abi: [{ type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
      functionName: 'balanceOf',
      args: [holderAddress],
    });
    return raw;
  }

  static async deployModuleSafe(moduleKey) {
    const mod = await this.getModule(moduleKey);
    if (!mod) throw new Error(`Module ${moduleKey} not initialized`);
    const owners = Array.isArray(mod.owners) ? mod.owners : JSON.parse(mod.owners || '[]');
    const info = await SafeEngine.getSafeInfo(mod.safe_address).catch(() => null);
    if (!info || !info.isDeployed) {
      await SafeEngine.deploySafe({ owners, threshold: mod.threshold, saltNonce: mod.salt_nonce });
    }
    return { safeAddress: mod.safe_address, deployed: true };
  }

  static async tokenizeModule(moduleKey) {
    const mod = await this.initializeModule(moduleKey);
    const cfg = this.getConfig();
    if (!cfg.privateKey) throw new Error('DAPP_PRIVATE_KEY not configured');

    const balance = await this.getModuleBalance(moduleKey);
    const isCrm = moduleKey === 'crm';
    if (balance <= 0 && !isCrm) throw new Error(`No balance to tokenize for ${moduleKey}`);

    let token = null;
    if (mod.token_id) {
      token = await BondTokenizationEngine.getToken(mod.token_id);
    }
    if (!token) {
      token = await BondTokenizationEngine.createToken({
        tokenName: mod.config.tokenName,
        tokenSymbol: mod.config.tokenSymbol,
        decimals: mod.config.decimals,
      });
    }

    const meta = (typeof mod.metadata === 'string' ? JSON.parse(mod.metadata || '{}') : (mod.metadata || {}));
    const alreadyMinted = Number(meta.mintedAmount || 0);
    const mintAmount = isCrm ? 0 : Math.max(0, balance - alreadyMinted);
    const principal = moduleKey === 'fixed_income' ? 0 : mintAmount;
    const interest = moduleKey === 'fixed_income' ? mintAmount : 0;

    // Mint new supply to the operator wallet so it is direct from the blockchain.
    const holderAddress = cfg.operatorAddress;
    if (mintAmount > 0) {
      await BondTokenizationEngine.mint({
        tokenId: token.id,
        principal,
        interest,
        holderAddress,
      });
    }

    const newMinted = alreadyMinted + mintAmount;
    const metadata = {
      ...(meta || {}),
      balance: { amount: newMinted, balance },
      mintedAmount: newMinted,
      holderAddress,
    };
    await query(
      'UPDATE module_smart_accounts SET token_id=$1, token_address=$2, balance_synced_at=NOW(), metadata=$3 WHERE id=$4',
      [token.id, token.token_address, JSON.stringify(metadata), mod.id]
    );

    return { module: await this.getModule(moduleKey), token, minted: mintAmount, totalMinted: newMinted, holderAddress };
  }

  static async settleToOperator(moduleKey, amount = 'all') {
    const mod = await this.getModule(moduleKey);
    if (!mod || !mod.token_address) throw new Error(`Module ${moduleKey} has not been tokenized`);
    if (moduleKey === 'crm') throw new Error('CRM module is not a transferable token balance');

    const cfg = this.getConfig();
    const tokenAddress = mod.token_address;
    const safeAddress = mod.safe_address;
    const operatorAddress = cfg.operatorAddress;
    const owners = Array.isArray(mod.owners) ? mod.owners : JSON.parse(mod.owners || '[]');
    const threshold = mod.threshold;

    // Ensure the module Safe is deployed
    await this.deployModuleSafe(moduleKey);

    const rawBalance = await this.getTokenBalance(tokenAddress, safeAddress);
    if (rawBalance === 0n) return { moduleKey, skipped: true, reason: 'No module token balance in Safe' };
    let tokenAmount = rawBalance;
    if (amount !== 'all' && amount) {
      const dec = mod.config.decimals || 6;
      tokenAmount = parseUnits(String(amount), dec);
      if (tokenAmount > rawBalance) tokenAmount = rawBalance;
    }

    const { safeTx, safeTxHash } = await SafeEngine.createTransaction({
      safeAddress,
      token: tokenAddress,
      tokenAmount: String(tokenAmount),
      to: operatorAddress,
    });

    const signatures = [];
    for (const addr of owners.slice(0, threshold)) {
      const wallet = await WalletEngine.getWalletByAddress(addr);
      if (!wallet || !wallet.private_key_encrypted) throw new Error(`No wallet for Safe owner ${addr}`);
      const pk = WalletEngine._decrypt(wallet.private_key_encrypted);
      const account = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
      const rawSig = await account.signMessage({ message: { raw: safeTxHash } });
      const safeSig = ethSignOffset(rawSig);
      signatures.push({ signer: account.address, signature: safeSig });
    }

    const rebuilt = SafeEngine.rebuildTransaction(safeTx.data, signatures);
    const result = await SafeEngine.executeTransaction({ safeAddress, safeTx: rebuilt });

    // Wait for the Safe execution to be mined so the operator wallet has the tokens.
    const publicClient = await this._publicClient();
    const receipt = await publicClient.waitForTransactionReceipt({ hash: result.txHash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`Safe transaction ${result.txHash} failed on-chain`);

    // Update metadata so future tokenization does not double-mint
    const meta = (typeof mod.metadata === 'string' ? JSON.parse(mod.metadata || '{}') : (mod.metadata || {}));
    const movedAmount = Number(tokenAmount) / Math.pow(10, mod.config.decimals || 6);
    const metadata = {
      ...(meta || {}),
      settledToOperator: true,
      settledAt: new Date().toISOString(),
      settledAmount: (Number(meta.settledAmount || 0) + movedAmount),
      holderAddress: operatorAddress,
    };
    await query('UPDATE module_smart_accounts SET metadata=$1, updated_at=NOW() WHERE id=$2', [JSON.stringify(metadata), mod.id]);

    return { moduleKey, safeAddress, operatorAddress, tokenAddress, amount: movedAmount, tokenAmount: String(tokenAmount), txHash: result.txHash };
  }

  static async settleAllToOperator() {
    const results = {};
    for (const key of Object.keys(MODULES)) {
      if (key === 'crm') continue;
      try {
        results[key] = await this.settleToOperator(key);
      } catch (err) {
        results[key] = { success: false, error: err.message };
      }
    }
    return results;
  }
}

module.exports = { ModuleSmartAccountEngine, MODULES };
