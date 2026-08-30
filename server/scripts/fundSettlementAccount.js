#!/usr/bin/env node
'use strict';

/**
 * Fund a settlement account out of the trust's book of record.
 *
 * The wire this originates is the trust moving its own dollars from the Trust
 * Operating Account into a registered settlement account — the Melio funding
 * DDA, for one — so a rail that debits that bank account has real money to
 * spend. The destination is named by key, never by routing and account number:
 * the accounts this may credit are the ones registered in
 * SETTLEMENT_FUNDING_DESTINATIONS.
 *
 * Usage:
 *   node server/scripts/fundSettlementAccount.js status
 *   node server/scripts/fundSettlementAccount.js plan --amount 25000 [--destination melio]
 *   node server/scripts/fundSettlementAccount.js initiate --amount 25000 \
 *     --maker trustee-one@example.com [--checker trustee-two@example.com] \
 *     [--destination melio] [--memo "Fund Melio DDA for August bills"] [--send]
 *   node server/scripts/fundSettlementAccount.js approve --wire WIRE-… --checker trustee-two@example.com
 *   node server/scripts/fundSettlementAccount.js send    --wire WIRE-…
 *   node server/scripts/fundSettlementAccount.js confirm --wire WIRE-… --reference … --provider-status confirmed
 *   node server/scripts/fundSettlementAccount.js settle  --wire WIRE-… --reference … --provider-status settled
 *   node server/scripts/fundSettlementAccount.js list [--status pending_approval]
 *   node server/scripts/fundSettlementAccount.js show   --wire WIRE-…
 *   node server/scripts/fundSettlementAccount.js cancel --wire WIRE-… --actor trustee-one@example.com
 *
 * Nothing is transmitted unless `send` is run (or `initiate --send`), and the
 * settlement account is credited in the GL only at `settle`, against the bank's
 * own settlement reference. `plan` and `status` change nothing.
 */

const { SettlementFundingEngine } = require('../integrations/inhouseBank/settlementFundingEngine');
const { WireEngine } = require('../integrations/wire/wireEngine');

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
  if (amount === undefined) throw new Error('--amount is required (dollars, e.g. 25000.00)');
  const cents = Math.round(Number(amount) * 100);
  if (!Number.isInteger(cents) || cents <= 0) {
    throw new Error(`--amount must be a positive dollar amount, got ${amount}`);
  }
  return cents;
}

function print(label, value) {
  console.log(`\n${label}`);
  console.log(JSON.stringify(value, null, 2));
}

function describeWire(wire) {
  return {
    wireId: wire.wire_id,
    status: wire.status,
    amount: (Number(wire.amount_cents) / 100).toFixed(2),
    beneficiary: wire.beneficiary_name,
    beneficiaryBank: wire.beneficiary_bank_name,
    accountLast4: String(wire.beneficiary_account || '').slice(-4),
    maker: wire.initiated_by,
    checker: wire.approved_by,
    journalEntryId: wire.journal_entry_id,
    description: wire.description,
  };
}

function requireWire(args) {
  const wireId = args.wire || args._[1];
  if (!wireId) throw new Error('--wire is required');
  return wireId;
}

