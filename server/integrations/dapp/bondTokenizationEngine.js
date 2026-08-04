'use strict';

/**
 * Bond Tokenization Engine
 *
 * Wraps the internal fixed-income/bond ledger and produces ERC-20 tokens
 * representing bond principal and accrued interest. In shadow mode it records
 * token mints in the local database; in live mode it deploys/mints via an
 * ERC-20 factory or direct BondToken contract using the dapp hot wallet.
 */

const { getConfig } = require('./config');
const fs = require('fs');
const path = require('path');

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

let BondEngine;
try { BondEngine = require('../bonds/bondEngine').BondEngine; } catch (e) { BondEngine = null; }

let viem, chains, privateKeyToAccount;
try { viem = require('viem'); chains = require('viem/chains'); ({ privateKeyToAccount } = require('viem/accounts')); } catch (e) { viem = null; chains = null; privateKeyToAccount = null; }

function str(name, fallback = '') { return (process.env[name] || fallback).trim(); }
function bool(name, fallback = false) { const v = process.env[name]; return v ? String(v).toLowerCase() === 'true' : fallback; }
function num(name, fallback = 0) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : fallback; }

function id(prefix = 'BT') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }

const memory = { tokens: new Map(), holdings: new Map() };

async function query(sql, params) {
  if (!pool) throw new Error('no database');
  return pool.query(sql, params);
}

