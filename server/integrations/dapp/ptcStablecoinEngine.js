'use strict';

/**
 * PTC-backed Stablecoin Engine
 *
 * Deploys a private/permissioned stablecoin (DLB-PTCUSD) and a reserve vault
 * for the DLB Private Trust Company. The stablecoin is minted when the trust
 * deposits tokenized module assets (DLB-BOND, DLB-FIXED-INCOME, DLB-TREASURY,
 * etc.) into the reserve vault, and burned when those reserves are redeemed.
 *
 * Designed for internal settlement within the private trust, not as a public
 * offering. All reserves remain in the custody of the PTC and are auditable
 * on-chain.
 */

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config');

let viem;
try { viem = require('viem'); } catch (e) { /* optional */ }
const { mainnet, sepolia } = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');

let ModuleSmartAccountEngine;
try { ModuleSmartAccountEngine = require('./moduleSmartAccountEngine').ModuleSmartAccountEngine; } catch (e) { ModuleSmartAccountEngine = null; }

function str(name, def = '') { return (process.env[name] || def).trim(); }
function num(name, def = 0) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : def; }

function dataDir() {
  if (process.env.PERSISTENT_DATA_DIR && fs.existsSync(process.env.PERSISTENT_DATA_DIR)) return process.env.PERSISTENT_DATA_DIR;
  if (fs.existsSync('/data')) return '/data';
  return path.join(process.cwd(), 'data');
}

function statePath() { return path.join(dataDir(), 'ptc-stablecoin-state.json'); }

function ensureDir() {
  const dir = dataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadState() {
  ensureDir();
  try {
    const p = statePath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { console.warn('[PtcStablecoinEngine] load state failed:', e.message); }
  return {};
}

function saveState(state) {
  ensureDir();
  try {
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
  } catch (e) { console.warn('[PtcStablecoinEngine] save state failed:', e.message); }
}

function safeJson(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v); }

function getArtifact(name) {
  const p = path.join(process.cwd(), 'artifacts', `contracts_PtcStablecoinSystem_sol_${name}.abi`);
  const bin = path.join(process.cwd(), 'artifacts', `contracts_PtcStablecoinSystem_sol_${name}.bin`);
  if (!fs.existsSync(p)) throw new Error(`Artifact not found: ${p}`);
  return { abi: JSON.parse(fs.readFileSync(p, 'utf8')), bytecode: fs.readFileSync(bin, 'utf8') };
}

function chainById(id) {
  switch (id) {
    case 1: return mainnet;
    case 11155111: return sepolia;
    default: return mainnet;
  }
}

function clients(cfg) {
  if (!viem) throw new Error('viem not installed');
  if (!cfg.privateKey) throw new Error('DAPP_PRIVATE_KEY not configured');
  const account = privateKeyToAccount(cfg.privateKey.startsWith('0x') ? cfg.privateKey : `0x${cfg.privateKey}`);
  const chain = chainById(cfg.chainId);
  const fees = cfg.getFees ? (cfg.getFees() || { maxFeePerGas: viem.parseGwei('20'), maxPriorityFeePerGas: viem.parseGwei('0.5') }) : { maxFeePerGas: viem.parseGwei('20'), maxPriorityFeePerGas: viem.parseGwei('0.5') };
  const publicClient = viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) });
  const walletClient = viem.createWalletClient({ account, chain, transport: viem.http(cfg.rpcUrl) });
  return { account, publicClient, walletClient, fees };
}

class PtcStablecoinEngine {
  static get defaultReserveTokens() {
    return ['bond_portfolio', 'fixed_income', 'treasury', 'trust_accounting', 'core_banking'];
  }

