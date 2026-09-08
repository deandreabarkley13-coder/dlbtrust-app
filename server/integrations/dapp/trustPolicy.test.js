'use strict';

/**
 * TrustPolicyEngine wiring: what gets encoded for the contract, what the
 * shadow gate withholds, and that a direct server-wallet transfer is refused
 * while the on-chain policy is the mandated route. The contract's own rules are
 * covered against a live EVM in scripts/testTrustDistributionPolicy.cjs.
 */

process.env.DAPP_MEMORY_MODE = 'true';
process.env.THIRDWEB_SECRET_KEY = 'test-secret';
process.env.THIRDWEB_SERVER_WALLET_ADDRESS = '0x1A904F795a0511C31Ba6347504D08d1bA58E4f89';
process.env.THIRDWEB_SERVER_WALLET_CHAIN_ID = '8453';
process.env.THIRDWEB_SETTLEMENT_TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
process.env.TRUST_POLICY_ADDRESS = '0x00000000000000000000000000000000000C0DE1';
process.env.TRUST_POLICY_CHAIN_ID = '8453';
process.env.TRUST_POLICY_LIVE = 'false';

const assert = require('assert');
const { TrustPolicyEngine, purposeHex, purposeFromHex, refHex } = require('./trustPolicyEngine');
const { ThirdwebServerWalletEngine } = require('./thirdwebServerWalletEngine');

const USDC = process.env.THIRDWEB_SETTLEMENT_TOKEN;
const BENEFICIARY = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';

function testPurposeAndRefEncoding() {
  const hex = purposeHex('medical');
  assert.strictEqual(hex.length, 66);
  assert.strictEqual(purposeFromHex(hex), 'medical');
  assert.strictEqual(purposeFromHex(`0x${'0'.repeat(64)}`), null);
  assert.throws(() => purposeHex('x'.repeat(33)), /longer than 32 bytes/);

  // A short canonical id stays readable on chain; anything longer is hashed
  // so the contract's replay protection still keys on one value per request.
  assert.strictEqual(purposeFromHex(refHex('DR-2026-0001')), 'DR-2026-0001');
  const long = refHex('x'.repeat(40));
  assert.strictEqual(long.length, 66);
  assert.notStrictEqual(long, refHex('x'.repeat(41)));
}

function testReadiness() {
  const readiness = TrustPolicyEngine.readiness();
  assert.strictEqual(readiness.contract, process.env.TRUST_POLICY_ADDRESS);
  assert.strictEqual(readiness.chainId, 8453);
  assert.strictEqual(readiness.shadow, true);
  assert.strictEqual(readiness.enforced, false);

  // Enforcing the contract while writes are shadowed would silently strand
  // every distribution, so readiness has to call it out.
  process.env.TRUST_POLICY_ENFORCED = 'true';
  try {
    assert.ok(TrustPolicyEngine.readiness().issues.some((i) => /never submitted/.test(i)));
  } finally {
    delete process.env.TRUST_POLICY_ENFORCED;
  }
}

