#!/usr/bin/env node
'use strict';

/**
 * Bond Redemption Clearing & Settlement OS from a terminal.
 *
 * `calendar` lists every active bond maturing inside the horizon. `announce`
 * opens a redemption notice, `record` strikes the record date, `clear` runs the
 * clearing gate, `batch` nets cleared notices for a value date, `fund` checks
 * the cash, `settle` retires principal on the bond ledger and posts the GL, and
 * `ledger-sync` drains any settled notice the ledger has not seen.
 *
 * `run` chains announce → record → clear → batch → fund → settle for one bond,
 * which is the whole maturity for a closely-held bond in one command.
 *
 * Usage:
 *   node server/scripts/bondRedemptionOs.js status
 *   node server/scripts/bondRedemptionOs.js calendar [--horizon 90]
 *   node server/scripts/bondRedemptionOs.js preflight --bond 1 [--kind maturity] [--amount 100000000] [--value-date 2027-01-01]
 *   node server/scripts/bondRedemptionOs.js announce --bond 1 --by trustee@example.com [--kind call] [--direction issuer|holder] [--amount cents] [--value-date YYYY-MM-DD] [--record-date YYYY-MM-DD] [--reference REF]
 *   node server/scripts/bondRedemptionOs.js record --notice RDM-... [--by ops@example.com] [--holders '[{"holderRef":"..","amountCents":..}]']
 *   node server/scripts/bondRedemptionOs.js clear --notice RDM-... [--by ops@example.com]
 *   node server/scripts/bondRedemptionOs.js batch --by ops@example.com [--value-date YYYY-MM-DD] [--direction issuer]
 *   node server/scripts/bondRedemptionOs.js fund --batch RDMB-... --by trustee@example.com [--force]
 *   node server/scripts/bondRedemptionOs.js settle --batch RDMB-... --by trustee@example.com [--no-gl]
 *   node server/scripts/bondRedemptionOs.js run --bond 1 --by trustee@example.com [--kind maturity] [--force]
 *   node server/scripts/bondRedemptionOs.js ledger-sync
 *   node server/scripts/bondRedemptionOs.js events [--subject RDM-...]
 *
 * Amounts are whole cents.
 */

const { BondRedemptionOsEngine } = require('../integrations/os/bondRedemptionOsEngine');

function parseArgs(argv) {
  const args = { flags: new Set(), _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) { args._.push(token); continue; }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args.flags.add(key);
    else { args[key] = next; i += 1; }
  }
  return args;
}

function print(label, value) {
  console.log(`\n${label}`);
  console.log(JSON.stringify(value, null, 2));
}

function money(value) {
  return `$${(Number(value || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function requireFlag(args, name, hint) {
  const value = args[name];
  if (!value) throw new Error(`--${name} is required${hint ? `: ${hint}` : ''}`);
  return value;
}

function optionalCents(args, name) {
  if (args[name] === undefined) return null;
  const value = Number(args[name]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} must be a positive whole number of cents`);
  return value;
}

function reportBatch(batch) {
  console.log(`\n${batch.batchId} [${batch.status}] ${batch.direction} value ${batch.valueDate}: ${batch.noticeCount} notice(s), net ${money(batch.netCents)}`);
  (batch.legs || []).forEach((leg) => console.log(`  ${leg.holderRef}${leg.holderName ? ` (${leg.holderName})` : ''}: ${money(leg.amountCents)}`));
  if (batch.settlement) {
    batch.settlement.results.forEach((r) => console.log(`  ${r.noticeId}: ${r.status}${r.journalEntryId ? ` JE ${r.journalEntryId}` : ''}${r.error ? ` — ${r.error}` : ''}${r.glError ? ` (GL pending: ${r.glError})` : ''}`));
  }
}

