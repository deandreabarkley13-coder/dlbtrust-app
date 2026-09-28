import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { TaxOsEngine, toCsv, FILING_MODE } = require('../server/integrations/os/taxOsEngine');
const { PrivateEntityOsEngine, DECLARATIONS } = require('../server/integrations/os/privateEntityOsEngine');
const { TaxEngine } = require('../server/integrations/tax/taxEngine');
const pool = require('../server/integrations/bonds/pgPool');

const saved = { ...process.env };

const RETURN = {
  return_id: 'R-2025', tax_year: 2025, status: 'computed', computed_at: '2026-01-15T00:00:00Z', trust_name: 'DEANDREA LAVAR BARKLEY TRUST', ein: '99-6411566',
  interest_income: 120000, dividend_income: 0, capital_gains: 0, rental_income: 0, other_income: 0, total_income: 120000,
  trustee_fees: 5000, legal_fees: 1000, tax_prep_fees: 500, other_deductions: 0, total_deductions: 6500,
  distributable_net_income: 113500, income_distribution_deduction: 90000, adjusted_total_income: 113500, personal_exemption: 100,
  taxable_income: 23400, tax_liability: 8000, estimated_payments: 0, tax_due: 8000, notes: null,
  k1s: [{ k1_id: 'K1-1', beneficiary_name: 'Jeremy N Robinson', allocation_percentage: 100, total_income: 90000, distributions_paid: 90000 }],
};
const K1 = { k1_id: 'K1-1', return_id: 'R-2025', tax_year: 2025, status: 'computed', beneficiary_contact_id: 'CRM-BEN-1', beneficiary_name: 'Jeremy N Robinson', beneficiary_tin_last4: '4321', mailing_address: '1 Main St', allocation_percentage: 100, interest_income: 90000, dividend_income: 0, capital_gains: 0, rental_income: 0, other_income: 0, total_income: 90000, deductions: 0, distributions_paid: 90000, issued_at: null };

function mockTax() {
  vi.spyOn(TaxEngine, 'getReturn').mockResolvedValue(RETURN);
  vi.spyOn(TaxEngine, 'listReturns').mockResolvedValue([RETURN]);
  vi.spyOn(TaxEngine, 'getAllConfig').mockResolvedValue({ config: { ein: '99-6411566', trust_name: 'DEANDREA LAVAR BARKLEY TRUST', trust_type: 'complex', fiscal_year_end: '12-31', state: 'OH' } });
  vi.spyOn(TaxEngine, 'listPayments').mockResolvedValue([]);
  vi.spyOn(TaxEngine, 'getK1sForReturn').mockResolvedValue([K1]);
  vi.spyOn(TaxEngine, 'getK1').mockResolvedValue(K1);
  const inserts: any[] = [];
  vi.spyOn(pool, 'query').mockImplementation(async (sql: any, params: any[] = []) => {
    const s = String(sql);
    if (/FROM trust_journal_lines/.test(s)) return { rows: [{ account_code: '3000', debits: 0, credits: 250000 }, { account_code: '4000', debits: 0, credits: 120000 }, { account_code: '2000', debits: 90000, credits: 95000 }], rowCount: 3 };
    if (/FROM coupon_payments/.test(s)) return { rows: [{ total: 120000, n: 4 }], rowCount: 1 };
    if (/FROM fineract_trust_accounts/.test(s)) return { rows: [{ role: 'principal', party_name: null, gl_code: '3000', fineract_account_no: '000000003', status: 'active' }, { role: 'interest-income', party_name: null, gl_code: '4000', fineract_account_no: '000000004', status: 'active' }], rowCount: 2 };
    if (/INSERT INTO tax_report_exports/.test(s)) { inserts.push(params); return { rows: [], rowCount: 1 }; }
    if (/crm_contacts/.test(s)) return { rows: [{ n: 1 }], rowCount: 1 };
    if (/GROUP BY report_type/.test(s)) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  });
  return { inserts };
}

