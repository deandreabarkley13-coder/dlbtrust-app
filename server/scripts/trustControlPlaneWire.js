#!/usr/bin/env node
'use strict';

/**
 * Trust Control Plane Wire — read every component the trust runs on, evaluate
 * the beneficiary-support pipeline against the Trust Mandate, and list every
 * gap. Optionally evaluate one hypothetical distribution.
 *
 * Run from the repo root:
 *   node server/scripts/trustControlPlaneWire.js [--evaluate <amountUsd>] [--role beneficiary|trustee]
 *     [--purpose <purpose>] [--json] [--strict]
 *
 * Steps:
 *   1. mandate     — who the platform acts for, roles, funding policy, authorities
 *   2. readiness   — Fineract, sub-ledger, fixed income, custodian, issuer, thirdweb,
 *                    Fabric, FireFly, Northflank, VM: configured? live?
 *   3. snapshot    — balances from each authority (fetched independently)
 *   4. pipeline    — income → distributable → policy → funding → notarize → settle →
 *                    confirm → book → reconcile, each ok / gap / unavailable
 *   5. --evaluate  — would a distribution of this size clear the mandate?
 *
 * Read-only: nothing is notarized, transferred or booked. With --strict the
 * exit code is 2 when any high-severity gap is present, so it can gate a deploy.
 */

require('dotenv').config();

const { TrustControlPlaneEngine } = require('../integrations/trust/trustControlPlaneEngine');

function parseArgs(argv) {
  const out = { evaluate: null, role: 'beneficiary', purpose: null, json: false, strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--json') out.json = true;
    else if (arg === '--strict') out.strict = true;
    else if (arg === '--evaluate') { out.evaluate = next; i += 1; } else if (arg === '--role') { out.role = next; i += 1; } else if (arg === '--purpose') { out.purpose = next; i += 1; } else throw new Error(`unknown argument "${arg}"`);
  }
  return out;
}

function print(title, value) {
  console.log(`\n== ${title} ==`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

const usd = (n) => (n === null || n === undefined ? 'n/a' : `$${Number(n).toFixed(2)}`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cp = await TrustControlPlaneEngine.controlPlane();
  let evaluation = null;
  if (args.evaluate !== null) {
    evaluation = await TrustControlPlaneEngine.evaluateDistribution({
      amountUsd: Number(args.evaluate), requesterRole: args.role, purpose: args.purpose, snapshot: cp.snapshot,
    });
  }

  if (args.json) {
    console.log(JSON.stringify({ ...cp, evaluation }, null, 2));
  } else {
    print('1. mandate', {
      legalName: cp.mandate.legalName,
      shortName: cp.mandate.shortName,
      roles: cp.mandate.roles,
      purpose: cp.mandate.purpose,
      fundingPolicy: cp.mandate.fundingPolicy,
      authority: cp.mandate.authority,
    });

    print('2. readiness', Object.fromEntries(Object.entries(cp.components).map(([k, c]) => [k, {
      available: c.available, ready: c.ready, mode: c.mode, issues: c.issues && c.issues.length ? c.issues : undefined,
    }])));

    const s = cp.snapshot;
    const view = (r) => (r.ok ? r.value : { unavailable: r.error });
    print('3. snapshot', {
      fineract: view(s.canonical),
      subLedger: view(s.subLedger),
      fixedIncome: view(s.fixedIncome),
      custodian: view(s.custodian),
      issuer: view(s.issuer),
      distributions: view(s.distributions),
      thirdweb: view(s.thirdweb),
      fabric: view(s.fabric),
      firefly: view(s.firefly),
    });

    console.log('\n== 4. pipeline ==');
    for (const st of cp.pipeline) {
      const mark = st.status === 'ok' ? 'ok ' : (st.status === 'gap' ? 'GAP' : '???');
      console.log(`  [${mark}] ${st.stage.padEnd(13)} ${st.label}`);
    }
    console.log(`\n  distributable income: ${usd(cp.distributable.distributableUsd)} (income ${usd(cp.distributable.incomeUsd)} - reserve ${usd(cp.distributable.reserveUsd)} - distributed 12m ${usd(cp.distributable.distributedTrailing12mUsd)})`);
    if (cp.distributable.corpusDrawUsd > 0) console.log(`  corpus draw: ${usd(cp.distributable.corpusDrawUsd)}`);

    console.log(`\n== gaps (${cp.gaps.length}, ${cp.blockingGaps} high) ==`);
    for (const g of cp.gaps) console.log(`  [${g.severity.padEnd(6)}] ${g.stage || g.component || '-'}: ${g.gap}`);

    if (evaluation) {
      print(`5. evaluate ${usd(evaluation.amountUsd)} (${args.role})`, {
        allowed: evaluation.allowed,
        enforced: evaluation.enforced,
        blocking: evaluation.blocking,
        checks: evaluation.checks.map((c) => `${c.ok ? 'ok ' : (c.blocking ? 'BLK' : 'wrn')} ${c.check}${c.ok ? '' : `: ${c.detail.error || JSON.stringify(c.detail)}`}`),
      });
    }
  }

  const failed = args.strict && (cp.blockingGaps > 0 || (evaluation && !evaluation.allowed));
  return failed ? 2 : 0;
}

// Exit explicitly: the Postgres pool keeps the event loop alive otherwise.
main().then((code) => process.exit(code)).catch((err) => {
  console.error(`trust control plane wire failed: ${err.message}`);
  process.exit(1);
});
