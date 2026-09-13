import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const TRUST = '0x1111111111111111111111111111111111111111';
const USDC = '0x2222222222222222222222222222222222222222';
const OPERATOR = '0x9999999999999999999999999999999999999999';

// dapp/config.js is read once at load: a raw-key operator with DAPP_SHADOW off so
// each engine's own <ENGINE>_SHADOW flag decides the mode under test.
process.env.DAPP_SHADOW = 'false';
process.env.DAPP_SIGNER = '';
process.env.DAPP_PRIVATE_KEY = '0x' + '11'.repeat(32);
process.env.DAPP_OPERATOR_ADDRESS = OPERATOR;
process.env.DAPP_USDC_ADDRESS = USDC;
process.env.DAPP_RPC_URL = process.env.DAPP_RPC_URL || 'http://127.0.0.1:8545';

const { YieldVaultOsEngine, proRata } = require('../server/integrations/dapp/yieldVaultOsEngine');
const { AmmOsEngine, StableSwapMath } = require('../server/integrations/dapp/ammOsEngine');
const { FloorRedemptionOsEngine } = require('../server/integrations/dapp/floorRedemptionOsEngine');
const { PtcStablecoinEngine } = require('../server/integrations/dapp/ptcStablecoinEngine');
const { TreasuryOnRampBridgeEngine } = require('../server/integrations/dapp/treasuryOnRampBridgeEngine');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const pool = require('../server/integrations/bonds/pgPool');

const POOL = '0x3333333333333333333333333333333333333333';
const FLOOR = '0x4444444444444444444444444444444444444444';
const LP_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LP_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HOLDER = '0xcccccccccccccccccccccccccccccccccccccccc';

const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
// token0 = TRUST (18 dp), token1 = USDC (6 dp)
const RATES = [1n, 10n ** 12n];
const A = 200;
const FEE_BPS = 4;

