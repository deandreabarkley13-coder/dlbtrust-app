/**
 * Bond Ladder Strategy Engine
 * DEANDREA LAVAR BARKLEY TRUST — Private Trust Fixed Income Ladder Construction
 *
 * Constructs and optimizes bond maturity ladders to provide predictable
 * income streams and manage reinvestment risk for trust portfolios.
 */

'use strict';

const { calcYieldToMaturity, calcPriceFromYield, periodsPerYear } = require('./fixed-income-engine');

// ─── Ladder Construction ──────────────────────────────────────────────────────

/**
 * Build an optimized bond ladder given strategy parameters.
 * Returns an array of recommended "rungs" (maturity slots) with target allocations.
 *
 * @param {Object} strategy - Ladder strategy configuration
 * @param {number} strategy.target_total_cents - Total amount to invest
 * @param {number} strategy.ladder_start_year - First maturity year
 * @param {number} strategy.ladder_end_year - Last maturity year
 * @param {number} strategy.rung_interval_months - Months between rungs (default 12)
 * @param {number} [strategy.min_rung_cents] - Minimum per-rung allocation
 * @param {number} [strategy.max_rung_cents] - Maximum per-rung allocation
 * @param {number} [strategy.target_yield] - Target portfolio yield
 * @param {Object[]} [existingHoldings] - Current holdings to account for
 */
function buildLadder(strategy, existingHoldings = []) {
  const {
    target_total_cents,
    ladder_start_year,
    ladder_end_year,
    rung_interval_months = 12,
    min_rung_cents,
    max_rung_cents,
    target_yield,
  } = strategy;

  // Generate rung dates
  const rungs = [];
  const startDate = new Date(`${ladder_start_year}-01-01`);
  const endDate = new Date(`${ladder_end_year}-12-31`);
  let current = new Date(startDate);

  while (current <= endDate) {
    rungs.push({
      maturity_date: current.toISOString().split('T')[0],
      maturity_year: current.getFullYear(),
      maturity_month: current.getMonth() + 1,
    });
    current = new Date(current);
    current.setMonth(current.getMonth() + rung_interval_months);
  }

  if (rungs.length === 0) {
    return { rungs: [], summary: { error: 'No rungs generated — check start/end years' } };
  }

  // Calculate equal allocation per rung
  const equalAllocation = Math.floor(target_total_cents / rungs.length);

  // Apply min/max constraints
  const constrainedAllocation = Math.max(
    min_rung_cents || 0,
    Math.min(max_rung_cents || Infinity, equalAllocation)
  );

  // Map existing holdings to rungs
  const holdingsByYear = {};
  for (const h of existingHoldings) {
    if (h.status !== 'active') continue;
    const matYear = new Date(h.maturity_date).getFullYear();
    holdingsByYear[matYear] = holdingsByYear[matYear] || [];
    holdingsByYear[matYear].push(h);
  }

  // Build rung details
  const rungDetails = rungs.map(rung => {
    const yearHoldings = holdingsByYear[rung.maturity_year] || [];
    const existingParCents = yearHoldings.reduce((sum, h) => sum + h.par_value_cents, 0);
    const existingMarketCents = yearHoldings.reduce(
      (sum, h) => sum + (h.market_value_cents || h.purchase_price_cents), 0
    );

    const gapCents = Math.max(0, constrainedAllocation - existingParCents);

    return {
      ...rung,
      target_allocation_cents: constrainedAllocation,
      target_allocation_usd: Math.round(constrainedAllocation) / 100,
      existing_par_cents: existingParCents,
      existing_par_usd: Math.round(existingParCents) / 100,
      existing_market_cents: existingMarketCents,
      existing_market_usd: Math.round(existingMarketCents) / 100,
      existing_holdings: yearHoldings.length,
      gap_cents: gapCents,
      gap_usd: Math.round(gapCents) / 100,
      is_filled: existingParCents >= constrainedAllocation,
    };
  });

  // Summary
  const totalAllocated = rungDetails.reduce((s, r) => s + r.existing_par_cents, 0);
  const totalGap = rungDetails.reduce((s, r) => s + r.gap_cents, 0);
  const filledCount = rungDetails.filter(r => r.is_filled).length;

  return {
    rungs: rungDetails,
    summary: {
      total_rungs: rungDetails.length,
      filled_rungs: filledCount,
      unfilled_rungs: rungDetails.length - filledCount,
      target_total_cents: target_total_cents,
      target_total_usd: Math.round(target_total_cents) / 100,
      currently_allocated_cents: totalAllocated,
      currently_allocated_usd: Math.round(totalAllocated) / 100,
      remaining_to_invest_cents: totalGap,
      remaining_to_invest_usd: Math.round(totalGap) / 100,
      completion_pct: target_total_cents > 0
        ? Math.round((totalAllocated / target_total_cents) * 10000) / 100
        : 0,
      per_rung_target_cents: constrainedAllocation,
      per_rung_target_usd: Math.round(constrainedAllocation) / 100,
      rung_interval_months,
      ladder_span_years: ladder_end_year - ladder_start_year + 1,
    },
  };
}

