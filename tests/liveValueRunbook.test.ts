import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

process.env.DAPP_MEMORY_MODE = 'true';

const { LiveValueRunbookOsEngine } = require('../server/integrations/os/liveValueRunbookOsEngine');
const { LiveValueRunbookOSEngine, engines } = require('../server/integrations/os/osEngine');

const saved = { ...process.env };

const GATE_KEYS = [
  'thirdwebApi', 'serverWallet', 'serverWalletLive', 'thirdwebShadow', 'gasSponsorship', 'canonicalFunding',
  'smartRouter', 'trustPolicy', 'signer', 'collateralOs', 'settlementReconcile', 'treasuryEth', 'treasuryUsdc', 'fundingEligible',
];

const LIVE_ENV = {
  THIRDWEB_SECRET_KEY: 'test-secret',
  THIRDWEB_SERVER_WALLET_ENABLED: 'true',
  THIRDWEB_SERVER_WALLET_LIVE: 'true',
  THIRDWEB_SHADOW: 'false',
  CANONICAL_FUNDING_LIVE: 'true',
  TRUST_POLICY_ENFORCED: 'true',
  TRUST_POLICY_LIVE: 'true',
};

/** A plan where the treasury is empty, so §4a is the first executable step. */
function topUpPlan(amountUsd: number) {
  return {
    amountUsd, role: 'beneficiary', purpose: null, bucket: 'coupon_income', reference: 'LVR-TEST', mode: 'live',
    liveGates: { open: true, closed: [] }, ready: false, executable: ['preflight', 'topUp'],
    steps: [
      { key: 'preflight', section: '§2', label: 'pre-flight', canExecute: true, human: false, skip: false, reason: null, requires: [] },
      { key: 'topUp', section: '§4a', label: 'Fund the treasury wallet', canExecute: true, human: false, humanAfter: true, skip: false, reason: null, requires: [], amountUsd },
      { key: 'book', section: '§4b', label: 'Book', canExecute: false, human: false, skip: false, reason: 'waits for §4a', requires: ['CANONICAL_FUNDING_LIVE'] },
      { key: 'gas', section: '§4', label: 'Gas', canExecute: false, human: false, skip: false, reason: 'FUNDING_LIVE not set', requires: ['FUNDING_LIVE'] },
      { key: 'draw', section: '§4c', label: 'Draw', canExecute: true, human: false, skip: false, reason: null, requires: ['CANONICAL_FUNDING_LIVE'] },
      { key: 'fund', section: '§4c', label: 'Checker approves', canExecute: false, human: true, skip: false, reason: 'checker approval', requires: [] },
      { key: 'settle', section: '§4e', label: 'Settle', canExecute: true, human: false, skip: false, reason: null, requires: ['THIRDWEB_SERVER_WALLET_LIVE', 'TRUST_POLICY_LIVE'] },
      { key: 'release', section: '§4e', label: 'Checker approves distribution', canExecute: false, human: true, skip: false, reason: 'checker approval', requires: [] },
      { key: 'reconcile', section: '§4', label: 'Reconcile', canExecute: true, human: false, skip: false, reason: null, requires: [] },
    ],
    firstBlocked: { key: 'book', section: '§4b', human: false, reason: 'waits for §4a' },
    readiness: { ready: false, blocking: [], errors: [], treasury: { eth: 0, usdc: 0 } },
    generatedAt: new Date().toISOString(),
  };
}

function fakeDeps() {
  return {
    TreasuryFunding: {
      createTopUp: vi.fn(async ({ amountFiat }: any) => ({ id: 'TWTOP-1', status: 'PENDING', amountFiat, link: 'https://pay.thirdweb.com/checkout/TWTOP-1' })),
      syncTopUp: vi.fn(), syncOpen: vi.fn(), openTopUps: vi.fn(async () => []),
    },
    ServerWallet: { send: vi.fn(), readiness: vi.fn() },
    Settlement: { reconcile: vi.fn(async () => ({ reconciled: 0 })) },
    Funding: { executePlan: vi.fn(), buildPlan: vi.fn() },
    Collateral: { draw: vi.fn(), reconcile: vi.fn(), settle: vi.fn(), executeSettlement: vi.fn(), draws: vi.fn(async () => []) },
    SpritzLeg: { stagePayout: vi.fn(), executePayout: vi.fn() },
    ControlPlane: { evaluateDistribution: vi.fn() },
    GasTank: null, AccountAbstraction: null, ThirdwebWallet: null, CanonicalFunding: null, TrustPolicy: null, DappConfig: null,
  };
}

