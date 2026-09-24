/**
 * Proof of Asset OS — /api/proof-of-asset
 *
 * The private placement bond and its fixed income proven across contract,
 * Fineract account of record, GL, fiat settlement and outside custody.
 *
 *   GET  /status                     readiness, latest portfolio proof, verdict counts
 *   GET  /proofs?bondId&scope&limit  proof register (checks only, no full evidence)
 *   GET  /proofs/latest?bondId       latest proof for a bond (or the portfolio)
 *   GET  /proofs/:proofId            full proof with evidence
 *   GET  /chain                      recompute the hash chain
 *   POST /proofs {bondId?}           prove one bond, or the portfolio when omitted
 *   POST /proofs/all                 prove every issued bond + the portfolio
 *   POST /proofs/:proofId/certify {signerName?}   admin certifies a proven proof
 */
const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { ProofOfAssetOsEngine } = require('../integrations/os/proofOfAssetOsEngine');

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

function bondIdParam(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw Object.assign(new Error('bondId must be an integer'), { status: 400, code: 'BAD_BOND_ID' });
  return n;
}

router.get('/status', operatorAuth, async (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json({ success: true, data: await ProofOfAssetOsEngine.status() }); } catch (err) { sendError(res, err); }
});

router.get('/proofs', operatorAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await ProofOfAssetOsEngine.list({ bondId: bondIdParam(req.query.bondId), scope: req.query.scope || undefined, limit: req.query.limit }) });
  } catch (err) { sendError(res, err); }
});

router.get('/proofs/latest', operatorAuth, async (req, res) => {
  try {
    const proof = await ProofOfAssetOsEngine.latest({ bondId: bondIdParam(req.query.bondId) });
    if (!proof) return res.status(404).json({ success: false, error: 'no proof yet', code: 'NOT_FOUND' });
    res.json({ success: true, data: proof });
  } catch (err) { sendError(res, err); }
});

router.get('/proofs/:proofId', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await ProofOfAssetOsEngine.get(req.params.proofId) }); } catch (err) { sendError(res, err); }
});

router.get('/chain', operatorAuth, async (req, res) => {
  try { res.json({ success: true, data: await ProofOfAssetOsEngine.verifyChain({ limit: req.query.limit }) }); } catch (err) { sendError(res, err); }
});

router.post('/proofs', operatorAuth, writeRateLimiter(), async (req, res) => {
  try {
    res.status(201).json({ success: true, data: await ProofOfAssetOsEngine.prove({ bondId: bondIdParam(req.body?.bondId), createdBy: principal(req) }) });
  } catch (err) { sendError(res, err); }
});

router.post('/proofs/all', operatorAuth, writeRateLimiter(), async (req, res) => {
  try { res.status(201).json({ success: true, data: await ProofOfAssetOsEngine.proveAll({ createdBy: principal(req) }) }); } catch (err) { sendError(res, err); }
});

router.post('/proofs/:proofId/certify', adminAuth, writeRateLimiter(), async (req, res) => {
  try {
    res.json({ success: true, data: await ProofOfAssetOsEngine.certify(req.params.proofId, { certifiedBy: principal(req), signerName: req.body?.signerName }) });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
