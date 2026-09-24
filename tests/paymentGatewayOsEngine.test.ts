import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

process.env.DAPP_RPC_URL = process.env.DAPP_RPC_URL || 'http://127.0.0.1:8545';
process.env.DAPP_USDC_ADDRESS = process.env.DAPP_USDC_ADDRESS || '0x2222222222222222222222222222222222222222';

const pool = require('../server/integrations/bonds/pgPool');
const { PaymentGatewayOsEngine } = require('../server/integrations/os/paymentGatewayOsEngine');
const { PaymentProcessorOsEngine } = require('../server/integrations/os/paymentProcessorOsEngine');
const { EngineWiringReadiness } = require('../server/integrations/os/engineWiringReadiness');
const { PaymentGatewayServerEngine } = require('../server/integrations/payments/paymentGatewayServerEngine');
const { DistributionRequestEngine } = require('../server/integrations/dapp/distributionRequestEngine');
const { ApiGatewayClearingEngine } = require('../server/integrations/dapp/apiGatewayClearingEngine');
const OS = require('../server/integrations/os/osEngine');
const osRouter = require('../server/routes/os');
const paymentHubConfig = require('../server/integrations/paymentHub/paymentHubConfig');
const { CreditOsEngine } = require('../server/integrations/os/creditOsEngine');
const { DebtOsEngine } = require('../server/integrations/os/debtOsEngine');
const { LiquidityOsEngine } = require('../server/integrations/os/liquidityOsEngine');

const ENV_KEYS = [
  'GCP_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'DATABASE_URL', 'APP_URL', 'DEPLOY_URL', 'DOMAIN',
  'PAYMENT_GATEWAY_LIVE', 'PAYMENT_GATEWAY_REQUIRE_APPROVAL_REF', 'PAYMENT_GATEWAY_REQUIRE_SCREENING_REF',
  'PAYMENT_GATEWAY_REQUIRE_DISTRIBUTION_REQUEST', 'PAYMENT_GATEWAY_DEFAULT_PROCESSOR', 'PAYMENT_GATEWAY_MAX_DISBURSEMENT_CENTS',
  'PAYMENT_GATEWAY_WEBHOOK_SECRET',
  'PAYMENT_PROCESSOR_LIVE', 'PAYMENT_PROCESSOR_REQUIRE_APPROVAL_REF', 'PAYMENT_PROCESSOR_REQUIRE_SCREENING_REF',
  'PAYMENT_PROCESSOR_DEFAULT', 'STRIPE_SECRET_KEY', 'STRIPE_PAYMENTS_SECRET_KEY', 'STRIPE_TREASURY_FINANCIAL_ACCOUNT_ID',
  'PAYMENT_HUB_LIVE', 'LILI_CLEARING_LIVE', 'CLEARING_API_ENDPOINT', 'CLEARING_API_KEY',
  'PAYMENT_DATA_ENCRYPTION_KEY', 'PAYMENT_SERVER_SERVICE_TOKEN', 'CLEARING_REQUIRE_APPROVAL_REF',
  'K_SERVICE', 'K_REVISION', 'GCS_CLEARING_EVIDENCE_BUCKET', 'API_GATEWAY_PROVIDER', 'PAYMENT_HUB_MODE', 'CROSS_CHAIN_ENABLED', 'CROSS_CHAIN_SHADOW',
];
const saved: Record<string, string | undefined> = {};

