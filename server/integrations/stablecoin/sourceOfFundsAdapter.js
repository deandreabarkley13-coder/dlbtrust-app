'use strict';

/**
 * Source-of-Funds Adapter for Stablecoin Payments
 *
 * Routes stablecoin payment holds, releases, and settlement debits to the
 * appropriate backing engine (treasury, cash, trust accounting, bonds,
 * fixed income, Fineract core banking, CRM, documents).
 *
 * For non-treasury sources, the adapter now sweeps the source balance into the
 * stablecoin treasury's internal ledger at reserve time.  The treasury then
 * holds the funds, and on settlement the on-chain USDC is disbursed while the
 * treasury reserve is finalized.  This makes Core Banking / Bond / Fixed Income /
 * Trust / Cash balances the real funding source for stablecoin payments.
 */

let CashEngine = null;
try { CashEngine = require('../cash/cashEngine').CashEngine; } catch (e) { /* optional */ }

let TrustAccountingEngine = null;
try { TrustAccountingEngine = require('../accounting/trustAccountingEngine').TrustAccountingEngine; } catch (e) { /* optional */ }

let BondEngine = null;
try { BondEngine = require('../bonds/bondEngine').BondEngine; } catch (e) { /* optional */ }

let FineractClient = null;
try { FineractClient = require('../fineract/fineractClient').FineractClient; } catch (e) { /* optional */ }

let CrmEngine = null;
try { CrmEngine = require('../crm/crmEngine').CrmEngine; } catch (e) { /* optional */ }

let DocumentEngine = null;
try { DocumentEngine = require('../documents/documentEngine').DocumentEngine; } catch (e) { /* optional */ }

const { TreasuryEngine, DEFAULT_ACCOUNT } = require('./treasuryEngine');
const { getConfig } = require('./config');

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

class SourceOfFundsAdapter {
  static defaultSourceType() { return 'treasury'; }

  static async getBalance({ sourceType, sourceAccountId }) {
    sourceType = String(sourceType || 'treasury').toLowerCase();
    switch (sourceType) {
      case 'treasury': {
        const pos = await TreasuryEngine.getPosition(sourceAccountId || DEFAULT_ACCOUNT).catch(() => null);
        return pos ? pos.availableCents : 0;
      }
      case 'cash': {
        if (!CashEngine) throw new Error('CashEngine not available');
        const acct = await CashEngine.getAccount(sourceAccountId);
        return acct ? Number(acct.balance_cents || 0) : 0;
      }
      case 'trust':
      case 'trust_account': {
        if (!TrustAccountingEngine) throw new Error('TrustAccountingEngine not available');
        const acct = await TrustAccountingEngine.getAccount(sourceAccountId);
        return acct ? toCents(acct.balance || 0) : 0;
      }
      case 'bond':
      case 'fixed_income': {
        if (!BondEngine) throw new Error('BondEngine not available');
        const bond = await BondEngine.getBond(sourceAccountId);
        if (!bond) return 0;
        return Math.round((Number(bond.principal_balance || 0) + Number(bond.accrued_interest || 0)) * 100);
      }
      case 'fineract':
      case 'core_banking': {
        if (!FineractClient) throw new Error('FineractClient not available');
        const summary = await FineractClient.getAccountBalance(sourceAccountId);
        return toCents(summary.accountBalance || summary.balance || 0);
      }
      default:
        return 0;
    }
  }

