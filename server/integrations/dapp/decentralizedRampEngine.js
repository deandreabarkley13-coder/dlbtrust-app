'use strict';

/**
 * DecentralizedRampEngine
 *
 * Aggregates decentralized and counterparty on/off-ramp routes for the trust:
 *  - Cross-chain / same-chain DEX conversion (CrossChainConversionEngine)
 *  - P2P order-book markets (TrustMarketEngine, DlbCanonicalSwapEngine, ModuleP2PSwapEngine)
 *  - Fiat on/off-ramp providers (OnOffRampEngine: MoonPay, Circle Mint, Coinbase, Spritz)
 *  - Direct BondDex / StablecoinDex swaps where a pool exists
 *
 * It returns a unified quote, creates a Canonical Consensus proposal, and dispatches
 * execution to the underlying engine.
 */

const { getConfig } = require('./config');

function id(prefix = 'DRMP') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }

let engineCache = null;
function loadEngines() {
  if (engineCache) return engineCache;
  engineCache = {};
  const names = [
    'CrossChainConversionEngine',
    'OnOffRampEngine',
    'TrustMarketEngine',
    'DlbCanonicalSwapEngine',
    'StablecoinDexEngine',
    'DexSwapEngine',
    'ModuleP2PSwapEngine',
    'CanonicalConsensusEngine',
  ];
  for (const name of names) {
    try {
      const mod = require(`./${name.charAt(0).toLowerCase() + name.slice(1).replace(/([A-Z])/g, '-$1').toLowerCase().replace(/-engine/, 'Engine').replace(/-/g, '')}`);
      engineCache[name] = mod[name] || mod.default;
    } catch (e) {
      try {
        const kebab = name.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');
        const mod = require(`./${kebab.replace(/-engine$/, 'Engine').replace(/-/g, '')}`);
        engineCache[name] = mod[name] || mod.default;
      } catch (e2) {
        try {
          const camel = name.charAt(0).toLowerCase() + name.slice(1);
          const mod = require(`./${camel}`);
          engineCache[name] = mod[name] || mod.default;
        } catch (e3) {
          engineCache[name] = null;
        }
      }
    }
  }
  // fallback explicit filenames
  try { if (!engineCache.CrossChainConversionEngine) engineCache.CrossChainConversionEngine = require('./crossChainConversionEngine').CrossChainConversionEngine; } catch (e) {}
  try { if (!engineCache.OnOffRampEngine) engineCache.OnOffRampEngine = require('./onOffRampEngine').OnOffRampEngine; } catch (e) {}
  try { if (!engineCache.TrustMarketEngine) engineCache.TrustMarketEngine = require('./trustMarketEngine').TrustMarketEngine; } catch (e) {}
  try { if (!engineCache.DlbCanonicalSwapEngine) engineCache.DlbCanonicalSwapEngine = require('./dlbCanonicalSwapEngine').DlbCanonicalSwapEngine; } catch (e) {}
  try { if (!engineCache.StablecoinDexEngine) engineCache.StablecoinDexEngine = require('./stablecoinDexEngine').StablecoinDexEngine; } catch (e) {}
  try { if (!engineCache.DexSwapEngine) engineCache.DexSwapEngine = require('./dexSwapEngine').DexSwapEngine; } catch (e) {}
  try { if (!engineCache.ModuleP2PSwapEngine) engineCache.ModuleP2PSwapEngine = require('./moduleP2PSwapEngine').ModuleP2PSwapEngine; } catch (e) {}
  try { if (!engineCache.CanonicalConsensusEngine) engineCache.CanonicalConsensusEngine = require('./canonicalConsensusEngine').CanonicalConsensusEngine; } catch (e) {}
  return engineCache;
}

function canonicalConsensusEngine() { return loadEngines().CanonicalConsensusEngine; }

function resolveTokenAddress(asset, cfg) {
  const a = String(asset || '').toUpperCase().trim();
  if (!a) return '';
  if (a.startsWith('0X')) return a;
  switch (a) {
    case 'DLB-PTCUSD': return process.env.DLB_PTCUSD_ADDRESS || '0xb01e6280ffe6faac679a17b029df8e065e8d0002';
    case 'DLBUSD': return cfg.dlbusdAddress || process.env.DLBUSD_ADDRESS || '0x6ba8d02596a3b091a7246e38e3e078f770d33985';
    case 'DAI': return process.env.DAPP_DAI_ADDRESS || '0x6B175474E89094C44Da98b954EedeAC495271d0F';
    case 'USDC': return cfg.usdcAddress || process.env.DAPP_USDC_ADDRESS || '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    case 'USDS': return process.env.DAPP_USDS_ADDRESS || '0xdC035D45d973E3EC169d2276DDab16f1e407384F';
    case 'WETH':
    case 'ETH': return cfg.wethAddress || process.env.DAPP_WETH_ADDRESS || '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    case 'SIT': return process.env.SOVEREIGN_TOKEN_ADDRESS || '';
    default: return '';
  }
}

