'use strict';

/**
 * Paired Asset Engine
 *
 * Sources the real canonical asset (USDS, USDC, DAI, WETH) needed to seed
 * a DEX pool alongside a trust-issued asset (DLBUSD / DLB-PTCUSD), then adds
 * liquidity through the Liquidity Pool Engine.
 */

const { query } = require('../bonds/pgPool');
const { getConfig } = require('./config');

let LiquidityPoolEngine, CanonicalConsensusEngine, CircleMintClient, CoinbaseTreasuryBridge, MoonPayEngine, StablecoinDexEngine, PtcStablecoinEngine, ModuleP2PSwapEngine;
try { ({ LiquidityPoolEngine } = require('./liquidityPoolEngine')); } catch (e) {}
try { ({ CanonicalConsensusEngine } = require('./canonicalConsensusEngine')); } catch (e) {}
try { CircleMintClient = require('../stablecoin/circleMintClient').CircleMintClient; } catch (e) {}
try { ({ CoinbaseTreasuryBridge } = require('./coinbaseTreasuryBridge')); } catch (e) {}
try { ({ MoonPayEngine } = require('./moonPayEngine')); } catch (e) {}
try { ({ StablecoinDexEngine } = require('./stablecoinDexEngine')); } catch (e) {}
try { ({ PtcStablecoinEngine } = require('./ptcStablecoinEngine')); } catch (e) {}
try { ({ ModuleP2PSwapEngine } = require('./moduleP2PSwapEngine')); } catch (e) {}

let viem;
try { viem = require('viem'); } catch (e) {}

function safeJson(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v); }
function id(prefix = 'PA') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }

const SOURCE_METHODS = {
  manual: { name: 'Manual deposit', note: 'Deposit the paired asset directly to the operator wallet.' },
  circle_mint: { name: 'Circle Mint on-ramp', note: 'Use a Circle Mint business account to mint/transfer USDC.' },
  coinbase_treasury: { name: 'Coinbase Treasury Bridge', note: 'Stage a fiat deposit from a trust ledger through Coinbase.' },
  moonpay: { name: 'MoonPay on-ramp', note: 'Generate a MoonPay widget URL to buy the paired asset into the operator wallet.' },
  counterparty: { name: 'Counterparty deposit', note: 'A buyer/counterparty sends the paired asset to the operator wallet.' },
  module_redemption: { name: 'DLB-PTCUSD reserve redemption', note: 'Redeem DLB-PTCUSD for reserve module tokens, then list them on the P2P order book for the paired asset.' },
};

class PairedAssetEngine {
  static get config() { return getConfig(); }

  static async ensureTables() {
    await query(`
      CREATE TABLE IF NOT EXISTS dapp_paired_asset_requests (
        id              TEXT PRIMARY KEY,
        proposal_id     TEXT,
        token_a         TEXT,
        token_b         TEXT,
        decimals_a      INTEGER DEFAULT 6,
        decimals_b      INTEGER DEFAULT 18,
        amount_a        TEXT,
        amount_b        TEXT,
        source_method   TEXT,
        source_account_id TEXT,
        pool_address    TEXT,
        create_pool     BOOLEAN DEFAULT FALSE,
        status          TEXT DEFAULT 'pending',
        result          JSONB DEFAULT '{}',
        created_by      TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_paired_asset_status ON dapp_paired_asset_requests(status)`);
  }

  static async _resolveToken(token) {
    const cfg = this.config;
    const t = String(token || '').toUpperCase();
    if (t === 'DLBUSD') {
      let address = process.env.DAPP_DLBUSD_ADDRESS || cfg.dlbusdAddress || '';
      if (!address && StablecoinDexEngine) {
        try { address = (await StablecoinDexEngine.getOrCreateDLBUSDToken())?.token_address || ''; } catch (e) {}
      }
      return { address, decimals: 6 };
    }
    if (t === 'DLB-PTCUSD') return { address: process.env.DLB_PTCUSD_ADDRESS || cfg.dlbPTCUSDAddress || '', decimals: 18 };
    if (t === 'USDS') return { address: cfg.usdsAddress || '', decimals: 18 };
    if (t === 'USDC') return { address: cfg.usdcAddress || '', decimals: 6 };
    if (t === 'DAI') return { address: cfg.daiAddress || '', decimals: 18 };
    if (t === 'WETH' || t === 'ETH') return { address: cfg.wethAddress || '', decimals: 18 };
    return { address: token, decimals: 18 };
  }

