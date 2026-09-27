#!/usr/bin/env node
'use strict';

/**
 * Aggregate the trust's Betterment Trust Checking account through the Banking
 * Aggregator (read-only).
 *
 * Betterment exposes no public API, so the account is read through a data
 * aggregator: BankSync (banksync.io, default) after it has been linked in the
 * BankSync dashboard, SimpleFIN (--connector simplefin, the Alderfi bank-data
 * path) after Betterment has been connected in the SimpleFIN Bridge, or Orange
 * Rails (--connector orangerails) after the bank has been linked in Orange
 * Rails' Quiltt widget. This script is idempotent:
 *   1. Ensures the aggregator tables exist.
 *   2. Creates (or reuses) the CONN-BETTERMENT-TRUST-CHECKING connection:
 *        connector banksync, direction inbound, mode live, bankName "Betterment",
 *        pullKinds accounts+transactions (no statements endpoint).
 *   3. Runs / retries the handshake (whoami + bank resolution).
 *   4. With --pull, performs an initial pull so accounts/transactions land in
 *      banking_aggregator_accounts / banking_aggregator_transactions; the
 *      scheduler then feeds them to trust GL / Fineract via DataBridge, which
 *      books this connection as trust principal (config.accounting.creditDefault
 *      = principal: unclassified credits → 3000 Trust Corpus; coupon / interest
 *      credits → 1020 Coupon Cash + 4100 / 4000 income).
 *
 * Credentials: BANKSYNC_API_KEY (workspace key) or
 * AGGREGATOR_BETTERMENT_TRUST_CHECKING_API_KEY (Secret Manager, connection-scoped).
 *
 * Usage:
 *   node server/scripts/aggregateBettermentTrustChecking.js
 *   node server/scripts/aggregateBettermentTrustChecking.js --pull
 *   node server/scripts/aggregateBettermentTrustChecking.js --bank-id bnk_123 --pull
 *   node server/scripts/aggregateBettermentTrustChecking.js --connector simplefin --pull
 *       (SimpleFIN: CONN-BETTERMENT-TRUST-CHECKING-SIMPLEFIN; needs the Access URL
 *        SIMPLEFIN_ACCESS_URL / AGGREGATOR_BETTERMENT_TRUST_CHECKING_SIMPLEFIN_ACCESS_URL.
 *        To obtain it once: create a Setup Token at https://beta-bridge.simplefin.org and run
 *        --connector simplefin --claim-setup-token <token> --claim-to <file>; the Access URL is
 *        written to <file> (mode 0600) for upload to Secret Manager and never printed)
 *   node server/scripts/aggregateBettermentTrustChecking.js --connector orangerails --pull
 *       (Orange Rails: CONN-BETTERMENT-TRUST-CHECKING-ORANGERAILS; needs the platform key
 *        ORANGERAILS_PLATFORM_API_KEY / AGGREGATOR_BETTERMENT_TRUST_CHECKING_ORANGERAILS_API_KEY and
 *        the vault keys ORANGERAILS_CREDENTIALS_KEY + ORANGERAILS_TRANSACTIONS_KEY (or the
 *        per-connection _CREDENTIALS_KEY / _TRANSACTIONS_KEY); link Betterment via
 *        POST /api/aggregator/connections/:id/link-token first)
 */

const fs = require('fs');
const { BankingAggregator } = require('../integrations/aggregator/bankingAggregator');
const { claimSetupToken } = require('../integrations/aggregator/connectors/simpleFinConnector');
const pool = require('../integrations/bonds/pgPool');

