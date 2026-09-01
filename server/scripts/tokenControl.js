#!/usr/bin/env node
'use strict';

/**
 * Token supply control from a terminal.
 *
 * Four engines, one desk. `cap` says how much token a bond backs, `integrity`
 * says whether the books, the holder register and the chain still agree,
 * `issuance-*` raises and approves the ticket that authorises new supply, and
 * `mint`/`burn-*`/`exchange-*` are the acts themselves.
 *
 * Nothing here mints on one signature: an issuance is requested by one trustee
 * and approved by another, a mint spends that ticket once, and a burn or
 * exchange is raised and approved before it destroys anything. An exchange
 * reports what the trust then owes the holder — it does not pay it.
 *
 * Usage:
 *   node server/scripts/tokenControl.js cap-config
 *   node server/scripts/tokenControl.js bond --ref 19781443-DLB-PRB
 *   node server/scripts/tokenControl.js cap --token BT-…
 *   node server/scripts/tokenControl.js assess --token BT-… --principal 1000000 [--interest 0]
 *   node server/scripts/tokenControl.js backing --token BT-… --ref 19781443-DLB-PRB
 *   node server/scripts/tokenControl.js back --token BT-… --ref 19781443-DLB-PRB --by trustee@example.com
 *   node server/scripts/tokenControl.js back-unbacked --ref 19781443-DLB-PRB --by trustee@example.com
 *   node server/scripts/tokenControl.js integrity [--token BT-…] [--record --by ops@example.com]
 *   node server/scripts/tokenControl.js issuances [--token BT-…] [--status approved]
 *   node server/scripts/tokenControl.js issuance-status --token BT-…
 *   node server/scripts/tokenControl.js issuance-request --token BT-… --principal 1000000 \
 *     [--interest 0] [--holder 0x…] --by trustee-one@example.com [--memo "…"] [--settles DISB-…]
 *   node server/scripts/tokenControl.js issuance-approve --id ISS-… --by trustee-two@example.com
 *   node server/scripts/tokenControl.js issuance-reject --id ISS-… --by trustee-two@example.com [--reason "…"]
 *   node server/scripts/tokenControl.js mint --issuance ISS-… --by trustee-two@example.com
 *   node server/scripts/tokenControl.js burn-required --token BT-…
 *   node server/scripts/tokenControl.js burn-request --token BT-… --holder 0x… \
 *     --principal 1000000 [--interest 0] --by trustee-one@example.com
 *   node server/scripts/tokenControl.js exchange-request --token BT-… --holder 0x… \
 *     --principal 1000000 --by trustee-one@example.com
 *   node server/scripts/tokenControl.js movement-approve --id BRN-… --by trustee-two@example.com
 *   node server/scripts/tokenControl.js movement-execute --id BRN-… [--reference "…"]
 *   node server/scripts/tokenControl.js movement-cancel --id BRN-… --by trustee-two@example.com
 *   node server/scripts/tokenControl.js movements [--kind burn] [--status approved]
 *
 * Amounts are whole cents, because that is what the ceilings are compared in.
 */

const { CapControlEngine } = require('../integrations/os/capControlEngine');
const { IntegrityControlEngine } = require('../integrations/os/integrityControlEngine');
const { IssuanceOsEngine } = require('../integrations/os/issuanceOsEngine');
const { MintExchangeOsEngine } = require('../integrations/os/mintExchangeOsEngine');

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

function requireFlag(args, name, hint) {
  const value = args[name];
  if (!value) throw new Error(`--${name} is required${hint ? `: ${hint}` : ''}`);
  return value;
}

function cents(args, name) {
  const raw = args[name];
  if (raw === undefined) return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`--${name} must be a whole number of cents, not ${raw}`);
  }
  return value;
}

