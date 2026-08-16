#!/usr/bin/env node
'use strict';

/**
 * Confirm an on-chain deposit for an Alchemy wallet funding request.
 *
 * Usage:
 *   ADMIN_SECRET_TOKEN=dlb-admin-2026-trust node server/scripts/confirmAgentWalletDeposit.js <requestId> <txHash> [amount] [asset]
 */

const BASE_URL = (process.env.OS_TEST_BASE_URL || 'http://localhost:3002').replace(/\/$/, '');
const TOKEN = process.env.ADMIN_SECRET_TOKEN || 'dlb-admin-2026-trust';

const requestId = process.argv[2];
const txHash = process.argv[3];
const amount = process.argv[4] || '';
const asset = process.argv[5] || '';

if (!requestId || !txHash) {
  console.error('Usage: node server/scripts/confirmAgentWalletDeposit.js <requestId> <txHash> [amount] [asset]');
  process.exit(1);
}

async function post(engine, body) {
  const res = await fetch(`${BASE_URL}/api/os/${engine}/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${json && json.error ? json.error : text}`);
  return json && json.data ? json.data : json;
}

async function main() {
  const result = await post('alchemy-wallet', {
    action: 'confirmDeposit',
    requestId,
    txHash,
    amount,
    asset,
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
