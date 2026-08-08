const { createPublicClient, http, encodeFunctionData, recoverMessageAddress } = require('viem');
const { getUserOperationHash } = require('viem/account-abstraction');
const { mainnet } = require('viem/chains');
const fs = require('fs');

const ENTRYPOINT = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';
const SENDER = '0x07c8b3B09F3d57FF811A4197b62883ec111ce6a2';
const OWNER = '0x3e53028cf69949f3B961ce786Baf2D4D75166562';

function makeUserOp(initCode, sig) {
  return {
    sender: SENDER,
    nonce: 0n,
    initCode,
    callData: '0xb61d27f6000000000000000000000000b01e6280ffe6faac679a17b029df8e065e8d0002000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044a9059cbb0000000000000000000000003e53028cf69949f3b961ce786baf2d4d75166562000000000000000000000000000000000000000000000000000000000000271000000000000000000000000000000000000000000000000000000000',
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    maxFeePerGas: 85916116n,
    maxPriorityFeePerGas: 20000n,
    paymasterAndData: '0x3e7934bfdc432dfafaf1a68f4226b87478b9ee89000000000000000000000000000000000000000000000000000000006a7685de0000000000000000000000000000000000000000000000000000000000000000a9e4fc1c08fa54370d20b2868c9cf5f2e6289ac928e90e65738a658c0c507fc7660ef15577c0aa7d5c140216d23fd036a39d980e3d71dc832eb0fc3a039610a71b',
    signature: sig,
  };
}

const publicClient = createPublicClient({ chain: mainnet, transport: http('https://ethereum-rpc.publicnode.com') });
const entryPointAbi = JSON.parse(fs.readFileSync('./entrypoint-abi.json', 'utf8'));

async function test(label, userOp) {
  const userOpHash = getUserOperationHash({ userOperation: userOp, entryPointAddress: ENTRYPOINT, chainId: 1, entryPointVersion: '0.6' });
  console.log(`\n[${label}] userOpHash:`, userOpHash);
  try {
    const rec = await recoverMessageAddress({ message: { raw: userOpHash }, signature: userOp.signature });
    console.log(`[${label}] account signature recovers:`, rec, 'match owner:', rec.toLowerCase() === OWNER.toLowerCase());
  } catch (e) { console.log(`[${label}] account sig recover error:`, e.message); }

  try {
    const data = encodeFunctionData({ abi: entryPointAbi, functionName: 'simulateValidation', args: [userOp] });
    const result = await publicClient.call({ to: ENTRYPOINT, data });
    console.log(`[${label}] simulateValidation result:`, result);
  } catch (e) {
    console.error(`[${label}] simulateValidation error:`, e.shortMessage || e.message);
  }
}

async function main() {
  const orig = makeUserOp('0x9406Cc6185a346906296840746125a0E449764545fbfb9cf0000000000000000000000003e53028cf69949f3b961ce786baf2d4d751665620000000000000000000000000000000000000000000000000000000000000000', '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c');
  const noinit = makeUserOp('0x', '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c');
  await test('orig-stub', orig);
  await test('no-init-stub', noinit);

  // Check paymaster getHash for both against the paymasterAndData signature
  const paymasterAbi = JSON.parse(fs.readFileSync('./artifacts/SovereignTrustPaymaster_sol_SovereignTrustPaymaster.abi', 'utf8'));
  const publicClient = createPublicClient({ chain: mainnet, transport: http('https://ethereum-rpc.publicnode.com') });
  for (const [label, uo] of [['orig', orig], ['no-init', noinit]]) {
    const parsed = await publicClient.readContract({ address: '0x3e7934bfdc432dfafaf1a68f4226b87478b9ee89', abi: paymasterAbi, functionName: 'parsePaymasterAndData', args: [uo.paymasterAndData] });
    const hash = await publicClient.readContract({ address: '0x3e7934bfdc432dfafaf1a68f4226b87478b9ee89', abi: paymasterAbi, functionName: 'getHash', args: [uo, parsed[0], parsed[1]] });
    const rec = await recoverMessageAddress({ message: { raw: hash }, signature: parsed[2] });
    console.log(`[paymaster ${label}] getHash:`, hash, 'recovered:', rec, 'match owner:', rec.toLowerCase() === OWNER.toLowerCase());
  }
}

main().catch(console.error);
