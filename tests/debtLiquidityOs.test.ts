import { describe, it, expect, vi, afterEach } from 'vitest';

const pool = require('../server/integrations/bonds/pgPool');
const { DebtOsEngine } = require('../server/integrations/os/debtOsEngine');
const { LiquidityOsEngine } = require('../server/integrations/os/liquidityOsEngine');
const { LiveBondEngine } = require('../server/integrations/bonds/liveEngine');
const { CashEngine } = require('../server/integrations/cash/cashEngine');
const { CreditOsEngine } = require('../server/integrations/os/creditOsEngine');

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) => iso(new Date(Date.now() + n * 86400000));

function stubBond(overrides: any = {}) {
  vi.spyOn(pool, 'query').mockImplementation(async (text: string) => {
    if (/FROM bonds/i.test(text)) {
      return { rows: [{ id: 1, bond_name: 'DLB-PRB', status: 'active', placement_type: overrides.placement_type || 'private', maturity_date: overrides.maturity_date || daysFromNow(3650), payment_freq: 'quarterly', currency: 'USD' }] } as any;
    }
    if (/crm_bond_subscriptions/i.test(text)) return { rows: overrides.holders || [] } as any;
    return { rows: [] } as any;
  });
  vi.spyOn(LiveBondEngine, 'getBondLiveMetrics').mockResolvedValue({
    bond_name: 'DLB-PRB', bond_identifier: 'DLB-PRB-2026', status: 'active', placement_type: overrides.placement_type || 'private', currency: 'USD',
    principal_balance: 100000000, accrued_interest_total: 500000, daily_accrual: 2739.73, coupon_rate_pct: 1, payment_freq: 'quarterly',
    coupon_per_period: 250000, annual_coupon_income: 1000000, next_coupon_date: overrides.next_coupon_date || daysFromNow(10),
    maturity_date: overrides.maturity_date || daysFromNow(3650), days_to_maturity: 3650, total_interest_paid: 0, total_principal_paid: 0,
  });
}

afterEach(() => vi.restoreAllMocks());

describe('DebtOsEngine', () => {
  it('rolls quarterly coupons across the horizon and includes principal at maturity inside the window', async () => {
    stubBond({ next_coupon_date: daysFromNow(10), maturity_date: daysFromNow(200) });
    const s = await DebtOsEngine.schedule(365);
    const coupons = s.events.filter((e: any) => e.type === 'coupon');
    const principal = s.events.filter((e: any) => e.type === 'principal');
    expect(coupons.length).toBe(4); // day 10, ~101, ~192, ~283
    expect(principal).toEqual([expect.objectContaining({ amount: 100000000, date: daysFromNow(200) })]);
    expect(s.totals.total).toBe(4 * 250000 + 100000000);

    const short = await DebtOsEngine.schedule(30);
    expect(short.events.map((e: any) => e.type)).toEqual(['coupon']);
  });

  it('is compliant only for a private placement held by verified trust/family contacts', async () => {
    stubBond({ holders: [
      { bond_id: 1, subscription_id: 'S1', subscription_amount: 50000000, subscription_status: 'active', contact_id: 'CT-TRUSTEE', contact_type: 'trustee', kyc_status: 'verified', aml_status: 'clear', contact_status: 'active' },
      { bond_id: 1, subscription_id: 'S2', subscription_amount: 50000000, subscription_status: 'active', contact_id: 'CT-BENEF', contact_type: 'beneficiary', kyc_status: 'verified', aml_status: 'clear', contact_status: 'active' },
    ] });
    const ok = await DebtOsEngine.placementCompliance();
    expect(ok.compliant).toBe(true);
    expect(ok.publicOffer).toBe(false);
    expect(ok.holdersByType).toEqual({ trustee: 1, beneficiary: 1 });
    vi.restoreAllMocks();

    stubBond({ placement_type: 'public', holders: [
      { bond_id: 1, subscription_id: 'S3', subscription_amount: 1000, subscription_status: 'active', contact_id: 'CT-OUTSIDE', contact_type: 'investor', kyc_status: 'pending', aml_status: 'clear', contact_status: 'active' },
    ] });
    const bad = await DebtOsEngine.placementCompliance();
    expect(bad.compliant).toBe(false);
    expect(bad.externalHolders).toBe(1);
    expect(bad.unverifiedHolders).toBe(1);
    expect(bad.issues.join('\n')).toMatch(/placement_type=public/);
    expect(bad.issues.join('\n')).toMatch(/outside trust\/family .*CT-OUTSIDE/);
    expect(bad.issues.join('\n')).toMatch(/without verified KYC: CT-OUTSIDE/);
  });
});

