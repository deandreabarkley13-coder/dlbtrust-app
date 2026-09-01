#!/usr/bin/env node
'use strict';

/**
 * Muxed addresses (`M…`) for the trust's payees.
 *
 * One funded account can serve every beneficiary: each gets a muxed address
 * over the same base account, so nobody has to create an account, hold a 1 XLM
 * reserve or open a USDC trustline of their own. The base account holder is
 * still the party being paid — the id only says whose credit it is in *their*
 * books — so `parse` exists to make that visible before a wallet is registered.
 *
 * Usage:
 *   node server/scripts/stellarMuxed.js create --address G… --id 7
 *   node server/scripts/stellarMuxed.js parse  --address M…
 *   node server/scripts/stellarMuxed.js check  --address M… | G…
 *
 * `check` reads Horizon: whether the base account exists and whether it trusts
 * the configured USDC issuer. A payment to an address whose base has no
 * trustline fails on submission, so this is worth doing before registering a
 * payee in PAYER_OS_WALLETS.
 */

const {
  muxedAddress, parseMuxed, describeAddress,
} = require('../integrations/stablecoin/muxedAccount');
const { getConfig } = require('../integrations/stablecoin/config');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function requireAddress(args) {
  const address = String(args.address || '').trim();
  if (!address) throw new Error('--address is required');
  return address;
}

function create(args) {
  const address = requireAddress(args);
  const id = args.id === undefined ? null : String(args.id);
  if (!id || id === 'true') throw new Error('--id is required: the subaccount id this address routes to');
  const muxed = muxedAddress(address, id);
  console.log(`Base account : ${address}`);
  console.log(`Subaccount id: ${id}`);
  console.log(`Muxed address: ${muxed}`);
  console.log('\nThe base account holds the XLM reserve, the USDC trustline and the balance.');
  console.log('Register the muxed address as a payee wallet; funds are spendable by the base account holder.');
  return 0;
}

function parse(args) {
  const { baseAddress, id } = parseMuxed(requireAddress(args));
  console.log(`Base account : ${baseAddress}`);
  console.log(`Subaccount id: ${id}`);
  return 0;
}

async function check(args) {
  const cfg = getConfig();
  const target = describeAddress(requireAddress(args));
  const base = String(cfg.horizonUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('HORIZON_URL is not configured');

  console.log(`Address      : ${target.address}`);
  console.log(`Kind         : ${target.muxed ? `muxed (id ${target.muxedId})` : 'account'}`);
  console.log(`Base account : ${target.baseAddress}`);

  const response = await fetch(`${base}/accounts/${target.baseAddress}`);
  if (response.status === 404) {
    console.log(`Account      : does not exist on ${cfg.network}; it must receive XLM before it can be paid`);
    return 2;
  }
  if (!response.ok) throw new Error(`Horizon returned ${response.status}`);
  const account = await response.json();
  const line = (account.balances || []).find(balance => (
    balance.asset_code === cfg.assetCode && balance.asset_issuer === cfg.issuerPublic
  ));
  console.log(`Account      : exists on ${cfg.network}`);
  console.log(`Trustline    : ${line ? `open, holding ${line.balance} ${cfg.assetCode}` : `no ${cfg.assetCode} trustline — a payment would fail`}`);
  return line ? 0 : 2;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = String(args._[0] || '').toLowerCase();
  if (command === 'create') return create(args);
  if (command === 'parse') return parse(args);
  if (command === 'check') return check(args);
  throw new Error(`Unknown command "${command || 'none'}". Use create, parse or check.`);
}

main()
  .then(code => process.exit(Number(code) || 0))
  .catch(error => {
    console.error(`\nFailed: ${error.message}`);
    process.exit(1);
  });
