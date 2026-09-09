#!/usr/bin/env node
'use strict';

/**
 * Deploy the trust's Smart Account contracts on Base (8453) from the thirdweb
 * server wallet and register them in the Treasury-Core ERP.
 *
 *   1. BondTokenFactory          (CREATE2, deterministic salt)
 *   2. DLB-PRB   BondToken       bond_portfolio module (private-placement bond; coupon income)
 *   3. DLB-TREASURY BondToken    treasury module (Trust Operating allocation)
 *   4. DlbCanonicalSwap          venue where module tokens are posted for USDC with
 *                                recipient = TrustDistributionPolicy (owner = server wallet,
 *                                Base USDC allow-listed as canonical tokenOut)
 *
 * Tokens are created through the factory so ownership lands on the server
 * wallet (BondToken's constructor takes msg.sender, which under CREATE2 would
 * be the deployer contract). Supply is minted to the server wallet only when
 * --mint is given and matches the ERP face value / ledger balance; minting a
 * module token records an ERP claim, it does not create USDC.
 *
 * Dry-run by default: prints the plan (chain, signer, artifacts, ctor args,
 * supplies) and exits. Pass --confirm to submit. Every step is idempotent:
 * an existing on-chain address (env or ERP row with bytecode on Base) is
 * reused rather than redeployed.
 *
 *   node scripts/deployModuleContractsBase.cjs [--confirm] [--mint] [--chain=8453]
 *     [--factory=0x..] [--swap=0x..] [--modules=bond_portfolio,treasury]
 *
 * Requires THIRDWEB_SECRET_KEY, THIRDWEB_SERVER_WALLET_ADDRESS, DATABASE_URL.
 */

const path = require('path');

process.chdir(path.join(__dirname, '..'));

const { ThirdwebChainSigner } = require('../server/integrations/dapp/thirdwebChainSigner');
const { ThirdwebServerWalletEngine } = require('../server/integrations/dapp/thirdwebServerWalletEngine');
const { BondTokenizationEngine } = require('../server/integrations/dapp/bondTokenizationEngine');
const { ModuleSmartAccountEngine, MODULES } = require('../server/integrations/dapp/moduleSmartAccountEngine');
const { TrustAllocationEngine } = require('../server/integrations/dapp/trustAllocationEngine');
const { getConfig: dappConfig } = require('../server/integrations/dapp/config');

let pool = null;
try { pool = require('../server/integrations/bonds/pgPool'); } catch (e) { pool = null; }

const BASE_CHAIN_ID = 8453;
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));

const confirm = args.confirm === true;
const mint = args.mint === true;
const chainId = Number(args.chain || BASE_CHAIN_ID);
const moduleKeys = String(args.modules || 'bond_portfolio,treasury').split(',').map((s) => s.trim()).filter(Boolean);

