/**
 * Live Bond Engine — Real-Time Fixed Income Analytics
 *
 * Wraps BondEngine with live pricing, duration, yield, and accrual calculations.
 * DLB-PRB: $100M face, 1% coupon, 30/360, monthly pay, 100-year term.
 *
 * All storage via the shared PostgreSQL pool (fineract_tenants).
 */

'use strict';

const pool = require('./pgPool');
const { BondEngine } = require('./bondEngine');

// ─── Frequency helpers ────────────────────────────────────────────────────────

function freqPerYear(paymentFreq) {
  switch ((paymentFreq || 'monthly').toLowerCase()) {
    case 'monthly':     return 12;
    case 'quarterly':   return 4;
    case 'semi-annual': return 2;
    case 'annual':      return 1;
    default:            return 12;
  }
}

// ─── LiveBondEngine ───────────────────────────────────────────────────────────

class LiveBondEngine {

  static calcDaysToMaturity(maturityDate) {
    const now = new Date();
    const mat = new Date(maturityDate);
    const msPerDay = 86400000;
    return Math.max(0, Math.ceil((mat.getTime() - now.getTime()) / msPerDay));
  }

  static calcAccruedInterestLive(bond) {
    const principal = parseFloat(bond.principal_balance);
    const couponRate = parseFloat(bond.coupon_rate);
    const lastAccrual = new Date(bond.last_accrual_date);
    const now = new Date();

    const d1 = lastAccrual;
    const d2 = now;
    let y1 = d1.getFullYear(), m1 = d1.getMonth() + 1, day1 = Math.min(d1.getDate(), 30);
    let y2 = d2.getFullYear(), m2 = d2.getMonth() + 1, day2 = Math.min(d2.getDate(), 30);
    const daysSince = Math.max(0, (y2 - y1) * 360 + (m2 - m1) * 30 + (day2 - day1));

    return principal * (couponRate / 360) * daysSince;
  }

  /**
   * Newton-Raphson YTM solver.
   * marketPrice as decimal (1.0 = par).
   */
  static calcYieldToMaturity(bond, marketPrice) {
    const faceValue = parseFloat(bond.face_value);
    const couponRate = parseFloat(bond.coupon_rate);
    const freq = freqPerYear(bond.payment_freq);
    const couponPayment = (faceValue * couponRate) / freq;

    const matDate = new Date(bond.maturity_date);
    const now = new Date();
    const yearsToMat = Math.max(0, (matDate.getTime() - now.getTime()) / (365.25 * 86400000));
    const n = Math.max(1, Math.round(yearsToMat * freq));

    const price = marketPrice * faceValue;

    let ytm = couponRate; // initial guess
    const tolerance = 1e-8;
    const maxIter = 100;

    for (let i = 0; i < maxIter; i++) {
      const r = ytm / freq;
      if (r === 0) { ytm = 0.0001; continue; }

      let pv = 0;
      let dpv = 0;
      for (let t = 1; t <= n; t++) {
        const df = Math.pow(1 + r, t);
        pv += couponPayment / df;
        dpv += (-t * couponPayment) / (df * (1 + r)) / freq;
      }
      const dfn = Math.pow(1 + r, n);
      pv += faceValue / dfn;
      dpv += (-n * faceValue) / (dfn * (1 + r)) / freq;

      const diff = pv - price;
      if (Math.abs(diff) < tolerance) break;

      const step = diff / dpv;
      ytm -= step;
      if (ytm <= 0) ytm = 0.0001;
    }

    return ytm;
  }

  static calcMacaulayDuration(bond) {
    const faceValue = parseFloat(bond.face_value);
    const couponRate = parseFloat(bond.coupon_rate);
    const freq = freqPerYear(bond.payment_freq);
    const couponPayment = (faceValue * couponRate) / freq;
    const ytm = couponRate; // assume par pricing

    const matDate = new Date(bond.maturity_date);
    const now = new Date();
    const yearsToMat = Math.max(0, (matDate.getTime() - now.getTime()) / (365.25 * 86400000));
    const n = Math.max(1, Math.round(yearsToMat * freq));

    const r = ytm / freq;
    if (r === 0) return yearsToMat;

    let weightedPV = 0;
    let totalPV = 0;
    for (let t = 1; t <= n; t++) {
      const df = Math.pow(1 + r, t);
      const pv = couponPayment / df;
      weightedPV += (t / freq) * pv;
      totalPV += pv;
    }
    const dfn = Math.pow(1 + r, n);
    const pvPrincipal = faceValue / dfn;
    weightedPV += (n / freq) * pvPrincipal;
    totalPV += pvPrincipal;

    return totalPV > 0 ? weightedPV / totalPV : 0;
  }

  static calcModifiedDuration(bond, ytm) {
    const macDuration = LiveBondEngine.calcMacaulayDuration(bond);
    const freq = freqPerYear(bond.payment_freq);
    return macDuration / (1 + ytm / freq);
  }

