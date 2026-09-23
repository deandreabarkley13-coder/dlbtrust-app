#!/usr/bin/env node
'use strict';

/**
 * Provision a bank as the M2M partner behind the shared MFT channel that both
 * the Payer OS ACH rails and the host-to-host wire rail transmit over
 * (docs/M2M_OS_RUNBOOK.md, "One channel, both rails").
 *
 * Runs in-process against DATABASE_URL, the same way the app does, so the
 * identity's private key is minted straight into the production book and never
 * leaves it. The bank's SFTP host, username and host-key fingerprint are read
 * from the environment (deployment secrets), never from the command line.
 *
 * Usage:
 *   node server/scripts/provisionM2mPartner.js identity  --label "Lili Bank host-to-host"
 *       → mints the machine identity; prints the authorized_keys line to hand the bank.
 *   node server/scripts/provisionM2mPartner.js register  --identity M2MID-… --name "Lili Bank" [--bank-name "Lili Bank"]
 *       [--outbound /outbound --ack /ack --return /returns --archive /archive]
 *       env: M2M_PARTNER_HOST, M2M_PARTNER_PORT (22), M2M_PARTNER_USERNAME, M2M_PARTNER_HOST_KEY_FINGERPRINT
 *       → registers the partner; prints the bound channel id m2m-<partnerId> and the
 *         env lines to set (ACH_MFT_CHANNEL / WIRE_H2H_MFT_CHANNEL).
 *   node server/scripts/provisionM2mPartner.js handshake --partner M2MP-… [--wait --every 60 --for 3600]
 *       → runs the handshake (repeats until `verified` with --wait).
 *   node server/scripts/provisionM2mPartner.js status    [--partner M2MP-…]
 *       → partner status, bound channel readiness, and whether both rails point at it.
 *
 * Nothing here transmits a payment file and nothing changes MFT_REQUIRE_APPROVAL.
 */

const { M2mOsEngine } = require('../integrations/os/m2mOsEngine');
const { MftOsEngine } = require('../integrations/os/mftOsEngine');

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

function print(title, value) {
  console.log(`\n${title}`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function actor() {
  return process.env.M2M_PROVISION_ACTOR || 'provision-script';
}

function required(value, what) {
  if (!value) throw new Error(`${what} is required`);
  return value;
}

function bindingLines(channelId) {
  return [
    `ACH_MFT_CHANNEL=${channelId}`,
    `WIRE_H2H_MFT_CHANNEL=${channelId}`,
    'WIRE_H2H_RAILS=fedwire',
    'MFT_REQUIRE_APPROVAL=true',
  ].join('\n');
}

async function status(partnerId) {
  const partners = await M2mOsEngine.partners();
  const chosen = partnerId ? partners.filter(p => p.partnerId === partnerId) : partners;
  if (partnerId && !chosen.length) throw new Error(`Partner not found: ${partnerId}`);
  const out = [];
  for (const partner of chosen) {
    let readiness = null;
    try { readiness = (await MftOsEngine.channel(partner.channelId)).readiness; } catch (err) { readiness = { ready: false, blockers: [err.message] }; }
    out.push({
      partnerId: partner.partnerId,
      name: partner.name,
      status: partner.status,
      host: partner.host,
      identityId: partner.identityId,
      channelId: partner.channelId,
      readiness,
      achBound: process.env.ACH_MFT_CHANNEL === partner.channelId,
      wireBound: process.env.WIRE_H2H_MFT_CHANNEL === partner.channelId,
      lastHandshakeAt: partner.lastHandshakeAt,
    });
  }
  return { requireApproval: process.env.MFT_REQUIRE_APPROVAL !== 'false', partners: out };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'status';

  await M2mOsEngine.ensureTables();
  await MftOsEngine.ensureTables();

  if (command === 'identity') {
    const identity = await M2mOsEngine.createIdentity({ label: required(args.label, '--label'), createdBy: actor() });
    print('Identity minted:', { identityId: identity.identityId, fingerprint: identity.fingerprint, bits: identity.bits, status: identity.status });
    print('authorized_keys line — hand this to the bank out of band (public key only):', identity.publicKeyOpenssh);
    return;
  }

  if (command === 'register') {
    const host = required(process.env.M2M_PARTNER_HOST, 'M2M_PARTNER_HOST');
    const username = required(process.env.M2M_PARTNER_USERNAME, 'M2M_PARTNER_USERNAME');
    const hostKeyFingerprint = required(process.env.M2M_PARTNER_HOST_KEY_FINGERPRINT, 'M2M_PARTNER_HOST_KEY_FINGERPRINT');
    const { partner, authorize } = await M2mOsEngine.registerPartner({
      name: required(args.name, '--name'),
      bankName: args['bank-name'] || args.name,
      host,
      port: Number(process.env.M2M_PARTNER_PORT) || 22,
      username,
      hostKeyFingerprint,
      identityId: required(args.identity, '--identity'),
      layout: {
        outboundPath: args.outbound, ackPath: args.ack, returnPath: args.return, archivePath: args.archive,
      },
      createdBy: actor(),
    });
    print('Partner registered:', { partnerId: partner.partnerId, status: partner.status, channelId: partner.channelId, identityId: partner.identityId, host: partner.host });
    print(authorize.instruction, authorize.publicKeyOpenssh);
    print('Set these deployment variables so both rails ride the channel:', bindingLines(partner.channelId));
    print('Next:', `node server/scripts/provisionM2mPartner.js handshake --partner ${partner.partnerId} --wait   (after the bank installs the key)`);
    return;
  }

  if (command === 'handshake') {
    const partnerId = required(args.partner, '--partner');
    const every = Math.max(10, Number(args.every) || 60) * 1000;
    const deadline = Date.now() + Math.max(every, (Number(args.for) || 3600) * 1000);
    for (;;) {
      const { partner, handshake } = await M2mOsEngine.handshake(partnerId, { actor: actor() });
      print(`Handshake ${handshake.ok ? 'passed' : 'failed'} — partner ${partner.status}:`, handshake);
      if (handshake.ok || !args.flags.has('wait') || Date.now() >= deadline) {
        if (!handshake.ok) process.exitCode = 2;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, every));
    }
    return;
  }

  if (command === 'status') {
    print('Shared M2M channel:', await status(args.partner || null));
    return;
  }

  throw new Error(`Unknown command "${command}". Commands: identity, register, handshake, status`);
}

if (require.main === module) {
  main().then(() => process.exit(process.exitCode || 0)).catch((err) => {
    console.error(`\nFailed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
