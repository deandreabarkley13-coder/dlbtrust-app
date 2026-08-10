'use strict';

/**
 * Reserve Vault Engine (CDP)
 *
 * Tokenizes trust ledger / module reserves into an on-chain vault stablecoin
 * and records the collateral backing. By default it uses the existing DLBUSD
 * token as the vault stablecoin because DLBUSD is already a ledger-backed
 * ERC-20 minted by StablecoinDexEngine. The engine can also tokenize PTC
 * reserve modules via PtcStablecoinEngine.
 *
 * The engine is deliberately simple and safe: it does not create DAI/USDC
 * from nothing. Swapping the vault stablecoin for canonical assets still
 * requires a counterparty, liquidity pool, or on-ramp with the canonical
 * asset on the other side.
 */

const { getConfig } = require('./config');

let StablecoinDexEngine;
try { ({ StablecoinDexEngine } = require('./stablecoinDexEngine')); } catch (e) { StablecoinDexEngine = null; }

let PtcStablecoinEngine;
try { ({ PtcStablecoinEngine } = require('./ptcStablecoinEngine')); } catch (e) { PtcStablecoinEngine = null; }

let DecentralizedRampEngine;
try { ({ DecentralizedRampEngine } = require('./decentralizedRampEngine')); } catch (e) { DecentralizedRampEngine = null; }

let InternalMarketMakerEngine;
try { ({ InternalMarketMakerEngine } = require('./internalMarketMakerEngine')); } catch (e) { InternalMarketMakerEngine = null; }

let query = null;
try { ({ query } = require('../bonds/pgPool')); } catch (e) { query = null; }

function id(prefix = 'RV') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function formatUnits(value, decimals = 18) {
  const v = String(value || 0).replace(/[^0-9]/g, '');
  if (!v) return '0';
  const whole = v.length > decimals ? v.slice(0, v.length - decimals) : '0';
  const frac = v.length > decimals ? v.slice(v.length - decimals).replace(/0+$/, '') : v.padStart(decimals, '0').replace(/^0+|0+$/g, '');
  return frac ? `${whole}.${frac}` : whole;
}

class ReserveVaultEngine {
  static getConfig() {
    const cfg = getConfig();
    return {
      vaultTokenSymbol: process.env.RESERVE_VAULT_TOKEN_SYMBOL || 'DLBUSD',
      defaultCollateralRatioBps: Number(process.env.RESERVE_VAULT_COLLATERAL_RATIO_BPS || '10000'),
      operatorAddress: cfg.operatorAddress,
    };
  }

  static async ensureTables() {
    if (!query) return;
    await query(`
      CREATE TABLE IF NOT EXISTS reserve_vault_tokens (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        name TEXT,
        token_address TEXT,
        decimals INTEGER DEFAULT 6,
        collateral_ratio_bps INTEGER DEFAULT 10000,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_rvt_symbol ON reserve_vault_tokens(symbol);`);
    await query(`
      CREATE TABLE IF NOT EXISTS reserve_vault_positions (
        id TEXT PRIMARY KEY,
        token_id TEXT REFERENCES reserve_vault_tokens(id) ON DELETE SET NULL,
        source_type TEXT NOT NULL,
        source_account_id TEXT,
        module_key TEXT,
        collateral_amount NUMERIC(24,6) NOT NULL DEFAULT 0,
        minted_amount NUMERIC(24,6) NOT NULL DEFAULT 0,
        collateral_ratio_bps INTEGER DEFAULT 10000,
        token_symbol TEXT,
        token_address TEXT,
        holder_address TEXT,
        target_asset TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','swapped','redeemed','liquidated','closed')),
        mint_tx_hash TEXT,
        swap_tx_hash TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_reserve_vault_positions_status ON reserve_vault_positions(status);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_reserve_vault_positions_source ON reserve_vault_positions(source_type, source_account_id);`);
  }

