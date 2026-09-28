import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

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

describe('Debt OS bank leg (distribute-to-bank)', () => {
  it('reports the unified path with the funded-source / ODFI stages as blockers and fails closed', async () => {
    const path = await DebtOsEngine.bankSettlementPath();
    expect(path.action).toBe('distribute-to-bank');
    expect(path.stages.map((s: any) => s.stage)).toEqual(['coupon_to_ledger', 'hold_accounts', 'bank_destination', 'odfi_origination', 'funded_source']);
    expect(path.realValueCapable).toBe(false);
    expect(path.blockers).toContain('funded_source');

    const acct = { rows: [{ account_id: 'CA-BOND-PROCEEDS', account_type: 'bond_proceeds', balance_cents: '100000000' }] };
    const q = vi.spyOn(pool, 'query').mockResolvedValue(acct as any);
    const dry = await DebtOsEngine.distributeToBank({ fromAccountId: 'CA-BOND-PROCEEDS', amount: 1000, dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, amount: 1000, inTransitAccountId: 'CA-BANK-IN-TRANSIT', gate: { allowed: false } });
    await expect(DebtOsEngine.distributeToBank({ fromAccountId: 'CA-BOND-PROCEEDS', amount: 1000 })).rejects.toThrow(/distribute-to-bank blocked/);
    await expect(DebtOsEngine.distributeToBank({ fromAccountId: 'CA-BOND-PROCEEDS', amount: 5000000 })).rejects.toThrow(/insufficient ledger balance/);
    q.mockRestore();
  });
});

describe('Funding OS (real value → ledger)', () => {
  const { FundingOsEngine } = require('../server/integrations/os/fundingOsEngine');

  it('inventories sources with ledger/bank capabilities; no real-value source unless Credit OS reports one', async () => {
    const spy = vi.spyOn(CreditOsEngine, 'fundingSources').mockResolvedValue({
      sources: [
        { id: 'stripe_treasury', configured: true, mode: 'test', realValueCapable: false, reason: 'test-mode key' },
        { id: 'skrill', configured: true, mode: 'live', realValueCapable: false, reason: 'wallet only' },
        { id: 'bank_odfi', configured: true, mode: 'loopback', realValueCapable: false, reason: 'loopback' },
      ], realValueCapable: [], anyRealValueCapable: false,
    });
    const inv = await FundingOsEngine.sources();
    spy.mockRestore();
    expect(inv.sources.map((s: any) => s.id)).toEqual(expect.arrayContaining(['stripe_treasury', 'skrill', 'bank_odfi', 'manual_bank_deposit']));
    expect(inv.anyRealValueCapable).toBe(false);
    expect(inv.sources.find((s: any) => s.id === 'manual_bank_deposit')).toMatchObject({ canFundLedger: true, canOriginateBankCredit: false, realValueCapable: false });
  });

  it('rejects unknown sources / non-positive amounts and never confirms without an external reference', async () => {
    await expect(FundingOsEngine.requestFunding({ sourceId: 'paypal', toAccountId: 'CA-OPERATING', amount: 10 })).rejects.toThrow(/unknown funding source/);
    await expect(FundingOsEngine.requestFunding({ sourceId: 'manual_bank_deposit', toAccountId: 'CA-OPERATING', amount: 0 })).rejects.toThrow(/positive/);
    const q = vi.spyOn(pool, 'query').mockResolvedValue({ rows: [{ request_id: 'FUND-1', status: 'approved', amount_cents: '100000', to_account_id: 'CA-OPERATING', source_id: 'manual_bank_deposit' }] } as any);
    await expect(FundingOsEngine.confirmFunding({ requestId: 'FUND-1', confirmedBy: 'checker' })).rejects.toThrow(/externalRef/);
    const dry = await FundingOsEngine.confirmFunding({ requestId: 'FUND-1', externalRef: 'LILI-TXN-1', confirmedBy: 'checker', dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, wouldDeposit: { toAccountId: 'CA-OPERATING', amount: 1000 } });
    q.mockRestore();
  });

  it('enforces maker/checker: the approver must differ from the requester', async () => {
    const q = vi.spyOn(pool, 'query').mockResolvedValue({ rows: [{ request_id: 'FUND-2', status: 'requested', requested_by: 'alice', amount_cents: '100' }] } as any);
    await expect(FundingOsEngine.approveFunding({ requestId: 'FUND-2', approvedBy: 'alice' })).rejects.toThrow(/maker\/checker/);
    q.mockRestore();
  });
});

