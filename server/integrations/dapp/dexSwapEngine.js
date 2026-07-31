'use strict';

/**
 * DEX Swap Engine
 *
 * Provides a minimal constant-product DEX swap path for tokenized bonds -> USDC.
 * In shadow mode it simulates quotes and returns a shadow tx hash.
 *
 * Live usage needs:
 *  - BOND_DEX_ADDRESS or DEX_SWAP_ROUTER pointing to a BondDex pool
 *  - tokenIn approved for the pool
 *  - tokenIn/USDC liquidity in the pool
 *  - gas in the operator wallet
 */

const { getConfig } = require('./config');

let viem, chains;
try { viem = require('viem'); chains = require('viem/chains'); } catch (e) { viem = null; chains = null; }

function str(name, fallback = '') { return (process.env[name] || fallback).trim(); }
function bool(name, fallback = false) { const v = process.env[name]; return v ? String(v).toLowerCase() === 'true' : fallback; }
function num(name, fallback = 0) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : fallback; }

const SWAP_ROUTER_02 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';

const erc20Abi = [
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
];

const bondDexAbi = [
  { type: 'function', name: 'token0', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'token1', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'reserve0', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'reserve1', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'swap', inputs: [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }], stateMutability: 'nonpayable' },
];

function walletClient() {
  if (!viem) throw new Error('viem not installed');
  const cfg = getConfig();
  if (!cfg.privateKey) throw new Error('DAPP_PRIVATE_KEY not configured');
  const account = viem.privateKeyToAccount(cfg.privateKey);
  const chain = cfg.chainId === 1 ? (chains && chains.mainnet) : (chains && chains.sepolia) || undefined;
  return {
    account,
    wallet: viem.createWalletClient({ account, chain, transport: viem.http(cfg.rpcUrl) }),
    publicClient: viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) })
  };
}

