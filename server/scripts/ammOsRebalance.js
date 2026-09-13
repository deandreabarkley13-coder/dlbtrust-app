#!/usr/bin/env node
'use strict';

/**
 * AMM OS from a terminal — StableSwap DLB-PTCUSD / canonical pool management.
 *
 *   readiness   signer / gates / artifact status
 *   status      pool, price vs $1, peg band, recent actions
 *   ensure      find or deploy + seed the pool [--seed 100]
 *   quote       --amount 100 [--token DLB-PTCUSD|USDC]
 *   rebalance   swap the surplus side back in when outside the band [--force]
 *   cycle       ensure + rebalance — what a scheduler runs
 *   actions     recent actions [--limit 20]
 *
 * Usage:
 *   node server/scripts/ammOsRebalance.js status
 *   node server/scripts/ammOsRebalance.js cycle
 */

const { AmmOsEngine } = require('../integrations/dapp/ammOsEngine');

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
    case 'readiness': print('Readiness', AmmOsEngine.readiness()); break;
    case 'status': print('Status', await AmmOsEngine.status()); break;
    case 'ensure': print('Pool', await AmmOsEngine.ensurePool({ seedUsd: args.seed ? Number(args.seed) : undefined })); break;
    case 'quote': {
      if (!args.amount) throw new Error('--amount is required');
      print('Quote', await AmmOsEngine.quote({ tokenIn: args.token || 'DLB-PTCUSD', amountIn: args.amount }));
      break;
    }
    case 'rebalance': print('Rebalance', await AmmOsEngine.rebalance({ force: args.flags.has('force') })); break;
    case 'cycle': print('Cycle', await AmmOsEngine.runCycle()); break;
    case 'actions': print('Actions', await AmmOsEngine.listActions({ limit: Number(args.limit) || 20 })); break;
    default: throw new Error(`unknown command ${command}`);
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error(`\n${err.code || 'ERROR'}: ${err.message}`); process.exit(1); });
}

module.exports = { main };
