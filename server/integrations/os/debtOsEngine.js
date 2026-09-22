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

// Only these CRM contact types may hold the private-placement bond.
const ALLOWED_HOLDER_TYPES = ['trustee', 'beneficiary'];

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
              c.contact_type, c.first_name, c.last_name, c.kyc_status, c.aml_status, c.fineract_client_id
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
        role: r.contact_type,
        allowed: ALLOWED_HOLDER_TYPES.includes(r.contact_type),
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
      if (!ALLOWED_HOLDER_TYPES.includes(h.contactType)) throw new Error(`holder ${h.firstName} ${h.lastName}: contactType must be one of ${ALLOWED_HOLDER_TYPES.join('/')}`);
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
      if (!c) c = existing.rows.find(r => r.contact_type === h.contactType && norm(r.first_name) === norm(h.firstName) && norm(r.last_name) === norm(h.lastName));
      const amount = Math.round((h.amount != null ? num(h.amount) : total * num(h.sharePct) / 100) * 100) / 100;
      plan.push({ holder: h, contact: c || null, create: !c, amount });
    }
    const superseded = reg.holders.map(x => x.subscriptionId);
    if (dryRun) return { dryRun: true, bondId, total, superseded, plan: plan.map(p => ({ name: `${p.holder.firstName} ${p.holder.lastName}`, role: p.holder.contactType, contactId: p.contact?.contact_id || null, create: p.create, amount: p.amount })) };

    const created = [];
    for (const p of plan) {
      if (p.create) {
        const c = await Crm.createContact({ contactType: p.holder.contactType, firstName: p.holder.firstName, lastName: p.holder.lastName, email: p.holder.email, notes: `private-placement holder (registered by ${approvedBy || 'system'})` });
        p.contact = c; created.push(c.contact_id);
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
                c.contact_id, c.contact_type, c.kyc_status, c.aml_status, c.status AS contact_status
           FROM crm_bond_subscriptions s
           JOIN crm_contacts c ON c.contact_id = s.contact_id
          WHERE s.status IN ('pending', 'active')`
      );
      holders = r.rows;
    }
    const external = holders.filter(h => !ALLOWED_HOLDER_TYPES.includes(h.contact_type));
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
    const [obligations, compliance, schedule] = await Promise.all([
      settle(() => this.obligations()), settle(() => this.placementCompliance()), settle(() => this.schedule(90)),
    ]);
    return {
      engine: 'debt',
      healthy: obligations.ok && compliance.ok,
      mode: compliance.ok && compliance.value.compliant ? 'live' : 'shadow',
      obligations: obligations.ok ? obligations.value : { error: obligations.error },
      compliance: compliance.ok ? compliance.value : { error: compliance.error },
      schedule90d: schedule.ok ? schedule.value : { error: schedule.error },
      timestamp: new Date().toISOString(),
    };
  }
}

module.exports = { DebtOsEngine };
