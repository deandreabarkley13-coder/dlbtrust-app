'use strict';

/**
 * Stablecoin DEX Engine
 *
 * Mints a DLBUSD ERC-20 stablecoin from any source-of-funds ledger and swaps it
 * on a DEX for USDC or USDS. The operator hot wallet / relayer pays gas, so the
 * dApp user does not need native tokens ("gasless" experience).
 */

const { getConfig } = require('./config');
const { SourceOfFundsAdapter } = require('../stablecoin/sourceOfFundsAdapter');

let BondTokenizationEngine = null;
try { BondTokenizationEngine = require('./bondTokenizationEngine').BondTokenizationEngine; } catch (e) { /* optional */ }

let DexSwapEngine = null;
try { DexSwapEngine = require('./dexSwapEngine').DexSwapEngine; } catch (e) { /* optional */ }

let UniswapV3Engine = null;
try { UniswapV3Engine = require('./uniswapV3Engine').UniswapV3Engine; } catch (e) { /* optional */ }

let DexAggregatorEngine = null;
try { DexAggregatorEngine = require('./dexAggregatorEngine').DexAggregatorEngine; } catch (e) { /* optional */ }

let viem, privateKeyToAccount;
try { viem = require('viem'); ({ privateKeyToAccount } = require('viem/accounts')); } catch (e) { }

function str(name, fallback = '') { return (process.env[name] || fallback).trim(); }
function bool(name, fallback = false) { const v = process.env[name]; return v ? String(v).toLowerCase() === 'true' : fallback; }

const MAINNET_USDS = '0xdC035D45d973E3EC169d2276DDab16f1e407384F';

function id(prefix = 'SDEX') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }

function getOperatorAddress(cfg) {
  try {
    if (viem && privateKeyToAccount && cfg.privateKey) return privateKeyToAccount(cfg.privateKey).address;
  } catch (e) { /* fall through */ }
  return str('DAPP_OPERATOR_ADDRESS', '');
}

function walletClient() {
  if (!viem) throw new Error('viem not installed');
  const cfg = getConfig();
  if (!cfg.privateKey) throw new Error('DAPP_PRIVATE_KEY not configured');
  const account = privateKeyToAccount(cfg.privateKey);
  const chains = require('viem/chains');
  const chain = cfg.chainId === 1 ? chains.mainnet : (chains.sepolia || undefined);
  const fees = cfg.getFees ? (cfg.getFees() || { maxFeePerGas: viem.parseGwei('20'), maxPriorityFeePerGas: viem.parseGwei('0.5') }) : { maxFeePerGas: viem.parseGwei('20'), maxPriorityFeePerGas: viem.parseGwei('0.5') };
  return {
    account,
    fees,
    wallet: viem.createWalletClient({ account, chain, transport: viem.http(cfg.rpcUrl) }),
    publicClient: viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) }),
  };
}

const erc20Abi = [
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'transfer', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
];

