const { createPublicClient, http, encodeFunctionData, recoverMessageAddress, parseAbi } = require('viem');
const { getUserOperationHash } = require('viem/account-abstraction');
const { mainnet } = require('viem/chains');
const fs = require('fs');

const ENTRYPOINT = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';
const SENDER = '0x07c8b3B09F3d57FF811A4197b62883ec111ce6a2';
const OWNER = '0x3e53028cf69949f3B961ce786Baf2D4D75166562';
const PAYMASTER = '0x733b605280321bea782d2fcc604eba3fc269d57c';
const TOKEN = '0xb01e6280ffe6faac679a17b029df8e065e8d0002';

const publicClient = createPublicClient({ chain: mainnet, transport: http('https://ethereum-rpc.publicnode.com') });
const entryPointAbi = JSON.parse(fs.readFileSync('./entrypoint-abi.json', 'utf8'));
const paymasterAbi = JSON.parse(fs.readFileSync('./artifacts/SovereignTrustPaymaster_sol_SovereignTrustPaymaster.abi', 'utf8'));

async function buildUserOp() {
  const operator = require('./server/integrations/dapp/config')? // not available
  // use stub signature for now; simulateHandleOp will still run callData if sig invalid?
  const stubSig = '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c';

  // Build paymasterAndData with real operator signature
  const validUntil = Math.floor(Date.now()/1000) + 3600;
  const validAfter = 0;
  const validityBytes = require('viem').encodeAbiParameters([{type:'uint48'},{type:'uint48'}], [validUntil, validAfter]);

  const userOp = {
    sender: SENDER,
    nonce: 0n,
    initCode: '0x9406Cc6185a346906296840746125a0E449764545fbfb9cf0000000000000000000000003e53028cf69949f3b961ce786baf2d4d751665620000000000000000000000000000000000000000000000000000000000000000',
    callData: '0xb61d27f6000000000000000000000000b01e6280ffe6faac679a17b029df8e065e8d0002000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044a9059cbb0000000000000000000000003e53028cf69949f3b961ce786baf2d4d75166562000000000000000000000000000000000000000000000000000000000000271000000000000000000000000000000000000000000000000000000000',
    callGasLimit: 100000n,
    verificationGasLimit: 200000n,
    preVerificationGas: 50000n,
    maxFeePerGas: 50000000000n,
    maxPriorityFeePerGas: 1500000000n,
    paymasterAndData: '0x',
    signature: stubSig,
  };

  const userOpForHash = { ...userOp, paymasterAndData: '0x', signature: '0x' };
  const hash = await publicClient.readContract({ address: PAYMASTER, abi: paymasterAbi, functionName: 'getHash', args: [userOpForHash, validUntil, validAfter] });
  console.log('paymaster hash', hash);
  // can't sign without private key, skip for simulate? But simulate will need valid sig?
  return userOp;
}

async function main() {
  const uo = await buildUserOp();
  console.log('UserOp:', uo);
  try {
    const data = encodeFunctionData({ abi: entryPointAbi, functionName: 'simulateHandleOp', args: [uo, '0x0000000000000000000000000000000000000000'] });
    const result = await publicClient.call({ to: ENTRYPOINT, data });
    console.log('simulateHandleOp result:', result);
  } catch (e) {
    console.error('simulateHandleOp error:', e.shortMessage || e.message);
    if (e.cause?.data) console.error('data:', e.cause.data);
    if (e.details) console.error('details:', e.details);
  }
}
main().catch(console.error);
