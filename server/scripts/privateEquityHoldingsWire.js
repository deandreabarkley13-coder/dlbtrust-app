#!/usr/bin/env node
'use strict';

/**
 * Private Equity Holdings Wire — the automated entry point that wires the
 * PFTC-issued private-placement bond to its private-equity asset backing:
 * Private Entity OS (issuer) → Debt OS (private placement) → Custody OS
 * (private_equity positions, countersigned receipts) → Proof of Asset →
 * Collateral OS (equity advance rate).
 *
 * Run from the repo root:
 *   node server/scripts/privateEquityHoldingsWire.js                        # readiness (read-only)
 *   node server/scripts/privateEquityHoldingsWire.js --evaluate [--prove] [--holding PEH-...] --actor <id>
 *   node server/scripts/privateEquityHoldingsWire.js --plan-draw --amount 250000
 *   ... [--json] [--strict]
 *
 * --evaluate re-checks every gate and records each holding's verdict
 * (collateral_eligible or blocked); --prove first records a fresh Proof of
 * Asset for each bond. --plan-draw is read-only: it reports whether --amount
 * fits the eligible collateral and the gated steps that would move it (Collateral
 * OS draw, then the screened maker/checker settlement funding pipeline).
 * Nothing here books GL lines, edits balances, or sends a wire. With --strict
 * the exit code is 2 when any blocker remains.
 */

require('dotenv').config();

const { PrivateEquityHoldingsOsEngine } = require('../integrations/os/privateEquityHoldingsOsEngine');

function parseArgs(argv) {
  const out = { evaluate: false, prove: false, planDraw: false, amount: null, holding: null, actor: null, json: false, strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--json') out.json = true;
    else if (arg === '--strict') out.strict = true;
    else if (arg === '--evaluate') out.evaluate = true;
    else if (arg === '--prove') out.prove = true;
    else if (arg === '--plan-draw') out.planDraw = true;
    else if (arg === '--amount') { out.amount = next; i += 1; } else if (arg === '--holding') { out.holding = next; i += 1; } else if (arg === '--actor') { out.actor = next; i += 1; } else throw new Error(`unknown argument "${arg}"`);
  }
  if (out.prove && !out.evaluate) throw new Error('--prove is only valid with --evaluate');
  if (out.evaluate && !out.actor) throw new Error('--evaluate requires --actor <id>');
  if (out.planDraw && !(Number(out.amount) > 0)) throw new Error('--plan-draw requires --amount <usd>');
  return out;
}

function planDraw(readiness, amountUsd) {
  const amountCents = Math.round(Number(amountUsd) * 100);
  const eligibleCents = readiness.status.summary.eligibleCollateralCents;
  const blockers = [...readiness.blockers];
  if (amountCents > eligibleCents) blockers.push(`requested $${(amountCents / 100).toFixed(2)} exceeds eligible collateral $${(eligibleCents / 100).toFixed(2)}`);
  if (!readiness.status.collateralOs.ready) blockers.push(...readiness.status.collateralOs.issues.map((i) => `collateral-os: ${i}`));
  return {
    amountCents,
    eligibleCollateralCents: eligibleCents,
    executable: blockers.length === 0,
    blockers,
    steps: [
      { step: 'collateral_draw', via: 'POST /api/os/collateral-os/process action=draw (Collateral OS maker/checker)', movesMoney: false },
      { step: 'funding_wire', via: 'server/scripts/fundSettlementAccount.js pipeline --amount <usd> --maker <m> --checker <c> --approval-ref <APR-…> --screening-ref <FCS-…>', movesMoney: true, requires: ['PAYMENT_APPROVAL_THRESHOLD>=2', 'live FCS- screening bound to amount + beneficiary', 'external bank settlement reference before settle'] },
    ],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let evaluation = null;
  if (args.evaluate) {
    evaluation = await PrivateEquityHoldingsOsEngine.evaluate({ holdingId: args.holding, prove: args.prove, actor: args.actor });
  }
  const readiness = await PrivateEquityHoldingsOsEngine.readiness();
  const plan = args.planDraw ? planDraw(readiness, args.amount) : null;
  const { status } = readiness;

  if (args.json) {
    console.log(JSON.stringify({ readiness: { ready: readiness.ready, mode: readiness.mode, blockers: readiness.blockers, warnings: readiness.warnings }, summary: status.summary, evaluation, plan }, null, 2));
  } else {
    console.log(`\n== readiness (${readiness.mode}, ${readiness.ready ? 'ready' : `${readiness.blockers.length} blocking`}) ==`);
    for (const b of readiness.blockers) console.log(`  BLK ${b}`);
    for (const w of readiness.warnings) console.log(`  wrn ${w}`);
    console.log('\n== holdings ==');
    for (const h of status.holdings) {
      console.log(`  ${h.holdingId}  bond #${h.bondId}  ${h.holdingName}  $${h.valuation}  ${h.status}${h.evaluation && h.evaluation.failing.length ? `  [${h.evaluation.failing.join(', ')}]` : ''}`);
    }
    console.log(`\n== summary ==\n${JSON.stringify(status.summary, null, 2)}`);
    if (plan) console.log(`\n== draw plan ==\n${JSON.stringify(plan, null, 2)}`);
  }
  if (!args.strict) return 0;
  return readiness.ready && (!plan || plan.executable) ? 0 : 2;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`private-equity holdings wire failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, planDraw, main };
