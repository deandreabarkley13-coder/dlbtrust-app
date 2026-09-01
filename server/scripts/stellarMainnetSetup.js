#!/usr/bin/env node
'use strict';

/**
 * Bring the distributor to the state a *mainnet* USDC purchase and payout need.
 *
 * Its testnet counterpart (stablecoinTestnetBootstrap.js) can create accounts
 * and buy tokens because test value is worthless. Nothing here creates value:
 *
 *   status     read the account on Horizon and say precisely what is missing —
 *              whether it exists at all, its XLM reserve, whether it trusts
 *              Circle's USDC, and what it holds. Needs no key.
 *   trustline  submit the one transaction the trust can legitimately originate
 *              with no funds: ChangeTrust to Circle's mainnet USDC issuer.
 *   preflight  every gate between here and a purchase, and here and a payout,
 *              as a checklist with what to do about each.
 *
 * The account is created by *receiving* ~1.5 XLM, which no script can conjure;
 * `status` says so rather than pretending a step is available. Fund-and-forget
 * is the one thing this cannot automate.
 *
 * Usage:
 *   node server/scripts/stellarMainnetSetup.js status
 *   node server/scripts/stellarMainnetSetup.js preflight
 *   node server/scripts/stellarMainnetSetup.js trustline --yes
 *
 * Mainnet only, by refusal: a mainnet trustline opened against a testnet
 * configuration would trust the wrong issuer, and this is the step that decides
 * which asset the trust will accept as dollars.
 */

const {
  Keypair, Horizon, TransactionBuilder, Networks, Operation, Asset, BASE_FEE,
} = require('@stellar/stellar-sdk');

const { StablecoinPayoutRail, CIRCLE_USDC_ISSUERS } = require('../integrations/os/stablecoinPayoutRail');
const { getConfig } = require('../integrations/stablecoin/config');

/** Base reserve (1 XLM) + one subentry for the trustline (0.5) + fee headroom. */
const XLM_FOR_TRUSTLINE = 2;

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

/**
 * The mainnet context, or a refusal. The issuer is read from the rail so this
 * script cannot introduce a second opinion about what USDC is.
 */
function mainnetContext() {
  const cfg = getConfig();
  const network = String(cfg.network || '').toLowerCase();
  if (network !== 'mainnet' && network !== 'public') {
    throw new Error(
      `STABLECOIN_NETWORK is "${cfg.network || 'unset'}"; this script only touches mainnet.`
      + ' Set STABLECOIN_NETWORK=mainnet (and HORIZON_URL, if you do not use horizon.stellar.org).'
    );
  }
  const issuer = CIRCLE_USDC_ISSUERS.public;
  if (cfg.issuerPublic && cfg.issuerPublic !== issuer) {
    throw new Error(
      `STABLECOIN_ISSUER_PUBLIC is ${cfg.issuerPublic}, which is not Circle's mainnet USDC issuer (${issuer});`
      + ' trusting it would accept a look-alike asset as dollars'
    );
  }
  return {
    cfg,
    issuer,
    assetCode: cfg.assetCode || 'USDC',
    asset: new Asset(cfg.assetCode || 'USDC', issuer),
    server: new Horizon.Server(cfg.horizonUrl || 'https://horizon.stellar.org'),
    address: cfg.distributorPublic,
  };
}

/** What the chain says about the distributor, with 404 as a fact rather than an error. */
async function readAccount(server, address) {
  try {
    const account = await server.loadAccount(address);
    return { exists: true, account };
  } catch (error) {
    if (error && error.response && error.response.status === 404) {
      return { exists: false, account: null };
    }
    throw error;
  }
}

function describeBalances(account, assetCode, issuer) {
  const balances = account.balances || [];
  const native = balances.find(balance => balance.asset_type === 'native');
  const line = balances.find(balance => (
    balance.asset_code === assetCode && balance.asset_issuer === issuer
  ));
  return {
    xlm: native ? native.balance : '0',
    trustline: Boolean(line),
    usdc: line ? line.balance : null,
    limit: line ? line.limit : null,
  };
}

async function status(ctx) {
  if (!ctx.address) {
    console.log('STABLECOIN_DISTRIBUTOR_PUBLIC is not set: there is no account to inspect.');
    return 1;
  }
  console.log(`Distributor : ${ctx.address}`);
  console.log(`Network     : mainnet (${ctx.server.serverURL.toString()})`);
  console.log(`USDC issuer : ${ctx.issuer} (Circle)`);

  const { exists, account } = await readAccount(ctx.server, ctx.address);
  if (!exists) {
    console.log('\nAccount     : DOES NOT EXIST on mainnet.');
    console.log(
      `\nA Stellar account is created by receiving XLM. Send at least ${XLM_FOR_TRUSTLINE} XLM to the`
      + '\naddress above from an exchange or any Stellar wallet, then run `status` again.'
      + '\nNo script can do this step: it requires value the trust does not yet hold.'
    );
    return 2;
  }

  const held = describeBalances(account, ctx.assetCode, ctx.issuer);
  console.log(`\nAccount     : exists (sequence ${account.sequence})`);
  console.log(`XLM         : ${held.xlm}`);
  console.log(`Trustline   : ${held.trustline ? `yes (limit ${held.limit})` : 'NO — cannot receive USDC yet'}`);
  console.log(`${ctx.assetCode.padEnd(12)}: ${held.trustline ? held.usdc : 'n/a'}`);

  const signers = (account.signers || []).filter(signer => signer.weight > 0);
  console.log(`Signers     : ${signers.map(signer => `${signer.key.slice(0, 8)}…(${signer.weight})`).join(', ')}`);
  console.log(`Thresholds  : low ${account.thresholds.low_threshold},`
    + ` med ${account.thresholds.med_threshold}, high ${account.thresholds.high_threshold}`);

  if (!held.trustline) {
    if (Number(held.xlm) < XLM_FOR_TRUSTLINE) {
      console.log(`\nNext: fund at least ${XLM_FOR_TRUSTLINE} XLM (holds ${held.xlm}), then run \`trustline --yes\`.`);
      return 2;
    }
    console.log('\nNext: run `trustline --yes` to trust Circle USDC, then acquire USDC.');
    return 0;
  }
  if (Number(held.usdc) === 0) {
    console.log('\nNext: acquire USDC. `npm run trust:buy-usdc -- plan` sizes it; the rail pays out only what it holds.');
  }
  return 0;
}

