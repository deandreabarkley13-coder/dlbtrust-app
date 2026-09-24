import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// dapp/config.js is read once at load: give the interop engine a configured
// source chain before anything requires it.
process.env.DAPP_RPC_URL = process.env.DAPP_RPC_URL || 'http://127.0.0.1:8545';
process.env.DAPP_USDC_ADDRESS = process.env.DAPP_USDC_ADDRESS || '0x2222222222222222222222222222222222222222';

const pool = require('../server/integrations/bonds/pgPool');
const { EngineWiringReadiness } = require('../server/integrations/os/engineWiringReadiness');
const { ApiGatewayClearingEngine } = require('../server/integrations/dapp/apiGatewayClearingEngine');
const paymentHubConfig = require('../server/integrations/paymentHub/paymentHubConfig');
const OS = require('../server/integrations/os/osEngine');
const { CreditOsEngine } = require('../server/integrations/os/creditOsEngine');
const { DebtOsEngine } = require('../server/integrations/os/debtOsEngine');
const { LiquidityOsEngine } = require('../server/integrations/os/liquidityOsEngine');
const { PaymentProcessorOsEngine } = require('../server/integrations/os/paymentProcessorOsEngine');

const GCP_ENV: Record<string, string> = {
  GCP_PROJECT: 'dlb-treasury-management',
  GOOGLE_CLOUD_PROJECT: 'dlb-treasury-management',
  K_SERVICE: 'dlbtrust-app',
  K_REVISION: 'dlbtrust-app-00042-abc',
  DATABASE_URL: 'postgres://app:pw@10.0.0.5:5432/dlbtrust',
  GCS_CLEARING_EVIDENCE_BUCKET: 'dlb-treasury-management-clearing-evidence',
  API_GATEWAY_PROVIDER: 'lili',
  LILI_CLEARING_LIVE: 'true',
  PAYMENT_HUB_MODE: 'phee',
  PAYMENT_HUB_LIVE: 'true',
  PAYMENT_DATA_ENCRYPTION_KEY: 'ab'.repeat(32),
  CROSS_CHAIN_ENABLED: 'true',
  CROSS_CHAIN_SHADOW: 'true',
  PAYMENT_PROCESSOR_LIVE: 'true',
  PAYMENT_GATEWAY_LIVE: 'true',
  PAYMENT_GATEWAY_WEBHOOK_SECRET: 'whsec-test',
  PAYMENT_SERVER_SERVICE_TOKEN: 'svc-token',
};

const ENV_KEYS = [...Object.keys(GCP_ENV), 'DAPP_RPC_URL', 'DAPP_USDC_ADDRESS'];
const saved: Record<string, string | undefined> = {};

/** Cloud SQL stub: connectivity probe answers, every requested table exists unless listed in `missing`. */
function stubCloudSql(missing: string[] = []) {
  vi.spyOn(pool, 'query').mockImplementation(async (sql: any, params: any = []) => {
    const text = String(sql);
    if (/current_database\(\)/i.test(text)) return { rows: [{ db: 'dlbtrust', version: 'PostgreSQL 16' }] } as any;
    if (/information_schema\.tables/i.test(text)) {
      const names: string[] = params[0] || [];
      return { rows: names.filter(n => !missing.includes(n)).map(table_name => ({ table_name })) } as any;
    }
    return { rows: [] } as any;
  });
}

