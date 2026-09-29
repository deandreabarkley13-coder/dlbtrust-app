import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  FraudComplianceOsEngine,
  buildSardineRequest,
  evaluateInternalRules,
  parseSardineResponse,
  getFraudComplianceConfig,
  normalizePayee,
  SARDINE_SANDBOX_URL,
} = require('../server/integrations/os/fraudComplianceOsEngine');
const { ComplianceEngine } = require('../server/integrations/compliance/complianceEngine');
const { EgressOsEngine } = require('../server/integrations/os/egressOsEngine');
const pool = require('../server/integrations/bonds/pgPool');

const saved = { ...process.env };
const PAYEE = { name: 'Jeremy N Robinson', routingNumber: '021000021', accountNumber: '9876543210', country: 'US' };

let rows: Map<string, any>;
function memPool() {
  rows = new Map();
  vi.spyOn(pool, 'query').mockImplementation(async (sql: any, params: any[] = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/^CREATE/.test(s) || /fraud_compliance_events/.test(s)) return { rows: [] };
    if (/^INSERT INTO fraud_compliance_screenings/.test(s)) {
      const [screening_ref, status, mode, rail, bank_id, amount_cents, payee_name, payee_type, payee_hash, payee_last4, payee_country,
        approval_ref, reference, sanctions_screening_id, sanctions_status, sanctions_provider, fraud_provider, fraud_status, fraud_level,
        fraud_aml_level, fraud_session_key, fraud_response, reasons, requested_by, expires_at] = params;
      rows.set(screening_ref, { screening_ref, status, mode, rail, bank_id, amount_cents, currency: 'USD', payee_name, payee_type, payee_hash, payee_last4, payee_country,
        approval_ref, reference, sanctions_screening_id, sanctions_status, sanctions_provider, fraud_provider, fraud_status, fraud_level,
        fraud_aml_level, fraud_session_key, fraud_response: JSON.parse(fraud_response), reasons: JSON.parse(reasons), requested_by, expires_at, consumed_at: null, created_at: new Date() });
      return { rows: [] };
    }
    if (/^SELECT \* FROM fraud_compliance_screenings WHERE screening_ref/.test(s)) return { rows: [rows.get(params[0])].filter(Boolean) };
    if (/FROM fraud_compliance_screenings WHERE payee_hash/.test(s)) {
      const mine = [...rows.values()].filter((r) => r.payee_hash === params[0]);
      const day = mine.filter((r) => Date.now() - new Date(r.created_at).getTime() < 86400000);
      return { rows: [{
        blocked: mine.filter((r) => r.status === 'blocked').length,
        trusted: mine.filter((r) => ['clear', 'consumed'].includes(r.status) && (r.reviewed_by || r.consumed_at)).length,
        day_count: day.length,
        day_cents: day.filter((r) => r.status !== 'blocked').reduce((a, r) => a + Number(r.amount_cents), 0),
      }] };
    }
    if (/^UPDATE fraud_compliance_screenings SET status=\$2, reviewed_by/.test(s)) {
      const r = rows.get(params[0]);
      if (!r || r.status !== 'review') return { rows: [] };
      Object.assign(r, { status: params[1], reviewed_by: params[2], review_notes: params[3], expires_at: params[4], reviewed_at: new Date() });
      return { rows: [r] };
    }
    if (/^UPDATE fraud_compliance_screenings SET status='consumed'/.test(s)) {
      const r = rows.get(params[0]);
      if (!r || r.status !== 'clear' || r.consumed_at || new Date(r.expires_at).getTime() <= Date.now()) return { rows: [] };
      Object.assign(r, { status: 'consumed', consumed_at: new Date(), consumed_by: params[1] });
      return { rows: [r] };
    }
    return { rows: [] };
  });
}

