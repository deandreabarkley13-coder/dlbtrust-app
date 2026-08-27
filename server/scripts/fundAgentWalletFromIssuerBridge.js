/*
 * CLI: fund the Agent Wallet by issuing real Base USDC from PTC ledger
 * source-of-funds (coupon / accrued interest trust accounts such as 1200)
 * through the Issuer Bridge OS Engine.
 *
 * Usage:
 *   node server/scripts/fundAgentWalletFromIssuerBridge.js --amount 100 \
 *     [--sourceAccountId 1200] [--sourceType trust] [--recipient 0x...] [--sourceMethod manual|circle_mint|moonpay]
 *
 * Environment:
 *   ADMIN_SECRET_TOKEN, AGENT_WALLET_ADDRESS, CIRCLE_MINT_API_KEY (for circle_mint)
 */

const args = process.argv.slice(2).reduce((acc, val, i, arr) => {
  if (val.startsWith('--')) {
    const key = val.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    acc[key] = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true';
  }
  return acc;
}, {});

const amount = parseFloat(args.amount || process.argv.find((a) => !a.startsWith('--')) || 0);
const sourceAccountId = args.sourceAccountId || '1000';
const sourceType = args.sourceType || 'trust';
const recipient = args.recipient || process.env.AGENT_WALLET_ADDRESS || '0x69a32f285ced1dbf102c7baedf0266f1d39580a1';
const sourceMethod = args.sourceMethod || (process.env.CIRCLE_MINT_API_KEY ? 'circle_mint' : 'manual');

if (!amount || amount <= 0) {
  console.error('Usage: node server/scripts/fundAgentWalletFromIssuerBridge.js --amount 100 [--sourceAccountId 1200] [--sourceType trust] [--recipient 0x...] [--sourceMethod manual|circle_mint|moonpay]');
  process.exit(1);
}

const BASE_URL = (process.env.OS_TEST_BASE_URL || 'http://localhost:3002').replace(/\/$/, '');
const TOKEN = process.env.ADMIN_SECRET_TOKEN || 'dlb-admin-2026-trust';

(async () => {
  const payload = {
    action: 'issue',
    sourceType,
    sourceAccountId,
    amount,
    sourceMethod,
    recipient,
    asset: 'USDC',
  };

  if (args.direct === 'true') {
    const { IssuerBridgeEngine } = require('../integrations/os/osEngine');
    await IssuerBridgeEngine.ensureTables();
    const result = await IssuerBridgeEngine.process(payload);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
  }

  try {
    const res = await fetch(`${BASE_URL}/api/os/issuer-bridge/process`, {
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
