#!/usr/bin/env node
'use strict';

/**
 * Send a trust wire through the configured partner bank rail.
 *
 * Canonical is the book of record; the partner bank originates on Fedwire.
 * Dual control is enforced by WireEngine — the checker must differ from the
 * maker before transmission is allowed.
 *
 * Usage:
 *   node server/scripts/sendTrustWire.js --amount 0.25 \
 *     --beneficiary "Db Net Mgmt LLC" --routing 000000000 --account 000000000 \
 *     --maker maker@example.com --checker checker@example.com \
 *     --description "Micro deposit validation" [--dry-run] [--send]
 *
 *   node server/scripts/sendTrustWire.js --wire WIRE-20260701-XXXXXX --send
 *
 * Nothing is transmitted unless --send is passed. --dry-run prints the exact
 * partner bank request (URL, method, body) and exits without creating a wire.
 */

const { WireEngine } = require('../integrations/wire/wireEngine');
const { PartnerBankRails } = require('../integrations/rails/partnerBankRails');

function parseArgs(argv) {
  const args = { flags: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
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
  const cents = Math.round(Number(amount) * 100);
  if (!Number.isInteger(cents) || cents <= 0) {
    throw new Error(`--amount must be a positive dollar amount, got ${amount}`);
  }
  return cents;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const status = PartnerBankRails.status();

  console.log('Partner bank rail status:');
  console.log(JSON.stringify(status, null, 2));
  if (!status.ready) {
    console.error(
      '\nRefusing to originate: the partner bank rail is not ready.'
      + `\nMissing configuration: ${status.missingConfiguration.join(', ')}`
      + '\nA canonical ledger balance cannot originate Fedwire on its own — the trust'
      + ' needs a funded account at a partner bank and that bank\'s API credential.'
    );
    process.exitCode = 2;
    return;
  }

  let wireId = args.wire || null;

  if (!wireId) {
    for (const required of ['amount', 'beneficiary', 'routing', 'account', 'maker']) {
      if (!args[required]) throw new Error(`--${required} is required when --wire is not given`);
    }
    const instruction = {
      reference: 'DRY-RUN',
      amountCents: toCents(args.amount),
      currency: args.currency || 'USD',
      beneficiaryName: args.beneficiary,
      beneficiaryRouting: args.routing,
      beneficiaryAccount: args.account,
      description: args.description || 'Trust wire',
      counterpartyId: args.counterparty || null,
      externalAccountId: args['external-account'] || null,
    };

    if (args.flags.has('dry-run')) {
      const prepared = PartnerBankRails.prepare('wire', instruction);
      console.log('\nDry run — this request would be sent, nothing was transmitted:');
      console.log(JSON.stringify(prepared, null, 2));
      return;
    }

    const wire = await WireEngine.initiateWire({
      amountCents: instruction.amountCents,
      currency: instruction.currency,
      beneficiaryName: instruction.beneficiaryName,
      beneficiaryRouting: instruction.beneficiaryRouting,
      beneficiaryAccount: instruction.beneficiaryAccount,
      beneficiaryBankName: args['beneficiary-bank'] || null,
      description: instruction.description,
      paymentType: args['payment-type'] || 'vendor_payment',
      initiatedBy: args.maker,
      requiresApproval: true,
      metadata: {
        partnerCounterpartyId: instruction.counterpartyId,
        partnerExternalAccountId: instruction.externalAccountId,
      },
    });
    wireId = wire.wire_id;
    console.log(`\nInitiated ${wireId} (maker ${args.maker})`);

    if (args.checker) {
      if (args.checker === args.maker) {
        throw new Error('Dual control: --checker must be a different trustee than --maker');
      }
      await WireEngine.approveWire(wireId, args.checker);
      console.log(`Approved ${wireId} (checker ${args.checker})`);
    }
  }

  const wire = await WireEngine.getWire(wireId);
  if (!wire) throw new Error(`Wire not found: ${wireId}`);
  console.log(`\n${wireId}: ${wire.status}, $${(Number(wire.amount_cents) / 100).toFixed(2)} → ${wire.beneficiary_name}`);

  const preview = await WireEngine.previewWireOrigination(wireId);
  console.log('\nPartner bank request:');
  console.log(JSON.stringify(preview, null, 2));

  if (!args.flags.has('send')) {
    console.log('\nNot transmitted. Re-run with --send to originate this wire.');
    return;
  }

  const sent = await WireEngine.sendWire(wireId);
  console.log('\nTransmitted:');
  console.log(JSON.stringify({
    wireId: sent.wire_id,
    status: sent.status,
    imad: sent.imad,
    omad: sent.omad,
    fedReference: sent.fed_reference,
    confirmationNumber: sent.confirmation_number,
  }, null, 2));
}

if (require.main === module) {
  main().then(() => process.exit(process.exitCode || 0)).catch((err) => {
    console.error(`\nFailed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
