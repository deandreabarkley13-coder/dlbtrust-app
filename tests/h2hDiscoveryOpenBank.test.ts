import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { H2hDiscoveryOsEngine, extractCandidates, hostAllowed, getH2hConfig } = require('../server/integrations/os/h2hDiscoveryOsEngine');
const { OpenBankRestApiOsEngine, normalizeProvider } = require('../server/integrations/os/openBankRestApiOsEngine');
const { AS2Partners } = require('../server/integrations/ach/as2Partners');
const { TrustAccountStructure } = require('../server/integrations/fineract/trustAccountStructure');
const { EngineWiringReadiness } = require('../server/integrations/os/engineWiringReadiness');
const pool = require('../server/integrations/bonds/pgPool');

const saved = { ...process.env };

const DOC = `
<html><head><title>Bank H2H onboarding</title><script>var x = 1;</script></head><body>
<h1>Host-to-Host file transmission</h1>
<p>AS2 ID: BANKH2H-PROD</p>
<p>Client ID: TRUST-CLIENT-0042</p>
<p>Base URL: https://api.examplebank.com/h2h/v2</p>
<p>SFTP host: sftp.examplebank.com</p>
<p>MDN URL: https://as2.examplebank.com/mdn</p>
<p>Certificate SHA256 fingerprint: AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89</p>
<p>Routing number: 091000022</p>
<p>API key: sk_live_SHOULD_NEVER_BE_STORED</p>
<p>Password: hunter2</p>
</body></html>`;

describe('H2H Discovery OS — extraction', () => {
  it('extracts AS2 ID, client ID, base URL, SFTP host, MDN, fingerprint, routing; never credentials', () => {
    const found = extractCandidates(DOC);
    const by = Object.fromEntries(found.map((c: any) => [c.field, c.value]));
    expect(by.as2_id).toBe('BANKH2H-PROD');
    expect(by.client_id).toBe('TRUST-CLIENT-0042');
    expect(by.base_url).toBe('https://api.examplebank.com/h2h/v2');
    expect(by.sftp_host).toBe('sftp.examplebank.com');
    expect(by.mdn_url).toBe('https://as2.examplebank.com/mdn');
    expect(by.cert_fingerprint).toMatch(/^AB:CD:EF/);
    expect(by.routing_number).toBe('091000022');
    const all = JSON.stringify(found);
    expect(all).not.toContain('sk_live_SHOULD_NEVER_BE_STORED');
    expect(all).not.toContain('hunter2');
    expect(found.some((c: any) => /api[_ ]?key|password/i.test(c.field))).toBe(false);
  });

  it('allow-lists hosts (exact or subdomain) and refuses when the list is empty', () => {
    expect(hostAllowed('developer.examplebank.com', ['examplebank.com'])).toBe(true);
    expect(hostAllowed('examplebank.com', ['examplebank.com'])).toBe(true);
    expect(hostAllowed('evil-examplebank.com', ['examplebank.com'])).toBe(false);
    expect(hostAllowed('169.254.169.254', ['examplebank.com'])).toBe(false);
    expect(hostAllowed('examplebank.com', [])).toBe(false);
  });
});