  /**
   * Move real funds from a source engine into the stablecoin treasury.
   * After this, the treasury internal ledger is backed by the source balance.
   */
  static async _fundSourceToTreasury({ sourceType, sourceAccountId, paymentId, amountCents }) {
    const cfg = getConfig();
    switch (sourceType) {
      case 'cash': {
        if (!CashEngine) throw new Error('CashEngine not available');
        const acct = await CashEngine.getAccount(sourceAccountId);
        if (!acct) throw new Error(`Cash account not found: ${sourceAccountId}`);
        if (Number(acct.balance_cents || 0) < amountCents) throw new Error(`Insufficient cash balance in ${sourceAccountId}`);
        const holdingAccount = cfg.cashHoldingAccount || 'STABLECOIN_CASH_HOLD';
        const movement = await CashEngine.transfer({
          fromAccountId: sourceAccountId,
          toAccountId: holdingAccount,
          amountCents,
          movementType: 'sweep',
          memo: `Stablecoin funding ${paymentId}`,
          referenceId: paymentId,
          referenceType: 'stablecoin_payment',
        });
        await TreasuryEngine.credit(DEFAULT_ACCOUNT, amountCents, { source: 'cash', sourceAccountId, movementId: movement.movement_id });
        return { sourceType, sourceAccountId, movementId: movement.movement_id, holdingAccount };
      }
      case 'trust':
      case 'trust_account': {
        if (!TrustAccountingEngine) throw new Error('TrustAccountingEngine not available');
        const acct = await TrustAccountingEngine.getAccount(sourceAccountId);
        if (!acct) throw new Error(`Trust account not found: ${sourceAccountId}`);
        const available = toCents(acct.balance || 0);
        if (available < amountCents) throw new Error(`Insufficient trust account balance: ${available} < ${amountCents}`);
        const assetAccount = cfg.stablecoinAssetAccount || '1210';
        const journal = await TrustAccountingEngine.postJournalEntry({
          entryDate: new Date(),
          description: `Stablecoin funding ${paymentId}`,
          referenceType: 'stablecoin_payment',
          referenceId: paymentId,
          postedBy: 'stablecoin-gateway',
          postToFineract: false,
          lines: [
            { accountCode: assetAccount, debitAmount: amountCents / 100, creditAmount: 0, memo: 'Stablecoin backing from source' },
            { accountCode: sourceAccountId, debitAmount: 0, creditAmount: amountCents / 100, memo: 'Source funds to stablecoin' },
          ],
        });
        await TreasuryEngine.credit(DEFAULT_ACCOUNT, amountCents, { source: 'trust', sourceAccountId, journalEntryId: journal.entry_id });
        return { sourceType, sourceAccountId, journalEntryId: journal.entry_id, assetAccount };
      }
      case 'bond':
      case 'fixed_income': {
        if (!BondEngine) throw new Error('BondEngine not available');
        const bond = await BondEngine.getBond(sourceAccountId);
        if (!bond) throw new Error(`Bond not found: ${sourceAccountId}`);
        const available = Math.round((Number(bond.principal_balance || 0) + Number(bond.accrued_interest || 0)) * 100);
        if (available < amountCents) throw new Error(`Insufficient bond liquidity: ${available} < ${amountCents}`);
        const amount = amountCents / 100;
        const result = await BondEngine.payPrincipal(Number(sourceAccountId), amount);
        await TreasuryEngine.credit(DEFAULT_ACCOUNT, amountCents, { source: sourceType, sourceAccountId, bondTransactionId: result.transaction.id });
        return { sourceType, sourceAccountId, bondTransactionId: result.transaction.id, newPrincipalCents: toCents(result.new_principal_balance) };
      }
      case 'fineract':
      case 'core_banking': {
        if (!FineractClient) throw new Error('FineractClient not available');
        const summary = await FineractClient.getAccountBalance(sourceAccountId);
        const available = toCents(summary.accountBalance || summary.balance || 0);
        if (available < amountCents) throw new Error(`Insufficient Fineract balance: ${available} < ${amountCents}`);
        const assetGlId = Number(cfg.fineractStablecoinAssetGlId);
        const sourceGlId = Number(sourceAccountId);
        if (!assetGlId) throw new Error('STABLECOIN_FINERACT_ASSET_GL_ID is required for Fineract source-of-funds');
        if (!Number.isFinite(sourceGlId)) throw new Error(`Invalid Fineract GL account id: ${sourceAccountId}`);
        const journal = await FineractClient.postJournalEntry({
          officeId: 1,
          transactionDate: new Date(),
          comments: `Stablecoin funding ${paymentId}`,
          debits: [{ glAccountId: sourceGlId, amount: amountCents / 100 }],
          credits: [{ glAccountId: assetGlId, amount: amountCents / 100 }],
        });
        await TreasuryEngine.credit(DEFAULT_ACCOUNT, amountCents, { source: 'fineract', sourceAccountId, journalId: journal.resourceId });
        return { sourceType, sourceAccountId, journalId: journal.resourceId };
      }
      default:
        throw new Error(`Unsupported source type for funding: ${sourceType}`);
    }
  }

