#!/usr/bin/env node
'use strict';

/**
 * Bank clearing spec formatter — scripted path
 *
 * The command-line face of the same automation the API and the intake loop use:
 * hand it whatever a data workflow produced and it detects the format, lifts
 * every payment into canonical instructions and renders the clearing spec the
 * rail's bank ingests.
 *
 *   node server/scripts/formatBankClearingFile.js status
 *   node server/scripts/formatBankClearingFile.js specs
 *   node server/scripts/formatBankClearingFile.js funding
 *   node server/scripts/formatBankClearingFile.js detect  <file|-> [--format csv]
 *   node server/scripts/formatBankClearingFile.js format  <file|-> [--rail fedwire] [--spec nacha-ccd]
 *                                                          [--funding-source operating]
 *                                                          [--out DIR] [--print] [--send]
 *   node server/scripts/formatBankClearingFile.js intake  [--limit 25] [--send]
 *
 * `detect` reads and reports only: what arrived, what the bank would be sent,
 * the control totals, and which account each payment is drawn on — it renders
 * nothing and writes nothing, so it is how to check a new workflow's export
 * before it clears anything.
 *
 * `funding` lists the accounts a payment may be drawn on: the Trust Operating
 * Account and each beneficiary's own trust account. `--funding-source` draws
 * the whole file on one of them (`operating`, `beneficiary:SL-…`, a
 * beneficiary's name) whatever the input's own columns say.
 *
 * `format` always archives the file, its manifest and its detached signature.
 * It reaches a bank only with `--send`, and then only over the Direct Send
 * channel, which refuses to carry the file unless it is itself configured and
 * the file is signed.
 *
 * `intake` is the system-to-system loop: everything in the intake inbox is
 * formatted, written to the outbox and moved out of the way, so a scheduled run
 * never re-formats a file it already handled.
 */

const fs = require('fs');
const path = require('path');
const { ClearingAutoFormatEngine } = require('../integrations/inhouseBank/clearing/clearingAutoFormatEngine');

function flag(args, name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1] || null;
}

function has(args, name) {
  return args.includes(`--${name}`);
}

function print(label, value) {
  console.log(`\n${label}`);
  console.log(JSON.stringify(value, null, 2));
}

function readInput(target) {
  if (!target || target.startsWith('--')) {
    throw new Error('give the input file to format, or - to read the payment data from stdin');
  }
  if (target === '-') return fs.readFileSync(0, 'utf8');
  return fs.readFileSync(target, 'utf8');
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const actor = flag(args, 'actor') || `cli:${process.env.USER || 'operator'}`;

  switch (command) {
    case 'status': {
      print('clearing spec automation', ClearingAutoFormatEngine.status());
      return;
    }
    case 'specs': {
      print('bank clearing specs', ClearingAutoFormatEngine.specs());
      return;
    }
    case 'funding': {
      print('permitted funding sources', await ClearingAutoFormatEngine.fundingSources());
      return;
    }
    case 'detect': {
      print('detected', await ClearingAutoFormatEngine.plan({
        input: readInput(args[0]),
        format: flag(args, 'format'),
        rail: flag(args, 'rail'),
        spec: flag(args, 'spec'),
        fundingSource: flag(args, 'funding-source'),
      }));
      return;
    }
    case 'format': {
      const source = args[0] === '-' ? 'cli:stdin' : `cli:${args[0]}`;
      const result = await ClearingAutoFormatEngine.format({
        input: readInput(args[0]),
        format: flag(args, 'format'),
        rail: flag(args, 'rail'),
        spec: flag(args, 'spec'),
        fundingSource: flag(args, 'funding-source'),
        source,
        actor,
        deliver: has(args, 'send'),
      });
      const outDir = flag(args, 'out');
      const writtenTo = [];
      if (outDir) {
        fs.mkdirSync(outDir, { recursive: true });
        for (const file of result.files) {
          const target = path.join(outDir, file.filename);
          fs.writeFileSync(target, file.payload, 'utf8');
          fs.writeFileSync(`${target}.manifest.json`, `${JSON.stringify(file.manifest, null, 2)}\n`, 'utf8');
          writtenTo.push(target);
        }
      }
      print(result.delivered ? 'formatted and sent to the bank channel' : 'formatted (not sent)', {
        batchId: result.batchId,
        detectedFormat: result.detection.format,
        detectionEvidence: result.detection.evidence,
        rail: `${result.rail} (${result.railSource})`,
        spec: `${result.spec} (${result.specSource})`,
        fundedFrom: result.funding.sources,
        controls: result.controls,
        archivePath: result.archivePath,
        writtenTo: writtenTo.length ? writtenTo : null,
        files: result.files.map(file => ({
          filename: file.filename,
          sequence: `${file.sequence} of ${file.of}`,
          controls: file.controls,
          signed: file.signed,
          delivery: file.delivery,
        })),
      });
      if (has(args, 'print')) {
        for (const file of result.files) console.log(`\n${file.filename}\n${file.payload}`);
      }
      return;
    }
    case 'intake': {
      const result = await ClearingAutoFormatEngine.runIntakeCycle({
        actor,
        trigger: 'cli',
        limit: flag(args, 'limit') ? Number(flag(args, 'limit')) : null,
        deliver: has(args, 'send') ? true : null,
      });
      print(`intake cycle: ${result.formatted.length} formatted, ${result.failed.length} failed`, result);
      if (result.failed.length) process.exitCode = 1;
      return;
    }
    default:
      console.error('Usage: formatBankClearingFile.js <status|specs|funding|detect|format|intake>');
      process.exitCode = 2;
  }
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch(err => {
    console.error(`${err.code || 'ERROR'}: ${err.message}`);
    if (err.failures) console.error(JSON.stringify(err.failures, null, 2));
    process.exit(1);
  });
