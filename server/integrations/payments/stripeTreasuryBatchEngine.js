'use strict';

/**
 * Stripe Treasury Batch Engine
 *
 * Bridges the PTC ledger to Stripe Treasury for bulk deposits and payouts.
 * - recordDeposit(): credits the trust ledger when fiat lands in Stripe Treasury.
 * - processPaymentFile(): reads a batch of payouts, prefunds the Treasury account
 *   from the PTC source, creates Stripe OutboundPayments, and posts ledger entries.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

let PayoutCenterEngine;
try { ({ PayoutCenterEngine } = require('../dapp/payoutCenterEngine')); } catch (e) { PayoutCenterEngine = null; }
let StripeTreasuryEngine;
try { ({ StripeTreasuryEngine } = require('./stripeTreasuryEngine')); } catch (e) { StripeTreasuryEngine = null; }
let TrustAccountingEngine;
try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) { TrustAccountingEngine = null; }

function id(prefix = 'STB') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }
function toCents(amount) { return Math.round((Number(amount) || 0) * 100); }

async function ensureAccount({ accountCode, accountName, accountType, subType, linkedCashAccount }) {
  if (!TrustAccountingEngine) throw new Error('TrustAccountingEngine not available');
  const existing = await TrustAccountingEngine.getAccount(accountCode);
  if (existing) return existing;
  return TrustAccountingEngine.createAccount({
    accountCode,
    accountName,
    accountType,
    subType,
    linkedCashAccount,
    description: `Auto-created for Stripe Treasury bridge`,
  });
}

function parseFile(input) {
  if (Array.isArray(input)) return input;
  if (typeof input === 'string') {
    try { return JSON.parse(input); } catch {}
    const lines = input.split(/\r?\n/).filter(l => l.trim());
    if (lines.length === 0) return [];
    const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
    return lines.slice(1).map(line => {
      const values = line.split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
      const row = {};
      headers.forEach((h, i) => { row[h] = values[i] || ''; });
      return row;
    });
  }
  throw new Error('Payment file must be a JSON array or CSV string');
}

class StripeTreasuryBatchEngine {
  static async recordDeposit({ amount, financialAccountId, creditAccountCode = 'PTC-TREASURY-DEPOSIT', depositType = 'trust_deposit', description, reference } = {}) {
    if (!TrustAccountingEngine) throw new Error('TrustAccountingEngine not available');
    const amountCents = toCents(amount);
    if (!amountCents || amountCents <= 0) throw new Error('amount must be positive');

    await ensureAccount({ accountCode: '1100', accountName: 'Cash', accountType: 'asset', subType: 'cash' });
    const creditType = creditAccountCode === '4000' ? 'income' : (creditAccountCode === '3000' ? 'equity' : 'liability');
    const creditSubType = creditAccountCode === '4000' ? 'interest_income' : (creditAccountCode === '3000' ? 'trust_corpus' : 'payable');
    await ensureAccount({
      accountCode: creditAccountCode,
      accountName: creditAccountCode === '4000' ? 'Interest Income' : (creditAccountCode === '3000' ? 'Trust Corpus' : 'PTC Treasury Deposit Clearing'),
      accountType: creditType,
      subType: creditSubType,
    });

    const je = await TrustAccountingEngine.postJournalEntry({
      entryDate: new Date(),
      description: description || `Stripe Treasury deposit ${reference || id('DEP')}`,
      referenceType: 'stripe_treasury_deposit',
      referenceId: reference || id('DEP'),
      postedBy: 'StripeTreasuryBatchEngine',
      lines: [
        { accountCode: '1100', debitAmount: (amountCents / 100).toFixed(2) },
        { accountCode: creditAccountCode, creditAmount: (amountCents / 100).toFixed(2) },
      ],
    });

    return {
      batchId: id('DEP'),
      journalEntryId: je.entry_id,
      amount: amountCents / 100,
      depositType,
      creditAccountCode,
      financialAccountId: financialAccountId || process.env.STRIPE_TREASURY_FINANCIAL_ACCOUNT_ID,
      reference,
    };
  }

  static async processPaymentFile({ file, sourceCashAccountCode = '1100', sourceAccountId = 'CA-OPERATING', financialAccountId, initiatedBy, network = 'ach', skipPrefund = false } = {}) {
    if (!PayoutCenterEngine) throw new Error('PayoutCenterEngine not available');
    if (!StripeTreasuryEngine) throw new Error('StripeTreasuryEngine not available');

    const rows = parseFile(file);
    if (!rows.length) throw new Error('Payment file is empty');

    const normalized = rows.map((r, i) => {
      const amount = Number(r.amount || r.amount_usd || r.Amount || r.amountUSD);
      if (!amount || amount <= 0) throw new Error(`Row ${i + 1}: amount required`);
      return {
        amount,
        routingNumber: r.routingNumber || r.routing || r.Routing || r.routing_number,
        accountNumber: r.accountNumber || r.account || r.Account || r.account_number,
        accountType: r.accountType || r.account_type || r.AccountType || 'checking',
        accountHolderType: r.accountHolderType || r.account_holder_type || r.holderType || 'individual',
        accountHolderName: r.accountHolderName || r.recipientName || r.beneficiaryName || r.fullName || r.Recipient || r.recipient,
        description: r.description || r.Description || `PTC batch payout`,
        statementDescriptor: r.statementDescriptor || r.statement_descriptor,
        network: r.network || r.Network || network,
      };
    });

    const totalAmount = normalized.reduce((sum, r) => sum + r.amount, 0);

    if (!skipPrefund) {
      const prefund = await StripeTreasuryEngine.prefundFromPtc({
        amount: totalAmount,
        sourceCashAccountId,
        financialAccountId: financialAccountId || process.env.STRIPE_TREASURY_FINANCIAL_ACCOUNT_ID,
        description: `Batch prefund ${id('BATCH')}`,
      });
      if (!prefund.prefunded) throw new Error(prefund.instruction || 'Unable to prefund Stripe Treasury for batch');
    }

    await ensureAccount({ accountCode: sourceCashAccountCode, accountName: 'Cash', accountType: 'asset', subType: 'cash', linkedCashAccount: sourceCashAccountId });
    await ensureAccount({ accountCode: 'PTC-PAYOUTS-CLEARED', accountName: 'PTC Payouts Cleared', accountType: 'liability', subType: 'payable' });

    const results = [];
    for (let i = 0; i < normalized.length; i++) {
      const row = normalized[i];
      let payout = null;
      let error = null;
      try {
        const rail = row.network === 'us_domestic_wire' ? 'stripe_wire' : 'stripe_ach';
        payout = await PayoutCenterEngine.createPayment({
          paymentType: 'payout',
          sourceType: 'cash',
          sourceAccountId,
          recipientType: 'external',
          recipientIdentifier: row.accountNumber,
          amount: row.amount,
          asset: 'USD',
          rail,
          description: row.description,
          railOptions: {
            financialAccountId: financialAccountId || process.env.STRIPE_TREASURY_FINANCIAL_ACCOUNT_ID,
            routingNumber: row.routingNumber,
            accountNumber: row.accountNumber,
            accountType: row.accountType,
            accountHolderType: row.accountHolderType,
            recipientName: row.accountHolderName,
            statementDescriptor: row.statementDescriptor,
            network: row.network,
            initiatedBy,
          },
        });

        await TrustAccountingEngine.postJournalEntry({
          entryDate: new Date(),
          description: `Batch payout ${payout.id} to ${row.accountHolderName || row.accountNumber}`,
          referenceType: 'stripe_treasury_batch_payout',
          referenceId: payout.id,
          postedBy: initiatedBy || 'StripeTreasuryBatchEngine',
          lines: [
            { accountCode: sourceCashAccountCode, debitAmount: row.amount.toFixed(2) },
            { accountCode: 'PTC-PAYOUTS-CLEARED', creditAmount: row.amount.toFixed(2) },
          ],
        });
      } catch (e) { error = e.message; }

      results.push({
        row: i + 1,
        amount: row.amount,
        recipient: row.accountHolderName || row.accountNumber,
        status: error ? 'failed' : (payout && payout.status) || 'pending',
        payoutId: payout && payout.id,
        stripeOutboundPaymentId: payout && payout.tx_hash,
        error,
      });
    }

    return {
      batchId: id('BATCH'),
      totalAmount,
      rowCount: normalized.length,
      results,
    };
  }
}

module.exports = { StripeTreasuryBatchEngine };