  static async _operatorBalance(tokenAddress) {
    if (!viem || !tokenAddress) return { raw: 0n, formatted: '0', decimals: 18 };
    const cfg = this.config;
    const { mainnet, sepolia } = require('viem/chains');
    const chain = cfg.chainId === 11155111 ? sepolia : mainnet;
    const publicClient = viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) });
    const decimals = await publicClient.readContract({
      address: tokenAddress,
      abi: [{ type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' }],
      functionName: 'decimals',
    }).catch(() => 18);
    const raw = await publicClient.readContract({
      address: tokenAddress,
      abi: [{ type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
      functionName: 'balanceOf',
      args: [cfg.operatorAddress],
    }).catch(() => 0n);
    return { raw, formatted: viem.formatUnits(raw, decimals), decimals };
  }

  static async sourceReadiness(method) {
    const cfg = this.config;
    const base = { method, ...SOURCE_METHODS[method], ready: false, issues: [] };
    if (method === 'manual' || method === 'counterparty') return { ...base, ready: true, note: 'Requires an external party to send the paired asset to the operator wallet.' };
    if (method === 'moonpay') {
      const r = MoonPayEngine ? MoonPayEngine.readiness() : { issues: ['MoonPayEngine not available'] };
      return { ...base, ready: r.ready, issues: r.issues };
    }
    if (method === 'circle_mint') {
      const ready = !!cfg.circleMintApiKey;
      return { ...base, ready, issues: ready ? [] : ['CIRCLE_MINT_API_KEY not configured'] };
    }
    if (method === 'coinbase_treasury') {
      const enabled = CoinbaseTreasuryBridge ? CoinbaseTreasuryBridge.enabled() : false;
      return { ...base, ready: enabled, issues: enabled ? [] : ['Coinbase Treasury Bridge not enabled (missing Coinbase credentials)'] };
    }
    if (method === 'module_redemption') {
      const ready = !!PtcStablecoinEngine && !!ModuleP2PSwapEngine;
      const issues = [];
      if (!PtcStablecoinEngine) issues.push('PtcStablecoinEngine not available');
      if (!ModuleP2PSwapEngine) issues.push('ModuleP2PSwapEngine not available');
      if (PtcStablecoinEngine) {
        try {
          const state = PtcStablecoinEngine.loadState ? PtcStablecoinEngine.loadState() : {};
          if (!state.vaultAddress) issues.push('PTC reserve vault not deployed');
        } catch (e) {}
      }
      return { ...base, ready: ready && issues.length === 0, issues };
    }
    return { ...base, issues: ['Unknown source method'] };
  }

  static async quote({ tokenA = 'DLBUSD', tokenB = 'USDS', amountA = '0', sourceMethod = 'manual' } = {}) {
    const a = await this._resolveToken(tokenA);
    const b = await this._resolveToken(tokenB);
    const amountB = Number(amountA); // 1:1 pricing for seeding
    const balB = await this._operatorBalance(b.address);
    const source = await this.sourceReadiness(sourceMethod);
    const poolInfo = b.address ? await this._findExistingPool(a.address, b.address).catch(() => null) : null;
    const enough = balB.raw >= viem.parseUnits(String(amountB), b.decimals);
    let status = 'pending_funds';
    if (enough && source.ready) status = 'ready_to_seed';
    else if (source.ready && !enough) status = 'awaiting_deposit';
    return {
      tokenA,
      tokenB,
      tokenAAddress: a.address,
      tokenBAddress: b.address,
      decimalsA: a.decimals,
      decimalsB: b.decimals,
      amountA,
      amountB,
      operatorBalanceB: balB.formatted,
      existingPool: poolInfo ? poolInfo.poolAddress : null,
      source,
      status,
      note: status === 'ready_to_seed'
        ? `Operator wallet has ${balB.formatted} ${tokenB} and source is ready; liquidity can be added now.`
        : `Need ${amountB} ${tokenB} in operator wallet before seeding. Source readiness: ${source.ready ? 'ready' : 'not ready'}.`,
    };
  }

  static async _findExistingPool(tokenA, tokenB) {
    if (!LiquidityPoolEngine) return null;
    const pools = await LiquidityPoolEngine.listPools();
    const match = pools.find(p =>
      (p.token0?.toLowerCase() === tokenA.toLowerCase() && p.token1?.toLowerCase() === tokenB.toLowerCase()) ||
      (p.token1?.toLowerCase() === tokenA.toLowerCase() && p.token0?.toLowerCase() === tokenB.toLowerCase())
    );
    return match || null;
  }

  static async propose({ tokenA = 'DLBUSD', tokenB = 'USDS', amountA, amountB, sourceMethod = 'manual', sourceAccountId, createPool = false, createdBy } = {}) {
    await this.ensureTables();
    const amountBOut = amountB || amountA;
    const a = await this._resolveToken(tokenA);
    const b = await this._resolveToken(tokenB);
    const requestId = id();
    const title = `Seed ${tokenA}/${tokenB} pool with ${amountA} ${tokenA} + ${amountBOut} ${tokenB}`;
    const payload = { requestId, tokenA, tokenB, amountA, amountB: amountBOut, sourceMethod, sourceAccountId, createPool };
    const proposal = await canonicalConsensus().createProposal({
      category: 'paired_asset',
      title,
      description: `Source ${amountBOut} ${tokenB} via ${sourceMethod} and add liquidity alongside ${amountA} ${tokenA}.`,
      payload,
      createdBy: createdBy || 'operator',
    });

    await query(
      `INSERT INTO dapp_paired_asset_requests (id, proposal_id, token_a, token_b, decimals_a, decimals_b, amount_a, amount_b, source_method, source_account_id, create_pool, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [requestId, proposal.id, tokenA, tokenB, a.decimals, b.decimals, String(amountA), String(amountBOut), sourceMethod, sourceAccountId || null, !!createPool, createdBy || 'operator']
    );

    return { requestId, proposalId: proposal.id, quote: await this.quote({ tokenA, tokenB, amountA, sourceMethod }) };
  }

  static async approve({ proposalId, role, approverEmail }) {
    return canonicalConsensus().approveProposal({ proposalId, role, approverEmail });
  }

  static async executeRequest(requestId) {
    const record = await this.getRequest(requestId);
    if (!record) throw new Error('Paired asset request not found');
    const proposal = await canonicalConsensus().getProposal(record.proposal_id);
    return canonicalConsensus().executeProposal(proposal.id);
  }

  static async _execute(proposal) {
    const { payload } = proposal;
    const { requestId, tokenA, tokenB, amountA, amountB, sourceMethod, sourceAccountId, createPool } = payload;
    try {
      const result = await this._seedPool({ requestId, tokenA, tokenB, amountA, amountB, sourceMethod, sourceAccountId, createPool });
      if (requestId) await this.updateStatus(requestId, result.status || 'executed', result);
      return result;
    } catch (err) {
      if (requestId) await this.updateStatus(requestId, 'failed', { error: err.message });
      throw err;
    }
  }

  static async _seedPool({ requestId, tokenA, tokenB, amountA, amountB, sourceMethod, sourceAccountId, createPool }) {
    const a = await this._resolveToken(tokenA);
    const b = await this._resolveToken(tokenB);
    const balB = await this._operatorBalance(b.address);
    const needRaw = viem.parseUnits(String(amountB || amountA), b.decimals);
    const depositResult = await this._fundPairedAsset({ method: sourceMethod, amount: amountB || amountA, token: b, sourceAccountId, balB, needRaw });

    if (depositResult.status !== 'ready') {
      return { status: depositResult.status, ...depositResult, requestId };
    }

    const pool = await this._findExistingPool(a.address, b.address);
    let poolResult;
    if (pool && pool.pool_address) {
      poolResult = await LiquidityPoolEngine.addLiquidity({
        poolAddress: pool.pool_address,
        tokenA: a.address,
        tokenB: b.address,
        amountA,
        amountB: amountB || amountA,
        decimalsA: a.decimals,
        decimalsB: b.decimals,
      });
    } else if (createPool) {
      poolResult = await LiquidityPoolEngine.createPool({
        tokenA: a.address,
        tokenB: b.address,
        amountA,
        amountB: amountB || amountA,
        decimalsA: a.decimals,
        decimalsB: b.decimals,
      });
    } else {
      return {
        status: 'no_pool',
        requestId,
        note: `No existing ${tokenA}/${tokenB} pool found. Set createPool=true or deploy a pool first.`,
        depositResult,
      };
    }

    return { status: 'executed', requestId, depositResult, poolResult };
  }

  static async _fundPairedAsset({ method, amount, token, sourceAccountId, balB, needRaw }) {
    const cfg = this.config;
    if (balB.raw >= needRaw) {
      return { status: 'ready', source: 'operator_wallet', balance: balB.formatted };
    }
    if (method === 'manual' || method === 'counterparty') {
      return {
        status: 'awaiting_deposit',
        depositAddress: cfg.operatorAddress,
        amountNeeded: amount,
        asset: token,
        instructions: `Send ${amount} of the paired asset to operator wallet ${cfg.operatorAddress}.`,
      };
    }
    if (method === 'moonpay') {
      const url = MoonPayEngine ? MoonPayEngine.buildUrl({ currencyCode: 'usdc', walletAddress: cfg.operatorAddress, amount }) : '';
      return { status: 'awaiting_onramp', onrampUrl: url, instructions: 'Complete the MoonPay on-ramp to fund the operator wallet.' };
    }
    if (method === 'circle_mint') {
      const apiKey = process.env.CIRCLE_MINT_API_KEY || cfg.circleMintApiKey;
      if (!apiKey) return { status: 'needs_config', issues: ['CIRCLE_MINT_API_KEY not configured'] };
      const client = new CircleMintClient({ apiKey, baseUrl: process.env.CIRCLE_MINT_BASE_URL });
      try {
        const balances = await client.getBalances();
        const available = balances?.data?.find(b => b.currency === 'USDC' || b.currency === 'USD');
        if (!available || Number(available.availableAmount) < Number(amount)) {
          return { status: 'needs_deposit', issues: ['Circle Mint balance insufficient or missing'], instructions: 'Wire USD to the Circle Mint account to mint USDC, then retry.' };
        }
        // Creating a blockchain transfer from Circle Mint requires a verified recipient address ID first.
        return { status: 'needs_recipient_setup', source: 'circle_mint', balance: available.availableAmount, instructions: `Create a verified recipient address for ${cfg.operatorAddress} in Circle Mint, then retry the transfer.` };
      } catch (e) {
        return { status: 'needs_config', issues: [e.message] };
      }
    }
    if (method === 'coinbase_treasury') {
      if (!CoinbaseTreasuryBridge) return { status: 'needs_config', issues: ['CoinbaseTreasuryBridge not available'] };
      if (!sourceAccountId) return { status: 'needs_source_account', issues: ['sourceAccountId required for coinbase_treasury'] };
      const transfer = await CoinbaseTreasuryBridge.stageFromSource({
        sourceType: 'cash',
        sourceAccountId,
        amount,
        targetAsset: 'USDC',
        targetNetwork: 'ethereum',
        targetAddress: cfg.operatorAddress,
      });
      return { status: transfer.status || 'pending', source: 'coinbase_treasury', transfer };
    }
    if (method === 'module_redemption') {
      if (!PtcStablecoinEngine || !ModuleP2PSwapEngine) return { status: 'needs_config', issues: ['PtcStablecoinEngine or ModuleP2PSwapEngine not available'] };
      const moduleKey = sourceAccountId || 'bond_portfolio';
      let reserve;
      try { reserve = await PtcStablecoinEngine._getModuleToken(moduleKey); } catch (e) { return { status: 'needs_config', issues: [`Reserve module ${moduleKey} not tokenized: ${e.message}`] }; }
      const existingOrders = await ModuleP2PSwapEngine.listOrders({ maker: cfg.operatorAddress, activeOnly: true });
      const active = existingOrders.find(o =>
        o.tokenIn.toLowerCase() === reserve.address.toLowerCase() &&
        o.tokenOut.toLowerCase() === token.address.toLowerCase() &&
        Number(o.amountOut) >= Number(amount)
      );
      if (active) return { status: 'awaiting_buyer', source: 'module_redemption', instructions: 'An existing P2P sell order is already active for this reserve/paired asset.', p2pOrderId: active.orderId, reserveRedemption: active };
      const ptcBalance = await PtcStablecoinEngine.balanceOf(cfg.operatorAddress);
      if (Number(ptcBalance) < Number(amount)) return { status: 'insufficient_dlb_ptcusd', source: 'module_redemption', balance: ptcBalance, needed: amount };
      const redeemResult = await PtcStablecoinEngine.redeem({ moduleKey, amount: String(amount), recipient: cfg.operatorAddress });
      const reserveRaw = BigInt(redeemResult.reserveAmount || 0);
      const displayIn = viem.formatUnits(reserveRaw, 6); // P2P engine hard-codes 6 decimal parse
      const displayOut = viem.formatUnits(needRaw, 6);
      const p2pOrder = await ModuleP2PSwapEngine.createOrder({ tokenIn: reserve.address, amountIn: displayIn, tokenOut: token.address, amountOut: displayOut, recipient: cfg.operatorAddress });
      return { status: 'awaiting_buyer', source: 'module_redemption', instructions: `Redeemed ${amount} DLB-PTCUSD for ${moduleKey} and listed on P2P order book. Buyer must fill order to provide ${amount} ${token.symbol || ''} to operator wallet.`, reserveRedemption: redeemResult, p2pOrderId: p2pOrder.orderId, orderTxHash: p2pOrder.txHash };
    }
    return { status: 'unknown_method', issues: [`Unknown source method: ${method}`] };
  }

  static async listRequests({ status, limit = 50, offset = 0 } = {}) {
    await this.ensureTables();
    let sql = 'SELECT * FROM dapp_paired_asset_requests';
    const params = [];
    if (status) { sql += ' WHERE status = $1'; params.push(status); }
    sql += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(Number(limit), Number(offset));
    const res = await query(sql, params);
    return res.rows.map(r => ({ ...r, result: typeof r.result === 'string' ? JSON.parse(r.result) : r.result }));
  }

  static async getRequest(requestId) {
    await this.ensureTables();
    const res = await query('SELECT * FROM dapp_paired_asset_requests WHERE id = $1', [requestId]);
    if (!res.rows.length) return null;
    const r = res.rows[0];
    return { ...r, result: typeof r.result === 'string' ? JSON.parse(r.result) : r.result };
  }

  static async updateStatus(requestId, status, result) {
    await query('UPDATE dapp_paired_asset_requests SET status=$1, result=$2, updated_at=NOW() WHERE id=$3', [status, safeJson(result || {}), requestId]);
  }

  static async listSources() {
    const sources = await Promise.all(Object.keys(SOURCE_METHODS).map(m => this.sourceReadiness(m)));
    return sources;
  }
}

function canonicalConsensus() {
  if (!CanonicalConsensusEngine) throw new Error('CanonicalConsensusEngine not available');
  return CanonicalConsensusEngine;
}

module.exports = { PairedAssetEngine };
