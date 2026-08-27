'use strict';

/**
 * Unified module funding and internal-transfer abstraction layer.
 *
 * Exposes Core Banking, Trust Accounting, Fixed Income / Bond, Sub-Ledger,
 * CRM, Tax and Document modules as a single funding surface.  Supports
 * internal transfers between like-module accounts and funding external
 * payment rails (Cash App, Google Wallet NFC, stablecoin/Safe, DEX) from
 * any source-of-funds ledger.
 */

const { SourceOfFundsAdapter } = require('../stablecoin/sourceOfFundsAdapter');
const { TreasuryEngine, DEFAULT_ACCOUNT } = require('../stablecoin/treasuryEngine');
const { getConfig } = require('./config');
const { getConfig: getStablecoinConfig } = require('../stablecoin/config');
const { CashAppEngine } = require('./cashAppEngine');
const { GoogleWalletEngine } = require('./googleWalletEngine');
const { StablecoinDexEngine } = require('./stablecoinDexEngine');
const { CoinbaseTreasuryBridge } = require('./coinbaseTreasuryBridge');

let CashEngine, TrustAccountingEngine, BondEngine, FineractClient, SubLedgerEngine, CrmEngine, TaxEngine, DocumentEngine;
try { CashEngine = require('../cash/cashEngine').CashEngine; } catch (e) { }
try { TrustAccountingEngine = require('../accounting/trustAccountingEngine').TrustAccountingEngine; } catch (e) { }
try { BondEngine = require('../bonds/bondEngine').BondEngine; } catch (e) { }
try { FineractClient = require('../fineract/fineractClient').FineractClient; } catch (e) { }
try { SubLedgerEngine = require('../accounting/subLedgerEngine').SubLedgerEngine; } catch (e) { }
try { CrmEngine = require('../crm/crmEngine').CrmEngine; } catch (e) { }
try { TaxEngine = require('../tax/taxEngine').TaxEngine; } catch (e) { }
try { DocumentEngine = require('../documents/documentEngine').DocumentEngine; } catch (e) { }

function toCents(amount) { return Math.round((Number(amount) || 0) * 100); }
function fromCents(cents) { return (Number(cents) || 0) / 100; }

class ModuleFundingEngine {
  static async getDappEngine() {
    try { return require('./dappEngine').DappEngine; } catch (e) { return null; }
  }

  static async listModules() {
    const DappEngine = await this.getDappEngine();
    if (!DappEngine || !DappEngine.listSourceBalances) return { groups: [] };
    const balances = await DappEngine.listSourceBalances();
    const groups = {};
    for (const b of balances) {
      const type = b.type || 'other';
      if (!groups[type]) groups[type] = { type, label: this._label(type), accounts: [] };
      groups[type].accounts.push(b);
    }
    return { groups: Object.values(groups) };
  }

  static _label(type) {
    const labels = {
      treasury: 'Treasury',
      cash: 'Cash Management',
      trust: 'Trust Accounting',
      bond: 'Bond / Fixed Income',
      core_banking: 'Core Banking',
      sub_ledger: 'Sub-Ledger',
      crm: 'CRM',
      tax: 'Tax',
      documents: 'Documents',
    };
    return labels[type] || type;
  }

  static async _assertTrustAssetDestination(accountId) {
    const account = await TrustAccountingEngine.getAccount(accountId);
    if (!account) throw new Error(`Trust account not found: ${accountId}`);
    if (account.is_active === false) throw new Error(`Trust destination account is inactive: ${accountId}`);
    if (String(account.account_type || '').toLowerCase() !== 'asset') {
      throw new Error(`Trust destination account must be an asset: ${accountId}`);
    }
    return account;
  }