function movers(d: ReturnType<typeof fakeDeps>) {
  return [
    d.TreasuryFunding.createTopUp, d.TreasuryFunding.syncTopUp, d.TreasuryFunding.syncOpen,
    d.ServerWallet.send, d.Funding.executePlan, d.Collateral.draw, d.Collateral.settle, d.Collateral.executeSettlement,
    d.SpritzLeg.stagePayout, d.SpritzLeg.executePayout, d.Settlement.reconcile,
  ];
}

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (/^(THIRDWEB_|TRUST_POLICY_|CANONICAL_FUNDING_|SMART_ROUTER_|FUNDING_LIVE|SPRITZ_|COLLATERAL_)/.test(k)) delete process.env[k];
  }
  process.env.DAPP_MEMORY_MODE = 'true';
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe('LiveValueRunbookOsEngine.readiness', () => {
  it('lists every runbook gate and flags unconfigured ones without throwing', () => {
    const r = LiveValueRunbookOsEngine.readiness();
    expect(r.engine).toBe('live-value-runbook');
    expect(r.evaluated).toBe('config');
    expect(r.mode).toBe('shadow');
    expect(r.ready).toBe(false);
    expect(r.stages.map((s: any) => s.key)).toEqual(GATE_KEYS);
    for (const s of r.stages) {
      expect(s).toMatchObject({ key: expect.any(String), label: expect.any(String), ok: expect.any(Boolean), blocking: expect.any(Boolean) });
      expect(s.detail).toEqual(expect.any(String));
    }
    const byKey = Object.fromEntries(r.stages.map((s: any) => [s.key, s]));
    expect(byKey.thirdwebApi.ok).toBe(false);
    expect(byKey.thirdwebApi.detail).toMatch(/THIRDWEB_SECRET_KEY not configured/);
    expect(byKey.serverWallet.detail).toMatch(/THIRDWEB_SERVER_WALLET_ADDRESS not pinned/);
    expect(byKey.trustPolicy.detail).toMatch(/TRUST_POLICY_ADDRESS not configured/);
    expect(byKey.serverWalletLive).toMatchObject({ ok: false, blocking: false, gate: 'THIRDWEB_SERVER_WALLET_LIVE' });
    expect(byKey.treasuryEth.evaluated).toBe('config');
    expect(r.blocking).toEqual(expect.arrayContaining(['thirdwebApi', 'serverWallet', 'trustPolicy', 'signer', 'treasuryEth', 'fundingEligible']));
    expect(r.gates).toMatchObject({
      SMART_ROUTER_LIVE: false, THIRDWEB_SERVER_WALLET_LIVE: false, THIRDWEB_SHADOW: true, THIRDWEB_GAS_SPONSORSHIP_LIVE: false,
      CANONICAL_FUNDING_LIVE: false, TRUST_POLICY_ENFORCED: false, TRUST_POLICY_LIVE: false, THIRDWEB_SECRET_KEY: false,
    });
    expect(r.liveGates.open).toBe(false);
    expect(r.liveGates.closed).toEqual(expect.arrayContaining(['THIRDWEB_SECRET_KEY', 'THIRDWEB_SERVER_WALLET_LIVE', 'THIRDWEB_SHADOW=false', 'CANONICAL_FUNDING_LIVE']));
    expect(JSON.stringify(r)).not.toMatch(/test-secret/);
  });

  it('flags TRUST_POLICY_ENFORCED without TRUST_POLICY_LIVE as a blocking misconfiguration', () => {
    process.env.TRUST_POLICY_ENFORCED = 'true';
    process.env.TRUST_POLICY_ADDRESS = '0x000000000000000000000000000000000000dEaD';
    const r = LiveValueRunbookOsEngine.readiness();
    const policy = r.stages.find((s: any) => s.key === 'trustPolicy');
    expect(policy.ok).toBe(false);
    expect(policy.detail).toMatch(/enforced without live/);
    expect(r.liveGates.closed).toContain('TRUST_POLICY_LIVE');
  });

  it('never prints the secret value, only whether it is configured', () => {
    process.env.THIRDWEB_SECRET_KEY = 'super-secret-value';
    const r = LiveValueRunbookOsEngine.readiness();
    expect(r.gates.THIRDWEB_SECRET_KEY).toBe(true);
    expect(JSON.stringify(r)).not.toContain('super-secret-value');
  });
});

