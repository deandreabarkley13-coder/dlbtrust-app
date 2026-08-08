'use strict';

/**
 * Account Abstraction (EIP-4337 v0.6) gas abstraction layer for the
 * Sovereign Trust Token system.
 *
 * Every trustee/beneficiary gets a SimpleAccount smart wallet whose
 * owner is their existing EOA.  Gas is sponsored by a SovereignTrustPaymaster
 * the trust operates: the paymaster keeps an EntryPoint deposit and signs
 * UserOperations off-chain.  End users never need native ETH in their wallets.
 *
 * Bundler: Particle Network free public bundler (or any ERC-4337 bundler).
 * Smart-account factory: canonical SimpleAccountFactory v0.6 on Sepolia.
 * Paymaster: self-hosted SovereignTrustPaymaster (deployed by the operator).
 *
 * Uses open-source tooling only: viem + viem/account-abstraction +
 * @account-abstraction/contracts + Particle public bundler.
 */

const fs = require('fs');
const path = require('path');
const { getConfig: getBaseConfig } = require('./config');

let viem;
let chains;
let accounts;
let aa;
try {
  viem = require('viem');
  chains = require('viem/chains');
  accounts = require('viem/accounts');
  aa = require('viem/account-abstraction');
} catch (e) {
  console.warn('[AccountAbstractionEngine] viem/account-abstraction not available:', e.message);
}

const DEFAULT_ENTRY_POINT_06 = aa?.entryPoint06Address || '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';
const DEFAULT_SIMPLE_ACCOUNT_FACTORY_06 = '0x9406Cc6185a346906296840746125a0E44976454';
const DEFAULT_BUNDLER_URL = 'https://bundler.particle.network';
const DEFAULT_VALIDITY_WINDOW_SEC = 300;

const FACTORY_ABI = viem?.parseAbi ? viem.parseAbi([
  'function createAccount(address owner, uint256 salt) external returns (address)',
  'function getAddress(address owner, uint256 salt) external view returns (address)',
]) : [];

const EXECUTE_ABI = viem?.parseAbi ? viem.parseAbi([
  'function execute(address dest, uint256 value, bytes calldata func) external',
  'function executeBatch(address[] calldata dest, bytes[] calldata func) external',
]) : [];

const ERC20_TRANSFER_ABI = viem?.parseAbi ? viem.parseAbi([
  'function transfer(address to, uint256 value) external returns (bool)',
]) : [];

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function bool(name, def = false) { const v = process.env[name]; return v ? String(v).toLowerCase() === 'true' : def; }
function num(name, def = 0) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : def; }

let pool = null;
try { pool = require('../bonds/pgPool'); } catch (e) { /* no DB in tests */ }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

const stateFilePath = path.join(process.env.DATA_DIR || '/data', 'aa-paymaster-state.json');
function loadStateFile() {
  try {
    if (fs.existsSync(stateFilePath)) return JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
  } catch (e) { console.warn('[AccountAbstractionEngine] loadStateFile failed:', e.message); }
  return null;
}
function saveStateFile(record) {
  try {
    fs.writeFileSync(stateFilePath, JSON.stringify(record, null, 2));
  } catch (e) { console.warn('[AccountAbstractionEngine] saveStateFile failed:', e.message); }
}

