'use strict';

/**
 * Treasury Prime validation — run with:
 *   node server/integrations/treasuryprime/treasuryPrime.test.js
 *
 * No network and no database: the client's fetch is stubbed so the request
 * payloads can be asserted directly. The point is proving amounts stay
 * decimal strings and never become floats.
 */

const assert = require('assert');
const decimal = require('./decimalAmount');
const client = require('./treasuryPrimeClient');

function testDecimalAmounts() {
  assert.strictEqual(decimal.normalizeAmount('250'), '250.00');
  assert.strictEqual(decimal.normalizeAmount('250.5'), '250.50');
  assert.strictEqual(decimal.normalizeAmount('  250.00  '), '250.00');
  assert.strictEqual(decimal.normalizeAmount('-0.05'), '-0.05');
  assert.strictEqual(decimal.normalizeAmount(0), '0.00');

  assert.throws(() => decimal.normalizeAmount('250.005'), /at most 2 decimal places/);
  assert.throws(() => decimal.normalizeAmount('$250.00'), /decimal string/);
  assert.throws(() => decimal.normalizeAmount(''), /required/);
  assert.throws(() => decimal.normalizeAmount(null), /required/);

  // Exact arithmetic — the classic float traps must not appear.
  assert.strictEqual(decimal.addAmounts('250.00', '0.10'), '250.10');
  assert.strictEqual(decimal.subtractAmounts('0.30', '0.10'), '0.20');
  assert.strictEqual(decimal.addAmounts('0.10', '0.20'), '0.30');
  assert.strictEqual(decimal.subtractAmounts('4725.00', '4750.00'), '-25.00');
  assert.strictEqual(decimal.addAmounts('99999999.99', '0.01'), '100000000.00');
  assert.strictEqual(decimal.absAmount('-25.00'), '25.00');
  assert.strictEqual(decimal.negateAmount('25.00'), '-25.00');

  // Comparison must be numeric, not lexical ("9.00" > "10.00" as strings).
  assert.strictEqual(decimal.compareAmounts('9.00', '10.00'), -1);
  assert.strictEqual(decimal.compareAmounts('250.00', '250.0'), 0);
  assert.strictEqual(decimal.compareAmounts('250.01', '250.00'), 1);
  assert.strictEqual(decimal.isPositiveAmount('0.01'), true);
  assert.strictEqual(decimal.isPositiveAmount('0.00'), false);
  assert.strictEqual(decimal.isZeroAmount('-0.00'), true);

  // Postgres NUMERIC round trip and unparseable upstream values.
  assert.strictEqual(decimal.coerceAmount('4725.0000'), '4725.00');
  assert.strictEqual(decimal.coerceAmount('250'), '250.00');
  assert.strictEqual(decimal.coerceAmount(null), null);
  assert.strictEqual(decimal.coerceAmount('not-money'), null);
  assert.strictEqual(decimal.isValidAmount('250.00'), true);
  assert.strictEqual(decimal.isValidAmount(250), false);
}

/** Capture the body the client would send, without any network call. */
function withStubbedFetch(response, fn) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, method: options.method, headers: options.headers, body: options.body ? JSON.parse(options.body) : undefined });
    return { ok: true, status: 200, text: async () => JSON.stringify(response) };
  };
  return Promise.resolve(fn(calls)).finally(() => { global.fetch = original; });
}

async function testClientPayloads() {
  process.env.TREASURY_PRIME_API_KEY_ID = 'key_test_001';
  process.env.TREASURY_PRIME_API_SECRET = 'secret_test';
  delete process.env.TREASURY_PRIME_BASE_URL;

  assert.strictEqual(client.isConfigured(), true);
  assert.strictEqual(client.baseUrl(), client.SANDBOX_BASE_URL);
  assert.strictEqual(client.isProduction(), false);

  await withStubbedFetch({ id: 'book_1', amount: '250.00', status: 'sent' }, async (calls) => {
    await client.createBookTransfer({ amount: '250', fromAccountId: 'acct_a', toAccountId: 'acct_b', memo: 'sweep' });
    assert.deepStrictEqual(calls[0].body, {
      amount: '250.00', from_account_id: 'acct_a', to_account_id: 'acct_b', memo: 'sweep',
    });
    assert.strictEqual(typeof calls[0].body.amount, 'string');
    assert.strictEqual(calls[0].headers.Authorization, `Basic ${Buffer.from('key_test_001:secret_test').toString('base64')}`);
  });

  await withStubbedFetch({ id: 'ach_1', status: 'pending' }, async (calls) => {
    await client.createAch({ amount: '25.5', direction: 'credit', accountId: 'acct_a', counterpartyId: 'cp_1', entryDesc: 'TRUST FEE' });
    assert.deepStrictEqual(calls[0].body, {
      amount: '25.50', direction: 'credit', account_id: 'acct_a', counterparty_id: 'cp_1', sec_code: 'ccd', entry_desc: 'TRUST FEE',
    });
  });

  await withStubbedFetch({ id: 'wire_1', status: 'pending' }, async (calls) => {
    await client.createWire({ amount: '100', accountId: 'acct_a', counterpartyId: 'cp_2', memo: 'distribution' });
    assert.deepStrictEqual(calls[0].body, {
      amount: '100.00', account_id: 'acct_a', counterparty_id: 'cp_2', memo: 'distribution',
    });
  });

  // Payment instructions must be nested; a flat shape is rejected upstream.
  await withStubbedFetch({ id: 'cp_1' }, async (calls) => {
    await client.createCounterparty({
      nameOnAccount: 'DLB Trust Operating',
      ach: { accountNumber: '123456789', routingNumber: '021000021' },
      wire: {
        accountNumber: '123456789',
        routingNumber: '021000021',
        addressOnAccount: { street_line_1: '1 Main St', city: 'Austin', state: 'TX', postal_code: '78701' },
      },
    });
    assert.strictEqual(calls[0].body.name_on_account, 'DLB Trust Operating');
    assert.strictEqual(calls[0].body.ach.account_type, 'checking');
    assert.strictEqual(calls[0].body.wire.address_on_account.city, 'Austin');
  });

  assert.throws(() => client.createAch({ amount: '1.00', direction: 'sideways', accountId: 'a', counterpartyId: 'c' }), /direction must be/);
  assert.throws(() => client.createBookTransfer({ amount: '1.00', fromAccountId: 'a' }), /required/);
  assert.throws(() => client.createCounterparty({ nameOnAccount: 'x' }), /ach or wire/);
  assert.throws(() => client.createCounterparty({ nameOnAccount: 'x', wire: { accountNumber: '1', routingNumber: '2' } }), /addressOnAccount/);

  // Upstream errors surface even on an HTTP 200 with an error body.
  const original = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => '{"error":"Missing required parameter: name_on_account"}' });
  await assert.rejects(client.ping(), /Missing required parameter/);
  global.fetch = original;

  delete process.env.TREASURY_PRIME_API_KEY_ID;
  delete process.env.TREASURY_PRIME_API_SECRET;
  assert.strictEqual(client.isConfigured(), false);
  await assert.rejects(client.ping(), /not configured/);
}