function evidence(args) {
  const reference = args.reference || args['settlement-reference'];
  if (!reference) {
    throw new Error('--reference is required: the bank\'s own reference for this wire, not a locally generated one');
  }
  return {
    reference,
    providerStatus: args['provider-status'] || null,
    fedReference: args['fed-reference'] || null,
    confirmationNumber: args['confirmation-number'] || null,
    settledBy: args.actor || null,
    confirmedBy: args.actor || null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = (args._[0] || 'status').toLowerCase();

  if (command === 'status') {
    const readiness = await SettlementFundingEngine.readiness();
    print('Settlement funding readiness:', readiness);
    if (!readiness.ready) process.exitCode = 2;
    return;
  }

  if (command === 'destinations') {
    print('Registered settlement accounts:', SettlementFundingEngine.destinations().map(entry => ({
      key: entry.key,
      label: entry.label,
      bank: entry.bankName,
      accountLast4: entry.accountLast4,
      glAccountCode: entry.glAccountCode,
    })));
    return;
  }

  if (command === 'plan') {
    const plan = await SettlementFundingEngine.plan({
      amountCents: toCents(args.amount),
      destination: args.destination || null,
      fundingSourceRef: args.source || null,
    });
    print('Plan — nothing was created:', plan);
    if (!plan.funded) process.exitCode = 2;
    return;
  }

  if (command === 'initiate') {
    const { wire, plan } = await SettlementFundingEngine.initiate({
      amountCents: toCents(args.amount),
      destination: args.destination || null,
      fundingSourceRef: args.source || null,
      initiatedBy: args.maker,
      memo: args.memo || null,
    });
    console.log(
      `\nInitiated ${wire.wire_id}: $${plan.amount} ${plan.source.accountName}`
      + ` → ${plan.destination.label} (…${plan.destination.accountLast4}), maker ${wire.initiated_by}`
    );

    let current = wire;
    if (args.checker) {
      current = await SettlementFundingEngine.approve(wire.wire_id, args.checker);
      console.log(`Approved by checker ${args.checker}`);
    }

    if (args.flags.has('send')) {
      if (!args.checker && current.status !== 'approved') {
        throw new Error('Dual control: a second trustee must approve before --send');
      }
      current = await SettlementFundingEngine.send(wire.wire_id);
      print('Transmitted:', describeWire(current));
      return;
    }

    print('Not transmitted:', describeWire(current));
    console.log(
      current.status === 'approved'
        ? '\nRun `send --wire ' + wire.wire_id + '` to originate it.'
        : '\nA second trustee must run `approve --wire ' + wire.wire_id + ' --checker …` first.'
    );
    return;
  }

  if (command === 'approve') {
    const wire = await SettlementFundingEngine.approve(requireWire(args), args.checker);
    print('Approved:', describeWire(wire));
    return;
  }

  if (command === 'send') {
    const wireId = requireWire(args);
    const preview = await WireEngine.previewWireOrigination(wireId);
    print('Bank request:', preview);
    if (!args.flags.has('yes')) {
      console.log('\nNot transmitted. Re-run with --yes to originate this wire.');
      return;
    }
    const wire = await SettlementFundingEngine.send(wireId);
    print('Transmitted:', describeWire(wire));
    return;
  }

  if (command === 'confirm') {
    const wire = await SettlementFundingEngine.confirm(requireWire(args), evidence(args));
    print('Confirmed by the bank:', describeWire(wire));
    return;
  }

  if (command === 'settle') {
    const wire = await SettlementFundingEngine.settle(requireWire(args), evidence(args));
    print('Settled — the settlement account is credited in the ledger:', describeWire(wire));
    return;
  }

  if (command === 'cancel') {
    const wire = await SettlementFundingEngine.cancel(requireWire(args), args.actor);
    print('Cancelled:', describeWire(wire));
    return;
  }

  if (command === 'list') {
    const wires = await SettlementFundingEngine.list({ status: args.status || null, limit: args.limit });
    print('Settlement funding wires:', wires.map(describeWire));
    return;
  }

  if (command === 'show') {
    const wire = await SettlementFundingEngine.get(requireWire(args));
    if (!wire) throw new Error(`Wire not found: ${requireWire(args)}`);
    print('Wire:', wire);
    print('Audit trail:', await WireEngine.getWireAuditLog(wire.wire_id));
    return;
  }

  throw new Error(
    `Unknown command "${command}".`
    + ' Commands: status, destinations, plan, initiate, approve, send, confirm, settle, cancel, list, show'
  );
}

if (require.main === module) {
  main().then(() => process.exit(process.exitCode || 0)).catch((err) => {
    console.error(`\nFailed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
