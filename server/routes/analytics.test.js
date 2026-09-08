#!/usr/bin/env node
/**
 * Exercises the analytics routes against a seeded Postgres schema, so the
 * SQLite → Postgres rewrite is checked on real SQL rather than mocks.
 * Needs a reachable Postgres (DATABASE_URL or FINERACT_DB_* env); writes only
 * into the throwaway schema named below.
 *
 *   node server/routes/analytics.test.js
 */

'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');

const SCHEMA = 'legacy_sqlite_routes_test';
process.env.LEGACY_SQLITE_SCHEMA = SCHEMA;

const express = require('express');
const pool = require(path.join(__dirname, '..', 'integrations', 'bonds', 'pgPool'));

async function seed() {
  await pool.query('DROP SCHEMA IF EXISTS ' + SCHEMA + ' CASCADE');
  await pool.query('CREATE SCHEMA ' + SCHEMA);
  await pool.query(`
    CREATE TABLE ${SCHEMA}.wallets (
      id bigint PRIMARY KEY,
      name text,
      role text,
      fiat_balance bigint,
      created_at text,
      wallet_id text,
      holder_name text,
      public_address text,
      updated_at text,
      currency text,
      email text,
      phone text,
      status text
    );
    CREATE TABLE ${SCHEMA}.transactions (
      id bigint PRIMARY KEY,
      category text,
      description text,
      amount bigint,
      payment_method text,
      from_wallet_id text,
      to_wallet_id text,
      status text,
      created_at text
    );
  `);
  await pool.query(`
    INSERT INTO ${SCHEMA}.wallets (id, name, role, fiat_balance, wallet_id, email, phone, holder_name, currency, status)
    VALUES
      (1, 'Trust Entity', 'trust_entity', 50000000, 'W-TRUST', 'trust@example.com', '555-0100', 'DLB Trust', 'USD', 'active'),
      (2, 'Bob', 'beneficiary', 2500000, 'W-BOB', 'bob@example.com', NULL, NULL, 'USD', 'active'),
      (3, 'Jane', 'beneficiary', 1000000, 'W-JANE', NULL, NULL, 'Jane B', 'USD', 'active')
  `);
  await pool.query(`
    INSERT INTO ${SCHEMA}.transactions (id, category, description, amount, payment_method, from_wallet_id, to_wallet_id, status, created_at)
    VALUES
      (1, 'corpus',       'Initial funding',  50000000, 'wire', NULL,      'W-TRUST', 'completed', '2025-01-15T10:00:00Z'),
      (2, 'distribution', 'Tuition',         -2500000,  'ach',  'W-TRUST', 'W-BOB',   'completed', '2025-03-20T10:00:00Z'),
      (3, 'distribution', 'Living expenses', -1000000,  'ach',  'W-TRUST', 'W-JANE',  'completed', '2026-02-10T10:00:00Z'),
      (4, 'interest',     'Bond coupon',      120000,   'book', NULL,      'W-TRUST', 'completed', '2026-02-28T10:00:00Z'),
      (5, 'fee',          'Management fee',  -50000,    'book', 'W-TRUST', NULL,      'completed', '2026-03-01T10:00:00Z'),
      (6, 'distribution', 'Pending draw',    -400000,   'ach',  'W-TRUST', 'W-GHOST', 'pending',   '2026-03-05T10:00:00Z')
  `);
}

