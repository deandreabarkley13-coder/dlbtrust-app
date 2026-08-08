const { createPublicClient, http, recoverMessageAddress } = require('viem');
const { mainnet } = require('viem/chains');

const PAYMASTER = '0x3e7934bfdc432dfafaf1a68f4226b87478b9ee89';
const OPERATOR = '0x3e53028cf69949f3B961ce786Baf2D4D75166562';
const SENDER = '0x07c8b3B09F3d57FF811A4197b62883ec111ce6a2';

const userOp = {
  sender: SENDER,
  nonce: 0n,
  initCode: '0x9406Cc6185a346906296840746125a0E449764545fbfb9cf0000000000000000000000003e53028cf69949f3b961ce786baf2d4d751665620000000000000000000000000000000000000000000000000000000000000000',
  callData: '0xb61d27f6000000000000000000000000b01e6280ffe6faac679a17b029df8e065e8d0002000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044a9059cbb0000000000000000000000003e53028cf69949f3b961ce786baf2d4d75166562000000000000000000000000000000000000000000000000000000000000271000000000000000000000000000000000000000000000000000000000',
  callGasLimit: 0n,
  verificationGasLimit: 0n,
  preVerificationGas: 0n,
  maxFeePerGas: 116281738n,
  maxPriorityFeePerGas: 20000n,
  paymasterAndData: '0x3e7934bfdc432dfafaf1a68f4226b87478b9ee89000000000000000000000000000000000000000000000000000000006a7685310000000000000000000000000000000000000000000000000000000000000000632b34c65df015676ee8b9d78c4f3b3ce38f89d1aa78753cd7751123f32a83475bc70ddba80a825352bafad09f218cc64e521cb6c35fddadc1d6fc26bd68422b1c',
  signature: '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c',
};

const publicClient = createPublicClient({ chain: mainnet, transport: http('https://ethereum-rpc.publicnode.com') });
const fs = require('fs');
const paymasterAbi = JSON.parse(fs.readFileSync('./artifacts/SovereignTrustPaymaster_sol_SovereignTrustPaymaster.abi', 'utf8'));

async function main() {
  const owner = await publicClient.readContract({ address: PAYMASTER, abi: paymasterAbi, functionName: 'owner' });
  console.log('paymaster owner:', owner, 'expected operator:', OPERATOR, 'match:', owner.toLowerCase() === OPERATOR.toLowerCase());

  const parsed = await publicClient.readContract({ address: PAYMASTER, abi: paymasterAbi, functionName: 'parsePaymasterAndData', args: [userOp.paymasterAndData] });
  console.log('parsed validUntil', parsed[0], 'validAfter', parsed[1], 'sig hex length', parsed[2].length, 'sig bytes', (parsed[2].length - 2) / 2);

  const hashActual = await publicClient.readContract({ address: PAYMASTER, abi: paymasterAbi, functionName: 'getHash', args: [userOp, parsed[0], parsed[1]] });
  console.log('getHash(actual userOp):', hashActual);

  const userOpSanitized = { ...userOp, paymasterAndData: '0x', signature: '0x' };
  const hashSanitized = await publicClient.readContract({ address: PAYMASTER, abi: paymasterAbi, functionName: 'getHash', args: [userOpSanitized, parsed[0], parsed[1]] });
  console.log('getHash(sanitized):', hashSanitized);

  const sig = parsed[2];
  console.log('sig:', sig);

  // Maybe the server signed a hash with default gas values
  const userOpDefaults = { ...userOpSanitized, callGasLimit: 100000n, verificationGasLimit: 100000n, preVerificationGas: 50000n, maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 100000000n };
  const hashDefaults = await publicClient.readContract({ address: PAYMASTER, abi: paymasterAbi, functionName: 'getHash', args: [userOpDefaults, parsed[0], parsed[1]] });
  console.log('getHash(defaults):', hashDefaults);
  try {
    const recoveredDefaults = await recoverMessageAddress({ message: { raw: hashDefaults }, signature: sig });
    console.log('recover(defaults):', recoveredDefaults, 'operator:', OPERATOR, 'match:', recoveredDefaults.toLowerCase() === OPERATOR.toLowerCase());
  } catch (e) { console.log('recover(defaults) error:', e.message); }

  // Or maybe server signed the EntryPoint userOpHash instead of getHash
  const { getUserOperationHash } = require('viem/account-abstraction');
  const userOpHash = getUserOperationHash({ userOperation: userOp, entryPointAddress: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789', chainId: 1, entryPointVersion: '0.6' });
  console.log('entryPoint userOpHash:', userOpHash);
  try {
    const recoveredUoH = await recoverMessageAddress({ message: { raw: userOpHash }, signature: sig });
    console.log('recover(userOpHash):', recoveredUoH, 'operator:', OPERATOR, 'match:', recoveredUoH.toLowerCase() === OPERATOR.toLowerCase());
  } catch (e) { console.log('recover(userOpHash) error:', e.message); }

  try {
    const recoveredActual = await recoverMessageAddress({ message: { raw: hashActual }, signature: sig });
    console.log('recover(actual):', recoveredActual, 'operator:', OPERATOR, 'match:', recoveredActual.toLowerCase() === OPERATOR.toLowerCase());
  } catch (e) { console.log('recover(actual) error:', e.message); }
  try {
    const recoveredSanitized = await recoverMessageAddress({ message: { raw: hashSanitized }, signature: sig });
    console.log('recover(sanitized):', recoveredSanitized, 'operator:', OPERATOR, 'match:', recoveredSanitized.toLowerCase() === OPERATOR.toLowerCase());
  } catch (e) { console.log('recover(sanitized) error:', e.message); }
}

main().catch(console.error);
