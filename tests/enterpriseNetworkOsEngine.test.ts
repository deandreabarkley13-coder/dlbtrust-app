import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

process.env.DAPP_RPC_URL = process.env.DAPP_RPC_URL || 'http://127.0.0.1:8545';
process.env.DAPP_USDC_ADDRESS = process.env.DAPP_USDC_ADDRESS || '0x2222222222222222222222222222222222222222';

const pool = require('../server/integrations/bonds/pgPool');
const { EnterpriseNetworkOsEngine } = require('../server/integrations/os/enterpriseNetworkOsEngine');
const { EngineWiringReadiness } = require('../server/integrations/os/engineWiringReadiness');
const { PaymentGatewayServerEngine } = require('../server/integrations/payments/paymentGatewayServerEngine');
const { CashEngine } = require('../server/integrations/cash/cashEngine');
const OS = require('../server/integrations/os/osEngine');
const osRouter = require('../server/routes/os');

const ENV_KEYS = [
  'GCP_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'DATABASE_URL', 'APP_URL', 'DEPLOY_URL', 'DOMAIN',
  'ENTERPRISE_NETWORK_LIVE', 'ENTERPRISE_NETWORK_REQUIRE_APPROVAL_REF', 'ENTERPRISE_NETWORK_REQUIRE_SCREENING_REF', 'ENTERPRISE_NETWORK_WEBHOOK_SECRET',
];
const saved: Record<string, string | undefined> = {};

type Db = { intents: Record<string, any>; participants: Record<string, any>; limits: Record<string, any>; policies: Record<string, any>; openCents: Record<string, number> };

function participantRow(overrides: Record<string, any> = {}) {
  return { participant_id: 'ENP-1', name: 'Acme Vendor LLC', participant_type: 'vendor', status: 'active', jurisdiction: 'US', endpoint: {}, screening_ref: 'SCR-0', approval_ref: 'APR-0', metadata: {}, onboarded_by: 'maker@dlbtrust.com', approved_by: 'checker@dlbtrust.com', created_at: new Date(), updated_at: new Date(), ...overrides };
}

function intentRow(overrides: Record<string, any> = {}) {
  return { intent_id: 'ENI-1', kind: 'onboard_participant', participant_id: 'ENP-NEW', payload: { participant: { name: 'Beneficiary Bank', type: 'bank', jurisdiction: 'US', endpoint: {}, metadata: {} } }, status: 'submitted', live: false, reason: null, requested_by: 'maker@dlbtrust.com', approved_by: null, approval_ref: null, screening_ref: null, result: null, error_message: null, created_at: new Date(), approved_at: null, applied_at: null, ...overrides };
}

