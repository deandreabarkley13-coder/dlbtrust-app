import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const OPERATOR = '0x3e53028cf69949f3B961ce786Baf2D4D75166562';

process.env.DAPP_MEMORY_MODE = 'true';
process.env.DAPP_SHADOW = 'false';
process.env.DAPP_SIGNER = '';
process.env.DAPP_PRIVATE_KEY = '0x' + '11'.repeat(32);
process.env.DAPP_OPERATOR_ADDRESS = OPERATOR;
process.env.DAPP_RPC_URL = process.env.DAPP_RPC_URL || 'http://127.0.0.1:8545';

const { TreasuryOnRampBridgeEngine } = require('../server/integrations/dapp/treasuryOnRampBridgeEngine');
const { CoinbaseTreasuryBridge } = require('../server/integrations/dapp/coinbaseTreasuryBridge');
const { SkrillLinkEngine } = require('../server/integrations/payments/skrillLinkEngine');
const { FundingEngine } = require('../server/integrations/dapp/fundingEngine');
const { StablecoinDexEngine } = require('../server/integrations/dapp/stablecoinDexEngine');
const { ModuleFundingEngine } = require('../server/integrations/dapp/moduleFundingEngine');
const pool = require('../server/integrations/bonds/pgPool');

const saved = { ...process.env };
const writes: Array<{ sql: string; params: unknown[] }> = [];

function baseStatus(eth: string, overrides: Record<string, unknown> = {}) {
  return {
    operator: { address: OPERATOR, eth, wei: '0', weth: '0', usdc: '0' },
    coldStart: Number(eth) < 0.003,
    externalWallet: null,
    hedera: null,
    pool: { address: '0xpool', exists: true, dlbusd: '100', target: '1', dlbusdTokenAddress: '0xdlbusd' },
    sourceBalances: [],
    rails: {
      operator_gas_tank: { ready: false },
      stablecoin_dex: { ready: true, issues: [] },
      coinbase_treasury: { ready: true, connected: true },
      coinbase_spot: { ready: true, connected: true },
      cashapp: { ready: false, issues: ['no cashtag'] },
      googlewallet: { ready: false, issues: [] },
      skrill: TreasuryOnRampBridgeEngine.skrillReadiness(),
    },
    neededEthForFirstTx: '0.003',
    neededWethToSeedPool: 100,
    ...overrides,
  };
}

beforeEach(() => {
  writes.length = 0;
  vi.spyOn(pool, 'query').mockImplementation(async (sql: string, params: unknown[] = []) => {
    writes.push({ sql, params });
    return { rows: [], rowCount: 0 };
  });
  vi.spyOn(CoinbaseTreasuryBridge, 'enabled').mockReturnValue(true);
  delete process.env.SKRILL_MERCHANT_EMAIL;
  delete process.env.SKRILL_API_PASSWORD;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...saved };
});

const op = { id: 'TORB-OP-1', stage: 'on_ramp', sourceMethod: 'skrill', sourceType: 'treasury', sourceAccountId: 'TREASURY_HOT', amount: 100, targetAsset: 'ETH' };

describe('SkrillLinkEngine.readiness', () => {
  it('names the missing keys without printing values', () => {
    expect(SkrillLinkEngine.readiness()).toMatchObject({ ready: false, missing: ['SKRILL_MERCHANT_EMAIL', 'SKRILL_API_PASSWORD'], capabilities: { bankWithdrawal: false } });
    process.env.SKRILL_MERCHANT_EMAIL = 'ops@example.com';
    process.env.SKRILL_API_PASSWORD = 'super-secret-pw';
    const r = SkrillLinkEngine.readiness();
    expect(r).toMatchObject({ ready: true, missing: [] });
    expect(JSON.stringify(r)).not.toMatch(/super-secret-pw|ops@example\.com/);
  });
});

