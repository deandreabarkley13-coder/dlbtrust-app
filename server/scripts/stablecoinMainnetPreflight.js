#!/usr/bin/env node
'use strict';

/**
 * Read whether a mainnet USDC push would work — before one is raised.
 *
 * Everything here is a read: Horizon for what the accounts actually hold, the
 * rail for what it would refuse. Nothing is initiated, approved, sent or
 * settled, and the distributor's secret is never needed, so this is safe to run
 * against a live configuration.
 *
 * It answers the four questions that make a real payment fail after approval:
 *
 *   1. Is the rail armed? Mainnet needs STABLECOIN_MAINNET_AUTHORIZED and a
 *      per-push ceiling, and the issuer must be Circle's.
 *   2. Does the distributor hold USDC, and enough XLM to pay fees? A funded
 *      trustline is the only funding authority this rail has.
 *   3. Does each registered wallet exist and already trust Circle's USDC? A
 *      payment to an account with no USDC trustline fails on submission
 *      (op_no_trust) — the recipient has to open it, nobody else can.
 *   4. Is compliance live? Origination is refused without a screening.
 *
 * Usage:
 *   node server/scripts/stablecoinMainnetPreflight.js
 *
 * Exits non-zero if a push would be refused, so it can gate a deploy.
 */

const { StablecoinPayoutRail } = require('../integrations/os/stablecoinPayoutRail');

/** Minimum XLM a Stellar account needs: 1 XLM base reserve + 0.5 per trustline. */
const MIN_XLM_WITH_TRUSTLINE = 1.5;

function line(label, value) {
  console.log(`  ${label.padEnd(28)} ${value}`);
}

async function account(horizonUrl, address) {
  const base = String(horizonUrl).replace(/\/+$/, '');
  const response = await fetch(`${base}/accounts/${address}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Horizon returned ${response.status} for ${address}`);
  return response.json();
}

function balances(data, assetCode, issuer) {
  const native = (data.balances || []).find(entry => entry.asset_type === 'native');
  const usdc = (data.balances || []).find(entry => (
    entry.asset_code === assetCode && entry.asset_issuer === issuer
  ));
  return { xlm: native ? native.balance : '0', usdc: usdc ? usdc.balance : null };
}

async function main() {
  const readiness = await StablecoinPayoutRail.readiness();
  const problems = [];

  console.log('\nRail');
  line('network', readiness.network);
  line('asset', readiness.asset);
  line('issuer', readiness.issuer || '(none configured)');
  line("Circle's issuer", readiness.trustedIssuers.join(', ') || '(unknown network)');
  line('horizon', readiness.horizonUrl);
  line('registered wallets', readiness.walletCount);
  line('armed', readiness.ready ? 'yes' : 'no');
  readiness.issues.forEach(issue => problems.push(issue));
  readiness.warnings.forEach(warning => console.log(`  warning: ${warning}`));

  if (readiness.distributorPublic && readiness.issuer) {
    console.log('\nDistributor');
    line('address', readiness.distributorPublic);
    const data = await account(readiness.horizonUrl, readiness.distributorPublic);
    if (!data) {
      problems.push(`Distributor ${readiness.distributorPublic} does not exist on ${readiness.network}`);
      line('exists', 'no');
    } else {
      const held = balances(data, readiness.asset, readiness.issuer);
      line('XLM (fees)', held.xlm);
      line(`${readiness.asset} trustline`, held.usdc === null ? 'missing' : held.usdc);
      if (held.usdc === null) {
        problems.push(
          `Distributor holds no ${readiness.asset} trustline for ${readiness.issuer};`
          + ' open it from the distributor before funding'
        );
      } else if (Number(held.usdc) === 0) {
        problems.push(`Distributor holds 0 ${readiness.asset}: fund it (Circle Mint) before a push`);
      }
      if (Number(held.xlm) < MIN_XLM_WITH_TRUSTLINE) {
        problems.push(
          `Distributor holds ${held.xlm} XLM, below the ~${MIN_XLM_WITH_TRUSTLINE} needed for the`
          + ' base reserve, the trustline reserve and fees'
        );
      }
    }
  }

  const wallets = StablecoinPayoutRail.wallets();
  if (wallets.length) console.log('\nRegistered wallets');
  for (const wallet of wallets) {
    const full = StablecoinPayoutRail.wallet(wallet.key);
    console.log(`\n  ${wallet.key} — ${wallet.name}`);
    line('address', full.address);
    line('gl account', full.glAccountCode);
    const data = readiness.issuer ? await account(readiness.horizonUrl, full.address) : null;
    if (!readiness.issuer) continue;
    if (!data) {
      problems.push(`Wallet ${wallet.key} does not exist on ${readiness.network}, so a payment to it would fail`);
      line('exists', 'no');
      continue;
    }
    const held = balances(data, readiness.asset, readiness.issuer);
    line(`${readiness.asset} trustline`, held.usdc === null ? 'missing' : 'open');
    if (held.usdc === null) {
      problems.push(
        `Wallet ${wallet.key} does not trust ${readiness.asset} from ${readiness.issuer};`
        + ' the recipient must open that trustline or the payment fails (op_no_trust)'
      );
    }
  }

  console.log('');
  if (!problems.length) {
    console.log(`Preflight clear: a ${readiness.network} USDC push would be accepted, under dual control as usual.`);
    return;
  }
  console.log(`A ${readiness.network} USDC push would be refused:`);
  problems.forEach(problem => console.log(`  • ${problem}`));
  process.exitCode = 2;
}

if (require.main === module) {
  main().then(() => process.exit(process.exitCode || 0)).catch((err) => {
    console.error(`\nFailed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
