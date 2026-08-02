'use strict';

/**
 * Operator Gas Tank
 *
 * Monitors the operator EVM hot wallet and auto-replenishes it with ETH by
 * converting $100 USD (configurable) from a source-of-funds ledger
 * (Treasury / Core Banking / Trust Accounting / Bond / Fixed Income / Cash /
 * Sub-Ledger) using either the Coinbase Treasury Bridge (CEX) or the
 * Stablecoin DEX (DEX).
 *
 * DEX mode flow:
 *   1. Read operator balance via the configured RPC (Alchemy).
 *   2. If balance < threshold, reserve $100 from the configured source ledger.
 *   3. Mint DLBUSD from that source and swap it for WETH/ETH on a DLBUSD/WETH
 *      pool. The operator relayer pays gas.
 *   4. If the pool does not exist or has no WETH liquidity, status is
 *      `needs_pool`; an external LP must send WETH to seed the pool.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const { getConfig } = require('./config');
const { CoinbaseTreasuryBridge } = require('./coinbaseTreasuryBridge');
const { AccountAbstractionEngine } = require('./accountAbstractionEngine');

let StablecoinDexEngine;
try { StablecoinDexEngine = require('./stablecoinDexEngine').StablecoinDexEngine; } catch (e) { StablecoinDexEngine = null; }

let viem;
try { viem = require('viem'); } catch (e) { }

async function query(sql, params) {
  if (!pool || !pool.query) throw new Error('Postgres pool unavailable');
  return pool.query(sql, params);
}

async function withFallback(fn, fallback) {
  try { return await fn(); } catch (e) { if (!pool) return fallback(e); throw e; }
}

function identifier(prefix = 'GAS') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function publicClient() {
  if (!viem) throw new Error('viem not installed');
  const cfg = getConfig();
  const chains = require('viem/chains');
  const chain = cfg.chainId === 1 ? chains.mainnet
    : (cfg.chainId === 11155111 ? chains.sepolia
    : { id: cfg.chainId, name: 'custom', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } });
  return viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) });
}

class OperatorGasTank {
  static getConfig() {
    const cfg = getConfig();
    return {
      mode: (process.env.OPERATOR_GAS_TANK_MODE || 'dex').toLowerCase(),
      thresholdEth: Number(process.env.OPERATOR_GAS_TANK_THRESHOLD_ETH || '0.005'),
      topupUsd: Number(process.env.OPERATOR_GAS_TANK_TOPUP_USD || '100'),
      sourceType: process.env.OPERATOR_GAS_TANK_SOURCE_TYPE || 'treasury',
      sourceAccountId: process.env.OPERATOR_GAS_TANK_SOURCE_ACCOUNT_ID || 'TREASURY_HOT',
      targetAsset: process.env.OPERATOR_GAS_TANK_TARGET_ASSET || 'ETH',
      targetNetwork: process.env.OPERATOR_GAS_TANK_TARGET_NETWORK || 'ethereum',
      createPoolIfMissing: String(process.env.OPERATOR_GAS_TANK_CREATE_POOL || 'false').toLowerCase() === 'true',
      poolSeedWeth: Number(process.env.OPERATOR_GAS_TANK_POOL_SEED_WETH || '0'),
      poolSeedDlbusd: Number(process.env.OPERATOR_GAS_TANK_POOL_SEED_DLBUSD || '0.2'),
      seedPaymasterAmount: Number(process.env.OPERATOR_GAS_TANK_SEED_PAYMASTER_ETH || '0'),
      operatorAddress: cfg.operatorAddress,
      wethAddress: cfg.wethAddress,
    };
  }

  static async ensureTables() {
    await withFallback(async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS operator_gas_tank_topups (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reserved','needs_deposit','needs_pool','completed','failed')),
          source_type TEXT,
          source_account_id TEXT,
          amount_usd NUMERIC(12,2) NOT NULL,
          target_asset TEXT NOT NULL DEFAULT 'ETH',
          target_network TEXT NOT NULL DEFAULT 'ethereum',
          target_address TEXT NOT NULL,
          operator_eth_before TEXT,
          operator_eth_after TEXT,
          bridge_transfer_id TEXT,
          error TEXT,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await query('CREATE INDEX IF NOT EXISTS idx_operator_gas_tank_status ON operator_gas_tank_topups(status);');
      try {
        await query('ALTER TABLE operator_gas_tank_topups DROP CONSTRAINT IF EXISTS operator_gas_tank_topups_status_check');
        await query("ALTER TABLE operator_gas_tank_topups ADD CONSTRAINT operator_gas_tank_topups_status_check CHECK (status IN ('pending','reserved','needs_deposit','needs_pool','completed','failed'))");
      } catch (e) { /* best effort */ }
    }, () => { /* memory fallback */ });
  }

  static async _insert(topup) {
    await withFallback(async () => {
      await query(`
        INSERT INTO operator_gas_tank_topups (id, status, source_type, source_account_id, amount_usd, target_asset, target_network, target_address, operator_eth_before, operator_eth_after, bridge_transfer_id, error, metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (id) DO UPDATE SET
          status=EXCLUDED.status,
          operator_eth_after=EXCLUDED.operator_eth_after,
          bridge_transfer_id=EXCLUDED.bridge_transfer_id,
          error=EXCLUDED.error,
          metadata=EXCLUDED.metadata,
          updated_at=NOW()
      `, [
        topup.id, topup.status, topup.source_type, topup.source_account_id, topup.amount_usd,
        topup.target_asset, topup.target_network, topup.target_address,
        topup.operator_eth_before, topup.operator_eth_after, topup.bridge_transfer_id,
        topup.error, JSON.stringify(topup.metadata || {})
      ]);
    }, () => { /* memory fallback */ });
  }

  static async _update(topup) {
    return this._insert(topup);
  }

  static async _selectOne(id) {
    return withFallback(async () => {
      const rows = await query('SELECT * FROM operator_gas_tank_topups WHERE id = $1', [id]);
      if (!rows.rows.length) throw new Error('Gas tank topup not found');
      return rows.rows[0];
    }, async () => { throw new Error('Postgres unavailable'); });
  }

  static async listTopups({ limit = 20, status } = {}) {
    return withFallback(async () => {
      const params = [Math.min(limit, 100)];
      const where = status ? 'WHERE status = $2' : '';
      if (status) params.push(status);
      const rows = await query(`SELECT * FROM operator_gas_tank_topups ${where} ORDER BY created_at DESC LIMIT $1`, params);
      return rows.rows;
    }, async () => []);
  }

  static async getBalance() {
    const cfg = this.getConfig();
    if (!cfg.operatorAddress) throw new Error('DAPP_OPERATOR_ADDRESS not configured');
    if (!viem) throw new Error('viem not installed');
    const client = publicClient();
    const wei = await client.getBalance({ address: cfg.operatorAddress });
    return { address: cfg.operatorAddress, balanceEth: viem.formatEther(wei), balanceWei: wei.toString() };
  }

  static async _wethBalance(address) {
    if (!viem || !address || !getConfig().wethAddress) return '0';
    try {
      const client = publicClient();
      const abi = [{ type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }];
      const raw = await client.readContract({ address: getConfig().wethAddress, abi, functionName: 'balanceOf', args: [address] });
      return viem.formatEther(raw);
    } catch (e) { return '0'; }
  }

  static async getStatus() {
    const cfg = this.getConfig();
    const balance = await this.getBalance().catch(e => ({ address: cfg.operatorAddress, balanceEth: '0', error: e.message }));
    const wethBalance = await this._wethBalance(cfg.operatorAddress);
    const topups = await this.listTopups({ limit: 10 });
    const low = Number(balance.balanceEth) < cfg.thresholdEth;
    return {
      operatorAddress: balance.address,
      balanceEth: balance.balanceEth,
      wethBalance,
      thresholdEth: cfg.thresholdEth,
      topupUsd: cfg.topupUsd,
      mode: cfg.mode,
      sourceType: cfg.sourceType,
      sourceAccountId: cfg.sourceAccountId,
      targetAsset: cfg.targetAsset,
      targetNetwork: cfg.targetNetwork,
      low,
      coinbaseEnabled: CoinbaseTreasuryBridge.enabled(),
      dexEnabled: !!StablecoinDexEngine,
      recentTopups: topups,
    };
  }

  static async _checkInFlight(recentTopups, force, balance) {
    if (force) return null;
    const inFlightStatuses = ['pending','reserved','needs_deposit','needs_pool','deposit_initiated','buying','sending'];
    return recentTopups.find(t => inFlightStatuses.includes(t.status));
  }

  static async _recordTopup(fields) {
    const topup = {
      id: identifier('GAS'),
      status: 'pending',
      source_type: fields.sourceType,
      source_account_id: fields.sourceAccountId,
      amount_usd: Number(fields.amount),
      target_asset: fields.targetAsset,
      target_network: fields.targetNetwork,
      target_address: fields.targetAddress,
      operator_eth_before: fields.balanceEth,
      operator_eth_after: null,
      bridge_transfer_id: null,
      error: '',
      metadata: {},
    };
    await this._insert(topup);
    return topup;
  }

  static async checkAndTopUp({
    sourceType,
    sourceAccountId,
    amountUsd,
    thresholdEth,
    targetAsset,
    targetNetwork,
    mode,
    createPoolIfMissing,
    poolSeedWeth,
    poolSeedDlbusd,
    force = false,
  } = {}) {
    const cfg = this.getConfig();
    const useMode = (mode || cfg.mode || 'dex').toLowerCase();
    const useSourceType = sourceType || cfg.sourceType;
    const useSourceAccountId = sourceAccountId || cfg.sourceAccountId;
    const useAmount = Number(amountUsd || cfg.topupUsd);
    const useThreshold = Number(thresholdEth || cfg.thresholdEth);
    const useTargetAsset = (targetAsset || cfg.targetAsset || 'ETH').toUpperCase();
    const useTargetNetwork = targetNetwork || cfg.targetNetwork || 'ethereum';

    if (!cfg.operatorAddress) throw new Error('DAPP_OPERATOR_ADDRESS not configured');

    const balance = await this.getBalance();
    if (!force && Number(balance.balanceEth) >= useThreshold) {
      return { status: 'skipped', reason: 'balance_above_threshold', balanceEth: balance.balanceEth, thresholdEth: useThreshold };
    }

    // Do not create overlapping top-ups while one is already in flight.
    const recentTopups = await this.listTopups({ limit: 5 });
    const inFlight = await this._checkInFlight(recentTopups, force, balance);
    if (inFlight) {
      return { status: 'skipped', reason: 'topup_already_in_flight', topupId: inFlight.id, status: inFlight.status, balanceEth: balance.balanceEth };
    }

    const topup = await this._recordTopup({
      sourceType: useSourceType,
      sourceAccountId: useSourceAccountId,
      amount: useAmount,
      targetAsset: useTargetAsset,
      targetNetwork: useTargetNetwork,
      targetAddress: cfg.operatorAddress,
      balanceEth: balance.balanceEth,
    });

    if (useMode === 'dex') {
      return this._checkAndTopUpDex({
        topup, cfg, useSourceType, useSourceAccountId, useAmount, useTargetAsset,
        createPoolIfMissing, poolSeedWeth, poolSeedDlbusd,
      });
    }

    return this._checkAndTopUpCoinbase({
      topup, cfg, useSourceType, useSourceAccountId, useAmount, useTargetAsset, useTargetNetwork,
    });
  }

  static async _checkAndTopUpDex({
    topup, cfg, useSourceType, useSourceAccountId, useAmount, useTargetAsset,
    createPoolIfMissing, poolSeedWeth, poolSeedDlbusd,
  }) {
    if (!StablecoinDexEngine) {
      topup.status = 'failed';
      topup.error = 'Stablecoin DEX engine not available';
      await this._update(topup);
      throw new Error(topup.error);
    }

    const dexCfg = StablecoinDexEngine.getConfig();
    if (!dexCfg.enabled) {
      topup.status = 'needs_config';
      topup.error = 'Stablecoin DEX is not enabled';
      await this._update(topup);
      return { status: 'needs_config', topup, reason: topup.error };
    }

    try {
      const result = await StablecoinDexEngine.depositAndSwap({
        sourceType: useSourceType,
        sourceAccountId: useSourceAccountId,
        amount: useAmount,
        targetAsset: useTargetAsset,
        recipient: cfg.operatorAddress,
        createPoolIfMissing: createPoolIfMissing !== undefined ? createPoolIfMissing : cfg.createPoolIfMissing,
        poolSeedUsdc: poolSeedWeth !== undefined ? poolSeedWeth : cfg.poolSeedWeth,
        poolSeedDlbusd: poolSeedDlbusd !== undefined ? poolSeedDlbusd : cfg.poolSeedDlbusd,
        poolSeedTargetAmount: poolSeedWeth !== undefined ? poolSeedWeth : cfg.poolSeedWeth,
        unwrapWeth: true,
      });

      topup.metadata = { ...topup.metadata, dexResult: result };

      if (result.mode === 'shadow' || result.poolCreated) {
        // If we created a pool, we likely used operator funds; do not mark completed until verified.
      }

      const after = await this.getBalance().catch(() => ({ balanceEth: topup.operator_eth_before }));
      const wethAfter = await this._wethBalance(cfg.operatorAddress);
      topup.operator_eth_after = after.balanceEth;
      topup.metadata.wethBalanceAfter = wethAfter;

      if (result.swap && (result.swap.status === 'executed' || result.swap.mode === 'shadow')) {
        topup.status = 'completed';
        await this._update(topup);
        await this._maybeSeedPaymaster();
        return {
          status: 'completed',
          topup,
          balanceEth: topup.operator_eth_after,
          wethBalance: wethAfter,
          dexResult: result,
        };
      }

      topup.status = 'needs_pool';
      topup.error = 'DEX swap did not execute. The DLBUSD/WETH pool may be missing or has no WETH liquidity.';
      await this._update(topup);
      return {
        status: 'needs_pool',
        topup,
        instructions: {
          message: 'Send WETH to the operator address, or use an external LP to seed a DLBUSD/WETH pool, then retry.',
          operatorAddress: cfg.operatorAddress,
          wethAddress: cfg.wethAddress,
        },
      };
    } catch (err) {
      const msg = (err && err.message) || String(err);
      topup.status = 'needs_pool';
      topup.error = msg;
      await this._update(topup);
      return {
        status: 'needs_pool',
        topup,
        instructions: {
          message: 'DEX swap failed, likely because no DLBUSD/WETH pool exists or it has no WETH liquidity.',
          operatorAddress: cfg.operatorAddress,
          wethAddress: cfg.wethAddress,
          error: msg,
        },
      };
    }
  }

  static async _checkAndTopUpCoinbase({ topup, cfg, useSourceType, useSourceAccountId, useAmount, useTargetAsset, useTargetNetwork }) {
    if (!CoinbaseTreasuryBridge.enabled()) {
      topup.status = 'needs_config';
      topup.error = 'Coinbase CDP API not configured; set COINBASE_CDP_KEY_NAME and COINBASE_CDP_PRIVATE_KEY to enable automatic ETH conversion.';
      await this._update(topup);
      return { status: 'needs_config', topup, reason: topup.error };
    }

    try {
      const result = await CoinbaseTreasuryBridge.stageFromSource({
        sourceType: useSourceType,
        sourceAccountId: useSourceAccountId,
        amount: useAmount,
        targetAsset: useTargetAsset,
        targetNetwork: useTargetNetwork,
        targetAddress: cfg.operatorAddress,
      });

      const transfer = result && result.transfer ? result.transfer : (result || {});
      topup.bridge_transfer_id = transfer.id || null;
      topup.status = result && result.status ? result.status : (transfer.status || 'pending');
      topup.metadata = { ...topup.metadata, bridgeResult: result };

      if (topup.status === 'completed') {
        const after = await this.getBalance().catch(() => ({ balanceEth: topup.operator_eth_before }));
        topup.operator_eth_after = after.balanceEth;
        await this._update(topup);
        await this._maybeSeedPaymaster();
        return { status: 'completed', topup, balanceEth: topup.operator_eth_after };
      }

      if (topup.status === 'needs_deposit') {
        topup.error = 'Source reserved; Coinbase account needs USD deposit to complete ETH buy and send.';
        await this._update(topup);
        return { status: 'needs_deposit', topup, instructions: result.instructions || {} };
      }

      await this._update(topup);
      return { status: topup.status, topup };
    } catch (err) {
      topup.status = 'failed';
      topup.error = (err && err.message) || String(err);
      await this._update(topup);
      throw err;
    }
  }

  static async _maybeSeedPaymaster() {
    const cfg = this.getConfig();
    const amount = cfg.seedPaymasterAmount;
    if (!amount || amount <= 0) return;
    try {
      const seed = await AccountAbstractionEngine.seedPaymaster({ amountEth: String(amount) });
      console.log('[operatorGasTank] auto-seeded paymaster:', seed);
    } catch (e) {
      console.warn('[operatorGasTank] auto-seed paymaster failed:', e.message);
    }
  }

  static async executePending(topupId) {
    const topup = await this._selectOne(topupId);
    if (topup.bridge_transfer_id) {
      const result = await CoinbaseTreasuryBridge.completeDepositAndExecute(topup.bridge_transfer_id);
      const transfer = result && result.transfer ? result.transfer : result;
      topup.status = transfer && transfer.status ? transfer.status : 'completed';
      if (topup.status === 'completed') {
        const after = await this.getBalance().catch(() => ({ balanceEth: topup.operator_eth_before }));
        topup.operator_eth_after = after.balanceEth;
        await this._maybeSeedPaymaster();
      }
      await this._update(topup);
      return { topup, bridgeResult: result };
    }

    // DEX retry
    if (!StablecoinDexEngine) throw new Error('Stablecoin DEX engine not available');
    const cfg = this.getConfig();
    const result = await StablecoinDexEngine.depositAndSwap({
      sourceType: topup.source_type,
      sourceAccountId: topup.source_account_id,
      amount: Number(topup.amount_usd),
      targetAsset: topup.target_asset,
      recipient: topup.target_address,
      unwrapWeth: true,
    });
    topup.metadata = { ...topup.metadata, dexRetryResult: result };
    const after = await this.getBalance().catch(() => ({ balanceEth: topup.operator_eth_before }));
    const wethAfter = await this._wethBalance(cfg.operatorAddress);
    topup.operator_eth_after = after.balanceEth;
    topup.metadata.wethBalanceAfter = wethAfter;
    if (result.swap && (result.swap.status === 'executed' || result.swap.mode === 'shadow')) {
      topup.status = 'completed';
      await this._update(topup);
      await this._maybeSeedPaymaster();
      return { status: 'completed', topup, balanceEth: topup.operator_eth_after, wethBalance: wethAfter, dexResult: result };
    }
    topup.status = 'needs_pool';
    topup.error = 'DEX retry failed: pool still missing or has no WETH liquidity.';
    await this._update(topup);
    return { status: 'needs_pool', topup, instructions: { operatorAddress: cfg.operatorAddress, wethAddress: cfg.wethAddress } };
  }
}

module.exports = { OperatorGasTank };
