#!/usr/bin/env node
/**
 * Provision the two segregated Treasury-Core ERP cash accounts that back the
 * allocation buckets (server/integrations/dapp/trustAllocationEngine.js):
 *
 *   1020  Coupon Income Cash — beneficiary support   -> coupon_income
 *   1030  Trust Operating Cash — trustees            -> trust_operating
 *   1025  Coupon Income — Treasury Wallet USDC       -> coupon_income (Spritz on-ramp)
 *   1035  Trust Operating — Treasury Wallet USDC     -> trust_operating (Spritz on-ramp)
 *
 * Each account is created in the local chart (trust_accounts), mirrored as a
 * DETAIL asset account in Fineract, and mapped in fineract_gl_mappings so
 * CanonicalFundingSource can read the canonical balance and post to both
 * books. Idempotent: re-running only fills in what is missing.
 *
 * Usage:
 *   node server/scripts/provision-funding-buckets.js [--dry-run]
 *
 * Afterwards set COUPON_INCOME_GL_ACCOUNT_CODE=1020 and
 * TRUST_OPERATING_GL_ACCOUNT_CODE=1030 in the runtime environment.
 */

'use strict';

const path = require('path');
const { FineractClient, GL_USAGE_DETAIL } = require(path.join(__dirname, '..', 'integrations', 'fineract', 'fineractClient'));
const { ACCOUNTS } = require(path.join(__dirname, '..', 'integrations', 'accounting', 'dataBridge'));
const { TrustAllocationEngine } = require(path.join(__dirname, '..', 'integrations', 'dapp', 'trustAllocationEngine'));
const pool = require(path.join(__dirname, '..', 'integrations', 'bonds', 'pgPool'));

const FINERACT_ASSET = 1;
const FINERACT_DETAIL = GL_USAGE_DETAIL;

const BUCKET_ACCOUNTS = [
  { bucket: 'coupon_income', code: ACCOUNTS.COUPON_CASH, name: 'Coupon Income Cash — Beneficiary Support' },
  { bucket: 'trust_operating', code: ACCOUNTS.OPERATING_CASH, name: 'Trust Operating Cash — Trustees' },
  { bucket: 'coupon_income', code: ACCOUNTS.COUPON_WALLET_USDC, name: 'Coupon Income — Treasury Wallet USDC', wallet: true },
  { bucket: 'trust_operating', code: ACCOUNTS.OPERATING_WALLET_USDC, name: 'Trust Operating — Treasury Wallet USDC', wallet: true },
];

async function ensureLocal(acct, dryRun) {
  const { rows } = await pool.query('SELECT account_code, account_name FROM trust_accounts WHERE account_code = $1', [acct.code]);
  if (rows.length) return { created: false, row: rows[0] };
  if (!dryRun) {
    await pool.query(
      'INSERT INTO trust_accounts (account_code, account_name, account_type, sub_type) VALUES ($1, $2, $3, $4)',
      [acct.code, acct.name, 'asset', 'cash']
    );
  }
  return { created: true, row: { account_code: acct.code, account_name: acct.name } };
}

async function ensureFineract(acct, existing, dryRun) {
  const found = existing.find((a) => a.glCode === acct.code);
  const postable = found && found.usage && Number(found.usage.id) === FINERACT_DETAIL;
  if (found && postable) return { created: false, id: found.id };
  if (dryRun) return { created: true, id: null, repaired: Boolean(found) };
  if (found) await FineractClient.deleteGLAccount(found.id);
  const result = await FineractClient.createGLAccount({
    name: acct.name,
    glCode: acct.code,
    type: FINERACT_ASSET,
    usage: FINERACT_DETAIL,
    description: `Segregated funding bucket ${acct.bucket}: ${acct.name}`,
  });
  return { created: true, id: result.resourceId || result.id, repaired: Boolean(found) };
}

async function ensureMapping(acct, fineractGlId, dryRun) {
  const { rows } = await pool.query(
    `SELECT fineract_gl_id FROM fineract_gl_mappings WHERE mapping_type = 'trust_journal' AND trust_account_code = $1`,
    [acct.code]
  );
  if (rows.length && Number(rows[0].fineract_gl_id) === Number(fineractGlId)) return { created: false };
  if (dryRun || fineractGlId === null) return { created: true };
  if (rows.length) {
    await pool.query(
      `UPDATE fineract_gl_mappings SET fineract_gl_id = $1, description = $2, updated_at = NOW()
        WHERE mapping_type = 'trust_journal' AND trust_account_code = $3`,
      [fineractGlId, `${acct.name} (asset)`, acct.code]
    );
  } else {
    await pool.query(
      `INSERT INTO fineract_gl_mappings (mapping_type, trust_account_code, fineract_gl_id, description) VALUES ('trust_journal', $1, $2, $3)`,
      [acct.code, fineractGlId, `${acct.name} (asset)`]
    );
  }
  return { created: true };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`[buckets] Provisioning segregated ERP cash accounts${dryRun ? ' (dry run)' : ''}\n`);

  let fineractAccounts = [];
  let fineractOk = true;
  try {
    await FineractClient.healthCheck();
    fineractAccounts = await FineractClient.getGLAccounts();
    if (!Array.isArray(fineractAccounts)) fineractAccounts = [];
  } catch (err) {
    fineractOk = false;
    console.warn(`[buckets] Fineract unreachable (${err.message}); local chart only, mappings skipped`);
  }

  const summary = [];
  for (const acct of BUCKET_ACCOUNTS) {
    const local = await ensureLocal(acct, dryRun);
    console.log(`  ${acct.code} ${acct.name}: local ${local.created ? 'created' : 'exists'}`);
    let fineract = { created: false, id: null };
    let mapping = { created: false };
    if (fineractOk) {
      fineract = await ensureFineract(acct, fineractAccounts, dryRun);
      console.log(`       fineract GL ${fineract.created ? 'created' : fineract.repaired ? 'exists, set to DETAIL (postable)' : 'exists'}${fineract.id !== null ? ` (id ${fineract.id})` : ''}`);
      mapping = await ensureMapping(acct, fineract.id, dryRun);
      console.log(`       mapping ${mapping.created ? 'written' : 'exists'}`);
    }
    const b = TrustAllocationEngine.bucket(acct.bucket);
    summary.push(acct.wallet
      ? { bucket: acct.bucket, code: acct.code, env: b.walletGlEnv, fineractGlId: fineract.id, configured: TrustAllocationEngine.walletGlAccountCode(acct.bucket) === acct.code }
      : { bucket: acct.bucket, code: acct.code, env: b.glEnv, fineractGlId: fineract.id, configured: TrustAllocationEngine.glAccountCode(acct.bucket) === acct.code });
  }

  console.log('\n[buckets] Runtime configuration:');
  for (const s of summary) {
    console.log(`  ${s.env}=${s.code}${s.configured ? '  (set)' : '  (NOT SET — add to the runtime env)'}`);
  }
  console.log(`\n[buckets] Wallet accounts ${ACCOUNTS.COUPON_WALLET_USDC}/${ACCOUNTS.OPERATING_WALLET_USDC} hold bucket cash the Spritz on-ramp converted to USDC in the treasury wallet (defaults apply when the env is unset).`);
  console.log(`\n[buckets] Segregation: ${BUCKET_ACCOUNTS[0].code} funds beneficiaries only, ${BUCKET_ACCOUNTS[1].code} funds trustee operating only; cross-bucket use is refused with ALLOCATION_SOURCE_MISMATCH.`);
  return summary;
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => { console.error(`\n[buckets] ${err.message}`); process.exit(1); });
}

module.exports = { main, BUCKET_ACCOUNTS };
