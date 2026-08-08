'use strict';

/**
 * Cross-Chain Conversion & Interoperability Engine
 *
 * Combines on-chain conversion, P2P order-book fallback, and cross-chain bridges
 * into a single route planner. It lets trustees convert any trust asset or ledger
 * balance into a canonical stablecoin (USDC/USDS/DAI) on the source chain or on a
 * target chain via a bridge.
 *
 * Routes are proposed through Canonical Consensus (1-of-2 Maker/Checker) before
 * execution, and every request is persisted in `cross_chain_requests`.
 */

const { query } = require('../bonds/pgPool');
const { getConfig } = require('./config');

let StablecoinDexEngine, DexSwapEngine, ModuleP2PSwapEngine, PtcStablecoinEngine, HyperledgerBesuEngine, AccountAbstractionEngine;
let viem;
try { ({ StablecoinDexEngine } = require('./stablecoinDexEngine')); } catch (e) { /* optional */ }
try { ({ DexSwapEngine } = require('./dexSwapEngine')); } catch (e) { /* optional */ }
try { ({ ModuleP2PSwapEngine } = require('./moduleP2PSwapEngine')); } catch (e) { /* optional */ }
try { ({ PtcStablecoinEngine } = require('./ptcStablecoinEngine')); } catch (e) { /* optional */ }
try { ({ HyperledgerBesuEngine } = require('./hyperledgerBesuEngine')); } catch (e) { /* optional */ }
try { ({ AccountAbstractionEngine } = require('./accountAbstractionEngine')); } catch (e) { /* optional */ }
try { viem = require('viem'); } catch (e) { viem = null; }

function canonicalConsensusEngine() {
  const { CanonicalConsensusEngine } = require('./canonicalConsensusEngine');
  return CanonicalConsensusEngine;
}

function safeJson(obj) {
  return JSON.stringify(obj, (k, v) => (typeof v === 'bigint' ? String(v) : v));
}

function id(prefix = 'XC') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function str(name, fallback = '') { return process.env[name] || fallback; }
function num(name, fallback = 0) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : fallback; }
function bool(name, fallback = false) { const v = process.env[name]; return v === 'true' || v === '1' || (v === undefined ? fallback : false); }

const CHAIN_CONFIG = {
  ethereum: { name: 'Ethereum', chainId: 1, nativeSymbol: 'ETH' },
  base: { name: 'Base', chainId: 8453, nativeSymbol: 'ETH' },
  polygon: { name: 'Polygon', chainId: 137, nativeSymbol: 'MATIC' },
  arbitrum: { name: 'Arbitrum', chainId: 42161, nativeSymbol: 'ETH' },
  besu: { name: 'DLB Hyperledger Besu', chainId: 1337, nativeSymbol: 'BESU' },
};

const BRIDGE_FEES = {
  'circle-cctp': { feeBps: 10, min: 0, needsContract: true },
  hyperlane: { feeBps: 20, min: 0, needsContract: true },
  axelar: { feeBps: 25, min: 0, needsContract: true },
  layerzero: { feeBps: 30, min: 0, needsContract: true },
  wormhole: { feeBps: 30, min: 0, needsContract: true },
  besu: { feeBps: 0, min: 0, needsContract: false },
};

class CrossChainConversionEngine {
  static getConfig() {
    const cfg = getConfig();
    return {
      enabled: bool('CROSS_CHAIN_ENABLED', true),
      shadow: bool('CROSS_CHAIN_SHADOW', cfg.dappShadow !== false ? true : cfg.dappShadow),
      sourceChain: str('CROSS_CHAIN_SOURCE_CHAIN', 'ethereum'),
      defaultBridge: str('CROSS_CHAIN_BRIDGE', 'circle-cctp'),
      slippageBps: num('CROSS_CHAIN_SLIPPAGE_BPS', 100),
      minOutputBps: num('CROSS_CHAIN_MIN_OUTPUT_BPS', 5000),
      usdcAddress: cfg.usdcAddress,
      usdsAddress: cfg.usdsAddress,
      daiAddress: cfg.daiAddress,
      wethAddress: cfg.wethAddress,
      operatorAddress: cfg.operatorAddress,
    };
  }

