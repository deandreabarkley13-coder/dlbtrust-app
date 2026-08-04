'use strict';

/**
 * WalletFundingEngine
 *
 * Funds every trustee/beneficiary wallet from matched source-of-funds ledger
 * balances (core banking, trust accounting, sub-ledger, cash, bond) and posts a
 * double-entry Trust Accounting journal for compliance.
 */

const { WalletEngine } = require('./walletEngine');
const { SourceOfFundsAdapter } = require('../stablecoin/sourceOfFundsAdapter');
const { getConfig } = require('./config');

let DappEngine, TrustAccountingEngine, CrmEngine;
function getDappEngine() { try { return require('./dappEngine').DappEngine; } catch (e) { return null; } }
function getTrustEngine() { try { return require('../accounting/trustAccountingEngine').TrustAccountingEngine; } catch (e) { return null; } }
function getCrmEngine() { try { return require('../crm/crmEngine').CrmEngine; } catch (e) { return null; } }

const WALLET_FUNDS_CODE = 'WALLET-FUNDS';
const WALLET_ALLOCATIONS_CODE = 'WALLET-ALLOCATIONS';

function toCents(amount) { return Math.round((Number(amount) || 0) * 100); }
function fromCents(cents) { return (Number(cents) || 0) / 100; }
function id(prefix = 'WFE') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();
}

function tokens(text) {
  return normalize(text).split(/\s+/).filter(Boolean);
}

const STOPWORDS = new Set(['trust', 'account', 'accounts', 'cash', 'bank', 'beneficiary', 'reserve', 'operating', 'corpus', 'distribution', 'investment', 'accrued', 'interest', 'fund', 'funds', 'savings', 'checking', 'ledger', 'income', 'asset', 'liability', 'equity', 'revenue', 'expense']);

class WalletFundingEngine {
  static _lazyLoad() {
    DappEngine = DappEngine || getDappEngine();
    TrustAccountingEngine = TrustAccountingEngine || getTrustEngine();
    CrmEngine = CrmEngine || getCrmEngine();
  }

  static async ensureAccounts() {
    this._lazyLoad();
    if (!TrustAccountingEngine) return;
    const accounts = [
      { code: WALLET_FUNDS_CODE, name: 'Wallet Funds — Beneficiary Holdings', type: 'asset', subType: 'wallet' },
      { code: WALLET_ALLOCATIONS_CODE, name: 'Wallet Allocations — Beneficiary Obligations', type: 'liability', subType: 'wallet' },
    ];
    for (const a of accounts) {
      try {
        const existing = await TrustAccountingEngine.getAccount(a.code);
        if (!existing) {
          await TrustAccountingEngine.createAccount({
            accountCode: a.code,
            accountName: a.name,
            accountType: a.type,
            subType: a.subType,
            description: 'Auto-created by WalletFundingEngine for compliant wallet funding',
          });
        }
      } catch (e) {
        console.warn('[WalletFundingEngine] ensureAccounts:', e.message);
      }
    }
  }

  static async listContacts() {
    this._lazyLoad();
    if (!CrmEngine || !CrmEngine.listContacts) return [];
    try { return await CrmEngine.listContacts({ status: 'active' }); } catch (e) { return []; }
  }

  static _sourceName(source) {
    return source.name || source.account_name || `Source ${source.type} ${source.id}`;
  }

  static _matchesUser(source, user, contacts) {
    if (!user) return false;
    const sourceName = normalize(this._sourceName(source));
    const sourceTokens = tokens(sourceName);
    const userName = normalize(user.name);
    const userEmail = String(user.email || '').toLowerCase();
    const userLocal = userEmail.split('@')[0];

    // Direct email match on CRM/sub-ledger contact
    if (source.contact_id && contacts && contacts.length) {
      const contact = contacts.find(c => String(c.contact_id) === String(source.contact_id));
      if (contact && contact.email) {
        if (contact.email.toLowerCase() === userEmail) return true;
      }
    }

    // Fineract client id match (if stored in user metadata)
    if (source.type === 'core_banking' && source.meta && source.meta.clientId && user.metadata && user.metadata.fineract_client_id) {
      if (String(source.meta.clientId) === String(user.metadata.fineract_client_id)) return true;
    }

    // Email local-part match (very specific)
    if (userLocal && userLocal.length > 2 && sourceName.includes(userLocal)) return true;

    // Full name substring match
    if (userName) {
      if (sourceName.includes(userName)) return true;

      // Require every meaningful name token to appear in the source name.
      const userParts = userName.split(/\s+/).filter(p => p.length > 1);
      if (userParts.length > 0 && userParts.every(p => sourceTokens.includes(p))) return true;
    }

    // Phone matching
    if (user.phone && sourceName.includes(String(user.phone).replace(/\D/g, ''))) return true;

    return false;
  }

