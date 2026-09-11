#!/usr/bin/env node
'use strict';

/**
 * Spritz on-ramp from a terminal — ERP bucket cash (1020 / 1030) -> Spritz
 * ACH debit of the linked trust bank -> USDC in the thirdweb treasury wallet,
 * booked Dr 1025|1035 / Cr 1020|1030 once the checker approves.
 *
 *   readiness   linked funding source, ACH-debit capability, wallet, bucket positions
 *   quote       price a deposit (no debit)          --amount 1000 --bucket coupon_income
 *   propose     maker/checker proposal              --amount 1000 --bucket coupon_income --ref ONRAMP-2026-09-A
 *   approve     checker approval (executes when the threshold is met) --proposal ... --role checker --email ...
 *   reconcile   follow submitted deposits; reverse the ERP journal on a returned ACH
 *   list        [--status proposed|submitted|completed|failed|cancelled] [--bucket ...]
 *   cancel      --id SOR-...
 *   summary
 *
 * Nothing is debited unless SPRITZ_ONRAMP_LIVE=true (and CANONICAL_FUNDING_LIVE=true for the GL).
 */

const { SpritzOnRampEngine } = require('../integrations/spritz/spritzOnRampEngine');

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

function requireFlag(args, name) {
  if (!args[name]) throw new Error(`--${name} is required`);
  return args[name];
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0] || 'summary';
  const by = args.by || 'cli';
  switch (command) {
    case 'readiness': print('Readiness', await SpritzOnRampEngine.readiness()); break;
    case 'quote': print('Quote', await SpritzOnRampEngine.quote({ amountUsd: requireFlag(args, 'amount'), bucket: requireFlag(args, 'bucket') })); break;
    case 'propose': print('Proposed', await SpritzOnRampEngine.propose({ amountUsd: requireFlag(args, 'amount'), bucket: requireFlag(args, 'bucket'), reference: requireFlag(args, 'ref'), createdBy: by, autoApprove: args.flags.has('auto-approve') })); break;
    case 'approve': print('Approved', await SpritzOnRampEngine.approve({ proposalId: requireFlag(args, 'proposal'), role: requireFlag(args, 'role'), approverEmail: requireFlag(args, 'email') })); break;
    case 'reconcile': print('Reconciled', await SpritzOnRampEngine.reconcile()); break;
    case 'list': print('On-ramps', await SpritzOnRampEngine.list({ status: args.status || null, bucket: args.bucket || null })); break;
    case 'get': print('On-ramp', await SpritzOnRampEngine.get(requireFlag(args, 'id'))); break;
    case 'cancel': print('Cancelled', await SpritzOnRampEngine.cancel({ onRampId: requireFlag(args, 'id'), reason: args.reason })); break;
    case 'summary': print('Summary', await SpritzOnRampEngine.summary()); break;
    default: throw new Error(`unknown command ${command}`);
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error(`\n${err.code || 'ERROR'}: ${err.message}`); process.exit(1); });
}

module.exports = { main };
