/**
 * Cash Flow Projection Engine
 * DEANDREA LAVAR BARKLEY TRUST — Fixed Income Cash Flow Forecasting
 *
 * Projects future cash flows from the fixed income portfolio:
 * coupon income, maturities, calls, and reinvestment proceeds.
 */

'use strict';

const { generateCouponDates, periodsPerYear } = require('./fixed-income-engine');

// ─── Project Cash Flows for a Single Holding ──────────────────────────────────

function projectHoldingCashFlows(holding) {
  const flows = [];
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  if (holding.status !== 'active') return flows;

  const ppy = periodsPerYear(holding.coupon_frequency);

  // Coupon payments
  if (ppy > 0) {
    const couponDates = generateCouponDates(
      holding.purchase_date, holding.maturity_date, holding.coupon_frequency
    );
    const couponAmountCents = Math.round((holding.par_value_cents * holding.coupon_rate) / ppy);

    for (const date of couponDates) {
      if (date > todayStr) {
        flows.push({
          holding_id: holding.id,
          security_name: holding.security_name,
          flow_type: 'coupon',
          flow_date: date,
          amount_cents: couponAmountCents,
          amount_usd: Math.round(couponAmountCents) / 100,
          projected: true,
        });
      }
    }
  }

  // Maturity principal return
  if (holding.maturity_date > todayStr) {
    flows.push({
      holding_id: holding.id,
      security_name: holding.security_name,
      flow_type: 'maturity',
      flow_date: holding.maturity_date,
      amount_cents: holding.par_value_cents,
      amount_usd: Math.round(holding.par_value_cents) / 100,
      projected: true,
    });
  }

  // Potential call (if callable and before maturity)
  if (holding.call_date && holding.call_date > todayStr && holding.call_date < holding.maturity_date) {
    const callAmount = holding.call_price_cents || holding.par_value_cents;
    flows.push({
      holding_id: holding.id,
      security_name: holding.security_name,
      flow_type: 'call',
      flow_date: holding.call_date,
      amount_cents: callAmount,
      amount_usd: Math.round(callAmount) / 100,
      projected: true,
      note: 'Potential call — may or may not be exercised',
    });
  }

  return flows;
}

// ─── Project Cash Flows for Entire Portfolio ──────────────────────────────────

function projectPortfolioCashFlows(holdings, options = {}) {
  const {
    horizon_months = 60,
    include_calls = true,
    group_by = 'month',
  } = options;

  const now = new Date();
  const horizonDate = new Date(now);
  horizonDate.setMonth(horizonDate.getMonth() + horizon_months);
  const horizonStr = horizonDate.toISOString().split('T')[0];

  let allFlows = [];

  for (const h of holdings) {
    const flows = projectHoldingCashFlows(h);
    for (const f of flows) {
      if (f.flow_date <= horizonStr) {
        if (!include_calls && f.flow_type === 'call') continue;
        allFlows.push(f);
      }
    }
  }

  // Sort by date
  allFlows.sort((a, b) => a.flow_date.localeCompare(b.flow_date));

  // Group if requested
  if (group_by === 'month' || group_by === 'quarter' || group_by === 'year') {
    return groupCashFlows(allFlows, group_by);
  }

  return {
    flows: allFlows,
    summary: summarizeCashFlows(allFlows),
  };
}

// ─── Group Cash Flows ─────────────────────────────────────────────────────────

function groupCashFlows(flows, groupBy) {
  const groups = {};

  for (const f of flows) {
    let key;
    const d = new Date(f.flow_date);

    switch (groupBy) {
      case 'month':
        key = f.flow_date.substring(0, 7); // YYYY-MM
        break;
      case 'quarter':
        key = `${d.getFullYear()}-Q${Math.ceil((d.getMonth() + 1) / 3)}`;
        break;
      case 'year':
        key = String(d.getFullYear());
        break;
      default:
        key = f.flow_date;
    }

    if (!groups[key]) {
      groups[key] = {
        period: key,
        coupon_cents: 0,
        maturity_cents: 0,
        call_cents: 0,
        total_cents: 0,
        flow_count: 0,
      };
    }

    groups[key].flow_count++;
    groups[key].total_cents += f.amount_cents;

    switch (f.flow_type) {
      case 'coupon':   groups[key].coupon_cents += f.amount_cents; break;
      case 'maturity': groups[key].maturity_cents += f.amount_cents; break;
      case 'call':     groups[key].call_cents += f.amount_cents; break;
    }
  }

  const periods = Object.values(groups).map(g => ({
    ...g,
    coupon_usd: Math.round(g.coupon_cents) / 100,
    maturity_usd: Math.round(g.maturity_cents) / 100,
    call_usd: Math.round(g.call_cents) / 100,
    total_usd: Math.round(g.total_cents) / 100,
  }));

  return {
    grouped_by: groupBy,
    periods,
    summary: summarizeCashFlows(flows),
  };
}

