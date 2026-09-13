/**
 * AMM OS Engine
 *
 * Automated liquidity management for the DLB-PTCUSD / canonical-stablecoin
 * StableSwap pool (contracts/StableAmmPool.sol):
 *
 *   ensurePool   find the pool (env, Postgres) or deploy + seed it, and register
 *                it with InternalMarketMakerEngine so LP positions accrue yield
 *   monitor      pool price of DLB-PTCUSD in canonical, compared with the $1 peg
 *   rebalance    when the price leaves the band (AMM_OS_PEG_BAND_BPS, 100 bps)
 *                swap the operator's surplus side into the pool — canonical in
 *                when DLB-PTCUSD trades rich, DLB-PTCUSD in when it trades cheap —
 *                sized to bring reserves back to parity, capped per cycle
 *
 * Every write is shadow unless AMM_OS_SHADOW=false, DAPP_SHADOW is not live and
 * (with the thirdweb signer) THIRDWEB_SERVER_WALLET_LIVE=true. The StableSwap
 * math is mirrored here so quotes and rebalance sizing work without a chain.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getConfig } = require('./config');
const { ThirdwebChainSigner } = require('./thirdwebChainSigner');
const { ThirdwebServerWalletEngine } = require('./thirdwebServerWalletEngine');

let viem = null;
try { viem = require('viem'); } catch (e) { /* optional */ }
let allChains = null;
try { allChains = require('viem/chains'); } catch (e) { /* optional */ }
let privateKeyToAccount = null;
try { ({ privateKeyToAccount } = require('viem/accounts')); } catch (e) { /* optional */ }

let query = null;
try { const pgPool = require('../bonds/pgPool'); query = (...args) => pgPool.query(...args); } catch (e) { /* optional */ }

let PtcStablecoinEngine = null;
try { ({ PtcStablecoinEngine } = require('./ptcStablecoinEngine')); } catch (e) { /* optional */ }
let InternalMarketMakerEngine = null;
try { ({ InternalMarketMakerEngine } = require('./internalMarketMakerEngine')); } catch (e) { /* optional */ }

const N_COINS = 2n;
const PRECISION = 10n ** 18n;
const FEE_DENOMINATOR = 10_000n;
const TRUST_TOKEN_DECIMALS = 18;
const CANONICAL_DECIMALS = { USDC: 6, USDS: 18, DAI: 18 };

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address', name: 'account' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'allowance', inputs: [{ type: 'address', name: 'owner' }, { type: 'address', name: 'spender' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'approve', inputs: [{ type: 'address', name: 'spender' }, { type: 'uint256', name: 'amount' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
];

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function num(name, def) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : def; }
function bool(name, def = false) { const v = process.env[name]; return v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(v); }
function isAddress(v) { return /^0x[0-9a-fA-F]{40}$/.test(String(v || '')); }
function newId(prefix = 'AMMO') { return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }
function safeJson(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v); }
function abs(a) { return a < 0n ? -a : a; }
function round6(n) { return Math.round((Number(n) || 0) * 1e6) / 1e6; }

function getArtifact() {
  const abiPath = path.join(process.cwd(), 'artifacts', 'contracts_StableAmmPool_sol_StableAmmPool.abi');
  const binPath = path.join(process.cwd(), 'artifacts', 'contracts_StableAmmPool_sol_StableAmmPool.bin');
  if (!fs.existsSync(abiPath)) throw new Error('StableAmmPool artifact not found; run scripts/compileOsEngines.cjs');
  return { abi: JSON.parse(fs.readFileSync(abiPath, 'utf8')), bytecode: '0x' + fs.readFileSync(binPath, 'utf8').trim().replace(/^0x/, '') };
}

function chainById(id) {
  if (!allChains) return undefined;
  return Object.values(allChains).find((c) => c && typeof c === 'object' && Number(c.id) === Number(id)) || allChains.mainnet;
}

function operatorAddress(cfg) {
  if (ThirdwebChainSigner.active()) return ThirdwebChainSigner.address() || cfg.operatorAddress;
  return cfg.operatorAddress;
}

