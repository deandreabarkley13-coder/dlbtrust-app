'use strict';

/**
 * Redemption Engine — close the gap from trust stablecoins / module tokens
 * to real-world payouts.
 *
 * High-level flow:
 *   1. A beneficiary/trustee requests redemption of DLB-PTCUSD (or a reserve
 *      module token) into fiat to a bank account, card, bill, or wallet.
 *   2. Engine records the redemption and optionally routes it through the
 *      Canonical Consensus Engine for Maker/Checker approval.
 *   3. On execution the engine:
 *      - redeems DLB-PTCUSD for reserve tokens,
 *      - lists the reserve tokens for sale into canonical USDC/USDS via the
 *        module P2P swap order book,
 *      - and/or attempts a DEX swap if a liquid pool exists,
 *      - settles the resulting canonical stablecoin to fiat using Spritz
 *        off-ramp (bank, card, bill pay).
 *   4. Every step is written to the redemption audit log.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

let StablecoinEngine;
try { ({ StablecoinEngine } = require('./stablecoinEngine')); } catch (e) { StablecoinEngine = null; }

let ModuleP2PSwapEngine;
try { ({ ModuleP2PSwapEngine } = require('./moduleP2PSwapEngine')); } catch (e) { ModuleP2PSwapEngine = null; }

let StablecoinDexEngine;
try { ({ StablecoinDexEngine } = require('./stablecoinDexEngine')); } catch (e) { StablecoinDexEngine = null; }

let SpritzEngine;
try { ({ SpritzEngine } = require('../spritz/spritzEngine')); } catch (e) { SpritzEngine = null; }

let CanonicalConsensusEngine;
try { ({ CanonicalConsensusEngine } = require('./canonicalConsensusEngine')); } catch (e) { CanonicalConsensusEngine = null; }

let DappEngine;
try { ({ DappEngine } = require('./dappEngine')); } catch (e) { DappEngine = null; }

function id(prefix = 'RDM') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }
function safeJson(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v); }

async function query(sql, params) {
  if (!pool || !pool.query) throw new Error('Postgres pool unavailable');
  return pool.query(sql, params);
}

async function withFallback(fn, fallback) { try { return await fn(); } catch (e) { if (!pool) return fallback(e); throw e; } }

class RedemptionEngine {
  static async ensureTables() {
    await withFallback(async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS dapp_redemptions (
          id TEXT PRIMARY KEY,
          requester_email TEXT,
          recipient_email TEXT,
          from_asset TEXT DEFAULT 'DLB-PTCUSD',
          reserve_module TEXT,
          amount_usd TEXT NOT NULL,
          destination_type TEXT NOT NULL,
          destination_id TEXT,
          rail TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          stage TEXT DEFAULT 'created',
          tx_data JSONB DEFAULT '{}',
          audit JSONB DEFAULT '[]',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    }, () => {});
  }

  static async _appendAudit(redemptionId, entry) {
    await withFallback(async () => {
      const { rows } = await query(`SELECT audit FROM dapp_redemptions WHERE id = $1`, [redemptionId]);
      const audit = (rows[0]?.audit || []);
      audit.push({ ...entry, at: new Date().toISOString() });
      await query(`UPDATE dapp_redemptions SET audit = $1, updated_at = NOW() WHERE id = $2`, [safeJson(audit), redemptionId]);
    }, () => {});
  }

  static async _update(redemptionId, updates) {
    await withFallback(async () => {
      const keys = Object.keys(updates);
      const set = keys.map((k, i) => `${k} = $${i + 1}`).join(',');
      const values = keys.map(k => (k === 'tx_data' || k === 'audit') ? safeJson(updates[k]) : updates[k]);
      await query(`UPDATE dapp_redemptions SET ${set}, updated_at = NOW() WHERE id = $${keys.length + 1}`, [...values, redemptionId]);
    }, () => {});
  }

  static async _resolveAddress(identifier) {
    if (!identifier) return null;
    if (typeof identifier === 'string' && identifier.startsWith('0x')) return identifier.toLowerCase();
    if (DappEngine) {
      const user = await DappEngine.getUserByEmail(identifier).catch(() => null);
      if (user?.wallet_address) return user.wallet_address;
    }
    return null;
  }

  static async create({ requesterEmail, recipientEmail, amount, fromAsset = 'DLB-PTCUSD', reserveModule, destinationType, destinationId, rail, requireConsensus = false } = {}) {
    await this.ensureTables();
    if (!amount || Number(amount) <= 0) throw new Error('amount must be positive');
    if (!destinationType) throw new Error('destinationType required');

    const record = {
      id: id(),
      requester_email: requesterEmail,
      recipient_email: recipientEmail,
      from_asset: fromAsset,
      reserve_module: reserveModule || 'fixed_income',
      amount_usd: String(amount),
      destination_type: destinationType,
      destination_id: destinationId,
      rail: rail || 'spritz_ach',
      status: 'pending',
      stage: 'created',
      tx_data: { requireConsensus },
      audit: [{ at: new Date().toISOString(), action: 'created', amount, fromAsset, destinationType }],
    };

    await withFallback(async () => {
      const keys = Object.keys(record);
      const cols = keys.join(',');
      const vals = keys.map((_, i) => `$${i + 1}`).join(',');
      await query(`INSERT INTO dapp_redemptions (${cols}) VALUES (${vals})`, keys.map(k => (k === 'tx_data' || k === 'audit') ? safeJson(record[k]) : record[k]));
    }, () => {});

    if (requireConsensus && CanonicalConsensusEngine) {
      const proposal = await CanonicalConsensusEngine.createProposal({
        title: `Redeem ${amount} ${fromAsset} to ${destinationType}`,
        category: 'custom',
        payload: { redemptionId: record.id, requesterEmail, amount, fromAsset, destinationType, destinationId },
        createdBy: requesterEmail,
      });
      record.tx_data.proposalId = proposal.id;
      await this._update(record.id, { tx_data: record.tx_data });
    }

    return record;
  }

  static async execute(redemptionId, { operatorEmail } = {}) {
    await this.ensureTables();
    const rows = await withFallback(async () => (await query(`SELECT * FROM dapp_redemptions WHERE id = $1`, [redemptionId])).rows, () => []);
    const record = rows[0];
    if (!record) throw new Error('Redemption not found');
    if (record.status === 'completed') throw new Error('Redemption already completed');

    const amount = Number(record.amount_usd);
    const fromAsset = record.from_asset;
    const reserveModule = record.reserve_module;
    const destinationType = record.destination_type;
    const destinationId = record.destination_id;
    const rail = record.rail;

    await this._update(redemptionId, { status: 'processing', stage: 'preparing' });
    await this._appendAudit(redemptionId, { action: 'execute.start', operator: operatorEmail });

    // 1. If fromAsset is DLB-PTCUSD, redeem for reserve module token.
    let reserveTokenAmount = null;
    if (fromAsset === 'DLB-PTCUSD' && StablecoinEngine) {
      await this._appendAudit(redemptionId, { action: 'redeem.stablecoin', reserveModule, amount });
      const redeemResult = await StablecoinEngine.redeem({ moduleKey: reserveModule, amount, operatorEmail });
      reserveTokenAmount = redeemResult.reserveAmount;
      await this._appendAudit(redemptionId, { action: 'redeem.stablecoin.done', txHash: redeemResult.txHash, reserveTokenAmount });
      await this._update(redemptionId, { stage: 'reserves_released', tx_data: { ...record.tx_data, redeem: redeemResult } });
    }

    // 2. Try to obtain canonical stablecoin (USDC/USDS) for the reserve token.
    let canonicalStablecoinAmount = 0;
    const canonicalAsset = 'USDC'; // default; can be configurable
    const targetAddress = await this._resolveAddress(record.recipient_email) || (SpritzEngine ? 'spritz' : '');

    // Prefer DEX if a liquid pool exists, otherwise list on P2P.
    let swapResult = null;
    if (StablecoinDexEngine) {
      try {
        await this._appendAudit(redemptionId, { action: 'swap.dex.attempt', reserveModule, amount });
        // Note: StablecoinDexEngine works from source-of-funds ledgers, not reserve tokens directly.
        // If reserve module has a source-of-funds adapter, this can be configured to mint DLBUSD and swap.
        swapResult = await StablecoinDexEngine.depositAndSwap({
          sourceType: 'module',
          sourceAccountId: reserveModule,
          amount,
          targetAsset: canonicalAsset,
          recipient: targetAddress,
        });
        if (swapResult?.swap?.txHash) {
          canonicalStablecoinAmount = amount;
          await this._appendAudit(redemptionId, { action: 'swap.dex.done', txHash: swapResult.swap.txHash, canonicalStablecoinAmount });
        }
      } catch (e) {
        await this._appendAudit(redemptionId, { action: 'swap.dex.failed', error: e.message });
      }
    }

    if (!canonicalStablecoinAmount && ModuleP2PSwapEngine) {
      try {
        await this._appendAudit(redemptionId, { action: 'swap.p2p.list', reserveModule, amount });
        const order = await ModuleP2PSwapEngine.createModuleOrder({
          moduleKey: reserveModule,
          amountIn: reserveTokenAmount ? String(reserveTokenAmount) : String(amount),
          pricePerToken: '1',
          recipient: targetAddress,
        });
        swapResult = order;
        await this._appendAudit(redemptionId, { action: 'swap.p2p.listed', orderId: order.orderId, txHash: order.txHash });
        await this._update(redemptionId, { status: 'awaiting_buyer', stage: 'p2p_order_listed', tx_data: { ...record.tx_data, p2pOrder: order } });
        return { ...record, status: 'awaiting_buyer', stage: 'p2p_order_listed', swapResult };
      } catch (e) {
        await this._appendAudit(redemptionId, { action: 'swap.p2p.failed', error: e.message });
      }
    }

    if (!canonicalStablecoinAmount && !swapResult) {
      await this._update(redemptionId, { status: 'awaiting_funds', stage: 'no_liquidity' });
      return { ...record, status: 'awaiting_funds', stage: 'no_liquidity' };
    }

    // 3. If canonical stablecoin is in hand, settle via Spritz if destination is fiat.
    if (canonicalStablecoinAmount > 0 && SpritzEngine && destinationType !== 'wallet') {
      await this._appendAudit(redemptionId, { action: 'offramp.quote', rail, amount: canonicalStablecoinAmount });
      const quote = await SpritzEngine.createOffRampQuote({
        accountId: destinationId,
        amount: String(canonicalStablecoinAmount),
        tokenAddress: process.env.DAPP_USDC_ADDRESS || '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        chain: 'ethereum',
        rail,
      });
      const executed = await SpritzEngine.executeQuote(quote.id);
      await this._appendAudit(redemptionId, { action: 'offramp.executed', txHash: executed.txHash, quoteId: quote.id });
      await this._update(redemptionId, { status: 'completed', stage: 'settled', tx_data: { ...record.tx_data, offramp: executed } });
      return { ...record, status: 'completed', stage: 'settled', quote, executed };
    }

    // If destination is wallet or no Spritz configured, just transfer canonical stablecoin.
    if (canonicalStablecoinAmount > 0) {
      await this._update(redemptionId, { status: 'completed', stage: 'wallet_transfer', tx_data: { ...record.tx_data, swapResult } });
      return { ...record, status: 'completed', stage: 'wallet_transfer', swapResult };
    }

    return { ...record, status: 'awaiting_buyer', stage: 'p2p_order_listed', swapResult };
  }

  static async approve(redemptionId, approverEmail) {
    await this.ensureTables();
    const rows = await withFallback(async () => (await query(`SELECT * FROM dapp_redemptions WHERE id = $1`, [redemptionId])).rows, () => []);
    const record = rows[0];
    if (!record) throw new Error('Redemption not found');
    const proposalId = record.tx_data?.proposalId;
    if (!proposalId || !CanonicalConsensusEngine) throw new Error('No consensus proposal attached');
    await CanonicalConsensusEngine.approveProposal({ proposalId, approverEmail });
    await this._appendAudit(redemptionId, { action: 'consensus.approved', by: approverEmail, proposalId });
    return this.execute(redemptionId, { operatorEmail: approverEmail });
  }

  static async get(redemptionId) {
    await this.ensureTables();
    const rows = await withFallback(async () => (await query(`SELECT * FROM dapp_redemptions WHERE id = $1`, [redemptionId])).rows, () => []);
    if (!rows.length) throw new Error('Redemption not found');
    return rows[0];
  }

  static async list({ limit = 50 } = {}) {
    await this.ensureTables();
    return withFallback(async () => {
      const rows = await query('SELECT * FROM dapp_redemptions ORDER BY created_at DESC LIMIT $1', [limit]);
      return rows.rows;
    }, () => []);
  }

  static async cancel(redemptionId) {
    await this.ensureTables();
    await this._update(redemptionId, { status: 'cancelled', stage: 'cancelled' });
    await this._appendAudit(redemptionId, { action: 'cancelled' });
    return this.get(redemptionId);
  }
}

module.exports = { RedemptionEngine };
