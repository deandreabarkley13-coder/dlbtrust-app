'use strict';

/**
 * Family Wallet API — the BaaS surface of the PTC In-House Family Bank
 *
 * Mounted at /api/wallet, with two distinct kinds of caller and therefore two
 * distinct doors:
 *
 *   /api/wallet/me/*   the holder, authenticated by their own wallet key. The
 *                      wallet is taken from the credential, never from the
 *                      request, so a holder cannot name someone else's wallet
 *                      and no route needs to check that they own it.
 *   everything else    the trust's operators, through the in-house bank's zero
 *                      trust gateway on the same scopes that already govern
 *                      virtual accounts. Provisioning a wallet, funding it,
 *                      changing its limits and issuing its keys are bank
 *                      operations, not holder operations.
 */

const express = require('express');
const { requireAuth, writeRateLimiter } = require('../integrations/auth/securityMiddleware');
const { ZeroTrustGateway } = require('../integrations/inhouseBank/zeroTrustGateway');
const { WalletEngine } = require('../integrations/inhouseBank/wallet/walletEngine');
const { WalletCredentials } = require('../integrations/inhouseBank/wallet/walletCredentials');

const router = express.Router();
const sessionAuth = requireAuth({ role: 'operator' });

function sendError(res, err) {
  const status = err.status || err.statusCode || 400;
  res.status(status).json({ success: false, error: err.message, code: err.code || null });
}

/** An operator session is optional here for the same reason it is in the bank router: machines sign instead. */
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
    } catch (err) { sendError(res, err); }
  };
}

/**
 * Holder authentication. The key may arrive as a pair of headers or as HTTP
 * basic auth, because a wallet key is exactly a username and password to most
 * client libraries.
 */
function walletAuth(scope) {
  return async (req, res, next) => {
    try {
      let keyId = req.headers['x-wallet-key-id'];
      let secret = req.headers['x-wallet-secret'];
      const authorization = String(req.headers.authorization || '');
      if ((!keyId || !secret) && authorization.startsWith('Basic ')) {
        const decoded = Buffer.from(authorization.slice(6).trim(), 'base64').toString('utf8');
        const separator = decoded.indexOf(':');
        if (separator > 0) {
          keyId = decoded.slice(0, separator);
          secret = decoded.slice(separator + 1);
        }
      }
      req.wallet = await WalletCredentials.verify({ keyId, secret, scope });
      next();
    } catch (err) { sendError(res, err); }
  };
}

// ── Holder surface ───────────────────────────────────────────────────────────

router.get('/me', walletAuth('wallet:read'), async (req, res) => {
  try { res.json({ success: true, data: await WalletEngine.balance(req.wallet.walletId) }); } catch (err) { sendError(res, err); }
});

router.get('/me/activity', walletAuth('wallet:read'), async (req, res) => {
  try {
    res.json({ success: true, data: await WalletEngine.activity(req.wallet.walletId, { limit: req.query.limit }) });
  } catch (err) { sendError(res, err); }
});