function clients(cfg) {
  if (ThirdwebChainSigner.active()) return ThirdwebChainSigner.clients({ chainId: cfg.chainId });
  if (!viem) throw new Error('viem not installed');
  if (!cfg.privateKey) throw new Error('DAPP_PRIVATE_KEY not configured');
  const account = privateKeyToAccount(cfg.privateKey.startsWith('0x') ? cfg.privateKey : `0x${cfg.privateKey}`);
  const chain = chainById(cfg.chainId);
  const fees = { maxFeePerGas: viem.parseGwei('20'), maxPriorityFeePerGas: viem.parseGwei('0.5') };
  const publicClient = viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) });
  const walletClient = viem.createWalletClient({ account, chain, transport: viem.http(cfg.rpcUrl) });
  return { account, publicClient, walletClient, fees };
}

// ─── StableSwap math (mirrors StableAmmPool.sol) ────────────────────────────

const StableSwapMath = {
  /** Invariant D for normalised (18-decimal) balances. */
  getD(xp, A) {
    const S = xp[0] + xp[1];
    if (S === 0n) return 0n;
    let D = S;
    const Ann = BigInt(A) * N_COINS;
    for (let i = 0; i < 255; i++) {
      let D_P = D;
      for (const x of xp) D_P = (D_P * D) / (x * N_COINS + 1n);
      const Dprev = D;
      D = ((Ann * S + D_P * N_COINS) * D) / ((Ann - 1n) * D + (N_COINS + 1n) * D_P);
      if (abs(D - Dprev) <= 1n) return D;
    }
    throw new Error('StableSwap: D did not converge');
  },

  /** New balance of coin j after coin i moves to x, holding D. */
  getY(i, j, x, xp, A, D = null) {
    const Ann = BigInt(A) * N_COINS;
    const _D = D === null ? this.getD(xp, A) : D;
    let c = _D;
    let S_ = 0n;
    for (let k = 0; k < 2; k++) {
      let _x;
      if (k === i) _x = x;
      else if (k !== j) _x = xp[k];
      else continue;
      S_ += _x;
      c = (c * _D) / (_x * N_COINS);
    }
    c = (c * _D) / (Ann * N_COINS);
    const b = S_ + _D / Ann;
    let y = _D;
    for (let n = 0; n < 255; n++) {
      const yPrev = y;
      y = (y * y + c) / (2n * y + b - _D);
      if (abs(y - yPrev) <= 1n) return y;
    }
    throw new Error('StableSwap: y did not converge');
  },

  /**
   * Quote a swap on raw reserves. `rates` scale each token to 18 decimals.
   * Returns amountOut/fee in tokenOut native units plus the post-trade price.
   */
  quote({ reserves, rates, A, feeBps, i, amountIn }) {
    const j = i === 0 ? 1 : 0;
    const xp = [reserves[0] * rates[0], reserves[1] * rates[1]];
    if (xp[0] === 0n || xp[1] === 0n) throw new Error('StableSwap: no liquidity');
    const D = this.getD(xp, A);
    const x = xp[i] + BigInt(amountIn) * rates[i];
    const y = this.getY(i, j, x, xp, A, D);
    const dy = xp[j] - y - 1n;
    const dyFee = (dy * BigInt(feeBps)) / FEE_DENOMINATOR;
    const amountOut = (dy - dyFee) / rates[j];
    const fee = dyFee / rates[j];
    const after = [...reserves];
    after[i] += BigInt(amountIn);
    after[j] -= amountOut;
    return { amountOut, fee, priceAfter: this.price({ reserves: after, rates, A }), D };
  },

  /** Marginal price of token0 in token1 (1e18 = parity), probe D / 10_000. */
  price({ reserves, rates, A }) {
    const xp = [reserves[0] * rates[0], reserves[1] * rates[1]];
    const D = this.getD(xp, A);
    if (D === 0n || xp[0] === 0n || xp[1] === 0n) return 0n;
    let dx = D / 10_000n;
    if (dx === 0n) dx = 1n;
    const y = this.getY(0, 1, xp[0] + dx, xp, A, D);
    const dy = xp[1] - y - 1n;
    return (dy * PRECISION) / dx;
  },

  /**
   * Amount of token `i` (native units) to swap in so both normalised reserves
   * meet at their mean. Constant-sum approximation, which is what the pool
   * behaves like near the peg; the caller clamps to its per-cycle cap.
   */
  rebalanceAmountIn({ reserves, rates, i }) {
    const xp = [reserves[0] * rates[0], reserves[1] * rates[1]];
    const j = i === 0 ? 1 : 0;
    if (xp[i] >= xp[j]) return 0n;
    return ((xp[j] - xp[i]) / 2n) / rates[i];
  },
};

