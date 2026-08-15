#!/usr/bin/env node
'use strict';

/**
 * OS Engine Smoke Test Runbook
 *
 * Exercises the OS engines (bank, treasury, payment, clearing, settlement,
 * compliance, security, rest-api, bank-aggregator, funding) through the public
 * `/api/os` endpoints and prints a pass/fail report.
 *
 * Usage:
 *   node server/scripts/osEngineSmokeTest.js
 *   ADMIN_SECRET_TOKEN=dlb-admin-2026-trust node server/scripts/osEngineSmokeTest.js
 *   OS_TEST_BASE_URL=https://dlbtrust-app.fly.dev ADMIN_SECRET_TOKEN=... node server/scripts/osEngineSmokeTest.js
 */

const BASE_URL = (process.env.OS_TEST_BASE_URL || 'http://localhost:3002').replace(/\/$/, '');
const TOKEN = process.env.ADMIN_SECRET_TOKEN || 'dlb-admin-2026-trust';
const VERBOSE = process.env.OS_TEST_VERBOSE !== 'false';

const engines = ['bank', 'treasury', 'payment', 'clearing', 'settlement', 'compliance', 'security', 'rest-api', 'bank-aggregator', 'funding'];

const results = [];
let failed = false;

async function call(method, path, body) {
  const url = `${BASE_URL}${path}`;
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': TOKEN,
    },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch { /* ignore */ }

  return { status: res.status, ok: res.ok, body: json || text };
}

function log(step, ok, detail) {
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${step}`);
  if (VERBOSE && detail !== undefined) {
    const printable = typeof detail === 'object' ? JSON.stringify(detail, null, 2) : String(detail);
    console.log(printable.split('\n').map((l) => `    ${l}`).join('\n'));
  }
}

function assert(cond, msg) {
  if (!cond) {
    failed = true;
    throw new Error(msg || 'assertion failed');
  }
}

async function runStep(name, fn) {
  try {
    const detail = await fn();
    log(name, true, detail);
    results.push({ name, ok: true });
  } catch (err) {
    failed = true;
    log(name, false, err.message);
    results.push({ name, ok: false, error: err.message });
  }
}

async function main() {
  console.log(`OS Engine Smoke Test — ${BASE_URL}`);
  console.log(`Engines: ${engines.join(', ')}`);
  console.log('-'.repeat(60));

  // Registry status
  await runStep('GET /api/os (registry)', async () => {
    const { ok, body } = await call('GET', '/api/os');
    assert(ok, `status ${body && body.error ? body.error : 'non-200'}`);
    assert(Array.isArray(body.data), 'expected array of engine statuses');
    const names = body.data.map((e) => e.name).sort();
    const expected = [...engines].sort();
    assert(JSON.stringify(names) === JSON.stringify(expected), `expected engines ${expected.join(', ')}, got ${names.join(', ')}`);
    return `${body.data.length} engines healthy`;
  });

  // Per-engine status and health
  for (const engine of engines) {
    await runStep(`${engine}: status`, async () => {
      const { ok, body } = await call('GET', `/api/os/${engine}/status`);
      assert(ok, body && body.error);
      assert(body.data && body.data.engine === engine, `engine mismatch`);
      return body.data;
    });

    await runStep(`${engine}: health`, async () => {
      const { ok, body } = await call('GET', `/api/os/${engine}/health`);
      assert(ok, body && body.error);
      assert(body.data && body.data.healthy === true, 'not healthy');
      return body.data;
    });
  }

  // Process actions
  const processSteps = [
    { engine: 'bank', action: 'accounts', payload: { bankId: 'SMOKE-BANK' }, expectEvent: true },
    { engine: 'bank', action: 'balance', payload: { bankId: 'SMOKE-BANK', accountId: 'SMOKE-ACCT' } },
    { engine: 'treasury', action: 'position', payload: { accountId: 'TREASURY_HOT' } },
    { engine: 'payment', action: 'listMethods', payload: {} },
    { engine: 'clearing', action: 'list', payload: {} },
    { engine: 'settlement', action: 'list', payload: {} },
    { engine: 'compliance', action: 'screen', payload: { subject: 'ACME Corp' } },
    { engine: 'security', action: 'audit', payload: { actor: 'admin', resource: '/api/os', metadata: { outcome: 'allow' } } },
    { engine: 'rest-api', action: 'createApiKey', payload: { name: 'smoke-test', role: 'operator', scopes: ['os:read'] }, expectKey: true },
    { engine: 'bank-aggregator', action: 'createConnection', payload: { name: 'smoke-test-internal-rails', connectorType: 'internal_rails', direction: 'both', config: {} }, expectEvent: true },
    { engine: 'funding', action: 'buildPlan', payload: { amountUsd: 100, sourceType: 'cash', sourceAccountId: 'CA-BOND-PROCEEDS', targetAsset: 'ETH', strategy: 'auto' } },
  ];

  const bankEventIds = [];
  const apiKeys = [];

  for (const { engine, action, payload, expectEvent, expectKey } of processSteps) {
    await runStep(`${engine}: process ${action}`, async () => {
      const { ok, body } = await call('POST', `/api/os/${engine}/process`, { action, ...payload });
      assert(ok, body && body.error);
      if (expectEvent) {
        assert(body.data && body.data.eventId, 'expected eventId');
        bankEventIds.push({ engine, eventId: body.data.eventId });
      }
      if (expectKey) {
        assert(body.data && body.data.result && body.data.result.apiKey, 'expected apiKey');
        apiKeys.push(body.data.result.apiKey);
      }
      return body.data;
    });
  }

  // List / get for bank using the event logged above
  if (bankEventIds.length) {
    await runStep('bank: list', async () => {
      const { ok, body } = await call('GET', '/api/os/bank/list?limit=5');
      assert(ok, body && body.error);
      assert(Array.isArray(body.data), 'expected array');
      return `${body.data.length} rows`;
    });

    const { eventId } = bankEventIds[0];
    await runStep('bank: get event', async () => {
      const { ok, body } = await call('GET', `/api/os/bank/get/${eventId}`);
      assert(ok, body && body.error);
      assert(body.data && body.data.event_id === eventId, 'event_id mismatch');
      return body.data;
    });
  }

  // Verify audit log does not store plaintext keys (sanity)
  if (apiKeys.length) {
    await runStep('rest-api: verify API key not stored plaintext', async () => {
      const key = apiKeys[0];
      const { ok, body } = await call('GET', '/api/os/rest-api/metrics');
      assert(ok, body && body.error);
      const recent = body.data && Array.isArray(body.data.recent) ? body.data.recent : [];
      const leaked = recent.some((r) => JSON.stringify(r).includes(key));
      assert(!leaked, 'API key leaked into os_events via metrics');
      return 'no plaintext key in metrics';
    });
  }

  console.log('-'.repeat(60));
  const passed = results.filter((r) => r.ok).length;
  console.log(`Results: ${passed}/${results.length} passed`);
  if (failed) {
    console.error('SMOKE TEST FAILED');
    process.exit(1);
  }
  console.log('SMOKE TEST PASSED');
}

main().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
