import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

process.env.DAPP_RPC_URL = process.env.DAPP_RPC_URL || 'http://127.0.0.1:8545';
process.env.DAPP_USDC_ADDRESS = process.env.DAPP_USDC_ADDRESS || '0x2222222222222222222222222222222222222222';

const pool = require('../server/integrations/bonds/pgPool');
const { TreasuryFundingBankEngine } = require('../server/integrations/payments/treasuryFundingBankEngine');
const { CashEngine } = require('../server/integrations/cash/cashEngine');
const { PayerOsEngine } = require('../server/integrations/os/payerOsEngine');
const { ReserveEngine } = require('../server/integrations/finops/reserveEngine');
const { SpritzTreasuryLegEngine } = require('../server/integrations/spritz/spritzTreasuryLegEngine');
const { TrustControlPlaneEngine } = require('../server/integrations/trust/trustControlPlaneEngine');
const { CollateralOsEngine } = require('../server/integrations/os/collateralOsEngine');
const { CanonicalFundingSource } = require('../server/integrations/fineract/canonicalFundingSource');
const { ApiGatewayClearingEngine } = require('../server/integrations/dapp/apiGatewayClearingEngine');
const { PaymentProcessorOsEngine } = require('../server/integrations/os/paymentProcessorOsEngine');
const { PaymentGatewayOsEngine } = require('../server/integrations/os/paymentGatewayOsEngine');
const { EnterpriseOdfiOsEngine } = require('../server/integrations/os/enterpriseOdfiOsEngine');
const OS = require('../server/integrations/os/osEngine');

/** The spendable stage is under test; the other pipeline stages are stubbed. */
function stubOtherStages() {
  vi.spyOn(SpritzTreasuryLegEngine, 'pipeline').mockResolvedValue({ stages: [] });
  vi.spyOn(TrustControlPlaneEngine, 'controlPlane').mockResolvedValue({ ready: false });
  vi.spyOn(CollateralOsEngine, 'status').mockResolvedValue({ ready: false });
  vi.spyOn(CanonicalFundingSource, 'readiness').mockResolvedValue({ ready: false });
  vi.spyOn(ApiGatewayClearingEngine, 'pipeline').mockResolvedValue({ stages: [] });
  vi.spyOn(PaymentProcessorOsEngine, 'status').mockResolvedValue({ engine: 'payment-processor', mode: 'shadow' });
  vi.spyOn(PaymentGatewayOsEngine, 'status').mockResolvedValue({ engine: 'payment-gateway', mode: 'shadow' });
}

function stubCloudSql() {
  return vi.spyOn(pool, 'query').mockImplementation(async (sql: any, params: any = []) => {
    const text = String(sql);
    if (/current_database\(\)/i.test(text)) return { rows: [{ db: 'dlbtrust', version: 'PostgreSQL 16' }] } as any;
    if (/information_schema\.tables/i.test(text)) return { rows: (params[0] || []).map((table_name: string) => ({ table_name })) } as any;
    return { rows: [] } as any;
  });
}