  static calcDV01(bond, modDuration, marketValue) {
    return modDuration * marketValue * 0.0001;
  }

  static calcCurrentPrice(bond, marketYield) {
    const faceValue = parseFloat(bond.face_value);
    const couponRate = parseFloat(bond.coupon_rate);
    const freq = freqPerYear(bond.payment_freq);
    const couponPayment = (faceValue * couponRate) / freq;

    const matDate = new Date(bond.maturity_date);
    const now = new Date();
    const yearsToMat = Math.max(0, (matDate.getTime() - now.getTime()) / (365.25 * 86400000));
    const n = Math.max(1, Math.round(yearsToMat * freq));

    const r = marketYield / freq;
    if (r === 0) return 1.0;

    let pv = 0;
    for (let t = 1; t <= n; t++) {
      pv += couponPayment / Math.pow(1 + r, t);
    }
    pv += faceValue / Math.pow(1 + r, n);

    return pv / faceValue;
  }

  static calcNextCouponDate(bond) {
    const freq = freqPerYear(bond.payment_freq);
    const monthsPerPeriod = 12 / freq;
    const issueDate = new Date(bond.issue_date);
    const now = new Date();

    let next = new Date(issueDate);
    while (next <= now) {
      next.setMonth(next.getMonth() + monthsPerPeriod);
    }
    return next;
  }

  static calcDailyAccrual(bond) {
    const principal = parseFloat(bond.principal_balance);
    const couponRate = parseFloat(bond.coupon_rate);
    return Math.round(principal * (couponRate / 360) * 100) / 100;
  }

  static calcDaysSinceLastAccrual(bond) {
    const last = new Date(bond.last_accrual_date);
    const now = new Date();
    const d1 = last, d2 = now;
    let y1 = d1.getFullYear(), m1 = d1.getMonth() + 1, day1 = Math.min(d1.getDate(), 30);
    let y2 = d2.getFullYear(), m2 = d2.getMonth() + 1, day2 = Math.min(d2.getDate(), 30);
    return Math.max(0, (y2 - y1) * 360 + (m2 - m1) * 30 + (day2 - day1));
  }

  static async getBondLiveMetrics(bondId, marketYield) {
    const bond = await BondEngine.getBond(bondId);
    if (!bond) throw new Error(`Bond ${bondId} not found`);

    const couponRate = parseFloat(bond.coupon_rate);
    const faceValue = parseFloat(bond.face_value);
    const principalBalance = parseFloat(bond.principal_balance);
    const dbAccrued = parseFloat(bond.accrued_interest);
    const yield_ = marketYield !== undefined ? parseFloat(marketYield) : couponRate;

    const daysToMat = LiveBondEngine.calcDaysToMaturity(bond.maturity_date);
    const yearsToMat = daysToMat / 365.25;
    const accruedLive = LiveBondEngine.calcAccruedInterestLive(bond);
    const totalAccrued = dbAccrued + accruedLive;
    const ytm = LiveBondEngine.calcYieldToMaturity(bond, 1.0);
    const macDuration = LiveBondEngine.calcMacaulayDuration(bond);
    const modDuration = LiveBondEngine.calcModifiedDuration(bond, ytm);
    const currentPrice = LiveBondEngine.calcCurrentPrice(bond, yield_);
    const marketValue = currentPrice * faceValue;
    const dv01 = LiveBondEngine.calcDV01(bond, modDuration, marketValue);
    const dailyAccrual = LiveBondEngine.calcDailyAccrual(bond);
    const nextCouponDate = LiveBondEngine.calcNextCouponDate(bond);
    const daysSinceAccrual = LiveBondEngine.calcDaysSinceLastAccrual(bond);
    const freq = freqPerYear(bond.payment_freq);
    const annualCouponIncome = principalBalance * couponRate;
    const couponPerPeriod = Math.round(annualCouponIncome / freq * 100) / 100;
    const currentYield = marketValue > 0 ? (annualCouponIncome / marketValue) * 100 : 0;

    return {
      bond_id: bond.id,
      bond_name: bond.bond_name,
      bond_identifier: bond.bond_identifier || null,
      isin: bond.isin,
      bond_type: bond.bond_type || 'corporate',
      placement_type: bond.placement_type || 'public',
      tax_exempt: bond.tax_exempt || false,
      tax_exempt_type: bond.tax_exempt_type || null,
      issuer: bond.issuer || null,
      issuer_state: bond.issuer_state || null,
      face_value: faceValue,
      principal_balance: principalBalance,
      coupon_rate_pct: couponRate * 100,
      payment_freq: bond.payment_freq,
      day_count: bond.day_count,
      currency: bond.currency,
      status: bond.status,
      issue_date: bond.issue_date,
      maturity_date: bond.maturity_date,
      days_to_maturity: daysToMat,
      years_to_maturity: Math.round(yearsToMat * 100) / 100,
      // Accrual metrics
      accrued_interest_db: dbAccrued,
      accrued_interest_pending: Math.round(accruedLive * 100) / 100,
      accrued_interest_total: Math.round(totalAccrued * 100) / 100,
      daily_accrual: dailyAccrual,
      days_since_last_accrual: daysSinceAccrual,
      last_accrual_date: bond.last_accrual_date,
      // Coupon schedule
      next_coupon_date: nextCouponDate.toISOString().split('T')[0],
      coupon_per_period: couponPerPeriod,
      annual_coupon_income: Math.round(annualCouponIncome * 100) / 100,
      // Yield & pricing
      ytm_pct: Math.round(ytm * 10000) / 100,
      current_yield_pct: Math.round(currentYield * 100) / 100,
      current_price_decimal: Math.round(currentPrice * 1000000) / 1000000,
      market_value: Math.round(marketValue * 100) / 100,
      // Risk metrics
      macaulay_duration_years: Math.round(macDuration * 100) / 100,
      modified_duration: Math.round(modDuration * 100) / 100,
      dv01: Math.round(dv01 * 100) / 100,
      // Totals
      total_interest_paid: parseFloat(bond.total_interest_paid),
      total_principal_paid: parseFloat(bond.total_principal_paid),
      total_current_value: Math.round((marketValue + totalAccrued) * 100) / 100,
      generated_at: new Date().toISOString(),
    };
  }

