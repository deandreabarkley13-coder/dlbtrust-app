'use strict';

/**
 * DlbCanonicalSwap Engine
 *
 * Deploys and operates the DlbCanonicalSwap contract — an audited-style P2P
 * escrow for swapping DLB trust tokens (DLBUSD, DLB-PTCUSD, etc.) into canonical
 * stablecoins (USDS, USDC, DAI, WETH) on Ethereum mainnet.
 *
 * The contract owner is the operator wallet. Permissioned trust tokens must
 * whitelist the swap contract before it can hold them.
 */

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config');

let viem;
let chains;
let accounts;
try { viem = require('viem'); chains = require('viem/chains'); ({ privateKeyToAccount } = require('viem/accounts')); accounts = { privateKeyToAccount }; } catch (e) { /* optional */ }

function str(name, def = '') { return (process.env[name] || def).trim(); }
function bool(name, def = false) { const v = process.env[name]; return v ? String(v).toLowerCase() === 'true' : def; }
function num(name, def = 0) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : def; }

function safeJson(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v); }

function dataDir() {
  if (process.env.PERSISTENT_DATA_DIR && fs.existsSync(process.env.PERSISTENT_DATA_DIR)) return process.env.PERSISTENT_DATA_DIR;
  if (fs.existsSync('/data')) return '/data';
  return path.join(process.cwd(), 'data');
}

function statePath() { return path.join(dataDir(), 'dlb-canonical-swap-state.json'); }

