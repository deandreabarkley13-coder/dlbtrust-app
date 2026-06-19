#!/usr/bin/env node
/**
 * Seed Fineract GL Accounts & Populate GL Mappings
 *
 * Creates GL accounts in Apache Fineract that mirror the trust chart of accounts,
 * then populates the fineract_gl_mappings table so journal entries can auto-post.
 *
 * Usage:
 *   node server/scripts/seed-fineract-gl.js
 *
 * Prerequisites:
 *   - Fineract running (docker compose up -d, wait ~60s)
 *   - PostgreSQL running with fineract_tenants database
 *   - fineract_gl_mappings table exists (run migrate-reports-gl-mappings.sql)
 */

'use strict';

const path = require('path');
const { FineractClient } = require(path.join(__dirname, '..', 'integrations', 'fineract', 'fineractClient'));
const pool = require(path.join(__dirname, '..', 'integrations', 'db', 'pgPool'));

// Fineract type codes: 1=ASSET, 2=LIABILITY, 3=EQUITY, 4=INCOME, 5=EXPENSE
const TYPE_MAP = {
  asset: 1,
  liability: 2,
  equity: 3,
  income: 4,
  expense: 5,
};

async function seedFineractGL() {
  console.log('[seed] Starting Fineract GL account seeding...\n');

  // 1. Verify Fineract is reachable
  try {
    await FineractClient.healthCheck();
    console.log('[seed] Fineract is reachable.\n');
  } catch (err) {
    console.error('[seed] ERROR: Fineract is not reachable. Start it with: docker compose up -d');
    console.error('       ' + err.message);
    process.exit(1);
  }

  // 2. Check existing GL accounts to avoid duplicates
  const existingAccounts = await FineractClient.getGLAccounts();
  const existingCodes = new Set(
    Array.isArray(existingAccounts) ? existingAccounts.map(a => a.glCode) : []
  );
  console.log(`[seed] Existing GL accounts in Fineract: ${existingCodes.size}`);

  // 3. Read trust chart of accounts from PostgreSQL
  const { rows: trustAccounts } = await pool.query(
    'SELECT account_code, account_name, account_type, sub_type FROM trust_accounts ORDER BY account_code'
  );
  console.log(`[seed] Trust accounts to sync: ${trustAccounts.length}\n`);

  // 4. Create GL accounts in Fineract for each trust account
  const mappings = [];
  let created = 0;
  let skipped = 0;

  for (const acct of trustAccounts) {
    const glCode = acct.account_code;

    if (existingCodes.has(glCode)) {
      // Find the existing Fineract account ID
      const existing = existingAccounts.find(a => a.glCode === glCode);
      console.log(`  [skip] ${glCode} ${acct.account_name} — already exists (id: ${existing.id})`);
      mappings.push({
        trustAccountCode: glCode,
        fineractGlId: existing.id,
        accountName: acct.account_name,
        accountType: acct.account_type,
      });
      skipped++;
      continue;
    }

    const fineractType = TYPE_MAP[acct.account_type];
    if (!fineractType) {
      console.warn(`  [warn] ${glCode} ${acct.account_name} — unknown type: ${acct.account_type}`);
      continue;
    }

    try {
      const result = await FineractClient.createGLAccount({
        name: acct.account_name,
        glCode,
        type: fineractType,
        usage: 2, // DETAIL (postable)
        description: `Trust account: ${acct.account_name} (${acct.sub_type || acct.account_type})`,
      });

      const fineractGlId = result.resourceId || result.id;
      console.log(`  [created] ${glCode} ${acct.account_name} -> Fineract GL id: ${fineractGlId}`);
      mappings.push({
        trustAccountCode: glCode,
        fineractGlId,
        accountName: acct.account_name,
        accountType: acct.account_type,
      });
      created++;
    } catch (err) {
      console.error(`  [error] ${glCode} ${acct.account_name}: ${err.message}`);
      if (err.detail) console.error('          ', JSON.stringify(err.detail).substring(0, 200));
    }
  }

  console.log(`\n[seed] Created ${created}, skipped ${skipped} (already existed)\n`);

  // 5. Populate fineract_gl_mappings table
  if (mappings.length > 0) {
    console.log('[seed] Populating fineract_gl_mappings table...');

    for (const m of mappings) {
      // Insert if not exists, then update to handle both cases
      await pool.query(`
        INSERT INTO fineract_gl_mappings (mapping_type, trust_account_code, fineract_gl_id, description)
        SELECT $1, $2, $3, $4
        WHERE NOT EXISTS (
          SELECT 1 FROM fineract_gl_mappings WHERE mapping_type = $1 AND trust_account_code = $2
        )
      `, ['trust_journal', m.trustAccountCode, m.fineractGlId, `${m.accountName} (${m.accountType})`]);
      await pool.query(`
        UPDATE fineract_gl_mappings SET fineract_gl_id = $1, description = $2, updated_at = NOW()
        WHERE mapping_type = 'trust_journal' AND trust_account_code = $3
      `, [m.fineractGlId, `${m.accountName} (${m.accountType})`, m.trustAccountCode]);
    }
    console.log(`[seed] ${mappings.length} mappings written to fineract_gl_mappings.\n`);
  }

  // 6. Verify
  const { rows: verifyRows } = await pool.query(
    'SELECT COUNT(*) as count FROM fineract_gl_mappings WHERE mapping_type = $1',
    ['trust_journal']
  );
  const glAccounts = await FineractClient.getGLAccounts();
  console.log('[seed] Verification:');
  console.log(`  Fineract GL accounts: ${Array.isArray(glAccounts) ? glAccounts.length : 0}`);
  console.log(`  GL mappings in DB:    ${verifyRows[0].count}`);
  console.log('\n[seed] Done! Fineract GL is now synced with trust chart of accounts.');
}

seedFineractGL()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[seed] Fatal error:', err);
    process.exit(1);
  });