describe('Tax OS — 1041 / K-1 reports and exports (reports only)', () => {
  beforeEach(() => { delete process.env.TAX_OS_EXPORT_BUCKET; delete process.env.TAX_OS_LIVE; });
  afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });

  it('builds the Form 1041 report with principal vs interest-income and beneficiary allocations', async () => {
    mockTax();
    const r = await TaxOsEngine.form1041Report({ taxYear: 2025 });
    expect(r.filing_mode).toBe('reports_only');
    expect(r.lines['9 Total income']).toBe(120000);
    expect(r.lines['Schedule B line 7 Distributable net income']).toBe(113500);
    expect(r.principal_vs_income.principal.additions_to_corpus).toBe(250000);
    expect(r.principal_vs_income.principal.asset_sales).toBe(0);
    expect(r.principal_vs_income.income.interest_and_coupon_income).toBe(120000);
    expect(r.principal_vs_income.distributions.paid).toBe(90000);
    expect(r.beneficiaries[0]).toMatchObject({ beneficiary: 'Jeremy N Robinson', allocation_percentage: 100 });
  });

  it('builds the K-1 report per beneficiary with allocation and Part III items', async () => {
    mockTax();
    const r = await TaxOsEngine.k1Report({ returnId: 'R-2025' });
    expect(r.schedules).toHaveLength(1);
    expect(r.schedules[0].beneficiary.tin_last4).toBe('4321');
    expect(r.schedules[0].part_iii['1 Interest income']).toBe(90000);
    expect(r.schedules[0].distributed_from).toMatch(/no corpus/);
  });

  it('exports JSON, CSV and PDF, records a hashed export row, and never transmits anywhere', async () => {
    const { inserts } = mockTax();
    const j = await TaxOsEngine.exportReport({ reportType: 'form_1041', format: 'json', taxYear: 2025, actor: 'trustee.a' });
    expect(j.mimeType).toBe('application/json');
    expect(JSON.parse(j.body.toString()).return_id).toBe('R-2025');
    const c = await TaxOsEngine.exportReport({ reportType: 'schedule_k1', format: 'csv', returnId: 'R-2025' });
    expect(c.body.toString()).toMatch(/^tax_year,return_id,k1_id,beneficiary/);
    expect(c.body.toString()).toMatch(/Jeremy N Robinson/);
    const p = await TaxOsEngine.exportReport({ reportType: 'package', format: 'pdf', taxYear: 2025 });
    expect(p.body.slice(0, 5).toString()).toBe('%PDF-');
    expect(p.body.toString('latin1')).toMatch(/%%EOF/);
    expect(p.storageUri).toBeNull();
    expect(inserts).toHaveLength(3);
    expect(inserts[0][8]).toMatch(/^[a-f0-9]{64}$/);
    expect(FILING_MODE).toBe('reports_only');
    await expect(TaxOsEngine.exportReport({ reportType: 'form_1041', format: 'xml', taxYear: 2025 })).rejects.toMatchObject({ code: 'TAX_OS_BAD_REQUEST' });
    await expect(TaxOsEngine.process({ action: 'efile' })).rejects.toMatchObject({ code: 'TAX_OS_BAD_ACTION' });
  });

  it('CSV escapes quotes/commas', () => {
    expect(toCsv([{ a: 'x,y', b: 'he said "hi"' }])).toBe('a,b\r\n"x,y","he said ""hi"""\r\n');
  });

  it('readiness reports shadow with TAX_OS_LIVE unset and flags a state mismatch', async () => {
    mockTax();
    process.env.TAX_OS_DECLARED_STATE = 'OH';
    (TaxEngine.getAllConfig as any).mockResolvedValue({ config: { ein: '99-6411566', trust_name: 'T', state: 'GA' } });
    const r = await TaxOsEngine.readiness();
    expect(r.mode).toBe('shadow');
    expect(r.blockers.join('\n')).toMatch(/state=GA/);
    expect(r.blockers.join('\n')).toMatch(/TAX_OS_LIVE/);
    expect(r.status.efile).toMatch(/not offered/);
    expect(r.status.movesMoney).toBe(false);
  });
});

