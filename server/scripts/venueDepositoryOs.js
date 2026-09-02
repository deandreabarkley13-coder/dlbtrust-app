#!/usr/bin/env node
'use strict';

/**
 * The trust's own bank accounts: which aggregator account reads each one,
 * which GL cash account it books to, what the bank says it holds, and whether
 * the books agree.
 *
 * Usage:
 *   node server/scripts/venueDepositoryOs.js list
 *   node server/scripts/venueDepositoryOs.js accounts                  # aggregator accounts a depository could be linked to
 *   node server/scripts/venueDepositoryOs.js link      --id VENUE-… --connection <connection id> --account <bank account id> [--gl 1000] --by <trustee>
 *   node server/scripts/venueDepositoryOs.js unlink    --id VENUE-…
 *   node server/scripts/venueDepositoryOs.js probe     --id VENUE-… [--refresh]
 *   node server/scripts/venueDepositoryOs.js reconcile [--refresh] [--dry-run]
 *
 * A depository venue is registered first with venueAccountOs.js; this joins
 * it to the aggregator account that reads it. Nothing here creates a bank
 * account or an aggregator connection.
 */

const { VenueDepositoryOsEngine } = require('../integrations/os/venueDepositoryOsEngine');
const { BankingAggregator } = require('../integrations/aggregator/bankingAggregator');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) { args._.push(token); continue; }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; continue; }
    args[key] = next;
    i += 1;
  }
  return args;
}

function money(cents) {
  const n = Number(cents || 0);
  return `${n < 0 ? '-' : ''}$${(Math.abs(n) / 100).toFixed(2)}`;
}

