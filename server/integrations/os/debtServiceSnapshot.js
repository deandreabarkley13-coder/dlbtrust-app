'use strict';

/**
 * PPB debt service — the single-family trust's principal and coupon income
 * paid to the trust and its beneficiaries, read from the engines that own it:
 *
 *   schedule   Debt OS coupon + principal events inside the horizon
 *   coupon     Fixed Income Distribution OS: rail readiness, bucket funding
 *              (coupon_income 1020 -> beneficiaries, trust_operating 1030 ->
 *              trustees) and distributions by status
 *   principal  Bond Redemption OS: notices, batches, upcoming maturities
 *   coverage   coupons due vs cleared coupon_income funding available
 *
 * Read-only: planning, staging and executing distributions stay on
 * FixedIncomeDistributionEngine (maker/checker, bank settlement reference).
 */

function tryRequire(mod) {
  try { return require(mod); } catch (e) { return null; }
}

const engines = {
  debt: () => tryRequire('./debtOsEngine')?.DebtOsEngine || null,
  distribution: () => tryRequire('./fixedIncomeDistributionEngine')?.FixedIncomeDistributionEngine || null,
  redemption: () => tryRequire('./bondRedemptionOsEngine')?.BondRedemptionOsEngine || null,
};

async function settle(fn) {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: e.message }; }
}

function missing(name) { return { ok: false, error: `${name} not loadable` }; }

function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }

async function debtServiceSnapshot({ horizonDays = 90 } = {}) {
  const Debt = engines.debt();
  const Dist = engines.distribution();
  const Redemption = engines.redemption();
  const [schedule, readiness, summary, principal] = await Promise.all([
    Debt ? settle(() => Debt.schedule(horizonDays)) : missing('Debt OS'),
    Dist ? settle(() => Dist.readiness()) : missing('Fixed Income Distribution OS'),
    Dist ? settle(() => Dist.summary()) : missing('Fixed Income Distribution OS'),
    Redemption ? settle(() => Redemption.status()) : missing('Bond Redemption OS'),
  ]);

  const buckets = readiness.ok ? readiness.value.buckets || [] : [];
  const funding = Object.fromEntries(buckets.map((b) => [b.bucket, {
    glAccountCode: b.glAccountCode,
    payees: (b.payees || []).length,
    available: b.funding && b.funding.availableCents != null ? round2(b.funding.availableCents / 100) : null,
    eligible: b.funding ? b.funding.eligible !== false && !b.funding.error : false,
    reason: b.funding ? b.funding.reason || b.funding.error || null : 'no funding position',
  }]));

  const byStatus = {};
  for (const r of summary.ok ? summary.value : []) {
    byStatus[r.bucket] = byStatus[r.bucket] || {};
    byStatus[r.bucket][r.status] = { count: r.count, total: round2(r.totalUsd) };
  }

  const totals = schedule.ok ? schedule.value.totals : null;
  const couponDue = totals ? round2(totals.coupon) : null;
  const couponFunding = funding.coupon_income ? funding.coupon_income.available : null;
  const upcoming = principal.ok ? principal.value.upcomingMaturities || [] : [];

  return {
    horizonDays,
    schedule: schedule.ok ? {
      events: schedule.value.events,
      coupon: round2(totals.coupon), principal: round2(totals.principal), total: round2(totals.total),
    } : { error: schedule.error },
    coupon: readiness.ok ? {
      rail: readiness.value.rail, ready: Boolean(readiness.value.ready), issues: readiness.value.issues || [],
      autoStage: Boolean(readiness.value.autoStage), autoExecute: Boolean(readiness.value.autoExecute),
      funding, distributions: byStatus,
    } : { error: readiness.error },
    principal: principal.ok ? {
      notices: principal.value.notices, batches: principal.value.batches,
      upcomingMaturities: upcoming.map((m) => ({ bondId: m.bondId, bondName: m.bondName, maturityDate: m.maturityDate, principal: round2(m.principalBalanceCents / 100), daysToMaturity: m.daysToMaturity, noticeId: m.noticeId })),
      unpostedSettlements: principal.value.unpostedSettlements,
    } : { error: principal.error },
    coverage: {
      couponDue,
      couponFunding,
      couponCovered: couponDue != null && couponFunding != null ? couponFunding + 0.005 >= couponDue : false,
    },
    movesMoney: false,
  };
}

module.exports = { debtServiceSnapshot, engines };
