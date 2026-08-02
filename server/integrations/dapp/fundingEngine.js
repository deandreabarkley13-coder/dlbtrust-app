'use strict';

/**
 * Funding Engine
 *
 * High-level orchestrator for closing the operator ETH / stablecoin gap.
 * Audits every available funding rail, builds the cheapest viable plan,
 * executes what it can, and returns a clear manual next-step where
 * outside funds are still required.
 */

const { getConfig } = require('./config');
const { OperatorGasTank } = require('./operatorGasTank');
const { StablecoinDexEngine } = require('./stablecoinDexEngine');
const { CashAppEngine } = require('./cashAppEngine');
const { GoogleWalletEngine } = require('./googleWalletEngine');
const { CoinbaseTreasuryBridge } = require('./coinbaseTreasuryBridge');
const { CoinbaseSpotEngine } = require('./coinbaseSpotEngine');
const { ModuleFundingEngine } = require('./moduleFundingEngine');
const { DappEngine } = require('./dappEngine');

let viem;
try { viem = require('viem'); } catch (e) { }

function str(name, fallback = '') { return (process.env[name] || fallback).trim(); }
function bool(name, fallback = false) { const v = process.env[name]; return v ? String(v).toLowerCase() === 'true' : fallback; }

function publicClient() {
  if (!viem) throw new Error('viem not installed');
  const cfg = getConfig();
  const chains = require('viem/chains');
  const chain = cfg.chainId === 1 ? chains.mainnet : (cfg.chainId === 11155111 ? chains.sepolia : { id: cfg.chainId, name: 'custom', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } });
  return viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) });
}

async function getEvmBalance(address) {
  if (!viem || !address || !address.startsWith('0x')) return { eth: '0', wei: '0' };
  try {
    const client = publicClient();
    const wei = await client.getBalance({ address });
    return { eth: viem.formatEther(wei), wei: wei.toString() };
  } catch (e) { return { eth: '0', wei: '0', error: e.message }; }
}

