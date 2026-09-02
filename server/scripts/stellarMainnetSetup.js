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
 *   sources    every Stellar key the trust holds, and what it holds on mainnet:
 *              the question "can we fund this ourselves?", answered by Horizon.
 *   fund       create (or top up) the distributor from one of those accounts.
 *
 * The account is created by *receiving* ~2 XLM, and `fund` can only forward XLM
 * the trust already holds somewhere: if `sources` reports nothing spendable,
 * value must come from outside, which no script can conjure. Every command
 * refuses rather than pretending a step is available.
 *
 * Usage:
 *   node server/scripts/stellarMainnetSetup.js status
 *   node server/scripts/stellarMainnetSetup.js preflight
 *   node server/scripts/stellarMainnetSetup.js trustline --yes
 *   node server/scripts/stellarMainnetSetup.js sources
 *   node server/scripts/stellarMainnetSetup.js fund --yes [--from-env NAME] [--amount 2]
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
const {
  planFunding, spendableXlm, nativeBalance, XLM_FOR_TRUSTLINE,
} = require('../integrations/stablecoin/accountFunding');

/**
 * Where a funding key may live. Secrets are named, never passed as arguments: a
 * seed on a command line lands in shell history and in every `ps` on the box.
 */
const FUNDING_SECRET_ENVS = [
  ['STELLAR_FUNDING_SECRET', 'a dedicated account for paying network fees'],
  ['STABLECOIN_DISTRIBUTOR_SECRET', 'the distributor itself'],
  ['STABLECOIN_ISSUER_SECRET', 'the issuer account, if the trust runs one'],
];

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

/** A named secret, or null: an unset variable is a fact, not an error. */
function loadFundingKey(envName) {
  const secret = String(process.env[envName] || '').trim();
  if (!secret) return null;
  if (!secret.startsWith('S')) {
    throw new Error(`${envName} is set but is not a Stellar secret seed (S…, 56 characters)`);
  }
  return Keypair.fromSecret(secret);
}

/**
 * Every key the trust holds, and what mainnet says it has. This is the answer to
 * "why can't the system send its own 2 XLM": it can, the moment one of these
 * rows shows spendable XLM.
 */
async function sources(ctx) {
  let spendableTotal = 0;
  let found = 0;

  for (const [envName, what] of FUNDING_SECRET_ENVS) {
    const kp = loadFundingKey(envName);
    if (!kp) {
      console.log(`${envName.padEnd(32)}: unset — ${what}`);
      continue;
    }
    found += 1;
    // eslint-disable-next-line no-await-in-loop
    const { exists, account } = await readAccount(ctx.server, kp.publicKey());
    if (!exists) {
      console.log(`${envName.padEnd(32)}: ${kp.publicKey().slice(0, 8)}… does not exist on mainnet`);
      continue;
    }
    const spendable = spendableXlm(account);
    spendableTotal += spendable;
    console.log(
      `${envName.padEnd(32)}: ${kp.publicKey().slice(0, 8)}… holds ${nativeBalance(account)} XLM,`
      + ` ${spendable} spendable after reserve`
    );
  }

  console.log(`\nSpendable on mainnet: ${Number(spendableTotal.toFixed(7))} XLM`);
  if (spendableTotal >= XLM_FOR_TRUSTLINE) {
    console.log('Enough to create the distributor: run `fund --yes`.');
    return 0;
  }
  console.log(
    `Not enough to create an account (${XLM_FOR_TRUSTLINE} XLM needed).`
    + `\n${found ? 'The keys above hold no mainnet value' : 'No funding key is configured'}: XLM must arrive from`
    + '\noutside — an exchange withdrawal or any Stellar wallet — to the distributor'
    + '\ndirectly, or to an account named above.'
  );
  return 2;
}

/**
 * Create the distributor from a funding account the trust holds, or top it up if
 * it already exists. This is the step people assume a script cannot do: it can,
 * given XLM anywhere inside the trust — and only then.
 */
async function fund(ctx, args) {
  if (!ctx.address) throw new Error('STABLECOIN_DISTRIBUTOR_PUBLIC is not set: there is no account to fund');
  if (!args.yes) {
    console.log('Refusing without --yes: this spends real XLM. Run `sources` first to see what is available.');
    return 1;
  }

  const envName = typeof args['from-env'] === 'string' ? args['from-env'] : 'STELLAR_FUNDING_SECRET';
  const kp = loadFundingKey(envName);
  if (!kp) {
    throw new Error(
      `${envName} is not set, so there is no key to send from.`
      + ' Run `sources` to see which keys the trust holds.'
    );
  }
  if (kp.publicKey() === ctx.address) {
    throw new Error(
      `${envName} signs for the distributor itself; an account cannot create or fund itself.`
      + ' Name a different funding account with --from-env.'
    );
  }

  const amount = args.amount === undefined ? XLM_FOR_TRUSTLINE : Number(args.amount);
  const [funder, destination] = await Promise.all([
    readAccount(ctx.server, kp.publicKey()),
    readAccount(ctx.server, ctx.address),
  ]);

  const plan = planFunding({
    source: funder.exists ? funder.account : null,
    destinationExists: destination.exists,
    amount,
  });
  if (!plan.ok) {
    console.log(`Cannot fund ${ctx.address.slice(0, 8)}… from ${kp.publicKey().slice(0, 8)}…:`);
    console.log(`  ${plan.reason}`);
    return 2;
  }

  const operation = plan.operation === 'createAccount'
    ? Operation.createAccount({ destination: ctx.address, startingBalance: plan.amount })
    : Operation.payment({ destination: ctx.address, asset: Asset.native(), amount: plan.amount });

  const tx = new TransactionBuilder(funder.account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.PUBLIC,
  }).addOperation(operation).setTimeout(90).build();
  tx.sign(kp);
  const result = await ctx.server.submitTransaction(tx);

  console.log(
    `${plan.operation === 'createAccount' ? 'Created' : 'Funded'} ${ctx.address}`
    + ` with ${plan.amount} XLM from ${kp.publicKey()} (tx ${result.hash})`
  );
  console.log('Next: `trustline --yes` to trust Circle USDC. The account still holds no USDC.');
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = String(args._[0] || 'status').toLowerCase();
  const ctx = mainnetContext();

  if (command === 'status') return status(ctx);
  if (command === 'trustline') return trustline(ctx, args);
  if (command === 'preflight') return preflight(ctx);
  if (command === 'sources') return sources(ctx);
  if (command === 'fund') return fund(ctx, args);
  throw new Error(`Unknown command "${command}". Use status, sources, fund, trustline or preflight.`);
}

main()
  .then(code => process.exit(Number(code) || 0))
  .catch(error => {
    console.error(`\nFailed: ${error.message}`);
    process.exit(1);
  });