async function trustline(ctx, args) {
  if (!args.yes) {
    console.log('Refusing without --yes: this transaction decides which asset the trust accepts as dollars.');
    return 1;
  }
  const secret = String(ctx.cfg.distributorSecret || '').trim();
  if (!secret.startsWith('S')) {
    throw new Error('STABLECOIN_DISTRIBUTOR_SECRET is required to sign the trustline');
  }
  const kp = Keypair.fromSecret(secret);
  if (ctx.address && kp.publicKey() !== ctx.address) {
    throw new Error(
      `STABLECOIN_DISTRIBUTOR_SECRET signs for ${kp.publicKey()}, not the configured`
      + ` ${ctx.address}; one of the two is from a different wallet`
    );
  }

  const { exists, account } = await readAccount(ctx.server, kp.publicKey());
  if (!exists) {
    throw new Error(
      `${kp.publicKey()} does not exist on mainnet: it must receive at least ${XLM_FOR_TRUSTLINE} XLM first`
    );
  }
  const held = describeBalances(account, ctx.assetCode, ctx.issuer);
  if (held.trustline) {
    console.log(`Already trusts ${ctx.assetCode} from ${ctx.issuer} (limit ${held.limit}); nothing to do.`);
    return 0;
  }
  if (Number(held.xlm) < XLM_FOR_TRUSTLINE) {
    throw new Error(
      `${kp.publicKey()} holds ${held.xlm} XLM; a trustline needs about ${XLM_FOR_TRUSTLINE}`
      + ' for the reserve and fee'
    );
  }

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.PUBLIC,
  }).addOperation(Operation.changeTrust({ asset: ctx.asset })).setTimeout(90).build();
  tx.sign(kp);
  const result = await ctx.server.submitTransaction(tx);
  console.log(`${kp.publicKey()} now trusts ${ctx.assetCode} from ${ctx.issuer} (tx ${result.hash})`);
  console.log('The account can now receive USDC. It still holds none.');
  return 0;
}

async function preflight(ctx) {
  const rail = await StablecoinPayoutRail.readiness();
  console.log('Payout rail');
  console.log(`  ready     : ${rail.ready ? 'yes' : 'no'}`);
  for (const issue of rail.issues || []) console.log(`  blocker   : ${issue}`);
  for (const warning of rail.warnings || []) console.log(`  warning   : ${warning}`);
  console.log(`  wallets   : ${rail.walletCount} registered`);

  if (!ctx.address) {
    console.log('\nChain: STABLECOIN_DISTRIBUTOR_PUBLIC is unset, so no position can be read.');
    return 1;
  }
  const { exists, account } = await readAccount(ctx.server, ctx.address);
  console.log('\nChain');
  if (!exists) {
    console.log('  account   : does not exist — fund it with XLM to create it');
    console.log('  trustline : n/a');
    console.log(`  ${ctx.assetCode.padEnd(10)}: 0 — nothing can be paid out`);
    return 2;
  }
  const held = describeBalances(account, ctx.assetCode, ctx.issuer);
  console.log(`  account   : exists, ${held.xlm} XLM`);
  console.log(`  trustline : ${held.trustline ? 'open' : 'missing — run `trustline --yes`'}`);
  console.log(`  ${ctx.assetCode.padEnd(10)}: ${held.trustline ? held.usdc : '0'}`);

  console.log('\nPurchase routes (STABLECOIN_FUNDING_SOURCE)');
  const routes = [
    ['circle_mint', 'CIRCLE_MINT_API_KEY', 'wire USD to Circle, then transfer to the distributor'],
    ['exchange', 'STABLECOIN_EXCHANGE_NAME', 'buy at an exchange, withdraw on Stellar'],
    ['stellar_dex', null, 'swap XLM the distributor already holds on the order books'],
    ['onramp', 'ONRAMP_PROVIDER / ONRAMP_API_KEY', 'a signed hosted checkout a trustee completes'],
  ];
  for (const [source, requires, what] of routes) {
    const configured = !requires || requires.split(' / ').every(name => String(process.env[name] || '').trim());
    console.log(`  ${source.padEnd(12)}: ${configured ? 'configured' : `needs ${requires}`} — ${what}`);
  }
  if (held.trustline && Number(held.usdc) > 0) return 0;
  console.log('\nEvery route ends the same way: the purchase posts only once Horizon shows the tokens landed.');
  return 2;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = String(args._[0] || 'status').toLowerCase();
  const ctx = mainnetContext();

  if (command === 'status') return status(ctx);
  if (command === 'trustline') return trustline(ctx, args);
  if (command === 'preflight') return preflight(ctx);
  throw new Error(`Unknown command "${command}". Use status, trustline or preflight.`);
}

main()
  .then(code => process.exit(Number(code) || 0))
  .catch(error => {
    console.error(`\nFailed: ${error.message}`);
    process.exit(1);
  });
