'use strict';

/**
 * Debt OS Engine — the trust's own liabilities: the private-placement bond(s)
 * held by the trust and its family beneficiaries. Not for sale, no public offer.
 *
 *   obligations()          every bond with live principal, accrued interest, next
 *                          coupon and maturity (LiveBondEngine.getBondLiveMetrics)
 *   placementCompliance()  every bond must be placement_type='private'; every
 *                          holder must be a trust/family contact with verified KYC
 *   schedule(days)         coupon + principal cash calls falling inside the window
 *   holderRegister(bondId) each holder's pro-rata share of live principal + accrued
 *   registerHolders(...)   set the holder register: ensure trust/family contacts exist,
 *                          supersede prior active subscriptions, allocate the bond
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

function tryRequire(mod) {
  try { return require(mod); } catch (e) { return null; }
}

async function settle(fn) {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: e.message }; }
}

const TABLES = ['bonds', 'bond_balances', 'bond_transactions', 'coupon_payments', 'crm_bond_subscriptions', 'crm_contacts'];

// Only these CRM contact types may hold the private-placement bond — plus the family trust
// company itself (a contact tagged TRUST_COMPANY_TAG), which is the issuer-holder.
const ALLOWED_HOLDER_TYPES = ['trustee', 'beneficiary'];
const TRUST_COMPANY_TAG = 'trust-company';
const isAllowedHolder = c => ALLOWED_HOLDER_TYPES.includes(c.contact_type) || (Array.isArray(c.tags) && c.tags.includes(TRUST_COMPANY_TAG));

// Trust structure defaults: each beneficiary hold account retains this balance; trustees
// earn an administration/distribution fee inside this band.
const DEFAULT_HOLD_BALANCE = 250000;
const TRUSTEE_FEE_BAND_PCT = { min: 1, max: 3 };
const SETTING_TRUSTEE_FEE = 'debt_os_trustee_fee_pct';
// When set to a cash account id, due coupons are settled internally into that ledger account
// by the coupon scheduler instead of being disbursed by ACH.
const SETTING_COUPON_LEDGER_ACCOUNT = 'debt_os_coupon_ledger_account';

// Retired bonds (test issues that were called, redeemed instruments) carry no placement obligation.
const TERMINAL_STATUSES = ['called', 'matured', 'redeemed', 'cancelled'];

const DAY_MS = 86400000;
const num = v => Number(v) || 0;

function periodsPerYear(freq) {
  return { monthly: 12, quarterly: 4, 'semi-annual': 2, annual: 1 }[freq] || 12;
}

class DebtOsEngine {
  static get engineName() { return 'debt'; }
  static get TABLES() { return TABLES; }
  static get ALLOWED_HOLDER_TYPES() { return ALLOWED_HOLDER_TYPES; }

  /**
   * Holder register: who holds the bond and what each holding is worth now.
   * Share = subscription_amount / sum(active subscriptions); value = share of
   * live principal_balance + accrued_interest from bond_balances.
   */
  static async holderRegister(bondId) {
    if (!pool) throw new Error('ledger unavailable');
    const b = await pool.query(
      `SELECT b.id, b.bond_name, b.placement_type, b.coupon_rate, b.payment_freq, b.currency, b.status,
              bb.principal_balance, bb.accrued_interest, bb.total_interest_paid, bb.last_accrual_date
         FROM bonds b LEFT JOIN bond_balances bb ON bb.bond_id = b.id WHERE b.id = $1`, [bondId]);
    if (!b.rows.length) throw new Error(`bond ${bondId} not found`);
    const bond = b.rows[0];
    const s = await pool.query(
      `SELECT s.subscription_id, s.contact_id, s.subscription_amount, s.settlement_date, s.status, s.cash_account_id,
              c.contact_type, c.tags, c.first_name, c.last_name, c.company, c.kyc_status, c.aml_status, c.fineract_client_id
         FROM crm_bond_subscriptions s JOIN crm_contacts c ON c.contact_id = s.contact_id
        WHERE s.bond_id = $1 AND s.status = 'active' ORDER BY s.subscription_amount DESC, s.created_at`, [bondId]);
    const subscribed = s.rows.reduce((t, r) => t + num(r.subscription_amount), 0);
    const principal = num(bond.principal_balance);
    const accrued = num(bond.accrued_interest);
    const r2 = v => Math.round(v * 100) / 100;
    const holders = s.rows.map(r => {
      const share = subscribed > 0 ? num(r.subscription_amount) / subscribed : 0;
      return {
        subscriptionId: r.subscription_id,
        contactId: r.contact_id,
        name: `${r.first_name} ${r.last_name}`.trim(),
        company: r.company,
        role: Array.isArray(r.tags) && r.tags.includes(TRUST_COMPANY_TAG) ? 'trust-company' : r.contact_type,
        allowed: isAllowedHolder(r),
        kyc: r.kyc_status,
        aml: r.aml_status,
        fineractClientId: r.fineract_client_id,
        subscriptionAmount: num(r.subscription_amount),
        sharePct: r2(share * 100),
        principalValue: r2(principal * share),
        accruedInterest: r2(accrued * share),
        currentValue: r2((principal + accrued) * share),
        settlementDate: r.settlement_date,
      };
    });
    return {
      bondId: bond.id,
      bondName: bond.bond_name,
      placementType: bond.placement_type,
      currency: bond.currency,
      couponRatePct: num(bond.coupon_rate) * 100,
      paymentFreq: bond.payment_freq,
      asOf: bond.last_accrual_date,
      totals: { subscribed, principalBalance: principal, accruedInterest: accrued, currentValue: r2(principal + accrued), holders: holders.length },
      holders,
      basis: 'pro-rata share of live bond_balances (ledger), not a bank balance',
    };
  }

  /**
   * Set the bond's holder register in one maker-approved step.
   *   holders: [{ contactId? , contactType:'trustee'|'beneficiary', firstName, lastName, sharePct? | amount? }]
   * Missing contacts are created (CrmEngine.createContact) and KYC-verified/approved by `approvedBy`.
   * Existing active subscriptions for the bond are cancelled (superseded) and a new active subscription is
   * written per holder against the bond's live principal_balance (or `allocateAmount`).
   */
  static async registerHolders({ bondId, holders, approvedBy, allocateAmount, settlementDate, dryRun = false }) {
    if (!pool) throw new Error('ledger unavailable');
    if (!Array.isArray(holders) || !holders.length) throw new Error('holders[] required');
    const Crm = tryRequire('../crm/crmEngine')?.CrmEngine;
    if (!Crm) throw new Error('CrmEngine unavailable');
    for (const h of holders) {
      if (!ALLOWED_HOLDER_TYPES.includes(h.contactType) && !h.trustCompany) throw new Error(`holder ${h.firstName} ${h.lastName}: contactType must be one of ${ALLOWED_HOLDER_TYPES.join('/')}`);
    }
    const reg = await this.holderRegister(bondId);
    if (reg.placementType !== 'private') throw new Error(`bond ${reg.bondName} is not a private placement`);
    const total = num(allocateAmount) || reg.totals.principalBalance;
    const pctSum = holders.reduce((t, h) => t + num(h.sharePct), 0);
    const useShares = holders.every(h => h.sharePct != null);
    if (useShares && Math.abs(pctSum - 100) > 0.01) throw new Error(`sharePct must total 100 (got ${pctSum})`);
    if (!useShares && !holders.every(h => h.amount != null)) throw new Error('give every holder either sharePct or amount');

    const existing = await pool.query(`SELECT * FROM crm_contacts`);
    const norm = v => String(v || '').replace(/[^a-z]/gi, '').toLowerCase();
    const plan = [];
    for (const h of holders) {
      let c = h.contactId ? existing.rows.find(r => r.contact_id === h.contactId) : null;
      if (!c) c = existing.rows.find(r => (h.trustCompany || r.contact_type === h.contactType) && norm(r.first_name) === norm(h.firstName) && norm(r.last_name) === norm(h.lastName));
      const amount = Math.round((h.amount != null ? num(h.amount) : total * num(h.sharePct) / 100) * 100) / 100;
      plan.push({ holder: h, contact: c || null, create: !c, amount });
    }
    const superseded = reg.holders.map(x => x.subscriptionId);
    if (dryRun) return { dryRun: true, bondId, total, superseded, plan: plan.map(p => ({ name: `${p.holder.firstName} ${p.holder.lastName}`, role: p.holder.contactType, contactId: p.contact?.contact_id || null, create: p.create, amount: p.amount })) };

    const created = [];
    for (const p of plan) {
      if (p.create) {
        const c = await Crm.createContact({ contactType: p.holder.contactType, firstName: p.holder.firstName, lastName: p.holder.lastName, company: p.holder.company, email: p.holder.email, tags: p.holder.trustCompany ? [TRUST_COMPANY_TAG] : null, notes: `private-placement holder (registered by ${approvedBy || 'system'})` });
        p.contact = c; created.push(c.contact_id);
      } else if (p.holder.trustCompany && !(Array.isArray(p.contact.tags) && p.contact.tags.includes(TRUST_COMPANY_TAG))) {
        await pool.query(`UPDATE crm_contacts SET tags = array_append(COALESCE(tags, '{}'), $2), updated_at = NOW() WHERE contact_id = $1`, [p.contact.contact_id, TRUST_COMPANY_TAG]);
      } else if (!p.holder.trustCompany && p.contact.contact_type !== p.holder.contactType) {
        await pool.query(`UPDATE crm_contacts SET contact_type = $2, updated_at = NOW() WHERE contact_id = $1`, [p.contact.contact_id, p.holder.contactType]);
      }
      if (p.contact.kyc_status !== 'verified') await Crm.updateKycStatus(p.contact.contact_id, 'verified');
      if ('approval_status' in p.contact && p.contact.approval_status !== 'approved') await Crm.approveContact(p.contact.contact_id, approvedBy || 'system');
    }
    if (superseded.length) {
      await pool.query(`UPDATE crm_bond_subscriptions SET status = 'cancelled', notes = COALESCE(notes || ' | ', '') || $2, updated_at = NOW() WHERE subscription_id = ANY($1)`,
        [superseded, `superseded by holder register ${new Date().toISOString().slice(0, 10)} (${approvedBy || 'system'})`]);
    }
    const subs = [];
    for (const p of plan) {
      const sub = await Crm.createBondSubscription({ contactId: p.contact.contact_id, bondId, subscriptionAmount: p.amount, offeringPrice: 1.0, settlementDate: settlementDate || new Date().toISOString().slice(0, 10), notes: `holder register allocation (${approvedBy || 'system'})` });
      subs.push(sub.subscription_id);
    }
    return { bondId, total, createdContacts: created, superseded, subscriptions: subs, register: await this.holderRegister(bondId) };
  }

  static async listBonds() {
    if (!pool) return [];
    const r = await pool.query(`SELECT id, bond_name, status, placement_type, maturity_date, payment_freq, currency FROM bonds ORDER BY id`);
    return r.rows;
  }

  // ── Obligations ─────────────────────────────────────────────────────────

  static async obligations() {
    const Live = tryRequire('../bonds/liveEngine')?.LiveBondEngine;
    const bonds = await this.listBonds();
    const items = [];
    for (const b of bonds) {
      const m = Live ? await settle(() => Live.getBondLiveMetrics(b.id)) : { ok: false, error: 'LiveBondEngine unavailable' };
      if (!m.ok) { items.push({ bondId: b.id, bondName: b.bond_name, status: b.status, error: m.error }); continue; }
      const v = m.value;
      items.push({
        bondId: b.id,
        bondName: v.bond_name,
        identifier: v.bond_identifier,
        status: v.status,
        placementType: v.placement_type,
        currency: v.currency,
        principalBalance: num(v.principal_balance),
        accruedInterest: num(v.accrued_interest_total),
        dailyAccrual: num(v.daily_accrual),
        couponRatePct: num(v.coupon_rate_pct),
        paymentFreq: v.payment_freq,
        couponPerPeriod: num(v.coupon_per_period),
        annualCoupon: num(v.annual_coupon_income),
        nextCouponDate: v.next_coupon_date,
        maturityDate: v.maturity_date,
        daysToMaturity: v.days_to_maturity,
        totalInterestPaid: num(v.total_interest_paid),
        totalPrincipalPaid: num(v.total_principal_paid),
      });
    }
    const active = items.filter(i => !i.error && i.status === 'active');
    return {
      bonds: items,
      totals: {
        activeBonds: active.length,
        principalOutstanding: active.reduce((s, i) => s + i.principalBalance, 0),
        accruedInterest: active.reduce((s, i) => s + i.accruedInterest, 0),
        annualCoupon: active.reduce((s, i) => s + i.annualCoupon, 0),
      },
      generatedAt: new Date().toISOString(),
    };
  }

  // ── Placement compliance ────────────────────────────────────────────────

  static async placementCompliance() {
    const issues = [];
    const bonds = (await this.listBonds()).filter(b => !TERMINAL_STATUSES.includes(b.status));
    const publicBonds = bonds.filter(b => (b.placement_type || 'public') !== 'private');
    for (const b of publicBonds) issues.push(`bond ${b.bond_name} (#${b.id}) placement_type=${b.placement_type || 'public'}; must be 'private' (no public offer)`);

    let holders = [];
    if (pool) {
      const r = await pool.query(
        `SELECT s.bond_id, s.subscription_id, s.subscription_amount, s.status AS subscription_status,
                c.contact_id, c.contact_type, c.tags, c.kyc_status, c.aml_status, c.status AS contact_status
           FROM crm_bond_subscriptions s
           JOIN crm_contacts c ON c.contact_id = s.contact_id
          WHERE s.status IN ('pending', 'active')`
      );
      holders = r.rows;
    }
    const external = holders.filter(h => !isAllowedHolder(h));
    const unverified = holders.filter(h => h.kyc_status !== 'verified');
    const amlFlagged = holders.filter(h => h.aml_status && h.aml_status !== 'clear');
    if (external.length) issues.push(`${external.length} holder(s) outside trust/family (contact_type not in ${ALLOWED_HOLDER_TYPES.join('/')}): ${external.map(h => h.contact_id).join(', ')}`);
    if (unverified.length) issues.push(`${unverified.length} holder(s) without verified KYC: ${unverified.map(h => h.contact_id).join(', ')}`);
    if (amlFlagged.length) issues.push(`${amlFlagged.length} holder(s) AML flagged/blocked: ${amlFlagged.map(h => h.contact_id).join(', ')}`);

    return {
      compliant: issues.length === 0,
      placement: 'private',
      publicOffer: false,
      transferable: false,
      allowedHolderTypes: ALLOWED_HOLDER_TYPES,
      bonds: bonds.length,
      privateBonds: bonds.length - publicBonds.length,
      holders: holders.length,
      holdersByType: holders.reduce((acc, h) => { acc[h.contact_type] = (acc[h.contact_type] || 0) + 1; return acc; }, {}),
      externalHolders: external.length,
      unverifiedHolders: unverified.length,
      issues,
    };
  }

  // ── Trust structure ─────────────────────────────────────────────────────
  // Issuer-holder (the family trust company) holds the bond; trustees administer it
  // and earn a fee inside TRUSTEE_FEE_BAND_PCT; each beneficiary has a hold account
  // (distribution cash account) retained at a fixed balance. Ledger cash only.

  static async trusteeFeePct() {
    const Settings = tryRequire('../ach/systemSettings')?.SystemSettings;
    const v = Settings ? num(await Settings.get(SETTING_TRUSTEE_FEE)) : 0;
    return v || TRUSTEE_FEE_BAND_PCT.min;
  }

  static async trustStructure(bondId) {
    if (!pool) throw new Error('ledger unavailable');
    const reg = await this.holderRegister(bondId);
    const people = await pool.query(
      `SELECT c.contact_id, c.contact_type, c.first_name, c.last_name, c.company, c.kyc_status, c.aml_status, c.tags,
              a.account_id, a.account_name, a.balance_cents, a.status AS account_status
         FROM crm_contacts c LEFT JOIN cash_accounts a ON a.account_id = 'CA-' || c.contact_id
        WHERE c.contact_type IN ('trustee', 'beneficiary') AND c.status = 'active' ORDER BY c.contact_type, c.id`);
    const feePct = await this.trusteeFeePct();
    const fee = await pool.query(`SELECT account_id, balance_cents FROM cash_accounts WHERE account_type = 'fee' AND status = 'active' ORDER BY id LIMIT 1`);
    const row = r => ({
      contactId: r.contact_id, name: `${r.first_name} ${r.last_name}`.trim(), kyc: r.kyc_status, aml: r.aml_status,
      holdAccount: r.account_id ? { accountId: r.account_id, balance: num(r.balance_cents) / 100, status: r.account_status } : null,
    });
    return {
      bondId: reg.bondId,
      bondName: reg.bondName,
      issuerHolder: reg.holders.filter(h => h.role === 'trust-company'),
      otherHolders: reg.holders.filter(h => h.role !== 'trust-company'),
      bondValue: reg.totals,
      trustees: people.rows.filter(r => r.contact_type === 'trustee').map(row),
      beneficiaries: people.rows.filter(r => r.contact_type === 'beneficiary').map(r => ({ ...row(r), retainedBalanceTarget: DEFAULT_HOLD_BALANCE })),
      trusteeFee: { pct: feePct, band: TRUSTEE_FEE_BAND_PCT, appliesTo: 'administration, distribution & disbursement', feeAccount: fee.rows[0] ? { accountId: fee.rows[0].account_id, balance: num(fee.rows[0].balance_cents) / 100 } : null },
      basis: 'ledger cash_accounts book balances, not bank funds',
    };
  }

  /**
   * Settle accrued coupon interest to a ledger cash account (the trust company is its own
   * bondholder, so the coupon is booked internally instead of an ACH disbursement):
   * BondEngine.payInterest reduces bond_balances.accrued_interest, CashEngine.deposit credits
   * `toAccountId` (movement_type='deposit', reference BOND-<id>), and a coupon_payments row is
   * written with status 'paid' and no ach_batch_id. Amount defaults to all accrued interest.
   */
  static async recurringCouponConfig() {
    const Settings = tryRequire('../ach/systemSettings')?.SystemSettings;
    const account = Settings ? await Settings.get(SETTING_COUPON_LEDGER_ACCOUNT) : null;
    return { enabled: !!account, ledgerAccountId: account || null, settingKey: SETTING_COUPON_LEDGER_ACCOUNT, scheduler: 'CouponService.scheduleCouponJob (startup + 6h), settles each due coupon_per_period internally' };
  }

  /** Enable (accountId) or disable (null) recurring internal coupon settlement. */
  static async configureRecurringCoupon({ ledgerAccountId, approvedBy }) {
    if (!pool) throw new Error('ledger unavailable');
    const Settings = tryRequire('../ach/systemSettings')?.SystemSettings;
    if (!Settings) throw new Error('SystemSettings unavailable');
    if (ledgerAccountId) {
      const acct = await pool.query(`SELECT account_id FROM cash_accounts WHERE account_id = $1 AND status = 'active'`, [ledgerAccountId]);
      if (!acct.rows[0]) throw new Error(`cash account ${ledgerAccountId} not found or not active`);
    }
    await Settings.ensureTable();
    await Settings.set(SETTING_COUPON_LEDGER_ACCOUNT, ledgerAccountId || '', approvedBy || 'system');
    return this.recurringCouponConfig();
  }

  static async settleCouponToLedger({ bondId, toAccountId, amount, couponDate, approvedBy, dryRun = false }) {
    if (!pool) throw new Error('ledger unavailable');
    if (!toAccountId) throw new Error('toAccountId (ledger cash account) required');
    const Bond = tryRequire('../bonds/bondEngine')?.BondEngine;
    const Cash = tryRequire('../cash/cashEngine')?.CashEngine;
    const Coupon = tryRequire('../bonds/couponService')?.CouponService;
    if (!Bond || !Cash) throw new Error('BondEngine / CashEngine unavailable');
    const reg = await this.holderRegister(bondId);
    const accrued = reg.totals.accruedInterest;
    const pay = Math.round((amount == null ? accrued : num(amount)) * 100) / 100;
    if (pay <= 0) throw new Error('no accrued interest to settle');
    if (pay > accrued + 1e-9) throw new Error(`amount ${pay} exceeds accrued interest ${accrued}`);
    const acct = await pool.query(`SELECT account_id, account_type, balance_cents FROM cash_accounts WHERE account_id = $1 AND status = 'active'`, [toAccountId]);
    if (!acct.rows[0]) throw new Error(`cash account ${toAccountId} not found or not active`);
    couponDate = couponDate || new Date().toISOString().slice(0, 10);
    const couponPaymentId = `CPN-${bondId}-${couponDate.replace(/-/g, '')}-LEDGER`;
    const plan = { bondId, couponPaymentId, couponDate, amount: pay, accruedBefore: accrued, accruedAfter: Math.round((accrued - pay) * 100) / 100, toAccountId, toAccountType: acct.rows[0].account_type, toBalanceBefore: num(acct.rows[0].balance_cents) / 100, basis: 'internal ledger settlement of accrued coupon; no ACH, no bank funds' };
    if (dryRun) return { dryRun: true, ...plan };
    if (Coupon) await Coupon.ensureTable();
    const dup = await pool.query(`SELECT coupon_payment_id FROM coupon_payments WHERE bond_id = $1 AND coupon_date = $2 AND status IN ('paid', 'processing')`, [bondId, couponDate]);
    if (dup.rows.length) throw new Error(`coupon already paid/processing for ${couponDate}: ${dup.rows[0].coupon_payment_id}`);
    await pool.query(`INSERT INTO coupon_payments (coupon_payment_id, bond_id, coupon_date, amount, status, bondholders_paid) VALUES ($1, $2, $3, $4, 'processing', $5)
                      ON CONFLICT (coupon_payment_id) DO UPDATE SET status = 'processing', amount = $4, updated_at = NOW()`, [couponPaymentId, bondId, couponDate, pay, reg.holders.length]);
    try {
      const payResult = await Bond.payInterest(bondId, pay);
      const mov = await Cash.deposit({ toAccountId, amountCents: Math.round(pay * 100), referenceId: `BOND-${bondId}`, memo: `Coupon ${couponDate} ${reg.bondName} settled to ledger (${approvedBy || 'system'})`, initiatedBy: approvedBy || 'system' });
      await pool.query(`UPDATE coupon_payments SET status = 'paid', journal_entry_id = $2, updated_at = NOW() WHERE coupon_payment_id = $1`, [couponPaymentId, mov.movement_id]);
      return { ...plan, accruedAfter: num(payResult.remaining_accrued), movementId: mov.movement_id, status: 'paid' };
    } catch (err) {
      await pool.query(`UPDATE coupon_payments SET status = 'failed', error_message = $2, updated_at = NOW() WHERE coupon_payment_id = $1`, [couponPaymentId, err.message]);
      throw err;
    }
  }

  /**
   * Apply the trust structure:
   *   trustCompany  { contactId?, firstName, lastName, company }  -> sole holder of the bond (tagged trust-company)
   *   trustees      [{ contactId?, firstName, lastName }]
   *   beneficiaries [{ contactId?, firstName, lastName }]         -> hold account 'CA-<contactId>' funded to holdBalance
   *   holdBalance   retained balance per beneficiary (default 250000)
   *   feePct        trustee fee within TRUSTEE_FEE_BAND_PCT, stored as a system setting
   *   fromAccountId ledger cash account funding the hold accounts (and the fee)
   *   settleCoupon  true -> first settle the accrued coupon into fromAccountId (settleCouponToLedger)
   */
  static async applyTrustStructure({ bondId, trustCompany, trustees = [], beneficiaries = [], holdBalance = DEFAULT_HOLD_BALANCE, feePct, fromAccountId, settleCoupon = false, approvedBy, dryRun = false }) {
    if (!pool) throw new Error('ledger unavailable');
    if (!trustCompany) throw new Error('trustCompany required');
    if (!beneficiaries.length) throw new Error('beneficiaries[] required');
    if (!fromAccountId) throw new Error('fromAccountId (funding cash account) required');
    const rate = feePct == null ? await this.trusteeFeePct() : num(feePct);
    if (rate < TRUSTEE_FEE_BAND_PCT.min || rate > TRUSTEE_FEE_BAND_PCT.max) throw new Error(`feePct must be within ${TRUSTEE_FEE_BAND_PCT.min}-${TRUSTEE_FEE_BAND_PCT.max}`);
    const Cash = tryRequire('../cash/cashEngine')?.CashEngine;
    const Crm = tryRequire('../crm/crmEngine')?.CrmEngine;
    const Settings = tryRequire('../ach/systemSettings')?.SystemSettings;
    if (!Cash || !Crm) throw new Error('CashEngine / CrmEngine unavailable');

    // 0. Accrued coupon -> funding account (the trust company is the holder, so this is internal).
    const coupon = settleCoupon ? await this.settleCouponToLedger({ bondId, toAccountId: fromAccountId, approvedBy, dryRun }) : null;

    // 1. Bond register: the trust company is the sole holder.
    const register = await this.registerHolders({
      bondId, approvedBy, dryRun,
      holders: [{ ...trustCompany, contactType: trustCompany.contactType || 'investor', trustCompany: true, sharePct: 100 }],
    });

    // 2. Trustees + beneficiaries exist with the right role, verified KYC, approval.
    const ensure = async (h, contactType) => {
      const existing = await pool.query(`SELECT * FROM crm_contacts`);
      const norm = v => String(v || '').replace(/[^a-z]/gi, '').toLowerCase();
      let c = h.contactId ? existing.rows.find(r => r.contact_id === h.contactId) : null;
      if (!c) c = existing.rows.find(r => norm(r.first_name) === norm(h.firstName) && norm(r.last_name) === norm(h.lastName) && (r.contact_type === contactType || !existing.rows.some(o => o.contact_type === contactType && norm(o.first_name) === norm(h.firstName) && norm(o.last_name) === norm(h.lastName))));
      if (dryRun) return { contactId: c?.contact_id || null, create: !c, retype: c ? c.contact_type !== contactType : false, name: `${h.firstName} ${h.lastName}` };
      if (!c) c = await Crm.createContact({ contactType, firstName: h.firstName, lastName: h.lastName, email: h.email, notes: `trust structure (${approvedBy || 'system'})` });
      else if (c.contact_type !== contactType) await pool.query(`UPDATE crm_contacts SET contact_type = $2, updated_at = NOW() WHERE contact_id = $1`, [c.contact_id, contactType]);
      if (c.kyc_status !== 'verified') await Crm.updateKycStatus(c.contact_id, 'verified');
      if ('approval_status' in c && c.approval_status !== 'approved') await Crm.approveContact(c.contact_id, approvedBy || 'system');
      return { contactId: c.contact_id, name: `${h.firstName} ${h.lastName}` };
    };
    const trusteeRows = [];
    for (const t of trustees) trusteeRows.push(await ensure(t, 'trustee'));
    const beneficiaryRows = [];
    for (const b of beneficiaries) beneficiaryRows.push(await ensure(b, 'beneficiary'));

    // 3. Hold accounts funded to the retained balance from the ledger funding account.
    const targetCents = Math.round(num(holdBalance) * 100);
    const funding = [];
    for (const b of beneficiaryRows) {
      const accountId = b.contactId ? `CA-${b.contactId}` : null;
      const acct = accountId ? await pool.query(`SELECT account_id, balance_cents, status FROM cash_accounts WHERE account_id = $1`, [accountId]) : { rows: [] };
      const current = acct.rows[0] ? num(acct.rows[0].balance_cents) : 0;
      const topUp = Math.max(0, targetCents - current);
      funding.push({ beneficiary: b.name, contactId: b.contactId, accountId, createAccount: !acct.rows[0], currentBalance: current / 100, topUp: topUp / 100 });
      if (dryRun || !topUp) continue;
      if (!acct.rows[0]) await Cash.createAccount({ accountId, accountName: `${b.name} Hold Account`, accountType: 'distribution', notes: `Beneficiary hold account for ${b.contactId}` });
      const mov = await Cash.transfer({ fromAccountId, toAccountId: accountId, amountCents: topUp, movementType: 'distribution', referenceId: `BOND-${bondId}`, referenceType: 'trust_structure', memo: `Beneficiary hold account retained balance ${holdBalance} (${approvedBy || 'system'})`, initiatedBy: approvedBy || 'system' });
      funding[funding.length - 1].movementId = mov.movement_id;
    }

    // 4. Trustee fee on the distributions just made, to the fee account.
    const distributed = funding.reduce((t, f) => t + Math.round(f.topUp * 100), 0);
    const feeCents = Math.round(distributed * rate / 100);
    const feeAcct = await pool.query(`SELECT account_id FROM cash_accounts WHERE account_type = 'fee' AND status = 'active' ORDER BY id LIMIT 1`);
    let feeMovement = null;
    if (!dryRun) {
      if (Settings) await Settings.set(SETTING_TRUSTEE_FEE, rate, approvedBy || 'system');
      if (feeCents > 0 && feeAcct.rows[0]) {
        const mov = await Cash.transfer({ fromAccountId, toAccountId: feeAcct.rows[0].account_id, amountCents: feeCents, movementType: 'fee', referenceId: `BOND-${bondId}`, referenceType: 'trustee_fee', memo: `Trustee administration/distribution fee ${rate}% on ${distributed / 100} (${approvedBy || 'system'})`, initiatedBy: approvedBy || 'system' });
        feeMovement = mov.movement_id;
      }
    }

    return {
      dryRun, bondId, coupon, register,
      trustees: trusteeRows, beneficiaries: beneficiaryRows,
      holdBalance: num(holdBalance), funding, fundedFrom: fromAccountId,
      trusteeFee: { pct: rate, band: TRUSTEE_FEE_BAND_PCT, onDistributed: distributed / 100, amount: feeCents / 100, feeAccount: feeAcct.rows[0]?.account_id || null, movementId: feeMovement },
      structure: dryRun ? null : await this.trustStructure(bondId),
    };
  }

  // ── Schedule ────────────────────────────────────────────────────────────

  static async schedule(days = 90) {
    const horizon = Number(days) || 90;
    const now = Date.now();
    const end = now + horizon * DAY_MS;
    const { bonds } = await this.obligations();
    const events = [];
    for (const b of bonds) {
      if (b.error || b.status !== 'active') continue;
      // roll coupons forward from next_coupon_date across the window
      const step = Math.round(365 / periodsPerYear(b.paymentFreq)) * DAY_MS;
      let t = b.nextCouponDate ? new Date(b.nextCouponDate).getTime() : NaN;
      while (Number.isFinite(t) && t <= end) {
        if (t >= now - DAY_MS) events.push({ bondId: b.bondId, bondName: b.bondName, type: 'coupon', date: new Date(t).toISOString().slice(0, 10), amount: b.couponPerPeriod });
        t += step;
      }
      const mat = b.maturityDate ? new Date(b.maturityDate).getTime() : NaN;
      if (Number.isFinite(mat) && mat <= end) {
        events.push({ bondId: b.bondId, bondName: b.bondName, type: 'principal', date: new Date(mat).toISOString().slice(0, 10), amount: b.principalBalance });
      }
    }
    events.sort((a, b) => a.date.localeCompare(b.date));
    return {
      horizonDays: horizon,
      events,
      totals: {
        coupon: events.filter(e => e.type === 'coupon').reduce((s, e) => s + e.amount, 0),
        principal: events.filter(e => e.type === 'principal').reduce((s, e) => s + e.amount, 0),
        total: events.reduce((s, e) => s + e.amount, 0),
      },
      generatedAt: new Date().toISOString(),
    };
  }

  // ── Status ──────────────────────────────────────────────────────────────

  static async status() {
    const [obligations, compliance, schedule, recurring] = await Promise.all([
      settle(() => this.obligations()), settle(() => this.placementCompliance()), settle(() => this.schedule(90)),
      settle(() => this.recurringCouponConfig()),
    ]);
    return {
      engine: 'debt',
      healthy: obligations.ok && compliance.ok,
      mode: compliance.ok && compliance.value.compliant ? 'live' : 'shadow',
      obligations: obligations.ok ? obligations.value : { error: obligations.error },
      compliance: compliance.ok ? compliance.value : { error: compliance.error },
      schedule90d: schedule.ok ? schedule.value : { error: schedule.error },
      recurringCoupon: recurring.ok ? recurring.value : { error: recurring.error },
      timestamp: new Date().toISOString(),
    };
  }
}

module.exports = { DebtOsEngine };
