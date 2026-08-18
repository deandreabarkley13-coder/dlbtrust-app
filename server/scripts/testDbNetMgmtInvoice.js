#!/usr/bin/env node
'use strict';

/**
 * Test DB NET MGMT management-fee invoice workflow through the Melio CSV rail.
 *
 * Creates or reuses the DB NET MGMT vendor, initiates an invoice payment,
 * approves it, executes it as a Melio CSV export, and prints the result.
 *
 * Example:
 *   node server/scripts/testDbNetMgmtInvoice.js --amount 5.00 --sourceAccountId 4000
 */

require('dotenv').config();
const { VendorEngine } = require('../integrations/vendors/vendorEngine');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    const v = argv[i + 1];
    if (k && v !== undefined) args[k] = v;
  }
  return args;
}

async function findOrCreateVendor() {
  const existing = await VendorEngine.listVendors({ search: 'DB NET MGMT' });
  const match = existing.find((v) => v.vendor_name.toUpperCase().includes('DB NET MGMT'));
  if (match) {
    if (!match.routing_number || !match.account_number) {
      return await VendorEngine.updateVendor(match.vendor_id, {
        bank_name: 'Lili Bank',
        routing_number: '121145307',
        account_number: '692101092959',
        account_type: 'checking',
        payment_method: 'melio',
      });
    }
    return match;
  }

  return await VendorEngine.createVendor({
    vendor_name: 'DB NET MGMT',
    vendor_type: 'consultant',
    contact_name: 'DB NET MGMT',
    address: 'Lili Bank Account',
    bank_name: 'Lili Bank',
    routing_number: '121145307',
    account_number: '692101092959',
    account_type: 'checking',
    payment_method: 'melio',
    notes: 'Private Trust Company management company — Lili Bank 121145307 / 692101092959',
  });
}

async function main() {
  const a = parseArgs(process.argv);
  const amount = Number(a.amount || 0.01);
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error('Usage: node server/scripts/testDbNetMgmtInvoice.js --amount <dollars> [--sourceAccountId 4000] [--invoiceNumber ...] [--description "Management fees"]');
    process.exit(1);
  }

  const sourceAccountId = a.sourceAccountId || '4000';
  const description = a.description || 'Management fees — DB NET MGMT';
  const invoiceNumber = a.invoiceNumber || `DBNM-MGMT-${Date.now()}`;
  const invoiceDate = a.invoiceDate || new Date().toISOString().slice(0, 10);
  const dueDate = a.dueDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  console.log('Ensuring DB NET MGMT vendor...');
  const vendor = await findOrCreateVendor();
  console.log(`Vendor: ${vendor.vendor_id}`);

  console.log(`Initiating invoice ${invoiceNumber} for $${amount.toFixed(2)}...`);
  const initiated = await VendorEngine.initiatePayment({
    vendor_id: vendor.vendor_id,
    amount,
    source_type: 'trust',
    source_account_code: sourceAccountId,
    payment_method: 'melio',
    payment_type: 'trust_expense',
    description,
    invoice_number: invoiceNumber,
    invoice_date: invoiceDate,
    due_date: dueDate,
    initiated_by: 'test-dbnetmgmt-invoice',
  });
  const paymentId = initiated.payment.payment_id;
  console.log(`Payment: ${paymentId}`);

  console.log('Approving payment...');
  await VendorEngine.approvePayment(paymentId, 'system');

  console.log('Executing Melio CSV export...');
  const executed = await VendorEngine.executePayment(paymentId, 'system');
  console.log(JSON.stringify(executed, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
