import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { EgressOsEngine, decide, getEgressConfig, RETIRED_HOSTS } = require('../server/integrations/os/egressOsEngine');
const { H2hDiscoveryOsEngine } = require('../server/integrations/os/h2hDiscoveryOsEngine');
const pool = require('../server/integrations/bonds/pgPool');

const saved = { ...process.env };

describe('Egress OS — policy', () => {
  beforeEach(() => {
    process.env.FINERACT_URL = 'https://dlbtrust-fineract-abc.us-east1.run.app/fineract-provider/api/v1';
    process.env.H2H_DISCOVERY_ALLOWED_HOSTS = 'examplebank.com';
    process.env.EGRESS_ALLOWED_HOSTS = 'api.ipify.org';
    delete process.env.EGRESS_ENFORCE;
  });
  afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });

  it('derives the allow-list from configured engines and denies retired rails in code', () => {
    const cfg = getEgressConfig();
    expect(cfg.allowedHosts).toContain('dlbtrust-fineract-abc.us-east1.run.app');
    expect(cfg.allowedHosts).toContain('examplebank.com');
    expect(cfg.allowedHosts).toContain('secretmanager.googleapis.com');
    for (const h of RETIRED_HOSTS) expect(cfg.deniedHosts).toContain(h);
    expect(decide('https://api.stripe.com/v1/payouts').allowed).toBe(false);
    expect(decide('https://api.thirdweb.com/x').reason).toMatch(/retired/);
    expect(decide('https://developer.examplebank.com/h2h').allowed).toBe(true);
    expect(decide('http://developer.examplebank.com/h2h').reason).toMatch(/HTTPS_ONLY/);
    expect(decide('https://unknown-bank.example/').reason).toMatch(/allow-list/);
    expect(decide('not a url').allowed).toBe(false);
  });

  it('authorize() audits but does not block until EGRESS_ENFORCE=true, then fails closed', async () => {
    const q = vi.spyOn(pool, 'query').mockResolvedValue({ rows: [], rowCount: 1 } as any);
    const d = await EgressOsEngine.authorize('https://api.stripe.com/v1', { caller: 't' });
    expect(d.allowed).toBe(false);
    expect(d.wouldBlock).toBe(true);
    expect(q.mock.calls[0][0]).toMatch(/INSERT INTO egress_events/);
    expect(q.mock.calls[0][1][1]).toBe('egress.refused');
    process.env.EGRESS_ENFORCE = 'true';
    await expect(EgressOsEngine.authorize('https://api.stripe.com/v1', { caller: 't' })).rejects.toMatchObject({ code: 'EGRESS_REFUSED', status: 403 });
    const ok = await EgressOsEngine.authorize('https://developer.examplebank.com/h2h', { caller: 't' });
    expect(ok.allowed).toBe(true);
    expect(ok.enforced).toBe(true);
  });

  it('H2H scan goes through egress authorize and is refused when enforced', async () => {
    process.env.EGRESS_ENFORCE = 'true';
    process.env.H2H_DISCOVERY_ALLOWED_HOSTS = 'examplebank.com';
    process.env.EGRESS_DENIED_HOSTS = 'examplebank.com';
    vi.spyOn(pool, 'query').mockImplementation(async (text: any) => {
      const t = String(text);
      if (/SELECT \* FROM h2h_discovery_sources WHERE status = 'active'/.test(t)) return { rows: [{ source_id: 'S1', bank_id: 'examplebank', url: 'https://developer.examplebank.com/h2h' }] } as any;
      return { rows: [], rowCount: 0 } as any;
    });
    const fetch = vi.spyOn(H2hDiscoveryOsEngine, '_fetch').mockResolvedValue({ status: 200, body: '', finalUrl: '', contentType: 'text/html' });
    const r = await H2hDiscoveryOsEngine.scan({ sourceId: 'S1', actor: 'trustee' });
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).toMatch(/deny-list/);
  });

  it('readiness is shadow until enforced, static IP declared and probe matched; live afterwards', async () => {
    process.env.EGRESS_ENFORCE = 'true';
    process.env.EGRESS_STATIC_IP = '34.1.2.3';
    process.env.EGRESS_VPC_CONNECTOR = 'dlbtrust-run';
    let probe: any = null;
    vi.spyOn(pool, 'query').mockImplementation(async (text: any) => {
      const t = String(text);
      if (/FROM egress_probes/.test(t)) return { rows: probe ? [probe] : [] } as any;
      if (/FROM egress_events/.test(t)) return { rows: [{ allowed: true, n: 3 }, { allowed: false, n: 1 }] } as any;
      return { rows: [], rowCount: 1 } as any;
    });
    let r = await EgressOsEngine.readiness();
    expect(r.mode).toBe('shadow');
    expect(r.blockers.join('\n')).toMatch(/no egress probe yet/);
    expect(r.status.last24h).toEqual({ allowed: 3, refused: 1 });

    vi.spyOn(EgressOsEngine, '_fetchJson').mockResolvedValue({ ip: '34.1.2.3' });
    const p = await EgressOsEngine.probe({ actor: 'trustee' });
    expect(p.matched).toBe(true);
    probe = { probe_id: p.probeId, observed_ip: '34.1.2.3', expected_ip: '34.1.2.3', matched: true, error: null, created_at: new Date() };
    r = await EgressOsEngine.readiness();
    expect(r.ready).toBe(true);
    expect(r.mode).toBe('live');

    probe.observed_ip = '9.9.9.9'; probe.matched = false;
    r = await EgressOsEngine.readiness();
    expect(r.mode).toBe('shadow');
    expect(r.blockers.join('\n')).toMatch(/does not match EGRESS_STATIC_IP/);
  });
});
