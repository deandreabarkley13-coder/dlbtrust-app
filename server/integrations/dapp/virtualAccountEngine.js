'use strict';

/**
 * Virtual Account Engine
 *
 * Creates ledger-backed virtual accounts (VA-*) for beneficiaries, payees and
 * internal pools. Each account gets a unique account number, can be funded from
 * any trust/cash source, and pays out through PayoutCenterEngine rails while
 * staying reconciled to on-chain token balances.
 */

const fs = require('fs');
const path = require('path');
const { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');

let PayoutCenterEngine;
try { ({ PayoutCenterEngine } = require('./payoutCenterEngine')); } catch (e) { }

let SovereignTrustEngine;
try { ({ SovereignTrustEngine } = require('./sovereignTrustEngine')); } catch (e) { }

function dataDir() {
  if (process.env.PERSISTENT_DATA_DIR && fs.existsSync(process.env.PERSISTENT_DATA_DIR)) return process.env.PERSISTENT_DATA_DIR;
  if (fs.existsSync('/data')) return '/data';
  return path.join(process.cwd(), 'data');
}

function statePath() { return path.join(dataDir(), 'virtual-accounts-state.json'); }

function ensureDir() {
  const dir = dataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadState() {
  ensureDir();
  try { if (fs.existsSync(statePath())) return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch (e) { console.warn('[VirtualAccountEngine] load state failed:', e.message); }
  return { accounts: [], transactions: [] };
}

function saveState(state) {
  ensureDir();
  try { fs.writeFileSync(statePath(), JSON.stringify(state, null, 2)); } catch (e) { console.warn('[VirtualAccountEngine] save state failed:', e.message); }
}

function id(prefix = 'VA') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }

function accountNumber() {
  const n = Math.floor(10000000 + Math.random() * 89999999);
  return `VA-${n}`;
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function now() { return new Date().toISOString(); }

class VirtualAccountEngine {
  static listAccounts({ status, type, ownerId, limit = 100 } = {}) {
    const state = loadState();
    let accounts = state.accounts || [];
    if (status) accounts = accounts.filter(a => a.status === status);
    if (type) accounts = accounts.filter(a => a.type === type);
    if (ownerId) accounts = accounts.filter(a => a.ownerId === ownerId);
    return accounts.slice(0, Number(limit) || 100);
  }

  static getAccount(accountId) {
    const state = loadState();
    const acct = (state.accounts || []).find(a => a.id === accountId || a.accountNumber === accountId);
    if (!acct) return null;
    return acct;
  }

  static async getAccountWithBalance(accountId) {
    const acct = this.getAccount(accountId);
    if (!acct) return null;
    const trust = await TrustAccountingEngine.getAccount(acct.accountCode);
    acct.balance = round2(trust ? (trust.balance || 0) : 0);
    return acct;
  }

  static async listSourceAccounts() {
    const accounts = await TrustAccountingEngine.listAccounts({ isActive: true });
    return accounts.filter(a => ['asset', 'liability', 'equity', 'cash'].includes(a.account_type) || a.account_type === 'cash');
  }

  static async createAccount({
    name,
    email,
    type = 'spending',
    ownerId,
    initialDeposit = 0,
    sourceType,
    sourceAccountId,
    description,
    createdBy = 'operator',
  } = {}) {
    if (!name) throw new Error('name is required');
    const deposit = round2(initialDeposit);
    if (deposit > 0 && (!sourceType || !sourceAccountId)) throw new Error('sourceType and sourceAccountId required for initial deposit');

    const vaId = id('VA');
    const accountCode = `VA-${Date.now()}`;
    const acctNum = accountNumber();

    await TrustAccountingEngine.createAccount({
      accountCode,
      accountName: `Virtual Account: ${name}`,
      accountType: 'asset',
      subType: 'cash',
      description: description || `Virtual account ${acctNum} for ${email || name}`,
    });

    const state = loadState();
    const account = {
      id: vaId,
      name,
      email: email || '',
      accountNumber: acctNum,
      accountCode,
      type,
      ownerId: ownerId || '',
      status: 'active',
      balance: 0,
      tokenBalance: 0,
      createdBy,
      createdAt: now(),
      updatedAt: now(),
    };

    if (deposit > 0) {
      await this._postJournal({
        accountCode,
        sourceType,
        sourceAccountId,
        amount: deposit,
        memo: `Initial deposit to virtual account ${acctNum}`,
        referenceId: vaId,
        createdBy,
      });
      account.balance = deposit;
      state.transactions.push({
        id: id('VATX'),
        type: 'deposit',
        virtualAccountId: vaId,
        amount: deposit,
        sourceType,
        sourceAccountId,
        createdBy,
        createdAt: now(),
      });
    }

    state.accounts = [account, ...(state.accounts || [])];
    saveState(state);
    return account;
  }

  static async fundAccount({ virtualAccountId, sourceType, sourceAccountId, amount, createdBy = 'operator' } = {}) {
    if (!virtualAccountId || !sourceType || !sourceAccountId || !amount) throw new Error('virtualAccountId, sourceType, sourceAccountId and amount required');
    const account = this.getAccount(virtualAccountId);
    if (!account) throw new Error(`Virtual account not found: ${virtualAccountId}`);
    if (account.status !== 'active') throw new Error(`Account ${account.status} cannot receive funds`);
    const amt = round2(amount);
    if (amt <= 0) throw new Error('amount must be positive');

    await this._postJournal({
      accountCode: account.accountCode,
      sourceType,
      sourceAccountId,
      amount: amt,
      memo: `Fund virtual account ${account.accountNumber}`,
      referenceId: account.id,
      createdBy,
    });

    const trust = await TrustAccountingEngine.getAccount(account.accountCode);
    account.balance = round2(trust ? (trust.balance || 0) : 0);
    account.updatedAt = now();

    const state = loadState();
    state.transactions.push({
      id: id('VATX'),
      type: 'deposit',
      virtualAccountId: account.id,
      amount: amt,
      sourceType,
      sourceAccountId,
      createdBy,
      createdAt: now(),
    });
    const idx = (state.accounts || []).findIndex(a => a.id === account.id);
    if (idx >= 0) state.accounts[idx] = account;
    saveState(state);
    return account;
  }

  static async transfer({ fromId, toId, amount, createdBy = 'operator' } = {}) {
    if (!fromId || !toId || !amount) throw new Error('fromId, toId and amount required');
    const from = this.getAccount(fromId);
    const to = this.getAccount(toId);
    if (!from || !to) throw new Error('Virtual account not found');
    const amt = round2(amount);
    if (amt <= 0) throw new Error('amount must be positive');

    await TrustAccountingEngine.postJournalEntry({
      entryDate: new Date(),
      description: `Virtual account transfer ${from.accountNumber} → ${to.accountNumber}`,
      referenceType: 'virtual_transfer',
      referenceId: id('VATX'),
      postedBy: createdBy,
      postToFineract: false,
      lines: [
        { accountCode: from.accountCode, debitAmount: 0, creditAmount: amt, memo: `Transfer out to ${to.accountNumber}` },
        { accountCode: to.accountCode, debitAmount: amt, creditAmount: 0, memo: `Transfer in from ${from.accountNumber}` },
      ],
    });

    const state = loadState();
    const tx = {
      id: id('VATX'),
      type: 'transfer',
      fromVirtualAccountId: from.id,
      toVirtualAccountId: to.id,
      amount: amt,
      createdBy,
      createdAt: now(),
    };
    state.transactions.push(tx);
    const fromTrust = await TrustAccountingEngine.getAccount(from.accountCode);
    const toTrust = await TrustAccountingEngine.getAccount(to.accountCode);
    const fromIdx = (state.accounts || []).findIndex(a => a.id === from.id);
    const toIdx = (state.accounts || []).findIndex(a => a.id === to.id);
    if (fromIdx >= 0) state.accounts[fromIdx].balance = round2(fromTrust ? (fromTrust.balance || 0) : 0);
    if (fromIdx >= 0) state.accounts[fromIdx].updatedAt = now();
    if (toIdx >= 0) state.accounts[toIdx].balance = round2(toTrust ? (toTrust.balance || 0) : 0);
    if (toIdx >= 0) state.accounts[toIdx].updatedAt = now();
    saveState(state);
    return tx;
  }

  static async payout({
    virtualAccountId,
    amount,
    asset = 'SIT',
    recipientIdentifier,
    recipientType = 'external',
    rail = 'sit',
    railOptions = {},
    description,
    createdBy = 'operator',
  } = {}) {
    if (!virtualAccountId || !amount || !recipientIdentifier) throw new Error('virtualAccountId, amount and recipientIdentifier required');
    const account = await this.getAccountWithBalance(virtualAccountId);
    if (!account) throw new Error(`Virtual account not found: ${virtualAccountId}`);
    if (account.status !== 'active') throw new Error(`Account ${account.status} cannot pay out`);
    const amt = round2(amount);
    if (amt <= 0) throw new Error('amount must be positive');
    if (account.balance < amt) throw new Error(`Insufficient virtual account balance: ${account.balance} < ${amt}`);
    if (!PayoutCenterEngine) throw new Error('PayoutCenterEngine not available');

    const payment = await PayoutCenterEngine.createPayment({
      paymentType: 'payout',
      sourceType: 'trust',
      sourceAccountId: account.accountCode,
      recipientType,
      recipientIdentifier,
      amount: String(amt),
      asset: String(asset).toUpperCase(),
      description: description || `Virtual account payout ${account.accountNumber}`,
      rail,
      railOptions,
    });

    const updated = await this.getAccountWithBalance(virtualAccountId);
    const state = loadState();
    state.transactions.push({
      id: id('VATX'),
      type: 'payout',
      virtualAccountId: account.id,
      amount: amt,
      asset: String(asset).toUpperCase(),
      recipientIdentifier,
      rail,
      paymentId: payment && payment.id,
      txHash: payment && (payment.tx_hash || payment.txHash),
      createdBy,
      createdAt: now(),
    });
    const idx = (state.accounts || []).findIndex(a => a.id === account.id);
    if (idx >= 0) state.accounts[idx] = updated;
    saveState(state);
    return { account: updated, payment };
  }

  static async reconcileDeposit({ accountNumber, amount, reference, sourceType = 'cash', sourceAccountId, createdBy = 'operator' } = {}) {
    if (!accountNumber || !amount) throw new Error('accountNumber and amount required');
    const account = this.getAccount(accountNumber);
    if (!account) throw new Error(`Virtual account not found: ${accountNumber}`);
    if (!sourceAccountId) {
      const state = loadState();
      return { status: 'awaiting_funds', account, instructions: { accountNumber: account.accountNumber, reference: reference || account.id } };
    }
    const amt = round2(amount);
    if (amt <= 0) throw new Error('amount must be positive');

    await this._postJournal({
      accountCode: account.accountCode,
      sourceType,
      sourceAccountId,
      amount: amt,
      memo: `Reconciled external deposit ${reference || ''}`,
      referenceId: reference || account.id,
      createdBy,
    });

    const updated = await this.getAccountWithBalance(account.id);
    const state = loadState();
    state.transactions.push({
      id: id('VATX'),
      type: 'reconcile_deposit',
      virtualAccountId: account.id,
      amount: amt,
      sourceType,
      sourceAccountId,
      reference,
      createdBy,
      createdAt: now(),
    });
    const idx = (state.accounts || []).findIndex(a => a.id === account.id);
    if (idx >= 0) state.accounts[idx] = updated;
    saveState(state);
    return updated;
  }

  static listTransactions({ virtualAccountId, limit = 100 } = {}) {
    const state = loadState();
    let txs = state.transactions || [];
    if (virtualAccountId) txs = txs.filter(t => t.virtualAccountId === virtualAccountId || t.fromVirtualAccountId === virtualAccountId || t.toVirtualAccountId === virtualAccountId);
    return txs.slice(0, Number(limit) || 100);
  }

  static async syncTokenBalance(virtualAccountId) {
    const account = this.getAccount(virtualAccountId);
    if (!account) throw new Error(`Virtual account not found: ${virtualAccountId}`);
    if (!SovereignTrustEngine) return account;
    try {
      const token = await SovereignTrustEngine._loadToken();
      if (token && token.token_address) {
        const { publicClient } = (require('./sovereignTrustEngine')).walletClient ? (require('./sovereignTrustEngine')).walletClient() : { publicClient: null };
        if (publicClient) {
          const raw = await publicClient.readContract({
            address: token.token_address,
            abi: [{ type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
            functionName: 'balanceOf',
            args: [account.walletAddress || process.env.DAPP_OPERATOR_ADDRESS || ''],
          });
          const viem = require('viem');
          account.tokenBalance = Number(viem.formatUnits(raw, 6));
        }
      }
    } catch (e) { console.warn('[VirtualAccountEngine] token sync failed:', e.message); }
    return account;
  }

  static async _postJournal({ accountCode, sourceType, sourceAccountId, amount, memo, referenceId, createdBy }) {
    await TrustAccountingEngine.postJournalEntry({
      entryDate: new Date(),
      description: memo,
      referenceType: 'virtual_account',
      referenceId,
      postedBy: createdBy,
      postToFineract: false,
      lines: [
        { accountCode, debitAmount: amount, creditAmount: 0, memo: 'Credit virtual account' },
        { accountCode: sourceAccountId, debitAmount: 0, creditAmount: amount, memo: 'Fund virtual account' },
      ],
    });
  }
}

module.exports = { VirtualAccountEngine };