function printDepository(d) {
  console.log(`${d.venueId}  ${d.label || '(venue missing)'} — ${d.status || 'unknown'}`);
  console.log(`  reads from   : ${d.connectionId} / ${d.externalAccountId}`);
  console.log(`  books to     : ${d.glAccountCode}`);
  console.log(`  bank says    : ${d.balance.verification === 'live'
    ? `${money(d.balance.cents)} as of ${d.balance.observedAt}`
    : `unread — ${d.balance.reason || 'never pulled'}${d.balance.lastKnownCents !== null ? ` (last known ${money(d.balance.lastKnownCents)})` : ''}`}`);
  console.log(`  reconciled   : ${d.lastReconciledAt
    ? `${d.lastReconciledAt}, difference ${d.lastDifferenceCents === null ? 'unknown' : money(d.lastDifferenceCents)}`
    : 'never'}`);
  if (d.blockers.length) console.log(`  blocked by   : ${d.blockers.join('; ')}`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case 'list': {
      const snapshot = await VenueDepositoryOsEngine.snapshot();
      if (!snapshot.depositories.length) {
        console.log('No depository is linked to an aggregator account, so no bank balance can be read here.');
        if (snapshot.unlinked.length) {
          console.log('Depository venues waiting to be linked:');
          for (const v of snapshot.unlinked) console.log(`  ${v.venueId}  ${v.label} (${v.status})`);
        } else {
          console.log('Register the bank account first:');
          console.log('  node server/scripts/venueAccountOs.js register --provider depository --by <trustee> --label "Trust checking"');
        }
        console.log('Then join it to the account the aggregator reads:');
        console.log('  node server/scripts/venueDepositoryOs.js accounts');
        console.log('  node server/scripts/venueDepositoryOs.js link --id VENUE-… --connection <id> --account <id> --by <trustee>');
        return 0;
      }
      for (const d of snapshot.depositories) { printDepository(d); console.log(''); }
      console.log(`${snapshot.linked} linked, ${snapshot.live} read live, ${money(snapshot.totalLiveCents)} confirmed at the banks`);
      if (snapshot.unlinked.length) {
        console.log(`${snapshot.unlinked.length} depository venue(s) not yet linked: ${snapshot.unlinked.map(v => v.venueId).join(', ')}`);
      }
      return 0;
    }

    case 'accounts': {
      const connections = await BankingAggregator.listConnections();
      const outside = connections.filter(c => c.connector_type !== 'internal_rails');
      if (!outside.length) {
        console.log('The aggregator has no outside bank connection. Add one at /api/aggregator/connections and pull it.');
        return 2;
      }
      for (const conn of outside) {
        console.log(`${conn.id}  ${conn.name} (${conn.connector_type}${conn.active ? '' : ', inactive'})${conn.last_pull_at ? `  last pulled ${conn.last_pull_at}` : '  never pulled'}`);
        const accounts = await BankingAggregator.listAccounts(conn.id);
        if (!accounts.length) { console.log('  no accounts pulled yet'); continue; }
        for (const a of accounts) {
          console.log(`  ${String(a.external_account_id).padEnd(24)} ${(a.name || '').padEnd(28)} ${a.mask ? `…${a.mask}` : ''} ${a.balance_current !== null ? `$${Number(a.balance_current).toFixed(2)}` : 'no balance'}  ${a.updated_at}`);
        }
      }
      return 0;
    }

    case 'link': {
      const link = await VenueDepositoryOsEngine.link({
        venueId: args.id,
        connectionId: args.connection,
        externalAccountId: args.account,
        glAccountCode: args.gl || VenueDepositoryOsEngine.DEFAULT_GL_ACCOUNT,
        linkedBy: args.by,
      });
      console.log(`${link.venue_id} reads from ${link.connection_id}/${link.external_account_id} and books to ${link.gl_account_code}`);
      console.log('Probe it to read what the bank holds:');
      console.log(`  node server/scripts/venueDepositoryOs.js probe --id ${link.venue_id} --refresh`);
      return 0;
    }

    case 'unlink': {
      const link = await VenueDepositoryOsEngine.unlink(args.id);
      console.log(`${link.venue_id} unlinked; its balance can now only be attested from a statement`);
      return 0;
    }

    case 'probe': {
      const { venue, reading } = await VenueDepositoryOsEngine.probe(args.id, { refresh: !!args.refresh });
      console.log(`${venue.venue_id} (${venue.label}) is ${venue.status}`);
      if (reading.verification === 'live') {
        console.log(`The bank holds ${money(reading.balanceCents)}, observed ${reading.detail.observedAt}, recorded as custody evidence.`);
        if (!reading.balanceCents) console.log('Zero dollars: the account exists and is empty.');
      } else {
        console.log(`Balance unread: ${reading.reason}`);
      }
      return reading.verification === 'live' ? 0 : 2;
    }

    case 'reconcile': {
      const result = await VenueDepositoryOsEngine.reconcile({ refresh: !!args.refresh, log: !args['dry-run'] });
      if (!result.linked) { console.log('No depository is linked; nothing to reconcile.'); return 0; }
      for (const c of result.comparisons) {
        console.log(`${c.glAccountCode} ${c.glAccountName || ''}`);
        console.log(`  banks say    : ${money(c.bankCents)}`);
        console.log(`  books say    : ${c.booksCents === null ? 'no such active account' : money(c.booksCents)}`);
        console.log(`  ${c.reconciled ? 'reconciled' : `off by ${money(c.differenceCents)} (${c.severity})`}`);
      }
      for (const u of result.unread) console.log(`${u.venueId} could not be read: ${u.reason}`);
      console.log(`${result.read} of ${result.linked} depositories read; ${result.discrepancies.length} discrepancy(ies)${args['dry-run'] ? ' (not logged)' : ' logged to the DataBridge'}`);
      return result.isReconciled ? 0 : 2;
    }

    default:
      console.log(require('fs').readFileSync(__filename, 'utf8').split('/**')[1].split('*/')[0].replace(/^ \* ?/gm, ''));
      return command ? 1 : 0;
  }
}

main()
  .then(code => process.exit(code))
  .catch((err) => {
    console.error(`Refused: ${err.message}`);
    process.exit(1);
  });