  static async _getOrCreateVaultToken(symbol = 'DLBUSD') {
    await this.ensureTables();
    if (!StablecoinDexEngine) throw new Error('StablecoinDexEngine not available');
    const token = await StablecoinDexEngine.getOrCreateDLBUSDToken();
    if (!token || !token.token_address) throw new Error('DLBUSD vault token not available');
    if (!query) return { id: 'dlbusd', ...token };
    const existing = await query('SELECT * FROM reserve_vault_tokens WHERE symbol = $1 LIMIT 1', [symbol]).catch(() => null);
    if (existing && existing.rows && existing.rows.length) return existing.rows[0];
    const tokenId = id('RVT');
    await query(
      `INSERT INTO reserve_vault_tokens (id, symbol, name, token_address, decimals, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (symbol) DO NOTHING`,
      [tokenId, symbol, token.name || 'DLB Vault USD', token.token_address, token.decimals || 6, JSON.stringify({ source: 'stablecoinDexEngine', dlbusdTokenId: token.id })]
    );
    const rows = await query('SELECT * FROM reserve_vault_tokens WHERE symbol = $1 LIMIT 1', [symbol]);
    return rows.rows[0];
  }

  static readiness() {
    const issues = [];
    if (!StablecoinDexEngine) issues.push('StablecoinDexEngine not available');
    if (!query) issues.push('Postgres pool not available');
    return { ready: issues.length === 0, issues, stablecoinDex: !!StablecoinDexEngine, ptcStablecoin: !!PtcStablecoinEngine, decentralizedRamp: !!DecentralizedRampEngine };
  }