  static async ensureTables() {
    await query(`
      CREATE TABLE IF NOT EXISTS cross_chain_requests (
        id              TEXT PRIMARY KEY,
        proposal_id     TEXT,
        source_type     TEXT,
        source_account  TEXT,
        source_token    TEXT,
        source_module   TEXT,
        amount          TEXT,
        target_asset    TEXT DEFAULT 'USDC',
        target_chain    TEXT DEFAULT 'ethereum',
        bridge_provider TEXT,
        recipient       TEXT,
        route           TEXT,
        status          TEXT DEFAULT 'pending',
        result          JSONB DEFAULT '{}',
        created_by      TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_cross_chain_status ON cross_chain_requests(status)`);
  }

  static _targetAddress(asset) {
    const cfg = this.getConfig();
    const t = String(asset).toUpperCase();
    if (t === 'USDC') return cfg.usdcAddress;
    if (t === 'USDS') return cfg.usdsAddress;
    if (t === 'DAI') return cfg.daiAddress;
    if (t === 'WETH' || t === 'ETH') return cfg.wethAddress;
    return '';
  }

  static _targetDecimals(asset) {
    const t = String(asset).toUpperCase();
    if (t === 'USDC') return 6;
    if (t === 'USDS' || t === 'DAI' || t === 'WETH' || t === 'ETH') return 18;
    return 6;
  }

  static _isKnownToken(symbol) {
    return ['DLB-PTCUSD', 'DLB-PRB', 'DLB-FIXED-INCOME', 'DLB-TREASURY', 'DLB-TRUST', 'DLB-CORE'].includes(String(symbol).toUpperCase());
  }

  static _moduleTokenKey(symbol) {
    return String(symbol).toUpperCase().replace('DLB-', '');
  }

  static _normalizeModuleKey(symbol) {
    const s = String(symbol || '').toUpperCase();
    if (s === 'DLB-PRB') return 'bond_portfolio';
    if (s === 'DLB-FIXED-INCOME') return 'fixed_income';
    if (s === 'DLB-TREASURY') return 'treasury';
    if (s === 'DLB-TRUST') return 'trust_accounting';
    if (s === 'DLB-CORE') return 'core_banking';
    return symbol;
  }

  static listChains() {
    return Object.entries(CHAIN_CONFIG).map(([key, c]) => ({ id: key, ...c, bridges: Object.keys(BRIDGE_FEES) }));
  }

  static listAssets() {
    const cfg = this.getConfig();
    return [
      { symbol: 'USDC', address: cfg.usdcAddress, decimals: 6, type: 'canonical' },
      { symbol: 'USDS', address: cfg.usdsAddress, decimals: 18, type: 'canonical' },
      { symbol: 'DAI', address: cfg.daiAddress, decimals: 18, type: 'canonical' },
      { symbol: 'WETH', address: cfg.wethAddress, decimals: 18, type: 'canonical' },
      { symbol: 'DLB-PTCUSD', address: process.env.DLB_PTCUSD_ADDRESS || '', decimals: 18, type: 'trust' },
      { symbol: 'DLB-PRB', address: process.env.DLB_PRB_ADDRESS || '', decimals: 6, type: 'trust' },
      { symbol: 'DLB-FIXED-INCOME', address: process.env.DLB_FIXED_INCOME_ADDRESS || '', decimals: 6, type: 'trust' },
      { symbol: 'DLB-TREASURY', address: process.env.DLB_TREASURY_ADDRESS || '', decimals: 6, type: 'trust' },
      { symbol: 'DLB-TRUST', address: process.env.DLB_TRUST_ADDRESS || '', decimals: 6, type: 'trust' },
      { symbol: 'DLB-CORE', address: process.env.DLB_CORE_ADDRESS || '', decimals: 6, type: 'trust' },
    ];
  }

