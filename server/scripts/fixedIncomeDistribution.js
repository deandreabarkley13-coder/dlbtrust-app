#!/usr/bin/env node
'use strict';

/**
 * Fixed income distribution from a terminal — booked coupon periods (1020) to
 * beneficiaries, operating allocations (1030) to trustees, segregated end to end.
 *
 *   readiness   payees, annual allocations, ERP/Spritz/policy leg status
 *   sources     posted source journals not yet planned
 *   plan        create planned distributions per payee (--dry-run to preview)
 *   list        distributions [--status planned|funding|funded|proposed|executed] [--bucket ...]
 *   stage       fund one distribution from its bucket's ERP cash (maker/checker proposal)
 *   reconcile   funded requests -> on-chain proposal / Spritz off-ramp (and auto-execute when enabled)
 *   execute     release a checker-approved distribution and book it
 *   cancel      cancel a distribution that has not executed
 *   cycle       plan + (auto)stage + reconcile — what the hourly reconcile runs
 *   summary     totals by bucket and status
 *
 * Usage:
 *   node server/scripts/fixedIncomeDistribution.js plan [--dry-run] --by trustee@example.com
 *   node server/scripts/fixedIncomeDistribution.js stage --id FID-... --by trustee@example.com [--auto-approve]
 *   node server/scripts/fixedIncomeDistribution.js execute --id FID-... --by trustee@example.com
 */

const { FixedIncomeDistributionEngine } = require('../integrations/os/fixedIncomeDistributionEngine');

function parseArgs(argv) {
  const args = { flags: new Set(), _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) { args._.push(token); continue; }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args.flags.add(key);
    else { args[key] = next; i += 1; }
  }
  return args;
}

function print(label, value) {
  console.log(`\n${label}`);
  console.log(JSON.stringify(value, null, 2));
}

function money(value) {
  return `$${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function requireFlag(args, name) {
  if (!args[name]) throw new Error(`--${name} is required`);
  return args[name];
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0] || 'summary';
  const by = args.by || 'cli';
  switch (command) {
    case 'readiness': print('Readiness', await FixedIncomeDistributionEngine.readiness()); break;
    case 'sources': print('Unplanned sources', await FixedIncomeDistributionEngine.unplannedSources()); break;
    case 'plan': {
      const out = await FixedIncomeDistributionEngine.plan({ createdBy: by, dryRun: args.flags.has('dry-run') });
      console.log(`\n${out.dryRun ? 'Would plan' : 'Planned'} ${out.planned} distributions totalling ${money(out.totalUsd)} from ${out.sources} source journals`);
      out.entries.forEach((e) => {
        console.log(`  ${e.source.referenceType}#${e.source.referenceId} ${e.source.entryDate} ${e.bucket} ${money(e.availableUsd)} -> allocated ${money(e.allocatedUsd)} retained ${money(e.retainedUsd)}`);
        e.distributions.forEach((d) => console.log(`    ${d.distributionId || '(dry)'} ${d.payeeRole} ${d.payeeName || d.payee} ${money(d.amountUsd)} [${d.status}]`));
      });
      break;
    }
    case 'list': print('Distributions', await FixedIncomeDistributionEngine.list({ status: args.status || null, bucket: args.bucket || null })); break;
    case 'get': print('Distribution', await FixedIncomeDistributionEngine.get(requireFlag(args, 'id'))); break;
    case 'stage': print('Staged', await FixedIncomeDistributionEngine.stage({ distributionId: requireFlag(args, 'id'), actor: by, autoApprove: args.flags.has('auto-approve') })); break;
    case 'reconcile': print('Reconciled', await FixedIncomeDistributionEngine.reconcile({ actor: by })); break;
    case 'execute': print('Executed', await FixedIncomeDistributionEngine.execute({ distributionId: requireFlag(args, 'id'), actor: by })); break;
    case 'cancel': print('Cancelled', await FixedIncomeDistributionEngine.cancel({ distributionId: requireFlag(args, 'id'), actor: by, reason: args.reason })); break;
    case 'cycle': print('Cycle', await FixedIncomeDistributionEngine.runCycle({ actor: by })); break;
    case 'summary': print('Summary', await FixedIncomeDistributionEngine.summary()); break;
    default: throw new Error(`unknown command ${command}`);
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error(`\n${err.code || 'ERROR'}: ${err.message}`); if (err.details) console.error(JSON.stringify(err.details, null, 2)); process.exit(1); });
}

module.exports = { main };