  static async deploy({ tokenName, tokenSymbol, force = false } = {}) {
    const cfg = getConfig();
    const state = loadState();
    if (!force && state.tokenAddress && state.vaultAddress) return state;

    const { account, publicClient, walletClient, fees } = clients(cfg);
    const stablecoinArtifact = getArtifact('PtcBackedStablecoin');
    const vaultArtifact = getArtifact('PtcReserveVault');

    // Deploy PtcBackedStablecoin
    const name = tokenName || 'DLB PTC Stablecoin';
    const symbol = tokenSymbol || 'DLB-PTCUSD';
    const stablecoinHash = await walletClient.deployContract({
      abi: stablecoinArtifact.abi,
      bytecode: stablecoinArtifact.bytecode,
      args: [name, symbol, account.address],
      ...fees,
    });
    const stablecoinReceipt = await publicClient.waitForTransactionReceipt({ hash: stablecoinHash, timeout: 120000 });
    if (stablecoinReceipt.status !== 'success') throw new Error(`PtcBackedStablecoin deploy failed: ${stablecoinHash}`);
    const tokenAddress = stablecoinReceipt.contractAddress;

    // Deploy PtcReserveVault
    const vaultHash = await walletClient.deployContract({
      abi: vaultArtifact.abi,
      bytecode: vaultArtifact.bytecode,
      args: [account.address, tokenAddress],
      ...fees,
    });
    const vaultReceipt = await publicClient.waitForTransactionReceipt({ hash: vaultHash, timeout: 120000 });
    if (vaultReceipt.status !== 'success') throw new Error(`PtcReserveVault deploy failed: ${vaultHash}`);
    const vaultAddress = vaultReceipt.contractAddress;

    // Configure roles and whitelist
    const txParams = { ...fees };
    const setMinterHash = await walletClient.writeContract({
      address: tokenAddress, abi: stablecoinArtifact.abi, functionName: 'setMinter', args: [vaultAddress, true], ...txParams,
    });
    await publicClient.waitForTransactionReceipt({ hash: setMinterHash, timeout: 120000 });

    const whitelistHash = await walletClient.writeContract({
      address: tokenAddress, abi: stablecoinArtifact.abi, functionName: 'setWhitelisted', args: [vaultAddress, true], ...txParams,
    });
    await publicClient.waitForTransactionReceipt({ hash: whitelistHash, timeout: 120000 });

    const ownerWhitelistHash = await walletClient.writeContract({
      address: tokenAddress, abi: stablecoinArtifact.abi, functionName: 'setWhitelisted', args: [account.address, true], ...txParams,
    });
    await publicClient.waitForTransactionReceipt({ hash: ownerWhitelistHash, timeout: 120000 });

    state.tokenAddress = tokenAddress;
    state.vaultAddress = vaultAddress;
    state.tokenName = name;
    state.tokenSymbol = symbol;
    state.owner = account.address;
    state.network = cfg.chainId === 1 ? 'mainnet' : 'sepolia';
    state.createdAt = new Date().toISOString();
    state.reserveTokens = [];
    saveState(state);

    return { tokenAddress, vaultAddress, tokenName: name, tokenSymbol: symbol, deployTx: stablecoinHash, vaultTx: vaultHash };
  }

  static async _getModuleToken(moduleKey) {
    if (!ModuleSmartAccountEngine) throw new Error('ModuleSmartAccountEngine not available');
    const mod = await ModuleSmartAccountEngine.getModule(moduleKey);
    if (!mod || !mod.token_address) throw new Error(`Module ${moduleKey} has not been tokenized`);
    return { address: mod.token_address, decimals: mod.config?.decimals || 6, moduleKey, name: mod.config?.tokenSymbol || mod.module_key };
  }

