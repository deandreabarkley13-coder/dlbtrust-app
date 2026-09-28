'use strict';

/**
 * Private access guard — the platform is a family-only system, not a public
 * site. Network-level privacy comes from Cloud Run behind Identity-Aware Proxy
 * (infra/gcp/cloudrun.tf: iap_enabled, no allUsers invoker, family principals
 * as iap.httpsResourceAccessor). This middleware is the in-process half:
 * every request must carry the IAP-signed assertion (`x-goog-iap-jwt-assertion`)
 * for one of the family identities, or a Google OIDC token from the platform's
 * own Cloud Scheduler service account. Anything else is refused.
 *
 *   PRIVATE_ACCESS_MODE            off | audit | enforce   (default: audit;
 *                                  Terraform sets enforce for the GCP runtime)
 *   PRIVATE_ACCESS_IAP_AUDIENCE    /projects/<number>/locations/<region>/services/<service>
 *   PRIVATE_ACCESS_FAMILY_EMAILS   comma-separated Google identities (trustees, beneficiaries)
 *   PRIVATE_ACCESS_FAMILY_DOMAINS  optional comma-separated Workspace domains
 *   PRIVATE_ACCESS_SERVICE_ACCOUNTS platform service accounts (deploy /
 *                                  scheduler) accepted when IAP asserts them
 *   PRIVATE_ACCESS_EXEMPT_PATHS    comma-separated path prefixes that skip the
 *                                  check (default: /api/health) — liveness
 *                                  probes only; never business routes.
 *
 * `audit` records every decision without blocking so the allow-list can be
 * proven before IAP is switched on. `enforce` fails closed: no valid family
 * assertion, no response beyond 403.
 */

const https = require('https');
const jwt = require('jsonwebtoken');
const schedulerAuth = require('../aggregator/schedulerAuth');

const IAP_PUBLIC_KEYS_URL = 'https://www.gstatic.com/iap/verify/public_key';
const IAP_ISSUER = 'https://cloud.google.com/iap';
const IAP_HEADER = 'x-goog-iap-jwt-assertion';

let keyCache = { keys: null, expiresAt: 0 };
const decisions = { allowed: 0, refused: 0, audited: 0, lastRefusal: null, lastAllowed: null };

function list(v) {
  return String(v || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function getPrivateAccessConfig(env = process.env) {
  const mode = ['off', 'audit', 'enforce'].includes(String(env.PRIVATE_ACCESS_MODE || '').toLowerCase()) ? String(env.PRIVATE_ACCESS_MODE).toLowerCase() : 'audit';
  return {
    mode,
    audience: String(env.PRIVATE_ACCESS_IAP_AUDIENCE || '').trim() || null,
    familyEmails: list(env.PRIVATE_ACCESS_FAMILY_EMAILS),
    familyDomains: list(env.PRIVATE_ACCESS_FAMILY_DOMAINS),
    exemptPaths: list(env.PRIVATE_ACCESS_EXEMPT_PATHS || '/api/health'),
    schedulerServiceAccount: String(env.AGGREGATOR_SCHEDULER_SERVICE_ACCOUNT || '').trim() || null,
    serviceAccounts: list(env.PRIVATE_ACCESS_SERVICE_ACCOUNTS),
  };
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000, headers: { Accept: 'application/json' } }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        try { resolve({ json: JSON.parse(data), headers: res.headers }); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`Timed out fetching ${url}`)));
  });
}

async function iapKeys() {
  if (keyCache.keys && Date.now() < keyCache.expiresAt) return keyCache.keys;
  const { json, headers } = await fetchJson(IAP_PUBLIC_KEYS_URL);
  const m = /max-age=(\d+)/.exec(headers['cache-control'] || '');
  keyCache = { keys: json, expiresAt: Date.now() + (m ? Number(m[1]) : 3600) * 1000 };
  return json;
}

function isFamily(email, cfg) {
  const e = String(email || '').toLowerCase();
  if (!e) return false;
  if (cfg.familyEmails.includes(e)) return true;
  const domain = e.split('@')[1];
  return Boolean(domain && cfg.familyDomains.includes(domain));
}

