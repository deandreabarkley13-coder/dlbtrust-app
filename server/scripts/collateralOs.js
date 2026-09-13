#!/usr/bin/env node
'use strict';

/**
 * Collateral OS from a terminal: tokenized RWA on Base -> spendable value ->
 * Treasury-Core ERP -> policy contract -> Spritz -> settlement bank.
 *
 * Usage:
 *   node server/scripts/collateralOs.js readiness
 *   node server/scripts/collateralOs.js facility
 *   node server/scripts/collateralOs.js positions [--status active]
 *   node server/scripts/collateralOs.js quote --token 0x... | --symbol DLB-PRB --quantity 1000 [--rate 7000]
 *   node server/scripts/collateralOs.js pledge --token 0x... | --symbol DLB-PRB --quantity 1000 [--rate 7000] [--wallet 0x...] --by trustee@example.com
 *   node server/scripts/collateralOs.js revalue [--position COL-...]
 *   node server/scripts/collateralOs.js release --position COL-... --by trustee@example.com
 *   node server/scripts/collateralOs.js draw --amount 250.00 --reference DRAW-001 [--purpose operating] [--bucket trust_operating] [--position COL-...] --by trustee@example.com
 *   node server/scripts/collateralOs.js reconcile [--by ops@example.com]
 *   node server/scripts/collateralOs.js settle-stage --draw CDR-... [--purpose operating] [--wallet 0x...] [--rail ach_standard]
 *   node server/scripts/collateralOs.js settle-execute --draw CDR-... [--by ops@example.com]
 *   node server/scripts/collateralOs.js repay --draw CDR-... [--amount 100.00] --by trustee@example.com
 *   node server/scripts/collateralOs.js draws [--status funded] [--open]
 *   node server/scripts/collateralOs.js events [--subject CDR-...]
 *
 * Amounts are USD; quantity is whole tokens (use --units for smallest units).
 */

const { CollateralOsEngine } = require('../integrations/os/collateralOsEngine');

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

function requireFlag(args, name, hint) {
  const value = args[name];
  if (!value) throw new Error(`--${name} is required${hint ? `: ${hint}` : ''}`);
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'facility';
  await CollateralOsEngine.ensureTables();

  switch (command) {
    case 'readiness': print('Collateral OS readiness', await CollateralOsEngine.readiness()); break;
    case 'facility': print('Collateral facility', await CollateralOsEngine.facility()); break;
    case 'positions': print('Collateral positions', await CollateralOsEngine.positions({ status: args.status || null })); break;
    case 'quote':
      print('Pledge quote', await CollateralOsEngine.quotePledge({ tokenAddress: args.token, symbol: args.symbol, chainId: args.chain, quantity: args.quantity, quantityUnits: args.units, advanceRateBps: args.rate }));
      break;
    case 'pledge':
      print('Pledged', await CollateralOsEngine.pledge({ tokenAddress: args.token, symbol: args.symbol, chainId: args.chain, quantity: args.quantity, quantityUnits: args.units, advanceRateBps: args.rate, custodyWallet: args.wallet, pledgedBy: requireFlag(args, 'by') }));
      break;
    case 'revalue': print('Revaluation', await CollateralOsEngine.revalue({ positionId: args.position || null, actor: args.by || 'cli' })); break;
    case 'release': print('Released', await CollateralOsEngine.release({ positionId: requireFlag(args, 'position'), actor: requireFlag(args, 'by') })); break;
    case 'draw':
      print('Draw', await CollateralOsEngine.draw({ amountUsd: requireFlag(args, 'amount'), reference: requireFlag(args, 'reference'), purpose: args.purpose, bucket: args.bucket, positionId: args.position, createdBy: requireFlag(args, 'by') }));
      break;
    case 'reconcile': print('Reconcile', await CollateralOsEngine.reconcile({ postedBy: args.by || 'cli' })); break;
    case 'settle-stage':
      print('Settlement staged', await CollateralOsEngine.stageSettlement({ drawId: requireFlag(args, 'draw'), purpose: args.purpose, payoutWallet: args.wallet, rail: args.rail, memo: args.memo }));
      break;
    case 'settle-execute': print('Settlement executed', await CollateralOsEngine.executeSettlement({ drawId: requireFlag(args, 'draw'), createdBy: args.by || 'cli' })); break;
    case 'repay': print('Repayment', await CollateralOsEngine.repay({ drawId: requireFlag(args, 'draw'), amountUsd: args.amount, createdBy: requireFlag(args, 'by') })); break;
    case 'draws': print('Draws', await CollateralOsEngine.draws({ status: args.status || null, open: args.flags.has('open') })); break;
    case 'events': print('Events', await CollateralOsEngine.events({ subjectId: args.subject || null, limit: args.limit })); break;
    default:
      throw new Error(`unknown command ${command}`);
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(`\n[collateral-os] ${err.message}`);
  process.exit(1);
});
