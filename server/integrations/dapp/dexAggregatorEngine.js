'use strict';

/**
 * DexAggregatorEngine
 *
 * Multi-source DEX aggregator that routes canonical token swaps through the
 * best available on-chain liquidity. Uses the OpenOcean public API by default
 * and can optionally fall back to 1inch/0x when API keys are configured.
 *
 * This is ideal for the second leg of trust stablecoin off-ramps
 * (e.g. WETH -> DAI, USDC -> DAI, USDC -> WETH).
 */

const { getConfig } = require('./config');

let viem, privateKeyToAccount, chains;
try {
  viem = require('viem');
  ({ privateKeyToAccount } = require('viem/accounts'));
  chains = require('viem/chains');
} catch (e) {}

let UniswapV3Engine;
try { UniswapV3Engine = require('./uniswapV3Engine').UniswapV3Engine; } catch (e) {}

function str(name, fallback = '') { return (process.env[name] || fallback).trim(); }
function num(name, fallback = 0) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : fallback; }

const OPENOCEAN_BASE = 'https://open-api.openocean.finance/v3';
const NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const erc20Abi = [
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'allowance', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
];

class DexAggregatorEngine {
  static getConfig() {
    const cfg = getConfig();
    return {
      ...cfg,
      enabled: true,
      openOceanChain: str('OPENOCEAN_CHAIN', 'eth'),
      oneInchApiKey: str('ONEINCH_API_KEY', ''),
      zeroExApiKey: str('ZEROX_API_KEY', ''),
      slippage: num('DEX_AGGREGATOR_SLIPPAGE', 1),
      timeoutMs: num('DEX_AGGREGATOR_TIMEOUT_MS', 20000),
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
    return {
      account,
      wallet: viem.createWalletClient({ account, chain, transport }),
      publicClient: viem.createPublicClient({ chain, transport }),
    };
  }

  static async _tokenDecimals(tokenAddress) {
    if (!viem || !tokenAddress) return 18;
    if (tokenAddress.toLowerCase() === NATIVE_TOKEN.toLowerCase()) return 18;
    try {
      const { publicClient } = await this._walletClient();
      return Number(await publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'decimals' })) || 18;
    } catch (e) { return 18; }
  }

  static _isNative(addr) {
    return !addr || addr.toLowerCase() === NATIVE_TOKEN.toLowerCase();
  }

  static _tokenParam(tokenAddress, cfg) {
    if (this._isNative(tokenAddress)) return NATIVE_TOKEN;
    return tokenAddress;
  }

  static async _fetchOpenOcean(path, cfg) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs || 20000);
    try {
      const res = await fetch(`${OPENOCEAN_BASE}/${cfg.openOceanChain}${path}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`OpenOcean HTTP ${res.status}: ${await res.text()}`);
      const json = await res.json();
      if (!json || json.code !== 200) throw new Error(`OpenOcean error: ${json?.msg || JSON.stringify(json)}`);
      return json.data;
    } finally { clearTimeout(timeout); }
  }

  static async quote({ tokenIn, tokenOut, amountIn, decimalsIn = 18, decimalsOut = 18, slippage, chain } = {}) {
    if (!amountIn || Number(amountIn) <= 0) throw new Error('amountIn must be positive');
    if (!tokenIn || !tokenOut) throw new Error('tokenIn and tokenOut required');
    const cfg = this.getConfig();
    const network = chain || cfg.openOceanChain;
    const inParam = this._tokenParam(tokenIn, cfg);
    const outParam = this._tokenParam(tokenOut, cfg);
    const gasPrice = Math.max(1, Math.floor(Number(process.env.DAPP_GAS_PRICE_GWEI || 1)));
    const slip = slippage !== undefined ? Number(slippage) : cfg.slippage;

    // Try OpenOcean first when not disabled
    if (str('OPENOCEAN_ENABLED', 'true').toLowerCase() !== 'false') {
      try {
        const params = new URLSearchParams({
          inTokenAddress: inParam,
          outTokenAddress: outParam,
          amount: String(amountIn),
          gasPrice: String(gasPrice),
          slippage: String(slip),
        });
        const data = await this._fetchOpenOcean(`/quote?${params.toString()}`, { ...cfg, openOceanChain: network, timeoutMs: 8000 });
        if (data && data.outAmount) {
          const outDecimals = decimalsOut || await this._tokenDecimals(tokenOut);
          const amountOut = Number(viem.formatUnits(BigInt(data.outAmount), outDecimals));
          const minOutRaw = BigInt(data.minOutAmount || 0);
          return {
            status: 'ready',
            provider: 'openocean',
            amountOut,
            amountOutMinimum: viem.formatUnits(minOutRaw, outDecimals),
            minOutAmount: data.minOutAmount,
            rawInAmount: data.inAmount,
            rawOutAmount: data.outAmount,
            estimatedGas: data.estimatedGas,
            gasPrice: data.gasPrice,
            priceImpact: data.price_impact,
            tokenIn,
            tokenOut,
            amountIn,
            decimalsIn,
            decimalsOut: outDecimals,
            exchange: data.exchange,
            path: data.path,
            instructions: `Swap ${amountIn} ${tokenIn} for ~${amountOut} ${tokenOut} via OpenOcean aggregator`,
          };
        }
      } catch (e) {
        // OpenOcean unavailable; fall back to on-chain V3
      }
    }

    if (UniswapV3Engine) {
      const v3 = await UniswapV3Engine.quote({ tokenIn, tokenOut, amountIn, decimalsIn, decimalsOut, slippageBps: Math.round(slip * 100) });
      if (v3 && v3.status === 'ready') return { ...v3, provider: 'uniswap_v3', aggregatorRoute: 'uniswap_v3', instructions: v3.instructions || `Swap ${amountIn} ${tokenIn} for ~${v3.amountOut} ${tokenOut} via Uniswap V3` };
    }

    throw new Error(`No aggregator route found for ${tokenIn} -> ${tokenOut}`);
  }

  static async swap({ tokenIn, tokenOut, amountIn, decimalsIn = 18, decimalsOut = 18, recipient, slippage, chain, minOut } = {}) {
    if (!amountIn || Number(amountIn) <= 0) throw new Error('amountIn must be positive');
    if (!tokenIn || !tokenOut) throw new Error('tokenIn and tokenOut required');
    if (!viem) throw new Error('viem not installed');
    const cfg = this.getConfig();
    const { wallet, publicClient, account } = await this._walletClient();
    const network = chain || cfg.openOceanChain;
    const finalRecipient = recipient || account.address;
    const inParam = this._tokenParam(tokenIn, cfg);
    const outParam = this._tokenParam(tokenOut, cfg);
    const gasPrice = Math.max(1, Math.floor(Number(process.env.DAPP_GAS_PRICE_GWEI || 1)));
    const slip = slippage !== undefined ? Number(slippage) : cfg.slippage;
    const rawIn = viem.parseUnits(String(amountIn), Number(decimalsIn) || 18);

    const quote = await this.quote({ tokenIn, tokenOut, amountIn, decimalsIn, decimalsOut, slippage: slip, chain: network });
    if (quote.status !== 'ready') throw new Error(quote.instructions || 'Aggregator quote not ready');

    // Fall back to Uniswap V3 direct swap when OpenOcean did not provide calldata
    if (quote.provider !== 'openocean') {
      if (!UniswapV3Engine) throw new Error('UniswapV3Engine not available for aggregator fallback');
      return UniswapV3Engine.swap({ tokenIn, tokenOut, amountIn, decimalsIn, decimalsOut, recipient: finalRecipient, slippageBps: Math.round(slip * 100), minOut });
    }

    const swapParams = new URLSearchParams({
      inTokenAddress: inParam,
      outTokenAddress: outParam,
      amount: String(amountIn),
      gasPrice: String(gasPrice),
      slippage: String(slip),
      account: finalRecipient,
    });
    if (minOut) swapParams.set('minOutput', String(minOut));
    const txData = await this._fetchOpenOcean(`/swap_quote?${swapParams.toString()}`, { ...cfg, openOceanChain: network, timeoutMs: 10000 });
    if (!txData || !txData.data || !txData.to) throw new Error('OpenOcean swap_quote did not return transaction data');

    const to = txData.to;
    const value = BigInt(txData.value || 0);
    const gasLimit = BigInt(txData.estimatedGas || 600000);
    const txGasPrice = BigInt(txData.gasPrice || viem.parseGwei('1'));

    return this._withLowerFees(async () => {
      // Approve the spender if input is an ERC-20
      if (!this._isNative(inParam)) {
        const allowance = BigInt(await publicClient.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'allowance', args: [account.address, to] }));
        if (allowance < rawIn) {
          const approveHash = await wallet.writeContract({
            address: tokenIn,
            abi: erc20Abi,
            functionName: 'approve',
            args: [to, rawIn],
            gas: 100000n,
            gasPrice: txGasPrice,
          });
          await publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: 120000 });
        }
      }

      const hash = await wallet.sendTransaction({
        to,
        data: txData.data,
        value,
        gas: gasLimit,
        gasPrice: txGasPrice,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180000 });

      // Try to extract actual output from Swap/Transfer logs
      let actualOut = quote.amountOut;
      try {
        const outDecimals = Number(decimalsOut) || 18;
        for (const log of (receipt.logs || [])) {
          if (log.address.toLowerCase() === tokenOut.toLowerCase() && log.topics[0] === ERC20_TRANSFER_TOPIC && log.topics.length >= 3) {
            const toTopic = '0x000000000000000000000000' + finalRecipient.slice(2).toLowerCase();
            if (log.topics[2].toLowerCase() === toTopic) {
              actualOut = Number(viem.formatUnits(BigInt(log.data), outDecimals));
              break;
            }
          }
        }
      } catch (e) {}

      return { status: 'executed', provider: 'openocean', txHash: hash, amountOut: actualOut, expectedAmountOut: quote.amountOut, amountOutMinimum: quote.amountOutMinimum, tokenIn, tokenOut, amountIn, recipient: finalRecipient, exchange: to, mode: 'live', receipt };
    });
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

  static async readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.privateKey) issues.push('DAPP_PRIVATE_KEY not configured');
    if (!cfg.rpcUrl) issues.push('DAPP_RPC_URL not configured');
    if (!UniswapV3Engine) issues.push('UniswapV3Engine not available for fallback');
    return { ready: issues.length === 0, provider: 'aggregator', fallback: UniswapV3Engine ? 'uniswap_v3' : 'none', chain: cfg.openOceanChain, issues };
  }
}

module.exports = { DexAggregatorEngine };
