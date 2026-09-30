#!/usr/bin/env node
'use strict';

/**
 * Unified Trust Data workflow — one ordered pass over Custody, Private Equity
 * Holdings, Pledge, Collateral, Enterprise Credit, Enterprise Capacity, Credit,
 * Attestation, the trust ledger, the cash module and the network path, stored
 * as a unified snapshot.
 *
 * Run from the repo root:
 *   node server/scripts/unifiedTrustDataWorkflow.js                                  # latest snapshot (read-only)
 *   node server/scripts/unifiedTrustDataWorkflow.js --run --actor <id> [--sync-ledger]
 *   node server/scripts/unifiedTrustDataWorkflow.js --reseal-chains --reason "<why>" --actor <id>
 *   ... [--json] [--strict]
 *
 * --sync-ledger aligns trust_accounts.balance with posted journal lines
 * (reconcileTrustBalances --apply); no journal entry is posted and no money
 * moves. With --strict the exit code is 2 when any consistency check fails.
 */

require('dotenv').config();

const { UnifiedTrustDataOsEngine } = require('../integrations/os/unifiedTrustDataOsEngine');

const VALUE_FLAGS = { '--actor': 'actor', '--reason': 'reason' };

function parseArgs(argv) {
  const out = { action: 'latest', json: false, strict: false, syncLedger: false, fields: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--strict') out.strict = true;
    else if (arg === '--sync-ledger') out.syncLedger = true;
    else if (arg === '--run') out.action = 'run';
    else if (arg === '--reseal-chains') out.action = 'reseal';
    else if (VALUE_FLAGS[arg]) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} requires a value`);
      out.fields[VALUE_FLAGS[arg]] = next;
      i += 1;
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (out.action !== 'latest' && !out.fields.actor) throw new Error('--actor is required');
  if (out.action === 'reseal' && !out.fields.reason) throw new Error('--reseal-chains requires --reason');
  return out;
}

function printSnapshot(s) {
  if (!s) { console.log('no unified snapshot yet (run with --run --actor <id>)'); return; }
  console.log(`== unified trust data ${s.snapshotId} (${s.createdAt}, by ${s.runBy}) ==`);
  console.log('-- ledger (posted journal lines)' + (s.ledger.synced ? ' [trust_accounts synced]' : ''));
  for (const [key, a] of Object.entries(s.ledger.accounts)) if (a) console.log(`  ${a.accountCode} ${key.padEnd(18)} ${a.balance.toFixed(2)}`);
  if (s.cash) console.log(`-- cash module ${Number(s.cash.cashModuleTotal).toFixed(2)} vs trust ledger ${Number(s.cash.trustAccountingTotal).toFixed(2)}`);
  if (s.custody) console.log(`-- custody held ${s.custody.held}  third-party receipted ${s.custody.thirdPartyReceipted}  self-custody ${s.custody.selfCustody}  unreceipted ${s.custody.unreceipted}`);
  const b = s.backing;
  console.log(`-- backing  PE eligible collateral ${b.peEligibleCollateral}  intra-trust book ${b.intraTrust.book} (collateral: ${b.intraTrust.countsAsCollateral})`);
  if (b.pledges) console.log(`   pledges ${b.pledges.total} (${b.pledges.counted} counted, ${b.pledges.countedValue})  liens ${(b.pledges.liens || []).join(', ') || '-'}`);
  if (b.collateralOs) console.log(`   Collateral OS collateral ${b.collateralOs.collateral}  spendable ${b.collateralOs.spendable}  drawn ${b.collateralOs.drawn}`);
  if (b.intraCapacity) console.log(`   Intra capacity (self custody ${b.intraCapacity.selfCustody} @ ${b.intraCapacity.intraRateBps} bps) ${b.intraCapacity.capacity}  earmarked ${b.intraCapacity.earmarked}  available ${b.intraCapacity.available}  (collateral: false)`);
  if (b.enterpriseCredit) console.log(`   Enterprise Credit capacity ${b.enterpriseCredit.capacity}  used ${b.enterpriseCredit.used}  available ${b.enterpriseCredit.available}`);
  if (s.attestation) console.log(`-- attestation attested ${s.attestation.attested}  claimed ${s.attestation.claimed}  variance ${s.attestation.variance}`);
  if (s.network) console.log(`-- network ${s.network.path ? `${s.network.path.vpcConnector} -> ${s.network.path.nat} (${s.network.path.staticIp})` : '-'}  vpn ${s.network.vpn.configured ? `${s.network.vpn.gateway} x${s.network.vpn.tunnels}` : 'not provisioned'}`);
  console.log('-- checks');
  for (const c of s.checks) console.log(`  ${c.ok ? 'ok ' : 'BRK'} ${c.check}: ${c.detail}`);
  for (const st of s.steps.filter((x) => !x.ok)) console.log(`  ERR ${st.name}: ${st.error}`);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  let result;
  if (args.action === 'run') result = await UnifiedTrustDataOsEngine.run({ actor: args.fields.actor, syncLedger: args.syncLedger });
  else if (args.action === 'reseal') result = await UnifiedTrustDataOsEngine.resealChains({ actor: args.fields.actor, reason: args.fields.reason });
  else result = await UnifiedTrustDataOsEngine.latest();

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else if (args.action === 'reseal') {
    for (const [name, r] of Object.entries(result)) {
      console.log(`${name.padEnd(18)} ${r.error ? `ERR ${r.error}` : r.skipped ? `intact (${r.events} events)` : `resealed ${r.rewritten}/${r.events}, intact=${r.chain ? r.chain.intact : r.intact}`}`);
    }
  } else printSnapshot(result);

  const failed = args.action === 'reseal'
    ? Object.values(result).some((r) => r.error || (r.chain && !r.chain.intact))
    : Boolean(result && result.checks.some((c) => !c.ok));
  if (args.strict && failed) process.exitCode = 2;
  return result;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`unifiedTrustDataWorkflow failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, main };