/** Postgres stub: DDL and inserts succeed, reads return nothing, every write is captured. */
function stubPg() {
  const writes: any[] = [];
  vi.spyOn(pool, 'query').mockImplementation(async (sql: any, params: any = []) => {
    const text = String(sql);
    if (/^\s*(CREATE|ALTER)/i.test(text)) return { rows: [] } as any;
    if (/^\s*INSERT/i.test(text)) { writes.push({ sql: text, params }); return { rows: [] } as any; }
    if (/SUM\(/i.test(text)) return { rows: [{ total: '0' }] } as any;
    return { rows: [] } as any;
  });
  return writes;
}

function setEnv(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}

const ENV_KEYS = [
  'DAPP_SHADOW', 'DAPP_SIGNER', 'THIRDWEB_SERVER_WALLET_LIVE', 'DAPP_PRIVATE_KEY', 'DAPP_USDC_ADDRESS',
  'YIELD_VAULT_OS_ENABLED', 'YIELD_VAULT_OS_SHADOW', 'YIELD_VAULT_OS_LP_SHARE_BPS', 'YIELD_VAULT_OS_HOLDERS',
  'YIELD_VAULT_OS_MIN_DISTRIBUTION_USD', 'YIELD_VAULT_OS_MAX_DISTRIBUTION_USD',
  'AMM_OS_ENABLED', 'AMM_OS_SHADOW', 'AMM_OS_PEG_BAND_BPS', 'AMM_OS_MAX_REBALANCE_USD', 'AMM_OS_POOL_ADDRESS',
  'FLOOR_REDEMPTION_OS_ENABLED', 'FLOOR_REDEMPTION_OS_SHADOW', 'FLOOR_REDEMPTION_OS_CONTRACT_ADDRESS',
  'FLOOR_REDEMPTION_OS_MIN_SPREAD_BPS', 'FLOOR_REDEMPTION_OS_MAX_ARB_USD', 'FLOOR_REDEMPTION_OS_TARGET_COVERAGE_BPS',
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  setEnv({ DAPP_SIGNER: '', THIRDWEB_SERVER_WALLET_LIVE: 'false' });
  vi.spyOn(PtcStablecoinEngine, 'state').mockReturnValue({ tokenAddress: TRUST, vaultAddress: '0x' + '55'.repeat(20), chainId: 1 } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
});

// ─── Yield Vault OS ──────────────────────────────────────────────────────────

describe('YieldVaultOsEngine — pro-rata math', () => {
  it('splits by weight, rounds to 6 dp and sums exactly to the total', () => {
    const out = proRata(100, [
      { recipient: LP_A, weight: 1n },
      { recipient: LP_B, weight: 1n },
      { recipient: HOLDER, weight: 1n },
    ]);
    const amounts = out.map((o: any) => o.amount);
    expect(amounts.reduce((s: number, a: number) => s + a, 0)).toBeCloseTo(100, 9);
    // dust (0.000001) lands on one recipient, the others get the floor
    expect(amounts.filter((a: number) => a === 33.333333)).toHaveLength(2);
    expect(amounts).toContain(33.333334);
  });

  it('drops zero weights and returns zero allocations for a zero total', () => {
    expect(proRata(50, [{ recipient: LP_A, weight: 0n }, { recipient: LP_B, weight: 5n }])).toEqual([
      { recipient: LP_B, weight: 5n, amount: 50 },
    ]);
    expect(proRata(0, [{ recipient: LP_A, weight: 3n }])).toEqual([{ recipient: LP_A, weight: 3n, amount: 0 }]);
  });

  it('allocate() routes LP share vs holder share and falls through when a class is empty', () => {
    const lp = [{ recipient: LP_A, class: 'lp', weight: 3n }, { recipient: LP_B, class: 'lp', weight: 1n }];
    const holders = [{ recipient: HOLDER, class: 'holder', weight: 10n * E18 }];
    const split = YieldVaultOsEngine.allocate({ total: 100, lpWeights: lp, holderWeights: holders, lpShareBps: 3000 });
    const byRecipient = Object.fromEntries(split.map((a: any) => [a.recipient, a.amount]));
    expect(byRecipient[LP_A]).toBe(22.5);
    expect(byRecipient[LP_B]).toBe(7.5);
    expect(byRecipient[HOLDER]).toBe(70);

    const lpOnly = YieldVaultOsEngine.allocate({ total: 100, lpWeights: lp, holderWeights: [], lpShareBps: 3000 });
    expect(lpOnly.reduce((s: number, a: any) => s + a.amount, 0)).toBe(100);
    expect(YieldVaultOsEngine.allocate({ total: 100, lpWeights: [], holderWeights: [], lpShareBps: 3000 })).toEqual([]);
  });
});

describe('YieldVaultOsEngine — shadow / live gating', () => {
  function income() {
    vi.spyOn(YieldVaultOsEngine, '_bondInterest').mockResolvedValue({ total: 80, detail: [] });
    vi.spyOn(YieldVaultOsEngine, '_lpYield').mockResolvedValue({ total: 20, detail: [] });
    vi.spyOn(YieldVaultOsEngine, '_reserveSurplus').mockResolvedValue({ total: 0, detail: null });
    vi.spyOn(YieldVaultOsEngine, '_alreadyDistributed').mockResolvedValue({ bond_interest: 0, lp_yield: 0, reserve_surplus: 0 });
    vi.spyOn(YieldVaultOsEngine, '_lpWeights').mockResolvedValue([{ recipient: LP_A, class: 'lp', weight: 100n }]);
    vi.spyOn(YieldVaultOsEngine, '_holderWeights').mockResolvedValue([{ recipient: HOLDER, class: 'holder', weight: 5n * E18 }]);
    vi.spyOn(YieldVaultOsEngine, '_notarize').mockResolvedValue('fabric-1');
    vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ id: 'JE-1' } as any);
  }

  it('is shadow by default and records allocations without moving tokens', async () => {
    setEnv({ YIELD_VAULT_OS_LP_SHARE_BPS: '3000' });
    income();
    const writes = stubPg();
    const transfer = vi.spyOn(PtcStablecoinEngine, 'transfer').mockResolvedValue({ txHash: '0xdead' } as any);

    expect(YieldVaultOsEngine.getConfig().shadow).toBe(true);
    const out = await YieldVaultOsEngine.runCycle();
    expect(out.skipped).toBe(false);
    expect(out.cycle.mode).toBe('shadow');
    expect(out.cycle.status).toBe('shadow');
    expect(out.cycle.distributed).toBe(100);
    expect(out.cycle.result.allocations.map((a: any) => [a.recipient, a.amount, a.status])).toEqual([
      [LP_A, 30, 'shadow'],
      [HOLDER, 70, 'shadow'],
    ]);
    // income consumed in source order: bond first, then LP yield
    expect(out.cycle.sources.used).toEqual({ bond_interest: 80, lp_yield: 20, reserve_surplus: 0 });
    expect(transfer).not.toHaveBeenCalled();
    expect(writes.some((w) => /yield_vault_os_distributions/.test(w.sql))).toBe(true);
  });

  it('pays DLB-PTCUSD through PtcStablecoinEngine.transfer when the live gates are set', async () => {
    setEnv({ YIELD_VAULT_OS_SHADOW: 'false', YIELD_VAULT_OS_LP_SHARE_BPS: '3000' });
    income();
    stubPg();
    const transfer = vi.spyOn(PtcStablecoinEngine, 'transfer').mockResolvedValue({ txHash: '0xdead' } as any);
    const post = TrustAccountingEngine.postJournalEntry as any;

    expect(YieldVaultOsEngine.getConfig().shadow).toBe(false);
    const cycle = await YieldVaultOsEngine.distribute();
    expect(cycle.mode).toBe('live');
    expect(cycle.status).toBe('completed');
    expect(transfer).toHaveBeenCalledTimes(2);
    expect(transfer).toHaveBeenCalledWith({ to: LP_A, amount: '30' });
    expect(transfer).toHaveBeenCalledWith({ to: HOLDER, amount: '70' });
    expect(cycle.journalEntryId).toBe('JE-1');
    const lines = post.mock.calls[0][0].lines;
    expect(lines.reduce((s: number, l: any) => s + l.debitAmount, 0)).toBe(100);
    expect(lines.reduce((s: number, l: any) => s + l.creditAmount, 0)).toBe(100);
    expect(cycle.fabricRecordId).toBe('fabric-1');
  });

  it('the thirdweb signer forces shadow until THIRDWEB_SERVER_WALLET_LIVE; the kill switch blocks distribute()', async () => {
    setEnv({ YIELD_VAULT_OS_SHADOW: 'false', DAPP_SIGNER: 'thirdweb', THIRDWEB_SERVER_WALLET_LIVE: 'false' });
    expect(YieldVaultOsEngine.getConfig().shadow).toBe(true);
    expect(AmmOsEngine.getConfig().shadow).toBe(true);
    expect(FloorRedemptionOsEngine.getConfig().shadow).toBe(true);

    setEnv({ THIRDWEB_SERVER_WALLET_LIVE: 'true' });
    expect(YieldVaultOsEngine.getConfig().shadow).toBe(false);

    setEnv({ DAPP_SIGNER: '', THIRDWEB_SERVER_WALLET_LIVE: 'false', YIELD_VAULT_OS_ENABLED: 'false' });
    income();
    stubPg();
    await expect(YieldVaultOsEngine.distribute()).rejects.toMatchObject({ code: 'DISABLED', status: 409 });
  });

  it('skips when income is below the minimum or nobody holds the token', async () => {
    setEnv({ YIELD_VAULT_OS_MIN_DISTRIBUTION_USD: '500' });
    income();
    stubPg();
    const out = await YieldVaultOsEngine.runCycle();
    expect(out.skipped).toBe(true);
    expect(out.reason).toMatch(/below minimum/);
  });
});

