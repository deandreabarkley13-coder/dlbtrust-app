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

const DAY_MS = 86400000;
const num = v => Number(v) || 0;

function periodsPerYear(freq) {
  return { monthly: 12, quarterly: 4, 'semi-annual': 2, annual: 1 }[freq] || 12;
}

class DebtOsEngine {
  static get engineName() { return 'debt'; }
  static get TABLES() { return TABLES; }
  static get ALLOWED_HOLDER_TYPES() { return ALLOWED_HOLDER_TYPES; }

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
    const bonds = await this.listBonds();
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
