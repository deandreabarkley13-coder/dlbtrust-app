'use strict';

const { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');

class JournalEntryEngine {
  static defaultAccounts = {
    principal: '1100',
    interestReceivable: '1200',
    interestIncome: '4000',
    trustCorpus: '3000',
  };

  static async ensureAccounts() {
    const required = [
      { code: this.defaultAccounts.principal, name: 'Bond Investments', type: 'asset', subType: 'investment' },
      { code: this.defaultAccounts.interestReceivable, name: 'Accrued Interest Receivable', type: 'asset', subType: 'receivable' },
      { code: this.defaultAccounts.interestIncome, name: 'Interest Income', type: 'income', subType: 'interest_income' },
      { code: this.defaultAccounts.trustCorpus, name: 'Trust Corpus', type: 'equity', subType: 'trust_corpus' },
    ];
    for (const a of required) {
      const exists = await TrustAccountingEngine.getAccount(a.code);
      if (!exists) {
        await TrustAccountingEngine.createAccount({
          accountCode: a.code,
          accountName: a.name,
          accountType: a.type,
          subType: a.subType,
        });
      }
    }
  }

  static async postPrincipalAndInterest({
    principalAmount = 0,
    interestAmount = 0,
    bondId = 1,
    description,
    postedBy = 'journal-entry-engine',
  }) {
    const principal = parseFloat(principalAmount || 0);
    const interest = parseFloat(interestAmount || 0);
    if (principal <= 0 && interest <= 0) {
      throw new Error('At least one of principalAmount or interestAmount must be positive');
    }

    await this.ensureAccounts();
    const result = {};
    const accts = this.defaultAccounts;

    if (principal > 0) {
      result.principalEntry = await TrustAccountingEngine.postJournalEntry({
        entryDate: new Date(),
        description: description || `Bond principal recognition — bond ${bondId}`,
        referenceType: 'bond_principal',
        referenceId: String(bondId),
        bondId: Number(bondId) || null,
        postedBy,
        postToFineract: false,
        lines: [
          { accountCode: accts.principal, debitAmount: principal, creditAmount: 0, memo: 'Bond principal asset' },
          { accountCode: accts.trustCorpus, debitAmount: 0, creditAmount: principal, memo: 'Trust corpus backing principal' },
        ],
      });
    }

    if (interest > 0) {
      result.interestEntry = await TrustAccountingEngine.postJournalEntry({
        entryDate: new Date(),
        description: description || `Coupon interest income accrual — bond ${bondId}`,
        referenceType: 'bond_interest',
        referenceId: String(bondId),
        bondId: Number(bondId) || null,
        postedBy,
        postToFineract: false,
        lines: [
          { accountCode: accts.interestReceivable, debitAmount: interest, creditAmount: 0, memo: 'Accrued coupon interest' },
          { accountCode: accts.interestIncome, debitAmount: 0, creditAmount: interest, memo: 'Coupon interest income' },
        ],
      });
    }

    return result;
  }

  static async listAccounts() {
    await this.ensureAccounts();
    return TrustAccountingEngine.listAccounts({ isActive: true });
  }

  static async listEntries({ bondId, limit = 50 } = {}) {
    return TrustAccountingEngine.listJournalEntries({ bondId, limit });
  }
}

module.exports = { JournalEntryEngine };
