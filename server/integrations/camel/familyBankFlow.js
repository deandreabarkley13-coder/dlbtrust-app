'use strict';

/**
 * The unified family-bank data flow, expressed as Camel routes
 *
 * Before this file, moving money through the family bank meant knowing the
 * order in which to call five engines: normalise the instruction, submit it,
 * wait for governance, execute it, then remember which last-mile channel that
 * rail uses — OpenACH for ACH, the host-to-host link for wires, nothing at all
 * for an on-us book transfer. Every caller reimplemented that knowledge, and a
 * caller that got it wrong left money debited and nothing originated.
 *
 * The flow below is that knowledge, written once:
 *
 *   family-bank-ingress        any channel → canonical instruction → submitted
 *     └─ choice: already dispatched   → family-bank-dispatch
 *                needs approval       → the flow stops and waits for governance
 *                approved, not moved  → family-bank-execute
 *                refused by policy    → recorded and the flow ends
 *   family-bank-execute        capture the hold, post both ledgers, dispatch
 *   family-bank-dispatch       hand the dispatched payment to its last mile
 *     └─ choice: on-us   → family-bank-onus
 *                ACH     → family-bank-openach-dispatch   (originate at the ODFI)
 *                wire    → family-bank-wire-dispatch      (host-to-host file)
 *                other   → family-bank-manual-rail        (a human must act)
 *   family-bank-openach-status  poll the ODFI and confirm settlements/returns
 *   family-bank-advice          a rail (or a JVM Camel runtime) reports an
 *                               outcome inbound; the only path to settled
 *   family-bank-file-batch      one ERP/bank file → one exchange per instruction
 *
 * Two invariants hold across all of it. Nothing here posts a ledger entry or
 * decides an outcome itself: every step delegates to the engine that owns that
 * decision, so the audit trail stays where the auditors already look. And every
 * step that touches an external rail consumes idempotently on the payment id,
 * because a redelivered exchange must never originate a second entry.
 */

const { CamelRouteEngine } = require('./camelRouteEngine');
const { InHouseBankEngine } = require('../inhouseBank/inHouseBankEngine');
const { DualLedgerEngine } = require('../inhouseBank/dualLedgerEngine');
const { OpenAchRailEngine } = require('../openach/openachRailEngine');

const ACH_RAILS = Object.freeze(['ach_standard', 'ach_same_day']);
const WIRE_RAILS = Object.freeze(['fedwire']);

const TOPICS = Object.freeze({
  requested: 'trust.payment.requested',
  approved: 'trust.payment.approved',
  transmitted: 'trust.payment.transmitted',
  settled: 'trust.payment.settled',
  failed: 'trust.payment.failed',
});

function payment(context) {
  return context.body && context.body.payment ? context.body.payment : context.body || {};
}

/** Statuses OpenACH and the wire host use, mapped onto the bank's outcomes. */
const ADVICE_OUTCOMES = Object.freeze({
  settled: 'settled',
  complete: 'settled',
  completed: 'settled',
  posted: 'settled',
  returned: 'returned',
  return: 'returned',
  failed: 'failed',
  rejected: 'failed',
});

