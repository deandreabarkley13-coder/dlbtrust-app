#!/usr/bin/env node
'use strict';

/**
 * The trust's accounts at other people's institutions: where they are in
 * onboarding, what they can do, and what each one actually holds.
 *
 * Usage:
 *   node server/scripts/venueAccountOs.js providers
 *   node server/scripts/venueAccountOs.js list
 *   node server/scripts/venueAccountOs.js can       --capability buy_xlm
 *   node server/scripts/venueAccountOs.js register  --provider coinbase --by trustee-one@… [--label "…"] [--reference <account id>]
 *   node server/scripts/venueAccountOs.js applied   --id VENUE-… --reference <application id>
 *   node server/scripts/venueAccountOs.js approved  --id VENUE-… --by trustee-two@… --evidence <approval email/id> [--reference <account id>]
 *   node server/scripts/venueAccountOs.js probe     --id VENUE-…   (or --all)
 *   node server/scripts/venueAccountOs.js attest    --id VENUE-… --amount 250 --evidence <statement id> --by trustee-two@…
 *   node server/scripts/venueAccountOs.js suspend   --id VENUE-… --reason "…"
 *   node server/scripts/venueAccountOs.js close     --id VENUE-… [--reason "…"]
 *
 * No command takes a credential. Keys live in the environment; this only ever
 * reports whether they are set.
 */

const { VenueAccountOsEngine, PROVIDERS, CAPABILITIES } = require('../integrations/os/venueAccountOsEngine');

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
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function printAccount(account) {
  console.log(`${account.venueId}  ${account.label} (${account.provider}/${account.kind})`);
  console.log(`  status       : ${account.status}${account.externalReference ? ` — ${account.externalReference}` : ''}`);
  console.log(`  can          : ${account.capabilities.join(', ')}`);
  console.log(`  credentials  : ${account.credentials.satisfied
    ? 'set'
    : `missing ${account.credentials.missing.join(', ')}`}`);
  console.log(`  balance      : ${account.balance.verification === 'unverified'
    ? `unread — ${account.balance.reason || 'never probed'}`
    : `${money(account.balance.cents)} (${account.balance.verification}${account.balance.stale ? ', stale' : ''})`}`);
  if (account.blockers.length) console.log(`  blocked by   : ${account.blockers.join('; ')}`);
  else if (!account.funded) console.log('  blocked by   : nothing, but no dollars are confirmed at the venue');
  else console.log('  ready        : yes');
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case 'providers': {
      for (const [id, spec] of Object.entries(PROVIDERS)) {
        console.log(`${id.padEnd(14)} ${spec.kind.padEnd(18)} ${spec.capabilities.join(', ')}`);
        console.log(`${' '.repeat(15)}needs: ${spec.credentials.length ? spec.credentials.join(', ') : 'no API credentials'}`);
        console.log(`${' '.repeat(15)}funded by: ${spec.funding}`);
      }
      return 0;
    }

    case 'list': {
      const snapshot = await VenueAccountOsEngine.snapshot();
      if (!snapshot.accounts.length) {
        console.log('No venue accounts registered. Every rail that needs one will report it as unconfigured.');
        console.log('Register the account the trust already has, or intends to open:');
        console.log('  node server/scripts/venueAccountOs.js register --provider coinbase --by <trustee>');
        return 0;
      }
      for (const account of snapshot.accounts) { printAccount(account); console.log(''); }
      console.log(`${snapshot.registered} registered, ${snapshot.usable} usable, ${snapshot.funded} holding confirmed funds`);
      return 0;
    }

    case 'can': {
      const capability = args.capability || args.c;
      if (!capability) throw new Error(`--capability is required (${CAPABILITIES.join(', ')})`);
      const match = await VenueAccountOsEngine.forCapability(capability, { requireFunds: !!args.funded });
      if (match.account) {
        console.log(`${capability}: ${match.account.label} (${match.account.venueId})`);
        printAccount(match.account);
        return 0;
      }
      console.log(`Nothing can ${capability} today:`);
      for (const issue of match.issues) console.log(`  - ${issue}`);
      return 2;
    }

    case 'register': {
      const row = await VenueAccountOsEngine.register({
        provider: args.provider,
        label: args.label || null,
        externalReference: args.reference || null,
        registeredBy: args.by,
      });
      console.log(`${row.venue_id} registered as ${row.status} (${row.provider}/${row.kind})`);
      console.log('An account exists here as a record only. It can do nothing until the venue approves it,');
      console.log('the credentials are set, and dollars are deposited.');
      return 0;
    }

    case 'applied': {
      const row = await VenueAccountOsEngine.recordApplication(args.id, { reference: args.reference, filedBy: args.by || null });
      console.log(`${row.venue_id} is ${row.status}`);
      return 0;
    }

    case 'approved': {
      const row = await VenueAccountOsEngine.recordApproval(args.id, {
        approvedBy: args.by,
        evidenceReference: args.evidence,
        externalReference: args.reference || null,
      });
      console.log(`${row.venue_id} is ${row.status}, approved by ${row.approved_by}`);
      console.log('Probe it to find out whether it holds anything:');
      console.log(`  node server/scripts/venueAccountOs.js probe --id ${row.venue_id}`);
      return 0;
    }

    case 'probe': {
      if (args.all) {
        const results = await VenueAccountOsEngine.probeAll();
        if (!results.length) { console.log('No account is open enough to have a balance.'); return 0; }
        for (const result of results) {
          console.log(`${result.venue.venue_id}: ${result.reading.verification === 'live'
            ? `${money(result.reading.balanceCents)} USD`
            : `unread — ${result.reading.reason}`}`);
        }
        return 0;
      }
      const { venue, reading } = await VenueAccountOsEngine.probe(args.id);
      console.log(`${venue.venue_id} (${venue.provider}) is ${venue.status}`);
      if (reading.verification === 'live') {
        console.log(`Holds ${money(reading.balanceCents)} of USD, read from the venue just now.`);
        if (reading.detail && reading.detail.wallets) {
          for (const wallet of reading.detail.wallets) console.log(`  ${wallet.currency.padEnd(6)} ${wallet.amount}`);
        }
        if (!reading.balanceCents) {
          console.log('Zero dollars. The account can trade, but has nothing to trade with:');
          console.log(`  ${(PROVIDERS[venue.provider] || {}).funding || 'deposit USD at the venue'}`);
        }
      } else {
        console.log(`Balance unread: ${reading.reason}`);
      }
      return reading.verification === 'live' ? 0 : 2;
    }

    case 'attest': {
      const cents = Math.round(Number(args.amount) * 100);
      if (!Number.isFinite(cents)) throw new Error(`--amount ${args.amount} is not a dollar amount`);
      const row = await VenueAccountOsEngine.attestBalance(args.id, {
        balanceCents: cents,
        evidenceReference: args.evidence,
        attestedBy: args.by,
        asset: args.asset || 'USD',
      });
      console.log(`${row.venue_id} attested at ${money(row.last_balance_cents)} on ${row.evidence_reference}`);
      console.log('Recorded as a statement, not a live read: a rail will treat it accordingly.');
      return 0;
    }

    case 'suspend': {
      const row = await VenueAccountOsEngine.suspend(args.id, { reason: args.reason, suspendedBy: args.by || null });
      console.log(`${row.venue_id} suspended: ${row.suspended_reason}`);
      return 0;
    }

    case 'close': {
      const row = await VenueAccountOsEngine.close(args.id, { reason: args.reason || null, closedBy: args.by || null });
      console.log(`${row.venue_id} closed`);
      return 0;
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
