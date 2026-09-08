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
 *
 * Signing: DAPP_PRIVATE_KEY over DAPP_RPC_URL by default, or the Vault-held
 * thirdweb server wallet when DAPP_SIGNER=thirdweb (ThirdwebChainSigner), in
 * which case the wallet is the owner of both contracts and the operator that
 * holds reserves and freshly minted stablecoin.
 */

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config');
const { ThirdwebChainSigner } = require('./thirdwebChainSigner');
const { ThirdwebPriceOracle } = require('./thirdwebPriceOracle');

let viem;
try { viem = require('viem'); } catch (e) { /* optional */ }
const allChains = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');

const STABLECOIN_DECIMALS = 18;

let ModuleSmartAccountEngine;
try { ModuleSmartAccountEngine = require('./moduleSmartAccountEngine').ModuleSmartAccountEngine; } catch (e) { ModuleSmartAccountEngine = null; }

function str(name, def = '') { return (process.env[name] || def).trim(); }
function num(name, def = 0) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : def; }

const stateStore = require('../cluster/jsonStateStore');
const STATE_FILE = 'ptc-stablecoin-state.json';

function loadState() { return stateStore.read(STATE_FILE, () => ({})); }

function saveState(state) { stateStore.write(STATE_FILE, state); }

function safeJson(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v); }

function getArtifact(name) {
  const p = path.join(process.cwd(), 'artifacts', `contracts_PtcStablecoinSystem_sol_${name}.abi`);
  const bin = path.join(process.cwd(), 'artifacts', `contracts_PtcStablecoinSystem_sol_${name}.bin`);
  if (!fs.existsSync(p)) throw new Error(`Artifact not found: ${p}`);
  return { abi: JSON.parse(fs.readFileSync(p, 'utf8')), bytecode: fs.readFileSync(bin, 'utf8') };
}

function chainById(id) {
  return Object.values(allChains).find((c) => c && typeof c === 'object' && Number(c.id) === Number(id)) || allChains.mainnet;
}

function networkName(id) {
  const chain = Object.values(allChains).find((c) => c && typeof c === 'object' && Number(c.id) === Number(id));
  return chain ? chain.name : `chain-${id}`;
}

/** The wallet that owns the contracts and holds reserves / minted stablecoin. */
function operatorAddress(cfg) {
  if (ThirdwebChainSigner.active()) return ThirdwebChainSigner.address() || cfg.operatorAddress;
  return cfg.operatorAddress;
}

