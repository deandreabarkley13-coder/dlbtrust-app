#!/usr/bin/env node
'use strict';

/**
 * thirdweb Server Wallet Wire
 *
 * Run from the repo root with THIRDWEB_SECRET_KEY in the environment:
 *   node server/scripts/thirdwebServerWalletWire.js [--identifier <id>] [--live]
 *       [--send <to> <quantityWei> [--token <erc20>]] [--wait]
 *
 * What it does, in order:
 *   1. readiness   — config + which gates are open (nothing is sent yet)
 *   2. wallets     — the project's existing server wallets
 *   3. ensure      — reuse the pinned THIRDWEB_SERVER_WALLET_ADDRESS if it is
 *                    one of the project's wallets, else create-or-fetch the
 *                    wallet behind the identifier (idempotent; holds no
 *                    funds, broadcasts nothing)
 *   4. balance     — native balance of that wallet on the configured chain
 *   5. northflank  — the exact set-secrets.mjs command that pins the address
 *                    (and, with --live, flips THIRDWEB_SERVER_WALLET_LIVE)
 *   6. --send      — optional transfer. Shadow unless --live is passed; with
 *                    --wait the script polls the thirdweb transaction to a
 *                    terminal status.
 *
 * Secret values are never printed.
 */

require('dotenv').config();

const { ThirdwebServerWalletEngine } = require('../integrations/dapp/thirdwebServerWalletEngine');

function parseArgs(argv) {
  const out = { live: false, wait: false, send: null, token: null, identifier: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--live') out.live = true;
    else if (arg === '--wait') out.wait = true;
    else if (arg === '--identifier') { out.identifier = argv[i + 1]; i += 1; }
    else if (arg === '--token') { out.token = argv[i + 1]; i += 1; }
    else if (arg === '--send') { out.send = { to: argv[i + 1], quantity: argv[i + 2] }; i += 2; }
    else throw new Error(`unknown argument "${arg}"`);
  }
  return out;
}

function print(title, value) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.live) process.env.THIRDWEB_SERVER_WALLET_LIVE = 'true';
  if (args.identifier) process.env.THIRDWEB_SERVER_WALLET_IDENTIFIER = args.identifier;

  const readiness = ThirdwebServerWalletEngine.readiness();
  print('readiness', readiness);
  if (!readiness.ready) {
    console.error(`\nnot ready: ${readiness.issues.join('; ')}`);
    process.exitCode = 1;
    return;
  }

  const { wallets } = await ThirdwebServerWalletEngine.listWallets({ limit: 20 });
  print('project server wallets', wallets);

  // A pinned address that already exists in the project is reused as-is;
  // ensureWallet only runs when there is nothing to reuse, so the wire never
  // creates a second wallet next to the one the operator pinned.
  const pinned = readiness.address
    ? wallets.find((w) => w.address.toLowerCase() === readiness.address.toLowerCase())
    : null;
  let wallet;
  if (pinned) {
    wallet = { identifier: pinned.identifier || readiness.identifier, address: pinned.address, smartAccountAddress: pinned.smartAccountAddress };
    print('using pinned THIRDWEB_SERVER_WALLET_ADDRESS', wallet);
  } else {
    if (readiness.address) console.warn(`\nwarning: THIRDWEB_SERVER_WALLET_ADDRESS (${readiness.address}) is not a server wallet of this project; creating/fetching "${readiness.identifier}" instead.`);
    wallet = await ThirdwebServerWalletEngine.ensureWallet(readiness.identifier);
    print(`server wallet for identifier "${readiness.identifier}"`, wallet);
  }

  const sender = wallet.address;
  try {
    print(`native balance of ${sender} on chain ${readiness.chainId}`, await ThirdwebServerWalletEngine.balance({ address: sender }));
  } catch (e) {
    console.warn(`\nbalance read failed: ${e.message}`);
  }

  const secrets = [`THIRDWEB_SERVER_WALLET_ADDRESS=${sender}`, `THIRDWEB_SERVER_WALLET_IDENTIFIER=${wallet.identifier || readiness.identifier}`];
  if (args.live) secrets.push('THIRDWEB_SERVER_WALLET_LIVE=true');
  print('northflank: pin the wallet in the runtime secret group', {
    command: `NORTHFLANK_API_TOKEN=... node scripts/northflank/set-secrets.mjs --group dlbtrust-runtime ${secrets.join(' ')}`,
  });

  if (!args.send) {
    console.log(`\nno --send given; wallet wired in ${readiness.live ? 'LIVE' : 'shadow'} mode. Add --send <to> <wei> to transfer.`);
    return;
  }

  const transfer = await ThirdwebServerWalletEngine.send({
    to: args.send.to,
    quantity: args.send.quantity,
    tokenAddress: args.token,
    reference: 'thirdwebServerWalletWire',
  });
  print(transfer.shadow ? 'shadow transfer (nothing sent)' : 'live transfer submitted', transfer);

  if (!transfer.shadow && args.wait && transfer.transactionId) {
    const final = await ThirdwebServerWalletEngine.waitForTransaction(transfer.transactionId);
    print('thirdweb transaction', final);
    if (final.status !== 'CONFIRMED') process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
