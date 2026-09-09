'use strict';

/**
 * On/Off Ramp Engine
 *
 * Production ramp aggregator that wires fiat, bank, and counterparty rails into
 * the trust's canonical stablecoin flow. It returns quotes, routes, and executes
 * through whichever configured provider is available.
 *
 * Supported flows:
 *  - On-ramp (fiat -> USDC/USDS/ETH): Coinbase Treasury Bridge, MoonPay, Circle Mint
 *  - Off-ramp (USDC/USDS/ETH -> fiat bank/card): Spritz (to the settlement bank), Coinbase sell+withdraw
 *  - Policy funding (ERP reserve -> USDC -> TrustDistributionPolicy): SpritzTreasuryLegEngine
 *  - Reserve conversion (DLB-PTCUSD/DLBUSD/DLB-PRB -> USDC/USDS): TrustMarketEngine P2P
 */

const { getConfig } = require('./config');
const { TrustMarketEngine } = require('./trustMarketEngine');
const { RampFeeEngine } = require('./rampFeeEngine');

let CoinbaseTreasuryBridge, CoinbaseSpotEngine, MoonPayEngine, SpritzEngine, SpritzTreasuryLegEngine, CircleMintClient;
try { ({ CoinbaseTreasuryBridge } = require('./coinbaseTreasuryBridge')); } catch (e) { }
try { ({ CoinbaseSpotEngine } = require('./coinbaseSpotEngine')); } catch (e) { }
try { ({ MoonPayEngine } = require('./moonPayEngine')); } catch (e) { }
try { ({ SpritzEngine } = require('../spritz/spritzEngine')); } catch (e) { }
try { ({ SpritzTreasuryLegEngine } = require('../spritz/spritzTreasuryLegEngine')); } catch (e) { }
try { CircleMintClient = require('../stablecoin/circleMintClient').CircleMintClient; } catch (e) { }

function id(prefix = 'RMP') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }

const SUPPORTED_DIRECTIONS = new Set([
  'onramp',
  'fiat_to_crypto',
  'offramp',
  'crypto_to_fiat',
  'exchange',
  'reserve_to_canonical',
  'crypto_to_crypto',
]);

function assertRampRequest(direction, amount) {
  if (!SUPPORTED_DIRECTIONS.has(String(direction))) {
    throw new Error(`unsupported ramp direction: ${direction}`);
  }
  const amountNum = Number(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) throw new Error('amount must be positive');
  return amountNum;
}

class OnOffRampEngine {
  static get config() { return getConfig(); }

  static async providers() {
    const cfg = this.config;
    const list = [];

    // Coinbase Treasury Bridge (fiat ledger -> crypto)
    if (CoinbaseTreasuryBridge) {
      const enabled = CoinbaseTreasuryBridge.enabled();
      list.push({ id: 'coinbase_treasury', name: 'Coinbase Treasury Bridge', directions: ['onramp'], ready: enabled, issues: enabled ? [] : ['Coinbase CDP API key not configured'] });
    }

    // MoonPay widget on-ramp
    if (MoonPayEngine) {
      const r = MoonPayEngine.readiness();
      list.push({ id: 'moonpay', name: 'MoonPay', directions: ['onramp'], ready: r.ready, issues: r.issues || [] });
    }

    // Circle Mint regulated fiat on-ramp
    const circleKey = process.env.CIRCLE_MINT_API_KEY || cfg.circleMintApiKey;
    list.push({ id: 'circle_mint', name: 'Circle Mint', directions: ['onramp'], ready: !!circleKey, issues: circleKey ? [] : ['CIRCLE_MINT_API_KEY not configured'] });

    // Spritz off-ramp
    if (SpritzEngine) {
      const spritzKey = process.env.SPRITZ_API_KEY || cfg.spritzApiKey;
      list.push({ id: 'spritz', name: 'Spritz Finance', directions: ['offramp'], ready: !!spritzKey, issues: spritzKey ? [] : ['SPRITZ_API_KEY not configured'] });
    } else {
      list.push({ id: 'spritz', name: 'Spritz Finance', directions: ['offramp'], ready: false, issues: ['SpritzEngine not available'] });
    }

    // Treasury-Core ERP reserve -> USDC -> TrustDistributionPolicy contract
    if (SpritzTreasuryLegEngine) {
      list.push({ id: 'erp_policy_funding', name: 'Treasury-Core ERP -> TrustDistributionPolicy', directions: ['reserve_to_canonical', 'exchange'], ready: true, issues: [] });
    }

    // Internal shadow rail. Always available, moves no value: it records the
    // ramp intent and books the fee so the propose/approve/execute lifecycle is
    // exercisable without any provider credentials or *_LIVE flag.
    list.push({ id: 'trust_shadow', name: 'Internal Shadow Rail (no value movement)', directions: ['onramp', 'offramp', 'exchange'], ready: true, issues: [] });

    // Trust internal P2P market
    if (TrustMarketEngine) {
      list.push({ id: 'trust_market', name: 'DLB Trust P2P Market', directions: ['onramp', 'offramp', 'exchange'], ready: true, issues: [] });
    }

    return list;
  }

