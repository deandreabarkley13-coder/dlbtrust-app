'use strict';

/**
 * Treasury Prime Routes — DLB Trust Platform
 * Mounts at: /api/treasury-prime
 *
 * Banking-as-a-service rails: account/balance sync, org ledger, book
 * transfers, ACH, wires, counterparties, webhooks and GL reconciliation.
 *
 * All monetary values in requests and responses are decimal strings
 * ("250.00") — Treasury Prime's native format. Do NOT send integer cents.
 */

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const webhookAuth = require('../integrations/treasuryprime/webhookAuth');
const { TreasuryPrimeEngine } = require('../integrations/treasuryprime/treasuryPrimeEngine');

const router = express.Router();
const operatorAuth = requireAuth({ role: 'operator' });

function sendError(res, err) {
  const message = err && err.message ? err.message : String(err);
  // Validation problems are the caller's fault; upstream failures are not.
  const isValidation = /required|must be|differ|Insufficient|not configured/i.test(message);
  res.status(isValidation ? 400 : 500).json({ success: false, error: message });
}

// ─── Status & reference data ────────────────────────────────────────────────
// Operator-only: exposes which environment (sandbox vs. production banking
// rails) the trust is pointed at, plus raw upstream error text.
router.get('/status', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TreasuryPrimeEngine.getStatus() }); } catch (err) { sendError(res, err); }
});

router.get('/routing-number/:rtn', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TreasuryPrimeEngine.lookupRoutingNumber(req.params.rtn) }); } catch (err) { sendError(res, err); }
});

// ─── Accounts & balances ────────────────────────────────────────────────────
router.get('/accounts', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TreasuryPrimeEngine.syncAccounts() }); } catch (err) { sendError(res, err); }
});

router.get('/accounts/cached', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TreasuryPrimeEngine.getCachedAccounts() }); } catch (err) { sendError(res, err); }
});

router.get('/balances', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TreasuryPrimeEngine.getBalances() }); } catch (err) { sendError(res, err); }
});

router.get('/accounts/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TreasuryPrimeEngine.getAccount(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.get('/accounts/:id/transactions', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await TreasuryPrimeEngine.syncTransactions({ accountId: req.params.id, limit: req.query.limit }) });
  } catch (err) { sendError(res, err); }
});

// ─── Org-wide ledger ────────────────────────────────────────────────────────
router.get('/transactions', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TreasuryPrimeEngine.syncTransactions({ limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.get('/transactions/cached', operatorAuth, async (req, res) => {
  try {
    res.json({
      success: true,
      data: await TreasuryPrimeEngine.getCachedTransactions({
        accountId: req.query.accountId,
        limit: req.query.limit,
        offset: req.query.offset,
      }),
    });
  } catch (err) { sendError(res, err); }
});

// ─── Counterparties ─────────────────────────────────────────────────────────
router.get('/counterparties', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TreasuryPrimeEngine.listCounterparties() }); } catch (err) { sendError(res, err); }
});

router.post('/counterparties', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { nameOnAccount, ach, wire, userdata } = req.body || {};
    res.status(201).json({ success: true, data: await TreasuryPrimeEngine.createCounterparty({ nameOnAccount, ach, wire, userdata }) });
  } catch (err) { sendError(res, err); }
});

// ─── Money movement ─────────────────────────────────────────────────────────
// Internal transfer between two org accounts (instant, double-entry).
router.post('/book-transfers', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { amount, fromAccountId, toAccountId, memo, userdata } = req.body || {};
    const data = await TreasuryPrimeEngine.initiateBookTransfer({
      amount, fromAccountId, toAccountId, memo, userdata,
      initiatedBy: (req.user && req.user.username) || null,
    });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ACH debit or credit against an external counterparty.
router.post('/ach', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { amount, direction, accountId, counterpartyId, secCode, entryDesc, effectiveDate, service, addenda, userdata } = req.body || {};
    const data = await TreasuryPrimeEngine.initiateAch({
      amount, direction, accountId, counterpartyId, secCode, entryDesc, effectiveDate, service, addenda, userdata,
      initiatedBy: (req.user && req.user.username) || null,
    });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// Outbound wire.
router.post('/wires', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { amount, accountId, counterpartyId, memo, purpose, instructions, userdata } = req.body || {};
    const data = await TreasuryPrimeEngine.initiateWire({
      amount, accountId, counterpartyId, memo, purpose, instructions, userdata,
      initiatedBy: (req.user && req.user.username) || null,
    });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Transfer audit trail ───────────────────────────────────────────────────
router.get('/transfers', operatorAuth, async (req, res) => {
  try {
    res.json({
      success: true,
      data: await TreasuryPrimeEngine.listTransfers({
        kind: req.query.kind, status: req.query.status, limit: req.query.limit, offset: req.query.offset,
      }),
    });
  } catch (err) { sendError(res, err); }
});

router.post('/transfers/refresh-pending', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await TreasuryPrimeEngine.refreshPendingTransfers({ limit: req.body && req.body.limit }) }); } catch (err) { sendError(res, err); }
});