describe('treasury on-ramp skrill source method', () => {
  it('quote reports needs_config with the missing key names when Skrill is unconfigured', async () => {
    const q = await TreasuryOnRampBridgeEngine.quote({ sourceType: 'treasury', sourceAccountId: 'TREASURY_HOT', amount: 100, sourceMethod: 'skrill', targetAsset: 'ETH' });
    expect(q.status).toBe('needs_config');
    expect(q.onRampReady).toMatchObject({ method: 'skrill', ready: false, missing: ['SKRILL_MERCHANT_EMAIL', 'SKRILL_API_PASSWORD'], manualWithdrawal: true });
    expect(q.instructions).toMatchObject({ mode: 'manual_withdrawal' });
  });

  it('_stageOnRamp returns needs_config and never delegates to Coinbase when credentials are missing', async () => {
    const stage = vi.spyOn(CoinbaseTreasuryBridge, 'stageFromSource');
    const res = await TreasuryOnRampBridgeEngine._stageOnRamp(op, {});
    expect(res).toMatchObject({ status: 'needs_config', stage: 'on_ramp', missing: ['SKRILL_MERCHANT_EMAIL', 'SKRILL_API_PASSWORD'] });
    expect(res.instructions).toMatch(/SKRILL_MERCHANT_EMAIL and SKRILL_API_PASSWORD/);
    expect(stage).not.toHaveBeenCalled();
  });

  it('happy path: manual withdrawal instructions plus Coinbase delegation to the operator', async () => {
    process.env.SKRILL_MERCHANT_EMAIL = 'ops@example.com';
    process.env.SKRILL_API_PASSWORD = 'super-secret-pw';
    const stage = vi.spyOn(CoinbaseTreasuryBridge, 'stageFromSource').mockResolvedValue({ id: 'CBTB-1', status: 'needs_deposit' });
    vi.spyOn(TreasuryOnRampBridgeEngine, '_sourceBalance').mockResolvedValue(25000);

    const q = await TreasuryOnRampBridgeEngine.quote({ sourceType: 'treasury', sourceAccountId: 'TREASURY_HOT', amount: 100, sourceMethod: 'skrill', targetAsset: 'ETH' });
    expect(q.status).toBe('awaiting_skrill_withdrawal');

    const res = await TreasuryOnRampBridgeEngine._stageOnRamp(op, {});
    expect(stage).toHaveBeenCalledWith({ sourceType: 'treasury', sourceAccountId: 'TREASURY_HOT', amount: 100, targetAsset: 'ETH', targetNetwork: 'ethereum', targetAddress: OPERATOR });
    expect(res).toMatchObject({ status: 'awaiting_skrill_withdrawal', stage: 'canonical_swap', withdrawalMode: 'manual', transfer: { id: 'CBTB-1' } });
    expect(res.instructions.message).toMatch(/Manually withdraw 100\.00 USD from the Skrill wallet/);
    expect(res.instructions.message).toContain(OPERATOR);
    expect(res.instructions.doNot.join(' ')).toMatch(/no-op self-transfer/);
    expect(res.instructions.doNot.join(' ')).toMatch(/pay-in only/);
    expect(res.instructions.doNot.join(' ')).toMatch(/Do not originate a bank wire/);
    expect(JSON.stringify(res)).not.toMatch(/super-secret-pw/);

    const update = writes.find(w => /UPDATE treasury_on_ramp_operations SET stage='canonical_swap'/.test(w.sql));
    expect(update).toBeTruthy();
    expect(update!.params[0]).toBe('awaiting_skrill_withdrawal');
    expect(update!.params[3]).toBe('TORB-OP-1');
  });
});