// ─── Reinvestment Recommendations ─────────────────────────────────────────────

/**
 * Given maturing holdings and a ladder strategy, recommend reinvestments
 * to maintain the ladder structure.
 */
function recommendReinvestments(maturingHoldings, strategy, currentHoldings) {
  const ladder = buildLadder(strategy, currentHoldings);
  const recommendations = [];

  // Sort unfilled rungs by maturity date
  const unfilledRungs = ladder.rungs
    .filter(r => !r.is_filled)
    .sort((a, b) => a.maturity_date.localeCompare(b.maturity_date));

  let availableCash = maturingHoldings.reduce((s, h) => s + h.par_value_cents, 0);

  for (const rung of unfilledRungs) {
    if (availableCash <= 0) break;

    const investAmount = Math.min(rung.gap_cents, availableCash);
    if (investAmount > 0) {
      const yearsToMaturity = (new Date(rung.maturity_date) - new Date()) / (365.25 * 86400000);

      recommendations.push({
        action: 'purchase',
        target_maturity: rung.maturity_date,
        target_year: rung.maturity_year,
        amount_cents: investAmount,
        amount_usd: Math.round(investAmount) / 100,
        approximate_years: Math.round(yearsToMaturity * 10) / 10,
        fills_rung: investAmount >= rung.gap_cents,
      });

      availableCash -= investAmount;
    }
  }

  return {
    maturing_par_cents: maturingHoldings.reduce((s, h) => s + h.par_value_cents, 0),
    maturing_par_usd: Math.round(maturingHoldings.reduce((s, h) => s + h.par_value_cents, 0)) / 100,
    maturing_count: maturingHoldings.length,
    recommendations,
    remaining_cash_cents: availableCash,
    remaining_cash_usd: Math.round(availableCash) / 100,
  };
}

// ─── Ladder Optimization ──────────────────────────────────────────────────────

/**
 * Analyze how well the current portfolio matches the ladder strategy
 * and suggest adjustments.
 */
function analyzeLadderFit(strategy, currentHoldings) {
  const ladder = buildLadder(strategy, currentHoldings);
  const analysis = {
    ...ladder.summary,
    issues: [],
    recommendations: [],
  };

  // Check for concentration in specific years
  for (const rung of ladder.rungs) {
    const pctOfTotal = strategy.target_total_cents > 0
      ? rung.existing_par_cents / strategy.target_total_cents
      : 0;

    if (pctOfTotal > 0.25) {
      analysis.issues.push({
        type: 'concentration',
        year: rung.maturity_year,
        detail: `${Math.round(pctOfTotal * 100)}% of portfolio matures in ${rung.maturity_year}`,
      });
    }
  }

  // Check for gaps (no holdings maturing for extended periods)
  const filledYears = ladder.rungs.filter(r => r.existing_holdings > 0).map(r => r.maturity_year);
  if (filledYears.length >= 2) {
    for (let i = 1; i < filledYears.length; i++) {
      const gap = filledYears[i] - filledYears[i - 1];
      if (gap > 2) {
        analysis.issues.push({
          type: 'gap',
          from_year: filledYears[i - 1],
          to_year: filledYears[i],
          detail: `No maturities between ${filledYears[i - 1]} and ${filledYears[i]} (${gap} year gap)`,
        });
      }
    }
  }

  // Recommendations
  const unfilledRungs = ladder.rungs.filter(r => !r.is_filled);
  if (unfilledRungs.length > 0) {
    analysis.recommendations.push({
      action: 'fill_gaps',
      detail: `${unfilledRungs.length} ladder rungs need additional investment`,
      total_needed_cents: unfilledRungs.reduce((s, r) => s + r.gap_cents, 0),
      total_needed_usd: Math.round(unfilledRungs.reduce((s, r) => s + r.gap_cents, 0)) / 100,
    });
  }

  return analysis;
}

module.exports = {
  buildLadder,
  recommendReinvestments,
  analyzeLadderFit,
};
