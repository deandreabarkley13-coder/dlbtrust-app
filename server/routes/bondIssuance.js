/**
 * Bond issuance — issuer (Trust Company) -> holder (Irrevocable Trust) P&I of record.
 * Mounted at /api/bond-issuance.
 *
 *   GET  /status                       readiness + parties + issuances
 *   GET  /parties?live=true            Fineract clients/accounts of issuer + holder
 *   POST /parties                      provision both parties in Fineract (idempotent)
 *   POST /parties/issuer/fund          {amountUsd, note} issuer capital deposit (bookkeeping)
 *   GET  /issuances                    issued bonds + recent payments
 *   POST /issuances                    {bondId} issue an active bond to the holder
 *   GET  /issuances/:bondId
 *   POST /issuances/:bondId/pay        {kind?, amountUsd?, periodDate?} book due P&I
 *   POST /run-due                      book every issued bond whose coupon is due
 */
const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { BondIssuanceEngine } = require('../integrations/bonds/bondIssuanceEngine');

const router = express.Router();
const operatorAuth = requireAuth({ role: 'operator' });
const adminAuth = requireAuth({ role: 'admin' });

function principal(req) {
  const user = req.user || {};
  return user.email || user.username || user.userId || user.sub || req.body?.actor || null;
}

function sendError(res, err) {
  const status = err.status || err.statusCode || 400;
  res.status(status).json({ success: false, error: err.message, code: err.code || null, details: err.details || undefined });
}

router.get('/status', operatorAuth, async (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json({ success: true, data: await BondIssuanceEngine.status() }); } catch (err) { sendError(res, err); }
});

router.get('/parties', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await BondIssuanceEngine.parties({ live: req.query.live === 'true' }) }); } catch (err) { sendError(res, err); }
});

router.post('/parties', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await BondIssuanceEngine.ensureParties() }); } catch (err) { sendError(res, err); }
});

router.post('/parties/issuer/fund', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await BondIssuanceEngine.fundIssuer({ ...req.body, actor: principal(req) }) }); } catch (err) { sendError(res, err); }
});

router.get('/issuances', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await BondIssuanceEngine.list() }); } catch (err) { sendError(res, err); }
});

router.post('/issuances', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await BondIssuanceEngine.issue({ bondId: req.body?.bondId, actor: principal(req) }) }); } catch (err) { sendError(res, err); }
});

router.get('/issuances/:bondId', operatorAuth, async (req, res) => {
  try {
    const data = await BondIssuanceEngine.get(Number(req.params.bondId));
    if (!data) return res.status(404).json({ success: false, error: 'issuance not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/issuances/:bondId/pay', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    res.status(201).json({ success: true, data: await BondIssuanceEngine.payDue({ bondId: Number(req.params.bondId), kind: req.body?.kind, amountUsd: req.body?.amountUsd, periodDate: req.body?.periodDate, actor: principal(req) }) });
  } catch (err) { sendError(res, err); }
});

router.post('/run-due', adminAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await BondIssuanceEngine.runDue({ actor: principal(req) || 'operator' }) }); } catch (err) { sendError(res, err); }
});

module.exports = router;
