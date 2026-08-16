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
const fs = require('fs');
const path = require('path');

let viem, chains, privateKeyToAccount;
try { viem = require('viem'); chains = require('viem/chains'); ({ privateKeyToAccount } = require('viem/accounts')); } catch (e) { viem = null; chains = null; privateKeyToAccount = null; }

function str(name, fallback = '') { return (process.env[name] || fallback).trim(); }
function bool(name, fallback = false) { const v = process.env[name]; return v ? String(v).toLowerCase() === 'true' : fallback; }
function num(name, fallback = 0) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : fallback; }

const SWAP_ROUTER_02 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
const UNISWAP_V2_ROUTER_02 = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const UNISWAP_V2_ROUTER_02_BASE = '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24';

function chainById(id) {
  if (!chains) return undefined;
  if (id === 8453) return chains.base;
  if (id === 11155111) return chains.sepolia;
  return chains.mainnet;
}

function defaultUniswapV2Router(chainId) {
  return chainId === 8453 ? UNISWAP_V2_ROUTER_02_BASE : UNISWAP_V2_ROUTER_02;
}

const erc20Abi = [
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'transfer', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
];

const whitelistAbi = [
  { type: 'function', name: 'whitelisted', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'setWhitelisted', inputs: [{ type: 'address' }, { type: 'bool' }], outputs: [], stateMutability: 'nonpayable' },
];

const uniswapV2RouterAbi = [
  { type: 'function', name: 'getAmountsOut', inputs: [{ type: 'uint256' }, { type: 'address[]' }], outputs: [{ type: 'uint256[]' }], stateMutability: 'view' },
  { type: 'function', name: 'swapExactTokensForTokens', inputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'address[]' }, { type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'uint256[]' }], stateMutability: 'nonpayable' },
];

