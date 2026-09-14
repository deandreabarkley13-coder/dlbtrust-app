import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Must be set before the engine loads: it decides at require time whether to use Postgres.
process.env.DAPP_MEMORY_MODE = 'true';

const { TreasuryDepositEngine } = require('../server/integrations/dapp/treasuryDepositEngine');
const { ThirdwebServerWalletEngine } = require('../server/integrations/dapp/thirdwebServerWalletEngine');
const { ThirdwebPriceOracle } = require('../server/integrations/dapp/thirdwebPriceOracle');
const { StablecoinDexEngine } = require('../server/integrations/dapp/stablecoinDexEngine');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const { LiveValueRunbookOsEngine } = require('../server/integrations/os/liveValueRunbookOsEngine');

const saved = { ...process.env };
const TREASURY = '0x1A904F795a0511C31Ba6347504D08d1bA58E4f89';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DLBUSD = '0x6ba8d02596a3b091a7246e38e3e078f770d33985';

// Treasury USDC balance in smallest units; the swap "delivers" by raising it.
let held = 0n;

function dexConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true, shadow: false, chainId: 8453, rpcUrl: 'http://rpc', privateKey: '0x' + '1'.repeat(64),
    usdcAddress: USDC, dlbusdAddress: DLBUSD, poolAddress: '0xpool', wethAddress: '0xweth',
    operatorAddress: '0x95bb85FdeC42b1517d282e8AD43A789d390aAda2', slippageBps: 100, ...overrides,
  };
}

function liveSwap(delivered: bigint) {
  return vi.fn(async ({ amount, recipient }: any) => {
    held += delivered;
    return {
      operationId: 'DLBUSD-SWAP-1', amount, recipient, mode: 'live', amountOut: amount, mintTxHash: '0xmint',
      swap: { txHash: '0xleg1', amountOut: '0.1' }, usdcSwap: { txHash: '0xusdc', amountOut: amount }, poolAddress: '0xpool',
    };
  });
}