  static async quote({ direction = 'exchange', sourceAsset = '', targetAsset = '', amount = '0', sourceType = '', sourceAccountId = '', targetAddress = '', network = 'ethereum' } = {}) {
    const cfg = this.config;
    const routes = [];
    assertRampRequest(direction, amount);

    // --- Fiat -> Crypto ---
    if (direction === 'onramp' || direction === 'fiat_to_crypto') {
      const amountNum = Number(amount);
      if (!amountNum || amountNum <= 0) throw new Error('amount must be positive');
      const target = (targetAsset || 'USDC').toUpperCase();
      const toAddress = targetAddress || cfg.operatorAddress;

      // Coinbase Treasury Bridge: reserve ledger -> USD -> Coinbase -> crypto
      if (CoinbaseTreasuryBridge) {
        const enabled = CoinbaseTreasuryBridge.enabled();
        const needs = [];
        if (!enabled) needs.push('Coinbase CDP API key not configured');
        if (!sourceAccountId) needs.push('sourceAccountId required to sweep ledger');
        routes.push({
          provider: 'coinbase_treasury',
          name: 'Coinbase Treasury Bridge',
          direction: 'onramp',
          sourceAsset,
          targetAsset: target,
          amount,
          targetAddress: toAddress,
          status: needs.length ? 'needs_config' : 'ready',
          instructions: needs.length
            ? `Fix: ${needs.join(', ')}`
            : `Will reserve ${amount} USD from ${sourceType}:${sourceAccountId}, stage a deposit to Coinbase, buy ${target}, and send to ${toAddress}.`,
          issues: needs,
        });
      }

      // MoonPay widget URL
      if (MoonPayEngine) {
        const r = MoonPayEngine.readiness();
        let url = '';
        try {
          if (r.ready) url = MoonPayEngine.buildUrl({ currencyCode: target.toLowerCase(), walletAddress: toAddress, amount: String(amountNum) });
        } catch (e) { /* ignored */ }
        routes.push({
          provider: 'moonpay',
          name: 'MoonPay',
          direction: 'onramp',
          sourceAsset,
          targetAsset: target,
          amount,
          targetAddress: toAddress,
          status: r.ready ? 'awaiting_onramp' : 'needs_config',
          onrampUrl: url,
          instructions: r.ready
            ? 'Complete the MoonPay widget to deposit the purchased crypto to the operator wallet.'
            : `Fix: ${(r.issues || []).join(', ')}`,
          issues: r.issues || [],
        });
      }

      // Circle Mint
      const circleKey = process.env.CIRCLE_MINT_API_KEY || cfg.circleMintApiKey;
      routes.push({
        provider: 'circle_mint',
        name: 'Circle Mint',
        direction: 'onramp',
        sourceAsset,
        targetAsset: target,
        amount,
        targetAddress: toAddress,
        status: circleKey ? 'ready' : 'needs_config',
        instructions: circleKey
          ? 'Circle Mint API is configured. Provide a verified wallet address ID to transfer minted USDC.'
          : 'Set CIRCLE_MINT_API_KEY and complete Circle Mint onboarding.',
        issues: circleKey ? [] : ['CIRCLE_MINT_API_KEY not configured'],
      });

    }

    // --- Crypto -> Fiat ---
    if (direction === 'offramp' || direction === 'crypto_to_fiat') {
      const asset = (sourceAsset || 'USDC').toUpperCase();
      const amountNum = Number(amount);
      if (!amountNum || amountNum <= 0) throw new Error('amount must be positive');

      if (SpritzEngine) {
        const spritzKey = process.env.SPRITZ_API_KEY || cfg.spritzApiKey;
        const bankAccounts = spritzKey ? await SpritzEngine.listBankAccounts().catch(() => []) : [];
        routes.push({
          provider: 'spritz',
          name: 'Spritz Finance Off-Ramp',
          direction: 'offramp',
          sourceAsset: asset,
          targetAsset: 'USD',
          amount,
          status: spritzKey ? (bankAccounts.length ? 'ready' : 'needs_bank_account') : 'needs_config',
          instructions: spritzKey
            ? (bankAccounts.length ? 'Spritz is ready. Provide accountId and rail to execute payout.' : 'Link a bank account in Spritz first.')
            : 'Set SPRITZ_API_KEY.',
          issues: spritzKey ? (bankAccounts.length ? [] : ['No linked Spritz bank account']) : ['SPRITZ_API_KEY not configured'],
        });
      }
    }

    // --- Reserve/Trust Token -> Canonical Stablecoin ---
    if (direction === 'exchange' || direction === 'reserve_to_canonical' || direction === 'crypto_to_crypto') {
      // ERP reserve -> USDC paid into the TrustDistributionPolicy contract
      if (SpritzTreasuryLegEngine) {
        const r = await SpritzTreasuryLegEngine.readiness().catch(e => ({ ready: false, issues: [e.message], policyContract: null }));
        routes.push({
          provider: 'erp_policy_funding',
          name: 'Treasury-Core ERP -> TrustDistributionPolicy',
          direction: 'reserve_to_canonical',
          sourceAsset: sourceAsset || (r.fundingSource && (r.fundingSource.sourceToken || r.fundingSource.sourceModule || r.fundingSource.sourceType)) || 'ERP',
          targetAsset: 'USDC',
          amount,
          targetAddress: r.policyContract || null,
          status: r.ready ? 'ready' : 'needs_config',
          instructions: r.ready
            ? 'Converts the ERP reserve to USDC under maker/checker consensus and pays it to the policy contract. No bank is debited.'
            : `Fix: ${(r.issues || []).join(', ')}`,
          issues: r.issues || [],
        });
      }
      if (TrustMarketEngine) {
        const q = await TrustMarketEngine.quote({ trustToken: sourceAsset || 'DLB-PTCUSD', pairedAsset: targetAsset || 'USDS', amount }).catch(e => ({ status: 'error', issues: [e.message] }));
        routes.push({
          provider: 'trust_market',
          name: 'DLB Trust P2P Market',
          direction: 'exchange',
          sourceAsset: sourceAsset || 'DLB-PTCUSD',
          targetAsset: targetAsset || 'USDS',
          amount,
          status: q.status === 'ready_to_list' ? 'ready' : q.status,
          quote: q,
          instructions: q.instructions,
          issues: q.issues || [],
        });
      }
    }

    // Internal shadow rail, offered for every direction so a ramp can always be
    // quoted, approved and booked without touching an external provider.
    routes.push({
      provider: 'trust_shadow',
      name: 'Internal Shadow Rail (no value movement)',
      direction,
      sourceAsset: sourceAsset || 'USD',
      targetAsset: targetAsset || 'USDC',
      amount,
      status: 'ready',
      instructions: 'Records the ramp and books the trust fee internally. No external transfer is initiated.',
      issues: [],
    });

    // Monetization: quote the configurable bps spread alongside the route. The
    // fee is only *booked* when the approved proposal executes.
    const fee = RampFeeEngine.quote({ amount, direction, asset: sourceAsset || 'USD' });
    for (const route of routes) route.fee = fee;

    // Pick the best ready route
    const best = routes.find(r => r.status === 'ready' || r.status === 'awaiting_onramp') || routes[0] || null;
    return { direction, sourceAsset, targetAsset, amount, routes, recommended: best, fee };
  }

