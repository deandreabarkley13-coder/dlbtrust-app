#!/usr/bin/env node
'use strict';

/**
 * PTC In-House Family Bank — direct host-to-host wire operator script
 *
 * The operator-side entry point to the trust's own wire channel. Every command
 * is safe to re-run: the idempotency vault decides whether a transmit actually
 * writes a file, advice ingestion is keyed on file content, and reconciliation
 * refreshes exceptions rather than duplicating them.
 *
 *   node server/scripts/ptcWireHostToHost.js status
 *   node server/scripts/ptcWireHostToHost.js prepare  <paymentId>
 *   node server/scripts/ptcWireHostToHost.js transmit <paymentId> [--actor name]
 *   node server/scripts/ptcWireHostToHost.js show     <transmissionId>
 *   node server/scripts/ptcWireHostToHost.js ingest
 *   node server/scripts/ptcWireHostToHost.js reconcile
 *   node server/scripts/ptcWireHostToHost.js exceptions [--resolved]
 *   node server/scripts/ptcWireHostToHost.js resolve <exceptionId> --note "what was done"
 *
 * `prepare` never contacts the bank, so it is the way to inspect the exact
 * pacs.008 bytes and their hash before anything leaves.
 */

const { WireHostToHostEngine } = require('../integrations/inhouseBank/wire/wireHostToHostEngine');

function flag(args, name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1] || null;
}

function print(label, value) {
  console.log(`\n${label}`);
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const actor = flag(args, 'actor') || `cli:${process.env.USER || 'operator'}`;

  switch (command) {
    case 'status': {
      print('wire channel', WireHostToHostEngine.readiness());
      print('transmissions', await WireHostToHostEngine.dashboard());
      return;
    }
    case 'prepare': {
      const prepared = await WireHostToHostEngine.prepare(args[0]);
      print('prepared', {
        paymentId: prepared.payment.paymentId,
        filename: prepared.filename,
        payloadHash: prepared.payloadHash,
        remoteDir: prepared.remoteDir,
        bytes: prepared.payload.length,
      });
      console.log(`\n${prepared.payload}`);
      return;
    }
    case 'transmit': {
      const result = await WireHostToHostEngine.transmit(args[0], { actor });
      print(result.transmitted ? 'transmitted' : `not transmitted (${result.reason})`, result.transmission);
      return;
    }
    case 'show': {
      print('transmission', await WireHostToHostEngine.transmission(args[0]));
      return;
    }
    case 'ingest': {
      print('advices ingested', await WireHostToHostEngine.ingestAdvices({ actor }));
      return;
    }
    case 'reconcile': {
      print('reconciliation', await WireHostToHostEngine.reconcile({ actor }));
      return;
    }
    case 'exceptions': {
      print('exceptions', await WireHostToHostEngine.exceptions({ resolved: args.includes('--resolved') }));
      return;
    }
    case 'resolve': {
      print('resolved', await WireHostToHostEngine.resolveException(args[0], { actor, resolution: flag(args, 'note') }));
      return;
    }
    default:
      console.error('Usage: ptcWireHostToHost.js <status|prepare|transmit|show|ingest|reconcile|exceptions|resolve>');
      process.exitCode = 2;
  }
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch(err => {
    console.error(`${err.code || 'ERROR'}: ${err.message}`);
    process.exit(1);
  });
