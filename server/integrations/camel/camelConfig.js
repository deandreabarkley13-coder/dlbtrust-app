'use strict';

/**
 * Apache Camel integration layer — configuration
 *
 * The family bank has many mouths: the dashboard, ISO 20022 files, the wallet
 * app, OpenACH, the wire host, the general ledger. Camel is the mediation layer
 * that joins them into one flow, and this file holds the knobs that decide how
 * that flow behaves when something goes wrong: how often the bus runs, how many
 * times a failed exchange is redelivered, how long it waits between attempts,
 * and where an exchange goes when it has failed for the last time.
 *
 * The bus runs in-process against Postgres by default, which is what makes the
 * flow identical whether or not a JVM Camel runtime is deployed alongside. When
 * one is deployed, `bridgeUrl` is where this system pushes exchanges it wants
 * Camel itself to mediate, and every push is HMAC-signed: an integration bus
 * that accepts unsigned payment instructions is a payment instruction forger.
 */

function text(name, fallback = '') {
  const raw = process.env[name];
  return raw === undefined || raw === null || raw === '' ? fallback : String(raw).trim();
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function intEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}

function getCamelConfig() {
  return {
    // The bus is opt-out: an unattended exchange is worse than an idle bus.
    enabled: boolEnv('CAMEL_BUS_ENABLED', true),
    contextName: text('CAMEL_CONTEXT_NAME', 'ptc-family-bank'),
    intervalSeconds: intEnv('CAMEL_BUS_INTERVAL_SECONDS', 60, { min: 5, max: 86400 }),
    batchSize: intEnv('CAMEL_BUS_BATCH', 50, { min: 1, max: 500 }),
    maxRedeliveries: intEnv('CAMEL_MAX_REDELIVERIES', 4, { min: 0, max: 20 }),
    redeliveryDelaySeconds: intEnv('CAMEL_REDELIVERY_DELAY_SECONDS', 30, { min: 1, max: 3600 }),
    backoffMultiplier: intEnv('CAMEL_BACKOFF_MULTIPLIER', 3, { min: 1, max: 10 }),
    maxRedeliveryDelaySeconds: intEnv('CAMEL_MAX_REDELIVERY_DELAY_SECONDS', 1800, { min: 1, max: 86400 }),
    // Retention only prunes exchanges that reached a terminal state; a dead
    // letter is never pruned, because it is the evidence of an unfinished flow.
    completedRetentionDays: intEnv('CAMEL_COMPLETED_RETENTION_DAYS', 30, { min: 1, max: 3650 }),
    publishEvents: boolEnv('CAMEL_PUBLISH_EVENTS', true),

    // External JVM Camel runtime, if one fronts or follows this bus.
    bridgeUrl: text('CAMEL_BRIDGE_URL') || null,
    bridgeSecret: text('CAMEL_BRIDGE_HMAC_SECRET') || text('IHB_SIGNING_SECRET') || null,
    bridgeTimeoutMs: intEnv('CAMEL_BRIDGE_TIMEOUT_MS', 15000, { min: 1000, max: 120000 }),
    // Inbound exchanges from the Camel runtime must be signed with this secret.
    inboundSecret: text('CAMEL_INBOUND_HMAC_SECRET') || text('CAMEL_BRIDGE_HMAC_SECRET') || null,
    inboundMaxAgeSeconds: intEnv('CAMEL_INBOUND_MAX_AGE_SECONDS', 300, { min: 30, max: 3600 }),
  };
}

function camelReadiness() {
  const config = getCamelConfig();
  const blockers = [];
  const warnings = [];
  if (!config.enabled) blockers.push('CAMEL_BUS_ENABLED is off: exchanges are accepted but nothing mediates them');
  if (config.bridgeUrl && !config.bridgeSecret) {
    blockers.push('CAMEL_BRIDGE_URL is set without CAMEL_BRIDGE_HMAC_SECRET: an unsigned bridge push cannot be trusted by the runtime');
  }
  if (!config.inboundSecret) {
    warnings.push('no CAMEL_INBOUND_HMAC_SECRET: inbound exchanges from a Camel runtime will be refused');
  }
  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    contextName: config.contextName,
    mode: config.bridgeUrl ? 'in_process_with_bridge' : 'in_process',
    note: blockers.length === 0
      ? 'The integration context mediates exchanges in process and records every step.'
      : 'The integration context is closed; exchanges wait rather than being mediated unrecorded.',
  };
}

module.exports = { getCamelConfig, camelReadiness };
