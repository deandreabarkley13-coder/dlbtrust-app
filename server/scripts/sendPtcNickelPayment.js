#!/usr/bin/env node
'use strict';

/**
 * Send a real fiat payment from a PTC ledger account to an external bank account
 * via the Nickel MCP/REST accounts-payable rail.
 *
 * By default the script pays DB NET MGMT at Lili Bank (121145307 / 692101092959)
 * using the interest-income GL account (4000). Set --routing and --account to
 * override the receiver and --sourceAccountId to change the source GL.
 *
 * Example:
 *   node server/scripts/sendPtcNickelPayment.js --amount 0.01 --sourceAccountId 4000
 */

require('dotenv').config();
const { PtcTreasuryEngine } = require('../integrations/os/osEngine');
const pool = require('../integrations/bonds/pgPool');

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
  const args = parseArgs(process.argv);

  const amount = Number(args.amount || args.amt);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Usage: --amount <dollars> [--sourceAccountId 4000] [--routing 121145307] [--account 692101092959] [--name "DB NET MGMT"] [--bankName "Lili Bank"] [--vendorEmail ...] [--invoiceNumber ...] [--memo ...]');
  }

  const routing = args.routing || process.env.NICKEL_RDFI_ROUTING || '121145307';
  const account = args.account || process.env.NICKEL_RDFI_ACCOUNT || '692101092959';
  const name = args.name || process.env.NICKEL_RDFI_NAME || 'DB NET MGMT';
  const bankName = args.bankName || process.env.NICKEL_RDFI_BANK_NAME || 'Lili Bank';
  const vendorEmail = args.vendorEmail || process.env.NICKEL_PAY_BILLS_EMAIL || 'deandrealavarbarkleytrust_935@invoicesmelio.com';
  const sourceAccountId = args.sourceAccountId || process.env.NICKEL_SOURCE_ACCOUNT_ID || '4000';
  const sourceType = args.sourceType || process.env.NICKEL_SOURCE_TYPE || 'trust';

  const payload = {
    action: 'distribute',
    rail: 'nickel',
    amount,
    sourceType,
    sourceAccountId,
    vendor: {
      name,
      email: vendorEmail,
      bankAccount: {
        accountNumber: account,
        routingNumber: routing,
        accountType: args.accountType || 'checking',
        bankName,
      },
    },
    invoiceNumber: args.invoiceNumber || `DBNM-${Date.now()}`,
    dueDate: args.dueDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    memo: args.memo || `Nickel PTC payment from ${sourceAccountId} to ${name}`,
    initiatedBy: args.initiatedBy || process.env.PTC_BANK_INITIATED_BY || 'ptc-nickel-script',
    autoSettle: args.autoSettle === 'true' || process.env.NICKEL_AUTO_SETTLE === 'true',
    merchantPaymentMethodId: args.merchantPaymentMethodId || process.env.NICKEL_MERCHANT_PAYMENT_METHOD_ID,
  };

  console.log('Originating Nickel PTC payment with payload:');
  console.log(JSON.stringify({
    ...payload,
    vendor: {
      ...payload.vendor,
      bankAccount: { ...payload.vendor.bankAccount, accountNumber: '***' + String(payload.vendor.bankAccount.accountNumber).slice(-4) },
    },
  }, null, 2));

  const result = await PtcTreasuryEngine.process(payload);
  console.log('Result:');
  console.log(JSON.stringify(result, null, 2));

  const nickelResult = result.result?.result || result.result || {};
  if (!result.success || !nickelResult.billPaymentId) {
    console.warn('Nickel payment did not complete; see result above.');
    process.exitCode = 1;
  }
}

main()
  .then(async () => {
    try { await pool.end(); } catch (e) { /* ignore */ }
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('ERROR:', err.message);
    console.error(err.stack);
    try { await pool.end(); } catch (e) { /* ignore */ }
    process.exit(1);
  });
