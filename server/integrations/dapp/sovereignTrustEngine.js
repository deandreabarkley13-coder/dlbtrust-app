'use strict';

/**
 * Sovereign Trust Engine
 *
 * Self-issued, private/permissioned stablecoin backed by the trust's internal
 * source-of-funds ledgers (Treasury, Core Banking, Trust Accounting, Bond /
 * Fixed Income, Cash, Sub-Ledger, CRM).  Deploys an ERC-20 token and an
 * ERC-2771 trusted forwarder on Ethereum via Alchemy, mints/burns against
 * reserve ledger balances, and submits gasless meta-transactions.
 */

const { getConfig } = require('./config');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let viem, chains, privateKeyToAccount;
try { viem = require('viem'); chains = require('viem/chains'); ({ privateKeyToAccount } = require('viem/accounts')); } catch (e) { viem = null; chains = null; privateKeyToAccount = null; }

let SourceOfFundsAdapter;
try { ({ SourceOfFundsAdapter } = require('../stablecoin/sourceOfFundsAdapter')); } catch (e) { SourceOfFundsAdapter = null; }

let TreasuryEngine;
try { ({ TreasuryEngine, DEFAULT_ACCOUNT } = require('../stablecoin/treasuryEngine')); } catch (e) { TreasuryEngine = null; }

let ModuleFundingEngine;
try { ({ ModuleFundingEngine } = require('./moduleFundingEngine')); } catch (e) { ModuleFundingEngine = null; }

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

function str(name, def = '') { return (process.env[name] || def).trim(); }
function bool(name, def = false) { const v = process.env[name]; return v ? String(v).toLowerCase() === 'true' : def; }
function num(name, def = 0) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : def; }

function id(prefix = 'SIT') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }
function toCents(amount) { return Math.round((Number(amount) || 0) * 100); }
function fromCents(cents) { return (cents / 100).toFixed(2); }

const memory = {
  token: null,
  forwarder: null,
  orders: new Map(),
  holders: new Map(),
  mints: new Map(),
};

async function query(sql, params) {
  if (!pool) throw new Error('no database');
  return pool.query(sql, params);
}

async function ensureTables() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sovereign_tokens (
      id TEXT PRIMARY KEY,
      network TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      token_address TEXT,
      forwarder_address TEXT,
      token_symbol TEXT NOT NULL DEFAULT 'SIT',
      token_name TEXT NOT NULL DEFAULT 'Sovereign Trust Token',
      status TEXT NOT NULL DEFAULT 'active',
      shadow BOOLEAN NOT NULL DEFAULT true,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sovereign_token_holders (
      id TEXT PRIMARY KEY,
      token_id TEXT REFERENCES sovereign_tokens(id) ON DELETE CASCADE,
      address TEXT NOT NULL,
      balance_cents BIGINT NOT NULL DEFAULT 0,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(token_id, address)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sovereign_ramp_orders (
      id TEXT PRIMARY KEY,
      token_id TEXT,
      direction TEXT NOT NULL,
      source_type TEXT,
      source_account_id TEXT,
      amount_cents BIGINT NOT NULL,
      target_address TEXT,
      fiat_destination TEXT,
      on_chain_tx TEXT,
      on_chain_status TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      metadata JSONB DEFAULT '{}',
      source_ref JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  } catch (e) {
    console.warn('[SovereignTrustEngine] ensureTables failed:', e.message);
  }
}

function walletClient() {
  if (!viem) throw new Error('viem not installed');
  const cfg = getConfig();
  if (!cfg.privateKey) throw new Error('DAPP_PRIVATE_KEY not configured');
  const account = privateKeyToAccount(cfg.privateKey);
  const chain = cfg.chainId === 1 ? (chains && chains.mainnet) : (chains && chains.sepolia) || undefined;
  const fees = { maxFeePerGas: viem.parseGwei('3'), maxPriorityFeePerGas: viem.parseGwei('0.0015') };
  return {
    account,
    fees,
    wallet: viem.createWalletClient({ account, chain, transport: viem.http(cfg.rpcUrl) }),
    publicClient: viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) })
  };
}

