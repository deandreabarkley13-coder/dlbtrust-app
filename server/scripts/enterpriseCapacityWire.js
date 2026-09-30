#!/usr/bin/env node
'use strict';

/**
 * Enterprise Capacity OS Wire — intra-trust capacity of self-custody assets.
 *
 * Run from the repo root:
 *   node server/scripts/enterpriseCapacityWire.js                          # readiness + intra capacity (read-only)
 *   node server/scripts/enterpriseCapacityWire.js --evaluate --actor <id>  # recompute capacity + earmark verdicts
 *   node server/scripts/enterpriseCapacityWire.js --request --amount 250000 --designation "Series A" \
 *     --purpose "Q4 internal allocation" --actor <maker>
 *   node server/scripts/enterpriseCapacityWire.js --approve --allocation ECPA-... --approval-ref APR-... --actor <checker>
 *   node server/scripts/enterpriseCapacityWire.js --release --allocation ECPA-... --actor <id>
 *   node server/scripts/enterpriseCapacityWire.js --cancel --allocation ECPA-... [--reason ...] --actor <id>
 *   ... [--json] [--strict]
 *
 * Nothing here books GL lines, edits balances or sends a wire. With --strict
 * the exit code is 2 when any blocker remains.
 */

require('dotenv').config();

const { EnterpriseCapacityOsEngine } = require('../integrations/os/enterpriseCapacityOsEngine');

const ACTIONS = ['--evaluate', '--request', '--approve', '--release', '--cancel'];
const VALUE_FLAGS = {
  '--actor': 'actor',
  '--amount': 'amount',
  '--designation': 'designation',
  '--purpose': 'purpose',
  '--allocation': 'allocationId',
  '--approval-ref': 'approvalRef',
  '--reason': 'reason',
};

function toCents(usd) {
  const n = Number(usd);
  if (!(n > 0)) throw new Error('--amount must be a positive USD amount');
  return Math.round(n * 100);
}

function parseArgs(argv) {
  const out = { action: null, json: false, strict: false, fields: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--strict') out.strict = true;
    else if (ACTIONS.includes(arg)) {
      if (out.action) throw new Error(`only one of ${ACTIONS.join(', ')} per run`);
      out.action = arg.slice(2);
    } else if (VALUE_FLAGS[arg]) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} requires a value`);
      out.fields[VALUE_FLAGS[arg]] = next;
      i += 1;
    } else throw new Error(`unknown argument "${arg}"`);
  }
  if (out.action && !out.fields.actor) throw new Error(`--${out.action} requires --actor <id>`);
  if (['approve', 'release', 'cancel'].includes(out.action) && !out.fields.allocationId) throw new Error(`--${out.action} requires --allocation <id>`);
  if (out.action === 'request') {
    for (const f of ['amount', 'designation', 'purpose']) if (!out.fields[f]) throw new Error(`--request requires --${f}`);
    out.fields.amountCents = toCents(out.fields.amount);
    delete out.fields.amount;
  }
  return out;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = args.action ? await EnterpriseCapacityOsEngine.process({ action: args.action, ...args.fields }) : null;
  const readiness = await EnterpriseCapacityOsEngine.readiness();
  const { status } = readiness;
  const cap = status.capacity;

  if (args.json) {
    console.log(JSON.stringify({
      readiness: { ready: readiness.ready, mode: readiness.mode, blockers: readiness.blockers, warnings: readiness.warnings },
      capacity: cap, summary: status.summary, result,
    }, null, 2));
  } else {
    console.log(`\n== readiness (${readiness.mode}, ${readiness.ready ? 'ready' : `${readiness.blockers.length} blocking`}) ==`);
    for (const b of readiness.blockers) console.log(`  BLK ${b}`);
    for (const w of readiness.warnings) console.log(`  wrn ${w}`);
    if (cap && !cap.error) {
      console.log('\n== intra capacity (self custody) ==');
      console.log(`  self-custody book   ${cap.selfCustody}  (receipted ${cap.selfCustodyReceipted.usd}, unreceipted ${cap.selfCustodyUnreceipted.usd})`);
      console.log(`  intra capacity      ${cap.capacity}  at ${cap.intraRateBps} bps`);
      console.log(`  earmarked           ${cap.used}   available ${cap.available}`);
      console.log(`  outside receipted   ${cap.outsideReceipted.usd}  (not intra)`);
      if (cap.peIntraTrust) console.log(`  PE intra-trust      ${cap.peIntraTrust.book}  (${cap.peIntraTrust.note})`);
      console.log(`  collateral: ${cap.countsAsCollateral}  Collateral OS base: ${cap.collateralOsBorrowingBase}  Enterprise Credit: ${cap.enterpriseCreditCapacity}`);
      console.log('  by account');
      for (const [id, b] of Object.entries(cap.byAccount)) console.log(`    ${id.padEnd(28)} ${String(b.positions).padStart(3)} pos  book ${b.book}  receipted ${b.receipted}`);
      console.log('  by asset class');
      for (const [k, b] of Object.entries(cap.byAssetClass)) console.log(`    ${k.padEnd(28)} ${String(b.positions).padStart(3)} pos  book ${b.book}  receipted ${b.receipted}`);
    } else if (cap) console.log(`\n== intra capacity unavailable: ${cap.error} ==`);
    console.log('\n== intra allocations ==');
    for (const a of status.allocations) {
      console.log(`  ${a.allocationId}  $${a.amount}  ${a.designation}  ${a.status}  ${(a.verdict && a.verdict.verdict) || '-'}`);
    }
    if (result) console.log(`\n== ${args.action} ==\n${JSON.stringify(result, (k, v) => (k === 'positions' && Array.isArray(v) ? v.length : v), 2)}`);
  }
  if (!args.strict) return 0;
  return readiness.ready ? 0 : 2;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`enterprise capacity wire failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, main };
