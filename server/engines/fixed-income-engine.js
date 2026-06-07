/**
 * Fixed Income Calculation Engine
 * DEANDREA LAVAR BARKLEY TRUST — Private Trust Fixed Income Analytics
 *
 * Core financial calculations for bond pricing, yield, duration, and
 * accrued interest with support for multiple day-count conventions.
 */

'use strict';

// ─── Day-Count Conventions ────────────────────────────────────────────────────

function daysInYear(convention) {
  switch (convention) {
    case 'actual/365': return 365;
    case 'actual/360': return 360;
    case '30/360':     return 360;
    case 'actual/actual': return 365.25;
    default: return 360;
  }
}

function daysBetween(d1, d2, convention) {
  const a = new Date(d1);
  const b = new Date(d2);

  if (convention === '30/360') {
    let y1 = a.getFullYear(), m1 = a.getMonth() + 1, day1 = Math.min(a.getDate(), 30);
    let y2 = b.getFullYear(), m2 = b.getMonth() + 1, day2 = Math.min(b.getDate(), 30);
    if (day1 === 31) day1 = 30;
    if (day2 === 31 && day1 >= 30) day2 = 30;
    return 360 * (y2 - y1) + 30 * (m2 - m1) + (day2 - day1);
  }

  // Actual day count for all other conventions
  const msPerDay = 86400000;
  return Math.round((b.getTime() - a.getTime()) / msPerDay);
}

function yearFraction(d1, d2, convention) {
  return daysBetween(d1, d2, convention) / daysInYear(convention);
}

// ─── Coupon Frequency Helpers ─────────────────────────────────────────────────

function periodsPerYear(frequency) {
  switch (frequency) {
    case 'monthly':     return 12;
    case 'quarterly':   return 4;
    case 'semi-annual': return 2;
    case 'annual':      return 1;
    case 'zero':        return 0;
    default:            return 2;
  }
}

function monthsBetweenCoupons(frequency) {
  const ppy = periodsPerYear(frequency);
  return ppy > 0 ? 12 / ppy : 0;
}

// ─── Coupon Schedule Generation ───────────────────────────────────────────────

function generateCouponDates(purchaseDate, maturityDate, frequency) {
  if (frequency === 'zero') return [];

  const months = monthsBetweenCoupons(frequency);
  const dates = [];
  const maturity = new Date(maturityDate);
  const purchase = new Date(purchaseDate);

  // Work backwards from maturity to find first coupon after purchase
  let d = new Date(maturity);
  const allDates = [new Date(d)];
  while (d > purchase) {
    d = new Date(d);
    d.setMonth(d.getMonth() - months);
    if (d > purchase) {
      allDates.unshift(new Date(d));
    }
  }

  return allDates.map(dt => dt.toISOString().split('T')[0]);
}

// ─── Accrued Interest ─────────────────────────────────────────────────────────

function calcAccruedInterest(parValueCents, couponRate, lastCouponDate, settlementDate, convention, frequency) {
  const ppy = periodsPerYear(frequency);
  if (ppy === 0) return 0;

  const couponPayment = (parValueCents * couponRate) / ppy;
  const daysSinceLastCoupon = daysBetween(lastCouponDate, settlementDate, convention);
  const totalDaysInPeriod = daysInYear(convention) / ppy;

  return Math.round(couponPayment * (daysSinceLastCoupon / totalDaysInPeriod));
}

// ─── Current Yield ────────────────────────────────────────────────────────────

function calcCurrentYield(couponRate, parValueCents, marketPriceCents) {
  if (!marketPriceCents || marketPriceCents === 0) return null;
  const annualCoupon = parValueCents * couponRate;
  return annualCoupon / marketPriceCents;
}

// ─── Yield to Maturity (Newton-Raphson) ───────────────────────────────────────