describe('LiveValueRunbookOsEngine.execute', () => {
  it('rejects a non-positive amount', async () => {
    await expect(LiveValueRunbookOsEngine.execute({ amountUsd: 0 })).rejects.toThrow(/positive USD amount/);
  });

  it('defaults to shadow and moves nothing even when the live gates are open', async () => {
    Object.assign(process.env, LIVE_ENV);
    const d = fakeDeps();
    vi.spyOn(LiveValueRunbookOsEngine, '_deps').mockReturnValue(d);
    vi.spyOn(LiveValueRunbookOsEngine, 'plan').mockResolvedValue(topUpPlan(250));

    const out = await LiveValueRunbookOsEngine.execute({ amountUsd: 250 });
    expect(out.mode).toBe('shadow');
    expect(out.live).toBe(false);
    expect(out.moved).toBe(false);
    expect(out.shadowReason).toMatch(/live=false/);
    for (const fn of movers(d)) expect(fn).not.toHaveBeenCalled();
    expect(out.results.find((r: any) => r.key === 'preflight').status).toBe('shadow');
    expect(out.stoppedAt).toMatchObject({ key: 'topUp', section: '§4a', human: true });
    expect(out.message).toMatch(/Nothing was created/);
  });

  it('stays shadow when live=true but a gate is closed, naming the gate', async () => {
    Object.assign(process.env, LIVE_ENV, { THIRDWEB_SERVER_WALLET_LIVE: 'false' });
    const d = fakeDeps();
    vi.spyOn(LiveValueRunbookOsEngine, '_deps').mockReturnValue(d);
    vi.spyOn(LiveValueRunbookOsEngine, 'plan').mockResolvedValue(topUpPlan(250));

    const out = await LiveValueRunbookOsEngine.execute({ amountUsd: 250, live: true });
    expect(out.mode).toBe('shadow');
    expect(out.liveRequested).toBe(true);
    expect(out.shadowReason).toMatch(/THIRDWEB_SERVER_WALLET_LIVE/);
    for (const fn of movers(d)) expect(fn).not.toHaveBeenCalled();
  });

  it('live: creates the §4a top-up, stops at the hosted checkout with an actionable message and touches nothing else', async () => {
    Object.assign(process.env, LIVE_ENV);
    const d = fakeDeps();
    vi.spyOn(LiveValueRunbookOsEngine, '_deps').mockReturnValue(d);
    vi.spyOn(LiveValueRunbookOsEngine, 'plan').mockResolvedValue(topUpPlan(250));

    const out = await LiveValueRunbookOsEngine.execute({ amountUsd: 250, live: true });
    expect(out.mode).toBe('live');
    expect(d.TreasuryFunding.createTopUp).toHaveBeenCalledTimes(1);
    expect(d.TreasuryFunding.createTopUp.mock.calls[0][0]).toMatchObject({ amountFiat: 250 });
    expect(out.completed).toBe(false);
    expect(out.stoppedAt).toMatchObject({ key: 'topUp', section: '§4a', human: true });
    expect(out.message).toMatch(/trustee must complete the hosted checkout https:\/\/pay\.thirdweb\.com\/checkout\/TWTOP-1/);
    expect(out.message).toMatch(/TWTOP-1/);
    expect(out.moved).toBe(false);
    const statuses = Object.fromEntries(out.results.map((r: any) => [r.key, r.status]));
    expect(statuses).toMatchObject({ preflight: 'done', book: 'pending', draw: 'pending', settle: 'pending', reconcile: 'pending' });
    for (const fn of movers(d).filter((f) => f !== d.TreasuryFunding.createTopUp)) expect(fn).not.toHaveBeenCalled();
    expect(d.ServerWallet.send).not.toHaveBeenCalled();
  });

  it('live: stops at the first closed gate instead of running past it', async () => {
    Object.assign(process.env, LIVE_ENV);
    const d = fakeDeps();
    vi.spyOn(LiveValueRunbookOsEngine, '_deps').mockReturnValue(d);
    const plan = topUpPlan(250);
    plan.steps[1] = { ...plan.steps[1], canExecute: false, reason: 'THIRDWEB_SECRET_KEY not configured' };
    vi.spyOn(LiveValueRunbookOsEngine, 'plan').mockResolvedValue(plan);

    const out = await LiveValueRunbookOsEngine.execute({ amountUsd: 250, live: true });
    expect(out.stoppedAt).toMatchObject({ key: 'topUp', human: false });
    expect(out.message).toMatch(/blocked at §4a topUp: THIRDWEB_SECRET_KEY not configured/);
    for (const fn of movers(d)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('LiveValueRunbookOSEngine (OS wrapper)', () => {
  it('is registered as live-value-runbook and answers status/readiness', async () => {
    expect(engines['live-value-runbook']).toBe(LiveValueRunbookOSEngine);
    const status = await LiveValueRunbookOSEngine.status();
    expect(status).toMatchObject({ engine: 'live-value-runbook', healthy: true, mode: 'shadow', ready: false });
    const readiness = await LiveValueRunbookOSEngine._process('readiness', {});
    expect(readiness.stages.map((s: any) => s.key)).toEqual(GATE_KEYS);
  });
});
