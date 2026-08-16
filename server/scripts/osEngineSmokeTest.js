#!/usr/bin/env node
'use strict';

/**
 * OS Engine Smoke Test Runbook
 *
 * Exercises the OS engines (bank, treasury, payment, clearing, settlement,
 * compliance, security, rest-api, bookkeeping, cash, asset-acquisition,
 * bank-aggregator, funding, smart-router, back-office, wallet-onramp, alchemy-wallet) through
 * the public `/api/os` endpoints and prints a pass/fail report.
 *
 * Usage:
 *   node server/scripts/osEngineSmokeTest.js
 *   ADMIN_SECRET_TOKEN=dlb-admin-2026-trust node server/scripts/osEngineSmokeTest.js
 *   OS_TEST_BASE_URL=https://dlbtrust-app.fly.dev ADMIN_SECRET_TOKEN=... node server/scripts/osEngineSmokeTest.js
 */

const BASE_URL = (process.env.OS_TEST_BASE_URL || 'http://localhost:3002').replace(/\/$/, '');
const TOKEN = process.env.ADMIN_SECRET_TOKEN || 'dlb-admin-2026-trust';
const VERBOSE = process.env.OS_TEST_VERBOSE !== 'false';

const engines = ['bank', 'treasury', 'payment', 'clearing', 'settlement', 'compliance', 'security', 'rest-api', 'bookkeeping', 'cash', 'asset-acquisition', 'bank-aggregator', 'funding', 'smart-router', 'back-office', 'wallet-onramp', 'alchemy-wallet', 'tokenization', 'conduit'];

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
    { engine: 'bank', action: 'cachedBanks', payload: {}, expectEvent: true },
    { engine: 'bank', action: 'cachedAccounts', payload: { bankId: 'SMOKE-BANK' } },
    { engine: 'treasury', action: 'position', payload: { accountId: 'TREASURY_HOT' } },
    { engine: 'payment', action: 'listMethods', payload: {} },
    { engine: 'clearing', action: 'list', payload: {} },
    { engine: 'settlement', action: 'list', payload: {} },
    { engine: 'compliance', action: 'screen', payload: { subject: 'ACME Corp' } },
    { engine: 'security', action: 'audit', payload: { actor: 'admin', resource: '/api/os', metadata: { outcome: 'allow' } } },
    { engine: 'rest-api', action: 'createApiKey', payload: { name: 'smoke-test', role: 'operator', scopes: ['os:read'] }, expectKey: true },
    { engine: 'bookkeeping', action: 'detectDuplicates', payload: { minAmount: 100 } },
    { engine: 'cash', action: 'listAccounts', payload: {} },
    { engine: 'asset-acquisition', action: 'list', payload: {} },
    { engine: 'bank-aggregator', action: 'createConnection', payload: { name: 'smoke-test-internal-rails', connectorType: 'internal_rails', direction: 'both', config: {} }, expectEvent: true },
    { engine: 'funding', action: 'buildPlan', payload: { amountUsd: 100, sourceType: 'cash', sourceAccountId: 'CA-BOND-PROCEEDS', targetAsset: 'ETH', strategy: 'auto' } },
    { engine: 'smart-router', action: 'route', payload: { amount: 100, currency: 'USD', destination: { type: 'bank', accountNumber: '123456789', routingNumber: '111000025' }, preferred: 'fiat' } },
    { engine: 'smart-router', action: 'deliver', payload: { amount: 100, currency: 'USD', destination: { type: 'bank', accountNumber: '123456789', routingNumber: '111000025' }, preferred: 'fiat', reference: 'SMOKE-SR-1', memo: 'Smoke test' }, capture: 'smartRouterPaymentId' },
    { engine: 'back-office', action: 'treasurySummary', payload: {} },
    { engine: 'back-office', action: 'bankReconciliation', payload: {} },
    { engine: 'back-office', action: 'createDistribution', payload: { beneficiaryEmail: 'beneficiary@example.com', amountUsd: 100, destinationAddress: '0x0000000000000000000000000000000000000000', sourceType: 'cash', sourceAccountId: 'CA-OPERATING', memo: 'Smoke test' }, capture: 'backOfficeRequestId' },
    { engine: 'wallet-onramp', action: 'providers', payload: {} },
    { engine: 'wallet-onramp', action: 'fund', payload: { sourceType: 'cash', sourceAccountId: 'CA-BOND-PROCEEDS', amount: 0.01, asset: 'USDC', targetAddress: '0x69a32f285ced1dbf102c7baedf0266f1d39580a1', sourceMethod: 'manual' }, capture: 'walletOnRampOperationId' },
    { engine: 'alchemy-wallet', action: 'listWallets', payload: {} },
    { engine: 'alchemy-wallet', action: 'getBalances', payload: { address: '0x74204857713CC1d741670505003e7261EF626E98' } },
    { engine: 'alchemy-wallet', action: 'send', payload: { to: '0x69a32f285ced1dbf102c7baedf0266f1d39580a1', amount: '0.0001', asset: 'ETH', dryRun: true } },
    { engine: 'alchemy-wallet', action: 'fundFromSource', payload: { sourceType: 'cash', sourceAccountId: 'CA-BOND-PROCEEDS', amount: 0.01, asset: 'SIT', targetAddress: '0x74204857713CC1d741670505003e7261EF626E98', memo: 'Smoke test internal wallet credit' }, capture: 'alchemyFundingEventId' },
    { engine: 'tokenization', action: 'execute', payload: { sourceType: 'bond_interest', sourceAccountId: '1', amount: 0.01, tokenSymbol: 'DLB-PRB-INT' } },
    { engine: 'conduit', action: 'execute', payload: { sources: [{ sourceType: 'bond_interest', sourceAccountId: '1', amount: 0.01 }], recipient: '0x69a32f285ced1dbf102c7baedf0266f1d39580a1' } },
  ];

  const bankEventIds = [];
  const apiKeys = [];
  let smartRouterPaymentId = null;
  let backOfficeRequestId = null;
  let walletOnRampOperationId = null;
  let alchemyFundingEventId = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const { engine, action, payload, expectEvent, expectKey, capture } of processSteps) {
    await sleep(2500); // stay under the 30 POST/min write rate limiter
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
      if (capture && body.data && body.data.result) {
        if (capture === 'smartRouterPaymentId' && body.data.result.paymentId) smartRouterPaymentId = body.data.result.paymentId;
        if (capture === 'backOfficeRequestId' && body.data.result.id) backOfficeRequestId = body.data.result.id;
        if (capture === 'walletOnRampOperationId' && body.data.result.operationId) walletOnRampOperationId = body.data.result.operationId;
      }
      if (capture && body.data && body.data.eventId) {
        if (capture === 'alchemyFundingEventId') alchemyFundingEventId = body.data.eventId;
      }
      return body.data;
    });
  }

  if (walletOnRampOperationId) {
    await runStep('wallet-onramp: operationId captured', async () => {
      assert(walletOnRampOperationId && walletOnRampOperationId.startsWith('WOR-'), 'expected WOR- operationId');
      return walletOnRampOperationId;
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

  // Back Office distribution follow-up
  if (backOfficeRequestId) {
    await runStep('back-office: listDistributions', async () => {
      const { ok, body } = await call('POST', '/api/os/back-office/process', { action: 'listDistributions', limit: 10 });
      assert(ok, body && body.error);
      assert(Array.isArray(body.data && body.data.result), 'expected result array');
      return `${(body.data.result || []).length} distributions`;
    });

    await runStep('back-office: getDistribution', async () => {
      const { ok, body } = await call('POST', '/api/os/back-office/process', { action: 'getDistribution', requestId: backOfficeRequestId });
      assert(ok, body && body.error);
      assert(body.data && body.data.result && body.data.result.id === backOfficeRequestId, 'requestId mismatch');
      return body.data.result;
    });
  }

  // Smart Router receipt / confirm / get
  if (smartRouterPaymentId) {
    await runStep('smart-router: receipt', async () => {
      const { ok, body } = await call('POST', '/api/os/smart-router/process', { action: 'receipt', paymentId: smartRouterPaymentId });
      assert(ok, body && body.error);
      assert(body.data && body.data.result && body.data.result.receipt && body.data.result.receipt.paymentId === smartRouterPaymentId, 'receipt paymentId mismatch');
      return body.data.result.receipt;
    });

    await runStep('smart-router: confirm', async () => {
      const { ok, body } = await call('POST', '/api/os/smart-router/process', { action: 'confirm', paymentId: smartRouterPaymentId });
      assert(ok, body && body.error);
      assert(body.data && body.data.result && body.data.result.paymentId === smartRouterPaymentId, 'confirm paymentId mismatch');
      return body.data.result;
    });

    await runStep('smart-router: get', async () => {
      const { ok, body } = await call('GET', `/api/os/smart-router/get/${encodeURIComponent(smartRouterPaymentId)}`);
      assert(ok, body && body.error);
      assert(body.data && body.data.id === smartRouterPaymentId, 'get id mismatch');
      return body.data;
    });
  }

  // Alchemy Wallet funding event retrieval
  if (alchemyFundingEventId) {
    await runStep('alchemy-wallet: get event', async () => {
      const { ok, body } = await call('GET', `/api/os/alchemy-wallet/get/${encodeURIComponent(alchemyFundingEventId)}`);
      assert(ok, body && body.error);
      assert(body.data && body.data.event_id === alchemyFundingEventId, 'event_id mismatch');
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