function normalizeAsset(asset) {
  return String(asset || '').toUpperCase().trim();
}

class DecentralizedRampEngine {
  static get config() { return getConfig(); }

  static async providers() {
    const { OnOffRampEngine, CrossChainConversionEngine, TrustMarketEngine, DlbCanonicalSwapEngine, StablecoinDexEngine, DexSwapEngine } = loadEngines();
    const providers = [];
    if (OnOffRampEngine) {
      try { providers.push(...(await OnOffRampEngine.providers())); } catch (e) {}
    }
    const decentralized = [
      { id: 'cross_chain', name: 'Cross-Chain Conversion (DEX + Bridge + P2P)', directions: ['exchange', 'crypto_to_crypto', 'reserve_to_canonical'], ready: !!CrossChainConversionEngine, issues: CrossChainConversionEngine ? [] : ['CrossChainConversionEngine not available'] },
      { id: 'trust_market', name: 'DLB Trust Market (1:1 P2P)', directions: ['exchange', 'crypto_to_crypto'], ready: !!TrustMarketEngine, issues: TrustMarketEngine ? [] : ['TrustMarketEngine not available'] },
      { id: 'p2p_canonical_swap', name: 'DLB Canonical P2P Swap', directions: ['exchange', 'crypto_to_crypto'], ready: !!DlbCanonicalSwapEngine, issues: DlbCanonicalSwapEngine ? [] : ['DlbCanonicalSwapEngine not available'] },
      { id: 'stablecoin_dex', name: 'Stablecoin DEX (DLBUSD -> canonical)', directions: ['exchange', 'crypto_to_crypto'], ready: !!StablecoinDexEngine, issues: StablecoinDexEngine ? [] : ['StablecoinDexEngine not available'] },
    ];
    // de-dupe by id
    const seen = new Set(providers.map(p => p.id));
    for (const p of decentralized) {
      if (!seen.has(p.id)) { providers.push(p); seen.add(p.id); }
    }
    return providers;
  }

