#!/usr/bin/env node
'use strict';

/**
 * Purge every Eaton Family Credit Union artifact from a live database.
 *
 * Source code no longer references Eaton, but deployed databases still carry the
 * old partner values: system_settings bank/wire endpoints pointing at
 * api.eatonfcu.org, the Eaton bank name, the stored bank/wire API keys for that
 * dead host, and the "Eaton Family CU Trust Checking" GL account label.
 *
 * The funds flow is Platform → Melio → DB NET MGMT (Lili Bank), so direct bank
 * endpoints are cleared rather than repointed: any direct wire/ACH send then
 * fails fast with "endpoint not configured" instead of resolving a dead host.
 *
 * Usage:
 *   DATABASE_URL=... node server/scripts/purgeEatonSettings.js [--dry-run]
 *
 * Secret values are never printed — only whether a key was cleared.
 */

const pool = require('../integrations/bonds/pgPool');

const DRY_RUN = process.argv.includes('--dry-run');

// Endpoint/label settings that pointed at Eaton, plus the credentials issued for
// that endpoint (useless once the endpoint is gone, and unsafe to leave behind).
const CLEARED_SETTINGS = [
  'bank_endpoint',
  'wire_endpoint',
  'bank_name',
  'bank_api_key',
  'wire_api_key',
];

const EATON_PATTERN = '%eaton%';

async function purgeSettings() {
  const { rows } = await pool.query(
    `SELECT key, value FROM system_settings
      WHERE key = ANY($1::text[]) OR value ILIKE $2`,
    [CLEARED_SETTINGS, EATON_PATTERN]
  );
  const targets = rows.filter(row => row.value !== null && row.value !== '');
  const report = targets.map(row => ({
    key: row.key,
    eatonReference: /eaton/i.test(row.value || ''),
    cleared: !DRY_RUN,
  }));
  if (!DRY_RUN && targets.length) {
    await pool.query(
      `UPDATE system_settings
          SET value = '', updated_at = NOW(), updated_by = 'purge-eaton'
        WHERE key = ANY($1::text[])`,
      [targets.map(row => row.key)]
    );
  }
  return report;
}

async function purgeGlAccountLabels() {
  const { rows } = await pool.query(
    `SELECT account_code, account_name, description FROM gl_accounts
      WHERE account_name ILIKE $1 OR description ILIKE $1`,
    [EATON_PATTERN]
  );
  if (!DRY_RUN && rows.length) {
    await pool.query(
      `UPDATE gl_accounts
          SET account_name = 'Trust Checking',
              description = 'Trust operating/checking account (institution configured via TRUST_BANK_* settings)'
        WHERE account_name ILIKE $1 OR description ILIKE $1`,
      [EATON_PATTERN]
    );
  }
  return rows.map(row => ({ accountCode: row.account_code, renamed: !DRY_RUN }));
}

async function main() {
  const settings = await purgeSettings();
  let glAccounts = [];
  try {
    glAccounts = await purgeGlAccountLabels();
  } catch (err) {
    console.warn(`[purge-eaton] gl_accounts skipped: ${err.message}`);
  }
  console.log(JSON.stringify({ dryRun: DRY_RUN, settings, glAccounts }, null, 2));
  await pool.end();
}

main().catch(async (err) => {
  console.error(`[purge-eaton] failed: ${err.message}`);
  try { await pool.end(); } catch { /* pool already closed */ }
  process.exit(1);
});
