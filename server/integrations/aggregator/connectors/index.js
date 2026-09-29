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
 *   handshake(conn, { timeoutMs })                            (optional, lifecycle)
 *       → { externalConnectionId, capabilities: {pull,push,webhook}, meta? }
 *       Registers the connection with the provider and verifies the signed
 *       reply. Throw on any failure (bad signature, provider error, timeout).
 *       Declaring this method makes the handshake REQUIRED: the engine refuses
 *       pull/push for the connection until handshake_state = 'verified', and
 *       runs the handshake automatically on create/update unless the
 *       connection config sets autoHandshake: false.
 *
 * To add a new provider, implement a connector and register it below (or call
 * registerConnector at startup). No changes to the engine or routes are needed.
 */

const { genericRestConnector } = require('./genericRestConnector');
const { internalRailsConnector } = require('./internalRailsConnector');
const { bankSyncConnector } = require('./bankSyncConnector');
const { orangeRailsConnector } = require('./orangeRailsConnector');
const { simpleFinConnector } = require('./simpleFinConnector');
const { finlynqConnector } = require('./finlynqConnector');

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
registerConnector(bankSyncConnector);
registerConnector(orangeRailsConnector);
registerConnector(simpleFinConnector);
registerConnector(finlynqConnector);

module.exports = { registerConnector, getConnector, listConnectorTypes };