// ─── AMM OS ──────────────────────────────────────────────────────────────────

function balanced(usd = 100_000) {
  return [BigInt(usd) * E18, BigInt(usd) * E6];
}

describe('StableSwapMath — low slippage near the peg', () => {
  it('prices a balanced pool at exactly 1 and quotes tiny slippage on a 1 % trade', () => {
    const reserves = balanced();
    const price = StableSwapMath.price({ reserves, rates: RATES, A });
    expect(Number(price) / 1e18).toBeCloseTo(1, 5);

    const q = StableSwapMath.quote({ reserves, rates: RATES, A, feeBps: FEE_BPS, i: 0, amountIn: 1_000n * E18 });
    const out = Number(q.amountOut) / 1e6;
    expect(out).toBeGreaterThan(999.5); // fee 4 bps + curve slippage well under 5 bps
    expect(out).toBeLessThan(1_000);
    expect(Number(q.fee) / 1e6).toBeCloseTo(1_000 * FEE_BPS / 10_000, 2);
  });

  it('a 30 % imbalance still trades within ~40 bps of parity (constant-product would be > 30 %)', () => {
    const reserves = [130_000n * E18, 70_000n * E6];
    const price = Number(StableSwapMath.price({ reserves, rates: RATES, A })) / 1e18;
    expect(price).toBeLessThan(1);
    expect(price).toBeGreaterThan(0.996);
    const q = StableSwapMath.quote({ reserves, rates: RATES, A, feeBps: 0, i: 0, amountIn: 1_000n * E18 });
    expect(Number(q.amountOut) / 1e6).toBeGreaterThan(995);
  });

  it('D is conserved across a fee-less swap and virtual price is stable', () => {
    const reserves = balanced();
    const xp = [reserves[0] * RATES[0], reserves[1] * RATES[1]];
    const d0 = StableSwapMath.getD(xp, BigInt(A));
    const amountIn = 5_000n * E18;
    const q = StableSwapMath.quote({ reserves, rates: RATES, A, feeBps: 0, i: 0, amountIn });
    const after = [(reserves[0] + amountIn) * RATES[0], (reserves[1] - q.amountOut) * RATES[1]];
    const d1 = StableSwapMath.getD(after, BigInt(A));
    // D never decreases; integer rounding may leave it up by a negligible amount
    expect(d1 >= d0).toBe(true);
    expect(Number(d1 - d0) / Number(d0)).toBeLessThan(1e-9);
  });
});