let tablesReady = false;
async function ensureTables() {
  if (tablesReady || !query) return;
  await query(`
    CREATE TABLE IF NOT EXISTS amm_os_pools (
      id                 TEXT PRIMARY KEY,
      chain_id           INTEGER NOT NULL,
      pool_address       TEXT NOT NULL UNIQUE,
      token0             TEXT NOT NULL,
      token1             TEXT NOT NULL,
      trust_token        TEXT NOT NULL,
      canonical_token    TEXT NOT NULL,
      canonical_asset    TEXT NOT NULL,
      canonical_decimals INTEGER NOT NULL,
      amplification      INTEGER NOT NULL,
      fee_bps            INTEGER NOT NULL,
      mode               TEXT NOT NULL,
      deploy_tx          TEXT,
      metadata           JSONB DEFAULT '{}',
      created_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS amm_os_actions (
      id            TEXT PRIMARY KEY,
      pool_address  TEXT,
      kind          TEXT NOT NULL,
      mode          TEXT NOT NULL,
      status        TEXT NOT NULL,
      price_before  NUMERIC(20,8),
      price_after   NUMERIC(20,8),
      deviation_bps INTEGER,
      token_in      TEXT,
      amount_in     TEXT,
      amount_out    TEXT,
      tx_hash       TEXT,
      detail        JSONB DEFAULT '{}',
      error         TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query('CREATE INDEX IF NOT EXISTS amm_os_actions_pool_idx ON amm_os_actions(pool_address, created_at DESC)');
  tablesReady = true;
}

class AmmOsEngine {
  static getConfig() {
    const cfg = getConfig();
    const wallet = ThirdwebServerWalletEngine.getConfig();
    const signerActive = ThirdwebChainSigner.active();
    const shadow = bool('AMM_OS_SHADOW', true) || cfg.dappShadow === true || (signerActive && !wallet.live);
    const canonicalAsset = str('AMM_OS_CANONICAL_ASSET', 'USDC').toUpperCase();
    const canonicalAddress = { USDC: cfg.usdcAddress, USDS: cfg.usdsAddress, DAI: cfg.daiAddress }[canonicalAsset] || '';
    return {
      enabled: bool('AMM_OS_ENABLED', true),
      shadow,
      signer: signerActive ? 'thirdweb' : 'private-key',
      walletLive: wallet.live,
      chainId: Number(cfg.chainId),
      rpcUrl: cfg.rpcUrl,
      privateKey: cfg.privateKey,
      operatorAddress: operatorAddress(cfg) || '',
      canonicalAsset,
      canonicalAddress,
      canonicalDecimals: num('AMM_OS_CANONICAL_DECIMALS', CANONICAL_DECIMALS[canonicalAsset] || 18),
      poolAddress: str('AMM_OS_POOL_ADDRESS'),
      pegBandBps: Math.max(1, num('AMM_OS_PEG_BAND_BPS', 100)),
      amplification: Math.max(1, num('AMM_OS_AMPLIFICATION', 200)),
      feeBps: Math.min(100, Math.max(0, num('AMM_OS_FEE_BPS', 4))),
      seedUsd: Math.max(0, num('AMM_OS_SEED_USD', 100)),
      maxRebalanceUsd: Math.max(0, num('AMM_OS_MAX_REBALANCE_USD', 1000)),
      slippageBps: Math.max(0, num('AMM_OS_SLIPPAGE_BPS', 50)),
    };
  }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.enabled) issues.push('AMM_OS_ENABLED is not true');
    if (!PtcStablecoinEngine) issues.push('PtcStablecoinEngine not available');
    else if (!PtcStablecoinEngine.state().tokenAddress) issues.push('PTC stablecoin not deployed');
    if (!cfg.canonicalAddress) issues.push(`canonical ${cfg.canonicalAsset} address not configured`);
    try { getArtifact(); } catch (e) { issues.push(e.message); }
    if (!cfg.shadow) {
      if (cfg.signer === 'thirdweb') issues.push(...ThirdwebChainSigner.readiness().issues);
      else if (!cfg.privateKey) issues.push('DAPP_PRIVATE_KEY not configured');
      if (!cfg.rpcUrl) issues.push('DAPP_RPC_URL not configured');
      if (!cfg.operatorAddress) issues.push('operator address unknown (DAPP_OPERATOR_ADDRESS or THIRDWEB_SERVER_WALLET_ADDRESS)');
    }
    return {
      provider: 'amm-os',
      ready: issues.length === 0,
      mode: cfg.shadow ? 'shadow' : 'live',
      enabled: cfg.enabled,
      signer: cfg.signer,
      walletLive: cfg.walletLive,
      chainId: cfg.chainId,
      canonicalAsset: cfg.canonicalAsset,
      pegBandBps: cfg.pegBandBps,
      issues,
    };
  }

  // ─── Pool discovery / deployment ─────────────────────────────────────────

  static _tokens(cfg) {
    const trust = PtcStablecoinEngine ? PtcStablecoinEngine.state().tokenAddress : null;
    if (!trust) throw new Error('PTC stablecoin not deployed');
    if (!cfg.canonicalAddress) throw new Error(`canonical ${cfg.canonicalAsset} address not configured`);
    const sorted = trust.toLowerCase() < cfg.canonicalAddress.toLowerCase();
    return {
      trust, canonical: cfg.canonicalAddress,
      token0: sorted ? trust : cfg.canonicalAddress,
      token1: sorted ? cfg.canonicalAddress : trust,
      decimals0: sorted ? TRUST_TOKEN_DECIMALS : cfg.canonicalDecimals,
      decimals1: sorted ? cfg.canonicalDecimals : TRUST_TOKEN_DECIMALS,
      trustIndex: sorted ? 0 : 1,
    };
  }

  static async getPoolRecord() {
    const cfg = this.getConfig();
    if (cfg.poolAddress && isAddress(cfg.poolAddress)) {
      const t = this._tokens(cfg);
      return { pool_address: cfg.poolAddress, chain_id: cfg.chainId, token0: t.token0, token1: t.token1, trust_token: t.trust, canonical_token: t.canonical, canonical_asset: cfg.canonicalAsset, canonical_decimals: cfg.canonicalDecimals, amplification: cfg.amplification, fee_bps: cfg.feeBps, source: 'env' };
    }
    if (!query) return null;
    await ensureTables();
    const { rows } = await query('SELECT * FROM amm_os_pools WHERE chain_id = $1 AND canonical_asset = $2 ORDER BY created_at DESC LIMIT 1', [cfg.chainId, cfg.canonicalAsset]);
    return rows[0] ? { ...rows[0], source: 'postgres' } : null;
  }

  static async _readPool(cfg, poolAddress) {
    const { publicClient } = clients(cfg);
    const { abi } = getArtifact();
    const read = (functionName, args = []) => publicClient.readContract({ address: poolAddress, abi, functionName, args });
    const [reserves, A, feeBps, totalSupply, paused, virtualPrice] = await Promise.all([
      read('getReserves'), read('A'), read('feeBps'), read('totalSupply'), read('paused'), read('getVirtualPrice'),
    ]);
    return {
      reserves: [BigInt(reserves[0]), BigInt(reserves[1])],
      A: Number(A), feeBps: Number(feeBps), totalSupply: BigInt(totalSupply), paused: Boolean(paused), virtualPrice: BigInt(virtualPrice),
    };
  }

  static async _operatorBalance(cfg, token) {
    const { publicClient } = clients(cfg);
    return BigInt(await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [cfg.operatorAddress] }));
  }

  static async _approve(cfg, token, spender, amount) {
    const { publicClient, walletClient, fees } = clients(cfg);
    const allowance = BigInt(await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [cfg.operatorAddress, spender] }));
    if (allowance >= amount) return null;
    const hash = await walletClient.writeContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [spender, amount], ...fees });
    await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    return hash;
  }

  static async _recordAction(action) {
    if (!query) return;
    await ensureTables();
    await query(
      `INSERT INTO amm_os_actions (id, pool_address, kind, mode, status, price_before, price_after, deviation_bps, token_in, amount_in, amount_out, tx_hash, detail, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [action.id, action.poolAddress || null, action.kind, action.mode, action.status, action.priceBefore ?? null, action.priceAfter ?? null, action.deviationBps ?? null,
        action.tokenIn || null, action.amountIn != null ? String(action.amountIn) : null, action.amountOut != null ? String(action.amountOut) : null, action.txHash || null, safeJson(action.detail || {}), action.error || null]
    );
  }

  /**
   * Make sure the DLB-PTCUSD / canonical pool exists. Deploys StableAmmPool
   * (salted, so a repeat through the thirdweb signer returns the same address),
   * whitelists it on the trust token, seeds both sides with `seedUsd` from the
   * operator wallet and registers it with InternalMarketMakerEngine. In shadow
   * mode the whole plan is returned without a transaction.
   */
  static async ensurePool({ seedUsd } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) { const e = new Error('AMM OS is disabled (AMM_OS_ENABLED)'); e.status = 409; e.code = 'DISABLED'; throw e; }
    const existing = await this.getPoolRecord();
    if (existing) return { created: false, pool: existing, mode: cfg.shadow ? 'shadow' : 'live' };
    const t = this._tokens(cfg);
    const seed = Number(seedUsd ?? cfg.seedUsd);
    const plan = {
      deploy: { contract: 'StableAmmPool', args: { token0: t.token0, token1: t.token1, decimals0: t.decimals0, decimals1: t.decimals1, A: cfg.amplification, feeBps: cfg.feeBps, owner: cfg.operatorAddress } },
      seed: { trust: seed, canonical: seed },
    };
    if (cfg.shadow) {
      await this._recordAction({ id: newId(), kind: 'ensure_pool', mode: 'shadow', status: 'shadow', detail: plan });
      return { created: false, mode: 'shadow', plan };
    }
    const readiness = this.readiness();
    if (!readiness.ready) throw new Error(`AMM OS not ready: ${readiness.issues.join('; ')}`);

    const { publicClient, walletClient, fees, account } = clients(cfg);
    const { abi, bytecode } = getArtifact();
    const hash = await walletClient.deployContract({
      abi, bytecode,
      args: [t.token0, t.token1, t.decimals0, t.decimals1, BigInt(cfg.amplification), BigInt(cfg.feeBps), cfg.operatorAddress || account.address],
      salt: `amm-os:${cfg.canonicalAsset}:${cfg.chainId}`,
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180000 });
    if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`StableAmmPool deploy failed: ${hash}`);
    const poolAddress = receipt.contractAddress;

    await PtcStablecoinEngine.whitelist(poolAddress, true).catch((e) => { throw new Error(`whitelist pool on trust token failed: ${e.message}`); });

    const rawTrust = viem.parseUnits(String(seed), TRUST_TOKEN_DECIMALS);
    const rawCanonical = viem.parseUnits(String(seed), cfg.canonicalDecimals);
    let seeded = null;
    if (seed > 0) {
      const [trustBal, canonBal] = await Promise.all([this._operatorBalance(cfg, t.trust), this._operatorBalance(cfg, t.canonical)]);
      if (trustBal < rawTrust || canonBal < rawCanonical) {
        seeded = { status: 'awaiting_funds', trustBalance: String(trustBal), canonicalBalance: String(canonBal), needTrust: String(rawTrust), needCanonical: String(rawCanonical) };
      } else {
        await this._approve(cfg, t.trust, poolAddress, rawTrust);
        await this._approve(cfg, t.canonical, poolAddress, rawCanonical);
        const [a0, a1] = t.trustIndex === 0 ? [rawTrust, rawCanonical] : [rawCanonical, rawTrust];
        const seedHash = await walletClient.writeContract({ address: poolAddress, abi, functionName: 'addLiquidity', args: [a0, a1, 0n], ...fees });
        const seedReceipt = await publicClient.waitForTransactionReceipt({ hash: seedHash, timeout: 120000 });
        if (seedReceipt.status !== 'success') throw new Error(`seed addLiquidity failed: ${seedHash}`);
        seeded = { status: 'seeded', txHash: seedReceipt.transactionHash || seedHash, trust: seed, canonical: seed };
      }
    }

    const record = {
      id: newId('AMMP'), chain_id: cfg.chainId, pool_address: poolAddress, token0: t.token0, token1: t.token1, trust_token: t.trust, canonical_token: t.canonical,
      canonical_asset: cfg.canonicalAsset, canonical_decimals: cfg.canonicalDecimals, amplification: cfg.amplification, fee_bps: cfg.feeBps, mode: 'live', deploy_tx: receipt.transactionHash || hash,
    };
    if (query) {
      await ensureTables();
      await query(
        `INSERT INTO amm_os_pools (id, chain_id, pool_address, token0, token1, trust_token, canonical_token, canonical_asset, canonical_decimals, amplification, fee_bps, mode, deploy_tx, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (pool_address) DO NOTHING`,
        [record.id, record.chain_id, record.pool_address, record.token0, record.token1, record.trust_token, record.canonical_token, record.canonical_asset, record.canonical_decimals, record.amplification, record.fee_bps, record.mode, record.deploy_tx, safeJson({ seeded })]
      );
      if (InternalMarketMakerEngine) {
        await InternalMarketMakerEngine.ensureTables();
        await query(
          `INSERT INTO internal_market_maker_pools (id, pool_address, name, trust_asset, canonical_asset, apy_bps, status, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,'active',$7) ON CONFLICT (pool_address) DO NOTHING`,
          [newId('IMMP'), poolAddress, `DLB-PTCUSD/${cfg.canonicalAsset} StableSwap`, 'DLB-PTCUSD', cfg.canonicalAsset, 0, safeJson({ engine: 'amm-os', contract: 'StableAmmPool' })]
        );
        if (seeded && seeded.status === 'seeded') {
          await InternalMarketMakerEngine._recordPosition({ poolId: poolAddress, holder: cfg.operatorAddress, poolResult: seeded }).catch(() => null);
        }
      }
    }
    await this._recordAction({ id: newId(), poolAddress, kind: 'ensure_pool', mode: 'live', status: 'completed', txHash: record.deploy_tx, detail: { ...plan, seeded } });
    return { created: true, mode: 'live', pool: record, seeded };
  }

  // ─── Monitoring ──────────────────────────────────────────────────────────

  /** Pool snapshot with DLB-PTCUSD priced in canonical and the peg deviation. */
  static async snapshot() {
    const cfg = this.getConfig();
    const pool = await this.getPoolRecord();
    if (!pool) return { exists: false, mode: cfg.shadow ? 'shadow' : 'live', pegBandBps: cfg.pegBandBps };
    const t = this._tokens(cfg);
    const chain = await this._readPool(cfg, pool.pool_address);
    const rates = [10n ** BigInt(18 - t.decimals0), 10n ** BigInt(18 - t.decimals1)];
    return this.evaluate({ ...chain, rates, trustIndex: t.trustIndex, pegBandBps: cfg.pegBandBps, poolAddress: pool.pool_address, canonicalAsset: cfg.canonicalAsset, canonicalDecimals: cfg.canonicalDecimals });
  }

  /**
   * Pure peg evaluation on a pool state. `price` is DLB-PTCUSD in canonical
   * (1e18 = $1). Positive deviation means the trust token trades above $1 —
   * canonical should flow in; negative means below — trust token flows in.
   */
  static evaluate({ reserves, rates, A, feeBps, trustIndex, pegBandBps, totalSupply = 0n, virtualPrice = 0n, paused = false, poolAddress = null, canonicalAsset = null, canonicalDecimals = 18 }) {
    const canonicalIndex = trustIndex === 0 ? 1 : 0;
    const price0in1 = StableSwapMath.price({ reserves, rates, A });
    let price = price0in1;
    if (price0in1 > 0n && trustIndex === 1) price = (PRECISION * PRECISION) / price0in1;
    const deviationBps = price === 0n ? 0 : Number(((price - PRECISION) * 10_000n) / PRECISION);
    const outOfBand = Math.abs(deviationBps) > pegBandBps;
    let action = 'hold';
    let tokenInIndex = null;
    if (outOfBand && !paused) {
      // Rich trust token → the pool is short of it → add trust token.
      // Cheap trust token → the pool is long of it → add canonical.
      tokenInIndex = deviationBps > 0 ? trustIndex : canonicalIndex;
      action = 'swap';
    }
    const amountIn = tokenInIndex === null ? 0n : StableSwapMath.rebalanceAmountIn({ reserves, rates, i: tokenInIndex });
    return {
      exists: true,
      poolAddress,
      canonicalAsset,
      paused,
      reserves: { trust: reserves[trustIndex].toString(), canonical: reserves[canonicalIndex].toString(), trustFormatted: Number(reserves[trustIndex]) / 1e18, canonicalFormatted: Number(reserves[canonicalIndex]) / 10 ** canonicalDecimals },
      A, feeBps,
      totalSupply: totalSupply.toString(),
      virtualPrice: Number(virtualPrice) / 1e18,
      price: Number(price) / 1e18,
      deviationBps,
      pegBandBps,
      outOfBand,
      action,
      tokenInIndex,
      tokenIn: tokenInIndex === null ? null : tokenInIndex === trustIndex ? 'DLB-PTCUSD' : canonicalAsset,
      amountIn: amountIn.toString(),
      amountInFormatted: tokenInIndex === null ? 0 : Number(amountIn) / 10 ** (tokenInIndex === trustIndex ? 18 : canonicalDecimals),
    };
  }

  /** Quote `amountIn` of `tokenIn` ('DLB-PTCUSD' or the canonical symbol / address) off the live pool state. */
  static async quote({ tokenIn = 'DLB-PTCUSD', amountIn } = {}) {
    if (!amountIn || Number(amountIn) <= 0) throw new Error('amountIn must be positive');
    const cfg = this.getConfig();
    const pool = await this.getPoolRecord();
    if (!pool) throw new Error('AMM OS pool not deployed');
    const t = this._tokens(cfg);
    const chain = await this._readPool(cfg, pool.pool_address);
    const rates = [10n ** BigInt(18 - t.decimals0), 10n ** BigInt(18 - t.decimals1)];
    const key = String(tokenIn).toUpperCase();
    const isTrust = key === 'DLB-PTCUSD' || key === t.trust.toUpperCase();
    const i = isTrust ? t.trustIndex : 1 - t.trustIndex;
    const decIn = isTrust ? TRUST_TOKEN_DECIMALS : cfg.canonicalDecimals;
    const decOut = isTrust ? cfg.canonicalDecimals : TRUST_TOKEN_DECIMALS;
    const raw = viem.parseUnits(String(amountIn), decIn);
    const q = StableSwapMath.quote({ reserves: chain.reserves, rates, A: chain.A, feeBps: chain.feeBps, i, amountIn: raw });
    const out = Number(q.amountOut) / 10 ** decOut;
    return {
      poolAddress: pool.pool_address,
      tokenIn: isTrust ? 'DLB-PTCUSD' : cfg.canonicalAsset,
      tokenOut: isTrust ? cfg.canonicalAsset : 'DLB-PTCUSD',
      amountIn: String(amountIn), amountInRaw: raw.toString(),
      amountOut: out, amountOutRaw: q.amountOut.toString(),
      fee: Number(q.fee) / 10 ** decOut,
      effectivePrice: out / Number(amountIn),
      slippageBps: Math.round((1 - out / Number(amountIn)) * 10_000),
    };
  }

  // ─── Rebalance ───────────────────────────────────────────────────────────

  /**
   * Bring the pool back inside the peg band with one swap from the operator
   * wallet, capped at AMM_OS_MAX_REBALANCE_USD. Returns `awaiting_funds` when
   * the operator lacks the input token rather than sourcing it elsewhere.
   */
  static async rebalance({ force = false } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) { const e = new Error('AMM OS is disabled (AMM_OS_ENABLED)'); e.status = 409; e.code = 'DISABLED'; throw e; }
    const snap = await this.snapshot();
    const mode = cfg.shadow ? 'shadow' : 'live';
    if (!snap.exists) return { status: 'no_pool', mode, snapshot: snap };
    if (snap.action === 'hold' && !force) {
      return { status: 'in_band', mode, snapshot: snap };
    }
    if (snap.action === 'hold') return { status: 'in_band', mode, snapshot: snap, forced: true };

    const t = this._tokens(cfg);
    const tokenInIsTrust = snap.tokenInIndex === t.trustIndex;
    const decIn = tokenInIsTrust ? TRUST_TOKEN_DECIMALS : cfg.canonicalDecimals;
    const capRaw = viem ? viem.parseUnits(String(cfg.maxRebalanceUsd), decIn) : BigInt(Math.floor(cfg.maxRebalanceUsd * 10 ** decIn));
    let amountIn = BigInt(snap.amountIn);
    if (amountIn > capRaw) amountIn = capRaw;
    const tokenInAddress = tokenInIsTrust ? t.trust : t.canonical;
    const pool = await this.getPoolRecord();
    const rates = [10n ** BigInt(18 - t.decimals0), 10n ** BigInt(18 - t.decimals1)];
    const chain = await this._readPool(cfg, pool.pool_address);
    const q = StableSwapMath.quote({ reserves: chain.reserves, rates, A: chain.A, feeBps: chain.feeBps, i: snap.tokenInIndex, amountIn });
    const minOut = (q.amountOut * (FEE_DENOMINATOR - BigInt(cfg.slippageBps))) / FEE_DENOMINATOR;

    const action = {
      id: newId(), poolAddress: pool.pool_address, kind: 'rebalance', mode, status: mode,
      priceBefore: snap.price, deviationBps: snap.deviationBps, tokenIn: snap.tokenIn, amountIn, amountOut: q.amountOut,
      detail: { tokenInAddress, minOut: minOut.toString(), capped: amountIn === capRaw, priceAfter: Number(q.priceAfter) / 1e18 },
    };
    if (cfg.shadow) {
      await this._recordAction(action);
      return { status: 'shadow', mode, snapshot: snap, action: { ...action, amountIn: amountIn.toString(), amountOut: q.amountOut.toString() } };
    }

    const balance = await this._operatorBalance(cfg, tokenInAddress);
    if (balance < amountIn) {
      action.status = 'awaiting_funds';
      action.error = `operator holds ${balance} ${snap.tokenIn}, needs ${amountIn}`;
      await this._recordAction(action);
      return { status: 'awaiting_funds', mode, snapshot: snap, needed: amountIn.toString(), available: balance.toString(), tokenIn: snap.tokenIn };
    }
    try {
      const { publicClient, walletClient, fees } = clients(cfg);
      const { abi } = getArtifact();
      await this._approve(cfg, tokenInAddress, pool.pool_address, amountIn);
      const hash = await walletClient.writeContract({ address: pool.pool_address, abi, functionName: 'swap', args: [tokenInAddress, amountIn, minOut, cfg.operatorAddress], ...fees });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
      if (receipt.status !== 'success') throw new Error(`swap failed: ${hash}`);
      action.txHash = receipt.transactionHash || hash;
      action.status = 'completed';
      const after = await this.snapshot().catch(() => null);
      action.priceAfter = after ? after.price : null;
      await this._recordAction(action);
      return { status: 'completed', mode, snapshot: snap, after, action: { ...action, amountIn: amountIn.toString(), amountOut: q.amountOut.toString() } };
    } catch (e) {
      action.status = 'failed';
      action.error = e.message;
      await this._recordAction(action);
      throw e;
    }
  }

  static async runCycle() {
    const cfg = this.getConfig();
    const ensured = await this.ensurePool();
    if (!ensured.pool) return { skipped: true, reason: cfg.shadow ? 'pool not deployed (shadow plan recorded)' : 'pool not deployed', ensured };
    const rebalanced = await this.rebalance();
    return { skipped: false, ensured, rebalanced };
  }

  static async listActions({ limit = 20 } = {}) {
    if (!query) return [];
    await ensureTables();
    const { rows } = await query('SELECT * FROM amm_os_actions ORDER BY created_at DESC LIMIT $1', [Math.min(200, Math.max(1, Number(limit) || 20))]);
    return rows;
  }

  static async status() {
    const cfg = this.getConfig();
    const readiness = this.readiness();
    const pool = await this.getPoolRecord().catch(() => null);
    const [snapshot, actions] = await Promise.all([
      pool ? this.snapshot().catch((e) => ({ exists: true, poolAddress: pool.pool_address, error: e.message })) : Promise.resolve({ exists: false }),
      this.listActions({ limit: 10 }).catch(() => []),
    ]);
    return {
      provider: 'amm-os',
      mode: cfg.shadow ? 'shadow' : 'live',
      enabled: cfg.enabled,
      readiness,
      canonicalAsset: cfg.canonicalAsset,
      pegBandBps: cfg.pegBandBps,
      amplification: cfg.amplification,
      feeBps: cfg.feeBps,
      maxRebalanceUsd: cfg.maxRebalanceUsd,
      pool,
      snapshot,
      recentActions: actions,
    };
  }
}

module.exports = { AmmOsEngine, StableSwapMath, PRECISION, round6 };
