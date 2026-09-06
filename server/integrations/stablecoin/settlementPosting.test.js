'use strict';

/**
 * Settlement-side GL posting for trust-funded stablecoin payments.
 *
 * Run: node server/integrations/stablecoin/settlementPosting.test.js
 *
 * Uses the real adapter with the trust accounting engine's static methods
 * stubbed, so no database or chain access is needed.
 */

const assert = require('assert');
const { SourceOfFundsAdapter } = require('./sourceOfFundsAdapter');
const { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');

const realList = TrustAccountingEngine.listJournalEntries;
const realPost = TrustAccountingEngine.postJournalEntry;

function stub({ existing = [] } = {}) {
  const calls = [];
  TrustAccountingEngine.listJournalEntries = async () => existing;
  TrustAccountingEngine.postJournalEntry = async (entry) => {
    calls.push(entry);
    return { entry_id: 'JRN-TEST', ...entry };
  };
  return calls;
}

function payment(overrides = {}) {
  return {
    id: 'SCP-TEST-1',
    amount_cents: 10000,
    total_cents: 10025,
    destination_wallet: 'GDESTINATION',
    source_type: 'trust_account',
    source_account_id: '1010',
    source_ref: { assetAccount: '1210' },
    metadata: {},
    ...overrides,
  };
}

function sum(lines, key) {
  return lines.reduce((t, l) => t + Number(l[key] || 0), 0);
}

async function run() {
  // Fee-bearing payment: payee leg, fee expense, and the full backing relief
  let calls = stub();
  await SourceOfFundsAdapter._postTrustSettlementEntry({
    payment: payment(),
    txHash: 'abc123',
    amountCents: 10000,
  });
  assert.strictEqual(calls.length, 1);
  const entry = calls[0];
  assert.strictEqual(entry.referenceType, 'stablecoin_settlement');
  assert.strictEqual(entry.referenceId, 'SCP-TEST-1');
  assert.ok(entry.description.includes('abc123'), 'tx hash belongs in the description');
  assert.strictEqual(entry.lines.length, 3);
  assert.deepStrictEqual(
    entry.lines.map((l) => [l.accountCode, l.debitAmount, l.creditAmount]),
    [['2000', 100, 0], ['5300', 0.25, 0], ['1210', 0, 100.25]],
  );
  assert.strictEqual(sum(entry.lines, 'debitAmount'), sum(entry.lines, 'creditAmount'));

  // Zero-fee payment: two legs only
  calls = stub();
  await SourceOfFundsAdapter._postTrustSettlementEntry({
    payment: payment({ total_cents: 10000 }),
    txHash: 'nofee',
    amountCents: 10000,
  });
  assert.strictEqual(calls[0].lines.length, 2);
  assert.deepStrictEqual(
    calls[0].lines.map((l) => [l.accountCode, l.debitAmount, l.creditAmount]),
    [['2000', 100, 0], ['1210', 0, 100]],
  );

  // Caller-chosen settlement and fee accounts win over the configured defaults
  calls = stub();
  await SourceOfFundsAdapter._postTrustSettlementEntry({
    payment: payment({ metadata: { settlementAccount: '5100', feeAccount: '5000' } }),
    txHash: 'override',
    amountCents: 10000,
  });
  assert.deepStrictEqual(
    calls[0].lines.map((l) => l.accountCode),
    ['5100', '5000', '1210'],
  );

  // Idempotent: a retried settlement must not relieve the backing asset twice
  calls = stub({ existing: [{ entry_id: 'JRN-ALREADY' }] });
  const repeat = await SourceOfFundsAdapter._postTrustSettlementEntry({
    payment: payment(),
    txHash: 'abc123',
    amountCents: 10000,
  });
  assert.strictEqual(calls.length, 0, 'no second journal entry');
  assert.strictEqual(repeat.entry_id, 'JRN-ALREADY');

  // Partial settlement relieves the settled amount plus the fee, still balanced
  calls = stub();
  await SourceOfFundsAdapter._postTrustSettlementEntry({
    payment: payment({ amount_cents: 10000, total_cents: 10025 }),
    txHash: 'partial',
    amountCents: 4000,
  });
  assert.deepStrictEqual(
    calls[0].lines.map((l) => [l.accountCode, l.debitAmount, l.creditAmount]),
    [['2000', 40, 0], ['5300', 0.25, 0], ['1210', 0, 40.25]],
  );
  assert.strictEqual(sum(calls[0].lines, 'debitAmount'), sum(calls[0].lines, 'creditAmount'));

  console.log('Stablecoin settlement posting validation passed');
}

run()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => {
    TrustAccountingEngine.listJournalEntries = realList;
    TrustAccountingEngine.postJournalEntry = realPost;
  });
