'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { TransactionalSettlementServerEngine } = require('../integrations/dapp/transactionalSettlementServerEngine');

const operatorAuth = requireAuth({ role: 'operator' });

function sendError(res, err) {
  console.error('[transactional-settlement] error:', err.message);
  res.status(500).json({ success: false, error: err.message });
}

router.get('/health', (req, res) => res.json({ success: true, status: 'ok' }));

router.get('/orders', operatorAuth, async (req, res) => {
  try {
    const data = await TransactionalSettlementServerEngine.listOrders({
      status: req.query.status,
      rail: req.query.rail,
      direction: req.query.direction,
      limit: parseInt(req.query.limit, 10) || 50,
      offset: parseInt(req.query.offset, 10) || 0,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/summary', operatorAuth, async (req, res) => {
  try {
    const data = await TransactionalSettlementServerEngine.getSummary();
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/orders/:id', operatorAuth, async (req, res) => {
  try {
    const data = await TransactionalSettlementServerEngine.getOrder(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Order not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/orders', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await TransactionalSettlementServerEngine.createOrder(req.body);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/orders/:id/execute', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await TransactionalSettlementServerEngine.executeOrder(req.params.id);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/orders/:id/cancel', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await TransactionalSettlementServerEngine.cancelOrder(req.params.id);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/orders/:id/reconcile', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await TransactionalSettlementServerEngine.reconcile(req.params.id);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/batch-execute', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const { orderIds } = req.body || {};
    if (!Array.isArray(orderIds) || !orderIds.length) throw new Error('orderIds array required');
    const data = await TransactionalSettlementServerEngine.batchExecute(orderIds);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.delete('/orders/:id', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    const data = await TransactionalSettlementServerEngine.deleteOrder(req.params.id);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