function registerProcessors() {
  /**
   * Ingress. `InHouseBankEngine.submit` already normalises, screens, prices and
   * routes the instruction, so the route's job is to hand it the exchange and
   * keep the payment id on the headers for everything downstream.
   */
  CamelRouteEngine.registerProcessor('submitPayment', async (context) => {
    const body = context.body || {};
    const principal = body.principal || context.headers.principal || 'camel';
    const result = await InHouseBankEngine.submit({
      idempotencyKey: body.idempotencyKey || context.headers.idempotencyKey || context.exchangeId,
      payload: body.instruction || body,
      // The engine reads the verified principal off an object, not a string.
      principal: typeof principal === 'object' ? principal : { principal },
      channel: body.channel || context.headers.channel || 'api',
    });
    context.headers.paymentId = result.payment ? result.payment.paymentId : result.paymentId || null;
    context.headers.rail = result.payment ? result.payment.rail : null;
    context.headers.internal = Boolean(result.payment && result.payment.internal);
    context.headers.replay = Boolean(result.replay);
    return result;
  });

  CamelRouteEngine.registerProcessor('executePayment', async (context) => {
    const id = context.headers.paymentId;
    const executed = await InHouseBankEngine.execute(id, { actor: context.headers.principal || 'camel' });
    context.headers.rail = executed.rail;
    context.headers.internal = Boolean(executed.internal);
    return { payment: executed };
  });

  /**
   * ACH last mile. A payment whose rail OpenACH cannot carry, or an OpenACH that
   * is not configured, is a routing problem rather than a payment problem: it is
   * reported on the exchange and left for the operator instead of being retried
   * forever against a rail that will never accept it.
   */
  CamelRouteEngine.registerProcessor('originateOpenAch', async (context) => {
    const id = context.headers.paymentId;
    const readiness = OpenAchRailEngine.readiness();
    if (!readiness.ready) {
      await DualLedgerEngine.appendEvent({
        eventType: 'payment.origination_deferred',
        paymentId: id,
        actor: 'camel',
        payload: { channel: 'openach', blockers: readiness.blockers },
      }).catch(() => null);
      return { originated: false, deferred: true, blockers: readiness.blockers };
    }
    const result = await OpenAchRailEngine.originate(id, { actor: 'camel' });
    context.headers.paymentScheduleId = result.dispatch ? result.dispatch.paymentScheduleId : null;
    return result;
  });

  CamelRouteEngine.registerProcessor('dispatchWire', async (context) => {
    const id = context.headers.paymentId;
    const { WireDispatchLink } = require('../inhouseBank/wire/wireDispatchLink');
    const result = await WireDispatchLink.kick(id, { actor: 'camel' });
    return result;
  });

  /**
   * The clearing cutoff. Direct Send assembles every dispatched wire that is
   * still waiting into one raw clearing file and pushes it at the bank's
   * pipeline. Nothing here decides an outcome: the file either cleared, was
   * refused, or is held for an operator, and the engine records which.
   */
  CamelRouteEngine.registerProcessor('directSendClearingFile', async (context) => {
    const { WireDirectSendEngine } = require('../inhouseBank/wire/wireDirectSendEngine');
    const readiness = WireDirectSendEngine.readiness();
    if (!readiness.ready) {
      await DualLedgerEngine.appendEvent({
        eventType: 'payment.origination_deferred',
        actor: 'camel',
        payload: { channel: 'direct-send', blockers: readiness.blockers },
      }).catch(() => null);
      return { sent: false, deferred: true, blockers: readiness.blockers };
    }
    const result = await WireDirectSendEngine.directSend({
      actor: context.headers.principal || 'camel',
      paymentIds: context.headers.paymentIds || null,
    });
    context.headers.batchId = result.batch ? result.batch.batchId : null;
    return result;
  });

  CamelRouteEngine.registerProcessor('pollOpenAchStatuses', async () => {
    return OpenAchRailEngine.pollStatuses({ actor: 'camel' });
  });

  /**
   * A rail's own report, from a webhook, an operator, or a JVM Camel runtime
   * mediating the bank's file channel. Normalisation happens here so that the
   * apply step sees one shape whatever reported it.
   */
  CamelRouteEngine.registerProcessor('normalizeAdvice', async (context) => {
    const body = context.body || {};
    const paymentId = body.paymentId || body.payment_id || context.headers.paymentId || null;
    const rawStatus = String(body.status || body.outcome || body.state || '').trim();
    const outcome = ADVICE_OUTCOMES[rawStatus.toLowerCase()]
      || (/^r\d{2}$/i.test(rawStatus) ? 'returned' : null);
    context.headers.paymentId = paymentId;
    context.headers.adviceOutcome = outcome;
    return {
      paymentId,
      status: rawStatus || null,
      outcome,
      reference: body.reference || body.settlementReference || null,
      reason: body.reason || null,
      rail: body.rail || context.headers.rail || null,
      raw: body,
    };
  });

  /**
   * Apply the advice. ACH advices go through the OpenACH dispatch row so its
   * state and the payment's stay in step; anything else confirms directly. Both
   * end in `InHouseBankEngine.confirm`, which is the only door to settled.
   */
  CamelRouteEngine.registerProcessor('applyAdvice', async (context) => {
    const advice = context.body || {};
    if (!advice.paymentId) throw new Error('an advice without a paymentId cannot be applied');
    const dispatch = await OpenAchRailEngine.get(advice.paymentId);
    if (dispatch) {
      return OpenAchRailEngine.applyStatus({
        paymentId: advice.paymentId,
        status: advice.status,
        reference: advice.reference,
        reason: advice.reason,
        actor: 'camel-advice',
        raw: advice.raw || {},
      });
    }
    const confirmed = await InHouseBankEngine.confirm(advice.paymentId, {
      outcome: advice.outcome,
      reference: advice.outcome === 'settled' ? advice.reference : null,
      reason: advice.outcome === 'settled' ? null : (advice.reason || `rail reported ${advice.status}`),
      actor: 'camel-advice',
    });
    return { applied: true, outcome: advice.outcome, paymentStatus: confirmed.status };
  });

  CamelRouteEngine.registerProcessor('noteOnUsSettlement', async (context) => {
    const settled = payment(context);
    await DualLedgerEngine.appendEvent({
      eventType: 'flow.onus_completed',
      paymentId: context.headers.paymentId,
      actor: 'camel',
      payload: { amountCents: settled.amountCents, status: settled.status },
    }).catch(() => null);
    return { onUs: true, status: settled.status };
  });

  /**
   * A rail with no automated channel. This is deliberately an event rather than
   * a silent success: somebody has to move the money, and the only way they will
   * know is if the bank says so.
   */
  CamelRouteEngine.registerProcessor('flagManualRail', async (context) => {
    const pending = payment(context);
    await DualLedgerEngine.appendEvent({
      eventType: 'payment.manual_rail_required',
      paymentId: context.headers.paymentId,
      actor: 'camel',
      payload: { rail: pending.rail, amountCents: pending.amountCents },
    }).catch(() => null);
    return { manual: true, rail: pending.rail };
  });

  /**
   * Policy refused the payment. The engine already recorded the rejection and
   * released the hold, so the flow's only job is to stop reporting the exchange
   * as an unfinished payment.
   */
  CamelRouteEngine.registerProcessor('noteRefused', async (context) => {
    const refused = payment(context);
    await DualLedgerEngine.appendEvent({
      eventType: 'flow.refused',
      paymentId: context.headers.paymentId,
      actor: 'camel',
      payload: { status: refused.status, reason: refused.failureReason || null },
    }).catch(() => null);
    return { refused: true, status: refused.status };
  });

  CamelRouteEngine.registerProcessor('noteAwaitingApproval', async (context) => {
    const held = payment(context);
    await DualLedgerEngine.appendEvent({
      eventType: 'flow.awaiting_approval',
      paymentId: context.headers.paymentId,
      actor: 'camel',
      payload: { requiredApprovals: held.requiredApprovals, status: held.status },
    }).catch(() => null);
    return { awaitingApproval: true, status: held.status };
  });

  CamelRouteEngine.registerSplitter('instructionsInFile', async (context) => {
    const body = context.body || {};
    const instructions = Array.isArray(body.instructions) ? body.instructions : [];
    return instructions.map((instruction, index) => ({
      body: {
        instruction,
        channel: body.channel || 'file',
        principal: body.principal || 'camel-file',
        idempotencyKey: instruction.idempotencyKey || `${body.batchId || context.exchangeId}-${index}`,
      },
      headers: { batchId: body.batchId || context.exchangeId, batchIndex: index },
      messageKey: `${body.batchId || context.exchangeId}#${index}`,
    }));
  });
}