describe('FundingEngine cold-start ordering', () => {
  it('0-ETH operator: skrill/Coinbase on-ramp runs and the DEX rail is never attempted', async () => {
    process.env.SKRILL_MERCHANT_EMAIL = 'ops@example.com';
    process.env.SKRILL_API_PASSWORD = 'super-secret-pw';
    vi.spyOn(FundingEngine, 'getStatus').mockResolvedValue(baseStatus('0'));
    const dex = vi.spyOn(StablecoinDexEngine, 'depositAndSwap');
    const stage = vi.spyOn(CoinbaseTreasuryBridge, 'stageFromSource').mockResolvedValue({ id: 'CBTB-2', status: 'needs_deposit' });

    const plan = await FundingEngine.buildPlan({ amountUsd: 100, sourceType: 'treasury', sourceAccountId: 'TREASURY_HOT', strategy: 'auto' });
    expect(plan.canExecute).toBe(true);
    expect(plan.steps[0].step).toBe('skrill_manual_withdrawal');

    const res = await FundingEngine.executePlan({ amountUsd: 100, sourceType: 'treasury', sourceAccountId: 'TREASURY_HOT', strategy: 'auto' });
    expect(dex).not.toHaveBeenCalled();
    expect(stage).toHaveBeenCalledTimes(1);
    expect(stage.mock.calls[0][0]).toMatchObject({ targetAddress: OPERATOR, targetNetwork: 'ethereum', amount: 100 });
    expect(res.executed).toHaveLength(1);
    expect(res.executed[0]).toMatchObject({ rail: 'skrill', result: { status: 'awaiting_skrill_withdrawal', withdrawalMode: 'manual' } });
  });

  it('0-ETH operator without Skrill: Coinbase first, DEX skipped with a reason', async () => {
    vi.spyOn(FundingEngine, 'getStatus').mockResolvedValue(baseStatus('0'));
    const dex = vi.spyOn(StablecoinDexEngine, 'depositAndSwap');
    vi.spyOn(ModuleFundingEngine, 'fundExternalRail');
    const stage = vi.spyOn(CoinbaseTreasuryBridge, 'stageFromSource').mockRejectedValue(new Error('Coinbase account holds no USD'));

    const res = await FundingEngine.executePlan({ amountUsd: 100, sourceType: 'treasury', sourceAccountId: 'TREASURY_HOT', strategy: 'auto' });
    expect(dex).not.toHaveBeenCalled();
    expect(stage).toHaveBeenCalledTimes(1);
    expect(res.executed.find((r: any) => r.rail === 'skrill')).toMatchObject({ result: { status: 'needs_config' } });
    const rails = res.executed.map((r: any) => r.rail);
    expect(rails.indexOf('skrill')).toBeLessThan(rails.indexOf('coinbase_treasury'));
    expect(rails.indexOf('coinbase_treasury')).toBeLessThan(rails.indexOf('stablecoin_dex'));
    expect(res.executed.find((r: any) => r.rail === 'stablecoin_dex')).toMatchObject({ skipped: true });
  });

  it('strategy=skrill with missing credentials builds a needs_config plan and executes nothing', async () => {
    vi.spyOn(FundingEngine, 'getStatus').mockResolvedValue(baseStatus('0'));
    const stage = vi.spyOn(CoinbaseTreasuryBridge, 'stageFromSource');
    const res = await FundingEngine.executePlan({ amountUsd: 100, sourceType: 'treasury', sourceAccountId: 'TREASURY_HOT', strategy: 'skrill' });
    expect(res.canExecute).toBe(false);
    expect(res.steps.some((s: any) => s.step === 'skrill_needs_config' && /SKRILL_MERCHANT_EMAIL and SKRILL_API_PASSWORD/.test(s.message))).toBe(true);
    expect(res.executed).toEqual([]);
    expect(stage).not.toHaveBeenCalled();
  });

  it('funded operator keeps the DEX-first behavior', async () => {
    vi.spyOn(FundingEngine, 'getStatus').mockResolvedValue(baseStatus('0.05'));
    const dex = vi.spyOn(StablecoinDexEngine, 'depositAndSwap').mockResolvedValue({ txHash: '0xswap' });
    const stage = vi.spyOn(CoinbaseTreasuryBridge, 'stageFromSource');

    const res = await FundingEngine.executePlan({ amountUsd: 100, sourceType: 'treasury', sourceAccountId: 'TREASURY_HOT', strategy: 'auto' });
    expect(dex).toHaveBeenCalledTimes(1);
    expect(stage).not.toHaveBeenCalled();
    expect(res.executed).toEqual([{ rail: 'stablecoin_dex', result: { txHash: '0xswap' } }]);
  });
});
