'use strict';

/**
 * Direct Send — configuration
 *
 * Direct Send is the family bank's no-portal path into the correspondent bank's
 * clearing pipeline. Instead of an operator signing into a bank portal and
 * uploading a file, the trust assembles its own raw clearing file from the
 * dispatched wires in its own ledger and pushes it straight at the pipeline:
 *
 *   • `pipeline` mode POSTs the raw bytes to the bank's clearing endpoint over
 *     mutual TLS. The bank's synchronous response is the file-level receipt.
 *   • `file` mode drops the identical bytes into the bank's host-to-host
 *     directory using the already-pinned H2H transport (SFTP, or the local
 *     spool when no bank host is configured). Banks whose pipeline ingests a
 *     drop directory rather than an HTTP endpoint take this mode.
 *
 * Three properties are load-bearing:
 *
 *   • The endpoint is authenticated in both directions. A clearing endpoint
 *     that does not verify the trust's client certificate, or that the trust
 *     does not verify in return, is an endpoint that can be impersonated, so
 *     `WIRE_DIRECT_SEND_INSECURE_TLS` exists for a lab and never for a bank.
 *   • The file is signed. The bank's pipeline authenticates the file itself,
 *     not just the connection, so every file carries a detached signature —
 *     HMAC-SHA256 with a shared secret or RSA/EC-SHA256 with the trust's key.
 *   • Nothing is a simulator. With no endpoint and no bank SFTP host the file
 *     lands in the local spool, and the channel reports plainly that it reached
 *     no bank rather than reporting a send.
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

function listEnv(name, fallback = '') {
  return text(name, fallback)
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
}

function getDirectSendConfig() {
  const endpoint = text('WIRE_DIRECT_SEND_URL');
  const signingKey = text('WIRE_DIRECT_SEND_SIGNING_SECRET');
  const signingKeyPath = text('WIRE_DIRECT_SEND_SIGNING_KEY_PATH');
  return {
    enabled: boolEnv('WIRE_DIRECT_SEND_ENABLED', true),
    // With an endpoint the file is pushed at the pipeline; without one it is
    // dropped on the H2H channel, which itself falls back to the local spool.
    mode: endpoint ? 'pipeline' : 'file',
    endpoint,
    // What the bank calls the trust as a sender, echoed in the file header and
    // in the pipeline request so the bank can route the file to our profile.
    senderId: text('WIRE_DIRECT_SEND_SENDER_ID', text('IHB_BANK_BIC', 'PTCUUS41XXX')),
    receiverId: text('WIRE_DIRECT_SEND_RECEIVER_ID'),
    // Rails whose dispatched payments Direct Send is allowed to clear. Anything
    // else stays on its own last mile.
    rails: listEnv('WIRE_DIRECT_SEND_RAILS', 'fedwire'),
    currency: text('WIRE_DIRECT_SEND_CURRENCY', text('IHB_CURRENCY', 'USD')).toUpperCase(),

    // Pipeline transport (mode === 'pipeline')
    timeoutMs: intEnv('WIRE_DIRECT_SEND_TIMEOUT_MS', 60000, { min: 1000, max: 600000 }),
    contentType: text('WIRE_DIRECT_SEND_CONTENT_TYPE', 'application/xml'),
    authToken: text('WIRE_DIRECT_SEND_TOKEN'),
    apiKeyHeader: text('WIRE_DIRECT_SEND_API_KEY_HEADER', 'X-Api-Key'),
    apiKey: text('WIRE_DIRECT_SEND_API_KEY'),
    clientCert: text('WIRE_DIRECT_SEND_CLIENT_CERT'),
    clientCertPath: text('WIRE_DIRECT_SEND_CLIENT_CERT_PATH'),
    clientKey: text('WIRE_DIRECT_SEND_CLIENT_KEY'),
    clientKeyPath: text('WIRE_DIRECT_SEND_CLIENT_KEY_PATH'),
    clientKeyPassphrase: text('WIRE_DIRECT_SEND_CLIENT_KEY_PASSPHRASE'),
    caCert: text('WIRE_DIRECT_SEND_CA_CERT'),
    caCertPath: text('WIRE_DIRECT_SEND_CA_CERT_PATH'),
    insecureTls: boolEnv('WIRE_DIRECT_SEND_INSECURE_TLS', false),

    // File signing. The bank authenticates the bytes, not only the channel.
    signingAlgorithm: text('WIRE_DIRECT_SEND_SIGNING_ALGORITHM', signingKeyPath ? 'rsa-sha256' : 'hmac-sha256'),
    signingSecret: signingKey,
    signingKeyPath,
    signingKeyPassphrase: text('WIRE_DIRECT_SEND_SIGNING_KEY_PASSPHRASE'),
    signatureSuffix: text('WIRE_DIRECT_SEND_SIGNATURE_SUFFIX', '.sig'),
    requireSignature: boolEnv('WIRE_DIRECT_SEND_REQUIRE_SIGNATURE', true),

    // File conventions
    filePrefix: text('WIRE_DIRECT_SEND_FILE_PREFIX', 'PTCCLR'),
    fileExtension: text('WIRE_DIRECT_SEND_FILE_EXTENSION', '.xml'),
    // Where the drop lands in file mode, relative to WIRE_H2H_REMOTE_ROOT.
    dropDir: text('WIRE_DIRECT_SEND_DROP_DIR', 'clearing'),
    writeManifest: boolEnv('WIRE_DIRECT_SEND_WRITE_MANIFEST', true),
    manifestSuffix: text('WIRE_DIRECT_SEND_MANIFEST_SUFFIX', '.manifest.json'),
    // A copy of every file the trust sent, kept locally regardless of transport,
    // because the file is the instruction of record.
    archiveDir: path.resolve(text('WIRE_DIRECT_SEND_ARCHIVE_DIR', path.join(process.cwd(), 'data', 'wire-direct-send'))),

    // Batching
    maxItems: intEnv('WIRE_DIRECT_SEND_MAX_ITEMS', 500, { min: 1, max: 100000 }),
    maxAmountCents: intEnv('WIRE_DIRECT_SEND_MAX_AMOUNT_CENTS', 0),
    minItems: intEnv('WIRE_DIRECT_SEND_MIN_ITEMS', 1, { min: 1, max: 100000 }),
    // How long a dispatched wire may wait for company in a batch before the
    // cutoff sends it alone.
    holdMinutes: intEnv('WIRE_DIRECT_SEND_HOLD_MINUTES', 0, { min: 0, max: 1440 }),

    // Reconciliation
    receiptSlaMinutes: intEnv('WIRE_DIRECT_SEND_RECEIPT_SLA_MINUTES', 30, { min: 1, max: 10080 }),
    // A batch that entered `transmitting` and never came back out: the pipeline
    // may hold the file, so it is escalated rather than resent.
    stuckMinutes: intEnv('WIRE_DIRECT_SEND_STUCK_MINUTES', 15, { min: 1, max: 1440 }),

    // Automation
    autoSend: boolEnv('WIRE_DIRECT_SEND_AUTO', false),
    autoIntervalSeconds: intEnv('WIRE_DIRECT_SEND_INTERVAL_SECONDS', 900, { min: 30, max: 86400 }),
  };
}

function directSendReadiness() {
  const config = getDirectSendConfig();
  const blockers = [];
  const warnings = [];

  if (!config.enabled) blockers.push('WIRE_DIRECT_SEND_ENABLED is off: the clearing pipeline is closed');

  if (config.mode === 'pipeline') {
    if (!/^https:\/\//i.test(config.endpoint)) {
      blockers.push('WIRE_DIRECT_SEND_URL must be https: a clearing file may not travel in the clear');
    }
    const hasCert = Boolean(config.clientCert || config.clientCertPath);
    const hasKey = Boolean(config.clientKey || config.clientKeyPath);
    if (hasCert !== hasKey) {
      blockers.push('WIRE_DIRECT_SEND_CLIENT_CERT and WIRE_DIRECT_SEND_CLIENT_KEY must be supplied together');
    }
    if (!hasCert && !config.authToken && !config.apiKey) {
      blockers.push('the pipeline has no client certificate, token or API key: the bank cannot authenticate the trust');
    }
    if (config.insecureTls) {
      warnings.push('WIRE_DIRECT_SEND_INSECURE_TLS is on: the bank endpoint certificate is not verified.');
    }
    if (!hasCert) {
      warnings.push('No client certificate: the pipeline is authenticated by bearer credential only.');
    }
  } else {
    warnings.push('No WIRE_DIRECT_SEND_URL: files are dropped on the host-to-host channel instead of posted.');
  }

  const signed = Boolean(config.signingSecret || config.signingKeyPath);
  if (config.requireSignature && !signed) {
    blockers.push('no WIRE_DIRECT_SEND_SIGNING_SECRET or WIRE_DIRECT_SEND_SIGNING_KEY_PATH: the file cannot be signed');
  }
  if (!signed) warnings.push('Clearing files are unsigned: the bank can only authenticate the channel.');
  if (!config.receiverId) warnings.push('WIRE_DIRECT_SEND_RECEIVER_ID is unset: the file header names no receiving bank.');

  return {
    ready: blockers.length === 0,
    enabled: config.enabled,
    mode: config.mode,
    endpoint: config.endpoint ? config.endpoint.replace(/\/\/[^@/]*@/, '//') : null,
    senderId: config.senderId,
    receiverId: config.receiverId || null,
    rails: config.rails,
    signing: signed ? config.signingAlgorithm : 'none',
    blockers,
    warnings,
    note: blockers.length === 0
      ? 'Direct Send can assemble a clearing file from dispatched wires and push it at the bank pipeline.'
      : 'Direct Send is closed until the listed configuration is supplied; the channel fails closed.',
  };
}

module.exports = { getDirectSendConfig, directSendReadiness };