const ENV_KEYS = ['GCP_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'DATABASE_URL', 'APP_URL', 'TREASURY_BANK_ENABLED'];
const saved: Record<string, string | undefined> = {};

describe('unified pipeline spendable stage', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.GCP_PROJECT = 'dlb-treasury-management';
    process.env.GOOGLE_CLOUD_PROJECT = 'dlb-treasury-management';
    process.env.DATABASE_URL = 'postgres://app:pw@10.0.0.5:5432/dlbtrust';
    process.env.APP_URL = 'https://dlbtrust-app-r5oawu76jq-ue.a.run.app';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it('reports attested reserves, not ledger balances, as real spendable dollars', async () => {
    stubCloudSql();
    stubOtherStages();
    vi.spyOn(TreasuryFundingBankEngine, 'status').mockResolvedValue({ ready: false, issues: ['treasury bank not linked to Stripe'] });
    vi.spyOn(EnterpriseOdfiOsEngine, 'readiness').mockResolvedValue({ ready: false, blockers: ['ENTERPRISE_ODFI_LIVE not true'], trustAccountCredit: { ready: false, blockers: ['BETTERMENT_ACCOUNT_NUMBER not configured (Secret Manager)'], totals: { queuedCents: 0, inFlightCents: 0, originatedCents: 0, returnedCents: 0 } } });
    vi.spyOn(CashEngine, 'getAccount').mockResolvedValue({ account_id: 'CA-STRIPE-BALANCE', status: 'active', balance_cents: 250000 });
    vi.spyOn(PayerOsEngine, 'readiness').mockResolvedValue({ ready: false, blockers: [], fundingSource: { sourceKey: 'ptc-cma', spendable: '1500.00' } });
    vi.spyOn(ReserveEngine, 'coverage').mockResolvedValue({ status: 'partial', ledgerCashCents: 1000000, attestedReserveCents: 250000, unbackedCents: 750000, unbacked: '7500.00' });

    const out = await OS.unifiedPipeline({ limit: 5 });

    expect(out.stages).toContain('spendable');
    expect(out.stages[out.stages.length - 1]).toBe('spendable');
    expect(out.spendable.ok).toBe(true);
    expect(out.spendable.value.summary).toMatchObject({
      realSpendableCents: 250000,
      realSpendable: '2500.00',
      ledgerCashCents: 1000000,
      unbackedCents: 750000,
      backingStatus: 'partial',
      stripeBalanceCents: 250000,
      payerSourceSpendableCents: 150000,
      fundingRail: 'enterprise_odfi_trust_account_credit',
      fundingRailReady: false,
      treasuryBankEnabled: false,
      debitRailReady: false,
    });
    expect(out.spendable.value.gaps).toContain('trustAccountCredit: BETTERMENT_ACCOUNT_NUMBER not configured (Secret Manager)');
    expect(out.spendable.value.gaps.some((g: string) => g.startsWith('treasuryBank'))).toBe(false);
    expect(out.spendable.value.gaps).toContain('reserve: ledger cash exceeds attested reserves by 7500.00');
  }, 30000);

  it('degrades a failing engine to a reported gap and counts no real dollars without attestation', async () => {
    stubCloudSql();
    stubOtherStages();
    vi.spyOn(TreasuryFundingBankEngine, 'status').mockResolvedValue({ ready: true, issues: [] });
    vi.spyOn(EnterpriseOdfiOsEngine, 'readiness').mockResolvedValue({ ready: true, blockers: [], trustAccountCredit: { ready: true, blockers: [], totals: { queuedCents: 100000, inFlightCents: 0, originatedCents: 500000, returnedCents: 0 } } });
    vi.spyOn(CashEngine, 'getAccount').mockResolvedValue(null);
    vi.spyOn(PayerOsEngine, 'readiness').mockRejectedValue(new Error('payer db down'));
    vi.spyOn(ReserveEngine, 'coverage').mockRejectedValue(new Error('reserve db down'));

    const out = await OS.unifiedPipeline({ limit: 5 });

    expect(out.spendable.ok).toBe(true);
    expect(out.spendable.value.summary).toMatchObject({ realSpendableCents: 0, backingStatus: 'unknown', fundingRailReady: true, trustAccountCreditQueuedCents: 100000, trustAccountCreditOriginatedCents: 500000, stripeBalanceCents: null });
    expect(out.spendable.value.gaps).toEqual([
      'stripeBalance: cash account CA-STRIPE-BALANCE not found',
      'payerSource: payer db down',
      'reserve: reserve db down',
    ]);
  }, 30000);

  it('reports the optional Betterment debit rail only when TREASURY_BANK_ENABLED=true', async () => {
    stubCloudSql();
    stubOtherStages();
    process.env.TREASURY_BANK_ENABLED = 'true';
    vi.spyOn(TreasuryFundingBankEngine, 'status').mockResolvedValue({ ready: false, issues: ['treasury bank not linked to Stripe'] });
    vi.spyOn(EnterpriseOdfiOsEngine, 'readiness').mockRejectedValue(new Error('odfi db down'));
    vi.spyOn(CashEngine, 'getAccount').mockResolvedValue(null);
    vi.spyOn(PayerOsEngine, 'readiness').mockResolvedValue({ ready: false, blockers: [], fundingSource: null });
    vi.spyOn(ReserveEngine, 'coverage').mockResolvedValue({ status: 'backed', ledgerCashCents: 0, attestedReserveCents: 0, unbackedCents: 0 });

    const out = await OS.unifiedPipeline({ limit: 5 });

    expect(out.spendable.value.summary).toMatchObject({ fundingRailReady: false, treasuryBankEnabled: true, debitRailReady: false });
    expect(out.spendable.value.gaps).toEqual(expect.arrayContaining(['trustAccountCredit: odfi db down', 'treasuryBank: treasury bank not linked to Stripe']));
  }, 30000);
});
