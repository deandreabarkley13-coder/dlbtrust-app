#!/usr/bin/env node
'use strict';

/**
 * Issue a dedicated DLB-PRB private-placement bond token and replace the
 * existing DLB-BOND reserve in the PTC stablecoin vault.
 *
 * Flow:
 *   1. Redeem the DLB-BOND reserve (burn DLB-PTCUSD, return DLB-BOND to operator).
 *   2. Deploy a DLB-PRB ERC-20 and mint the bond face value to the operator.
 *   3. Add DLB-PRB as a reserve token and deposit it (mints DLB-PTCUSD).
 *   4. Remove DLB-BOND as an active reserve token and burn the returned DLB-BOND.
 *   5. Update module_smart_accounts and the PTC stablecoin state file.
 */

const fs = require('fs');
const path = require('path');
const { getConfig } = require('../server/integrations/dapp/config');
const { BondTokenizationEngine } = require('../server/integrations/dapp/bondTokenizationEngine');
const { PtcStablecoinEngine } = require('../server/integrations/dapp/ptcStablecoinEngine');
const { ModuleSmartAccountEngine } = require('../server/integrations/dapp/moduleSmartAccountEngine');
const { query } = require('../server/integrations/bonds/pgPool');
const viem = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { mainnet, sepolia } = require('viem/chains');
const { CapControlEngine } = require('../server/integrations/os/capControlEngine');

const OLD_BOND_TOKEN = '0xe8dee80f97349f3f88c2ca0c21e7ff0df14c5c05';
// The trust's own reference for the bond, resolved against the bond ledger at
// run time rather than assumed to be a particular row.
const BOND_REFERENCE = process.env.BOND_REFERENCE || '19781443-DLB-PRB';

function clients(cfg) {
  const chain = cfg.chainId === 1 ? mainnet : sepolia;
  const account = privateKeyToAccount(cfg.privateKey);
  const publicClient = viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) });
  const walletClient = viem.createWalletClient({ account, chain, transport: viem.http(cfg.rpcUrl) });
  const fees = cfg.getFees ? cfg.getFees() : { maxFeePerGas: viem.parseGwei('3'), maxPriorityFeePerGas: viem.parseGwei('0.1') };
  return { account, publicClient, walletClient, fees };
}

function statePath() {
  if (process.env.PERSISTENT_DATA_DIR && fs.existsSync(process.env.PERSISTENT_DATA_DIR)) {
    return path.join(process.env.PERSISTENT_DATA_DIR, 'ptc-stablecoin-state.json');
  }
  if (fs.existsSync('/data')) return '/data/ptc-stablecoin-state.json';
  return path.join(process.cwd(), 'data', 'ptc-stablecoin-state.json');
}