async function runOne(args) {
  const by = requireFlag(args, 'by', 'the trustee calling the redemption');
  const notice = await BondRedemptionOsEngine.announce({
    bondId: requireFlag(args, 'bond'), kind: args.kind || 'maturity', direction: args.direction || 'issuer',
    principalCents: optionalCents(args, 'amount'), valueDate: args['value-date'] || null, recordDate: args['record-date'] || null,
    reference: args.reference || null, memo: args.memo || null, announcedBy: by,
  });
  console.log(`Announced ${notice.noticeId} for ${notice.bondName}: ${money(notice.principalCents)} value ${notice.valueDate}`);
  await BondRedemptionOsEngine.strikeRecord(notice.noticeId, { holders: args.holders ? JSON.parse(args.holders) : null, actor: by });
  const cleared = await BondRedemptionOsEngine.clear(notice.noticeId, { actor: by });
  if (cleared.status !== 'cleared') {
    print('Rejected by clearing:', cleared.clearing);
    process.exitCode = 2;
    return;
  }
  const batch = await BondRedemptionOsEngine.openBatch({ valueDate: cleared.valueDate, direction: cleared.direction, currency: cleared.currency, noticeIds: [notice.noticeId], openedBy: by });
  await BondRedemptionOsEngine.fundBatch(batch.batchId, { fundedBy: by, force: args.flags.has('force') });
  reportBatch(await BondRedemptionOsEngine.settleBatch(batch.batchId, { settledBy: by, postGl: !args.flags.has('no-gl') }));
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0] || 'status';

  if (command === 'status') { print('Bond Redemption OS:', await BondRedemptionOsEngine.status()); return; }
  if (command === 'calendar') {
    const rows = await BondRedemptionOsEngine.upcoming({ horizonDays: args.horizon || 90 });
    if (!rows.length) console.log('No active bonds mature inside the horizon.');
    rows.forEach((b) => console.log(`${b.bondName} (#${b.bondId}) matures ${b.maturityDate} in ${b.daysToMaturity}d — ${money(b.principalBalanceCents)} outstanding${b.noticeId ? ` — notice ${b.noticeId}` : ''}`));
    return;
  }
  if (command === 'preflight') {
    print('Preflight:', await BondRedemptionOsEngine.preflight({ bondId: requireFlag(args, 'bond'), kind: args.kind || 'maturity', principalCents: optionalCents(args, 'amount'), valueDate: args['value-date'] || null, recordDate: args['record-date'] || null }));
    return;
  }
  if (command === 'announce') {
    print('Announced:', await BondRedemptionOsEngine.announce({
      bondId: requireFlag(args, 'bond'), kind: args.kind || 'maturity', direction: args.direction || 'issuer',
      principalCents: optionalCents(args, 'amount'), valueDate: args['value-date'] || null, recordDate: args['record-date'] || null,
      reference: args.reference || null, memo: args.memo || null, announcedBy: requireFlag(args, 'by', 'the trustee calling the redemption'),
    }));
    return;
  }
  if (command === 'record') {
    print('Record struck:', await BondRedemptionOsEngine.strikeRecord(requireFlag(args, 'notice'), { holders: args.holders ? JSON.parse(args.holders) : null, recordDate: args['record-date'] || null, actor: args.by || null }));
    return;
  }
  if (command === 'clear') { print('Clearing:', await BondRedemptionOsEngine.clear(requireFlag(args, 'notice'), { actor: args.by || null })); return; }
  if (command === 'cancel') { print('Cancelled:', await BondRedemptionOsEngine.cancelNotice(requireFlag(args, 'notice'), { actor: args.by || null, reason: args.reason || null })); return; }
  if (command === 'batch') {
    reportBatch(await BondRedemptionOsEngine.openBatch({ valueDate: args['value-date'] || null, direction: args.direction || 'issuer', currency: args.currency || 'USD', openedBy: requireFlag(args, 'by') }));
    return;
  }
  if (command === 'fund') { reportBatch(await BondRedemptionOsEngine.fundBatch(requireFlag(args, 'batch'), { fundedBy: requireFlag(args, 'by'), force: args.flags.has('force') })); return; }
  if (command === 'settle') { reportBatch(await BondRedemptionOsEngine.settleBatch(requireFlag(args, 'batch'), { settledBy: requireFlag(args, 'by'), postGl: !args.flags.has('no-gl') })); return; }
  if (command === 'run') { await runOne(args); return; }
  if (command === 'ledger-sync') {
    const { DataBridge } = require('../integrations/accounting/dataBridge');
    print('Ledger sync:', await DataBridge.syncBondRedemptionsToAccounting());
    return;
  }
  if (command === 'events') { print('Events:', await BondRedemptionOsEngine.events({ subjectId: args.subject || null, limit: args.limit || 100 })); return; }

  throw new Error(`Unknown command "${command}". Commands: status, calendar, preflight, announce, record, clear, cancel, batch, fund, settle, run, ledger-sync, events`);
}

if (require.main === module) {
  main().then(() => process.exit(process.exitCode || 0)).catch((err) => {
    console.error(`\nFailed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