const bondDexAbi = [
  { type: 'function', name: 'token0', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'token1', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'reserve0', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'reserve1', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'addLiquidity', inputs: [{ type: 'uint256' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'swap', inputs: [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }], stateMutability: 'nonpayable' },
];

function getBondDexAbi() {
  const abiPath = str('BOND_DEX_ABI_PATH', path.join(process.cwd(), 'artifacts', 'contracts_BondDex_sol_BondDex.abi'));
  return JSON.parse(fs.readFileSync(abiPath, 'utf8'));
}

function getBondDexBytecode() {
  const binPath = str('BOND_DEX_BYTECODE_PATH', path.join(process.cwd(), 'artifacts', 'contracts_BondDex_sol_BondDex.bin'));
  return '0x' + fs.readFileSync(binPath, 'utf8').trim();
}

function walletClient() {
  if (!viem) throw new Error('viem not installed');
  const cfg = getConfig();
  if (!cfg.privateKey) throw new Error('DAPP_PRIVATE_KEY not configured');
  const account = privateKeyToAccount(cfg.privateKey);
  const chain = chainById(cfg.chainId);
  const fees = cfg.getFees ? (cfg.getFees() || { maxFeePerGas: viem.parseGwei('20'), maxPriorityFeePerGas: viem.parseGwei('0.5') }) : { maxFeePerGas: viem.parseGwei('20'), maxPriorityFeePerGas: viem.parseGwei('0.5') };
  return {
    account,
    fees,
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

  static async quote({ tokenIn, tokenOut, amountIn, decimalsIn = 6, decimalsOut = 6, fee = 3000, router } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw new Error('DEX swap not enabled');
    const amount = Number(amountIn) || 0;
    if (amount <= 0) throw new Error('amountIn must be positive');

    const outputToken = tokenOut || cfg.usdcAddress;
    const inputToken = tokenIn;
    const poolAddress = router || cfg.router;

    if (!cfg.shadow && poolAddress && viem) {
      const { publicClient } = walletClient();
      const token0 = await publicClient.readContract({ address: poolAddress, abi: bondDexAbi, functionName: 'token0' });
      const token1 = await publicClient.readContract({ address: poolAddress, abi: bondDexAbi, functionName: 'token1' });
      const r0 = await publicClient.readContract({ address: poolAddress, abi: bondDexAbi, functionName: 'reserve0' });
      const r1 = await publicClient.readContract({ address: poolAddress, abi: bondDexAbi, functionName: 'reserve1' });
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

  static async swap({ tokenIn, tokenOut, amountIn, amountOutMinimum, recipient, fee = 3000, decimalsIn = 6, decimalsOut = 6, router } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw new Error('DEX swap not enabled');
    if (!amountIn || Number(amountIn) <= 0) throw new Error('amountIn required');

    const inputToken = tokenIn;
    const outputToken = tokenOut || cfg.usdcAddress;
    const poolAddress = router || cfg.router;
    const quote = await this.quote({ tokenIn: inputToken, tokenOut: outputToken, amountIn, decimalsIn, decimalsOut, fee, router: poolAddress });

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

    if (!poolAddress || !viem) throw new Error('BOND_DEX_ADDRESS / DEX_SWAP_ROUTER not configured');

    const { wallet, publicClient, fees } = walletClient();
    const rawIn = viem.parseUnits(String(amountIn), decimalsIn);
    const minOut = amountOutMinimum ? viem.parseUnits(String(amountOutMinimum), decimalsOut) : 0n;

    const approveHash = await wallet.writeContract({
      address: inputToken,
      abi: erc20Abi,
      functionName: 'approve',
      args: [poolAddress, rawIn],
      gas: 100000n,
      ...fees,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: 120000 });

    const swapHash = await wallet.writeContract({
      address: poolAddress,
      abi: bondDexAbi,
      functionName: 'swap',
      args: [rawIn, inputToken, minOut],
      gas: 250000n,
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: swapHash, timeout: 120000 });
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

  static async quoteUniswapV2({ tokenIn, tokenOut, amountIn, decimalsIn = 18, decimalsOut = 18, router, path } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw new Error('DEX swap not enabled');
    const amount = Number(amountIn) || 0;
    if (amount <= 0) throw new Error('amountIn must be positive');

    const routerAddress = router || str('UNISWAP_V2_ROUTER', defaultUniswapV2Router(cfg.chainId));
    const swapPath = Array.isArray(path) && path.length >= 2 ? path : [tokenIn, tokenOut];
    const inputToken = tokenIn || swapPath[0];
    const outputToken = tokenOut || swapPath[swapPath.length - 1];

    if (!cfg.shadow && viem) {
      const { publicClient } = walletClient();
      const rawIn = viem.parseUnits(String(amountIn), decimalsIn);
      const amounts = await publicClient.readContract({
        address: routerAddress,
        abi: uniswapV2RouterAbi,
        functionName: 'getAmountsOut',
        args: [rawIn, swapPath],
      });
      if (!amounts || amounts.length < swapPath.length) throw new Error('Uniswap V2 getAmountsOut failed');
      const amountOutRaw = amounts[amounts.length - 1];
      const amountOutHuman = Number(viem.formatUnits(amountOutRaw, decimalsOut));
      const minOutHuman = amountOutHuman * (1 - cfg.slippageBps / 10000);
      return {
        tokenIn: inputToken,
        tokenOut: outputToken,
        path: swapPath,
        amountIn,
        amountOut: amountOutHuman.toFixed(decimalsOut),
        amountOutMinimum: minOutHuman.toFixed(decimalsOut),
        price: amountOutHuman / amount,
        mode: 'live',
        router: routerAddress,
      };
    }

    const price = 0.95 + Math.random() * 0.05;
    const outHuman = amount * price;
    const minOutHuman = outHuman * (1 - cfg.slippageBps / 10000);
    return {
      tokenIn: inputToken,
      tokenOut: outputToken,
      path: swapPath,
      amountIn,
      amountOut: outHuman.toFixed(decimalsOut),
      amountOutMinimum: minOutHuman.toFixed(decimalsOut),
      price,
      mode: 'shadow',
      router: routerAddress,
    };
  }

  static async swapOnUniswapV2({ tokenIn, tokenOut, amountIn, amountOutMinimum, recipient, decimalsIn = 18, decimalsOut = 18, router, path, privateKey } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw new Error('DEX swap not enabled');
    const amount = Number(amountIn) || 0;
    if (amount <= 0) throw new Error('amountIn must be positive');

    const routerAddress = router || str('UNISWAP_V2_ROUTER', defaultUniswapV2Router(cfg.chainId));
    const swapPath = Array.isArray(path) && path.length >= 2 ? path : [tokenIn, tokenOut];
    const inputToken = tokenIn || swapPath[0];
    const outputToken = tokenOut || swapPath[swapPath.length - 1];
    const to = recipient || cfg.operatorAddress;

    const quote = await this.quoteUniswapV2({ tokenIn: inputToken, tokenOut: outputToken, amountIn, decimalsIn, decimalsOut, router: routerAddress, path: swapPath });

    if (cfg.shadow) {
      return {
        status: 'executed',
        mode: 'shadow',
        txHash: `shadow-uniswap-${Date.now()}`,
        tokenIn: inputToken,
        tokenOut: outputToken,
        amountIn,
        amountOut: quote.amountOut,
        amountOutMinimum: amountOutMinimum || quote.amountOutMinimum,
        recipient: to,
      };
    }

    if (!routerAddress || !viem) throw new Error('Uniswap V2 router not configured');
    let wallet, publicClient, fees;
    if (privateKey && privateKeyToAccount) {
      const account = privateKeyToAccount(privateKey);
      const chain = chainById(cfg.chainId);
      fees = cfg.getFees ? (cfg.getFees() || { maxFeePerGas: viem.parseGwei('20'), maxPriorityFeePerGas: viem.parseGwei('0.5') }) : { maxFeePerGas: viem.parseGwei('20'), maxPriorityFeePerGas: viem.parseGwei('0.5') };
      wallet = viem.createWalletClient({ account, chain, transport: viem.http(cfg.rpcUrl) });
      publicClient = viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) });
    } else {
      ({ wallet, publicClient, fees } = walletClient());
    }
    const rawIn = viem.parseUnits(String(amountIn), decimalsIn);
    const minOut = amountOutMinimum ? viem.parseUnits(String(amountOutMinimum), decimalsOut) : viem.parseUnits(quote.amountOutMinimum, decimalsOut);
    const deadline = Math.floor(Date.now() / 1000) + 300;

    const approveHash = await wallet.writeContract({
      address: inputToken,
      abi: erc20Abi,
      functionName: 'approve',
      args: [routerAddress, rawIn],
      gas: 100000n,
      ...fees,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: 120000 });

    const swapHash = await wallet.writeContract({
      address: routerAddress,
      abi: uniswapV2RouterAbi,
      functionName: 'swapExactTokensForTokens',
      args: [rawIn, minOut, swapPath, to, BigInt(deadline)],
      gas: 250000n,
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: swapHash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`Uniswap V2 swap failed: ${receipt.transactionHash}`);

    return {
      status: 'executed',
      mode: 'live',
      txHash: receipt.transactionHash,
      tokenIn: inputToken,
      tokenOut: outputToken,
      path: swapPath,
      amountIn,
      amountOut: quote.amountOut,
      amountOutMinimum: quote.amountOutMinimum,
      recipient: to,
    };
  }

  static async createPool({ tokenA, tokenB, amountA, amountB, decimalsA = 6, decimalsB = 6 } = {}) {
    if (!tokenA || !tokenB) throw new Error('tokenA and tokenB required');
    if (tokenA.toLowerCase() === tokenB.toLowerCase()) throw new Error('tokens must be different');
    const cfg = this.getConfig();
    if (cfg.shadow) return { poolAddress: `shadow-pool-${Date.now()}`, mode: 'shadow' };
    if (!cfg.privateKey || !viem) throw new Error('DAPP_PRIVATE_KEY or viem not configured');

    const [token0, token1] = tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
    const [raw0, raw1] = tokenA.toLowerCase() === token0.toLowerCase()
      ? [viem.parseUnits(String(amountA), decimalsA), viem.parseUnits(String(amountB), decimalsB)]
      : [viem.parseUnits(String(amountB), decimalsB), viem.parseUnits(String(amountA), decimalsA)];

    const { wallet, publicClient, fees } = walletClient();
    const abi = getBondDexAbi();
    const bytecode = getBondDexBytecode();

    const deployHash = await wallet.deployContract({
      abi,
      bytecode,
      args: [token0, token1],
      gas: 800000n,
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`pool deploy failed: ${receipt.transactionHash}`);
    const poolAddress = receipt.contractAddress;

    // Permissioned stablecoin tokens require the pool contract to be whitelisted before
    // it can receive tokens. We best-effort whitelist on both sides and ignore failures.
    for (const token of [token0, token1]) {
      try {
        const isWhitelisted = await publicClient.readContract({ address: token, abi: whitelistAbi, functionName: 'whitelisted', args: [poolAddress] }).catch(() => true);
        if (isWhitelisted === false) {
          const wlHash = await wallet.writeContract({ address: token, abi: whitelistAbi, functionName: 'setWhitelisted', args: [poolAddress, true], gas: 100000n, ...fees });
          await publicClient.waitForTransactionReceipt({ hash: wlHash, timeout: 120000 });
        }
      } catch (e) { /* token may not implement whitelisting or operator may not be admin; continue */ }
    }

    const approve0 = await wallet.writeContract({
      address: token0,
      abi: erc20Abi,
      functionName: 'approve',
      args: [poolAddress, raw0],
      gas: 100000n,
      ...fees,
    });
    await publicClient.waitForTransactionReceipt({ hash: approve0, timeout: 120000 });

    const approve1 = await wallet.writeContract({
      address: token1,
      abi: erc20Abi,
      functionName: 'approve',
      args: [poolAddress, raw1],
      gas: 100000n,
      ...fees,
    });
    await publicClient.waitForTransactionReceipt({ hash: approve1, timeout: 120000 });

    const addHash = await wallet.writeContract({
      address: poolAddress,
      abi: bondDexAbi,
      functionName: 'addLiquidity',
      args: [raw0, raw1],
      gas: 300000n,
      ...fees,
    });
    const addReceipt = await publicClient.waitForTransactionReceipt({ hash: addHash, timeout: 120000 });
    if (addReceipt.status !== 'success') throw new Error(`addLiquidity failed: ${addReceipt.transactionHash}`);

    return {
      poolAddress,
      token0,
      token1,
      amount0: amountA,
      amount1: amountB,
      mode: 'live',
      txHash: addReceipt.transactionHash,
    };
  }

  static async getPoolInfo({ poolAddress } = {}) {
    if (!poolAddress) throw new Error('poolAddress required');
    const cfg = this.getConfig();
    if (cfg.shadow) return { poolAddress, mode: 'shadow' };
    if (!viem) throw new Error('viem not installed');
    const { publicClient } = walletClient();
    const [token0, token1, reserve0, reserve1] = await Promise.all([
      publicClient.readContract({ address: poolAddress, abi: bondDexAbi, functionName: 'token0' }),
      publicClient.readContract({ address: poolAddress, abi: bondDexAbi, functionName: 'token1' }),
      publicClient.readContract({ address: poolAddress, abi: bondDexAbi, functionName: 'reserve0' }),
      publicClient.readContract({ address: poolAddress, abi: bondDexAbi, functionName: 'reserve1' }),
    ]);
    const [decimals0, decimals1] = await Promise.all([
      publicClient.readContract({ address: token0, abi: erc20Abi, functionName: 'decimals' }),
      publicClient.readContract({ address: token1, abi: erc20Abi, functionName: 'decimals' }),
    ]);
    return { poolAddress, token0, token1, decimals0, decimals1, reserve0: String(reserve0), reserve1: String(reserve1), mode: 'live' };
  }

  static async addLiquidity({ poolAddress, tokenA, tokenB, amountA, amountB, decimalsA = 6, decimalsB = 6 } = {}) {
    if (!poolAddress || !tokenA || !tokenB || amountA === undefined || amountB === undefined) throw new Error('poolAddress, tokenA, tokenB, amountA, amountB required');
    const cfg = this.getConfig();
    if (cfg.shadow) return { poolAddress, mode: 'shadow', amountA, amountB };
    if (!cfg.privateKey || !viem) throw new Error('DAPP_PRIVATE_KEY or viem not configured');

    const { wallet, publicClient, fees } = walletClient();
    const [token0, token1] = await Promise.all([
      publicClient.readContract({ address: poolAddress, abi: bondDexAbi, functionName: 'token0' }),
      publicClient.readContract({ address: poolAddress, abi: bondDexAbi, functionName: 'token1' }),
    ]);
    const [decimals0, decimals1] = await Promise.all([
      publicClient.readContract({ address: token0, abi: erc20Abi, functionName: 'decimals' }),
      publicClient.readContract({ address: token1, abi: erc20Abi, functionName: 'decimals' }),
    ]);

    const tokenAIsToken0 = tokenA.toLowerCase() === token0.toLowerCase();
    const raw0 = tokenAIsToken0
      ? viem.parseUnits(String(amountA), decimals0)
      : viem.parseUnits(String(amountB), decimals1);
    const raw1 = tokenAIsToken0
      ? viem.parseUnits(String(amountB), decimals1)
      : viem.parseUnits(String(amountA), decimals0);

    const approve0 = await wallet.writeContract({
      address: token0,
      abi: erc20Abi,
      functionName: 'approve',
      args: [poolAddress, raw0],
      gas: 100000n,
      ...fees,
    });
    await publicClient.waitForTransactionReceipt({ hash: approve0, timeout: 120000 });

    const approve1 = await wallet.writeContract({
      address: token1,
      abi: erc20Abi,
      functionName: 'approve',
      args: [poolAddress, raw1],
      gas: 100000n,
      ...fees,
    });
    await publicClient.waitForTransactionReceipt({ hash: approve1, timeout: 120000 });

    const addHash = await wallet.writeContract({
      address: poolAddress,
      abi: bondDexAbi,
      functionName: 'addLiquidity',
      args: [raw0, raw1],
      gas: 300000n,
      ...fees,
    });
    const addReceipt = await publicClient.waitForTransactionReceipt({ hash: addHash, timeout: 120000 });
    if (addReceipt.status !== 'success') throw new Error(`addLiquidity failed: ${addReceipt.transactionHash}`);

    return {
      poolAddress,
      token0,
      token1,
      amountA,
      amountB,
      mode: 'live',
      txHash: addReceipt.transactionHash,
    };
  }

  static async removeLiquidity({ poolAddress, lpAmount, recipient } = {}) {
    if (!poolAddress || !lpAmount) throw new Error('poolAddress and lpAmount required');
    const cfg = this.getConfig();
    if (cfg.shadow) return { poolAddress, mode: 'shadow', lpAmount };
    if (!cfg.privateKey || !viem) throw new Error('DAPP_PRIVATE_KEY or viem not configured');

    const { wallet, publicClient, fees } = walletClient();
    const [token0, token1] = await Promise.all([
      publicClient.readContract({ address: poolAddress, abi: bondDexAbi, functionName: 'token0' }),
      publicClient.readContract({ address: poolAddress, abi: bondDexAbi, functionName: 'token1' }),
    ]);
    const rawLp = viem.parseEther(String(lpAmount));
    const to = recipient || wallet.account.address;
    const removeHash = await wallet.writeContract({
      address: poolAddress,
      abi: bondDexAbi,
      functionName: 'removeLiquidity',
      args: [rawLp],
      gas: 250000n,
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: removeHash, timeout: 120000 });
    if (receipt.status !== 'success') throw new Error(`removeLiquidity failed: ${removeHash}`);

    return { poolAddress, token0, token1, lpAmount, recipient: to, txHash: removeHash, mode: 'live' };
  }
}

module.exports = { DexSwapEngine, UNISWAP_V2_ROUTER_02, SWAP_ROUTER_02, erc20Abi, uniswapV2RouterAbi };
