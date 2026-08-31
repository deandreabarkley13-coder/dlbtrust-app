#!/usr/bin/env node
'use strict';

/**
 * Run a clearing cycle from a terminal.
 *
 * The cycle is the unit of work: `candidates` shows what would net and how many
 * credits that saves, `open` binds those obligations to a cycle and nets them,
 * `fund` makes the one funding decision for the whole cycle, and `settle` hands
 * each net leg to Payer OS — where it lands `pending_approval`, so a second
 * trustee still signs before anything is originated. `reconcile` follows the
 * legs back and will report `partially_settled` rather than call a cycle done.
 *
 * No command here debits anybody, posts a journal entry or names a counterparty
 * that is not already a registered Payer OS payee.
 *
 * Usage:
 *   node server/scripts/clearingCycle.js candidates [--limit 200] [--value-date 2026-08-31]
 *   node server/scripts/clearingCycle.js funding
 *   node server/scripts/clearingCycle.js runbook
 *   node server/scripts/clearingCycle.js cycles [--status netted] [--limit 20]
 *   node server/scripts/clearingCycle.js cycle --id CYC-…
 *   node server/scripts/clearingCycle.js open --operator ops@example.com \
 *     [--value-date 2026-08-31] [--origins vendor_payable,beneficiary_distribution]
 *   node server/scripts/clearingCycle.js fund --id CYC-… --operator ops@example.com
 *   node server/scripts/clearingCycle.js settle --id CYC-… --maker trustee-one@example.com
 *   node server/scripts/clearingCycle.js reconcile --id CYC-…
 *   node server/scripts/clearingCycle.js cancel --id CYC-… --operator ops@example.com [--reason "…"]
 */

const { ClearingNettingEngine } = require('../integrations/os/clearingNettingEngine');

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
    if (next === undefined || next.startsWith('--')) args.flags.add(key);
    else {
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

function summariseLegs(cycle) {
  console.log(`\nCycle ${cycle.cycleId} (${cycle.status}) value ${cycle.valueDate}`);
  console.log(`  ${cycle.obligationCount} obligation(s) → ${cycle.legs.length} leg(s), gross ${cycle.gross}, net ${cycle.net}`);
  cycle.legs.forEach((leg) => {
    console.log(`  ${leg.legId} ${leg.net} → ${leg.counterparty || leg.payeeKey}`
      + ` (${leg.disbursementType}, ${leg.obligationCount} obligation(s), ${leg.status}`
      + `${leg.disbursementId ? `, ${leg.disbursementId}` : ''})`);
    if (leg.failureReason) console.log(`    failed: ${leg.failureReason}`);
  });
  console.log(`  next: ${cycle.nextStep}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = (args._[0] || 'runbook').toLowerCase();

  if (command === 'candidates') {
    const data = await ClearingNettingEngine.candidates({
      limit: args.limit,
      valueDate: args['value-date'] || null,
    });
    print('Clearing candidates:', data);
    console.log(`\n${data.totals.obligationCount} obligation(s) would net to ${data.totals.legCount} leg(s)`
      + ` — ${data.totals.creditsAvoided} credit(s) avoided, ${data.totals.net} to fund.`);
    return;
  }

  if (command === 'funding') {
    print('Clearing funding:', await ClearingNettingEngine.funding());
    return;
  }

  if (command === 'runbook') {
    const data = await ClearingNettingEngine.runbook({ limit: args.limit });
    print('Clearing runbook:', data);
    if (data.breaks.length) process.exitCode = 2;
    return;
  }

  if (command === 'cycles') {
    print('Clearing cycles:', await ClearingNettingEngine.list({
      status: args.status || null,
      limit: args.limit,
    }));
    return;
  }

  if (command === 'cycle') {
    const cycle = await ClearingNettingEngine.cycle(requireFlag(args, 'id', 'a cycle id'));
    print('Cycle:', cycle);
    summariseLegs(cycle);
    return;
  }

  if (command === 'open') {
    const cycle = await ClearingNettingEngine.openCycle({
      openedBy: requireFlag(args, 'operator', 'the operator opening the cycle'),
      valueDate: args['value-date'] || null,
      limit: args.limit || 200,
      currency: args.currency || 'USD',
      origins: args.origins ? args.origins.split(',').map(part => part.trim()).filter(Boolean) : null,
      note: args.note || null,
    });
    summariseLegs(cycle);
    console.log(`\nNext: node server/scripts/clearingCycle.js fund --id ${cycle.cycleId} --operator …`);
    return;
  }

  if (command === 'fund') {
    const cycle = await ClearingNettingEngine.fundCycle({
      cycleId: requireFlag(args, 'id', 'a cycle id'),
      fundedBy: requireFlag(args, 'operator', 'the operator funding the cycle'),
    });
    summariseLegs(cycle);
    console.log(`\nNext: node server/scripts/clearingCycle.js settle --id ${cycle.cycleId} --maker …`);
    return;
  }

  if (command === 'settle') {
    const result = await ClearingNettingEngine.settleCycle({
      cycleId: requireFlag(args, 'id', 'a cycle id'),
      initiatedBy: requireFlag(args, 'maker', 'the trustee raising the net credits'),
      memo: args.memo || null,
    });
    print('Legs handed to Payer OS:', result.legs);
    summariseLegs(result.cycle);
    console.log('\nEach leg is pending a second trustee in Payer OS:');
    result.legs.filter(leg => leg.disbursementId).forEach((leg) => {
      console.log(`  node server/scripts/sendPayerCredit.js approve --id ${leg.disbursementId} --checker …`);
    });
    return;
  }

  if (command === 'reconcile') {
    const cycle = await ClearingNettingEngine.reconcile(requireFlag(args, 'id', 'a cycle id'));
    summariseLegs(cycle);
    return;
  }

  if (command === 'cancel') {
    const result = await ClearingNettingEngine.cancelCycle({
      cycleId: requireFlag(args, 'id', 'a cycle id'),
      cancelledBy: requireFlag(args, 'operator', 'the operator cancelling the cycle'),
      reason: args.reason || null,
    });
    print('Cancelled:', result);
    console.log(`\n${result.releasedObligations} obligation(s) across ${result.releasedLegs} leg(s) are back in the credit queue.`);
    if (result.retained.length) {
      console.log('\nLegs kept, because their money is already with Payer OS:');
      result.retained.forEach(leg => console.log(`  ${leg.legId} ${leg.disbursementId || ''} (${leg.status})`));
      process.exitCode = 2;
    }
    return;
  }

  throw new Error(
    `Unknown command "${command}".`
    + ' Commands: candidates, funding, runbook, cycles, cycle, open, fund, settle, reconcile, cancel'
  );
}

if (require.main === module) {
  main().then(() => process.exit(process.exitCode || 0)).catch((err) => {
    console.error(`\nFailed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