async function ensureTable() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bond_tokens (
      id TEXT PRIMARY KEY,
      bond_id INTEGER,
      bond_name TEXT,
      token_name TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      token_address TEXT,
      total_supply NUMERIC NOT NULL DEFAULT 0,
      tokenized_principal NUMERIC NOT NULL DEFAULT 0,
      tokenized_interest NUMERIC NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bond_token_holders (
      id TEXT PRIMARY KEY,
      token_id TEXT REFERENCES bond_tokens(id) ON DELETE CASCADE,
      holder_address TEXT NOT NULL,
      balance NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(token_id, holder_address)
    );
  `);
}

function walletClient() {
  if (!viem) throw new Error('viem not installed');
  const cfg = getConfig();
  if (!cfg.privateKey) throw new Error('DAPP_PRIVATE_KEY not configured');
  const account = privateKeyToAccount(cfg.privateKey);
  const chain = cfg.chainId === 1 ? (chains && chains.mainnet) : (chains && chains.sepolia) || undefined;
  const fees = cfg.getFees ? (cfg.getFees() || { maxFeePerGas: viem.parseGwei('20'), maxPriorityFeePerGas: viem.parseGwei('0.5') }) : { maxFeePerGas: viem.parseGwei('20'), maxPriorityFeePerGas: viem.parseGwei('0.5') };
  return {
    account,
    fees,
    wallet: viem.createWalletClient({ account, chain, transport: viem.http(cfg.rpcUrl) }),
    publicClient: viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) })
  };
}

function getBondTokenAbi() {
  const abiPath = str('BOND_TOKEN_ABI_PATH', path.join(process.cwd(), 'artifacts', 'contracts_BondToken_sol_BondToken.abi'));
  return JSON.parse(fs.readFileSync(abiPath, 'utf8'));
}

function getBondTokenBytecode() {
  const binPath = str('BOND_TOKEN_BYTECODE_PATH', path.join(process.cwd(), 'artifacts', 'contracts_BondToken_sol_BondToken.bin'));
  return '0x' + fs.readFileSync(binPath, 'utf8').trim();
}

const factoryAbi = [
  { type: 'function', name: 'createBondToken', inputs: [{ type: 'string' }, { type: 'string' }, { type: 'uint256' }], outputs: [{ type: 'address' }], stateMutability: 'nonpayable' },
  { type: 'event', name: 'BondTokenCreated', inputs: [{ type: 'address', indexed: true, name: 'token' }, { type: 'string', name: 'name' }, { type: 'string', name: 'symbol' }, { type: 'uint256', name: 'initialSupply' }] }
];

class BondTokenizationEngine {
  static getConfig() {
    const cfg = getConfig();
    return {
      enabled: bool('BOND_TOKENIZATION_ENABLED', true),
      shadow: bool('BOND_TOKEN_SHADOW', cfg.dappShadow !== false ? true : cfg.dappShadow),
      factoryAddress: str('BOND_TOKEN_FACTORY', ''),
      bytecodePath: str('BOND_TOKEN_BYTECODE_PATH', path.join(process.cwd(), 'artifacts', 'contracts_BondToken_sol_BondToken.bin')),
      abiPath: str('BOND_TOKEN_ABI_PATH', path.join(process.cwd(), 'artifacts', 'contracts_BondToken_sol_BondToken.abi')),
      chainId: cfg.chainId,
      rpcUrl: cfg.rpcUrl,
      privateKey: cfg.privateKey,
      usdcAddress: cfg.usdcAddress,
    };
  }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.enabled) issues.push('BOND_TOKENIZATION_ENABLED is not true');
    if (!cfg.shadow) {
      if (!cfg.privateKey) issues.push('DAPP_PRIVATE_KEY not configured');
      if (!cfg.rpcUrl) issues.push('DAPP_RPC_URL not configured');
      if (!cfg.factoryAddress && !fs.existsSync(cfg.bytecodePath)) issues.push('BOND_TOKEN_FACTORY or BOND_TOKEN_BYTECODE_PATH missing');
    }
    return { ready: issues.length === 0, mode: cfg.shadow ? 'shadow' : 'live', issues };
  }

  static async createToken({ bondId, tokenName, tokenSymbol, tokenAddress, decimals = 6 } = {}) {
    await ensureTable();
    let bond;
    if (bondId && BondEngine) {
      bond = await BondEngine.getBond(bondId);
    }
    const cfg = this.getConfig();
    const tokenId = id('BTOK');
    const record = {
      id: tokenId,
      bond_id: bondId || null,
      bond_name: bond ? bond.bond_name : `Bond ${bondId || 'custom'}`,
      token_name: tokenName || `${bond ? bond.bond_name : 'Bond'} Token`,
      token_symbol: tokenSymbol || (bond ? `DLB${bond.id}` : 'DLBBOND'),
      token_address: tokenAddress || (cfg.shadow ? `shadow-${tokenId}` : ''),
      total_supply: 0,
      tokenized_principal: 0,
      tokenized_interest: 0,
      status: 'active',
      metadata: JSON.stringify({ shadow: cfg.shadow, chainId: cfg.chainId, decimals }),
    };

    if (!cfg.shadow && !tokenAddress) {
      const { wallet, publicClient, fees } = walletClient();
      const abi = getBondTokenAbi();
      const bytecode = getBondTokenBytecode();
      const hash = await wallet.deployContract({
        abi,
        bytecode,
        args: [record.token_name, record.token_symbol, 0],
        gas: 2500000n,
        ...fees,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
      if (receipt.status !== 'success') throw new Error(`bond token deploy failed: ${receipt.transactionHash}`);
      record.token_address = receipt.contractAddress;
    }

    if (pool) {
      await pool.query(
        `INSERT INTO bond_tokens (id, bond_id, bond_name, token_name, token_symbol, token_address, total_supply, tokenized_principal, tokenized_interest, status, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [record.id, record.bond_id, record.bond_name, record.token_name, record.token_symbol, record.token_address, record.total_supply, record.tokenized_principal, record.tokenized_interest, record.status, record.metadata]
      );
    } else {
      memory.tokens.set(tokenId, record);
    }
    return record;
  }

  static async listTokens() {
    await ensureTable();
    if (pool) {
      const res = await pool.query('SELECT * FROM bond_tokens ORDER BY created_at DESC');
      return res.rows;
    }
    return Array.from(memory.tokens.values());
  }

  static async getToken(tokenId) {
    await ensureTable();
    if (pool) {
      const res = await pool.query('SELECT * FROM bond_tokens WHERE id = $1', [tokenId]);
      if (!res.rows.length) throw new Error('Token not found');
      return res.rows[0];
    }
    const t = memory.tokens.get(tokenId);
    if (!t) throw new Error('Token not found');
    return t;
  }

  static async mint({ tokenId, principal, interest, holderAddress } = {}) {
    await ensureTable();
    const token = await this.getToken(tokenId);
    if (token.status !== 'active') throw new Error('Token not active');
    const principalNum = Number(principal) || 0;
    const interestNum = Number(interest) || 0;
    const amount = principalNum + interestNum;
    if (amount <= 0) throw new Error('amount must be positive');

    token.total_supply = Number(token.total_supply || 0) + amount;
    token.tokenized_principal = Number(token.tokenized_principal || 0) + principalNum;
    token.tokenized_interest = Number(token.tokenized_interest || 0) + interestNum;
    token.updated_at = new Date().toISOString();

    const cfg = this.getConfig();
    const target = holderAddress || 'treasury';
    let txHash = null;

    if (!cfg.shadow) {
      if (!token.token_address || token.token_address.startsWith('shadow-')) throw new Error('token has no on-chain address');
      const { wallet, publicClient, fees } = walletClient();
      const abi = getBondTokenAbi();
      const decimals = (token.metadata && token.metadata.decimals) ? token.metadata.decimals : 6;
      const raw = viem.parseUnits(String(amount), decimals);
      const hash = await wallet.writeContract({
        address: token.token_address,
        abi,
        functionName: 'mint',
        args: [target, raw],
        gas: 100000n,
        ...fees,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
      if (receipt.status !== 'success') throw new Error(`mint failed: ${receipt.transactionHash}`);
      txHash = receipt.transactionHash;
    }

    if (pool) {
      await pool.query('UPDATE bond_tokens SET total_supply = $1, tokenized_principal = $2, tokenized_interest = $3, updated_at = NOW() WHERE id = $4', [token.total_supply, token.tokenized_principal, token.tokenized_interest, tokenId]);
      await pool.query(
        `INSERT INTO bond_token_holders (id, token_id, holder_address, balance) VALUES ($1, $2, $3, $4)
         ON CONFLICT (token_id, holder_address) DO UPDATE SET balance = bond_token_holders.balance + $4, updated_at = NOW()`,
        [id('BTH'), tokenId, target, amount]
      );
    } else {
      memory.tokens.set(tokenId, token);
      const key = `${tokenId}:${target}`;
      const h = memory.holdings.get(key) || { id: id('BTH'), token_id: tokenId, holder_address: target, balance: 0 };
      h.balance += amount;
      memory.holdings.set(key, h);
    }

    return { token, minted: amount, principal: principalNum, interest: interestNum, holder: target, txHash };
  }

  static async getHoldings(tokenId) {
    await ensureTable();
    if (pool) {
      const res = await pool.query('SELECT * FROM bond_token_holders WHERE token_id = $1', [tokenId]);
      return res.rows;
    }
    return Array.from(memory.holdings.values()).filter(h => h.token_id === tokenId);
  }

  static async getTokenByBondId(bondId) {
    await ensureTable();
    if (pool) {
      const res = await pool.query("SELECT * FROM bond_tokens WHERE bond_id = $1 AND token_address IS NOT NULL AND token_address <> '' AND token_address NOT LIKE 'shadow-%' ORDER BY created_at DESC LIMIT 1", [bondId]);
      if (res.rows.length) return res.rows[0];
      return null;
    }
    return Array.from(memory.tokens.values()).find(t => t.bond_id === bondId && t.token_address && !t.token_address.startsWith('shadow-')) || null;
  }

  static async getTokenBySymbol(tokenSymbol) {
    await ensureTable();
    if (pool) {
      const res = await pool.query("SELECT * FROM bond_tokens WHERE token_symbol = $1 AND token_address IS NOT NULL AND token_address <> '' AND token_address NOT LIKE 'shadow-%' ORDER BY created_at DESC LIMIT 1", [tokenSymbol.toUpperCase()]);
      if (res.rows.length) return res.rows[0];
      return null;
    }
    return Array.from(memory.tokens.values()).find(t => String(t.token_symbol).toUpperCase() === tokenSymbol.toUpperCase() && t.token_address && !t.token_address.startsWith('shadow-')) || null;
  }
}

module.exports = { BondTokenizationEngine };