beforeEach(() => {
  held = 0n;
  process.env.DAPP_MEMORY_MODE = 'true';
  process.env.THIRDWEB_SERVER_WALLET_ADDRESS = TREASURY;
  process.env.THIRDWEB_SERVER_WALLET_CHAIN_ID = '8453';
  process.env.THIRDWEB_SETTLEMENT_TOKEN = USDC;
  process.env.TREASURY_TOPUP_HOLD_SOURCE_TYPE = 'trust';
  process.env.TREASURY_TOPUP_HOLD_ACCOUNT_ID = '1000';

  vi.spyOn(ThirdwebServerWalletEngine, 'fundingStatus').mockImplementation(async ({ chainId, tokenAddress = null }: any) => ({
    address: TREASURY, chainId: Number(chainId || 8453), tokenAddress,
    gas: { symbol: 'ETH', held: '0', required: '0', sufficient: true },
    asset: { symbol: 'USDC', decimals: 6, held: held.toString(), required: '0', sufficient: true },
    funded: true,
  }));
  vi.spyOn(ThirdwebPriceOracle, 'getPrice').mockResolvedValue({ symbol: 'USDC', decimals: 6, priceUsd: 1 } as any);
  vi.spyOn(ThirdwebPriceOracle, 'quoteUsd').mockImplementation(async ({ quantity }: any) => ({ amountUsd: Number(BigInt(quantity) / 10000n) / 100, priceUsd: 1, symbol: 'USDC', decimals: 6 }));
  vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ id: 'je-1' } as any);
  vi.spyOn(StablecoinDexEngine, 'getConfig').mockReturnValue(dexConfig());
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe('TreasuryDepositEngine.fund (internal 1:1 swap)', () => {
  it('reports the swap rail closed while StablecoinDexEngine is in shadow', () => {
    vi.spyOn(StablecoinDexEngine, 'getConfig').mockReturnValue(dexConfig({ shadow: true }));
    const r = TreasuryDepositEngine.fundReadiness();
    expect(r.canFund).toBe(false);
    expect(r.mode).toBe('shadow');
    expect(r.issues.join(' ')).toMatch(/shadow mode/);
  });

  it('happy path: mints + swaps the outstanding USDC to the deposit address, syncs and books exactly once', async () => {
    const swap = liveSwap(250_000_000n);
    vi.spyOn(StablecoinDexEngine, 'depositAndSwap').mockImplementation(swap);
    const deposit = await TreasuryDepositEngine.declare({ amount: '250', tokenAddress: USDC });

    const out = await TreasuryDepositEngine.fund(deposit.id, {});
    expect(out.funded).toBe(true);
    expect(out.code).toBe('CREDITED');
    expect(swap).toHaveBeenCalledTimes(1);
    expect(swap.mock.calls[0][0]).toMatchObject({ sourceType: 'trust', sourceAccountId: '1000', amount: '250', targetAsset: 'USDC', recipient: TREASURY });
    expect(out.swap).toMatchObject({ txHash: '0xusdc', mode: 'live', amount: '250' });
    expect(out.deposit).toMatchObject({ status: 'credited', booked: true, creditedQuantity: '250000000', amountUsd: 250 });
    expect(TrustAccountingEngine.postJournalEntry).toHaveBeenCalledTimes(1);
    const entry = (TrustAccountingEngine.postJournalEntry as any).mock.calls[0][0];
    expect(entry.lines[0]).toMatchObject({ accountCode: '1210', debitAmount: 250 });
    expect(entry.lines[1]).toMatchObject({ accountCode: '1000', creditAmount: 250 });

    // Idempotent: a second fund swaps nothing and never re-books.
    const again = await TreasuryDepositEngine.fund(deposit.id, {});
    expect(again.funded).toBe(false);
    expect(again.code).toBe('ALREADY_CREDITED');
    expect(again.idempotent).toBe(true);
    expect(swap).toHaveBeenCalledTimes(1);
    expect(TrustAccountingEngine.postJournalEntry).toHaveBeenCalledTimes(1);
    expect((await TreasuryDepositEngine.sync(deposit.id)).booked).toBe(true);
    expect(TrustAccountingEngine.postJournalEntry).toHaveBeenCalledTimes(1);
  });

  it('request body source overrides the hold-account defaults and only the outstanding remainder is swapped', async () => {
    held = 100_000_000n;
    const deposit = await TreasuryDepositEngine.declare({ amount: '250', tokenAddress: USDC });
    held = 140_000_000n; // 40 arrived externally
    await TreasuryDepositEngine.sync(deposit.id);
    const swap = liveSwap(210_000_000n);
    vi.spyOn(StablecoinDexEngine, 'depositAndSwap').mockImplementation(swap);

    const out = await TreasuryDepositEngine.fund(deposit.id, { sourceType: 'cash', sourceAccountId: 'CA-BOND-PROCEEDS' });
    expect(swap.mock.calls[0][0]).toMatchObject({ sourceType: 'cash', sourceAccountId: 'CA-BOND-PROCEEDS', amount: '210' });
    expect(out.funded).toBe(true);
    expect(out.deposit.creditedQuantity).toBe('250000000');
  });

  it('shadow DEX: returns a non-success actionable result, swaps nothing and books nothing', async () => {
    vi.spyOn(StablecoinDexEngine, 'getConfig').mockReturnValue(dexConfig({ shadow: true }));
    const swap = vi.spyOn(StablecoinDexEngine, 'depositAndSwap');
    const deposit = await TreasuryDepositEngine.declare({ amount: '250', tokenAddress: USDC });

    const out = await TreasuryDepositEngine.fund(deposit.id, {});
    expect(out.funded).toBe(false);
    expect(out.code).toBe('STABLECOIN_DEX_NOT_LIVE');
    expect(out.message).toMatch(/shadow mode/);
    expect(out.message).toMatch(/Nothing was minted, swapped or booked/);
    expect(swap).not.toHaveBeenCalled();
    expect(TrustAccountingEngine.postJournalEntry).not.toHaveBeenCalled();
    expect((await TreasuryDepositEngine.get(deposit.id))).toMatchObject({ status: 'expected', booked: false });
  });

  it('disabled DEX: same fail-closed result', async () => {
    vi.spyOn(StablecoinDexEngine, 'getConfig').mockReturnValue(dexConfig({ enabled: false }));
    const swap = vi.spyOn(StablecoinDexEngine, 'depositAndSwap');
    const deposit = await TreasuryDepositEngine.declare({ amount: '10', tokenAddress: USDC });
    const out = await TreasuryDepositEngine.fund(deposit.id, {});
    expect(out).toMatchObject({ funded: false, code: 'STABLECOIN_DEX_NOT_LIVE' });
    expect(out.message).toMatch(/STABLECOIN_DEX_ENABLED/);
    expect(swap).not.toHaveBeenCalled();
    expect(TrustAccountingEngine.postJournalEntry).not.toHaveBeenCalled();
  });

  it('a swap that comes back in shadow mode or without a live txHash never claims success', async () => {
    vi.spyOn(StablecoinDexEngine, 'depositAndSwap').mockResolvedValue({ operationId: 'DLBUSD-SWAP-2', mode: 'shadow', swap: { txHash: 'shadow-dex-1' }, amountOut: '10' } as any);
    const deposit = await TreasuryDepositEngine.declare({ amount: '10', tokenAddress: USDC });
    const out = await TreasuryDepositEngine.fund(deposit.id, {});
    expect(out).toMatchObject({ funded: false, code: 'SWAP_NOT_LIVE' });
    expect(TrustAccountingEngine.postJournalEntry).not.toHaveBeenCalled();
    expect((await TreasuryDepositEngine.get(deposit.id)).status).toBe('expected');
  });

  it('refuses a non-USDC deposit, a cancelled deposit and a missing source', async () => {
    const eth = await TreasuryDepositEngine.declare({ amount: '0.01', tokenAddress: null });
    vi.spyOn(ThirdwebPriceOracle, 'getPrice').mockResolvedValue({ symbol: 'ETH', decimals: 18, priceUsd: 3000 } as any);
    await expect(TreasuryDepositEngine.fund(eth.id, {})).rejects.toMatchObject({ code: 'ASSET_MISMATCH' });

    const cancelled = await TreasuryDepositEngine.declare({ amount: '1', tokenAddress: USDC });
    await TreasuryDepositEngine.cancel(cancelled.id);
    await expect(TreasuryDepositEngine.fund(cancelled.id, {})).rejects.toMatchObject({ code: 'DEPOSIT_NOT_OPEN' });

    delete process.env.TREASURY_TOPUP_HOLD_ACCOUNT_ID;
    const open = await TreasuryDepositEngine.declare({ amount: '1', tokenAddress: USDC });
    await expect(TreasuryDepositEngine.fund(open.id, {})).rejects.toMatchObject({ code: 'SOURCE_REQUIRED' });
    await expect(TreasuryDepositEngine.fund('TWDEP-missing', {})).rejects.toMatchObject({ status: 404 });
  });
});