router.get('/me/statement', walletAuth('wallet:read'), async (req, res) => {
  try {
    const data = await WalletEngine.statement(req.wallet.walletId, {
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

// What would happen, without creating anything: the answer a spend control
// should give an app before it shows a confirm button.
router.post('/me/check', walletAuth('wallet:read'), async (req, res) => {
  try {
    const data = await WalletEngine.check(req.wallet.walletId, {
      amountCents: req.body.amountCents,
      creditorAccountNumber: (req.body.creditor && req.body.creditor.accountNumber) || req.body.toAccount || null,
      rail: req.body.rail || req.body.requestedRail || null,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/me/payments', walletAuth('wallet:pay'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await WalletEngine.pay(req.wallet.walletId, {
      idempotencyKey: req.headers['idempotency-key'] || req.body.idempotencyKey,
      amountCents: req.body.amountCents,
      amount: req.body.amount,
      creditor: req.body.creditor || {},
      paymentPurpose: req.body.paymentPurpose || null,
      purposeCode: req.body.purposeCode || null,
      requestedSpeed: req.body.requestedSpeed || 'standard',
      requestedRail: req.body.requestedRail || req.body.rail || null,
      memo: req.body.memo || null,
      actor: req.wallet.principal,
    });
    res.status(data.replay ? 200 : 201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/me/transfers', walletAuth('wallet:transfer'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await WalletEngine.transfer(req.wallet.walletId, {
      toRef: req.body.to || req.body.toWallet || req.body.toRef || req.body.handle,
      idempotencyKey: req.headers['idempotency-key'] || req.body.idempotencyKey,
      amountCents: req.body.amountCents,
      amount: req.body.amount,
      memo: req.body.memo || null,
      actor: req.wallet.principal,
    });
    res.status(data.replay ? 200 : 201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

// ── Operator surface ─────────────────────────────────────────────────────────

router.get('/wallets', optionalSession, guard('accounts:read'), async (req, res) => {
  try {
    const data = await WalletEngine.list({
      status: req.query.status || null,
      holderRef: req.query.holderRef || null,
      walletType: req.query.walletType || null,
      limit: req.query.limit,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/wallets', optionalSession, guard('accounts:manage'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await WalletEngine.open({ ...req.body, openedBy: req.ihb.principal });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/wallets/dashboard', optionalSession, guard('accounts:read'), async (req, res) => {
  try { res.json({ success: true, data: await WalletEngine.dashboard() }); } catch (err) { sendError(res, err); }
});

router.get('/wallets/:ref', optionalSession, guard('accounts:read'), async (req, res) => {
  try {
    const data = await WalletEngine.get(req.params.ref, { withAccount: true });
    if (!data) return res.status(404).json({ success: false, error: 'Wallet not found' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/wallets/:ref/status', optionalSession, guard('accounts:manage'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await WalletEngine.setStatus(req.params.ref, req.body.status, {
      actor: req.ihb.principal,
      reason: req.body.reason || null,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/wallets/:ref/controls', optionalSession, guard('accounts:manage'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await WalletEngine.setControls(req.params.ref, req.body, { actor: req.ihb.principal });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/wallets/:ref/fund', optionalSession, guard('accounts:manage'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await WalletEngine.fund(req.params.ref, {
      amountCents: req.body.amountCents,
      direction: req.body.direction || 'credit',
      memo: req.body.memo || null,
      actor: req.ihb.principal,
    });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.get('/wallets/:ref/spend', optionalSession, guard('accounts:read'), async (req, res) => {
  try { res.json({ success: true, data: await WalletEngine.spend(req.params.ref) }); } catch (err) { sendError(res, err); }
});

// ── Credentials ──────────────────────────────────────────────────────────────
//
// Issuing a wallet key is an account-management operation: the key can spend
// the wallet within its controls, so it is gated like opening the wallet was.
// The secret is in the response body once and is never retrievable again.

router.get('/wallets/:ref/credentials', optionalSession, guard('accounts:read'), async (req, res) => {
  try {
    const data = await WalletCredentials.list(req.params.ref, { includeRevoked: req.query.all === 'true' });
    res.json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/wallets/:ref/credentials', optionalSession, guard('accounts:manage'), writeRateLimiter(), async (req, res) => {
  try {
    const data = await WalletCredentials.issue(req.params.ref, {
      label: req.body.label || null,
      scopes: req.body.scopes,
      expiresInDays: req.body.expiresInDays || null,
      createdBy: req.ihb.principal,
    });
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err); }
});

router.post('/credentials/:keyId/revoke', optionalSession, guard('accounts:manage'), writeRateLimiter(), async (req, res) => {
  try {
    res.json({ success: true, data: await WalletCredentials.revoke(req.params.keyId, { actor: req.ihb.principal }) });
  } catch (err) { sendError(res, err); }
});

router.post('/credentials/:keyId/rotate', optionalSession, guard('accounts:manage'), writeRateLimiter(), async (req, res) => {
  try {
    res.json({ success: true, data: await WalletCredentials.rotate(req.params.keyId, { actor: req.ihb.principal }) });
  } catch (err) { sendError(res, err); }
});

// A client of a JSON API that mistypes a path should be told so in JSON. Without
// this, an unmatched /api/wallet/* falls through to the SPA catch-all and the
// caller gets the login page with a 200.
router.use((req, res) => {
  res.status(404).json({ success: false, error: `No wallet endpoint at ${req.method} /api/wallet${req.path}`, code: 'WALLET_NO_ROUTE' });
});

module.exports = router;
