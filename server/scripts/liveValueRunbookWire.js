#!/usr/bin/env node
'use strict';

/**
 * Live Value Runbook Wire — the single automated entry point for
 * docs/LIVE_VALUE_RUNBOOK.md §2–§4: readiness, gated plan, gated execution.
 *
 * Run from the repo root:
 *   node server/scripts/liveValueRunbookWire.js                       # readiness + pipeline (read-only)
 *   node server/scripts/liveValueRunbookWire.js --plan --amount 250 [--role beneficiary|trustee] [--purpose <purpose>]
 *   node server/scripts/liveValueRunbookWire.js --execute --amount 250 [--role ...] [--purpose ...] [--live]
 *   ... [--json] [--strict]
 *
 * Steps:
 *   1. readiness  — every runbook gate (thirdweb API, server wallet, live flags, ERP,
 *                   policy contract, signer, collateral, treasury ETH/USDC, fundingEligible)
 *   2. pipeline   — unified ERP → policy contract → Spritz → settlement view
 *   3. --plan     — ordered steps to move --amount, each executable or blocked-with-reason
 *   4. --execute  — run the executable steps in order; STOPS at the first human step
 *                   (the §4a hosted checkout, a checker approval) or closed gate.
 *
 * Shadow by default: --execute moves nothing unless --live is passed AND every
 * relevant *_LIVE gate is set. With --strict the exit code is 2 when any blocking
 * gate is closed or execution stopped, so it can gate a deploy. Secret values are
 * never printed — only whether they are configured.
 */

require('dotenv').config();

const { LiveValueRunbookOsEngine } = require('../integrations/os/liveValueRunbookOsEngine');

function parseArgs(argv) {
  const out = { plan: false, execute: false, amount: null, role: 'beneficiary', purpose: null, live: false, json: false, strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--json') out.json = true;
    else if (arg === '--strict') out.strict = true;
    else if (arg === '--plan') out.plan = true;
    else if (arg === '--execute') out.execute = true;
    else if (arg === '--live') out.live = true;
    else if (arg === '--amount') { out.amount = next; i += 1; } else if (arg === '--role') { out.role = next; i += 1; } else if (arg === '--purpose') { out.purpose = next; i += 1; } else throw new Error(`unknown argument "${arg}"`);
  }
  if ((out.plan || out.execute) && !(Number(out.amount) > 0)) throw new Error('--plan / --execute require --amount <usd>');
  if (!['beneficiary', 'trustee'].includes(out.role)) throw new Error('--role must be beneficiary or trustee');
  return out;
}

function print(title, value) {
  console.log(`\n== ${title} ==`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

async function unifiedPipeline() {
  try {
    const os = require('../integrations/os/osEngine');
    return await os.unifiedPipeline({ limit: 20 });
  } catch (e) {
    return { error: e.message };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const readiness = await LiveValueRunbookOsEngine.readinessFull();
  const pipeline = args.plan || args.execute ? null : await unifiedPipeline();
  let plan = null;
  let execution = null;
  if (args.execute) {
    execution = await LiveValueRunbookOsEngine.execute({ amountUsd: Number(args.amount), role: args.role, purpose: args.purpose, live: args.live });
  } else if (args.plan) {
    plan = await LiveValueRunbookOsEngine.plan({ amountUsd: Number(args.amount), role: args.role, purpose: args.purpose });
  }

  if (args.json) {
    console.log(JSON.stringify({ readiness, pipeline, plan, execution }, null, 2));
  } else {
    console.log(`\n== 1. readiness (${readiness.mode}, ${readiness.ready ? 'ready' : `${readiness.blocking.length} blocking`}) ==`);
    for (const s of readiness.stages) {
      const mark = s.ok ? 'ok ' : (s.blocking ? 'BLK' : 'off');
      console.log(`  [${mark}] ${s.key.padEnd(20)} ${s.label}${s.detail ? `\n        ${s.detail}` : ''}`);
    }
    if (!readiness.liveGates.open) console.log(`\n  live gates closed: ${readiness.liveGates.closed.join(', ')}`);
    if (readiness.errors.length) console.log(`  errors: ${readiness.errors.join('; ')}`);
    console.log(`  treasury: ${readiness.treasury.address || 'n/a'} eth=${readiness.treasury.eth ?? 'n/a'} usdc=${readiness.treasury.usdc ?? 'n/a'} fundingEligible=${readiness.treasury.fundingEligible ?? 'n/a'} signer=${readiness.signer.type || 'n/a'}`);

    if (pipeline) {
      const view = (r) => (r && r.ok ? { ok: true } : { ok: false, error: r ? r.error : 'n/a' });
      print('2. pipeline', {
        stages: pipeline.stages,
        canonicalFunding: view(pipeline.canonicalFunding),
        treasuryLeg: pipeline.treasuryLeg && pipeline.treasuryLeg.ok ? { ready: pipeline.treasuryLeg.value.ready, stages: (pipeline.treasuryLeg.value.stages || []).map((s) => `${s.ok ? 'ok ' : 'BLK'} ${s.key}`) } : view(pipeline.treasuryLeg),
        controlPlane: pipeline.controlPlane && pipeline.controlPlane.ok ? { blockingGaps: pipeline.controlPlane.value.blockingGaps, gaps: pipeline.controlPlane.value.gaps.length } : view(pipeline.controlPlane),
        collateral: view(pipeline.collateral),
        error: pipeline.error,
      });
    }

    if (plan) {
      console.log(`\n== 3. plan $${plan.amountUsd.toFixed(2)} (${plan.role}${plan.purpose ? `, ${plan.purpose}` : ''}) mode=${plan.mode} ==`);
      for (const s of plan.steps) {
        const mark = s.skip ? 'skp' : (s.canExecute ? 'run' : (s.human ? 'HUM' : 'BLK'));
        console.log(`  [${mark}] ${s.section.padEnd(4)} ${s.key.padEnd(10)} ${s.label}${s.reason ? `\n        ${s.reason}` : ''}`);
      }
      if (plan.firstBlocked) console.log(`\n  first blocked: ${plan.firstBlocked.section} ${plan.firstBlocked.key} — ${plan.firstBlocked.reason}`);
      if (!plan.liveGates.open) console.log(`  live gates closed: ${plan.liveGates.closed.join(', ')}`);
    }

    if (execution) {
      console.log(`\n== 4. execute $${execution.amountUsd.toFixed(2)} mode=${execution.mode} moved=${execution.moved} ==`);
      if (execution.shadowReason) console.log(`  ${execution.shadowReason}`);
      for (const r of execution.results) {
        console.log(`  [${r.status.padEnd(7)}] ${(r.section || '').padEnd(4)} ${r.key.padEnd(10)} ${r.message}`);
      }
      console.log(`\n  ${execution.completed ? 'completed' : `STOPPED at ${execution.stoppedAt.section} ${execution.stoppedAt.key}${execution.stoppedAt.human ? ' (human step)' : ''}`}: ${execution.message}`);
    }
  }

  const blocked = readiness.blocking.length > 0
    || (plan && plan.firstBlocked && !plan.firstBlocked.human)
    || (execution && !execution.completed && !(execution.stoppedAt && execution.stoppedAt.human));
  return args.strict && blocked ? 2 : 0;
}

// Exit explicitly: the Postgres pool keeps the event loop alive otherwise.
main().then((code) => process.exit(code)).catch((err) => {
  console.error(`live value runbook wire failed: ${err.message}`);
  process.exit(1);
});