describe('LiveValueRunbookOsEngine selfFund step', () => {
  const GATE_KEYS = [
    'thirdwebApi', 'serverWallet', 'serverWalletLive', 'thirdwebShadow', 'gasSponsorship', 'canonicalFunding',
    'smartRouter', 'trustPolicy', 'signer', 'collateralOs', 'settlementReconcile', 'treasuryEth', 'treasuryUsdc', 'fundingEligible',
  ];
  const LIVE_ENV = {
    THIRDWEB_SECRET_KEY: 'test-secret', THIRDWEB_SERVER_WALLET_ENABLED: 'true', THIRDWEB_SERVER_WALLET_LIVE: 'true',
    THIRDWEB_SHADOW: 'false', CANONICAL_FUNDING_LIVE: 'true', TRUST_POLICY_ENFORCED: 'true', TRUST_POLICY_LIVE: 'true',
  };

  function deps(fundResult: any) {
    const d: any = {
      TreasuryFunding: { createTopUp: vi.fn(async () => ({ id: 'TWTOP-1', status: 'PENDING', link: 'https://pay/1' })), syncTopUp: vi.fn(), openTopUps: vi.fn(async () => []) },
      TreasuryDeposit: {
        fundReadiness: vi.fn(() => ({ canFund: true, sourceType: 'trust', sourceAccountId: '1000', issues: [] })),
        list: vi.fn(async () => []),
        declare: vi.fn(async ({ amount }: any) => ({ id: 'TWDEP-1', expectedQuantity: String(Number(amount) * 1e6), decimals: 6, tokenAddress: USDC })),
        fund: vi.fn(async () => fundResult),
      },
      ServerWallet: { send: vi.fn() }, Settlement: { reconcile: vi.fn(async () => ({})) }, Funding: { executePlan: vi.fn(), buildPlan: vi.fn() },
      Collateral: { draw: vi.fn(), reconcile: vi.fn(async () => ({ draws: [] })), settle: vi.fn(), executeSettlement: vi.fn(), draws: vi.fn(async () => []), facility: vi.fn(async () => { throw new Error('no facility'); }) },
      SpritzLeg: {}, ControlPlane: { evaluateDistribution: vi.fn(async () => ({ allowed: true, enforced: true, blocking: [] })) },
      GasTank: null, AccountAbstraction: null, ThirdwebWallet: null, CanonicalFunding: null, TrustPolicy: null, DappConfig: null,
    };
    vi.spyOn(LiveValueRunbookOsEngine, '_deps').mockReturnValue(d);
    vi.spyOn(LiveValueRunbookOsEngine, 'readinessFull').mockResolvedValue({
      ready: false, blocking: [], errors: [], treasury: { address: TREASURY, eth: 1, usdc: 0, fundingEligible: true },
      stages: GATE_KEYS.map((key) => ({ key, label: key, ok: key !== 'treasuryUsdc', detail: 'ok', blocking: true })),
    } as any);
    return d;
  }

  it('plan puts selfFund before the fiat checkout and makes the manual send the last resort', async () => {
    deps(null);
    const plan = await LiveValueRunbookOsEngine.plan({ amountUsd: 250 });
    const keys = plan.steps.map((s: any) => s.key);
    expect(keys.indexOf('selfFund')).toBeLessThan(keys.indexOf('topUp'));
    const byKey = Object.fromEntries(plan.steps.map((s: any) => [s.key, s]));
    expect(byKey.selfFund).toMatchObject({ canExecute: true, section: '§4a-alt', source: { sourceType: 'trust', sourceAccountId: '1000' } });
    expect(byKey.topUp.note).toMatch(/^fallback when the internal swap/);
    expect(byKey.topUp.note).toMatch(/Last resort.*external wallet/);
  });

  it('live: self-funds via the internal swap, skips the hosted checkout and continues', async () => {
    Object.assign(process.env, LIVE_ENV);
    const d = deps({ funded: true, code: 'CREDITED', depositId: 'TWDEP-1', message: 'funded', swap: { txHash: '0xusdc' }, deposit: { status: 'credited', booked: true } });
    const out = await LiveValueRunbookOsEngine.execute({ amountUsd: 250, live: true, steps: ['preflight', 'selfFund', 'topUp', 'book'] });
    expect(d.TreasuryDeposit.declare).toHaveBeenCalledWith(expect.objectContaining({ amount: '250' }));
    expect(d.TreasuryDeposit.fund).toHaveBeenCalledWith('TWDEP-1', { sourceType: 'trust', sourceAccountId: '1000' });
    expect(d.TreasuryFunding.createTopUp).not.toHaveBeenCalled();
    const byKey = Object.fromEntries(out.results.map((r: any) => [r.key, r]));
    expect(byKey.selfFund.status).toBe('done');
    expect(byKey.topUp.status).toBe('skipped');
    expect(byKey.book.status).toBe('skipped');
    expect(out.moved).toBe(true);
  });

  it('live: a closed swap rail falls through to the hosted checkout instead of claiming funding', async () => {
    Object.assign(process.env, LIVE_ENV);
    const d = deps({ funded: false, code: 'STABLECOIN_DEX_NOT_LIVE', depositId: 'TWDEP-1', message: 'internal swap rail unavailable: shadow' });
    const out = await LiveValueRunbookOsEngine.execute({ amountUsd: 250, live: true, steps: ['preflight', 'selfFund', 'topUp'] });
    const byKey = Object.fromEntries(out.results.map((r: any) => [r.key, r]));
    expect(byKey.selfFund.status).toBe('skipped');
    expect(byKey.selfFund.message).toMatch(/STABLECOIN_DEX_NOT_LIVE/);
    expect(d.TreasuryFunding.createTopUp).toHaveBeenCalledTimes(1);
    expect(out.stoppedAt).toMatchObject({ key: 'topUp', human: true });
    expect(out.moved).toBe(false);
  });

  it('shadow run never calls fund', async () => {
    const d = deps(null);
    const out = await LiveValueRunbookOsEngine.execute({ amountUsd: 250 });
    expect(d.TreasuryDeposit.fund).not.toHaveBeenCalled();
    expect(d.TreasuryDeposit.declare).not.toHaveBeenCalled();
    expect(out.results.find((r: any) => r.key === 'selfFund').status).toBe('shadow');
  });
});
