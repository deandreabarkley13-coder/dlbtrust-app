'use strict';

/**
 * UniswapV3Engine
 *
 * Direct Uniswap V3 exact-input quotes and swaps on Ethereum mainnet.
 * Useful for converting canonical assets (WETH, USDC, USDS, DAI) at low slippage
 * when a V3 pool exists. This engine does NOT support DLB-PTCUSD or DLBUSD
 * unless those tokens have a live V3 pool.
 */

const { getConfig } = require('./config');

let viem, privateKeyToAccount, chains;
try {
  viem = require('viem');
  ({ privateKeyToAccount } = require('viem/accounts'));
  chains = require('viem/chains');
} catch (e) {}

function str(name, fallback = '') { return (process.env[name] || fallback).trim(); }
function num(name, fallback = 0) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : fallback; }

const SWAP_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const QUOTER_V2 = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

const FEE_TIERS = [100, 500, 3000, 10000];

const erc20Abi = [
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'allowance', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
];

const quoterV2Abi = [
  { type: 'function', name: 'quoteExactInputSingle', inputs: [{ components: [{ type: 'address', name: 'tokenIn' }, { type: 'address', name: 'tokenOut' }, { type: 'uint256', name: 'amountIn' }, { type: 'uint24', name: 'fee' }, { type: 'uint160', name: 'sqrtPriceLimitX96' }], name: 'params', type: 'tuple' }], outputs: [{ type: 'uint256', name: 'amountOut' }, { type: 'uint160', name: 'sqrtPriceX96After' }, { type: 'uint32', name: 'initializedTicksCrossed' }, { type: 'uint256', name: 'gasEstimate' }], stateMutability: 'nonpayable' },
];

const swapRouterAbi = [
  { type: 'function', name: 'exactInputSingle', inputs: [{ components: [{ type: 'address', name: 'tokenIn' }, { type: 'address', name: 'tokenOut' }, { type: 'uint24', name: 'fee' }, { type: 'address', name: 'recipient' }, { type: 'uint256', name: 'deadline' }, { type: 'uint256', name: 'amountIn' }, { type: 'uint256', name: 'amountOutMinimum' }, { type: 'uint160', name: 'sqrtPriceLimitX96' }], type: 'tuple' }], outputs: [{ type: 'uint256' }], stateMutability: 'nonpayable' },
];

class UniswapV3Engine {
  static getConfig() {
    const cfg = getConfig();
    return {
      ...cfg,
      enabled: true,
      swapRouter: str('UNISWAP_V3_SWAP_ROUTER', SWAP_ROUTER),
      quoter: str('UNISWAP_V3_QUOTER', QUOTER_V2),
      wethAddress: str('DAPP_WETH_ADDRESS', WETH),
      slippageBps: num('UNISWAP_V3_SLIPPAGE_BPS', 100),
    };
  }

  static async _walletClient() {
    if (!viem) throw new Error('viem not installed');
    const cfg = this.getConfig();
    if (!cfg.privateKey) throw new Error('DAPP_PRIVATE_KEY not configured');
    const pk = cfg.privateKey.startsWith('0x') ? cfg.privateKey : `0x${cfg.privateKey}`;
    const account = privateKeyToAccount(pk);
    const chain = cfg.chainId === 1 ? chains.mainnet : (chains.sepolia || undefined);
    const transport = viem.http(cfg.rpcUrl);
    const fees = cfg.getFees ? (cfg.getFees() || { maxFeePerGas: viem.parseGwei('20'), maxPriorityFeePerGas: viem.parseGwei('0.5') }) : { maxFeePerGas: viem.parseGwei('20'), maxPriorityFeePerGas: viem.parseGwei('0.5') };
    return {
      account,
      fees,
      wallet: viem.createWalletClient({ account, chain, transport }),
      publicClient: viem.createPublicClient({ chain, transport }),
    };
  }

