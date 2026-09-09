import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const DEANDREA = '0x5bcdFcBB7C35d51c5c346CAAD83b632B8cEAE169';
const MALISSA = '0xfEa48eF825cD2A8CEc45B933E29130aAf6c2890F';
const OPERATING = '0x491c175a4C24106e52a7423f216a56af7786125F';
const STRANGER = '0x0000000000000000000000000000000000000bad';
const PRB_TOKEN = '0x1111111111111111111111111111111111111111';

process.env.DAPP_CHAIN_ID = '8453';

const pool = require('../server/integrations/bonds/pgPool');
const { TrustAllocationEngine } = require('../server/integrations/dapp/trustAllocationEngine');
const { ModuleSmartAccountEngine } = require('../server/integrations/dapp/moduleSmartAccountEngine');

function mockLedger({ couponPaid = '0', staged = '0', treasury = 0 } = {}) {
  vi.spyOn(pool, 'query').mockImplementation(async (sql: string) => {
    if (/FROM coupon_payments/.test(sql)) return { rows: [{ total: couponPaid }], rowCount: 1 } as any;
    if (/FROM trust_allocation_payouts WHERE bucket/.test(sql)) return { rows: [{ total: staged }], rowCount: 1 } as any;
    return { rows: [], rowCount: 0 } as any;
  });
  vi.spyOn(ModuleSmartAccountEngine, 'getModuleBalance').mockResolvedValue(treasury as any);
}

