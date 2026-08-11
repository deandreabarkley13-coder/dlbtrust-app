'use strict';

/**
 * WalletVirtualAccountEngine
 *
 * Gives every wallet a virtual account number (VA-*) so wallets can easily
 * transact with external merchants, vendors, and other wallets. A virtual
 * account is a wallet + an account number + an optional external counterparty
 * (merchant/vendor address). The engine handles funding from ledger sources,
 * outbound crypto payments, inbound deposit recording, and wallet-to-wallet
 * transfers.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const { getConfig } = require('./config');

let WalletEngine, WalletCreationEngine, VendorEngine, Web3Engine, PaymentBlockchainEngine, TrustAccountingEngine;
function loadDeps() {
  try { ({ WalletEngine } = require('./walletEngine')); } catch (e) { WalletEngine = null; }
  try { ({ WalletCreationEngine } = require('./walletCreationEngine')); } catch (e) { WalletCreationEngine = null; }
  try { ({ VendorEngine } = require('../vendors/vendorEngine')); } catch (e) { VendorEngine = null; }
  try { ({ Web3Engine } = require('./web3Engine')); } catch (e) { Web3Engine = null; }
  try { ({ PaymentBlockchainEngine } = require('./paymentBlockchainEngine')); } catch (e) { PaymentBlockchainEngine = null; }
  try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) { TrustAccountingEngine = null; }
}

function id(prefix = 'WVA') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }
function accountNumber() {
  const n = Math.floor(10000000 + Math.random() * 89999999);
  return `VA-${n}`;
}
function toCents(amount, asset = '') {
  const decimals = asset.toUpperCase() === 'ETH' || asset.toUpperCase() === 'WETH' || asset.toUpperCase() === 'DAI' || asset.toUpperCase() === 'USDS' ? 18 : 6;
  return Math.round((Number(amount) || 0) * (decimals === 18 ? 1e18 : 1e6));
}
function fromCents(cents, asset = '') {
  const decimals = asset.toUpperCase() === 'ETH' || asset.toUpperCase() === 'WETH' || asset.toUpperCase() === 'DAI' || asset.toUpperCase() === 'USDS' ? 18 : 6;
  return (Number(cents) / (decimals === 18 ? 1e18 : 1e6)).toFixed(decimals === 18 ? 18 : 6).replace(/\.?0+$/, '');
}
function safeJson(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v); }

async function query(sql, params) {
  if (!pool || !pool.query) throw new Error('Postgres pool unavailable');
  return pool.query(sql, params);
}

class WalletVirtualAccountEngine {
  static async ensureTables() {
    if (!pool) return;
    await query(`
      CREATE TABLE IF NOT EXISTS wallet_virtual_accounts (
        id TEXT PRIMARY KEY,
        account_number TEXT UNIQUE NOT NULL,
        wallet_id TEXT,
        name TEXT NOT NULL,
        email TEXT,
        owner_type TEXT NOT NULL DEFAULT 'wallet' CHECK (owner_type IN ('wallet','merchant','vendor','external')),
        owner_id TEXT,
        owner_address TEXT,
        asset TEXT NOT NULL DEFAULT 'SIT',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','closed')),
        metadata JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_wallet_virtual_accounts_wallet ON wallet_virtual_accounts(wallet_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_wallet_virtual_accounts_number ON wallet_virtual_accounts(account_number)`);

    await query(`
      CREATE TABLE IF NOT EXISTS wallet_virtual_account_transactions (
        tx_id TEXT PRIMARY KEY,
        virtual_account_id TEXT NOT NULL REFERENCES wallet_virtual_accounts(id),
        direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound','transfer')),
        asset TEXT NOT NULL,
        amount_cents BIGINT NOT NULL,
        counterparty TEXT,
        counterparty_type TEXT,
        tx_hash TEXT,
        status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending','completed','failed')),
        memo TEXT,
        metadata JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_wva_tx_account ON wallet_virtual_account_transactions(virtual_account_id)`);
  }

  static _rowToObject(row) {
    if (!row) return null;
    const out = { ...row, amount: row.amount_cents !== undefined ? fromCents(row.amount_cents, row.asset) : undefined };
    return out;
  }

  static async _ensureWallet({ walletId, userEmail, name }) {
    loadDeps();
    if (walletId) {
      const wallet = await WalletEngine.getWallet(walletId);
      if (wallet) return wallet;
    }
    if (WalletCreationEngine) {
      return WalletCreationEngine.createWallet({
        email: userEmail || `va-${Date.now()}@dlbtrust.local`,
        name: name || 'Virtual Account Wallet',
        type: 'internal',
        subtype: 'virtual_account',
      });
    }
    throw new Error('No walletId provided and WalletCreationEngine unavailable');
  }

  static async _resolveVendorAddress(ownerId) {
    loadDeps();
    if (!VendorEngine || !ownerId) return null;
    const vendor = await VendorEngine.getVendor(ownerId).catch(() => null);
    if (!vendor) return null;
    return vendor.crypto_address || vendor.wallet_address || vendor.blockchain_address || null;
  }

  static async createVirtualAccount({
    name, email, walletId, userEmail,
    ownerType = 'wallet', ownerId, ownerAddress,
    asset = 'SIT', status = 'active', metadata = {},
    createWallet = true,
  } = {}) {
    loadDeps();
    await this.ensureTables();
    if (!name) throw new Error('name is required');

    let resolvedAddress = ownerAddress;
    if (!resolvedAddress && (ownerType === 'vendor' || ownerType === 'merchant')) {
      resolvedAddress = await this._resolveVendorAddress(ownerId);
    }

    const wallet = await this._ensureWallet({ walletId, userEmail: email || userEmail, name });

    const accountId = id();
    const number = accountNumber();
    const meta = { ...metadata, ownerAddress: resolvedAddress };
    await query(`
      INSERT INTO wallet_virtual_accounts (id, account_number, wallet_id, name, email, owner_type, owner_id, owner_address, asset, status, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
    `, [accountId, number, wallet.id, name, email || null, ownerType, ownerId || null, resolvedAddress, asset.toUpperCase(), status, safeJson(meta)]);

    return { ...await this.getVirtualAccount(accountId), wallet };
  }

  static async getVirtualAccount(id) {
    loadDeps();
    await this.ensureTables();
    const res = await query('SELECT * FROM wallet_virtual_accounts WHERE id = $1', [id]);
    return this._rowToObject(res.rows[0]);
  }

  static async getVirtualAccountByNumber(accountNumber) {
    loadDeps();
    await this.ensureTables();
    const res = await query('SELECT * FROM wallet_virtual_accounts WHERE account_number = $1', [accountNumber]);
    return this._rowToObject(res.rows[0]);
  }

  static async listVirtualAccounts({ ownerType, status, limit = 50, offset = 0 } = {}) {
    loadDeps();
    await this.ensureTables();
    const conditions = []; const params = []; let idx = 1;
    if (ownerType) { conditions.push(`owner_type = $${idx++}`); params.push(ownerType); }
    if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Math.min(limit, 200), offset);
    const res = await query(`SELECT * FROM wallet_virtual_accounts ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`, params);
    return res.rows.map(r => this._rowToObject(r));
  }

  static async getBalance(virtualAccountId) {
    loadDeps();
    const acct = await this.getVirtualAccount(virtualAccountId);
    if (!acct) throw new Error('Virtual account not found');
    const walletBalance = await WalletEngine.getBalance(acct.wallet_id, acct.asset).catch(() => ({ [acct.asset]: '0' }));
    const onChain = await Web3Engine.getBalances({ address: await this._getWalletAddress(acct.wallet_id) }).catch(() => null);
    const tokenKey = acct.asset.toLowerCase();
    return {
      virtualAccountId,
      accountNumber: acct.account_number,
      asset: acct.asset,
      internal: walletBalance && walletBalance[acct.asset] ? walletBalance[acct.asset] : walletBalance,
      onChain: onChain && onChain[tokenKey] ? onChain[tokenKey].formatted : '0',
    };
  }

  static async _getWalletAddress(walletId) {
    loadDeps();
    const wallet = await WalletEngine.getWallet(walletId);
    return wallet ? wallet.address : '';
  }

  static async _recordTx({ virtualAccountId, direction, asset, amount, counterparty, counterpartyType, txHash, status = 'completed', memo, metadata = {} }) {
    const txId = id('WVATX');
    const cents = toCents(amount, asset);
    await query(`
      INSERT INTO wallet_virtual_account_transactions (tx_id, virtual_account_id, direction, asset, amount_cents, counterparty, counterparty_type, tx_hash, status, memo, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
    `, [txId, virtualAccountId, direction, asset.toUpperCase(), cents, counterparty || null, counterpartyType || null, txHash || null, status, memo || null, safeJson(metadata)]);
    return txId;
  }

  static async fundAccount({ virtualAccountId, sourceType, sourceAccountId, amount, memo } = {}) {
    loadDeps();
    await this.ensureTables();
    const acct = await this.getVirtualAccount(virtualAccountId);
    if (!acct) throw new Error('Virtual account not found');
    if (!sourceType || !sourceAccountId || !amount) throw new Error('sourceType, sourceAccountId and amount required');

    let result;
    if (acct.asset.toUpperCase() === 'SIT') {
      result = await WalletEngine.fundWallet({ walletId: acct.wallet_id, amount, asset: 'SIT', sourceType, sourceAccountId, memo: memo || `Fund VA ${acct.account_number}` });
    } else {
      await WalletEngine.credit(acct.wallet_id, acct.asset, amount, { memo: memo || `Credit VA ${acct.account_number}` });
      result = { walletId: acct.wallet_id, amount, asset: acct.asset };
    }
    const txId = await this._recordTx({ virtualAccountId, direction: 'inbound', asset: acct.asset, amount, counterparty: sourceAccountId, counterpartyType: 'ledger', memo: memo || `Fund from ${sourceType}:${sourceAccountId}` });
    return { virtualAccountId, txId, ...result };
  }

  static async payExternal({ virtualAccountId, toAddress, amount, memo } = {}) {
    loadDeps();
    await this.ensureTables();
    const acct = await this.getVirtualAccount(virtualAccountId);
    if (!acct) throw new Error('Virtual account not found');
    if (!toAddress || !amount) throw new Error('toAddress and amount required');
    const result = await WalletEngine.transfer({ fromWalletId: acct.wallet_id, toAddress, amount, asset: acct.asset, memo: memo || `VA ${acct.account_number} payout` });
    const txId = await this._recordTx({ virtualAccountId, direction: 'outbound', asset: acct.asset, amount, counterparty: toAddress, counterpartyType: 'external', txHash: result.txHash, memo: memo || `Pay external ${toAddress}` });
    return { virtualAccountId, txId, ...result };
  }

  static async payVendor({ virtualAccountId, vendorId, amount, memo } = {}) {
    loadDeps();
    await this.ensureTables();
    if (!VendorEngine) throw new Error('VendorEngine not available');
    const acct = await this.getVirtualAccount(virtualAccountId);
    if (!acct) throw new Error('Virtual account not found');
    const vendor = await VendorEngine.getVendor(vendorId);
    if (!vendor) throw new Error('Vendor not found');
    const address = vendor.crypto_address || vendor.wallet_address || vendor.blockchain_address;
    if (address) {
      return this.payExternal({ virtualAccountId, toAddress: address, amount, memo: memo || `Pay vendor ${vendor.name}` });
    }
    const payment = await VendorEngine.initiatePayment({
      vendor_id: vendorId,
      amount,
      source_type: 'virtual_account',
      source_account_id: acct.id,
      reference: acct.account_number,
      description: memo || `Virtual account payment for ${acct.name}`,
    });
    const txId = await this._recordTx({ virtualAccountId, direction: 'outbound', asset: acct.asset, amount, counterparty: vendorId, counterpartyType: 'vendor', memo: memo || `Vendor payment ${vendorId}` });
    return { virtualAccountId, txId, vendorPaymentId: payment.payment_id, status: 'pending' };
  }

  static async receivePayment({ virtualAccountId, fromAddress, amount, txHash, memo } = {}) {
    loadDeps();
    await this.ensureTables();
    const acct = await this.getVirtualAccount(virtualAccountId);
    if (!acct) throw new Error('Virtual account not found');
    if (!amount) throw new Error('amount required');
    await WalletEngine.credit(acct.wallet_id, acct.asset, amount, { memo: memo || `Inbound to VA ${acct.account_number}`, tx_hash: txHash });
    const txId = await this._recordTx({ virtualAccountId, direction: 'inbound', asset: acct.asset, amount, counterparty: fromAddress, counterpartyType: 'external', txHash, memo: memo || `Receive from ${fromAddress}` });
    return { virtualAccountId, txId, amount, asset: acct.asset };
  }

  static async transferToVirtualAccount({ fromVirtualAccountId, toVirtualAccountId, amount, memo } = {}) {
    loadDeps();
    await this.ensureTables();
    const from = await this.getVirtualAccount(fromVirtualAccountId);
    const to = await this.getVirtualAccount(toVirtualAccountId);
    if (!from || !to) throw new Error('Virtual account not found');
    const result = await WalletEngine.transfer({ fromWalletId: from.wallet_id, toWalletId: to.wallet_id, amount, asset: from.asset, memo: memo || `VA ${from.account_number} -> ${to.account_number}` });
    const txId = await this._recordTx({ virtualAccountId: fromVirtualAccountId, direction: 'transfer', asset: from.asset, amount, counterparty: to.account_number, counterpartyType: 'virtual_account', txHash: result.txHash, memo: memo || `Transfer to ${to.account_number}` });
    return { fromVirtualAccountId, toVirtualAccountId, txId, ...result };
  }

  static async getTransactions(virtualAccountId, { limit = 50 } = {}) {
    loadDeps();
    await this.ensureTables();
    const res = await query('SELECT * FROM wallet_virtual_account_transactions WHERE virtual_account_id = $1 ORDER BY created_at DESC LIMIT $2', [virtualAccountId, Math.min(limit, 200)]);
    return res.rows.map(r => this._rowToObject(r));
  }

  static async closeVirtualAccount(virtualAccountId) {
    loadDeps();
    await this.ensureTables();
    await query(`UPDATE wallet_virtual_accounts SET status='closed', updated_at=NOW() WHERE id=$1`, [virtualAccountId]);
    return this.getVirtualAccount(virtualAccountId);
  }

  static async getInfo() {
    loadDeps();
    return {
      networks: ['internal', 'blockchain', 'vendor'],
      walletReady: !!WalletEngine,
      walletCreationReady: !!WalletCreationEngine,
      vendorReady: !!VendorEngine,
      web3Ready: !!Web3Engine,
    };
  }
}

module.exports = { WalletVirtualAccountEngine };