/** In-memory Cloud SQL stub for the enterprise-network tables; every requested table exists unless listed in `missing`. */
function stubCloudSql(db: Partial<Db> = {}, missing: string[] = []) {
  const state: Db = { intents: {}, participants: {}, limits: {}, policies: {}, openCents: {}, ...db };
  const query = vi.spyOn(pool, 'query').mockImplementation(async (sql: any, params: any = []) => {
    const text = String(sql).replace(/\s+/g, ' ');
    if (/current_database\(\)/i.test(text)) return { rows: [{ db: 'dlbtrust', version: 'PostgreSQL 16' }] } as any;
    if (/information_schema\.tables/i.test(text)) return { rows: (params[0] || []).filter((n: string) => !missing.includes(n)).map((table_name: string) => ({ table_name })) } as any;
    if (/SELECT \* FROM enterprise_network_intents WHERE intent_id/i.test(text)) return { rows: state.intents[params[0]] ? [state.intents[params[0]]] : [] } as any;
    if (/SELECT \* FROM enterprise_network_participants WHERE participant_id/i.test(text)) return { rows: state.participants[params[0]] ? [state.participants[params[0]]] : [] } as any;
    if (/SELECT \* FROM enterprise_network_participants/i.test(text)) return { rows: Object.values(state.participants) } as any;
    if (/SELECT \* FROM enterprise_network_exposure_limits WHERE participant_id/i.test(text)) return { rows: state.limits[params[0]] ? [state.limits[params[0]]] : [] } as any;
    if (/SELECT \* FROM enterprise_network_routing_policies/i.test(text)) {
      const [pid, rail] = params;
      return { rows: Object.values(state.policies).filter((p: any) => (p.participant_id === pid || p.participant_id == null) && (!rail || p.rail === rail)).sort((a: any, b: any) => Number(a.participant_id == null) - Number(b.participant_id == null) || a.priority - b.priority) } as any;
    }
    if (/FROM private_payment_network_transactions WHERE participant_id/i.test(text)) return { rows: [{ cents: state.openCents[params[0]] || 0 }] } as any;
    if (/INSERT INTO enterprise_network_intents/i.test(text)) {
      const [intent_id, kind, participant_id, payload, reason, requested_by, approval_ref, screening_ref] = params;
      state.intents[intent_id] = intentRow({ intent_id, kind, participant_id, payload: JSON.parse(payload), reason, requested_by, approval_ref, screening_ref });
      return { rows: [state.intents[intent_id]] } as any;
    }
    if (/UPDATE enterprise_network_intents SET status = 'approved'/i.test(text)) Object.assign(state.intents[params[0]], { status: 'approved', approved_by: params[1], approval_ref: params[2], screening_ref: params[3], live: params[4] });
    if (/UPDATE enterprise_network_intents SET status = 'failed'/i.test(text)) Object.assign(state.intents[params[0]], { status: 'failed', error_message: params[1] });
    if (/UPDATE enterprise_network_intents SET status = 'cancelled'/i.test(text)) Object.assign(state.intents[params[0]], { status: 'cancelled', error_message: params[1] });
    if (/UPDATE enterprise_network_intents SET status = \$2, result/i.test(text)) Object.assign(state.intents[params[0]], { status: params[1], result: JSON.parse(params[2]) });
    if (/INSERT INTO enterprise_network_participants/i.test(text)) {
      const [participant_id, name, participant_type, status, jurisdiction, endpoint, screening_ref, approval_ref, metadata, onboarded_by, approved_by] = params;
      state.participants[participant_id] = participantRow({ participant_id, name, participant_type, status, jurisdiction, endpoint: JSON.parse(endpoint), screening_ref, approval_ref, metadata: JSON.parse(metadata), onboarded_by, approved_by });
    }
    if (/UPDATE enterprise_network_participants SET status = 'suspended'/i.test(text) && state.participants[params[0]]) state.participants[params[0]].status = 'suspended';
    if (/UPDATE enterprise_network_participants SET status = \$2/i.test(text) && state.participants[params[0]]) state.participants[params[0]].status = params[1];
    if (/INSERT INTO enterprise_network_exposure_limits/i.test(text)) {
      const [participant_id, limit_cents, currency, status, approval_ref] = params;
      state.limits[participant_id] = { participant_id, limit_cents, currency, status, approval_ref, updated_at: new Date() };
    }
    if (/INSERT INTO enterprise_network_routing_policies/i.test(text)) {
      const [policy_id, participant_id, rail, processor, priority, max_amount_cents, status, metadata] = params;
      state.policies[policy_id] = { policy_id, participant_id, rail, processor, priority, max_amount_cents, status, metadata: JSON.parse(metadata), updated_at: new Date() };
    }
    return { rows: [] } as any;
  });
  return { query, state };
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

function noMoneyMovement() {
  return {
    sale: vi.spyOn(PaymentGatewayServerEngine, 'sale'),
    transfer: vi.spyOn(CashEngine, 'transfer'),
  };
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

describe('enterprise-network OS engine registration and routing', () => {
  it('is registered in the OS engine map, route map and readiness audit with its tables', () => {
    expect(OS.engines['enterprise-network']).toBe(OS.EnterpriseNetworkPlatformEngine);
    expect(OS.EnterpriseNetworkPlatformEngine.platformEngine).toBe('enterprise-network');
    expect(OS.EnterpriseNetworkPlatformEngine.engineName).toBe('enterprise-network');
    expect(EngineWiringReadiness.ENGINE_KEYS).toContain('enterprise-network');
    expect(EngineWiringReadiness.ENGINE_TITLES['enterprise-network']).toMatch(/Enterprise Network OS Engine/);
    expect(EnterpriseNetworkOsEngine.TABLES).toEqual(['enterprise_network_intents', 'enterprise_network_participants', 'enterprise_network_routing_policies', 'enterprise_network_exposure_limits', 'os_events']);
    expect(EngineWiringReadiness.TABLES['enterprise-network']).toEqual(EnterpriseNetworkOsEngine.TABLES);
    const paths = osRouter.stack.filter((l: any) => l.route).map((l: any) => l.route.path);
    expect(paths).toEqual(expect.arrayContaining(['/:engine/status', '/:engine/readiness', '/:engine/process', '/enterprise-network/webhook']));
  });

  it('creates its tables through ensureAll() alongside the shared os_events table', async () => {
    const { query } = stubCloudSql();
    await OS.EnterpriseNetworkPlatformEngine.ensureTables();
    const ddl = query.mock.calls.map(([sql]: any[]) => String(sql)).filter((s) => /CREATE TABLE IF NOT EXISTS/i.test(s));
    for (const t of EnterpriseNetworkOsEngine.TABLES) expect(ddl.some((s) => s.includes(t)), t).toBe(true);
  });

  it('serves /api/os/enterprise-network/status in shadow mode and reports it never moves money', async () => {
    stubCloudSql();
    const req: any = { params: { engine: 'enterprise-network' }, query: {}, body: {}, osEngine: OS.EnterpriseNetworkPlatformEngine };
    const res = responseStub();
    await routeHandler('get', '/:engine/status')(req, res);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ engine: 'enterprise-network', mode: 'shadow', movesMoney: false, integrations: { enterpriseNetworkOs: true } });
    expect(res.body.data.pipeline.movesMoney).toBe(false);
  });

  it('rejects direct registry writes and money movement on /process with 409 and audits them in os_events', async () => {
    const { query } = stubCloudSql();
    const handler = routeHandler('post', '/:engine/process');
    for (const action of ['onboardParticipant', 'setExposureLimit', 'admit', 'payout', 'transfer']) {
      const res = responseStub();
      await handler({ params: { engine: 'enterprise-network' }, body: { action }, osEngine: OS.EnterpriseNetworkPlatformEngine, user: { username: 'ops-admin' } }, res);
      expect(res.statusCode, action).toBe(409);
      expect(res.body.error).toMatch(/maker-checker/);
    }
    const audits = query.mock.calls.filter(([sql, params]: any[]) => /INSERT INTO os_events/i.test(String(sql)) && params[1] === 'enterprise-network');
    expect(audits).toHaveLength(5);
    expect(audits[0][1][3]).toBe('rejected');

    const bogus = responseStub();
    await handler({ params: { engine: 'enterprise-network' }, body: { action: 'wire-now' }, osEngine: OS.EnterpriseNetworkPlatformEngine }, bogus);
    expect(bogus.statusCode).toBe(400);
    expect(bogus.body.error).toMatch(/Unknown enterprise-network action: wire-now/);
  });

  it('writes a completed os_events audit row for submit through BaseOSEngine.process', async () => {
    const { query } = stubCloudSql();
    const out = await OS.EnterpriseNetworkPlatformEngine.process({ action: 'submit', kind: 'onboard_participant', participant: { name: 'Beneficiary Bank', type: 'bank' }, requestedBy: 'maker@dlbtrust.com' });
    expect(out.success).toBe(true);
    expect(out.result.status).toBe('submitted');
    const logged = query.mock.calls.find(([sql]: any[]) => /INSERT INTO os_events/i.test(String(sql)));
    expect(logged![1]).toContain('enterprise-network');
    expect(logged![1][2]).toBe('submit');
    expect(logged![1][3]).toBe('completed');
  });
});

