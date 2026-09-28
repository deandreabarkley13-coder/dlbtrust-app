import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');
const Guard = require('../server/integrations/auth/privateAccessGuard');
const schedulerAuth = require('../server/integrations/aggregator/schedulerAuth');
const { PrivatePaymentNetworkOsEngine } = require('../server/integrations/os/privatePaymentNetworkOsEngine');
const { PaymentProcessorOsEngine } = require('../server/integrations/os/paymentProcessorOsEngine');
const { EnterpriseNetworkOsEngine } = require('../server/integrations/os/enterpriseNetworkOsEngine');
const { PaymentGatewayServerEngine } = require('../server/integrations/payments/paymentGatewayServerEngine');
const { CashEngine } = require('../server/integrations/cash/cashEngine');
const { EngineWiringReadiness } = require('../server/integrations/os/engineWiringReadiness');
const pool = require('../server/integrations/bonds/pgPool');

const AUD = '/projects/514695212719/locations/us-east1/services/dlbtrust-app';
const saved = { ...process.env };
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function assertion(email: string, over: { iss?: string; aud?: string } = {}) {
  return jwt.sign({ email, sub: `accounts.google.com:${email}` }, privateKey, { algorithm: 'ES256', keyid: 'k1', issuer: over.iss || Guard.IAP_ISSUER, audience: over.aud || AUD, expiresIn: '5m' });
}

function req(path: string, headers: Record<string, string> = {}) {
  return { path, url: path, headers } as any;
}

function run(mw: any, r: any) {
  const res: any = { statusCode: 200, headers: {} as Record<string, string>, status(c: number) { res.statusCode = c; return res; }, json(b: any) { res.body = b; return res; }, set(k: string, v: string) { res.headers[k] = v; } };
  return new Promise<{ res: any; nexted: boolean }>((resolve) => {
    let nexted = false;
    Promise.resolve(mw(r, res, () => { nexted = true; resolve({ res, nexted }); })).then(() => { if (!nexted) resolve({ res, nexted }); });
  });
}