function stubProviders() {
  vi.spyOn(ApiGatewayClearingEngine, 'readiness').mockResolvedValue({
    provider: 'lili', mode: 'live', ready: true, blockers: [],
    storage: { ledger: { connected: true }, gcpProject: 'dlb-treasury-management' },
  });
  vi.spyOn(paymentHubConfig, 'readiness').mockReturnValue({
    ready: true, canTransmit: true, issues: [], warnings: [],
    config: { mode: 'phee', live: true, accountingOwner: 'dlbtrust', approvalThreshold: 2, baseUrlConfigured: true },
  });
  vi.spyOn(CreditOsEngine, 'fundingSources').mockResolvedValue({
    sources: [{ id: 'bank_odfi', configured: true, mode: 'live', realValueCapable: true, reason: 'external channel(s): sftp', channels: ['sftp'], loopback: [] }],
    realValueCapable: ['bank_odfi'], anyRealValueCapable: true,
  });
  vi.spyOn(CreditOsEngine, 'ledgerValidation').mockResolvedValue({ valid: true, issues: [], trustGl: { balanced: true }, fineractGl: { connected: true }, openDiscrepancies: 0 });
  vi.spyOn(CreditOsEngine, 'creditPipeline').mockResolvedValue({ deposits: {}, achBatches: {}, unverifiedTransmitted: 0, unverified: [] });
  vi.spyOn(DebtOsEngine, 'obligations').mockResolvedValue({ bonds: [], totals: { activeBonds: 1, principalOutstanding: 100000000, accruedInterest: 0, annualCoupon: 1000000 } });
  vi.spyOn(DebtOsEngine, 'placementCompliance').mockResolvedValue({ compliant: true, placement: 'private', publicOffer: false, holders: 2, externalHolders: 0, unverifiedHolders: 0, issues: [] });
  vi.spyOn(DebtOsEngine, 'schedule').mockResolvedValue({ horizonDays: 90, events: [], totals: { coupon: 250000, principal: 0, total: 250000 } });
  vi.spyOn(LiquidityOsEngine, 'coverage').mockResolvedValue({
    adequate: true, issues: [], cash: { liquid: 2000000, reserve: 1000000 },
    horizons: { '30d': { covered: true }, '90d': { covered: true }, '365d': { covered: true } },
    reserve: { balance: 1000000, annualCoupon: 1000000, coverage: 1, target: 1 }, payout: { realValueCapable: true, sources: ['bank_odfi'] },
  });
  vi.spyOn(PaymentProcessorOsEngine, 'processors').mockImplementation(async () => ({
    config: PaymentProcessorOsEngine.getConfig(),
    sources: [{ id: 'payment_hub', liveFlag: 'PAYMENT_HUB_LIVE', mode: 'live', configured: true, realValueCapable: true, reason: null }],
    realValueCapable: ['payment_hub'], anyRealValueCapable: true,
  }));
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(GCP_ENV)) process.env[k] = v;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

describe('platform engine registry', () => {
  it('registers every engine behind the eleven capabilities in the OS route map', () => {
    for (const key of ['payment', 'clearing', 'settlement', 'apigee', 'apisix', 'reconciliation', 'interop', 'credit', 'debt', 'liquidity', 'funding-os', 'payment-processor', 'payment-gateway']) {
      expect(OS.engines[key], key).toBeDefined();
      expect(typeof OS.engines[key].readiness).toBe('function');
    }
    expect(OS.PaymentEngine.platformEngine).toBe('payment');
    expect(OS.ClearingEngine.platformEngine).toBe('clearing');
    expect(OS.SettlementEngine.platformEngine).toBe('clearing');
    expect(OS.ApigeeGatewayEngine.platformEngine).toBe('gateway');
    expect(OS.ApacheApisixEngine.platformEngine).toBe('gateway');
    expect(OS.ReconciliationEngine.platformEngine).toBe('reconciliation');
    expect(OS.InteropEngine.platformEngine).toBe('interop');
    expect(OS.CreditEngine.platformEngine).toBe('credit');
    expect(OS.DebtEngine.platformEngine).toBe('debt');
    expect(OS.LiquidityEngine.platformEngine).toBe('liquidity');
    expect(OS.FundingOsPlatformEngine.platformEngine).toBe('funding-os');
    expect(OS.PaymentProcessorPlatformEngine.platformEngine).toBe('payment-processor');
    expect(OS.PaymentGatewayPlatformEngine.platformEngine).toBe('payment-gateway');
  });

  it('exposes readiness through the OS router and the finops cross-chain router', () => {
    const osRouter = require('../server/routes/os');
    const finops = require('../server/routes/finops');
    const paths = (r: any) => r.stack.filter((l: any) => l.route).map((l: any) => l.route.path);
    expect(paths(osRouter)).toEqual(expect.arrayContaining(['/readiness', '/readiness/:platformEngine', '/:engine/readiness']));
    expect(paths(finops)).toContain('/cross-chain/readiness');
    // literal readiness route is registered ahead of the /:id catch-all
    const fp = paths(finops);
    expect(fp.indexOf('/cross-chain/readiness')).toBeLessThan(fp.indexOf('/cross-chain/:id'));
  });
});