/** @returns {Promise<{email:string, sub:string}|null>} verified IAP identity, or null. */
async function verifyIapAssertion(token, cfg = getPrivateAccessConfig()) {
  if (!token || !cfg.audience) return null;
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || !decoded.header || decoded.header.alg !== 'ES256' || !decoded.header.kid) return null;
  const keys = await iapKeys();
  const pem = keys[decoded.header.kid];
  if (!pem) return null;
  let claims;
  try {
    claims = jwt.verify(token, pem, { algorithms: ['ES256'], audience: cfg.audience, issuer: IAP_ISSUER });
  } catch (e) {
    return null;
  }
  if (!claims.email) return null;
  return { email: String(claims.email).toLowerCase(), sub: claims.sub };
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return /^Bearer\s+(.+)$/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : null;
}

/**
 * Decide for one request. Pure with respect to the response: returns
 * { allow, principal, kind, reason }.
 */
async function decideRequest(req, cfg = getPrivateAccessConfig()) {
  const p = String(req.path || req.url || '');
  if (cfg.exemptPaths.some(x => p === x || p.startsWith(`${x}/`))) return { allow: true, kind: 'exempt', principal: null, reason: null };
  const iap = await verifyIapAssertion(req.headers[IAP_HEADER], cfg);
  if (iap) {
    if (isFamily(iap.email, cfg)) return { allow: true, kind: 'family', principal: iap.email, reason: null };
    const e = String(iap.email || '').toLowerCase();
    if (e && (cfg.serviceAccounts.includes(e) || e === String(cfg.schedulerServiceAccount || '').toLowerCase())) return { allow: true, kind: 'platform', principal: e, reason: null };
    return { allow: false, kind: 'iap', principal: iap.email, reason: `identity ${iap.email} is not on the family allow-list` };
  }
  const sched = await schedulerAuth.verifySchedulerToken(bearer(req));
  if (sched) return { allow: true, kind: 'scheduler', principal: sched.email, reason: null };
  return { allow: false, kind: 'anonymous', principal: null, reason: cfg.audience ? 'no IAP assertion for a family identity' : 'PRIVATE_ACCESS_IAP_AUDIENCE not configured; IAP assertion cannot be verified' };
}

function privateAccessGuard() {
  return async function privateAccess(req, res, next) {
    const cfg = getPrivateAccessConfig();
    if (cfg.mode === 'off') return next();
    let d;
    try { d = await decideRequest(req, cfg); } catch (e) { d = { allow: false, kind: 'error', principal: null, reason: `verification error: ${e.message}` }; }
    req.privateAccess = d;
    if (d.allow) {
      decisions.allowed += 1;
      decisions.lastAllowed = { at: new Date().toISOString(), kind: d.kind, principal: d.principal, path: req.path };
      if (d.principal) res.set('x-dlb-family-identity', d.principal);
      return next();
    }
    decisions.lastRefusal = { at: new Date().toISOString(), kind: d.kind, principal: d.principal, path: req.path, reason: d.reason };
    if (cfg.mode === 'audit') { decisions.audited += 1; return next(); }
    decisions.refused += 1;
    return res.status(403).json({ success: false, error: 'private family system: access refused', code: 'PRIVATE_ACCESS_REFUSED' });
  };
}

function status(env = process.env) {
  const cfg = getPrivateAccessConfig(env);
  return {
    mode: cfg.mode,
    iapAudienceConfigured: Boolean(cfg.audience),
    familyEmails: cfg.familyEmails.length,
    familyDomains: cfg.familyDomains.length,
    exemptPaths: cfg.exemptPaths,
    serviceAccounts: cfg.serviceAccounts.length,
    schedulerServiceAccount: Boolean(cfg.schedulerServiceAccount),
    decisions: { ...decisions },
  };
}

function _reset() { keyCache = { keys: null, expiresAt: 0 }; Object.assign(decisions, { allowed: 0, refused: 0, audited: 0, lastRefusal: null, lastAllowed: null }); }
function _setKeysForTest(keys) { keyCache = { keys, expiresAt: Date.now() + 60000 }; }

module.exports = { privateAccessGuard, decideRequest, verifyIapAssertion, getPrivateAccessConfig, isFamily, status, IAP_HEADER, IAP_ISSUER, _reset, _setKeysForTest };