/** Same wiring the readiness audit uses to bring the other ten engines to ready. */
function stubOtherEnginesReady() {
  Object.assign(process.env, {
    K_SERVICE: 'dlbtrust-app', K_REVISION: 'dlbtrust-app-00042-abc', GCS_CLEARING_EVIDENCE_BUCKET: 'dlb-treasury-management-clearing-evidence',
    API_GATEWAY_PROVIDER: 'lili', LILI_CLEARING_LIVE: 'true', PAYMENT_HUB_MODE: 'phee', PAYMENT_HUB_LIVE: 'true',
    PAYMENT_DATA_ENCRYPTION_KEY: 'ab'.repeat(32), CROSS_CHAIN_ENABLED: 'true', CROSS_CHAIN_SHADOW: 'true',
    PAYMENT_PROCESSOR_LIVE: 'true', PAYMENT_SERVER_SERVICE_TOKEN: 'svc',
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
  vi.spyOn(PaymentProcessorOsEngine, 'processors').mockImplementation(async () => upstreamLive('payment_hub'));
}

function upstreamLive(processor = 'payment_hub') {
  return {
    config: { ...PaymentProcessorOsEngine.getConfig(), live: true, requireApproval: true, requireScreening: true },
    sources: [{ id: processor, liveFlag: 'PAYMENT_HUB_LIVE', mode: 'live', configured: true, realValueCapable: true, reason: null }],
    realValueCapable: [processor],
    anyRealValueCapable: true,
  };
}

function upstreamShadow() {
  return {
    config: { ...PaymentProcessorOsEngine.getConfig(), live: false },
    sources: [{ id: 'stripe_treasury', liveFlag: 'STRIPE_SECRET_KEY', mode: 'test', configured: true, realValueCapable: false, reason: 'STRIPE_SECRET_KEY is sk_test_ (test mode)' }],
    realValueCapable: [],
    anyRealValueCapable: false,
  };
}

/** Bring the gateway itself to live: flags, encryption key and a live upstream processor. */
function gatewayLive(processor = 'payment_hub') {
  process.env.PAYMENT_GATEWAY_LIVE = 'true';
  process.env.PAYMENT_PROCESSOR_LIVE = 'true';
  process.env.PAYMENT_DATA_ENCRYPTION_KEY = 'ab'.repeat(32);
  vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(upstreamLive(processor));
}

function achMethod(overrides: Record<string, any> = {}) {
  return { method_id: 'PM-ACH-1', type: 'ach', processor: 'payment_hub', member_id: 'beneficiary@dlbtrust.com', last4: '6789', status: 'active', ...overrides };
}

function distributionRequest(overrides: Record<string, any> = {}) {
  return { id: 'DR-1', type: 'distribution', requester_role: 'beneficiary', beneficiary_email: 'beneficiary@dlbtrust.com', amount_cents: 250000, currency: 'USD', status: 'approved', approvals: [], ...overrides };
}

function intentRow(overrides: Record<string, any> = {}) {
  return {
    intent_id: 'PGI-1', purpose: 'distribution', operation: 'sale', processor: 'payment_hub', method_id: 'PM-ACH-1', distribution_request_id: 'DR-1',
    beneficiary_email: 'beneficiary@dlbtrust.com', amount_cents: 250000, currency: 'USD', status: 'submitted', real_value: false, reference: 'DR-1',
    destination: {}, metadata: { methodType: 'ach' }, requested_by: 'maker@dlbtrust.com', approved_by: null, approval_ref: null, screening_ref: null,
    gateway_tx_id: null, processor_tx_id: null, route: null, result: null, error_message: null, created_at: new Date(), approved_at: null, executed_at: null,
    ...overrides,
  };
}

/** Cloud SQL stub: connectivity probe answers, every requested table exists unless listed in `missing`; intents come from `rows`. */
function stubCloudSql(missing: string[] = [], rows: Record<string, any> = {}) {
  return vi.spyOn(pool, 'query').mockImplementation(async (sql: any, params: any = []) => {
    const text = String(sql);
    if (/current_database\(\)/i.test(text)) return { rows: [{ db: 'dlbtrust', version: 'PostgreSQL 16' }] } as any;
    if (/information_schema\.tables/i.test(text)) {
      const names: string[] = params[0] || [];
      return { rows: names.filter(n => !missing.includes(n)).map(table_name => ({ table_name })) } as any;
    }
    if (/SELECT \* FROM payment_gateway_intents WHERE intent_id/i.test(text)) return { rows: rows[params[0]] ? [rows[params[0]]] : [] } as any;
    if (/INSERT INTO payment_gateway_intents/i.test(text)) {
      const [intent_id, purpose, operation, processor, method_id, distribution_request_id, beneficiary_email, amount_cents, currency, real_value, reference, destination, metadata, requested_by, approval_ref, screening_ref, gateway_tx_id] = params;
      return { rows: [intentRow({ intent_id, purpose, operation, processor, method_id, distribution_request_id, beneficiary_email, amount_cents, currency, real_value, reference, destination: JSON.parse(destination), metadata: JSON.parse(metadata), requested_by, approval_ref, screening_ref, gateway_tx_id })] } as any;
    }
    if (/UPDATE payment_gateway_intents SET status = 'approved'/i.test(text) && rows[params[0]]) {
      Object.assign(rows[params[0]], { status: 'approved', approved_by: params[1], approval_ref: params[2], screening_ref: params[3], real_value: params[4] });
    }
    if (/UPDATE payment_gateway_intents SET status = 'shadow'/i.test(text) && rows[params[0]]) Object.assign(rows[params[0]], { status: 'shadow', route: 'shadow', result: JSON.parse(params[1]) });
    if (/UPDATE payment_gateway_intents SET status = 'executed'/i.test(text) && rows[params[0]]) Object.assign(rows[params[0]], { status: 'executed', route: params[1], gateway_tx_id: params[2], processor_tx_id: params[3], result: JSON.parse(params[4]) });
    if (/UPDATE payment_gateway_intents SET status = 'failed'/i.test(text) && rows[params[0]]) Object.assign(rows[params[0]], { status: 'failed', error_message: params[1] });
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

describe('payment-gateway OS engine registration and routing', () => {
  it('is registered as the eleventh platform engine in the OS engine map, route map and readiness audit', () => {
    expect(OS.engines['payment-gateway']).toBe(OS.PaymentGatewayPlatformEngine);
    expect(OS.PaymentGatewayPlatformEngine.platformEngine).toBe('payment-gateway');
    expect(OS.PaymentGatewayPlatformEngine.engineName).toBe('payment-gateway');
    expect(EngineWiringReadiness.ENGINE_KEYS).toContain('payment-gateway');
    expect(EngineWiringReadiness.ENGINE_KEYS).toHaveLength(11);
    expect(EngineWiringReadiness.ENGINE_TITLES['payment-gateway']).toMatch(/Payment Gateway OS Engine/);
    expect(PaymentGatewayOsEngine.PURPOSES).toEqual(['distribution', 'disbursement']);
    const paths = osRouter.stack.filter((l: any) => l.route).map((l: any) => l.route.path);
    expect(paths).toEqual(expect.arrayContaining(['/:engine/status', '/:engine/readiness', '/:engine/list', '/:engine/process', '/payment-gateway/webhook', '/readiness/:platformEngine']));
  });

  it('serves /api/os/payment-gateway/{status,readiness} through the generic engine routes', async () => {
    stubCloudSql();
    const getEngine = osRouter.stack.find((l: any) => l.route?.path === '/:engine/status').route.stack.find((s: any) => s.name === 'getEngine').handle;
    const req: any = { params: { engine: 'payment-gateway' }, query: {}, body: {} };
    const next = vi.fn();
    getEngine(req, responseStub(), next);
    expect(next).toHaveBeenCalled();
    expect(req.osEngine).toBe(OS.PaymentGatewayPlatformEngine);

    const statusRes = responseStub();
    await routeHandler('get', '/:engine/status')(req, statusRes);
    expect(statusRes.body.success).toBe(true);
    expect(statusRes.body.data.engine).toBe('payment-gateway');
    expect(statusRes.body.data.mode).toBe('shadow');
    expect(statusRes.body.data.purposes).toEqual(['distribution', 'disbursement']);
    expect(statusRes.body.data.integrations).toMatchObject({ paymentGatewayOs: true, gateway: true, paymentProcessorOs: true, distributionRequests: true });

    const readyRes = responseStub();
    await routeHandler('get', '/:engine/readiness')(req, readyRes);
    expect(readyRes.body.data.engine).toBe('payment-gateway');
    expect(readyRes.body.data.mode).toBe('shadow');
    expect(Array.isArray(readyRes.body.data.blockers)).toBe(true);
  });

  it('rejects direct gateway money movement on /process with 409 and writes a rejected os_events audit row', async () => {
    const query = stubCloudSql();
    const handler = routeHandler('post', '/:engine/process');
    for (const action of ['sale', 'authorize', 'capture', 'refund', 'void', 'payout', 'disburse', 'createSession']) {
      const res = responseStub();
      await handler({ params: { engine: 'payment-gateway' }, body: { action, amount: 100 }, osEngine: OS.PaymentGatewayPlatformEngine, user: { username: 'ops-admin' } }, res);
      expect(res.statusCode, action).toBe(409);
      expect(res.body.error).toMatch(/maker-checker/);
    }
    const audits = query.mock.calls.filter(([sql, params]: any[]) => /INSERT INTO os_events/i.test(String(sql)) && params[1] === 'payment-gateway');
    expect(audits).toHaveLength(8);
    expect(audits[0][1][2]).toBe('sale');
    expect(audits[0][1][3]).toBe('rejected');
    expect(JSON.parse(audits[0][1][5])).toMatchObject({ rejected: true, actor: 'ops-admin' });

    const bogus = responseStub();
    await handler({ params: { engine: 'payment-gateway' }, body: { action: 'wire-now' }, osEngine: OS.PaymentGatewayPlatformEngine }, bogus);
    expect(bogus.statusCode).toBe(400);
    expect(bogus.body.error).toMatch(/Unknown payment-gateway action: wire-now/);
  });

  it('also audits the rejected direct actions of the payment-processor engine', async () => {
    const query = stubCloudSql();
    const res = responseStub();
    await routeHandler('post', '/:engine/process')({ params: { engine: 'payment-processor' }, body: { action: 'processPayment' }, osEngine: OS.PaymentProcessorPlatformEngine, user: { username: 'ops-admin' } }, res);
    expect(res.statusCode).toBe(409);
    const audit = query.mock.calls.find(([sql, params]: any[]) => /INSERT INTO os_events/i.test(String(sql)) && params[1] === 'payment-processor');
    expect(audit).toBeDefined();
    expect(audit![1][3]).toBe('rejected');
  });

  it('records every gated action in os_events through BaseOSEngine.process', async () => {
    const query = stubCloudSql();
    vi.spyOn(PaymentGatewayOsEngine, 'pipeline').mockResolvedValue({ byStatus: {}, byPurpose: {}, liveExposureCents: 0 });
    const out = await OS.PaymentGatewayPlatformEngine.process({ action: 'pipeline' });
    expect(out.success).toBe(true);
    expect(out.engine).toBe('payment-gateway');
    expect(out.eventId).toMatch(/^payment-gateway-/);
    const logged = query.mock.calls.find(([sql]: any[]) => /INSERT INTO os_events/i.test(String(sql)));
    expect(logged![1]).toContain('payment-gateway');
    expect(logged![1][3]).toBe('completed');
  });
});

describe('payment-gateway tokenized beneficiary payout methods', () => {
  it('tokenizes an ACH payout method for a beneficiary without moving money', async () => {
    stubCloudSql();
    const tokenize = vi.spyOn(PaymentGatewayServerEngine, 'tokenizePaymentMethod').mockResolvedValue(achMethod());
    const sale = vi.spyOn(PaymentGatewayServerEngine, 'sale');
    const out = await PaymentGatewayOsEngine.tokenize({ type: 'ach', processor: 'payment_hub', payload: { accountNumber: '000123456789', routingNumber: '021000021' }, beneficiaryEmail: 'beneficiary@dlbtrust.com', initiatedBy: 'maker@dlbtrust.com' });
    expect(out.method_id).toBe('PM-ACH-1');
    expect(tokenize).toHaveBeenCalledWith(expect.objectContaining({ type: 'ach', memberId: 'beneficiary@dlbtrust.com', billingDetails: expect.objectContaining({ beneficiaryEmail: 'beneficiary@dlbtrust.com' }) }));
    expect(sale).not.toHaveBeenCalled();
    await expect(PaymentGatewayOsEngine.tokenize({ type: 'cheque' })).rejects.toMatchObject({ message: /type must be one of card, ach, wallet, crypto/ });
  });

  it('refuses to tokenize in live mode without the payment-data encryption key', async () => {
    stubCloudSql();
    process.env.PAYMENT_GATEWAY_LIVE = 'true';
    await expect(PaymentGatewayOsEngine.tokenize({ type: 'ach', payload: {} })).rejects.toMatchObject({ status: 409, message: /PAYMENT_DATA_ENCRYPTION_KEY/ });
  });
});

describe('payment-gateway fail-closed distribution / disbursement gates', () => {
  it('records a shadow distribution intent bound to a trustee distribution request', async () => {
    const query = stubCloudSql();
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(upstreamShadow());
    vi.spyOn(PaymentGatewayServerEngine, 'getMethod').mockResolvedValue(achMethod());
    vi.spyOn(DistributionRequestEngine, 'getRequest').mockResolvedValue(distributionRequest({ status: 'under_review' }));
    const intent = await PaymentGatewayOsEngine.submit({ purpose: 'distribution', methodId: 'PM-ACH-1', distributionRequestId: 'DR-1', amountCents: 250000, requestedBy: 'maker@dlbtrust.com' });
    expect(intent.status).toBe('submitted');
    expect(intent.purpose).toBe('distribution');
    expect(intent.processor).toBe('payment_hub');
    expect(intent.realValue).toBe(false);
    expect(intent.distributionRequestId).toBe('DR-1');
    expect(intent.beneficiaryEmail).toBe('beneficiary@dlbtrust.com');
    expect(query.mock.calls.some(([sql]: any[]) => /INSERT INTO payment_gateway_intents/i.test(String(sql)))).toBe(true);
  });

  it('requires a distribution request when PAYMENT_GATEWAY_REQUIRE_DISTRIBUTION_REQUEST=true and refuses amount mismatches or rejected requests', async () => {
    stubCloudSql();
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(upstreamShadow());
    vi.spyOn(PaymentGatewayServerEngine, 'getMethod').mockResolvedValue(achMethod());
    process.env.PAYMENT_GATEWAY_REQUIRE_DISTRIBUTION_REQUEST = 'true';
    const base = { purpose: 'disbursement', methodId: 'PM-ACH-1', amountCents: 250000, requestedBy: 'maker@dlbtrust.com' };
    await expect(PaymentGatewayOsEngine.submit(base)).rejects.toMatchObject({ status: 409, message: /distributionRequestId is required/ });
    const getRequest = vi.spyOn(DistributionRequestEngine, 'getRequest');
    getRequest.mockResolvedValueOnce(null);
    await expect(PaymentGatewayOsEngine.submit({ ...base, distributionRequestId: 'DR-404' })).rejects.toMatchObject({ status: 404 });
    getRequest.mockResolvedValueOnce(distributionRequest({ status: 'rejected' }));
    await expect(PaymentGatewayOsEngine.submit({ ...base, distributionRequestId: 'DR-1' })).rejects.toMatchObject({ status: 409, message: /is rejected/ });
    getRequest.mockResolvedValueOnce(distributionRequest({ amount_cents: 100000 }));
    await expect(PaymentGatewayOsEngine.submit({ ...base, distributionRequestId: 'DR-1' })).rejects.toMatchObject({ status: 409, message: /does not match distribution request/ });
  });

  it('refuses self-loopback destinations, disabled payout methods and amounts over the disbursement cap', async () => {
    const query = stubCloudSql();
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(upstreamShadow());
    const getMethod = vi.spyOn(PaymentGatewayServerEngine, 'getMethod').mockResolvedValue(achMethod());
    vi.spyOn(DistributionRequestEngine, 'getRequest').mockResolvedValue(distributionRequest());
    const base = { purpose: 'disbursement', methodId: 'PM-ACH-1', distributionRequestId: 'DR-1', amountCents: 250000, requestedBy: 'maker@dlbtrust.com' };
    await expect(PaymentGatewayOsEngine.submit({ ...base, destination: { partnerUrl: 'direct' } })).rejects.toMatchObject({ status: 409, message: /self-loopback partner refused/ });
    await expect(PaymentGatewayOsEngine.submit({ ...base, destination: { partnerAs2Id: 'DLBTRUST-DIRECT' } })).rejects.toMatchObject({ status: 409 });
    await expect(PaymentGatewayOsEngine.submit({ ...base, destination: { endpoint: 'https://dlbtrust-app-r5oawu76jq-ue.a.run.app/api/os/payment-gateway/process' } })).rejects.toMatchObject({ status: 409 });
    getMethod.mockResolvedValueOnce(achMethod({ status: 'disabled' }));
    await expect(PaymentGatewayOsEngine.submit(base)).rejects.toMatchObject({ status: 409, message: /is disabled/ });
    process.env.PAYMENT_GATEWAY_MAX_DISBURSEMENT_CENTS = '100000';
    await expect(PaymentGatewayOsEngine.submit(base)).rejects.toMatchObject({ status: 409, message: /exceeds PAYMENT_GATEWAY_MAX_DISBURSEMENT_CENTS/ });
    expect(query.mock.calls.some(([sql]: any[]) => /INSERT INTO payment_gateway_intents/i.test(String(sql)))).toBe(false);
  });

  it('requires approvalRef + screeningRef for every real-value submission', async () => {
    stubCloudSql();
    gatewayLive();
    vi.spyOn(PaymentGatewayServerEngine, 'getMethod').mockResolvedValue(achMethod());
    vi.spyOn(DistributionRequestEngine, 'getRequest').mockResolvedValue(distributionRequest());
    const base = { purpose: 'distribution', methodId: 'PM-ACH-1', distributionRequestId: 'DR-1', amountCents: 250000, requestedBy: 'maker@dlbtrust.com' };
    await expect(PaymentGatewayOsEngine.submit(base)).rejects.toMatchObject({ status: 409, message: /approvalRef .* required for a real-value gateway disbursement/ });
    await expect(PaymentGatewayOsEngine.submit({ ...base, approvalRef: 'APR-1' })).rejects.toMatchObject({ status: 409, message: /screeningRef .* required/ });
    const ok = await PaymentGatewayOsEngine.submit({ ...base, approvalRef: 'APR-1', screeningRef: 'SCR-1' });
    expect(ok.realValue).toBe(true);
    expect(ok.status).toBe('submitted');
  });

  it('enforces maker/checker: the approver must differ from the requester', async () => {
    stubCloudSql([], { 'PGI-1': intentRow() });
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(upstreamShadow());
    await expect(PaymentGatewayOsEngine.approve({ intentId: 'PGI-1', approvedBy: 'maker@dlbtrust.com' })).rejects.toMatchObject({ status: 409, message: /approver must differ from requester/ });
    await expect(PaymentGatewayOsEngine.approve({ intentId: 'PGI-404', approvedBy: 'checker@dlbtrust.com' })).rejects.toMatchObject({ status: 404 });
  });

  it('records shadow approvals without calling the gateway while PAYMENT_GATEWAY_LIVE is off', async () => {
    const rows = { 'PGI-1': intentRow() };
    stubCloudSql([], rows);
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(upstreamShadow());
    const sale = vi.spyOn(PaymentGatewayServerEngine, 'sale');
    const out = await PaymentGatewayOsEngine.approve({ intentId: 'PGI-1', approvedBy: 'checker@dlbtrust.com' });
    expect(out.status).toBe('shadow');
    expect(out.dispatched).toBe(false);
    expect(out.note).toBe('PAYMENT_GATEWAY_LIVE=false');
    expect(sale).not.toHaveBeenCalled();
    await expect(PaymentGatewayOsEngine.approve({ intentId: 'PGI-1', approvedBy: 'checker@dlbtrust.com' })).rejects.toMatchObject({ status: 409, message: /is shadow, expected submitted/ });
  });

  it('never dispatches a real-value approval without both references or a two-trustee-approved distribution request', async () => {
    const rows = { 'PGI-1': intentRow() };
    stubCloudSql([], rows);
    gatewayLive();
    const sale = vi.spyOn(PaymentGatewayServerEngine, 'sale');
    const getRequest = vi.spyOn(DistributionRequestEngine, 'getRequest').mockResolvedValue(distributionRequest({ status: 'under_review' }));
    await expect(PaymentGatewayOsEngine.approve({ intentId: 'PGI-1', approvedBy: 'checker@dlbtrust.com' })).rejects.toMatchObject({ status: 409, message: /approvalRef/ });
    await expect(PaymentGatewayOsEngine.approve({ intentId: 'PGI-1', approvedBy: 'checker@dlbtrust.com', approvalRef: 'APR-1' })).rejects.toMatchObject({ status: 409, message: /screeningRef/ });
    await expect(PaymentGatewayOsEngine.approve({ intentId: 'PGI-1', approvedBy: 'checker@dlbtrust.com', approvalRef: 'APR-1', screeningRef: 'SCR-1' })).rejects.toMatchObject({ status: 409, message: /must be approved by both trustees before dispatch \(status under_review\)/ });
    expect(getRequest).toHaveBeenCalledWith('DR-1');
    expect(sale).not.toHaveBeenCalled();
    expect(rows['PGI-1'].status).toBe('submitted');
  });

  it('dispatches an approved real-value distribution through PaymentGatewayServerEngine.sale and marks the request payout_created', async () => {
    const rows = { 'PGI-1': intentRow() };
    stubCloudSql([], rows);
    gatewayLive();
    vi.spyOn(DistributionRequestEngine, 'getRequest').mockResolvedValue(distributionRequest({ status: 'approved' }));
    const update = vi.spyOn(DistributionRequestEngine, '_update').mockResolvedValue(distributionRequest({ status: 'payout_created' }));
    const sale = vi.spyOn(PaymentGatewayServerEngine, 'sale').mockResolvedValue({ gatewayTxId: 'GW-TX-1', processorTxId: 'PH-1', status: 'succeeded' });
    const out = await PaymentGatewayOsEngine.approve({ intentId: 'PGI-1', approvedBy: 'checker@dlbtrust.com', approvalRef: 'APR-1', screeningRef: 'SCR-1' });
    expect(out.status).toBe('executed');
    expect(out.dispatched).toBe(true);
    expect(out.gatewayTxId).toBe('GW-TX-1');
    expect(out.route).toBe('PaymentGatewayServerEngine.sale');
    expect(sale).toHaveBeenCalledTimes(1);
    expect(sale.mock.calls[0][0]).toMatchObject({
      amount: 2500, currency: 'USD', methodId: 'PM-ACH-1', processor: 'payment_hub', direction: 'outbound', initiatedBy: 'checker@dlbtrust.com',
      metadata: expect.objectContaining({ purpose: 'distribution', distributionRequestId: 'DR-1', approvalRef: 'APR-1', screeningRef: 'SCR-1', approvedBy: 'checker@dlbtrust.com' }),
    });
    expect(update).toHaveBeenCalledWith('DR-1', expect.objectContaining({ status: 'payout_created', payout_id: 'GW-TX-1' }));
  });

  it('marks the intent failed when the gateway dispatch throws', async () => {
    const rows = { 'PGI-1': intentRow({ approval_ref: 'APR-1', screening_ref: 'SCR-1' }) };
    stubCloudSql([], rows);
    gatewayLive();
    vi.spyOn(DistributionRequestEngine, 'getRequest').mockResolvedValue(distributionRequest());
    vi.spyOn(PaymentGatewayServerEngine, 'sale').mockRejectedValue(new Error('processor declined'));
    await expect(PaymentGatewayOsEngine.approve({ intentId: 'PGI-1', approvedBy: 'checker@dlbtrust.com' })).rejects.toMatchObject({ status: 502, message: /dispatch failed: processor declined/ });
    expect(rows['PGI-1'].status).toBe('failed');
    expect(rows['PGI-1'].error_message).toBe('processor declined');
  });
});

describe('payment-gateway webhook and reconciliation', () => {
  it('verifies the processor callback HMAC and reconciles the gateway transaction', async () => {
    stubCloudSql();
    process.env.PAYMENT_GATEWAY_WEBHOOK_SECRET = 'whsec_test';
    const body = JSON.stringify({ gatewayTxId: 'GW-TX-1', processorTxId: 'PH-1', status: 'settled' });
    const reconcile = vi.spyOn(PaymentGatewayServerEngine, 'reconcileWebhook').mockResolvedValue({ gatewayTxId: 'GW-TX-1', status: 'settled' });
    vi.spyOn(PaymentGatewayOsEngine, '_getByTx').mockResolvedValue(null);
    const good = crypto.createHmac('sha256', 'whsec_test').update(body).digest('hex');

    await expect(PaymentGatewayOsEngine.webhook({ rawBody: body, signature: 'sha256=deadbeef', payload: JSON.parse(body) })).rejects.toMatchObject({ status: 401 });
    expect(reconcile).not.toHaveBeenCalled();

    const res = responseStub();
    await routeHandler('post', '/payment-gateway/webhook')({ body: JSON.parse(body), rawBody: Buffer.from(body), get: (h: string) => (h === 'x-gateway-signature' ? `sha256=${good}` : undefined) }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.result.reconciliation).toMatchObject({ status: 'settled' });
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ gatewayTxId: 'GW-TX-1', processorTxId: 'PH-1', status: 'settled' }));

    delete process.env.PAYMENT_GATEWAY_WEBHOOK_SECRET;
    expect(PaymentGatewayOsEngine.verifyWebhookSignature(body, good)).toMatchObject({ ok: false, reason: /PAYMENT_GATEWAY_WEBHOOK_SECRET not set/ });
  });
});

describe('payment-gateway readiness on dlb-treasury-management', () => {
  it('reports shadow mode and the exact blockers while live flags and secrets are absent', async () => {
    stubCloudSql(['payment_gateway_intents']);
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(upstreamShadow());
    const r = await EngineWiringReadiness.engineReadiness('payment-gateway');
    expect(r.engine).toBe('payment-gateway');
    expect(r.ready).toBe(false);
    expect(r.healthy).toBe(true);
    expect(r.mode).toBe('shadow');
    expect(r.gcp.project).toBe('dlb-treasury-management');
    expect(r.gcp.ledger.connected).toBe(true);
    expect(r.blockers).toEqual(expect.arrayContaining([
      expect.stringMatching(/^PAYMENT_GATEWAY_LIVE is not true/),
      expect.stringMatching(/^PAYMENT_PROCESSOR_LIVE is not true/),
      expect.stringMatching(/^no real-value gateway processor: .*PAYMENT_GATEWAY_LIVE=false/),
      expect.stringMatching(/^PAYMENT_GATEWAY_WEBHOOK_SECRET not set/),
      expect.stringMatching(/^PAYMENT_DATA_ENCRYPTION_KEY not set/),
      'Cloud SQL tables missing: payment_gateway_intents',
    ]));
    expect(r.tables.payment_gateway_intents).toBe(false);
    expect(r.tables.dapp_distribution_requests).toBe(true);
  });

  it('names relaxed gates and a test-mode Stripe payments key as blockers', async () => {
    stubCloudSql();
    gatewayLive();
    process.env.PAYMENT_GATEWAY_REQUIRE_APPROVAL_REF = 'false';
    process.env.PAYMENT_GATEWAY_REQUIRE_SCREENING_REF = 'false';
    process.env.STRIPE_PAYMENTS_SECRET_KEY = 'sk_test_abc';
    const r = await EngineWiringReadiness.engineReadiness('payment-gateway');
    expect(r.ready).toBe(false);
    expect(r.blockers).toEqual(expect.arrayContaining([
      'PAYMENT_GATEWAY_REQUIRE_APPROVAL_REF=false disables the approvalRef gate',
      'PAYMENT_GATEWAY_REQUIRE_SCREENING_REF=false disables the screeningRef gate',
      'STRIPE_PAYMENTS_SECRET_KEY is sk_test_ (test mode)',
      expect.stringMatching(/^PAYMENT_GATEWAY_WEBHOOK_SECRET not set/),
    ]));
  });

  it('goes live once PAYMENT_GATEWAY_LIVE, the processor engine, the gates and the secrets are in place', async () => {
    stubCloudSql();
    gatewayLive();
    process.env.PAYMENT_GATEWAY_WEBHOOK_SECRET = 'whsec_live';
    const r = await EngineWiringReadiness.engineReadiness('payment-gateway');
    expect(r.blockers).toEqual([]);
    expect(r.ready).toBe(true);
    expect(r.mode).toBe('live');
    expect(r.provider).toBe('payment_hub');
    expect(r.liveFlags).toMatchObject({ PAYMENT_GATEWAY_LIVE: true, PAYMENT_PROCESSOR_LIVE: true, REQUIRE_APPROVAL_REF: true, REQUIRE_SCREENING_REF: true, WEBHOOK_SECRET: true, REAL_VALUE_PROCESSORS: ['payment_hub'] });
  });

  it('GET /api/os/readiness returns 503 until payment-gateway is ready and /readiness/payment-gateway reports mode + blockers', async () => {
    stubCloudSql();
    stubOtherEnginesReady();

    const all = responseStub();
    await routeHandler('get', '/readiness')({ params: {}, query: {} }, all);
    expect(all.statusCode).toBe(503);
    expect(all.body.data.ready).toBe(false);
    expect(all.body.data.total).toBe(11);
    expect(all.body.data.readyCount).toBe(10);
    expect(all.body.data.engines['payment-gateway'].ready).toBe(false);
    expect(all.body.data.engines['payment-processor'].ready).toBe(true);

    const one = responseStub();
    await routeHandler('get', '/readiness/:platformEngine')({ params: { platformEngine: 'payment-gateway' }, query: {} }, one);
    expect(one.statusCode).toBe(503);
    expect(one.body.data.mode).toBe('shadow');
    expect(one.body.data.blockers.some((b: string) => b.startsWith('PAYMENT_GATEWAY_LIVE is not true'))).toBe(true);

    process.env.PAYMENT_GATEWAY_LIVE = 'true';
    process.env.PAYMENT_GATEWAY_WEBHOOK_SECRET = 'whsec_live';
    const ok = responseStub();
    await routeHandler('get', '/readiness')({ params: {}, query: {} }, ok);
    expect(ok.statusCode).toBe(200);
    expect(ok.body.data.readyCount).toBe(11);
  });
});

describe('canonical-money unified pipeline', () => {
  it('includes the payment_gateway stage after payment_processor', async () => {
    stubCloudSql();
    const out = await OS.CanonicalMoneyOSEngine.process({ action: 'pipeline', limit: 5 });
    expect(out.result.stages.slice(-2)).toEqual(['payment_processor', 'payment_gateway']);
    expect(out.result.paymentGateway.ok).toBe(true);
    expect(out.result.paymentGateway.value.engine).toBe('payment-gateway');
    expect(out.result.paymentGateway.value.mode).toBe('shadow');
  });
});
