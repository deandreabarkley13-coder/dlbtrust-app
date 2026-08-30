#!/usr/bin/env node
'use strict';

/**
 * Push a credit out of the trust — the wire script for Payer OS.
 *
 * The trust is the payer here: the dollars leave an account the book of record
 * owns, over a channel the trust configured, to a party the trust registered in
 * advance. Three kinds of push exist and nothing else does — funding a
 * settlement account (by wire), a direct deposit to a person, and a vendor
 * payout (both ACH credits). There is no command that debits anyone.
 *
 * Payees are named by key, never by routing and account number: the accounts
 * this may credit are the ones registered in PAYER_OS_PAYEES, and the
 * settlement accounts are the ones in SETTLEMENT_FUNDING_DESTINATIONS.
 *
 * Usage:
 *   node server/scripts/sendPayerCredit.js status
 *   node server/scripts/sendPayerCredit.js payees [--type vendor_payout]
 *   node server/scripts/sendPayerCredit.js plan --type vendor_payout --payee acme --amount 2500.00
 *   node server/scripts/sendPayerCredit.js initiate --type direct_deposit --payee jane-doe \
 *     --amount 1200.00 --maker trustee-one@example.com [--checker trustee-two@example.com] \
 *     [--memo "August distribution"] [--send]
 *   node server/scripts/sendPayerCredit.js approve --id PAYDD-… --checker trustee-two@example.com
 *   node server/scripts/sendPayerCredit.js send    --id PAYDD-… --yes
 *   node server/scripts/sendPayerCredit.js settle  --id PAYDD-… --reference <bank reference>
 *   node server/scripts/sendPayerCredit.js cancel  --id PAYDD-… --actor trustee-one@example.com
 *   node server/scripts/sendPayerCredit.js list    [--type vendor_payout] [--status approved]
 *   node server/scripts/sendPayerCredit.js show    --id PAYDD-…
 *
 * Nothing is originated unless `send` is run with --yes (or `initiate --send`
 * with a checker), and the ledger is posted only at `settle`, against the bank's
 * own reference. `plan`, `status` and `payees` change nothing.
 */

const { PayerOsEngine } = require('../integrations/os/payerOsEngine');