describe('privateAccessGuard — IAP family allow-list', () => {
  beforeEach(() => {
    process.env.PRIVATE_ACCESS_MODE = 'enforce';
    process.env.PRIVATE_ACCESS_IAP_AUDIENCE = AUD;
    process.env.PRIVATE_ACCESS_FAMILY_EMAILS = 'deandreabarkley13@gmail.com';
    process.env.PRIVATE_ACCESS_FAMILY_DOMAINS = 'dlbtrust.family';
    process.env.PRIVATE_ACCESS_SERVICE_ACCOUNTS = 'dlbtrust-deployer@dlb-treasury-management.iam.gserviceaccount.com';
    delete process.env.PRIVATE_ACCESS_EXEMPT_PATHS;
    Guard._reset();
    Guard._setKeysForTest({ k1: PEM });
    vi.spyOn(schedulerAuth, 'verifySchedulerToken').mockResolvedValue(null);
  });
  afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });

  it('admits a family identity asserted by IAP and stamps the identity header', async () => {
    const { res, nexted } = await run(Guard.privateAccessGuard(), req('/api/os/readiness', { [Guard.IAP_HEADER]: assertion('DeAndreaBarkley13@gmail.com') }));
    expect(nexted).toBe(true);
    expect(res.headers['x-dlb-family-identity']).toBe('deandreabarkley13@gmail.com');
    const d2 = await Guard.decideRequest(req('/x', { [Guard.IAP_HEADER]: assertion('malissa@dlbtrust.family') }));
    expect(d2).toMatchObject({ allow: true, kind: 'family' });
  });

  it('refuses anonymous requests and non-family identities with 403 in enforce mode; only /api/health is exempt', async () => {
    const anon = await run(Guard.privateAccessGuard(), req('/api/os/private-payment-network/list'));
    expect(anon.nexted).toBe(false);
    expect(anon.res.statusCode).toBe(403);
    expect(anon.res.body.code).toBe('PRIVATE_ACCESS_REFUSED');
    const stranger = await run(Guard.privateAccessGuard(), req('/api/open-bank/v1/accounts', { [Guard.IAP_HEADER]: assertion('someone@example.com') }));
    expect(stranger.res.statusCode).toBe(403);
    const health = await run(Guard.privateAccessGuard(), req('/api/health/ready'));
    expect(health.nexted).toBe(true);
    expect(Guard.status().decisions.refused).toBe(2);
  });

  it('rejects forged assertions: wrong audience, wrong issuer, unknown key, non-ES256', async () => {
    expect(await Guard.verifyIapAssertion(assertion('deandreabarkley13@gmail.com', { aud: '/projects/1/locations/us-east1/services/other' }))).toBeNull();
    expect(await Guard.verifyIapAssertion(assertion('deandreabarkley13@gmail.com', { iss: 'https://accounts.google.com' }))).toBeNull();
    Guard._setKeysForTest({ other: PEM });
    expect(await Guard.verifyIapAssertion(assertion('deandreabarkley13@gmail.com'))).toBeNull();
    const hs = jwt.sign({ email: 'deandreabarkley13@gmail.com' }, 'secret', { algorithm: 'HS256', keyid: 'k1', issuer: Guard.IAP_ISSUER, audience: AUD });
    expect(await Guard.verifyIapAssertion(hs)).toBeNull();
    expect(await Guard.verifyIapAssertion(assertion('x@y', {}), { ...Guard.getPrivateAccessConfig(), audience: null })).toBeNull();
  });

  it('admits platform service accounts asserted by IAP or via the scheduler OIDC token', async () => {
    const sa = await Guard.decideRequest(req('/api/os/readiness', { [Guard.IAP_HEADER]: assertion('dlbtrust-deployer@dlb-treasury-management.iam.gserviceaccount.com') }));
    expect(sa).toMatchObject({ allow: true, kind: 'platform' });
    (schedulerAuth.verifySchedulerToken as any).mockResolvedValue({ email: 'sched@dlb-treasury-management.iam.gserviceaccount.com' });
    const sched = await Guard.decideRequest(req('/api/os/aggregator/pull', { authorization: 'Bearer t' }));
    expect(sched).toMatchObject({ allow: true, kind: 'scheduler' });
  });

  it('audit mode records the refusal but lets the request through; off mode skips the check', async () => {
    process.env.PRIVATE_ACCESS_MODE = 'audit';
    const a = await run(Guard.privateAccessGuard(), req('/api/os/readiness'));
    expect(a.nexted).toBe(true);
    expect(Guard.status().decisions.audited).toBe(1);
    expect(Guard.status().decisions.lastRefusal.kind).toBe('anonymous');
    process.env.PRIVATE_ACCESS_MODE = 'off';
    const o = await run(Guard.privateAccessGuard(), req('/api/os/readiness'));
    expect(o.nexted).toBe(true);
    expect(Guard.status().mode).toBe('off');
  });
});

