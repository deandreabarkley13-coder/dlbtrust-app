'use strict';

/**
 * Module P2P Swap Engine
 *
 * Uses the deployed ModuleTokenSwap order-book contract to let the trust list
 * DLB module tokens (or any ERC-20) for USDC without requiring WETH/ETH
 * liquidity pools. Buyers pay gas to fill orders, so the trust does not need
 * native ETH to receive USDC once an order is listed.
 */

const { getConfig } = require('./config');
const { BondTokenizationEngine } = require('./bondTokenizationEngine');
const { ModuleSmartAccountEngine } = require('./moduleSmartAccountEngine');

let viem, chains, accounts;
try {
  viem = require('viem');
  chains = require('viem/chains');
  accounts = require('viem/accounts');
} catch (e) { /* ignored */ }

function getArtifact(file) {
  const fs = require('fs');
  const path = require('path');
  const candidate = path.join(process.cwd(), 'artifacts', file);
  if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, 'utf8'));
  const fallback = path.join(__dirname, '..', '..', '..', 'artifacts', file);
  if (fs.existsSync(fallback)) return JSON.parse(fs.readFileSync(fallback, 'utf8'));
  throw new Error(`artifact not found: ${file}`);
}

function getSwapAbi() {
  return getArtifact('contracts_ModuleTokenSwap_sol_ModuleTokenSwap.abi');
}