describe('DebtOsEngine.registerHolders', () => {
  it('rejects holders outside trust/family and shares that do not total 100', async () => {
    stubBond();
    vi.spyOn(DebtOsEngine, 'holderRegister').mockResolvedValue({ bondName: 'DLB-PRB', placementType: 'private', totals: { principalBalance: 98524627.51 }, holders: [] });
    await expect(DebtOsEngine.registerHolders({ bondId: 1, holders: [{ contactType: 'investor', firstName: 'Out', lastName: 'Sider', sharePct: 100 }] })).rejects.toThrow(/contactType must be one of trustee\/beneficiary/);
    await expect(DebtOsEngine.registerHolders({ bondId: 1, holders: [{ contactType: 'trustee', firstName: 'A', lastName: 'B', sharePct: 60 }, { contactType: 'beneficiary', firstName: 'C', lastName: 'D', sharePct: 30 }] })).rejects.toThrow(/sharePct must total 100/);
  });

  it('dry run matches existing contacts by name (case/punctuation-insensitive) and allocates the live principal', async () => {
    stubBond();
    (pool.query as any).mockImplementation(async (text: string) => {
      if (/FROM crm_contacts$/i.test(text.trim())) return { rows: [{ contact_id: 'CRM-TRU-1', contact_type: 'trustee', first_name: 'DEANDREA L', last_name: 'BARKLEY', kyc_status: 'verified' }] } as any;
      return { rows: [] } as any;
    });
    vi.spyOn(DebtOsEngine, 'holderRegister').mockResolvedValue({ bondName: 'DLB-PRB', placementType: 'private', totals: { principalBalance: 1000 }, holders: [{ subscriptionId: 'SUB-OLD' }] });
    const r = await DebtOsEngine.registerHolders({ bondId: 1, dryRun: true, holders: [
      { contactType: 'trustee', firstName: 'DeAndrea-L', lastName: 'Barkley', sharePct: 60 },
      { contactType: 'beneficiary', firstName: 'Jeremy N', lastName: 'Robinson', sharePct: 40 },
    ] });
    expect(r.superseded).toEqual(['SUB-OLD']);
    expect(r.plan).toEqual([
      expect.objectContaining({ contactId: 'CRM-TRU-1', create: false, amount: 600 }),
      expect.objectContaining({ contactId: null, create: true, amount: 400 }),
    ]);
  });
});

