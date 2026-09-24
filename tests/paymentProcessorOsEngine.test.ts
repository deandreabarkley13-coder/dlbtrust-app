import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

process.env.DAPP_RPC_URL = process.env.DAPP_RPC_URL || 'http://127.0.0.1:8545';
process.env.DAPP_USDC_ADDRESS = process.env.DAPP_USDC_ADDRESS || '0x2222222222222222222222222222222222222222';

const pool = require('../server/integrations/bonds/pgPool');
const { PaymentProcessorOsEngine } = require('../server/integrations/os/paymentProcessorOsEngine');
const { EngineWiringReadiness } = require('../server/integrations/os/engineWiringReadiness');
const { PaymentProcessorServerEngine } = require('../server/integrations/payments/paymentProcessorServerEngine');
const { BankSettlementEngine } = require('../server/integrations/payments/bankSettlementEngine');
const { ApiGatewayClearingEngine } = require('../server/integrations/dapp/apiGatewayClearingEngine');
const OS = require('../server/integrations/os/osEngine');
const osRouter = require('../server/routes/os');
const paymentHubConfig = require('../server/integrations/paymentHub/paymentHubConfig');
const { CreditOsEngine } = require('../server/integrations/os/creditOsEngine');
const { DebtOsEngine } = require('../server/integrations/os/debtOsEngine');
const { LiquidityOsEngine } = require('../server/integrations/os/liquidityOsEngine');

const ENV_KEYS = [
  'GCP_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'DATABASE_URL', 'APP_URL', 'DEPLOY_URL', 'DOMAIN',
  'PAYMENT_PROCESSOR_LIVE', 'PAYMENT_PROCESSOR_REQUIRE_APPROVAL_REF', 'PAYMENT_PROCESSOR_REQUIRE_SCREENING_REF',
  'PAYMENT_PROCESSOR_DEFAULT', 'STRIPE_SECRET_KEY', 'STRIPE_PAYMENTS_SECRET_KEY', 'STRIPE_TREASURY_FINANCIAL_ACCOUNT_ID',
  'PAYMENT_HUB_LIVE', 'LILI_CLEARING_LIVE', 'CLEARING_API_ENDPOINT', 'CLEARING_API_KEY',
  'PAYMENT_DATA_ENCRYPTION_KEY', 'PAYMENT_SERVER_SERVICE_TOKEN', 'CLEARING_REQUIRE_APPROVAL_REF',
  'K_SERVICE', 'K_REVISION', 'GCS_CLEARING_EVIDENCE_BUCKET', 'API_GATEWAY_PROVIDER', 'PAYMENT_HUB_MODE', 'CROSS_CHAIN_ENABLED', 'CROSS_CHAIN_SHADOW',
];