async function testEngineGuards() {
  process.env.TREASURY_PRIME_API_KEY_ID = 'key_test_001';
  process.env.TREASURY_PRIME_API_SECRET = 'secret_test';
  const { TreasuryPrimeEngine } = require('./treasuryPrimeEngine');

  const accountResponse = {
    id: 'acct_a', name: 'Operating', account_type: 'checking',
    available_balance: '4725.00', current_balance: '4975.00',
  };

  await withStubbedFetch(accountResponse, async () => {
    const account = await TreasuryPrimeEngine.getAccount('acct_a');
    assert.strictEqual(account.availableBalance, '4725.00');
    assert.strictEqual(account.currentBalance, '4975.00');
    assert.strictEqual(typeof account.availableBalance, 'string');
  });

  await withStubbedFetch(accountResponse, async () => {
    const ok = await TreasuryPrimeEngine.assertSufficientFunds('acct_a', '4725.00');
    assert.deepStrictEqual(ok, { checked: true, availableBalance: '4725.00' });
    await assert.rejects(
      TreasuryPrimeEngine.assertSufficientFunds('acct_a', '4725.01'),
      /Insufficient available balance/,
    );
  });

  await withStubbedFetch(accountResponse, async () => {
    await assert.rejects(
      TreasuryPrimeEngine.initiateBookTransfer({ amount: '0.00', fromAccountId: 'acct_a', toAccountId: 'acct_b' }),
      /greater than 0.00/,
    );
    await assert.rejects(
      TreasuryPrimeEngine.initiateBookTransfer({ amount: '1.00', fromAccountId: 'acct_a', toAccountId: 'acct_a' }),
      /must differ/,
    );
    await assert.rejects(
      TreasuryPrimeEngine.initiateWire({ amount: '10000.00', accountId: 'acct_a', counterpartyId: 'cp_1' }),
      /Insufficient available balance/,
    );
  });

  await withStubbedFetch({ ping: 'pong', api_version: '1', time: '2026-08-13T00:00:00Z' }, async () => {
    const status = await TreasuryPrimeEngine.getStatus();
    assert.strictEqual(status.configured, true);
    assert.strictEqual(status.reachable, true);
    assert.strictEqual(status.environment, 'sandbox');
    assert.strictEqual(status.amountFormat, 'decimal-string');
  });

  const transfer = await TreasuryPrimeEngine.recordTransfer('ach', {
    id: 'ach_1', amount: '25.00', direction: 'credit', account_id: 'acct_a',
    counterparty_id: 'cp_1', status: 'pending', bankdata: { hold_id: 'ttx_1' },
  });
  assert.strictEqual(transfer.amount, '25.00');
  assert.strictEqual(transfer.status, 'pending');
  assert.strictEqual(transfer.holdTransactionId, 'ttx_1');
  await assert.rejects(TreasuryPrimeEngine.refreshTransfer('cheque', 'x'), /kind must be one of/);
  await assert.rejects(TreasuryPrimeEngine.lookupRoutingNumber('12345'), /9 digits/);

  delete process.env.TREASURY_PRIME_API_KEY_ID;
  delete process.env.TREASURY_PRIME_API_SECRET;
}

async function main() {
  const originalEnv = { ...process.env };
  try {
    testDecimalAmounts();
    await testClientPayloads();
    await testEngineGuards();
    console.log('Treasury Prime validation passed');
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