// ─── Summarize Cash Flows ─────────────────────────────────────────────────────

function summarizeCashFlows(flows) {
  let totalCoupon = 0;
  let totalMaturity = 0;
  let totalCall = 0;

  for (const f of flows) {
    switch (f.flow_type) {
      case 'coupon':   totalCoupon += f.amount_cents; break;
      case 'maturity': totalMaturity += f.amount_cents; break;
      case 'call':     totalCall += f.amount_cents; break;
    }
  }

  const total = totalCoupon + totalMaturity + totalCall;

  // Annual income estimate (coupons only)
  let annualIncome = 0;
  if (flows.length > 0) {
    const couponFlows = flows.filter(f => f.flow_type === 'coupon');
    if (couponFlows.length >= 2) {
      const firstDate = new Date(couponFlows[0].flow_date);
      const lastDate = new Date(couponFlows[couponFlows.length - 1].flow_date);
      const spanYears = (lastDate - firstDate) / (365.25 * 86400000);
      if (spanYears > 0) {
        annualIncome = Math.round(totalCoupon / spanYears);
      }
    }
  }

  return {
    total_flow_count: flows.length,
    total_cents: total,
    total_usd: Math.round(total) / 100,
    total_coupon_cents: totalCoupon,
    total_coupon_usd: Math.round(totalCoupon) / 100,
    total_maturity_cents: totalMaturity,
    total_maturity_usd: Math.round(totalMaturity) / 100,
    total_call_cents: totalCall,
    total_call_usd: Math.round(totalCall) / 100,
    estimated_annual_coupon_income_cents: annualIncome,
    estimated_annual_coupon_income_usd: Math.round(annualIncome) / 100,
  };
}

// ─── Income Forecast ──────────────────────────────────────────────────────────

function forecastIncome(holdings, years = 5) {
  const forecast = [];
  const now = new Date();

  for (let y = 0; y < years; y++) {
    const yearStart = new Date(now.getFullYear() + y, 0, 1);
    const yearEnd = new Date(now.getFullYear() + y, 11, 31);
    const yearStartStr = yearStart.toISOString().split('T')[0];
    const yearEndStr = yearEnd.toISOString().split('T')[0];

    let couponIncome = 0;
    let maturingPrincipal = 0;
    let activeCount = 0;

    for (const h of holdings) {
      if (h.status !== 'active') continue;
      if (h.maturity_date < yearStartStr) continue;

      activeCount++;
      const ppy = periodsPerYear(h.coupon_frequency);

      if (ppy > 0) {
        const couponDates = generateCouponDates(h.purchase_date, h.maturity_date, h.coupon_frequency);
        const couponAmount = Math.round((h.par_value_cents * h.coupon_rate) / ppy);

        for (const d of couponDates) {
          if (d >= yearStartStr && d <= yearEndStr) {
            couponIncome += couponAmount;
          }
        }
      }

      if (h.maturity_date >= yearStartStr && h.maturity_date <= yearEndStr) {
        maturingPrincipal += h.par_value_cents;
      }
    }

    forecast.push({
      year: now.getFullYear() + y,
      projected_coupon_income_cents: couponIncome,
      projected_coupon_income_usd: Math.round(couponIncome) / 100,
      maturing_principal_cents: maturingPrincipal,
      maturing_principal_usd: Math.round(maturingPrincipal) / 100,
      total_cash_flow_cents: couponIncome + maturingPrincipal,
      total_cash_flow_usd: Math.round(couponIncome + maturingPrincipal) / 100,
      active_holdings: activeCount,
    });
  }

  return forecast;
}

module.exports = {
  projectHoldingCashFlows,
  projectPortfolioCashFlows,
  groupCashFlows,
  summarizeCashFlows,
  forecastIncome,
};
