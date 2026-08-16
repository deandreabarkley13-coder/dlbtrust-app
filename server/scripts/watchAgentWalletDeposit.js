#!/usr/bin/env node
'use strict';

/**
 * Auto-watch the Alchemy Agent Wallet for an incoming USDC deposit and
 * confirm the matching alchemy-wallet funding request.
 *
 * Usage:
 *   ADMIN_SECRET_TOKEN=dlb-admin-2026-trust \
 *   ALCHEMY_API_KEY=... \
 *   REQUEST_ID=AWF-... \
 *   TARGET_ADDRESS=0x69a32f285ced1dbf102c7baedf0266f1d39580a1 \
 *   node server/scripts/watchAgentWalletDeposit.js [amount] [pollMs] [timeoutMs]
 *
 * Defaults:
 *   amount = 100 (USDC)
 *   pollMs = 15000
 *   timeoutMs = 0 (infinite)
 */

const BASE_URL = (process.env.OS_TEST_BASE_URL || 'http://localhost:3002').replace(/\/$/, '');
const TOKEN = process.env.ADMIN_SECRET_TOKEN || 'dlb-admin-2026-trust';
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const REQUEST_ID = process.env.REQUEST_ID || '';
const TARGET_ADDRESS = process.env.TARGET_ADDRESS || '0x69a32f285ced1dbf102c7baedf0266f1d39580a1';
const ASSET = process.env.ASSET || 'USDC';
const USDC_ADDRESS = process.env.DAPP_USDC_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const RPC_URL = process.env.DAPP_RPC_URL || `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const TRANSFER_EVENT = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const targetAmount = Number(process.argv[2] || process.env.TARGET_AMOUNT || '100');
const pollMs = Number(process.argv[3] || process.env.POLL_MS || '15000');
const timeoutMs = Number(process.argv[4] || process.env.TIMEOUT_MS || '0');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function padAddress(addr) {
  return '0x' + addr.slice(2).toLowerCase().padStart(64, '0');
}

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

async function getLatestBlock() {
  const hex = await rpc('eth_blockNumber');
  return Number.parseInt(hex, 16);
}

async function getUsdcBalance(address) {
  const data = '0x70a08231' + padAddress(address).slice(2);
  const result = await rpc('eth_call', [
    { to: USDC_ADDRESS, data },
    'latest',
  ]);
  return Number(BigInt(result) / 1_000_000n) / 1; // whole USDC units
}

async function getDepositLogs(fromBlock, toBlock) {
  const topics = [TRANSFER_EVENT, null, padAddress(TARGET_ADDRESS)];
  const logs = await rpc('eth_getLogs', [
    {
      fromBlock: '0x' + fromBlock.toString(16),
      toBlock: '0x' + toBlock.toString(16),
      address: USDC_ADDRESS,
      topics,
    },
  ]);
  return logs || [];
}

async function confirmDeposit(txHash, amount) {
  const res = await fetch(`${BASE_URL}/api/os/alchemy-wallet/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify({
      action: 'confirmDeposit',
      requestId: REQUEST_ID,
      txHash,
      amount,
      asset: ASSET,
    }),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function main() {
  if (!REQUEST_ID) throw new Error('REQUEST_ID env var required');
  if (!ALCHEMY_API_KEY && !process.env.DAPP_RPC_URL) {
    throw new Error('ALCHEMY_API_KEY or DAPP_RPC_URL required');
  }
  const startBlock = await getLatestBlock();
  console.log(`[watch] Target ${TARGET_ADDRESS} for >= ${targetAmount} ${ASSET} on Base mainnet`);
  console.log(`[watch] Starting from block ${startBlock}, polling every ${pollMs}ms`);

  let lastScanned = startBlock - 1;
  const startTime = Date.now();
  let confirmed = false;

  while (!confirmed) {
    if (timeoutMs && Date.now() - startTime > timeoutMs) {
      throw new Error(`Timeout after ${timeoutMs}ms without detecting deposit`);
    }
    try {
      const latest = await getLatestBlock();
      if (latest > lastScanned) {
        const logs = await getDepositLogs(lastScanned + 1, latest);
        for (const log of logs) {
          const rawAmount = BigInt(log.data);
          const amountUnits = Number(rawAmount) / 1_000_000;
          console.log(`[watch] Detected USDC transfer tx ${log.transactionHash}: ${amountUnits} USDC`);
          if (amountUnits >= targetAmount) {
            console.log(`[watch] Sufficient deposit found. Confirming funding request ${REQUEST_ID}...`);
            const result = await confirmDeposit(log.transactionHash, amountUnits);
            console.log('[watch] Confirm result:', JSON.stringify(result, null, 2));
            if (result.success || result.data?.success) {
              confirmed = true;
              return;
            }
          }
        }
        lastScanned = latest;
      }

      const balance = await getUsdcBalance(TARGET_ADDRESS);
      console.log(`[watch] Block ${latest} | balance ${balance} USDC`);
      if (balance >= targetAmount) {
        // balance already there but no log matched? confirm with no txHash
        console.log(`[watch] Balance threshold reached. Confirming funding request ${REQUEST_ID}...`);
        const result = await confirmDeposit(null, balance);
        console.log('[watch] Confirm result:', JSON.stringify(result, null, 2));
        if (result.success || result.data?.success) {
          confirmed = true;
          return;
        }
      }
    } catch (e) {
      console.error('[watch] Error:', e.message);
    }
    await sleep(pollMs);
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
