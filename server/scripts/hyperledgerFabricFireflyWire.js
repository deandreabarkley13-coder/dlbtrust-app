#!/usr/bin/env node
'use strict';

/**
 * Hyperledger Fabric + FireFly Wire — walk one settlement end to end and show
 * what is actually provable at each step.
 *
 * Run from the repo root:
 *   node server/scripts/hyperledgerFabricFireflyWire.js \
 *     [--reference WIRE-123] \
 *     [--notarize <file.json|-> ] [--record-type wire] \
 *     [--verify <file.json>] \
 *     [--instruct <file.json>] [--counterparty org.partnerbank] \
 *     [--transfer <amountUsd>] [--source-type canonical --source-account 1000] \
 *     [--sync <settlementId>] [--retry <settlementId>] [--receipt <notarizationId>] \
 *     [--subscribe <webhookUrl>] [--reconcile] [--live]
 *
 * Steps:
 *   1. readiness   — Fabric channel/signer, FireFly node, and which gates are open
 *   2. node        — FireFly org/node identity, member orgs, token pools, balances
 *   3. --notarize  — digest a record and anchor it on the Fabric channel
 *   4. --verify    — re-derive the digest from the record as it stands today and
 *                    say `verified`, `mismatch`, or `unnotarized`
 *   5. --instruct  — send the counterparty a private settlement instruction whose
 *                    hash is pinned on the ledger (and notarized on Fabric)
 *   6. --transfer  — move tokenized value, checking the source of funds first;
 *                    nothing is booked until FireFly confirms it
 *   7. --sync      — poll one settlement and book it on confirmation (once)
 *   8. --retry     — re-drive a failed transfer once under the same reference
 *   9. --reconcile — every confirmed transfer the books never recorded
 *
 * Without --live nothing is anchored and no value moves: the script still
 * digests, plans, and prints exactly what it would have done. Credentials are
 * read from the environment and never printed.
 */

require('dotenv').config();

const fs = require('fs');

const { FabricLedgerEngine } = require('../integrations/hyperledger/fabricLedgerEngine');
const { FireflyEngine } = require('../integrations/hyperledger/fireflyEngine');

function parseArgs(argv) {
  const out = {
    reference: null, notarize: null, recordType: 'trust_record', verify: null, instruct: null,
    counterparty: null, transfer: null, sourceType: null, sourceAccount: null, memo: null,
    sync: null, retry: null, receipt: null, subscribe: null, reconcile: false, live: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--live') out.live = true;
    else if (arg === '--reconcile') out.reconcile = true;
    else if (arg === '--reference') { out.reference = next; i += 1; } else if (arg === '--notarize') { out.notarize = next; i += 1; } else if (arg === '--record-type') { out.recordType = next; i += 1; } else if (arg === '--verify') { out.verify = next; i += 1; } else if (arg === '--instruct') { out.instruct = next; i += 1; } else if (arg === '--counterparty') { out.counterparty = next; i += 1; } else if (arg === '--transfer') { out.transfer = next; i += 1; } else if (arg === '--source-type') { out.sourceType = next; i += 1; } else if (arg === '--source-account') { out.sourceAccount = next; i += 1; } else if (arg === '--memo') { out.memo = next; i += 1; } else if (arg === '--sync') { out.sync = next; i += 1; } else if (arg === '--retry') { out.retry = next; i += 1; } else if (arg === '--receipt') { out.receipt = next; i += 1; } else if (arg === '--subscribe') { out.subscribe = next; i += 1; } else throw new Error(`unknown argument "${arg}"`);
  }
  return out;
}

function print(title, value) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
  console.log(JSON.stringify(value, null, 2));
}

function readJson(pathOrDash) {
  const raw = pathOrDash === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(pathOrDash, 'utf8');
  try { return JSON.parse(raw); } catch (e) { throw new Error(`${pathOrDash} is not valid JSON: ${e.message}`); }
}