  static async quote({
    direction = 'exchange',
    sourceAsset = '',
    targetAsset = '',
    amount = '0',
    sourceType = '',
    sourceAccountId = '',
    sourceModule = '',
    targetAddress = '',
    network = 'ethereum',
    bridgeProvider = '',
    slippageBps = 100,
  } = {}) {
    const cfg = this.config;
    const { CrossChainConversionEngine, OnOffRampEngine, TrustMarketEngine, DlbCanonicalSwapEngine, StablecoinDexEngine, DexSwapEngine } = loadEngines();
    const routes = [];
    const dir = String(direction).toLowerCase();
    const src = normalizeAsset(sourceAsset);
    const tgt = normalizeAsset(targetAsset);
    const amt = Number(amount) || 0;

    if (['onramp', 'fiat_to_crypto', 'offramp', 'crypto_to_fiat'].includes(dir)) {
      if (OnOffRampEngine) {
        try {
          const q = await OnOffRampEngine.quote({ direction, sourceAsset, targetAsset, amount, sourceType, sourceAccountId, targetAddress, network });
          (q.routes || []).forEach(r => routes.push({ ...r, engine: 'OnOffRampEngine', direction: dir }));
        } catch (e) {
          routes.push({ provider: 'fiat_ramp', name: 'Fiat On/Off Ramp', status: 'error', instructions: e.message, engine: 'OnOffRampEngine' });
        }
      }
    }

    if (['exchange', 'crypto_to_crypto', 'reserve_to_canonical'].includes(dir)) {
      if (CrossChainConversionEngine) {
        try {
          const q = await CrossChainConversionEngine.quote({
            sourceType,
            sourceAccountId,
            sourceToken: src || undefined,
            sourceModule,
            amount,
            targetAsset: tgt || 'USDC',
            targetChain: String(network).toLowerCase(),
            bridgeProvider,
            slippageBps,
          });
          if (q && q.routes) {
            q.routes.forEach(r => {
              routes.push({
                provider: r.provider || 'cross_chain',
                name: r.name || r.provider || 'Cross-Chain',
                direction: 'exchange',
                sourceAsset,
                targetAsset,
                amount,
                estimatedOutput: Number(r.estimatedOutput) || 0,
                outputAsset: r.outputAsset || targetAsset,
                fee: Number(r.fee) || 0,
                status: r.status || 'unknown',
                instructions: r.note || r.warning || r.instructions || '',
                quote: r,
                engine: 'CrossChainConversionEngine',
                needsApproval: r.needsApproval,
              });
            });
          }
        } catch (e) {
          routes.push({ provider: 'cross_chain', name: 'Cross-Chain Conversion', status: 'error', instructions: e.message, engine: 'CrossChainConversionEngine' });
        }
      }

      if (StablecoinDexEngine && src === 'DLBUSD') {
        try {
          const q = await StablecoinDexEngine.quote({ amount, targetAsset: tgt || 'USDC' });
          const out = Number(q.amountOut) || 0;
          routes.push({
            provider: 'stablecoin_dex',
            name: `Stablecoin DEX (DLBUSD -> ${tgt || 'USDC'})`,
            direction: 'exchange',
            sourceAsset,
            targetAsset,
            amount,
            estimatedOutput: out,
            status: out > 0 ? 'ready' : 'no_liquidity',
            instructions: out > 0 ? `Swap ${amount} DLBUSD for ~${out} ${tgt || 'USDC'}` : 'DLBUSD pool has no liquidity for this target.',
            quote: q,
            engine: 'StablecoinDexEngine',
          });
        } catch (e) {
          routes.push({ provider: 'stablecoin_dex', name: 'Stablecoin DEX', status: 'error', instructions: e.message, engine: 'StablecoinDexEngine' });
        }
      }

      if (TrustMarketEngine && ['DLB-PTCUSD', 'DLBUSD', 'SIT'].includes(src)) {
        try {
          const q = await TrustMarketEngine.quote({ trustToken: src, pairedAsset: tgt || 'USDC', amount, reserveModule: sourceModule });
          routes.push({
            provider: 'trust_market',
            name: 'DLB Trust Market (1:1 P2P)',
            direction: 'exchange',
            sourceAsset,
            targetAsset,
            amount,
            estimatedOutput: q.status === 'ready_to_list' ? amt : 0,
            status: q.status === 'ready_to_list' ? 'ready' : q.status,
            instructions: q.instructions || '',
            quote: q,
            engine: 'TrustMarketEngine',
          });
        } catch (e) {
          routes.push({ provider: 'trust_market', name: 'DLB Trust Market', status: 'error', instructions: e.message, engine: 'TrustMarketEngine' });
        }
      }

      if (DlbCanonicalSwapEngine) {
        const tokenIn = resolveTokenAddress(src, cfg);
        const tokenOut = resolveTokenAddress(tgt, cfg);
        if (tokenIn && tokenOut) {
          try {
            const q = await DlbCanonicalSwapEngine.quote({ tokenIn, amountIn: amount, tokenOut });
            routes.push({
              provider: 'p2p_canonical_swap',
              name: 'DLB P2P Canonical Swap (1:1)',
              direction: 'exchange',
              sourceAsset,
              targetAsset,
              amount,
              estimatedOutput: Number(q.amountOut) || 0,
              status: 'ready',
              instructions: q.note || `P2P swap ${amount} ${src} for ${q.amountOut} ${tgt}`,
              quote: q,
              engine: 'DlbCanonicalSwapEngine',
            });
          } catch (e) {
            routes.push({ provider: 'p2p_canonical_swap', name: 'DLB P2P Canonical Swap', status: 'error', instructions: e.message, engine: 'DlbCanonicalSwapEngine' });
          }
        }
      }

    }

    const readyStatuses = new Set(['ready', 'awaiting_buyer', 'awaiting_onramp', 'awaiting_funds', 'awaiting_bridge']);
    const ready = routes.filter(r => readyStatuses.has(r.status));
    const recommended = ready.sort((a, b) => (Number(b.estimatedOutput) || 0) - (Number(a.estimatedOutput) || 0))[0] || routes[0] || null;

    return {
      direction: dir,
      sourceAsset,
      targetAsset,
      amount,
      network,
      routes,
      recommended,
      quotedAt: new Date().toISOString(),
    };
  }