describe('EngineWiringReadiness on dlb-treasury-management', () => {
  it('reports all eleven engines ready and healthy with the GCP config in place', async () => {
    stubCloudSql();
    stubProviders();
    const report = await EngineWiringReadiness.readiness();

    expect(report.project).toBe('dlb-treasury-management');
    expect(report.gcp.projectMatches).toBe(true);
    expect(report.gcp.cloudRun).toBe(true);
    expect(report.gcp.ledger.connected).toBe(true);
    expect(report.gcp.evidenceBucket).toBe(GCP_ENV.GCS_CLEARING_EVIDENCE_BUCKET);
    expect(Object.keys(report.engines).sort()).toEqual(['clearing', 'credit', 'debt', 'funding-os', 'gateway', 'interop', 'liquidity', 'payment', 'payment-gateway', 'payment-processor', 'reconciliation']);
    for (const [key, engine] of Object.entries<any>(report.engines)) {
      expect(engine.blockers, `${key} blockers`).toEqual([]);
      expect(engine.ready, key).toBe(true);
      expect(engine.healthy, key).toBe(true);
      expect(engine.gcp.project).toBe('dlb-treasury-management');
      expect(Object.values(engine.tables).every(Boolean), `${key} tables`).toBe(true);
    }
    expect(report.ready).toBe(true);
    expect(report.readyCount).toBe(11);
    expect(report.total).toBe(11);

    expect(report.engines.payment.mode).toBe('live');
    expect(report.engines.payment.provider).toBe('payment-hub-ee');
    expect(report.engines.gateway.provider).toBe('lili');
    expect(report.engines.gateway.mode).toBe('live');
    expect(report.engines.clearing.mode).toBe('live');
    expect(report.engines.reconciliation.mode).toBe('live');
    expect(report.engines.interop.mode).toBe('shadow');
    expect(report.engines.interop.liveFlags.CROSS_CHAIN_SHADOW).toBe(true);
    expect(report.engines.credit.mode).toBe('live');
    expect(report.engines.credit.provider).toBe('bank_odfi');
    expect(report.engines.debt.mode).toBe('live');
    expect(report.engines.debt.liveFlags.PUBLIC_OFFER).toBe(false);
    expect(report.engines.liquidity.mode).toBe('live');
    expect(report.engines.liquidity.liveFlags.RESERVE_COVERAGE).toBe(1);
    expect(report.engines['payment-processor'].mode).toBe('live');
    expect(report.engines['payment-processor'].provider).toBe('payment_hub');
    expect(report.engines['payment-processor'].liveFlags.PAYMENT_PROCESSOR_LIVE).toBe(true);
    expect(report.engines['payment-gateway'].mode).toBe('live');
    expect(report.engines['payment-gateway'].provider).toBe('payment_hub');
    expect(report.engines['payment-gateway'].liveFlags.PAYMENT_GATEWAY_LIVE).toBe(true);
  });

  it('payment-processor engine is the tenth blocker until PAYMENT_PROCESSOR_LIVE and a real-value processor exist', async () => {
    stubCloudSql();
    stubProviders();
    delete process.env.PAYMENT_PROCESSOR_LIVE;
    (PaymentProcessorOsEngine.processors as any).mockImplementation(async () => ({
      config: PaymentProcessorOsEngine.getConfig(),
      sources: [{ id: 'stripe_treasury', liveFlag: 'STRIPE_SECRET_KEY', mode: 'test', realValueCapable: false, reason: 'STRIPE_SECRET_KEY is sk_test_ (test mode)' }],
      realValueCapable: [], anyRealValueCapable: false,
    }));
    const report = await EngineWiringReadiness.readiness();
    expect(report.ready).toBe(false);
    expect(report.readyCount).toBe(9);
    expect(report.total).toBe(11);
    expect(report.engines['payment-gateway'].ready).toBe(false);
    expect(report.engines['payment-gateway'].blockers.some((b: string) => b.startsWith('PAYMENT_PROCESSOR_LIVE is not true'))).toBe(true);
    const pp = report.engines['payment-processor'];
    expect(pp.ready).toBe(false);
    expect(pp.mode).toBe('shadow');
    expect(pp.blockers.some((b: string) => b.startsWith('PAYMENT_PROCESSOR_LIVE is not true'))).toBe(true);
    expect(pp.blockers.some((b: string) => /no real-value processor: stripe_treasury: STRIPE_SECRET_KEY is sk_test_/.test(b))).toBe(true);
  });

  it('debt engine blocks a public placement or a holder outside the trust/family', async () => {
    stubCloudSql();
    stubProviders();
    (DebtOsEngine.placementCompliance as any).mockResolvedValue({
      compliant: false, placement: 'private', publicOffer: false, holders: 3, externalHolders: 1, unverifiedHolders: 1,
      issues: [
        "bond DLB-PRB (#1) placement_type=public; must be 'private' (no public offer)",
        '1 holder(s) outside trust/family (contact_type not in trustee/beneficiary): CT-EXT-1',
        '1 holder(s) without verified KYC: CT-FAM-2',
      ],
    });
    const debt = await EngineWiringReadiness.engineReadiness('debt');
    expect(debt.ready).toBe(false);
    expect(debt.mode).toBe('shadow');
    expect(debt.blockers).toEqual(expect.arrayContaining([
      expect.stringMatching(/placement: bond DLB-PRB .* must be 'private'/),
      expect.stringMatching(/placement: 1 holder\(s\) outside trust\/family/),
      expect.stringMatching(/placement: 1 holder\(s\) without verified KYC/),
    ]));
  });

  it('liquidity engine blocks when debt service is not covered by liquid cash or the reserve tier is thin', async () => {
    stubCloudSql();
    stubProviders();
    (LiquidityOsEngine.coverage as any).mockResolvedValue({
      adequate: false, cash: { liquid: 100000, reserve: 0 },
      horizons: { '30d': { covered: true }, '90d': { covered: false, due: 250000, liquidCash: 100000, shortfall: 150000 }, '365d': { covered: false } },
      reserve: { balance: 0, annualCoupon: 1000000, coverage: 0, target: 1 }, payout: { realValueCapable: false, sources: [] },
      issues: ['90d debt service 250000 exceeds liquid cash 100000 (shortfall 150000)', 'reserve 0 covers 0x of annual coupon 1000000 (target >= 1x)', 'no funded real-value source to pay coupons out (see credit engine)'],
    });
    const liq = await EngineWiringReadiness.engineReadiness('liquidity');
    expect(liq.ready).toBe(false);
    expect(liq.mode).toBe('shadow');
    expect(liq.liveFlags.COVERED_30D).toBe(true);
    expect(liq.liveFlags.COVERED_90D).toBe(false);
    expect(liq.liveFlags.PAYOUT_REAL_VALUE_CAPABLE).toBe(false);
    expect(liq.blockers.some((b: string) => /shortfall 150000/.test(b))).toBe(true);
    expect(liq.blockers.some((b: string) => /reserve 0 covers 0x/.test(b))).toBe(true);
  });

  it('credit engine stays validation-only and blocked when every funding source is test-mode, Skrill or a loopback ODFI', async () => {
    stubCloudSql();
    stubProviders();
    (CreditOsEngine.fundingSources as any).mockResolvedValue({
      sources: [
        { id: 'stripe_treasury', configured: true, mode: 'test', realValueCapable: false, reason: 'test-mode key (sandbox)' },
        { id: 'skrill', configured: true, mode: 'live', realValueCapable: false, reason: 'Skrill-to-Skrill only' },
        { id: 'bank_odfi', configured: true, mode: 'loopback', realValueCapable: false, reason: 'Only self-loopback ODFI partner(s) configured (as2_partner:DLBTRUST-DIRECT)', channels: [], loopback: ['as2_partner:DLBTRUST-DIRECT'] },
      ],
      realValueCapable: [], anyRealValueCapable: false,
    });
    (CreditOsEngine.creditPipeline as any).mockResolvedValue({ deposits: { transmitted: 2 }, achBatches: { accepted: 2 }, unverifiedTransmitted: 2, unverified: [] });
    const credit = await EngineWiringReadiness.engineReadiness('credit');
    expect(credit.ready).toBe(false);
    expect(credit.healthy).toBe(true);
    expect(credit.mode).toBe('shadow');
    expect(credit.provider).toBe('validation-only');
    expect(credit.liveFlags.STRIPE_KEY_MODE).toBe('test');
    expect(credit.liveFlags.BANK_ODFI_EXTERNAL).toBe(false);
    expect(credit.blockers.some((b: string) => /no funded real-value origination source/.test(b) && /DLBTRUST-DIRECT/.test(b))).toBe(true);
    expect(credit.blockers.some((b: string) => /2 credit\(s\) marked transmitted with no bank confirmation/.test(b))).toBe(true);
  });

  it('routes every OS engine readiness() onto its platform report', async () => {
    stubCloudSql();
    stubProviders();
    const pairs: Array<[any, string]> = [
      [OS.PaymentEngine, 'payment'], [OS.ClearingEngine, 'clearing'], [OS.SettlementEngine, 'clearing'],
      [OS.ApigeeGatewayEngine, 'gateway'], [OS.ApacheApisixEngine, 'gateway'],
      [OS.ReconciliationEngine, 'reconciliation'], [OS.InteropEngine, 'interop'],
      [OS.PaymentProcessorPlatformEngine, 'payment-processor'],
    ];
    for (const [Engine, key] of pairs) {
      const r = await Engine.readiness();
      expect(r.engine, Engine.engineName).toBe(key);
      expect(r.ready, Engine.engineName).toBe(true);
    }
  });

  it('names the project mismatch when deployed against the wrong GCP project', async () => {
    stubCloudSql();
    stubProviders();
    process.env.GCP_PROJECT = 'dlb-treasury';
    process.env.GOOGLE_CLOUD_PROJECT = 'dlb-treasury';
    const report = await EngineWiringReadiness.readiness();
    expect(report.ready).toBe(false);
    for (const engine of Object.values<any>(report.engines)) {
      expect(engine.ready).toBe(false);
      expect(engine.blockers).toContain('GCP_PROJECT is dlb-treasury, expected dlb-treasury-management');
    }
  });

  it('flags missing reconciliation tables on Cloud SQL and a missing evidence bucket', async () => {
    stubCloudSql(['ach_reconciliations']);
    stubProviders();
    delete process.env.GCS_CLEARING_EVIDENCE_BUCKET;
    const recon = await EngineWiringReadiness.engineReadiness('reconciliation');
    expect(recon.ready).toBe(false);
    expect(recon.tables.ach_reconciliations).toBe(false);
    expect(recon.blockers).toContain('Cloud SQL tables missing: ach_reconciliations');
    expect(recon.jobs['ACHReconciliation.runReconciliation']).toContain('/api/ach-pipeline/reconciliation/run');
    expect(recon.jobs['DataBridge.getReconciliationReport']).toContain('/api/accounting/bridge/report');
    expect(recon.jobs['ApiGatewayClearingEngine.reconcile']).toContain('/api/dapp/clearing-pipeline/events/:id/reconcile');

    const gateway = await EngineWiringReadiness.engineReadiness('gateway');
    expect(gateway.ready).toBe(false);
    expect(gateway.blockers.some((b: string) => b.startsWith('GCS_CLEARING_EVIDENCE_BUCKET not set'))).toBe(true);
  });

  it('reports the exact secret that keeps an engine from going live', async () => {
    stubCloudSql();
    stubProviders();
    delete process.env.PAYMENT_DATA_ENCRYPTION_KEY;
    (paymentHubConfig.readiness as any).mockReturnValue({
      ready: false, canTransmit: false, issues: ['PAYMENT_HUB_AUTH_TOKEN is required'], warnings: [],
      config: { mode: 'phee', live: true },
    });
    const interop = await EngineWiringReadiness.engineReadiness('interop');
    expect(interop.ready).toBe(false);
    expect(interop.blockers).toContain('PAYMENT_DATA_ENCRYPTION_KEY not set (M2M identity keys are stored encrypted)');

    const payment = await EngineWiringReadiness.engineReadiness('payment');
    expect(payment.ready).toBe(false);
    expect(payment.mode).toBe('shadow');
    expect(payment.blockers).toContain('payment hub: PAYMENT_HUB_AUTH_TOKEN is required');
  });

  it('reports Cloud SQL down as a blocker on every engine', async () => {
    vi.spyOn(pool, 'query').mockRejectedValue(new Error('connect ECONNREFUSED'));
    stubProviders();
    const report = await EngineWiringReadiness.readiness();
    expect(report.gcp.ledger.connected).toBe(false);
    for (const [key, engine] of Object.entries<any>(report.engines)) {
      if (key === 'gateway') continue; // gateway delegates ledger state to ApiGatewayClearingEngine.readiness (stubbed)
      expect(engine.blockers, key).toContain('ledger database (Cloud SQL / DATABASE_URL) not connected');
    }
  });

  it('rejects an unknown platform engine with 404', async () => {
    await expect(EngineWiringReadiness.engineReadiness('nope')).rejects.toMatchObject({ status: 404 });
  });
});
