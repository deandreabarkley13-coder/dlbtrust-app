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
  maxFeePerGas: 85916116n,
  maxPriorityFeePerGas: 20000n,
  paymasterAndData: '0x3e7934bfdc432dfafaf1a68f4226b87478b9ee89000000000000000000000000000000000000000000000000000000006a7685de0000000000000000000000000000000000000000000000000000000000000000a9e4fc1c08fa54370d20b2868c9cf5f2e6289ac928e90e65738a658c0c507fc7660ef15577c0aa7d5c140216d23fd036a39d980e3d71dc832eb0fc3a039610a71b',
  signature: '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c',
};

const publicClient = createPublicClient({ chain: mainnet, transport: http('https://ethereum-rpc.publicnode.com') });
const fs = require('fs');
const paymasterAbi = JSON.parse(fs.readFileSync('./artifacts/SovereignTrustPaymaster_sol_SovereignTrustPaymaster.abi', 'utf8'));

async function main() {
  const owner = await publicClient.readContract({ address: PAYMASTER, abi: paymasterAbi, functionName: 'owner' });
  console.log('paymaster owner:', owner, 'expected operator:', OPERATOR, 'match:', owner.toLowerCase() === OPERATOR.toLowerCase());

  const parsed = await publicClient.readContract({ address: PAYMASTER, abi: paymasterAbi, functionName: 'parsePaymasterAndData', args: [userOp.paymasterAndData] });
  console.log('parsed validUntil', parsed[0], 'validAfter', parsed[1], 'sig bytes', (parsed[2].length - 2) / 2);

  const hashActual = await publicClient.readContract({ address: PAYMASTER, abi: paymasterAbi, functionName: 'getHash', args: [userOp, parsed[0], parsed[1]] });
  console.log('getHash(actual userOp):', hashActual);

  const userOpNoInit = { ...userOp, initCode: '0x' };
  const hashNoInit = await publicClient.readContract({ address: PAYMASTER, abi: paymasterAbi, functionName: 'getHash', args: [userOpNoInit, parsed[0], parsed[1]] });
  console.log('getHash(no initCode):', hashNoInit);

  const sig = parsed[2];
  console.log('sig:', sig);
  try {
    const recovered = await recoverMessageAddress({ message: { raw: hashActual }, signature: sig });
    console.log('recover(actual):', recovered, 'operator:', OPERATOR, 'match:', recovered.toLowerCase() === OPERATOR.toLowerCase());
  } catch (e) { console.log('recover(actual) error:', e.message); }

  // Simulate validatePaymasterUserOp from the EntryPoint
  try {
    const data = publicClient.encodeFunctionData ? null : null;
    const { encodeFunctionData } = require('viem');
    const simulateData = encodeFunctionData({
      abi: paymasterAbi,
      functionName: 'validatePaymasterUserOp',
      args: [userOp, '0x' + '00'.repeat(32), 0],
    });
    const result = await publicClient.call({ to: PAYMASTER, data: simulateData, account: { address: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789', type: 'json-rpc' } });
    console.log('simulate validatePaymasterUserOp result:', result);
  } catch (e) { console.log('simulate validatePaymasterUserOp error:', e.message, e.cause?.shortMessage); }
}

main().catch(console.error);
