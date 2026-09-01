#!/usr/bin/env node
'use strict';

/**
 * Attestation OS from a terminal.
 *
 * `attest` reads every custody source the trust has — the Stellar distributor,
 * the Circle account, the partner bank, whatever the aggregator has connected —
 * and writes down what each one answered, including the ones that answered
 * nothing. `snapshot` then shows the number the system could never show before:
 * what the books claim, against what somebody else is actually holding.
 *
 * `assert` is what a rail asks before it moves money, and it is the only
 * command here that can refuse.
 *
 * Usage:
 *   node server/scripts/attestationOs.js attest [--by ops@example.com]
 *   node server/scripts/attestationOs.js snapshot
 *   node server/scripts/attestationOs.js status
 *   node server/scripts/attestationOs.js observations
 *   node server/scripts/attestationOs.js assert --amount 250000 [--domain treasury] [--rail wire]
 *   node server/scripts/attestationOs.js statement --source-type partner_bank \
 *     --source-key "Column operating" --amount 250000 --evidence "stmt-2026-08.pdf" \
 *     --by trustee@example.com [--domain treasury]
 *
 * Amounts are whole cents.
 */

const { AttestationOsEngine } = require('../integrations/os/attestationOsEngine');

function parseArgs(argv) {
  const args = { flags: new Set(), _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args.flags.add(key);
    else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function print(label, value) {
  console.log(`\n${label}`);
  console.log(JSON.stringify(value, null, 2));
}

function money(value) {
  return `$${(Number(value || 0) / 100).toFixed(2)}`;
}

function requireFlag(args, name, hint) {
  const value = args[name];
  if (!value) throw new Error(`--${name} is required${hint ? `: ${hint}` : ''}`);
  return value;
}

function cents(args, name) {
  const raw = requireFlag(args, name, 'a whole number of cents');
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive whole number of cents, not ${raw}`);
  }
  return value;
}

function reportSnapshot(snapshot) {
  console.log(`\n${money(snapshot.claimedCents)} claimed, ${money(snapshot.attestedCents)} attested`
    + ` — ${money(snapshot.varianceCents)} of it stands on nothing`);
  snapshot.domains.forEach((domain) => {
    const ratio = domain.coverageRatio === null ? 'n/a' : `${(domain.coverageRatio * 100).toFixed(1)}%`;
    console.log(`  ${domain.domain}: claimed ${money(domain.claimedCents)},`
      + ` attested ${money(domain.attestedCents)} (${ratio} covered)`);
    domain.unreadable.forEach((source) => {
      console.log(`    unreadable ${source.sourceKey}: ${source.reason}`);
    });
    domain.stale.forEach((source) => {
      console.log(`    stale ${source.sourceKey}: ${source.ageMinutes} minutes old`);
    });
  });
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);

  if (!command || command === 'help' || args.flags.has('help')) {
    console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0]);
    return;
  }

  if (command === 'attest') {
    const run = await AttestationOsEngine.attest({ runBy: args.by || null });
    console.log(`\nRun ${run.runId}: ${run.observations.length} observation(s),`
      + ` ${money(run.custodyCents)} attested, ${money(run.claimedCents)} claimed,`
      + ` ${run.unreadable} source(s) unreadable`);
    run.observations.forEach((observation) => {
      const state = observation.verification === 'unverified'
        ? `unreadable — ${observation.unverifiedReason}`
        : `${observation.verification} ${money(observation.balanceCents)}`;
      console.log(`  [${observation.category}] ${observation.domain}/${observation.sourceKey}: ${state}`);
    });
    return;
  }

  if (command === 'snapshot') {
    reportSnapshot(await AttestationOsEngine.snapshot());
    return;
  }

  if (command === 'status') {
    print('Attestation status:', await AttestationOsEngine.status());
    return;
  }

  if (command === 'observations') {
    const rows = await AttestationOsEngine.latest();
    print(`${rows.length} latest observation(s):`, rows);
    return;
  }

  if (command === 'assert') {
    try {
      const decision = await AttestationOsEngine.assertLive({
        amountCents: cents(args, 'amount'),
        domain: args.domain || 'treasury',
        rail: args.rail || 'external',
        accountId: args.account || null,
      });
      print('Allowed:', decision);
    } catch (err) {
      console.log(`\nRefused: ${err.message}`);
      process.exitCode = 2;
    }
    return;
  }

  if (command === 'statement') {
    const data = await AttestationOsEngine.statement({
      domain: args.domain || 'treasury',
      sourceType: requireFlag(args, 'source-type', 'partner_bank, depository_account, …'),
      sourceKey: requireFlag(args, 'source-key', 'which account the statement covers'),
      asset: args.asset || 'USD',
      balanceCents: cents(args, 'amount'),
      evidenceReference: requireFlag(args, 'evidence', 'the statement this balance came from'),
      attestedBy: requireFlag(args, 'by', 'the officer attesting it'),
    });
    print('Recorded:', data);
    return;
  }

  throw new Error(
    `Unknown command "${command}". Commands: attest, snapshot, status, observations, assert, statement`
  );
}

if (require.main === module) {
  main().then(() => process.exit(process.exitCode || 0)).catch((err) => {
    console.error(`\nFailed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
