require('dotenv').config();

const path = require('path');
const { CrmEngine } = require('../integrations/crm/crmEngine');
const { CashEngine } = require('../integrations/cash/cashEngine');
const { TrustAccountingEngine } = require('../integrations/accounting/trustAccountingEngine');
const { SubLedgerEngine } = require('../integrations/accounting/subLedgerEngine');
const pool = require('../integrations/bonds/pgPool');

const SEED_AMOUNT = 1.0;

async function ensureTables() {
  try { await CashEngine.init(); } catch (e) { /* optional */ }
  try { await SubLedgerEngine.ensureTables(); } catch (e) { /* optional */ }
}

function isRealContact(c) {
  if (!c.email) return false;
  const email = c.email.toLowerCase();
  if (email.includes('@example.com')) return false;
  if (email.includes('@dlbtrust.internal')) return false;
  return true;
}

async function setup() {
  await ensureTables();

  const contacts = await CrmEngine.listContacts({ status: 'active' });
  const realContacts = contacts.filter(isRealContact);

  const result = { created: { cash: 0, trust: 0, sub: 0 }, seeded: 0, errors: [] };

  // Ensure sweep holding account exists for future cash funding
  try {
    const holding = await CashEngine.getAccount('STABLECOIN_CASH_HOLD');
    if (!holding) {
      await CashEngine.createAccount({
        accountId: 'STABLECOIN_CASH_HOLD',
        accountName: 'Stablecoin Cash Holding',
        accountType: 'operating',
        notes: 'Intermediary for source-of-funds cash sweeps',
      });
    }
  } catch (e) {
    result.errors.push(`holding: ${e.message}`);
  }

  for (const c of realContacts) {
    const emailLocal = c.email.split('@')[0];
    const name = `${c.first_name || ''} ${c.last_name || ''}`.trim() || c.company || c.contact_id;
    const accountId = `CA-${c.contact_id}`;
    const trustCode = `TRUST-${c.contact_id}`;

    // Cash account
    try {
      const existingCash = await CashEngine.getAccount(accountId);
      if (!existingCash) {
        await CashEngine.createAccount({
          accountId,
          accountName: `${name} (${emailLocal}) Distribution`,
          accountType: 'distribution',
          linkedFineractAccountId: c.fineract_client_id || null,
          notes: `Contact cash distribution account for ${c.contact_id}`,
        });
        result.created.cash++;
      }
    } catch (e) {
      result.errors.push(`cash ${c.contact_id}: ${e.message}`);
    }

    // Trust accounting account
    try {
      const existingTrust = await TrustAccountingEngine.getAccount(trustCode);
      if (!existingTrust) {
        await TrustAccountingEngine.createAccount({
          accountCode: trustCode,
          accountName: `${name} (${emailLocal}) Trust`,
          accountType: 'asset',
          subType: 'cash',
          parentAccountCode: '1000',
          linkedCashAccount: accountId,
          description: `Per-contact trust asset for ${c.contact_id}`,
        });
        result.created.trust++;
      }
    } catch (e) {
      result.errors.push(`trust ${c.contact_id}: ${e.message}`);
    }

    // Sub-ledger
    try {
      const existingSl = await pool.query(
        `SELECT sub_ledger_id FROM client_sub_ledgers
         WHERE contact_id = $1 AND parent_account_code = $2 AND sub_account_type = $3 AND status = 'active'`,
        [c.contact_id, '1200', 'distribution']
      );
      if (existingSl.rows.length === 0) {
        await SubLedgerEngine.createSubLedger({
          contactId: c.contact_id,
          parentAccountCode: '1200',
          subAccountName: `${name} (${emailLocal}) Distribution`,
          subAccountType: 'distribution',
          openingBalance: 0,
          currency: 'USD',
          notes: `Distribution sub-ledger for ${c.contact_id}`,
        });
        result.created.sub++;
      }
    } catch (e) {
      result.errors.push(`subledger ${c.contact_id}: ${e.message}`);
    }

    // Seed trust account from 1000 for wallet funding
    try {
      const acct = await TrustAccountingEngine.getAccount(trustCode);
      const bal = Number(acct && acct.balance || 0);
      if (bal < SEED_AMOUNT) {
        const seedDollars = (SEED_AMOUNT - bal).toFixed(2);
        await TrustAccountingEngine.postJournalEntry({
          entryDate: new Date(),
          description: `Seed contact trust account ${trustCode}`,
          referenceType: 'contact_ledger_setup',
          referenceId: c.contact_id,
          postedBy: 'setupContactLedgers',
          postToFineract: false,
          lines: [
            { accountCode: trustCode, debitAmount: seedDollars, creditAmount: 0, memo: 'Seed contact trust asset' },
            { accountCode: '1000', debitAmount: 0, creditAmount: seedDollars, memo: 'Seed from Trust Cash & Equivalents' },
          ],
        });
        result.seeded++;
      }
    } catch (e) {
      result.errors.push(`seed ${c.contact_id}: ${e.message}`);
    }
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.errors.length ? 1 : 0);
}

setup().catch(err => {
  console.error(err);
  process.exit(1);
});