describe('AmmOsEngine — peg-band rebalance decisions', () => {
  const base = { rates: RATES, A, feeBps: FEE_BPS, trustIndex: 0, pegBandBps: 100, canonicalDecimals: 6, canonicalAsset: 'USDC' };

  it('holds inside the band', () => {
    const snap = AmmOsEngine.evaluate({ ...base, reserves: [104_000n * E18, 96_000n * E6] });
    expect(snap.action).toBe('hold');
    expect(Math.abs(snap.deviationBps)).toBeLessThan(100);
    expect(snap.tokenIn).toBeNull();
  });

  it('swaps canonical in when DLB-PTCUSD trades below $1 by more than the band', () => {
    // very lopsided pool with low A so the price actually breaks the band
    const snap = AmmOsEngine.evaluate({ ...base, A: 5, reserves: [180_000n * E18, 20_000n * E6] });
    expect(snap.price).toBeLessThan(0.99);
    expect(snap.outOfBand).toBe(true);
    expect(snap.action).toBe('swap');
    expect(snap.tokenIn).toBe('USDC');
    // half the normalised gap: (180k - 20k) / 2 = 80k USDC
    expect(snap.amountInFormatted).toBeCloseTo(80_000, 0);
  });

  it('swaps DLB-PTCUSD in when it trades above $1', () => {
    const snap = AmmOsEngine.evaluate({ ...base, A: 5, reserves: [20_000n * E18, 180_000n * E6] });
    expect(snap.price).toBeGreaterThan(1.01);
    expect(snap.action).toBe('swap');
    expect(snap.tokenIn).toBe('DLB-PTCUSD');
    expect(snap.amountInFormatted).toBeCloseTo(80_000, 0);
  });

  it('respects a wider configured band and never acts on a paused pool', () => {
    const tight = AmmOsEngine.evaluate({ ...base, reserves: [104_000n * E18, 96_000n * E6] });
    const narrow = AmmOsEngine.evaluate({ ...base, pegBandBps: 1, reserves: [104_000n * E18, 96_000n * E6] });
    expect(tight.action).toBe('hold');
    expect(narrow.deviationBps).toBe(tight.deviationBps);
    expect(narrow.action).toBe('swap');
    const wide = AmmOsEngine.evaluate({ ...base, A: 5, pegBandBps: 6_000, reserves: [180_000n * E18, 20_000n * E6] });
    expect(wide.deviationBps).toBeLessThan(-5_000);
    expect(wide.action).toBe('hold');
    const paused = AmmOsEngine.evaluate({ ...base, A: 5, paused: true, reserves: [180_000n * E18, 20_000n * E6] });
    expect(paused.outOfBand).toBe(true);
    expect(paused.action).toBe('hold');
  });

  it('handles the token1 = trust ordering by inverting the price', () => {
    // token0 = USDC (6dp), token1 = TRUST (18dp), trust cheap
    const snap = AmmOsEngine.evaluate({ ...base, A: 5, trustIndex: 1, rates: [10n ** 12n, 1n], reserves: [20_000n * E6, 180_000n * E18] });
    expect(snap.price).toBeLessThan(0.99);
    expect(snap.tokenIn).toBe('USDC');
  });
});