/** Same wiring the readiness audit uses to bring the other nine engines to ready. */
function stubOtherEnginesReady() {
  Object.assign(process.env, {
    K_SERVICE: 'dlbtrust-app', K_REVISION: 'dlbtrust-app-00042-abc', GCS_CLEARING_EVIDENCE_BUCKET: 'dlb-treasury-management-clearing-evidence',
    API_GATEWAY_PROVIDER: 'lili', LILI_CLEARING_LIVE: 'true', PAYMENT_HUB_MODE: 'phee', PAYMENT_HUB_LIVE: 'true',
    PAYMENT_DATA_ENCRYPTION_KEY: 'ab'.repeat(32), CROSS_CHAIN_ENABLED: 'true', CROSS_CHAIN_SHADOW: 'true',
  });
  vi.spyOn(ApiGatewayClearingEngine, 'readiness').mockResolvedValue({ provider: 'lili', mode: 'live', ready: true, blockers: [], storage: { ledger: { connected: true }, gcpProject: 'dlb-treasury-management' } });
  vi.spyOn(paymentHubConfig, 'readiness').mockReturnValue({ ready: true, canTransmit: true, issues: [], warnings: [], config: { mode: 'phee', live: true, accountingOwner: 'dlbtrust', approvalThreshold: 2, baseUrlConfigured: true } });
  vi.spyOn(CreditOsEngine, 'fundingSources').mockResolvedValue({ sources: [{ id: 'bank_odfi', configured: true, mode: 'live', realValueCapable: true, reason: 'external channel(s): sftp', channels: ['sftp'], loopback: [] }], realValueCapable: ['bank_odfi'], anyRealValueCapable: true });
  vi.spyOn(CreditOsEngine, 'ledgerValidation').mockResolvedValue({ valid: true, issues: [], trustGl: { balanced: true }, fineractGl: { connected: true }, openDiscrepancies: 0 });
  vi.spyOn(CreditOsEngine, 'creditPipeline').mockResolvedValue({ deposits: {}, achBatches: {}, unverifiedTransmitted: 0, unverified: [] });
  vi.spyOn(DebtOsEngine, 'obligations').mockResolvedValue({ bonds: [], totals: { activeBonds: 1, principalOutstanding: 100000000, accruedInterest: 0, annualCoupon: 1000000 } });
  vi.spyOn(DebtOsEngine, 'placementCompliance').mockResolvedValue({ compliant: true, placement: 'private', publicOffer: false, holders: 2, externalHolders: 0, unverifiedHolders: 0, issues: [] });
  vi.spyOn(DebtOsEngine, 'schedule').mockResolvedValue({ horizonDays: 90, events: [], totals: { coupon: 250000, principal: 0, total: 250000 } });
  vi.spyOn(LiquidityOsEngine, 'coverage').mockResolvedValue({ adequate: true, issues: [], cash: { liquid: 2000000, reserve: 1000000 }, horizons: { '30d': { covered: true }, '90d': { covered: true }, '365d': { covered: true } }, reserve: { balance: 1000000, annualCoupon: 1000000, coverage: 1, target: 1 }, payout: { realValueCapable: true, sources: ['bank_odfi'] } });
}
const saved: Record<string, string | undefined> = {};

function liveInventory(processor = 'lili') {
  return {
    config: { ...PaymentProcessorOsEngine.getConfig(), live: true, requireApproval: true, requireScreening: true },
    sources: [{ id: processor, mode: 'live', realValueCapable: true, reason: null }],
    realValueCapable: [processor],
    anyRealValueCapable: true,
  };
}

function shadowInventory() {
  return {
    config: { ...PaymentProcessorOsEngine.getConfig(), live: false },
    sources: [{ id: 'lili', mode: 'shadow', realValueCapable: false, reason: 'LILI_CLEARING_LIVE=false' }],
    realValueCapable: [],
    anyRealValueCapable: false,
  };
}

function submittedRow(overrides: Record<string, any> = {}) {
  return {
    submission_id: 'PPS-1', processor: 'lili', rail: 'ach', direction: 'outbound', amount_cents: 12500, currency: 'USD',
    status: 'submitted', real_value: false, reference: 'INV-1', source: { accountId: 'CA-OPERATING' },
    destination: { bankId: 'lili', accountNumber: '123', routingNumber: '021000021' }, metadata: {},
    requested_by: 'maker@dlbtrust.com', approved_by: null, approval_ref: null, screening_ref: null,
    processor_tx_id: null, settlement_id: null, route: null, result: null, error_message: null,
    created_at: new Date(), approved_at: null, executed_at: null, ...overrides,
  };
}

/** Cloud SQL stub: connectivity probe answers, every requested table exists unless listed in `missing`. */
function stubCloudSql(missing: string[] = []) {
  return vi.spyOn(pool, 'query').mockImplementation(async (sql: any, params: any = []) => {
    const text = String(sql);
    if (/current_database\(\)/i.test(text)) return { rows: [{ db: 'dlbtrust', version: 'PostgreSQL 16' }] } as any;
    if (/information_schema\.tables/i.test(text)) {
      const names: string[] = params[0] || [];
      return { rows: names.filter(n => !missing.includes(n)).map(table_name => ({ table_name })) } as any;
    }
    return { rows: [] } as any;
  });
}

function responseStub() {
  const response: any = {
    statusCode: 200,
    status: vi.fn(function status(code: number) { response.statusCode = code; return response; }),
    json: vi.fn(function json(body: any) { response.body = body; return response; }),
  };
  return response;
}

