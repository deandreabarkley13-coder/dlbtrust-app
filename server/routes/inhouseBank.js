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

const router = express.Router();

// pain.001 arrives as XML, which the JSON body parser mounted on the app skips.
router.use(express.text({ type: ['application/xml', 'text/xml'], limit: '4mb' }));

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

module.exports = router;