function calcYieldToMaturity(priceCents, parValueCents, couponRate, yearsToMaturity, frequency) {
  const ppy = periodsPerYear(frequency);

  if (ppy === 0) {
    // Zero-coupon bond
    if (priceCents <= 0 || yearsToMaturity <= 0) return null;
    return Math.pow(parValueCents / priceCents, 1 / yearsToMaturity) - 1;
  }

  const n = Math.round(yearsToMaturity * ppy);
  const c = (parValueCents * couponRate) / ppy;
  const fv = parValueCents;
  const price = priceCents;

  // Newton-Raphson iteration
  let ytm = couponRate; // initial guess
  for (let iter = 0; iter < 200; iter++) {
    let pv = 0;
    let dpv = 0;

    for (let t = 1; t <= n; t++) {
      const df = Math.pow(1 + ytm / ppy, -t);
      pv += c * df;
      dpv += -t * c * df / (1 + ytm / ppy) / ppy;
    }
    const dfn = Math.pow(1 + ytm / ppy, -n);
    pv += fv * dfn;
    dpv += -n * fv * dfn / (1 + ytm / ppy) / ppy;

    const diff = pv - price;
    if (Math.abs(diff) < 0.01) return ytm;

    if (Math.abs(dpv) < 1e-12) break;
    ytm = ytm - diff / dpv;

    if (ytm < -0.5 || ytm > 2) break;
  }

  return ytm;
}

// ─── Yield to Call ────────────────────────────────────────────────────────────

function calcYieldToCall(priceCents, callPriceCents, couponRate, parValueCents, yearsToCall, frequency) {
  if (!callPriceCents || yearsToCall <= 0) return null;
  return calcYieldToMaturity(priceCents, callPriceCents, couponRate, yearsToCall, frequency);
}

// ─── Macaulay Duration ────────────────────────────────────────────────────────

function calcMacaulayDuration(priceCents, parValueCents, couponRate, yearsToMaturity, ytm, frequency) {
  const ppy = periodsPerYear(frequency);

  if (ppy === 0) return yearsToMaturity;
  if (!ytm || ytm === 0) return yearsToMaturity;

  const n = Math.round(yearsToMaturity * ppy);
  const c = (parValueCents * couponRate) / ppy;
  const r = ytm / ppy;
  const fv = parValueCents;

  let weightedPV = 0;
  let totalPV = 0;

  for (let t = 1; t <= n; t++) {
    const df = Math.pow(1 + r, -t);
    const period = t / ppy;
    weightedPV += period * c * df;
    totalPV += c * df;
  }

  const dfn = Math.pow(1 + r, -n);
  weightedPV += (n / ppy) * fv * dfn;
  totalPV += fv * dfn;

  return totalPV > 0 ? weightedPV / totalPV : yearsToMaturity;
}

// ─── Modified Duration ────────────────────────────────────────────────────────

function calcModifiedDuration(macaulayDuration, ytm, frequency) {
  const ppy = periodsPerYear(frequency);
  if (ppy === 0) return macaulayDuration;
  return macaulayDuration / (1 + ytm / ppy);
}

// ─── Convexity ────────────────────────────────────────────────────────────────

function calcConvexity(priceCents, parValueCents, couponRate, yearsToMaturity, ytm, frequency) {
  const ppy = periodsPerYear(frequency);
  if (ppy === 0 || !ytm) return 0;

  const n = Math.round(yearsToMaturity * ppy);
  const c = (parValueCents * couponRate) / ppy;
  const r = ytm / ppy;
  const fv = parValueCents;

  let convexity = 0;
  let totalPV = 0;

  for (let t = 1; t <= n; t++) {
    const df = Math.pow(1 + r, -t);
    convexity += t * (t + 1) * c * df;
    totalPV += c * df;
  }

  const dfn = Math.pow(1 + r, -n);
  convexity += n * (n + 1) * fv * dfn;
  totalPV += fv * dfn;

  if (totalPV === 0) return 0;
  return convexity / (totalPV * ppy * ppy * Math.pow(1 + r, 2));
}

// ─── Price from Yield ─────────────────────────────────────────────────────────

function calcPriceFromYield(parValueCents, couponRate, ytm, yearsToMaturity, frequency) {
  const ppy = periodsPerYear(frequency);

  if (ppy === 0) {
    return Math.round(parValueCents / Math.pow(1 + ytm, yearsToMaturity));
  }

  const n = Math.round(yearsToMaturity * ppy);
  const c = (parValueCents * couponRate) / ppy;
  const r = ytm / ppy;

  let pv = 0;
  for (let t = 1; t <= n; t++) {
    pv += c / Math.pow(1 + r, t);
  }
  pv += parValueCents / Math.pow(1 + r, n);

  return Math.round(pv);
}

// ─── Full Bond Analytics ──────────────────────────────────────────────────────