async function safely(title, fn) {
  try { print(title, await fn()); return true; } catch (err) {
    console.warn(`\n${title}: ${err.message}`);
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.live) {
    process.env.FABRIC_LEDGER_LIVE = 'true';
    process.env.FIREFLY_LIVE = 'true';
  }
  const reference = args.reference || `HLF-${Date.now()}`;

  const fabric = FabricLedgerEngine.readiness();
  const firefly = FireflyEngine.readiness();
  print('readiness', { fabric, firefly });
  if (!fabric.canNotarize) console.warn(`\nfabric channel not reachable: ${fabric.issues.join('; ')}`);
  if (!firefly.canMessage) console.warn(`\nfirefly node not reachable: ${firefly.issues.join('; ')}`);

  if (firefly.canMessage) {
    await safely('firefly node', () => FireflyEngine.status());
    await safely('member organizations', () => FireflyEngine.organizations());
    await safely('token pools', () => FireflyEngine.pools());
    await safely('token balances', () => FireflyEngine.balances());
  }

  if (args.notarize) {
    const payload = readJson(args.notarize);
    const recordId = String(payload.id || payload.reference || reference);
    const notarization = await FabricLedgerEngine.notarize({
      recordType: args.recordType,
      recordId,
      payload,
      metadata: { source: 'hyperledgerFabricFireflyWire' },
      notarizedBy: 'wire-script',
    });
    print(notarization.anchored ? 'record anchored on the channel' : `notarization ${notarization.status} (digest only)`, notarization);
    if (notarization.status === 'pending') {
      console.log(`\nreceipt: node server/scripts/hyperledgerFabricFireflyWire.js --receipt ${notarization.id}`);
    }
  }

  if (args.receipt) {
    print('fabric receipt', await FabricLedgerEngine.syncReceipt(args.receipt));
  }

  if (args.verify) {
    const payload = readJson(args.verify);
    const recordId = String(payload.id || payload.reference || reference);
    const result = await FabricLedgerEngine.verify({ recordType: args.recordType, recordId, payload });
    print(`verification: ${result.outcome}`, result);
    if (result.outcome === 'mismatch') process.exitCode = 2;
  }

  if (args.instruct) {
    const instruction = readJson(args.instruct);
    const sent = await FireflyEngine.sendInstruction({
      reference: String(instruction.reference || reference),
      instruction,
      counterparty: args.counterparty,
      requestedBy: 'wire-script',
    });
    print(sent.status === 'shadow' ? 'instruction digested (nothing sent)' : 'instruction sent to counterparty', sent);
  }

  if (args.transfer) {
    const settlement = await FireflyEngine.transfer({
      amountUsd: args.transfer,
      reference,
      counterparty: args.counterparty,
      memo: args.memo,
      sourceType: args.sourceType,
      sourceAccountId: args.sourceAccount,
      requestedBy: 'wire-script',
    });
    print(settlement.status === 'shadow' ? 'transfer planned (nothing moved)' : `transfer ${settlement.status}`, settlement);
    if (settlement.status !== 'shadow') {
      console.log(`\nsettle: node server/scripts/hyperledgerFabricFireflyWire.js --sync ${settlement.id}`);
    }
  }

  if (args.sync) {
    const synced = await FireflyEngine.sync(args.sync);
    print(`settlement ${synced.status}${synced.booked ? ' (booked)' : ''}`, synced);
  }

  if (args.retry) {
    const retried = await FireflyEngine.retry(args.retry, { requestedBy: 'wire-script' });
    print(retried.retried === false ? `retry skipped: ${retried.reason}` : `retry attempt ${retried.detail.attempt} ${retried.status}`, retried);
    if (retried.retried !== false && retried.status !== 'shadow') {
      console.log(`\nsettle: node server/scripts/hyperledgerFabricFireflyWire.js --sync ${retried.id}`);
    }
  }

  if (args.subscribe) {
    print('event subscription', await FireflyEngine.ensureSubscription({ webhookUrl: args.subscribe }));
  }

  if (args.reconcile) {
    print('reconciliation', await FireflyEngine.reconcile());
  }

  const acted = args.notarize || args.verify || args.instruct || args.transfer || args.sync || args.retry || args.receipt || args.subscribe || args.reconcile;
  if (!acted) {
    print('recent notarizations', await FabricLedgerEngine.list({ limit: 10 }));
    print('recent settlements', await FireflyEngine.list({ limit: 10 }));
    console.log('\nno action flag given; nothing anchored and nothing moved.');
  }
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
