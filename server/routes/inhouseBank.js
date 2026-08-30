'use strict';

/**
 * In-House Bank Orchestration Payment API — PTC In-House Family Bank
 *
 * Mounted at /api/inhouse-bank. Every route passes through the zero trust
 * gateway first: an authenticated operator session or a signed service call,
 * scoped to the operation, with the signature computed over the exact bytes the
 * caller sent. The gateway fails closed, so a route that cannot verify never
 * reaches an engine.
 */

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { InHouseBankEngine } = require('../integrations/inhouseBank/inHouseBankEngine');
const { IngressEngine } = require('../integrations/inhouseBank/ingressEngine');
const { VirtualAccountManager } = require('../integrations/inhouseBank/virtualAccountManager');
const { GovernanceEngine } = require('../integrations/inhouseBank/governanceEngine');
const { RoutingEngine } = require('../integrations/inhouseBank/routingEngine');
const { DualLedgerEngine } = require('../integrations/inhouseBank/dualLedgerEngine');
const { ZeroTrustGateway } = require('../integrations/inhouseBank/zeroTrustGateway');
const { WireHostToHostEngine } = require('../integrations/inhouseBank/wire/wireHostToHostEngine');
const { WireDispatchLink } = require('../integrations/inhouseBank/wire/wireDispatchLink');
const { WireDirectSendEngine } = require('../integrations/inhouseBank/wire/wireDirectSendEngine');
const { ClearingAutoFormatEngine } = require('../integrations/inhouseBank/clearing/clearingAutoFormatEngine');

const router = express.Router();

// pain.001 arrives as XML, which the JSON body parser mounted on the app skips.
// A data workflow handing over a CSV or a NACHA file is the same situation, so
// the clearing-spec routes accept those media types as raw text too.
router.use(express.text({ type: ['application/xml', 'text/xml', 'text/csv', 'text/plain'], limit: '8mb' }));

const sessionAuth = requireAuth({ role: 'operator' });

/**
 * A human operator authenticates with a session; a machine authenticates with a
 * signed service token that only the gateway understands. So a missing or
 * unusable session is not refused here — it just means `req.user` stays null
 * and the gateway has to find another reason to trust the caller. It refuses
 * when there is none.
 */
function optionalSession(req, res, next) {
  let settled = false;
  const advance = () => { if (!settled) { settled = true; next(); } };
  const shim = {
    status() { return shim; },
    json() { advance(); return shim; },
    send() { advance(); return shim; },
    setHeader() { return shim; },
  };
  sessionAuth(req, shim, advance);
}

function sendError(res, err) {
  const status = err.status || err.statusCode || 400;
  res.status(status).json({ success: false, error: err.message, code: err.code || null });
}

/**
 * Zero trust in front of every handler. `body` is the raw request bytes when
 * they are available, because that is what the client signed; falling back to
 * the parsed body would let a re-serialization difference break a valid
 * signature (or, worse, validate an altered one).
 */
function guard(scope) {
  return async (req, res, next) => {
    try {
      const body = Buffer.isBuffer(req.rawBody)
        ? req.rawBody.toString('utf8')
        : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
      req.ihb = await ZeroTrustGateway.authorize({
        scope,
        headers: req.headers,
        body,
        user: req.user || null,
        requestRef: req.headers['idempotency-key'] || null,
      });
      next();
    } catch (err) {
      sendError(res, err);
    }
  };
}

// ── Status ───────────────────────────────────────────────────────────────────

router.get('/health', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    const readiness = InHouseBankEngine.readiness();
    res.status(readiness.ready ? 200 : 503).json({ success: readiness.ready, data: readiness });
  } catch (err) { sendError(res, err); }
});

router.get('/dashboard', optionalSession, guard('payments:read'), async (req, res) => {
  try { res.json({ success: true, data: await InHouseBankEngine.dashboard() }); } catch (err) { sendError(res, err); }
});

// ── Virtual account management ───────────────────────────────────────────────

