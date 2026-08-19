#!/usr/bin/env node
'use strict';

/**
 * Originate an ACH NACHA distribution from the PTC ledger to an external beneficiary.
 *
 * Sourcing from an interest-income GL account (e.g. 4000 Interest Income) is supported:
 * the treasury engine maps the income account to the accrued-interest asset account for
 * cash, then posts the distribution against the income account.
 *
 * Usage:
 *   node server/scripts/sendPtcAchPayment.js \
 *     --amount 5000 \
 *     --fromAccountId TBA-... \
 *     --sourceAccountId 4000 \
 *     --routing YOUR_RDFI_ROUTING \
 *     --account YOUR_RDFI_ACCOUNT \
 *     --name "DB NET MGMT" \
 *     --bankName "Lili Bank" \
 *     --odfiRouting YOUR_ODFI_ROUTING \
 *     --odfiAccount YOUR_ODFI_ORIGINATOR_ID \
 *     --odfiName "DB NET MGMT" \
 *     --destinationName "Lili Bank"
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (key.startsWith('--')) {
      const k = key.replace(/^--/, '');
      const next = argv[i + 1];
      args[k] = next && !next.startsWith('--') ? next : true;
      if (next && !next.startsWith('--')) i++;
    }
  }
  return args;
}

function validateRouting(routing) {
  if (!/^\d{9}$/.test(String(routing))) return false;
  const d = String(routing).split('').map(Number);
  const sum = 3 * d[0] + 7 * d[1] + d[2] + 3 * d[3] + 7 * d[4] + d[5] + 3 * d[6] + 7 * d[7] + d[8];
  return sum % 10 === 0;
}

const args = parseArgs(process.argv);

// Required payee / ODFI data must be supplied explicitly; no real account/routing defaults.
const amount = Number(args.amount || args.amt);
if (!Number.isFinite(amount) || amount <= 0) {
  throw new Error('--amount must be a positive number');
}

const routing = args.routing;
if (!routing || !validateRouting(routing)) {
  throw new Error('--routing is required and must be a valid 9-digit ABA routing number');
}

const account = args.account;
if (!account) {
  throw new Error('--account (RDFI account number) is required');
}

const name = args.name;
if (!name) {
  throw new Error('--name (payee name) is required');
}

const bankName = args.bankName;
if (!bankName) {
  throw new Error('--bankName (RDFI bank name) is required');
}

const sourceAccountId = args.sourceAccountId;
if (!sourceAccountId) {
  throw new Error('--sourceAccountId is required (e.g. 4000 for Interest Income)');
}

const odfiRouting = args.odfiRouting || routing;
if (!validateRouting(odfiRouting)) {
  throw new Error('--odfiRouting must be a valid 9-digit ABA routing number');
}

const odfiAccount = args.odfiAccount || account;
const odfiName = args.odfiName || name;
const destinationName = args.destinationName || bankName;

// Configure NACHA ODFI/originator from CLI or environment only (no PTC_BANK_* fallbacks).
process.env.NACHA_ODFI_ROUTING = odfiRouting;
if (odfiAccount) process.env.NACHA_ORIGINATOR_ID = odfiAccount;
if (odfiName) process.env.NACHA_ORIGINATOR_NAME = odfiName;
if (odfiName) process.env.NACHA_COMPANY_NAME = odfiName;
if (destinationName) process.env.NACHA_IMMEDIATE_DESTINATION_NAME = destinationName;
if (odfiName) process.env.NACHA_IMMEDIATE_ORIGIN_NAME = odfiName;

const fs = require('fs');
const { PtcTreasuryEngine } = require('../integrations/os/osEngine');
const pool = require('../integrations/bonds/pgPool');

async function findPtcCheckingAccount() {
  const res = await pool.query(
    `SELECT account_id, account_number, balance_cents
     FROM trust_bank_accounts
     WHERE status = 'active' AND account_name ILIKE '%checking%'
     ORDER BY balance_cents DESC, created_at DESC
     LIMIT 1`
  );
  if (!res.rows.length) throw new Error('No active PTC checking account found');
  return res.rows[0];
}

async function main() {
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

  const senderRouting = args.senderRouting || odfiRouting;
  const senderAccount = args.senderAccount || fromAccount.account_number;

  const payload = {
    action: 'distribute',
    rail: 'ach',
    amount,
    fromAccountId: fromAccount.account_id,
    sourceType: args.sourceType || 'trust',
    sourceAccountId,
    payee: {
      routing,
      account,
      name,
      bankName,
    },
    description: args.description || `ACH distribution from interest income to ${name}`,
    initiatedBy: args.initiatedBy || process.env.PTC_BANK_INITIATED_BY || 'ptc-bank-script',
    autoSend: true,
    senderRouting,
    senderAccount,
    requiresApproval: args.requiresApproval === 'true' || false,
  };

  console.log('Originating PTC ACH distribution with payload:');
  console.log(JSON.stringify({ ...payload, payee: { ...payload.payee, account: '***' + String(payload.payee.account).slice(-4) } }, null, 2));

  const result = await PtcTreasuryEngine.process(payload);
  console.log('Result:');
  console.log(JSON.stringify(result, null, 2));

  const paymentId = result && (result.paymentId || (result.result && result.result.paymentId));
  const transferId = result && (result.transferId || (result.result && result.result.sent && result.result.sent.externalTxId));

  if (transferId) {
    const transferRes = await pool.query(
      `SELECT transfer_id, ach_batch_id, external_tx_id, status, rail, amount_cents, memo, metadata
       FROM bank_transfers WHERE transfer_id = $1`,
      [transferId]
    );
    const transfer = transferRes.rows[0];
    console.log('bank_transfers row:');
    console.log(JSON.stringify(transfer, null, 2));

    if (transfer && transfer.ach_batch_id) {
      const batchRes = await pool.query(
        `SELECT batch_id, filename, file_path, status, entry_count, total_amount_cents, partner_id
         FROM ach_batches WHERE batch_id = $1`,
        [transfer.ach_batch_id]
      );
      const batch = batchRes.rows[0];
      console.log('ach_batches row:');
      console.log(JSON.stringify(batch, null, 2));

      if (batch && batch.file_path && fs.existsSync(batch.file_path)) {
        console.log('NACHA file path:', batch.file_path);
        const stats = fs.statSync(batch.file_path);
        console.log('NACHA file size:', stats.size, 'bytes');
      } else {
        console.warn('NACHA file path not found for batch', transfer.ach_batch_id);
      }
    }
  }

  if (paymentId) {
    const paymentRes = await pool.query(
      `SELECT payment_id, status, external_tx_id, metadata FROM trust_bank_payments WHERE payment_id = $1`,
      [paymentId]
    );
    console.log('trust_bank_payments row:');
    console.log(JSON.stringify(paymentRes.rows[0], null, 2));

    const journalRes = await pool.query(
      `SELECT entry_id, description, posted_by, created_at
       FROM trust_journal_entries
       WHERE reference_type = 'ptc-bank-payment' AND reference_id = $1
       ORDER BY created_at DESC`,
      [paymentId]
    );
    if (journalRes.rows.length) {
      console.log('GL journal entries:');
      for (const je of journalRes.rows) {
        const linesRes = await pool.query(
          `SELECT account_code, debit_amount, credit_amount, memo
           FROM trust_journal_lines WHERE entry_id = $1 ORDER BY id`,
          [je.entry_id]
        );
        console.log({ ...je, lines: linesRes.rows });
      }
    }
  }

  const finalStatus = result && (result.status || (result.sent && result.sent.status) || (result.result && result.result.status));
  if (!finalStatus || finalStatus === 'failed' || (typeof finalStatus === 'string' && finalStatus.includes('failed'))) {
    console.error('ACH distribution did not complete successfully.');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
});
