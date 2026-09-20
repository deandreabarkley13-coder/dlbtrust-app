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
  it('registers every engine behind the five capabilities in the OS route map', () => {
    for (const key of ['payment', 'clearing', 'settlement', 'apigee', 'apisix', 'reconciliation', 'interop']) {
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
  it('reports all five engines ready and healthy with the GCP config in place', async () => {
    stubCloudSql();
    stubProviders();
    const report = await EngineWiringReadiness.readiness();

    expect(report.project).toBe('dlb-treasury-management');
    expect(report.gcp.projectMatches).toBe(true);
    expect(report.gcp.cloudRun).toBe(true);
    expect(report.gcp.ledger.connected).toBe(true);
    expect(report.gcp.evidenceBucket).toBe(GCP_ENV.GCS_CLEARING_EVIDENCE_BUCKET);
    expect(Object.keys(report.engines).sort()).toEqual(['clearing', 'gateway', 'interop', 'payment', 'reconciliation']);
    for (const [key, engine] of Object.entries<any>(report.engines)) {
      expect(engine.blockers, `${key} blockers`).toEqual([]);
      expect(engine.ready, key).toBe(true);
      expect(engine.healthy, key).toBe(true);
      expect(engine.gcp.project).toBe('dlb-treasury-management');
      expect(Object.values(engine.tables).every(Boolean), `${key} tables`).toBe(true);
    }
    expect(report.ready).toBe(true);
    expect(report.readyCount).toBe(5);

    expect(report.engines.payment.mode).toBe('live');
    expect(report.engines.payment.provider).toBe('payment-hub-ee');
    expect(report.engines.gateway.provider).toBe('lili');
    expect(report.engines.gateway.mode).toBe('live');
    expect(report.engines.clearing.mode).toBe('live');
    expect(report.engines.reconciliation.mode).toBe('live');
    expect(report.engines.interop.mode).toBe('shadow');
    expect(report.engines.interop.liveFlags.CROSS_CHAIN_SHADOW).toBe(true);
  });

  it('routes every OS engine readiness() onto its platform report', async () => {
    stubCloudSql();
    stubProviders();
    const pairs: Array<[any, string]> = [
      [OS.PaymentEngine, 'payment'], [OS.ClearingEngine, 'clearing'], [OS.SettlementEngine, 'clearing'],
      [OS.ApigeeGatewayEngine, 'gateway'], [OS.ApacheApisixEngine, 'gateway'],
      [OS.ReconciliationEngine, 'reconciliation'], [OS.InteropEngine, 'interop'],
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
