'use strict';

/**
 * Payout Center Engine
 *
 * Single, simplified entry point for distributions, disbursements, expenses,
 * and DEX swaps. Connects source-of-funds ledgers to beneficiary, trustee,
 * and vendor wallets using SIT, stablecoin DEX, or fiat rails.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

let viem;
try { viem = require('viem'); } catch (e) { viem = null; }

function getDappEngine() {
  try { return require('./dappEngine').DappEngine; } catch (e) { return null; }
}

let SovereignTrustEngine;
try { ({ SovereignTrustEngine } = require('./sovereignTrustEngine')); } catch (e) { SovereignTrustEngine = null; }

let StablecoinDexEngine;
try { ({ StablecoinDexEngine } = require('./stablecoinDexEngine')); } catch (e) { StablecoinDexEngine = null; }

let CashAppEngine;
try { ({ CashAppEngine } = require('./cashAppEngine')); } catch (e) { CashAppEngine = null; }

let ModuleFundingEngine;
try { ({ ModuleFundingEngine } = require('./moduleFundingEngine')); } catch (e) { ModuleFundingEngine = null; }

let BtcPayEngine;
try { ({ BtcPayEngine } = require('../payments/btcPayEngine')); } catch (e) { BtcPayEngine = null; }

function id(prefix = 'PAY') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }
function isAddress(v) { return viem && viem.isAddress && viem.isAddress(v); }
function safeJson(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v); }

async function query(sql, params) {
  if (!pool || !pool.query) throw new Error('Postgres pool unavailable');
  return pool.query(sql, params);
}

async function withFallback(fn, fallback) {
  try { return await fn(); } catch (e) { if (!pool) return fallback(e); throw e; }
}

class PayoutCenterEngine {
  static async ensureTables() {
    await withFallback(async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS dapp_payout_center (
          id TEXT PRIMARY KEY,
          payment_type TEXT NOT NULL DEFAULT 'payout',
          source_type TEXT,
          source_account_id TEXT,
          recipient_type TEXT,
          recipient_email TEXT,
          recipient_address TEXT,
          amount_usd TEXT,
          asset TEXT,
          rail TEXT,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          tx_hash TEXT,
          tx_data JSONB DEFAULT '{}',
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    }, () => {});
  }

  static async listRecipients({ role } = {}) {
    const DappEngine = getDappEngine();
    if (!DappEngine) throw new Error('DappEngine not available');
    const users = await DappEngine.listUsers();
    return users
      .filter(u => {
        if (!role || role === 'all') return true;
        const roles = Array.isArray(u.roles) ? u.roles : (u.roles ? JSON.parse(u.roles) : [u.role]);
        return roles.includes(role) || u.role === role;
      })
      .map(u => ({ id: u.id, email: u.email, name: u.name, role: u.role, roles: u.roles, walletAddress: u.wallet_address }));
  }

  static isBtcAddress(v) {
    if (typeof v !== 'string' || !v.trim()) return false;
    let addr = v.trim();
    if (addr.toLowerCase().startsWith('bitcoin:')) {
      try {
        const u = new URL(addr);
        addr = u.pathname || u.hostname;
      } catch { return false; }
    }
    return /^[13][a-zA-Z0-9]{25,34}$/.test(addr) || /^(bc1|BC1)[a-zA-Z0-9]{11,71}$/.test(addr);
  }

  static async resolveRecipient({ recipientType, identifier, asset = '' } = {}) {
    const upper = String(asset).toUpperCase();
    if (isAddress(identifier)) return { address: viem.getAddress ? viem.getAddress(identifier) : identifier.toLowerCase(), type: 'address' };
    if (upper === 'BTC' && this.isBtcAddress(identifier)) {
      let addr = identifier.trim();
      if (addr.toLowerCase().startsWith('bitcoin:')) {
        const u = new URL(addr);
        addr = u.pathname || u.hostname;
      }
      return { address: addr, type: 'btc_address' };
    }
    const DappEngine = getDappEngine();
    if (!DappEngine) throw new Error('Wallet address required or DappEngine not available');
    const user = await DappEngine.getUserByEmail(identifier).catch(() => null);
    if (!user) throw new Error(`Recipient not found for ${identifier}`);
    if (!user.wallet_address) throw new Error(`Recipient ${identifier} has no linked wallet`);
    return { address: user.wallet_address, type: 'user', user };
  }

  static async createPayment({ paymentType = 'payout', sourceType, sourceAccountId, recipientType, recipientIdentifier, amount, asset = 'SIT', description, rail, railOptions = {} } = {}) {
    await this.ensureTables();
    if (!sourceType || !sourceAccountId) throw new Error('sourceType and sourceAccountId required');
    if (!recipientIdentifier) throw new Error('recipientIdentifier required');
    if (!amount || Number(amount) <= 0) throw new Error('amount must be positive');

    const recipient = await this.resolveRecipient({ recipientType, identifier: recipientIdentifier, asset });
    const chosenRail = (rail || 'sit').toLowerCase();
    const recordId = id('PC');
    const base = {
      id: recordId,
      payment_type: paymentType,
      source_type: sourceType,
      source_account_id: sourceAccountId,
      recipient_type: recipientType || 'external',
      recipient_email: recipient.user ? recipient.user.email : null,
      recipient_address: recipient.address,
      amount_usd: String(amount),
      asset: asset.toUpperCase(),
      rail: rail || 'sit',
      description: description || `${paymentType} to ${recipient.address}`,
      status: 'pending',
      tx_hash: null,
      tx_data: {},
      metadata: { railOptions },
    };

    await withFallback(async () => {
      const keys = Object.keys(base).filter(k => base[k] !== undefined);
      const cols = keys.join(',');
      const vals = keys.map((_, i) => `$${i + 1}`).join(',');
      await query(`INSERT INTO dapp_payout_center (${cols}) VALUES (${vals})`, keys.map(k => (k === 'tx_data' || k === 'metadata') ? safeJson(base[k]) : base[k]));
    }, () => {});

    let result = null;
    // Reuse the latest valid DEX pool for this asset to avoid paying creation gas each time.
    if (chosenRail === 'dex' && !railOptions.poolAddress) {
      const latest = await this.getLatestPoolAddress(asset);
      if (latest) railOptions.poolAddress = latest;
    }

    switch (chosenRail) {
      case 'sit':
      case 'sovereign': {
        if (!SovereignTrustEngine) throw new Error('SovereignTrustEngine not available');
        result = await SovereignTrustEngine.mintFromSource({
          sourceType,
          sourceAccountId,
          to: recipient.address,
          amount,
          memo: description,
        });
        base.tx_hash = result.tx;
        base.status = result.tx ? 'completed' : 'pending';
        break;
      }
      case 'dex':
      case 'stablecoin_dex': {
        if (!StablecoinDexEngine) throw new Error('StablecoinDexEngine not available');
        const seed = railOptions.createPoolIfMissing ? { createPoolIfMissing: true, poolSeedUsdc: railOptions.poolSeedUsdc || 0.005, poolSeedDlbusd: railOptions.poolSeedDlbusd || 10 } : {};
        result = await StablecoinDexEngine.depositAndSwap({
          sourceType,
          sourceAccountId,
          amount,
          targetAsset: asset.toUpperCase(),
          recipient: recipient.address,
          poolAddress: railOptions.poolAddress,
          ...seed,
        });
        base.tx_hash = result.swap && result.swap.txHash;
        base.status = (result.swap && result.swap.mode === 'live' && result.swap.txHash) ? 'completed' : 'pending';
        break;
      }
      case 'cashapp':
      case 'cash': {
        if (!CashAppEngine) throw new Error('CashAppEngine not available');
        result = await CashAppEngine.requestPayment({
          amountUsd: amount,
          recipientTag: railOptions.cashtag,
          walletAddress: recipient.address,
          memo: description,
          direction: railOptions.direction || 'pull',
        });
        base.tx_hash = result && result.paymentId;
        base.status = 'awaiting_sender';
        break;
      }
      case 'fund_rail':
      case 'module': {
        if (!ModuleFundingEngine) throw new Error('ModuleFundingEngine not available');
        result = await ModuleFundingEngine.fundExternalRail({
          sourceType,
          sourceAccountId,
          rail: railOptions.rail || 'stablecoin_dex',
          amount,
          memo: description,
          railOptions: { targetAsset: asset, recipient: recipient.address, ...railOptions },
        });
        base.tx_hash = result && (result.fundingId || result.txHash);
        base.status = 'completed';
        break;
      }
      case 'btcpay': {
        if (!BtcPayEngine || !BtcPayEngine.isConfigured()) throw new Error('BTCPay engine not configured');
        result = await BtcPayEngine.payoutBtc({
          destination: recipient.address,
          amountUsd: amount,
          description,
          memo: description,
          autoApprove: true,
        });
        base.tx_hash = result.payoutId;
        base.status = 'awaiting_payment';
        break;
      }
      default:
        throw new Error(`Unsupported rail: ${rail}`);
    }

    base.tx_data = result || {};
    base.updated_at = new Date().toISOString();
    await withFallback(async () => {
      await query(`UPDATE dapp_payout_center SET status = $1, tx_hash = $2, tx_data = $3, updated_at = NOW() WHERE id = $4`,
        [base.status, base.tx_hash, safeJson(base.tx_data), base.id]);
    }, () => {});

    return { ...base, result };
  }

  static async getLatestPoolAddress(asset) {
    await this.ensureTables();
    return withFallback(async () => {
      const rows = await query(
        `SELECT tx_data->>'poolAddress' AS pool FROM dapp_payout_center
         WHERE rail = 'dex' AND asset = $1 AND tx_data->>'poolAddress' IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
        [asset.toUpperCase()]
      );
      return rows.rows[0] ? rows.rows[0].pool : null;
    }, () => null);
  }

  static async listPayments({ limit = 50 } = {}) {
    await this.ensureTables();
    return withFallback(async () => {
      const rows = await query('SELECT * FROM dapp_payout_center ORDER BY created_at DESC LIMIT $1', [limit]);
      return rows.rows;
    }, () => []);
  }
}

module.exports = { PayoutCenterEngine };
