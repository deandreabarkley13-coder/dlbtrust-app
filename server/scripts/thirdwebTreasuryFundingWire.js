#!/usr/bin/env node
'use strict';

/**
 * thirdweb Treasury Funding Wire — fund the trust treasury wallet with real
 * on-chain value through thirdweb's Universal Bridge (no Circle/MoonPay
 * credential needed; the project secret key is enough).
 *
 * Run from the repo root with THIRDWEB_SECRET_KEY in the environment:
 *   node server/scripts/thirdwebTreasuryFundingWire.js \
 *     [--amount <fiat>] [--currency USD] [--token <erc20>] [--chain <id>] \
 *     [--source-type trust --source-account 1000] \
 *     [--sync <topUpId>] [--swap <fiat> [--from <token>] [--to <token>]]
 *
 * Steps:
 *   1. readiness  — config and which gates are open
 *   2. balances   — what the treasury wallet actually holds today
 *   3. --amount   — quotes the fiat amount, checks the hold account, and
 *                   creates a hosted thirdweb checkout. The printed link is
 *                   what a trustee completes to deliver tokens on-chain;
 *                   nothing is booked until it settles.
 *   4. --sync     — poll a top-up; on COMPLETED the hold account is swept and
 *                   the journal entry is posted (once).
 *   5. --swap     — rebalance treasury assets (needs THIRDWEB_SERVER_WALLET_LIVE=true).
 *
 * Secret values are never printed.
 */

require('dotenv').config();

const { ThirdwebTreasuryFundingEngine } = require('../integrations/dapp/thirdwebTreasuryFundingEngine');

function parseArgs(argv) {
  const out = { amount: null, currency: undefined, token: undefined, chain: undefined, sourceType: null, sourceAccount: null, sync: null, swap: null, from: undefined, to: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--amount') { out.amount = next; i += 1; } else if (arg === '--currency') { out.currency = next; i += 1; } else if (arg === '--token') { out.token = next; i += 1; } else if (arg === '--chain') { out.chain = next; i += 1; } else if (arg === '--source-type') { out.sourceType = next; i += 1; } else if (arg === '--source-account') { out.sourceAccount = next; i += 1; } else if (arg === '--sync') { out.sync = next; i += 1; } else if (arg === '--swap') { out.swap = next; i += 1; } else if (arg === '--from') { out.from = next; i += 1; } else if (arg === '--to') { out.to = next; i += 1; } else throw new Error(`unknown argument "${arg}"`);
  }
  return out;
}

function print(title, value) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const readiness = ThirdwebTreasuryFundingEngine.readiness();
  print('readiness', readiness);
  if (!readiness.canTopUp) {
    console.error(`\ncannot reach thirdweb: ${readiness.issues.join('; ')}`);
    process.exitCode = 1;
    return;
  }

  print('treasury balances', await ThirdwebTreasuryFundingEngine.treasuryBalances({ chainId: args.chain }));

  if (args.sync) {
    const synced = await ThirdwebTreasuryFundingEngine.syncTopUp(args.sync);
    print(`top-up ${synced.status}${synced.booked ? ' (booked)' : ''}`, synced);
    return;
  }

  if (args.amount) {
    const topUp = await ThirdwebTreasuryFundingEngine.createTopUp({
      amountFiat: args.amount,
      currency: args.currency,
      chainId: args.chain,
      tokenAddress: args.token,
      sourceType: args.sourceType || undefined,
      sourceAccountId: args.sourceAccount || undefined,
    });
    print('top-up created (complete the link to deliver tokens on-chain)', topUp);
    console.log(`\ncheckout: ${topUp.link}`);
    console.log(`then: node server/scripts/thirdwebTreasuryFundingWire.js --sync ${topUp.id}`);
    return;
  }

  if (args.swap) {
    const swap = await ThirdwebTreasuryFundingEngine.swap({
      amountUsd: args.swap,
      fromTokenAddress: args.from,
      toTokenAddress: args.to,
      chainId: args.chain,
    });
    print('swap submitted', swap);
    return;
  }

  print('recent top-ups', await ThirdwebTreasuryFundingEngine.listTopUps({ limit: 10 }));
  console.log('\nno --amount/--sync/--swap given; nothing moved.');
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