function routeHandler(method: string, path: string) {
  const layer = osRouter.stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`route ${method.toUpperCase()} ${path} not registered`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

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

describe('payment-processor OS engine registration and routing', () => {
  it('is registered as the tenth platform engine in the OS engine map and route map', () => {
    expect(OS.engines['payment-processor']).toBe(OS.PaymentProcessorPlatformEngine);
    expect(OS.PaymentProcessorPlatformEngine.platformEngine).toBe('payment-processor');
    expect(OS.PaymentProcessorPlatformEngine.engineName).toBe('payment-processor');
    expect(EngineWiringReadiness.ENGINE_KEYS).toContain('payment-processor');
    expect(EngineWiringReadiness.ENGINE_KEYS).toHaveLength(10);
    expect(EngineWiringReadiness.ENGINE_TITLES['payment-processor']).toBe('Payment Processor OS Engine');
    const paths = osRouter.stack.filter((l: any) => l.route).map((l: any) => l.route.path);
    expect(paths).toEqual(expect.arrayContaining(['/:engine/status', '/:engine/readiness', '/:engine/list', '/:engine/process', '/readiness/:platformEngine']));
  });

  it('serves /api/os/payment-processor/{status,readiness,process} through the generic engine routes', async () => {
    stubCloudSql();
    const getEngine = osRouter.stack.find((l: any) => l.route?.path === '/:engine/status').route.stack.find((s: any) => s.name === 'getEngine').handle;
    const req: any = { params: { engine: 'payment-processor' }, query: {}, body: {} };
    const next = vi.fn();
    getEngine(req, responseStub(), next);
    expect(next).toHaveBeenCalled();
    expect(req.osEngine).toBe(OS.PaymentProcessorPlatformEngine);

    const statusRes = responseStub();
    await routeHandler('get', '/:engine/status')(req, statusRes);
    expect(statusRes.body.success).toBe(true);
    expect(statusRes.body.data.engine).toBe('payment-processor');
    expect(statusRes.body.data.mode).toBe('shadow');
    expect(statusRes.body.data.integrations).toMatchObject({ paymentProcessorOs: true, processor: true, gateway: true, paymentHub: true, bankSettlement: true, gatewayClearing: true });

    const readyRes = responseStub();
    await routeHandler('get', '/:engine/readiness')(req, readyRes);
    expect(readyRes.body.data.engine).toBe('payment-processor');
    expect(readyRes.body.data.mode).toBe('shadow');
    expect(Array.isArray(readyRes.body.data.blockers)).toBe(true);
  });

  it('rejects direct money-moving actions on /process and only accepts the gated maker/checker actions', async () => {
    stubCloudSql();
    const handler = routeHandler('post', '/:engine/process');
    for (const action of ['processPayment', 'sale', 'capture', 'clearPayment', 'clearAndSettle', 'createIntent']) {
      const res = responseStub();
      await handler({ params: { engine: 'payment-processor' }, body: { action, amount: 100 }, osEngine: OS.PaymentProcessorPlatformEngine }, res);
      expect(res.statusCode, action).toBe(409);
      expect(res.body.error).toMatch(/maker-checker/);
    }
    const unknown = responseStub();
    await handler({ params: { engine: 'payment-processor' }, body: { action: 'refund' }, osEngine: OS.PaymentProcessorPlatformEngine }, unknown);
    expect(unknown.statusCode).toBe(409);

    const bogus = responseStub();
    await handler({ params: { engine: 'payment-processor' }, body: { action: 'wire-now' }, osEngine: OS.PaymentProcessorPlatformEngine }, bogus);
    expect(bogus.statusCode).toBe(400);
    expect(bogus.body.error).toMatch(/Unknown payment-processor action: wire-now/);
  });

  it('records every gated action in os_events through BaseOSEngine.process', async () => {
    const query = stubCloudSql();
    vi.spyOn(PaymentProcessorOsEngine, 'pipeline').mockResolvedValue({ byStatus: {}, liveExposureCents: 0 });
    const out = await OS.PaymentProcessorPlatformEngine.process({ action: 'pipeline' });
    expect(out.success).toBe(true);
    expect(out.engine).toBe('payment-processor');
    expect(out.eventId).toMatch(/^payment-processor-/);
    const logged = query.mock.calls.find(([sql]: any[]) => /INSERT INTO os_events/i.test(String(sql)));
    expect(logged).toBeDefined();
    expect(logged![1]).toContain('payment-processor');
  });
});

describe('payment-processor fail-closed gates', () => {
  it('refuses self-loopback partners on submit', async () => {
    const query = stubCloudSql();
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(liveInventory());
    const base = { processor: 'lili', amount: 125, requestedBy: 'maker@dlbtrust.com', approvalRef: 'APR-1', screeningRef: 'SCR-1' };
    await expect(PaymentProcessorOsEngine.submit({ ...base, destination: { partnerUrl: 'direct' } })).rejects.toMatchObject({ status: 409, message: /self-loopback partner refused/ });
    await expect(PaymentProcessorOsEngine.submit({ ...base, destination: { partnerAs2Id: 'DLBTRUST-DIRECT' } })).rejects.toMatchObject({ status: 409 });
    await expect(PaymentProcessorOsEngine.submit({ ...base, destination: { endpoint: 'https://dlbtrust-app-r5oawu76jq-ue.a.run.app/api/os/payment-processor/process' } })).rejects.toMatchObject({ status: 409 });
    await expect(PaymentProcessorOsEngine.submit({ ...base, destination: { url: 'http://localhost:3002/api/payment-server/v1/settle' } })).rejects.toMatchObject({ status: 409 });
    expect(query.mock.calls.some(([sql]: any[]) => /INSERT INTO payment_processor_submissions/i.test(String(sql)))).toBe(false);
  });

  it('requires approvalRef + screeningRef for every real-value submission, even when the provider gate is relaxed', async () => {
    const query = stubCloudSql();
    process.env.PAYMENT_PROCESSOR_LIVE = 'true';
    process.env.CLEARING_REQUIRE_APPROVAL_REF = 'false';
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(liveInventory());
    const base = { processor: 'lili', amount: 125, requestedBy: 'maker@dlbtrust.com', destination: { bankId: 'lili' } };
    await expect(PaymentProcessorOsEngine.submit(base)).rejects.toMatchObject({ status: 409, message: /approvalRef .* required/ });
    await expect(PaymentProcessorOsEngine.submit({ ...base, approvalRef: 'APR-1' })).rejects.toMatchObject({ status: 409, message: /screeningRef .* required/ });
    expect(query.mock.calls.some(([sql]: any[]) => /INSERT INTO payment_processor_submissions/i.test(String(sql)))).toBe(false);

    query.mockImplementation(async (sql: any, params: any[] = []) => {
      if (/INSERT INTO payment_processor_submissions/i.test(String(sql))) {
        return { rows: [submittedRow({ real_value: params[6], approval_ref: params[12], screening_ref: params[13] })] } as any;
      }
      return { rows: [] } as any;
    });
    const sub = await PaymentProcessorOsEngine.submit({ ...base, approvalRef: 'APR-1', screeningRef: 'SCR-1' });
    expect(sub.status).toBe('submitted');
    expect(sub.realValue).toBe(true);
    expect(sub.approvalRef).toBe('APR-1');
    expect(sub.screeningRef).toBe('SCR-1');
    delete process.env.CLEARING_REQUIRE_APPROVAL_REF;
  });

  it('enforces maker/checker: the approver must differ from the requester', async () => {
    stubCloudSql();
    vi.spyOn(PaymentProcessorOsEngine, '_get').mockResolvedValue(submittedRow());
    const dispatch = vi.spyOn(PaymentProcessorOsEngine, '_dispatch');
    await expect(PaymentProcessorOsEngine.approve({ submissionId: 'PPS-1', approvedBy: 'maker@dlbtrust.com' })).rejects.toMatchObject({ status: 409, message: /approver must differ from requester/ });
    await expect(PaymentProcessorOsEngine.approve({ submissionId: 'PPS-1' })).rejects.toMatchObject({ message: /approvedBy required/ });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('never dispatches a real-value approval without both references', async () => {
    stubCloudSql();
    process.env.PAYMENT_PROCESSOR_LIVE = 'true';
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(liveInventory());
    vi.spyOn(PaymentProcessorOsEngine, '_get').mockResolvedValue(submittedRow({ approval_ref: 'APR-1' }));
    const dispatch = vi.spyOn(PaymentProcessorOsEngine, '_dispatch');
    await expect(PaymentProcessorOsEngine.approve({ submissionId: 'PPS-1', approvedBy: 'checker@dlbtrust.com' }))
      .rejects.toMatchObject({ status: 409, message: /screeningRef .* required before a real-value payment is dispatched/ });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('records shadow approvals without calling any provider while PAYMENT_PROCESSOR_LIVE is off', async () => {
    const query = stubCloudSql();
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(shadowInventory());
    const row = submittedRow();
    vi.spyOn(PaymentProcessorOsEngine, '_get').mockImplementation(async () => row);
    query.mockImplementation(async (sql: any, params: any[] = []) => {
      if (/SET status = 'shadow'/i.test(String(sql))) { row.status = 'shadow'; row.route = 'shadow'; row.result = JSON.parse(params[1]); }
      return { rows: [] } as any;
    });
    const dispatch = vi.spyOn(PaymentProcessorOsEngine, '_dispatch');
    const processPayment = vi.spyOn(PaymentProcessorServerEngine, 'processPayment');
    const out = await PaymentProcessorOsEngine.approve({ submissionId: 'PPS-1', approvedBy: 'checker@dlbtrust.com' });
    expect(out.dispatched).toBe(false);
    expect(out.status).toBe('shadow');
    expect(out.note).toMatch(/PAYMENT_PROCESSOR_LIVE is not true/);
    expect(dispatch).not.toHaveBeenCalled();
    expect(processPayment).not.toHaveBeenCalled();
  });

  it('routes the Lili rail through BankSettlementEngine.clearAndSettle / ApiGatewayClearingEngine.clearPayment with both references', async () => {
    stubCloudSql();
    process.env.PAYMENT_PROCESSOR_LIVE = 'true';
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(liveInventory());
    const row = submittedRow({ approval_ref: 'APR-1', screening_ref: 'SCR-1', real_value: true });
    vi.spyOn(PaymentProcessorOsEngine, '_get').mockImplementation(async () => row);
    const settle = vi.spyOn(BankSettlementEngine, 'clearAndSettle').mockResolvedValue({ settlementId: 'STL-1', status: 'cleared' });
    const clear = vi.spyOn(ApiGatewayClearingEngine, 'clearPayment').mockResolvedValue({ eventId: 'GCE-1', status: 'cleared' });
    const processPayment = vi.spyOn(PaymentProcessorServerEngine, 'processPayment');

    const out = await PaymentProcessorOsEngine.approve({ submissionId: 'PPS-1', approvedBy: 'checker@dlbtrust.com' });
    expect(out.dispatched).toBe(true);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0][0]).toMatchObject({ bankId: 'lili', rail: 'ach', approvalRef: 'APR-1', screeningRef: 'SCR-1', amountCents: 12500, initiatedBy: 'checker@dlbtrust.com' });
    expect(processPayment).not.toHaveBeenCalled();

    row.rail = 'api_gateway';
    row.status = 'submitted';
    await PaymentProcessorOsEngine.approve({ submissionId: 'PPS-1', approvedBy: 'checker@dlbtrust.com' });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(clear.mock.calls[0][0]).toMatchObject({ rail: 'api_gateway', approvalRef: 'APR-1', screeningRef: 'SCR-1', flow: 'payment_processor' });
  });

  it('dispatches non-Lili processors through PaymentProcessorServerEngine.processPayment with the approval trail in metadata', async () => {
    stubCloudSql();
    process.env.PAYMENT_PROCESSOR_LIVE = 'true';
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(liveInventory('stripe_treasury'));
    const row = submittedRow({ processor: 'stripe_treasury', rail: 'stripe_ach', approval_ref: 'APR-1', screening_ref: 'SCR-1', real_value: true });
    vi.spyOn(PaymentProcessorOsEngine, '_get').mockImplementation(async () => row);
    const processPayment = vi.spyOn(PaymentProcessorServerEngine, 'processPayment').mockResolvedValue({ processorTxId: 'PPT-1', status: 'submitted' });
    const out = await PaymentProcessorOsEngine.approve({ submissionId: 'PPS-1', approvedBy: 'checker@dlbtrust.com' });
    expect(out.dispatched).toBe(true);
    expect(processPayment).toHaveBeenCalledTimes(1);
    expect(processPayment.mock.calls[0][0]).toMatchObject({
      processor: 'stripe_treasury', rail: 'stripe_ach', initiatedBy: 'checker@dlbtrust.com',
      metadata: { submissionId: 'PPS-1', approvalRef: 'APR-1', screeningRef: 'SCR-1', approvedBy: 'checker@dlbtrust.com' },
    });
  });
});

describe('payment-processor readiness on dlb-treasury-management', () => {
  it('reports shadow mode and the exact blockers while live flags and secrets are absent', async () => {
    stubCloudSql(['payment_intents']);
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    const r = await EngineWiringReadiness.engineReadiness('payment-processor');
    expect(r.engine).toBe('payment-processor');
    expect(r.title).toBe('Payment Processor OS Engine');
    expect(r.ready).toBe(false);
    expect(r.healthy).toBe(true);
    expect(r.mode).toBe('shadow');
    expect(r.gcp.project).toBe('dlb-treasury-management');
    expect(r.gcp.ledger.connected).toBe(true);
    expect(r.liveFlags).toMatchObject({ PAYMENT_PROCESSOR_LIVE: false, STRIPE_KEY_MODE: 'test', PAYMENT_HUB_LIVE: false, LILI_CLEARING_LIVE: false, CLEARING_API_ENDPOINT: null, REQUIRE_APPROVAL_REF: true, REQUIRE_SCREENING_REF: true });
    expect(r.tables).toMatchObject({ payment_processor_transactions: true, payment_gateway_transactions: true, payment_intents: false, payment_approvals: true });
    expect(r.blockers.some((b: string) => b.startsWith('PAYMENT_PROCESSOR_LIVE is not true'))).toBe(true);
    expect(r.blockers.some((b: string) => /no real-value processor/.test(b) && /STRIPE_SECRET_KEY is sk_test_/.test(b) && /PAYMENT_HUB_LIVE=false/.test(b) && /LILI_CLEARING_LIVE=false/.test(b) && /CLEARING_API_ENDPOINT not set/.test(b))).toBe(true);
    expect(r.blockers).toContain('PAYMENT_DATA_ENCRYPTION_KEY not set (payment methods are stored encrypted)');
    expect(r.blockers).toContain('Cloud SQL tables missing: payment_intents');
  });

  it('names the relaxed gate and the missing processor secrets as blockers', async () => {
    stubCloudSql();
    process.env.PAYMENT_PROCESSOR_LIVE = 'true';
    process.env.PAYMENT_PROCESSOR_REQUIRE_SCREENING_REF = 'false';
    process.env.STRIPE_SECRET_KEY = 'sk_live_123';
    process.env.CLEARING_API_ENDPOINT = 'https://clearing.partner.example/v1';
    const r = await EngineWiringReadiness.engineReadiness('payment-processor');
    expect(r.ready).toBe(false);
    expect(r.blockers).toContain('PAYMENT_PROCESSOR_REQUIRE_SCREENING_REF=false disables the screeningRef gate');
    expect(r.blockers.some((b: string) => b.startsWith('STRIPE_PAYMENTS_SECRET_KEY not set'))).toBe(true);
    expect(r.blockers).toContain('CLEARING_API_KEY not set while CLEARING_API_ENDPOINT is configured');
    expect(r.blockers.some((b: string) => /GCP_PROJECT/.test(b))).toBe(false);
  });

  it('blocks a self-loopback clearing endpoint and the wrong GCP project', async () => {
    stubCloudSql();
    process.env.PAYMENT_PROCESSOR_LIVE = 'true';
    process.env.CLEARING_API_ENDPOINT = 'https://dlbtrust-app-r5oawu76jq-ue.a.run.app/api/clearing';
    process.env.CLEARING_API_KEY = 'k';
    process.env.GCP_PROJECT = 'dlb-treasury';
    process.env.GOOGLE_CLOUD_PROJECT = 'dlb-treasury';
    const r = await EngineWiringReadiness.engineReadiness('payment-processor');
    expect(r.ready).toBe(false);
    expect(r.mode).toBe('shadow');
    expect(r.blockers.some((b: string) => /CLEARING_API_ENDPOINT=.* is a self-loopback/.test(b))).toBe(true);
    expect(r.blockers).toContain('GCP_PROJECT is dlb-treasury, expected dlb-treasury-management');
  });

  it('goes live once PAYMENT_PROCESSOR_LIVE, a real-value processor, the gates and the secrets are in place', async () => {
    stubCloudSql();
    process.env.PAYMENT_PROCESSOR_LIVE = 'true';
    process.env.PAYMENT_DATA_ENCRYPTION_KEY = 'ab'.repeat(32);
    process.env.STRIPE_SECRET_KEY = 'sk_live_123';
    process.env.STRIPE_PAYMENTS_SECRET_KEY = 'rk_live_456';
    process.env.STRIPE_TREASURY_FINANCIAL_ACCOUNT_ID = 'fa_1';
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue({
      ...liveInventory('stripe_treasury'),
      config: PaymentProcessorOsEngine.getConfig(),
    });
    const r = await EngineWiringReadiness.engineReadiness('payment-processor');
    expect(r.blockers).toEqual([]);
    expect(r.ready).toBe(true);
    expect(r.mode).toBe('live');
    expect(r.provider).toBe('stripe_treasury');
    expect(r.liveFlags.STRIPE_KEY_MODE).toBe('live');
    expect(r.liveFlags.STRIPE_PAYMENTS_KEY_MODE).toBe('live');
  });

  it('GET /api/os/readiness returns 503 until payment-processor is ready and /readiness/payment-processor reports mode + blockers', async () => {
    stubCloudSql();
    stubOtherEnginesReady();

    const all = responseStub();
    await routeHandler('get', '/readiness')({ params: {}, query: {} }, all);
    expect(all.statusCode).toBe(503);
    expect(all.body.data.ready).toBe(false);
    expect(all.body.data.total).toBe(10);
    expect(all.body.data.readyCount).toBe(9);
    expect(all.body.data.engines['payment-processor'].ready).toBe(false);

    const one = responseStub();
    await routeHandler('get', '/readiness/:platformEngine')({ params: { platformEngine: 'payment-processor' }, query: {} }, one);
    expect(one.statusCode).toBe(503);
    expect(one.body.data.mode).toBe('shadow');
    expect(one.body.data.blockers.some((b: string) => b.startsWith('PAYMENT_PROCESSOR_LIVE is not true'))).toBe(true);

    process.env.PAYMENT_PROCESSOR_LIVE = 'true';
    process.env.PAYMENT_SERVER_SERVICE_TOKEN = 'svc';
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue({ ...liveInventory('payment_hub'), config: PaymentProcessorOsEngine.getConfig() });
    const ok = responseStub();
    await routeHandler('get', '/readiness')({ params: {}, query: {} }, ok);
    expect(ok.statusCode).toBe(200);
    expect(ok.body.data.readyCount).toBe(10);
  });
});

describe('canonical-money unified pipeline', () => {
  it('includes the payment_processor stage', async () => {
    stubCloudSql();
    const out = await OS.CanonicalMoneyOSEngine.process({ action: 'pipeline', limit: 5 });
    expect(out.result.stages).toContain('payment_processor');
    expect(out.result.paymentProcessor.ok).toBe(true);
    expect(out.result.paymentProcessor.value.engine).toBe('payment-processor');
    expect(out.result.paymentProcessor.value.mode).toBe('shadow');
  });
});
