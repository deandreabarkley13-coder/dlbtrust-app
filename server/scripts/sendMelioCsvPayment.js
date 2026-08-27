#!/usr/bin/env node
'use strict';

/**
 * Originate a Melio CSV payment from the PTC ledger.
 *
 * Example:
 *   node server/scripts/sendMelioCsvPayment.js --amount 5.00 --sourceAccountId 1000 [--vendorEmail vendor@example.com]
 *
 * Defaults to DB NET MGMT at Lili Bank (121145307 / 692101092959).
 * Reads source GL balance from the trust accounting engine and falls back to
 * CSV export when the Melio REST API is not configured.
 */

require('dotenv').config();
const { PtcTreasuryEngine } = require('../integrations/os/osEngine');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    const v = argv[i + 1];
    if (k && v !== undefined) args[k] = v;
  }
  return args;
}

async function main() {
  const a = parseArgs(process.argv);
  const amount = Number(a.amount || a.amt);
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error('Usage: node server/scripts/sendMelioCsvPayment.js --amount <dollars> [--sourceAccountId 1000] [--vendorName "DB NET MGMT"] [--vendorEmail "vendor@example.com"] [--routing 121145307] [--account 692101092959] [--bankName "Lili Bank"] [--accountType checking] [--dueDate YYYY-MM-DD] [--memo "..."]');
    process.exit(1);
  }

  const sourceAccountId = a.sourceAccountId || '1000';
  const vendorName = a.vendorName || process.env.MELIO_VENDOR_NAME || 'DB NET MGMT';
  const routing = a.routing || process.env.MELIO_VENDOR_ROUTING || '121145307';
  const account = a.account || process.env.MELIO_VENDOR_ACCOUNT || '692101092959';
  const bankName = a.bankName || process.env.MELIO_VENDOR_BANK_NAME || 'Lili Bank';
  const accountType = a.accountType || process.env.MELIO_VENDOR_ACCOUNT_TYPE || 'checking';
  const vendorEmail = a.vendorEmail || '';
  const dueDate = a.dueDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const memo = a.memo || `Melio CSV export from trust account ${sourceAccountId} to ${vendorName}`;

  const payload = {
    action: 'distribute',
    rail: 'melio',
    amount,
    sourceType: 'trust',
    sourceAccountId,
    vendor: {
      name: vendorName,
      email: vendorEmail,
      bankAccount: {
        routingNumber: routing,
        accountNumber: account,
        accountType,
        bankName,
      },
    },
    deliveryMethod: 'csv',
    dueDate,
    memo,
    initiatedBy: a.initiatedBy || process.env.PTC_BANK_INITIATED_BY || 'melio-csv-script',
  };

  console.log('Generating Melio CSV export...');
  const response = await PtcTreasuryEngine.process(payload);
  console.log(JSON.stringify(response, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
