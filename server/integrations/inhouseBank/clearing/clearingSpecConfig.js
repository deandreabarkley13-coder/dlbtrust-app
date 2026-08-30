'use strict';

/**
 * Automatic clearing-file formatting — configuration
 *
 * The trust's data workflows do not all speak the bank's language. A vendor
 * settlement run emits JSON, a payroll export emits CSV, a sub-ledger emits
 * pain.001, an inherited ACH job emits a NACHA file. The bank's clearing
 * pipeline accepts exactly one shape per rail, published in its connectivity
 * pack, and rejects the rest.
 *
 * This module holds the mapping that closes that gap: which spec each rail
 * clears in, what the trust is called in a file header, and where the intake
 * automation reads from and writes to. Three properties are load-bearing:
 *
 *   • The rail → spec mapping is configuration, not a guess. A bank that
 *     ingests Fedwire tag files and a bank that ingests pacs.008 are told
 *     apart by `CLEARING_SPEC_RAIL_MAP`, not by inspecting the payload.
 *   • Detection may only ever pick the *input* format. The output spec comes
 *     from this configuration, so a malformed or hostile input file cannot
 *     talk the trust into emitting a file some other bank would clear.
 *   • Nothing here transmits. Formatting produces bytes and a manifest; the
 *     Direct Send channel remains the only thing that reaches a bank, with its
 *     own readiness gate, signing key and idempotency vault.
 */

const path = require('path');

function text(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === null ? fallback : String(value).trim();
}

function intEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

/**
 * `fedwire=pacs.008.001.08,ach=nacha-ccd` → { fedwire: 'pacs.008.001.08', ach: 'nacha-ccd' }
 */
function parseRailMap(raw) {
  const map = {};
  for (const entry of String(raw || '').split(',')) {
    const [rail, spec] = entry.split('=').map(part => (part || '').trim());
    if (rail && spec) map[rail.toLowerCase()] = spec.toLowerCase();
  }
  return map;
}

const DEFAULT_RAIL_MAP = 'fedwire=pacs.008.001.08,rtp=pacs.008.001.08,swift=pacs.008.001.08,ach=nacha-ccd';