router.get('/transfers/:kind/:id', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TreasuryPrimeEngine.refreshTransfer(req.params.kind, req.params.id) }); } catch (err) { sendError(res, err); }
});

// ─── GL reconciliation ──────────────────────────────────────────────────────
router.post('/accounts/:id/reconcile', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { trustAccountCode, postJournal } = req.body || {};
    const data = await TreasuryPrimeEngine.reconcileAccount({
      accountId: req.params.id,
      trustAccountCode,
      postJournal: postJournal !== false,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ─── Webhooks ───────────────────────────────────────────────────────────────
router.get('/webhooks', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TreasuryPrimeEngine.listWebhooks() }); } catch (err) { sendError(res, err); }
});

// One webhook per event (`book.update`, `ach.update`, …). The basic_user /
// basic_secret pair registered here is what Treasury Prime sends back on every
// callback, so it must match TREASURY_PRIME_WEBHOOK_USER / _SECRET; without it
// the receiver below has no way to authenticate the caller and rejects it.
router.post('/webhooks', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { url, event, userdata } = req.body || {};
    const basicSecret = process.env.TREASURY_PRIME_WEBHOOK_SECRET;
    if (!basicSecret) throw new Error('TREASURY_PRIME_WEBHOOK_SECRET must be configured before registering a webhook');
    const data = await TreasuryPrimeEngine.createWebhook({
      url,
      event,
      basicUser: webhookAuth.webhookUser(),
      basicSecret,
      userdata,
    });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// Re-enable a webhook Treasury Prime put into `error`/`disabled` status, or
// repoint/rotate it.
router.patch('/webhooks/:id', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { url, status, rotateSecret } = req.body || {};
    const patch = { url, status };
    if (rotateSecret) {
      const basicSecret = process.env.TREASURY_PRIME_WEBHOOK_SECRET;
      if (!basicSecret) throw new Error('TREASURY_PRIME_WEBHOOK_SECRET must be configured to rotate the webhook secret');
      patch.basicUser = webhookAuth.webhookUser();
      patch.basicSecret = basicSecret;
    }
    res.json({ success: true, data: await TreasuryPrimeEngine.updateWebhook(req.params.id, patch) });
  } catch (err) { sendError(res, err); }
});

router.delete('/webhooks/:id', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await TreasuryPrimeEngine.deleteWebhook(req.params.id) }); } catch (err) { sendError(res, err); }
});

router.get('/webhooks/events', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await TreasuryPrimeEngine.getCachedWebhookEvents({ limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

/**
 * Receiver Treasury Prime calls on status transitions. Treasury Prime cannot
 * present an operator token and does not sign its callbacks; the only
 * authentication it offers is the HTTP Basic header built from the
 * basic_user/basic_secret stored on the webhook object, so that is what this
 * route compares — in constant time. The legacy x-treasury-prime-secret
 * header is still accepted for internal replays. Outside development the
 * secret is mandatory: without it the endpoint refuses to process anything.
 *
 * The payload itself is never trusted: it carries only an object id, and the
 * object is re-fetched from the API before any status is believed. Treasury
 * Prime retries non-2xx responses up to 15 times, so failures here are safe
 * but noisy, and repeated failures move the webhook into `error` status.
 */
router.post('/webhooks/receive', writeRateLimiter(), async (req, res) => {
  try {
    const expected = process.env.TREASURY_PRIME_WEBHOOK_SECRET;
    if (!expected) {
      if (process.env.NODE_ENV === 'production') {
        return res.status(503).json({ success: false, error: 'TREASURY_PRIME_WEBHOOK_SECRET is not configured' });
      }
      console.warn('[treasury-prime] webhook receiver is unauthenticated: TREASURY_PRIME_WEBHOOK_SECRET is unset');
    } else if (!webhookAuth.isAuthentic(req.headers, expected)) {
      return res.status(401).json({ success: false, error: 'Invalid webhook credentials' });
    }
    const data = await TreasuryPrimeEngine.handleWebhook(req.body || {});
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
