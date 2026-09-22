'use strict';

/**
 * Liquidity OS Engine — can the trust meet the bond's coupon and principal
 * calls from cash it actually controls?
 *
 *   cashPosition()   ledger cash by account type (operating / reserve / distribution /
 *                    bond_proceeds / escrow / fee) — book balances, not bank balances
 *   coverage()       cash vs Debt OS schedule at 30 / 90 / 365 days, reserve tier vs
 *                    annual coupon, and whether any funded real-value source exists
 *                    (CreditOsEngine.fundingSources) to actually pay a coupon out
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

function tryRequire(mod) {
  try { return require(mod); } catch (e) { return null; }
}

async function settle(fn) {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: e.message }; }
}

const TABLES = ['cash_accounts', 'cash_movements', 'bonds', 'bond_balances', 'coupon_payments'];
const HORIZONS = [30, 90, 365];

// Accounts the trust may draw on for debt service; distribution/fee/escrow are earmarked.
const LIQUID_TYPES = ['operating', 'reserve', 'bond_proceeds'];

const ratio = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 1000 : null);

class LiquidityOsEngine {
  static get engineName() { return 'liquidity'; }
  static get TABLES() { return TABLES; }

  static async cashPosition() {
    const Cash = tryRequire('../cash/cashEngine')?.CashEngine;
    if (!Cash || !pool) throw new Error('CashEngine / ledger unavailable');
    const s = await Cash.getPositionSummary();
    const byType = {};
    for (const [type, v] of Object.entries(s.by_type || {})) byType[type] = v.total_cents / 100;
    const liquid = LIQUID_TYPES.reduce((sum, t) => sum + (byType[t] || 0), 0);
    return {
      basis: 'ledger book balances (cash_accounts) — not bank-confirmed funds',
      byType,
      total: s.grand_total_dollars,
      liquid,
      liquidTypes: LIQUID_TYPES,
      reserve: byType.reserve || 0,
      generatedAt: s.generated_at,
    };
  }

  static async coverage() {
    const Debt = tryRequire('./debtOsEngine')?.DebtOsEngine;
    const Credit = tryRequire('./creditOsEngine')?.CreditOsEngine;
    const cash = await settle(() => this.cashPosition());
    const obligations = Debt ? await settle(() => Debt.obligations()) : { ok: false, error: 'DebtOsEngine unavailable' };
    const funding = Credit ? await settle(() => Credit.fundingSources()) : { ok: false, error: 'CreditOsEngine unavailable' };

    const horizons = {};
    for (const days of HORIZONS) {
      const sched = Debt ? await settle(() => Debt.schedule(days)) : { ok: false, error: 'DebtOsEngine unavailable' };
      const due = sched.ok ? sched.value.totals.total : null;
      const liquid = cash.ok ? cash.value.liquid : null;
      horizons[`${days}d`] = {
        due,
        coupon: sched.ok ? sched.value.totals.coupon : null,
        principal: sched.ok ? sched.value.totals.principal : null,
        liquidCash: liquid,
        coverageRatio: due === null || liquid === null ? null : (due === 0 ? Infinity : ratio(liquid, due)),
        covered: due !== null && liquid !== null && liquid >= due,
        shortfall: due !== null && liquid !== null ? Math.max(0, due - liquid) : null,
        error: sched.ok ? undefined : sched.error,
      };
    }

    const annualCoupon = obligations.ok ? obligations.value.totals.annualCoupon : null;
    const reserve = cash.ok ? cash.value.reserve : null;
    const issues = [];
    if (!cash.ok) issues.push(`cash position: ${cash.error}`);
    if (!obligations.ok) issues.push(`debt obligations: ${obligations.error}`);
    for (const [h, v] of Object.entries(horizons)) {
      if (v.error) issues.push(`${h} schedule: ${v.error}`);
      else if (!v.covered) issues.push(`${h} debt service ${v.due} exceeds liquid cash ${v.liquidCash} (shortfall ${v.shortfall})`);
    }
    const reserveCoverage = annualCoupon !== null && reserve !== null ? ratio(reserve, annualCoupon) : null;
    if (reserveCoverage !== null && annualCoupon > 0 && reserveCoverage < 1) issues.push(`reserve ${reserve} covers ${reserveCoverage}x of annual coupon ${annualCoupon} (target >= 1x)`);
    const payable = funding.ok && funding.value.anyRealValueCapable;
    if (funding.ok && !payable) issues.push('no funded real-value source to pay coupons out (see credit engine)');
    else if (!funding.ok) issues.push(`funding sources: ${funding.error}`);

    return {
      adequate: issues.length === 0,
      cash: cash.ok ? cash.value : { error: cash.error },
      horizons,
      reserve: { balance: reserve, annualCoupon, coverage: reserveCoverage, target: 1 },
      payout: { realValueCapable: Boolean(payable), sources: funding.ok ? funding.value.realValueCapable : [] },
      issues,
      generatedAt: new Date().toISOString(),
    };
  }

  static async status() {
    const c = await settle(() => this.coverage());
    return {
      engine: 'liquidity',
      healthy: c.ok,
      mode: c.ok && c.value.adequate ? 'live' : 'shadow',
      coverage: c.ok ? c.value : { error: c.error },
      timestamp: new Date().toISOString(),
    };
  }
}

module.exports = { LiquidityOsEngine };