  /**
   * Build one or more candidate routes for converting `amount` of the source
   * into `targetAsset` on `targetChain`. Each route includes an estimated output,
   * fee, and status. If no liquid DEX route exists, the engine recommends a P2P
   * order so the trust can find a counterparty without needing seed liquidity.
   */
  static async quote({
    sourceType,
    sourceAccountId,
    sourceToken,
    sourceModule,
    amount,
    targetAsset = 'USDC',
    targetChain = 'ethereum',
    bridgeProvider,
    recipient,
    slippageBps,
  } = {}) {
    if (!amount || Number(amount) <= 0) throw new Error('amount must be positive');
    const cfg = this.getConfig();
    const sourceChain = cfg.sourceChain;
    const outAsset = String(targetAsset).toUpperCase();
    const outChain = String(targetChain).toLowerCase();
    const routes = [];

    const sourceLabel = sourceType
      ? `${sourceType}:${sourceAccountId}`
      : sourceModule || (sourceToken === 'DLB-PTCUSD' ? 'DLB-PTCUSD' : (sourceToken || 'unknown'));

    const inputAmount = Number(amount);

    // 1. Same-chain DEX route (source -> canonical stablecoin on source chain)
    if (sourceChain === outChain) {
      const dexRoute = await this._quoteSameChainDex({
        sourceType,
        sourceAccountId,
        sourceToken,
        sourceModule,
        amount,
        targetAsset: outAsset,
        slippageBps: slippageBps ?? cfg.slippageBps,
      });
      if (dexRoute) routes.push(dexRoute);
    }

    // 2. Cross-chain route: convert to a bridgeable canonical asset, bridge, then optionally swap on destination.
    if (sourceChain !== outChain) {
      const bridge = await this._quoteCrossChain({
        sourceType,
        sourceAccountId,
        sourceToken,
        sourceModule,
        amount,
        targetAsset: outAsset,
        targetChain: outChain,
        bridgeProvider: bridgeProvider || cfg.defaultBridge,
        slippageBps: slippageBps ?? cfg.slippageBps,
      });
      if (bridge) routes.push(bridge);
    }

    // 3. P2P order-book route (always available, no DEX liquidity required).
    const p2pRoute = {
      name: 'p2p_order',
      provider: 'ModuleTokenSwap / OTC order book',
      steps: [
        { action: sourceType ? 'mint' : (sourceModule ? 'deposit' : 'transfer'), asset: sourceLabel, chain: sourceChain },
        { action: 'create_order', asset: outAsset, chain: sourceChain },
        { action: 'await_buyer', asset: outAsset, chain: sourceChain },
      ],
      inputAmount: inputAmount,
      estimatedOutput: inputAmount,
      outputAsset: outAsset,
      outputChain: outChain,
      fee: 0,
      feeAsset: outAsset,
      status: 'awaiting_buyer',
      note: 'Buyer pays gas to fill. Trust must first hold/mint the token in the operator wallet.',
      needsApproval: true,
    };
    routes.push(p2pRoute);

    // Recommend the route that is ready now and produces the most output.
    const ready = routes.filter(r => r.status === 'ready');
    const recommendation = ready.length
      ? ready.sort((a, b) => Number(b.estimatedOutput) - Number(a.estimatedOutput))[0].name
      : 'p2p_order';

    return {
      sourceChain,
      targetChain: outChain,
      source: sourceLabel,
      amount,
      targetAsset: outAsset,
      routes,
      recommendation,
      quotedAt: new Date().toISOString(),
    };
  }

