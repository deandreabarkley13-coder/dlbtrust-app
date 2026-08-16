#!/usr/bin/env node
'use strict';

/**
 * Fund the Alchemy Agent Wallet from the PTC operating account.
 *
 * Usage:
 *   ADMIN_SECRET_TOKEN=dlb-admin-2026-trust node server/scripts/fundAgentWalletFromOperating.js [amount] [asset] [targetAddress]
 *
 * Defaults:
 *   amount = 0.01
 *   asset  = USDC
 *   targetAddress = active Alchemy session EVM wallet (or local wallet)
 *
 * The script auto-replenishes CA-OPERATING from CA-BOND-PROCEEDS if needed,
 * then creates a wallet-onramp request to deposit the asset on Base mainnet.
 */

const BASE_URL = (process.env.OS_TEST_BASE_URL || 'http://localhost:3002').replace(/\/$/, '');
const TOKEN = process.env.ADMIN_SECRET_TOKEN || 'dlb-admin-2026-trust';

const amount = process.argv[2] || '0.01';
const asset = process.argv[3] || 'USDC';
const targetAddress = process.argv[4] || '';
const sourceMethod = process.argv[5] || process.env.AGENT_WALLET_SOURCE_METHOD || 'manual';

async function post(engine, body) {
  const res = await fetch(`${BASE_URL}/api/os/${engine}/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${json && json.error ? json.error : text}`);
  }
  return json && json.data ? json.data : json;
}

async function main() {
  // Resolve active wallet if no address supplied
  let resolvedTarget = targetAddress;
  if (!resolvedTarget) {
    const wallets = await post('alchemy-wallet', { action: 'listWallets' });
    resolvedTarget = wallets.result && (wallets.result.sessionEvm || wallets.result.evm);
    if (!resolvedTarget) throw new Error('No Alchemy EVM wallet found; provide targetAddress or connect a wallet');
    console.log(`Using Alchemy wallet: ${resolvedTarget}`);
  }

  console.log(`Funding ${amount} ${asset} to ${resolvedTarget} from operating account...`);

  const result = await post('alchemy-wallet', {
    action: 'fundFromOperating',
    amount,
    asset,
    targetAddress: resolvedTarget,
    sourceMethod,
    autoReplenish: true,
  });

  console.log('Funding request created:');
  console.log(JSON.stringify(result, null, 2));

  if (result.result && result.result.onRamp && result.result.onRamp.operationId) {
    console.log('\nNext step: once the deposit confirms on-chain, run:');
    console.log(`  ADMIN_SECRET_TOKEN=${TOKEN} node server/scripts/confirmAgentWalletDeposit.js ${result.result.requestId} <txHash>`);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