function parseArgs(argv) {
  const args = { flags: new Set(), _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args.flags.add(key);
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function toCents(amount) {
  if (amount === undefined) throw new Error('--amount is required (dollars, e.g. 2500.00)');
  const cents = Math.round(Number(amount) * 100);
  if (!Number.isInteger(cents) || cents <= 0) {
    throw new Error(`--amount must be a positive dollar amount, got ${amount}`);
  }
  return cents;
}

function requireType(args) {
  const type = args.type || args['disbursement-type'];
  if (!type) {
    throw new Error(
      '--type is required: settlement_funding, direct_deposit or vendor_payout'
    );
  }
  return type;
}

function requireId(args) {
  const id = args.id || args._[1];
  if (!id) throw new Error('--id is required');
  return id;
}

function print(label, value) {
  console.log(`\n${label}`);
  console.log(JSON.stringify(value, null, 2));
}

function describe(row) {
  return {
    disbursementId: row.disbursement_id,
    type: row.disbursement_type,
    rail: row.rail,
    direction: row.direction,
    status: row.status,
    amount: (Number(row.amount_cents) / 100).toFixed(2),
    payee: row.payee_label || row.payee_name,
    accountLast4: row.payee_account_last4,
    secCode: row.sec_code,
    fundedFrom: row.funding_account_name,
    maker: row.initiated_by,
    checker: row.approved_by,
    railReference: row.rail_reference,
    settlementReference: row.settlement_reference,
    journalEntryId: row.journal_entry_id,
    failureReason: row.failure_reason,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = (args._[0] || 'status').toLowerCase();

  if (command === 'status') {
    const readiness = await PayerOsEngine.readiness();
    print('Payer OS readiness:', readiness);
    if (!readiness.ready) process.exitCode = 2;
    return;
  }

  if (command === 'payees') {
    print('Registered payees:', PayerOsEngine.payees(args.type || null));
    return;
  }

  if (command === 'plan') {
    const plan = await PayerOsEngine.plan({
      disbursementType: requireType(args),
      amountCents: toCents(args.amount),
      payee: args.payee || null,
      fundingSourceRef: args.source || null,
    });
    print('Plan — nothing was created:', plan);
    if (!plan.funded) process.exitCode = 2;
    return;
  }

  if (command === 'initiate') {
    const { disbursement, plan } = await PayerOsEngine.initiate({
      disbursementType: requireType(args),
      amountCents: toCents(args.amount),
      payee: args.payee || null,
      fundingSourceRef: args.source || null,
      initiatedBy: args.maker,
      memo: args.memo || null,
    });
    console.log(
      `\nRaised ${disbursement.disbursement_id}: $${plan.amount} ${plan.source.accountName}`
      + ` → ${plan.payee.label} (…${plan.payee.accountLast4}) over ${plan.rail}, maker ${disbursement.initiated_by}`
    );

    let current = disbursement;
    if (args.checker) {
      current = await PayerOsEngine.approve(disbursement.disbursement_id, args.checker);
      console.log(`Approved by checker ${args.checker}`);
    }

    if (args.flags.has('send')) {
      if (current.status !== 'approved') {
        throw new Error('Dual control: a second trustee must approve before --send');
      }
      const sent = await PayerOsEngine.send(disbursement.disbursement_id);
      print('Originated:', describe(sent.disbursement));
      return;
    }

    print('Not originated:', describe(current));
    console.log(
      current.status === 'approved'
        ? `\nRun \`send --id ${disbursement.disbursement_id} --yes\` to originate it.`
        : `\nA second trustee must run \`approve --id ${disbursement.disbursement_id} --checker …\` first.`
    );
    return;
  }

  if (command === 'approve') {
    const row = await PayerOsEngine.approve(requireId(args), args.checker);
    print('Approved:', describe(row));
    return;
  }

  if (command === 'send') {
    const id = requireId(args);
    const row = await PayerOsEngine.get(id);
    if (!row) throw new Error(`Disbursement not found: ${id}`);
    print('About to originate:', describe(row));
    if (!args.flags.has('yes')) {
      console.log('\nNot originated. Re-run with --yes to push these funds.');
      return;
    }
    const sent = await PayerOsEngine.send(id);
    print('Originated:', describe(sent.disbursement));
    if (sent.batch) console.log(`NACHA batch ${sent.batch.batch_id} (${sent.batch.status})`);
    if (sent.wire) console.log(`Wire ${sent.wire.wire_id} (${sent.wire.status})`);
    return;
  }

  if (command === 'settle') {
    const reference = args.reference || args['settlement-reference'];
    if (!reference) {
      throw new Error("--reference is required: the bank's own reference, not a locally generated one");
    }
    const settled = await PayerOsEngine.settle(requireId(args), {
      reference,
      settlementDate: args['settlement-date'] || null,
      settledBy: args.actor || null,
    });
    print('Settled — the ledger is posted:', describe(settled.disbursement));
    return;
  }

  if (command === 'cancel') {
    const row = await PayerOsEngine.cancel(requireId(args), args.actor);
    print('Cancelled:', describe(row));
    return;
  }

  if (command === 'list') {
    const rows = await PayerOsEngine.list({
      disbursementType: args.type || null,
      status: args.status || null,
      limit: args.limit,
    });
    print('Payer OS disbursements:', rows.map(describe));
    return;
  }

  if (command === 'show') {
    const id = requireId(args);
    const row = await PayerOsEngine.get(id);
    if (!row) throw new Error(`Disbursement not found: ${id}`);
    print('Disbursement:', row);
    print('Audit trail:', await PayerOsEngine.events(id));
    return;
  }

  throw new Error(
    `Unknown command "${command}".`
    + ' Commands: status, payees, plan, initiate, approve, send, settle, cancel, list, show'
  );
}

if (require.main === module) {
  main().then(() => process.exit(process.exitCode || 0)).catch((err) => {
    console.error(`\nFailed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
