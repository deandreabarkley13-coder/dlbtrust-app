#!/usr/bin/env node
'use strict';

/**
 * Run the family bank's back office from a terminal.
 *
 * Everything except `push` only reads: the desks, the unified position, the
 * day's breaks and the queue of obligations waiting on money. `push` hands one
 * queued obligation to Payer OS and stops there — the disbursement comes back
 * pending a second trustee, and approving, originating and settling it stay in
 * `sendPayerCredit.js`. No command here debits anybody, and none of them can
 * name a counterparty that is not already registered as a Payer OS payee.
 *
 * Usage:
 *   node server/scripts/wealthBackOffice.js status
 *   node server/scripts/wealthBackOffice.js init [--desk tax]
 *   node server/scripts/wealthBackOffice.js desks
 *   node server/scripts/wealthBackOffice.js desk --desk fixed_income [--limit 10]
 *   node server/scripts/wealthBackOffice.js position [--as-of 2026-08-31]
 *   node server/scripts/wealthBackOffice.js runbook [--tax-year 2026]
 *   node server/scripts/wealthBackOffice.js queue [--origin vendor_payable]
 *   node server/scripts/wealthBackOffice.js push --origin vendor_payable --id VPAY-… \
 *     --maker trustee-one@example.com [--payee acme] [--memo "August invoice"]
 *   node server/scripts/wealthBackOffice.js pushes [--limit 20]
 *   node server/scripts/wealthBackOffice.js melio [--limit 50]
 *   node server/scripts/wealthBackOffice.js clearing [--limit 20]
 *   node server/scripts/wealthBackOffice.js client --id CONTACT-…
 */

const { WealthBackOfficeEngine } = require('../integrations/os/wealthBackOfficeEngine');

function parseArgs(argv) {
  const args = { flags: new Set(), _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args.flags.add(key);
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function print(label, value) {
  console.log(`\n${label}`);
  console.log(JSON.stringify(value, null, 2));
}

function requireFlag(args, name, hint) {
  const value = args[name];
  if (!value) throw new Error(`--${name} is required${hint ? `: ${hint}` : ''}`);
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = (args._[0] || 'status').toLowerCase();

  if (command === 'status') {
    const readiness = await WealthBackOfficeEngine.readiness();
    print('Wealth Back Office readiness:', readiness);
    if (!readiness.ready) process.exitCode = 2;
    return;
  }

  if (command === 'init') {
    const schema = await WealthBackOfficeEngine.initDesks({ desk: args.desk || null });
    print('Desk storage:', schema);
    if (!schema.ready) {
      console.log('\nDesks still closed:');
      schema.actions.forEach(action => console.log(`  ${action}`));
      process.exitCode = 2;
    }
    return;
  }

  if (command === 'desks') {
    print('Desks:', WealthBackOfficeEngine.desks());
    return;
  }

  if (command === 'desk') {
    const desk = requireFlag(args, 'desk', 'one of ' + WealthBackOfficeEngine.desks().map(d => d.desk).join(', '));
    print(`Desk ${desk}:`, await WealthBackOfficeEngine.deskReport(desk, {
      limit: args.limit,
      asOfDate: args['as-of'] || null,
      taxYear: args['tax-year'] || null,
    }));
    return;
  }

  if (command === 'position') {
    const book = await WealthBackOfficeEngine.bookOfRecord({
      asOfDate: args['as-of'] || null,
      taxYear: args['tax-year'] || null,
    });
    print('Book of record:', book);
    if (!book.complete) process.exitCode = 2;
    return;
  }

  if (command === 'runbook') {
    const runbook = await WealthBackOfficeEngine.runbook({
      asOfDate: args['as-of'] || null,
      taxYear: args['tax-year'] || null,
    });
    print("Today's duties:", runbook);
    if (runbook.breaks) process.exitCode = 2;
    return;
  }

  if (command === 'queue') {
    const queue = await WealthBackOfficeEngine.creditQueue({ origin: args.origin || null, limit: args.limit });
    print('Obligations awaiting a credit push:', queue);
    return;
  }

  if (command === 'push') {
    const result = await WealthBackOfficeEngine.pushCredit({
      origin: requireFlag(args, 'origin', 'vendor_payable or beneficiary_distribution'),
      originId: requireFlag(args, 'id', "the obligation's own identifier"),
      payeeKey: args.payee || null,
      memo: args.memo || null,
      fundingSourceRef: args.source || null,
      initiatedBy: requireFlag(args, 'maker', 'a credit push is raised by a named trustee'),
    });
    console.log(
      `\nRaised ${result.disbursement.disbursement_id} for ${result.origin} ${result.originId}:`
      + ` ${(Number(result.disbursement.amount_cents) / 100).toFixed(2)} to ${result.disbursement.payee_label || result.disbursement.payee_name}`
      + ` over ${result.disbursement.rail}, maker ${result.disbursement.initiated_by}`
    );
    console.log(`Nothing has moved. ${result.awaiting}`);
    console.log(`  node server/scripts/sendPayerCredit.js approve --id ${result.disbursement.disbursement_id} --checker …`);
    return;
  }

  if (command === 'melio') {
    const exports_ = await WealthBackOfficeEngine.melioExports({ limit: args.limit });
    print('Melio CSV exports still owed a manual step:', exports_);
    if (exports_.items.length) {
      console.log('\nNext step per export:');
      exports_.items.forEach((item) => {
        console.log(`  ${item.exportId} ${item.amount} ${item.counterparty || '(unnamed)'}${item.stale ? ` [STALE ${item.ageDays}d]` : ''}`);
        console.log(`    ${item.nextStep}`);
      });
    }
    return;
  }

  if (command === 'clearing') {
    const { ClearingNettingEngine } = require('../integrations/os/clearingNettingEngine');
    const [runbook, candidates] = await Promise.all([
      ClearingNettingEngine.runbook({ limit: args.limit }),
      ClearingNettingEngine.candidates({ limit: args.limit }),
    ]);
    print('Clearing desk:', { runbook, candidates: candidates.totals });
    console.log(`\n${candidates.totals.obligationCount} obligation(s) would net to ${candidates.totals.legCount} leg(s)`
      + ` — ${candidates.totals.creditsAvoided} credit(s) avoided, ${candidates.totals.net} to fund.`);
    console.log('  open one with: node server/scripts/clearingCycle.js open --operator …');
    if (runbook.breaks.length) process.exitCode = 2;
    return;
  }

  if (command === 'pushes') {
    print('Handoffs to Payer OS:', await WealthBackOfficeEngine.pushes({ origin: args.origin || null, limit: args.limit }));
    return;
  }

  if (command === 'client') {
    print('Client:', await WealthBackOfficeEngine.client(requireFlag(args, 'id', 'a CRM contact id'), { limit: args.limit }));
    return;
  }

  throw new Error(
    `Unknown command "${command}".`
    + ' Commands: status, init, desks, desk, position, runbook, queue, melio, clearing, push, pushes, client'
  );
}

if (require.main === module) {
  main().then(() => process.exit(process.exitCode || 0)).catch((err) => {
    console.error(`\nFailed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