class DexSwapEngine {
  static getConfig() {
    const cfg = getConfig();
    return {
      enabled: bool('DEX_SWAP_ENABLED', true),
      shadow: bool('DEX_SWAP_SHADOW', cfg.dappShadow !== false ? true : cfg.dappShadow),
      chainId: cfg.chainId,
      rpcUrl: cfg.rpcUrl,
      privateKey: cfg.privateKey,
      router: str('BOND_DEX_ADDRESS') || str('DEX_SWAP_ROUTER', SWAP_ROUTER_02),
      usdcAddress: cfg.usdcAddress,
      slippageBps: num('DEX_SLIPPAGE_BPS', 100),
    };
  }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.enabled) issues.push('DEX_SWAP_ENABLED is not true');
    if (!cfg.shadow) {
      if (!cfg.privateKey) issues.push('DAPP_PRIVATE_KEY not configured');
      if (!cfg.rpcUrl) issues.push('DAPP_RPC_URL not configured');
      if (!cfg.router) issues.push('BOND_DEX_ADDRESS / DEX_SWAP_ROUTER not configured');
    }
    return { ready: issues.length === 0, mode: cfg.shadow ? 'shadow' : 'live', issues };
  }

  static async quote({ tokenIn, tokenOut, amountIn, decimalsIn = 6, decimalsOut = 6, fee = 3000 } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw new Error('DEX swap not enabled');
    const amount = Number(amountIn) || 0;
    if (amount <= 0) throw new Error('amountIn must be positive');

    const outputToken = tokenOut || cfg.usdcAddress;
    const inputToken = tokenIn;

    if (!cfg.shadow && cfg.router && viem) {
      const { publicClient } = walletClient();
      const token0 = await publicClient.readContract({ address: cfg.router, abi: bondDexAbi, functionName: 'token0' });
      const token1 = await publicClient.readContract({ address: cfg.router, abi: bondDexAbi, functionName: 'token1' });
      const r0 = await publicClient.readContract({ address: cfg.router, abi: bondDexAbi, functionName: 'reserve0' });
      const r1 = await publicClient.readContract({ address: cfg.router, abi: bondDexAbi, functionName: 'reserve1' });
      const tokenInIsToken0 = inputToken.toLowerCase() === token0.toLowerCase();
      const reserveIn = tokenInIsToken0 ? r0 : r1;
      const reserveOut = tokenInIsToken0 ? r1 : r0;
      const rawIn = viem.parseUnits(String(amount), decimalsIn);
      const amountInWithFee = (rawIn * 997n) / 1000n;
      const amountOutRaw = (amountInWithFee * reserveOut) / (reserveIn + amountInWithFee);
      const amountOutHuman = Number(viem.formatUnits(amountOutRaw, decimalsOut));
      const minOutHuman = amountOutHuman * (1 - cfg.slippageBps / 10000);
      return {
        tokenIn: inputToken,
        tokenOut: outputToken,
        amountIn: amount,
        amountOut: amountOutHuman.toFixed(decimalsOut),
        amountOutMinimum: minOutHuman.toFixed(decimalsOut),
        fee,
        price: amountOutHuman / amount,
        mode: 'live',
      };
    }

    const price = 0.95 + Math.random() * 0.05;
    const outHuman = amount * price;
    const minOutHuman = outHuman * (1 - cfg.slippageBps / 10000);
    return {
      tokenIn: inputToken,
      tokenOut: outputToken,
      amountIn: amount,
      amountOut: outHuman.toFixed(decimalsOut),
      amountOutMinimum: minOutHuman.toFixed(decimalsOut),
      fee,
      price,
      mode: 'shadow',
    };
  }

  static async swap({ tokenIn, tokenOut, amountIn, amountOutMinimum, recipient, fee = 3000, decimalsIn = 6, decimalsOut = 6 } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw new Error('DEX swap not enabled');
    if (!amountIn || Number(amountIn) <= 0) throw new Error('amountIn required');

    const inputToken = tokenIn;
    const outputToken = tokenOut || cfg.usdcAddress;
    const quote = await this.quote({ tokenIn: inputToken, tokenOut: outputToken, amountIn, decimalsIn, decimalsOut, fee });

    if (cfg.shadow) {
      return {
        status: 'executed',
        mode: 'shadow',
        txHash: `shadow-dex-${Date.now()}`,
        tokenIn: inputToken,
        tokenOut: outputToken,
        amountIn,
        amountOut: quote.amountOut,
        amountOutMinimum: amountOutMinimum || quote.amountOutMinimum,
        recipient: recipient || 'operator',
        note: 'Shadow DEX swap; real swap requires token approval, liquidity pool, and gas.',
      };
    }

    if (!cfg.router || !viem) throw new Error('BOND_DEX_ADDRESS / DEX_SWAP_ROUTER not configured');

    const { wallet, publicClient } = walletClient();
    const rawIn = viem.parseUnits(String(amountIn), decimalsIn);
    const minOut = amountOutMinimum ? viem.parseUnits(String(amountOutMinimum), decimalsOut) : 0n;

    const approveHash = await wallet.writeContract({
      address: inputToken,
      abi: erc20Abi,
      functionName: 'approve',
      args: [cfg.router, rawIn],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });

    const swapHash = await wallet.writeContract({
      address: cfg.router,
      abi: bondDexAbi,
      functionName: 'swap',
      args: [rawIn, inputToken, minOut],
      gas: 500000n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });
    if (receipt.status !== 'success') throw new Error(`swap failed: ${receipt.transactionHash}`);

    return {
      status: 'executed',
      mode: 'live',
      txHash: receipt.transactionHash,
      tokenIn: inputToken,
      tokenOut: outputToken,
      amountIn,
      amountOut: quote.amountOut,
      amountOutMinimum: amountOutMinimum || quote.amountOutMinimum,
      recipient: recipient || wallet.account.address,
    };
  }
}

module.exports = { DexSwapEngine };
