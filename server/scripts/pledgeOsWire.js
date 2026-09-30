#!/usr/bin/env node
'use strict';

/**
 * Pledge OS Wire — records pledges with their lien evidence and evaluates each
 * pledge's backing (Private Equity Holdings OS holding, Custody OS position,
 * or a bond looked through to its eligible private-equity holdings), then
 * reports how much of the Collateral OS borrowing base the counted pledges back.
 *
 * Run from the repo root:
 *   node server/scripts/pledgeOsWire.js                                   # readiness + coverage (read-only)
 *   node server/scripts/pledgeOsWire.js --evaluate [--pledge PLG-...] --actor <id>
 *   node server/scripts/pledgeOsWire.js --record --reference PLEDGE-DLB-PRB-1 \
 *     --asset "DLB-PRB private placement bond" --pledgor "DEANDREA LAVAR BARKLEY TRUST" \
 *     --secured-party "DEANDREA-LAVAR: BARKLEY" --backing-type bond --backing-ref 1 \
 *     --lien-filing P24000656-2 --lien-jurisdiction US-IA --lien-type UTILITY \
 *     --filing-office "Iowa Secretary of State" --lien-filed-at 2024-03-26 --actor <id>
 *   ... [--json] [--strict]
 *
 * --record then evaluates the recorded pledge. Nothing here books GL lines,
 * edits balances, draws or sends a wire. With --strict the exit code is 2 when
 * any blocker remains.
 */

require('dotenv').config();

const { PledgeOsEngine } = require('../integrations/os/pledgeOsEngine');

const VALUE_FLAGS = {
  '--pledge': 'pledge',
  '--actor': 'actor',
  '--reference': 'reference',
  '--asset': 'assetDescription',
  '--pledgor': 'pledgor',
  '--secured-party': 'securedParty',
  '--backing-type': 'backingType',
  '--backing-ref': 'backingRef',
  '--lien-filing': 'lienFilingNumber',
  '--lien-jurisdiction': 'lienJurisdiction',
  '--lien-type': 'lienFilingType',
  '--filing-office': 'lienFilingOffice',
  '--lien-filed-at': 'lienFiledAt',
};

function parseArgs(argv) {
  const out = { evaluate: false, record: false, json: false, strict: false, pledge: null, actor: null, fields: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--strict') out.strict = true;
    else if (arg === '--evaluate') out.evaluate = true;
    else if (arg === '--record') out.record = true;
    else if (VALUE_FLAGS[arg]) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} requires a value`);
      const key = VALUE_FLAGS[arg];
      if (key === 'pledge' || key === 'actor') out[key] = next; else out.fields[key] = next;
      i += 1;
    } else throw new Error(`unknown argument "${arg}"`);
  }
  if ((out.evaluate || out.record) && !out.actor) throw new Error('--evaluate and --record require --actor <id>');
  if (!out.record && Object.keys(out.fields).length) throw new Error('pledge fields are only valid with --record');
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let recorded = null;
  let evaluation = null;
  if (args.record) {
    recorded = await PledgeOsEngine.record({ ...args.fields, actor: args.actor });
    evaluation = await PledgeOsEngine.evaluate({ pledgeId: recorded.pledgeId, actor: args.actor });
  } else if (args.evaluate) {
    evaluation = await PledgeOsEngine.evaluate({ pledgeId: args.pledge, actor: args.actor });
  }
  const readiness = await PledgeOsEngine.readiness();
  const { status } = readiness;

  if (args.json) {
    console.log(JSON.stringify({
      readiness: { ready: readiness.ready, mode: readiness.mode, blockers: readiness.blockers, warnings: readiness.warnings },
      summary: status.summary, coverage: status.coverage, recorded, evaluation,
    }, null, 2));
  } else {
    console.log(`\n== readiness (${readiness.mode}, ${readiness.ready ? 'ready' : `${readiness.blockers.length} blocking`}) ==`);
    for (const b of readiness.blockers) console.log(`  BLK ${b}`);
    for (const w of readiness.warnings) console.log(`  wrn ${w}`);
    console.log('\n== pledges ==');
    for (const p of status.pledges) {
      const unmet = p.evaluation && p.evaluation.unmet && p.evaluation.unmet.length ? `  [${p.evaluation.unmet.join(', ')}]` : '';
      console.log(`  ${p.pledgeId}  ${p.reference}  ${p.backingType}:${p.backingRef}  lien ${p.lien.filingNumber} (${p.lien.jurisdiction})  $${p.counted}  ${p.status}${unmet}`);
    }
    console.log(`\n== summary ==\n${JSON.stringify(status.summary, null, 2)}`);
    console.log(`\n== collateral coverage ==\n${JSON.stringify(status.coverage, null, 2)}`);
  }
  if (!args.strict) return 0;
  return readiness.ready ? 0 : 2;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`pledge os wire failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, main };