const wethAbi = [
  { type: 'function', name: 'deposit', inputs: [], outputs: [], stateMutability: 'payable' },
  { type: 'function', name: 'withdraw', inputs: [{ type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
];

class StablecoinDexEngine {
  static getConfig() {
    const cfg = getConfig();
    return {
      enabled: bool('STABLECOIN_DEX_ENABLED', true),
      shadow: bool('STABLECOIN_DEX_SHADOW', cfg.dappShadow !== false ? true : cfg.dappShadow),
      chainId: cfg.chainId,
      rpcUrl: cfg.rpcUrl,
      privateKey: cfg.privateKey,
      usdcAddress: cfg.usdcAddress,
      usdsAddress: str('DAPP_USDS_ADDRESS', cfg.chainId === 1 ? MAINNET_USDS : ''),
      dlbusdAddress: str('DAPP_DLBUSD_ADDRESS', ''),
      poolAddress: str('BOND_DEX_ADDRESS', ''),
      wethAddress: cfg.wethAddress,
      daiAddress: str('DAPP_DAI_ADDRESS', '0x6B175474E89094C44Da98b954EedeAC495271d0F'),
      operatorAddress: cfg.operatorAddress || getOperatorAddress(cfg),
      slippageBps: Number(str('STABLECOIN_DEX_SLIPPAGE_BPS', '100')) || 100,
    };
  }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.enabled) issues.push('STABLECOIN_DEX_ENABLED is not true');
    if (!cfg.shadow) {
      if (!cfg.privateKey) issues.push('DAPP_PRIVATE_KEY not configured');
      if (!cfg.rpcUrl) issues.push('DAPP_RPC_URL not configured');
      if (!cfg.usdcAddress) issues.push('DAPP_USDC_ADDRESS not configured');
      if (!BondTokenizationEngine) issues.push('BondTokenizationEngine not available');
      if (!DexSwapEngine) issues.push('DexSwapEngine not available');
    }
    return { ready: issues.length === 0, mode: cfg.shadow ? 'shadow' : 'live', issues };
  }

  static async wrapEth({ amount } = {}) {
    const cfg = this.getConfig();
    if (cfg.shadow) return { wrapped: amount, mode: 'shadow' };
    if (!cfg.wethAddress) throw new Error('DAPP_WETH_ADDRESS not configured');
    if (!amount || Number(amount) <= 0) throw new Error('amount must be positive');
    const { wallet, publicClient, fees } = walletClient();
    const raw = viem.parseEther(String(amount));
    const hash = await wallet.writeContract({
      address: cfg.wethAddress,
      abi: wethAbi,
      functionName: 'deposit',
      value: raw,
      gas: 100000n,
      ...fees,
    });
    await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    return { wrapped: amount, txHash: hash };
  }

  static async getOrCreateDLBUSDToken() {
    if (!BondTokenizationEngine) throw new Error('BondTokenizationEngine not available');
    const cfg = this.getConfig();
    let tokenAddress = cfg.dlbusdAddress;

    if (!tokenAddress && cfg.poolAddress && !cfg.shadow && viem) {
      try {
        const { publicClient } = walletClient();
        const bondDexAbi = [
          { type: 'function', name: 'token0', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
          { type: 'function', name: 'token1', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
        ];
        const [t0, t1] = await Promise.all([
          publicClient.readContract({ address: cfg.poolAddress, abi: bondDexAbi, functionName: 'token0' }),
          publicClient.readContract({ address: cfg.poolAddress, abi: bondDexAbi, functionName: 'token1' }),
        ]);
        const wethLower = (cfg.wethAddress || '').toLowerCase();
        const candidate = String(t0).toLowerCase() === wethLower ? t1 : t0;
        if (candidate && String(candidate).toLowerCase() !== wethLower) tokenAddress = candidate;
      } catch (e) { console.warn('[StablecoinDexEngine] pool DLBUSD token detection failed:', e.message); }
    }

    let token = null;
    if (tokenAddress) {
      try { token = await BondTokenizationEngine.getTokenByAddress(tokenAddress); } catch (e) { /* ignore */ }
    }
    if (!token) token = await BondTokenizationEngine.getTokenBySymbol('DLBUSD');

    if (token && token.token_address && !cfg.shadow) {
      const { publicClient } = walletClient();
      const code = await publicClient.getBytecode({ address: token.token_address }).catch(() => '0x');
      if (!code || code === '0x') token = null;
    }
    if (!token) {
      token = await BondTokenizationEngine.createToken({
        tokenName: 'DLBUSD',
        tokenSymbol: 'DLBUSD',
        tokenAddress: tokenAddress || undefined,
        decimals: 6,
      });
    }
    return token;
  }

  static targetTokenAddress(targetAsset) {
    const cfg = this.getConfig();
    const t = String(targetAsset).toUpperCase();
    if (t === 'USD' || t === 'USDC') return cfg.usdcAddress;
    if (t === 'USDS') return cfg.usdsAddress || (cfg.chainId === 1 ? MAINNET_USDS : cfg.usdcAddress);
    if (t === 'ETH' || t === 'WETH') return cfg.wethAddress || '';
    if (t === 'DAI') return cfg.daiAddress || '';
    return '';
  }

  static targetTokenDecimals(targetAsset) {
    const t = String(targetAsset).toUpperCase();
    if (t === 'ETH' || t === 'WETH' || t === 'DAI' || t === 'USDS') return 18;
    return 6;
  }

  static async _quoteSecondLeg({ tokenIn, tokenOut, amountIn, decimalsIn = 18, decimalsOut = 18 } = {}) {
    const errors = [];
    if (DexAggregatorEngine) {
      try {
        const q = await DexAggregatorEngine.quote({ tokenIn, tokenOut, amountIn, decimalsIn, decimalsOut });
        if (Number(q?.amountOut) > 0) return { ...q, route: 'aggregator', engine: 'DexAggregatorEngine' };
      } catch (e) { errors.push(`aggregator: ${e.message}`); }
    }
    if (UniswapV3Engine) {
      try {
        const q = await UniswapV3Engine.quote({ tokenIn, tokenOut, amountIn, decimalsIn, decimalsOut });
        if (q?.status === 'ready' && Number(q.amountOut) > 0) return { ...q, route: 'uniswap_v3', engine: 'UniswapV3Engine' };
      } catch (e) { errors.push(`uniswap_v3: ${e.message}`); }
    }
    if (DexSwapEngine) {
      try {
        const q = await DexSwapEngine.quoteUniswapV2({ tokenIn, tokenOut, amountIn, decimalsIn, decimalsOut, path: [tokenIn, tokenOut] });
        if (Number(q?.amountOut) > 0) return { ...q, route: 'uniswap_v2', engine: 'DexSwapEngine' };
      } catch (e) { errors.push(`uniswap_v2: ${e.message}`); }
    }
    throw new Error(`No second-leg route for ${tokenIn} -> ${tokenOut}: ${errors.join('; ')}`);
  }

  static async _swapSecondLeg({ tokenIn, tokenOut, amountIn, decimalsIn = 18, decimalsOut = 18, recipient, quote } = {}) {
    if (quote?.route === 'aggregator' && DexAggregatorEngine) {
      return DexAggregatorEngine.swap({ tokenIn, tokenOut, amountIn, decimalsIn, decimalsOut, recipient, minOut: quote.amountOutMinimum });
    }
    if (quote?.route === 'uniswap_v3' && UniswapV3Engine) {
      return UniswapV3Engine.swap({ tokenIn, tokenOut, amountIn, decimalsIn, decimalsOut, recipient, minOut: quote.amountOutMinimum });
    }
    if (DexSwapEngine) {
      return DexSwapEngine.swapOnUniswapV2({ tokenIn, tokenOut, amountIn, amountOutMinimum: quote?.amountOutMinimum, decimalsIn, decimalsOut, recipient, path: [tokenIn, tokenOut] });
    }
    throw new Error('No second-leg swap engine available');
  }

  static async quote({ amount, targetAsset = 'USDC', poolAddress }) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw new Error('Stablecoin DEX not enabled');
    if (!amount || Number(amount) <= 0) throw new Error('amount must be positive');
    const token = await this.getOrCreateDLBUSDToken();
    const tokenOut = this.targetTokenAddress(targetAsset);
    if (!tokenOut) throw new Error(`Target asset ${targetAsset} has no token address configured`);
    const decimalsOut = this.targetTokenDecimals(targetAsset);
    const quote = await DexSwapEngine.quote({
      tokenIn: token.token_address,
      tokenOut,
      amountIn: amount,
      decimalsIn: 6,
      decimalsOut,
      router: poolAddress,
    });
    return { tokenIn: token.token_address, tokenOut, ...quote };
  }

  static async createPool({ seedUsdcAmount = 0.2, seedDlbusdAmount = 0.2, targetAsset = 'USDC' } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw new Error('Stablecoin DEX not enabled');
    if (cfg.shadow) return { poolAddress: `shadow-pool-dlbusd-${Date.now()}`, mode: 'shadow' };
    const token = await this.getOrCreateDLBUSDToken();
    const tokenOut = this.targetTokenAddress(targetAsset);
    if (!tokenOut) throw new Error(`Target asset ${targetAsset} has no token address configured`);
    const decimalsOut = this.targetTokenDecimals(targetAsset);

    // First mint the seed DLBUSD to the operator wallet (no source debit; comes from treasury backing)
    await BondTokenizationEngine.mint({ tokenId: token.id, principal: seedDlbusdAmount, holderAddress: cfg.operatorAddress });

    // If seeding a WETH pool, wrap native ETH so the pool can pull WETH from the operator.
    if (tokenOut.toLowerCase() === (cfg.wethAddress || '').toLowerCase()) {
      const { publicClient } = walletClient();
      const wethBalance = await publicClient.readContract({ address: tokenOut, abi: wethAbi, functionName: 'balanceOf', args: [cfg.operatorAddress] });
      const seedWethRaw = viem.parseEther(String(seedUsdcAmount));
      if (BigInt(wethBalance || 0) < seedWethRaw) {
        await this.wrapEth({ amount: seedUsdcAmount });
      }
    }

    return DexSwapEngine.createPool({
      tokenA: token.token_address,
      tokenB: tokenOut,
      amountA: seedDlbusdAmount,
      amountB: seedUsdcAmount,
      decimalsA: 6,
      decimalsB: decimalsOut,
    });
  }

  static async mintFromSource({ sourceType, sourceAccountId, amount, targetAddress } = {}) {
    if (!sourceType || !sourceAccountId || !amount) throw new Error('sourceType, sourceAccountId, and amount are required');
    const amountNum = Number(amount);
    if (amountNum <= 0) throw new Error('amount must be positive');
    const amountCents = Math.round(amountNum * 100);
    const cfg = this.getConfig();
    const operationId = id();

    // Reserve the source-of-funds ledger balance into the treasury
    const sweep = await SourceOfFundsAdapter._fundSourceToTreasury({
      sourceType,
      sourceAccountId,
      paymentId: operationId,
      amountCents,
    });

    const token = await this.getOrCreateDLBUSDToken();
    const holder = targetAddress || cfg.operatorAddress;
    let mint;
    try {
      mint = await BondTokenizationEngine.mint({
        tokenId: token.id,
        principal: amountNum,
        holderAddress: holder,
      });
    } catch (mintErr) {
      // Rollback the source-engine debit if on-chain mint fails so funds are not stranded.
      try {
        await SourceOfFundsAdapter._refundSourceFromTreasury({
          sourceType,
          sourceAccountId,
          payment: { id: operationId, total_cents: amountCents },
          sourceRef: sweep,
        });
      } catch (rollbackErr) {
        console.warn('[StablecoinDexEngine] source rollback failed after mint error:', rollbackErr.message);
      }
      throw mintErr;
    }

    return {
      operationId,
      sourceType,
      sourceAccountId,
      amount,
      tokenAddress: token.token_address,
      minted: mint.minted,
      mintTxHash: mint.txHash,
      sweep,
      holder,
    };
  }

  static async unwrapWethToEth({ amount, recipient } = {}) {
    const cfg = this.getConfig();
    if (!cfg.wethAddress || cfg.shadow) return { skipped: true };
    if (!viem) throw new Error('viem not installed');
    const { wallet, publicClient, fees } = walletClient();
    const wethAbi = [
      { type: 'function', name: 'withdraw', inputs: [{ type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
      { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
    ];
    const target = recipient || cfg.operatorAddress;
    const balance = await publicClient.readContract({ address: cfg.wethAddress, abi: wethAbi, functionName: 'balanceOf', args: [wallet.account.address] });
    const raw = amount ? viem.parseUnits(String(amount), 18) : balance;
    if (raw <= 0n) return { skipped: true, reason: 'no_weth_balance' };
    const hash = await wallet.writeContract({ address: cfg.wethAddress, abi: wethAbi, functionName: 'withdraw', args: [raw], gas: 100000n, ...fees });
    await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    const sendHash = await wallet.sendTransaction({ to: target, value: raw, gas: 21000n, ...fees });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: sendHash, timeout: 120000 });
    return { hash, sendHash, status: receipt.status, amountEth: viem.formatEther(raw), to: target };
  }

  static async _isValidPool({ poolAddress, tokenIn, tokenOut }) {
    if (!poolAddress || !tokenIn || !tokenOut) return false;
    if (this.getConfig().shadow) return true;
    try {
      const { publicClient } = walletClient();
      const code = await publicClient.getBytecode({ address: poolAddress });
      if (!code || code === '0x') return false;
      const bondDexAbi = [
        { type: 'function', name: 'token0', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
        { type: 'function', name: 'token1', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
      ];
      const [t0, t1] = await Promise.all([
        publicClient.readContract({ address: poolAddress, abi: bondDexAbi, functionName: 'token0' }),
        publicClient.readContract({ address: poolAddress, abi: bondDexAbi, functionName: 'token1' }),
      ]);
      const inLower = tokenIn.toLowerCase();
      const outLower = tokenOut.toLowerCase();
      return (t0.toLowerCase() === inLower && t1.toLowerCase() === outLower) || (t0.toLowerCase() === outLower && t1.toLowerCase() === inLower);
    } catch (e) { return false; }
  }

  static async swap({ amount, targetAsset = 'USDC', poolAddress, recipient, minOut } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw new Error('Stablecoin DEX not enabled');
    const amountNum = Number(amount);
    if (amountNum <= 0) throw new Error('amount must be positive');
    const token = await this.getOrCreateDLBUSDToken();
    const tokenOut = this.targetTokenAddress(targetAsset);
    if (!tokenOut) throw new Error(`Target asset ${targetAsset} has no token address configured`);
    const decimalsOut = this.targetTokenDecimals(targetAsset);

    if (poolAddress && !(await this._isValidPool({ poolAddress, tokenIn: token.token_address, tokenOut }))) {
      throw new Error(`Pool ${poolAddress} is not a valid DLBUSD/${targetAsset} BondDex pool`);
    }

    const quote = await DexSwapEngine.quote({
      tokenIn: token.token_address,
      tokenOut,
      amountIn: amount,
      decimalsIn: 6,
      decimalsOut,
      router: poolAddress,
    });

    const swap = await DexSwapEngine.swap({
      tokenIn: token.token_address,
      tokenOut,
      amountIn: amount,
      amountOutMinimum: minOut || quote.amountOutMinimum,
      decimalsIn: 6,
      decimalsOut,
      router: poolAddress,
      recipient: recipient || cfg.operatorAddress,
    });

    const finalRecipient = (recipient || cfg.operatorAddress).toLowerCase();
    const operatorAddressLower = cfg.operatorAddress.toLowerCase();
    if (finalRecipient !== operatorAddressLower && !cfg.shadow) {
      const { wallet, publicClient, fees } = walletClient();
      const rawOut = viem.parseUnits(String(swap.amountOut), decimalsOut);
      const transferHash = await wallet.writeContract({
        address: tokenOut,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [recipient, rawOut],
        gas: 100000n,
        ...fees,
      });
      await publicClient.waitForTransactionReceipt({ hash: transferHash, timeout: 120000 });
      swap.transferHash = transferHash;
    }

    return { quote, swap };
  }

  static async depositAndSwap({
    sourceType,
    sourceAccountId,
    amount,
    targetAsset = 'USDC',
    recipient,
    poolAddress,
    createPoolIfMissing = false,
    poolSeedUsdc = 0.2,
    poolSeedDlbusd = 0.2,
    poolSeedTargetAmount,
    unwrapWeth = true,
  } = {}) {
    if (!sourceType || !sourceAccountId || !amount) throw new Error('sourceType, sourceAccountId, and amount are required');
    const cfg = this.getConfig();
    if (!cfg.enabled) throw new Error('Stablecoin DEX not enabled');
    const operationId = id('DLBUSD-SWAP');

    // 1. Resolve or create the DEX pool BEFORE debiting the source ledger
    const targetUpper = (targetAsset || '').toUpperCase();
    const needsWethPool = ['DAI', 'ETH', 'USDS', 'USDC'].includes(targetUpper);
    const poolTargetAsset = needsWethPool ? 'WETH' : targetAsset;
    let resolvedPool = poolAddress;
    let poolInfo = null;
    const token = await this.getOrCreateDLBUSDToken();
    const tokenOut = this.targetTokenAddress(poolTargetAsset);
    if (resolvedPool && !(await this._isValidPool({ poolAddress: resolvedPool, tokenIn: token.token_address, tokenOut }))) {
      resolvedPool = null;
    }
    // Fallback to a configured pool/router address if no pool address was supplied.
    if (!resolvedPool && DexSwapEngine) {
      const router = DexSwapEngine.getConfig && DexSwapEngine.getConfig().router;
      if (router && await this._isValidPool({ poolAddress: router, tokenIn: token.token_address, tokenOut })) {
        resolvedPool = router;
      }
    }
    if (!resolvedPool && createPoolIfMissing) {
      const seedTarget = poolSeedTargetAmount !== undefined ? poolSeedTargetAmount : poolSeedUsdc;
      poolInfo = await this.createPool({ seedUsdcAmount: seedTarget, seedDlbusdAmount: poolSeedDlbusd, targetAsset: poolTargetAsset });
      resolvedPool = poolInfo && poolInfo.poolAddress;
    }
    if (!resolvedPool) throw new Error('No valid DEX pool address and createPoolIfMissing is false');

    // 2. Mint DLBUSD from the chosen source ledger
    const mint = await this.mintFromSource({ sourceType, sourceAccountId, amount, targetAddress: cfg.operatorAddress });

    // 3. Execute the DEX swap (operator relayer pays gas; user is gasless)
    let isEthTarget = targetUpper === 'ETH';
    let isDaiTarget = targetUpper === 'DAI';
    let isUsdsTarget = targetUpper === 'USDS';
    let isUsdcTarget = targetUpper === 'USDC';
    let swapTarget = needsWethPool ? 'WETH' : targetAsset;
    // For WETH/ETH/DAI/USDS routes the first leg (DLBUSD -> WETH) lands in the operator wallet
    // so the operator can perform the second leg or unwrap without needing gas from the recipient.
    let swapRecipient = needsWethPool ? cfg.operatorAddress : (recipient || cfg.operatorAddress);
    let quote, swap, daiSwap, usdsSwap, usdcSwap;
    try {
      const swapResult = await this.swap({
        amount,
        targetAsset: swapTarget,
        poolAddress: resolvedPool,
        recipient: swapRecipient,
      });
      quote = swapResult.quote;
      swap = swapResult.swap;
    } catch (swapErr) {
      // Try an ETH fallback so bond interest is not left stranded as DLBUSD in the operator wallet.
      if (needsWethPool) {
        console.warn('[StablecoinDexEngine] primary WETH-route swap failed; DLBUSD held by operator:', swapErr.message);
        throw swapErr;
      }
      console.warn('[StablecoinDexEngine] primary swap failed, trying WETH fallback:', swapErr.message);
      try {
        const ethSwapResult = await this.swap({
          amount,
          targetAsset: 'WETH',
          poolAddress: resolvedPool,
          recipient: cfg.operatorAddress,
        });
        quote = ethSwapResult.quote;
        swap = ethSwapResult.swap;
        isEthTarget = true;
      } catch (ethErr) {
        console.warn('[StablecoinDexEngine] WETH fallback swap failed; DLBUSD held by operator:', ethErr.message);
        throw ethErr;
      }
    }

    // 3b. Route WETH through the best available DEX (aggregator, V3, V2) for DAI, USDC, or USDS payouts.
    if (!cfg.shadow && (isDaiTarget || isUsdcTarget || isUsdsTarget)) {
      const wethAddress = cfg.wethAddress;
      const outAddress = isDaiTarget ? this.targetTokenAddress('DAI') : (isUsdsTarget ? this.targetTokenAddress('USDS') : cfg.usdcAddress);
      if (!outAddress || !wethAddress) throw new Error(`${targetAsset} or WETH address not configured`);
      const decimalsOut = isDaiTarget || isUsdsTarget ? 18 : 6;
      try {
        const secondLegQuote = await this._quoteSecondLeg({ tokenIn: wethAddress, tokenOut: outAddress, amountIn: swap.amountOut, decimalsIn: 18, decimalsOut });
        const swapResult = await this._swapSecondLeg({ tokenIn: wethAddress, tokenOut: outAddress, amountIn: swap.amountOut, decimalsIn: 18, decimalsOut, recipient: recipient || cfg.operatorAddress, quote: secondLegQuote });
        if (isDaiTarget) daiSwap = swapResult;
        else if (isUsdsTarget) usdsSwap = swapResult;
        else usdcSwap = swapResult;
      } catch (secondaryErr) {
        console.warn(`[StablecoinDexEngine] WETH -> ${targetAsset} second-leg swap failed:`, secondaryErr.message);
        throw secondaryErr;
      }
    }

    let unwrap = { skipped: true };
    if (!cfg.shadow && isEthTarget && unwrapWeth) {
      try { unwrap = await this.unwrapWethToEth({ amount: swap.amountOut, recipient: recipient || cfg.operatorAddress }); } catch (e) { unwrap = { skipped: false, error: e.message }; }
    }

    const actualTargetAsset = isEthTarget ? 'ETH' : (isDaiTarget ? 'DAI' : (isUsdsTarget ? 'USDS' : (isUsdcTarget ? 'USDC' : targetAsset)));
    const actualAmountOut = isEthTarget ? (unwrap.amountEth || swap.amountOut || 0) : (isDaiTarget ? ((daiSwap && daiSwap.amountOut) || 0) : (isUsdsTarget ? ((usdsSwap && usdsSwap.amountOut) || 0) : (isUsdcTarget ? ((usdcSwap && usdcSwap.amountOut) || 0) : (swap.amountOut || 0))));

    return {
      operationId,
      sourceType,
      sourceAccountId,
      amount,
      targetAsset,
      actualTargetAsset,
      swapTarget,
      tokenAddress: mint.tokenAddress,
      minted: mint.minted,
      mintTxHash: mint.mintTxHash,
      poolAddress: resolvedPool,
      poolCreated: !!poolInfo,
      quote,
      swap,
      daiSwap,
      usdsSwap,
      usdcSwap,
      unwrap,
      recipient: recipient || cfg.operatorAddress,
      amountOut: actualAmountOut,
      mode: cfg.shadow ? 'shadow' : 'live',
      note: cfg.shadow
        ? 'Shadow swap completed. Real on-chain swap requires a deployed DLBUSD token, a funded DEX pool, and gas in the operator wallet.'
        : 'DLBUSD minted from source ledger and swapped on the DEX. The operator relayer paid gas; the user did not need native tokens.',
    };
  }
}

module.exports = { StablecoinDexEngine };
