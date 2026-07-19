'use strict';

/**
 * Connector registry — the pluggable extension point of the Banking Aggregator.
 *
 * A connector is a plain object implementing any of:
 *   pullAccounts(conn, opts)      → [normalized account]      (inbound)
 *   pullTransactions(conn, opts)  → [normalized transaction]  (inbound)
 *   pullStatements(conn, opts)    → [normalized statement]    (inbound)
 *   push(conn, payload)           → { ok, providerRef, ... }  (outbound)
 *   verifyWebhook(conn, headers, rawBody) → boolean           (inbound event)
 *   handleWebhook(conn, event, aggregator)                    (inbound event)
 *
 * To add a new provider, implement a connector and register it below (or call
 * registerConnector at startup). No changes to the engine or routes are needed.
 */

const { genericRestConnector } = require('./genericRestConnector');
const { internalRailsConnector } = require('./internalRailsConnector');
const { eatonConnector } = require('./eatonConnector');

const REGISTRY = new Map();

function registerConnector(connector) {
  if (!connector || !connector.type) throw new Error('Connector must have a "type"');
  REGISTRY.set(connector.type, connector);
}

function getConnector(type) {
  const c = REGISTRY.get(type);
  if (!c) throw new Error(`No connector registered for type "${type}"`);
  return c;
}

function listConnectorTypes() {
  return Array.from(REGISTRY.keys());
}

// Built-in connectors
registerConnector(genericRestConnector);
registerConnector(internalRailsConnector);
registerConnector(eatonConnector);

module.exports = { registerConnector, getConnector, listConnectorTypes };
