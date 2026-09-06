import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const { ThirdwebSponsorshipPolicy } = require('../server/integrations/dapp/thirdwebSponsorshipPolicy');
const pool = require('../server/integrations/bonds/pgPool');

const saved = { ...process.env };
const SENDER = '0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16';
const TARGET = '0x2222f2738BE6bB7aA0Bfe4AEeAf2908172CF5539';

/** A provisioned sender, no prior sponsored usage, tables already present. */
function mockDirectory({ provisioned = true, ops = 0, gasWei = '0' } = {}) {
  vi.spyOn(pool, 'query').mockImplementation(((sql: string) => {
    if (/FROM dapp_users/.test(sql)) return Promise.resolve({ rows: provisioned ? [{ '1': 1 }] : [], rowCount: provisioned ? 1 : 0 });
    if (/COUNT\(\*\)/.test(sql)) return Promise.resolve({ rows: [{ ops, gas_wei: gasWei }], rowCount: 1 });
    return Promise.resolve({ rows: [], rowCount: 0 });
  }) as any);
}

/** Rules-only view: strips the live-flag gate so rule outcomes are visible. */
function userOp(overrides: Record<string, unknown> = {}) {
  return { sender: SENDER, targets: [TARGET], gasLimit: '500000', gasPrice: '1000000000', ...overrides };
}

