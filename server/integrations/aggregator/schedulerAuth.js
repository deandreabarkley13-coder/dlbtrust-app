'use strict';

/**
 * Verifies Google-issued OIDC ID tokens presented by Cloud Scheduler jobs
 * (infra/gcp/aggregator_cron.tf) that call POST /api/aggregator/connections/:id/pull.
 *
 * Fail-closed: verification is disabled entirely unless both
 *   AGGREGATOR_SCHEDULER_SERVICE_ACCOUNT  — SA email the job runs as
 *   AGGREGATOR_SCHEDULER_AUDIENCE         — expected `aud` (the Cloud Run URL)
 * are configured. Tokens must be RS256, signed by a current Google cert,
 * issued by accounts.google.com, unexpired, for the configured audience, and
 * carry email_verified for exactly the configured service account.
 */

const https = require('https');
const jwt = require('jsonwebtoken');

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v1/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

let certCache = { certs: null, expiresAt: 0 };

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000, headers: { Accept: 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' fetching ' + url));
        try { resolve({ json: JSON.parse(data), headers: res.headers }); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Timed out fetching ' + url)));
  });
}

function maxAgeSeconds(cacheControl) {
  const m = /max-age=(\d+)/.exec(cacheControl || '');
  return m ? Number(m[1]) : 3600;
}

async function googleCerts() {
  if (certCache.certs && Date.now() < certCache.expiresAt) return certCache.certs;
  const { json, headers } = await fetchJson(GOOGLE_CERTS_URL);
  certCache = { certs: json, expiresAt: Date.now() + maxAgeSeconds(headers['cache-control']) * 1000 };
  return json;
}

function schedulerConfig() {
  const serviceAccount = process.env.AGGREGATOR_SCHEDULER_SERVICE_ACCOUNT;
  const audience = process.env.AGGREGATOR_SCHEDULER_AUDIENCE;
  if (!serviceAccount || !audience) return null;
  return { serviceAccount, audience };
}

/**
 * @returns {Promise<object|null>} verified claims, or null when scheduler auth
 *   is not configured or the token is invalid.
 */
async function verifySchedulerToken(token) {
  const cfg = schedulerConfig();
  if (!cfg || !token) return null;
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || !decoded.header || decoded.header.alg !== 'RS256' || !decoded.header.kid) return null;
  const certs = await googleCerts();
  const pem = certs[decoded.header.kid];
  if (!pem) return null;
  let claims;
  try {
    claims = jwt.verify(token, pem, { algorithms: ['RS256'], audience: cfg.audience, issuer: GOOGLE_ISSUERS });
  } catch (e) {
    return null;
  }
  if (claims.email_verified !== true || claims.email !== cfg.serviceAccount) return null;
  return claims;
}

function _resetCertCache() { certCache = { certs: null, expiresAt: 0 }; }

module.exports = { verifySchedulerToken, schedulerConfig, _resetCertCache };
