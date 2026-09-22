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