function clients(cfg) {
  if (ThirdwebChainSigner.active()) return ThirdwebChainSigner.clients({ chainId: cfg.chainId });
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

  /** Signer, chain, operator and deployment state without touching the chain. */
  static readiness() {
    const cfg = getConfig();
    const state = this.state();
    const issues = [];
    const signer = ThirdwebChainSigner.active() ? 'thirdweb' : 'private-key';
    if (signer === 'thirdweb') issues.push(...ThirdwebChainSigner.readiness().issues);
    else if (!cfg.privateKey) issues.push('DAPP_PRIVATE_KEY not configured');
    if (!operatorAddress(cfg)) issues.push('operator address unknown (DAPP_OPERATOR_ADDRESS or THIRDWEB_SERVER_WALLET_ADDRESS)');
    return {
      provider: 'ptc-stablecoin',
      signer,
      chainId: cfg.chainId,
      operator: operatorAddress(cfg) || null,
      deployed: Boolean(state.tokenAddress && state.vaultAddress),
      tokenAddress: state.tokenAddress || null,
      vaultAddress: state.vaultAddress || null,
      tokenSymbol: state.tokenSymbol || null,
      reserveTokens: (state.reserveTokens || []).length,
      ready: issues.length === 0,
      issues,
    };
  }

  /**
   * Deployment state for the configured chain. A state file left by a
   * deployment on another chain is reported as not deployed here.
   */
  static state() {
    const cfg = getConfig();
    const state = loadState();
    if (state.tokenAddress && state.chainId !== undefined && Number(state.chainId) !== Number(cfg.chainId)) return { staleChainId: state.chainId };
    if (state.tokenAddress) this.pinPrice(state);
    return state;
  }

  /** The stablecoin is $1.00 by construction (the vault mints at the reserve's USD price), so the oracle is told so. */
  static pinPrice(state) {
    const cfg = getConfig();
    if (!state || !state.tokenAddress) return;
    ThirdwebPriceOracle.pin({
      chainId: cfg.chainId, tokenAddress: state.tokenAddress, symbol: state.tokenSymbol || 'DLB-PTCUSD',
      decimals: STABLECOIN_DECIMALS, priceUsd: 1, source: 'ptc-issuer',
    });
  }

  static async deploy({ tokenName, tokenSymbol, force = false } = {}) {
    const cfg = getConfig();
    const state = this.state();
    if (!force && state.tokenAddress && state.vaultAddress) return state;

    const { account, publicClient, walletClient, fees } = clients(cfg);
    const stablecoinArtifact = getArtifact('PtcBackedStablecoin');
    const vaultArtifact = getArtifact('PtcReserveVault');

    // Deploy PtcBackedStablecoin
    const name = tokenName || 'DLB PTC Stablecoin';
    const symbol = tokenSymbol || 'DLB-PTCUSD';
    const saltSuffix = force ? `:${Date.now()}` : '';
    const stablecoinHash = await walletClient.deployContract({
      abi: stablecoinArtifact.abi,
      bytecode: stablecoinArtifact.bytecode,
      args: [name, symbol, account.address],
      salt: `ptc-stablecoin:${symbol}:${cfg.chainId}${saltSuffix}`,
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
      salt: `ptc-vault:${tokenAddress}${saltSuffix}`,
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

    const fresh = {
      tokenAddress,
      vaultAddress,
      tokenName: name,
      tokenSymbol: symbol,
      decimals: STABLECOIN_DECIMALS,
      owner: account.address,
      signer: ThirdwebChainSigner.active() ? 'thirdweb' : 'private-key',
      chainId: cfg.chainId,
      network: networkName(cfg.chainId),
      createdAt: new Date().toISOString(),
      deployTx: stablecoinReceipt.transactionHash || null,
      vaultTx: vaultReceipt.transactionHash || null,
      reserveTokens: [],
    };
    saveState(fresh);
    this.pinPrice(fresh);

    return { ...fresh, deployTx: stablecoinReceipt.transactionHash || stablecoinHash, vaultTx: vaultReceipt.transactionHash || vaultHash };
  }

  static async _getModuleToken(moduleKey) {
    if (!ModuleSmartAccountEngine) throw new Error('ModuleSmartAccountEngine not available');
    const mod = await ModuleSmartAccountEngine.getModule(moduleKey);
    if (!mod || !mod.token_address) throw new Error(`Module ${moduleKey} has not been tokenized`);
    return { address: mod.token_address, decimals: mod.config?.decimals || 6, moduleKey, name: mod.config?.tokenSymbol || mod.module_key };
  }

  static async addReserveToken({ token, decimals, price, moduleKey, name } = {}) {
    const cfg = getConfig();
    const state = this.state();
    if (!state.vaultAddress || !state.tokenAddress) throw new Error('PTC stablecoin not deployed');
    const { publicClient, walletClient, fees } = clients(cfg);
    const vaultArtifact = getArtifact('PtcReserveVault');

    let reserve;
    if (moduleKey) {
      reserve = await this._getModuleToken(moduleKey);
    } else {
      if (!token) throw new Error('token address or moduleKey required');
      if (!decimals) throw new Error('decimals required');
      reserve = { address: token, decimals: Number(decimals), moduleKey: 'custom', name: name || null };
    }
    const priceWei = price || '1000000000000000000'; // $1.00 in 18 decimals

    const existing = (state.reserveTokens || []).find(r => r.address.toLowerCase() === reserve.address.toLowerCase());
    if (existing) return { reserve: existing, txHash: existing.txHash || null, alreadyAccepted: true };

    const hash = await walletClient.writeContract({
      address: state.vaultAddress,
      abi: vaultArtifact.abi,
      functionName: 'addReserveToken',
      args: [reserve.address, Number(reserve.decimals), priceWei],
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`addReserveToken failed: ${hash}`);
    const txHash = receipt.transactionHash || hash;

    state.reserveTokens = state.reserveTokens || [];
    state.reserveTokens.push({ address: reserve.address, decimals: reserve.decimals, moduleKey: reserve.moduleKey, name: reserve.name, price: priceWei, txHash, addedAt: new Date().toISOString() });
    saveState(state);

    return { reserve, txHash };
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
      abi: [{ type: 'function', name: 'balanceOf', inputs: [{ type: 'address', name: 'account' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
      functionName: 'balanceOf',
      args: [operatorAddress(cfg)],
    });
    return BigInt(raw);
  }

  static async approveAndDeposit({ moduleKey, token, amount = 'all', recipient } = {}) {
    const cfg = getConfig();
    const state = this.state();
    if (!state.vaultAddress) throw new Error('PTC reserve vault not deployed');
    const { publicClient, walletClient, fees } = clients(cfg);
    const stablecoinArtifact = getArtifact('PtcBackedStablecoin');
    const vaultArtifact = getArtifact('PtcReserveVault');

    let reserve;
    if (moduleKey) {
      reserve = await this._getModuleToken(moduleKey);
    } else {
      if (!token) throw new Error('token address or moduleKey required');
      const meta = (state.reserveTokens || []).find(r => r.address.toLowerCase() === token.toLowerCase());
      reserve = { address: token, decimals: meta ? meta.decimals : 6 };
    }

    const operator = operatorAddress(cfg);
    const to = recipient || operator;

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
      abi: [{ type: 'function', name: 'allowance', inputs: [{ type: 'address', name: 'owner' }, { type: 'address', name: 'spender' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
      functionName: 'allowance',
      args: [operator, state.vaultAddress],
    });
    if (BigInt(existingAllowance || 0) < BigInt(rawAmount)) {
      const approveHash = await walletClient.writeContract({
        address: reserve.address,
        abi: [{ type: 'function', name: 'approve', inputs: [{ type: 'address', name: 'spender' }, { type: 'uint256', name: 'value' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' }],
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

    const meta = (state.reserveTokens || []).find(r => r.address.toLowerCase() === reserve.address.toLowerCase());
    const priceWei = BigInt((meta && meta.price) || '1000000000000000000');
    const minted = (BigInt(rawAmount) * priceWei) / (10n ** BigInt(reserve.decimals));
    return { moduleKey, token: reserve.address, amount: rawAmount.toString(), mintedStablecoin: minted.toString(), recipient: to, txHash: receipt.transactionHash || depositHash };
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
    const state = this.state();
    if (!state.vaultAddress) throw new Error('PTC reserve vault not deployed');
    const { publicClient, walletClient, fees } = clients(cfg);
    const stablecoinArtifact = getArtifact('PtcBackedStablecoin');
    const vaultArtifact = getArtifact('PtcReserveVault');

    let reserve;
    if (moduleKey) {
      reserve = await this._getModuleToken(moduleKey);
    } else {
      const meta = (state.reserveTokens || []).find(r => r.address.toLowerCase() === (token || '').toLowerCase());
      reserve = { address: token, decimals: meta ? meta.decimals : 6 };
    }

    const to = recipient || operatorAddress(cfg);
    const rawStablecoin = viem.parseEther(String(amount));

    // Approve vault to burn stablecoin
    const existingAllowance = await publicClient.readContract({
      address: state.tokenAddress,
      abi: stablecoinArtifact.abi,
      functionName: 'allowance',
      args: [operatorAddress(cfg), state.vaultAddress],
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
    return { moduleKey, token: reserve.address, stablecoinAmount: rawStablecoin.toString(), reserveAmount: reserveAmount.toString(), recipient: to, txHash: receipt.transactionHash || redeemHash };
  }

  static async isWhitelisted(address) {
    const cfg = getConfig();
    const state = this.state();
    if (!state.tokenAddress) throw new Error('PTC stablecoin not deployed');
    const { publicClient } = clients(cfg);
    const stablecoinArtifact = getArtifact('PtcBackedStablecoin');
    return Boolean(await publicClient.readContract({ address: state.tokenAddress, abi: stablecoinArtifact.abi, functionName: 'whitelisted', args: [address] }));
  }

  static async whitelist(address, allowed = true) {
    const cfg = getConfig();
    const state = this.state();
    if (!state.tokenAddress) throw new Error('PTC stablecoin not deployed');
    const { publicClient, walletClient, fees } = clients(cfg);
    const stablecoinArtifact = getArtifact('PtcBackedStablecoin');
    const already = await this.isWhitelisted(address).catch(() => null);
    if (already === allowed) return { address, allowed, txHash: null, unchanged: true };
    const hash = await walletClient.writeContract({
      address: state.tokenAddress,
      abi: stablecoinArtifact.abi,
      functionName: 'setWhitelisted',
      args: [address, allowed],
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`whitelist failed: ${hash}`);
    return { address, allowed, txHash: receipt.transactionHash || hash };
  }

  static async transfer({ to, amount } = {}) {
    const cfg = getConfig();
    const state = this.state();
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
    return { to, amount, txHash: receipt.transactionHash || hash };
  }

  static async balanceOf(address) {
    const state = this.state();
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
    const state = this.state();
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
    const state = this.state();
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
        out.push({ ...r, vaultBalance: raw.toString(), vaultBalanceFormatted: viem.formatUnits(BigInt(raw), r.decimals) });
      } catch (e) { out.push({ ...r, error: e.message }); }
    }
    return out;
  }

  static async info() {
    const state = this.state();
    if (!state.tokenAddress) return { deployed: false, chainId: getConfig().chainId, staleChainId: state.staleChainId || null };
    const [supply, reserves] = await Promise.all([this.totalSupply().catch(() => '0'), this.reserveBalances().catch(() => [])]);
    return { ...state, deployed: true, totalSupply: supply, reserves };
  }

  static async setPaused(paused) {
    const cfg = getConfig();
    const state = this.state();
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
    return { paused, txHash: receipt.transactionHash || hash };
  }
}

module.exports = { PtcStablecoinEngine };