  static async addReserveToken({ token, decimals, price, moduleKey } = {}) {
    const cfg = getConfig();
    const state = loadState();
    if (!state.vaultAddress || !state.tokenAddress) throw new Error('PTC stablecoin not deployed');
    const { account, publicClient, walletClient, fees } = clients(cfg);
    const vaultArtifact = getArtifact('PtcReserveVault');

    let reserve;
    if (moduleKey) {
      reserve = await this._getModuleToken(moduleKey);
    } else {
      if (!token) throw new Error('token address or moduleKey required');
      if (!decimals) throw new Error('decimals required');
      reserve = { address: token, decimals: Number(decimals), moduleKey: 'custom' };
    }
    const priceWei = price || '1000000000000000000'; // $1.00 in 18 decimals

    const hash = await walletClient.writeContract({
      address: state.vaultAddress,
      abi: vaultArtifact.abi,
      functionName: 'addReserveToken',
      args: [reserve.address, Number(reserve.decimals), priceWei],
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`addReserveToken failed: ${hash}`);

    if (!state.reserveTokens.find(r => r.address.toLowerCase() === reserve.address.toLowerCase())) {
      state.reserveTokens.push({ address: reserve.address, decimals: reserve.decimals, moduleKey: reserve.moduleKey, name: reserve.name, price: priceWei, addedAt: new Date().toISOString() });
      saveState(state);
    }

    return { reserve, txHash: hash };
  }

  static async addDefaultReserveTokens() {
    const results = [];
    for (const moduleKey of this.defaultReserveTokens) {
      try {
        const mod = await ModuleSmartAccountEngine?.getModule(moduleKey);
        if (mod && mod.token_address) {
          results.push(await this.addReserveToken({ moduleKey }));
        }
      } catch (e) { results.push({ moduleKey, error: e.message }); }
    }
    return results;
  }

  static async getOperatorTokenBalance(tokenAddress) {
    const cfg = getConfig();
    const { publicClient } = clients(cfg);
    const raw = await publicClient.readContract({
      address: tokenAddress,
      abi: [{ type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
      functionName: 'balanceOf',
      args: [cfg.operatorAddress],
    });
    return raw;
  }

  static async approveAndDeposit({ moduleKey, token, amount = 'all', recipient } = {}) {
    const cfg = getConfig();
    const state = loadState();
    if (!state.vaultAddress) throw new Error('PTC reserve vault not deployed');
    const { account, publicClient, walletClient, fees } = clients(cfg);
    const stablecoinArtifact = getArtifact('PtcBackedStablecoin');
    const vaultArtifact = getArtifact('PtcReserveVault');

    let reserve;
    if (moduleKey) {
      reserve = await this._getModuleToken(moduleKey);
    } else {
      if (!token) throw new Error('token address or moduleKey required');
      const meta = state.reserveTokens.find(r => r.address.toLowerCase() === token.toLowerCase());
      reserve = { address: token, decimals: meta ? meta.decimals : 6 };
    }

    const operatorAddress = cfg.operatorAddress;
    const to = recipient || operatorAddress;

    // Determine amount
    let rawAmount;
    if (String(amount).toLowerCase() === 'all') {
      rawAmount = await this.getOperatorTokenBalance(reserve.address);
    } else {
      rawAmount = viem.parseUnits(String(amount), Number(reserve.decimals));
    }
    if (rawAmount <= 0n) throw new Error(`No ${moduleKey || token} balance available to deposit`);

    // Approve vault
    const existingAllowance = await publicClient.readContract({
      address: reserve.address,
      abi: [{ type: 'function', name: 'allowance', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
      functionName: 'allowance',
      args: [operatorAddress, state.vaultAddress],
    });
    if (BigInt(existingAllowance || 0) < BigInt(rawAmount)) {
      const approveHash = await walletClient.writeContract({
        address: reserve.address,
        abi: [{ type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' }],
        functionName: 'approve',
        args: [state.vaultAddress, rawAmount],
        ...fees,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: 120000 });
    }

    // Whitelist recipient before mint
    const isWhitelisted = await publicClient.readContract({
      address: state.tokenAddress,
      abi: stablecoinArtifact.abi,
      functionName: 'whitelisted',
      args: [to],
    }).catch(() => true);
    if (!isWhitelisted) {
      const wlHash = await walletClient.writeContract({
        address: state.tokenAddress, abi: stablecoinArtifact.abi, functionName: 'setWhitelisted', args: [to, true], ...fees,
      });
      await publicClient.waitForTransactionReceipt({ hash: wlHash, timeout: 120000 });
    }

    const depositHash = await walletClient.writeContract({
      address: state.vaultAddress,
      abi: vaultArtifact.abi,
      functionName: 'depositReserve',
      args: [reserve.address, rawAmount, to],
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: depositHash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`depositReserve failed: ${depositHash}`);

    const minted = (BigInt(rawAmount) * 10n ** 18n) / (10n ** BigInt(reserve.decimals));
    return { moduleKey, token: reserve.address, amount: rawAmount.toString(), mintedStablecoin: minted.toString(), recipient: to, txHash: depositHash };
  }

  static async depositAll({ recipient } = {}) {
    const results = [];
    for (const moduleKey of this.defaultReserveTokens) {
      try {
        const mod = await ModuleSmartAccountEngine?.getModule(moduleKey);
        if (mod && mod.token_address) {
          results.push(await this.approveAndDeposit({ moduleKey, amount: 'all', recipient }));
        }
      } catch (e) { results.push({ moduleKey, error: e.message }); }
    }
    return results;
  }

  static async redeem({ moduleKey, token, amount, recipient } = {}) {
    const cfg = getConfig();
    const state = loadState();
    if (!state.vaultAddress) throw new Error('PTC reserve vault not deployed');
    const { account, publicClient, walletClient, fees } = clients(cfg);
    const stablecoinArtifact = getArtifact('PtcBackedStablecoin');
    const vaultArtifact = getArtifact('PtcReserveVault');

    let reserve;
    if (moduleKey) {
      reserve = await this._getModuleToken(moduleKey);
    } else {
      const meta = state.reserveTokens.find(r => r.address.toLowerCase() === (token || '').toLowerCase());
      reserve = { address: token, decimals: meta ? meta.decimals : 6 };
    }

    const to = recipient || cfg.operatorAddress;
    const rawStablecoin = viem.parseEther(String(amount));

    // Approve vault to burn stablecoin
    const existingAllowance = await publicClient.readContract({
      address: state.tokenAddress,
      abi: stablecoinArtifact.abi,
      functionName: 'allowance',
      args: [cfg.operatorAddress, state.vaultAddress],
    });
    if (BigInt(existingAllowance || 0) < BigInt(rawStablecoin)) {
      const approveHash = await walletClient.writeContract({
        address: state.tokenAddress,
        abi: stablecoinArtifact.abi,
        functionName: 'approve',
        args: [state.vaultAddress, rawStablecoin],
        ...fees,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: 120000 });
    }

    const redeemHash = await walletClient.writeContract({
      address: state.vaultAddress,
      abi: vaultArtifact.abi,
      functionName: 'redeemReserve',
      args: [reserve.address, rawStablecoin, to],
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: redeemHash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`redeemReserve failed: ${redeemHash}`);

    const reserveAmount = (BigInt(rawStablecoin) * (10n ** BigInt(reserve.decimals))) / 10n ** 18n;
    return { moduleKey, token: reserve.address, stablecoinAmount: rawStablecoin.toString(), reserveAmount: reserveAmount.toString(), recipient: to, txHash: redeemHash };
  }

  static async whitelist(address, allowed = true) {
    const cfg = getConfig();
    const state = loadState();
    if (!state.tokenAddress) throw new Error('PTC stablecoin not deployed');
    const { publicClient, walletClient, fees } = clients(cfg);
    const stablecoinArtifact = getArtifact('PtcBackedStablecoin');
    const hash = await walletClient.writeContract({
      address: state.tokenAddress,
      abi: stablecoinArtifact.abi,
      functionName: 'setWhitelisted',
      args: [address, allowed],
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`whitelist failed: ${hash}`);
    return { address, allowed, txHash: hash };
  }

  static async transfer({ to, amount } = {}) {
    const cfg = getConfig();
    const state = loadState();
    if (!state.tokenAddress) throw new Error('PTC stablecoin not deployed');
    const { walletClient, publicClient, fees } = clients(cfg);
    const stablecoinArtifact = getArtifact('PtcBackedStablecoin');
    await this.whitelist(to, true);
    const raw = viem.parseEther(String(amount));
    const hash = await walletClient.writeContract({
      address: state.tokenAddress,
      abi: stablecoinArtifact.abi,
      functionName: 'transfer',
      args: [to, raw],
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`transfer failed: ${hash}`);
    return { to, amount, txHash: hash };
  }

  static async balanceOf(address) {
    const state = loadState();
    if (!state.tokenAddress) return '0';
    const cfg = getConfig();
    const { publicClient } = clients(cfg);
    const stablecoinArtifact = getArtifact('PtcBackedStablecoin');
    const raw = await publicClient.readContract({
      address: state.tokenAddress,
      abi: stablecoinArtifact.abi,
      functionName: 'balanceOf',
      args: [address],
    });
    return viem.formatEther(raw);
  }

  static async totalSupply() {
    const state = loadState();
    if (!state.tokenAddress) return '0';
    const cfg = getConfig();
    const { publicClient } = clients(cfg);
    const stablecoinArtifact = getArtifact('PtcBackedStablecoin');
    const raw = await publicClient.readContract({
      address: state.tokenAddress,
      abi: stablecoinArtifact.abi,
      functionName: 'totalSupply',
    });
    return viem.formatEther(raw);
  }

  static async reserveBalances() {
    const state = loadState();
    if (!state.vaultAddress) return [];
    const cfg = getConfig();
    const { publicClient } = clients(cfg);
    const vaultArtifact = getArtifact('PtcReserveVault');
    const out = [];
    for (const r of state.reserveTokens || []) {
      try {
        const raw = await publicClient.readContract({
          address: state.vaultAddress,
          abi: vaultArtifact.abi,
          functionName: 'getReserveBalance',
          args: [r.address],
        });
        out.push({ ...r, vaultBalance: raw.toString(), vaultBalanceFormatted: (Number(raw) / Math.pow(10, r.decimals)).toFixed(r.decimals) });
      } catch (e) { out.push({ ...r, error: e.message }); }
    }
    return out;
  }

  static async info() {
    const state = loadState();
    if (!state.tokenAddress) return { deployed: false };
    const [supply, reserves] = await Promise.all([this.totalSupply().catch(() => '0'), this.reserveBalances().catch(() => [])]);
    return { ...state, deployed: true, totalSupply: supply, reserves };
  }

  static async setPaused(paused) {
    const cfg = getConfig();
    const state = loadState();
    if (!state.tokenAddress) throw new Error('PTC stablecoin not deployed');
    const { walletClient, publicClient, fees } = clients(cfg);
    const stablecoinArtifact = getArtifact('PtcBackedStablecoin');
    const fn = paused ? 'pause' : 'unpause';
    const hash = await walletClient.writeContract({
      address: state.tokenAddress,
      abi: stablecoinArtifact.abi,
      functionName: fn,
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`${fn} failed: ${hash}`);
    return { paused, txHash: hash };
  }
}

module.exports = { PtcStablecoinEngine };