const ERC20_ABI = [
  { type: 'function', name: 'owner', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'totalSupply', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'mint', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
];

async function rpc(method, params) {
  const url = dappConfig().rpcUrl;
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

async function hasCode(address) {
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
  const code = await rpc('eth_getCode', [address, 'latest']);
  return typeof code === 'string' && code.length > 2;
}

function fmtUnits(raw, decimals) {
  const s = BigInt(raw).toString().padStart(decimals + 1, '0');
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

async function existingTokenFor(moduleKey) {
  if (!pool) return null;
  const mod = await ModuleSmartAccountEngine.getModule(moduleKey).catch(() => null);
  if (mod && await hasCode(mod.token_address)) return { address: mod.token_address, tokenId: mod.token_id, source: 'module_smart_accounts' };
  const symbol = MODULES[moduleKey].tokenSymbol;
  const { rows } = await pool.query(
    `SELECT id, token_address, metadata FROM bond_tokens WHERE token_symbol = $1 AND status = 'active' ORDER BY created_at DESC`, [symbol]
  );
  for (const row of rows) {
    const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata || '{}') : (row.metadata || {});
    if (Number(meta.chainId) === chainId && await hasCode(row.token_address)) return { address: row.token_address, tokenId: row.id, source: 'bond_tokens' };
  }
  return null;
}

async function main() {
  const twCfg = ThirdwebServerWalletEngine.getConfig();
  const signer = twCfg.address;
  if (!signer) throw new Error('THIRDWEB_SERVER_WALLET_ADDRESS not configured');
  if (!twCfg.secretKey) throw new Error('THIRDWEB_SECRET_KEY not configured');
  if (chainId !== BASE_CHAIN_ID) throw new Error(`this script deploys to Base only (got --chain=${chainId})`);
  if (Number(dappConfig().chainId) !== BASE_CHAIN_ID) throw new Error(`DAPP_CHAIN_ID must be ${BASE_CHAIN_ID} so the RPC/USDC config is Base`);
  if (!pool) throw new Error('DATABASE_URL not configured; ERP registration is required');
  for (const key of moduleKeys) {
    if (!MODULES[key]) throw new Error(`unknown module ${key}`);
  }

  const factoryArtifact = ThirdwebChainSigner.artifact('contracts_BondTokenFactory_sol_BondTokenFactory');
  const swapArtifact = ThirdwebChainSigner.artifact('contracts_DlbCanonicalSwap_sol_DlbCanonicalSwap');

  const plan = { chainId, signer, mode: confirm ? 'LIVE' : 'dry-run', mint, steps: [] };

  // 1. factory
  let factory = args.factory || process.env.BOND_TOKEN_FACTORY || '';
  const factoryLive = await hasCode(factory);
  plan.steps.push({ step: 'BondTokenFactory', address: factoryLive ? factory : null, action: factoryLive ? 'reuse' : 'deploy (CREATE2 salt bond-token-factory:8453)', configured: factory || null });

  // 2/3. module tokens
  const tokens = [];
  for (const key of moduleKeys) {
    const cfg = MODULES[key];
    const existing = await existingTokenFor(key);
    const erpBalance = await ModuleSmartAccountEngine.getModuleBalance(key).catch(() => 0);
    const supply = BigInt(Math.round(Number(erpBalance) * 10 ** cfg.decimals));
    tokens.push({ key, cfg, existing, erpBalance, supply });
    plan.steps.push({
      step: `${cfg.tokenSymbol} (${key})`, address: existing ? existing.address : null,
      action: existing ? `reuse (${existing.source})` : `factory.createBondToken("${cfg.tokenName}", "${cfg.tokenSymbol}", 0)`,
      erpBalance: Number(erpBalance).toFixed(2), mintPlanned: mint ? `${fmtUnits(supply, cfg.decimals)} to ${signer}` : 'none (--mint not set)',
    });
  }

  // 4. swap
  let swap = args.swap || process.env.DLB_CANONICAL_SWAP_ADDRESS || '';
  const swapLive = await hasCode(swap);
  plan.steps.push({
    step: 'DlbCanonicalSwap', address: swapLive ? swap : null,
    action: swapLive ? 'reuse' : `deploy(owner=${signer}, feeRecipient=${signer}, feeBps=0) + setCanonicalStablecoin(${BASE_USDC}, true)`,
  });

  console.log(JSON.stringify(plan, null, 2));
  if (!confirm) {
    console.log('\nDry run only. Re-run with --confirm to submit these transactions from the server wallet on Base.');
    return;
  }

  const result = { chainId, signer, factory: null, tokens: [], swap: null, env: {} };

  if (!factoryLive) {
    const d = await ThirdwebChainSigner.deploy({ ...factoryArtifact, salt: `bond-token-factory:${chainId}`, chainId });
    factory = d.address;
    console.log(`BondTokenFactory deployed ${factory} tx=${d.transactionHash || d.transactionId || 'existing'}`);
  }
  if (!await hasCode(factory)) throw new Error(`BondTokenFactory ${factory} has no bytecode on Base after deploy`);
  result.factory = factory;
  result.env.BOND_TOKEN_FACTORY = factory;
  process.env.BOND_TOKEN_FACTORY = factory;

  for (const t of tokens) {
    let address = t.existing ? t.existing.address : null;
    let tokenId = t.existing ? t.existing.tokenId : null;
    let deployTx = null;
    if (!address) {
      const d = await ThirdwebChainSigner.deployBondToken({ name: t.cfg.tokenName, symbol: t.cfg.tokenSymbol, initialSupply: 0n, chainId });
      address = d.address;
      deployTx = d.transactionHash;
      console.log(`${t.cfg.tokenSymbol} deployed ${address} tx=${deployTx}`);
    }
    if (!await hasCode(address)) throw new Error(`${t.cfg.tokenSymbol} ${address} has no bytecode on Base`);
    const owner = await ThirdwebChainSigner.read({ address, abi: ERC20_ABI, functionName: 'owner', chainId });
    if (String(owner).toLowerCase() !== signer.toLowerCase()) throw new Error(`${t.cfg.tokenSymbol} owner is ${owner}, expected server wallet ${signer}`);

    if (!tokenId) {
      const bondId = t.cfg.sourceType === 'bond' ? Number(t.cfg.sourceAccountId) : null;
      const record = await BondTokenizationEngine.createToken({ bondId, tokenName: t.cfg.tokenName, tokenSymbol: t.cfg.tokenSymbol, tokenAddress: address, decimals: t.cfg.decimals });
      tokenId = record.id;
      await pool.query(
        `UPDATE bond_tokens SET metadata = metadata || $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [tokenId, JSON.stringify({ chainId, signer: 'thirdweb', owner: signer, factory, deployTx, module: t.key, network: 'base' })]
      );
    }
    await ModuleSmartAccountEngine.initializeModule(t.key).catch((e) => console.warn(`initializeModule(${t.key}) skipped: ${e.message}`));
    await pool.query(
      `UPDATE module_smart_accounts SET token_id = $2, token_address = $3, metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb, updated_at = NOW() WHERE module_key = $1`,
      [t.key, tokenId, address, JSON.stringify({ chainId, owner: signer, network: 'base' })]
    );

    let minted = null;
    if (mint && t.supply > 0n) {
      const current = BigInt(await ThirdwebChainSigner.read({ address, abi: ERC20_ABI, functionName: 'totalSupply', chainId }));
      if (current < t.supply) {
        const delta = t.supply - current;
        const txId = await ThirdwebChainSigner.write({ address, abi: ERC20_ABI, functionName: 'mint', args: [signer, delta], chainId, idempotencyKey: `mint:${t.key}:${address}:${delta}` });
        const receipt = await ThirdwebChainSigner.wait(txId);
        minted = { amount: fmtUnits(delta, t.cfg.decimals), tx: receipt.transactionHash };
        await pool.query(
          `UPDATE bond_tokens SET total_supply = $2, tokenized_principal = $2, updated_at = NOW() WHERE id = $1`,
          [tokenId, Number(t.erpBalance)]
        );
        await pool.query(`UPDATE module_smart_accounts SET balance_synced_at = NOW() WHERE module_key = $1`, [t.key]);
        console.log(`${t.cfg.tokenSymbol} minted ${minted.amount} to ${signer} tx=${minted.tx}`);
      }
    }
    result.tokens.push({ module: t.key, symbol: t.cfg.tokenSymbol, address, tokenId, owner, minted });
  }

  if (!swapLive) {
    const d = await ThirdwebChainSigner.deploy({ ...swapArtifact, args: [signer, signer, 0n], salt: `dlb-canonical-swap:${chainId}`, chainId });
    swap = d.address;
    console.log(`DlbCanonicalSwap deployed ${swap} tx=${d.transactionHash || d.transactionId || 'existing'}`);
  }
  if (!await hasCode(swap)) throw new Error(`DlbCanonicalSwap ${swap} has no bytecode on Base`);
  const swapOwner = await ThirdwebChainSigner.read({ address: swap, abi: swapArtifact.abi, functionName: 'owner', chainId });
  if (String(swapOwner).toLowerCase() !== signer.toLowerCase()) throw new Error(`DlbCanonicalSwap owner is ${swapOwner}, expected ${signer}`);
  const usdcAllowed = await ThirdwebChainSigner.read({ address: swap, abi: swapArtifact.abi, functionName: 'canonicalStablecoins', args: [BASE_USDC], chainId });
  if (!usdcAllowed) {
    const txId = await ThirdwebChainSigner.write({ address: swap, abi: swapArtifact.abi, functionName: 'setCanonicalStablecoin', args: [BASE_USDC, true], chainId, idempotencyKey: `swap:usdc:${swap}` });
    const receipt = await ThirdwebChainSigner.wait(txId);
    console.log(`DlbCanonicalSwap: Base USDC allow-listed tx=${receipt.transactionHash}`);
  }
  result.swap = { address: swap, owner: swapOwner, usdcCanonical: true };
  result.env.DLB_CANONICAL_SWAP_ADDRESS = swap;
  result.env.DLB_CANONICAL_SWAP_SHADOW = 'false';
  for (const t of result.tokens) {
    result.env[TrustAllocationEngine.tokenEnvFor(t.module)] = t.address;
  }

  console.log('\nRESULT');
  console.log(JSON.stringify(result, null, 2));
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