function startServer() {
  const app = express();
  app.use('/api/analytics', require('./analytics'));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function get(port, url) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (err) {
          reject(new Error('non-JSON response from ' + url + ': ' + body.slice(0, 200)));
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    console.log('skipped: no Postgres reachable (' + err.message + ')');
    return;
  }

  await pool.query('DROP SCHEMA IF EXISTS ' + SCHEMA + ' CASCADE');
  let server = await startServer();
  let port = server.address().port;

  const missing = await get(port, '/api/analytics/summary');
  assert.strictEqual(missing.status, 503, 'unmigrated schema answers 503, not 500');
  assert.match(missing.body.detail, /migrateSqliteToPostgres/, '503 names the migration to run');
  console.log('  ✓ reports 503 with the migration command when the ledger is missing');

  await new Promise((r) => server.close(r));
  await seed();
  server = await startServer();
  port = server.address().port;

  const summary = await get(port, '/api/analytics/summary');
  assert.strictEqual(summary.status, 200);
  assert.strictEqual(summary.body.portfolio.total_cents, 53500000, 'balances sum as numbers, not concatenated strings');
  assert.strictEqual(summary.body.portfolio.total_usd, 535000);
  assert.strictEqual(summary.body.portfolio.total_wallets, 3);
  assert.strictEqual(summary.body.transactions.net_flow_cents, 50120000 - 3550000, 'net flow subtracts, not string-concatenates');
  assert.strictEqual(summary.body.distributions.count, 2, 'pending distributions excluded');
  assert.strictEqual(summary.body.distributions.total_cents, 3500000);
  assert.strictEqual(summary.body.corpus.original_cents, 50000000);
  assert.strictEqual(summary.body.interest_income.total_cents, 120000);
  assert.strictEqual(summary.body.management_fees.total_cents, 50000);
  assert.strictEqual(summary.body.inception_date, '2025-01-15T10:00:00Z');
  console.log('  ✓ summary aggregates cents arithmetically');

  const wallets = await get(port, '/api/analytics/wallets');
  const bob = wallets.body.wallets.find((w) => w.wallet_id === 'W-BOB');
  assert.strictEqual(wallets.body.count, 3);
  assert.strictEqual(bob.total_received_cents, 2500000);
  assert.strictEqual(bob.total_sent_cents, 0);
  assert.strictEqual(bob.transaction_count, 1);
  assert.strictEqual(bob.last_activity, '2025-03-20T10:00:00Z');
  console.log('  ✓ per-wallet inflow/outflow and last activity');

  const filtered = await get(port, '/api/analytics/transactions?category=distribution&from=2026-01-01&limit=1');
  assert.strictEqual(filtered.body.total_count, 2, 'date filter slices the ISO string');
  assert.strictEqual(filtered.body.transactions.length, 1, 'limit applies');
  assert.strictEqual(filtered.body.transactions[0].direction, 'debit');
  assert.deepStrictEqual(filtered.body.monthly_flows.map((m) => m.month), ['2026-02', '2026-03']);
  console.log('  ✓ transactions filter by date and group by month');

  const beneficiaries = await get(port, '/api/analytics/beneficiaries');
  assert.strictEqual(beneficiaries.body.count, 2);
  assert.strictEqual(beneficiaries.body.total_balance_cents, 3500000);
  const jane = beneficiaries.body.beneficiaries.find((b) => b.wallet_id === 'W-JANE');
  assert.strictEqual(jane.total_received_cents, 1000000);
  assert.strictEqual(jane.net_position_cents, 1000000);
  assert.deepStrictEqual(jane.payment_methods_used, { ach: 1 });
  assert.strictEqual(jane.recent_transactions[0].amount_cents, -1000000);
  console.log('  ✓ beneficiary flows, methods and recent transactions');

  const ach = await get(port, '/api/analytics/ach-readiness');
  assert.strictEqual(ach.status, 200, 'missing bank columns must not fail the endpoint');
  assert.strictEqual(ach.body.summary.total_beneficiaries, 2);
  assert.strictEqual(ach.body.summary.ach_ready_count, 0);
  const achJane = ach.body.all_users.find((u) => u.wallet_id === 'W-JANE');
  assert.deepStrictEqual(achJane.blockers, ['email', 'phone', 'routing_number', 'bank_account']);
  console.log('  ✓ ACH readiness degrades when bank columns are absent');

  const distributions = await get(port, '/api/analytics/distributions?year=2026');
  assert.strictEqual(distributions.body.count, 1, 'year filter slices the ISO string');
  assert.strictEqual(distributions.body.total_cents, 1000000);
  assert.deepStrictEqual(distributions.body.by_year.map((y) => y.year), ['2025', '2026']);
  assert.deepStrictEqual(distributions.body.by_period.map((p) => p.month), ['03', '02']);
  console.log('  ✓ distributions group by year and month');

  const quality = await get(port, '/api/analytics/data-quality');
  assert.strictEqual(quality.body.user_profile_quality.total_users, 3);
  assert.deepStrictEqual(quality.body.user_profile_quality.missing_fields, { email: 1, phone: 2, holder_name: 1 });
  assert.strictEqual(quality.body.transaction_quality.orphaned_to_wallet, 1, 'W-GHOST is orphaned');
  assert.strictEqual(quality.body.transaction_quality.orphaned_from_wallet, 0);
  console.log('  ✓ data quality counts missing fields and orphans');

  const gl = await get(port, '/api/analytics/gl-summary');
  assert.strictEqual(gl.status, 200);
  if (gl.body.source === 'legacy_ledger_fallback') {
    assert.strictEqual(gl.body.total_assets, 535000);
    assert.strictEqual(gl.body.income_usd, 1200);
    console.log('  ✓ GL summary falls back to the migrated ledger');
  } else {
    console.log('  ✓ GL summary served by Fineract (fallback not exercised)');
  }

  await new Promise((r) => server.close(r));
  await pool.query('DROP SCHEMA IF EXISTS ' + SCHEMA + ' CASCADE');
  console.log('analytics routes: all checks passed');
}

main()
  .catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    if (typeof pool.end === 'function') pool.end().catch(() => {});
  });
