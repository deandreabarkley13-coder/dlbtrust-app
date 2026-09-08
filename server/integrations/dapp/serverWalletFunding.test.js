'use strict';

/**
 * Server wallet funding preflight — run with
 * `node server/integrations/dapp/serverWalletFunding.test.js`.
 * The thirdweb balance call is stubbed, so no credential or chain access is used.
 */

process.env.DAPP_MEMORY_MODE = 'true';
process.env.THIRDWEB_SERVER_WALLET_ADDRESS = '0x1A904F795a0511C31Ba6347504D08d1bA58E4f89';
process.env.THIRDWEB_SERVER_WALLET_CHAIN_ID = '8453';
process.env.THIRDWEB_SERVER_WALLET_MIN_GAS_WEI = '200000000000000';

const assert = require('assert');
const { ThirdwebServerWalletEngine } = require('./thirdwebServerWalletEngine');

const WALLET = process.env.THIRDWEB_SERVER_WALLET_ADDRESS;
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

let holdings = { native: '0', token: '0' };

ThirdwebServerWalletEngine.balance = async ({ tokenAddress } = {}) => (tokenAddress
  ? [{ chainId: 8453, tokenAddress: USDC, symbol: 'USDC', decimals: 6, value: holdings.token, displayValue: holdings.token }]
  : [{ chainId: 8453, tokenAddress: null, symbol: 'ETH', decimals: 18, value: holdings.native, displayValue: holdings.native }]);

async function testTokenTransferNeedsTokenAndGas() {
  holdings = { native: '0', token: '5000000' };
  const noGas = await ThirdwebServerWalletEngine.fundingStatus({ tokenAddress: USDC, quantity: '1000000' });
  assert.strictEqual(noGas.address, WALLET);
  assert.strictEqual(noGas.asset.sufficient, true);
  assert.strictEqual(noGas.gas.sufficient, false);
  assert.strictEqual(noGas.funded, false);
  await assert.rejects(
    () => ThirdwebServerWalletEngine.assertFunded({ tokenAddress: USDC, quantity: '1000000' }),
    (err) => err.code === 'TREASURY_UNDERFUNDED' && err.status === 409 && /gas ETH/.test(err.message)
  );

  holdings.native = '900000000000000';
  const funded = await ThirdwebServerWalletEngine.assertFunded({ tokenAddress: USDC, quantity: '1000000' });
  assert.strictEqual(funded.funded, true);

  await assert.rejects(
    () => ThirdwebServerWalletEngine.assertFunded({ tokenAddress: USDC, quantity: '6000000' }),
    /holds 5000000, needs 6000000/
  );
}

async function testNativeTransferReservesGas() {
  // A native transfer must leave the gas floor behind, not spend down to zero.
  holdings = { native: '1000000000000000', token: '0' };
  const tight = await ThirdwebServerWalletEngine.fundingStatus({ quantity: '900000000000000' });
  assert.strictEqual(tight.asset.required, '1100000000000000');
  assert.strictEqual(tight.funded, false);

  const ok = await ThirdwebServerWalletEngine.fundingStatus({ quantity: '700000000000000' });
  assert.strictEqual(ok.funded, true);
}

async function testShadowSendSkipsPreflight() {
  // Shadow mode records intent without touching the chain, so an empty wallet is fine.
  holdings = { native: '0', token: '0' };
  process.env.THIRDWEB_SERVER_WALLET_LIVE = 'false';
  process.env.THIRDWEB_PRICE_FALLBACK_TO_CALLER = 'true';
  const record = await ThirdwebServerWalletEngine.send({
    to: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    quantity: '1000000',
    tokenAddress: USDC,
    amountUsd: 1,
    requesterRole: 'trustee',
    purpose: 'medical',
  });
  assert.strictEqual(record.status, 'shadow');
  assert.strictEqual(record.shadow, true);
}

async function main() {
  await testTokenTransferNeedsTokenAndGas();
  await testNativeTransferReservesGas();
  await testShadowSendSkipsPreflight();
  console.log('Server wallet funding preflight validation passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