describe('PPN family-only mode', () => {
  beforeEach(() => {
    process.env.GCP_PROJECT = 'dlb-treasury-management';
    process.env.DATABASE_URL = 'postgres://app:pw@10.0.0.5:5432/dlbtrust';
    process.env.PRIVATE_PAYMENT_NETWORK_FAMILY_ONLY = 'true';
    delete process.env.PRIVATE_PAYMENT_NETWORK_EXCLUDED_PROCESSORS;
    vi.spyOn(pool, 'query').mockImplementation(async (sql: any, params: any = []) => {
      if (/INSERT INTO private_payment_network_transactions/i.test(String(sql))) {
        const [transaction_id, type, source_account_id, destination_account_id, , participant_id, processor, , amount_cents] = params;
        return { rows: [{ transaction_id, type, source_account_id, destination_account_id, participant_id, processor, amount_cents, status: 'submitted', destination: {}, metadata: {} }] } as any;
      }
      return { rows: [] } as any;
    });
    vi.spyOn(CashEngine, 'getAccount').mockImplementation(async (id: string) => (id === 'CA-404' ? null : { account_id: id, status: 'active', balance_cents: 1000000, currency: 'USD' }));
    vi.spyOn(PaymentGatewayServerEngine, 'getMethod').mockResolvedValue({ method_id: 'PM-ACH-1', type: 'ach', processor: 'payment_hub', status: 'active' });
    vi.spyOn(EnterpriseNetworkOsEngine, 'resolveRoute').mockResolvedValue(null);
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue({
      config: { ...PaymentProcessorOsEngine.getConfig(), live: true, requireApproval: true, requireScreening: true },
      sources: [
        { id: 'payment_hub', mode: 'live', configured: true, realValueCapable: true, reason: null },
        { id: 'stripe_treasury', mode: 'live', configured: true, realValueCapable: true, reason: null },
      ],
      realValueCapable: ['payment_hub', 'stripe_treasury'], anyRealValueCapable: true,
    });
  });
  afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });

  it('excludes Stripe and card/wallet rails by default and refuses payouts routed to them', async () => {
    const cfg = PrivatePaymentNetworkOsEngine.getConfig();
    expect(cfg.familyOnly).toBe(true);
    expect(cfg.excludedProcessors).toEqual(['stripe_treasury', 'stripe', 'pdcflow', 'skrill']);
    expect(PrivatePaymentNetworkOsEngine.excludedReason('stripe_treasury')).toMatch(/excluded/);
    expect(PrivatePaymentNetworkOsEngine.excludedReason('stripe_connect_x')).toMatch(/excluded/);
    expect(PrivatePaymentNetworkOsEngine.excludedReason('internal_ledger')).toBeNull();
    vi.spyOn(EnterpriseNetworkOsEngine, 'admit').mockResolvedValue({ participant: { participantId: 'ENP-B', participantType: 'beneficiary' } });
    await expect(PrivatePaymentNetworkOsEngine.submit({ type: 'payout', sourceAccountId: 'CA-TRUST', methodId: 'PM-ACH-1', participantId: 'ENP-B', processor: 'stripe_treasury', amountCents: 1000, requestedBy: 'maker' }))
      .rejects.toMatchObject({ status: 409, message: /stripe_treasury is excluded/ });
  });

  it('refuses payouts to non-family participants and admits trustee / beneficiary / metadata.family participants', async () => {
    const admit = vi.spyOn(EnterpriseNetworkOsEngine, 'admit').mockResolvedValue({ participant: { participantId: 'ENP-V', participantType: 'vendor' } });
    const base = { type: 'payout', sourceAccountId: 'CA-TRUST', methodId: 'PM-ACH-1', processor: 'payment_hub', amountCents: 1000, requestedBy: 'maker' };
    await expect(PrivatePaymentNetworkOsEngine.submit({ ...base, participantId: 'ENP-V' })).rejects.toMatchObject({ status: 409, message: /family-only network: participant ENP-V is vendor/ });
    admit.mockResolvedValue({ participant: { participantId: 'ENP-T', type: 'trustee' } });
    await expect(PrivatePaymentNetworkOsEngine.submit({ ...base, participantId: 'ENP-T' })).resolves.toMatchObject({ participantId: 'ENP-T' });
    admit.mockResolvedValue({ participant: { participantId: 'ENP-F', type: 'counterparty', metadata: { family: true } } });
    await expect(PrivatePaymentNetworkOsEngine.submit({ ...base, participantId: 'ENP-F' })).resolves.toMatchObject({ participantId: 'ENP-F' });
    expect(PrivatePaymentNetworkOsEngine.familyReason(null)).toMatch(/needs a family participant/);
    process.env.PRIVATE_PAYMENT_NETWORK_FAMILY_ONLY = 'false';
    expect(PrivatePaymentNetworkOsEngine.familyReason({ participantType: 'vendor' })).toBeNull();
  });

  it('book transfers between trust sub-accounts stay available as the family distribution route', async () => {
    const tx = await PrivatePaymentNetworkOsEngine.submit({ type: 'book_transfer', sourceAccountId: 'CA-INTEREST-INCOME', destinationAccountId: 'CA-BENEFICIARY', amountCents: 5000, requestedBy: 'maker' });
    expect(tx).toMatchObject({ type: 'book_transfer', processor: 'internal_ledger' });
  });

  it('processor inventory reports excluded rails as non-real-value and exposes family-only state', async () => {
    const inv = await PrivatePaymentNetworkOsEngine.processors();
    const stripe = inv.sources.find((s: any) => s.id === 'stripe_treasury');
    expect(stripe).toMatchObject({ mode: 'excluded', realValueCapable: false });
    expect(stripe.reason).toMatch(/excluded/);
    expect(inv.realValueCapable).not.toContain('stripe_treasury');
    expect(inv.familyOnly).toBe(true);
    expect(inv.excludedProcessors).toContain('stripe');
  });
});