  static async _quoteSameChainDex({ sourceType, sourceAccountId, sourceToken, sourceModule, amount, targetAsset, slippageBps }) {
    const cfg = this.getConfig();
    const weth = cfg.wethAddress;
    const outAddr = this._targetAddress(targetAsset);
    if (!outAddr) return null;

    let dlbusdAmount = 0;
    let tokenInAddress = '';
    let decimalsIn = 6;

    if (sourceType) {
      // Ledger source first mints DLBUSD (6 decimals).
      dlbusdAmount = Number(amount);
      const token = await StablecoinDexEngine.getOrCreateDLBUSDToken();
      tokenInAddress = token.token_address;
    } else if (sourceToken && sourceToken.toLowerCase() === 'dlb-ptcusd') {
      // DLB-PTCUSD has no DLBUSD/WETH pool by default; use P2P or a specific pool.
      return null;
    } else if (sourceToken) {
      // Raw token. Same-chain DEX only makes sense if the token is DLBUSD or has a BondDex pool.
      const dlb = await StablecoinDexEngine.getOrCreateDLBUSDToken();
      if (sourceToken.toLowerCase() !== dlb.token_address.toLowerCase()) return null;
      tokenInAddress = sourceToken;
      decimalsIn = 6;
    } else if (sourceModule) {
      // Module token (6 decimals in the ModuleTokenSwap contract).
      return null; // handled by P2P or cross-chain module deposit path
    }

    if (!tokenInAddress) return null;

    // First leg: tokenIn -> WETH via BondDex pool.
    const poolAddress = StablecoinDexEngine ? StablecoinDexEngine.getConfig().poolAddress || process.env.BOND_DEX_ADDRESS : '';
    let wethOut = 0;
    if (poolAddress && DexSwapEngine) {
      try {
        const q = await DexSwapEngine.quote({
          tokenIn: tokenInAddress,
          tokenOut: weth,
          amountIn: dlbusdAmount || amount,
          decimalsIn,
          decimalsOut: 18,
          router: poolAddress,
        });
        wethOut = Number(q.amountOut);
      } catch (e) {
        console.warn('[CrossChainConversionEngine] BondDex quote failed:', e.message);
      }
    }

    if (!wethOut || wethOut <= 0) {
      return {
        name: 'same_chain_dex',
        provider: 'BondDex + Uniswap V2',
        steps: [{ action: 'quote', asset: targetAsset, chain: cfg.sourceChain }],
        inputAmount: Number(amount),
        estimatedOutput: 0,
        outputAsset: targetAsset,
        outputChain: cfg.sourceChain,
        fee: 0,
        status: 'no_liquidity',
        warning: `No DLBUSD/WETH pool liquidity for ${amount}. Add liquidity or use P2P.`,
      };
    }

    // Second leg: WETH -> targetAsset via Uniswap V2.
    let finalOut = 0;
    if (DexSwapEngine) {
      try {
        const q = await DexSwapEngine.quoteUniswapV2({
          tokenIn: weth,
          tokenOut: outAddr,
          amountIn: wethOut,
          decimalsIn: 18,
          decimalsOut: this._targetDecimals(targetAsset),
          path: [weth, outAddr],
        });
        finalOut = Number(q.amountOut);
      } catch (e) {
        console.warn('[CrossChainConversionEngine] Uniswap V2 quote failed:', e.message);
      }
    }

    const minOut = Number(amount) * (cfg.minOutputBps / 10000);
    const tooSmall = finalOut < minOut;
    const warning = tooSmall
      ? `High slippage: ${finalOut.toFixed(6)} ${targetAsset} for ${amount} source units. Pool may be too small.`
      : undefined;
    const status = finalOut > 0 && !tooSmall ? 'ready' : 'no_liquidity';

    return {
      name: 'same_chain_dex',
      provider: 'BondDex + Uniswap V2',
      steps: [
        { action: sourceType ? 'mint' : 'transfer', asset: tokenInAddress, chain: cfg.sourceChain },
        { action: 'swap', input: dlbusdAmount || amount, inputAsset: 'DLBUSD', output: wethOut, outputAsset: 'WETH', chain: cfg.sourceChain, provider: 'BondDex' },
        { action: 'swap', input: wethOut, inputAsset: 'WETH', output: finalOut, outputAsset: targetAsset, chain: cfg.sourceChain, provider: 'Uniswap V2' },
      ],
      inputAmount: Number(amount),
      estimatedOutput: finalOut,
      outputAsset: targetAsset,
      outputChain: cfg.sourceChain,
      fee: Number(amount) - finalOut,
      feeAsset: targetAsset,
      status,
      warning,
      slippageBps,
    };
  }

