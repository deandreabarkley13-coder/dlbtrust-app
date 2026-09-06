#!/usr/bin/env node
'use strict';

/**
 * Canonical Funding Source Wire — prove the treasury core-banking ERP
 * (Fineract) can authorize and record a funding draw before any rail spends.
 *
 * Run from the repo root:
 *   node server/scripts/canonicalFundingWire.js \
 *     [--account 1000] [--asset 1210] [--check <amountUsd>] \
 *     [--draw <amountUsd> --reference <id>] [--live]
 *
 * Steps:
 *   1. readiness      — ERP URL/tenant, mapped accounts, live gate, circuit state
 *   2. gl-map         — trust account code → Fineract GL id
 *   3. position       — canonical GL vs sub-ledger, drift, available after reserve
 *   4. reconciliation — per-account drift report
 *   5. --check        — would this draw be authorized? (reads only)
 *   6. --draw         — withdraw from the operating savings account and post one
 *                       double-entry to both books. Shadow unless --live.
 *
 * Credentials are read from the environment and never printed.
 */

require('dotenv').config();

const { CanonicalFundingSource } = require('../integrations/fineract/canonicalFundingSource');

function parseArgs(argv) {
  const out = { account: undefined, asset: undefined, check: null, draw: null, reference: null, live: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--live') out.live = true;
    else if (arg === '--account') { out.account = next; i += 1; } else if (arg === '--asset') { out.asset = next; i += 1; } else if (arg === '--check') { out.check = next; i += 1; } else if (arg === '--draw') { out.draw = next; i += 1; } else if (arg === '--reference') { out.reference = next; i += 1; } else throw new Error(`unknown argument "${arg}"`);
  }
  return out;
}

function print(title, value) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.live) process.env.CANONICAL_FUNDING_LIVE = 'true';

  const readiness = CanonicalFundingSource.readiness();
  print('readiness', readiness);
  if (!readiness.ready) console.warn(`\nwarning: ${readiness.issues.join('; ')}`);

  print('gl map (trust code → fineract gl id)', await CanonicalFundingSource.glMap());

  try {
    print('canonical position', await CanonicalFundingSource.position({ accountCode: args.account }));
    print('reconciliation', await CanonicalFundingSource.reconcile({
      accountCodes: [args.account, args.asset].filter(Boolean),
    }));
  } catch (err) {
    console.error(`\ncannot read canonical position: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (args.check) {
    try {
      const position = await CanonicalFundingSource.assertAvailable({ amountUsd: args.check, accountCode: args.account });
      console.log(`\n$${Number(args.check)} draw is authorized by the ERP (available $${position.availableBalanceCents / 100}).`);
    } catch (err) {
      console.log(`\n$${Number(args.check)} draw refused: ${err.message} [${err.code}]`);
    }
  }

  if (!args.draw) {
    console.log(`\nno --draw given; nothing moved (${readiness.live ? 'LIVE' : 'shadow'} mode).`);
    return;
  }

  const result = await CanonicalFundingSource.commit({
    amountUsd: args.draw,
    reference: args.reference || `WIRE-${Date.now()}`,
    cashAccountCode: args.account,
    assetAccountCode: args.asset,
    memo: 'Canonical funding wire check',
  });
  print(result.committed ? 'draw committed to both books' : 'draw planned (nothing moved)', result);
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
