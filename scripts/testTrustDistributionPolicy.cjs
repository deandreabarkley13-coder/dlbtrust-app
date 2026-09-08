/**
 * TrustDistributionPolicy contract suite. Runs against a local EVM:
 *
 *   node scripts/compileTrustDistributionPolicy.cjs
 *   npx hardhat node &            # or any RPC at TEST_RPC_URL with unlocked funded accounts
 *   node scripts/testTrustDistributionPolicy.cjs
 *
 * Covers every on-chain control: role gating, purpose and beneficiary
 * allow-lists, per-distribution and rolling-period ceilings, maker/checker
 * approval, timelock, expiry, escrowed release, installment vesting, clawback,
 * freeze, pause, reservation accounting, and the native-asset path.
 */
const fs = require('fs');
const path = require('path');
const viem = require('viem');
const { privateKeyToAccount } = require('viem/accounts');

const RPC_URL = process.env.TEST_RPC_URL || 'http://127.0.0.1:8545';
const ARTIFACTS = path.join(__dirname, '..', 'artifacts');

// Deterministic hardhat/anvil development keys — never used on a live network.
const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
];

const chain = {
  id: 31337,
  name: 'local',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

const ROLE = { MAKER: 0, CHECKER: 1, EXECUTOR: 2, PAUSER: 3, COMPLIANCE: 4 };
const NATIVE = '0x0000000000000000000000000000000000000000';
const DAY = 86400;

function artifact(name) {
  return {
    abi: JSON.parse(fs.readFileSync(path.join(ARTIFACTS, `${name}.abi`), 'utf8')),
    bytecode: `0x${fs.readFileSync(path.join(ARTIFACTS, `${name}.bin`), 'utf8').trim()}`,
  };
}

let passed = 0;
const failures = [];

function ok(label, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ok   ${label}`); return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}

function eq(label, actual, expected) {
  ok(label, actual === expected, `expected ${expected}, got ${actual}`);
}

async function rejects(label, promise, needle) {
  try {
    await promise;
  } catch (e) {
    const message = String(e.shortMessage || e.message || e);
    ok(label, message.includes(needle), `expected "${needle}" in "${message.split('\n')[0]}"`);
    return;
  }
  ok(label, false, 'call unexpectedly succeeded');
}

function purpose(text) { return viem.stringToHex(text, { size: 32 }); }
let refSeq = 0;
function nextRef() { refSeq += 1; return viem.stringToHex(`DR-${refSeq}`, { size: 32 }); }

(async () => {
  const publicClient = viem.createPublicClient({ chain, transport: viem.http(RPC_URL) });
  const accounts = KEYS.map((key) => privateKeyToAccount(key));
  const [trustee, maker, checkerA, checkerB, executor, beneficiary] = accounts;
  const wallets = Object.fromEntries(accounts.map((account) => [
    account.address.toLowerCase(),
    viem.createWalletClient({ account, chain, transport: viem.http(RPC_URL) }),
  ]));
  const as = (account) => wallets[account.address.toLowerCase()];

  async function send(account, contract, functionName, args = [], value) {
    const hash = await as(account).writeContract({ address: contract.address, abi: contract.abi, functionName, args, value });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted`);
    return receipt;
  }
  async function simulate(account, contract, functionName, args = []) {
    return publicClient.simulateContract({ account: account.address, address: contract.address, abi: contract.abi, functionName, args });
  }
  async function read(contract, functionName, args = []) {
    return publicClient.readContract({ address: contract.address, abi: contract.abi, functionName, args });
  }
  async function deploy(name, args, account = trustee) {
    const { abi, bytecode } = artifact(name);
    const hash = await as(account).deployContract({ abi, bytecode, args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return { address: receipt.contractAddress, abi };
  }
  async function warp(seconds) {
    await publicClient.request({ method: 'evm_increaseTime', params: [viem.numberToHex(seconds)] });
    await publicClient.request({ method: 'evm_mine', params: [] });
  }

  // ── Fixture: 2-of-N checkers, 1 day timelock, 1 day clawback window ──────────
  const token = await deploy('contracts_test_MockERC20_sol_MockERC20', []);
  const policy = await deploy('contracts_TrustDistributionPolicy_sol_TrustDistributionPolicy', [
    trustee.address, 2, BigInt(DAY), BigInt(DAY),
  ]);
  await send(trustee, token, 'mint', [policy.address, 1_000_000_000n]); // 1,000 mUSD (6dp)
  await send(trustee, policy, 'setRole', [ROLE.MAKER, maker.address, true]);
  await send(trustee, policy, 'setRole', [ROLE.CHECKER, checkerA.address, true]);
  await send(trustee, policy, 'setRole', [ROLE.CHECKER, checkerB.address, true]);
  await send(trustee, policy, 'setRole', [ROLE.EXECUTOR, executor.address, true]);
  await send(trustee, policy, 'setPurpose', [purpose('medical'), true]);
  await send(trustee, policy, 'setTokenLimits', [token.address, true, 500_000_000n, 600_000_000n, DAY * 30]);
  await send(trustee, policy, 'setBeneficiary', [beneficiary.address, true]);
  await send(trustee, policy, 'setBeneficiaryLimits', [beneficiary.address, token.address, 200_000_000n, 300_000_000n, DAY * 30]);
  // Rolling ceilings bucket on block.timestamp / periodSeconds, so start the
  // suite at a period boundary: otherwise the few days the earlier sections
  // warp through could cross into the next bucket and reset the caps under
  // test depending on when the suite happens to run.
  const start = await publicClient.getBlock();
  await warp((DAY * 30) - (Number(start.timestamp) % (DAY * 30)) + 1);

  console.log('\ngovernance and gating');
  eq('trustee is owner', (await read(policy, 'owner')).toLowerCase(), trustee.address.toLowerCase());
  ok('maker role recorded', await read(policy, 'hasRole', [ROLE.MAKER, maker.address]));
  eq('full balance is unreserved', await read(policy, 'available', [token.address]), 1_000_000_000n);
  await rejects('non-maker cannot propose',
    simulate(checkerA, policy, 'propose', [token.address, beneficiary.address, 1_000_000n, purpose('medical'), nextRef(), 0n, 1, 0]),
    'role missing');
  await rejects('unknown purpose refused',
    simulate(maker, policy, 'propose', [token.address, beneficiary.address, 1_000_000n, purpose('yacht'), nextRef(), 0n, 1, 0]),
    'purpose not allowed');
  await rejects('non-allow-listed beneficiary refused',
    simulate(maker, policy, 'propose', [token.address, checkerA.address, 1_000_000n, purpose('medical'), nextRef(), 0n, 1, 0]),
    'beneficiary not allowed');
  await rejects('over per-distribution cap refused',
    simulate(maker, policy, 'propose', [token.address, beneficiary.address, 250_000_000n, purpose('medical'), nextRef(), 0n, 1, 0]),
    'over beneficiary per-distribution cap');
  await rejects('unpriced token refused',
    simulate(maker, policy, 'propose', [NATIVE, beneficiary.address, 1n, purpose('medical'), nextRef(), 0n, 1, 0]),
    'token not allowed');

  console.log('\nmaker/checker approval and timelock');
  const ref1 = nextRef();
  await send(maker, policy, 'propose', [token.address, beneficiary.address, 100_000_000n, purpose('medical'), ref1, 0n, 1, 0]);
  const id1 = await read(policy, 'distributionCount');
  eq('proposal recorded', (await read(policy, 'distributions', [id1])).status, 1);
  await rejects('reference cannot be reused',
    simulate(maker, policy, 'propose', [token.address, beneficiary.address, 1_000_000n, purpose('medical'), ref1, 0n, 1, 0]),
    'ref invalid');
  await rejects('a maker without the checker role cannot approve', simulate(maker, policy, 'approve', [id1]), 'role missing');
  // A checker who proposed cannot also approve, even holding both roles.
  await send(trustee, policy, 'setRole', [ROLE.MAKER, checkerA.address, true]);
  await send(checkerA, policy, 'propose', [token.address, beneficiary.address, 1_000_000n, purpose('medical'), nextRef(), 0n, 1, 0]);
  const selfApproved = await read(policy, 'distributionCount');
  await rejects('proposer cannot approve own proposal', simulate(checkerA, policy, 'approve', [selfApproved]), 'proposer cannot approve');
  await send(checkerA, policy, 'cancel', [selfApproved, purpose('test')]);
  await send(trustee, policy, 'setRole', [ROLE.MAKER, checkerA.address, false]);
  await send(checkerA, policy, 'approve', [id1]);
  eq('one approval leaves it proposed', (await read(policy, 'distributions', [id1])).status, 1);
  await rejects('same checker cannot approve twice', simulate(checkerA, policy, 'approve', [id1]), 'already approved');
  await rejects('unapproved distribution cannot execute', simulate(executor, policy, 'execute', [id1]), 'not approved');
  await send(checkerB, policy, 'approve', [id1]);
  const approved = await read(policy, 'distributions', [id1]);
  eq('threshold reached', approved.status, 2);
  ok('timelock eta set one day out', approved.eta === approved.approvedAt + BigInt(DAY), `eta ${approved.eta}`);
  await rejects('execute refused before the timelock', simulate(executor, policy, 'execute', [id1]), 'timelocked');
  await warp(DAY + 1);
  await rejects('non-executor cannot execute', simulate(maker, policy, 'execute', [id1]), 'role missing');

  console.log('\nescrowed release and clawback window');
  await send(executor, policy, 'execute', [id1]);
  const escrow1 = await read(policy, 'escrowCount');
  eq('distribution executed', (await read(policy, 'distributions', [id1])).status, 3);
  eq('amount reserved, not paid', await read(policy, 'reserved', [token.address]), 100_000_000n);
  eq('unreserved balance reduced', await read(policy, 'available', [token.address]), 900_000_000n);
  eq('beneficiary not yet paid', await read(token, 'balanceOf', [beneficiary.address]), 0n);
  eq('nothing claimable inside the clawback window', await read(policy, 'claimable', [escrow1]), 0n);
  await rejects('claim refused inside the clawback window', simulate(beneficiary, policy, 'claim', [escrow1]), 'nothing claimable');
  await warp(DAY + 1);
  eq('fully claimable after the window', await read(policy, 'claimable', [escrow1]), 100_000_000n);
  await send(beneficiary, policy, 'claim', [escrow1]);
  eq('beneficiary paid', await read(token, 'balanceOf', [beneficiary.address]), 100_000_000n);
  eq('reservation released', await read(policy, 'reserved', [token.address]), 0n);
  eq('nothing left to claim', await read(policy, 'claimable', [escrow1]), 0n);

  console.log('\nrolling period ceiling');
  // 300 mUSD/30d beneficiary cap, 100 already spent: 200 fits, the next 100 does not.
  const id2 = await propose(200_000_000n);
  await approveAndPass(id2);
  await send(executor, policy, 'execute', [id2]);
  const [benRemaining] = await read(policy, 'remainingPeriodAllowance', [token.address, beneficiary.address]);
  eq('period allowance exhausted', benRemaining, 0n);
  const id3 = await propose(50_000_000n);
  await approveAndPass(id3);
  await rejects('over-period execute refused', simulate(executor, policy, 'execute', [id3]), 'over beneficiary period cap');
  await warp(DAY * 31);
  await send(executor, policy, 'execute', [id3]);
  eq('next period resets the allowance', (await read(policy, 'distributions', [id3])).status, 3);

  console.log('\nclawback');
  const clawed = await read(policy, 'escrowCount');
  const reservedBefore = await read(policy, 'reserved', [token.address]);
  await send(trustee, policy, 'revoke', [clawed, purpose('sanctions-hit')]);
  eq('revoked escrow releases its reservation', await read(policy, 'reserved', [token.address]), reservedBefore - 50_000_000n);
  eq('revoked escrow is unclaimable', await read(policy, 'claimable', [clawed]), 0n);
  await rejects('claim refused after revocation', simulate(beneficiary, policy, 'claim', [clawed]), 'revoked');

  console.log('\ninstallment vesting');
  await warp(DAY * 31);
  const id4 = await propose(120_000_000n, { installments: 4, interval: DAY * 7 });
  await approveAndPass(id4);
  await send(executor, policy, 'execute', [id4]);
  const vesting = await read(policy, 'escrowCount');
  await warp(DAY + 1); // clawback window elapsed: first tranche only
  eq('first tranche vested', await read(policy, 'claimable', [vesting]), 30_000_000n);
  const paidBefore = await read(token, 'balanceOf', [beneficiary.address]);
  await send(beneficiary, policy, 'claim', [vesting]);
  eq('first tranche paid', await read(token, 'balanceOf', [beneficiary.address]), paidBefore + 30_000_000n);
  await warp(DAY * 7);
  eq('second tranche vested', await read(policy, 'claimable', [vesting]), 30_000_000n);
  await warp(DAY * 21);
  eq('remainder vested at the end of the schedule', await read(policy, 'claimable', [vesting]), 90_000_000n);
  await send(beneficiary, policy, 'claim', [vesting]);
  eq('schedule fully paid', await read(token, 'balanceOf', [beneficiary.address]), paidBefore + 120_000_000n);
  await rejects('nothing left after the schedule', simulate(beneficiary, policy, 'claim', [vesting]), 'nothing claimable');

  console.log('\nfreeze, pause and expiry');
  await warp(DAY * 31);
  const id5 = await propose(10_000_000n);
  await approveAndPass(id5);
  await send(trustee, policy, 'setFrozen', [beneficiary.address, true]);
  await rejects('frozen beneficiary cannot be executed', simulate(executor, policy, 'execute', [id5]), 'beneficiary frozen');
  await rejects('frozen beneficiary cannot be proposed for',
    simulate(maker, policy, 'propose', [token.address, beneficiary.address, 1_000_000n, purpose('medical'), nextRef(), 0n, 1, 0]),
    'beneficiary frozen');
  await send(trustee, policy, 'setFrozen', [beneficiary.address, false]);
  await send(executor, policy, 'execute', [id5]);
  const frozenEscrow = await read(policy, 'escrowCount');
  await send(trustee, policy, 'setFrozen', [beneficiary.address, true]);
  await warp(DAY + 1);
  await rejects('frozen beneficiary cannot claim', simulate(beneficiary, policy, 'claim', [frozenEscrow]), 'beneficiary frozen');
  await send(trustee, policy, 'setFrozen', [beneficiary.address, false]);

  await send(trustee, policy, 'pause', []);
  await rejects('paused: no proposals',
    simulate(maker, policy, 'propose', [token.address, beneficiary.address, 1_000_000n, purpose('medical'), nextRef(), 0n, 1, 0]),
    'paused');
  await rejects('paused: no claims', simulate(beneficiary, policy, 'claim', [frozenEscrow]), 'paused');
  await rejects('pauser cannot unpause', simulate(maker, policy, 'unpause', []), 'not owner');
  await send(trustee, policy, 'unpause', []);
  await send(beneficiary, policy, 'claim', [frozenEscrow]);

  const now = await publicClient.getBlock().then((b) => b.timestamp);
  const id6 = await propose(10_000_000n, { expiresAt: now + BigInt(DAY + DAY / 2) });
  await approveAndPass(id6);
  await warp(DAY);
  await rejects('execute refused after expiry', simulate(executor, policy, 'execute', [id6]), 'expired');
  const cancelled = await propose(10_000_000n);
  await send(maker, policy, 'cancel', [cancelled, purpose('duplicate')]);
  eq('cancelled proposal is terminal', (await read(policy, 'distributions', [cancelled])).status, 4);
  await rejects('cancelled proposal cannot be approved', simulate(checkerA, policy, 'approve', [cancelled]), 'not proposed');

  console.log('\nreservation accounting and native asset');
  const balance = await read(policy, 'balanceOfToken', [token.address]);
  const free = await read(policy, 'available', [token.address]);
  const held = await read(policy, 'reserved', [token.address]);
  ok('available == balance - reserved', free === balance - held, `${free} vs ${balance} - ${held}`);
  const tooBig = await propose(200_000_000n);
  await approveAndPass(tooBig);
  await send(trustee, policy, 'setTokenLimits', [token.address, true, 0n, 0n, 0]);
  await send(trustee, policy, 'setBeneficiaryLimits', [beneficiary.address, token.address, 200_000_000n, 0n, 0]);
  // Drain the unreserved balance through a second allow-listed recipient so the queued one cannot be funded.
  await send(trustee, policy, 'setBeneficiary', [checkerA.address, true]);
  const drainRef = nextRef();
  await send(maker, policy, 'propose', [token.address, checkerA.address, free, purpose('medical'), drainRef, 0n, 1, 0]);
  const drain = await read(policy, 'distributionCount');
  await approveAndPass(drain);
  await send(executor, policy, 'execute', [drain]);
  await rejects('execute refused when the unreserved balance is short',
    simulate(executor, policy, 'execute', [tooBig]), 'insufficient unreserved balance');

  await send(trustee, policy, 'setTokenLimits', [NATIVE, true, 0n, 0n, 0]);
  // Ceilings are per token, so the mUSD ceilings do not constrain a wei-denominated release.
  await send(trustee, policy, 'setBeneficiaryLimits', [beneficiary.address, NATIVE, viem.parseEther('1.5'), 0n, 0]);
  await as(trustee).sendTransaction({ to: policy.address, value: viem.parseEther('2') });
  eq('native deposit is available', await read(policy, 'available', [NATIVE]), viem.parseEther('2'));
  const nativeId = await propose(viem.parseEther('1'), { token: NATIVE });
  await approveAndPass(nativeId);
  await send(executor, policy, 'execute', [nativeId]);
  await warp(DAY + 1);
  const ethBefore = await publicClient.getBalance({ address: beneficiary.address });
  await send(trustee, policy, 'claim', [await read(policy, 'escrowCount')]); // anyone may trigger; funds go to the beneficiary
  const ethAfter = await publicClient.getBalance({ address: beneficiary.address });
  ok('native claim paid the beneficiary', ethAfter - ethBefore === viem.parseEther('1'), `${ethAfter - ethBefore}`);

  async function propose(amount, { token: t = token.address, installments = 1, interval = 0, expiresAt = 0n } = {}) {
    await send(maker, policy, 'propose', [t, beneficiary.address, amount, purpose('medical'), nextRef(), expiresAt, installments, interval]);
    return read(policy, 'distributionCount');
  }
  async function approveAndPass(id) {
    await send(checkerA, policy, 'approve', [id]);
    await send(checkerB, policy, 'approve', [id]);
    await warp(DAY + 1);
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
  console.log('TrustDistributionPolicy: all on-chain controls verified');
})().catch((e) => { console.error(e); process.exit(1); });
