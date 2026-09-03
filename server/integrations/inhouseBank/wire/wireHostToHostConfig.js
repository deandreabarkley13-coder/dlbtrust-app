'use strict';

/**
 * Direct host-to-host wire channel — configuration
 *
 * The PTC family bank does not hand its wires to an aggregator: it writes the
 * pacs.008 into the correspondent bank's own SFTP drop and reads the bank's
 * acknowledgement, status and return advices back out of it. That makes the
 * channel a pair of directories and a host key, and every one of them has to
 * be pinned before a payment file may leave.
 *
 * Two properties are load-bearing:
 *
 *   • The host key is verified. An SFTP wire channel that accepts any host key
 *     is a wire channel that can be pointed at somebody else's server, so the
 *     default is to refuse an unpinned host. `WIRE_H2H_ALLOW_UNKNOWN_HOST_KEY`
 *     exists for a lab, not for production.
 *   • The spool transport is not a simulator. When no SFTP host is configured
 *     the engine writes the same bytes to a local directory tree with the same
 *     directory layout, so a file can be produced and reconciled end to end
 *     without inventing a fake bank response.
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

function joinRemote(base, child) {
  if (!child) return base;
  if (child.startsWith('/')) return child;
  return `${String(base).replace(/\/+$/, '')}/${child}`;
}

function getWireChannelConfig() {
  const root = text('WIRE_H2H_REMOTE_ROOT', '/wire');
  const host = text('WIRE_H2H_SFTP_HOST');
  const mftChannelId = text('WIRE_H2H_MFT_CHANNEL');
  return {
    // Transport. Naming an MFT channel hands delivery to the MFT register,
    // which then owns the bank host, the bytes and the release decision.
    transport: mftChannelId ? 'mft' : host ? 'sftp' : 'spool',
    mftChannelId,
    host,
    port: intEnv('WIRE_H2H_SFTP_PORT', 22, { min: 1, max: 65535 }),
    username: text('WIRE_H2H_SFTP_USER'),
    password: text('WIRE_H2H_SFTP_PASSWORD'),
    privateKey: text('WIRE_H2H_SFTP_PRIVATE_KEY'),
    privateKeyPath: text('WIRE_H2H_SFTP_PRIVATE_KEY_PATH'),
    passphrase: text('WIRE_H2H_SFTP_PASSPHRASE'),
    // sha256 base64 or hex fingerprint of the bank's host key, as published by
    // the bank in its connectivity pack.
    hostKeyFingerprint: text('WIRE_H2H_SFTP_HOST_KEY_FINGERPRINT'),
    allowUnknownHostKey: boolEnv('WIRE_H2H_ALLOW_UNKNOWN_HOST_KEY', false),
    connectTimeoutMs: intEnv('WIRE_H2H_CONNECT_TIMEOUT_MS', 30000, { min: 1000, max: 300000 }),
    spoolDir: path.resolve(text('WIRE_H2H_SPOOL_DIR', path.join(process.cwd(), 'data', 'wire-h2h'))),

    // Directory layout on the bank host
    outboundPath: joinRemote(root, text('WIRE_H2H_OUTBOUND_DIR', 'outbound')),
    ackPath: joinRemote(root, text('WIRE_H2H_ACK_DIR', 'ack')),
    returnPath: joinRemote(root, text('WIRE_H2H_RETURN_DIR', 'returns')),
    archivePath: joinRemote(root, text('WIRE_H2H_ARCHIVE_DIR', 'archive')),

    // File conventions
    filePrefix: text('WIRE_H2H_FILE_PREFIX', 'PTCWIRE'),
    // The bank picks files up from the outbound directory continuously, so a
    // partially written file would be collected mid-write. Every file is
    // therefore written under a staging suffix and renamed into place.
    stagingSuffix: text('WIRE_H2H_STAGING_SUFFIX', '.tmp'),

    // Rails this channel is allowed to carry. A same-day ACH file has no
    // business going out of the wire drop.
    rails: (text('WIRE_H2H_RAILS', 'fedwire').split(',').map(r => r.trim()).filter(Boolean)),

    // Reconciliation
    ackSlaMinutes: intEnv('WIRE_H2H_ACK_SLA_MINUTES', 120, { min: 1, max: 10080 }),
    settlementSlaMinutes: intEnv('WIRE_H2H_SETTLEMENT_SLA_MINUTES', 1440, { min: 1, max: 20160 }),
    // A reservation whose transmitting process died leaves a vault row with no
    // outcome. After this long the engine may re-take it, but only after it has
    // proved on the bank host that the file is not already there.
    reservationStaleMinutes: intEnv('WIRE_H2H_RESERVATION_STALE_MINUTES', 15, { min: 1, max: 1440 }),
    archiveProcessedAdvices: boolEnv('WIRE_H2H_ARCHIVE_ADVICES', true),
  };
}

function wireChannelReadiness() {
  const config = getWireChannelConfig();
  const blockers = [];
  if (config.transport === 'sftp') {
    if (!config.username) blockers.push('WIRE_H2H_SFTP_USER is unset: the bank host cannot authenticate the trust');
    if (!config.password && !config.privateKey && !config.privateKeyPath) {
      blockers.push('no WIRE_H2H_SFTP_PRIVATE_KEY, WIRE_H2H_SFTP_PRIVATE_KEY_PATH or WIRE_H2H_SFTP_PASSWORD');
    }
    if (!config.hostKeyFingerprint && !config.allowUnknownHostKey) {
      blockers.push('WIRE_H2H_SFTP_HOST_KEY_FINGERPRINT is unset: the bank host key cannot be pinned');
    }
  }
  const warnings = [];
  if (config.transport === 'mft') {
    warnings.push(`Wire files are delivered through MFT channel ${config.mftChannelId}; its readiness is checked at transmission.`);
  }
  if (config.transport === 'spool') {
    warnings.push(`No WIRE_H2H_SFTP_HOST: files are written to the local spool at ${config.spoolDir} and reach no bank.`);
  }
  if (config.allowUnknownHostKey) {
    warnings.push('WIRE_H2H_ALLOW_UNKNOWN_HOST_KEY is on: any host presenting the right credentials can receive wire files.');
  }
  return {
    ready: blockers.length === 0,
    transport: config.transport,
    host: config.host || null,
    outboundPath: config.outboundPath,
    ackPath: config.ackPath,
    returnPath: config.returnPath,
    rails: config.rails,
    blockers,
    warnings,
  };
}

module.exports = { getWireChannelConfig, wireChannelReadiness };