function id(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function getChain(chainId) {
  switch (chainId) {
    case 1: return chains?.mainnet;
    case 11155111: return chains?.sepolia;
    case 137: return chains?.polygon;
    case 42161: return chains?.arbitrum;
    case 8453: return chains?.base;
    default: return undefined;
  }
}

async function ensureTables() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS aa_paymasters (
        id TEXT PRIMARY KEY,
        chain_id INTEGER NOT NULL,
        network TEXT NOT NULL,
        paymaster_address TEXT,
        owner_address TEXT NOT NULL,
        deposit_tx TEXT,
        stake_tx TEXT,
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS aa_operations (
        id TEXT PRIMARY KEY,
        chain_id INTEGER NOT NULL,
        network TEXT NOT NULL,
        owner TEXT NOT NULL,
        smart_account TEXT,
        token_address TEXT,
        to_address TEXT,
        amount TEXT,
        status TEXT DEFAULT 'prepared',
        user_op_hash TEXT,
        on_chain_tx TEXT,
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (e) {
    console.warn('[AccountAbstractionEngine] ensureTables failed:', e.message);
  }
}

function getArtifact(file, parseJson = true) {
  const candidate = path.join(process.cwd(), 'artifacts', file);
  if (fs.existsSync(candidate)) return parseJson ? JSON.parse(fs.readFileSync(candidate, 'utf8')) : fs.readFileSync(candidate, 'utf8').trim();
  const fallback = path.join(__dirname, '..', '..', '..', 'artifacts', file);
  if (fs.existsSync(fallback)) return parseJson ? JSON.parse(fs.readFileSync(fallback, 'utf8')) : fs.readFileSync(fallback, 'utf8').trim();
  throw new Error(`artifact not found: ${file}`);
}

function getPaymasterAbi() {
  return getArtifact('SovereignTrustPaymaster_sol_SovereignTrustPaymaster.abi');
}

function getPaymasterBytecode() {
  return ('0x' + getArtifact('SovereignTrustPaymaster_sol_SovereignTrustPaymaster.bin', false)).toLowerCase();
}

const memory = {
  paymaster: null,
  operations: new Map(),
};

class AccountAbstractionEngine {
  static getConfig() {
    const base = getBaseConfig();
    let operatorAddress = base.operatorAddress;
    if (!operatorAddress && base.privateKey && accounts) {
      try { operatorAddress = accounts.privateKeyToAccount(base.privateKey).address; } catch (e) {}
    }
    return {
      ...base,
      operatorAddress,
      aaEnabled: bool('AA_ENABLED', true),
      aaShadow: bool('AA_SHADOW', true),
      entryPoint: str('AA_ENTRY_POINT', DEFAULT_ENTRY_POINT_06),
      factory: str('AA_FACTORY', DEFAULT_SIMPLE_ACCOUNT_FACTORY_06),
      bundlerUrl: str('AA_BUNDLER_URL', DEFAULT_BUNDLER_URL),
      paymasterAddress: str('AA_PAYMASTER_ADDRESS', ''),
      privateKey: base.privateKey,
      validityWindowSec: num('AA_VALIDITY_WINDOW_SEC', DEFAULT_VALIDITY_WINDOW_SEC),
    };
  }

  static _checkDeps() {
    if (!viem || !aa) throw new Error('Account abstraction dependencies not available');
    const cfg = this.getConfig();
    if (!cfg.privateKey) throw new Error('DAPP_PRIVATE_KEY not configured');
    return cfg;
  }

  static _publicClient(cfg) {
    const chain = getChain(cfg.chainId);
    const transport = viem.http(cfg.rpcUrl);
    return viem.createPublicClient({ chain, transport });
  }

  static _operatorAccount(cfg) {
    return accounts.privateKeyToAccount(cfg.privateKey);
  }

  static _walletClient(cfg) {
    const chain = getChain(cfg.chainId);
    const account = this._operatorAccount(cfg);
    return viem.createWalletClient({ account, chain, transport: viem.http(cfg.rpcUrl) });
  }

  static _bundlerTransport(cfg) {
    const isParticle = cfg.bundlerUrl.includes('particle');
    if (!isParticle) return viem.http(cfg.bundlerUrl, { timeout: 60000 });
    const chainId = cfg.chainId;
    return viem.http(cfg.bundlerUrl, {
      timeout: 60000,
      fetchFn: (url, init) => {
        const body = JSON.parse(init.body);
        body.chainId = chainId;
        return fetch(url, { ...init, body: JSON.stringify(body) });
      },
    });
  }

  static async _loadPaymaster() {
    if (memory.paymaster) return memory.paymaster;
    const fromFile = loadStateFile();
    if (fromFile && fromFile.paymaster_address) {
      memory.paymaster = fromFile;
      return fromFile;
    }
    if (!pool || !pool.query) return null;
    try {
      const { rows } = await pool.query('SELECT * FROM aa_paymasters ORDER BY created_at DESC LIMIT 1');
      if (rows && rows[0]) {
        memory.paymaster = rows[0];
        return rows[0];
      }
    } catch (e) {
      console.warn('[AccountAbstractionEngine] _loadPaymaster failed:', e.message);
    }
    return null;
  }

  static async _savePaymaster(record) {
    memory.paymaster = record;
    saveStateFile(record);
    if (!pool || !pool.query) return record;
    try {
      await pool.query(`
        INSERT INTO aa_paymasters (id, chain_id, network, paymaster_address, owner_address, deposit_tx, stake_tx, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO UPDATE SET
          paymaster_address = EXCLUDED.paymaster_address,
          deposit_tx = EXCLUDED.deposit_tx,
          stake_tx = EXCLUDED.stake_tx,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
      `, [record.id, record.chain_id, record.network, record.paymaster_address, record.owner_address, record.deposit_tx, record.stake_tx, JSON.stringify(record.metadata || {})]);
    } catch (e) {
      console.warn('[AccountAbstractionEngine] _savePaymaster failed:', e.message);
    }
    return record;
  }

  static async _saveOperation(record) {
    memory.operations.set(record.id, record);
    if (!pool) return record;
    try {
      await pool.query(`
        INSERT INTO aa_operations (id, chain_id, network, owner, smart_account, token_address, to_address, amount, status, user_op_hash, on_chain_tx, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          user_op_hash = EXCLUDED.user_op_hash,
          on_chain_tx = EXCLUDED.on_chain_tx,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
      `, [record.id, record.chain_id, record.network, record.owner, record.smart_account, record.token_address, record.to_address, record.amount, record.status, record.user_op_hash, record.on_chain_tx, JSON.stringify(record.metadata || {})]);
    } catch (e) {
      console.warn('[AccountAbstractionEngine] _saveOperation failed:', e.message);
    }
    return record;
  }

  static async readiness() {
    await ensureTables();
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.privateKey) issues.push('DAPP_PRIVATE_KEY not configured');
    if (!cfg.rpcUrl) issues.push('DAPP_RPC_URL not configured');
    if (!cfg.aaEnabled) issues.push('AA_ENABLED=false');
    let paymaster = await this._loadPaymaster();
    if (!paymaster && cfg.paymasterAddress) {
      paymaster = { id: id('AA-PAYMASTER'), chain_id: cfg.chainId, network: cfg.chainId === 1 ? 'mainnet' : 'sepolia', paymaster_address: cfg.paymasterAddress, owner_address: cfg.operatorAddress, metadata: {} };
      await this._savePaymaster(paymaster);
    }
    return {
      enabled: cfg.aaEnabled,
      shadow: cfg.aaShadow,
      chainId: cfg.chainId,
      entryPoint: cfg.entryPoint,
      factory: cfg.factory,
      bundlerUrl: cfg.bundlerUrl,
      paymasterAddress: paymaster?.paymaster_address || cfg.paymasterAddress || '',
      operatorAddress: cfg.operatorAddress,
      ready: issues.length === 0 && cfg.aaEnabled,
      issues,
    };
  }

  static async deployPaymaster({ force = false } = {}) {
    await ensureTables();
    const cfg = this._checkDeps();
    const operator = cfg.operatorAddress;
    let paymaster = await this._loadPaymaster();
    if (!force && paymaster && paymaster.paymaster_address && !paymaster.paymaster_address.startsWith('shadow-')) {
      return { success: true, shadow: false, paymaster: paymaster.paymaster_address, entryPoint: cfg.entryPoint, cached: true };
    }

    const record = {
      id: id('AA-PAYMASTER'),
      chain_id: cfg.chainId,
      network: cfg.chainId === 1 ? 'mainnet' : 'sepolia',
      paymaster_address: cfg.paymasterAddress || '',
      owner_address: operator,
      metadata: {},
    };

    if (cfg.aaShadow) {
      if (!record.paymaster_address) record.paymaster_address = `shadow-paymaster-${Date.now()}`;
      await this._savePaymaster(record);
      return { success: true, shadow: true, paymaster: record.paymaster_address, entryPoint: cfg.entryPoint };
    }

    const wallet = this._walletClient(cfg);
    const publicClient = this._publicClient(cfg);
    const fees = await this._feeValues(publicClient, cfg);

    const hash = await wallet.deployContract({
      abi: getPaymasterAbi(),
      bytecode: getPaymasterBytecode(),
      args: [cfg.entryPoint, operator],
      gas: 2000000n,
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`paymaster deploy failed: ${receipt.transactionHash}`);
    record.paymaster_address = receipt.contractAddress;
    record.metadata = { ...record.metadata, deployTx: receipt.transactionHash };
    await this._savePaymaster(record);
    return { success: true, shadow: false, paymaster: record.paymaster_address, entryPoint: cfg.entryPoint, tx: receipt.transactionHash };
  }

  static async getPaymasterBalance() {
    await ensureTables();
    const cfg = this._checkDeps();
    if (cfg.aaShadow) return { shadow: true, message: 'AA_SHADOW is enabled; no real balance to read' };
    const paymaster = await this._loadPaymaster();
    const address = cfg.paymasterAddress || paymaster?.paymaster_address;
    const publicClient = this._publicClient(cfg);
    const operatorEth = await publicClient.getBalance({ address: cfg.operatorAddress });
    if (!address || address.startsWith('shadow-')) {
      return {
        deployed: false,
        operatorAddress: cfg.operatorAddress,
        operatorEth: viem.formatEther(operatorEth),
        paymasterAddress: null,
        paymasterEth: '0',
        entryPointDeposit: '0',
        entryPointStake: '0',
        staked: false,
        unstakeDelaySec: 0,
        message: 'Paymaster not deployed; use Seed Paymaster to deploy and fund it.',
      };
    }
    const [paymasterEth, depositInfo] = await Promise.all([
      publicClient.getBalance({ address }),
      publicClient.readContract({
        address: cfg.entryPoint,
        abi: aa.entryPoint06Abi,
        functionName: 'getDepositInfo',
        args: [address],
      }).catch(() => ({ deposit: 0n, staked: false, stake: 0n, unstakeDelaySec: 0n, withdrawTime: 0n })),
    ]);
    return {
      deployed: true,
      paymasterAddress: address,
      operatorAddress: cfg.operatorAddress,
      operatorEth: viem.formatEther(operatorEth),
      paymasterEth: viem.formatEther(paymasterEth),
      entryPointDeposit: viem.formatEther(depositInfo?.deposit || 0n),
      entryPointStake: viem.formatEther(depositInfo?.stake || 0n),
      staked: !!depositInfo?.staked,
      unstakeDelaySec: Number(depositInfo?.unstakeDelaySec || 0n),
    };
  }

  static async seedPaymaster({ amountEth = '0.001', whitelistAddress } = {}) {
    await ensureTables();
    const cfg = this._checkDeps();
    if (cfg.aaShadow) return { shadow: true, message: 'AA_SHADOW is enabled. Set AA_SHADOW=false and fund the operator wallet to seed a real paymaster.' };

    const publicClient = this._publicClient(cfg);
    let paymasterRecord = await this._loadPaymaster();
    let paymasterAddress = cfg.paymasterAddress || paymasterRecord?.paymaster_address;

    // Deploy if missing
    if (!paymasterAddress || paymasterAddress.startsWith('shadow-')) {
      const operatorEth = await publicClient.getBalance({ address: cfg.operatorAddress });
      const estimatedDeploy = viem.parseEther('0.01');
      if (operatorEth < estimatedDeploy) {
        return {
          needs_funding: true,
          reason: 'deploy',
          operatorAddress: cfg.operatorAddress,
          operatorEth: viem.formatEther(operatorEth),
          requiredEth: '0.01',
          message: `Operator wallet needs at least 0.01 ETH to deploy the paymaster on chain ${cfg.chainId}.`,
        };
      }
      const deployed = await this.deployPaymaster();
      paymasterRecord = await this._loadPaymaster();
      paymasterAddress = deployed.paymaster || paymasterRecord?.paymaster_address;
    }

    if (!paymasterAddress || paymasterAddress.startsWith('shadow-')) throw new Error('paymaster not deployed');

    const depositAmt = viem.parseEther(String(amountEth));
    const stakeAmt = depositAmt;
    const gasReserve = viem.parseEther('0.0005');
    const required = depositAmt + stakeAmt + gasReserve;

    const [operatorEth] = await Promise.all([publicClient.getBalance({ address: cfg.operatorAddress })]);
    if (operatorEth < required) {
      return {
        needs_funding: true,
        reason: 'seed',
        operatorAddress: cfg.operatorAddress,
        paymasterAddress,
        operatorEth: viem.formatEther(operatorEth),
        requiredEth: viem.formatEther(required),
        shortfallEth: viem.formatEther(required - operatorEth),
        message: `Operator wallet needs ${viem.formatEther(required - operatorEth)} more ETH to deposit ${String(amountEth)} ETH and stake ${String(amountEth)} ETH on the EntryPoint.`,
      };
    }

    const fundResult = await this.fundPaymaster({ amountEth, unstakeDelaySec: 86400 });
    const whitelistResults = [];
    const senderToWhitelist = whitelistAddress || cfg.operatorAddress;
    try {
      whitelistResults.push(await this.whitelistSender(senderToWhitelist, true));
    } catch (err) {
      whitelistResults.push({ success: false, error: err.message });
    }

    const balances = await this.getPaymasterBalance();
    return {
      success: true,
      paymasterAddress,
      fund: fundResult,
      whitelistResults,
      balances,
      message: `Paymaster seeded. EntryPoint deposit ${balances.entryPointDeposit} ETH, stake ${balances.entryPointStake} ETH. Sender ${senderToWhitelist} whitelisted.`,
    };
  }

  static async fundPaymaster({ amountEth, unstakeDelaySec = 86400 } = {}) {
    await ensureTables();
    const cfg = this._checkDeps();
    const paymaster = await this._loadPaymaster();
    const address = cfg.paymasterAddress || paymaster?.paymaster_address;
    if (!address || address.startsWith('shadow-')) {
      if (cfg.aaShadow) return { shadow: true, paymaster: address, message: 'shadow mode - no on-chain deposit needed' };
      throw new Error('paymaster not deployed');
    }
    if (cfg.aaShadow) {
      return { shadow: true, paymaster: address, message: 'shadow mode - no on-chain deposit needed' };
    }

    const wallet = this._walletClient(cfg);
    const publicClient = this._publicClient(cfg);
    const value = typeof amountEth === 'bigint' ? amountEth : viem.parseEther(String(amountEth || '0.001'));
    const fees = await this._feeValues(publicClient, cfg);

    const depositHash = await wallet.writeContract({
      address: cfg.entryPoint,
      abi: aa.entryPoint06Abi,
      functionName: 'depositTo',
      args: [address],
      value,
      gas: 100000n,
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: depositHash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`deposit failed: ${receipt.transactionHash}`);

    const stakeHash = await wallet.writeContract({
      address,
      abi: getPaymasterAbi(),
      functionName: 'stake',
      args: [unstakeDelaySec],
      value,
      gas: 100000n,
      ...fees,
    });
    const stakeReceipt = await publicClient.waitForTransactionReceipt({ hash: stakeHash, timeout: 120000 });
    if (stakeReceipt.status !== 'success') throw new Error(`stake failed: ${stakeReceipt.transactionHash}`);

    if (paymaster) {
      paymaster.deposit_tx = receipt.transactionHash;
      paymaster.stake_tx = stakeReceipt.transactionHash;
      await this._savePaymaster(paymaster);
    }
    return { success: true, paymaster: address, depositTx: receipt.transactionHash, stakeTx: stakeReceipt.transactionHash };
  }

  static async whitelistSender(address, allowed = true) {
    await ensureTables();
    const cfg = this._checkDeps();
    const paymaster = await this._loadPaymaster();
    const paymasterAddress = cfg.paymasterAddress || paymaster?.paymaster_address;
    if (!paymasterAddress || paymasterAddress.startsWith('shadow-')) {
      if (cfg.aaShadow) return { shadow: true, paymaster: paymasterAddress, address, allowed };
      throw new Error('paymaster not deployed');
    }
    const wallet = this._walletClient(cfg);
    const publicClient = this._publicClient(cfg);
    const fees = await this._feeValues(publicClient, cfg);
    const hash = await wallet.writeContract({
      address: paymasterAddress,
      abi: getPaymasterAbi(),
      functionName: 'setWhitelisted',
      args: [address, allowed],
      gas: 100000n,
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`whitelist failed: ${receipt.transactionHash}`);
    return { success: true, paymaster: paymasterAddress, address, allowed, tx: receipt.transactionHash };
  }

  static async getSmartAccountAddress(ownerAddress, index = 0n) {
    const cfg = this._checkDeps();
    if (!viem.isAddress(ownerAddress)) throw new Error('invalid owner address');
    const publicClient = this._publicClient(cfg);
    return await publicClient.readContract({
      address: cfg.factory,
      abi: FACTORY_ABI,
      functionName: 'getAddress',
      args: [ownerAddress, index],
    });
  }

  static async buildSmartAccount(ownerAddress, index = 0n) {
    const cfg = this._checkDeps();
    const publicClient = this._publicClient(cfg);
    const client = publicClient;

    const getAddress = () => this.getSmartAccountAddress(ownerAddress, index);
    const getFactoryArgs = () => {
      const factoryData = viem.encodeFunctionData({
        abi: FACTORY_ABI,
        functionName: 'createAccount',
        args: [ownerAddress, index],
      });
      return { factory: cfg.factory, factoryData };
    };
    const encodeCalls = (calls) => {
      if (calls.length === 1) {
        const c = calls[0];
        return viem.encodeFunctionData({
          abi: EXECUTE_ABI,
          functionName: 'execute',
          args: [c.to, c.value || 0n, c.data || '0x'],
        });
      }
      const dest = calls.map(c => c.to);
      const data = calls.map(c => c.data || '0x');
      return viem.encodeFunctionData({
        abi: EXECUTE_ABI,
        functionName: 'executeBatch',
        args: [dest, data],
      });
    };
    const getStubSignature = () => '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c';

    const account = await aa.toSmartAccount({
      client,
      entryPoint: { address: cfg.entryPoint, abi: aa.entryPoint06Abi, version: '0.6' },
      getAddress,
      getFactoryArgs,
      encodeCalls,
      getStubSignature,
      sign: async () => { throw new Error('No signer available on server'); },
      signMessage: async () => { throw new Error('No signer available on server'); },
      signTypedData: async () => { throw new Error('No signer available on server'); },
      signUserOperation: async () => { throw new Error('No signer available on server'); },
    });
    return account;
  }

  static async _getSenderNonce(paymasterAddress, sender) {
    const cfg = this.getConfig();
    if (!paymasterAddress || paymasterAddress.startsWith('shadow-') || cfg.aaShadow) return 0n;
    const publicClient = this._publicClient(cfg);
    try {
      return await publicClient.readContract({
        address: paymasterAddress,
        abi: getPaymasterAbi(),
        functionName: 'senderNonce',
        args: [sender],
      });
    } catch (e) {
      console.warn('[AccountAbstractionEngine] senderNonce read failed:', e.message);
      return 0n;
    }
  }

  static _normalizeUserOpField(userOp, field, fallback) {
    const v = userOp[field];
    if (v === undefined || v === null) return fallback;
    if (typeof v === 'bigint') return v;
    if (typeof v === 'string') {
      if (v.startsWith('0x')) return BigInt(v);
      try { return BigInt(v); } catch { return fallback; }
    }
    if (typeof v === 'number') return BigInt(v);
    return fallback;
  }

  static _sanitizeUserOp(userOp) {
    // Keep every field from the userOp intact; only zero out paymasterAndData
    // and signature so the paymaster hash is not circular. getHash ignores those
    // two fields anyway, but we sanitize them for clarity.
    return {
      sender: userOp.sender,
      nonce: userOp.nonce ?? 0n,
      initCode: userOp.initCode || '0x',
      callData: userOp.callData || '0x',
      callGasLimit: userOp.callGasLimit ?? 0n,
      verificationGasLimit: userOp.verificationGasLimit ?? 0n,
      preVerificationGas: userOp.preVerificationGas ?? 0n,
      maxFeePerGas: userOp.maxFeePerGas ?? 0n,
      maxPriorityFeePerGas: userOp.maxPriorityFeePerGas ?? 0n,
      paymasterAndData: '0x',
      signature: '0x',
    };
  }

  static async _buildPaymasterAndData(userOp, paymasterAddress, isStub = false) {
    const cfg = this._checkDeps();
    const validUntil = Math.floor(Date.now() / 1000) + cfg.validityWindowSec;
    const validAfter = 0;
    const validityBytes = viem.encodeAbiParameters([{ type: 'uint48' }, { type: 'uint48' }], [validUntil, validAfter]);

    if (cfg.aaShadow) {
      const pm = viem.isAddress(paymasterAddress) ? paymasterAddress : '0x0000000000000000000000000000000000000000';
      const stubSig = ('0x' + '00'.repeat(65));
      return viem.concat([pm, validityBytes, stubSig]);
    }

    const operator = this._operatorAccount(cfg);
    const publicClient = this._publicClient(cfg);
    const userOpForHash = this._sanitizeUserOp({ ...userOp, paymasterAndData: '0x', signature: '0x' });

    const hash = await publicClient.readContract({
      address: paymasterAddress,
      abi: getPaymasterAbi(),
      functionName: 'getHash',
      args: [userOpForHash, validUntil, validAfter],
    });

    const signature = await operator.signMessage({ message: { raw: hash } });
    const recovered = await viem.recoverMessageAddress({ message: { raw: hash }, signature }).catch(() => null);
    console.log('[AA] _buildPaymasterAndData hash:', hash, 'signature:', signature, 'isStub:', isStub, 'validUntil:', validUntil, 'operator:', operator.address, 'recovered:', recovered);
    return viem.concat([paymasterAddress, validityBytes, signature]);
  }

  static _paymasterActions(paymasterAddress) {
    return {
      getPaymasterStubData: async (parameters) => ({
        paymasterAndData: await this._buildPaymasterAndData(parameters, paymasterAddress, true),
      }),
      getPaymasterData: async (parameters) => ({
        paymasterAndData: await this._buildPaymasterAndData(parameters, paymasterAddress, false),
      }),
    };
  }

  static async _feeValues(publicClient, cfg, paymasterAddress, estimatedGas = 1700000n) {
    try {
      const block = await publicClient.getBlock({ blockTag: 'latest' });
      const baseFee = block.baseFeePerGas;
      if (!baseFee) throw new Error('no base fee');
      let deposit = 0n;
      if (paymasterAddress && viem.isAddress(paymasterAddress)) {
        deposit = await publicClient.readContract({
          address: cfg.entryPoint,
          abi: aa.entryPoint06Abi,
          functionName: 'getDepositInfo',
          args: [paymasterAddress],
        }).then(info => info?.deposit || 0n).catch(() => 0n);
      }
      const requiredGas = BigInt(estimatedGas);
      // Cap the gas price so the EntryPoint requiredPreFund (3x verificationGasLimit) fits in the paymaster deposit.
      // userOpGasPrice = min(maxFeePerGas, baseFee + maxPriorityFeePerGas). We target that price.
      const targetGasPrice = deposit > 0n
        ? (deposit * 90n) / (requiredGas * 100n) // 10% buffer for deposit / gas mismatch
        : baseFee + 150000000n; // fallback 0.15 gwei
      const minPriority = 70000000n; // 0.07 gwei; ignored if deposit cannot cover it
      let maxPriorityFeePerGas = targetGasPrice > baseFee ? targetGasPrice - baseFee : targetGasPrice;
      if (maxPriorityFeePerGas < minPriority && targetGasPrice >= baseFee + minPriority) {
        maxPriorityFeePerGas = minPriority;
      }
      if (maxPriorityFeePerGas < 1n) maxPriorityFeePerGas = 1n;
      const maxFeePerGas = targetGasPrice;
      return { maxFeePerGas, maxPriorityFeePerGas };
    } catch (e) {
      if (cfg.chainId !== 1 && cfg.chainId !== 11155111) return { maxFeePerGas: 5000000000n, maxPriorityFeePerGas: 1500000000n };
      return { maxFeePerGas: 5000000000n, maxPriorityFeePerGas: 1500000000n };
    }
  }

  static async prepareGaslessTransfer({ owner, to, amount, token, tokenAddress, index = 0n } = {}) {
    await ensureTables();
    const cfg = this._checkDeps();
    if (!viem.isAddress(owner)) throw new Error('owner must be an EVM address');
    if (!viem.isAddress(to)) throw new Error('to must be an EVM address');
    tokenAddress = tokenAddress || token;
    if (!tokenAddress) {
      try {
        const { SovereignTrustEngine } = require('./sovereignTrustEngine');
        const token = await SovereignTrustEngine._loadToken();
        tokenAddress = token?.token_address;
      } catch (e) { /* ignore */ }
    }
    if (!tokenAddress || tokenAddress.startsWith('shadow-')) {
      if (cfg.aaShadow) tokenAddress = tokenAddress || 'shadow-token';
      else throw new Error('sovereign token not deployed');
    }
    if (!amount || amount === '0') throw new Error('amount required');

    const account = await this.buildSmartAccount(owner, typeof index === 'bigint' ? index : BigInt(index || 0));
    const smartAccountAddress = account.address;

    const publicClient = this._publicClient(cfg);
    const decimals = (tokenAddress && tokenAddress.startsWith('0x')) ? await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_TRANSFER_ABI,
      functionName: 'decimals',
    }).catch(() => 18) : 18;
    const rawAmount = viem.parseUnits(String(amount), decimals);
    const callData = viem.encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: 'transfer',
      args: [to, rawAmount],
    });

    let userOp;
    let userOpHash;

    if (cfg.aaShadow) {
      const initCode = await (async () => {
        const { factory, factoryData } = await account.getFactoryArgs();
        return viem.concat([factory, factoryData]);
      })();
      const fees = await this._feeValues(this._publicClient(cfg), cfg, paymasterAddress);
      userOp = {
        sender: smartAccountAddress,
        nonce: 0n,
        initCode,
        callData: await account.encodeCalls([{ to: tokenAddress, value: 0n, data: callData }]),
        callGasLimit: 100000n,
        verificationGasLimit: 100000n,
        preVerificationGas: 50000n,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        paymasterAndData: '0x',
        signature: '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c',
      };
      const paymaster = await this._loadPaymaster();
      const paymasterAddress = cfg.paymasterAddress || paymaster?.paymaster_address || 'shadow-paymaster';
      userOp.paymasterAndData = await this._buildPaymasterAndData(userOp, paymasterAddress);
      userOpHash = aa.getUserOperationHash({
        chainId: cfg.chainId,
        entryPointAddress: cfg.entryPoint,
        entryPointVersion: '0.6',
        userOperation: userOp,
      });
      const operator = this._operatorAccount(cfg);
      userOp.signature = await operator.signMessage({ message: { raw: userOpHash } });
    } else {
      const publicClient = this._publicClient(cfg);
      const paymasterAddress = cfg.paymasterAddress || (await this._loadPaymaster())?.paymaster_address;
      if (!paymasterAddress || paymasterAddress.startsWith('shadow-')) throw new Error('paymaster not deployed');
      const fees = await this._feeValues(publicClient, cfg, paymasterAddress);
      const bundlerClient = aa.createBundlerClient({
        account,
        chain: getChain(cfg.chainId),
        client: publicClient,
        transport: this._bundlerTransport(cfg),
        paymaster: this._paymasterActions(paymasterAddress),
      });
      // Use a fixed EntryPoint nonce sequence (key 0) so the paymaster hash is
      // stable between gas estimation and the final send call.
      const nonce = await publicClient.readContract({
        address: cfg.entryPoint,
        abi: aa.entryPoint06Abi,
        functionName: 'getNonce',
        args: [smartAccountAddress, 0n],
      }).catch(() => 0n);

      console.log('[AA] prepareUserOperation inputs:', { sender: smartAccountAddress, owner, nonce: String(nonce), tokenAddress, to, amount: String(amount) });
      userOp = await aa.prepareUserOperation(bundlerClient, {
        calls: [{ to: tokenAddress, value: 0n, data: callData }],
        nonce,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      console.log('[AA] prepared userOp:', this._serializeUserOp(userOp));

      // Recompute fees based on actual gas limits so the paymaster deposit can cover the bundler's signerGasPrice.
      const actualRequiredGas = (userOp.callGasLimit || 0n) + (userOp.verificationGasLimit || 0n) * 3n + (userOp.preVerificationGas || 0n);
      const adjustedFees = await this._feeValues(publicClient, cfg, paymasterAddress, actualRequiredGas);
      if (adjustedFees.maxFeePerGas !== fees.maxFeePerGas || adjustedFees.maxPriorityFeePerGas !== fees.maxPriorityFeePerGas) {
        console.log('[AA] adjusting fees to:', adjustedFees);
        userOp = await aa.prepareUserOperation(bundlerClient, {
          calls: [{ to: tokenAddress, value: 0n, data: callData }],
          nonce,
          maxFeePerGas: adjustedFees.maxFeePerGas,
          maxPriorityFeePerGas: adjustedFees.maxPriorityFeePerGas,
        });
        console.log('[AA] re-prepared userOp:', this._serializeUserOp(userOp));
      }

      userOpHash = aa.getUserOperationHash({
        chainId: cfg.chainId,
        entryPointAddress: cfg.entryPoint,
        entryPointVersion: '0.6',
        userOperation: userOp,
      });
      const operator = this._operatorAccount(cfg);
      userOp.signature = await operator.signMessage({ message: { raw: userOpHash } });
    }

    const operation = {
      id: id('AA-OP'),
      chain_id: cfg.chainId,
      network: cfg.chainId === 1 ? 'mainnet' : 'sepolia',
      owner,
      smart_account: smartAccountAddress,
      token_address: tokenAddress,
      to_address: to,
      amount: String(amount),
      status: 'prepared',
      user_op_hash: userOpHash,
      metadata: { userOp: this._serializeUserOp(userOp), paymasterAndData: userOp.paymasterAndData },
    };
    await this._saveOperation(operation);

    return {
      operationId: operation.id,
      smartAccountAddress,
      userOpHash,
      paymasterAndData: userOp.paymasterAndData,
      signature: userOp.signature,
      userOp: this._serializeUserOp(userOp),
      shadow: cfg.aaShadow,
    };
  }

  static _serializeUserOp(userOp) {
    const out = {};
    for (const [k, v] of Object.entries(userOp)) {
      out[k] = typeof v === 'bigint' ? String(v) : v;
    }
    return out;
  }

  static _deserializeUserOp(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v) && v.length > 66) {
        out[k] = v; // hex bytes
      } else if (typeof v === 'string' && /^\d+$/.test(v)) {
        out[k] = BigInt(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  static async submitGaslessTransfer({ operationId, signature } = {}) {
    await ensureTables();
    const cfg = this._checkDeps();
    const op = memory.operations.get(operationId) || (await this._dbOperation(operationId));
    if (!op) throw new Error('operation not found');

    const userOp = this._deserializeUserOp(op.metadata.userOp);
    let userOpHash = aa.getUserOperationHash({
      chainId: cfg.chainId,
      entryPointAddress: cfg.entryPoint,
      entryPointVersion: '0.6',
      userOperation: userOp,
    });

    if (signature) {
      userOp.signature = signature;
    } else {
      const operator = this._operatorAccount(cfg);
      userOp.signature = await operator.signMessage({ message: { raw: userOpHash } });
    }

    if (cfg.aaShadow) {
      op.status = 'completed';
      op.on_chain_tx = `shadow-aa-${op.id}`;
      await this._saveOperation(op);
      return { success: true, shadow: true, operationId, userOpHash, tx: op.on_chain_tx };
    }

    const publicClient = this._publicClient(cfg);
    const bundlerClient = aa.createBundlerClient({
      chain: getChain(cfg.chainId),
      client: publicClient,
      transport: this._bundlerTransport(cfg),
    });

    const rpcUserOp = aa.formatUserOperationRequest(userOp);
    const submittedUserOpHash = await bundlerClient.request({
      method: 'eth_sendUserOperation',
      params: [rpcUserOp, cfg.entryPoint],
    });
    const receipt = await aa.waitForUserOperationReceipt(bundlerClient, { hash: submittedUserOpHash });

    op.status = 'completed';
    op.on_chain_tx = receipt.receipt.transactionHash || receipt.userOpHash;
    await this._saveOperation(op);

    return { success: true, operationId, userOpHash: submittedUserOpHash, tx: receipt.receipt.transactionHash || receipt.userOpHash, receipt: JSON.parse(JSON.stringify(receipt, (k, v) => typeof v === 'bigint' ? String(v) : v)) };
  }

  static async _dbOperation(operationId) {
    if (!pool) return null;
    const { rows } = await pool.query('SELECT * FROM aa_operations WHERE id = $1', [operationId]);
    if (!rows || !rows[0]) return null;
    return rows[0];
  }
}

module.exports = { AccountAbstractionEngine };