describe('DebtOsEngine.applyTrustStructure', () => {
  it('rejects a trustee fee outside the 1-3% band and plans hold-account top-ups to the retained balance (dry run)', async () => {
    stubBond();
    const base = { bondId: 1, fromAccountId: 'CA-OPERATING', trustCompany: { firstName: 'DLB', lastName: 'Family Trust Company' }, beneficiaries: [{ firstName: 'Jeremy N', lastName: 'Robinson' }] };
    await expect(DebtOsEngine.applyTrustStructure({ ...base, feePct: 5 })).rejects.toThrow(/feePct must be within 1-3/);
    (pool.query as any).mockImplementation(async (text: string) => {
      if (/FROM crm_contacts$/i.test(text.trim())) return { rows: [{ contact_id: 'CRM-BEN-7', contact_type: 'trustee', first_name: 'Jeremy N', last_name: 'Robinson', kyc_status: 'verified' }] } as any;
      if (/FROM cash_accounts WHERE account_id/.test(text)) return { rows: [{ account_id: 'CA-CRM-BEN-7', balance_cents: 10000000, status: 'active' }] } as any;
      if (/account_type = 'fee'/.test(text)) return { rows: [{ account_id: 'CA-FEE' }] } as any;
      return { rows: [] } as any;
    });
    vi.spyOn(DebtOsEngine, 'holderRegister').mockResolvedValue({ bondName: 'DLB-PRB', placementType: 'private', totals: { principalBalance: 98524627.51 }, holders: [{ subscriptionId: 'CRM-INV-001' }] });
    const r = await DebtOsEngine.applyTrustStructure({ ...base, feePct: 1, dryRun: true });
    expect(r.register.plan[0]).toEqual(expect.objectContaining({ create: true, amount: 98524627.51 }));
    expect(r.register.superseded).toEqual(['CRM-INV-001']);
    expect(r.beneficiaries[0]).toEqual(expect.objectContaining({ contactId: 'CRM-BEN-7', retype: true }));
    expect(r.funding[0]).toEqual(expect.objectContaining({ accountId: 'CA-CRM-BEN-7', currentBalance: 100000, topUp: 150000 }));
    expect(r.trusteeFee).toEqual(expect.objectContaining({ pct: 1, onDistributed: 150000, amount: 1500, feeAccount: 'CA-FEE', movementId: null }));
  });
});

describe('LiquidityOsEngine', () => {
  it('measures liquid ledger cash against the debt schedule and reserve tier without calling it bank funds', async () => {
    stubBond({ next_coupon_date: daysFromNow(10) });
    vi.spyOn(CashEngine, 'getPositionSummary').mockResolvedValue({
      by_type: { operating: { total_cents: 10000000, account_count: 1 }, reserve: { total_cents: 50000000, account_count: 1 }, distribution: { total_cents: 999999900, account_count: 1 } },
      grand_total_cents: 1059999900, grand_total_dollars: 10599999, generated_at: new Date().toISOString(),
    });
    vi.spyOn(CreditOsEngine, 'fundingSources').mockResolvedValue({ sources: [], realValueCapable: [], anyRealValueCapable: false });

    const c = await LiquidityOsEngine.coverage();
    expect(c.cash.basis).toMatch(/not bank-confirmed/);
    expect(c.cash.liquid).toBe(600000); // operating + reserve; distribution is earmarked
    expect(c.horizons['30d']).toMatchObject({ due: 250000, covered: true, shortfall: 0 });
    expect(c.horizons['365d'].due).toBe(1000000);
    expect(c.horizons['365d'].covered).toBe(false);
    expect(c.reserve).toMatchObject({ balance: 500000, annualCoupon: 1000000, coverage: 0.5 });
    expect(c.payout.realValueCapable).toBe(false);
    expect(c.adequate).toBe(false);
    expect(c.issues).toEqual(expect.arrayContaining([
      expect.stringMatching(/365d debt service 1000000 exceeds liquid cash 600000/),
      expect.stringMatching(/reserve 500000 covers 0.5x/),
      expect.stringMatching(/no funded real-value source/),
    ]));
  });
});

describe('CouponService recurring coupon due-date', () => {
  const { CouponService } = require('../server/integrations/bonds/couponService');
  const m = { payment_freq: 'semi-annual', issue_date: '2024-02-28', next_coupon_date: '2027-02-28' };

  it('is due for the scheduled date on/after it within the grace window (not only on the exact day)', () => {
    expect(CouponService.dueCouponDate(m, '2026-08-28')).toBe('2026-08-28');
    expect(CouponService.dueCouponDate(m, '2026-09-22')).toBe('2026-08-28');
  });
  it('is not due outside the grace window, before the date, or on the issue date', () => {
    expect(CouponService.dueCouponDate(m, '2026-10-15')).toBeNull();
    expect(CouponService.dueCouponDate({ ...m, next_coupon_date: '2026-08-28' }, '2026-08-27')).toBeNull();
    expect(CouponService.dueCouponDate({ ...m, next_coupon_date: '2024-08-28' }, '2024-03-01')).toBeNull();
  });
});