function ensureDir() {
  const dir = dataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadState() {
  ensureDir();
  try { if (fs.existsSync(statePath())) return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch (e) { console.warn('[DlbCanonicalSwapEngine] load state failed:', e.message); }
  return {};
}

function saveState(state) {
  ensureDir();
  try { fs.writeFileSync(statePath(), JSON.stringify(state, null, 2)); } catch (e) { console.warn('[DlbCanonicalSwapEngine] save state failed:', e.message); }
}

function getArtifact() {
  const abiPath = path.join(process.cwd(), 'artifacts', 'contracts_DlbCanonicalSwap_sol_DlbCanonicalSwap.abi');
  const binPath = path.join(process.cwd(), 'artifacts', 'contracts_DlbCanonicalSwap_sol_DlbCanonicalSwap.bin');
  if (!fs.existsSync(abiPath)) throw new Error('DlbCanonicalSwap artifact not found; run scripts/compileDlbCanonicalSwap.cjs');
  return { abi: JSON.parse(fs.readFileSync(abiPath, 'utf8')), bytecode: '0x' + fs.readFileSync(binPath, 'utf8').trim() };
}

function chainById(id) {
  if (!chains) return undefined;
  if (id === 1) return chains.mainnet;
  if (id === 11155111) return chains.sepolia;
  return chains.mainnet;
}

const MAINNET_USDS = '0xdC035D45d973E3EC169d2276DDab16f1e407384F';
const MAINNET_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const MAINNET_DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
const MAINNET_WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

const erc20Abi = [
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'allowance', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'transfer', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'transferFrom', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
];

const whitelistAbi = [
  { type: 'function', name: 'whitelisted', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'setWhitelisted', inputs: [{ type: 'address' }, { type: 'bool' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'owner', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
];

function walletClient() {
  if (!viem) throw new Error('viem not installed');
  const cfg = getConfig();
  if (!cfg.privateKey) throw new Error('DAPP_PRIVATE_KEY not configured');
  const account = accounts.privateKeyToAccount(cfg.privateKey.startsWith('0x') ? cfg.privateKey : `0x${cfg.privateKey}`);
  const chain = chainById(cfg.chainId);
  const fees = cfg.getFees ? (cfg.getFees() || { maxFeePerGas: viem.parseGwei('20'), maxPriorityFeePerGas: viem.parseGwei('0.5') }) : { maxFeePerGas: viem.parseGwei('20'), maxPriorityFeePerGas: viem.parseGwei('0.5') };
  return {
    account,
    fees,
    wallet: viem.createWalletClient({ account, chain, transport: viem.http(cfg.rpcUrl) }),
    publicClient: viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) })
  };
}

class DlbCanonicalSwapEngine {
  static getConfig() {
    const cfg = getConfig();
    const state = loadState();
    return {
      enabled: bool('DLB_CANONICAL_SWAP_ENABLED', true),
      shadow: bool('DLB_CANONICAL_SWAP_SHADOW', cfg.dappShadow !== false ? true : cfg.dappShadow),
      chainId: cfg.chainId,
      rpcUrl: cfg.rpcUrl,
      privateKey: cfg.privateKey,
      operatorAddress: cfg.operatorAddress,
      contractAddress: process.env.DLB_CANONICAL_SWAP_ADDRESS || state.contractAddress || '',
      canonicalTokens: {
        USDS: str('DAPP_USDS_ADDRESS', MAINNET_USDS),
        USDC: cfg.usdcAddress || MAINNET_USDC,
        DAI: str('DAPP_DAI_ADDRESS', MAINNET_DAI),
        WETH: cfg.wethAddress || MAINNET_WETH,
      },
      feeBps: num('DLB_CANONICAL_SWAP_FEE_BPS', 0),
    };
  }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.enabled) issues.push('DLB_CANONICAL_SWAP_ENABLED is not true');
    if (!cfg.shadow) {
      if (!cfg.privateKey) issues.push('DAPP_PRIVATE_KEY not configured');
      if (!cfg.rpcUrl) issues.push('DAPP_RPC_URL not configured');
      try { getArtifact(); } catch (e) { issues.push(e.message); }
    }
    return { ready: issues.length === 0, mode: cfg.shadow ? 'shadow' : 'live', issues, contractAddress: cfg.contractAddress };
  }

  static async deploy({ force = false, feeBps = 0, feeRecipient } = {}) {
    const cfg = this.getConfig();
    const state = loadState();
    if (!force && state.contractAddress) return { ...state, alreadyDeployed: true };
    if (cfg.shadow) {
      const shadow = { contractAddress: `shadow-dlb-canonical-swap-${Date.now()}`, feeBps, network: 'shadow' };
      saveState({ ...state, ...shadow });
      return shadow;
    }

    const { wallet, publicClient, fees } = walletClient();
    const { abi, bytecode } = getArtifact();
    const recipient = feeRecipient || cfg.operatorAddress || wallet.account.address;

    const hash = await wallet.deployContract({
      abi,
      bytecode,
      args: [wallet.account.address, recipient, Number(feeBps)],
      gas: 1500000n,
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`DlbCanonicalSwap deploy failed: ${receipt.transactionHash}`);

    state.contractAddress = receipt.contractAddress;
    state.deployTxHash = receipt.transactionHash;
    state.feeBps = feeBps;
    state.feeRecipient = recipient;
    state.owner = wallet.account.address;
    state.network = cfg.chainId === 1 ? 'mainnet' : 'sepolia';
    state.createdAt = new Date().toISOString();
    saveState(state);

    return { contractAddress: state.contractAddress, deployTxHash: state.deployTxHash, feeBps, feeRecipient: recipient };
  }

  static async ensureCanonical(tokenSymbol) {
    const cfg = this.getConfig();
    const contractAddress = cfg.contractAddress;
    if (!contractAddress) throw new Error('DlbCanonicalSwap not deployed');
    if (cfg.shadow) return { skipped: true, mode: 'shadow' };

    const token = (cfg.canonicalTokens[tokenSymbol.toUpperCase()] || tokenSymbol).toLowerCase();
    const { wallet, publicClient, fees } = walletClient();
    const { abi } = getArtifact();

    const isCanonical = await publicClient.readContract({
      address: contractAddress,
      abi,
      functionName: 'canonicalStablecoins',
      args: [token],
    }).catch(() => false);

    if (isCanonical) return { token, allowed: true, txHash: null };

    const hash = await wallet.writeContract({
      address: contractAddress,
      abi,
      functionName: 'setCanonicalStablecoin',
      args: [token, true],
      gas: 100000n,
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`setCanonicalStablecoin failed: ${receipt.transactionHash}`);
    return { token, allowed: true, txHash: receipt.transactionHash };
  }

  static async ensureWhitelisted(tokenAddress) {
    const cfg = this.getConfig();
    const contractAddress = cfg.contractAddress;
    if (!contractAddress) throw new Error('DlbCanonicalSwap not deployed');
    if (cfg.shadow) return { skipped: true, mode: 'shadow' };

    const token = tokenAddress.toLowerCase();
    const { wallet, publicClient, fees } = walletClient();

    try {
      const isWhitelisted = await publicClient.readContract({ address: token, abi: whitelistAbi, functionName: 'whitelisted', args: [contractAddress] });
      if (isWhitelisted) return { token, whitelisted: true, txHash: null };

      const owner = await publicClient.readContract({ address: token, abi: whitelistAbi, functionName: 'owner' }).catch(() => null);
      if (owner && owner.toLowerCase() !== wallet.account.address.toLowerCase()) {
        console.warn(`[DlbCanonicalSwapEngine] operator is not owner of ${token}; cannot whitelist`);
        return { token, whitelisted: false, txHash: null, note: 'operator not token owner' };
      }

      const hash = await wallet.writeContract({
        address: token,
        abi: whitelistAbi,
        functionName: 'setWhitelisted',
        args: [contractAddress, true],
        gas: 100000n,
        ...fees,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
      if (receipt.status !== 'success') throw new Error(`setWhitelisted failed: ${receipt.transactionHash}`);
      return { token, whitelisted: true, txHash: receipt.transactionHash };
    } catch (e) {
      console.warn('[DlbCanonicalSwapEngine] whitelist best-effort failed:', e.message);
      return { token, whitelisted: false, error: e.message };
    }
  }

  static async _decimals(tokenAddress) {
    const cfg = this.getConfig();
    if (cfg.shadow) return 6;
    const { publicClient } = walletClient();
    return Number(await publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'decimals' }).catch(() => 6));
  }

  static async createOrder({ tokenIn, amountIn, tokenOut, amountOut, recipient } = {}) {
    const cfg = this.getConfig();
    if (!cfg.contractAddress) throw new Error('DlbCanonicalSwap not deployed');
    if (!tokenIn || !tokenOut || !amountIn || !amountOut) throw new Error('tokenIn, amountIn, tokenOut, amountOut required');

    // Ensure the requested output is treated as canonical by the contract
    await this.ensureCanonical(tokenOut);
    // Best-effort whitelist the contract to receive the input token
    await this.ensureWhitelisted(tokenIn);

    const decimalsIn = await this._decimals(tokenIn);
    const decimalsOut = await this._decimals(tokenOut);
    const rawIn = viem.parseUnits(String(amountIn), decimalsIn);
    const rawOut = viem.parseUnits(String(amountOut), decimalsOut);

    if (cfg.shadow) {
      return {
        orderId: `shadow-${Date.now()}`,
        tokenIn,
        amountIn,
        tokenOut,
        amountOut,
        recipient: recipient || cfg.operatorAddress,
        mode: 'shadow',
      };
    }

    const { wallet, publicClient, fees } = walletClient();
    const { abi } = getArtifact();
    const contractAddress = cfg.contractAddress;

    const allowance = await publicClient.readContract({
      address: tokenIn,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [wallet.account.address, contractAddress],
    });
    if (BigInt(allowance || 0) < BigInt(rawIn)) {
      const approveHash = await wallet.writeContract({
        address: tokenIn,
        abi: erc20Abi,
        functionName: 'approve',
        args: [contractAddress, rawIn],
        gas: 100000n,
        ...fees,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: 120000 });
    }

    const target = recipient || cfg.operatorAddress || wallet.account.address;
    const hash = await wallet.writeContract({
      address: contractAddress,
      abi,
      functionName: 'createOrder',
      args: [tokenIn, rawIn, tokenOut, rawOut, target],
      gas: 300000n,
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`createOrder failed: ${receipt.transactionHash}`);

    const orderId = await this._deriveOrderId(publicClient, contractAddress, abi, receipt, target);
    return { orderId, tokenIn, amountIn, tokenOut, amountOut, recipient: target, txHash: receipt.transactionHash, mode: 'live' };
  }

  static async _deriveOrderId(publicClient, contractAddress, abi, receipt, target) {
    try {
      const logs = await publicClient.getLogs({
        address: contractAddress,
        event: { type: 'event', name: 'OrderCreated', inputs: [{ type: 'uint256', indexed: true, name: 'id' }, { type: 'address', indexed: true, name: 'maker' }, { type: 'address', name: 'tokenIn' }, { type: 'uint256', name: 'amountIn' }, { type: 'address', name: 'tokenOut' }, { type: 'uint256', name: 'amountOut' }, { type: 'address', name: 'recipient' }] },
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      });
      const match = logs.find(l => l.args.maker.toLowerCase() === walletClient().account.address.toLowerCase() && (!target || l.args.recipient.toLowerCase() === target.toLowerCase()));
      return match ? String(match.args.id) : null;
    } catch (e) {
      return null;
    }
  }

  static async fillOrder({ orderId } = {}) {
    const cfg = this.getConfig();
    if (!cfg.contractAddress) throw new Error('DlbCanonicalSwap not deployed');
    if (!orderId) throw new Error('orderId required');

    if (cfg.shadow) return { orderId, status: 'filled', mode: 'shadow', txHash: `shadow-${Date.now()}` };

    const { wallet, publicClient, fees } = walletClient();
    const { abi } = getArtifact();

    const order = await publicClient.readContract({
      address: cfg.contractAddress,
      abi,
      functionName: 'orders',
      args: [BigInt(orderId)],
    });
    const tokenOut = order[4];
    const amountOut = order[5];

    const allowance = await publicClient.readContract({
      address: tokenOut,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [wallet.account.address, cfg.contractAddress],
    });
    if (BigInt(allowance || 0) < BigInt(amountOut)) {
      const approveHash = await wallet.writeContract({
        address: tokenOut,
        abi: erc20Abi,
        functionName: 'approve',
        args: [cfg.contractAddress, amountOut],
        gas: 100000n,
        ...fees,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: 120000 });
    }

    const hash = await wallet.writeContract({
      address: cfg.contractAddress,
      abi,
      functionName: 'fillOrder',
      args: [BigInt(orderId)],
      gas: 300000n,
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`fillOrder failed: ${receipt.transactionHash}`);
    return { orderId, status: 'filled', txHash: receipt.transactionHash, mode: 'live' };
  }

  static async cancelOrder({ orderId } = {}) {
    const cfg = this.getConfig();
    if (!cfg.contractAddress) throw new Error('DlbCanonicalSwap not deployed');
    if (!orderId) throw new Error('orderId required');

    if (cfg.shadow) return { orderId, status: 'cancelled', mode: 'shadow' };

    const { wallet, publicClient, fees } = walletClient();
    const { abi } = getArtifact();
    const hash = await wallet.writeContract({
      address: cfg.contractAddress,
      abi,
      functionName: 'cancelOrder',
      args: [BigInt(orderId)],
      gas: 200000n,
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`cancelOrder failed: ${receipt.transactionHash}`);
    return { orderId, status: 'cancelled', txHash: receipt.transactionHash, mode: 'live' };
  }

  static async getOrder({ orderId } = {}) {
    const cfg = this.getConfig();
    if (!cfg.contractAddress) return null;
    if (!orderId) throw new Error('orderId required');
    if (cfg.shadow) return null;

    const { publicClient } = walletClient();
    const { abi } = getArtifact();
    const o = await publicClient.readContract({
      address: cfg.contractAddress,
      abi,
      functionName: 'orders',
      args: [BigInt(orderId)],
    });
    return {
      orderId: String(o[0]),
      maker: o[1],
      tokenIn: o[2],
      amountIn: String(o[3]),
      tokenOut: o[4],
      amountOut: String(o[5]),
      recipient: o[6],
      active: o[7],
    };
  }

  static async listOrders({ maker, activeOnly = true } = {}) {
    const cfg = this.getConfig();
    if (!cfg.contractAddress) return [];
    if (cfg.shadow) return [];

    const { publicClient } = walletClient();
    const { abi } = getArtifact();
    const orderCount = await publicClient.readContract({ address: cfg.contractAddress, abi, functionName: 'nextOrderId' }).catch(() => 1n);
    const ids = [];
    for (let i = 1n; i < orderCount; i++) ids.push(i);

    const orders = [];
    for (const id of ids) {
      const o = await publicClient.readContract({ address: cfg.contractAddress, abi, functionName: 'orders', args: [id] });
      const active = o[7];
      if (activeOnly && !active) continue;
      orders.push({
        orderId: String(o[0]),
        maker: o[1],
        tokenIn: o[2],
        amountIn: String(o[3]),
        tokenOut: o[4],
        amountOut: String(o[5]),
        recipient: o[6],
        active,
      });
    }
    if (maker) return orders.filter(o => o.maker.toLowerCase() === maker.toLowerCase());
    return orders;
  }

  static async quote({ tokenIn, amountIn, tokenOut } = {}) {
    const cfg = this.getConfig();
    if (!tokenIn || !tokenOut || !amountIn) throw new Error('tokenIn, amountIn, tokenOut required');
    // 1:1 quote by default; real price is set by maker
    return {
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: String(amountIn),
      price: '1.0',
      note: 'P2P swap; amountOut is the maker asking price. A taker must supply that amount of canonical token to fill.',
    };
  }
}

module.exports = { DlbCanonicalSwapEngine };