  static async _quoteCrossChain({ sourceType, sourceAccountId, sourceToken, sourceModule, amount, targetAsset, targetChain, bridgeProvider, slippageBps }) {
    const cfg = this.getConfig();
    const bridge = bridgeProvider || cfg.defaultBridge;
    const feeCfg = BRIDGE_FEES[bridge];
    if (!feeCfg) return null;

    // Quote same-chain conversion into a bridgeable canonical asset (USDC first, then WETH).
    const bridgeAsset = ['USDC', 'USDS', 'DAI'].includes(targetAsset) ? targetAsset : 'USDC';
    const bridgeable = await this._quoteSameChainDex({
      sourceType,
      sourceAccountId,
      sourceToken,
      sourceModule,
      amount,
      targetAsset: bridgeAsset,
      slippageBps,
    });

    const bridgeIn = bridgeable ? Number(bridgeable.estimatedOutput) : 0;
    const bridgeOut = bridgeIn * (1 - feeCfg.feeBps / 10000);
    const needsContract = feeCfg.needsContract;
    const ready = !needsContract || bridge === 'besu'; // Besu can use existing transferToken; others need deployed bridge contracts.

    const steps = [
      ...(bridgeable ? bridgeable.steps : [{ action: 'hold', asset: 'source', chain: cfg.sourceChain }]),
      { action: 'bridge', input: bridgeIn, inputAsset: bridgeAsset, output: bridgeOut, outputAsset: bridgeAsset, chain: targetChain, provider: bridge },
    ];
    if (bridgeAsset !== targetAsset) {
      steps.push({ action: 'swap', input: bridgeOut, inputAsset: bridgeAsset, output: '?', outputAsset: targetAsset, chain: targetChain, provider: 'destination DEX' });
    }

    return {
      name: 'cross_chain_bridge',
      provider: bridge,
      steps,
      inputAmount: Number(amount),
      estimatedOutput: bridgeAsset === targetAsset ? bridgeOut : 0,
      outputAsset: targetAsset,
      outputChain: targetChain,
      fee: bridgeIn - bridgeOut,
      feeAsset: bridgeAsset,
      status: ready ? 'awaiting_bridge' : 'needs_bridge_contract',
      warning: needsContract ? `A ${bridge} bridge contract must be deployed/configured before this route is live.` : undefined,
    };
  }

