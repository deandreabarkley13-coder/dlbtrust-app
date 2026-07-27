'use strict';

/**
 * Source-of-Funds Adapter for Stablecoin Payments
 *
 * Routes stablecoin payment holds, releases, and settlement debits to the
 * appropriate backing engine (treasury, cash, trust accounting, bonds,
 * fixed income, Fineract core banking, CRM, documents).
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

  static async reserve(payment) {
    const sourceType = String(payment.source_type || 'treasury').toLowerCase();
    const sourceAccountId = payment.source_account_id || DEFAULT_ACCOUNT;
    const amountCents = Number(payment.total_cents);

    switch (sourceType) {
      case 'treasury': {
        const { reserveId } = await TreasuryEngine.hold(payment.id, sourceAccountId, amountCents);
        return { sourceType, sourceAccountId, reserveId };
      }
      case 'cash': {
        if (!CashEngine) throw new Error('CashEngine not available');
        const acct = await CashEngine.getAccount(sourceAccountId);
        if (!acct) throw new Error(`Cash account not found: ${sourceAccountId}`);
        if (Number(acct.balance_cents || 0) < amountCents) throw new Error(`Insufficient cash balance in ${sourceAccountId}`);
        const cfg = getConfig();
        const holdingAccount = cfg.cashHoldingAccount || 'STABLECOIN_CASH_HOLD';
        const movement = await CashEngine.transfer({
          fromAccountId: sourceAccountId,
          toAccountId: holdingAccount,
          amountCents,
          movementType: 'reserve',
          memo: `Stablecoin reserve ${payment.id}`,
          referenceId: payment.id,
          referenceType: 'stablecoin_payment',
        });
        return { sourceType, sourceAccountId, movementId: movement.movement_id, holdingAccount };
      }
      case 'trust':
      case 'trust_account': {
        if (!TrustAccountingEngine) throw new Error('TrustAccountingEngine not available');
        const acct = await TrustAccountingEngine.getAccount(sourceAccountId);
        if (!acct) throw new Error(`Trust account not found: ${sourceAccountId}`);
        return { sourceType, sourceAccountId, reservedAt: new Date().toISOString() };
      }
      case 'bond':
      case 'fixed_income': {
        if (!BondEngine) throw new Error('BondEngine not available');
        const bond = await BondEngine.getBond(sourceAccountId);
        if (!bond) throw new Error(`Bond not found: ${sourceAccountId}`);
        const available = Math.round((Number(bond.principal_balance || 0) + Number(bond.accrued_interest || 0)) * 100);
        if (available < amountCents) throw new Error(`Insufficient bond liquidity: ${available} < ${amountCents}`);
        return { sourceType, sourceAccountId, reservedAt: new Date().toISOString() };
      }
      case 'fineract':
      case 'core_banking': {
        if (!FineractClient) throw new Error('FineractClient not available');
        const summary = await FineractClient.getAccountBalance(sourceAccountId);
        const available = toCents(summary.accountBalance || summary.balance || 0);
        if (available < amountCents) throw new Error(`Insufficient Fineract balance: ${available} < ${amountCents}`);
        return { sourceType, sourceAccountId, reservedAt: new Date().toISOString() };
      }
      default:
        throw new Error(`Unsupported source type: ${sourceType}`);
    }
  }

  static async post(payment, txHash, { settledAmountCents } = {}) {
    const sourceType = String(payment.source_type || 'treasury').toLowerCase();
    const sourceAccountId = payment.source_account_id || DEFAULT_ACCOUNT;
    const sourceRef = payment.source_ref || {};
    const amountCents = Number(settledAmountCents || payment.amount_cents);

    switch (sourceType) {
      case 'treasury': {
        if (payment.reserve_id) {
          const result = await TreasuryEngine.post(payment.reserve_id, txHash, { settledAmountCents: amountCents });
          return { sourceType, sourceAccountId, ...result };
        }
        return { sourceType, sourceAccountId, posted: true };
      }
      case 'cash': {
        if (!CashEngine) throw new Error('CashEngine not available');
        if (sourceRef.movementId) {
          return { sourceType, sourceAccountId, movementId: sourceRef.movementId, posted: true };
        }
        const cfg = getConfig();
        const holdingAccount = cfg.cashHoldingAccount || 'STABLECOIN_CASH_HOLD';
        const movement = await CashEngine.transfer({
          fromAccountId: holdingAccount,
          toAccountId: cfg.cashSettlementAccount || sourceAccountId,
          amountCents,
          movementType: 'withdrawal',
          memo: `Stablecoin settlement ${payment.id} ${txHash || ''}`,
          referenceId: payment.id,
          referenceType: 'stablecoin_payment',
        });
        return { sourceType, sourceAccountId, movementId: movement.movement_id, posted: true };
      }
      case 'trust':
      case 'trust_account': {
        if (!TrustAccountingEngine) throw new Error('TrustAccountingEngine not available');
        const cfg = getConfig();
        const journal = await TrustAccountingEngine.postJournalEntry({
          entryDate: new Date(),
          description: `Stablecoin settlement ${payment.id} ${txHash || ''}`,
          referenceType: 'stablecoin_payment',
          referenceId: payment.id,
          postedBy: 'stablecoin-gateway',
          postToFineract: false,
          lines: [
            { accountCode: cfg.stablecoinAssetAccount || '1210', debitAmount: amountCents / 100, creditAmount: 0, memo: 'Stablecoin asset received' },
            { accountCode: sourceAccountId, debitAmount: 0, creditAmount: amountCents / 100, memo: 'Source account debited' },
          ],
        });
        return { sourceType, sourceAccountId, journalEntryId: journal.entry_id, posted: true };
      }
      case 'bond':
      case 'fixed_income': {
        if (!BondEngine) throw new Error('BondEngine not available');
        const bond = await BondEngine.getBond(sourceAccountId);
        if (!bond) throw new Error(`Bond not found: ${sourceAccountId}`);
        const amount = amountCents / 100;
        await BondEngine.payPrincipal(Number(sourceAccountId), amount);
        const newPrincipal = Math.max(0, Number(bond.principal_balance || 0) - amount);
        return { sourceType, sourceAccountId, posted: true, newPrincipalCents: toCents(newPrincipal) };
      }
      case 'fineract':
      case 'core_banking': {
        if (!FineractClient) throw new Error('FineractClient not available');
        const cfg = getConfig();
        const assetGlId = Number(cfg.fineractStablecoinAssetGlId);
        const sourceGlId = Number(sourceAccountId);
        if (!assetGlId) throw new Error('STABLECOIN_FINERACT_ASSET_GL_ID is required for Fineract source-of-funds');
        if (!Number.isFinite(sourceGlId)) throw new Error(`Invalid Fineract GL account id: ${sourceAccountId}`);
        const journal = await FineractClient.postJournalEntry({
          officeId: 1,
          transactionDate: new Date(),
          comments: `Stablecoin settlement ${payment.id} ${txHash || ''}`,
          debits: [{ glAccountId: assetGlId, amount: amountCents / 100 }],
          credits: [{ glAccountId: sourceGlId, amount: amountCents / 100 }],
        });
        return { sourceType, sourceAccountId, journalId: journal.resourceId, posted: true };
      }
      default:
        return { sourceType, sourceAccountId, posted: false };
    }
  }

  static async release(payment) {
    const sourceType = String(payment.source_type || 'treasury').toLowerCase();
    const sourceAccountId = payment.source_account_id || DEFAULT_ACCOUNT;
    const sourceRef = payment.source_ref || {};

    switch (sourceType) {
      case 'treasury': {
        if (payment.reserve_id) await TreasuryEngine.release(payment.reserve_id, 'payment failed or cancelled');
        return { released: true };
      }
      case 'cash': {
        if (!CashEngine) throw new Error('CashEngine not available');
        if (sourceRef.movementId && sourceRef.holdingAccount) {
          const amountCents = Number(payment.total_cents);
          await CashEngine.transfer({
            fromAccountId: sourceRef.holdingAccount,
            toAccountId: sourceAccountId,
            amountCents,
            movementType: 'transfer',
            memo: `Release stablecoin reserve ${payment.id}`,
            referenceId: payment.id,
            referenceType: 'stablecoin_payment',
          });
        }
        return { released: true };
      }
      default:
        return { released: true };
    }
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
