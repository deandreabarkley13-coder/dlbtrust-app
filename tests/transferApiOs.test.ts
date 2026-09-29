import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { TransferApiOsEngine, callerFromRequest, idempotencyKeyFromRequest, decodeUserInfo, getTransferApiConfig } = require('../server/integrations/os/transferApiOsEngine');
const { EnterpriseOdfiOsEngine } = require('../server/integrations/os/enterpriseOdfiOsEngine');
const { FraudComplianceOsEngine } = require('../server/integrations/os/fraudComplianceOsEngine');
const pool = require('../server/integrations/bonds/pgPool');

const saved = { ...process.env };
const GW_SA = 'dlbtrust-transfer-gateway@dlb-treasury-management.iam.gserviceaccount.com';

function b64url(o: any) {
  return Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let store: Map<string, any>;
function memPool() {
  store = new Map();
  vi.spyOn(pool, 'query').mockImplementation(async (sql: any, params: any[] = []) => {
    const s = String(sql).trim();
    if (!/transfer_api_requests/.test(s)) return { rows: [] };
    if (/^CREATE/.test(s)) return { rows: [] };
    if (/^INSERT/.test(s)) {
      const [request_id, idempotency_key, action, caller, via, transfer_id, status_code, response] = params;
      if (!store.has(idempotency_key)) store.set(idempotency_key, { request_id, idempotency_key, action, caller, via, transfer_id, status_code, response: JSON.parse(response), created_at: new Date() });
      return { rows: [] };
    }
    if (/WHERE idempotency_key = \$1/.test(s)) return { rows: [store.get(params[0])].filter(Boolean) };
    if (/WHERE request_id = \$1/.test(s)) return { rows: [...store.values()].filter((r) => r.request_id === params[0]) };
    if (/GROUP BY action/.test(s)) {
      const agg: Record<string, number> = {};
      for (const r of store.values()) agg[r.action] = (agg[r.action] || 0) + 1;
      return { rows: Object.entries(agg).map(([action, n]) => ({ action, n })) };
    }
    return { rows: [...store.values()] };
  });
}

const BATCH = { batch_id: 'EOB-1', purpose_class: 'distribution', status: 'planned', item_count: 1, total_cents: 125000, planner: 'rules', planned_by: 'malissa.robinson', created_at: new Date(), items: [{ item_id: 'EOI-1', status: 'planned', amount_cents: 125000, creditor_name: 'Jeremy N Robinson', creditor_last4: '3210', rail: 'family_book', network_id: 'PPN-FAMILY', urgency: 'standard' }] };
const MAKER = { email: 'malissa.robinson', via: 'api_gateway', gateway: GW_SA };
const CHECKER = { email: 'deandreabarkley13@gmail.com', via: 'api_gateway', gateway: GW_SA };
const ITEMS = [{ approvalRef: 'APR-1', screeningRef: 'OFAC-1', instruction: { amountCents: 125000, creditor: { name: 'Jeremy N Robinson', accountNumber: '9876543210', fineractAccountId: '5' } } }];

beforeEach(() => {
  process.env.TRANSFER_API_ENABLED = 'true';
  process.env.TRANSFER_API_GATEWAY_SERVICE_ACCOUNT = GW_SA;
  process.env.PRIVATE_ACCESS_SERVICE_ACCOUNTS = `deployer@x.iam.gserviceaccount.com,${GW_SA}`;
  memPool();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe('Transfer API OS — caller identity', () => {
  it('trusts the gateway user-info header only when IAP says the gateway service account called', () => {
    const headers = { 'x-apigateway-api-userinfo': b64url({ email: 'Malissa.Robinson@family.test', sub: '1' }) };
    expect(callerFromRequest({ headers, privateAccess: { kind: 'platform', principal: GW_SA } })).toMatchObject({ email: 'malissa.robinson@family.test', via: 'api_gateway' });
    // same header, but not via the gateway: ignored; portal identity wins / none
    expect(callerFromRequest({ headers, privateAccess: { kind: 'family', principal: 'x@f' }, user: { email: 'Trustee@f' } })).toMatchObject({ email: 'trustee@f', via: 'portal' });
    expect(callerFromRequest({ headers, privateAccess: { kind: 'platform', principal: 'other-sa@p.iam.gserviceaccount.com' } })).toBeNull();
    expect(callerFromRequest({ headers: {}, privateAccess: { kind: 'platform', principal: GW_SA }, query: {} })).toBeNull();
    expect(callerFromRequest({ headers: { 'x-api-key': 'k' }, privateAccess: { kind: 'platform', principal: GW_SA } })).toMatchObject({ via: 'api_gateway_key' });
    expect(decodeUserInfo('not-json')).toBeNull();
  });

  it('requires a well-formed Idempotency-Key on writes', () => {
    expect(idempotencyKeyFromRequest({ headers: { 'idempotency-key': 'dist-2026-09-27:001' }, body: {} })).toBe('dist-2026-09-27:001');
    expect(() => idempotencyKeyFromRequest({ headers: {}, body: {} })).toThrow(/Idempotency-Key/);
    expect(() => idempotencyKeyFromRequest({ headers: { 'idempotency-key': 'short' }, body: {} })).toThrow(/Idempotency-Key/);
    expect(() => idempotencyKeyFromRequest({ headers: { 'idempotency-key': 'bad key with spaces' }, body: {} })).toThrow(/Idempotency-Key/);
  });
});

describe('Transfer API OS — writes delegate to Enterprise ODFI with idempotent replay', () => {
  it('originates through EnterpriseOdfiOsEngine as the gateway caller, redacts, and replays the stored response', async () => {
    const originate = vi.spyOn(EnterpriseOdfiOsEngine, 'originate').mockResolvedValue(BATCH);
    const t = await TransferApiOsEngine.transfer({ purposeClass: 'distribution', items: ITEMS, caller: MAKER, idempotencyKey: 'dist-0001-abc' });
    expect(originate).toHaveBeenCalledTimes(1);
    expect(originate.mock.calls[0][0]).toMatchObject({ purposeClass: 'distribution', actor: 'malissa.robinson' });
    expect(originate.mock.calls[0][0].items[0].idempotencyKey).toBe('dist-0001-abc:1');
    expect(t).toMatchObject({ transferId: 'EOB-1', status: 'planned', totalCents: 125000, items: [{ creditorLast4: '3210', rail: 'family_book' }] });
    expect(JSON.stringify(t)).not.toContain('9876543210');

    const again = await TransferApiOsEngine.transfer({ purposeClass: 'distribution', items: ITEMS, caller: MAKER, idempotencyKey: 'dist-0001-abc' });
    expect(originate).toHaveBeenCalledTimes(1);
    expect(again).toMatchObject({ transferId: 'EOB-1', replayed: true });
    expect(store.get('dist-0001-abc')).toMatchObject({ action: 'transfer', caller: 'malissa.robinson', via: 'api_gateway', transfer_id: 'EOB-1', status_code: 200 });
  });

  it('propagates Enterprise ODFI maker/checker and approval refusals, records them, and replays the failure', async () => {
    const err = Object.assign(new Error('malissa.robinson is not a designated checker (ENTERPRISE_ODFI_CHECKERS)'), { code: 'ENTERPRISE_ODFI_ROLE', statusCode: 403 });
    const release = vi.spyOn(EnterpriseOdfiOsEngine, 'release').mockRejectedValue(err);
    await expect(TransferApiOsEngine.release({ transferId: 'EOB-1', caller: MAKER, idempotencyKey: 'rel-0001-abc' })).rejects.toMatchObject({ statusCode: 403, code: 'ENTERPRISE_ODFI_ROLE' });
    expect(store.get('rel-0001-abc')).toMatchObject({ action: 'release', status_code: 403 });
    await expect(TransferApiOsEngine.release({ transferId: 'EOB-1', caller: MAKER, idempotencyKey: 'rel-0001-abc' })).rejects.toMatchObject({ statusCode: 403, details: { replayed: true } });
    expect(release).toHaveBeenCalledTimes(1);

    vi.spyOn(EnterpriseOdfiOsEngine, 'originate').mockRejectedValue(Object.assign(new Error('item k: approvalRef and screeningRef are required'), { code: 'ENTERPRISE_ODFI_APPROVAL', statusCode: 403 }));
    await expect(TransferApiOsEngine.transfer({ purposeClass: 'vendor_payout', items: [{ instruction: {} }], caller: MAKER, idempotencyKey: 'vend-0001-abc' })).rejects.toMatchObject({ code: 'ENTERPRISE_ODFI_APPROVAL' });
  });

  it('release by a distinct checker delegates to EnterpriseOdfiOsEngine.release (the only money-moving path)', async () => {
    const release = vi.spyOn(EnterpriseOdfiOsEngine, 'release').mockResolvedValue({ ...BATCH, status: 'released', released_by: CHECKER.email });
    const r = await TransferApiOsEngine.release({ transferId: 'EOB-1', caller: CHECKER, idempotencyKey: 'rel-0002-abc' });
    expect(release).toHaveBeenCalledWith({ batchId: 'EOB-1', actor: CHECKER.email });
    expect(r).toMatchObject({ status: 'released', releasedBy: CHECKER.email });
  });

  it('refuses writes without an identity, from API-key callers, with a reused key for another action, or with a bad purposeClass', async () => {
    vi.spyOn(EnterpriseOdfiOsEngine, 'originate').mockResolvedValue(BATCH);
    await expect(TransferApiOsEngine.transfer({ purposeClass: 'distribution', items: ITEMS, caller: null, idempotencyKey: 'dist-0002-abc' })).rejects.toMatchObject({ statusCode: 401 });
    await expect(TransferApiOsEngine.transfer({ purposeClass: 'distribution', items: ITEMS, caller: { email: 'api-key', via: 'api_gateway_key' }, idempotencyKey: 'dist-0002-abc' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(TransferApiOsEngine.transfer({ purposeClass: 'gift', items: ITEMS, caller: MAKER, idempotencyKey: 'dist-0003-abc' })).rejects.toMatchObject({ code: 'TRANSFER_API_BAD_REQUEST' });
    await TransferApiOsEngine.transfer({ purposeClass: 'distribution', items: ITEMS, caller: MAKER, idempotencyKey: 'dist-0004-abc' });
    await expect(TransferApiOsEngine.cancel({ transferId: 'EOB-1', caller: MAKER, idempotencyKey: 'dist-0004-abc' })).rejects.toMatchObject({ statusCode: 409, code: 'TRANSFER_API_IDEMPOTENCY' });
    await expect(TransferApiOsEngine.process({ action: 'transfer', actor: 'malissa.robinson', purposeClass: 'distribution', items: ITEMS })).rejects.toMatchObject({ code: 'TRANSFER_API_IDEMPOTENCY' });
    process.env.TRANSFER_API_ENABLED = 'false';
    await expect(TransferApiOsEngine.transfer({ purposeClass: 'distribution', items: ITEMS, caller: MAKER, idempotencyKey: 'dist-0005-abc' })).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('Transfer API OS — readiness', () => {
  const odfiStatus = { profile: { status: 'countersigned' }, rails: { external: [], family: ['PPN-FAMILY'] }, policy: {} };

  it('is shadow without the gateway config and inherits the enterprise-odfi sponsor-network blocker', async () => {
    vi.spyOn(EnterpriseOdfiOsEngine, 'status').mockResolvedValue(odfiStatus);
    vi.spyOn(EnterpriseOdfiOsEngine, 'readiness').mockResolvedValue({ ready: false, mode: 'shadow', blockers: ['no verified external sponsor ODFI network (ach_operator / rtp_participant / fednow_participant); only family book transfers can route'] });
    delete process.env.TRANSFER_API_GATEWAY_HOST;
    const r = await TransferApiOsEngine.readiness();
    expect(r.mode).toBe('shadow');
    expect(r.blockers).toEqual(expect.arrayContaining([
      expect.stringMatching(/TRANSFER_API_GATEWAY_HOST not set/),
      expect.stringMatching(/TRANSFER_API_AUDIENCE not set/),
      expect.stringMatching(/^enterprise-odfi: no verified external sponsor ODFI network/),
      'TRANSFER_API_LIVE not true',
    ]));
    expect(r.status.policy).toMatchObject({ movesMoneyDirectly: false, isBank: false, usaOnly: true });
  });

  it('flags a gateway service account that IAP would refuse, and is live only when fully configured and enterprise-odfi is live', async () => {
    vi.spyOn(EnterpriseOdfiOsEngine, 'status').mockResolvedValue(odfiStatus);
    const odfi = vi.spyOn(EnterpriseOdfiOsEngine, 'readiness').mockResolvedValue({ ready: true, mode: 'live', blockers: [] });
    process.env.TRANSFER_API_GATEWAY_HOST = 'dlbtrust-transfer-gateway-abc.ue.gateway.dev';
    process.env.TRANSFER_API_AUDIENCE = 'https://transfer.dlb-treasury-management.dlbtrust';
    process.env.TRANSFER_API_LIVE = 'true';
    process.env.PRIVATE_ACCESS_SERVICE_ACCOUNTS = 'deployer@x.iam.gserviceaccount.com';
    let r = await TransferApiOsEngine.readiness();
    expect(r.blockers).toEqual([expect.stringMatching(/not in PRIVATE_ACCESS_SERVICE_ACCOUNTS/)]);

    process.env.PRIVATE_ACCESS_SERVICE_ACCOUNTS = GW_SA;
    r = await TransferApiOsEngine.readiness();
    expect(r).toMatchObject({ ready: true, mode: 'live', blockers: [] });
    expect(getTransferApiConfig().gatewayServiceAccount).toBe(GW_SA);

    odfi.mockResolvedValue({ ready: false, mode: 'shadow', blockers: ['ENTERPRISE_ODFI_LIVE not true'] });
    r = await TransferApiOsEngine.readiness();
    expect(r).toMatchObject({ ready: false, mode: 'shadow', blockers: ['enterprise-odfi: ENTERPRISE_ODFI_LIVE not true'] });
  });
});

describe('Transfer API — API Gateway OpenAPI template', () => {
  it('protects every write with a Google ID token only (no API key), requires Idempotency-Key, and meters quotas', () => {
    const tpl = fs.readFileSync(path.join(__dirname, '..', 'infra', 'gcp', 'transfer_api_openapi.yaml.tpl'), 'utf8');
    expect(tpl).toMatch(/x-google-backend:\s+address: \$\{backend_address\}\s+jwt_audience: \$\{backend_jwt_audience\}/);
    expect(tpl).toMatch(/x-google-issuer: https:\/\/accounts\.google\.com/);
    const ops = [...tpl.matchAll(/operationId: (\w+)[\s\S]*?security:\n((?:\s+- \w+: \[\]\n)+)/g)].map((m) => [m[1], m[2].match(/\w+(?=: \[\])/g)]);
    const writes = ops.filter(([op]) => /create|release|cancel|review/.test(op as string));
    expect(writes.map(([op]) => op)).toEqual(['createTransfer', 'releaseTransfer', 'cancelTransfer', 'createScreening', 'reviewScreening']);
    for (const [, sec] of writes) expect(sec).toEqual(['google_id_token']);
    for (const [, sec] of ops.filter(([op]) => !/create|release|cancel|review/.test(op as string))) expect(sec).toEqual(['google_id_token', 'api_key']);
    expect((tpl.match(/name: Idempotency-Key\s+in: header\s+required: true/g) || []).length).toBe(5);
    expect(tpl).toMatch(/transfer-writes-per-minute[\s\S]*STANDARD: \$\{write_quota_per_minute\}/);
    expect(tpl).not.toMatch(/accountNumber|routingNumber|bearer/i);
  });
});

describe('Transfer API OS — Fraud & Compliance screenings', () => {
  const PAYEE = { name: 'Jeremy N Robinson', routingNumber: '021000021', accountNumber: '9876543210', country: 'US' };

  it('screen delegates to FraudComplianceOsEngine as the gateway caller and replays; review goes to the checker', async () => {
    const screen = vi.spyOn(FraudComplianceOsEngine, 'screen').mockResolvedValue({ screeningRef: 'FCS-1', status: 'review', mode: 'live', payee: { last4: '3210' } });
    const review = vi.spyOn(FraudComplianceOsEngine, 'review').mockResolvedValue({ screeningRef: 'FCS-1', status: 'clear' });
    const s = await TransferApiOsEngine.screen({ payee: PAYEE, amountCents: 125000, rail: 'ach', bankId: 'lili', caller: MAKER, idempotencyKey: 'scr-0001-abc' });
    expect(s).toMatchObject({ screeningRef: 'FCS-1', status: 'review' });
    expect(screen.mock.calls[0][0]).toMatchObject({ amountCents: 125000, bankId: 'lili', actor: 'malissa.robinson' });
    await expect(TransferApiOsEngine.screen({ payee: PAYEE, amountCents: 125000, caller: MAKER, idempotencyKey: 'scr-0001-abc' })).resolves.toMatchObject({ replayed: true });
    expect(screen).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([...store.values()])).not.toContain('9876543210');

    await TransferApiOsEngine.reviewScreening({ screeningRef: 'FCS-1', decision: 'clear', caller: CHECKER, idempotencyKey: 'rev-0001-abc' });
    expect(review.mock.calls[0][0]).toMatchObject({ screeningRef: 'FCS-1', decision: 'clear', actor: 'deandreabarkley13@gmail.com' });
  });

  it('refuses screening writes from API-key callers and 404s an unknown screening', async () => {
    const screen = vi.spyOn(FraudComplianceOsEngine, 'screen');
    await expect(TransferApiOsEngine.screen({ payee: PAYEE, amountCents: 1, caller: { email: 'k', via: 'api_gateway_key' }, idempotencyKey: 'scr-0002-abc' })).rejects.toMatchObject({ code: 'TRANSFER_API_FORBIDDEN' });
    expect(screen).not.toHaveBeenCalled();
    vi.spyOn(FraudComplianceOsEngine, 'getScreening').mockResolvedValue(null);
    await expect(TransferApiOsEngine.getScreening({ screeningRef: 'FCS-missing' })).rejects.toMatchObject({ statusCode: 404 });
  });
});