function getTokenAbi() {
  const abiPath = str('SOVEREIGN_TOKEN_ABI_PATH', path.join(process.cwd(), 'artifacts', 'contracts_SovereignTrustToken_sol_SovereignTrustToken.abi'));
  return JSON.parse(fs.readFileSync(abiPath, 'utf8'));
}
function getTokenBytecode() {
  const binPath = str('SOVEREIGN_TOKEN_BYTECODE_PATH', path.join(process.cwd(), 'artifacts', 'contracts_SovereignTrustToken_sol_SovereignTrustToken.bin'));
  return '0x' + fs.readFileSync(binPath, 'utf8').trim();
}
function getForwarderAbi() {
  const abiPath = str('SOVEREIGN_FORWARDER_ABI_PATH', path.join(process.cwd(), 'artifacts', 'contracts_SovereignTrustForwarder_sol_SovereignTrustForwarder.abi'));
  return JSON.parse(fs.readFileSync(abiPath, 'utf8'));
}
function getForwarderBytecode() {
  const binPath = str('SOVEREIGN_FORWARDER_BYTECODE_PATH', path.join(process.cwd(), 'artifacts', 'contracts_SovereignTrustForwarder_sol_SovereignTrustForwarder.bin'));
  return '0x' + fs.readFileSync(binPath, 'utf8').trim();
}

class SovereignTrustEngine {
  static getConfig() {
    const cfg = getConfig();
    return {
      enabled: bool('SOVEREIGN_TRUST_ENABLED', true),
      shadow: bool('SOVEREIGN_TRUST_SHADOW', true),
      tokenName: str('SOVEREIGN_TOKEN_NAME', 'Sovereign Trust Token'),
      tokenSymbol: str('SOVEREIGN_TOKEN_SYMBOL', 'SIT'),
      reserveAccount: str('SOVEREIGN_RESERVE_ACCOUNT', 'SOVEREIGN_RESERVE'),
      rpcUrl: cfg.rpcUrl,
      chainId: cfg.chainId,
      privateKey: cfg.privateKey,
      operatorAddress: cfg.operatorAddress || (cfg.privateKey ? privateKeyToAccount(cfg.privateKey).address : ''),
      tokenAddress: str('SOVEREIGN_TOKEN_ADDRESS', ''),
      forwarderAddress: str('SOVEREIGN_FORWARDER_ADDRESS', ''),
      gaslessMaxGas: num('SOVEREIGN_GASLESS_MAX_GAS', 500000),
    };
  }

