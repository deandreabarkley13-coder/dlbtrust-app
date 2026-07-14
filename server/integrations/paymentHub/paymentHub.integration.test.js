'use strict';

const assert = require('assert');

if (!process.env.DATABASE_URL || !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)) {
  throw new Error('Payment Hub integration tests require a local DATABASE_URL');
}

process.env.NODE_ENV = 'test';
process.env.PAYMENT_HUB_MODE = 'shadow';
process.env.PAYMENT_APPROVAL_THRESHOLD = '1';
process.env.PAYMENT_ALLOW_SELF_APPROVAL = 'true';
process.env.PAYMENT_DATA_ENCRYPTION_KEY = '22'.repeat(32);

const pool = require('../bonds/pgPool');
const { PaymentHubEngine } = require('./paymentHubEngine');
const ElectronicSettlementEngine = require('../payments/electronicSettlementEngine');
const { VendorEngine } = require('../vendors/vendorEngine');
const { WireEngine } = require('../wire/wireEngine');

async function createAccountingSchema() {
  await pool.query(`
    DROP TABLE IF EXISTS wire_audit_log, wire_transfers, vendor_payments, vendors,
      electronic_settlements, payment_webhook_receipts, payment_funding_holds,
      payment_events, payment_approvals, payment_intents, trust_journal_lines,
      trust_journal_entries, cashflow_events, trust_accounts CASCADE;
    CREATE TABLE trust_accounts (
      account_code TEXT PRIMARY KEY,
      account_name TEXT NOT NULL,
      account_type TEXT NOT NULL,
      balance NUMERIC(18,2) NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE trust_journal_entries (
      id BIGSERIAL PRIMARY KEY,
      entry_id TEXT UNIQUE NOT NULL,
      entry_date DATE NOT NULL,
      description TEXT NOT NULL,
      reference_type TEXT,
      reference_id TEXT,
      bond_id BIGINT,
      posted_by TEXT,
      fineract_txn_id TEXT,
      status TEXT NOT NULL DEFAULT 'posted',
      reversal_of TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE trust_journal_lines (
      id BIGSERIAL PRIMARY KEY,
      entry_id TEXT NOT NULL REFERENCES trust_journal_entries(entry_id),
      account_code TEXT NOT NULL REFERENCES trust_accounts(account_code),
      debit_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
      credit_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
      memo TEXT
    );
    CREATE TABLE cashflow_events (
      id BIGSERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      category TEXT NOT NULL,
      amount NUMERIC(18,2) NOT NULL,
      direction TEXT NOT NULL,
      description TEXT,
      event_date TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO trust_accounts (account_code, account_name, account_type, balance) VALUES
      ('1000', 'Cash', 'asset', 10000.00),
      ('5100', 'Distributions', 'expense', 0.00),
      ('5200', 'Operating Expenses', 'expense', 0.00);
  `);
}

