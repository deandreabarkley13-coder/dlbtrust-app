#!/usr/bin/env node
'use strict';

/**
 * Generate a Melio bill-spreadsheet import from multiple payables.
 *
 * Examples:
 *   node server/scripts/sendMelioCsvBatch.js --file ./payables.json
 *   node server/scripts/sendMelioCsvBatch.js --payables '[{"amount":5,"vendorName":"DB NET MGMT","dueDate":"2026-01-31"}]'
 */

require('dotenv').config();
const fs = require('fs');
const { MelioEngine } = require('../integrations/os/osEngine');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1];
    if (key && value !== undefined) args[key] = value;
  }
  return args;
}

function readPayables(args) {
  if (args.file || args.payablesFile) {
    return JSON.parse(fs.readFileSync(args.file || args.payablesFile, 'utf8'));
  }
  if (args.payables) return JSON.parse(args.payables);
  const amount = Number(args.amount || args.amt);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Usage: node server/scripts/sendMelioCsvBatch.js --file <payables.json> or --payables <json>');
  }
  return [{
    amount,
    sourceType: args.sourceType || 'trust',
    sourceAccountId: args.sourceAccountId || '4000',
    vendor: { name: args.vendorName || process.env.MELIO_VENDOR_NAME || 'DB NET MGMT' },
    dueDate: args.dueDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    invoiceNumber: args.invoiceNumber,
    memo: args.memo || `Melio CSV batch export from ${args.sourceAccountId || '4000'}`,
  }];
}

async function main() {
  const args = parseArgs(process.argv);
  const payables = readPayables(args);
  console.log(`Generating Melio CSV batch export for ${payables.length} payable(s)...`);
  const response = await MelioEngine.process({
    action: 'exportBatch',
    payables,
    batchId: args.batchId,
  });
  console.log(JSON.stringify(response, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  if (err.invalidRows) console.error(JSON.stringify(err.invalidRows, null, 2));
  process.exit(1);
});