describe('AmmOsEngine — rebalance() gating', () => {
  function pool(reserves: bigint[]) {
    vi.spyOn(AmmOsEngine, 'getPoolRecord').mockResolvedValue({ pool_address: POOL, token0: TRUST, token1: USDC } as any);
    vi.spyOn(AmmOsEngine, '_readPool').mockResolvedValue({ reserves, A: 5, feeBps: FEE_BPS, totalSupply: 200_000n * E18, virtualPrice: E18, paused: false } as any);
  }

  it('records a shadow action with the capped swap and signs nothing', async () => {
    setEnv({ AMM_OS_MAX_REBALANCE_USD: '1000' });
    pool([180_000n * E18, 20_000n * E6]);
    const record = vi.spyOn(AmmOsEngine, '_recordAction').mockResolvedValue(undefined as any);
    const balance = vi.spyOn(AmmOsEngine, '_operatorBalance');

    const out = await AmmOsEngine.rebalance();
    expect(out.status).toBe('shadow');
    expect(out.action.tokenIn).toBe('USDC');
    expect(out.action.amountIn).toBe((1_000n * E6).toString());
    expect(out.action.detail.capped).toBe(true);
    expect(record).toHaveBeenCalledTimes(1);
    expect(balance).not.toHaveBeenCalled();
  });

  it('returns in_band without recording when the pool is inside the band', async () => {
    pool(balanced());
    const record = vi.spyOn(AmmOsEngine, '_recordAction').mockResolvedValue(undefined as any);
    const out = await AmmOsEngine.rebalance();
    expect(out.status).toBe('in_band');
    expect(record).not.toHaveBeenCalled();
  });

  it('live mode surfaces awaiting_funds when the operator wallet lacks the input token', async () => {
    setEnv({ AMM_OS_SHADOW: 'false', AMM_OS_MAX_REBALANCE_USD: '1000' });
    pool([180_000n * E18, 20_000n * E6]);
    const record = vi.spyOn(AmmOsEngine, '_recordAction').mockResolvedValue(undefined as any);
    vi.spyOn(AmmOsEngine, '_operatorBalance').mockResolvedValue(10n * E6);

    expect(AmmOsEngine.getConfig().shadow).toBe(false);
    const out = await AmmOsEngine.rebalance();
    expect(out.status).toBe('awaiting_funds');
    expect(out.tokenIn).toBe('USDC');
    expect(out.needed).toBe((1_000n * E6).toString());
    expect(out.available).toBe((10n * E6).toString());
    expect(record.mock.calls[0][0].status).toBe('awaiting_funds');
  });

  it('AMM_OS_ENABLED=false is a kill switch', async () => {
    setEnv({ AMM_OS_ENABLED: 'false' });
    await expect(AmmOsEngine.rebalance()).rejects.toMatchObject({ code: 'DISABLED' });
  });
});

// ─── Floor Redemption OS ─────────────────────────────────────────────────────

describe('FloorRedemptionOsEngine — coverage and quotes', () => {
  it('reports coverage as canonical reserve ÷ (supply × floor)', () => {
    const c = FloorRedemptionOsEngine.coverage({ reserveRaw: 500n * E6, supplyRaw: 1_000n * E18, floorPriceRaw: E18, reserveDecimals: 6 });
    expect(c.coverageBps).toBe(5_000);
    expect(c.fullyCovered).toBe(false);
    expect(c.shortfall).toBe(500);
    expect(c.needed).toBe(1_000);

    const full = FloorRedemptionOsEngine.coverage({ reserveRaw: 1_200n * E6, supplyRaw: 1_000n * E18, floorPriceRaw: E18, reserveDecimals: 6 });
    expect(full.coverageBps).toBe(12_000);
    expect(full.fullyCovered).toBe(true);
    expect(full.shortfall).toBe(0);
  });

  it('applies a non-unit floor in 1e18 precision', () => {
    const floor = (98n * E18) / 100n; // $0.98
    const q = FloorRedemptionOsEngine.quoteRedeem({ trustRaw: 100n * E18, floorPriceRaw: floor, reserveDecimals: 6 });
    expect(q).toBe(98n * E6);
    const c = FloorRedemptionOsEngine.coverage({ reserveRaw: 980n * E6, supplyRaw: 1_000n * E18, floorPriceRaw: floor, reserveDecimals: 6 });
    expect(c.coverageBps).toBe(10_000);
  });
});

