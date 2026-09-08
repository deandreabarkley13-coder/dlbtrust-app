'use strict';

/**
 * Treasury deposit validation — run with `node server/integrations/dapp/treasuryDeposit.test.js`.
 * Runs in memory mode with the wallet balance and price oracle stubbed, so no
 * database, thirdweb credential or chain access is needed.
 */

process.env.DAPP_MEMORY_MODE = 'true';
process.env.THIRDWEB_SERVER_WALLET_ADDRESS = '0x1A904F795a0511C31Ba6347504D08d1bA58E4f89';
process.env.THIRDWEB_SERVER_WALLET_CHAIN_ID = '8453';
process.env.THIRDWEB_SETTLEMENT_TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const assert = require('assert');
const { ThirdwebServerWalletEngine } = require('./thirdwebServerWalletEngine');
const { ThirdwebPriceOracle } = require('./thirdwebPriceOracle');
const { TreasuryDepositEngine, display, unitsFromAmount } = require('./treasuryDepositEngine');

const WALLET = process.env.THIRDWEB_SERVER_WALLET_ADDRESS;
const USDC = process.env.THIRDWEB_SETTLEMENT_TOKEN;

// Stubbed wallet holdings in smallest units, driven per-test.
let held = { asset: '0', gas: '0' };

ThirdwebServerWalletEngine.fundingStatus = async ({ chainId, tokenAddress = null, quantity = null } = {}) => {
  const want = quantity === null ? 0n : BigInt(quantity);
  const gas = BigInt(held.gas);
  const asset = tokenAddress ? BigInt(held.asset) : gas;
  return {
    address: WALLET,
    chainId: Number(chainId || 8453),
    tokenAddress: tokenAddress || null,
    gas: { symbol: 'ETH', held: gas.toString(), required: '0', sufficient: true },
    asset: { symbol: tokenAddress ? 'USDC' : 'ETH', decimals: tokenAddress ? 6 : 18, held: asset.toString(), required: want.toString(), sufficient: asset >= want },
    funded: asset >= want,
  };
};

ThirdwebPriceOracle.getPrice = async ({ tokenAddress }) => (tokenAddress
  ? { symbol: 'USDC', decimals: 6, priceUsd: 1 }
  : { symbol: 'ETH', decimals: 18, priceUsd: 3000 });

ThirdwebPriceOracle.quoteUsd = async ({ quantity }) => ({ amountUsd: Number(BigInt(quantity) / 10000n) / 100, priceUsd: 1, symbol: 'USDC', decimals: 6 });

function testUnitConversion() {
  assert.strictEqual(unitsFromAmount('250.5', 6).toString(), '250500000');
  assert.strictEqual(unitsFromAmount('1', 18).toString(), '1000000000000000000');
  assert.strictEqual(display('250500000', 6), '250.5');
  assert.strictEqual(display('1000000', 6), '1');
  assert.throws(() => unitsFromAmount('1.1234567', 6), /more than 6 decimal places/);
  assert.throws(() => unitsFromAmount('-5', 6), /not a positive decimal/);
}

async function testDeclareRecordsBaseline() {
  held = { asset: '40000000', gas: '5000000000000000' }; // 40 USDC already held
  const deposit = await TreasuryDepositEngine.declare({ amount: '250', tokenAddress: USDC, memo: 'trust wallet top-up' });
  assert.strictEqual(deposit.status, 'expected');
  assert.strictEqual(deposit.expectedQuantity, '250000000');
  // Pre-existing holdings are the baseline, so they are never credited.
  assert.strictEqual(deposit.baselineQuantity, '40000000');
  assert.strictEqual(deposit.creditedQuantity, '0');
  assert.strictEqual(deposit.booked, false);
  assert.strictEqual(deposit.instructions.depositAddress, WALLET);
  assert.strictEqual(deposit.instructions.amount, '250');
  return deposit;
}