router.get('/accounts', optionalSession, guard('accounts:read'), async (req, res) => {
  try {
    const data = await VirtualAccountManager.list({
      status: req.query.status || null,
      ownerRef: req.query.ownerRef || null,
      accountType: req.query.accountType || null,
      limit: req.query.limit,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/accounts', optionalSession, guard('accounts:manage'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await VirtualAccountManager.open({ ...req.body, openedBy: req.ihb.principal });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/accounts/position', optionalSession, guard('accounts:read'), async (req, res) => {
  try { res.json({ success: true, data: await VirtualAccountManager.position() }); } catch (err) { sendError(res, err); }
});

router.get('/accounts/:ref', optionalSession, guard('accounts:read'), async (req, res) => {
  try {
    const data = await VirtualAccountManager.get(req.params.ref);
    if (!data) return res.status(404).json({ success: false, error: 'Virtual account not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/accounts/:ref/status', optionalSession, guard('accounts:manage'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await VirtualAccountManager.setStatus(req.params.ref, req.body.status, req.ihb.principal);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// Move value between the trust settlement account and a virtual account. This
// is an allocation inside the bank, not a payment, so it never touches a rail.
router.post('/accounts/:ref/fund', optionalSession, guard('accounts:manage'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await InHouseBankEngine.fund({
      accountRef: req.params.ref,
      amountCents: req.body.amountCents,
      direction: req.body.direction || 'credit',
      memo: req.body.memo || null,
      actor: req.ihb.principal,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// camt.053 for one virtual account: the statement a counterparty or auditor can
// load into their own system.
router.get('/accounts/:ref/statement', optionalSession, guard('accounts:read'), async (req, res) => {
  try {
    const data = await InHouseBankEngine.statement({
      accountRef: req.params.ref,
      fromDate: req.query.from || null,
      toDate: req.query.to || null,
    });
    if (String(req.query.format || '').toLowerCase() === 'xml') {
      res.type('application/xml').send(data.camt053);
      return;
    }
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ── Payments ─────────────────────────────────────────────────────────────────

router.post('/payments', optionalSession, guard('payments:initiate'), writeRateLimiter(), async (req, res) => {
  try {
    const result = await InHouseBankEngine.submit({
      idempotencyKey: req.headers['idempotency-key'] || req.body.idempotencyKey,
      payload: req.body,
      principal: req.ihb,
      channel: req.body.channel || 'api',
    });
    res.status(result.replay ? 200 : 201).json({ success: true, data: result });
  } catch (err) { sendError(res, err); }
});

router.get('/payments', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    const data = await InHouseBankEngine.list({
      status: req.query.status || null,
      debtorRef: req.query.debtor || null,
      rail: req.query.rail || null,
      limit: req.query.limit,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/payments/:id', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    const payment = await InHouseBankEngine.get(req.params.id);
    if (!payment) return res.status(404).json({ success: false, error: 'Payment not found' });
    const [events, postings] = await Promise.all([
      DualLedgerEngine.events({ paymentId: req.params.id, limit: 100 }),
      DualLedgerEngine.postingsFor(req.params.id),
    ]);
    res.json({ success: true, data: { payment, events, postings } });
  } catch (err) { sendError(res, err); }
});

router.post('/payments/:id/approve', optionalSession, guard('payments:approve'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await InHouseBankEngine.approve(req.params.id, {
      approver: req.ihb.principal,
      role: req.ihb.role,
      reason: req.body.reason || null,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/payments/:id/reject', optionalSession, guard('payments:approve'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await InHouseBankEngine.reject(req.params.id, { actor: req.ihb.principal, reason: req.body.reason || null });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/payments/:id/cancel', optionalSession, guard('payments:initiate'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await InHouseBankEngine.cancel(req.params.id, { actor: req.ihb.principal, reason: req.body.reason || null });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// The rail reports back. This is the only route that can settle a payment, and
// it demands the rail's own reference to do it.
router.post('/payments/:id/confirm', optionalSession, guard('payments:initiate'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await InHouseBankEngine.confirm(req.params.id, {
      outcome: req.body.outcome,
      reference: req.body.reference || null,
      reason: req.body.reason || null,
      actor: req.ihb.principal,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/payments/:id/pacs008', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    const xml = await InHouseBankEngine.pacs008(req.params.id);
    res.type('application/xml').send(xml);
  } catch (err) { sendError(res, err); }
});

// ── ISO 20022 ingress ────────────────────────────────────────────────────────

router.post('/iso20022/pain001', optionalSession, guard('payments:initiate'), writeRateLimiter(), async (req, res) => {
  try {
    const xml = typeof req.body === 'string' ? req.body : (req.body && req.body.xml);
    if (!xml) throw Object.assign(new Error('A pain.001 XML document is required'), { status: 400 });
    const result = await InHouseBankEngine.ingestPain001({ xml, principal: req.ihb });
    if (String(req.query.format || '').toLowerCase() === 'xml') {
      res.type('application/xml').send(result.statusReport);
      return;
    }
    res.status(201).json({ success: true, data: result });
  } catch (err) { sendError(res, err); }
});

// ── Governance & policy ──────────────────────────────────────────────────────

router.get('/policies', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    res.json({ success: true, data: await GovernanceEngine.listPolicies({ activeOnly: req.query.all !== 'true' }) });
  } catch (err) { sendError(res, err); }
});

router.post('/policies', optionalSession, guard('accounts:manage'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await GovernanceEngine.upsertPolicy({ ...req.body, createdBy: req.ihb.principal });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ── Routing & liquidity ──────────────────────────────────────────────────────

router.get('/routing/matrix', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    const amountCents = req.query.amountCents ? Number(req.query.amountCents) : 0;
    res.json({ success: true, data: await RoutingEngine.matrix({ amountCents }) });
  } catch (err) { sendError(res, err); }
});

// A dry run: what would this payment cost, on which rail, and why — without
// creating anything.
router.post('/routing/quote', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    const instruction = IngressEngine.normalize(req.body, { principal: req.ihb.principal, channel: 'api' });
    const debtor = await VirtualAccountManager.require(instruction.debtorAccount, 'debtor virtual account');
    const creditorInternal = instruction.creditor.accountNumber
      ? await VirtualAccountManager.get(instruction.creditor.accountNumber)
      : null;
    const policy = await GovernanceEngine.evaluate(instruction, debtor, { internal: Boolean(creditorInternal) });
    const routing = policy.decision === 'deny'
      ? null
      : await RoutingEngine.decide(instruction, { internal: Boolean(creditorInternal) });
    res.json({ success: true, data: { instruction, policy, routing } });
  } catch (err) { sendError(res, err); }
});

router.post('/routing/liquidity', optionalSession, guard('accounts:manage'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await RoutingEngine.setLiquidity({ ...req.body, attestedBy: req.ihb.principal });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ── Dual ledger ──────────────────────────────────────────────────────────────

router.get('/ledger/reconcile', optionalSession, guard('ledger:reconcile'), async (req, res) => {
  try { res.json({ success: true, data: await DualLedgerEngine.reconcile() }); } catch (err) { sendError(res, err); }
});

router.post('/ledger/sync', optionalSession, guard('ledger:reconcile'), writeRateLimiter(), async (req, res) => {
  try {
    res.json({ success: true, data: await DualLedgerEngine.syncPending({ limit: req.body.limit, postedBy: req.ihb.principal }) });
  } catch (err) { sendError(res, err); }
});

router.get('/events', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    res.json({ success: true, data: await DualLedgerEngine.events({ paymentId: req.query.paymentId || null, limit: req.query.limit }) });
  } catch (err) { sendError(res, err); }
});

router.get('/events/verify', optionalSession, guard('payments:read'), async (req, res) => {
  try { res.json({ success: true, data: await DualLedgerEngine.verifyChain() }); } catch (err) { sendError(res, err); }
});

// ── Direct host-to-host wire channel ─────────────────────────────────────────
//
// Transmission is scoped to payments:initiate rather than payments:read, and
// advice ingestion and reconciliation to ledger:reconcile, because ingesting a
// bank advice can settle or reverse a payment. Nothing here returns SFTP
// credentials: `readiness` reports what is missing by name, never by value.

router.get('/wire/channel', optionalSession, guard('payments:read'), async (req, res) => {
  try { res.json({ success: true, data: WireHostToHostEngine.readiness() }); } catch (err) { sendError(res, err); }
});

router.get('/wire/dashboard', optionalSession, guard('payments:read'), async (req, res) => {
  try { res.json({ success: true, data: await WireHostToHostEngine.dashboard() }); } catch (err) { sendError(res, err); }
});

router.get('/wire/transmissions', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    const data = await WireHostToHostEngine.list({
      state: req.query.state || null,
      paymentId: req.query.paymentId || null,
      limit: req.query.limit,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/wire/transmissions/:id', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    const data = await WireHostToHostEngine.transmission(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: `Wire transmission ${req.params.id} not found` });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/wire/payments/:id/file', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    const { filename, payload, payloadHash, remoteDir } = await WireHostToHostEngine.prepare(req.params.id);
    res.json({ success: true, data: { filename, payloadHash, remoteDir, payload } });
  } catch (err) { sendError(res, err); }
});

router.post('/wire/payments/:id/transmit', optionalSession, guard('payments:initiate'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await WireHostToHostEngine.transmit(req.params.id, { actor: req.ihb.principal });
    res.status(data.transmitted ? 201 : 200).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/wire/advices/ingest', optionalSession, guard('ledger:reconcile'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await WireHostToHostEngine.ingestAdvices({ actor: req.ihb.principal, limit: req.body.limit });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/wire/reconcile', optionalSession, guard('ledger:reconcile'), writeRateLimiter(), async (req, res) => {
  try {
    res.json({ success: true, data: await WireHostToHostEngine.reconcile({ actor: req.ihb.principal }) });
  } catch (err) { sendError(res, err); }
});

router.get('/wire/exceptions', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    const resolved = req.query.resolved === undefined ? false : req.query.resolved === 'true';
    res.json({ success: true, data: await WireHostToHostEngine.exceptions({ resolved, limit: req.query.limit }) });
  } catch (err) { sendError(res, err); }
});

router.post('/wire/exceptions/:id/resolve', optionalSession, guard('ledger:reconcile'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await WireHostToHostEngine.resolveException(req.params.id, {
      actor: req.ihb.principal,
      resolution: req.body.resolution,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ── Dispatch link ────────────────────────────────────────────────────────────
//
// The driver that carries dispatched payments to the bank host and reads the
// bank's advices back. Its cycle is idempotent, so an operator may run one on
// demand without waiting for, or interfering with, the scheduled one.

router.get('/wire/link', optionalSession, guard('payments:read'), async (req, res) => {
  try { res.json({ success: true, data: await WireDispatchLink.status() }); } catch (err) { sendError(res, err); }
});

router.get('/wire/link/pending', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    res.json({ success: true, data: await WireDispatchLink.pending({ limit: req.query.limit }) });
  } catch (err) { sendError(res, err); }
});

router.post('/wire/link/drive', optionalSession, guard('payments:initiate'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await WireDispatchLink.driveOnce({
      actor: req.ihb.principal,
      trigger: 'operator',
      limit: req.body.limit || null,
      reconcile: req.body.reconcile === undefined ? null : Boolean(req.body.reconcile),
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ── Direct Send clearing channel ─────────────────────────────────────────────
//
// The no-portal path: assemble a raw clearing file from dispatched wires and
// push it at the bank's pipeline. Assembling claims payments in the wire vault
// and sending moves money at the bank, so both need payments:initiate; a held
// batch may only be determined by somebody who can reconcile the ledger.
// Nothing here returns pipeline credentials or signing keys.

router.get('/wire/direct-send', optionalSession, guard('payments:read'), async (req, res) => {
  try { res.json({ success: true, data: await WireDirectSendEngine.dashboard() }); } catch (err) { sendError(res, err); }
});

router.get('/wire/direct-send/channel', optionalSession, guard('payments:read'), async (req, res) => {
  try { res.json({ success: true, data: WireDirectSendEngine.readiness() }); } catch (err) { sendError(res, err); }
});

router.get('/wire/direct-send/pending', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    res.json({ success: true, data: await WireDirectSendEngine.pending({ limit: req.query.limit }) });
  } catch (err) { sendError(res, err); }
});

router.get('/wire/direct-send/batches', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    const data = await WireDirectSendEngine.list({ state: req.query.state || null, limit: req.query.limit });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/wire/direct-send/batches/:id', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    const data = await WireDirectSendEngine.batch(req.params.id, { includePayload: req.query.payload === 'true' });
    if (!data) return res.status(404).json({ success: false, error: `Clearing batch ${req.params.id} not found` });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/wire/direct-send/assemble', optionalSession, guard('payments:initiate'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await WireDirectSendEngine.assemble({
      actor: req.ihb.principal,
      limit: req.body.limit || null,
      paymentIds: Array.isArray(req.body.paymentIds) ? req.body.paymentIds : null,
    });
    res.status(data.assembled ? 201 : 200).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/wire/direct-send/batches/:id/send', optionalSession, guard('payments:initiate'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await WireDirectSendEngine.send(req.params.id, { actor: req.ihb.principal });
    res.status(data.sent ? 201 : 200).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/wire/direct-send/send', optionalSession, guard('payments:initiate'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await WireDirectSendEngine.directSend({
      actor: req.ihb.principal,
      limit: req.body.limit || null,
      paymentIds: Array.isArray(req.body.paymentIds) ? req.body.paymentIds : null,
    });
    res.status(data.sent ? 201 : 200).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/wire/direct-send/batches/:id/acknowledge', optionalSession, guard('ledger:reconcile'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await WireDirectSendEngine.acknowledge(req.params.id, {
      actor: req.ihb.principal,
      reference: req.body.reference || null,
      acceptedCount: req.body.acceptedCount === undefined ? null : Number(req.body.acceptedCount),
      totalAmountCents: req.body.totalAmountCents === undefined ? null : Number(req.body.totalAmountCents),
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/wire/direct-send/batches/:id/cancel', optionalSession, guard('payments:initiate'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await WireDirectSendEngine.cancel(req.params.id, {
      actor: req.ihb.principal,
      reason: req.body.reason || 'cancelled by operator',
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/wire/direct-send/batches/:id/resolve-held', optionalSession, guard('ledger:reconcile'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await WireDirectSendEngine.resolveHeld(req.params.id, {
      actor: req.ihb.principal,
      received: req.body.received,
      note: req.body.note,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/wire/direct-send/reconcile', optionalSession, guard('ledger:reconcile'), writeRateLimiter(), async (req, res) => {
  try {
    res.json({ success: true, data: await WireDirectSendEngine.reconcile({ actor: req.ihb.principal }) });
  } catch (err) { sendError(res, err); }
});

// ── Automatic clearing-spec formatting ───────────────────────────────────────
//
// The system-to-system join between the trust's data workflows and the bank's
// clearing pipeline: hand over whatever a workflow produced — JSON, CSV,
// pain.001, pacs.008, a NACHA file — and the engine detects it, lifts it into
// canonical instructions and renders the spec that rail's bank ingests. One
// call can produce several files: the Fedwire Funds Service carries one credit
// transfer per ISO 20022 message, so a multi-payment input becomes one message
// per payment, each listed in `files`.
//
// `detect` only reads, so it needs payments:read. Formatting produces an
// instruction file and may deliver it, so it needs payments:initiate, and the
// payload bytes are returned only when the caller explicitly asks for them.

/**
 * A clearing input may arrive as raw bytes (XML, CSV, a NACHA file) or wrapped
 * in a JSON envelope. Anything else in the JSON body is the request's own
 * options, so an envelope-less JSON body is only treated as the payload when it
 * actually carries payments.
 */
function clearingInputFrom(req) {
  if (typeof req.body === 'string') return req.body;
  const body = req.body || {};
  if (body.input !== undefined) return body.input;
  if (body.payload !== undefined) return body.payload;
  if (Array.isArray(body.instructions) || Array.isArray(body.payments) || Array.isArray(body.items) || Array.isArray(body.rows)) {
    return body;
  }
  if (Array.isArray(body)) return body;
  const err = new Error('No payment data in the request: send the file as the request body, or a JSON envelope with an input, payload or instructions field');
  err.code = 'CLEARING_AUTOFORMAT_NO_INPUT';
  err.status = 400;
  throw err;
}

function clearingOptionsFrom(req) {
  const body = typeof req.body === 'string' ? {} : (req.body || {});
  return {
    format: body.format || req.query.format || null,
    rail: body.rail || req.query.rail || null,
    spec: body.spec || req.query.spec || null,
  };
}

router.get('/wire/clearing-spec', optionalSession, guard('payments:read'), async (req, res) => {
  try { res.json({ success: true, data: ClearingAutoFormatEngine.status() }); } catch (err) { sendError(res, err); }
});

router.get('/wire/clearing-spec/specs', optionalSession, guard('payments:read'), async (req, res) => {
  try { res.json({ success: true, data: { specs: ClearingAutoFormatEngine.specs() } }); } catch (err) { sendError(res, err); }
});

router.post('/wire/clearing-spec/detect', optionalSession, guard('payments:read'), async (req, res) => {
  try {
    const data = ClearingAutoFormatEngine.inspect({ input: clearingInputFrom(req), ...clearingOptionsFrom(req) });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/wire/clearing-spec/format', optionalSession, guard('payments:initiate'), writeRateLimiter(), async (req, res) => {
  try {
    const body = typeof req.body === 'string' ? {} : (req.body || {});
    const result = await ClearingAutoFormatEngine.format({
      input: clearingInputFrom(req),
      ...clearingOptionsFrom(req),
      source: body.source || `api:${req.ihb.principal}`,
      actor: req.ihb.principal,
      deliver: body.deliver === true || req.query.deliver === 'true',
      profile: body.profile || {},
    });
    const includePayload = body.includePayload === true || req.query.payload === 'true';
    const data = includePayload
      ? result
      : { ...result, files: result.files.map(file => ({ ...file, payload: undefined })) };
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/wire/clearing-spec/intake', optionalSession, guard('payments:initiate'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await ClearingAutoFormatEngine.runIntakeCycle({
      actor: req.ihb.principal,
      trigger: 'operator',
      limit: req.body && req.body.limit ? req.body.limit : null,
      deliver: req.body && req.body.deliver !== undefined ? Boolean(req.body.deliver) : null,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
