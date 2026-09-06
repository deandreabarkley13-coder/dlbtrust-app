#!/usr/bin/env node
'use strict';

/**
 * Beneficiary Expense Wallet Wire
 *
 * Run from the repo root with THIRDWEB_SECRET_KEY in the environment:
 *   node server/scripts/beneficiaryExpenseWalletWire.js \
 *     --beneficiary <name-or-email> [--beneficiary <another> ...] \
 *     [--purposes lifestyle,medical] [--live] \
 *     [--fund <amountUsd> --purpose <p> [--role beneficiary|trustee]
 *      [--source-type trust --source-account 1000] [--token <erc20>]]
 *
 * Steps:
 *   1. readiness  — config plus which gates are open (nothing moves yet)
 *   2. ensure     — one thirdweb server wallet per beneficiary/purpose pair
 *                   (idempotent, holds no funds, broadcasts nothing)
 *   3. balances   — configured-token balance of each expense wallet
 *   4. --fund     — funds one purpose wallet from the trust hold account. The
 *                   hold-account position and the distribution limit are
 *                   checked first; shadow unless --live, in which case the
 *                   hold account is swept and the transfer is submitted.
 *
 * Secret values are never printed.
 */

require('dotenv').config();

const { BeneficiaryExpenseWalletEngine } = require('../integrations/dapp/beneficiaryExpenseWalletEngine');

function parseArgs(argv) {
  const out = { beneficiaries: [], purposes: null, live: false, fund: null, purpose: null, role: 'beneficiary', sourceType: null, sourceAccount: null, token: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--live') out.live = true;
    else if (arg === '--beneficiary') { out.beneficiaries.push(argv[i + 1]); i += 1; }
    else if (arg === '--purposes') { out.purposes = String(argv[i + 1] || '').split(',').map((p) => p.trim()).filter(Boolean); i += 1; }
    else if (arg === '--fund') { out.fund = argv[i + 1]; i += 1; }
    else if (arg === '--purpose') { out.purpose = argv[i + 1]; i += 1; }
    else if (arg === '--role') { out.role = argv[i + 1]; i += 1; }
    else if (arg === '--source-type') { out.sourceType = argv[i + 1]; i += 1; }
    else if (arg === '--source-account') { out.sourceAccount = argv[i + 1]; i += 1; }
    else if (arg === '--token') { out.token = argv[i + 1]; i += 1; }
    else throw new Error(`unknown argument "${arg}"`);
  }
  if (!out.beneficiaries.length) throw new Error('at least one --beneficiary is required');
  return out;
}

function print(title, value) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.live) process.env.THIRDWEB_SERVER_WALLET_LIVE = 'true';

  const readiness = BeneficiaryExpenseWalletEngine.readiness();
  print('readiness', readiness);
  if (!readiness.ready) {
    console.error(`\nnot ready: ${readiness.issues.join('; ')}`);
    process.exitCode = 1;
    return;
  }

  for (const beneficiary of args.beneficiaries) {
    const provisioned = await BeneficiaryExpenseWalletEngine.ensureWallets({ beneficiary, purposes: args.purposes });
    print(`expense wallets for ${beneficiary}`, provisioned.wallets);
    print(`balances for ${beneficiary}`, await BeneficiaryExpenseWalletEngine.balances({ beneficiary }));
  }

  if (!args.fund) {
    console.log(`\nno --fund given; wallets provisioned in ${readiness.live ? 'LIVE' : 'shadow'} mode.`);
    return;
  }

  const funding = await BeneficiaryExpenseWalletEngine.fund({
    beneficiary: args.beneficiaries[0],
    purpose: args.purpose,
    amountUsd: args.fund,
    requesterRole: args.role,
    sourceType: args.sourceType || undefined,
    sourceAccountId: args.sourceAccount || undefined,
    tokenAddress: args.token,
  });
  print(funding.shadow ? 'shadow funding (nothing moved)' : 'live funding submitted', funding);
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