const CONNECTION_ID = 'CONN-BETTERMENT-TRUST-CHECKING';
const CONNECTION_NAME = 'Betterment Trust Checking';

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const CONNECTORS = {
  banksync: (o) => Object.assign({ bankName: 'Betterment' }, o.bankId ? { bankId: o.bankId } : {}),
  simplefin: (o) => Object.assign({ orgName: 'Betterment', lookbackDays: 90 },
    o.bankId ? { connId: o.bankId } : {},
    o.accountIds ? { accountIds: o.accountIds } : {}),
  orangerails: (o) => Object.assign({ institutionName: 'Betterment', appUserId: 'dlb-family-trust' },
    o.baseUrl ? { baseUrl: o.baseUrl } : {},
    o.accountIds ? { accountIds: o.accountIds } : {}),
};

async function ensureConnection(o) {
  const connectorType = o.connector || 'banksync';
  if (!CONNECTORS[connectorType]) throw new Error(`--connector must be one of: ${Object.keys(CONNECTORS).join(', ')}`);
  const id = connectorType === 'banksync' ? CONNECTION_ID : `${CONNECTION_ID}-${connectorType.toUpperCase()}`;
  const config = Object.assign({
    mode: o.mode || 'live',
    pullKinds: ['accounts', 'transactions'],
    autoHandshake: false,
    accounting: { creditDefault: 'principal' },
  }, CONNECTORS[connectorType](o));
  const existing = await BankingAggregator.getConnection(id).catch(() => null);
  if (!existing) {
    return BankingAggregator.createConnection({ id, name: CONNECTION_NAME, connectorType, direction: 'inbound', config });
  }
  if (existing.connector_type !== connectorType) throw new Error(`${id} already exists with connector ${existing.connector_type}`);
  return BankingAggregator.updateConnection(id, { active: true, config });
}

async function claimToken(setupToken, outFile) {
  if (!outFile) throw new Error('--claim-setup-token requires --claim-to <file> (the Access URL is a secret and is never printed)');
  const accessUrl = await claimSetupToken(setupToken);
  fs.writeFileSync(outFile, accessUrl + '\n', { mode: 0o600 });
  console.log(`SimpleFIN Access URL claimed and written to ${outFile}. Store it as Secret Manager SIMPLEFIN_ACCESS_URL and mount it on Cloud Run; the Setup Token is now spent.`);
}

async function main() {
  const doPull = process.argv.includes('--pull');
  const setupToken = arg('--claim-setup-token');
  if (setupToken) {
    await claimToken(setupToken, arg('--claim-to'));
    if (!process.env.SIMPLEFIN_ACCESS_URL) {
      console.log('Re-run with SIMPLEFIN_ACCESS_URL set to seed the connection and handshake.');
      return;
    }
  }
  const accountIds = arg('--account-ids');
  const conn = await ensureConnection({
    connector: arg('--connector'),
    bankId: arg('--bank-id'),
    mode: arg('--mode'),
    baseUrl: arg('--base-url'),
    accountIds: accountIds ? accountIds.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  });
  const id = conn.id;
  console.log(`connection ${conn.id} (${conn.connector_type}, ${conn.direction}, mode=${conn.mode}) handshake=${conn.handshake_state}`);

  const hs = await BankingAggregator.handshake(id);
  console.log(`handshake: ${hs.handshake_state}` + (hs.external_connection_id ? ` bank=${hs.external_connection_id}` : '')
    + (hs.error ? ` error=${hs.error}` : ''));
  if (hs.handshake_state !== 'verified') {
    console.log('Betterment is not readable yet. Fix the error above (provider plan/API access, link Betterment with the provider, credentials) and re-run.');
    process.exitCode = 2;
    return;
  }

  if (doPull) {
    const summary = await BankingAggregator.pull(id);
    console.log(`pull: accounts=${summary.accounts} transactions=${summary.transactions}`
      + (summary.errors.length ? ` errors=${JSON.stringify(summary.errors)}` : ''));
    if (summary.errors.length) process.exitCode = 2;
  }
}

main()
  .catch((err) => { console.error('aggregateBettermentTrustChecking failed:', err.message); process.exitCode = 1; })
  .finally(() => pool.end && pool.end().catch(() => {}));