describe('Private Entity OS — declaration, attestation, audit', () => {
  afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });

  function memProfile() {
    const profiles: any[] = [];
    const atts: any[] = [];
    vi.spyOn(pool, 'query').mockImplementation(async (sql: any, params: any[] = []) => {
      const s = String(sql);
      if (/INSERT INTO private_entity_profile/.test(s)) { profiles.push({ profile_id: params[0], version: params[1], entity_name: params[2], family_name: params[6], registered_by: params[11], status: 'declared', superseded_at: null }); return { rows: [] }; }
      if (/INSERT INTO private_entity_attestations/.test(s)) { atts.push({ attestation_id: params[0], profile_id: params[1], attested_by: params[2], role: params[3], statement: params[4] }); return { rows: [] }; }
      if (/FROM private_entity_profile WHERE superseded_at IS NULL/.test(s)) { const p = profiles.filter((x) => !x.superseded_at).sort((a, b) => b.version - a.version)[0]; return { rows: p ? [p] : [] }; }
      if (/FROM private_entity_attestations WHERE profile_id/.test(s)) return { rows: atts.filter((a) => a.profile_id === params[0]) };
      if (/SET superseded_at = NOW\(\)/.test(s)) { const p = profiles.find((x) => x.profile_id === params[0]); p.superseded_at = 'now'; p.status = params[1]; return { rows: [] }; }
      if (/SET status = 'attested'/.test(s)) { profiles.find((x) => x.profile_id === params[0]).status = 'attested'; return { rows: [] }; }
      if (/FROM trust_config/.test(s)) return { rows: [{ config_key: 'ein', config_value: '99-6411566' }, { config_key: 'trust_name', config_value: 'T' }, { config_key: 'state', config_value: 'GA' }] };
      return { rows: [] };
    });
    return { profiles, atts };
  }

  it('register + second-trustee attest reaches attested; same trustee cannot attest twice', async () => {
    memProfile();
    const p = await PrivateEntityOsEngine.register({ designatedFamilyMember: 'DeAndrea L Barkley', actor: 'trustee.a@f' });
    expect(p.version).toBe(1);
    expect(p.status).toBe('declared');
    expect(p.attestations).toHaveLength(1);
    await expect(PrivateEntityOsEngine.attest({ actor: 'TRUSTEE.A@f' })).rejects.toMatchObject({ code: 'PRIVATE_ENTITY_SAME_ACTOR' });
    const a = await PrivateEntityOsEngine.attest({ actor: 'trustee.b@f' });
    expect(a.status).toBe('attested');
    expect(a.attestations).toHaveLength(2);
    const p2 = await PrivateEntityOsEngine.register({ actor: 'trustee.a@f' });
    expect(p2.version).toBe(2);
    expect(Object.keys(DECLARATIONS)).toContain('not_legal_advice');
  });

  it('audit passes only when the platform is private, family-only, non-depository, PPN-only, no on-chain', () => {
    const good = { PRIVATE_ACCESS_MODE: 'enforce', PRIVATE_ACCESS_IAP_ENABLED: 'true', PRIVATE_ACCESS_FAMILY_EMAILS: 'a@f,b@f', PRIVATE_PAYMENT_NETWORK_FAMILY_ONLY: 'true' };
    expect(PrivateEntityOsEngine.audit(good).failing).toEqual([]);
    const bad = { ...good, PRIVATE_ACCESS_PUBLIC_INVOKER: 'true', STRIPE_INTAKE_ENABLED: 'true', ASSET_SALES_ENABLED: 'true', SMART_ROUTER_LIVE: 'true', PRIVATE_PAYMENT_NETWORK_EXCLUDED_PROCESSORS: 'pdcflow' };
    expect(PrivateEntityOsEngine.audit(bad).failing).toEqual(['no_public_invoker', 'no_public_processor', 'non_depository', 'no_asset_sales', 'no_onchain_rails']);
  });

  it('readiness is shadow until registered + attested + audit clean + Ohio state + live, and never claims legal status', async () => {
    memProfile();
    process.env.PRIVATE_ACCESS_MODE = 'enforce';
    process.env.PRIVATE_ACCESS_IAP_ENABLED = 'true';
    process.env.PRIVATE_ACCESS_FAMILY_EMAILS = 'a@f';
    process.env.PRIVATE_PAYMENT_NETWORK_FAMILY_ONLY = 'true';
    delete process.env.PRIVATE_ENTITY_LIVE;
    let r = await PrivateEntityOsEngine.readiness();
    expect(r.blockers.join('\n')).toMatch(/no private entity profile registered/);
    await PrivateEntityOsEngine.register({ actor: 'a@f' });
    r = await PrivateEntityOsEngine.readiness();
    expect(r.blockers.join('\n')).toMatch(/1\/2 trustee attestations/);
    expect(r.blockers.join('\n')).toMatch(/state=GA/);
    expect(r.blockers.join('\n')).toMatch(/PRIVATE_ENTITY_LIVE/);
    expect(r.status.legalStatus).toMatch(/not established by this software/);
    expect(r.status.entity.jurisdiction).toBe('US-OH');
  });
});