describe('private-access readiness', () => {
  beforeEach(() => {
    process.env.GCP_PROJECT = 'dlb-treasury-management';
    process.env.GOOGLE_CLOUD_PROJECT = 'dlb-treasury-management';
    process.env.DATABASE_URL = 'postgres://app:pw@10.0.0.5:5432/dlbtrust';
    vi.spyOn(pool, 'query').mockImplementation(async (sql: any) => {
      if (/current_database\(\)/i.test(String(sql))) return { rows: [{ db: 'dlbtrust', version: 'PostgreSQL 16' }] } as any;
      return { rows: [] } as any;
    });
  });
  afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });

  it('is registered and fails closed when the platform is still public or the PPN is not family-only', async () => {
    expect(EngineWiringReadiness.ENGINE_KEYS).toContain('private-access');
    process.env.PRIVATE_ACCESS_MODE = 'audit';
    process.env.PRIVATE_ACCESS_PUBLIC_INVOKER = 'true';
    process.env.PRIVATE_ACCESS_EXEMPT_PATHS = '/api/health,/api/open-bank';
    delete process.env.PRIVATE_ACCESS_IAP_AUDIENCE;
    delete process.env.PRIVATE_ACCESS_FAMILY_EMAILS;
    delete process.env.PRIVATE_ACCESS_IAP_ENABLED;
    process.env.PRIVATE_PAYMENT_NETWORK_FAMILY_ONLY = 'false';
    const r = await EngineWiringReadiness.engineReadiness('private-access');
    expect(r.ready).toBe(false);
    expect(r.mode).toBe('shadow');
    const b = r.blockers.join('\n');
    expect(b).toMatch(/PRIVATE_ACCESS_MODE=audit/);
    expect(b).toMatch(/PRIVATE_ACCESS_IAP_AUDIENCE not set/);
    expect(b).toMatch(/no family identity is allow-listed/);
    expect(b).toMatch(/exposes non-health routes: \/api\/open-bank/);
    expect(b).toMatch(/PRIVATE_ACCESS_IAP_ENABLED not true/);
    expect(b).toMatch(/allUsers still holds roles\/run.invoker/);
    expect(b).toMatch(/PRIVATE_PAYMENT_NETWORK_FAMILY_ONLY not true/);
  });

  it('is live with IAP on, no public invoker, an enforcing guard, a family allow-list and a family-only PPN', async () => {
    process.env.PRIVATE_ACCESS_MODE = 'enforce';
    process.env.PRIVATE_ACCESS_IAP_AUDIENCE = AUD;
    process.env.PRIVATE_ACCESS_FAMILY_EMAILS = 'deandreabarkley13@gmail.com';
    process.env.PRIVATE_ACCESS_IAP_ENABLED = 'true';
    process.env.PRIVATE_ACCESS_PUBLIC_INVOKER = 'false';
    process.env.PRIVATE_ACCESS_INGRESS = 'INGRESS_TRAFFIC_ALL';
    process.env.PRIVATE_ACCESS_EXEMPT_PATHS = '/api/health';
    process.env.PRIVATE_PAYMENT_NETWORK_FAMILY_ONLY = 'true';
    delete process.env.PRIVATE_PAYMENT_NETWORK_EXCLUDED_PROCESSORS;
    const r = await EngineWiringReadiness.engineReadiness('private-access');
    expect(r.blockers).toEqual([]);
    expect(r).toMatchObject({ ready: true, mode: 'live' });
    expect(r.liveFlags).toMatchObject({ PRIVATE_ACCESS_MODE: 'enforce', PRIVATE_ACCESS_IAP_ENABLED: true, PRIVATE_ACCESS_PUBLIC_INVOKER: false, PRIVATE_PAYMENT_NETWORK_FAMILY_ONLY: true });
    expect(r.liveFlags.PRIVATE_PAYMENT_NETWORK_EXCLUDED_PROCESSORS).toContain('stripe_treasury');
  });
});
