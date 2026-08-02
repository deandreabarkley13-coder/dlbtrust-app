'use strict';

/**
 * Sepolia end-to-end test for the SovereignTrustEthMarket.
 *
 * This script demonstrates a gasless ETH top-up for the operator wallet:
 *   1. Deploy SovereignTrustEthMarket with the existing DLBUSD token as the mintable asset.
 *   2. Transfer DLBUSD ownership to the market (one-time, paid by operator Sepolia ETH).
 *   3. An LP deposits ETH into the market.
 *   4. The operator signs a SwapRequest off-chain.
 *   5. The LP/relayer submits the swap; the market mints DLBUSD to the LP
 *      and sends ETH to the operator.
 *
 * Run with:
 *   DAPP_PRIVATE_KEY=<operator-key> \
 *   DAPP_CHAIN_ID=11155111 \
 *   DAPP_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/alch_f2yjFif-nGWMDdFMcuCoc \
 *   node server/scripts/testEthMarketSepolia.js
 */

const fs = require('fs');
const path = require('path');
const { privateKeyToAccount } = require('viem/accounts');
const { sepolia } = require('viem/chains');
const viem = require('viem');

const RPC_URL = process.env.DAPP_RPC_URL || 'https://eth-sepolia.g.alchemy.com/v2/alch_f2yjFif-nGWMDdFMcuCoc';
const PRIVATE_KEY = process.env.DAPP_PRIVATE_KEY;
const TOKEN_ADDRESS = process.env.TEST_TOKEN_ADDRESS || '0xd0C51931dCD5b76112581f2a53C08Ad198cB2121';
const CHAIN_ID = Number(process.env.DAPP_CHAIN_ID || '11155111');

if (!PRIVATE_KEY) {
  console.error('Set DAPP_PRIVATE_KEY');
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY);
const operator = account.address;
const chain = sepolia;

const publicClient = viem.createPublicClient({ chain, transport: viem.http(RPC_URL) });
const wallet = viem.createWalletClient({ account, chain, transport: viem.http(RPC_URL) });

const marketAbi = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'artifacts', 'contracts_SovereignTrustEthMarket_sol_SovereignTrustEthMarket.abi'), 'utf8'));
const marketBytecode = '0x' + fs.readFileSync(path.join(process.cwd(), 'artifacts', 'contracts_SovereignTrustEthMarket_sol_SovereignTrustEthMarket.bin'), 'utf8').trim();

const tokenAbi = [
  { type: 'function', name: 'owner', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'transferOwnership', inputs: [{ type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'mint', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
];

async function main() {
  const before = await publicClient.getBalance({ address: operator });
  console.log('Operator:', operator);
  console.log('Operator Sepolia ETH before:', viem.formatEther(before));

  const owner = await publicClient.readContract({ address: TOKEN_ADDRESS, abi: tokenAbi, functionName: 'owner' });
  console.log('Token owner:', owner);
  if (owner.toLowerCase() !== operator.toLowerCase()) {
    throw new Error('Operator is not token owner; cannot transfer ownership');
  }

  // Deploy market with $1,800/ETH price
  const ethPriceUsd = 1800n * 10n ** 6n;
  const deployHash = await wallet.deployContract({
    abi: marketAbi,
    bytecode: marketBytecode,
    args: [TOKEN_ADDRESS, ethPriceUsd],
    gas: 900000n,
    maxFeePerGas: viem.parseGwei('3'),
    maxPriorityFeePerGas: viem.parseGwei('0.0015'),
  });
  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  if (deployReceipt.status !== 'success') throw new Error('market deploy failed');
  const marketAddress = deployReceipt.contractAddress;
  console.log('Market deployed:', marketAddress);

  // Set relayer to operator wallet for this test
  const setRelayerHash = await wallet.writeContract({
    address: marketAddress,
    abi: marketAbi,
    functionName: 'setRelayer',
    args: [operator, true],
    gas: 100000n,
    maxFeePerGas: viem.parseGwei('3'),
    maxPriorityFeePerGas: viem.parseGwei('0.0015'),
  });
  await publicClient.waitForTransactionReceipt({ hash: setRelayerHash });
  console.log('Relayer set to operator for test');

  // Transfer token ownership to market so it can mint DLBUSD
  const transferHash = await wallet.writeContract({
    address: TOKEN_ADDRESS,
    abi: tokenAbi,
    functionName: 'transferOwnership',
    args: [marketAddress],
    gas: 100000n,
    maxFeePerGas: viem.parseGwei('3'),
    maxPriorityFeePerGas: viem.parseGwei('0.0015'),
  });
  await publicClient.waitForTransactionReceipt({ hash: transferHash });
  console.log('Token ownership transferred to market');

  // LP deposits 0.0001 ETH
  const depositAmount = viem.parseEther('0.0001');
  const depositHash = await wallet.writeContract({
    address: marketAddress,
    abi: marketAbi,
    functionName: 'depositEth',
    value: depositAmount,
    gas: 100000n,
    maxFeePerGas: viem.parseGwei('3'),
    maxPriorityFeePerGas: viem.parseGwei('0.0015'),
  });
  await publicClient.waitForTransactionReceipt({ hash: depositHash });
  console.log('LP deposited', viem.formatEther(depositAmount), 'ETH');

  // Operator signs a SwapRequest off-chain: mint $10 DLBUSD, receive equivalent ETH
  const dlbusdAmount = 10n * 10n ** 6n; // $10
  const minEthOut = await publicClient.readContract({ address: marketAddress, abi: marketAbi, functionName: 'computeEthOut', args: [dlbusdAmount] });
  console.log('ETH out for $10:', viem.formatEther(minEthOut));

  const domain = {
    name: 'SovereignTrustEthMarket',
    version: '1',
    chainId: CHAIN_ID,
    verifyingContract: marketAddress,
  };
  const types = {
    SwapRequest: [
      { name: 'token', type: 'address' },
      { name: 'operator', type: 'address' },
      { name: 'dlbusdAmount', type: 'uint256' },
      { name: 'ethRecipient', type: 'address' },
      { name: 'minEthOut', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  };
  const message = {
    token: TOKEN_ADDRESS,
    operator,
    dlbusdAmount: dlbusdAmount.toString(),
    ethRecipient: operator,
    minEthOut: minEthOut.toString(),
    nonce: '0',
    deadline: String(Math.floor(Date.now() / 1000) + 600),
  };
  const signature = await wallet.signTypedData({ domain, types, primaryType: 'SwapRequest', message });
  console.log('Operator signed swap request');

  // Relayer submits swap (same operator wallet in test, but in production this can be any relayer)
  const swapHash = await wallet.writeContract({
    address: marketAddress,
    abi: marketAbi,
    functionName: 'swap',
    args: [message, operator, signature],
    gas: 300000n,
    maxFeePerGas: viem.parseGwei('3'),
    maxPriorityFeePerGas: viem.parseGwei('0.0015'),
  });
  const swapReceipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });
  if (swapReceipt.status !== 'success') throw new Error('swap failed');
  console.log('Swap executed:', swapHash);

  const after = await publicClient.getBalance({ address: operator });
  const lpTokenBalance = await publicClient.readContract({ address: TOKEN_ADDRESS, abi: tokenAbi, functionName: 'balanceOf', args: [operator] });
  console.log('Operator ETH after:', viem.formatEther(after));
  console.log('Operator DLBUSD balance:', (Number(lpTokenBalance) / 1e6).toFixed(6));

  const totalEth = await publicClient.readContract({ address: marketAddress, abi: marketAbi, functionName: 'totalEth' });
  console.log('Market total ETH:', viem.formatEther(totalEth));
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