  static async getPortfolioSnapshot() {
    const result = await pool.query(
      `SELECT b.id FROM bonds b WHERE b.status = 'active'`
    );

    const metrics = [];
    for (const row of result.rows) {
      try {
        const m = await LiveBondEngine.getBondLiveMetrics(row.id);
        metrics.push(m);
      } catch (err) {
        console.warn(`[LiveEngine] Skip bond ${row.id}: ${err.message}`);
      }
    }

    const totalFace = metrics.reduce((s, m) => s + m.face_value, 0);
    const totalMarket = metrics.reduce((s, m) => s + m.market_value, 0);
    const totalAccrued = metrics.reduce((s, m) => s + m.accrued_interest_total, 0);

    const weightedCoupon = totalFace > 0
      ? metrics.reduce((s, m) => s + (m.coupon_rate_pct / 100) * m.face_value, 0) / totalFace
      : 0;
    const weightedModDuration = totalMarket > 0
      ? metrics.reduce((s, m) => s + m.modified_duration * m.market_value, 0) / totalMarket
      : 0;
    const totalDV01 = metrics.reduce((s, m) => s + m.dv01, 0);

    const totalDailyAccrual = metrics.reduce((s, m) => s + m.daily_accrual, 0);
    const totalAnnualIncome = metrics.reduce((s, m) => s + m.annual_coupon_income, 0);
    const totalCurrentValue = metrics.reduce((s, m) => s + m.total_current_value, 0);
    const weightedYTM = totalMarket > 0
      ? metrics.reduce((s, m) => s + (m.ytm_pct / 100) * m.market_value, 0) / totalMarket
      : 0;

    return {
      bond_count: metrics.length,
      total_face_value: totalFace,
      total_market_value: Math.round(totalMarket * 100) / 100,
      total_accrued_interest: Math.round(totalAccrued * 100) / 100,
      total_current_value: Math.round(totalCurrentValue * 100) / 100,
      total_daily_accrual: Math.round(totalDailyAccrual * 100) / 100,
      total_annual_income: Math.round(totalAnnualIncome * 100) / 100,
      weighted_avg_coupon_pct: Math.round(weightedCoupon * 10000) / 100,
      weighted_avg_ytm_pct: Math.round(weightedYTM * 10000) / 100,
      weighted_avg_modified_duration: Math.round(weightedModDuration * 100) / 100,
      total_dv01: Math.round(totalDV01 * 100) / 100,
      bonds: metrics,
      generated_at: new Date().toISOString(),
    };
  }

  static scheduleAccrualJob() {
    const runAccrual = async () => {
      try {
        const result = await pool.query(
          `SELECT b.id, b.bond_name FROM bonds b WHERE b.status = 'active'`
        );
        for (const bond of result.rows) {
          try {
            const accrualResult = await BondEngine.accrueInterest(bond.id);
            if (accrualResult.accrued > 0) {
              console.log(`[LiveEngine] Accrued bond ${bond.bond_name}: +$${accrualResult.accrued} (${accrualResult.days} days)`);
            }
          } catch (err) {
            console.warn(`[LiveEngine] Accrual failed for ${bond.bond_name}: ${err.message}`);
          }
        }
      } catch (err) {
        console.error('[LiveEngine] Accrual job error:', err.message);
      }
    };

    // Run immediately on startup, then every 24 hours
    setTimeout(runAccrual, 3000);
    setInterval(runAccrual, 24 * 60 * 60 * 1000);
    console.log('[LiveEngine] Daily accrual job scheduled (runs on startup + 24h interval)');
  }
}

module.exports = { LiveBondEngine };