const ERC20_DECIMALS_ABI = [{ type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' }];

function chainById(id) {
  switch (id) {
    case 1: return chains?.mainnet;
    case 11155111: return chains?.sepolia;
    default: return chains?.mainnet;
  }
}

class ModuleP2PSwapEngine {
  static getConfig() {
    const cfg = getConfig();
    return {
      contractAddress: process.env.MODULE_P2P_SWAP_ADDRESS || cfg.moduleP2PSwapAddress,
      rpcUrl: cfg.rpcUrl,
      privateKey: cfg.privateKey,
      operatorAddress: cfg.operatorAddress,
      usdcAddress: cfg.usdcAddress,
      chainId: cfg.chainId,
    };
  }

  static _clients(cfg) {
    if (!viem) throw new Error('viem not available');
    if (!cfg.privateKey) throw new Error('DAPP_PRIVATE_KEY not configured');
    if (!cfg.contractAddress) throw new Error('MODULE_P2P_SWAP_ADDRESS not configured');
    const chain = chainById(cfg.chainId);
    const account = accounts.privateKeyToAccount(cfg.privateKey);
    const publicClient = viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) });
    const walletClient = viem.createWalletClient({ account, chain, transport: viem.http(cfg.rpcUrl) });
    return { account, publicClient, walletClient };
  }

  static async listOrders({ maker, activeOnly = true } = {}) {
    const cfg = this.getConfig();
    const { publicClient } = this._clients(cfg);
    const abi = getSwapAbi();

    let ids = [];
    if (maker) {
      ids = await publicClient.readContract({ address: cfg.contractAddress, abi, functionName: 'getOrdersByMaker', args: [maker] });
    } else {
      const count = await publicClient.readContract({ address: cfg.contractAddress, abi, functionName: 'nextOrderId' });
      ids = [];
      for (let i = 1n; i < count; i++) ids.push(i);
    }

    const orders = [];
    for (const id of ids) {
      const o = await publicClient.readContract({ address: cfg.contractAddress, abi, functionName: 'orders', args: [id] });
      const active = o[7];
      if (!activeOnly || active) {
        orders.push({
          orderId: String(id),
          maker: o[1],
          tokenIn: o[2],
          amountIn: String(o[3]),
          tokenOut: o[4],
          amountOut: String(o[5]),
          recipient: o[6],
          active,
        });
      }
    }
    return orders;
  }

  static async createOrder({ tokenIn, amountIn, tokenOut, amountOut, recipient } = {}) {
    const cfg = this.getConfig();
    if (!tokenIn || !tokenOut || !amountIn || !amountOut || !recipient) throw new Error('tokenIn, amountIn, tokenOut, amountOut, recipient required');
    const { account, publicClient, walletClient } = this._clients(cfg);
    const abi = getSwapAbi();
    const decimalsIn = Number(await publicClient.readContract({ address: tokenIn, abi: ERC20_DECIMALS_ABI, functionName: 'decimals' }).catch(() => 6));
    const decimalsOut = Number(await publicClient.readContract({ address: tokenOut, abi: ERC20_DECIMALS_ABI, functionName: 'decimals' }).catch(() => 6));
    const rawIn = viem.parseUnits(String(amountIn), decimalsIn);
    const rawOut = viem.parseUnits(String(amountOut), decimalsOut);

    // Approve P2P contract to pull tokenIn
    const existing = await publicClient.readContract({ address: tokenIn, abi: [{ type: 'function', name: 'allowance', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }], functionName: 'allowance', args: [account.address, cfg.contractAddress] });
    if (BigInt(existing || 0) < BigInt(rawIn)) {
      const approveHash = await walletClient.writeContract({
        address: tokenIn,
        abi: [{ type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' }],
        functionName: 'approve',
        args: [cfg.contractAddress, rawIn],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: 120000 });
    }

    const hash = await walletClient.writeContract({
      address: cfg.contractAddress,
      abi,
      functionName: 'createOrder',
      args: [tokenIn, rawIn, tokenOut, rawOut, recipient],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`createOrder failed: ${receipt.transactionHash}`);

    // Derive order id from logs
    const logs = await publicClient.getLogs({ address: cfg.contractAddress, event: { type: 'event', name: 'OrderCreated', inputs: [{ type: 'uint256', indexed: true, name: 'id' }, { type: 'address', indexed: true, name: 'maker' }, { type: 'address', name: 'tokenIn' }, { type: 'uint256', name: 'amountIn' }, { type: 'address', name: 'tokenOut' }, { type: 'uint256', name: 'amountOut' }, { type: 'address', name: 'recipient' }] } });
    const latest = logs.filter(l => l.args.maker.toLowerCase() === account.address.toLowerCase()).pop();
    return { txHash: receipt.transactionHash, orderId: latest ? String(latest.args.id) : null };
  }

  static async fillOrder({ orderId } = {}) {
    const cfg = this.getConfig();
    if (!orderId) throw new Error('orderId required');
    const { publicClient, walletClient } = this._clients(cfg);
    const abi = getSwapAbi();
    const hash = await walletClient.writeContract({
      address: cfg.contractAddress,
      abi,
      functionName: 'fillOrder',
      args: [BigInt(orderId)],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`fillOrder failed: ${receipt.transactionHash}`);
    return { txHash: receipt.transactionHash };
  }

  static async cancelOrder({ orderId } = {}) {
    const cfg = this.getConfig();
    if (!orderId) throw new Error('orderId required');
    const { publicClient, walletClient } = this._clients(cfg);
    const abi = getSwapAbi();
    const hash = await walletClient.writeContract({
      address: cfg.contractAddress,
      abi,
      functionName: 'cancelOrder',
      args: [BigInt(orderId)],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`cancelOrder failed: ${receipt.transactionHash}`);
    return { txHash: receipt.transactionHash };
  }

  static async createModuleOrder({ moduleKey, amountIn, pricePerToken, recipient } = {}) {
    const mod = await ModuleSmartAccountEngine.getModule(moduleKey);
    if (!mod || !mod.token_address) throw new Error(`Module ${moduleKey} not tokenized`);
    const tokenIn = mod.token_address;
    const cfg = this.getConfig();
    const tokenOut = cfg.usdcAddress;
    if (!tokenOut) throw new Error('USDC address not configured');
    const amountOut = Number(amountIn) * Number(pricePerToken);
    return this.createOrder({ tokenIn, amountIn, tokenOut, amountOut, recipient: recipient || cfg.operatorAddress });
  }
}

module.exports = { ModuleP2PSwapEngine };
