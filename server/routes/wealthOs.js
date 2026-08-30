'use strict';

/**
 * Wealth Back Office OS API — /api/wealth-os
 *
 * The reading surface of the family bank's back office, plus the one write that
 * matters: handing a queued obligation to Payer OS. Reading a desk changes
 * nothing and needs an operator session. Raising a credit push is rate limited
 * and admin-gated, and still lands `pending_approval` — the second signature,
 * the file and the ledger posting all belong to /api/payer, so no route here
 * can move money on its own.
 */

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { WealthBackOfficeEngine } = require('../integrations/os/wealthBackOfficeEngine');
const { CrmEngine } = require('../integrations/crm/crmEngine');

const router = express.Router();
const operatorAuth = requireAuth({ role: 'operator' });
const adminAuth = requireAuth({ role: 'admin' });

function principal(req) {
  const user = req.user || {};
  return user.email || user.username || user.userId || user.sub || null;
}

function sendError(res, err) {
  const status = err.status || err.statusCode || 400;
  res.status(status).json({ success: false, error: err.message, code: err.code || null });
}

router.get('/', operatorAuth, async (req, res) => {
  try {
    const readiness = await WealthBackOfficeEngine.readiness();
    res.status(readiness.ready ? 200 : 503).json({ success: readiness.ready, data: readiness });
  } catch (err) { sendError(res, err); }
});

router.get('/desks', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: WealthBackOfficeEngine.desks() });
  } catch (err) { sendError(res, err); }
});

router.post('/init', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await WealthBackOfficeEngine.initDesks({ desk: (req.body || {}).desk || null });
    res.status(data.ready ? 200 : 409).json({ success: data.ready, data });
  } catch (err) { sendError(res, err); }
});

router.get('/desks/:desk', operatorAuth, async (req, res) => {
  try {
    const data = await WealthBackOfficeEngine.deskReport(req.params.desk, {
      limit: req.query.limit,
      asOfDate: req.query.asOfDate || null,
      fromDate: req.query.fromDate || null,
      toDate: req.query.toDate || null,
      taxYear: req.query.taxYear || null,
      days: req.query.days || null,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/book-of-record', operatorAuth, async (req, res) => {
  try {
    const data = await WealthBackOfficeEngine.bookOfRecord({
      asOfDate: req.query.asOfDate || null,
      taxYear: req.query.taxYear || null,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/runbook', operatorAuth, async (req, res) => {
  try {
    const data = await WealthBackOfficeEngine.runbook({
      asOfDate: req.query.asOfDate || null,
      taxYear: req.query.taxYear || null,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/portfolio', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await WealthBackOfficeEngine.fixedIncomePortfolio() });
  } catch (err) { sendError(res, err); }
});

router.get('/clients', operatorAuth, async (req, res) => {
  try {
    const data = await CrmEngine.listContacts({
      contactType: req.query.type || undefined,
      search: req.query.search || undefined,
      limit: req.query.limit || undefined,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/clients/:contactId', operatorAuth, async (req, res) => {
  try {
    const data = await WealthBackOfficeEngine.client(req.params.contactId, { limit: req.query.limit });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/credit-queue', operatorAuth, async (req, res) => {
  try {
    const data = await WealthBackOfficeEngine.creditQueue({
      origin: req.query.origin || null,
      limit: req.query.limit,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/pushes', operatorAuth, async (req, res) => {
  try {
    const data = await WealthBackOfficeEngine.pushes({ origin: req.query.origin || null, limit: req.query.limit });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/credit-queue/:origin/:originId/push', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    const data = await WealthBackOfficeEngine.pushCredit({
      origin: req.params.origin,
      originId: req.params.originId,
      payeeKey: body.payeeKey || null,
      memo: body.memo || null,
      fundingSourceRef: body.fundingSource || null,
      initiatedBy: principal(req),
    });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/schedule', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    const data = await WealthBackOfficeEngine.scheduleDuty({
      desk: body.desk,
      duty: body.duty,
      dueAt: body.dueAt || body.start,
      description: body.description || null,
      attendees: Array.isArray(body.attendees) ? body.attendees : [],
      referenceId: body.referenceId || null,
      createdBy: principal(req),
    });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/messages', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body || {};
    const data = await WealthBackOfficeEngine.postNote({
      desk: body.desk,
      subject: body.subject,
      body: body.body,
      participants: Array.isArray(body.participants) ? body.participants : [],
      referenceId: body.referenceId || null,
      sender: principal(req),
    });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