async function testShadowProposeEncodesTheCall() {
  const record = await TrustPolicyEngine.propose({
    beneficiary: BENEFICIARY,
    quantity: '250000000',
    purpose: 'medical',
    reference: 'DR-77',
  });
  assert.strictEqual(record.status, 'shadow');
  assert.strictEqual(record.shadow, true);
  assert.strictEqual(record.transactionId, null);
  assert.strictEqual(record.contract, process.env.TRUST_POLICY_ADDRESS);
  assert.match(record.call.method, /^function propose\(address token/);
  // token, beneficiary, amount, purpose, ref, expiresAt, installments, interval
  assert.deepStrictEqual(record.call.params, [
    USDC, BENEFICIARY, '250000000', purposeHex('medical'), refHex('DR-77'), '0', 1, 0,
  ]);

  await assert.rejects(() => TrustPolicyEngine.propose({ beneficiary: 'nope', quantity: '1', reference: 'r' }), /beneficiary must be a valid address/);
  await assert.rejects(() => TrustPolicyEngine.propose({ beneficiary: BENEFICIARY, quantity: '0', reference: 'r' }), /quantity must be positive/);
  await assert.rejects(
    () => TrustPolicyEngine.propose({ beneficiary: BENEFICIARY, quantity: '1', reference: 'r', installments: 4 }),
    /intervalSeconds is required/
  );
}

async function testGovernanceCallsAreGated() {
  const role = await TrustPolicyEngine.setRole({ role: 'checker', account: BENEFICIARY });
  assert.deepStrictEqual(role.call.params, [1, BENEFICIARY, true]);
  await assert.rejects(() => TrustPolicyEngine.setRole({ role: 'wizard', account: BENEFICIARY }), /role must be one of/);

  const limits = await TrustPolicyEngine.setTokenLimits({ token: USDC, maxPerDistribution: '25000000000', periodCap: '100000000000', periodSeconds: 2592000 });
  assert.deepStrictEqual(limits.call.params, [USDC, true, '25000000000', '100000000000', 2592000]);

  // Beneficiary ceilings are per token, since the units are the token's.
  const perBeneficiary = await TrustPolicyEngine.setBeneficiaryLimits({ beneficiary: BENEFICIARY, maxPerDistribution: '500000000' });
  assert.deepStrictEqual(perBeneficiary.call.params, [BENEFICIARY, USDC, '500000000', '0', 0]);

  const previous = process.env.TRUST_POLICY_ADDRESS;
  delete process.env.TRUST_POLICY_ADDRESS;
  try {
    await assert.rejects(() => TrustPolicyEngine.pause(), (err) => err.code === 'TRUST_POLICY_NOT_CONFIGURED' && err.status === 409);
  } finally {
    process.env.TRUST_POLICY_ADDRESS = previous;
  }
}

async function testStateReadsMapTuples() {
  const calls = [];
  const original = ThirdwebServerWalletEngine.readContract;
  ThirdwebServerWalletEngine.readContract = async ({ calls: batch }) => {
    calls.push(...batch.map((c) => c.method.split(/[ (]/)[1]));
    if (batch.length === 11) return ['0xOwner', false, 2, 86400, 86400, 0, '3', '1', '1000000000', '250000000', '750000000'];
    // distributions(id) tuple followed by escrowOf(id)
    return [[
      USDC, BENEFICIARY, '250000000', purposeHex('medical'), refHex('DR-77'),
      '0x1A904F795a0511C31Ba6347504D08d1bA58E4f89', 1750000000, 1750003600, 1750090000, 0, 1, 0, 2, 3,
    ], '7'];
  };
  try {
    const status = await TrustPolicyEngine.status();
    assert.strictEqual(status.approvalThreshold, 2);
    assert.deepStrictEqual(status.treasury, { token: USDC, balance: '1000000000', reserved: '250000000', available: '750000000' });

    const distribution = await TrustPolicyEngine.distribution('4');
    assert.strictEqual(distribution.status, 'executed');
    assert.strictEqual(distribution.purpose, 'medical');
    assert.strictEqual(distribution.approvals, 2);
    assert.strictEqual(distribution.escrowId, '7');
    assert.strictEqual(distribution.beneficiary, BENEFICIARY);
  } finally {
    ThirdwebServerWalletEngine.readContract = original;
  }
  assert.ok(calls.includes('available'));
}

async function testEnforcementBlocksDirectSends() {
  process.env.TRUST_POLICY_ENFORCED = 'true';
  process.env.THIRDWEB_PRICE_FALLBACK_TO_CALLER = 'true';
  try {
    await assert.rejects(
      () => ThirdwebServerWalletEngine.send({ to: BENEFICIARY, quantity: '1000000', tokenAddress: USDC, amountUsd: 1, requesterRole: 'trustee', purpose: 'medical' }),
      (err) => err.code === 'TRUST_POLICY_ENFORCED' && err.status === 409
    );
  } finally {
    delete process.env.TRUST_POLICY_ENFORCED;
  }

  // Without enforcement the existing rail is untouched (shadow, nothing sent).
  const record = await ThirdwebServerWalletEngine.send({
    to: BENEFICIARY, quantity: '1000000', tokenAddress: USDC, amountUsd: 1, requesterRole: 'trustee', purpose: 'medical',
  });
  assert.strictEqual(record.status, 'shadow');
}

async function main() {
  testPurposeAndRefEncoding();
  testReadiness();
  await testShadowProposeEncodesTheCall();
  await testGovernanceCallsAreGated();
  await testStateReadsMapTuples();
  await testEnforcementBlocksDirectSends();
  console.log('TrustPolicyEngine wiring validation passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