  static async mint({
    sourceType,
    sourceAccountId,
    moduleKey,
    amount,
    targetAddress,
    collateralRatioBps = this.getConfig().defaultCollateralRatioBps,
    memo = '',
  } = {}) {
    if (!amount || Number(amount) <= 0) throw new Error('amount must be positive');
    const cfg = this.getConfig();
    const holder = targetAddress || cfg.operatorAddress;
    if (!holder) throw new Error('targetAddress or DAPP_OPERATOR_ADDRESS required');

    const vaultToken = await this._getOrCreateVaultToken(cfg.vaultTokenSymbol);
    const ratio = Math.max(1, Math.min(10000, Number(collateralRatioBps) || 10000));
    const collateralAmount = Number(amount);
    const mintAmount = (collateralAmount * ratio) / 10000;

    let mintResult;
    let tokenSymbol;
    let tokenAddress;
    let tokenId;
    let recordedMinted;
    if (moduleKey && PtcStablecoinEngine) {
      // For module reserves, deposit the raw collateral amount into the PTC vault and record what was actually minted.
      mintResult = await PtcStablecoinEngine.approveAndDeposit({ moduleKey, amount: String(collateralAmount), recipient: holder });
      const ptcInfo = await PtcStablecoinEngine.info();
      tokenSymbol = ptcInfo.tokenSymbol || 'DLB-PTCUSD';
      tokenAddress = ptcInfo.tokenAddress || '';
      tokenId = null;
      recordedMinted = formatUnits(mintResult.mintedStablecoin, 18);
    } else if (sourceType && sourceAccountId && StablecoinDexEngine) {
      // Mint only the ratio-adjusted amount from the ledger source.
      mintResult = await StablecoinDexEngine.mintFromSource({
        sourceType,
        sourceAccountId,
        amount: String(mintAmount),
        targetAddress: holder,
      });
      tokenSymbol = vaultToken.symbol;
      tokenAddress = vaultToken.token_address;
      tokenId = vaultToken.id;
      recordedMinted = mintResult.minted;
    } else {
      throw new Error('Either (sourceType, sourceAccountId) or moduleKey is required');
    }

    const positionId = id('RVP');
    if (query) {
      await query(
        `INSERT INTO reserve_vault_positions (id, token_id, source_type, source_account_id, module_key, collateral_amount, minted_amount, collateral_ratio_bps, token_symbol, token_address, holder_address, status, mint_tx_hash, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [positionId, tokenId, sourceType || 'module', sourceAccountId || null, moduleKey || null, collateralAmount, recordedMinted, ratio, tokenSymbol, tokenAddress, holder, 'active', (mintResult && (mintResult.mintTxHash || mintResult.txHash)) || null, JSON.stringify({ memo, mintResult })]
      );
    }
    return { positionId, sourceType, sourceAccountId, moduleKey, collateralAmount, mintAmount: recordedMinted, tokenSymbol, tokenAddress, holder, mintResult };
  }

  static async getPosition(positionId) {
    if (!query) throw new Error('Postgres pool not available');
    await this.ensureTables();
    const rows = await query('SELECT * FROM reserve_vault_positions WHERE id = $1', [positionId]);
    if (!rows.rows.length) throw new Error('Position not found');
    return rows.rows[0];
  }

  static async listPositions({ sourceType, sourceAccountId, status, holder } = {}) {
    if (!query) return [];
    await this.ensureTables();
    const conditions = [];
    const params = [];
    if (sourceType) { conditions.push('source_type = $' + (params.length + 1)); params.push(sourceType); }
    if (sourceAccountId) { conditions.push('source_account_id = $' + (params.length + 1)); params.push(sourceAccountId); }
    if (status) { conditions.push('status = $' + (params.length + 1)); params.push(status); }
    if (holder) { conditions.push('holder_address ILIKE $' + (params.length + 1)); params.push(holder); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const rows = await query(`SELECT * FROM reserve_vault_positions ${where} ORDER BY created_at DESC LIMIT 100`, params);
    return rows.rows;
  }

  static async quoteToTarget({ positionId, targetAsset = 'DAI', amount } = {}) {
    const position = await this.getPosition(positionId);
    const quoteAmount = amount || position.minted_amount;
    if (!quoteAmount || Number(quoteAmount) <= 0) throw new Error('amount must be positive');
    if (!DecentralizedRampEngine) throw new Error('DecentralizedRampEngine not available');
    const q = await DecentralizedRampEngine.quote({
      sourceAsset: position.token_symbol,
      targetAsset,
      amount: String(quoteAmount),
      sourceType: position.source_type,
      sourceAccountId: position.source_account_id,
    });
    return { position, targetAsset, quoteAmount, routes: q.routes, recommended: q.recommended };
  }

  static async swapToTarget({ positionId, targetAsset = 'DAI', amount, routeProvider, route } = {}) {
    const position = await this.getPosition(positionId);
    const swapAmount = amount || position.minted_amount;
    if (!swapAmount || Number(swapAmount) <= 0) throw new Error('amount must be positive');

    if (!DecentralizedRampEngine) throw new Error('DecentralizedRampEngine not available');

    const q = await DecentralizedRampEngine.quote({
      sourceAsset: position.token_symbol,
      targetAsset,
      amount: String(swapAmount),
      sourceType: position.source_type,
      sourceAccountId: position.source_account_id,
    });

    let chosen = route || q.recommended;
    if (routeProvider) {
      const want = String(routeProvider).toLowerCase();
      chosen = (q.routes || []).find(r => (r.provider && String(r.provider).toLowerCase() === want) || (r.engine && String(r.engine).toLowerCase() === want)) || chosen;
    }
    if (!chosen) throw new Error('No viable route found for ' + position.token_symbol + ' -> ' + targetAsset);

    const proposal = await DecentralizedRampEngine.propose({
      direction: 'exchange',
      sourceAsset: position.token_symbol,
      targetAsset,
      amount: String(swapAmount),
      route: chosen,
      routeProvider: chosen.provider || chosen.engine,
      sourceType: position.source_type,
      sourceAccountId: position.source_account_id,
      targetAddress: position.holder_address,
    });

    if (query) {
      const meta = { ...position.metadata, swapProposal: proposal, targetAsset, swapAmount };
      await query("UPDATE reserve_vault_positions SET target_asset = $1, updated_at = NOW(), metadata = $2 WHERE id = $3", [targetAsset, JSON.stringify(meta), positionId]);
    }
    return { position, targetAsset, swapAmount, route: chosen, proposal };
  }

  static async info() {
    await this.ensureTables();
    const token = await this._getOrCreateVaultToken(this.getConfig().vaultTokenSymbol).catch((e) => { console.warn('[ReserveVaultEngine] vault token load failed:', e.message); return null; });
    const positions = await this.listPositions({ status: 'active' });
    const totalCollateral = positions.reduce((sum, p) => sum + Number(p.collateral_amount || 0), 0);
    const totalMinted = positions.reduce((sum, p) => sum + Number(p.minted_amount || 0), 0);
    return {
      vaultToken: token ? { symbol: token.symbol, token_address: token.token_address, decimals: token.decimals } : null,
      activePositions: positions.length,
      totalCollateral,
      totalMinted,
    };
  }
}

module.exports = { ReserveVaultEngine };