describe('enterprise-network maker/checker flow', () => {
  it('validates change intents at submit', async () => {
    stubCloudSql({ participants: { 'ENP-1': participantRow({ status: 'suspended' }) } });
    await expect(EnterpriseNetworkOsEngine.submit({ kind: 'move_money', requestedBy: 'maker@dlbtrust.com' })).rejects.toMatchObject({ status: 400, message: /kind must be one of/ });
    await expect(EnterpriseNetworkOsEngine.submit({ kind: 'onboard_participant', participant: { name: 'X', type: 'bank' } })).rejects.toMatchObject({ message: /requestedBy required/ });
    await expect(EnterpriseNetworkOsEngine.submit({ kind: 'onboard_participant', participant: { name: 'X', type: 'pirate' }, requestedBy: 'm' })).rejects.toMatchObject({ message: /participant.type must be one of/ });
    await expect(EnterpriseNetworkOsEngine.submit({ kind: 'set_exposure_limit', participantId: 'ENP-404', limit: { limitCents: 1 }, requestedBy: 'm' })).rejects.toMatchObject({ status: 404 });
    await expect(EnterpriseNetworkOsEngine.submit({ kind: 'set_exposure_limit', participantId: 'ENP-1', limit: { limitCents: -5 }, requestedBy: 'm' })).rejects.toMatchObject({ message: /limitCents must be >= 0/ });
    await expect(EnterpriseNetworkOsEngine.submit({ kind: 'suspend_participant', participantId: 'ENP-1', requestedBy: 'm' })).rejects.toMatchObject({ status: 409, message: /already suspended/ });
    await expect(EnterpriseNetworkOsEngine.submit({ kind: 'set_routing_policy', policy: { rail: 'ach' }, requestedBy: 'm' })).rejects.toMatchObject({ message: /policy.processor required/ });
  });

  it('enforces maker/checker: the approver must differ from the requester', async () => {
    stubCloudSql({ intents: { 'ENI-1': intentRow() } });
    await expect(EnterpriseNetworkOsEngine.approve({ intentId: 'ENI-1', approvedBy: 'maker@dlbtrust.com' })).rejects.toMatchObject({ status: 409, message: /approver must differ from requester/ });
    await expect(EnterpriseNetworkOsEngine.approve({ intentId: 'ENI-404', approvedBy: 'checker@dlbtrust.com' })).rejects.toMatchObject({ status: 404 });
    await expect(EnterpriseNetworkOsEngine.approve({ intentId: 'ENI-1' })).rejects.toMatchObject({ message: /approvedBy required/ });
  });

  it('refuses self-loopback participant endpoints and routing destinations at submit and approve', async () => {
    const { query } = stubCloudSql({ intents: { 'ENI-1': intentRow({ payload: { participant: { name: 'Loop', type: 'bank', endpoint: { partnerAs2Id: 'DLBTRUST-DIRECT' } } } }) } });
    const base = { kind: 'onboard_participant', requestedBy: 'maker@dlbtrust.com' };
    await expect(EnterpriseNetworkOsEngine.submit({ ...base, participant: { name: 'Loop', type: 'bank', endpoint: { partnerUrl: 'direct' } } })).rejects.toMatchObject({ status: 409, message: /self-loopback partner refused/ });
    await expect(EnterpriseNetworkOsEngine.submit({ ...base, participant: { name: 'Loop', type: 'bank', endpoint: { webhookUrl: 'https://dlbtrust-app-r5oawu76jq-ue.a.run.app/api/os/payment-gateway/webhook' } } })).rejects.toMatchObject({ status: 409 });
    await expect(EnterpriseNetworkOsEngine.submit({ kind: 'set_routing_policy', policy: { rail: 'ach', processor: 'payment_hub', destination: { url: 'http://localhost:3002' } }, requestedBy: 'maker@dlbtrust.com' })).rejects.toMatchObject({ status: 409, message: /self-loopback/ });
    expect(query.mock.calls.some(([sql]: any[]) => /INSERT INTO enterprise_network_intents/i.test(String(sql)))).toBe(false);
    await expect(EnterpriseNetworkOsEngine.approve({ intentId: 'ENI-1', approvedBy: 'checker@dlbtrust.com' })).rejects.toMatchObject({ status: 409, message: /self-loopback partner refused: partner DLBTRUST-DIRECT/ });
  });

  it('refuses a participant whose AS2 partner is our own MFT Gateway station', async () => {
    stubCloudSql();
    await expect(EnterpriseNetworkOsEngine.submit({ kind: 'onboard_participant', participant: { name: 'Loop Bank', type: 'bank', endpoint: { partnerAs2Id: 'DLBTRUST-AS2' } }, requestedBy: 'maker@dlbtrust.com' }))
      .rejects.toMatchObject({ status: 409, message: /own AS2 station/ });
    const ok = await EnterpriseNetworkOsEngine.submit({ kind: 'onboard_participant', participant: { name: 'Sunrise Banks', type: 'bank', endpoint: { partnerAs2Id: 'SUNRISE-AS2' } }, requestedBy: 'maker@dlbtrust.com' });
    expect(ok.status).toBe('submitted');
  });

  it('records shadow registry entries while ENTERPRISE_NETWORK_LIVE is off and never moves money', async () => {
    const { state } = stubCloudSql();
    const money = noMoneyMovement();
    const intent = await EnterpriseNetworkOsEngine.submit({ kind: 'onboard_participant', participantId: 'ENP-7', participant: { name: 'Beneficiary Bank', type: 'bank' }, requestedBy: 'maker@dlbtrust.com' });
    expect(intent.status).toBe('submitted');
    const out = await EnterpriseNetworkOsEngine.approve({ intentId: intent.intentId, approvedBy: 'checker@dlbtrust.com' });
    expect(out.status).toBe('shadow');
    expect(out.applied).toBe(false);
    expect(out.note).toMatch(/ENTERPRISE_NETWORK_LIVE=false/);
    expect(state.participants['ENP-7'].status).toBe('shadow');

    const lim = await EnterpriseNetworkOsEngine.submit({ kind: 'set_exposure_limit', participantId: 'ENP-7', limit: { limitCents: 500000 }, requestedBy: 'maker@dlbtrust.com' });
    await EnterpriseNetworkOsEngine.approve({ intentId: lim.intentId, approvedBy: 'checker@dlbtrust.com' });
    expect(state.limits['ENP-7']).toMatchObject({ limit_cents: 500000, status: 'shadow' });
    await expect(EnterpriseNetworkOsEngine.admit({ participantId: 'ENP-7', amountCents: 1000, realValue: true })).rejects.toMatchObject({ status: 409, message: /is shadow; real-value payouts need an active participant/ });

    expect(money.sale).not.toHaveBeenCalled();
    expect(money.transfer).not.toHaveBeenCalled();
    await expect(EnterpriseNetworkOsEngine.approve({ intentId: intent.intentId, approvedBy: 'checker@dlbtrust.com' })).rejects.toMatchObject({ status: 409, message: /is shadow, expected submitted/ });
  });

  it('requires approvalRef + screeningRef from the checker before a participant goes live', async () => {
    process.env.ENTERPRISE_NETWORK_LIVE = 'true';
    const { state } = stubCloudSql({ intents: { 'ENI-1': intentRow({ participant_id: 'ENP-NEW' }) } });
    await expect(EnterpriseNetworkOsEngine.approve({ intentId: 'ENI-1', approvedBy: 'checker@dlbtrust.com' })).rejects.toMatchObject({ status: 409, message: /approvalRef/ });
    await expect(EnterpriseNetworkOsEngine.approve({ intentId: 'ENI-1', approvedBy: 'checker@dlbtrust.com', approvalRef: 'APR-1' })).rejects.toMatchObject({ status: 409, message: /screeningRef/ });
    expect(state.intents['ENI-1'].status).toBe('submitted');
    const out = await EnterpriseNetworkOsEngine.approve({ intentId: 'ENI-1', approvedBy: 'checker@dlbtrust.com', approvalRef: 'APR-1', screeningRef: 'SCR-1' });
    expect(out.status).toBe('applied');
    expect(out.applied).toBe(true);
    expect(state.participants['ENP-NEW']).toMatchObject({ status: 'active', screening_ref: 'SCR-1', approval_ref: 'APR-1', approved_by: 'checker@dlbtrust.com' });
  });

  it('applies a checker-approved suspension even in shadow mode (restrictive changes only)', async () => {
    const { state } = stubCloudSql({ participants: { 'ENP-1': participantRow() } });
    const intent = await EnterpriseNetworkOsEngine.submit({ kind: 'suspend_participant', participantId: 'ENP-1', reason: 'screening hold', requestedBy: 'maker@dlbtrust.com' });
    const out = await EnterpriseNetworkOsEngine.approve({ intentId: intent.intentId, approvedBy: 'checker@dlbtrust.com' });
    expect(out.status).toBe('applied');
    expect(state.participants['ENP-1'].status).toBe('suspended');
    await expect(EnterpriseNetworkOsEngine.admit({ participantId: 'ENP-1', amountCents: 1 })).rejects.toMatchObject({ status: 409, message: /is suspended/ });
  });

  it('admits payouts only within an exposure limit and resolves participant routes before network defaults', async () => {
    process.env.ENTERPRISE_NETWORK_LIVE = 'true';
    stubCloudSql({
      participants: { 'ENP-1': participantRow() },
      limits: { 'ENP-1': { participant_id: 'ENP-1', limit_cents: 100000, currency: 'USD', status: 'active' } },
      openCents: { 'ENP-1': 60000 },
      policies: {
        'ENR-NET': { policy_id: 'ENR-NET', participant_id: null, rail: 'ach', processor: 'lili', priority: 1, max_amount_cents: null, status: 'active' },
        'ENR-P': { policy_id: 'ENR-P', participant_id: 'ENP-1', rail: 'ach', processor: 'payment_hub', priority: 50, max_amount_cents: 30000, status: 'active' },
      },
    });
    const ok = await EnterpriseNetworkOsEngine.admit({ participantId: 'ENP-1', amountCents: 40000, realValue: true });
    expect(ok.exposure).toMatchObject({ limitCents: 100000, openCents: 60000, headroomCents: 40000 });
    await expect(EnterpriseNetworkOsEngine.admit({ participantId: 'ENP-1', amountCents: 40001 })).rejects.toMatchObject({ status: 409, message: /exposure limit exceeded/ });
    await expect(EnterpriseNetworkOsEngine.admit({ participantId: 'ENP-404', amountCents: 1 })).rejects.toMatchObject({ status: 404 });
    expect(await EnterpriseNetworkOsEngine.resolveRoute({ participantId: 'ENP-1', rail: 'ach', amountCents: 20000, realValue: true })).toMatchObject({ policyId: 'ENR-P', processor: 'payment_hub', scope: 'participant' });
    expect(await EnterpriseNetworkOsEngine.resolveRoute({ participantId: 'ENP-1', rail: 'ach', amountCents: 50000, realValue: true })).toMatchObject({ policyId: 'ENR-NET', processor: 'lili', scope: 'network' });
  });
});

