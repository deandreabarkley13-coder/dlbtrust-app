#!/usr/bin/env node
'use strict';

/**
 * Send a real fiat payment from a PTC ledger account to an external bank account
 * via the Apache APISIX OS engine rail.
 *
 * By default the script uses DB NET MGMT at Lili Bank (121145307 / 692101092959)
 * as both the ODFI originator and the RDFI receiver. Set --senderRouting and
 * --senderAccount to override the originator; set --routing and --account to
 * override the receiver.
 *
 * Example:
 *   node server/scripts/sendPtcApacheApisixPayment.js --amount 5000 --sourceAccountId 4000
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

async function findPtcCheckingAccount() {
  if (!pool) throw new Error('Postgres pool not available');
  const res = await pool.query(
    `SELECT account_id, account_number, balance_cents FROM trust_bank_accounts
     WHERE account_type = 'checking' AND status = 'active'
     ORDER BY balance_cents DESC, created_at DESC LIMIT 1`
  );
  if (!res.rows.length) throw new Error('No active PTC checking account found; create one via ptc-bank/createAccount first');
  return res.rows[0];
}

async function main() {
  const args = parseArgs(process.argv);

  const amount = Number(args.amount || args.amt);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Usage: --amount <dollars> [--sourceAccountId 4000] [--fromAccountId <id>] [--routing 121145307] [--account 692101092959] [--name "DB NET MGMT"] [--bankName "Lili Bank"] [--senderRouting 121145307] [--senderAccount 692101092959]');
  }

  const fromAccount = args.fromAccountId
    ? await (async () => {
        const r = await pool.query(
          'SELECT account_id, account_number, balance_cents FROM trust_bank_accounts WHERE account_id = $1',
          [args.fromAccountId]
        );
        if (!r.rows.length) throw new Error(`Account not found: ${args.fromAccountId}`);
        return r.rows[0];
      })()
    : await findPtcCheckingAccount();

  const routing = args.routing || process.env.APISIX_RDFI_ROUTING || '121145307';
  const account = args.account || process.env.APISIX_RDFI_ACCOUNT || '692101092959';
  const name = args.name || process.env.APISIX_RDFI_NAME || 'DB NET MGMT';
  const bankName = args.bankName || process.env.APISIX_RDFI_BANK_NAME || 'Lili Bank';
  const senderRouting = args.senderRouting || process.env.APISIX_ODFI_ROUTING || routing;
  const senderAccount = args.senderAccount || process.env.APISIX_ODFI_ACCOUNT || account;
  const senderName = args.senderName || process.env.APISIX_ODFI_NAME || name;
  const senderBankName = args.senderBankName || process.env.APISIX_ODFI_BANK_NAME || bankName;

  const sourceAccountId = args.sourceAccountId || process.env.APISIX_SOURCE_GL || '4000';
  const sourceType = args.sourceType || 'trust';

  const payload = {
    action: 'distribute',
    rail: 'apisix',
    amount,
    fromAccountId: fromAccount.account_id,
    sourceType,
    sourceAccountId,
    payee: {
      routing,
      account,
      name,
      bankName,
    },
    description: args.description || `Apache APISIX payment from ${sourceAccountId} to ${name}`,
    initiatedBy: args.initiatedBy || process.env.PTC_BANK_INITIATED_BY || 'ptc-apisix-script',
    autoSend: true,
    senderRouting,
    senderAccount,
    metadata: {
      senderRouting,
      senderAccount,
      senderName,
      senderBankName,
      senderAccountType: args.senderAccountType || 'checking',
      destinationAccountType: args.destinationAccountType || 'checking',
      paymentType: args.paymentType || 'wire',
      reference: args.reference || `PTC-APISIX-${Date.now()}`,
      interestIncomeSource: sourceAccountId === '4000' ? '4000' : undefined,
    },
  };

  console.log('Originating Apache APISIX PTC payment with payload:');
  console.log(JSON.stringify({
    ...payload,
    payee: { ...payload.payee, account: '***' + String(payload.payee.account).slice(-4) },
    metadata: { ...payload.metadata, senderAccount: '***' + String(payload.metadata.senderAccount).slice(-4) },
  }, null, 2));

  const result = await PtcTreasuryEngine.process(payload);
  console.log('Result:');
  console.log(JSON.stringify(result, null, 2));

  if (!result.success || !result.result?.sent) {
    console.warn('Apache APISIX payment did not complete; see result above.');
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
