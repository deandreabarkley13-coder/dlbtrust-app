#!/usr/bin/env node
'use strict';

/**
 * PPB Debt Service Wire — principal and coupon income for the single-family
 * trust and its beneficiaries.
 *
 * Run from the repo root:
 *   node server/scripts/ppbDebtServiceWire.js                        # schedule, funding, distributions (read-only)
 *   node server/scripts/ppbDebtServiceWire.js --plan --actor <id>    # plan distributions for booked coupon/operating journals
 *   node server/scripts/ppbDebtServiceWire.js --plan --dry-run --actor <id>
 *   ... [--horizon 90] [--json] [--strict]
 *
 * Planning only creates `planned` fixed-income distributions. Staging and
 * executing them stay on fixedIncomeDistribution.js (maker/checker, screening
 * and the settlement bank's reference). With --strict the exit code is 2 when
 * the coupon rail is not ready or coupons due are not covered.
 */

require('dotenv').config();

const { debtServiceSnapshot, engines } = require('../integrations/os/debtServiceSnapshot');

const VALUE_FLAGS = { '--actor': 'actor', '--horizon': 'horizon' };

function parseArgs(argv) {
  const out = { plan: false, dryRun: false, json: false, strict: false, actor: null, horizonDays: 90 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--plan') out.plan = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--strict') out.strict = true;
    else if (VALUE_FLAGS[arg]) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--actor') out.actor = next;
      else {
        const n = Number(next);
        if (!(Number.isInteger(n) && n > 0)) throw new Error('--horizon must be a positive whole number of days');
        out.horizonDays = n;
      }
      i += 1;
    } else throw new Error(`unknown argument "${arg}"`);
  }
  if (out.dryRun && !out.plan) throw new Error('--dry-run only applies to --plan');
  if (out.plan && !out.actor) throw new Error('--plan requires --actor <id>');
  return out;
}

function money(n) {
  return n == null ? '-' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  let plan = null;
  if (args.plan) {
    const Dist = engines.distribution();
    if (!Dist) throw new Error('Fixed Income Distribution OS not loadable');
    plan = await Dist.plan({ createdBy: args.actor, dryRun: args.dryRun });
  }
  const snap = await debtServiceSnapshot({ horizonDays: args.horizonDays });

  if (args.json) {
    console.log(JSON.stringify({ ...snap, plan: plan ? { dryRun: plan.dryRun, sources: plan.sources, planned: plan.planned, totalUsd: plan.totalUsd } : null }, null, 2));
  } else {
    console.log(`\n== PPB debt service (${snap.horizonDays} days) ==`);
    if (snap.schedule.error) console.log(`  schedule unavailable: ${snap.schedule.error}`);
    else {
      console.log(`  coupon due      ${money(snap.schedule.coupon)}`);
      console.log(`  principal due   ${money(snap.schedule.principal)}`);
      for (const e of snap.schedule.events) console.log(`    ${e.date}  ${e.type.padEnd(9)} ${money(e.amount)}  ${e.bondName}`);
    }
    console.log('\n== coupon income (Fixed Income Distribution OS) ==');
    if (snap.coupon.error) console.log(`  unavailable: ${snap.coupon.error}`);
    else {
      console.log(`  rail ${snap.coupon.rail}  ${snap.coupon.ready ? 'ready' : 'not ready'}  auto-stage ${snap.coupon.autoStage}  auto-execute ${snap.coupon.autoExecute}`);
      for (const i of snap.coupon.issues) console.log(`  BLK ${i}`);
      for (const [bucket, f] of Object.entries(snap.coupon.funding)) {
        console.log(`  ${bucket.padEnd(16)} GL ${f.glAccountCode}  payees ${f.payees}  available ${money(f.available)}${f.eligible ? '' : `  (${f.reason})`}`);
      }
      for (const [bucket, statuses] of Object.entries(snap.coupon.distributions)) {
        console.log(`  ${bucket.padEnd(16)} ${Object.entries(statuses).map(([s, v]) => `${s} ${v.count} ${money(v.total)}`).join('  ')}`);
      }
    }
    console.log('\n== principal (Bond Redemption OS) ==');
    if (snap.principal.error) console.log(`  unavailable: ${snap.principal.error}`);
    else {
      for (const m of snap.principal.upcomingMaturities) console.log(`  ${m.maturityDate}  ${m.bondName}  ${money(m.principal)}  notice ${m.noticeId || '-'}`);
      if (!snap.principal.upcomingMaturities.length) console.log('  no maturity inside 90 days');
    }
    console.log(`\n== coverage ==\n  coupons due ${money(snap.coverage.couponDue)}  coupon income funding ${money(snap.coverage.couponFunding)}  ${snap.coverage.couponCovered ? 'covered' : 'NOT covered'}`);
    if (plan) console.log(`\n== ${plan.dryRun ? 'would plan' : 'planned'} ${plan.planned} distribution(s) ${money(plan.totalUsd)} from ${plan.sources} source journal(s) ==`);
  }
  if (!args.strict) return 0;
  return snap.coupon.ready && snap.coverage.couponCovered ? 0 : 2;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`ppb debt service wire failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, main };