function analyzeBond(holding) {
  const now = new Date();
  const maturity = new Date(holding.maturity_date);
  const yearsToMaturity = (maturity - now) / (365.25 * 86400000);

  if (yearsToMaturity <= 0) {
    return {
      years_to_maturity: 0,
      status: 'matured',
      ytm: null,
      ytc: null,
      current_yield: null,
      macaulay_duration: 0,
      modified_duration: 0,
      convexity: 0,
      accrued_interest_cents: 0,
    };
  }

  const priceCents = holding.market_value_cents || holding.purchase_price_cents;
  const ytm = calcYieldToMaturity(
    priceCents, holding.par_value_cents, holding.coupon_rate,
    yearsToMaturity, holding.coupon_frequency
  );

  let ytc = null;
  if (holding.call_date) {
    const callDate = new Date(holding.call_date);
    const yearsToCall = (callDate - now) / (365.25 * 86400000);
    if (yearsToCall > 0) {
      ytc = calcYieldToCall(
        priceCents, holding.call_price_cents || holding.par_value_cents,
        holding.coupon_rate, holding.par_value_cents, yearsToCall, holding.coupon_frequency
      );
    }
  }

  const macDuration = calcMacaulayDuration(
    priceCents, holding.par_value_cents, holding.coupon_rate,
    yearsToMaturity, ytm, holding.coupon_frequency
  );

  const modDuration = calcModifiedDuration(macDuration, ytm, holding.coupon_frequency);

  const convexity = calcConvexity(
    priceCents, holding.par_value_cents, holding.coupon_rate,
    yearsToMaturity, ytm, holding.coupon_frequency
  );

  const currentYield = calcCurrentYield(
    holding.coupon_rate, holding.par_value_cents, priceCents
  );

  // Accrued interest
  const couponDates = generateCouponDates(
    holding.purchase_date, holding.maturity_date, holding.coupon_frequency
  );
  let accruedInterest = 0;
  if (couponDates.length > 0) {
    const todayStr = now.toISOString().split('T')[0];
    const pastCoupons = couponDates.filter(d => d <= todayStr);
    const lastCoupon = pastCoupons.length > 0
      ? pastCoupons[pastCoupons.length - 1]
      : holding.purchase_date;
    accruedInterest = calcAccruedInterest(
      holding.par_value_cents, holding.coupon_rate,
      lastCoupon, todayStr, holding.day_count_convention, holding.coupon_frequency
    );
  }

  return {
    years_to_maturity: Math.round(yearsToMaturity * 100) / 100,
    ytm: ytm !== null ? Math.round(ytm * 10000) / 10000 : null,
    ytc: ytc !== null ? Math.round(ytc * 10000) / 10000 : null,
    yield_to_worst: ytc !== null && ytm !== null ? Math.min(ytm, ytc) : ytm,
    current_yield: currentYield !== null ? Math.round(currentYield * 10000) / 10000 : null,
    macaulay_duration: Math.round(macDuration * 100) / 100,
    modified_duration: Math.round(modDuration * 100) / 100,
    convexity: Math.round(convexity * 100) / 100,
    accrued_interest_cents: accruedInterest,
    accrued_interest_usd: Math.round(accruedInterest) / 100,
    coupon_dates: couponDates,
    next_coupon_date: couponDates.find(d => d > now.toISOString().split('T')[0]) || null,
    price_cents: priceCents,
    price_per_100: holding.par_value_cents > 0
      ? Math.round((priceCents / holding.par_value_cents) * 10000) / 100
      : null,
  };
}

// ─── Portfolio-Level Analytics ─────────────────────────────────────────────────

