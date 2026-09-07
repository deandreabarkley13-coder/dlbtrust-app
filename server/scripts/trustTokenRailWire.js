#!/usr/bin/env node
'use strict';

/**
 * Trust Token Rail Wire — move fixed-income value on chain and out to a
 * beneficiary expense wallet with no bank in the loop, signing everything
 * from the thirdweb Vault-held server wallet.
 *
 * Run from the repo root:
 *   node server/scripts/trustTokenRailWire.js --status
 *   node server/scripts/trustTokenRailWire.js --plan --issue 25 --beneficiary "wire check" --purpose medical
 *   node server/scripts/trustTokenRailWire.js --run  --issue 25 --distribute 10 --beneficiary "wire check" \
 *       --purpose medical --role trustee --by trustee-a --approve trustee-b [--bond 1] [--json]
 *   node server/scripts/trustTokenRailWire.js --reconcile [--run-id TTR-...]
 *
 * Stages of a run:
 *   position         the fixed-income position the value comes from (ledger)
 *   bond_token       the position's on-chain claim (BondToken via factory)
 *   issuance         maker/checker ticket, cap control, mint of bond units
 *   trust_token      PtcBackedStablecoin + PtcReserveVault, bond token accepted as reserve
 *   reserve_deposit  bond units into the vault → trust token minted to treasury
 *   distribution     whitelist + send trust token to the beneficiary's expense wallet, book on confirm
 *   evidence         Fabric notarization of the whole run
 *   reconcile        ledger vs chain vs vault vs holders vs books vs Fabric
 *
 * Shadow unless DAPP_SIGNER=thirdweb, THIRDWEB_SERVER_WALLET_LIVE=true and
 * BOND_TOKEN_SHADOW=false: shadow runs plan every stage, notarize the plan and
 * reconcile, but deploy nothing, mint nothing and send nothing.
 * Exit code 2 when a run fails or reconciliation finds a discrepancy.
 */

require('dotenv').config();

const { TrustTokenRailEngine } = require('../integrations/dapp/trustTokenRailEngine');

function parseArgs(argv) {
  const out = {
    mode: null, issue: null, distribute: null, beneficiary: null, purpose: null, role: 'trustee',
    by: 'trustee-a', approve: 'trustee-b', bond: null, runId: null, memo: null, json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    const take = (key) => { out[key] = next; i += 1; };
    if (arg === '--status' || arg === '--plan' || arg === '--run' || arg === '--reconcile') out.mode = arg.slice(2);
    else if (arg === '--json') out.json = true;
    else if (arg === '--issue') take('issue');
    else if (arg === '--distribute') take('distribute');
    else if (arg === '--beneficiary') take('beneficiary');
    else if (arg === '--purpose') take('purpose');
    else if (arg === '--role') take('role');
    else if (arg === '--by') take('by');
    else if (arg === '--approve') take('approve');
    else if (arg === '--bond') take('bond');
    else if (arg === '--run-id') take('runId');
    else if (arg === '--memo') take('memo');
    else throw new Error(`unknown argument "${arg}"`);
  }
  if (!out.mode) out.mode = 'status';
  return out;
}

function print(title, value) {
  console.log(`\n== ${title} ==`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function requestFrom(args) {
  return {
    bondId: args.bond, issueUsd: args.issue === null ? undefined : Number(args.issue),
    distributeUsd: args.distribute === null ? undefined : Number(args.distribute),
    beneficiary: args.beneficiary, purpose: args.purpose, requesterRole: args.role,
    initiatedBy: args.by, approvedBy: args.approve, memo: args.memo,
  };
}

function stageLine(stage) {
  const marks = { done: 'ok', shadow: 'shadow', skipped: 'skip', failed: 'FAIL', discrepancies: 'DISCREPANCY', pending: '...' };
  const tail = stage.error ? ` — ${stage.error}` : '';
  return `  [${marks[stage.status] || stage.status}] ${stage.name}${tail}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === 'status') {
    const status = await TrustTokenRailEngine.status();
    if (args.json) { console.log(JSON.stringify(status, null, 2)); return 0; }
    print('readiness', {
      ready: status.readiness.ready, shadow: status.readiness.shadow, chainId: status.readiness.chainId,
      signer: status.readiness.signer, operator: status.readiness.operator, issues: status.readiness.issues,
    });
    print('trust token', status.trustToken);
    print('bond tokens', status.bondTokens);
    print('pinned prices', status.pinnedPrices);
    print('recent runs', status.recentRuns);
    print('off-ramp', TrustTokenRailEngine.offRamp());
    return 0;
  }

  if (args.mode === 'plan') {
    const plan = TrustTokenRailEngine.plan(requestFrom(args));
    if (args.json) console.log(JSON.stringify(plan, null, 2)); else print('plan', plan);
    return 0;
  }

  if (args.mode === 'reconcile') {
    const run = args.runId ? await TrustTokenRailEngine.getRun(args.runId) : null;
    if (args.runId && !run) throw new Error(`run ${args.runId} not found`);
    const result = await TrustTokenRailEngine.reconcile({ run });
    if (args.json) console.log(JSON.stringify(result, null, 2)); else print('reconcile', result);
    return result.clean ? 0 : 2;
  }

  const run = await TrustTokenRailEngine.run(requestFrom(args));
  if (args.json) { console.log(JSON.stringify(run, null, 2)); } else {
    print(`run ${run.id}`, `status ${run.status} · chain ${run.chainId} · ${run.shadow ? 'SHADOW (nothing deployed, minted or sent)' : 'LIVE'}`);
    console.log(run.stages.map(stageLine).join('\n'));
    print('summary', run.summary);
    const reconcile = run.stages.find((s) => s.name === 'reconcile');
    if (reconcile && reconcile.result) print('reconcile', { clean: reconcile.result.clean, discrepancies: reconcile.result.discrepancies });
  }
  const reconcile = run.stages.find((s) => s.name === 'reconcile');
  return run.status === 'failed' || (reconcile && reconcile.result && !reconcile.result.clean) ? 2 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(`trust token rail wire failed: ${err.message}`);
  process.exit(1);
});
