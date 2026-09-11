#!/usr/bin/env node
'use strict';

/**
 * Collateral OS from a terminal — spendable value against the tokenized RWA.
 *
 *   readiness   what the engine can do right now (oracle, custody wallet, ERP leg, Spritz bank)
 *   facility    collateral value, spendable (advance-rated) value, drawn, available, utilization
 *   pledge      register a custody-held bond token as collateral (off-balance-sheet)
 *   revalue     re-price every pledge; flag / clear a margin call
 *   draw        raise the ERP -> USDC -> policy contract proposal against the facility
 *   reconcile   mark checker-approved draws funded and book DR USDC treasury / CR facility
 *   settle      stage the Spritz off-ramp of a funded draw to the DB NET MGMT bank
 *   execute     release the approved distribution and execute the Spritz quote
 *   repay       reduce a draw (DR facility / CR USDC treasury)
 *   release     hand a pledge back
 *
 * Usage:
 *   node server/scripts/collateralOs.js readiness
 *   node server/scripts/collateralOs.js facility
 *   node server/scripts/collateralOs.js positions [--status pledged]
 *   node server/scripts/collateralOs.js pledge --token DLB-PRB|<tokenId>|0x... [--quantity 1000000] [--wallet 0x...] [--class bond_token] [--advance-bps 7000] [--reference PLEDGE-1] --by trustee@example.com
 *   node server/scripts/collateralOs.js revalue [--by ops@example.com]
 *   node server/scripts/collateralOs.js draw --amount 250000 --reference DRAW-2026-001 --by trustee@example.com [--position COL-...] --bucket coupon_income|trust_operating (funded only from its own segregated source) [--auto-approve]
 *   node server/scripts/collateralOs.js reconcile [--by ops@example.com]
 *   node server/scripts/collateralOs.js draws [--status funded]
 *   node server/scripts/collateralOs.js settle --draw CDR-... --by trustee@example.com [--purpose operating] [--rail ach_standard] [--memo ...]
 *   node server/scripts/collateralOs.js execute --draw CDR-... --by trustee@example.com
 *   node server/scripts/collateralOs.js repay --draw CDR-... [--amount 1000] --by trustee@example.com
 *   node server/scripts/collateralOs.js release --position COL-... --by trustee@example.com [--reason ...]
 *   node server/scripts/collateralOs.js events [--subject COL-...|CDR-...|FACILITY]
 *
 * Amounts are USD.
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

function money(value) {
  return `$${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function requireFlag(args, name, hint) {
  const value = args[name];
  if (!value) throw new Error(`--${name} is required${hint ? `: ${hint}` : ''}`);
  return value;
}

function tokenSelector(value) {
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return { tokenAddress: value };
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value) || /^\d+$/.test(value)) return { tokenId: value };
  return { tokenSymbol: value };
}

function reportFacility(f) {
  console.log(`\nFacility: collateral ${money(f.collateralUsd)} | spendable ${money(f.spendableUsd)} | drawn ${money(f.drawnUsd)} | available ${money(f.availableUsd)} | utilization ${f.utilizationBps} bps${f.marginCall ? ' — MARGIN CALL' : ''}`);
  (f.byPosition || []).forEach((p) => console.log(`  ${p.positionId} ${p.tokenSymbol || ''} [${p.status}] value ${money(p.valueUsd)} @ ${p.advanceRateBps} bps -> ${money(p.spendableUsd)} (drawn ${money(p.drawnUsd)})`));
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0] || 'facility';

  if (command === 'readiness') { print('Collateral OS readiness:', await CollateralOsEngine.readiness()); return; }
  if (command === 'status') { print('Collateral OS:', await CollateralOsEngine.status()); return; }
  if (command === 'facility') { reportFacility(await CollateralOsEngine.facility()); return; }
  if (command === 'positions') { print('Positions:', await CollateralOsEngine.positions({ status: args.status || null, limit: args.limit })); return; }
  if (command === 'draws') { print('Draws:', await CollateralOsEngine.draws({ status: args.status || null, positionId: args.position || null, limit: args.limit })); return; }
  if (command === 'events') { print('Events:', await CollateralOsEngine.events({ subjectId: args.subject || null, limit: args.limit || 100 })); return; }

  if (command === 'pledge') {
    const out = await CollateralOsEngine.pledge({
      ...tokenSelector(requireFlag(args, 'token', 'token symbol, id or address')),
      quantity: args.quantity, quantityUnits: args.units, custodyWallet: args.wallet,
      assetClass: args.class, advanceRateBps: args['advance-bps'], reference: args.reference,
      pledgedBy: requireFlag(args, 'by', 'the trustee pledging'),
    });
    print('Pledged:', out);
    reportFacility(await CollateralOsEngine.facility());
    return;
  }
  if (command === 'revalue') { const out = await CollateralOsEngine.revalue({ actor: args.by || null }); print('Revalued:', out); return; }
  if (command === 'draw') {
    const out = await CollateralOsEngine.draw({
      amountUsd: requireFlag(args, 'amount', 'USD'), positionId: args.position || null, bucket: args.bucket || undefined,
      sourceType: args['source-type'], sourceAccountId: args['source-account'], sourceToken: args['source-token'], sourceModule: args['source-module'],
      reference: requireFlag(args, 'reference', 'ERP reference'), createdBy: requireFlag(args, 'by'), autoApprove: args.flags.has('auto-approve'),
    });
    print('Draw:', out);
    return;
  }
  if (command === 'reconcile') { const out = await CollateralOsEngine.reconcile({ postedBy: args.by || null }); print('Reconciled:', out.draws); reportFacility(out.facility); return; }
  if (command === 'settle') { print('Settling:', await CollateralOsEngine.settle({ drawId: requireFlag(args, 'draw'), purpose: args.purpose, rail: args.rail, memo: args.memo, payoutWallet: args.wallet, actor: requireFlag(args, 'by') })); return; }
  if (command === 'execute') { print('Settled:', await CollateralOsEngine.executeSettlement({ drawId: requireFlag(args, 'draw'), actor: requireFlag(args, 'by') })); return; }
  if (command === 'repay') {
    const out = await CollateralOsEngine.repay({ drawId: requireFlag(args, 'draw'), amountUsd: args.amount, reference: args.reference, actor: requireFlag(args, 'by') });
    print('Repaid:', { drawId: out.drawId, status: out.status, repaidUsd: out.repaidUsd, outstandingUsd: out.outstandingUsd, journal: out.journal });
    reportFacility(out.facility);
    return;
  }
  if (command === 'release') { print('Released:', await CollateralOsEngine.release({ positionId: requireFlag(args, 'position'), actor: requireFlag(args, 'by'), reason: args.reason })); return; }

  throw new Error(`unknown command '${command}'`);
}

if (require.main === module) {
  main().then(() => process.exit(process.exitCode || 0)).catch((err) => {
    console.error(`\n${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
    process.exit(1);
  });
}

module.exports = { main };