beforeEach(() => {
  ThirdwebSponsorshipPolicy._resetMemory();
  process.env.THIRDWEB_VERIFIER_SECRET = 'verifier-secret';
  process.env.DAPP_CHAIN_ID = '1';
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe('thirdweb server verifier authorization', () => {
  it('rejects requests when no verifier secret is configured', () => {
    delete process.env.THIRDWEB_VERIFIER_SECRET;
    expect(ThirdwebSponsorshipPolicy.authorize({}).ok).toBe(false);
  });

  it('rejects a wrong secret and accepts the configured one', () => {
    expect(ThirdwebSponsorshipPolicy.authorize({ 'x-thirdweb-verifier-secret': 'nope' }).ok).toBe(false);
    expect(ThirdwebSponsorshipPolicy.authorize({ 'x-thirdweb-verifier-secret': 'verifier-secret' }).ok).toBe(true);
  });
});

// The live flag is the last gate: rules may pass and sponsorship still be
// refused, because sponsored gas spends trust funds.
describe('sponsorship stays denied until it is live', () => {
  it('denies an otherwise-allowed operation while shadow is on', async () => {
    mockDirectory();
    const decision = await ThirdwebSponsorshipPolicy.evaluate({ chainId: 1, userOp: userOp() });
    expect(decision.wouldAllow).toBe(true);
    expect(decision.isAllowed).toBe(false);
    expect(decision.reason).toMatch(/not live/i);
  });

  it('allows it once shadow is off and sponsorship is live', async () => {
    mockDirectory();
    process.env.THIRDWEB_SHADOW = 'false';
    process.env.THIRDWEB_GAS_SPONSORSHIP_LIVE = 'true';
    const decision = await ThirdwebSponsorshipPolicy.evaluate({ chainId: 1, userOp: userOp() });
    expect(decision.isAllowed).toBe(true);
    expect(decision.shadow).toBe(false);
  });
});

describe('trust sponsorship rules', () => {
  beforeEach(() => {
    process.env.THIRDWEB_SHADOW = 'false';
    process.env.THIRDWEB_GAS_SPONSORSHIP_LIVE = 'true';
  });

  it('denies an operation with no sender', async () => {
    mockDirectory();
    const decision = await ThirdwebSponsorshipPolicy.evaluate({ chainId: 1, userOp: { targets: [TARGET] } });
    expect(decision.wouldAllow).toBe(false);
    expect(decision.reason).toMatch(/sender missing/);
  });

  it('denies chains outside the allowlist', async () => {
    mockDirectory();
    process.env.THIRDWEB_POLICY_CHAIN_IDS = '8453';
    const decision = await ThirdwebSponsorshipPolicy.evaluate({ chainId: 1, userOp: userOp() });
    expect(decision.wouldAllow).toBe(false);
    expect(decision.reason).toMatch(/chain 1 is not sponsored/);
  });

  it('denies a sender the trust never provisioned', async () => {
    mockDirectory({ provisioned: false });
    const decision = await ThirdwebSponsorshipPolicy.evaluate({ chainId: 1, userOp: userOp() });
    expect(decision.wouldAllow).toBe(false);
    expect(decision.reason).toMatch(/not a trust-provisioned/);
  });

  // An unreadable account directory must not widen the policy.
  it('denies when the provisioned-sender check cannot be answered', async () => {
    vi.spyOn(pool, 'query').mockRejectedValue(new Error('db down'));
    const decision = await ThirdwebSponsorshipPolicy.evaluate({ chainId: 1, userOp: userOp() });
    expect(decision.wouldAllow).toBe(false);
    expect(decision.reason).toMatch(/cannot verify/);
  });

  it('denies targets outside the contract allowlist, case-insensitively', async () => {
    mockDirectory();
    process.env.THIRDWEB_POLICY_ALLOWED_TARGETS = TARGET.toUpperCase();
    const allowed = await ThirdwebSponsorshipPolicy.evaluate({ chainId: 1, userOp: userOp() });
    expect(allowed.wouldAllow).toBe(true);

    const denied = await ThirdwebSponsorshipPolicy.evaluate({
      chainId: 1,
      userOp: userOp({ targets: ['0x1111111111111111111111111111111111111111'] }),
    });
    expect(denied.wouldAllow).toBe(false);
    expect(denied.reason).toMatch(/not allowlisted/);
  });

  it('reads targets from the batched userOp shape', async () => {
    mockDirectory();
    process.env.THIRDWEB_POLICY_ALLOWED_TARGETS = TARGET;
    const decision = await ThirdwebSponsorshipPolicy.evaluate({
      chainId: 1,
      userOp: { sender: SENDER, gasLimit: '500000', gasPrice: '1000000000', data: { targets: [TARGET], callDatas: [], values: [] } },
    });
    expect(decision.wouldAllow).toBe(true);
  });

  it('denies an operation over the per-operation gas ceiling', async () => {
    mockDirectory();
    process.env.THIRDWEB_POLICY_MAX_GAS_WEI_PER_OP = '1000';
    const decision = await ThirdwebSponsorshipPolicy.evaluate({ chainId: 1, userOp: userOp() });
    expect(decision.wouldAllow).toBe(false);
    expect(decision.reason).toMatch(/per-operation ceiling/);
  });

  it('denies a sender at the daily operation limit', async () => {
    mockDirectory({ ops: 25 });
    const decision = await ThirdwebSponsorshipPolicy.evaluate({ chainId: 1, userOp: userOp() });
    expect(decision.wouldAllow).toBe(false);
    expect(decision.reason).toMatch(/daily sponsored-operation limit/);
  });

  it('denies a sender whose daily gas budget would be exceeded by this operation', async () => {
    mockDirectory({ gasWei: '19999999999999999' });
    const decision = await ThirdwebSponsorshipPolicy.evaluate({ chainId: 1, userOp: userOp() });
    expect(decision.wouldAllow).toBe(false);
    expect(decision.reason).toMatch(/daily sponsored-gas budget/);
  });

  it('denies a clientId belonging to another project', async () => {
    mockDirectory();
    process.env.THIRDWEB_CLIENT_ID = 'ours';
    const decision = await ThirdwebSponsorshipPolicy.evaluate({ clientId: 'theirs', chainId: 1, userOp: userOp() });
    expect(decision.wouldAllow).toBe(false);
    expect(decision.reason).toMatch(/clientId/);
  });
});

describe('policy description and audit trail', () => {
  it('reports shadow enforcement and the verifier path', () => {
    const described = ThirdwebSponsorshipPolicy.describe();
    expect(described.enforcing).toBe(false);
    expect(described.verifierPath).toBe('/api/dapp/thirdweb/sponsorship/verify');
    expect(described.verifierSecretConfigured).toBe(true);
    expect(described.chainIds).toEqual([1]);
  });

  it('records every decision even when nothing is sponsored', async () => {
    mockDirectory();
    const decision = await ThirdwebSponsorshipPolicy.evaluate({ chainId: 1, userOp: userOp() });
    expect(decision.isAllowed).toBe(false);

    const insert = (pool.query as any).mock.calls
      .map((call: unknown[]) => call)
      .find(([sql]: [string]) => /INSERT INTO thirdweb_sponsorship_decisions/.test(sql));
    expect(insert).toBeDefined();
    const params = insert[1] as unknown[];
    expect(params[5]).toBe(false); // allowed
    expect(params[6]).toBe(true); // would_allow
  });
});
