#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { getConfig } = require('../server/integrations/dapp/config');
const { PtcStablecoinEngine } = require('../server/integrations/dapp/ptcStablecoinEngine');
const { query } = require('../server/integrations/bonds/pgPool');
const viem = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { mainnet, sepolia } = require('viem/chains');

const OLD_BOND_TOKEN = '0xe8dee80f97349f3f88c2ca0c21e7ff0df14c5c05';
const PRB_TOKEN = '0x3f3a354f76be6ad0e7fc9b6efe39727b39cbd160';
const PRB_TOKEN_ID = 'BTOK-1786140651946-IO551I';

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

async function main() {
  const cfg = getConfig();
  const { account, publicClient, walletClient, fees } = clients(cfg);
  const operator = cfg.operatorAddress;

  const tokenId = PRB_TOKEN_ID;
  const prbAddress = PRB_TOKEN;
  console.log('Finishing DLB-PRB reserve swap. Token:', prbAddress);

  console.log('Adding DLB-PRB as reserve token...');
  const add = await PtcStablecoinEngine.addReserveToken({
    token: prbAddress,
    decimals: 6,
    price: '1000000000000000000',
  });
  console.log('AddReserveToken tx:', add.txHash);

  console.log('Depositing DLB-PRB into the reserve vault...');
  const deposit = await PtcStablecoinEngine.approveAndDeposit({
    token: prbAddress,
    amount: 'all',
    recipient: operator,
  });
  console.log('Deposit tx:', deposit.txHash, 'minted DLB-PTCUSD:', viem.formatUnits(BigInt(deposit.mintedStablecoin), 18));

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
      await publicClient.waitForTransactionReceipt({ hash: removeHash, timeout: 120000 });
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
    await publicClient.waitForTransactionReceipt({ hash: burnHash, timeout: 120000 });
    console.log('Burn DLB-BOND tx:', burnHash);
  } else {
    console.log('No DLB-BOND in operator wallet to burn.');
  }

  state.reserveTokens = (state.reserveTokens || []).filter(
    r => r.address.toLowerCase() !== OLD_BOND_TOKEN.toLowerCase()
  );
  state.reserveTokens.push({
    address: prbAddress,
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
    if (mod && tokenId) {
      const metadata = typeof mod.metadata === 'string' ? JSON.parse(mod.metadata || '{}') : (mod.metadata || {});
      metadata.tokenSymbol = 'DLB-PRB';
      metadata.tokenName = 'DLB Private Placement Bond';
      metadata.mintedAmount = 100_000_000;
      metadata.balance = { amount: 100_000_000, balance: 100_000_000 };
      await query(
        'UPDATE module_smart_accounts SET token_id = $1, token_address = $2, metadata = $3, updated_at = NOW() WHERE id = $4',
        [tokenId, prbAddress, JSON.stringify(metadata), mod.id]
      );
      console.log('Updated bond_portfolio module to use DLB-PRB');
    } else if (!tokenId) {
      console.warn('No PRB_TOKEN_ID set; skipping module_smart_accounts token_id update');
    }
  } catch (e) {
    console.warn('Could not update module_smart_accounts:', e.message);
  }

  console.log('Done. DLB-PRB reserve token:', prbAddress);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
