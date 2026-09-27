#!/usr/bin/env node
'use strict';

/**
 * Aggregate the trust's Betterment Trust Checking account through the Banking
 * Aggregator (read-only, BankSync connector).
 *
 * Betterment exposes no public API, so the account is read through a data
 * aggregator: BankSync (banksync.io, default) after it has been linked in the
 * BankSync dashboard, or Plaid (--connector plaid) after Plaid Link. This
 * script is idempotent:
 *   1. Ensures the aggregator tables exist.
 *   2. Creates (or reuses) the CONN-BETTERMENT-TRUST-CHECKING connection:
 *        connector banksync, direction inbound, mode live, bankName "Betterment",
 *        pullKinds accounts+transactions (no statements endpoint).
 *   3. Runs / retries the handshake (whoami + bank resolution).
 *   4. With --pull, performs an initial pull so accounts/transactions land in
 *      banking_aggregator_accounts / banking_aggregator_transactions; the
 *      scheduler then feeds them to trust GL / Fineract via DataBridge.
 *
 * Credentials: BANKSYNC_API_KEY (workspace key) or
 * AGGREGATOR_BETTERMENT_TRUST_CHECKING_API_KEY (Secret Manager, connection-scoped).
 *
 * Usage:
 *   node server/scripts/aggregateBettermentTrustChecking.js
 *   node server/scripts/aggregateBettermentTrustChecking.js --pull
 *   node server/scripts/aggregateBettermentTrustChecking.js --bank-id bnk_123 --pull
 *   node server/scripts/aggregateBettermentTrustChecking.js --connector plaid --pull
 *       (Plaid: CONN-BETTERMENT-TRUST-CHECKING-PLAID; needs PLAID_CLIENT_ID/PLAID_SECRET and the
 *        Link access token as AGGREGATOR_BETTERMENT_TRUST_CHECKING_ACCESS_TOKEN / PLAID_ACCESS_TOKEN)
 */

const { BankingAggregator } = require('../integrations/aggregator/bankingAggregator');
const pool = require('../integrations/bonds/pgPool');

const CONNECTION_ID = 'CONN-BETTERMENT-TRUST-CHECKING';
const CONNECTION_NAME = 'Betterment Trust Checking';

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const CONNECTORS = {
  banksync: (o) => Object.assign({ bankName: 'Betterment' }, o.bankId ? { bankId: o.bankId } : {}),
  plaid: (o) => Object.assign({ env: o.plaidEnv || process.env.PLAID_ENV || 'production' },
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
  }, CONNECTORS[connectorType](o));
  const existing = await BankingAggregator.getConnection(id).catch(() => null);
  if (!existing) {
    return BankingAggregator.createConnection({ id, name: CONNECTION_NAME, connectorType, direction: 'inbound', config });
  }
  if (existing.connector_type !== connectorType) throw new Error(`${id} already exists with connector ${existing.connector_type}`);
  return BankingAggregator.updateConnection(id, { active: true, config });
}

async function main() {
  const doPull = process.argv.includes('--pull');
  const accountIds = arg('--account-ids');
  const conn = await ensureConnection({
    connector: arg('--connector'),
    bankId: arg('--bank-id'),
    mode: arg('--mode'),
    plaidEnv: arg('--plaid-env'),
    accountIds: accountIds ? accountIds.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  });
  const id = conn.id;
  console.log(`connection ${conn.id} (${conn.connector_type}, ${conn.direction}, mode=${conn.mode}) handshake=${conn.handshake_state}`);

  const hs = await BankingAggregator.handshake(id);
  console.log(`handshake: ${hs.handshake_state}` + (hs.external_connection_id ? ` bank=${hs.external_connection_id}` : '')
    + (hs.error ? ` error=${hs.error}` : ''));
  if (hs.handshake_state !== 'verified') {
    console.log('Betterment is not readable yet. Fix the error above (BankSync plan/API access, link Betterment in BankSync, credentials) and re-run.');
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