  static async readiness() {
    await ensureTables();
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.privateKey) issues.push('DAPP_PRIVATE_KEY not configured');
    if (!cfg.rpcUrl) issues.push('DAPP_RPC_URL not configured');
    try {
      getTokenAbi();
      getForwarderAbi();
    } catch (e) { issues.push('compiled artifacts missing: run solcjs'); }
    if (!cfg.shadow) {
      if (!cfg.tokenAddress || cfg.tokenAddress.startsWith('shadow-')) issues.push('SOVEREIGN_TOKEN_ADDRESS not set or shadow');
      if (!cfg.forwarderAddress || cfg.forwarderAddress.startsWith('shadow-')) issues.push('SOVEREIGN_FORWARDER_ADDRESS not set or shadow');
    }
    const token = await this._loadToken();
    return {
      ready: issues.length === 0,
      mode: cfg.shadow ? 'shadow' : 'live',
      issues,
      token: token ? { address: token.token_address, forwarder: token.forwarder_address, symbol: token.token_symbol } : null,
      operatorAddress: cfg.operatorAddress,
      network: cfg.chainId === 1 ? 'mainnet' : 'sepolia',
    };
  }

  static async _loadToken() {
    if (memory.token) return memory.token;
    if (!pool) return null;
    try {
      const rows = await pool.query('SELECT * FROM sovereign_tokens ORDER BY created_at DESC LIMIT 1');
      if (rows.rows && rows.rows.length) memory.token = rows.rows[0];
    } catch (e) { console.warn('[SovereignTrustEngine] _loadToken failed:', e.message); }
    return memory.token;
  }

  static async _saveToken(record) {
    memory.token = record;
    if (!pool) return record;
    const cfg = this.getConfig();
    const params = [
      record.id, cfg.chainId === 1 ? 'mainnet' : 'sepolia', cfg.chainId,
      record.token_address, record.forwarder_address, cfg.tokenSymbol, cfg.tokenName,
      'active', cfg.shadow, JSON.stringify(record.metadata || {})
    ];
    try {
      await pool.query(`
        INSERT INTO sovereign_tokens (id, network, chain_id, token_address, forwarder_address, token_symbol, token_name, status, shadow, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO UPDATE SET
          token_address = EXCLUDED.token_address,
          forwarder_address = EXCLUDED.forwarder_address,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
      `, params);
    } catch (e) { console.warn('[SovereignTrustEngine] _saveToken failed:', e.message); }
    return record;
  }

  static async _loadOrders() {
    if (!pool || memory.orders.size) return;
    try {
      const rows = await pool.query('SELECT * FROM sovereign_ramp_orders ORDER BY created_at DESC');
      for (const r of rows.rows || []) memory.orders.set(r.id, r);
    } catch (e) { console.warn('[SovereignTrustEngine] _loadOrders failed:', e.message); }
  }

  static async _saveOrder(order) {
    memory.orders.set(order.id, order);
    if (!pool) return order;
    const params = [
      order.id, order.token_id, order.direction, order.source_type, order.source_account_id,
      order.amount_cents, order.target_address, order.fiat_destination, order.on_chain_tx,
      order.on_chain_status, order.status, JSON.stringify(order.metadata || {}),
      JSON.stringify(order.source_ref || {}), order.id
    ];
    try {
      await pool.query(`
        INSERT INTO sovereign_ramp_orders (id, token_id, direction, source_type, source_account_id, amount_cents, target_address, fiat_destination, on_chain_tx, on_chain_status, status, metadata, source_ref)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (id) DO UPDATE SET
          on_chain_tx = EXCLUDED.on_chain_tx,
          on_chain_status = EXCLUDED.on_chain_status,
          status = EXCLUDED.status,
          metadata = EXCLUDED.metadata,
          source_ref = EXCLUDED.source_ref,
          updated_at = NOW()
      `, params);
    } catch (e) { console.warn('[SovereignTrustEngine] _saveOrder failed:', e.message); }
    return order;
  }

  static async deployContracts() {
    await ensureTables();
    const cfg = this.getConfig();
    const record = {
      id: id('SIT-DEPLOY'),
      token_address: cfg.tokenAddress,
      forwarder_address: cfg.forwarderAddress,
      metadata: { name: cfg.tokenName, symbol: cfg.tokenSymbol },
    };

    if (cfg.shadow) {
      if (!record.token_address) record.token_address = `shadow-token-${Date.now()}`;
      if (!record.forwarder_address) record.forwarder_address = `shadow-forwarder-${Date.now()}`;
      await this._saveToken(record);
      return { success: true, shadow: true, token: record.token_address, forwarder: record.forwarder_address };
    }

    const { wallet, publicClient, fees } = walletClient();

    if (!record.forwarder_address || record.forwarder_address.startsWith('shadow-')) {
      const hash = await wallet.deployContract({
        abi: getForwarderAbi(),
        bytecode: getForwarderBytecode(),
        gas: 1200000n,
        ...fees,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
      if (receipt.status !== 'success') throw new Error(`Forwarder deploy failed: ${receipt.transactionHash}`);
      record.forwarder_address = receipt.contractAddress;
      record.metadata = { ...record.metadata, forwarderDeployTx: receipt.transactionHash };
    }

    if (!record.token_address || record.token_address.startsWith('shadow-')) {
      const hash = await wallet.deployContract({
        abi: getTokenAbi(),
        bytecode: getTokenBytecode(),
        args: [cfg.tokenName, cfg.tokenSymbol, cfg.operatorAddress],
        gas: 2500000n,
        ...fees,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
      if (receipt.status !== 'success') throw new Error(`Token deploy failed: ${receipt.transactionHash}`);
      record.token_address = receipt.contractAddress;
      record.metadata = { ...record.metadata, tokenDeployTx: receipt.transactionHash };

      const hash2 = await wallet.writeContract({
        address: record.token_address,
        abi: getTokenAbi(),
        functionName: 'setTrustedForwarder',
        args: [record.forwarder_address, true],
        gas: 100000n,
        ...fees,
      });
      await publicClient.waitForTransactionReceipt({ hash: hash2, timeout: 120000 });
      record.metadata = { ...record.metadata, setForwarderTx: hash2 };
    }

    await this._saveToken(record);
    return {
      success: true,
      shadow: false,
      token: record.token_address,
      forwarder: record.forwarder_address,
      operator: cfg.operatorAddress,
    };
  }

  static async _ensureDeployed() {
    const token = await this._loadToken();
    if (token && token.token_address && token.forwarder_address) return token;
    return (await this.deployContracts()).token ? await this._loadToken() : null;
  }

  static async _recordMint(orderId, to, amountCents, sourceRef, onChainTx) {
    const addr = (to || '').toLowerCase();
    const token = await this._loadToken();
    const existing = memory.holders.get(addr) || 0;
    memory.holders.set(addr, existing + amountCents);
    if (!pool) return;
    try {
      const holderId = `HOLD-${orderId || Date.now()}`;
      await pool.query(`
        INSERT INTO sovereign_token_holders (id, token_id, address, balance_cents, metadata)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (token_id, address) DO UPDATE SET
          balance_cents = sovereign_token_holders.balance_cents + EXCLUDED.balance_cents,
          metadata = sovereign_token_holders.metadata || EXCLUDED.metadata,
          updated_at = NOW()
      `, [holderId, token.id, addr, amountCents, JSON.stringify({ sourceRef, onChainTx })]);
    } catch (e) { console.warn('[SovereignTrustEngine] _recordMint failed:', e.message); }
  }

  static async _tokenWrite(method, args, opts = {}) {
    const cfg = this.getConfig();
    const token = await this._loadToken();
    if (!token) throw new Error('sovereign token not deployed');
    if (cfg.shadow) {
      return `shadow-tx-${method}-${Date.now()}`;
    }
    const { wallet, publicClient, fees } = walletClient();
    const hash = await wallet.writeContract({
      address: token.token_address,
      abi: getTokenAbi(),
      functionName: method,
      args,
      gas: opts.gas || 200000n,
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`${method} failed: ${receipt.transactionHash}`);
    return receipt.transactionHash;
  }

  static async mintFromSource({ sourceType, sourceAccountId, to, amount, memo, amountCents } = {}) {
    await ensureTables();
    const cfg = this.getConfig();
    if (!SourceOfFundsAdapter || !TreasuryEngine) throw new Error('SourceOfFundsAdapter or TreasuryEngine not available');
    const token = await this._ensureDeployed();
    if (!token) throw new Error('token deployment failed');

    const cents = amountCents || toCents(amount);
    if (cents <= 0) throw new Error('amount must be > 0');
    const raw = viem.parseUnits(String(cents / 100), 6);

    const paymentId = id('SIT-MINT');
    let sourceRef;
    if (String(sourceType).toLowerCase() === 'treasury') {
      const acct = sourceAccountId || cfg.reserveAccount;
      await TreasuryEngine.debit(acct, cents, { reason: memo || `Sovereign token mint reserve ${paymentId}`, source: 'sovereign_mint', metadata: { sourceType, sourceAccountId, paymentId, target: to } });
      sourceRef = { sourceType, sourceAccountId: acct, treasuryDebit: true };
    } else {
      sourceRef = await SourceOfFundsAdapter._fundSourceToTreasury({
        sourceType, sourceAccountId, paymentId, amountCents: cents,
      });
    }

    if (String(sourceType).toLowerCase() !== 'treasury') {
      await TreasuryEngine.debit(DEFAULT_ACCOUNT, cents, {
        reason: memo || `Sovereign token mint reserve ${paymentId}`,
        source: 'sovereign_mint',
        metadata: { sourceType, sourceAccountId, paymentId, target: to, sourceRef },
      });
    }
    await TreasuryEngine.credit(cfg.reserveAccount, cents, {
      source: 'sovereign_mint',
      metadata: { sourceType, sourceAccountId, paymentId, target: to, sourceRef },
    });

    let tx = null;
    try {
      tx = await this._tokenWrite('mint', [to, raw], { gas: 200000n });
    } catch (err) {
      try {
        await TreasuryEngine.debit(cfg.reserveAccount, cents, { reason: `rollback mint ${paymentId}` });
        await TreasuryEngine.credit(DEFAULT_ACCOUNT, cents, { reason: `rollback mint ${paymentId}` });
        await SourceOfFundsAdapter._refundSourceFromTreasury({ sourceType, sourceAccountId, payment: { id: paymentId, total_cents: cents }, sourceRef });
      } catch (e) { console.warn('[SovereignTrustEngine] mint rollback failed:', e.message); }
      throw err;
    }

    await this._recordMint(paymentId, to, cents, sourceRef, tx);

    const order = {
      id: id('SIT-RAMP'),
      token_id: token.id,
      direction: 'on_ramp',
      source_type: sourceType,
      source_account_id: sourceAccountId,
      amount_cents: cents,
      target_address: to,
      on_chain_tx: tx,
      on_chain_status: tx ? 'success' : 'shadow',
      status: 'completed',
      source_ref: sourceRef,
      metadata: { memo, raw: raw.toString(), token: token.token_address },
    };
    await this._saveOrder(order);

    return { success: true, orderId: order.id, token: token.token_address, to, amount: fromCents(cents), tx, sourceRef };
  }

  static async burnToSource({ from, sourceType, sourceAccountId, amount, amountCents, memo } = {}) {
    await ensureTables();
    const cfg = this.getConfig();
    if (!SourceOfFundsAdapter || !TreasuryEngine) throw new Error('SourceOfFundsAdapter or TreasuryEngine not available');
    const token = await this._loadToken();
    if (!token) throw new Error('token not deployed');

    const cents = amountCents || toCents(amount);
    if (cents <= 0) throw new Error('amount must be > 0');
    const raw = viem.parseUnits(String(cents / 100), 6);

    const balance = await this.tokenBalanceOf(from);
    if (Number(balance) * 100 < cents) throw new Error(`Insufficient SIT balance: ${balance}`);

    const paymentId = id('SIT-BURN');

    let tx = null;
    try {
      tx = await this._tokenWrite('burnFrom', [from, raw], { gas: 120000n });
    } catch (err) {
      throw new Error(`SIT burn failed: ${err.message}`);
    }

    await TreasuryEngine.debit(cfg.reserveAccount, cents, {
      reason: memo || `Sovereign token burn release ${paymentId}`,
      source: 'sovereign_burn',
      metadata: { sourceType, sourceAccountId, paymentId, from, tx },
    });
    await TreasuryEngine.credit(DEFAULT_ACCOUNT, cents, {
      source: 'sovereign_burn',
      metadata: { sourceType, sourceAccountId, paymentId, from, tx },
    });

    const sourceRef = { burnTx: tx, from, amountCents: cents };
    if (ModuleFundingEngine) {
      await ModuleFundingEngine._creditSource({
        type: sourceType, accountId: sourceAccountId, amountCents: cents,
        memo: memo || `Sovereign token burn release ${paymentId}`, referenceId: paymentId,
      });
    } else {
      await SourceOfFundsAdapter._refundSourceFromTreasury({
        sourceType, sourceAccountId,
        payment: { id: paymentId, total_cents: cents },
        sourceRef,
      });
    }

    const fromAddr = (from || '').toLowerCase();
    const existing = memory.holders.get(fromAddr) || 0;
    memory.holders.set(fromAddr, Math.max(0, existing - cents));
    if (pool) {
      try {
        await pool.query(`
          INSERT INTO sovereign_token_holders (id, token_id, address, balance_cents, metadata)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (token_id, address) DO UPDATE SET
            balance_cents = GREATEST(0, sovereign_token_holders.balance_cents - EXCLUDED.balance_cents),
            metadata = sovereign_token_holders.metadata || EXCLUDED.metadata,
            updated_at = NOW()
        `, [id('SIT-HOLD'), token.id, fromAddr, cents, JSON.stringify(sourceRef)]);
      } catch (e) { console.warn('[SovereignTrustEngine] burn holder update failed:', e.message); }
    }

    const order = {
      id: id('SIT-RAMP'),
      token_id: token.id,
      direction: 'off_ramp',
      source_type: sourceType,
      source_account_id: sourceAccountId,
      amount_cents: cents,
      target_address: from,
      on_chain_tx: tx,
      on_chain_status: tx ? 'success' : 'shadow',
      status: 'completed',
      source_ref: sourceRef,
      metadata: { memo, raw: raw.toString() },
    };
    await this._saveOrder(order);

    return { success: true, orderId: order.id, token: token.token_address, from, amount: fromCents(cents), tx, releasedTo: `${sourceType}:${sourceAccountId}` };
  }

  static async tokenBalanceOf(address) {
    const token = await this._loadToken();
    if (!token) return '0';
    if (this.getConfig().shadow) {
      const h = memory.holders.get((address || '').toLowerCase());
      return h ? (h / 100).toFixed(2) : '0.00';
    }
    const { publicClient } = walletClient();
    const raw = await publicClient.readContract({
      address: token.token_address,
      abi: getTokenAbi(),
      functionName: 'balanceOf',
      args: [address],
    });
    return viem.formatUnits(raw, 6);
  }

  static async tokenInfo() {
    const token = await this._loadToken();
    if (!token) return { deployed: false };
    if (this.getConfig().shadow) {
      return { deployed: true, shadow: true, address: token.token_address, forwarder: token.forwarder_address, symbol: token.token_symbol, name: token.token_name, totalSupply: '0', decimals: 6 };
    }
    const { publicClient } = walletClient();
    const [name, symbol, decimals, totalSupply, paused, whitelistEnabled] = await Promise.all([
      publicClient.readContract({ address: token.token_address, abi: getTokenAbi(), functionName: 'name' }).catch(() => null),
      publicClient.readContract({ address: token.token_address, abi: getTokenAbi(), functionName: 'symbol' }).catch(() => null),
      publicClient.readContract({ address: token.token_address, abi: getTokenAbi(), functionName: 'decimals' }).catch(() => 6),
      publicClient.readContract({ address: token.token_address, abi: getTokenAbi(), functionName: 'totalSupply' }).catch(() => 0n),
      publicClient.readContract({ address: token.token_address, abi: getTokenAbi(), functionName: 'paused' }).catch(() => false),
      publicClient.readContract({ address: token.token_address, abi: getTokenAbi(), functionName: 'whitelistEnabled' }).catch(() => true),
    ]);
    return {
      deployed: true,
      shadow: false,
      address: token.token_address,
      forwarder: token.forwarder_address,
      name, symbol, decimals, paused, whitelistEnabled,
      totalSupply: totalSupply ? viem.formatUnits(totalSupply, Number(decimals || 6)) : '0',
    };
  }

  static async whitelistAddress(address, allowed = true) {
    return await this._tokenWrite('setWhitelisted', [address, allowed], { gas: 100000n });
  }

  // ─── ERC-2771 Meta-transactions (gasless) ────────────────────────────────────

  static getEip712Domain(forwarderAddress, chainId) {
    return {
      name: 'SovereignTrustForwarder',
      version: '1',
      chainId,
      verifyingContract: forwarderAddress,
    };
  }

  static getEip712Types() {
    return {
      ForwardRequest: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'gas', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'data', type: 'bytes' },
      ],
    };
  }

  static async buildMetaTx({ from, to, data, functionName, args, amount, gas } = {}) {
    const token = await this._ensureDeployed();
    if (!token) throw new Error('token not deployed');
    const cfg = this.getConfig();
    const chainId = cfg.chainId;
    const forwarderAddress = token.forwarder_address;
    const tokenAddress = token.token_address;

    let callData = data;
    if (!callData && functionName) {
      let fnArgs = args ? [...args] : [];
      if (amount) {
        const raw = viem.parseUnits(String(amount), 6);
        if (functionName === 'transfer' && fnArgs.length < 2) fnArgs = [fnArgs[0] || to, raw];
        else if (functionName === 'approve' && fnArgs.length < 2) fnArgs = [fnArgs[0] || to, raw];
        else if (functionName === 'burn' && fnArgs.length < 1) fnArgs = [raw];
        else if (functionName === 'transferFrom' && fnArgs.length < 3) fnArgs = [fnArgs[0] || from, fnArgs[1] || to, raw];
      }
      callData = viem.encodeFunctionData({ abi: getTokenAbi(), functionName, args: fnArgs });
    }
    if (!callData) throw new Error('data or functionName+args required');
    to = tokenAddress;

    if (cfg.shadow) {
      const nonce = 0n;
      return {
        shadow: true,
        forwardRequest: { from, to, value: '0', gas: String(gas || cfg.gaslessMaxGas), nonce: String(nonce), data: callData },
        domain: this.getEip712Domain(forwarderAddress, chainId),
        types: this.getEip712Types(),
        primaryType: 'ForwardRequest',
        message: { from, to, value: '0', gas: String(gas || cfg.gaslessMaxGas), nonce: String(nonce), data: callData },
      };
    }
    const { publicClient } = walletClient();
    const forwarderAbi = getForwarderAbi();
    const nonce = await publicClient.readContract({
      address: forwarderAddress,
      abi: forwarderAbi,
      functionName: 'getNonce',
      args: [from],
    }).catch(() => 0n);
    return {
      shadow: false,
      forwardRequest: {
        from,
        to,
        value: '0',
        gas: String(gas || cfg.gaslessMaxGas),
        nonce: String(nonce),
        data: callData,
      },
      domain: this.getEip712Domain(forwarderAddress, chainId),
      types: this.getEip712Types(),
      primaryType: 'ForwardRequest',
      message: {
        from,
        to,
        value: '0',
        gas: String(gas || cfg.gaslessMaxGas),
        nonce: String(nonce),
        data: callData,
      },
    };
  }

  static async relayMetaTx({ request, signature }) {
    const cfg = this.getConfig();
    const token = await this._loadToken();
    if (!token) throw new Error('token not deployed');
    if (cfg.shadow) {
      return { success: true, shadow: true, tx: `shadow-relay-${Date.now()}` };
    }
    const { wallet, publicClient, fees } = walletClient();

    const req = {
      ...request,
      value: request.value ? BigInt(request.value) : 0n,
      gas: request.gas ? BigInt(request.gas) : 500000n,
      nonce: request.nonce ? BigInt(request.nonce) : 0n,
    };
    const hash = await wallet.writeContract({
      address: token.forwarder_address,
      abi: getForwarderAbi(),
      functionName: 'execute',
      args: [req, signature],
      gas: req.gas + 50000n,
      value: req.value,
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`meta-tx relay failed: ${receipt.transactionHash}`);
    return { success: true, tx: receipt.transactionHash, gasUsed: receipt.gasUsed.toString() };
  }

  // ─── Self-hosted fiat on/off ramps ──────────────────────────────────────────

  static async createOnRampOrder({ sourceType, sourceAccountId, amount, targetAddress, fiatReference, memo }) {
    await ensureTables();
    const token = await this._ensureDeployed();
    const result = await this.mintFromSource({ sourceType, sourceAccountId, to: targetAddress, amount, memo });
    return { ...result, direction: 'on_ramp', fiatReference };
  }

  static async createOffRampOrder({ fromAddress, sourceType, sourceAccountId, amount, fiatDestination, memo }) {
    await ensureTables();
    const token = await this._ensureDeployed();
    const result = await this.burnToSource({ from: fromAddress, sourceType, sourceAccountId, amount, memo });
    return { ...result, direction: 'off_ramp', fiatDestination };
  }

  static async listOrders() {
    await this._loadOrders();
    return Array.from(memory.orders.values()).sort((a, b) => b.created_at - a.created_at);
  }

  static async getOrder(orderId) {
    await this._loadOrders();
    return memory.orders.get(orderId) || null;
  }
}

module.exports = { SovereignTrustEngine };