  static async _allocationsForWallet(wallet, sourceBalances, contacts) {
    const user = wallet.user;
    if (!user || !user.email) return { sources: [], totalCents: 0, totalUsd: 0 };

    const matches = (sourceBalances || []).filter(s => {
      if (!s || Number(s.balance_cents || 0) <= 0) return false;
      if (['crm', 'treasury'].includes(s.type)) return false;
      return this._matchesUser(s, user, contacts);
    });

    const totalCents = matches.reduce((sum, s) => sum + (Number(s.balance_cents || 0)), 0);
    return {
      sources: matches.map(s => ({ type: s.type, id: s.id, name: this._sourceName(s), balance_cents: Number(s.balance_cents || 0) })),
      totalCents,
      totalUsd: fromCents(totalCents),
    };
  }

  static async preview() {
    this._lazyLoad();
    const wallets = await WalletEngine.listWallets();
    const sourceBalances = DappEngine && DappEngine.listSourceBalances ? await DappEngine.listSourceBalances() : [];
    const contacts = await this.listContacts();

    const results = [];
    for (const wallet of wallets) {
      const alloc = await this._allocationsForWallet(wallet, sourceBalances, contacts);
      if (alloc.totalCents > 0) {
        results.push({ walletId: wallet.id, userEmail: wallet.user && wallet.user.email, address: wallet.address, amount: alloc.totalUsd, sources: alloc.sources });
      }
    }
    return results;
  }

  static async fundAll({ asset = 'SIT', autoConvert = true, dryRun = false } = {}) {
    this._lazyLoad();
    if (!DappEngine || !DappEngine.listSourceBalances) throw new Error('DappEngine not available');

    await this.ensureAccounts();
    const wallets = await WalletEngine.listWallets();
    const sourceBalances = await DappEngine.listSourceBalances();
    const contacts = await this.listContacts();

    const cfg = getConfig();
    const reserveAccount = cfg.reserveAccount || 'SIT-RESERVE';
    const paymentIdBase = id('WFE');

    const results = [];
    let totalFundedCents = 0;

    for (const wallet of wallets) {
      const alloc = await this._allocationsForWallet(wallet, sourceBalances, contacts);
      if (alloc.totalCents <= 0) continue;

      totalFundedCents += alloc.totalCents;

      if (dryRun) {
        results.push({ walletId: wallet.id, userEmail: wallet.user && wallet.user.email, address: wallet.address, amount: alloc.totalUsd, sources: alloc.sources, dryRun: true });
        continue;
      }

      const sweepErrors = [];
      for (const source of alloc.sources) {
        try {
          await SourceOfFundsAdapter._fundSourceToTreasury({
            sourceType: source.type,
            sourceAccountId: source.id,
            paymentId: `${paymentIdBase}-${source.type}`,
            amountCents: source.balance_cents,
          });
        } catch (err) {
          console.warn(`[WalletFundingEngine] sweep failed for ${source.type} ${source.id}:`, err.message);
          sweepErrors.push({ type: source.type, id: source.id, error: err.message });
        }
      }

      let fundResult = null;
      let txHash = null;
      try {
        if (autoConvert && asset.toUpperCase() === 'SIT') {
          fundResult = await WalletEngine.fundWallet({
            walletId: wallet.id,
            amount: alloc.totalUsd,
            asset: 'SIT',
            sourceType: 'treasury',
            sourceAccountId: 'TREASURY_HOT',
            memo: `Wallet funding from ledgers (${alloc.sources.map(s => `${s.type}:${s.id}`).join(', ')})`,
          });
          txHash = fundResult && fundResult.mint && fundResult.mint.tx;
        } else {
          // Internal ledger credit only; caller can convert later.
          const cents = toCents(alloc.totalUsd);
          await WalletEngine._credit(wallet.id, asset, String(cents), { memo: `Wallet funding from ledgers` });
          fundResult = { walletId: wallet.id, amount: alloc.totalUsd, asset, credited: true };
        }
      } catch (err) {
        results.push({ walletId: wallet.id, address: wallet.address, amount: alloc.totalUsd, success: false, error: err.message, sweepErrors });
        continue;
      }

      // Compliance journal entry
      if (TrustAccountingEngine) {
        try {
          const assetCents = toCents(alloc.totalUsd);
          const amountDisplay = fromCents(assetCents);
          await TrustAccountingEngine.postJournalEntry({
            entryDate: new Date(),
            description: `Fund wallet ${wallet.id} from source-of-funds ledgers`,
            referenceType: 'wallet_funding',
            referenceId: wallet.id,
            postedBy: 'wallet-funding-engine',
            postToFineract: false,
            lines: [
              { accountCode: WALLET_FUNDS_CODE, debitAmount: amountDisplay, creditAmount: 0, memo: `Wallet ${wallet.id}` },
              { accountCode: WALLET_ALLOCATIONS_CODE, debitAmount: 0, creditAmount: amountDisplay, memo: `Obligation for wallet ${wallet.id}` },
            ],
          });
        } catch (jeErr) {
          console.warn('[WalletFundingEngine] trust accounting entry failed:', jeErr.message);
        }
      }

      results.push({ walletId: wallet.id, address: wallet.address, amount: alloc.totalUsd, asset, success: true, txHash, fundResult: !!fundResult, sweepErrors });
    }

    return { fundedWallets: results.length, totalUsd: fromCents(totalFundedCents), results };
  }
}

module.exports = { WalletFundingEngine };