  static async propose({
    direction = 'exchange',
    sourceAsset = '',
    targetAsset = '',
    amount = '0',
    routeProvider = '',
    route: routeArg = null,
    sourceType = '',
    sourceAccountId = '',
    sourceModule = '',
    targetAddress = '',
    network = 'ethereum',
    bridgeProvider = '',
    slippageBps = 100,
    payload = {},
    createdBy = '',
  } = {}) {
    const CCE = canonicalConsensusEngine();
    if (!CCE) throw new Error('CanonicalConsensusEngine not available');

    let route = routeArg || payload.route || null;
    let provider = routeProvider || (route && (route.provider || route.name)) || '';
    if (!route || !provider) {
      const q = await this.quote({ direction, sourceAsset, targetAsset, amount, sourceType, sourceAccountId, sourceModule, targetAddress, network, bridgeProvider, slippageBps });
      if (!provider) {
        route = q.recommended;
      } else {
        const want = String(provider).toLowerCase();
        route = (q.routes || []).find(r =>
          (r.provider && String(r.provider).toLowerCase() === want) ||
          (r.name && String(r.name).toLowerCase() === want) ||
          (r.engine && String(r.engine).toLowerCase() === want)
        ) || q.recommended;
      }
      provider = route ? (route.provider || route.name || provider) : provider;
    }

    const title = `Decentralized ramp: ${direction} ${amount} ${sourceAsset || ''} -> ${targetAsset || ''}`;
    const description = `Route via ${provider || 'best provider'} for decentralized on/off ramp.`;
    const proposal = await CCE.createProposal({
      category: 'decentralized_ramp',
      title,
      description,
      payload: {
        direction,
        sourceAsset,
        targetAsset,
        amount,
        routeProvider: provider,
        route,
        sourceType,
        sourceAccountId,
        sourceModule,
        targetAddress,
        network,
        bridgeProvider,
        slippageBps,
        ...payload,
      },
      createdBy,
    });
    return { proposalId: proposal.id, status: proposal.status, route, proposal };
  }

  static async _execute(proposal) {
    const cfg = this.config;
    const { CrossChainConversionEngine, OnOffRampEngine, TrustMarketEngine, DlbCanonicalSwapEngine, StablecoinDexEngine, DexSwapEngine } = loadEngines();
    const p = proposal.payload || {};
    let { routeProvider, route } = p;
    const { direction, sourceAsset, targetAsset, amount, sourceType, sourceAccountId, sourceModule, targetAddress, network, bridgeProvider, slippageBps } = p;
    const provider = String(routeProvider || (route && (route.provider || route.name)) || '').toLowerCase();

    if (!provider) throw new Error('No route provider selected for decentralized ramp execution');

    const crossChainRouteNames = new Set(['same_chain_dex', 'p2p_order', 'cross_chain_bridge']);
    const isCrossChain = provider.includes('cross_chain') || provider.includes('moduletokenswap') || provider.includes('otc') || provider.includes('order book') || (route && crossChainRouteNames.has(route.name));
    if (isCrossChain) {
      if (!CrossChainConversionEngine) throw new Error('CrossChainConversionEngine not available');
      const routeName = route ? route.name : (provider.includes('p2p') || provider.includes('moduletokenswap') || provider.includes('otc') || provider.includes('order book') ? 'p2p_order' : (provider.includes('bridge') ? 'cross_chain_bridge' : 'same_chain_dex'));
      return CrossChainConversionEngine._execute({
        payload: {
          sourceType,
          sourceAccountId,
          sourceToken: sourceAsset,
          sourceModule,
          amount,
          targetAsset,
          recipient: targetAddress,
          targetChain: String(network || 'ethereum').toLowerCase(),
          bridgeProvider,
          slippageBps,
          route,
          routeName,
        },
      });
    }

    if (['moonpay', 'circle_mint', 'coinbase_treasury', 'coinbase_spot', 'spritz', 'fiat_ramp', 'on_off_ramp'].includes(provider)) {
      if (!OnOffRampEngine) throw new Error('OnOffRampEngine not available');
      return OnOffRampEngine._execute({ payload: { provider: routeProvider || provider, direction, sourceAsset, targetAsset, amount, sourceType, sourceAccountId, targetAddress, network, ...p } });
    }

    if (provider.includes('trust_market')) {
      if (!TrustMarketEngine) throw new Error('TrustMarketEngine not available');
      return TrustMarketEngine.createOffer({ trustToken: sourceAsset, pairedAsset: targetAsset, amount, reserveModule: sourceModule, recipient: targetAddress });
    }

    if (provider.includes('p2p_canonical') || provider.includes('canonical_swap')) {
      if (!DlbCanonicalSwapEngine) throw new Error('DlbCanonicalSwapEngine not available');
      const tokenIn = resolveTokenAddress(sourceAsset, cfg);
      const tokenOut = resolveTokenAddress(targetAsset, cfg);
      if (!tokenIn || !tokenOut) throw new Error(`Cannot resolve token addresses for ${sourceAsset} -> ${targetAsset}`);
      return DlbCanonicalSwapEngine.createOrder({ tokenIn, amountIn: amount, tokenOut, amountOut: amount, recipient: targetAddress });
    }

    if (provider.includes('stablecoin_dex')) {
      if (!StablecoinDexEngine) throw new Error('StablecoinDexEngine not available');
      if (sourceType) {
        return StablecoinDexEngine.depositAndSwap({ sourceType, sourceAccountId, amount, targetAsset, recipient: targetAddress });
      }
      return StablecoinDexEngine.swap({ amount, targetAsset, recipient: targetAddress });
    }

    throw new Error(`Decentralized ramp provider "${routeProvider}" is not implemented`);
  }
}

module.exports = { DecentralizedRampEngine };