  static async propose({ direction, sourceAsset, targetAsset, amount, provider, sourceType, sourceAccountId, targetAddress, network = 'ethereum', payload = {}, createdBy } = {}) {
    const { CanonicalConsensusEngine } = require('./canonicalConsensusEngine');
    if (!CanonicalConsensusEngine) throw new Error('CanonicalConsensusEngine not available');
    const title = `${direction}: ${amount} ${sourceAsset || 'USD'} -> ${targetAsset || 'USDC'}`;
    const proposal = await CanonicalConsensusEngine.createProposal({
      category: 'ramp',
      title,
      description: `On/Off ramp request via ${provider || 'best provider'}`,
      payload: {
        direction, sourceAsset, targetAsset, amount, provider, sourceType, sourceAccountId, targetAddress, network,
        // Carry the quoted fee through approval so the booked amount is the one
        // the approver saw.
        fee: RampFeeEngine.quote({ amount, direction, asset: sourceAsset || 'USD' }),
        ...payload,
      },
      createdBy,
    });
    return { proposalId: proposal.id, status: 'pending_approval', proposal, fee: proposal.payload ? proposal.payload.fee : undefined };
  }

  /**
   * Execute an approved ramp proposal and book the fee.
   *
   * The provider legs below stay bound by their own credentials/flags; nothing
   * here enables live value movement. Fee booking is an internal GL journal and
   * runs after the provider leg so a failed ramp is never charged.
   */
  static async _execute(proposal) {
    const outcome = await this._executeProvider(proposal);
    const p = proposal.payload || {};
    const fee = await RampFeeEngine.book({
      referenceType: 'ramp_fee',
      referenceId: proposal.id,
      amount: p.amount,
      feeBps: p.fee && p.fee.feeBps,
      direction: p.direction,
      asset: p.sourceAsset || 'USD',
      provider: p.provider,
      postedBy: proposal.created_by || proposal.createdBy || 'ramp-execution',
    });
    if (outcome && typeof outcome === 'object') return { ...outcome, fee };
    return { result: outcome, fee };
  }

