#!/usr/bin/env node
'use strict';

/**
 * Canonical GL Map Wire — build `trust code → Fineract GL id` from live data.
 *
 * Read-only by default: it reconciles the live trust chart, the live
 * fineract_gl_mappings rows, and the ERP's own /glaccounts, then prints a
 * CANONICAL_GL_MAP line covering everything the ERP actually confirms.
 *
 *   node server/scripts/canonicalGlMapWire.js                  # plan the core chart
 *   node server/scripts/canonicalGlMapWire.js --all            # include PTC/CRM/holding accounts
 *   node server/scripts/canonicalGlMapWire.js --codes 1000,1210
 *   node server/scripts/canonicalGlMapWire.js --write          # persist confirmed mappings
 *   node server/scripts/canonicalGlMapWire.js --write --create-missing
 *   node server/scripts/canonicalGlMapWire.js --json           # machine-readable plan
 *
 * Exit code is 1 when the canonical cash/asset accounts cannot be resolved, so
 * this doubles as a deploy gate for the canonical funding rail.
 */

require('dotenv').config();

const { CanonicalGlMapBuilder } = require('../integrations/fineract/canonicalGlMapBuilder');

const STATUS_NOTE = {
  mapped: 'ok',
  discoverable: 'mapping row missing — --write adds it',
  drifted: 'mapping disagrees with the ERP — --write corrects it',
  stale: 'mapped GL id no longer exists — --write --create-missing recreates it',
  absent: 'not in the ERP — --write --create-missing creates it',
  unpostable: 'withheld: cannot be posted to',
  type_mismatch: 'withheld: wrong side of the chart',
  unverified: 'withheld: ERP unreachable, mapping not trusted',
};

function parseArgs(argv) {
  const out = { codes: null, all: false, write: false, createMissing: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') out.all = true;
    else if (arg === '--write') out.write = true;
    else if (arg === '--create-missing') out.createMissing = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--codes') { out.codes = String(argv[i + 1] || '').split(',').map((c) => c.trim()).filter(Boolean); i += 1; } else throw new Error(`unknown argument "${arg}"`);
  }
  return out;
}

function printTable(entries) {
  const pad = (v, n) => String(v === null || v === undefined ? '—' : v).padEnd(n).slice(0, n);
  console.log(`\n${pad('code', 40)} ${pad('type', 10)} ${pad('stored', 7)} ${pad('erp', 7)} ${pad('status', 13)} note`);
  console.log('─'.repeat(120));
  for (const e of entries) {
    console.log(`${pad(e.accountCode, 40)} ${pad(e.accountType, 10)} ${pad(e.storedGlId, 7)} ${pad(e.liveGlId, 7)} ${pad(e.status, 13)} ${e.reason || STATUS_NOTE[e.status] || ''}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const options = { codes: args.codes, includeDynamic: args.all };

  const plan = await CanonicalGlMapBuilder.build(options);

  if (args.json && !args.write) {
    console.log(JSON.stringify(plan, null, 2));
    process.exitCode = plan.ok ? 0 : 1;
    return;
  }

  console.log(`ERP: ${plan.fineractUrl}`);
  console.log(plan.erp.reachable
    ? `ERP reachable — ${plan.erp.glAccounts} GL accounts`
    : `ERP UNREACHABLE — ${plan.erp.error}`);
  printTable(plan.entries);

  if (plan.orphanMappings.length) {
    console.log('\norphan mappings (mapped but no longer in the trust chart):');
    for (const o of plan.orphanMappings) console.log(`  ${o.accountCode} → GL ${o.fineractGlId}`);
  }

  console.log(`\ncoverage: ${JSON.stringify(plan.coverage)}`);
  console.log(`required ${plan.requiredCodes.join(', ')} → ${plan.ok ? 'resolvable' : 'NOT resolvable'}`);
  for (const issue of plan.issues) console.log(`  ! ${issue}`);
  console.log(`\n${plan.envLine || '(no confirmed mappings)'}`);

  if (!args.write) {
    console.log('\nread-only: nothing written. Re-run with --write [--create-missing] to persist.');
    process.exitCode = plan.ok ? 0 : 1;
    return;
  }

  const result = await CanonicalGlMapBuilder.apply({ ...options, createMissing: args.createMissing, plan });
  console.log(`\ncreated ${result.created.length} GL account(s), wrote ${result.written.length} mapping(s), skipped ${result.skipped.length}`);
  for (const c of result.created) console.log(`  [created] ${c.accountCode} ${c.accountName} → GL ${c.fineractGlId}`);
  for (const w of result.written) console.log(`  [mapped ] ${w.accountCode} → GL ${w.fineractGlId}${w.previousGlId ? ` (was ${w.previousGlId})` : ''}`);
  for (const s of result.skipped) console.log(`  [skipped] ${s.accountCode} — ${s.skipReason}`);
  console.log(`\n${result.envLine}`);
  console.log(`required ${plan.requiredCodes.join(', ')} → ${result.ok ? 'resolvable' : 'STILL NOT resolvable'}`);
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
