'use strict';

/**
 * Camel YAML DSL renderer — the same flow, for a JVM Camel runtime
 *
 * The bus in this repo mediates the family bank's flow in process, which is what
 * makes the flow work with nothing else deployed. Some estates want the real
 * thing: Camel on the JVM (or Camel K / Camel JBang) fronting the bank's file
 * drops, SFTP directories, JMS queues and partner HTTP endpoints, because those
 * are the components Camel already has and this repo does not.
 *
 * This renderer emits that deployment from the *registered* routes rather than
 * from a hand-written copy, so a route added to the flow cannot silently be
 * missing from the runtime. The generated routes are deliberately thin: each one
 * consumes from its channel and posts the message to this application's signed
 * inbox, where the engines that own the ledger take over. Camel does the
 * transport and the retries it is good at; it never decides a payment.
 *
 * Generated endpoints assume two properties:
 *   dlbtrust.baseUrl   where this application answers
 *   dlbtrust.inboxKey  the shared secret used for the X-Camel-Signature header
 */

const { CamelRouteEngine } = require('./camelRouteEngine');
const { getCamelConfig } = require('./camelConfig');

function indent(depth) {
  return ' '.repeat(depth * 2);
}

function quote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

/**
 * Describe an in-process step as a YAML comment. The JVM runtime does not run
 * these steps — the application does — but a reader of the deployment needs to
 * know what happens on the other side of the inbox call.
 */
function stepComment(step, depth) {
  const pad = indent(depth);
  switch (step.type) {
    case 'choice': {
      const clauses = step.when.map(clause => clause.predicate).join(' | ');
      return `${pad}# choice: ${clauses}${step.otherwise ? ' | otherwise' : ''}`;
    }
    case 'split': return `${pad}# split(${step.splitter}) -> ${step.to}`;
    case 'to': return `${pad}# to(${step.route})`;
    case 'wireTap': return `${pad}# wireTap(${step.topic})`;
    case 'filter': return `${pad}# filter(${step.predicate})`;
    default: return `${pad}# ${step.type}(${step.processor || step.name || ''})`;
  }
}

function consumerFor(route) {
  const uri = route.from.uri;
  if (uri.startsWith('platform-http:')) return uri;
  if (uri.startsWith('timer:')) return uri;
  // A direct: route is only reachable from inside the context, so the runtime
  // exposes it as HTTP under the same name instead of inventing a channel.
  return `platform-http:/camel/${route.routeId}`;
}

function renderRoute(route, { inboxPath }) {
  const lines = [];
  lines.push(`${indent(1)}- route:`);
  lines.push(`${indent(3)}id: ${route.routeId}`);
  if (route.description) lines.push(`${indent(3)}description: ${quote(route.description)}`);
  lines.push(`${indent(3)}from:`);
  lines.push(`${indent(4)}uri: ${quote(consumerFor(route))}`);
  lines.push(`${indent(4)}steps:`);
  lines.push(`${indent(5)}- setHeader:`);
  lines.push(`${indent(7)}name: CamelHttpMethod`);
  lines.push(`${indent(7)}constant: POST`);
  lines.push(`${indent(5)}- setHeader:`);
  lines.push(`${indent(7)}name: X-Camel-Route`);
  lines.push(`${indent(7)}constant: ${route.routeId}`);
  if (route.idempotentKeyHeader) {
    lines.push(`${indent(5)}- setHeader:`);
    lines.push(`${indent(7)}name: X-Camel-Message-Key`);
    lines.push(`${indent(7)}simple: ${quote(`\${header.${route.idempotentKeyHeader}}`)}`);
  }
  // The signature is computed by the runtime's signer bean; an unsigned inbox
  // call is refused, which is the point.
  lines.push(`${indent(5)}- bean:`);
  lines.push(`${indent(7)}ref: inboxSigner`);
  lines.push(`${indent(7)}method: sign`);
  lines.push(`${indent(5)}- to:`);
  lines.push(`${indent(7)}uri: ${quote(`{{dlbtrust.baseUrl}}${inboxPath}/${route.routeId}`)}`);
  lines.push(`${indent(5)}- log:`);
  lines.push(`${indent(7)}message: ${quote(`${route.routeId} mediated \${header.X-Camel-Message-Key}`)}`);
  route.steps.forEach(step => lines.push(stepComment(step, 5)));
  return lines.join('\n');
}

/**
 * The driver route. The application's own scheduler already drives the bus; a
 * runtime that owns the schedule instead can disable it (CAMEL_BUS_ENABLED=false)
 * and drive it from here, which is the deployment where Camel is the scheduler
 * of record.
 */
function renderDriver({ intervalSeconds }) {
  return [
    `${indent(1)}- route:`,
    `${indent(3)}id: family-bank-bus-driver`,
    `${indent(3)}description: ${quote('Drive pending exchanges in the application context, including redeliveries.')}`,
    `${indent(3)}from:`,
    `${indent(4)}uri: ${quote(`timer:family-bank-bus?period=${intervalSeconds * 1000}`)}`,
    `${indent(4)}steps:`,
    `${indent(5)}- setHeader:`,
    `${indent(7)}name: CamelHttpMethod`,
    `${indent(7)}constant: POST`,
    `${indent(5)}- bean:`,
    `${indent(7)}ref: inboxSigner`,
    `${indent(7)}method: sign`,
    `${indent(5)}- to:`,
    `${indent(7)}uri: ${quote('{{dlbtrust.baseUrl}}/api/camel/drive')}`,
    `${indent(5)}- log:`,
    `${indent(7)}message: ${quote('bus drive: ${body}')}`,
  ].join('\n');
}

/**
 * Render the whole deployment. `routes` defaults to whatever is registered, so
 * the output is the flow as it actually runs.
 */
function renderCamelYaml({ routes = null, inboxPath = '/api/camel/inbox', intervalSeconds = null } = {}) {
  const config = getCamelConfig();
  const registered = routes || CamelRouteEngine.routes();
  const header = [
    '# Apache Camel deployment for the PTC in-house family bank',
    '#',
    '# Generated from the registered routes of the application integration context',
    `# (${config.contextName}) by server/integrations/camel/camelYaml.js. Do not edit by`,
    '# hand: regenerate with `node server/scripts/camelBus.js yaml`.',
    '#',
    '# Required properties:',
    '#   dlbtrust.baseUrl  = https://host-of-this-application',
    '#   dlbtrust.inboxKey = the CAMEL_INBOUND_HMAC_SECRET of that application',
    '#',
    '# Each route consumes from its channel and posts the message to the signed',
    '# inbox. The application owns every ledger decision; Camel owns transport.',
    '',
    '- beans:',
    `${indent(2)}- name: inboxSigner`,
    `${indent(3)}type: org.dlbtrust.camel.InboxSigner`,
    `${indent(3)}properties:`,
    `${indent(4)}secret: "{{dlbtrust.inboxKey}}"`,
    '',
    'routes:',
  ].join('\n');

  const body = registered
    .map(route => renderRoute(route, { inboxPath }))
    .concat([renderDriver({ intervalSeconds: intervalSeconds || config.intervalSeconds })])
    .join('\n');

  return `${header}\n${body}\n`;
}

module.exports = { renderCamelYaml };