describe('H2H Discovery OS — register / scan / confirm / apply (maker-checker)', () => {
  let sql: { text: string; params: any[] }[];
  let rows: Record<string, any[]>;

  beforeEach(() => {
    process.env.H2H_DISCOVERY_ALLOWED_HOSTS = 'examplebank.com';
    sql = [];
    rows = {};
    vi.spyOn(pool, 'query').mockImplementation(async (text: any, params: any[] = []) => {
      const t = String(text).replace(/\s+/g, ' ').trim();
      sql.push({ text: t, params });
      if (/INSERT INTO h2h_discovery_sources/.test(t)) return { rows: [{ source_id: params[0], bank_id: params[1], bank_name: params[2], url: params[3], kind: params[4], created_by: params[5], status: 'active' }] } as any;
      if (/SELECT \* FROM h2h_discovery_sources WHERE status = 'active'/.test(t)) return { rows: [{ source_id: 'H2HSRC-1', bank_id: 'examplebank', url: 'https://developer.examplebank.com/h2h' }] } as any;
      if (/INSERT INTO h2h_discovery_candidates/.test(t)) return { rowCount: 1, rows: [] } as any;
      if (/SELECT \* FROM h2h_discovery_candidates/.test(t)) return { rows: rows.candidates || [] } as any;
      if (/UPDATE h2h_discovery_candidates SET status = \$2/.test(t)) return { rows: [{ candidate_id: params[0], status: params[1], confirmed_by: params[2], source_id: 'H2HSRC-1', bank_id: 'examplebank', field: 'as2_id', value: 'BANKH2H-PROD' }] } as any;
      return { rows: [], rowCount: 0 } as any;
    });
    vi.spyOn(H2hDiscoveryOsEngine, '_fetch').mockResolvedValue({ status: 200, body: DOC, finalUrl: 'https://developer.examplebank.com/h2h', contentType: 'text/html' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  it('refuses sources outside the allow-list and non-https', async () => {
    await expect(H2hDiscoveryOsEngine.registerSource({ bankId: 'x', url: 'https://evil.test/docs' })).rejects.toMatchObject({ code: 'H2H_HOST_NOT_ALLOWED' });
    await expect(H2hDiscoveryOsEngine.registerSource({ bankId: 'x', url: 'http://examplebank.com/docs' })).rejects.toMatchObject({ code: 'H2H_BAD_URL' });
    const src = await H2hDiscoveryOsEngine.registerSource({ bankId: 'ExampleBank', bankName: 'Example Bank', url: 'https://developer.examplebank.com/h2h', createdBy: 'trustee-one' });
    expect(src.bankId).toBe('examplebank');
  });

  it('scan stores candidates only (no partner writes) and reports counts by field', async () => {
    const register = vi.spyOn(AS2Partners, 'register');
    const r = await H2hDiscoveryOsEngine.scan({ bankId: 'examplebank', actor: 'trustee-one' });
    expect(r.scanned).toBe(1);
    expect(r.results[0].ok).toBe(true);
    expect(r.results[0].byField.as2_id).toBe(1);
    expect(r.results[0].inserted).toBeGreaterThanOrEqual(7);
    expect(register).not.toHaveBeenCalled();
    expect(sql.some(s => /INSERT INTO h2h_discovery_candidates/.test(s.text) && s.params[3] === 'as2_id' && s.params[4] === 'BANKH2H-PROD')).toBe(true);
  });

  it('apply refuses when the applier confirmed the candidates, then registers an AS2 partner with identifiers only', async () => {
    rows.candidates = [
      { candidate_id: 'C1', source_id: 'H2HSRC-1', bank_id: 'examplebank', field: 'as2_id', value: 'BANKH2H-PROD', status: 'confirmed', confirmed_by: 'trustee-one' },
      { candidate_id: 'C2', source_id: 'H2HSRC-1', bank_id: 'examplebank', field: 'as2_url', value: 'https://as2.examplebank.com/in', status: 'confirmed', confirmed_by: 'trustee-one' },
      { candidate_id: 'C3', source_id: 'H2HSRC-1', bank_id: 'examplebank', field: 'client_id', value: 'TRUST-CLIENT-0042', status: 'confirmed', confirmed_by: 'trustee-one' },
    ];
    vi.spyOn(AS2Partners, 'getPartner').mockResolvedValue(null as any);
    const register = vi.spyOn(AS2Partners, 'register').mockImplementation(async (o: any) => ({ partnerId: o.partnerId, ...o }));

    await expect(H2hDiscoveryOsEngine.apply({ bankId: 'examplebank', actor: 'trustee-one' })).rejects.toMatchObject({ code: 'H2H_SAME_ACTOR' });
    expect(register).not.toHaveBeenCalled();

    const applied = await H2hDiscoveryOsEngine.apply({ bankId: 'examplebank', actor: 'trustee-two' });
    expect(applied.protocol).toBe('as2');
    expect(applied.partnerId).toBe('H2H-EXAMPLEBANK');
    expect(register).toHaveBeenCalledTimes(1);
    const arg = register.mock.calls[0][0];
    expect(arg.partnerAs2Id).toBe('BANKH2H-PROD');
    expect(arg.partnerUrl).toBe('https://as2.examplebank.com/in');
    expect(arg.apiKey).toBeUndefined();
    expect(arg.apiSecret).toBeUndefined();
    expect(sql.some(s => /SET status = 'applied'/.test(s.text) && s.params[1] === 'trustee-two')).toBe(true);
  });

  it('readiness is shadow with the honest blocker until a bank is confirmed+applied', async () => {
    const r = await H2hDiscoveryOsEngine.readiness();
    expect(r.mode).toBe('shadow');
    expect(r.ready).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/no bank has confirmed\+applied/);
    expect(getH2hConfig().allowedHosts).toEqual(['examplebank.com']);
  });
});

describe('Open Bank REST API OS', () => {
  let sql: { text: string; params: any[] }[];

  beforeEach(() => {
    sql = [];
    vi.spyOn(pool, 'query').mockImplementation(async (text: any, params: any[] = []) => {
      const t = String(text).replace(/\s+/g, ' ').trim();
      sql.push({ text: t, params });
      if (/INSERT INTO open_bank_providers/.test(t)) return { rows: [{ provider_id: params[0], name: params[1], documentation_urls: JSON.parse(params[10]), payment_initiation: params[8], api_products: JSON.parse(params[9]) }] } as any;
      if (/SELECT \* FROM open_bank_providers/.test(t)) return { rows: [{ provider_id: 'hsbc', name: 'HSBC', documentation_urls: ['https://developer.hsbc.com/'], payment_initiation: true, api_products: [] }] } as any;
      if (/INSERT INTO open_bank_file_drops/.test(t)) return { rows: [{ file_drop_id: params[0], provider_id: params[1], protocol: params[2], endpoint: params[3], as2_id: params[4], client_id: params[5], partner_id: params[7], channel_id: params[8], status: 'registered', registered_by: params[9] }] } as any;
      if (/SELECT \* FROM open_bank_file_drops WHERE file_drop_id/.test(t)) return { rows: [{ file_drop_id: params[0], provider_id: 'hsbc', registered_by: 'trustee-one' }] } as any;
      if (/UPDATE open_bank_file_drops SET status = 'verified'/.test(t)) return { rows: [{ file_drop_id: params[0], provider_id: 'hsbc', status: 'verified', verified_by: params[1] }] } as any;
      if (/SELECT \* FROM open_bank_file_drops/.test(t)) return { rows: [] } as any;
      return { rows: [], rowCount: 0 } as any;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  it('normalizes a tracker account-provider profile into documentation URLs + payment-initiation flag', () => {
    const p = normalizeProvider({
      id: 'HSBC', name: 'HSBC', countryHQ: 'GB', developerPortalUrl: 'https://developer.hsbc.com/', sandbox: { status: 'available' },
      apiProducts: [{ label: 'PIS', type: 'paymentInitiation', documentationUrl: 'https://developer.hsbc.com/#/pis', apiReferenceUrl: 'http://insecure.example' }],
    });
    expect(p.providerId).toBe('hsbc');
    expect(p.paymentInitiation).toBe(true);
    expect(p.documentationUrls).toEqual(['https://developer.hsbc.com/', 'https://developer.hsbc.com/#/pis']);
    expect(p.sandboxStatus).toBe('available');
  });

  it('importProvider pulls from the tracker dataset and seedDiscovery hands doc URLs to H2H discovery', async () => {
    vi.spyOn(OpenBankRestApiOsEngine, '_getJson').mockResolvedValue({ id: 'hsbc', name: 'HSBC', developerPortalUrl: 'https://developer.hsbc.com/', apiProducts: [] });
    const imported = await OpenBankRestApiOsEngine.importProvider({ providerId: 'hsbc', actor: 'trustee-one' });
    expect(imported.providerId).toBe('hsbc');
    expect(OpenBankRestApiOsEngine._getJson.mock.calls[0][0]).toMatch(/open-banking-tracker-data\/master\/data\/account-providers\/hsbc\.json$/);

    const reg = vi.spyOn(H2hDiscoveryOsEngine, 'registerSource').mockResolvedValue({ sourceId: 'S1' } as any);
    const seeded = await OpenBankRestApiOsEngine.seedDiscovery({ providerId: 'hsbc', actor: 'trustee-one' });
    expect(seeded.seeded).toHaveLength(1);
    expect(reg.mock.calls[0][0]).toMatchObject({ bankId: 'hsbc', url: 'https://developer.hsbc.com/', kind: 'open-banking-tracker' });
  });

  it('registerFileDrop projects onto AS2Partners, refuses credentials, and verify enforces maker/checker', async () => {
    vi.spyOn(AS2Partners, 'getPartner').mockResolvedValue(null as any);
    const register = vi.spyOn(AS2Partners, 'register').mockImplementation(async (o: any) => o);

    await expect(OpenBankRestApiOsEngine.registerFileDrop({ providerId: 'hsbc', protocol: 'rest_api', endpoint: 'https://api.hsbc.com/h2h', notes: 'api_key=abc', actor: 'trustee-one' })).rejects.toMatchObject({ code: 'OPEN_BANK_SECRET_REFUSED' });
    await expect(OpenBankRestApiOsEngine.registerFileDrop({ providerId: 'hsbc', protocol: 'rest_api', endpoint: 'http://api.hsbc.com/h2h', actor: 'trustee-one' })).rejects.toMatchObject({ code: 'OPEN_BANK_BAD_REQUEST' });

    const drop = await OpenBankRestApiOsEngine.registerFileDrop({ providerId: 'hsbc', protocol: 'rest_api', endpoint: 'https://api.hsbc.com/h2h', clientId: 'TRUST-42', actor: 'trustee-one' });
    expect(drop.partnerId).toBe('OB-HSBC');
    expect(drop.status).toBe('registered');
    expect(register.mock.calls[0][0]).toMatchObject({ partnerId: 'OB-HSBC', protocol: 'rest_api', apiBaseUrl: 'https://api.hsbc.com/h2h' });

    await expect(OpenBankRestApiOsEngine.verifyFileDrop({ fileDropId: drop.fileDropId, actor: 'trustee-one' })).rejects.toMatchObject({ code: 'OPEN_BANK_SAME_ACTOR' });
    const verified = await OpenBankRestApiOsEngine.verifyFileDrop({ fileDropId: drop.fileDropId, actor: 'trustee-two' });
    expect(verified.status).toBe('verified');
  });

  it('accounts view is read-only over the Fineract trust account structure', async () => {
    vi.spyOn(TrustAccountStructure, 'inventory').mockResolvedValue({
      accountOfRecord: { role: 'account-of-record', externalId: 'holder:dlb-irrevocable-trust:savings', glCode: '1000', found: true, active: true, id: 2, accountNo: '000000002', status: 'Active', balance: 7709589.04, availableBalance: 7709589.04 },
      principal: { role: 'principal', externalId: 'holder:dlb-irrevocable-trust:principal', glCode: '3000', found: true, active: true, id: 3, accountNo: '000000003', status: 'Active', balance: 0 },
      interestIncome: { role: 'interest-income', externalId: 'holder:dlb-irrevocable-trust:interest-income', glCode: '4000', found: true, active: true, id: 4, accountNo: '000000004', status: 'Active', balance: 0 },
      trustees: [{ role: 'trustee', externalId: 'trustee:CRM-TRU-1:savings', glCode: '1030', found: true, active: true, id: 6, partyName: 'DEANDREA L BARKLEY' }],
      beneficiaries: [{ role: 'beneficiary', externalId: 'beneficiary:CRM-BEN-1:savings', glCode: '1020', found: true, active: true, id: 5, partyName: 'Jeremy N Robinson' }],
    } as any);
    const accounts = await OpenBankRestApiOsEngine.accounts();
    expect(accounts.map((a: any) => a.role)).toEqual(['account-of-record', 'principal', 'interest-income', 'trustee', 'beneficiary']);
    expect(accounts[0].balance).toBe(7709589.04);
    expect(sql.some(s => /withdraw|deposit/i.test(s.text))).toBe(false);
  });

  it('readiness is shadow until a file drop is verified', async () => {
    const r = await OpenBankRestApiOsEngine.readiness();
    expect(r.mode).toBe('shadow');
    expect(r.blockers.join(' ')).toMatch(/no bank file-drop intake registered/);
  });
});

describe('GCP readiness workflow registers both engines', () => {
  it('lists h2h-discovery and open-bank-rest-api with titles and tables', () => {
    expect(EngineWiringReadiness.ENGINE_KEYS).toContain('h2h-discovery');
    expect(EngineWiringReadiness.ENGINE_KEYS).toContain('open-bank-rest-api');
    expect(EngineWiringReadiness.ENGINE_TITLES['h2h-discovery']).toMatch(/web data scraping/i);
    expect(EngineWiringReadiness.ENGINE_TITLES['open-bank-rest-api']).toMatch(/Open Banking Tracker/);
    expect(EngineWiringReadiness.TABLES['h2h-discovery']).toContain('h2h_discovery_candidates');
    expect(EngineWiringReadiness.TABLES['open-bank-rest-api']).toContain('open_bank_file_drops');
  });
});
