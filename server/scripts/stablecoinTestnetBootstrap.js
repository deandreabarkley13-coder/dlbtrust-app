#!/usr/bin/env node
'use strict';

/**
 * Bring a Stellar *testnet* account to the state the USDC payout rail needs.
 *
 * Payer OS reads a position rather than assuming one, so before a
 * `stablecoin_payout` can be planned the distributor has to exist, hold a
 * trustline to Circle's testnet USDC issuer, and actually hold some of it. That
 * is three chain operations and no ledger opinion, which is all this script is:
 *
 *   keypair   generate a disposable testnet keypair (prints the secret — it is
 *             a throwaway, and belongs in your env, never in the repo)
 *   fund      ask friendbot for test XLM, so the account exists and can pay fees
 *   trustline open the USDC trustline for the configured issuer, signing with
 *             the account's own secret (Circle's faucet cannot pay an account
 *             that does not trust the asset yet)
 *   buy       swap test XLM for test USDC on the testnet DEX, for when
 *             faucet.circle.com is inconvenient to drive by hand
 *
 * Usage:
 *   node server/scripts/stablecoinTestnetBootstrap.js keypair
 *   node server/scripts/stablecoinTestnetBootstrap.js fund --address G…
 *   node server/scripts/stablecoinTestnetBootstrap.js trustline --secret S…
 *   node server/scripts/stablecoinTestnetBootstrap.js buy --secret S… --amount 5
 *
 * Testnet only, by refusal: every command checks the configured network first,
 * because none of this is appropriate for an account holding real USDC. Mainnet
 * accounts are funded by Circle and their trustlines opened deliberately, not by
 * a convenience script.
 */

const {
  Keypair, Horizon, TransactionBuilder, Networks, Operation, Asset, BASE_FEE,
} = require('@stellar/stellar-sdk');

const { StablecoinPayoutRail } = require('../integrations/os/stablecoinPayoutRail');

const FRIENDBOT_URL = 'https://friendbot.stellar.org';

function parseArgs(argv) {
  const args = { flags: new Set(), _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args.flags.add(key);
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

/** The rail's own view of the asset, so this script cannot invent an issuer. */
async function testnetContext() {
  const readiness = await StablecoinPayoutRail.readiness();
  if (readiness.network !== 'testnet') {
    throw new Error(
      `This script only touches testnet accounts; the rail is configured for ${readiness.network || 'no network'}`
    );
  }
  if (!readiness.issuer) {
    throw new Error('No USDC issuer is configured (STABLECOIN_ISSUER_PUBLIC)');
  }
  return {
    asset: new Asset(readiness.asset, readiness.issuer),
    server: new Horizon.Server(readiness.horizonUrl),
    issuer: readiness.issuer,
    assetCode: readiness.asset,
  };
}

function requireSecret(args) {
  const secret = args.secret;
  if (!secret || !secret.startsWith('S')) {
    throw new Error("--secret is required: the account's own secret key, which signs for itself");
  }
  return Keypair.fromSecret(secret);
}

async function submit(server, kp, operation) {
  const account = await server.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  }).addOperation(operation).setTimeout(60).build();
  tx.sign(kp);
  return server.submitTransaction(tx);
}

async function usdcBalance(server, address, assetCode, issuer) {
  const account = await server.loadAccount(address);
  const line = (account.balances || []).find(balance => (
    balance.asset_code === assetCode && balance.asset_issuer === issuer
  ));
  return line ? line.balance : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = (args._[0] || 'keypair').toLowerCase();

  if (command === 'keypair') {
    const kp = Keypair.random();
    console.log(`public ${kp.publicKey()}`);
    console.log(`secret ${kp.secret()}`);
    console.log('\nA disposable testnet keypair. Put the secret in your environment, not in git.');
    return;
  }

  const { asset, server, issuer, assetCode } = await testnetContext();

  if (command === 'fund') {
    const address = args.address;
    if (!address) throw new Error('--address is required');
    const res = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(address)}`);
    if (!res.ok) throw new Error(`Friendbot refused ${address}: HTTP ${res.status}`);
    console.log(`${address} funded with test XLM`);
    return;
  }

  if (command === 'trustline') {
    const kp = requireSecret(args);
    const existing = await usdcBalance(server, kp.publicKey(), assetCode, issuer);
    if (existing !== null) {
      console.log(`${kp.publicKey()} already trusts ${assetCode} from ${issuer} (balance ${existing})`);
      return;
    }
    const res = await submit(server, kp, Operation.changeTrust({ asset }));
    console.log(`${kp.publicKey()} now trusts ${assetCode} from ${issuer} (tx ${res.hash})`);
    console.log(`\nRequest test ${assetCode} at https://faucet.circle.com, or run \`buy --secret … --amount 5\`.`);
    return;
  }

  if (command === 'buy') {
    const kp = requireSecret(args);
    const want = args.amount || '5';
    const paths = await server.strictReceivePaths([Asset.native()], asset, want).call();
    if (!paths.records.length) {
      throw new Error(`No testnet DEX path from XLM to ${assetCode}; use https://faucet.circle.com instead`);
    }
    const best = paths.records[0];
    const res = await submit(server, kp, Operation.pathPaymentStrictReceive({
      sendAsset: Asset.native(),
      sendMax: (Number(best.source_amount) * 1.2).toFixed(7),
      destination: kp.publicKey(),
      destAsset: asset,
      destAmount: want,
      path: best.path.map(hop => (hop.asset_type === 'native'
        ? Asset.native()
        : new Asset(hop.asset_code, hop.asset_issuer))),
    }));
    console.log(`Bought ${want} ${assetCode} for about ${best.source_amount} XLM (tx ${res.hash})`);
    console.log(`${kp.publicKey()} now holds ${await usdcBalance(server, kp.publicKey(), assetCode, issuer)} ${assetCode}`);
    return;
  }

  throw new Error(`Unknown command "${command}". Commands: keypair, fund, trustline, buy`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => {
    const detail = err.response && err.response.data
      ? JSON.stringify(err.response.data.extras || err.response.data)
      : err.message;
    console.error(`\nFailed: ${detail}`);
    process.exit(1);
  });
}

module.exports = { main };