describe('enterprise-network reconcile and webhook', () => {
  it('reconciles open exposure against limits and flags breaches', async () => {
    stubCloudSql({
      participants: { 'ENP-1': participantRow(), 'ENP-2': participantRow({ participant_id: 'ENP-2' }) },
      limits: { 'ENP-1': { participant_id: 'ENP-1', limit_cents: 100000, currency: 'USD', status: 'active' } },
      openCents: { 'ENP-1': 150000, 'ENP-2': 0 },
    });
    const out = await EnterpriseNetworkOsEngine.reconcile({});
    expect(out.balanced).toBe(false);
    expect(out.breaches).toEqual([expect.objectContaining({ participantId: 'ENP-1', openCents: 150000, limitCents: 100000 })]);
    expect(out.exposures).toHaveLength(2);
  });

  it('verifies the screening callback HMAC on /api/os/enterprise-network/webhook and suspends on a screening hit', async () => {
    const { state } = stubCloudSql({ participants: { 'ENP-1': participantRow() } });
    process.env.ENTERPRISE_NETWORK_WEBHOOK_SECRET = 'whsec_network';
    const body = JSON.stringify({ participantId: 'ENP-1', event: 'screening.hit', reference: 'OFAC-123' });
    const good = crypto.createHmac('sha256', 'whsec_network').update(body).digest('hex');

    await expect(EnterpriseNetworkOsEngine.webhook({ rawBody: body, signature: 'sha256=deadbeef', payload: JSON.parse(body) })).rejects.toMatchObject({ status: 401 });
    expect(state.participants['ENP-1'].status).toBe('active');

    const res = responseStub();
    await routeHandler('post', '/enterprise-network/webhook')({ body: JSON.parse(body), rawBody: Buffer.from(body), get: (h: string) => (h === 'x-network-signature' ? `sha256=${good}` : undefined) }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.result).toMatchObject({ participantId: 'ENP-1', event: 'screening.hit', action: 'suspended' });
    expect(state.participants['ENP-1'].status).toBe('suspended');

    delete process.env.ENTERPRISE_NETWORK_WEBHOOK_SECRET;
    expect(EnterpriseNetworkOsEngine.verifyWebhookSignature(body, good)).toMatchObject({ ok: false, reason: /ENTERPRISE_NETWORK_WEBHOOK_SECRET not set/ });
  });
});

