/*
 * CLI: fund the Agent Wallet by tokenizing fixed-income coupon interest
 * and swapping it to Base mainnet USDC on a DEX.
 *
 * Usage:
 *   node server/scripts/fundAgentWalletFromTokenization.js --amount 100 \
 *     [--sourceAccountId 1] [--recipient 0x...] [--tokenSymbol DLB-PRB-INT] [--live]
 *
 * Environment:
 *   ADMIN_SECRET_TOKEN, DAPP_PRIVATE_KEY, DAPP_CHAIN_ID=8453, DAPP_USDC_ADDRESS,
 *   AGENT_WALLET_ADDRESS, TOKENIZATION_SHADOW=false (for live execution)
 */

const args = process.argv.slice(2).reduce((acc, val, i, arr) => {
  if (val.startsWith('--')) {
    const key = val.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    acc[key] = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true';
  }
  return acc;
}, {});

const amount = parseFloat(args.amount || process.argv.find((a) => !a.startsWith('--')) || 0);
const sourceAccountId = args.sourceAccountId || '1';
const sourceType = args.sourceType || 'bond_interest';
const recipient = args.recipient || process.env.AGENT_WALLET_ADDRESS || '0x69a32f285ced1dbf102c7baedf0266f1d39580a1';
const tokenSymbol = args.tokenSymbol || 'DLB-PRB-INT';

if (!amount || amount <= 0) {
  console.error('Usage: node server/scripts/fundAgentWalletFromTokenization.js --amount 100 [--sourceAccountId 1] [--recipient 0x...] [--tokenSymbol DLB-PRB-INT]');
  process.exit(1);
}

// Use the live OS engine endpoint if a server is running, otherwise call the engine directly.
const BASE_URL = (process.env.OS_TEST_BASE_URL || 'http://localhost:3002').replace(/\/$/, '');
const TOKEN = process.env.ADMIN_SECRET_TOKEN || 'dlb-admin-2026-trust';

(async () => {
  const payload = { action: 'execute', sourceType, sourceAccountId, amount, tokenSymbol, recipient };

  // Direct mode: import the engine and run without a running server.
  if (args.direct === 'true') {
    const { TokenizationEngine } = require('../integrations/os/osEngine');
    await TokenizationEngine.ensureTables();
    const result = await TokenizationEngine.process(payload);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
  }

  try {
    const res = await fetch(`${BASE_URL}/api/os/tokenization/process`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': TOKEN,
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    console.log(JSON.stringify(body, null, 2));
    process.exit(res.ok && body && body.success ? 0 : 1);
  } catch (err) {
    console.error('Failed to reach OS engine:', err.message);
    process.exit(1);
  }
})();
