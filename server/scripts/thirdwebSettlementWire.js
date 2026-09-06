#!/usr/bin/env node
'use strict';

/**
 * thirdweb Settlement Wire — moves approved canonical ERP payables
 * (distribution requests, expense records) on-chain through the thirdweb
 * server wallet and reconciles open transfers back into the ledger.
 *
 * Run from the repo root with the thirdweb variables in the environment:
 *   node server/scripts/thirdwebSettlementWire.js                 readiness + queue (read-only)
 *   node server/scripts/thirdwebSettlementWire.js --reconcile     poll open transfers / subscriptions
 *   node server/scripts/thirdwebSettlementWire.js --distribution <id> [--distribution <id> ...]
 *   node server/scripts/thirdwebSettlementWire.js --expense <id>
 *   node server/scripts/thirdwebSettlementWire.js --settle-all    every approved payable with an EVM destination
 *   node server/scripts/thirdwebSettlementWire.js --watch [sec]   reconcile loop (default 30s)
 *
 * THIRDWEB_SERVER_WALLET_LIVE=false (default) records shadow transfers only;
 * nothing reaches thirdweb. Secret values are never printed.
 */

require('dotenv').config();

const { ThirdwebSettlementEngine } = require('../integrations/dapp/thirdwebSettlementEngine');

function parseArgs(argv) {
  const out = { reconcile: false, distributions: [], expenses: [], settleAll: false, watch: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--reconcile') out.reconcile = true;
    else if (arg === '--distribution') { out.distributions.push(next); i += 1; }
    else if (arg === '--expense') { out.expenses.push(next); i += 1; }
    else if (arg === '--settle-all') out.settleAll = true;
    else if (arg === '--watch') { out.watch = next && !next.startsWith('--') ? Number(next) : 30; if (next && !next.startsWith('--')) i += 1; }
    else if (arg === '--json') out.json = true;
    else throw new Error(`unknown argument "${arg}"`);
  }
  return out;
}

function print(label, value) {
  console.log(`\n== ${label} ==`);
  console.log(JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}

async function settleQueue(queue) {
  const results = [];
  for (const d of queue.distributions.filter((x) => x.canSettle)) {
    results.push(await ThirdwebSettlementEngine.settleDistribution(d.id).then((r) => ({ distribution: d.id, transfer: r.transfer })).catch((e) => ({ distribution: d.id, error: e.message })));
  }
  for (const e of queue.expenses.filter((x) => x.canSettle)) {
    results.push(await ThirdwebSettlementEngine.settleExpense(e.id).then((r) => ({ expense: e.id, transfer: r.transfer })).catch((err) => ({ expense: e.id, error: err.message })));
  }
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const readiness = ThirdwebSettlementEngine.readiness();
  print('readiness', readiness);
  if (!readiness.live) console.log('\n[shadow] THIRDWEB_SERVER_WALLET_LIVE is not true: transfers are recorded, nothing is broadcast.');

  const queue = await ThirdwebSettlementEngine.queue({ limit: 100 });
  print('queue', { counts: queue.counts, distributions: queue.distributions, expenses: queue.expenses, openTransfers: queue.openTransfers });

  for (const id of args.distributions) print(`settle distribution ${id}`, await ThirdwebSettlementEngine.settleDistribution(id));
  for (const id of args.expenses) print(`settle expense ${id}`, await ThirdwebSettlementEngine.settleExpense(id));
  if (args.settleAll) print('settle-all', await settleQueue(queue));

  if (args.reconcile || args.settleAll || args.distributions.length || args.expenses.length) {
    print('reconcile', await ThirdwebSettlementEngine.reconcile({ limit: 200 }));
  }

  if (args.watch) {
    const seconds = Number.isFinite(args.watch) && args.watch > 0 ? args.watch : 30;
    console.log(`\n[watch] reconciling every ${seconds}s (Ctrl-C to stop)`);
    for (;;) {
      await new Promise((r) => setTimeout(r, seconds * 1000));
      const result = await ThirdwebSettlementEngine.reconcile({ limit: 200 }).catch((e) => ({ error: e.message }));
      console.log(`[watch ${new Date().toISOString()}] checked=${result.checked ?? '-'} applied=${(result.results || []).filter((r) => r.applied).length}${result.error ? ` error=${result.error}` : ''}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(`\nERROR: ${e.message}`); process.exit(1); });