  static async _tokenDecimals(tokenAddress) {
    if (!viem) return 18;
    if (!tokenAddress) return 18;
    try {
      const { publicClient } = await this._walletClient();
      return Number(await publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'decimals' })) || 18;
    } catch (e) { return 18; }
  }

  static async _withLowerFees(fn) {
    const oldMax = process.env.DAPP_MAX_FEE_GWEI;
    const oldPri = process.env.DAPP_PRIORITY_FEE_GWEI;
    process.env.DAPP_MAX_FEE_GWEI = '1';
    process.env.DAPP_PRIORITY_FEE_GWEI = '0.05';
    try { return await fn(); }
    finally {
      if (oldMax !== undefined) process.env.DAPP_MAX_FEE_GWEI = oldMax; else delete process.env.DAPP_MAX_FEE_GWEI;
      if (oldPri !== undefined) process.env.DAPP_PRIORITY_FEE_GWEI = oldPri; else delete process.env.DAPP_PRIORITY_FEE_GWEI;
    }
  }

  static async quote({ tokenIn, tokenOut, amountIn, decimalsIn = 18, decimalsOut = 18, slippageBps } = {}) {
    if (!amountIn || Number(amountIn) <= 0) throw new Error('amountIn must be positive');
    if (!tokenIn || !tokenOut) throw new Error('tokenIn and tokenOut required');
    if (!viem) throw new Error('viem not installed');
    const cfg = this.getConfig();
    const { publicClient } = await this._walletClient();
    const rawIn = viem.parseUnits(String(amountIn), Number(decimalsIn) || 18);

    let best = null;
    for (const fee of FEE_TIERS) {
      try {
        const [amountOut] = await publicClient.readContract({
          address: cfg.quoter,
          abi: quoterV2Abi,
          functionName: 'quoteExactInputSingle',
          args: [[tokenIn, tokenOut, rawIn, fee, 0n]],
        });
        const humanOut = Number(viem.formatUnits(amountOut, Number(decimalsOut) || 18));
        if (!best || humanOut > best.amountOut) {
          best = { fee, amountOut: humanOut, rawOut: amountOut };
        }
      } catch (e) {
        // pool/fee tier unavailable
      }
    }

    if (!best) return { status: 'no_pool', amountOut: 0, instructions: `No Uniswap V3 pool found for ${tokenIn} -> ${tokenOut}` };

    const slippage = slippageBps !== undefined ? Number(slippageBps) : cfg.slippageBps;
    const minOut = BigInt(best.rawOut) * BigInt(10000 - slippage) / 10000n;
    return {
      status: 'ready',
      amountOut: best.amountOut,
      amountOutMinimum: viem.formatUnits(minOut, Number(decimalsOut) || 18),
      fee: best.fee,
      tokenIn,
      tokenOut,
      amountIn,
      decimalsIn,
      decimalsOut,
      router: cfg.swapRouter,
      instructions: `Swap ${amountIn} ${tokenIn} for ~${best.amountOut} ${tokenOut} on Uniswap V3 (fee ${best.fee})`,
    };
  }

  static async swap({ tokenIn, tokenOut, amountIn, decimalsIn = 18, decimalsOut = 18, recipient, slippageBps, minOut } = {}) {
    if (!amountIn || Number(amountIn) <= 0) throw new Error('amountIn must be positive');
    if (!tokenIn || !tokenOut) throw new Error('tokenIn and tokenOut required');
    if (!viem) throw new Error('viem not installed');
    const cfg = this.getConfig();
    const quote = await this.quote({ tokenIn, tokenOut, amountIn, decimalsIn, decimalsOut, slippageBps });
    if (quote.status !== 'ready') throw new Error(quote.instructions || 'Uniswap V3 quote not ready');
    const rawIn = viem.parseUnits(String(amountIn), Number(decimalsIn) || 18);
    const rawMinOut = minOut !== undefined ? viem.parseUnits(String(minOut), Number(decimalsOut) || 18) : (quote.rawOut ? BigInt(quote.rawOut) * BigInt(10000 - (slippageBps !== undefined ? Number(slippageBps) : cfg.slippageBps)) / 10000n : 0n);
    const { wallet, publicClient, account, fees } = await this._walletClient();
    const finalRecipient = recipient || account.address;

    return this._withLowerFees(async () => {
      // Approve router if input token is not native ETH
      if (tokenIn.toLowerCase() !== '0x0000000000000000000000000000000000000000' && tokenIn.toLowerCase() !== '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
        const allowance = BigInt(await publicClient.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'allowance', args: [account.address, cfg.swapRouter] }));
        if (allowance < rawIn) {
          const approveHash = await wallet.writeContract({
            address: tokenIn,
            abi: erc20Abi,
            functionName: 'approve',
            args: [cfg.swapRouter, rawIn],
            gas: 100000n,
            ...fees,
          });
          await publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: 120000 });
        }
      }

      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
      const hash = await wallet.writeContract({
        address: cfg.swapRouter,
        abi: swapRouterAbi,
        functionName: 'exactInputSingle',
        args: [[tokenIn, tokenOut, quote.fee, finalRecipient, deadline, rawIn, rawMinOut, 0n]],
        gas: 500000n,
        ...fees,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180000 });
      return { status: 'executed', txHash: hash, amountOut: quote.amountOut, amountOutMinimum: viem.formatUnits(rawMinOut, Number(decimalsOut) || 18), tokenIn, tokenOut, amountIn, fee: quote.fee, recipient: finalRecipient, mode: 'live', receipt };
    });
  }

  static async readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.privateKey) issues.push('DAPP_PRIVATE_KEY not configured');
    if (!cfg.rpcUrl) issues.push('DAPP_RPC_URL not configured');
    if (!viem) issues.push('viem not installed');
    return { ready: issues.length === 0, router: cfg.swapRouter, quoter: cfg.quoter, issues };
  }
}

module.exports = { UniswapV3Engine };