function loadState() {
  try {
    if (fs.existsSync(statePath())) return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch (e) { console.warn('Could not read state:', e.message); }
  return {};
}

function saveState(state) {
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

async function waitReceipt(publicClient, hash) {
  return publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
}

async function main() {
  const cfg = getConfig();
  const { account, publicClient, walletClient, fees } = clients(cfg);
  const operator = cfg.operatorAddress;

  console.log('Operator:', operator);
  console.log('Chain ID:', cfg.chainId);

  // 1. Redeem the existing DLB-BOND reserve for its full outstanding amount.
  const oldVaultBalance = await publicClient.readContract({
    address: OLD_BOND_TOKEN,
    abi: [{ type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
    functionName: 'balanceOf',
    args: ['0xc8b2f6909b50a43ac839e74c3d0e82ae060094d1'],
  });
  const oldFormatted = Number(oldVaultBalance) / 1e6;
  console.log('Current DLB-BOND in vault:', oldFormatted.toFixed(2));

  if (oldFormatted > 0) {
    console.log('Redeeming DLB-BOND reserve (stablecoin will be burned)...');
    const redeem = await PtcStablecoinEngine.redeem({ moduleKey: 'bond_portfolio', amount: oldFormatted.toFixed(2), recipient: operator });
    console.log('Redeem tx:', redeem.txHash);
  }

  // 2. Create and mint DLB-PRB.
  const bond = await CapControlEngine.resolveBond(BOND_REFERENCE);
  console.log(`Bond ${BOND_REFERENCE} is row ${bond.id} (${bond.bond_name})`);

  console.log('Deploying DLB-PRB token...');
  const prbToken = await BondTokenizationEngine.createToken({
    bondId: bond.id,
    tokenName: 'DLB Private Placement Bond',
    tokenSymbol: 'DLB-PRB',
    decimals: 6,
  });
  console.log('DLB-PRB token address:', prbToken.token_address);

  // The face value is no longer this script's to assert: an approved issuance
  // ticket carries the amount two trustees agreed the bond backs.
  const issuanceId = process.env.ISSUANCE_ID;
  if (!issuanceId) {
    throw new Error(
      'ISSUANCE_ID is required: raise a ticket with '
      + '`node server/scripts/tokenControl.js issuance-request --token ' + prbToken.id
      + ' --principal <cents> --holder ' + operator + ' --by <trustee>`,'
      + ' have a second trustee approve it, then re-run with ISSUANCE_ID set'
    );
  }
  console.log('Minting DLB-PRB to operator against issuance', issuanceId, '...');
  const mint = await BondTokenizationEngine.mint({
    issuanceId,
    mintedBy: process.env.MINTED_BY || null,
    expect: { tokenId: prbToken.id, holderAddress: operator },
  });
  const mintedAmount = Number(mint.result.minted);
  console.log('Minted', mintedAmount, 'DLB-PRB; tx:', mint.result.txHash);

  // 3. Add DLB-PRB as reserve token and deposit.
  console.log('Adding DLB-PRB as reserve token...');
  const add = await PtcStablecoinEngine.addReserveToken({
    token: prbToken.token_address,
    decimals: 6,
    price: '1000000000000000000',
  });
  console.log('AddReserveToken tx:', add.txHash);

  console.log('Depositing DLB-PRB into the reserve vault...');
  const deposit = await PtcStablecoinEngine.approveAndDeposit({
    token: prbToken.token_address,
    amount: 'all',
    recipient: operator,
  });
  console.log('Deposit tx:', deposit.txHash, 'minted DLB-PTCUSD:', viem.formatUnits(BigInt(deposit.mintedStablecoin), 18));

  // 4. Remove old DLB-BOND from active reserves and burn returned tokens.
  const state = loadState();
  const vaultAddress = state.vaultAddress;
  if (vaultAddress) {
    try {
      console.log('Removing DLB-BOND from active reserves...');
      const vaultArtifact = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'artifacts', 'contracts_PtcStablecoinSystem_sol_PtcReserveVault.abi'), 'utf8'));
      const removeHash = await walletClient.writeContract({
        address: vaultAddress,
        abi: vaultArtifact,
        functionName: 'removeReserveToken',
        args: [OLD_BOND_TOKEN],
        ...fees,
      });
      await waitReceipt(publicClient, removeHash);
      console.log('RemoveReserveToken tx:', removeHash);
    } catch (e) {
      console.warn('removeReserveToken failed or already inactive:', e.message);
    }
  }

  const operatorBondBalance = await publicClient.readContract({
    address: OLD_BOND_TOKEN,
    abi: [{ type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
    functionName: 'balanceOf',
    args: [operator],
  });
  if (BigInt(operatorBondBalance) > 0n) {
    console.log('Burning', Number(operatorBondBalance) / 1e6, 'DLB-BOND from operator...');
    const burnHash = await walletClient.writeContract({
      address: OLD_BOND_TOKEN,
      abi: [{ type: 'function', name: 'burn', inputs: [{ type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' }],
      functionName: 'burn',
      args: [operatorBondBalance],
      ...fees,
    });
    await waitReceipt(publicClient, burnHash);
    console.log('Burn DLB-BOND tx:', burnHash);
  } else {
    console.log('No DLB-BOND in operator wallet to burn.');
  }

  // 5. Update state and module_smart_accounts.
  state.reserveTokens = (state.reserveTokens || []).filter(
    r => r.address.toLowerCase() !== OLD_BOND_TOKEN.toLowerCase()
  );
  state.reserveTokens.push({
    address: prbToken.token_address,
    decimals: 6,
    moduleKey: 'bond_portfolio',
    name: 'DLB-PRB',
    price: '1000000000000000000',
    addedAt: new Date().toISOString(),
  });
  saveState(state);
  console.log('Updated ptc-stablecoin-state.json');

  try {
    const mod = (await query('SELECT * FROM module_smart_accounts WHERE module_key = $1', ['bond_portfolio'])).rows[0];
    if (mod) {
      const metadata = typeof mod.metadata === 'string' ? JSON.parse(mod.metadata || '{}') : (mod.metadata || {});
      metadata.tokenSymbol = 'DLB-PRB';
      metadata.tokenName = 'DLB Private Placement Bond';
      metadata.mintedAmount = mintedAmount;
      metadata.balance = { amount: mintedAmount, balance: mintedAmount };
      await query(
        'UPDATE module_smart_accounts SET token_id = $1, token_address = $2, metadata = $3, updated_at = NOW() WHERE id = $4',
        [prbToken.id, prbToken.token_address, JSON.stringify(metadata), mod.id]
      );
      console.log('Updated bond_portfolio module to use DLB-PRB');
    }
  } catch (e) {
    console.warn('Could not update module_smart_accounts:', e.message);
  }

  console.log('Done. DLB-PRB reserve token:', prbToken.token_address);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