  static async propose({
    sourceType,
    sourceAccountId,
    sourceToken,
    sourceModule,
    amount,
    targetAsset = 'USDC',
    targetChain = 'ethereum',
    bridgeProvider,
    recipient,
    routeName,
    createdBy,
    autoExecute = false,
  } = {}) {
    await this.ensureTables();
    if (!amount || Number(amount) <= 0) throw new Error('amount must be positive');
    const route = await this.quote({
      sourceType,
      sourceAccountId,
      sourceToken,
      sourceModule,
      amount,
      targetAsset,
      targetChain,
      bridgeProvider,
      recipient,
    });

    const chosenRoute = routeName
      ? route.routes.find(r => r.name === routeName)
      : route.routes.find(r => r.name === route.recommendation) || route.routes[0];
    if (!chosenRoute) throw new Error('No route available for the selected parameters');

    const requestId = id();
    const title = `Convert ${amount} ${sourceType || sourceToken || sourceModule} to ${targetAsset} on ${targetChain}`;
    const proposal = await canonicalConsensusEngine().createProposal({
      category: 'cross_chain',
      title,
      description: `Cross-chain conversion via ${chosenRoute.provider}. Recommended route: ${chosenRoute.name}.`,
      payload: {
        requestId,
        sourceType,
        sourceAccountId,
        sourceToken,
        sourceModule,
        amount,
        targetAsset,
        targetChain,
        bridgeProvider,
        recipient,
        routeName: chosenRoute.name,
        route: chosenRoute,
      },
      createdBy: createdBy || 'operator',
      autoExecute,
    });

    await query(
      `INSERT INTO cross_chain_requests (id, proposal_id, source_type, source_account, source_token, source_module, amount, target_asset, target_chain, bridge_provider, recipient, route, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [requestId, proposal.id, sourceType || null, sourceAccountId || null, sourceToken || null, sourceModule || null, String(amount), String(targetAsset).toUpperCase(), String(targetChain).toLowerCase(), bridgeProvider || null, recipient || null, safeJson(chosenRoute), 'pending', createdBy || 'operator']
    );

    return { requestId, proposalId: proposal.id, route, chosenRoute, proposal };
  }

  static async approve({ proposalId, role, approverEmail }) {
    return canonicalConsensusEngine().approveProposal({ proposalId, role, approverEmail });
  }

  static async listRequests({ status, limit = 50, offset = 0 } = {}) {
    await this.ensureTables();
    let sql = 'SELECT * FROM cross_chain_requests';
    const params = [];
    if (status) { sql += ' WHERE status = $1'; params.push(status); }
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));
    const res = await query(sql, params);
    return res.rows.map(r => ({
      ...r,
      route: typeof r.route === 'string' ? JSON.parse(r.route) : r.route,
      result: typeof r.result === 'string' ? JSON.parse(r.result) : r.result,
    }));
  }

  static async getRequest(requestId) {
    await this.ensureTables();
    const res = await query('SELECT * FROM cross_chain_requests WHERE id = $1', [requestId]);
    if (!res.rows.length) return null;
    const r = res.rows[0];
    return { ...r, route: typeof r.route === 'string' ? JSON.parse(r.route) : r.route, result: typeof r.result === 'string' ? JSON.parse(r.result) : r.result };
  }

  static async executeRequest(requestId) {
    const record = await this.getRequest(requestId);
    if (!record) throw new Error('Cross-chain request not found');
    const proposal = await canonicalConsensusEngine().getProposal(record.proposal_id);
    return canonicalConsensusEngine().executeProposal(proposal.id);
  }

  static async _execute(proposal) {
    const { payload } = proposal;
    const { routeName, requestId } = payload;
    try {
      let result;
      switch (routeName) {
        case 'same_chain_dex':
          result = await this._executeSameChainDex(payload);
          break;
        case 'p2p_order':
          result = await this._executeP2POrder(payload);
          break;
        case 'cross_chain_bridge':
          result = await this._executeCrossChainBridge(payload);
          break;
        default:
          throw new Error(`Unknown cross-chain route: ${routeName}`);
      }
      if (requestId) await this.updateStatus(requestId, 'executed', result);
      return result;
    } catch (err) {
      if (requestId) await this.updateStatus(requestId, 'failed', { error: err.message });
      throw err;
    }
  }

  static async _executeSameChainDex(payload) {
    const { sourceType, sourceAccountId, sourceToken, sourceModule, amount, targetAsset, recipient, route } = payload;
    if (!StablecoinDexEngine && !DexSwapEngine) throw new Error('No conversion engines available');

    if (sourceType) {
      if (!StablecoinDexEngine) throw new Error('StablecoinDexEngine not available');
      return await StablecoinDexEngine.depositAndSwap({
        sourceType,
        sourceAccountId,
        amount,
        targetAsset,
        recipient,
      });
    }

    if (sourceToken && sourceToken.toLowerCase() === 'dlb-ptcusd') {
      const token = process.env.DLB_PTCUSD_ADDRESS || sourceToken;
      return await this._dexSwapOrP2P(token, targetAsset, amount, recipient, route);
    }

    if (sourceToken) {
      return await this._dexSwapOrP2P(sourceToken, targetAsset, amount, recipient, route);
    }

    if (sourceModule) {
      if (!PtcStablecoinEngine) throw new Error('PtcStablecoinEngine not available');
      const moduleKey = this._normalizeModuleKey(sourceModule);
      const deposit = await PtcStablecoinEngine.approveAndDeposit({ moduleKey, amount, recipient: this.getConfig().operatorAddress });
      const token = process.env.DLB_PTCUSD_ADDRESS || '';
      const swap = await this._dexSwapOrP2P(token, targetAsset, this._formatUnits(deposit.mintedStablecoin, 18), recipient, route);
      return { deposit, swap };
    }

    throw new Error('No source specified');
  }

  static _formatUnits(raw, decimals) {
    if (!viem || !raw) return String(raw);
    try { return viem.formatUnits(BigInt(raw), decimals); } catch (e) { return String(raw); }
  }

  static async _dexSwapOrP2P(tokenIn, targetAsset, amount, recipient, route) {
    if (!DexSwapEngine) throw new Error('DexSwapEngine not available');
    const pool = route?.poolAddress || process.env.BOND_DEX_ADDRESS || '';
    try {
      return await DexSwapEngine.swapOnUniswapV2({
        tokenIn,
        tokenOut: this._targetAddress(targetAsset),
        amountIn: amount,
        recipient,
        decimalsIn: this._tokenDecimals(tokenIn),
        decimalsOut: this._targetDecimals(targetAsset),
      });
    } catch (e) {
      return await DexSwapEngine.swap({
        tokenIn,
        tokenOut: this._targetAddress(targetAsset),
        amountIn: amount,
        recipient,
        decimalsIn: this._tokenDecimals(tokenIn),
        decimalsOut: this._targetDecimals(targetAsset),
        router: pool,
      });
    }
  }

  static _tokenDecimals(tokenAddress) {
    if ((tokenAddress || '').toLowerCase() === (process.env.DLB_PTCUSD_ADDRESS || '').toLowerCase()) return 18;
    return 6;
  }

  static _p2pDisplayFromRaw(raw) {
    if (!raw || !viem) return '0';
    const b = typeof raw === 'bigint' ? raw : BigInt(raw);
    // ModuleP2PSwapEngine.createOrder hard-codes 6 decimals for both in/out.
    // formatUnits(raw, 6) gives the correct display string so parseUnits(..., 6) recovers the raw amount.
    return viem.formatUnits(b, 6);
  }

  static async _executeP2POrder(payload) {
    const { sourceType, sourceAccountId, sourceToken, sourceModule, amount, targetAsset, recipient } = payload;
    const target = recipient || this.getConfig().operatorAddress;
    const targetAddr = this._targetAddress(targetAsset) || process.env.DAPP_USDC_ADDRESS;
    if (!targetAddr) throw new Error(`Target asset ${targetAsset} has no configured address`);
    if (!viem) throw new Error('viem not available');

    let tokenIn = '';
    let rawIn = 0n;
    let displayIn = String(amount);

    if (sourceType) {
      if (!StablecoinDexEngine) throw new Error('StablecoinDexEngine not available');
      const mint = await StablecoinDexEngine.mintFromSource({ sourceType, sourceAccountId, amount, targetAddress: this.getConfig().operatorAddress });
      tokenIn = mint.tokenAddress;
      displayIn = String(mint.minted || amount);
      rawIn = viem.parseUnits(displayIn, 6);
    } else if (sourceToken && sourceToken.toLowerCase() === 'dlb-ptcusd') {
      tokenIn = process.env.DLB_PTCUSD_ADDRESS || '';
      rawIn = viem.parseUnits(String(amount), 18);
    } else if (sourceToken) {
      tokenIn = sourceToken;
      rawIn = viem.parseUnits(String(amount), 6);
    } else if (sourceModule) {
      if (!PtcStablecoinEngine) throw new Error('PtcStablecoinEngine not available');
      const moduleKey = this._normalizeModuleKey(sourceModule);
      const deposit = await PtcStablecoinEngine.approveAndDeposit({ moduleKey, amount, recipient: this.getConfig().operatorAddress });
      tokenIn = process.env.DLB_PTCUSD_ADDRESS || '';
      rawIn = BigInt(deposit?.mintedStablecoin || 0);
    }

    if (!tokenIn || rawIn <= 0n) throw new Error('Could not determine tokenIn for P2P order');

    if (!ModuleP2PSwapEngine) throw new Error('ModuleP2PSwapEngine not available');

    // ModuleP2PSwapEngine.createOrder reads token decimals from the token contracts
    // and parses display amounts, so pass plain display values to preserve precision.
    const displayOut = String(amount);

    return await ModuleP2PSwapEngine.createOrder({
      tokenIn,
      amountIn: displayIn,
      tokenOut: targetAddr,
      amountOut: displayOut,
      recipient: target,
    });
  }

  static async _executeCrossChainBridge(payload) {
    const { targetChain, bridgeProvider, amount, targetAsset, recipient, requestId } = payload;
    const bridge = bridgeProvider || this.getConfig().defaultBridge;
    if (bridge === 'besu' && HyperledgerBesuEngine) {
      const tokenAddr = this._targetAddress(targetAsset) || this.getConfig().usdcAddress;
      const result = await HyperledgerBesuEngine.transferToken({ tokenAddress: tokenAddr, to: recipient || this.getConfig().operatorAddress, amount, decimals: this._targetDecimals(targetAsset) });
      if (requestId) await this.updateStatus(requestId, 'executed', result);
      return result;
    }
    const result = {
      status: 'awaiting_bridge',
      bridge,
      targetChain,
      targetAsset,
      amount,
      recipient,
      note: 'Bridge contract must be deployed and configured before live execution.',
    };
    if (requestId) await this.updateStatus(requestId, 'awaiting_bridge', result);
    return result;
  }

  static async updateStatus(requestId, status, result) {
    await this.ensureTables();
    await query('UPDATE cross_chain_requests SET status=$1, result=$2, updated_at=NOW() WHERE id=$3', [status, safeJson(result || {}), requestId]);
  }
}

module.exports = { CrossChainConversionEngine };