async function getErc20Balance(address, tokenAddress) {
  if (!viem || !address || !tokenAddress) return '0';
  try {
    const client = publicClient();
    const abi = [{ type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }];
    const raw = await client.readContract({ address: tokenAddress, abi, functionName: 'balanceOf', args: [address] });
    const decimals = await client.readContract({ address: tokenAddress, abi: [{ type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' }], functionName: 'decimals' });
    return viem.formatUnits(raw, decimals);
  } catch (e) { return '0'; }
}

async function getHederaBalance(accountId) {
  if (!accountId) return null;
  try {
    const res = await fetch(`https://mainnet.mirrornode.hedera.com/api/v1/accounts/${accountId}`);
    if (!res.ok) return { error: `mirror node ${res.status}` };
    const data = await res.json();
    const tinybar = data.balance?.balance ?? data.balance?.tinybar ?? 0;
    return {
      hbar: String(Number(tinybar) / 1e8),
      evmAddress: data.evm_address || '',
      tokens: (data.tokens || []).map(t => ({ tokenId: t.token_id, balance: t.balance })),
    };
  } catch (e) { return { error: e.message }; }
}

async function getPoolLiquidity(poolAddress, tokenIn, tokenOut) {
  if (!viem || !poolAddress) return { dlbusd: '0', target: '0', exists: false };
  try {
    const client = publicClient();
    const abi = [
      { type: 'function', name: 'token0', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
      { type: 'function', name: 'token1', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
      { type: 'function', name: 'reserve0', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
      { type: 'function', name: 'reserve1', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
    ];
    const token0 = await client.readContract({ address: poolAddress, abi, functionName: 'token0' });
    const token1 = await client.readContract({ address: poolAddress, abi, functionName: 'token1' });
    const r0 = await client.readContract({ address: poolAddress, abi, functionName: 'reserve0' });
    const r1 = await client.readContract({ address: poolAddress, abi, functionName: 'reserve1' });
    const inIsToken0 = tokenIn.toLowerCase() === token0.toLowerCase();
    const dlbusdRaw = inIsToken0 ? r0 : r1;
    const targetRaw = inIsToken0 ? r1 : r0;
    const dlbusd = viem.formatUnits(dlbusdRaw, 6);
    const targetDecimals = (tokenOut.toLowerCase() === getConfig().wethAddress.toLowerCase()) ? 18 : 6;
    const target = viem.formatUnits(targetRaw, targetDecimals);
    return { dlbusd, target, exists: true, token0, token1 };
  } catch (e) { return { dlbusd: '0', target: '0', exists: false, error: e.message }; }
}

class FundingEngine {
  static getConfig() {
    const cfg = getConfig();
    return {
      operatorAddress: cfg.operatorAddress,
      wethAddress: cfg.wethAddress,
      usdcAddress: cfg.usdcAddress,
      nativeSymbol: cfg.nativeTokenSymbol,
      externalEvmAddress: str('FUNDING_EXTERNAL_EVM_ADDRESS', ''),
      hederaAccountId: str('FUNDING_HEDERA_ACCOUNT_ID', ''),
    };
  }

  static async getStatus({ externalEvmAddress, hederaAccountId, amountUsd = 0.05 } = {}) {
    const cfg = this.getConfig();
    const opAddress = cfg.operatorAddress;
    const extAddress = externalEvmAddress || cfg.externalEvmAddress || '';
    const hedera = hederaAccountId || cfg.hederaAccountId || '';

    const operatorEth = await getEvmBalance(opAddress);
    const operatorWeth = opAddress ? await getErc20Balance(opAddress, cfg.wethAddress) : '0';
    const operatorUsdc = opAddress ? await getErc20Balance(opAddress, cfg.usdcAddress) : '0';

    const externalEth = extAddress ? await getEvmBalance(extAddress) : { eth: '0', wei: '0' };
    const externalWeth = extAddress ? await getErc20Balance(extAddress, cfg.wethAddress) : '0';

    let dlbusdTokenAddress = '';
    try {
      const token = await StablecoinDexEngine.getOrCreateDLBUSDToken();
      dlbusdTokenAddress = token.token_address;
    } catch (e) { }

    const poolAddress = str('BOND_DEX_ADDRESS') || str('DEX_SWAP_ROUTER', '');
    const poolLiquidity = dlbusdTokenAddress ? await getPoolLiquidity(poolAddress, dlbusdTokenAddress, cfg.wethAddress) : { exists: false };

    const hederaBalance = hedera ? await getHederaBalance(hedera) : null;

    const sourceBalances = await DappEngine.listSourceBalances().catch(() => []);

    const rails = {
      operator_gas_tank: await OperatorGasTank.getStatus().catch(e => ({ ready: false, error: e.message })),
      stablecoin_dex: StablecoinDexEngine ? await StablecoinDexEngine.readiness() : { ready: false, error: 'engine missing' },
      coinbase_treasury: { ready: CoinbaseTreasuryBridge.enabled(), connected: CoinbaseTreasuryBridge.enabled() },
      coinbase_spot: { ready: CoinbaseSpotEngine.enabled(), connected: CoinbaseSpotEngine.enabled() },
      cashapp: await CashAppEngine.readiness(),
      googlewallet: await GoogleWalletEngine.readiness(),
    };

    return {
      operator: { address: opAddress, ...operatorEth, weth: operatorWeth, usdc: operatorUsdc },
      externalWallet: extAddress ? { address: extAddress, ...externalEth, weth: externalWeth } : null,
      hedera: hederaBalance,
      pool: { address: poolAddress, ...poolLiquidity, dlbusdTokenAddress },
      sourceBalances,
      rails,
      neededEthForFirstTx: '0.003',
      neededWethToSeedPool: amountUsd,
    };
  }

  static async buildPlan({ amountUsd = 100, sourceType, sourceAccountId, targetAsset = 'ETH', strategy = 'auto', externalEvmAddress, hederaAccountId, cashtag = '' } = {}) {
    const status = await this.getStatus({ externalEvmAddress, hederaAccountId, amountUsd });
    const cfg = this.getConfig();
    const op = status.operator;
    const missing = [];
    const steps = [];
    const balances = [];

    if (Number(op.eth) >= Number(status.neededEthForFirstTx)) {
      steps.push({ step: 'use_existing', message: `Operator has ${op.eth} ETH, enough for transactions.` });
      return { canExecute: true, status, steps, missing, recommendation: 'Operator is funded. Execute the desired payout/dex/safe operation directly.' };
    }

    // 1. External EVM wallet
    if (status.externalWallet && Number(status.externalWallet.eth) > 0) {
      balances.push({ type: 'external_evm_eth', value: status.externalWallet.eth, address: status.externalWallet.address });
      if (Number(status.externalWallet.eth) >= Number(status.neededEthForFirstTx)) {
        steps.push({ step: 'manual_send_external', message: `Send ${status.neededEthForFirstTx} ETH from ${status.externalWallet.address} to operator ${cfg.operatorAddress}.` });
        return { canExecute: false, status, steps, missing, recommendation: 'External wallet has enough ETH. Sign and send manually; the engine cannot sign your external private key.' };
      }
    }

    // 2. DEX (preferred — uses internal stablecoin rails, not CEX)
    if (status.rails.stablecoin_dex.ready) {
      if (status.pool.exists && Number(status.pool.target) > 0) {
        steps.push({ step: 'dex_swap', message: `Mint ${amountUsd} DLBUSD from ${sourceType}:${sourceAccountId} and swap for ${targetAsset} on pool ${status.pool.address}.` });
        if (strategy === 'dex' || strategy === 'auto') {
          return { canExecute: true, status, steps, missing, recommendation: 'Execute Stablecoin DEX swap; the pool already has WETH/USDC liquidity.' };
        }
      } else {
        missing.push(`DLBUSD/${targetAsset} pool is missing or empty (${status.pool.target || 0} ${targetAsset})`);
        steps.push({ step: 'seed_pool', message: `An external LP must deposit WETH/${targetAsset} into pool ${status.pool.address || 'not deployed'} before the DEX can convert DLBUSD.` });
      }
    } else {
      missing.push('Stablecoin DEX not ready: ' + (status.rails.stablecoin_dex.issues || []).join(', '));
    }

    // 3. Cash App / P2P fiat
    if (status.rails.cashapp.ready) {
      steps.push({ step: 'cashapp_p2p', message: 'Generate Cash App P2P QR/link, receive USD, then wire/deposit to Coinbase or another on-ramp.' });
      if (strategy === 'cashapp') {
        const tag = String(cashtag || '').replace(/^\$/, '').trim();
        if (!tag) missing.push('A $Cashtag is required for Cash App P2P');
        else return { canExecute: true, status, steps, missing, recommendation: `Generate Cash App QR for $${tag}, receive USD, then convert to ETH.` };
      }
      if (strategy === 'auto' && cashtag) {
        const tag = String(cashtag).replace(/^\$/, '').trim();
        return { canExecute: true, status, steps, missing, recommendation: `Generate Cash App QR for $${tag}, receive USD, then convert to ETH.` };
      }
    } else {
      missing.push('Cash App rail not ready: ' + (status.rails.cashapp.issues || []).join(', '));
    }

    // 4. Coinbase (fiat → crypto) — fallback when DEX/Cash App cannot close the gap
    if (status.rails.coinbase_treasury.ready) {
      steps.push({ step: 'coinbase_treasury', message: `Reserve ${amountUsd} USD from source ledger and stage Coinbase Treasury bridge. Requires Coinbase account to hold USD.` });
      if (strategy === 'coinbase') {
        return { canExecute: true, status, steps, missing: [...missing, 'coinbase_usd_deposit'], recommendation: 'Run coinbase treasury rail and deposit USD into the connected Coinbase account.' };
      }
    } else {
      missing.push('Coinbase CDP API not configured');
    }

    // 5. Hedera HBAR bridge
    if (status.hedera && Number(status.hedera.hbar) > 0) {
      steps.push({ step: 'hedera_bridge', message: `Hedera account holds ${status.hedera.hbar} HBAR. Bridge to EVM via Hashport/centralized exchange, then send ETH to operator.` });
      missing.push('Hedera HBAR bridge not automated; manual bridge required');
    }

    // 6. Manual deposit invoice
    steps.push({ step: 'manual_deposit', message: `Deposit at least ${status.neededEthForFirstTx} ETH to ${cfg.operatorAddress}, or seed the DLBUSD/WETH pool with WETH.` });
    return { canExecute: false, status, steps, missing, recommendation: 'No automated rail can mint ETH. Deposit ETH or WETH externally, then retry.' };
  }

  static async executePlan({ amountUsd = 100, sourceType, sourceAccountId, targetAsset = 'ETH', strategy = 'auto', railOptions = {}, cashtag = '', memo = '', externalEvmAddress, hederaAccountId } = {}) {
    const plan = await this.buildPlan({ amountUsd, sourceType, sourceAccountId, targetAsset, strategy, externalEvmAddress, hederaAccountId, cashtag });
    if (!plan.canExecute) return { ...plan, executed: [] };

    const executed = [];
    const cfg = this.getConfig();

    // DEX rail (preferred)
    if (strategy === 'dex' || strategy === 'auto') {
      try {
        const result = await StablecoinDexEngine.depositAndSwap({
          sourceType, sourceAccountId, amount: amountUsd,
          targetAsset, recipient: cfg.operatorAddress,
          createPoolIfMissing: railOptions.createPoolIfMissing,
          poolSeedUsdc: railOptions.poolSeedUsdc,
          poolSeedDlbusd: railOptions.poolSeedDlbusd,
        });
        executed.push({ rail: 'stablecoin_dex', result });
        return { ...plan, executed };
      } catch (e) {
        executed.push({ rail: 'stablecoin_dex', error: e.message });
      }
    }

    // Cash App rail
    if (strategy === 'cashapp' || strategy === 'auto') {
      try {
        const tag = (cashtag || railOptions.cashtag || railOptions.recipientTag || '').trim();
        if (!tag) throw new Error('A $Cashtag is required for Cash App P2P funding. Provide cashtag in rail options.');
        const result = await ModuleFundingEngine.fundExternalRail({
          sourceType, sourceAccountId, rail: 'cashapp_fund_operator', amount: amountUsd,
          railOptions: { cashtag: tag, memo: memo || railOptions.memo || 'Fund operator via Cash App' },
        });
        executed.push({ rail: 'cashapp_fund_operator', result });
        return { ...plan, executed };
      } catch (e) {
        executed.push({ rail: 'cashapp_fund_operator', error: e.message });
      }
    }

    // Coinbase rail (CEX fallback)
    if (strategy === 'coinbase' || strategy === 'auto') {
      try {
        const result = await CoinbaseTreasuryBridge.stageFromSource({
          sourceType, sourceAccountId, amount: amountUsd,
          targetAsset, targetAddress: cfg.operatorAddress,
          coinbasePaymentMethodId: railOptions.coinbasePaymentMethodId || '',
        });
        executed.push({ rail: 'coinbase_treasury', result });
        return { ...plan, executed };
      } catch (e) {
        executed.push({ rail: 'coinbase_treasury', error: e.message });
      }
    }

    return { ...plan, executed };
  }

  static async getDepositInvoice({ amountEth = '0.01', externalEvmAddress, hederaAccountId } = {}) {
    const status = await this.getStatus({ externalEvmAddress, hederaAccountId });
    const cfg = this.getConfig();
    return {
      operatorAddress: cfg.operatorAddress,
      wethAddress: cfg.wethAddress,
      amountEth,
      message: `Send ${amountEth} ETH (or WETH to ${cfg.wethAddress}) to the operator wallet. If seeding a DLBUSD/WETH pool, send WETH to the operator and then use the Stablecoin DEX "Create Pool" button.`,
      hedera: status.hedera ? { accountId: hederaAccountId, hbar: status.hedera.hbar, evmAddress: status.hedera.evmAddress, note: 'HBAR must be bridged/swapped to ETH off-chain before it can fund EVM gas.' } : null,
      externalWallet: status.externalWallet,
      sourceBalances: status.sourceBalances,
    };
  }
}

module.exports = { FundingEngine };
