'use strict';

const express = require('express');
const OfxEngine = require('../integrations/ofx/ofxEngine');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');

const router = express.Router();
const operatorAuth = requireAuth({ role: 'operator' });
const adminAuth = requireAuth({ role: 'admin' });

function sendError(res, err) {
  const status = err.status || 400;
  res.status(status).json({ success: false, error: err.message || 'OFX operation failed' });
}

router.get('/health', async (req, res) => {
  try {
    const r = await OfxEngine.readiness();
    res.status(r.ready ? 200 : 503).json({ success: r.ready, data: r });
  } catch (err) { sendError(res, err); }
});

router.get('/institutions', operatorAuth, async (req, res) => {
  try {
    const data = await OfxEngine.listInstitutions();
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/institutions', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await OfxEngine.saveInstitution(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/institutions/:id', operatorAuth, async (req, res) => {
  try {
    const data = await OfxEngine.getInstitution(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'institution not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.put('/institutions/:id', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await OfxEngine.saveInstitution({ ...req.body, id: req.params.id });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.delete('/institutions/:id', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    await OfxEngine.deleteInstitution(req.params.id);
    res.json({ success: true });
  } catch (err) { sendError(res, err); }
});

router.post('/parse', operatorAuth, async (req, res) => {
  try {
    const { content } = req.body;
    const data = OfxEngine.parseStatement(content);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/statements', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { institutionId, content } = req.body;
    if (!content) throw new Error('OFX content required');
    const data = await OfxEngine.importStatement({ institutionId, fileContent: content });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/statements', operatorAuth, async (req, res) => {
  try {
    const data = await OfxEngine.listStatements(req.query.institutionId);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/statements/:id/transactions', operatorAuth, async (req, res) => {
  try {
    const data = await OfxEngine.listTransactions(req.params.id);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/payments', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await OfxEngine.createPayment(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/payments', operatorAuth, async (req, res) => {
  try {
    const data = await OfxEngine.listPayments({
      limit: req.query.limit ? Number(req.query.limit) : 50,
      offset: req.query.offset ? Number(req.query.offset) : 0,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/payments/:id', operatorAuth, async (req, res) => {
  try {
    const data = await OfxEngine.getPayment(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'payment not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/payments/:id/submit', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await OfxEngine.submitPayment(req.params.id);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/payments/:id/cancel', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await OfxEngine.cancelPayment(req.params.id);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
