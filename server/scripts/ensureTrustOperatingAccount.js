#!/usr/bin/env node
'use strict';

/**
 * Make the Trust Operating Account real in the chart of accounts.
 *
 * Payments fund themselves from the account the funding registry calls
 * operating (CLEARING_FUNDING_OPERATING_ACCOUNT, 1010 Trust Checking), and the
 * registry fails closed when that account is missing, inactive or empty — so a
 * trust whose chart was seeded before 1010 existed, or whose cash still sits in
 * 1000, cannot pay until the account exists and holds the operating balance.
 *
 * This script reports that state and, on request, fixes it:
 *   1. Creates the operating account if the chart of accounts lacks it.
 *   2. Reactivates it if it exists but is inactive.
 *   3. Reclassifies cash into it from the source cash account with a balanced
 *      asset-reclass journal entry (DR operating / CR source) — the same entry
 *      the cash sweep books, no P&L impact.
 *
 * Reads only, unless --confirm is given: nothing is written and no journal
 * entry is posted without it, because the reclass moves the trust's stated
 * operating balance between two asset accounts.
 *
 * Usage:
 *   node server/scripts/ensureTrustOperatingAccount.js
 *   node server/scripts/ensureTrustOperatingAccount.js --confirm
 *   node server/scripts/ensureTrustOperatingAccount.js --reclass all --confirm
 *   node server/scripts/ensureTrustOperatingAccount.js --reclass 25000.00 --confirm
 *
 * Options:
 *   --account   Operating account code (default: the funding registry's)
 *   --from      Cash account to reclassify out of (default: 1000)
 *   --reclass   Dollar amount, or "all" for the source account's full balance
 *   --postedBy  Journal entry attribution (default: $USER or 'trustee')
 *   --confirm   Actually write; omit for a dry run
 */

const {
  FundingSourceRegistry,
} = require('../integrations/inhouseBank/clearing/fundingSourceRegistry');
const { TrustAccountingEngine } = require('../integrations/accounting/trustAccountingEngine');
const pool = require('../integrations/bonds/pgPool');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function dollars(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

async function main() {
  const args = parseArgs(process.argv);
  const confirm = args.confirm === true || args.confirm === 'true';
  const operatingCode = String(args.account || FundingSourceRegistry.operatingAccountCode());
  const sourceCode = String(args.from || '1000');
  const postedBy = String(args.postedBy || process.env.USER || 'trustee');

  const existing = await TrustAccountingEngine.getAccount(operatingCode);
  const source = await TrustAccountingEngine.getAccount(sourceCode);

  console.log(`Operating account (funding registry): ${operatingCode}`);
  console.log(existing
    ? `  present: ${existing.account_name} — ${dollars(existing.balance_cents)}, active=${existing.is_active}`
    : '  MISSING from the chart of accounts');
  console.log(source
    ? `Source account ${sourceCode}: ${source.account_name} — ${dollars(source.balance_cents)}`
    : `Source account ${sourceCode}: not in the chart of accounts`);

  const actions = [];
  if (!existing) actions.push(`create ${operatingCode} (Trust Checking)`);
  else if (!existing.is_active) actions.push(`reactivate ${operatingCode}`);

  let reclassCents = 0;
  if (args.reclass) {
    if (!source) {
      throw new Error(`Cannot reclassify from ${sourceCode}: it is not in the chart of accounts`);
    }
    reclassCents = String(args.reclass).toLowerCase() === 'all'
      ? Number(source.balance_cents || 0)
      : Math.round(Number(args.reclass) * 100);
    if (!Number.isFinite(reclassCents) || reclassCents <= 0) {
      throw new Error('--reclass must be a positive dollar amount or "all"');
    }
    if (reclassCents > Number(source.balance_cents || 0)) {
      throw new Error(
        `${sourceCode} holds ${dollars(source.balance_cents)}, which does not cover a `
        + `${dollars(reclassCents)} reclassification`
      );
    }
    actions.push(`post DR ${operatingCode} / CR ${sourceCode} ${dollars(reclassCents)}`);
  }

  if (actions.length === 0) {
    console.log('\nNothing to do: the operating account exists and is active.');
    return;
  }

  console.log(`\n${confirm ? 'Applying' : 'Would apply (dry run, pass --confirm)'}:`);
  actions.forEach(action => console.log(`  - ${action}`));
  if (!confirm) return;

  if (!existing) {
    await TrustAccountingEngine.createAccount({
      accountCode: operatingCode,
      accountName: process.env.TRUST_BANK_NAME || 'Trust Checking',
      accountType: 'asset',
      subType: 'cash',
      description: 'Trust operating/checking account (institution configured via TRUST_BANK_* settings)',
    });
    console.log(`  created ${operatingCode}`);
  } else if (!existing.is_active) {
    await TrustAccountingEngine.updateAccount(operatingCode, { isActive: true });
    console.log(`  reactivated ${operatingCode}`);
  }

  if (reclassCents > 0) {
    const amount = Number((reclassCents / 100).toFixed(2));
    const entry = await TrustAccountingEngine.postJournalEntry({
      description: `Reclassify trust cash ${sourceCode} → ${operatingCode} (operating account)`,
      referenceType: 'cash_reclass',
      referenceId: `OPERATING-${operatingCode}`,
      postedBy,
      lines: [
        { accountCode: operatingCode, debitAmount: amount, memo: 'Trust Operating Account' },
        { accountCode: sourceCode, creditAmount: amount, memo: 'Reclassified to operating' },
      ],
    });
    console.log(`  posted ${entry.entry_id} for ${dollars(reclassCents)}`);
  }

  const after = await TrustAccountingEngine.getAccount(operatingCode);
  console.log(`\n${operatingCode} now holds ${dollars(after.balance_cents)} and is `
    + `${after.is_active ? 'active' : 'INACTIVE'}.`);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(`ensureTrustOperatingAccount failed: ${err.message}`);
    pool.end().finally(() => process.exit(1));
  });