describe('FloorRedemptionOsEngine — arbitrage spread logic', () => {
  const arb = {
    rates: RATES, A: 5, feeBps: FEE_BPS, trustIndex: 0, floorPriceRaw: E18, reserveDecimals: 6,
    minSpreadBps: 25, maxArbRaw: 500n * E6,
  };

  it('buys cheap DLB-PTCUSD on the AMM and redeems at the floor when the spread clears fee + threshold', () => {
    const plan = FloorRedemptionOsEngine.planArb({
      ...arb,
      reserves: [180_000n * E18, 20_000n * E6],
      reserveRaw: 100_000n * E6,
      canonicalBalanceRaw: 10_000n * E6,
    });
    expect(plan.actionable).toBe(true);
    expect(plan.status).toBe('arb');
    expect(plan.ammPrice).toBeLessThan(1);
    expect(plan.spreadBps).toBeGreaterThan(25 + FEE_BPS);
    expect(plan.spend).toBe(500); // capped by FLOOR_REDEMPTION_OS_MAX_ARB_USD
    expect(plan.trustBought).toBeGreaterThan(500);
    expect(plan.redeemOut).toBeCloseTo(plan.trustBought, 5);
    expect(plan.profit).toBeCloseTo(plan.redeemOut - plan.spend, 5);
    expect(plan.profit).toBeGreaterThan(0);
    expect(plan.priceAfter).toBeGreaterThan(plan.ammPrice);
  });

  it('does nothing when the AMM is at or above the floor, or the discount is inside the threshold', () => {
    const atPeg = FloorRedemptionOsEngine.planArb({ ...arb, A: 200, reserves: balanced(), reserveRaw: 1_000n * E6, canonicalBalanceRaw: 1_000n * E6 });
    expect(atPeg.actionable).toBe(false);
    expect(atPeg.reason).toMatch(/at or above floor/);

    // slightly cheap but the discount (< 25 bps + fee) is not worth it
    const thin = FloorRedemptionOsEngine.planArb({ ...arb, A: 200, reserves: [104_000n * E18, 96_000n * E6], reserveRaw: 1_000n * E6, canonicalBalanceRaw: 1_000n * E6 });
    expect(thin.actionable).toBe(false);
    expect(thin.ammPrice).toBeLessThan(1);
    expect(thin.reason).toMatch(/below threshold/);

    const rich = FloorRedemptionOsEngine.planArb({ ...arb, reserves: [20_000n * E18, 180_000n * E6], reserveRaw: 1_000n * E6, canonicalBalanceRaw: 1_000n * E6 });
    expect(rich.actionable).toBe(false);
  });

  it('spends only what the operator wallet holds', () => {
    const plan = FloorRedemptionOsEngine.planArb({ ...arb, reserves: [180_000n * E18, 20_000n * E6], reserveRaw: 100_000n * E6, canonicalBalanceRaw: 120n * E6 });
    expect(plan.actionable).toBe(true);
    expect(plan.spend).toBe(120);
  });

  it('surfaces awaiting_funds when the canonical wallet is empty or the reserve cannot honour the redemption', () => {
    const noWallet = FloorRedemptionOsEngine.planArb({ ...arb, reserves: [180_000n * E18, 20_000n * E6], reserveRaw: 100_000n * E6, canonicalBalanceRaw: 0n });
    expect(noWallet.actionable).toBe(false);
    expect(noWallet.status).toBe('awaiting_funds');

    const dryReserve = FloorRedemptionOsEngine.planArb({ ...arb, reserves: [180_000n * E18, 20_000n * E6], reserveRaw: 0n, canonicalBalanceRaw: 10_000n * E6 });
    expect(dryReserve.actionable).toBe(false);
    expect(dryReserve.status).toBe('awaiting_funds');
    expect(dryReserve.reason).toMatch(/reserve/);

    // a thin reserve limits the buy to what can be redeemed, and flags it
    const thin = FloorRedemptionOsEngine.planArb({ ...arb, reserves: [180_000n * E18, 20_000n * E6], reserveRaw: 100n * E6, canonicalBalanceRaw: 10_000n * E6 });
    expect(thin.actionable).toBe(true);
    expect(thin.status).toBe('awaiting_funds');
    expect(thin.reserveLimited).toBe(true);
    expect(thin.spend).toBeLessThan(100);
    expect(BigInt(thin.redeemOutRaw) <= 100n * E6).toBe(true);
    expect(thin.profit).toBeGreaterThan(0);
  });
});

