#!/usr/bin/env node
'use strict';

/**
 * Wire script for the trust ecosystem (browser extension + mobile app path).
 *
 * Exercises, in-process, exactly what a thin client does through
 * /api/dapp/ecosystem/*: a beneficiary session submits an expense, the maker
 * and checker trustees approve it, a trustee pays it from the thirdweb server
 * wallet, priced by ThirdwebPriceOracle. The payment is SHADOW unless
 * THIRDWEB_SERVER_WALLET_LIVE=true and --live is passed, so by default nothing
 * leaves the treasury; the oracle and (with --portfolio) wallet-token reads do
 * hit thirdweb's API and need THIRDWEB_SECRET_KEY.
 *
 *   node server/scripts/trustEcosystemWire.js [--usd 250] [--purpose medical]
 *     [--to 0x...] [--token <erc20>] [--portfolio] [--live] [--memory]
 *
 *   --memory   force DAPP_MEMORY_MODE (no PostgreSQL required)
 *   --live     allow a real send when THIRDWEB_SERVER_WALLET_LIVE=true
 */

const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '../../.env') }); } catch (e) { /* optional */ }

function parseArgs(argv) {
  const args = { usd: '250', purpose: 'medical', to: null, token: null, portfolio: false, live: false, memory: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--usd') args.usd = argv[++i];
    else if (a === '--purpose') args.purpose = argv[++i];
    else if (a === '--to') args.to = argv[++i];
    else if (a === '--token') args.token = argv[++i];
    else if (a === '--portfolio') args.portfolio = true;
    else if (a === '--live') args.live = true;
    else if (a === '--memory') args.memory = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.memory) process.env.DAPP_MEMORY_MODE = 'true';
if (!args.live) process.env.THIRDWEB_SERVER_WALLET_LIVE = 'false';

const { TrustEcosystemEngine } = require('../integrations/dapp/trustEcosystemEngine');
const { ThirdwebServerWalletEngine } = require('../integrations/dapp/thirdwebServerWalletEngine');
const { getTrusteeByRole } = require('../integrations/dapp/trustees');

const log = (label, value) => console.log(`\n== ${label}\n${JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? String(v) : v), 2)}`);

async function main() {
  const maker = getTrusteeByRole('maker');
  const checker = getTrusteeByRole('checker');
  const treasury = ThirdwebServerWalletEngine.readiness();
  const to = args.to || treasury.address;
  if (!to) throw new Error('pass --to <address> or pin THIRDWEB_SERVER_WALLET_ADDRESS');

  // Sessions exactly as dappAuth would attach them from a verified JWT/SIWE login.
  const beneficiary = { userId: 'wire-beneficiary', email: 'deandreabarkley13@gmail.com', role: 'beneficiary', roles: ['beneficiary'], walletAddress: to, authMethod: 'dapp_user' };
  const makerUser = { userId: 'wire-maker', email: maker.email, role: 'trustee_maker', roles: ['trustee_maker', 'beneficiary'], authMethod: 'dapp_user' };
  const checkerUser = { userId: 'wire-checker', email: checker.email, role: 'trustee_checker', roles: ['trustee_checker', 'beneficiary'], authMethod: 'dapp_user' };

  const manifest = TrustEcosystemEngine.manifest();
  log('manifest', { chainId: manifest.chainId, policy: manifest.policy, treasury: manifest.treasury, priceOracle: manifest.priceOracle });
  if (!manifest.priceOracle.ready) throw new Error(`price oracle not ready: ${manifest.priceOracle.issues.join('; ')}`);

  log('beneficiary session', await TrustEcosystemEngine.session(beneficiary));
  log('trustee session', await TrustEcosystemEngine.session(makerUser));

  if (args.portfolio) log('portfolio', await TrustEcosystemEngine.portfolio({ user: beneficiary }));

  log('quote', await TrustEcosystemEngine.quote({ amountUsd: args.usd, tokenAddress: args.token }));

  const expense = await TrustEcosystemEngine.submitExpense({
    user: beneficiary, amountUsd: args.usd, purpose: args.purpose, memo: 'ecosystem wire', destinationAddress: to, client: 'wire-script',
  });
  log('expense submitted', expense);

  await TrustEcosystemEngine.payExpense({ user: makerUser, requestId: expense.id }).then(
    () => { throw new Error('unapproved expense must not be payable'); },
    (e) => log('pay before approval (expected rejection)', { code: e.code, message: e.message }),
  );
  await TrustEcosystemEngine.approveExpense({ user: beneficiary, requestId: expense.id }).then(
    () => { throw new Error('beneficiary must not approve'); },
    (e) => log('beneficiary approve (expected rejection)', { code: e.code, message: e.message }),
  );

  log('maker approval', await TrustEcosystemEngine.approveExpense({ user: makerUser, requestId: expense.id, role: 'maker' }));
  log('checker approval', await TrustEcosystemEngine.approveExpense({ user: checkerUser, requestId: expense.id, role: 'checker' }));

  const paid = await TrustEcosystemEngine.payExpense({ user: checkerUser, requestId: expense.id, tokenAddress: args.token });
  log(paid.transfer.shadow ? 'payment (SHADOW — nothing sent)' : 'payment (LIVE)', paid);

  log('beneficiary view', await TrustEcosystemEngine.listExpenses({ user: beneficiary, limit: 3 }));
}

main().catch((err) => { console.error('\nwire failed:', err.message); process.exit(1); });
