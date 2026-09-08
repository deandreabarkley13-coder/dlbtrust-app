#!/usr/bin/env node
/**
 * One-Time Migration: Wallets → Apache Fineract
 *
 * Reads all wallets from the migrated legacy ledger in Postgres, then for each:
 *   1. Creates a Fineract client (beneficiary/trustee)
 *   2. Creates a savings account (using a configurable savings product)
 *   3. Posts the current fiat_balance as an opening deposit journal entry
 *
 * Usage:
 *   node server/scripts/migrate-wallets-to-fineract.js
 *
 * Environment:
 *   LEGACY_SQLITE_SCHEMA  — schema holding the migrated wallets (default: legacy_sqlite)
 *   FINERACT_URL          — Fineract API base URL
 *   FINERACT_TENANT_ID    — Fineract tenant (default: "default")
 *   FINERACT_USERNAME     — Fineract admin user
 *   FINERACT_PASSWORD     — Fineract admin password
 *   FINERACT_SAVINGS_PRODUCT_ID — savings product to use (default: 1)
 *   FINERACT_CASH_GL_ACCOUNT_ID — GL account for cash/asset side (default: 1)
 *   FINERACT_DEPOSIT_GL_ACCOUNT_ID — GL account for deposit/liability side (default: 2)
 */

'use strict';

require('dotenv').config();

const path = require('path');
const pool = require(path.join(__dirname, '..', 'integrations', 'bonds', 'pgPool'));
const { FineractClient } = require('../integrations/fineract/fineractClient');

const SCHEMA = process.env.LEGACY_SQLITE_SCHEMA || 'legacy_sqlite';
if (!/^[a-z_][a-z0-9_]*$/.test(SCHEMA)) {
  throw new Error('LEGACY_SQLITE_SCHEMA must be a plain lowercase identifier, got: ' + SCHEMA);
}
const SAVINGS_PRODUCT_ID     = parseInt(process.env.FINERACT_SAVINGS_PRODUCT_ID, 10) || 1;
const CASH_GL_ACCOUNT_ID     = parseInt(process.env.FINERACT_CASH_GL_ACCOUNT_ID, 10) || 1;
const DEPOSIT_GL_ACCOUNT_ID  = parseInt(process.env.FINERACT_DEPOSIT_GL_ACCOUNT_ID, 10) || 2;

async function migrate() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  DLB Trust → Fineract Migration');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Wallet source: ${SCHEMA}.wallets (Postgres)`);
  console.log(`  Fineract URL:  ${process.env.FINERACT_URL || '(default)'}`);
  console.log(`  Savings Prod:  ${SAVINGS_PRODUCT_ID}`);
  console.log('');

  // 1. Connect to Postgres
  try {
    await pool.query('SELECT 1');
    console.log('[DB] Connected to Postgres');
  } catch (err) {
    console.error(`[DB] Cannot reach Postgres: ${err.message}`);
    process.exit(1);
  }

  // 2. Verify Fineract is reachable
  try {
    await FineractClient.healthCheck();
    console.log('[Fineract] Health check passed');
  } catch (err) {
    console.error(`[Fineract] Health check failed: ${err.message}`);
    console.error('  Make sure Fineract is running (docker compose up -d) and wait ~60s for init.');
    process.exit(1);
  }

  // 3. Read all wallets
  let wallets;
  try {
    const res = await pool.query(`SELECT * FROM ${SCHEMA}.wallets ORDER BY id`);
    wallets = res.rows;
  } catch (err) {
    console.error(`[DB] Cannot read ${SCHEMA}.wallets: ${err.message}`);
    console.error('  Migrate the legacy SQLite file first: node server/scripts/migrateSqliteToPostgres.js --confirm');
    process.exit(1);
  }

  console.log(`[Migration] Found ${wallets.length} wallet(s)\n`);

  const results = [];

  for (const wallet of wallets) {
    const label = wallet.holder_name || wallet.name || `Wallet ${wallet.id}`;
    console.log(`─── Migrating: ${label} (id=${wallet.id}) ───`);

    try {
      // Parse name
      const nameParts = (wallet.holder_name || wallet.name || `Wallet ${wallet.id}`)
        .replace(/^Beneficiary \d+ - /, '')
        .trim()
        .split(' ');
      const firstName = nameParts[0] || 'Wallet';
      const lastName  = nameParts.slice(1).join(' ') || String(wallet.id);

      // 3a. Create Fineract client
      console.log(`  Creating client: ${firstName} ${lastName}`);
      const clientResult = await FineractClient.createClient({
        firstName,
        lastName,
        externalId: `wallet_${wallet.id}`,
        email: wallet.email || undefined,
      });
      const clientId = clientResult.clientId || clientResult.resourceId;
      console.log(`  ✓ Client created: id=${clientId}`);

      // 3b. Create savings account
      console.log(`  Creating savings account (product=${SAVINGS_PRODUCT_ID})`);
      const accountResult = await FineractClient.createSavingsAccount({
        clientId,
        productId: SAVINGS_PRODUCT_ID,
        externalId: `wallet_savings_${wallet.id}`,
      });
      const savingsId = accountResult.savingsId || accountResult.resourceId;
      console.log(`  ✓ Savings account created: id=${savingsId}`);

      // 3c. Post opening balance as journal entry (if balance > 0)
      const balanceCents = Number(wallet.fiat_balance || 0);
      const balanceDollars = balanceCents / 100;

      if (balanceDollars > 0) {
        console.log(`  Posting opening balance: $${balanceDollars.toFixed(2)}`);
        await FineractClient.postJournalEntry({
          officeId: 1,
          transactionDate: new Date(),
          credits: [{ glAccountId: DEPOSIT_GL_ACCOUNT_ID, amount: balanceDollars }],
          debits:  [{ glAccountId: CASH_GL_ACCOUNT_ID, amount: balanceDollars }],
          comments: `Opening balance migration for ${label} (wallet ${wallet.id})`,
        });
        console.log(`  ✓ Journal entry posted`);
      } else {
        console.log(`  (zero balance — skipping journal entry)`);
      }

      results.push({
        wallet_id: wallet.id,
        name: label,
        fineract_client_id: clientId,
        fineract_savings_id: savingsId,
        balance_usd: balanceDollars,
        status: 'migrated',
      });

    } catch (err) {
      console.error(`  ✗ Error: ${err.message}`);
      if (err.detail) console.error(`    Detail: ${JSON.stringify(err.detail).substring(0, 200)}`);
      results.push({
        wallet_id: wallet.id,
        name: label,
        status: 'error',
        error: err.message,
      });
    }

    console.log('');
  }

  // 4. Summary
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Migration Summary');
  console.log('═══════════════════════════════════════════════════════');
  const migrated = results.filter(r => r.status === 'migrated');
  const errors   = results.filter(r => r.status === 'error');
  console.log(`  Total:    ${results.length}`);
  console.log(`  Migrated: ${migrated.length}`);
  console.log(`  Errors:   ${errors.length}`);

  if (errors.length > 0) {
    console.log('\n  Failed wallets:');
    for (const e of errors) {
      console.log(`    - ${e.name} (id=${e.wallet_id}): ${e.error}`);
    }
  }

  console.log('\nDone.');
  return results;
}

migrate()
  .catch(err => {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (typeof pool.end === 'function') pool.end().catch(() => {});
  });