describe('Debt OS coupon settlement into the Fineract account of record', () => {
  const { BondEngine } = require('../server/integrations/bonds/bondEngine');
  const { FineractClient } = require('../server/integrations/fineract/fineractClient');
  const ENV = ['FINERACT_URL', 'CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID', 'CANONICAL_FUNDING_PAYMENT_TYPE_ID', 'PRIVATE_PAYMENT_NETWORK_CORE_BANKING'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of ENV) saved[k] = process.env[k]; process.env.FINERACT_URL = 'https://dlbtrust-fineract.internal/fineract-provider/api/v1'; delete process.env.CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID; delete process.env.PRIVATE_PAYMENT_NETWORK_CORE_BANKING; });
  afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  function stubLedger(account: any, updates: any[] = []) {
    vi.spyOn(DebtOsEngine, 'holderRegister').mockResolvedValue({ bondId: 1, bondName: 'DLB-PRB', holders: [{}], totals: { accruedInterest: 250000 } } as any);
    vi.spyOn(pool, 'query').mockImplementation(async (text: string, params: any[] = []) => {
      if (/FROM cash_accounts/i.test(text)) return { rows: account ? [account] : [] } as any;
      if (/UPDATE coupon_payments/i.test(text)) { updates.push(params); return { rows: [] } as any; }
      return { rows: [] } as any;
    });
  }

  it('_couponCoreBanking resolves the linked savings account, falls back to CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID and blocks when neither exists', () => {
    const env = { FINERACT_URL: 'https://dlbtrust-fineract.internal', CANONICAL_FUNDING_PAYMENT_TYPE_ID: '1' };
    expect(DebtOsEngine._couponCoreBanking({ account_id: 'CA-BOND-PROCEEDS', linked_fineract_account_id: '2' }, env)).toMatchObject({ system: 'fineract', required: true, configured: true, savingsAccountId: '2', paymentTypeId: 1, blocker: null });
    expect(DebtOsEngine._couponCoreBanking({ account_id: 'CA-X' }, { ...env, CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID: '2' }).savingsAccountId).toBe('2');
    expect(DebtOsEngine._couponCoreBanking({ account_id: 'CA-X' }, env).blocker).toMatch(/no linked_fineract_account_id/);
    expect(DebtOsEngine._couponCoreBanking({ account_id: 'CA-X', linked_fineract_account_id: '2' }, { FINERACT_URL: 'http://localhost:8443' }).blocker).toMatch(/FINERACT_URL/);
    expect(DebtOsEngine._couponCoreBanking({ account_id: 'CA-X' }, { PRIVATE_PAYMENT_NETWORK_CORE_BANKING: 'false' })).toMatchObject({ required: false, blocker: null, savingsAccountId: null });
  });

  it('deposits the coupon into the linked Fineract savings account and the trust ledger, then marks the coupon paid (no asset sale)', async () => {
    const updates: any[] = [];
    stubLedger({ account_id: 'CA-BOND-PROCEEDS', account_type: 'bond_proceeds', balance_cents: '0', linked_fineract_account_id: '2' }, updates);
    vi.spyOn(BondEngine, 'payInterest').mockResolvedValue({ remaining_accrued: 0 } as any);
    const deposit = vi.spyOn(FineractClient, 'depositSavings').mockResolvedValue({ resourceId: 9001 } as any);
    const cash = vi.spyOn(CashEngine, 'deposit').mockResolvedValue({ movement_id: 'MOV-1' } as any);

    const dry = await DebtOsEngine.settleCouponToLedger({ bondId: 1, toAccountId: 'CA-BOND-PROCEEDS', couponDate: '2026-09-30', dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, amount: 250000, coreBanking: { savingsAccountId: '2', blocker: null } });
    expect(dry.basis).toMatch(/Fineract core-banking savings account of record/);
    expect(deposit).not.toHaveBeenCalled();

    const res = await DebtOsEngine.settleCouponToLedger({ bondId: 1, toAccountId: 'CA-BOND-PROCEEDS', couponDate: '2026-09-30', approvedBy: 'trustee' });
    expect(deposit).toHaveBeenCalledWith(expect.objectContaining({ accountId: '2', amount: 250000, paymentTypeId: 1 }));
    expect(cash).toHaveBeenCalledWith(expect.objectContaining({ toAccountId: 'CA-BOND-PROCEEDS', amountCents: 25000000 }));
    expect(res).toMatchObject({ status: 'paid', movementId: 'MOV-1', fineract: { system: 'fineract', savingsAccountId: '2', depositTransactionId: '9001', amount: 250000 } });
    expect(updates.at(-1)[0]).toMatch(/^CPN-/);
  });

  it('fails closed before any leg when the cash account has no Fineract link and no canonical account is set', async () => {
    stubLedger({ account_id: 'CA-MISC', account_type: 'operating', balance_cents: '0', linked_fineract_account_id: null });
    const deposit = vi.spyOn(FineractClient, 'depositSavings');
    const pay = vi.spyOn(BondEngine, 'payInterest');
    await expect(DebtOsEngine.settleCouponToLedger({ bondId: 1, toAccountId: 'CA-MISC', couponDate: '2026-09-30' })).rejects.toThrow(/core-banking coupon deposit blocked: cash account CA-MISC has no linked_fineract_account_id/);
    expect(deposit).not.toHaveBeenCalled();
    expect(pay).not.toHaveBeenCalled();
  });

  it('does not claim coupon income reached core banking when the Fineract deposit fails', async () => {
    const updates: any[] = [];
    stubLedger({ account_id: 'CA-BOND-PROCEEDS', account_type: 'bond_proceeds', balance_cents: '0', linked_fineract_account_id: '2' }, updates);
    vi.spyOn(BondEngine, 'payInterest').mockResolvedValue({ remaining_accrued: 0 } as any);
    vi.spyOn(FineractClient, 'depositSavings').mockRejectedValue(new Error('Fineract 401'));
    const cash = vi.spyOn(CashEngine, 'deposit');
    await expect(DebtOsEngine.settleCouponToLedger({ bondId: 1, toAccountId: 'CA-BOND-PROCEEDS', couponDate: '2026-09-30' })).rejects.toThrow('Fineract 401');
    expect(cash).not.toHaveBeenCalled();
    expect(updates.at(-1)).toEqual([expect.stringMatching(/^CPN-/), 'Fineract 401', 'failed']);
  });

  it('keeps the coupon in processing with the Fineract transaction id when the ledger leg fails after the deposit posted', async () => {
    const updates: any[] = [];
    stubLedger({ account_id: 'CA-BOND-PROCEEDS', account_type: 'bond_proceeds', balance_cents: '0', linked_fineract_account_id: '2' }, updates);
    vi.spyOn(BondEngine, 'payInterest').mockResolvedValue({ remaining_accrued: 0 } as any);
    vi.spyOn(FineractClient, 'depositSavings').mockResolvedValue({ resourceId: 9002 } as any);
    vi.spyOn(CashEngine, 'deposit').mockRejectedValue(new Error('ledger down'));
    await expect(DebtOsEngine.settleCouponToLedger({ bondId: 1, toAccountId: 'CA-BOND-PROCEEDS', couponDate: '2026-09-30' })).rejects.toThrow('ledger down');
    expect(updates.at(-1)[2]).toBe('processing');
    expect(updates.at(-1)[1]).toMatch(/deposit 9002 already posted/);
  });
});
