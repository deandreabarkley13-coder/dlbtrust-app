const { createPublicClient, http, parseAbi, keccak256, encodeAbiParameters, recoverMessageAddress, concat, parseEther, formatEther } = require('viem');
const { mainnet } = require('viem/chains');

const PAYMASTER = '0x373bb5143a0d5626d961bd7b69ef9ad704cb3ac3';
const ENTRYPOINT = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';
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
  maxFeePerGas: 106684856n,
  maxPriorityFeePerGas: 20000n,
  paymasterAndData: '0x373bb5143a0d5626d961bd7b69ef9ad704cb3ac300000000000000000000000000000000000000000000000000000006a7683d60000000000000000000000000000000000000000000000000000000000000000feb850f0383cf9c596995ee0cb189621df4b2aef83b7c4832719063aaa8f04fa424cfe2d4d68f725e18da011c32e57ec6fdda4b5db68b6ded425806ed0d76b911b',
  signature: '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c',
};

const publicClient = createPublicClient({ chain: mainnet, transport: http('https://ethereum-rpc.publicnode.com') });

const fs = require('fs');
const paymasterAbi = JSON.parse(fs.readFileSync('./artifacts/SovereignTrustPaymaster_sol_SovereignTrustPaymaster.abi', 'utf8'));

async function main() {
  const parsed = await publicClient.readContract({ address: PAYMASTER, abi: paymasterAbi, functionName: 'parsePaymasterAndData', args: [userOp.paymasterAndData] });
  console.log('parsed validUntil', parsed[0], 'validAfter', parsed[1], 'sig length', parsed[2].length);

  const hashActual = await publicClient.readContract({ address: PAYMASTER, abi: paymasterAbi, functionName: 'getHash', args: [userOp, parsed[0], parsed[1]] });
  console.log('getHash(actual userOp):', hashActual);

  const userOpSanitized = { ...userOp, paymasterAndData: '0x', signature: '0x' };
  const hashSanitized = await publicClient.readContract({ address: PAYMASTER, abi: paymasterAbi, functionName: 'getHash', args: [userOpSanitized, parsed[0], parsed[1]] });
  console.log('getHash(sanitized):', hashSanitized);

  const sig = parsed[2];
  console.log('sig:', sig);
  try {
    const recoveredActual = recoverMessageAddress({ message: { raw: hashActual }, signature: sig });
    console.log('recover(actual):', recoveredActual, 'operator:', OPERATOR, 'match:', recoveredActual.toLowerCase() === OPERATOR.toLowerCase());
  } catch (e) { console.log('recover(actual) error:', e.message); }
  try {
    const recoveredSanitized = recoverMessageAddress({ message: { raw: hashSanitized }, signature: sig });
    console.log('recover(sanitized):', recoveredSanitized, 'operator:', OPERATOR, 'match:', recoveredSanitized.toLowerCase() === OPERATOR.toLowerCase());
  } catch (e) { console.log('recover(sanitized) error:', e.message); }
}

main().catch(console.error);
