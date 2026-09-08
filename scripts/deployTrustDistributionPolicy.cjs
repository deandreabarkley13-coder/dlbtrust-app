#!/usr/bin/env node
'use strict';

/**
 * Deploy TrustDistributionPolicy.
 *
 * Two signers, both explicit — nothing is deployed from a guessed key:
 *
 *   --signer=thirdweb   (default) deploys from the thirdweb server wallet via
 *                       POST /v1/contracts. Needs THIRDWEB_SECRET_KEY,
 *                       THIRDWEB_SERVER_WALLET_ADDRESS and TRUST_POLICY_LIVE=true.
 *   --signer=rpc        deploys with a local key over JSON-RPC. Needs
 *                       POLICY_DEPLOYER_PRIVATE_KEY and DAPP_RPC_URL.
 *
 * Without --confirm the script only prints what it would do, so the compiled
 * artifact, constructor arguments and target chain can be reviewed first.
 *
 * Usage:
 *   node scripts/compileTrustDistributionPolicy.cjs
 *   node scripts/deployTrustDistributionPolicy.cjs \
 *     --owner=0xTrusteeGovernanceMultisig --threshold=2 \
 *     --release-delay=86400 --clawback=86400 --chain=8453 [--confirm]
 *
 * Every setter is onlyOwner and the app cannot sign for a trustee's wallet, so
 * to configure from the app pass --owner=<server wallet>, run
 * configureTrustDistributionPolicy.cjs with "transferOwnershipTo" set to
 * trustee governance, and the handover is the last call of that run.
 */

const fs = require('fs');
const path = require('path');

const ARTIFACTS = path.join(__dirname, '..', 'artifacts');
const BASE_NAME = 'contracts_TrustDistributionPolicy_sol_TrustDistributionPolicy';

function arg(name, def = null) {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const [, value] = hit.split('=');
  return value === undefined ? true : value;
}

function loadArtifact() {
  const abiPath = path.join(ARTIFACTS, `${BASE_NAME}.abi`);
  const binPath = path.join(ARTIFACTS, `${BASE_NAME}.bin`);
  if (!fs.existsSync(abiPath) || !fs.existsSync(binPath)) {
    throw new Error('artifacts missing — run: node scripts/compileTrustDistributionPolicy.cjs');
  }
  const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
  const bytecode = `0x${fs.readFileSync(binPath, 'utf8').trim().replace(/^0x/, '')}`;
  return { abi, bytecode };
}

async function deployViaThirdweb(params, artifact) {
  const { TrustPolicyEngine } = require('../server/integrations/dapp/trustPolicyEngine');
  const result = await TrustPolicyEngine.deploy({
    owner: params.owner,
    approvalThreshold: params.threshold,
    releaseDelaySeconds: params.releaseDelay,
    clawbackWindowSeconds: params.clawback,
    chainId: params.chainId,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    salt: params.salt || undefined,
  });
  return result;
}

async function deployViaRpc(params, artifact) {
  const viem = require('viem');
  const { privateKeyToAccount } = require('viem/accounts');
  const key = process.env.POLICY_DEPLOYER_PRIVATE_KEY;
  const rpcUrl = process.env.POLICY_DEPLOYER_RPC_URL || process.env.DAPP_RPC_URL;
  if (!key) throw new Error('POLICY_DEPLOYER_PRIVATE_KEY is required for --signer=rpc');
  if (!rpcUrl) throw new Error('DAPP_RPC_URL (or POLICY_DEPLOYER_RPC_URL) is required for --signer=rpc');
  const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`);
  const chain = { id: params.chainId, name: `chain-${params.chainId}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
  const wallet = viem.createWalletClient({ account, chain, transport: viem.http(rpcUrl) });
  const publicClient = viem.createPublicClient({ chain, transport: viem.http(rpcUrl) });
  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [params.owner, params.threshold, BigInt(params.releaseDelay), BigInt(params.clawback)],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { address: receipt.contractAddress, transactionHash: hash, chainId: params.chainId, from: account.address, status: receipt.status };
}

async function main() {
  const params = {
    owner: arg('owner', process.env.TRUST_POLICY_OWNER || ''),
    threshold: Number(arg('threshold', 2)),
    releaseDelay: Number(arg('release-delay', 86400)),
    clawback: Number(arg('clawback', 86400)),
    chainId: Number(arg('chain', process.env.TRUST_POLICY_CHAIN_ID || process.env.THIRDWEB_SERVER_WALLET_CHAIN_ID || process.env.DAPP_CHAIN_ID || 8453)),
    signer: String(arg('signer', 'thirdweb')),
    salt: arg('salt', null),
    confirm: Boolean(arg('confirm', false)),
  };
  if (!/^0x[0-9a-fA-F]{40}$/.test(params.owner)) {
    throw new Error('--owner=<address> is required: trustee governance owns the policy, not the server wallet');
  }
  const artifact = loadArtifact();

  console.log('TrustDistributionPolicy deployment');
  console.log(`  chainId              ${params.chainId}`);
  console.log(`  signer               ${params.signer}`);
  console.log(`  owner (governance)   ${params.owner}`);
  console.log(`  approvalThreshold    ${params.threshold}`);
  console.log(`  releaseDelay         ${params.releaseDelay}s (timelock after the last approval)`);
  console.log(`  clawbackWindow       ${params.clawback}s (escrow held before the beneficiary can claim)`);
  console.log(`  bytecode             ${(artifact.bytecode.length - 2) / 2} bytes`);
  if (!params.confirm) {
    console.log('\nDry run. Re-run with --confirm to deploy.');
    return;
  }

  const result = params.signer === 'rpc' ? await deployViaRpc(params, artifact) : await deployViaThirdweb(params, artifact);
  console.log('\nResult:', JSON.stringify(result, null, 2));
  if (result.address) {
    console.log(`\nSet TRUST_POLICY_ADDRESS=${result.address} (chain ${params.chainId}), then configure roles and limits:`);
    console.log('  node scripts/configureTrustDistributionPolicy.cjs --file=policy.config.json --confirm');
  } else if (result.shadow) {
    console.log('\nTRUST_POLICY_LIVE=false: nothing was submitted.');
  }
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
