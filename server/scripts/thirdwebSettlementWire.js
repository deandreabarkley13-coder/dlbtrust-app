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
 *   node server/scripts/thirdwebSettlementWire.js --fund <usd> [--source cash:CA-OPERATING]
 *                                                                 fund the treasury wallet from a canonical ERP account
 *                                                                 (creates the thirdweb checkout; booked on COMPLETED)
 *   node server/scripts/thirdwebSettlementWire.js --fund-sync [id] sync one or every open top-up
 *
 * THIRDWEB_SERVER_WALLET_LIVE=false (default) records shadow transfers only;
 * nothing reaches thirdweb. Secret values are never printed.
 */

require('dotenv').config();

const { ThirdwebSettlementEngine } = require('../integrations/dapp/thirdwebSettlementEngine');
const { ThirdwebTreasuryFundingEngine } = require('../integrations/dapp/thirdwebTreasuryFundingEngine');

function parseArgs(argv) {
  const out = { reconcile: false, distributions: [], expenses: [], settleAll: false, watch: null, json: false, fund: null, source: null, fundSync: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--reconcile') out.reconcile = true;
    else if (arg === '--distribution') { out.distributions.push(next); i += 1; }
    else if (arg === '--expense') { out.expenses.push(next); i += 1; }
    else if (arg === '--settle-all') out.settleAll = true;
    else if (arg === '--watch') { out.watch = next && !next.startsWith('--') ? Number(next) : 30; if (next && !next.startsWith('--')) i += 1; }
    else if (arg === '--json') out.json = true;
    else if (arg === '--fund') { out.fund = Number(next); i += 1; }
    else if (arg === '--source') { out.source = next; i += 1; }
    else if (arg === '--fund-sync') { out.fundSync = next && !next.startsWith('--') ? next : 'all'; if (next && !next.startsWith('--')) i += 1; }
    else throw new Error(`unknown argument "${arg}"`);
  }
  return out;
}

function print(label, value) {
  console.log(`\n== ${label} ==`);
  console.log(JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}

/** Walk every page of the queue; each id is attempted at most once per run. */
async function settleQueue() {
  const results = [];
  const attempted = new Set();
  const PAGE = 100;
  for (let offset = 0; ; offset += PAGE) {
    const page = await ThirdwebSettlementEngine.queue({ limit: PAGE, offset });
    const todo = [
      ...page.distributions.filter((x) => x.canSettle).map((x) => ({ kind: 'distribution', id: x.id })),
      ...page.expenses.filter((x) => x.canSettle).map((x) => ({ kind: 'expense', id: x.id })),
    ].filter((x) => !attempted.has(`${x.kind}:${x.id}`));
    for (const item of todo) {
      attempted.add(`${item.kind}:${item.id}`);
      const settle = item.kind === 'distribution' ? ThirdwebSettlementEngine.settleDistribution(item.id) : ThirdwebSettlementEngine.settleExpense(item.id);
      results.push(await settle.then((r) => ({ [item.kind]: item.id, transfer: r.transfer })).catch((e) => ({ [item.kind]: item.id, error: e.message })));
    }
    if (page.distributions.length < PAGE && page.expenses.length < PAGE) break;
  }
  return results;
}

async function fundTreasury(amountUsd, source) {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new Error('--fund requires a positive USD amount');
  const [sourceType, sourceAccountId] = source ? String(source).split(':') : [undefined, undefined];
  const topUp = await ThirdwebTreasuryFundingEngine.createTopUp({
    amountFiat: amountUsd, sourceType, sourceAccountId, requestedBy: 'thirdwebSettlementWire', requesterRole: 'trustee',
  });
  console.log(`\n[fund] complete the checkout to deliver ${topUp.quantity} ${topUp.symbol} to ${topUp.recipient}:\n  ${topUp.link}`);
  console.log('[fund] the ERP entry is booked only when thirdweb reports COMPLETED (webhook or --fund-sync).');
  return topUp;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.fund != null || args.fundSync) {
    print('funding readiness', ThirdwebTreasuryFundingEngine.readiness());
    if (args.fund != null) print('fund', await fundTreasury(args.fund, args.source));
    if (args.fundSync === 'all') print('fund-sync', await ThirdwebTreasuryFundingEngine.syncOpen());
    else if (args.fundSync) print(`fund-sync ${args.fundSync}`, await ThirdwebTreasuryFundingEngine.syncTopUp(args.fundSync));
    return;
  }
  const readiness = ThirdwebSettlementEngine.readiness();
  print('readiness', readiness);
  if (!readiness.live) console.log('\n[shadow] THIRDWEB_SERVER_WALLET_LIVE is not true: transfers are recorded, nothing is broadcast.');

  const queue = await ThirdwebSettlementEngine.queue({ limit: 100 });
  print('queue', { counts: queue.counts, distributions: queue.distributions, expenses: queue.expenses, openTransfers: queue.openTransfers });

  for (const id of args.distributions) print(`settle distribution ${id}`, await ThirdwebSettlementEngine.settleDistribution(id));
  for (const id of args.expenses) print(`settle expense ${id}`, await ThirdwebSettlementEngine.settleExpense(id));
  if (args.settleAll) print('settle-all', await settleQueue());

  if (args.reconcile || args.settleAll || args.distributions.length || args.expenses.length) {
    print('reconcile', await ThirdwebSettlementEngine.reconcile());
  }

  if (args.watch) {
    const seconds = Number.isFinite(args.watch) && args.watch > 0 ? args.watch : 30;
    console.log(`\n[watch] reconciling every ${seconds}s (Ctrl-C to stop)`);
    for (;;) {
      await new Promise((r) => setTimeout(r, seconds * 1000));
      const result = await ThirdwebSettlementEngine.reconcile().catch((e) => ({ error: e.message }));
      console.log(`[watch ${new Date().toISOString()}] checked=${result.checked ?? '-'} applied=${(result.results || []).filter((r) => r.applied).length}${result.error ? ` error=${result.error}` : ''}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(`\nERROR: ${e.message}`); process.exit(1); });
