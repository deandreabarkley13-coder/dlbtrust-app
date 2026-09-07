'use strict';

/**
 * Payout routing validation — run with `node server/integrations/dapp/payoutRoute.test.js`.
 * Exercises the destination router with no database or provider access.
 */

const assert = require('assert');
const { PayoutRouteEngine } = require('./payoutRouteEngine');

const WALLET = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const GOOD_ROUTING = '021000021';

function testWalletRoute() {
  const route = PayoutRouteEngine.plan({ destinationAddress: WALLET });
  assert.strictEqual(route.destinationType, 'wallet');
  assert.strictEqual(route.rail, 'sit');
  assert.strictEqual(route.engine, 'payout_center');
  assert.strictEqual(route.asset, 'SIT');
  assert.strictEqual(route.destinationLabel, WALLET);
  assert.strictEqual(route.autoExecutable, true);

  const viaThirdweb = PayoutRouteEngine.plan({ destinationAddress: WALLET, payoutRail: 'thirdweb' });
  assert.strictEqual(viaThirdweb.engine, 'thirdweb');
  // Server-wallet settlement is released deliberately, never by approval alone.
  assert.strictEqual(viaThirdweb.autoExecutable, false);

  assert.throws(() => PayoutRouteEngine.plan({ destinationType: 'wallet' }), /destinationAddress required/);
  assert.throws(() => PayoutRouteEngine.plan({ destinationType: 'card', destinationAddress: WALLET }), /destinationType must be one of/);
}

function testBankRoute() {
  const route = PayoutRouteEngine.plan({
    destinationType: 'bank',
    bank: { routingNumber: GOOD_ROUTING, accountNumber: '1234567890', accountHolderName: 'Jane Beneficiary' },
  });
  assert.strictEqual(route.rail, 'ach');
  assert.strictEqual(route.engine, 'payout_center');
  assert.strictEqual(route.asset, 'USD');
  assert.strictEqual(route.autoExecutable, true);
  assert.strictEqual(route.destinationLabel, 'ach:****7890');
  assert.strictEqual(route.railOptions.secCode, 'PPD');
  assert.strictEqual(route.railOptions.accountNumber, '1234567890');
  assert.strictEqual(route.redacted.accountNumber, '****7890');
  assert.strictEqual(Object.values(route.redacted).includes('1234567890'), false);

  const business = PayoutRouteEngine.plan({
    destinationType: 'bank',
    bank: { routingNumber: GOOD_ROUTING, accountNumber: '55554444', businessName: 'Duke Energy LLC', holderType: 'business', accountType: 'savings' },
  });
  assert.strictEqual(business.railOptions.secCode, 'CCD');
  assert.strictEqual(business.railOptions.accountType, 'savings');
  assert.strictEqual(business.railOptions.businessName, 'Duke Energy LLC');

  assert.throws(() => PayoutRouteEngine.plan({
    destinationType: 'bank',
    bank: { routingNumber: '021000022', accountNumber: '1234567890', accountHolderName: 'Jane' },
  }), /ABA checksum/);
  assert.throws(() => PayoutRouteEngine.plan({
    destinationType: 'bank',
    bank: { routingNumber: GOOD_ROUTING, accountHolderName: 'Jane' },
  }), /bank.accountNumber required/);
  assert.throws(() => PayoutRouteEngine.plan({
    destinationType: 'bank',
    bank: { routingNumber: GOOD_ROUTING, accountNumber: '1234567890' },
  }), /bank.accountHolderName required/);
  assert.throws(() => PayoutRouteEngine.plan({
    destinationType: 'bank',
    currency: 'EUR',
    bank: { routingNumber: GOOD_ROUTING, accountNumber: '1234567890', accountHolderName: 'Jane' },
  }), /settle in USD/);
}

function testBillerRoute() {
  const route = PayoutRouteEngine.plan({
    destinationType: 'biller',
    biller: { billerName: 'Duke Energy', accountReference: '900012345678', invoiceNumber: 'INV-42' },
  });
  assert.strictEqual(route.rail, 'bill_pay');
  assert.strictEqual(route.asset, 'USD');
  assert.strictEqual(route.destinationLabel, 'biller:Duke Energy');
  assert.strictEqual(route.railOptions.accountReference, '900012345678');
  assert.strictEqual(route.redacted.accountReference, '****5678');
  assert.strictEqual(route.autoExecutable, true);

  assert.throws(() => PayoutRouteEngine.plan({ destinationType: 'biller', biller: {} }), /billerName or biller.billerId required/);
}

function testResolveFromRecord() {
  const planned = PayoutRouteEngine.plan({
    destinationType: 'bank',
    bank: { routingNumber: GOOD_ROUTING, accountNumber: '1234567890', accountHolderName: 'Jane Beneficiary' },
  });
  const record = {
    destination_type: planned.destinationType,
    destination_address: planned.destinationLabel,
    currency: 'USD',
    metadata: { payoutDestination: { destinationType: planned.destinationType, ...planned.railOptions } },
  };
  const resolved = PayoutRouteEngine.resolveFromRecord(record);
  assert.strictEqual(resolved.rail, 'ach');
  assert.strictEqual(resolved.railOptions.routingNumber, GOOD_ROUTING);
  assert.strictEqual(resolved.railOptions.accountNumber, '1234567890');
  assert.strictEqual(resolved.railOptions.recipientName, 'Jane Beneficiary');

  // A record written before destination types existed still routes to the wallet rail.
  const legacy = PayoutRouteEngine.resolveFromRecord({ destination_address: WALLET, currency: 'USD', metadata: {} });
  assert.strictEqual(legacy.destinationType, 'wallet');
  assert.strictEqual(legacy.rail, 'sit');
}

function testScrubReceipt() {
  const receipt = {
    id: 'PAY-1',
    status: 'awaiting_transmission',
    accountNumber: '1234567890',
    nacha_content: '101 021000021...1234567890...',
    tx_data: {
      batch_id: 'ACH-1',
      nacha_content: '101 021000021...1234567890...',
      entries: [{ accountNumber: '1234567890', amountCents: 1234 }],
    },
  };
  const scrubbed = PayoutRouteEngine.scrubReceipt(receipt);

  assert.strictEqual(scrubbed.id, 'PAY-1');
  assert.strictEqual(scrubbed.status, 'awaiting_transmission');
  assert.strictEqual(scrubbed.tx_data.batch_id, 'ACH-1');
  assert.strictEqual(scrubbed.accountNumber, '****7890');
  assert.strictEqual(scrubbed.tx_data.entries[0].accountNumber, '****7890');
  assert.strictEqual(scrubbed.tx_data.entries[0].amountCents, 1234);
  assert.ok(!('nacha_content' in scrubbed));
  assert.ok(!('nacha_content' in scrubbed.tx_data));
  assert.ok(!JSON.stringify(scrubbed).includes('1234567890'));

  // A self-referencing receipt must not hang the scrubber.
  const cyclic = { id: 'PAY-2' };
  cyclic.self = cyclic;
  assert.strictEqual(PayoutRouteEngine.scrubReceipt(cyclic).id, 'PAY-2');
}

function main() {
  testWalletRoute();
  testBankRoute();
  testBillerRoute();
  testResolveFromRecord();
  testScrubReceipt();
  console.log('Payout routing validation passed');
}

main();
