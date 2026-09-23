'use strict';

const { query } = require('../bonds/pgPool');
let StablecoinDexEngine, DexSwapEngine, PtcStablecoinEngine, CanonicalLiquidityEngine, CanonicalFundingSource, ThirdwebServerWalletEngine, TrustAllocationEngine;
try { ({ TrustAllocationEngine } = require('./trustAllocationEngine')); } catch (e) { /* optional */ }
try { ({ StablecoinDexEngine } = require('./stablecoinDexEngine')); } catch (e) { /* optional */ }
try { ({ CanonicalFundingSource } = require('../fineract/canonicalFundingSource')); } catch (e) { /* optional */ }
try { ({ ThirdwebServerWalletEngine } = require('./thirdwebServerWalletEngine')); } catch (e) { /* optional */ }
try { ({ DexSwapEngine } = require('./dexSwapEngine')); } catch (e) { /* optional */ }
try { ({ PtcStablecoinEngine } = require('./ptcStablecoinEngine')); } catch (e) { /* optional */ }
try { ({ CanonicalLiquidityEngine } = require('./canonicalLiquidityEngine')); } catch (e) { /* optional */ }
let dappConfig = null;
try { ({ getConfig: dappConfig } = require('./config')); } catch (e) { /* optional */ }

const CANONICAL_SOURCE_TYPES = new Set(['canonical', 'erp', 'core_banking_canonical']);
const USDC_DECIMALS = 6;

function usdcAddress() {
  return dappConfig ? dappConfig().usdcAddress || null : null;
}

function canonicalConsensusEngine() {
  const { CanonicalConsensusEngine } = require('./canonicalConsensusEngine');
  return CanonicalConsensusEngine;
}

function safeJson(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v); }
function id(prefix = 'CM') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }

/**
 * CanonicalMoneyEngine — turn trust assets and income into canonical spendable stablecoins.
 *
 * Supported sources:
 *  - canonical: the Treasury-Core banking ERP (Fineract GL). The liquidity is
 *    the treasury's own USDC: CanonicalFundingSource moves the GL (Dr USDC
 *    treasury / Cr source cash account, both books) and the treasury wallet
 *    deposits USDC into the recipient policy contract. No DEX pool.
 *  - ledger sources (cash, treasury, trust, bond, fixed_income/bond_interest, fineract, sub_ledger)
 *  - DLB-PTCUSD stablecoin
 *  - module reserve tokens (DLB-PRB, DLB-TREASURY, etc.)
 *
 * Execution is gated by Canonical Consensus (1-of-2 Maker/Checker).
 */
class CanonicalMoneyEngine {
  static async ensureTables() {
    await query(`
      CREATE TABLE IF NOT EXISTS canonical_money_requests (
        id              TEXT PRIMARY KEY,
        proposal_id     TEXT,
        source_type     TEXT,
        source_account  TEXT,
        source_token    TEXT,
        source_module   TEXT,
        amount          TEXT,
        target_asset    TEXT DEFAULT 'USDC',
        route           TEXT,
        status          TEXT DEFAULT 'pending',
        result          JSONB DEFAULT '{}',
        created_by      TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_canonical_money_status ON canonical_money_requests(status)`);
  }

  static async quote({ sourceType, sourceAccountId, sourceToken, sourceModule, amount, targetAsset = 'USDC', poolAddress }) {
    if (!amount || Number(amount) <= 0) throw new Error('amount must be positive');
    const route = await this._pickRoute({ sourceType, sourceAccountId, sourceToken, sourceModule, targetAsset, poolAddress });
    return { ...route, amount, targetAsset, quotedAt: new Date().toISOString() };
  }