function sardineReply(body: any, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

function sanctions(status = 'clear') {
  return vi.spyOn(ComplianceEngine, 'screen').mockResolvedValue({ screening_id: 'COMP-1', status, provider: 'opensanctions', risk_level: status === 'clear' ? 'low' : 'high' });
}

function liveEnv() {
  process.env.FRAUD_COMPLIANCE_LIVE = 'true';
  process.env.COMPLIANCE_PROVIDER = 'opensanctions';
  process.env.FRAUD_COMPLIANCE_PROVIDER = 'sardine';
  process.env.FRAUD_COMPLIANCE_REVIEW_NEW_PAYEES = 'false';
  process.env.SARDINE_CLIENT_ID = 'cid';
  process.env.SARDINE_CLIENT_SECRET = 'csecret';
  process.env.SARDINE_BASE_URL = 'https://api.sardine.ai';
  vi.spyOn(ComplianceEngine, 'assertPaymentReady').mockResolvedValue({ ready: true, provider: 'opensanctions' });
}

beforeEach(() => {
  for (const k of Object.keys(process.env)) if (/^(FRAUD_COMPLIANCE_|SARDINE_|COMPLIANCE_PROVIDER)/.test(k)) delete process.env[k];
  vi.spyOn(EgressOsEngine, 'authorize').mockResolvedValue({ allowed: true });
  memPool();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe('Fraud & Compliance OS — Sardine adapter', () => {
  it('defaults to the internal provider, the Sardine sandbox and shadow mode', () => {
    const cfg = getFraudComplianceConfig({});
    expect(cfg).toMatchObject({ enabled: true, live: false, provider: 'internal', ttlMinutes: 60, enforceSettlement: false });
    expect(cfg.rules).toEqual({ reviewAmountCents: 1000000, maxAmountCents: 0, velocityCount: 5, velocityCents: 5000000, reviewNewPayees: true });
    expect(cfg.sardine.baseUrl).toBe(SARDINE_SANDBOX_URL);
    expect(cfg.sardine.explicitBaseUrl).toBe(false);
  });

  it('builds a /v1/customers request with a hashed customer id and the bank payment method', () => {
    const cfg = getFraudComplianceConfig({});
    const req = buildSardineRequest({ screeningRef: 'FCS-1', payee: normalizePayee(PAYEE), amountCents: 125000, rail: 'ach', cfg });
    expect(req.flow).toBe('dlbtrust_payment_ach');
    expect(req.customer).toMatchObject({ firstName: 'Jeremy', lastName: 'N Robinson', address: { countryCode: 'US' } });
    expect(req.customer.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(req.transaction).toMatchObject({ id: 'FCS-1', amount: 1250, currencyCode: 'USD', actionType: 'withdraw', paymentMethod: { type: 'bank', bank: { accountNumber: '9876543210', routingNumber: '021000021' } } });
  });

  it('maps Sardine levels to clear / review / blocked, worst of level and amlLevel', () => {
    expect(parseSardineResponse({ status: 'Success', level: 'low', transaction: { amlLevel: 'low' } }).status).toBe('clear');
    expect(parseSardineResponse({ status: 'Success', level: 'low', transaction: { amlLevel: 'high' } }).status).toBe('review');
    expect(parseSardineResponse({ status: 'Success', level: 'very_high' }).status).toBe('blocked');
    expect(() => parseSardineResponse({ status: 'Failure', level: 'low' })).toThrow(/status Failure/);
    expect(() => parseSardineResponse({ status: 'Success' })).toThrow(/no risk level/);
  });
});

describe('Fraud & Compliance OS — screen / review / verify workflow', () => {
  it('live: sanctions clear + Sardine low -> live clear screening; Basic auth to the configured host', async () => {
    liveEnv();
    sanctions('clear');
    const f = sardineReply({ sessionKey: 'sk-1', status: 'Success', level: 'low', customer: { score: 12, level: 'low' }, transaction: { level: 'low', amlLevel: 'low' } });
    const s = await FraudComplianceOsEngine.screen({ payee: PAYEE, amountCents: 125000, bankId: 'unit-operating', approvalRef: 'APR-1', actor: 'malissa.robinson' });
    expect(s).toMatchObject({ status: 'clear', mode: 'live', bankId: 'unit-operating', amountCents: 125000, payee: { last4: '3210' }, fraud: { provider: 'internal+sardine', level: 'low', sessionKey: 'sk-1' } });
    const [url, init] = f.mock.calls[0] as any[];
    expect(url).toBe('https://api.sardine.ai/v1/customers');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('cid:csecret').toString('base64')}`);
    expect(JSON.stringify([...rows.values()])).not.toContain('9876543210');
  });

  it('live fails closed when Sardine is unreachable or the sanctions list is local', async () => {
    liveEnv();
    sanctions('clear');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));
    await expect(FraudComplianceOsEngine.screen({ payee: PAYEE, amountCents: 100, actor: 'm' })).rejects.toMatchObject({ status: 503, code: 'FRAUD_PROVIDER_UNREACHABLE' });
    process.env.COMPLIANCE_PROVIDER = 'local';
    await expect(FraudComplianceOsEngine.screen({ payee: PAYEE, amountCents: 100, actor: 'm' })).rejects.toMatchObject({ status: 503, code: 'FRAUD_COMPLIANCE_NOT_READY' });
    expect(rows.size).toBe(0);
  });

  it('shadow without Sardine credentials records a review screening that cannot authorize a live settlement', async () => {
    sanctions('clear');
    process.env.FRAUD_COMPLIANCE_PROVIDER = 'sardine';
    const s = await FraudComplianceOsEngine.screen({ payee: PAYEE, amountCents: 5000, actor: 'malissa.robinson' });
    expect(s).toMatchObject({ status: 'review', mode: 'shadow' });
    expect(s.reasons).toContain('sardine not configured');
    const cleared = await FraudComplianceOsEngine.review({ screeningRef: s.screeningRef, decision: 'clear', actor: 'deandreabarkley13@gmail.com' });
    expect(cleared.status).toBe('clear');
    await expect(FraudComplianceOsEngine.verify({ screeningRef: s.screeningRef, amountCents: 5000 })).rejects.toThrow(/shadow screening/);
  });

  it('review requires a distinct reviewer on FRAUD_COMPLIANCE_REVIEWERS and syncs the sanctions record', async () => {
    liveEnv();
    process.env.FRAUD_COMPLIANCE_REVIEWERS = 'deandreabarkley13@gmail.com';
    sanctions('review');
    sardineReply({ status: 'Success', level: 'low' });
    const approve = vi.spyOn(ComplianceEngine, 'approve').mockResolvedValue({});
    const s = await FraudComplianceOsEngine.screen({ payee: PAYEE, amountCents: 5000, actor: 'malissa.robinson' });
    expect(s.status).toBe('review');
    await expect(FraudComplianceOsEngine.review({ screeningRef: s.screeningRef, decision: 'clear', actor: 'Malissa.Robinson' })).rejects.toMatchObject({ status: 403, code: 'FRAUD_COMPLIANCE_SAME_ACTOR' });
    await expect(FraudComplianceOsEngine.review({ screeningRef: s.screeningRef, decision: 'clear', actor: 'someone@else.test' })).rejects.toMatchObject({ status: 403, code: 'FRAUD_COMPLIANCE_FORBIDDEN' });
    const ok = await FraudComplianceOsEngine.review({ screeningRef: s.screeningRef, decision: 'clear', actor: 'deandreabarkley13@gmail.com', notes: 'false positive' });
    expect(ok).toMatchObject({ status: 'clear', reviewedBy: 'deandreabarkley13@gmail.com' });
    expect(approve).toHaveBeenCalledWith('COMP-1', expect.objectContaining({ reviewedBy: 'deandreabarkley13@gmail.com' }));
  });

  it('blocked screenings cannot be reviewed', async () => {
    liveEnv();
    sanctions('clear');
    sardineReply({ status: 'Success', level: 'very_high' });
    const s = await FraudComplianceOsEngine.screen({ payee: PAYEE, amountCents: 5000, actor: 'm' });
    expect(s.status).toBe('blocked');
    await expect(FraudComplianceOsEngine.review({ screeningRef: s.screeningRef, decision: 'clear', actor: 'c' })).rejects.toMatchObject({ status: 409 });
  });

  it('verify binds amount, bank and payee; consume is single use', async () => {
    liveEnv();
    sanctions('clear');
    sardineReply({ status: 'Success', level: 'low' });
    const s = await FraudComplianceOsEngine.screen({ payee: PAYEE, amountCents: 125000, bankId: 'unit-operating', actor: 'm' });
    const ref = s.screeningRef;
    await expect(FraudComplianceOsEngine.verify({ screeningRef: ref, amountCents: 125001 })).rejects.toThrow(/not 125001/);
    await expect(FraudComplianceOsEngine.verify({ screeningRef: ref, amountCents: 125000, bankId: 'lili' })).rejects.toThrow(/settlement bank unit-operating/);
    await expect(FraudComplianceOsEngine.verify({ screeningRef: ref, amountCents: 125000, payee: { ...PAYEE, accountNumber: '1111' } })).rejects.toThrow(/different payee/);
    expect((await FraudComplianceOsEngine.verify({ screeningRef: ref, amountCents: 125000, bankId: 'unit-operating', payee: PAYEE })).status).toBe('clear');
    const used = await FraudComplianceOsEngine.verify({ screeningRef: ref, amountCents: 125000, bankId: 'unit-operating', consume: true, consumer: 'SBS-1' });
    expect(used).toMatchObject({ status: 'consumed', consumedBy: 'SBS-1' });
    await expect(FraudComplianceOsEngine.verify({ screeningRef: ref, amountCents: 125000, consume: true })).rejects.toThrow(/already used by SBS-1/);
    await expect(FraudComplianceOsEngine.verify({ screeningRef: 'FCS-nope', amountCents: 1 })).rejects.toMatchObject({ status: 409 });
  });

  it('verify refuses an expired screening', async () => {
    liveEnv();
    sanctions('clear');
    sardineReply({ status: 'Success', level: 'low' });
    const s = await FraudComplianceOsEngine.screen({ payee: PAYEE, amountCents: 100, actor: 'm' });
    rows.get(s.screeningRef).expires_at = new Date(Date.now() - 1000);
    await expect(FraudComplianceOsEngine.verify({ screeningRef: s.screeningRef, amountCents: 100 })).rejects.toThrow(/expired/);
  });

  it('rejects non-US payees and missing actor', async () => {
    await expect(FraudComplianceOsEngine.screen({ payee: { ...PAYEE, country: 'MX' }, amountCents: 100, actor: 'm' })).rejects.toMatchObject({ status: 422 });
    await expect(FraudComplianceOsEngine.screen({ payee: PAYEE, amountCents: 100 })).rejects.toMatchObject({ status: 401 });
  });
});

describe('Fraud & Compliance OS — readiness', () => {
  it('lists every blocker in the default configuration', async () => {
    const r = await FraudComplianceOsEngine.readiness();
    expect(r.ready).toBe(false);
    expect(r.mode).toBe('shadow');
    expect(r.blockers).toEqual(expect.arrayContaining([
      'COMPLIANCE_PROVIDER=local: live screening needs ofac or opensanctions',
      'FRAUD_COMPLIANCE_LIVE not true',
      'FRAUD_COMPLIANCE_ENFORCE_SETTLEMENT not true (live settlements accept any screeningRef)',
    ]));
    expect(r.blockers.join(' ')).not.toMatch(/SARDINE/);
  });

  it('is live with sanctions ready, Sardine live host and enforcement on', async () => {
    liveEnv();
    process.env.FRAUD_COMPLIANCE_ENFORCE_SETTLEMENT = 'true';
    vi.spyOn(ComplianceEngine, 'readiness').mockResolvedValue({ ready: true, issues: [] });
    const r = await FraudComplianceOsEngine.readiness();
    expect(r.blockers).toEqual([]);
    expect(r).toMatchObject({ ready: true, mode: 'live' });
    expect(r.status.fraud).toMatchObject({ provider: 'sardine', configured: true, sandbox: false });
  });
});

describe('Fraud & Compliance OS — DLB internal rules (FRAUD_COMPLIANCE_PROVIDER=internal)', () => {
  function internalLive() {
    process.env.FRAUD_COMPLIANCE_LIVE = 'true';
    process.env.COMPLIANCE_PROVIDER = 'opensanctions';
    vi.spyOn(ComplianceEngine, 'assertPaymentReady').mockResolvedValue({ ready: true, provider: 'opensanctions' });
  }

  it('evaluateInternalRules: prior block and cap block; amount, new payee, velocity and missing bank details review', () => {
    const rules = getFraudComplianceConfig({ FRAUD_COMPLIANCE_MAX_AMOUNT_CENTS: '2000000' }).rules;
    const p = normalizePayee(PAYEE);
    const none = { blocked: 0, trusted: 1, dayCount: 0, dayCents: 0 };
    expect(evaluateInternalRules({ payee: p, amountCents: 5000, rail: 'ach', history: none, rules })).toMatchObject({ status: 'clear', level: 'low', reasons: [] });
    expect(evaluateInternalRules({ payee: p, amountCents: 5000, rail: 'ach', history: { ...none, blocked: 1 }, rules }).status).toBe('blocked');
    expect(evaluateInternalRules({ payee: p, amountCents: 2000001, rail: 'ach', history: none, rules }).status).toBe('blocked');
    const rule = (h: any, amt = 5000, rail = 'ach', payee = p) => evaluateInternalRules({ payee, amountCents: amt, rail, history: { ...none, ...h }, rules }).summary.rules.map((r: any) => r.rule);
    expect(rule({}, 1000000)).toEqual(['review_amount']);
    expect(rule({ trusted: 0 })).toEqual(['new_payee']);
    expect(rule({ dayCount: 4 })).toEqual(['velocity_count']);
    expect(rule({ dayCents: 4999000 }, 1000)).toEqual(['velocity_amount']);
    expect(rule({}, 5000, 'wire', normalizePayee({ name: 'X', country: 'US' }))).toEqual(['bank_details']);
  });

  it('live without Sardine: first payment to a payee goes to review, checker clears it, the next one is clear and settles', async () => {
    internalLive();
    sanctions('clear');
    const f = vi.spyOn(globalThis, 'fetch');
    const first = await FraudComplianceOsEngine.screen({ payee: PAYEE, amountCents: 50000, bankId: 'lili', actor: 'AnnRobinson1117@gmail.com' });
    expect(first).toMatchObject({ status: 'review', mode: 'live', fraud: { provider: 'internal', level: 'medium' } });
    expect(first.reasons.join(' ')).toMatch(/internal:new_payee/);
    await FraudComplianceOsEngine.review({ screeningRef: first.screeningRef, decision: 'clear', actor: 'deandreabarkley13@gmail.com' });
    const second = await FraudComplianceOsEngine.screen({ payee: PAYEE, amountCents: 50000, bankId: 'lili', actor: 'AnnRobinson1117@gmail.com' });
    expect(second).toMatchObject({ status: 'clear', mode: 'live', fraud: { provider: 'internal', level: 'low' } });
    await expect(FraudComplianceOsEngine.verify({ screeningRef: second.screeningRef, amountCents: 50000, bankId: 'lili', consume: true, consumer: 'SET-1' })).resolves.toMatchObject({ status: 'consumed' });
    expect(f).not.toHaveBeenCalled();
  });

  it('a blocked payee stays blocked on the next screening', async () => {
    internalLive();
    sanctions('clear');
    const s = await FraudComplianceOsEngine.screen({ payee: PAYEE, amountCents: 50000, actor: 'AnnRobinson1117@gmail.com' });
    await FraudComplianceOsEngine.review({ screeningRef: s.screeningRef, decision: 'block', actor: 'deandreabarkley13@gmail.com' });
    const again = await FraudComplianceOsEngine.screen({ payee: PAYEE, amountCents: 100, actor: 'AnnRobinson1117@gmail.com' });
    expect(again.status).toBe('blocked');
    expect(again.reasons.join(' ')).toMatch(/internal:prior_block/);
  });

  it('readiness is live with the internal provider, a real sanctions list and enforcement on — no Sardine needed', async () => {
    internalLive();
    process.env.FRAUD_COMPLIANCE_ENFORCE_SETTLEMENT = 'true';
    vi.spyOn(ComplianceEngine, 'readiness').mockResolvedValue({ ready: true, issues: [] });
    const r = await FraudComplianceOsEngine.readiness();
    expect(r.blockers).toEqual([]);
    expect(r).toMatchObject({ ready: true, mode: 'live' });
    expect(r.status.fraud).toMatchObject({ provider: 'internal', configured: true });
  });

  it('refuses an unknown fraud provider in live mode', async () => {
    internalLive();
    process.env.FRAUD_COMPLIANCE_PROVIDER = 'none';
    sanctions('clear');
    await expect(FraudComplianceOsEngine.screen({ payee: PAYEE, amountCents: 100, actor: 'm' })).rejects.toMatchObject({ code: 'FRAUD_COMPLIANCE_NOT_READY' });
  });
});
