#!/usr/bin/env node
'use strict';

/**
 * PTC In-House Family Bank — Direct Send clearing operator script
 *
 * The no-portal wire path from the command line: assemble the trust's dispatched
 * wires into one raw clearing file and push it straight at the bank's clearing
 * pipeline. Nobody logs into a bank portal and nobody uploads anything by hand.
 *
 *   node server/scripts/ptcWireDirectSend.js status
 *   node server/scripts/ptcWireDirectSend.js pending
 *   node server/scripts/ptcWireDirectSend.js assemble [--limit 50] [--payments ID,ID]
 *   node server/scripts/ptcWireDirectSend.js file     <batchId>
 *   node server/scripts/ptcWireDirectSend.js send     <batchId> [--actor name]
 *   node server/scripts/ptcWireDirectSend.js run      [--limit 50] [--payments ID,ID]
 *   node server/scripts/ptcWireDirectSend.js show     <batchId>
 *   node server/scripts/ptcWireDirectSend.js batches  [--state transmitted]
 *   node server/scripts/ptcWireDirectSend.js ack      <batchId> [--reference REF] [--count N] [--amount-cents N]
 *   node server/scripts/ptcWireDirectSend.js cancel   <batchId> --note "why"
 *   node server/scripts/ptcWireDirectSend.js held     <batchId> --received yes|no --note "what the bank confirmed"
 *   node server/scripts/ptcWireDirectSend.js reconcile
 *
 * `assemble` claims payments and builds the file but contacts no bank, so it is
 * how to inspect the exact bytes, control totals and signature before anything
 * clears. `file` prints those bytes. `run` is assemble plus send.
 *
 * `held` is the one command that exists purely for a human judgement: a batch
 * whose pipeline response was a timeout or a 5xx may already be executing at the
 * bank, so the engine will not guess — an operator establishes what happened and
 * records it here, with a note.
 */

const { WireDirectSendEngine } = require('../integrations/inhouseBank/wire/wireDirectSendEngine');

function flag(args, name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1] || null;
}

function list(args, name) {
  const raw = flag(args, name);
  return raw ? raw.split(',').map(entry => entry.trim()).filter(Boolean) : null;
}

function print(label, value) {
  console.log(`\n${label}`);
  console.log(JSON.stringify(value, null, 2));
}

function summarize(result) {
  return {
    assembled: result.assembled ?? null,
    sent: result.sent ?? null,
    reason: result.reason || null,
    batchId: result.batch ? result.batch.batchId : null,
    filename: result.batch ? result.batch.filename : null,
    state: result.batch ? result.batch.state : null,
    itemCount: result.batch ? result.batch.itemCount : 0,
    totalAmount: result.batch ? result.batch.totalAmount : null,
    reference: result.receipt ? result.receipt.reference : null,
    skipped: result.skipped || [],
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const actor = flag(args, 'actor') || `cli:${process.env.USER || 'operator'}`;

  switch (command) {
    case 'status': {
      print('direct send channel', WireDirectSendEngine.readiness());
      print('clearing files', await WireDirectSendEngine.dashboard());
      return;
    }
    case 'pending': {
      print('dispatched wires awaiting clearing', await WireDirectSendEngine.pending());
      return;
    }
    case 'assemble': {
      const result = await WireDirectSendEngine.assemble({
        actor,
        limit: flag(args, 'limit') ? Number(flag(args, 'limit')) : null,
        paymentIds: list(args, 'payments'),
      });
      print(result.assembled ? 'assembled' : `not assembled (${result.reason})`, summarize(result));
      return;
    }
    case 'file': {
      const batch = await WireDirectSendEngine.batch(args[0], { includePayload: true });
      if (!batch) throw new Error(`Clearing batch ${args[0]} not found`);
      print('clearing file', {
        batchId: batch.batchId,
        filename: batch.filename,
        state: batch.state,
        payloadHash: batch.payloadHash,
        signatureAlgorithm: batch.signatureAlgorithm,
        controls: batch.manifest.controls,
      });
      console.log(`\n${batch.payload}`);
      return;
    }
    case 'send': {
      const result = await WireDirectSendEngine.send(args[0], { actor });
      print(result.sent ? 'sent to the clearing pipeline' : `not sent (${result.reason})`, summarize(result));
      return;
    }
    case 'run': {
      const result = await WireDirectSendEngine.directSend({
        actor,
        limit: flag(args, 'limit') ? Number(flag(args, 'limit')) : null,
        paymentIds: list(args, 'payments'),
      });
      print(result.sent ? 'cleared' : `nothing cleared (${result.reason})`, summarize(result));
      return;
    }
    case 'show': {
      print('clearing batch', await WireDirectSendEngine.batch(args[0]));
      return;
    }
    case 'batches': {
      print('clearing batches', await WireDirectSendEngine.list({ state: flag(args, 'state') }));
      return;
    }
    case 'ack': {
      const result = await WireDirectSendEngine.acknowledge(args[0], {
        actor,
        reference: flag(args, 'reference'),
        acceptedCount: flag(args, 'count') === null ? null : Number(flag(args, 'count')),
        totalAmountCents: flag(args, 'amount-cents') === null ? null : Number(flag(args, 'amount-cents')),
      });
      print(result.acknowledged ? 'acknowledged' : 'not acknowledged', result);
      return;
    }
    case 'cancel': {
      const note = flag(args, 'note');
      if (!note) throw new Error('cancel needs --note explaining why the file was abandoned');
      print('cancelled', await WireDirectSendEngine.cancel(args[0], { actor, reason: note }));
      return;
    }
    case 'held': {
      const received = String(flag(args, 'received') || '').toLowerCase();
      if (!['yes', 'no', 'true', 'false'].includes(received)) {
        throw new Error('held needs --received yes|no, established with the bank');
      }
      print('held batch determined', await WireDirectSendEngine.resolveHeld(args[0], {
        actor,
        received: ['yes', 'true'].includes(received),
        note: flag(args, 'note'),
      }));
      return;
    }
    case 'reconcile': {
      print('reconciliation', await WireDirectSendEngine.reconcile({ actor }));
      return;
    }
    default:
      console.error('Usage: ptcWireDirectSend.js <status|pending|assemble|file|send|run|show|batches|ack|cancel|held|reconcile>');
      process.exitCode = 2;
  }
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch(err => {
    console.error(`${err.code || 'ERROR'}: ${err.message}`);
    process.exit(1);
  });