describe('FloorRedemptionOsEngine — fund() / redeem() never fabricate canonical', () => {
  function contract({ reserveRaw }: { reserveRaw: bigint }) {
    vi.spyOn(FloorRedemptionOsEngine, 'getContractRecord').mockResolvedValue({
      contract_address: FLOOR, reserve_asset: 'USDC', reserve_token: USDC, reserve_decimals: 6, trust_token: TRUST, floor_price: E18.toString(),
    } as any);
    vi.spyOn(FloorRedemptionOsEngine, '_readContract').mockResolvedValue({
      reserve: reserveRaw, floorPrice: E18, paused: false, totalRedeemed: 0n, totalPaidOut: 0n, whitelistEnabled: true, burnOnRedeem: false,
    } as any);
    vi.spyOn(PtcStablecoinEngine, 'totalSupply').mockResolvedValue('1000' as any);
    return vi.spyOn(FloorRedemptionOsEngine, '_recordAction').mockResolvedValue(undefined as any);
  }

  it('shadow fund() records the plan without touching a wallet', async () => {
    const record = contract({ reserveRaw: 400n * E6 });
    const balance = vi.spyOn(FloorRedemptionOsEngine, '_operatorBalance');
    const out = await FloorRedemptionOsEngine.fund({ amount: 600 });
    expect(out.mode).toBe('shadow');
    expect(out.status).toBe('shadow');
    expect(out.amount).toBe(600);
    expect(out.amountRaw).toBe((600n * E6).toString());
    expect(record).toHaveBeenCalledTimes(1);
    expect(balance).not.toHaveBeenCalled();
  });

  it('live fund() with a short wallet proposes an on-ramp and returns awaiting_funds', async () => {
    setEnv({ FLOOR_REDEMPTION_OS_SHADOW: 'false' });
    contract({ reserveRaw: 400n * E6 });
    vi.spyOn(FloorRedemptionOsEngine, '_operatorBalance').mockResolvedValue(50n * E6);
    const propose = vi.spyOn(TreasuryOnRampBridgeEngine, 'propose').mockResolvedValue({ id: 'ONRAMP-1' } as any);
    // no amount: fund the shortfall to full coverage = 1000 supply × $1 − 400 reserve
    const out = await FloorRedemptionOsEngine.fund();
    expect(out.mode).toBe('live');
    expect(out.status).toBe('awaiting_funds');
    expect(out.needed).toBe(600);
    expect(out.available).toBe(50);
    expect(out.shortfall).toBe(550);
    expect(propose).toHaveBeenCalledTimes(1);
    expect(propose.mock.calls[0][0]).toMatchObject({ amount: '550', targetAsset: 'USDC', createdBy: 'floor-redemption-os' });
    expect(out.onRampOperation).toEqual({ id: 'ONRAMP-1' });
  });

  it('redeem() returns awaiting_funds when the reserve cannot cover the request', async () => {
    setEnv({ FLOOR_REDEMPTION_OS_SHADOW: 'false' });
    contract({ reserveRaw: 100n * E6 });
    const trustBalance = vi.spyOn(FloorRedemptionOsEngine, '_operatorBalance').mockResolvedValue(5_000n * E18);
    const out = await FloorRedemptionOsEngine.redeem({ amount: '250' });
    expect(out.status).toBe('awaiting_funds');
    expect(out.available).toBe(100);
    expect(out.needed).toBe(250);
    expect(trustBalance).not.toHaveBeenCalled();
  });
});

describe('OS engines — readiness', () => {
  it('all three report shadow mode and the missing PTC deployment without throwing', () => {
    (PtcStablecoinEngine.state as any).mockReturnValue({});
    for (const E of [YieldVaultOsEngine, AmmOsEngine, FloorRedemptionOsEngine]) {
      const r = E.readiness();
      expect(r.mode).toBe('shadow');
      expect(r.ready).toBe(false);
      expect(r.issues).toContain('PTC stablecoin not deployed');
    }
  });
});