function getClearingSpecConfig() {
  const intakeDir = path.resolve(
    text('CLEARING_AUTOFORMAT_INTAKE_DIR', path.join(process.cwd(), 'data', 'clearing-intake'))
  );
  return {
    enabled: boolEnv('CLEARING_AUTOFORMAT_ENABLED', true),

    // Rail → bank clearing spec, as published in the bank's connectivity pack.
    railSpecs: { ...parseRailMap(DEFAULT_RAIL_MAP), ...parseRailMap(text('CLEARING_SPEC_RAIL_MAP')) },
    // The rail an instruction carries when its source data names none.
    defaultRail: text('CLEARING_AUTOFORMAT_DEFAULT_RAIL', 'fedwire').toLowerCase(),
    currency: text('CLEARING_AUTOFORMAT_CURRENCY', text('IHB_CURRENCY', 'USD')).toUpperCase(),

    // Who the trust is in a file header. Defaults track the wire channel so a
    // formatted file and a Direct Send batch name the same sender.
    senderId: text('CLEARING_AUTOFORMAT_SENDER_ID', text('WIRE_DIRECT_SEND_SENDER_ID', text('IHB_BANK_BIC', 'PTCUUS41XXX'))),
    senderName: text('CLEARING_AUTOFORMAT_SENDER_NAME', text('TRUST_BANK_NAME', 'DLB TRUST')),
    senderRouting: text('CLEARING_AUTOFORMAT_SENDER_ROUTING', text('NACHA_ODFI_ROUTING', text('TRUST_BANK_ROUTING', ''))),
    senderAccount: text('CLEARING_AUTOFORMAT_SENDER_ACCOUNT', text('TRUST_BANK_ACCOUNT', '')),
    receiverId: text('CLEARING_AUTOFORMAT_RECEIVER_ID', text('WIRE_DIRECT_SEND_RECEIVER_ID')),
    receiverRouting: text('CLEARING_AUTOFORMAT_RECEIVER_ROUTING', ''),
    receiverName: text('CLEARING_AUTOFORMAT_RECEIVER_NAME', text('TRUST_BANK_NAME', '')),

    // File conventions. The prefix and extension are what the bank's collector
    // matches on, so they are per-spec overridable through the spec registry.
    filePrefix: text('CLEARING_AUTOFORMAT_FILE_PREFIX', 'PTCFMT'),
    archiveDir: path.resolve(
      text('CLEARING_AUTOFORMAT_ARCHIVE_DIR', path.join(process.cwd(), 'data', 'clearing-formatted'))
    ),
    writeManifest: boolEnv('CLEARING_AUTOFORMAT_WRITE_MANIFEST', true),

    // Limits. A file the bank would refuse wholesale is better refused here,
    // where the rejection names the offending instruction.
    maxItems: intEnv('CLEARING_AUTOFORMAT_MAX_ITEMS', 5000, { min: 1, max: 100000 }),
    maxAmountCents: intEnv('CLEARING_AUTOFORMAT_MAX_AMOUNT_CENTS', 0),
    maxInputBytes: intEnv('CLEARING_AUTOFORMAT_MAX_INPUT_BYTES', 8 * 1024 * 1024, { min: 1024 }),

    // Intake automation: the system-to-system loop. Files land in `inbox`,
    // formatted output and manifests land in `outbox`, and every input file is
    // moved to `processed` or `failed` so a cycle never sees it twice.
    intakeDir,
    inboxDir: path.join(intakeDir, 'inbox'),
    outboxDir: path.join(intakeDir, 'outbox'),
    processedDir: path.join(intakeDir, 'processed'),
    failedDir: path.join(intakeDir, 'failed'),
    intakeExtensions: text('CLEARING_AUTOFORMAT_INTAKE_EXTENSIONS', '.json,.csv,.xml,.ach,.txt')
      .split(',')
      .map(entry => entry.trim().toLowerCase())
      .filter(Boolean),
    intakeMaxFiles: intEnv('CLEARING_AUTOFORMAT_INTAKE_MAX_FILES', 25, { min: 1, max: 1000 }),
    // Delivery is opt-in per cycle and off by default: an intake directory a
    // data workflow can write to must not be a way to move money by itself.
    deliverOnIntake: boolEnv('CLEARING_AUTOFORMAT_DELIVER', false),
    autoIntake: boolEnv('CLEARING_AUTOFORMAT_AUTO_INTAKE', false),
    autoIntervalSeconds: intEnv('CLEARING_AUTOFORMAT_INTERVAL_SECONDS', 300, { min: 30, max: 86400 }),
  };
}

function clearingSpecReadiness(specIds = []) {
  const config = getClearingSpecConfig();
  const blockers = [];
  const warnings = [];

  if (!config.enabled) blockers.push('CLEARING_AUTOFORMAT_ENABLED is off: automatic clearing-file formatting is closed');

  const unknown = Object.entries(config.railSpecs).filter(([, spec]) => specIds.length && !specIds.includes(spec));
  for (const [rail, spec] of unknown) {
    blockers.push(`CLEARING_SPEC_RAIL_MAP maps ${rail} to unknown spec "${spec}"`);
  }
  if (!config.railSpecs[config.defaultRail]) {
    blockers.push(`CLEARING_AUTOFORMAT_DEFAULT_RAIL is ${config.defaultRail}, which CLEARING_SPEC_RAIL_MAP does not map to a spec`);
  }
  if (!config.senderRouting) {
    warnings.push('No CLEARING_AUTOFORMAT_SENDER_ROUTING: NACHA output cannot be produced until the ODFI routing number is set.');
  }
  if (!config.receiverId && !config.receiverRouting) {
    warnings.push('No receiver is configured: formatted files name no receiving bank in their header.');
  }
  if (config.deliverOnIntake) {
    warnings.push('CLEARING_AUTOFORMAT_DELIVER is on: files dropped in the intake inbox are pushed at the bank channel automatically.');
  }

  return {
    ready: blockers.length === 0,
    enabled: config.enabled,
    railSpecs: config.railSpecs,
    defaultRail: config.defaultRail,
    senderId: config.senderId,
    receiverId: config.receiverId || null,
    intake: {
      inbox: config.inboxDir,
      outbox: config.outboxDir,
      deliverOnIntake: config.deliverOnIntake,
      auto: config.autoIntake,
    },
    blockers,
    warnings,
    note: blockers.length === 0
      ? 'Inbound payment data can be detected and formatted into the bank clearing spec its rail requires.'
      : 'Automatic formatting is closed until the listed configuration is supplied; it fails closed.',
  };
}

module.exports = { getClearingSpecConfig, clearingSpecReadiness, parseRailMap };
