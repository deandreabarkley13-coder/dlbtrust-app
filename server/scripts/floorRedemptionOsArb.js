#!/usr/bin/env node
'use strict';

/**
 * Floor Redemption OS from a terminal — canonical floor reserve and peg defense.
 *
 *   readiness   signer / gates / artifact status
 *   status      contract, floor coverage, AMM price, recent actions
 *   deploy      salted, idempotent FloorPriceRedemption deployment [--force]
 *   fund        move canonical into the reserve [--amount 500] [--no-onramp]
 *               (without --amount, funds the coverage shortfall; short wallets
 *               propose a TreasuryOnRampBridge operation and report awaiting_funds)
 *   redeem      --amount 100 [--to 0x...]  redeem DLB-PTCUSD at the floor
 *   arb         one arbitrage / peg-defense pass — what a scheduler runs
 *   actions     recent actions [--limit 20]
 *
 * Usage:
 *   node server/scripts/floorRedemptionOsArb.js status
 *   node server/scripts/floorRedemptionOsArb.js arb
 */

const { FloorRedemptionOsEngine } = require('../integrations/dapp/floorRedemptionOsEngine');

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
  console.log(JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? String(v) : v), 2));
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0] || 'status';
  switch (command) {
    case 'readiness': print('Readiness', FloorRedemptionOsEngine.readiness()); break;
    case 'status': print('Status', await FloorRedemptionOsEngine.status()); break;
    case 'deploy': print('Deploy', await FloorRedemptionOsEngine.deploy({ force: args.flags.has('force') })); break;
    case 'fund': print('Fund', await FloorRedemptionOsEngine.fund({ amount: args.amount, onRamp: !args.flags.has('no-onramp') })); break;
    case 'redeem': {
      if (!args.amount) throw new Error('--amount is required');
      print('Redeem', await FloorRedemptionOsEngine.redeem({ amount: args.amount, to: args.to }));
      break;
    }
    case 'arb':
    case 'cycle': print('Arb cycle', await FloorRedemptionOsEngine.arbCycle()); break;
    case 'actions': print('Actions', await FloorRedemptionOsEngine.listActions({ limit: Number(args.limit) || 20 })); break;
    default: throw new Error(`unknown command ${command}`);
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error(`\n${err.code || 'ERROR'}: ${err.message}`); process.exit(1); });
}

module.exports = { main };
