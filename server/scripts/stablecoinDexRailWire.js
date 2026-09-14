#!/usr/bin/env node
'use strict';

/**
 * Stablecoin DEX Rail Wire — operate the internal DLBUSD→USDC swap rail
 * (`dlbusd-1to1-swap`) that funds the treasury wallet with no fiat checkout.
 *
 * Run from the repo root with the DAPP_* / STABLECOIN_DEX_* runtime env loaded:
 *   node server/scripts/stablecoinDexRailWire.js --readiness
 *   node server/scripts/stablecoinDexRailWire.js --deploy-dlbusd
 *   node server/scripts/stablecoinDexRailWire.js --create-pool --target USDC \
 *     --seed-dlbusd 1 --seed-usdc 1
 *   node server/scripts/stablecoinDexRailWire.js --fund --amount 250 \
 *     [--source-type trust --source-account 1000]
 *
 * Steps:
 *   --readiness    — StablecoinDexEngine.readiness() + TreasuryDepositEngine.fundReadiness()
 *   --deploy-dlbusd — resolves or deploys the DLBUSD token once and prints the address to
 *                    pin as DAPP_DLBUSD_ADDRESS so every replica uses the same token
 *   --create-pool  — deploys a BondDex DLBUSD/<target> pool seeded from the operator
 *                    wallet and prints the address to set as BOND_DEX_ADDRESS
 *   --fund         — declares a treasury deposit, then mints DLBUSD 1:1 from the source
 *                    ledger, swaps it for USDC and delivers it to the treasury wallet
 *
 * Fail-closed: --deploy-dlbusd, --create-pool and --fund refuse to run unless both
 * readiness checks are ready (live mode, not shadow). Secret values are never printed.
 */

require('dotenv').config();

const { StablecoinDexEngine } = require('../integrations/dapp/stablecoinDexEngine');
const { TreasuryDepositEngine } = require('../integrations/dapp/treasuryDepositEngine');

function parseArgs(argv) {
  const out = { readiness: false, deployDlbusd: false, createPool: false, fund: false, target: 'USDC', seedDlbusd: null, seedUsdc: null, amount: null, sourceType: null, sourceAccount: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--readiness') out.readiness = true;
    else if (arg === '--deploy-dlbusd') out.deployDlbusd = true;
    else if (arg === '--create-pool') out.createPool = true;
    else if (arg === '--fund') out.fund = true;
    else if (arg === '--target') { out.target = next; i += 1; } else if (arg === '--seed-dlbusd') { out.seedDlbusd = next; i += 1; } else if (arg === '--seed-usdc') { out.seedUsdc = next; i += 1; } else if (arg === '--amount') { out.amount = next; i += 1; } else if (arg === '--source-type') { out.sourceType = next; i += 1; } else if (arg === '--source-account') { out.sourceAccount = next; i += 1; } else throw new Error(`unknown argument "${arg}"`);
  }
  return out;
}

function print(title, value, log = console.log) {
  log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
  log(JSON.stringify(value, null, 2));
}

function positive(name, value) {
  const n = Number(value);
  if (!value || !Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return String(value);
}

/**
 * Runs the wire with injectable engines/output so the refusal path is unit-testable.
 * Returns { exitCode, readiness, fundReadiness, result }.
 */
async function run(argv, { Dex = StablecoinDexEngine, Deposit = TreasuryDepositEngine, log = console.log, error = console.error } = {}) {
  const args = parseArgs(argv);

  const readiness = Dex.readiness();
  const fundReadiness = Deposit.fundReadiness();
  print('stablecoin dex readiness', readiness, log);
  print('treasury deposit fund readiness', fundReadiness, log);

  if (!args.deployDlbusd && !args.createPool && !args.fund) {
    if (!args.readiness) log('\nno --deploy-dlbusd/--create-pool/--fund given; nothing moved.');
    return { exitCode: 0, readiness, fundReadiness, result: null };
  }

  if (!readiness.ready || readiness.mode !== 'live' || !fundReadiness.canFund) {
    const issues = [...new Set([...(readiness.issues || []), ...(fundReadiness.issues || [])])];
    if (readiness.mode !== 'live' && !issues.some((i) => /shadow/i.test(i))) issues.unshift(`StablecoinDexEngine is in ${readiness.mode} mode`);
    error(`\nrefusing to move value: rail ${fundReadiness.rail || 'dlbusd-1to1-swap'} is not live`);
    for (const issue of issues) error(`  - ${issue}`);
    return { exitCode: 1, readiness, fundReadiness, result: null, refused: true, issues };
  }

  if (args.deployDlbusd) {
    const dlbusd = await Dex.ensureDLBUSDAddress();
    print('dlbusd token', dlbusd, log);
    if (dlbusd.source === 'env') log(`\nDAPP_DLBUSD_ADDRESS is already pinned to ${dlbusd.address}; nothing deployed.`);
    else log(`\nset DAPP_DLBUSD_ADDRESS=${dlbusd.address} in the dlbtrust-runtime secret group and restart the service so every replica pins the same token.`);
    return { exitCode: 0, readiness, fundReadiness, result: dlbusd };
  }

  if (args.createPool) {
    const pool = await Dex.createPool({
      targetAsset: args.target || 'USDC',
      seedDlbusdAmount: positive('--seed-dlbusd', args.seedDlbusd),
      seedUsdcAmount: positive('--seed-usdc', args.seedUsdc),
    });
    print('pool created', pool, log);
    log(`\nset BOND_DEX_ADDRESS=${pool.poolAddress} in the runtime secret group and restart the service.`);
    return { exitCode: 0, readiness, fundReadiness, result: pool };
  }

  const amount = positive('--amount', args.amount);
  const source = {};
  if (args.sourceType) source.sourceType = args.sourceType;
  if (args.sourceAccount) source.sourceAccountId = args.sourceAccount;
  if (!source.sourceAccountId && !fundReadiness.sourceAccountId) {
    throw new Error('--source-account is required (TREASURY_TOPUP_HOLD_ACCOUNT_ID is not configured)');
  }

  const deposit = await Deposit.declare({ amount, tokenAddress: fundReadiness.usdcAddress || undefined });
  print('deposit declared', { id: deposit.id, depositAddress: deposit.walletAddress, chainId: deposit.chainId, amount: deposit.expectedAmount, symbol: deposit.symbol }, log);

  const funded = await Deposit.fund(deposit.id, source);
  const summary = {
    depositId: deposit.id,
    funded: Boolean(funded.funded),
    code: funded.code || null,
    txHash: (funded.swap && funded.swap.txHash) || funded.txHash || null,
    message: funded.message || null,
    deposit: funded.deposit ? { status: funded.deposit.status, booked: funded.deposit.booked, creditedQuantity: funded.deposit.creditedQuantity } : undefined,
  };
  print(funded.funded ? 'treasury funded' : `not funded (${summary.code})`, summary, log);
  return { exitCode: funded.funded ? 0 : 1, readiness, fundReadiness, result: summary };
}

module.exports = { run, parseArgs };

if (require.main === module) {
  run(process.argv.slice(2))
    .then((out) => { process.exitCode = out.exitCode; })
    .catch((err) => {
      console.error(`\n${err.message}`);
      process.exit(1);
    });
}
