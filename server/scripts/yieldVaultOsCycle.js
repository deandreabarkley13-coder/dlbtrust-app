#!/usr/bin/env node
'use strict';

/**
 * Yield Vault OS from a terminal — distribute real trust income (bond accrued
 * interest, LP yield, vault reserve surplus) pro-rata in DLB-PTCUSD.
 *
 *   readiness   signer / gates / dependency status
 *   status      sources, totals, recent cycles
 *   sources     gross, already paid and available income per source
 *   plan        allocations the next cycle would pay (no writes)
 *   distribute  execute the current plan (shadow unless the live gates are set)
 *   cycle       plan + distribute — what a scheduler runs
 *   lp-payout   accrue LP yield and pay it out [--pool 0x...] [--apy-bps 500]
 *   cycles      recent cycles [--limit 20]
 *
 * Usage:
 *   node server/scripts/yieldVaultOsCycle.js plan
 *   node server/scripts/yieldVaultOsCycle.js cycle
 */

const { YieldVaultOsEngine } = require('../integrations/dapp/yieldVaultOsEngine');
const { InternalMarketMakerEngine } = require('../integrations/dapp/internalMarketMakerEngine');

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
    case 'readiness': print('Readiness', YieldVaultOsEngine.readiness()); break;
    case 'status': print('Status', await YieldVaultOsEngine.status()); break;
    case 'sources': print('Sources', await YieldVaultOsEngine.sources()); break;
    case 'plan': print('Plan', await YieldVaultOsEngine.plan()); break;
    case 'distribute': print('Distributed', await YieldVaultOsEngine.distribute()); break;
    case 'cycle': print('Cycle', await YieldVaultOsEngine.runCycle()); break;
    case 'lp-payout':
      print('LP payout', await InternalMarketMakerEngine.accrueYield({ poolAddress: args.pool, apyBps: args['apy-bps'] ? Number(args['apy-bps']) : undefined, payout: true }));
      break;
    case 'cycles': print('Cycles', await YieldVaultOsEngine.listCycles({ limit: Number(args.limit) || 20 })); break;
    default: throw new Error(`unknown command ${command}`);
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error(`\n${err.code || 'ERROR'}: ${err.message}`); process.exit(1); });
}

module.exports = { main };