  static async propose({ sourceType, sourceAccountId, sourceToken, sourceModule, amount, targetAsset = 'USDC', poolAddress, recipient, createPoolIfMissing, poolSeedUsdc, poolSeedDlbusd, title, createdBy, autoApprove = false }) {
    await this.ensureTables();
    if (!amount || Number(amount) <= 0) throw new Error('amount must be positive');
    const route = await this._pickRoute({ sourceType, sourceAccountId, sourceToken, sourceModule, targetAsset, poolAddress });
    const requestId = id();
    const proposal = await canonicalConsensusEngine().createProposal({
      category: 'canonical_money',
      title: title || `Convert ${amount} ${sourceType || sourceToken || sourceModule} to ${targetAsset}`,
      description: `Canonical money conversion via ${route.action}`,
      payload: {
        requestId,
        sourceType,
        sourceAccountId,
        sourceToken,
        sourceModule,
        amount,
        targetAsset,
        poolAddress,
        recipient,
        createPoolIfMissing,
        poolSeedUsdc,
        poolSeedDlbusd,
        route,
      },
      createdBy: createdBy || 'operator',
      autoExecute: autoApprove,
    });
    await query(
      `INSERT INTO canonical_money_requests (id, proposal_id, source_type, source_account, source_token, source_module, amount, target_asset, route, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [requestId, proposal.id, sourceType || null, sourceAccountId || null, sourceToken || null, sourceModule || null, String(amount), targetAsset, safeJson(route), 'pending', createdBy || 'operator']
    );
    return { requestId, proposalId: proposal.id, route, proposal };
  }

  static async approve({ proposalId, role, approverEmail }) {
    return canonicalConsensusEngine().approveProposal({ proposalId, role, approverEmail });
  }

  static async listRequests({ status, limit = 50, offset = 0 } = {}) {
    await this.ensureTables();
    let sql = 'SELECT * FROM canonical_money_requests';
    const params = [];
    if (status) { sql += ' WHERE status = $1'; params.push(status); }
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));
    const res = await query(sql, params);
    return res.rows.map(r => ({ ...r, route: typeof r.route === 'string' ? JSON.parse(r.route) : r.route, result: typeof r.result === 'string' ? JSON.parse(r.result) : r.result }));
  }

  static async _execute(proposal) {
    const { payload } = proposal;
    const { requestId, route } = payload;
    try {
      const result = await this._executeRoute(route, payload);
      await query('UPDATE canonical_money_requests SET result=$1, status=$2, updated_at=NOW() WHERE id=$3', [safeJson(result), result.status || 'completed', requestId]);
      return result;
    } catch (err) {
      const errorResult = { status: 'failed', error: err.message };
      await query('UPDATE canonical_money_requests SET result=$1, status=$2, updated_at=NOW() WHERE id=$3', [safeJson(errorResult), 'failed', requestId]);
      throw err;
    }
  }

  /**
   * Which canonical account an erp_treasury draw credits. When the bucket's cash
   * was already on-ramped into the treasury wallet (SpritzOnRampEngine books it
   * in the bucket's wallet USDC account, 1025/1035) and that account covers the
   * amount, the draw credits the wallet account — the USDC deposited to the
   * policy contract is that same USDC. Otherwise the bucket cash account itself.
   */
  static async _erpCashAccount(sourceAccountId, amount) {
    const code = String(sourceAccountId);
    if (!TrustAllocationEngine) return code;
    const bucket = TrustAllocationEngine.bucketForSource({ sourceType: 'canonical', sourceAccountId: code });
    if (!bucket) return code;
    const walletCode = TrustAllocationEngine.walletGlAccountCode(bucket.key);
    if (!walletCode || walletCode === code) return code;
    const needed = Math.round(Number(amount) * 100);
    const wallet = await CanonicalFundingSource.position({ accountCode: walletCode, purpose: `${bucket.key} wallet` }).catch(() => null);
    return wallet && wallet.fundingEligible && wallet.availableBalanceCents >= needed ? walletCode : code;
  }

  static async _pickRoute({ sourceType, sourceAccountId, sourceToken, sourceModule, targetAsset, poolAddress }) {
    // Treasury-Core ERP GL -> treasury USDC -> policy contract (no pool)
    if (sourceType && CANONICAL_SOURCE_TYPES.has(String(sourceType).toLowerCase())) {
      if (String(targetAsset || 'USDC').toUpperCase() !== 'USDC') throw new Error('canonical ERP source funds USDC only');
      if (!sourceAccountId) throw new Error('sourceAccountId (ERP GL cash account code) required for canonical source');
      const erp = CanonicalFundingSource ? CanonicalFundingSource.getConfig() : null;
      return {
        action: 'erp_treasury',
        sourceType: 'canonical',
        sourceAccountId: String(sourceAccountId),
        sourceModule: sourceModule || null,
        targetAsset: 'USDC',
        tokenOut: usdcAddress(),
        glAccounts: erp ? { cash: String(sourceAccountId), asset: erp.assetAccountCode } : null,
        live: Boolean(erp && erp.live),
        note: 'Treasury-Core ERP: Dr USDC treasury / Cr ERP cash account, treasury wallet deposits USDC to the policy contract',
      };
    }
    // Ledger / source-of-funds -> DLBUSD -> canonical stablecoin
    if (sourceType) return { action: 'mint_and_swap', sourceType, sourceAccountId, targetAsset, note: 'Mint DLBUSD from ledger and swap on DEX' };
    const ptcAddress = process.env.DLB_PTCUSD_ADDRESS || '0xb01e6280ffe6faac679a17b029df8e065e8d0002';
    const targetAddress = StablecoinDexEngine ? StablecoinDexEngine.targetTokenAddress(targetAsset) : '';
    const tokenIn = sourceModule ? ptcAddress : (sourceToken && sourceToken.toLowerCase() === 'dlb-ptcusd' ? ptcAddress : sourceToken);
    // PTC stablecoin or module token -> canonical stablecoin via governed liquidity pool
    if (sourceToken && sourceToken.toLowerCase() === 'dlb-ptcusd') {
      const pool = poolAddress || await this._findPool(tokenIn, targetAddress);
      return { action: 'ptc_swap', tokenIn, targetAddress, targetAsset, poolAddress: pool, note: pool ? 'Swap DLB-PTCUSD via canonical liquidity pool' : 'No canonical liquidity pool found; create one first' };
    }
    // Module token -> vault -> DLB-PTCUSD -> canonical stablecoin
    if (sourceModule) {
      const pool = poolAddress || await this._findPool(ptcAddress, targetAddress);
      return { action: 'module_deposit_and_swap', moduleKey: sourceModule, tokenIn: ptcAddress, targetAddress, targetAsset, poolAddress: pool, note: pool ? 'Deposit module reserve into PTC vault and swap DLB-PTCUSD' : 'No canonical liquidity pool found; create one first' };
    }
    // Raw token address -> DEX swap
    if (sourceToken) {
      const pool = poolAddress || await this._findPool(tokenIn, targetAddress);
      return { action: 'dex_swap', tokenIn, targetAddress, targetAsset, poolAddress: pool, note: pool ? 'Swap token via DEX' : 'No canonical liquidity pool found; create one first' };
    }
    throw new Error('Unable to determine conversion route from source');
  }

  static async _findPool(tokenIn, tokenOut) {
    if (!tokenIn || !tokenOut) return null;
    const inLower = tokenIn.toLowerCase();
    const outLower = tokenOut.toLowerCase();
    const res = await query("SELECT * FROM canonical_liquidity_pools WHERE status = 'active' AND ((LOWER(token0) = $1 AND LOWER(token1) = $2) OR (LOWER(token0) = $2 AND LOWER(token1) = $1)) LIMIT 1", [inLower, outLower]);
    return res.rows.length ? res.rows[0].pool_address : null;
  }

  static async _executeRoute(route, payload) {
    if (!StablecoinDexEngine && !DexSwapEngine && !PtcStablecoinEngine) throw new Error('No money conversion engines available');
    const { amount, targetAsset, recipient, createPoolIfMissing, poolSeedUsdc, poolSeedDlbusd } = payload;
    switch (route.action) {
      case 'erp_treasury': {
        if (!CanonicalFundingSource) throw new Error('CanonicalFundingSource not available');
        const cashAccountCode = await this._erpCashAccount(route.sourceAccountId, amount);
        const funding = await CanonicalFundingSource.commit({
          amountUsd: amount,
          reference: payload.requestId,
          referenceType: 'canonical_money',
          memo: `ERP ${cashAccountCode} -> ${amount} USDC${recipient ? ' to ' + recipient : ''}`,
          cashAccountCode,
          postedBy: 'canonical-money-engine',
          purpose: route.sourceModule ? `${route.sourceModule} funding` : 'treasury funding',
        });
        let deposit = null;
        if (recipient) {
          if (!ThirdwebServerWalletEngine) throw new Error('ThirdwebServerWalletEngine not available');
          const policy = String(process.env.TRUST_POLICY_ADDRESS || '').toLowerCase();
          if (!policy || policy !== String(recipient).toLowerCase()) {
            throw new Error(`canonical ERP funding deposits only to the policy contract ${policy || '(TRUST_POLICY_ADDRESS unset)'}, not ${recipient}`);
          }
          deposit = await ThirdwebServerWalletEngine.fundPolicy({
            quantity: BigInt(Math.round(Number(amount) * 10 ** USDC_DECIMALS)),
            tokenAddress: route.tokenOut || undefined,
            reference: payload.requestId,
            memo: `ERP ${route.sourceAccountId} funding`,
            amountUsd: amount,
          });
        }
        const shadow = Boolean(funding.shadow) || Boolean(deposit && deposit.shadow);
        return { action: route.action, status: shadow ? 'shadow' : 'completed', shadow, funding, deposit, cashAccountCode, journaledBy: 'canonical_funding_source' };
      }
      case 'mint_and_swap':
        if (!StablecoinDexEngine) throw new Error('StablecoinDexEngine not available');
        return await StablecoinDexEngine.depositAndSwap({
          sourceType: route.sourceType,
          sourceAccountId: route.sourceAccountId,
          amount,
          targetAsset,
          recipient,
          createPoolIfMissing,
          poolSeedUsdc,
          poolSeedDlbusd,
        });
      case 'ptc_swap':
      case 'dex_swap':
        if (!DexSwapEngine) throw new Error('DexSwapEngine not available');
        if (!route.poolAddress) throw new Error('No DEX pool available for swap. Create a canonical liquidity pool first.');
        return await DexSwapEngine.swap({
          tokenIn: route.tokenIn,
          tokenOut: route.targetAddress,
          amountIn: amount,
          decimalsIn: route.action === 'ptc_swap' ? 18 : 6,
          router: route.poolAddress,
          recipient,
        });
      case 'module_deposit_and_swap':
        if (!PtcStablecoinEngine) throw new Error('PtcStablecoinEngine not available');
        const deposit = await PtcStablecoinEngine.approveAndDeposit({ moduleKey: route.moduleKey, amount });
        if (!DexSwapEngine) throw new Error('DexSwapEngine not available');
        if (!route.poolAddress) throw new Error('No DEX pool available for swap. Create a canonical liquidity pool first.');
        const swap = await DexSwapEngine.swap({
          tokenIn: route.tokenIn,
          tokenOut: route.targetAddress,
          amountIn: amount,
          decimalsIn: 18,
          router: route.poolAddress,
          recipient,
        });
        return { deposit, swap };
      default:
        throw new Error(`Unknown route action: ${route.action}`);
    }
  }
}

module.exports = { CanonicalMoneyEngine };