function reportFindings(report) {
  console.log(`\n${report.tokens} token(s) checked, ${report.findings.length} finding(s),`
    + ` ${report.blockingCount} blocking — ${report.clean ? 'clean' : 'NOT clean'}`);
  report.findings.forEach((finding) => {
    console.log(`  [${finding.severity}] ${finding.code} ${finding.tokenId}: ${finding.detail}`);
    if (finding.remediation) {
      console.log(`    remediation: ${finding.remediation.action} ${finding.remediation.amount || ''}`.trimEnd());
    }
  });
  if (!report.clean) process.exitCode = 2;
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);

  if (!command || command === 'help' || args.flags.has('help')) {
    console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0]);
    return;
  }

  if (command === 'cap-config') {
    print('Cap Control configuration:', CapControlEngine.config());
    return;
  }

  if (command === 'bond') {
    const data = await CapControlEngine.bondSummary(
      requireFlag(args, 'ref', 'a bond id, identifier, name or ISIN')
    );
    print(`Bond ${data.bond.identifier || data.bond.name} (row ${data.bond.id}):`, data);
    return;
  }

  if (command === 'cap') {
    const data = await CapControlEngine.headroom(requireFlag(args, 'token', 'a bond token id'));
    print('Headroom:', data);
    return;
  }

  if (command === 'assess') {
    const data = await CapControlEngine.assess({
      tokenId: requireFlag(args, 'token', 'a bond token id'),
      principalCents: cents(args, 'principal'),
      interestCents: cents(args, 'interest'),
    });
    print(data.allowed ? 'Within the ceiling:' : 'Refused:', data);
    if (!data.allowed) process.exitCode = 2;
    return;
  }

  if (command === 'backing') {
    const data = await CapControlEngine.assessBacking({
      tokenId: requireFlag(args, 'token', 'a bond token id'),
      bondReference: requireFlag(args, 'ref', 'a bond id, identifier, name or ISIN'),
    });
    print(data.allowed ? 'The bond can carry it:' : 'The bond cannot carry it:', data);
    if (!data.allowed) process.exitCode = 2;
    return;
  }

  if (command === 'back') {
    const { BondTokenizationEngine } = require('../integrations/dapp/bondTokenizationEngine');
    const data = await BondTokenizationEngine.attachBacking({
      tokenId: requireFlag(args, 'token', 'a bond token id'),
      bondReference: requireFlag(args, 'ref', 'a bond id, identifier, name or ISIN'),
      attachedBy: requireFlag(args, 'by', 'the trustee backing it'),
    });
    print(`Backed by ${data.backing.bond.name} (row ${data.backing.bond.id}):`, data.token);
    console.log('\nIts ceiling now comes from the bond, shared with every token standing on it.');
    return;
  }

  if (command === 'back-unbacked') {
    const { BondTokenizationEngine } = require('../integrations/dapp/bondTokenizationEngine');
    const ref = requireFlag(args, 'ref', 'a bond id, identifier, name or ISIN');
    const by = requireFlag(args, 'by', 'the trustee backing them');
    const tokens = await BondTokenizationEngine.listTokens();
    const unbacked = tokens.filter(t => t.bond_id === null || t.bond_id === undefined);
    console.log(`\n${unbacked.length} unbacked token(s) to stand on ${ref}`);
    for (const token of unbacked) {
      try {
        const done = await BondTokenizationEngine.attachBacking({
          tokenId: token.id, bondReference: ref, attachedBy: by,
        });
        console.log(`  backed ${token.token_symbol || token.id} → bond ${done.backing.bond.id}`);
      } catch (err) {
        process.exitCode = 2;
        console.log(`  REFUSED ${token.token_symbol || token.id}: ${err.message}`);
      }
    }
    return;
  }

  if (command === 'integrity') {
    const report = await IntegrityControlEngine.check({ tokenId: args.token || null });
    if (args.flags.has('record') || args.by) {
      const recorded = await IntegrityControlEngine.record(report, {
        checkedBy: args.by || 'cli',
      });
      console.log(`\nFiled as ${recorded.runId}`);
    }
    reportFindings(report);
    return;
  }

  if (command === 'issuances') {
    const data = await IssuanceOsEngine.list({
      tokenId: args.token || null,
      status: args.status || null,
      limit: args.limit,
    });
    print(`${data.length} issuance(s):`, data);
    return;
  }

  if (command === 'issuance-status') {
    const data = await IssuanceOsEngine.status(requireFlag(args, 'token', 'a bond token id'));
    print('Issuance status:', data);
    return;
  }

  if (command === 'issuance-request') {
    const data = await IssuanceOsEngine.request({
      tokenId: requireFlag(args, 'token', 'a bond token id'),
      principalCents: cents(args, 'principal'),
      interestCents: cents(args, 'interest'),
      holderAddress: args.holder || null,
      memo: args.memo || null,
      settlesObligation: args.settles || null,
      initiatedBy: requireFlag(args, 'by', 'the trustee raising the issuance'),
    });
    print('Raised:', data.issuance);
    console.log('\nA second trustee approves it:');
    console.log(`  node server/scripts/tokenControl.js issuance-approve --id ${data.issuance.issuance_id} --by …`);
    return;
  }

  if (command === 'issuance-approve') {
    const data = await IssuanceOsEngine.approve(
      requireFlag(args, 'id', 'an issuance id'),
      requireFlag(args, 'by', 'the second trustee')
    );
    print('Approved:', data);
    console.log(`\nMint it: node server/scripts/tokenControl.js mint --issuance ${data.issuance_id} --by …`);
    return;
  }

  if (command === 'issuance-reject') {
    const data = await IssuanceOsEngine.reject(requireFlag(args, 'id', 'an issuance id'), {
      rejectedBy: requireFlag(args, 'by', 'the trustee rejecting it'),
      reason: args.reason || null,
    });
    print('Rejected, headroom returned:', data);
    return;
  }

  if (command === 'mint') {
    const data = await MintExchangeOsEngine.mint({
      issuanceId: requireFlag(args, 'issuance', 'an approved issuance id'),
      mintedBy: args.by || null,
    });
    print('Minted:', data.movement);
    print('Issuance now:', data.issuance);
    return;
  }

  if (command === 'burn-required') {
    const data = await MintExchangeOsEngine.burnRequired(requireFlag(args, 'token', 'a bond token id'));
    print('Burn required to come back under the ceiling:', data);
    if (data.requiredCents > 0) process.exitCode = 2;
    return;
  }

  if (command === 'burn-request' || command === 'exchange-request') {
    const data = await MintExchangeOsEngine.request({
      kind: command === 'burn-request' ? 'burn' : 'exchange',
      tokenId: requireFlag(args, 'token', 'a bond token id'),
      holderAddress: requireFlag(args, 'holder', 'the holder whose token is returned'),
      principalCents: cents(args, 'principal'),
      interestCents: cents(args, 'interest'),
      memo: args.memo || null,
      initiatedBy: requireFlag(args, 'by', 'the trustee raising it'),
    });
    print('Raised:', data);
    console.log(`\n  node server/scripts/tokenControl.js movement-approve --id ${data.movement_id} --by …`);
    return;
  }

  if (command === 'movement-approve') {
    const data = await MintExchangeOsEngine.approve(
      requireFlag(args, 'id', 'a movement id'),
      requireFlag(args, 'by', 'the second trustee')
    );
    print('Approved:', data);
    console.log(`\n  node server/scripts/tokenControl.js movement-execute --id ${data.movement_id}`);
    return;
  }

  if (command === 'movement-execute') {
    const data = await MintExchangeOsEngine.execute(requireFlag(args, 'id', 'a movement id'), {
      settlementReference: args.reference || null,
    });
    print('Executed:', data.movement);
    if (data.obligation) {
      print('The trust now owes the holder (unsettled):', data.obligation);
      console.log('\nSettle it through Payer OS:');
      console.log('  node server/scripts/sendPayerCredit.js create --payee … --amount …');
    }
    return;
  }

  if (command === 'movement-cancel') {
    const data = await MintExchangeOsEngine.cancel(
      requireFlag(args, 'id', 'a movement id'),
      requireFlag(args, 'by', 'the trustee cancelling it')
    );
    print('Cancelled:', data);
    return;
  }

  if (command === 'movements') {
    const data = await MintExchangeOsEngine.list({
      kind: args.kind || null,
      status: args.status || null,
      tokenId: args.token || null,
      limit: args.limit,
    });
    print(`${data.length} movement(s):`, data);
    return;
  }

  throw new Error(
    `Unknown command "${command}". Commands: cap-config, bond, cap, assess, backing, back, back-unbacked, integrity,`
    + ' issuances, issuance-status, issuance-request, issuance-approve, issuance-reject,'
    + ' mint, burn-required, burn-request, exchange-request, movement-approve,'
    + ' movement-execute, movement-cancel, movements'
  );
}

if (require.main === module) {
  main().then(() => process.exit(process.exitCode || 0)).catch((err) => {
    console.error(`\nFailed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
