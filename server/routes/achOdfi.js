/**
 * US ACH API Connector OS — /api/ach-odfi
 *
 * The bank-as-API ODFI (Increase / Column) that executes treasury ACH credits
 * from a real funded account. Payment Hub → ach_batches → this channel.
 *
 *   GET  /status                   readiness + provider available balance + transfer counts
 *   GET  /providers                supported providers
 *   GET  /balance                  funded (available) balance at the ODFI
 *   GET  /transfers?batchId&status transfer register
 *   POST /sync                     poll non-final transfers at the provider
 *   POST /webhooks/:provider       provider-signed status webhook (no session auth)
 */
const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { OdfiApiConnectorEngine } = require('../integrations/ach/odfiApiConnectorEngine');

const router = express.Router();
const operatorAuth = requireAuth({ role: 'operator' });

function sendError(res, err) {
  const status = err.status || err.statusCode || 400;
  res.status(status).json({ success: false, error: err.message, code: err.code || null, details: err.details || undefined });
}

router.post('/webhooks/:provider', async (req, res) => {
  try {
    res.json({ success: true, data: await OdfiApiConnectorEngine.handleWebhook(req.params.provider, req.rawBody, req.headers) });
  } catch (err) { sendError(res, err); }
});

router.get('/status', operatorAuth, async (req, res) => {
  try {
    const data = await OdfiApiConnectorEngine.status();
    res.status(data.ready ? 200 : 503).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/providers', operatorAuth, (req, res) => {
  res.json({ success: true, data: OdfiApiConnectorEngine.providers() });
});

router.get('/balance', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await OdfiApiConnectorEngine.fundedBalance() }); } catch (err) { sendError(res, err); }
});

router.get('/transfers', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await OdfiApiConnectorEngine.list({ batchId: req.query.batchId, status: req.query.status, limit: req.query.limit }) });
  } catch (err) { sendError(res, err); }
});

router.post('/sync', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.json({ success: true, data: await OdfiApiConnectorEngine.sync({ limit: req.body && req.body.limit }) }); } catch (err) { sendError(res, err); }
});

module.exports = router;
