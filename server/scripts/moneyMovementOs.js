#!/usr/bin/env node
'use strict';

/**
 * Acquire the trust's first on-chain value: dollars → XLM → the distributor.
 *
 * This is the only script here that adds an asset rather than moving one. It
 * buys XLM at a trading venue with USD the trust deposited there, withdraws it
 * to the distributor — creating the account if it does not exist — and
 * recognises only what Horizon actually shows.
 *
 * Usage:
 *   node server/scripts/moneyMovementOs.js readiness
 *   node server/scripts/moneyMovementOs.js plan     [--amount 5]
 *   node server/scripts/moneyMovementOs.js quote    --amount 5
 *   node server/scripts/moneyMovementOs.js initiate --amount 5 --maker trustee-one@…
 *   node server/scripts/moneyMovementOs.js approve  --id XLMBUY-… --checker trustee-two@…
 *   node server/scripts/moneyMovementOs.js deposit  --id XLMBUY-… --reference <ACH ref>
 *   node server/scripts/moneyMovementOs.js execute  --id XLMBUY-… --yes
 *   node server/scripts/moneyMovementOs.js confirm  --id XLMBUY-…
 *   node server/scripts/moneyMovementOs.js list
 *
 * `--amount` is dollars. `execute` is the only command that spends money, and
 * it requires `--yes`.
 */

const { MoneyMovementOsEngine } = require('../integrations/os/moneyMovementOsEngine');
const { StellarVenue } = require('../integrations/stablecoin/stellarVenue');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) { args._.push(token); continue; }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; continue; }
    args[key] = next;
    i += 1;
  }
  return args;
}

function dollars(value) {
  const cents = Math.round(Number(value) * 100);
  if (!Number.isFinite(cents) || cents <= 0) throw new Error(`--amount ${value} is not a positive dollar amount`);
  return cents;
}

function printDestination(destination) {
  if (!destination || !destination.address) {
    console.log('Destination      : not configured (STABLECOIN_DISTRIBUTOR_PUBLIC)');
    return;
  }
  console.log(`Destination      : ${destination.address}`);
  console.log(`  on chain       : ${destination.exists
    ? `exists, holding ${destination.xlm} XLM`
    : 'does not exist — a withdrawal of XLM is what creates it'}`);
  if (destination.needsXlm) console.log(`  still needs    : ${destination.needsXlm} XLM for the reserve and a USDC trustline`);
}

async function readiness() {
  const state = await MoneyMovementOsEngine.readiness();
  console.log(`Network          : ${state.network}`);
  printDestination(state.destination);
  for (const venue of state.venues) {
    console.log(`Venue ${venue.id.padEnd(11)}: ${venue.configured ? 'configured' : `missing ${venue.missing.join(', ')}`}`);
    console.log(`  ${venue.note}`);
  }
  if (state.ready) {
    console.log('\nReady: XLM can be bought and withdrawn from here.');
    return 0;
  }
  console.log('\nNot ready:');
  for (const issue of state.issues) console.log(`  - ${issue}`);
  console.log('\nDollars become XLM only at a venue that takes fiat. That account is the'
    + '\none thing no engine here can replace.');
  return 2;
}

async function plan(args) {
  const usdCents = args.amount ? dollars(args.amount) : 500;
  const planned = await MoneyMovementOsEngine.plan({ usdCents });
  console.log(`Acquiring ${planned.usd} of XLM`);
  printDestination(planned.destination);
  console.log('');
  for (const leg of planned.legs) {
    console.log(`${leg.automated ? '[auto]  ' : '[manual]'} ${leg.leg}: ${leg.description}`);
    console.log(`         posts: ${leg.posts}`);
  }
  return planned.readiness.ready ? 0 : 2;
}

async function quote(args) {
  const usdCents = dollars(args.amount);
  const quoted = await StellarVenue.quote({ usd: usdCents / 100 });
  console.log(`${quoted.product}: $${quoted.usd} buys ${quoted.xlm || 'an unknown amount of'} XLM`);
  if (quoted.ok) return 0;
  console.log(quoted.needsDeposit
    ? 'The venue account holds no dollars: deposit USD there first.'
    : `The venue refused: ${quoted.errors.join(', ')}`);
  return 2;
}

async function initiate(args) {
  const usdCents = dollars(args.amount);
  const { acquisition } = await MoneyMovementOsEngine.initiate({
    usdCents,
    initiatedBy: args.maker,
    memo: typeof args.memo === 'string' ? args.memo : null,
  });
  console.log(`Raised ${acquisition.acquisition_id} for $${(acquisition.usd_cents / 100).toFixed(2)} of XLM`);
  console.log(`A second trustee approves: approve --id ${acquisition.acquisition_id} --checker <trustee>`);
  return 0;
}

async function approve(args) {
  const row = await MoneyMovementOsEngine.approve(args.id, args.checker);
  console.log(`${row.acquisition_id} approved by ${row.approved_by}`);
  return 0;
}

async function deposit(args) {
  const row = await MoneyMovementOsEngine.recordDeposit(args.id, {
    reference: args.reference,
    sentBy: typeof args.by === 'string' ? args.by : null,
  });
  console.log(`${row.acquisition_id}: USD booked in transit (journal ${row.transit_journal_id})`);
  return 0;
}

async function execute(args) {
  if (!args.yes) {
    console.log('This buys XLM with real dollars at the venue and withdraws it on-chain.');
    console.log('Re-run with --yes to proceed.');
    return 1;
  }
  const row = await MoneyMovementOsEngine.execute(args.id, {
    executedBy: typeof args.by === 'string' ? args.by : null,
  });
  console.log(`${row.acquisition_id}: bought ${row.xlm_bought} XLM (order ${row.venue_order_id || 'n/a'})`);
  console.log(`Withdrawal ${row.venue_withdrawal_id || 'n/a'} sent to ${row.destination}`);
  console.log(`Nothing is recognised yet. Confirm on the ledger: confirm --id ${row.acquisition_id}`);
  return 0;
}

async function confirm(args) {
  const row = await MoneyMovementOsEngine.confirm(args.id, {
    confirmedBy: typeof args.by === 'string' ? args.by : null,
  });
  console.log(`${row.acquisition_id}: ${row.xlm_confirmed} XLM confirmed at ${row.destination}`);
  console.log(`Posted as journal ${row.journal_entry_id}`);
  console.log('Next: npm run trust:stellar-mainnet -- trustline --yes');
  return 0;
}

async function list() {
  const rows = await MoneyMovementOsEngine.list({});
  if (!rows.length) {
    console.log('No XLM acquisitions.');
    return 0;
  }
  for (const row of rows) {
    console.log(`${row.acquisition_id}  ${row.status.padEnd(16)} $${(row.usd_cents / 100).toFixed(2).padStart(8)}`
      + `  ${row.xlm_confirmed || row.xlm_bought || '-'} XLM  ${row.destination}`);
  }
  return 0;
}

const COMMANDS = { readiness, plan, quote, initiate, approve, deposit, execute, confirm, list };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'readiness';
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command ${command}. One of: ${Object.keys(COMMANDS).join(', ')}`);
    return 1;
  }
  return handler(args);
}

main()
  .then(code => process.exit(code || 0))
  .catch(err => {
    console.error(`\nFailed: ${err.message}`);
    process.exit(1);
  });