  /**
   * Internal transfer between two accounts.  For same-type accounts the
   * engine's native transfer/journal API is used.  Cross-type transfers are
   * currently surfaced as funding-rail suggestions.
   */
  static async internalTransfer({ fromType, fromAccountId, toType, toAccountId, amount, memo } = {}) {
    if (!fromType || !toType || !fromAccountId || !toAccountId) throw new Error('fromType, fromAccountId, toType, and toAccountId are required');
    if (fromType === toType && fromAccountId === toAccountId) throw new Error('source and destination must be different');
    const amountCents = toCents(amount);
    if (amountCents <= 0) throw new Error('amount must be positive');

    const referenceId = `INT-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

    if (fromType === toType) {
      const result = await this._sameTypeTransfer({ type: fromType, fromAccountId, toAccountId, amountCents, memo, referenceId });
      return { success: true, transferId: referenceId, fromType, fromAccountId, toType, toAccountId, amount: fromCents(amountCents), result };
    }

    // Cross-type: sweep source into treasury (or debit treasury), then credit destination.
    let sweep;
    if (fromType === 'treasury') {
      sweep = await TreasuryEngine.debit(fromAccountId || DEFAULT_ACCOUNT, amountCents, { reason: memo || `Internal transfer ${referenceId}`, source: 'treasury' });
    } else {
      sweep = await SourceOfFundsAdapter._fundSourceToTreasury({
        sourceType: fromType, sourceAccountId: fromAccountId, paymentId: referenceId, amountCents,
      });
    }
    try {
      let credit;
      if (toType === 'treasury') {
        credit = await TreasuryEngine.credit(toAccountId || DEFAULT_ACCOUNT, amountCents, { source: 'internal_transfer', metadata: { referenceId, memo } });
      } else {
        credit = await this._creditSource({ type: toType, accountId: toAccountId, amountCents, memo, referenceId });
      }
      return { success: true, transferId: referenceId, fromType, fromAccountId, toType, toAccountId, amount: fromCents(amountCents), sweep, credit };
    } catch (err) {
      // Rollback sweep on failure
      try {
        if (fromType === 'treasury') {
          await TreasuryEngine.credit(fromAccountId || DEFAULT_ACCOUNT, amountCents, { source: 'internal_transfer_rollback', metadata: { referenceId, memo } });
        } else {
          await SourceOfFundsAdapter._refundSourceFromTreasury({
            sourceType: fromType, sourceAccountId: fromAccountId, payment: { id: referenceId, total_cents: amountCents }, sourceRef: sweep,
          });
        }
      } catch (e) { console.warn('[ModuleFundingEngine] rollback failed:', e.message); }
      throw err;
    }
  }

  static async _sameTypeTransfer({ type, fromAccountId, toAccountId, amountCents, memo, referenceId }) {
    const amount = fromCents(amountCents);
    switch (type) {
      case 'cash': {
        if (!CashEngine) throw new Error('CashEngine not available');
        return CashEngine.transfer({
          fromAccountId, toAccountId, amountCents, movementType: 'transfer',
          memo: memo || `Internal transfer ${referenceId}`,
          referenceId, referenceType: 'module_internal_transfer',
        });
      }
      case 'trust':
      case 'trust_account': {
        if (!TrustAccountingEngine) throw new Error('TrustAccountingEngine not available');
        await TrustAccountingEngine.assertFundingAvailable(fromAccountId, amountCents, {
          purpose: 'internal transfer',
        });
        await this._assertTrustAssetDestination(toAccountId);
        return TrustAccountingEngine.postJournalEntry({
          entryDate: new Date(),
          description: memo || `Internal transfer ${referenceId}`,
          referenceType: 'module_internal_transfer', referenceId,
          postedBy: 'module-funding-engine',
          postToFineract: false,
          lines: [
            { accountCode: toAccountId, debitAmount: amount, creditAmount: 0, memo: 'Transfer in' },
            { accountCode: fromAccountId, debitAmount: 0, creditAmount: amount, memo: 'Transfer out' },
          ],
        });
      }
      case 'sub_ledger': {
        if (!SubLedgerEngine) throw new Error('SubLedgerEngine not available');
        const debit = await SubLedgerEngine.postTransaction({
          subLedgerId: fromAccountId, transactionType: 'debit', amount,
          description: memo || `Internal transfer ${referenceId}`,
          referenceType: 'module_internal_transfer', referenceId, postedBy: 'module-funding-engine',
        });
        const credit = await SubLedgerEngine.postTransaction({
          subLedgerId: toAccountId, transactionType: 'credit', amount,
          description: memo || `Internal transfer ${referenceId}`,
          referenceType: 'module_internal_transfer', referenceId, postedBy: 'module-funding-engine',
        });
        return { debit, credit };
      }
      case 'fineract':
      case 'core_banking': {
        if (!FineractClient) throw new Error('FineractClient not available');
        const cfg = getConfig();
        const fromGl = Number(fromAccountId);
        const toGl = Number(toAccountId);
        if (!Number.isFinite(fromGl) || !Number.isFinite(toGl)) throw new Error('Core banking transfer requires GL account IDs');
        return FineractClient.postJournalEntry({
          officeId: 1, transactionDate: new Date(),
          comments: memo || `Internal transfer ${referenceId}`,
          debits: [{ glAccountId: fromGl, amount }],
          credits: [{ glAccountId: toGl, amount }],
        });
      }
      case 'bond':
      case 'fixed_income': {
        if (!BondEngine) throw new Error('BondEngine not available');
        const paid = await BondEngine.payPrincipal(Number(fromAccountId), amount, {});
        const received = await BondEngine.receivePrincipal(Number(toAccountId), amount, {});
        return { paid, received };
      }
      case 'treasury': {
        await TreasuryEngine.debit(fromAccountId || DEFAULT_ACCOUNT, amountCents, { reason: memo || `Internal transfer ${referenceId}`, source: 'treasury' });
        await TreasuryEngine.credit(toAccountId || DEFAULT_ACCOUNT, amountCents, { source: 'treasury', metadata: { referenceId } });
        return { debited: fromAccountId, credited: toAccountId };
      }
      default:
        throw new Error(`Internal transfer not supported for module type: ${type}`);
    }
  }

  static async _creditSource({ type, accountId, amountCents, memo, referenceId }) {
    const amount = fromCents(amountCents);
    const stablecoinCfg = getStablecoinConfig();
    switch (type) {
      case 'cash': {
        if (!CashEngine) throw new Error('CashEngine not available');
        return CashEngine.deposit({
          toAccountId: accountId, amountCents,
          memo: memo || `Credit from module funding ${referenceId}`,
          referenceId, initiatedBy: 'module-funding-engine',
        });
      }
      case 'trust':
      case 'trust_account': {
        if (!TrustAccountingEngine) throw new Error('TrustAccountingEngine not available');
        await this._assertTrustAssetDestination(accountId);
        const assetAccount = stablecoinCfg.stablecoinAssetAccount || '1210';
        return TrustAccountingEngine.postJournalEntry({
          entryDate: new Date(),
          description: memo || `Credit from treasury ${referenceId}`,
          referenceType: 'module_internal_transfer', referenceId,
          postedBy: 'module-funding-engine', postToFineract: false,
          lines: [
            { accountCode: accountId, debitAmount: amount, creditAmount: 0, memo: 'Credit from treasury' },
            { accountCode: assetAccount, debitAmount: 0, creditAmount: amount, memo: 'Treasury backing to trust' },
          ],
        });
      }
      case 'sub_ledger': {
        if (!SubLedgerEngine) throw new Error('SubLedgerEngine not available');
        return SubLedgerEngine.postTransaction({
          subLedgerId: accountId, transactionType: 'credit', amount,
          description: memo || `Credit from treasury ${referenceId}`,
          referenceType: 'module_internal_transfer', referenceId, postedBy: 'module-funding-engine',
        });
      }
      case 'fineract':
      case 'core_banking': {
        if (!FineractClient) throw new Error('FineractClient not available');
        const assetGlId = Number(stablecoinCfg.fineractStablecoinAssetGlId);
        const targetGlId = Number(accountId);
        if (!assetGlId || !Number.isFinite(targetGlId)) throw new Error('STABLECOIN_FINERACT_ASSET_GL_ID and target GL id required');
        return FineractClient.postJournalEntry({
          officeId: 1, transactionDate: new Date(),
          comments: memo || `Credit from treasury ${referenceId}`,
          debits: [{ glAccountId: assetGlId, amount }],
          credits: [{ glAccountId: targetGlId, amount }],
        });
      }
      case 'bond':
      case 'fixed_income': {
        if (!BondEngine) throw new Error('BondEngine not available');
        return BondEngine.receivePrincipal(Number(accountId), amount, {});
      }
      case 'treasury': {
        return TreasuryEngine.credit(accountId || DEFAULT_ACCOUNT, amountCents, { source: 'internal_transfer', metadata: { referenceId, memo } });
      }
      default:
        throw new Error(`Credit not supported for module type: ${type}`);
    }
  }

  static async _debitSourceForRail({ sourceType, sourceAccountId, amountCents, referenceId, memo }) {
    // Use the source-of-funds adapter to move source funds into the stablecoin treasury.
    return SourceOfFundsAdapter._fundSourceToTreasury({
      sourceType, sourceAccountId, paymentId: referenceId, amountCents,
    });
  }

  /**
   * Fund an external payment rail from a source-of-funds ledger.
   * Supported rails: cashapp, googlewallet, stablecoin_dex, coinbase_treasury, safe_payout.
   * Instrument rails (cashapp, googlewallet) reserve source funds and return a QR/pass.
   * Execution rails (stablecoin_dex, coinbase_treasury, safe_payout) pass the source
   * ledger to the underlying engine, which handles the debit and on-chain settlement.
   */
  static async fundExternalRail({ sourceType, sourceAccountId, rail, amount, memo, railOptions = {} } = {}) {
    if (!sourceType || !rail || !amount) throw new Error('sourceType, rail, and amount required');
    const amountCents = toCents(amount);
    if (amountCents <= 0) throw new Error('amount must be positive');
    const referenceId = `RAIL-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

    const instrumentRails = new Set(['cashapp', 'cashapp_fund_operator', 'googlewallet', 'google_wallet']);
    let reserve = null;
    let instrument;

    // Validate instrument prerequisites before debiting the source ledger.
    if (rail === 'cashapp' || rail === 'cashapp_fund_operator') {
      const tag = (railOptions.cashtag || railOptions.recipientTag || CashAppEngine.getConfig().cashtag || '').replace(/^\$/, '').trim();
      if (!tag) throw new Error('A $Cashtag is required for Cash App rails. Set CASHAPP_CASHTAG or pass {"cashtag":"$YourTag"} in Rail Options.');
    }

    if (instrumentRails.has(rail)) {
      reserve = await this._debitSourceForRail({ sourceType, sourceAccountId, amountCents, referenceId, memo });
    }

    switch (rail) {
      case 'cashapp':
        instrument = await CashAppEngine.requestPayment({
          amountUsd: fromCents(amountCents),
          recipientTag: railOptions.cashtag || railOptions.recipientTag,
          walletAddress: railOptions.walletAddress,
          memo: memo || `Funded from ${sourceType}:${sourceAccountId}`,
          direction: railOptions.direction,
        });
        break;
      case 'cashapp_fund_operator':
        instrument = await CashAppEngine.fundOperator({
          amountUsd: fromCents(amountCents),
          cashtag: railOptions.cashtag,
          memo: memo || `Funded from ${sourceType}:${sourceAccountId}`,
          direction: railOptions.direction,
        });
        break;
      case 'googlewallet':
      case 'google_wallet':
        instrument = await GoogleWalletEngine.createPass({
          email: railOptions.email,
          walletAddress: railOptions.walletAddress || getConfig().operatorAddress,
          ...railOptions,
        });
        break;
      case 'stablecoin_dex':
      case 'dex': {
        const DappEngine = await this.getDappEngine();
        if (!DappEngine) throw new Error('DappEngine not available');
        instrument = await StablecoinDexEngine.depositAndSwap({
          sourceType, sourceAccountId, amount: fromCents(amountCents),
          targetAsset: railOptions.targetAsset || 'USDC',
          recipient: railOptions.recipient || railOptions.recipientAddress,
          poolAddress: railOptions.poolAddress,
          createPoolIfMissing: railOptions.createPoolIfMissing,
          poolSeedUsdc: railOptions.poolSeedUsdc,
          poolSeedDlbusd: railOptions.poolSeedDlbusd,
        });
        break;
      }
      case 'coinbase_treasury':
      case 'coinbase': {
        const cfg = getConfig();
        instrument = await CoinbaseTreasuryBridge.stageFromSource({
          sourceType, sourceAccountId, amount: fromCents(amountCents),
          targetAddress: railOptions.targetAddress || cfg.operatorAddress,
          targetAsset: railOptions.asset || 'ETH',
          coinbasePaymentMethodId: railOptions.coinbasePaymentMethodId || '',
        });
        break;
      }
      case 'safe_payout': {
        const DappEngine = await this.getDappEngine();
        if (!DappEngine) throw new Error('DappEngine not available');
        instrument = await DappEngine.createPayout({
          safeId: railOptions.safeId, destination: railOptions.destination || railOptions.to,
          amountUsd: fromCents(amountCents), token: railOptions.asset || 'USDC',
          sourceType, sourceAccountId, description: memo,
        });
        break;
      }
      default:
        throw new Error(`Unsupported funding rail: ${rail}`);
    }

    const fundingId = instrument && (instrument.operationId || instrument.id || instrument.transferId || referenceId) || referenceId;
    return { success: true, fundingId, sourceType, sourceAccountId, rail, amount: fromCents(amountCents), reserve, instrument };
  }
}

module.exports = { ModuleFundingEngine };