function analyzePortfolio(holdings) {
  if (!holdings || holdings.length === 0) {
    return {
      total_par_cents: 0,
      total_market_cents: 0,
      total_book_cents: 0,
      total_accrued_interest_cents: 0,
      weighted_avg_ytm: null,
      weighted_avg_duration: null,
      weighted_avg_convexity: null,
      weighted_avg_coupon: null,
      weighted_avg_maturity_years: null,
      holding_count: 0,
      by_type: {},
      by_rating: {},
      by_sector: {},
      by_tax_status: {},
    };
  }

  let totalPar = 0;
  let totalMarket = 0;
  let totalBook = 0;
  let totalAccrued = 0;
  let weightedYTM = 0;
  let weightedDuration = 0;
  let weightedConvexity = 0;
  let weightedCoupon = 0;
  let weightedMaturity = 0;

  const byType = {};
  const byRating = {};
  const bySector = {};
  const byTaxStatus = {};

  for (const h of holdings) {
    if (h.status !== 'active') continue;

    const analytics = analyzeBond(h);
    const mv = h.market_value_cents || h.purchase_price_cents;
    const bv = h.book_value_cents || h.purchase_price_cents;

    totalPar += h.par_value_cents;
    totalMarket += mv;
    totalBook += bv;
    totalAccrued += analytics.accrued_interest_cents;

    weightedYTM += (analytics.ytm || 0) * mv;
    weightedDuration += analytics.macaulay_duration * mv;
    weightedConvexity += analytics.convexity * mv;
    weightedCoupon += h.coupon_rate * mv;
    weightedMaturity += analytics.years_to_maturity * mv;

    // Aggregations
    const type = h.security_type || 'other';
    byType[type] = byType[type] || { count: 0, par_cents: 0, market_cents: 0 };
    byType[type].count++;
    byType[type].par_cents += h.par_value_cents;
    byType[type].market_cents += mv;

    const rating = h.credit_rating || 'NR';
    byRating[rating] = byRating[rating] || { count: 0, par_cents: 0, market_cents: 0 };
    byRating[rating].count++;
    byRating[rating].par_cents += h.par_value_cents;
    byRating[rating].market_cents += mv;

    const sector = h.sector || 'General';
    bySector[sector] = bySector[sector] || { count: 0, par_cents: 0, market_cents: 0 };
    bySector[sector].count++;
    bySector[sector].par_cents += h.par_value_cents;
    bySector[sector].market_cents += mv;

    const tax = h.tax_status || 'taxable';
    byTaxStatus[tax] = byTaxStatus[tax] || { count: 0, par_cents: 0, market_cents: 0 };
    byTaxStatus[tax].count++;
    byTaxStatus[tax].par_cents += h.par_value_cents;
    byTaxStatus[tax].market_cents += mv;
  }

  // Add percentages to breakdowns
  for (const group of [byType, byRating, bySector, byTaxStatus]) {
    for (const key of Object.keys(group)) {
      group[key].pct_of_portfolio = totalMarket > 0
        ? Math.round((group[key].market_cents / totalMarket) * 10000) / 100
        : 0;
      group[key].market_usd = Math.round(group[key].market_cents) / 100;
      group[key].par_usd = Math.round(group[key].par_cents) / 100;
    }
  }

  return {
    total_par_cents: totalPar,
    total_par_usd: Math.round(totalPar) / 100,
    total_market_cents: totalMarket,
    total_market_usd: Math.round(totalMarket) / 100,
    total_book_cents: totalBook,
    total_book_usd: Math.round(totalBook) / 100,
    total_accrued_interest_cents: totalAccrued,
    total_accrued_interest_usd: Math.round(totalAccrued) / 100,
    weighted_avg_ytm: totalMarket > 0 ? Math.round((weightedYTM / totalMarket) * 10000) / 10000 : null,
    weighted_avg_duration: totalMarket > 0 ? Math.round((weightedDuration / totalMarket) * 100) / 100 : null,
    weighted_avg_convexity: totalMarket > 0 ? Math.round((weightedConvexity / totalMarket) * 100) / 100 : null,
    weighted_avg_coupon: totalMarket > 0 ? Math.round((weightedCoupon / totalMarket) * 10000) / 10000 : null,
    weighted_avg_maturity_years: totalMarket > 0 ? Math.round((weightedMaturity / totalMarket) * 100) / 100 : null,
    holding_count: holdings.filter(h => h.status === 'active').length,
    by_type: byType,
    by_rating: byRating,
    by_sector: bySector,
    by_tax_status: byTaxStatus,
  };
}

module.exports = {
  daysInYear,
  daysBetween,
  yearFraction,
  periodsPerYear,
  monthsBetweenCoupons,
  generateCouponDates,
  calcAccruedInterest,
  calcCurrentYield,
  calcYieldToMaturity,
  calcYieldToCall,
  calcMacaulayDuration,
  calcModifiedDuration,
  calcConvexity,
  calcPriceFromYield,
  analyzeBond,
  analyzePortfolio,
};