  static async _executeProvider(proposal) {
    const p = proposal.payload || {};
    const { provider, direction } = p;

    if (provider === 'trust_shadow') {
      // A proposal can be created without going through quote(), so the shadow
      // rail validates its own request before recording anything.
      assertRampRequest(direction, p.amount);
      return {
        status: 'shadow_recorded',
        provider,
        direction,
        amount: p.amount,
        instructions: 'Shadow rail: the ramp and its fee are recorded internally; no external value moved.',
      };
    }

    if (direction === 'exchange' || (provider === 'trust_market' && direction !== 'onramp' && direction !== 'offramp')) {
      return TrustMarketEngine._execute({ payload: { action: 'create_offer', ...p } });
    }

    if (provider === 'coinbase_treasury') {
      if (!CoinbaseTreasuryBridge) throw new Error('CoinbaseTreasuryBridge not available');
      return CoinbaseTreasuryBridge.stageFromSource({
        sourceType: p.sourceType,
        sourceAccountId: p.sourceAccountId,
        amount: p.amount,
        targetAsset: p.targetAsset,
        targetNetwork: p.network || 'ethereum',
        targetAddress: p.targetAddress,
      });
    }

    if (provider === 'moonpay') {
      if (!MoonPayEngine) throw new Error('MoonPayEngine not available');
      const url = MoonPayEngine.buildUrl({
        currencyCode: (p.targetAsset || 'usdc').toLowerCase(),
        walletAddress: p.targetAddress || this.config.operatorAddress,
        amount: String(p.amount),
      });
      return { status: 'awaiting_onramp', onrampUrl: url, instructions: 'Complete the MoonPay widget to finish the deposit.' };
    }

    if (provider === 'circle_mint') {
      const cfg = this.config;
      const apiKey = process.env.CIRCLE_MINT_API_KEY || cfg.circleMintApiKey;
      if (!apiKey) throw new Error('CIRCLE_MINT_API_KEY not configured');
      if (!CircleMintClient) throw new Error('CircleMintClient not available');
      const client = new CircleMintClient({ apiKey, baseUrl: process.env.CIRCLE_MINT_BASE_URL });
      // Circle Mint on-ramp requires a verified wallet address; quote only here.
      return { status: 'needs_recipient_setup', instructions: 'Create a verified recipient address for the operator wallet in Circle Mint, then call execute.' };
    }

    if (provider === 'erp_policy_funding') {
      if (!SpritzTreasuryLegEngine) throw new Error('SpritzTreasuryLegEngine not available');
      return SpritzTreasuryLegEngine.fund({
        amountUsd: p.amount,
        sourceType: p.sourceType,
        sourceAccountId: p.sourceAccountId,
        sourceToken: p.sourceToken || p.sourceAsset,
        sourceModule: p.sourceModule,
        reference: p.reference || proposal.id,
        createdBy: proposal.created_by || proposal.createdBy,
      });
    }

    if (provider === 'spritz' && (direction === 'onramp' || direction === 'fiat_to_crypto')) {
      throw Object.assign(new Error('Spritz is the settlement (off-ramp) leg only; the policy contract is funded from the Treasury-Core ERP via SpritzTreasuryLegEngine.fund()'), { status: 409, code: 'SPRITZ_NOT_A_FUNDING_SOURCE' });
    }

    if (provider === 'spritz') {
      if (!SpritzEngine) throw new Error('SpritzEngine not available');
      const quote = await SpritzEngine.createOffRampQuote({
        accountId: p.accountId,
        amount: p.amount,
        chain: p.network || 'ethereum',
        tokenAddress: p.tokenAddress || p.sourceAsset,
        rail: p.rail || 'ach_standard',
        memo: p.memo,
      });
      return { status: 'awaiting_funds', spritzQuote: quote, instructions: 'Operator wallet must hold the source USDC; call Spritz executeQuote after quoting.' };
    }

    throw new Error(`Ramp provider ${provider} not implemented`);
  }
}

module.exports = { OnOffRampEngine };