async function testPartialThenFullCredit() {
  held = { asset: '0', gas: '0' };
  const deposit = await TreasuryDepositEngine.declare({ amount: '100', tokenAddress: USDC });

  const untouched = await TreasuryDepositEngine.sync(deposit.id);
  assert.strictEqual(untouched.status, 'expected');
  assert.strictEqual(untouched.creditedQuantity, '0');

  held.asset = '60000000';
  const partial = await TreasuryDepositEngine.sync(deposit.id);
  assert.strictEqual(partial.status, 'partial');
  assert.strictEqual(partial.creditedQuantity, '60000000');
  assert.strictEqual(partial.booked, false);

  // An overshoot credits the expected amount only.
  held.asset = '130000000';
  const credited = await TreasuryDepositEngine.sync(deposit.id);
  assert.strictEqual(credited.status, 'credited');
  assert.strictEqual(credited.creditedQuantity, '100000000');
  assert.strictEqual(credited.amountUsd, 100);
  assert.ok(credited.creditedAt);

  // Terminal deposits are not re-credited when more value arrives later.
  held.asset = '900000000';
  const again = await TreasuryDepositEngine.sync(deposit.id);
  assert.strictEqual(again.creditedQuantity, '100000000');
}

async function testCancel() {
  held = { asset: '0', gas: '0' };
  const deposit = await TreasuryDepositEngine.declare({ amount: '10', tokenAddress: USDC });
  const cancelled = await TreasuryDepositEngine.cancel(deposit.id, { reason: 'sent from the wrong wallet' });
  assert.strictEqual(cancelled.status, 'cancelled');
  assert.strictEqual(cancelled.memo, 'sent from the wrong wallet');

  held.asset = '10000000';
  assert.strictEqual((await TreasuryDepositEngine.sync(deposit.id)).status, 'cancelled');

  const funded = await TreasuryDepositEngine.declare({ amount: '5', tokenAddress: USDC });
  held.asset = '20000000';
  await TreasuryDepositEngine.sync(funded.id);
  await assert.rejects(() => TreasuryDepositEngine.cancel(funded.id), /already credited/);
}

async function testSyncOpenAndValidation() {
  held = { asset: '0', gas: '0' };
  const first = await TreasuryDepositEngine.declare({ amount: '1', tokenAddress: USDC });
  held.asset = '1000000';
  const result = await TreasuryDepositEngine.syncOpen({ limit: 10 });
  assert.ok(result.checked >= 1);
  assert.ok(result.deposits.some((d) => d.id === first.id && d.status === 'credited'));

  await assert.rejects(() => TreasuryDepositEngine.declare({ amount: '1', tokenAddress: 'not-an-address' }), /tokenAddress invalid/);
  await assert.rejects(() => TreasuryDepositEngine.declare({ amount: '1', tokenAddress: USDC, fromAddress: '0x1' }), /fromAddress invalid/);
  await assert.rejects(() => TreasuryDepositEngine.declare({ quantity: '0', tokenAddress: USDC }), /must be positive/);
  await assert.rejects(() => TreasuryDepositEngine.sync('TWDEP-missing'), /not found/);
}

async function testInstructionsAndReadiness() {
  held = { asset: '7000000', gas: '2000000000000000' };
  const instructions = await TreasuryDepositEngine.instructions({});
  assert.strictEqual(instructions.depositAddress, WALLET);
  assert.strictEqual(instructions.chainId, 8453);
  assert.strictEqual(instructions.chain, 'Base');
  assert.strictEqual(instructions.settlementAsset.held, '7000000');
  assert.match(instructions.warning, /chain 8453/);

  const readiness = TreasuryDepositEngine.readiness();
  assert.strictEqual(readiness.walletAddress, WALLET);
  assert.strictEqual(readiness.chainId, 8453);
  assert.strictEqual(readiness.settlementToken, USDC);
}

async function main() {
  testUnitConversion();
  await testDeclareRecordsBaseline();
  await testPartialThenFullCredit();
  await testCancel();
  await testSyncOpenAndValidation();
  await testInstructionsAndReadiness();
  console.log('Treasury deposit validation passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
