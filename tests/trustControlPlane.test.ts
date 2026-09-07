import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

process.env.DAPP_MEMORY_MODE = 'true';

const { getMandate, PIPELINE_STAGES } = require('../server/integrations/trust/trustMandate');
const { TrustControlPlaneEngine } = require('../server/integrations/trust/trustControlPlaneEngine');
const { DistributionRequestEngine } = require('../server/integrations/dapp/distributionRequestEngine');
const { PayoutCenterEngine } = require('../server/integrations/dapp/payoutCenterEngine');
const { FabricLedgerEngine } = require('../server/integrations/hyperledger/fabricLedgerEngine');

const saved = { ...process.env };

const ok = (value: any) => ({ ok: true, value });
const down = (error: string) => ({ ok: false, error });

/** A snapshot where every authority answered and agrees. */
function healthySnapshot(overrides: Record<string, any> = {}) {
  return {
    mandate: getMandate(),
    canonical: ok({ inSync: true, toleranceUsd: 1, accounts: [{ accountCode: '1000', canonicalUsd: 50000, ledgerUsd: 50000, inSync: true }] }),
    subLedger: ok({ accounts: 4, principalUsd: 100000, incomeUsd: 12800, cashUsd: 50000, fundingEligibleUsd: 50000, segregated: 0 }),
    fixedIncome: ok({ positions: 2, principalUsd: 100000, accruedInterestUsd: 12800, annualIncomeUsd: 5000, discrepancies: [] }),
    custodian: ok({ netWorthUsd: 150000, principalUsd: 100000, interestUsd: 12800, bonds: 2, beneficiaries: 1 }),
    issuer: ok({ assets: [{ assetCode: 'DLBUSD', outstandingUsd: 1000, reserveUsd: 1000, backed: true }] }),
    distributions: ok({ total: 3, pendingApproval: 0, approvedUnexecuted: 0, executed: 2, failed: 0, executedTrailing12mUsd: 2000, executedNotNotarized: [], executedOutsideMandate: [] }),
    thirdweb: ok({ openTransfers: 0, openUsd: 0 }),
    fabric: ok({ notarizations: 2, anchored: 2, shadow: 0, pending: 0, failed: 0 }),
    firefly: ok({ transfers: 2, confirmed: 2, booked: 2, confirmedUnbooked: [], pending: 0, failed: 0, shadow: 0, notarized: 2 }),
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function gapsFor(pipeline: any, stage: string) {
  return pipeline.gaps.filter((g: any) => g.stage === stage);
}

beforeEach(() => {
  process.env.DAPP_MEMORY_MODE = 'true';
  for (const k of ['TRUST_LEGAL_NAME', 'TRUST_NAME', 'TRUST_MANDATE_ENFORCE', 'TRUST_MANDATE_ALLOW_CORPUS', 'TRUST_MANDATE_RESERVE_INCOME_PCT',
    'TRUST_MANDATE_REQUIRE_CANONICAL', 'FABRIC_CONNECT_URL', 'FABRIC_SIGNER', 'FABRIC_LEDGER_LIVE', 'FIREFLY_API_URL', 'FIREFLY_LIVE',
    'THIRDWEB_SECRET_KEY', 'APP_DOMAIN', 'NORTHFLANK_PROJECT_ID', 'NF_SERVICE_ID']) delete process.env[k];
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe('trust mandate', () => {
  it('names the family trust and its custodian/issuer role by default', () => {
    const m = getMandate();
    expect(m.legalName).toBe('DEANDREA LAVAR BARKLEY FAMILY TRUST');
    expect(m.roles).toEqual(['custodian', 'issuer']);
    expect(m.fundingPolicy).toMatchObject({ source: 'fixed-income', allowCorpusDistributions: false, enforce: false, reserveIncomePct: 10 });
    expect(m.authority.cashAndGl).toBe('fineract');
    expect(m.pipeline).toEqual(PIPELINE_STAGES.map((s: any) => s.key));
  });

  it('reads legal name and enforcement from the environment', () => {
    process.env.TRUST_LEGAL_NAME = 'DEANDREA LAVAR BARKLEY FAMILY TRUST, A NEVADA TRUST';
    process.env.TRUST_MANDATE_ENFORCE = 'true';
    process.env.TRUST_MANDATE_RESERVE_INCOME_PCT = '25';
    const m = getMandate();
    expect(m.legalName).toBe('DEANDREA LAVAR BARKLEY FAMILY TRUST, A NEVADA TRUST');
    expect(m.fundingPolicy.enforce).toBe(true);
    expect(m.fundingPolicy.reserveIncomePct).toBe(25);
  });
});

describe('control plane readiness', () => {
  it('lists every component and flags unconfigured ones as gaps without throwing', () => {
    const r = TrustControlPlaneEngine.readiness();
    for (const k of ['fineract', 'subLedger', 'fixedIncome', 'custodian', 'issuer', 'thirdweb', 'fabric', 'firefly', 'northflank', 'vm']) {
      expect(r.components[k]).toBeDefined();
      expect(r.components[k].available).toBe(true);
    }
    expect(r.live).toEqual({ fabric: false, firefly: false, thirdweb: false, fineract: false });
    expect(r.gaps.some((g: any) => g.component === 'fabric')).toBe(true);
    expect(r.gaps.some((g: any) => g.component === 'settlement' && g.severity === 'info')).toBe(true);
    expect(r.components.vm.mode).toBe('ip-only');
    expect(r.ready).toBe(false);
  });

  it('reports live gates and DNS once configured', () => {
    process.env.FABRIC_CONNECT_URL = 'https://fabconnect.trust.internal';
    process.env.FABRIC_SIGNER = 'signer';
    process.env.FABRIC_LEDGER_LIVE = 'true';
    process.env.FIREFLY_API_URL = 'https://firefly.trust.internal';
    process.env.FIREFLY_LIVE = 'true';
    process.env.APP_DOMAIN = 'app.dlbfamilytrust.com';
    process.env.NORTHFLANK_PROJECT_ID = 'proj-1';
    const r = TrustControlPlaneEngine.readiness();
    expect(r.live.fabric).toBe(true);
    expect(r.live.firefly).toBe(true);
    expect(r.components.vm).toMatchObject({ mode: 'dns', publicUrl: 'https://app.dlbfamilytrust.com', issues: [] });
    expect(r.components.northflank.ready).toBe(true);
  });
});

describe('distributable income', () => {
  it('is booked sub-ledger income, less reserve, less trailing-12m distributions', () => {
    const d = TrustControlPlaneEngine.distributable(healthySnapshot());
    // 12800 - 10% - 2000
    expect(d).toMatchObject({ known: true, incomeSource: 'postgres:trust_accounts', incomeUsd: 12800, reserveUsd: 1280, distributedTrailing12mUsd: 2000, distributableUsd: 9520, corpusDrawUsd: 0 });
  });

  it('never adds bond accrued interest on top of the booked income', () => {
    const d = TrustControlPlaneEngine.distributable(healthySnapshot({
      subLedger: ok({ accounts: 4, principalUsd: 100000, incomeUsd: 2525000, cashUsd: 4855, fundingEligibleUsd: 4855, segregated: 0 }),
      fixedIncome: ok({ positions: 1, principalUsd: 100000000, accruedInterestUsd: 2525000, annualIncomeUsd: 1000000, discrepancies: [] }),
    }));
    expect(d.incomeUsd).toBe(2525000);
  });

  it('falls back to bond accrued interest only when the sub-ledger is unavailable', () => {
    const d = TrustControlPlaneEngine.distributable(healthySnapshot({ subLedger: down('pg down') }));
    expect(d).toMatchObject({ known: true, incomeSource: 'postgres:bond_balances', incomeUsd: 12800 });
  });

  it('measures the corpus draw when distributions outran income', () => {
    const d = TrustControlPlaneEngine.distributable(healthySnapshot({
      distributions: ok({ executedTrailing12mUsd: 20000, executedNotNotarized: [], executedOutsideMandate: [] }),
    }));
    expect(d.distributableUsd).toBe(0);
    expect(d.corpusDrawUsd).toBe(20000 - 11520);
  });

  it('is unknown when neither ledger answers', () => {
    const d = TrustControlPlaneEngine.distributable(healthySnapshot({ subLedger: down('pg down'), fixedIncome: down('pg down') }));
    expect(d.known).toBe(false);
    expect(d.distributableUsd).toBeNull();
  });
});

describe('pipeline evaluation', () => {
  const readiness = () => TrustControlPlaneEngine.readiness();

  it('walks every mandated stage in order', () => {
    const p = TrustControlPlaneEngine.evaluatePipeline(readiness(), healthySnapshot());
    expect(p.stages.map((s: any) => s.stage)).toEqual(PIPELINE_STAGES.map((s: any) => s.key));
    expect(p.stages.find((s: any) => s.stage === 'income').status).toBe('ok');
    expect(p.stages.find((s: any) => s.stage === 'book').status).toBe('ok');
  });

  it('flags corpus draw, unbooked confirmations, unnotarized payouts and under-reserved issuance', () => {
    const p = TrustControlPlaneEngine.evaluatePipeline(readiness(), healthySnapshot({
      distributions: ok({ executedTrailing12mUsd: 50000, executedNotNotarized: ['REQ-1'], executedOutsideMandate: ['REQ-2'] }),
      firefly: ok({ transfers: 3, confirmed: 3, booked: 2, confirmedUnbooked: [{ id: 'FF-1', reference: 'W-1', amountUsd: 100 }], pending: 0, failed: 1, shadow: 0, notarized: 3 }),
      issuer: ok({ assets: [{ assetCode: 'DLBUSD', outstandingUsd: 5000, reserveUsd: 1000, backed: false }] }),
    }));
    expect(gapsFor(p, 'distributable').map((g: any) => g.gap)).toEqual(expect.arrayContaining([
      expect.stringContaining('drawing on corpus'),
      expect.stringContaining('failed mandate check'),
    ]));
    expect(gapsFor(p, 'notarize').some((g: any) => /1 executed distribution\(s\) have no Fabric notarization/.test(g.gap))).toBe(true);
    expect(gapsFor(p, 'book')).toHaveLength(1);
    expect(gapsFor(p, 'book')[0].severity).toBe('high');
    expect(gapsFor(p, 'confirm').some((g: any) => /1 FireFly transfer\(s\) failed/.test(g.gap))).toBe(true);
    expect(gapsFor(p, 'reconcile').some((g: any) => /under-reserved: DLBUSD/.test(g.gap))).toBe(true);
  });

  it('does not treat corpus draw as a gap when the mandate allows it', () => {
    process.env.TRUST_MANDATE_ALLOW_CORPUS = 'true';
    const p = TrustControlPlaneEngine.evaluatePipeline(readiness(), healthySnapshot({
      distributions: ok({ executedTrailing12mUsd: 50000, executedNotNotarized: [], executedOutsideMandate: [] }),
    }));
    expect(gapsFor(p, 'distributable')).toHaveLength(0);
  });

  it('surfaces an unavailable authority as a gap instead of assuming it agrees', () => {
    const p = TrustControlPlaneEngine.evaluatePipeline(readiness(), healthySnapshot({ fixedIncome: down('relation "bonds" does not exist') }));
    expect(p.stages.find((s: any) => s.stage === 'income').status).toBe('unavailable');
    expect(gapsFor(p, 'income')[0].severity).toBe('high');
    expect(gapsFor(p, 'reconcile').some((g: any) => /fixedIncome view unavailable/.test(g.gap))).toBe(true);
  });

  it('catches a custodian view that double-counts principal and income', () => {
    const p = TrustControlPlaneEngine.evaluatePipeline(readiness(), healthySnapshot({
      custodian: ok({ netWorthUsd: 0, principalUsd: 200000, interestUsd: 25600, bonds: 2, beneficiaries: 0 }),
    }));
    const gaps = gapsFor(p, 'reconcile').map((g: any) => g.gap);
    expect(gaps).toEqual(expect.arrayContaining([
      expect.stringMatching(/custodian income view \$25600 != sub-ledger income \$12800/),
      expect.stringMatching(/custodian principal view \$200000 != bond principal \$100000/),
    ]));
  });

  it('flags accrued interest that the sub-ledger never booked', () => {
    const p = TrustControlPlaneEngine.evaluatePipeline(readiness(), healthySnapshot({
      subLedger: ok({ accounts: 4, principalUsd: 100000, incomeUsd: 0, cashUsd: 50000, fundingEligibleUsd: 50000, segregated: 0 }),
      custodian: ok({ netWorthUsd: 0, principalUsd: 100000, interestUsd: 0, bonds: 2, beneficiaries: 0 }),
    }));
    expect(gapsFor(p, 'reconcile').some((g: any) => /sub-ledger booked income \$0 != bond accrued interest \$12800/.test(g.gap))).toBe(true);
    expect(p.distributable.incomeUsd).toBe(0);
  });

  it('has no reconcile gaps when every authority agrees', () => {
    const p = TrustControlPlaneEngine.evaluatePipeline(readiness(), healthySnapshot({ canonical: ok({ inSync: true, toleranceUsd: 1, accounts: [] }) }));
    expect(gapsFor(p, 'reconcile')).toEqual([]);
  });
});

describe('distribution guard', () => {
  it('allows a distribution the fixed-income surplus can fund', async () => {
    const e = await TrustControlPlaneEngine.evaluateDistribution({ amountUsd: 500, snapshot: healthySnapshot() });
    expect(e.allowed).toBe(true);
    expect(e.blocking).toEqual([]);
    expect(e.checks.find((c: any) => c.check === 'distributable-income')).toMatchObject({ ok: true, detail: { distributableUsd: 9520 } });
    // Canonical Fineract is not configured here: warned, not blocking, unless the mandate requires it.
    expect(e.checks.find((c: any) => c.check === 'canonical-funding')).toMatchObject({ ok: false, blocking: false });
  });

  it('blocks a distribution that would draw on corpus', async () => {
    const e = await TrustControlPlaneEngine.evaluateDistribution({ amountUsd: 9600, snapshot: healthySnapshot() });
    expect(e.allowed).toBe(false);
    expect(e.blocking).toEqual(['distributable-income']);
    expect(e.checks.find((c: any) => c.check === 'distributable-income').detail.wouldDrawCorpusUsd).toBe(80);
  });

  it('only warns about corpus when the mandate allows corpus distributions', async () => {
    process.env.TRUST_MANDATE_ALLOW_CORPUS = 'true';
    const e = await TrustControlPlaneEngine.evaluateDistribution({ amountUsd: 9600, snapshot: healthySnapshot() });
    expect(e.allowed).toBe(true);
  });

  it('blocks on the distribution policy ceiling', async () => {
    const e = await TrustControlPlaneEngine.evaluateDistribution({ amountUsd: 150000, requesterRole: 'beneficiary', snapshot: healthySnapshot() });
    expect(e.blocking).toContain('policy');
    expect(e.checks.find((c: any) => c.check === 'policy').detail.code).toBe('DISTRIBUTION_LIMIT_EXCEEDED');
  });

  it('blocks when canonical funding is required but not configured', async () => {
    process.env.TRUST_MANDATE_REQUIRE_CANONICAL = 'true';
    const e = await TrustControlPlaneEngine.evaluateDistribution({ amountUsd: 100, snapshot: healthySnapshot() });
    expect(e.blocking).toContain('canonical-funding');
  });
});

describe('distribution execution under the mandate', () => {
  const request = {
    id: 'REQ-MANDATE',
    type: 'distribution',
    status: 'approved',
    requester_role: 'beneficiary',
    amount_cents: 50000,
    destination_address: '0x1111111111111111111111111111111111111111',
    beneficiary_email: 'beneficiary@example.com',
    metadata: {},
  };

  function stubExecution() {
    vi.spyOn(DistributionRequestEngine, 'ensureTables').mockResolvedValue(undefined);
    vi.spyOn(DistributionRequestEngine, 'getRequest').mockResolvedValue(request);
    const update = vi.spyOn(DistributionRequestEngine, '_update').mockResolvedValue(request);
    const pay = vi.spyOn(PayoutCenterEngine, 'createPayment').mockResolvedValue({ id: 'PC-M', status: 'completed', tx_hash: '0xabc' });
    return { update, pay };
  }

  it('records the mandate decision and a Fabric notarization on the executed request (report-only)', async () => {
    vi.spyOn(TrustControlPlaneEngine, 'snapshot').mockResolvedValue(healthySnapshot());
    const { update, pay } = stubExecution();

    await DistributionRequestEngine.executeRequest('REQ-MANDATE');

    expect(pay).toHaveBeenCalledTimes(1);
    const final = update.mock.calls.at(-1)![1];
    expect(final.status).toBe('executed');
    expect(final.metadata.mandate).toMatchObject({ allowed: true, enforced: false, mandate: { legalName: 'DEANDREA LAVAR BARKLEY FAMILY TRUST' } });
    expect(final.metadata.notarization).toMatchObject({ status: 'shadow' });
    expect(final.metadata.notarization.digest).toMatch(/^[0-9a-f]{64}$/);
    const rows = await FabricLedgerEngine.list({ recordType: 'distribution_request' });
    expect(rows.some((r: any) => r.recordId === 'REQ-MANDATE')).toBe(true);
  });

  it('still pays but records allowed=false when the mandate is violated and not enforced', async () => {
    vi.spyOn(TrustControlPlaneEngine, 'snapshot').mockResolvedValue(healthySnapshot({
      subLedger: ok({ accounts: 4, principalUsd: 100000, incomeUsd: 0, cashUsd: 0, fundingEligibleUsd: 0, segregated: 0 }),
      fixedIncome: ok({ positions: 2, principalUsd: 100000, accruedInterestUsd: 0, annualIncomeUsd: 0, discrepancies: [] }),
    }));
    const { update, pay } = stubExecution();

    await DistributionRequestEngine.executeRequest('REQ-MANDATE');

    expect(pay).toHaveBeenCalledTimes(1);
    const final = update.mock.calls.at(-1)![1];
    expect(final.metadata.mandate).toMatchObject({ allowed: false, enforced: false, blocking: ['distributable-income'] });
  });

  it('refuses the payout when TRUST_MANDATE_ENFORCE is on and income cannot fund it', async () => {
    process.env.TRUST_MANDATE_ENFORCE = 'true';
    vi.spyOn(TrustControlPlaneEngine, 'snapshot').mockResolvedValue(healthySnapshot({
      subLedger: ok({ accounts: 4, principalUsd: 100000, incomeUsd: 0, cashUsd: 0, fundingEligibleUsd: 0, segregated: 0 }),
      fixedIncome: ok({ positions: 2, principalUsd: 100000, accruedInterestUsd: 0, annualIncomeUsd: 0, discrepancies: [] }),
    }));
    const { update, pay } = stubExecution();

    await expect(DistributionRequestEngine.executeRequest('REQ-MANDATE')).rejects.toMatchObject({
      status: 422, code: 'MANDATE_VIOLATION', message: expect.stringContaining('distributable-income'),
    });
    expect(pay).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith('REQ-MANDATE', { metadata: expect.objectContaining({ mandate: expect.objectContaining({ allowed: false }) }) });
  });

  it('never lets a broken control plane stop an approved payout', async () => {
    vi.spyOn(TrustControlPlaneEngine, 'evaluateDistribution').mockRejectedValue(new Error('pg down'));
    vi.spyOn(TrustControlPlaneEngine, 'notarizeDistribution').mockRejectedValue(new Error('fabric down'));
    const { update, pay } = stubExecution();

    await DistributionRequestEngine.executeRequest('REQ-MANDATE');

    expect(pay).toHaveBeenCalledTimes(1);
    const final = update.mock.calls.at(-1)![1];
    expect(final.metadata.mandate).toMatchObject({ allowed: null, error: 'pg down' });
    expect(final.metadata.notarization).toEqual({ error: 'fabric down' });
  });
});