  /**
   * Reverse a source-to-treasury sweep when the payment fails or is cancelled.
   */
  static async _refundSourceFromTreasury({ sourceType, sourceAccountId, payment, sourceRef }) {
    const amountCents = Number(payment.total_cents);
    const cfg = getConfig();
    await TreasuryEngine.debit(DEFAULT_ACCOUNT, amountCents, { reason: `Refund source for ${payment.id}`, source: sourceType });
    switch (sourceType) {
      case 'cash': {
        if (!CashEngine) throw new Error('CashEngine not available');
        const holdingAccount = sourceRef.holdingAccount || cfg.cashHoldingAccount || 'STABLECOIN_CASH_HOLD';
        await CashEngine.transfer({
          fromAccountId: holdingAccount,
          toAccountId: sourceAccountId,
          amountCents,
          movementType: 'transfer',
          memo: `Release stablecoin reserve ${payment.id}`,
          referenceId: payment.id,
          referenceType: 'stablecoin_payment',
        });
        break;
      }
      case 'trust':
      case 'trust_account': {
        if (!TrustAccountingEngine) throw new Error('TrustAccountingEngine not available');
        if (sourceRef.journalEntryId) {
          await TrustAccountingEngine.reverseJournalEntry(sourceRef.journalEntryId, { postedBy: 'stablecoin-gateway' });
        }
        break;
      }
      case 'bond':
      case 'fixed_income': {
        if (!BondEngine) throw new Error('BondEngine not available');
        if (sourceRef.bondTransactionId) {
          const amount = amountCents / 100;
          await BondEngine.receivePrincipal(Number(sourceAccountId), amount);
        }
        break;
      }
      case 'fineract':
      case 'core_banking': {
        if (!FineractClient) throw new Error('FineractClient not available');
        if (sourceRef.journalId) {
          const assetGlId = Number(cfg.fineractStablecoinAssetGlId);
          const sourceGlId = Number(sourceAccountId);
          if (assetGlId && Number.isFinite(sourceGlId)) {
            await FineractClient.postJournalEntry({
              officeId: 1,
              transactionDate: new Date(),
              comments: `Reversal of stablecoin funding ${payment.id}`,
              debits: [{ glAccountId: assetGlId, amount: amountCents / 100 }],
              credits: [{ glAccountId: sourceGlId, amount: amountCents / 100 }],
            });
          }
        }
        break;
      }
      default:
        break;
    }
    return { refunded: true };
  }

  static async reserve(payment) {
    const sourceType = String(payment.source_type || 'treasury').toLowerCase();
    const sourceAccountId = payment.source_account_id || DEFAULT_ACCOUNT;
    const amountCents = Number(payment.total_cents);

    if (sourceType === 'treasury') {
      const { reserveId } = await TreasuryEngine.hold(payment.id, sourceAccountId, amountCents);
      return { sourceType, sourceAccountId, reserveId };
    }

    const funding = await SourceOfFundsAdapter._fundSourceToTreasury({ sourceType, sourceAccountId, paymentId: payment.id, amountCents });
    try {
      const { reserveId } = await TreasuryEngine.hold(payment.id, DEFAULT_ACCOUNT, amountCents);
      return { sourceType, sourceAccountId, reserveId, ...funding };
    } catch (err) {
      // Rollback the source sweep if we cannot hold in treasury
      try { await SourceOfFundsAdapter._refundSourceFromTreasury({ sourceType, sourceAccountId, payment, sourceRef: funding }); } catch (e) { console.warn('[SourceOfFundsAdapter] rollback failed:', e.message); }
      throw err;
    }
  }