describe('Trust allocation buckets', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.TRUST_ALLOCATION_BENEFICIARY_WALLETS;
    delete process.env.TRUST_ALLOCATION_TRUSTEE_WALLETS;
    delete process.env.DLB_PRB_TOKEN_ADDRESS;
    delete process.env.DLB_TREASURY_TOKEN_ADDRESS;
  });

  it('splits the policy allow-list into beneficiaries (coupon income) and trustees (Trust Operating)', () => {
    const beneficiaries = TrustAllocationEngine.payees('coupon_income').map((p: { address: string }) => p.address);
    const trustees = TrustAllocationEngine.payees('trust_operating').map((p: { address: string }) => p.address);
    expect(beneficiaries).toEqual(expect.arrayContaining([DEANDREA, MALISSA]));
    expect(beneficiaries).not.toContain(OPERATING);
    expect(trustees).toEqual([OPERATING]);
  });

  it('maps purposes to buckets and leaves investment unallocated', () => {
    expect(TrustAllocationEngine.bucketForPurpose('distribution').key).toBe('coupon_income');
    expect(TrustAllocationEngine.bucketForPurpose('medical').key).toBe('coupon_income');
    expect(TrustAllocationEngine.bucketForPurpose('operating').key).toBe('trust_operating');
    expect(TrustAllocationEngine.bucketForPurpose('trustee_fee').key).toBe('trust_operating');
    expect(TrustAllocationEngine.bucketForPurpose('investment')).toBeNull();
  });

  it('pays beneficiaries from recognised coupon income only', async () => {
    mockLedger({ couponPaid: '83333.33', staged: '3333.33' });
    const b = await TrustAllocationEngine.assertPayout({ payoutWallet: DEANDREA, purpose: 'distribution', amountUsd: 80000, reference: 'CPN-1' });
    expect(b.key).toBe('coupon_income');
    await expect(TrustAllocationEngine.assertPayout({ payoutWallet: DEANDREA, purpose: 'distribution', amountUsd: 80000.01, reference: 'CPN-2' }))
      .rejects.toMatchObject({ code: 'ALLOCATION_HEADROOM_EXCEEDED' });
  });

  it('refuses coupon income to a trustee wallet and Trust Operating to a beneficiary wallet', async () => {
    mockLedger({ couponPaid: '1000', treasury: 1000 });
    await expect(TrustAllocationEngine.assertPayout({ payoutWallet: OPERATING, purpose: 'distribution', amountUsd: 10, reference: 'X-1' }))
      .rejects.toMatchObject({ code: 'ALLOCATION_PAYEE_NOT_ALLOWED' });
    await expect(TrustAllocationEngine.assertPayout({ payoutWallet: DEANDREA, purpose: 'operating', amountUsd: 10, reference: 'X-2' }))
      .rejects.toMatchObject({ code: 'ALLOCATION_PAYEE_NOT_ALLOWED' });
    await expect(TrustAllocationEngine.assertPayout({ payoutWallet: STRANGER, purpose: 'operating', amountUsd: 10, reference: 'X-3' }))
      .rejects.toMatchObject({ code: 'ALLOCATION_PAYEE_NOT_ALLOWED' });
  });

  it('pays trustees from the Trust Operating (treasury module) balance', async () => {
    mockLedger({ treasury: 150 });
    const b = await TrustAllocationEngine.assertPayout({ payoutWallet: OPERATING, purpose: 'trustee_fee', amountUsd: 150, reference: 'FEE-1' });
    expect(b.key).toBe('trust_operating');
    await expect(TrustAllocationEngine.assertPayout({ payoutWallet: OPERATING, purpose: 'operating', amountUsd: 151, reference: 'FEE-2' }))
      .rejects.toMatchObject({ code: 'ALLOCATION_HEADROOM_EXCEEDED' });
  });

  it('rejects an explicit bucket that does not match the purpose, and unallocated purposes', async () => {
    mockLedger({ couponPaid: '1000', treasury: 1000 });
    await expect(TrustAllocationEngine.assertPayout({ bucket: 'trust_operating', payoutWallet: OPERATING, purpose: 'distribution', amountUsd: 10, reference: 'M-1' }))
      .rejects.toMatchObject({ code: 'ALLOCATION_PURPOSE_MISMATCH' });
    await expect(TrustAllocationEngine.assertPayout({ payoutWallet: DEANDREA, purpose: 'investment', amountUsd: 10, reference: 'M-2' }))
      .rejects.toMatchObject({ code: 'ALLOCATION_PURPOSE_UNALLOCATED' });
    await expect(TrustAllocationEngine.assertPayout({ bucket: 'nope', payoutWallet: DEANDREA, purpose: 'distribution', amountUsd: 10 }))
      .rejects.toMatchObject({ code: 'ALLOCATION_BUCKET_UNKNOWN' });
  });

  it('accepts a re-staged reference without consuming headroom twice', async () => {
    vi.spyOn(pool, 'query').mockImplementation(async (sql: string) => {
      if (/SELECT bucket FROM trust_allocation_payouts/.test(sql)) return { rows: [{ bucket: 'coupon_income' }], rowCount: 1 } as any;
      if (/FROM coupon_payments/.test(sql)) return { rows: [{ total: '0' }], rowCount: 1 } as any;
      return { rows: [], rowCount: 0 } as any;
    });
    const b = await TrustAllocationEngine.assertPayout({ payoutWallet: DEANDREA, purpose: 'distribution', amountUsd: 500, reference: 'CPN-DUP' });
    expect(b.key).toBe('coupon_income');
    await expect(TrustAllocationEngine.assertPayout({ payoutWallet: OPERATING, purpose: 'operating', amountUsd: 1, reference: 'CPN-DUP' }))
      .rejects.toMatchObject({ code: 'ALLOCATION_REFERENCE_CONFLICT' });
  });

  it('funds each bucket from its module token on Base when deployed, else the module ledger', () => {
    expect(TrustAllocationEngine.fundingSource('coupon_income')).toEqual({ sourceModule: 'bond_portfolio' });
    process.env.DLB_PRB_TOKEN_ADDRESS = PRB_TOKEN;
    expect(TrustAllocationEngine.fundingSource('coupon_income')).toEqual({ sourceToken: PRB_TOKEN, sourceModule: 'bond_portfolio' });
    expect(TrustAllocationEngine.fundingSource('trust_operating')).toEqual({ sourceModule: 'treasury' });
    expect(TrustAllocationEngine.tokenEnvFor('bond_portfolio')).toBe('DLB_PRB_TOKEN_ADDRESS');
    expect(TrustAllocationEngine.tokenEnvFor('treasury')).toBe('DLB_TREASURY_TOKEN_ADDRESS');
  });

  it('summarises recognised, staged and headroom per bucket', async () => {
    mockLedger({ couponPaid: '83333.33', staged: '333.33', treasury: 100003677.67 });
    const out = await TrustAllocationEngine.summaries();
    expect(out.find((s: { bucket: string }) => s.bucket === 'coupon_income')).toMatchObject({ recognisedUsd: 83333.33, stagedUsd: 333.33, headroomUsd: 83000 });
    expect(out.find((s: { bucket: string }) => s.bucket === 'trust_operating')).toMatchObject({ recognisedUsd: 100003677.67, payees: [{ address: OPERATING }] });
  });
});