describe('enterprise-network readiness on dlb-treasury-management', () => {
  it('reports shadow mode and the exact blockers while live flag and secret are absent', async () => {
    stubCloudSql({}, ['enterprise_network_intents']);
    const r = await EngineWiringReadiness.engineReadiness('enterprise-network');
    expect(r.engine).toBe('enterprise-network');
    expect(r.ready).toBe(false);
    expect(r.healthy).toBe(true);
    expect(r.mode).toBe('shadow');
    expect(r.blockers).toEqual(expect.arrayContaining([
      expect.stringMatching(/^ENTERPRISE_NETWORK_LIVE is not true/),
      expect.stringMatching(/^ENTERPRISE_NETWORK_WEBHOOK_SECRET not set/),
      'Cloud SQL tables missing: enterprise_network_intents',
    ]));
  });

  it('names relaxed gates as blockers and goes live once the flag, gates and secret are in place', async () => {
    stubCloudSql();
    process.env.ENTERPRISE_NETWORK_LIVE = 'true';
    process.env.ENTERPRISE_NETWORK_WEBHOOK_SECRET = 'whsec_network';
    process.env.ENTERPRISE_NETWORK_REQUIRE_SCREENING_REF = 'false';
    const relaxed = await EngineWiringReadiness.engineReadiness('enterprise-network');
    expect(relaxed.blockers).toContain('ENTERPRISE_NETWORK_REQUIRE_SCREENING_REF=false disables the participant screeningRef gate');
    delete process.env.ENTERPRISE_NETWORK_REQUIRE_SCREENING_REF;
    const r = await EngineWiringReadiness.engineReadiness('enterprise-network');
    expect(r.blockers).toEqual([]);
    expect(r.ready).toBe(true);
    expect(r.mode).toBe('live');
    expect(r.liveFlags).toMatchObject({ ENTERPRISE_NETWORK_LIVE: true, REQUIRE_APPROVAL_REF: true, REQUIRE_SCREENING_REF: true, WEBHOOK_SECRET: true });
  });
});