  static async post(payment, txHash, { settledAmountCents } = {}) {
    const sourceType = String(payment.source_type || 'treasury').toLowerCase();
    const sourceAccountId = payment.source_account_id || DEFAULT_ACCOUNT;
    const sourceRef = payment.source_ref || {};
    const amountCents = Number(settledAmountCents || payment.amount_cents);
    const cfg = getConfig();

    if (payment.reserve_id) {
      await TreasuryEngine.post(payment.reserve_id, txHash, { settledAmountCents: amountCents });
    }

    switch (sourceType) {
      case 'treasury':
        return { sourceType, sourceAccountId, posted: true };
      case 'cash': {
        if (!CashEngine) throw new Error('CashEngine not available');
        if (!sourceRef.movementId) throw new Error('Cash source has no reserve movement; approve before settling');
        const holdingAccount = sourceRef.holdingAccount || cfg.cashHoldingAccount || 'STABLECOIN_CASH_HOLD';
        if (cfg.cashSettlementAccount) {
          const movement = await CashEngine.transfer({
            fromAccountId: holdingAccount,
            toAccountId: cfg.cashSettlementAccount,
            amountCents,
            movementType: 'withdrawal',
            memo: `Stablecoin settlement ${payment.id} ${txHash || ''}`,
            referenceId: payment.id,
            referenceType: 'stablecoin_payment',
          });
          return { sourceType, sourceAccountId, movementId: movement.movement_id, posted: true };
        }
        return { sourceType, sourceAccountId, movementId: sourceRef.movementId, posted: true };
      }
      case 'trust':
      case 'trust_account':
        return { sourceType, sourceAccountId, journalEntryId: sourceRef.journalEntryId, posted: true };
      case 'bond':
      case 'fixed_income':
        return { sourceType, sourceAccountId, bondTransactionId: sourceRef.bondTransactionId, posted: true, newPrincipalCents: sourceRef.newPrincipalCents };
      case 'fineract':
      case 'core_banking':
        return { sourceType, sourceAccountId, journalId: sourceRef.journalId, posted: true };
      default:
        return { sourceType, sourceAccountId, posted: false };
    }
  }

  static async release(payment) {
    const sourceType = String(payment.source_type || 'treasury').toLowerCase();
    const sourceAccountId = payment.source_account_id || DEFAULT_ACCOUNT;
    const sourceRef = payment.source_ref || {};

    if (payment.reserve_id) {
      await TreasuryEngine.release(payment.reserve_id, 'payment failed or cancelled');
    }

    if (sourceType === 'treasury') {
      return { released: true };
    }

    await SourceOfFundsAdapter._refundSourceFromTreasury({ sourceType, sourceAccountId, payment, sourceRef });
    return { released: true };
  }

  static async recordCrmAndDocuments(payment, txHash) {
    const results = {};
    if (CrmEngine && payment.metadata && payment.metadata.contact_id) {
      try {
        results.interaction = await CrmEngine.logInteraction({
          contactId: payment.metadata.contact_id,
          interactionType: 'payment',
          subject: 'Stablecoin settlement',
          body: `Settled ${payment.amount_cents / 100} ${payment.asset_code} to ${payment.destination_wallet} (tx: ${txHash})`,
          direction: 'outbound',
          outcome: 'completed',
          createdBy: 'stablecoin-gateway',
        });
      } catch (e) { console.warn('[sourceOfFunds] CRM interaction failed:', e.message); }
    }
    if (DocumentEngine) {
      try {
        results.document = await DocumentEngine.createDocument({
          documentName: `Stablecoin Receipt ${payment.id}`,
          documentType: 'receipt',
          category: 'payment',
          referenceType: 'stablecoin_payment',
          referenceId: payment.id,
          content: JSON.stringify({ ...payment, tx_hash: txHash }, null, 2),
          contentType: 'application/json',
          createdBy: 'stablecoin-gateway',
        });
      } catch (e) { console.warn('[sourceOfFunds] Document creation failed:', e.message); }
    }
    return results;
  }
}

module.exports = { SourceOfFundsAdapter };