function registerPredicates() {
  CamelRouteEngine.registerPredicate('awaitingApproval', (context) => {
    const submitted = payment(context);
    return submitted.status === 'pending_approval' || submitted.status === 'received';
  });
  CamelRouteEngine.registerPredicate('readyToExecute', (context) => payment(context).status === 'approved');
  // `submit` executes anything that needed no signature, so the common case at
  // ingress is a payment that is already dispatched and only needs its rail.
  CamelRouteEngine.registerPredicate('isDispatched', (context) => payment(context).status === 'dispatched');
  CamelRouteEngine.registerPredicate('isRefused', (context) => ['rejected', 'failed', 'cancelled'].includes(payment(context).status));
  CamelRouteEngine.registerPredicate('isInternal', (context) => Boolean(payment(context).internal));
  CamelRouteEngine.registerPredicate('isAchRail', (context) => ACH_RAILS.includes(payment(context).rail));
  CamelRouteEngine.registerPredicate('isWireRail', (context) => WIRE_RAILS.includes(payment(context).rail));
  CamelRouteEngine.registerPredicate('adviceHasOutcome', (context) => Boolean((context.body || {}).outcome));
}

function registerRoutes() {
  CamelRouteEngine.register({
    routeId: 'family-bank-ingress',
    description: 'Any channel to a submitted in-house bank payment, then on to execution or governance.',
    from: { uri: 'direct:family-bank-ingress', kind: 'direct' },
    idempotentKeyHeader: 'idempotencyKey',
    steps: [
      { type: 'process', processor: 'submitPayment', updatesBody: true, note: 'ingress, screening, policy and routing' },
      { type: 'wireTap', topic: TOPICS.requested },
      {
        type: 'choice',
        when: [
          { predicate: 'isDispatched', steps: [{ type: 'to', route: 'family-bank-dispatch' }] },
          { predicate: 'readyToExecute', steps: [{ type: 'to', route: 'family-bank-execute' }] },
          { predicate: 'awaitingApproval', steps: [{ type: 'process', processor: 'noteAwaitingApproval' }] },
          { predicate: 'isRefused', steps: [{ type: 'process', processor: 'noteRefused' }] },
        ],
      },
    ],
  });

  CamelRouteEngine.register({
    routeId: 'family-bank-execute',
    description: 'Capture the hold, post the bank ledger and the GL, and hand the payment to its rail.',
    from: { uri: 'direct:family-bank-execute', kind: 'direct' },
    idempotentKeyHeader: 'paymentId',
    steps: [
      { type: 'process', processor: 'executePayment', updatesBody: true, note: 'ledger movement and dispatch' },
      { type: 'wireTap', topic: TOPICS.approved },
      { type: 'to', route: 'family-bank-dispatch' },
    ],
  });

  CamelRouteEngine.register({
    routeId: 'family-bank-dispatch',
    description: 'Choose the last mile for a dispatched payment: on-us, OpenACH, the wire host, or an operator.',
    from: { uri: 'direct:family-bank-dispatch', kind: 'direct' },
    steps: [
      {
        type: 'choice',
        when: [
          { predicate: 'isInternal', steps: [{ type: 'to', route: 'family-bank-onus' }] },
          { predicate: 'isAchRail', steps: [{ type: 'to', route: 'family-bank-openach-dispatch' }] },
          { predicate: 'isWireRail', steps: [{ type: 'to', route: 'family-bank-wire-dispatch' }] },
        ],
        otherwise: [{ type: 'to', route: 'family-bank-manual-rail' }],
      },
    ],
  });

  CamelRouteEngine.register({
    routeId: 'family-bank-openach-dispatch',
    description: 'Originate a dispatched ACH payment at the ODFI through OpenACH, once and only once.',
    from: { uri: 'direct:family-bank-openach-dispatch', kind: 'direct' },
    idempotentKeyHeader: 'paymentId',
    steps: [
      { type: 'process', processor: 'originateOpenAch', updatesBody: true, note: 'OpenACH origination' },
      { type: 'wireTap', topic: TOPICS.transmitted },
    ],
  });

  CamelRouteEngine.register({
    routeId: 'family-bank-wire-dispatch',
    description: 'Hand a dispatched wire to the host-to-host channel.',
    from: { uri: 'direct:family-bank-wire-dispatch', kind: 'direct' },
    idempotentKeyHeader: 'paymentId',
    steps: [
      { type: 'process', processor: 'dispatchWire', updatesBody: true, note: 'host-to-host transmission' },
      { type: 'wireTap', topic: TOPICS.transmitted },
    ],
  });

  CamelRouteEngine.register({
    routeId: 'family-bank-onus',
    description: 'An on-us book transfer is already settled; record that the flow finished.',
    from: { uri: 'direct:family-bank-onus', kind: 'direct' },
    steps: [
      { type: 'process', processor: 'noteOnUsSettlement', updatesBody: true },
      { type: 'wireTap', topic: TOPICS.settled },
    ],
  });

  CamelRouteEngine.register({
    routeId: 'family-bank-manual-rail',
    description: 'A dispatched payment on a rail with no automated channel needs an operator.',
    from: { uri: 'direct:family-bank-manual-rail', kind: 'direct' },
    idempotentKeyHeader: 'paymentId',
    steps: [
      { type: 'process', processor: 'flagManualRail', updatesBody: true },
      { type: 'wireTap', topic: TOPICS.transmitted },
    ],
  });

  CamelRouteEngine.register({
    routeId: 'family-bank-wire-direct-send',
    description: 'Clearing cutoff: batch the dispatched wires into one raw clearing file and Direct Send it to the bank pipeline.',
    from: { uri: 'timer:wire-direct-send?period=900000', kind: 'timer' },
    steps: [
      { type: 'process', processor: 'directSendClearingFile', updatesBody: true, note: 'Direct Send clearing file' },
      { type: 'wireTap', topic: TOPICS.transmitted },
    ],
  });

  CamelRouteEngine.register({
    routeId: 'family-bank-openach-status',
    description: 'Poll OpenACH for the status of every originated entry and confirm what it reports.',
    from: { uri: 'timer:openach-status?period=300000', kind: 'timer' },
    steps: [
      { type: 'process', processor: 'pollOpenAchStatuses', updatesBody: true },
      { type: 'wireTap', topic: TOPICS.settled },
    ],
  });

  CamelRouteEngine.register({
    routeId: 'family-bank-advice',
    description: 'An inbound rail advice: the only path from dispatched to settled, returned or failed.',
    from: { uri: 'platform-http:/api/camel/inbox/family-bank-advice', kind: 'http' },
    idempotentKeyHeader: 'adviceId',
    steps: [
      { type: 'transform', processor: 'normalizeAdvice' },
      { type: 'filter', predicate: 'adviceHasOutcome' },
      { type: 'process', processor: 'applyAdvice', updatesBody: true },
      { type: 'wireTap', topic: TOPICS.settled },
    ],
  });

  CamelRouteEngine.register({
    routeId: 'family-bank-file-batch',
    description: 'One ERP or bank instruction file becomes one exchange per instruction.',
    from: { uri: 'platform-http:/api/camel/inbox/family-bank-file-batch', kind: 'http' },
    idempotentKeyHeader: 'batchId',
    steps: [
      { type: 'split', splitter: 'instructionsInFile', to: 'family-bank-ingress' },
    ],
  });
}

let installed = false;

/**
 * Install the flow into the integration context. Idempotent, because the server
 * mounts it at boot and a test or a CLI may install it again in the same
 * process; registering twice must not double-mediate anything.
 */
function installFamilyBankFlow({ force = false } = {}) {
  if (installed && !force) return { installed: false, reason: 'already installed', routes: CamelRouteEngine.routes().length };
  registerProcessors();
  registerPredicates();
  registerRoutes();
  installed = true;
  return { installed: true, routes: CamelRouteEngine.routes().length };
}

/** Put an instruction on the flow. This is what every channel should call. */
async function submitToFlow({ instruction, idempotencyKey, principal = 'camel', channel = 'api' } = {}) {
  installFamilyBankFlow();
  if (!idempotencyKey) throw new Error('an idempotency key is required to put a payment on the flow');
  return CamelRouteEngine.send('family-bank-ingress', { instruction, idempotencyKey, principal, channel }, {
    headers: { idempotencyKey, principal, channel },
    messageKey: idempotencyKey,
    source: `channel:${channel}`,
  });
}

module.exports = {
  installFamilyBankFlow,
  submitToFlow,
  ACH_RAILS,
  WIRE_RAILS,
  TOPICS,
};
