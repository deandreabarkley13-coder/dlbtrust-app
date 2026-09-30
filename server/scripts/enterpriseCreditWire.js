#!/usr/bin/env node
'use strict';

/**
 * Enterprise Credit OS Wire — asset-backed distributions and disbursements.
 *
 * Run from the repo root:
 *   node server/scripts/enterpriseCreditWire.js                          # readiness + capacity (read-only)
 *   node server/scripts/enterpriseCreditWire.js --evaluate --actor <id>  # recompute backing verdicts
 *   node server/scripts/enterpriseCreditWire.js --request --kind distribution --amount 25000 \
 *     --beneficiary "Beneficiary name" --purpose "Q3 distribution" [--bond 1] --actor <maker>
 *   node server/scripts/enterpriseCreditWire.js --approve --allocation ECA-... --approval-ref APR-... --actor <checker>
 *   node server/scripts/enterpriseCreditWire.js --plan --allocation ECA-...
 *   node server/scripts/enterpriseCreditWire.js --disburse --allocation ECA-... --bank-reference <ref> --actor <id>
 *   ... [--json] [--strict]
 *
 * --plan prints the screened maker/checker fundSettlementAccount.js pipeline
 * command that sends the wire. Nothing here books GL lines, edits balances or
 * sends a wire. With --strict the exit code is 2 when any blocker remains.
 */

require('dotenv').config();

const { EnterpriseCreditOsEngine } = require('../integrations/os/enterpriseCreditOsEngine');

const ACTIONS = ['--evaluate', '--request', '--approve', '--plan', '--disburse', '--repay', '--cancel'];
const VALUE_FLAGS = {
  '--actor': 'actor',
  '--kind': 'kind',
  '--amount': 'amount',
  '--beneficiary': 'beneficiary',
  '--purpose': 'purpose',
  '--bond': 'bondId',
  '--allocation': 'allocationId',
  '--approval-ref': 'approvalRef',
  '--bank-reference': 'bankReference',
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
  if (out.action && out.action !== 'plan' && !out.fields.actor) throw new Error(`--${out.action} requires --actor <id>`);
  if (['approve', 'plan', 'disburse', 'repay', 'cancel'].includes(out.action) && !out.fields.allocationId) throw new Error(`--${out.action} requires --allocation <id>`);
  if (out.action === 'request') {
    for (const f of ['kind', 'amount', 'beneficiary', 'purpose']) if (!out.fields[f]) throw new Error(`--request requires --${f}`);
    out.fields.amountCents = toCents(out.fields.amount);
    delete out.fields.amount;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const f = args.fields;
  let result = null;
  if (args.action === 'plan') result = await EnterpriseCreditOsEngine.fundingPlan({ allocationId: f.allocationId });
  else if (args.action) result = await EnterpriseCreditOsEngine.process({ action: args.action, ...f });
  const readiness = await EnterpriseCreditOsEngine.readiness();
  const { status } = readiness;

  if (args.json) {
    console.log(JSON.stringify({
      readiness: { ready: readiness.ready, mode: readiness.mode, blockers: readiness.blockers, warnings: readiness.warnings },
      capacity: status.capacity, summary: status.summary, result,
    }, null, 2));
  } else {
    console.log(`\n== readiness (${readiness.mode}, ${readiness.ready ? 'ready' : `${readiness.blockers.length} blocking`}) ==`);
    for (const b of readiness.blockers) console.log(`  BLK ${b}`);
    for (const w of readiness.warnings) console.log(`  wrn ${w}`);
    console.log(`\n== capacity ==\n${JSON.stringify(status.capacity, null, 2)}`);
    console.log('\n== allocations ==');
    for (const a of status.allocations) {
      console.log(`  ${a.allocationId}  ${a.kind}  $${a.amount}  ${a.beneficiary}  ${a.status}  ${(a.backing && a.backing.verdict) || '-'}`);
    }
    console.log(`\n== summary ==\n${JSON.stringify(status.summary, null, 2)}`);
    if (result) console.log(`\n== ${args.action} ==\n${JSON.stringify(result, null, 2)}`);
  }
  if (!args.strict) return 0;
  return readiness.ready ? 0 : 2;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`enterprise credit wire failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, main };