async function main() {
  await createAccountingSchema();
  await PaymentHubEngine.ensureTables();

  const input = {
    idempotencyKey: 'integration-payment-1',
    paymentType: 'vendor_payment',
    amount: '100.00',
    sourceType: 'trust_account',
    sourceAccountCode: '1000',
    debitAccountCode: '5200',
    beneficiaryName: 'Test Vendor',
    beneficiaryRouting: '021000021',
    beneficiaryAccount: '1234567890',
    beneficiaryAccountType: 'checking',
    secCode: 'CCD',
    effectiveDate: '2026-07-13',
    description: 'Integration payment',
  };

  const created = await PaymentHubEngine.createIntent(input, 'maker-1');
  assert.strictEqual(created.idempotent, false);
  assert.strictEqual(created.intent.beneficiary_account, '****7890');

  const duplicate = await PaymentHubEngine.createIntent(input, 'maker-1');
  assert.strictEqual(duplicate.idempotent, true);
  assert.strictEqual(duplicate.intent.intent_id, created.intent.intent_id);

  await assert.rejects(
    PaymentHubEngine.createIntent({ ...input, amount: '101.00' }, 'maker-1'),
    /different payment instruction/
  );

  const intentId = created.intent.intent_id;
  const approved = await PaymentHubEngine.approveIntent(intentId, 'maker-1', 'integration approval');
  assert.strictEqual(approved.status, 'approved');

  await PaymentHubEngine._reserveAndQueue(intentId, 'integration-test');
  await pool.query(
    "UPDATE payment_funding_holds SET expires_at = NOW() - INTERVAL '1 hour' WHERE intent_id = $1",
    [intentId]
  );
  const competing = await PaymentHubEngine.createIntent({
    ...input,
    idempotencyKey: 'integration-payment-competing',
    amount: '9950.00',
  }, 'maker-1');
  await PaymentHubEngine.approveIntent(competing.intent.intent_id, 'maker-1', 'integration approval');
  await assert.rejects(
    PaymentHubEngine._reserveAndQueue(competing.intent.intent_id, 'integration-test'),
    /Insufficient cleared funds/
  );

  const ambiguous = await PaymentHubEngine.createIntent({
    ...input,
    idempotencyKey: 'integration-payment-ambiguous',
    amount: '50.00',
  }, 'maker-1');
  await PaymentHubEngine.approveIntent(ambiguous.intent.intent_id, 'maker-1', 'integration approval');
  await PaymentHubEngine._reserveAndQueue(ambiguous.intent.intent_id, 'integration-test');
  await PaymentHubEngine._transition(
    ambiguous.intent.intent_id,
    'transmitting',
    'integration-test',
    'test_transmission_started',
    {}
  );
  await PaymentHubEngine._fail(
    ambiguous.intent.intent_id,
    'integration-test',
    'AMBIGUOUS_TRANSMISSION',
    'Transmission result is unknown'
  );
  await assert.rejects(
    PaymentHubEngine.cancelIntent(ambiguous.intent.intent_id, 'maker-1', 'release funds'),
    /cannot be cancelled in failed status/
  );
  const activeAmbiguousHold = await pool.query(
    `SELECT COUNT(*)::int AS count FROM payment_funding_holds
     WHERE intent_id = $1 AND status = 'active'`,
    [ambiguous.intent.intent_id]
  );
  assert.strictEqual(activeAmbiguousHold.rows[0].count, 1);

  await PaymentHubEngine._transition(intentId, 'transmitting', 'integration-test', 'test_transmitting', {});
  await PaymentHubEngine._transition(intentId, 'transmitted', 'integration-test', 'test_transmitted', {});

  const settled = await PaymentHubEngine.applyExternalEvent({
    eventId: 'event-settled-1',
    intentId,
    status: 'settled',
    settlementDate: '2026-07-14',
  });
  assert.strictEqual(settled.intent.status, 'settled');
  assert.strictEqual(settled.intent.accounting_status, 'posted');

  await Promise.all(Array.from({ length: 5 }, () =>
    PaymentHubEngine.postSettlementAccounting(intentId, 'integration-test')
  ));

  const postedCount = await pool.query(
    `SELECT COUNT(*)::int AS count FROM trust_journal_entries
     WHERE reference_type = 'payment_hub_intent' AND reference_id = $1`,
    [intentId]
  );
  assert.strictEqual(postedCount.rows[0].count, 1);

  const balances = await pool.query(
    `SELECT account_code, balance::numeric FROM trust_accounts WHERE account_code IN ('1000','5200')`
  );
  const balanceMap = Object.fromEntries(balances.rows.map(row => [row.account_code, Number(row.balance)]));
  assert.strictEqual(balanceMap['1000'], 9900);
  assert.strictEqual(balanceMap['5200'], 100);

  const stale = await PaymentHubEngine.applyExternalEvent({
    eventId: 'event-stale-1',
    intentId,
    status: 'accepted',
  });
  assert.strictEqual(stale.stale, true);

  const returned = await PaymentHubEngine.applyExternalEvent({
    eventId: 'event-returned-1',
    intentId,
    status: 'returned',
    returnCode: 'R01',
    returnReason: 'Insufficient funds',
  });
  assert.strictEqual(returned.intent.status, 'returned');
  assert.strictEqual(returned.intent.accounting_status, 'reversed');

  const repeatedReturn = await PaymentHubEngine.applyExternalEvent({
    eventId: 'event-returned-2',
    intentId,
    status: 'returned',
    returnCode: 'R01',
    returnReason: 'Insufficient funds',
  });
  assert.strictEqual(repeatedReturn.intent.accounting_status, 'reversed');
  const reversalCount = await pool.query(
    `SELECT COUNT(*)::int AS count FROM trust_journal_entries
     WHERE reference_type = 'reversal' AND reference_id = $1`,
    [settled.intent.journal_entry_id]
  );
  assert.strictEqual(reversalCount.rows[0].count, 1);

  const restored = await pool.query(
    `SELECT account_code, balance::numeric FROM trust_accounts WHERE account_code IN ('1000','5200')`
  );
  const restoredMap = Object.fromEntries(restored.rows.map(row => [row.account_code, Number(row.balance)]));
  assert.strictEqual(restoredMap['1000'], 10000);
  assert.strictEqual(restoredMap['5200'], 0);

  const audit = await PaymentHubEngine.verifyAuditChain(intentId);
  assert.strictEqual(audit.valid, true);

  await ElectronicSettlementEngine.ensureTables();
  const legacySettlementId = 'ESTL-INTEGRATION-1';
  await pool.query(
    `INSERT INTO electronic_settlements
      (settlement_id, payment_ref, payment_type, payment_method, payee_name,
       source_account_code, amount, status, initiated_by, description)
     VALUES ($1, $2, 'trust_distribution', 'ach', 'Test Beneficiary',
       '1000', 125.00, 'clearing', 'integration-test', 'Legacy confirmed settlement')`,
    [legacySettlementId, 'LEGACY-PAYMENT-1']
  );
  await assert.rejects(
    ElectronicSettlementEngine.confirmSettlement(legacySettlementId),
    /processor-confirmed settled status/
  );
  await assert.rejects(
    ElectronicSettlementEngine.advanceSettlementStatus(legacySettlementId, 'settled', {}),
    /processor confirmation and a settlement reference/
  );
  await ElectronicSettlementEngine.advanceSettlementStatus(legacySettlementId, 'settled', {
    processorConfirmed: true,
    settlement_ref: 'BANK-SETTLEMENT-1',
  });
  const beforeLegacyConfirmation = await pool.query(
    `SELECT COUNT(*)::int AS count FROM trust_journal_entries
     WHERE reference_type = 'electronic_settlement' AND reference_id = $1`,
    [legacySettlementId]
  );
  assert.strictEqual(beforeLegacyConfirmation.rows[0].count, 0);

  const confirmations = await Promise.all([
    ElectronicSettlementEngine.confirmSettlement(legacySettlementId),
    ElectronicSettlementEngine.confirmSettlement(legacySettlementId),
  ]);
  assert.strictEqual(confirmations[0].confirmation_code, confirmations[1].confirmation_code);
  const repeatedConfirmation = await ElectronicSettlementEngine.confirmSettlement(legacySettlementId);
  assert.strictEqual(repeatedConfirmation.confirmation_code, confirmations[0].confirmation_code);

  const legacyPosted = await pool.query(
    `SELECT COUNT(*)::int AS count FROM trust_journal_entries
     WHERE reference_type = 'electronic_settlement' AND reference_id = $1`,
    [legacySettlementId]
  );
  assert.strictEqual(legacyPosted.rows[0].count, 1);
  const legacyBalances = await pool.query(
    `SELECT account_code, balance::numeric FROM trust_accounts WHERE account_code IN ('1000','5100')`
  );
  const legacyBalanceMap = Object.fromEntries(
    legacyBalances.rows.map(row => [row.account_code, Number(row.balance)])
  );
  assert.strictEqual(legacyBalanceMap['1000'], 9875);
  assert.strictEqual(legacyBalanceMap['5100'], 125);

  await WireEngine.ensureTables();
  const wire = await WireEngine.initiateWire({
    amountCents: 7500,
    beneficiaryName: 'Wire Beneficiary',
    beneficiaryRouting: '021000021',
    beneficiaryAccount: '1234567890',
    paymentType: 'vendor_payment',
    description: 'Integration wire',
    initiatedBy: 'maker-1',
    requiresApproval: false,
  });
  const wireBeforeSend = await pool.query(
    `SELECT COUNT(*)::int AS count FROM trust_journal_entries
     WHERE reference_type = 'wire_transfer' AND reference_id = $1`,
    [wire.wire_id]
  );
  assert.strictEqual(wireBeforeSend.rows[0].count, 0);
  await WireEngine.sendWire(wire.wire_id);
  await assert.rejects(
    WireEngine.settleWire(wire.wire_id, {}),
    /processor confirmation and a settlement reference/
  );
  const wireSettlements = await Promise.all([
    WireEngine.settleWire(wire.wire_id, {
      processorConfirmed: true,
      settlementRef: 'WIRE-SETTLEMENT-1',
    }),
    WireEngine.settleWire(wire.wire_id, {
      processorConfirmed: true,
      settlementRef: 'WIRE-SETTLEMENT-1',
    }),
  ]);
  assert.strictEqual(wireSettlements[0].journal_entry_id, wireSettlements[1].journal_entry_id);
  const repeatedWireSettlement = await WireEngine.settleWire(wire.wire_id, {
    processorConfirmed: true,
    settlementRef: 'WIRE-SETTLEMENT-1',
  });
  assert.strictEqual(repeatedWireSettlement.journal_entry_id, wireSettlements[0].journal_entry_id);
  const wirePosted = await pool.query(
    `SELECT COUNT(*)::int AS count FROM trust_journal_entries
     WHERE reference_type = 'wire_transfer' AND reference_id = $1`,
    [wire.wire_id]
  );
  assert.strictEqual(wirePosted.rows[0].count, 1);
  const wireBalances = await pool.query(
    `SELECT account_code, balance::numeric FROM trust_accounts WHERE account_code IN ('1000','5200')`
  );
  const wireBalanceMap = Object.fromEntries(
    wireBalances.rows.map(row => [row.account_code, Number(row.balance)])
  );
  assert.strictEqual(wireBalanceMap['1000'], 9800);
  assert.strictEqual(wireBalanceMap['5200'], 75);
  const wireCashflow = await pool.query(
    `SELECT COUNT(*)::int AS count FROM cashflow_events
     WHERE event_type = 'wire_payment' AND amount = 75`
  );
  assert.strictEqual(wireCashflow.rows[0].count, 1);

  await VendorEngine.ensureTables();
  await pool.query(
    `INSERT INTO vendors (vendor_id, vendor_name, routing_number, account_number, payment_method)
     VALUES ('VND-INTEGRATION', 'Concurrent Vendor', '021000021', '1234567890', 'ach')`
  );
  await pool.query(
    `INSERT INTO vendor_payments
      (payment_id, vendor_id, amount, payment_method, status, initiated_by, approved_by, approved_at)
     VALUES ('VP-INTEGRATION', 'VND-INTEGRATION', 50.00, 'ach', 'approved', 'maker-1', 'checker-1', NOW())`
  );
  const originalExecuteAch = VendorEngine._executeACH;
  let vendorExecutions = 0;
  VendorEngine._executeACH = async () => {
    vendorExecutions += 1;
    await new Promise(resolve => setTimeout(resolve, 50));
    return { payment_intent_id: 'PAY-VENDOR-INTEGRATION', payment_hub_status: 'queued' };
  };
  try {
    const vendorResults = await Promise.allSettled([
      VendorEngine.executePayment('VP-INTEGRATION', 'worker-1'),
      VendorEngine.executePayment('VP-INTEGRATION', 'worker-2'),
    ]);
    assert.strictEqual(vendorResults.filter(result => result.status === 'fulfilled').length, 1);
    assert.strictEqual(vendorResults.filter(result => result.status === 'rejected').length, 1);
    assert.strictEqual(vendorExecutions, 1);
    const vendorPayment = await VendorEngine.getPayment('VP-INTEGRATION');
    assert.strictEqual(vendorPayment.payment_intent_id, 'PAY-VENDOR-INTEGRATION');
    assert.strictEqual(vendorPayment.status, 'processing');
  } finally {
    VendorEngine._executeACH = originalExecuteAch;
  }

  await new Promise(resolve => setTimeout(resolve, 100));
  console.log('Payment Hub database integration validation passed');
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
