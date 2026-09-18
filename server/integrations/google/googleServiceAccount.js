'use strict';

/**
 * Google Cloud service-account credentials for the server-side Google APIs the
 * trust calls directly (Google Wallet Objects, Cloud Storage evidence bucket).
 *
 * Credential sources, in order:
 *   1. an explicit env var holding either the full service-account JSON key
 *      (as downloaded from the GCP Console) or just the PEM private key, in
 *      which case the client email comes from a sibling `*_EMAIL` var;
 *   2. GOOGLE_APPLICATION_CREDENTIALS pointing at a service-account JSON file;
 *   3. the Cloud Run / GCE metadata server (Workload Identity), which is what
 *      the Terraform in infra/gcp provisions for the app's runtime identity.
 *
 * Tokens are cached in memory per (account, scope) and never logged.
 */

const fs = require('fs');
const jwt = require('jsonwebtoken');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const EXPIRY_SKEW_MS = 60 * 1000;
const TOKEN_CACHE = new Map();

function normalizePem(key) {
  return String(key || '').replace(/\\n/g, '\n').trim();
}

/**
 * Parse a service account from a key value plus optional email. Returns null
 * when nothing usable is configured (callers treat that as shadow mode).
 */
function parseServiceAccount(keyValue, email) {
  const raw = String(keyValue || '').trim();
  if (!raw) return null;
  if (raw.startsWith('{')) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error('service-account key is not valid JSON'); }
    if (!parsed.private_key || !parsed.client_email) throw new Error('service-account JSON must contain private_key and client_email');
    return { clientEmail: parsed.client_email, privateKey: normalizePem(parsed.private_key), projectId: parsed.project_id || null, source: 'json' };
  }
  const pem = normalizePem(raw.startsWith('-----') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  if (!pem.includes('PRIVATE KEY')) throw new Error('service-account key must be a JSON key file or a PEM private key');
  if (!email) throw new Error('a PEM service-account key needs the matching client email');
  return { clientEmail: email, privateKey: pem, projectId: null, source: 'pem' };
}

function loadServiceAccount({ keyEnv, emailEnv } = {}) {
  const fromEnv = parseServiceAccount(keyEnv ? process.env[keyEnv] : '', emailEnv ? process.env[emailEnv] : '');
  if (fromEnv) return fromEnv;
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (file && fs.existsSync(file)) {
    const sa = parseServiceAccount(fs.readFileSync(file, 'utf8'), '');
    if (sa) return { ...sa, source: 'file' };
  }
  return null;
}

function onGoogleRuntime() {
  return Boolean(process.env.K_SERVICE || process.env.GCE_METADATA_HOST || process.env.GOOGLE_METADATA_IDENTITY === 'true');
}

/** RS256-sign arbitrary claims with the service account's private key. */
function signJwt(claims, sa, { expiresInSec = 3600 } = {}) {
  if (!sa || !sa.privateKey) throw new Error('no service-account private key available to sign');
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ iat: now, exp: now + expiresInSec, ...claims }, sa.privateKey, { algorithm: 'RS256' });
}

async function postForm(url, form) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Google token endpoint returned HTTP ${res.status}`);
  return res.json();
}

/**
 * OAuth2 access token for the given scopes, from the service account (JWT
 * bearer grant) or the metadata server when running on Cloud Run/GCE.
 */
async function getAccessToken(sa, scopes) {
  const scope = Array.isArray(scopes) ? scopes.join(' ') : String(scopes || '');
  const cacheKey = `${sa ? sa.clientEmail : 'metadata'}|${scope}`;
  const cached = TOKEN_CACHE.get(cacheKey);
  if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) return cached.token;

  let json;
  if (sa) {
    const assertion = signJwt({ iss: sa.clientEmail, sub: sa.clientEmail, aud: TOKEN_URL, scope }, sa);
    json = await postForm(TOKEN_URL, { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
  } else if (onGoogleRuntime()) {
    const url = `${METADATA_TOKEN_URL}?scopes=${encodeURIComponent(scope)}`;
    const res = await fetch(url, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`metadata server returned HTTP ${res.status}`);
    json = await res.json();
  } else {
    throw new Error('no Google credentials: set a service-account key or run on Cloud Run with a runtime service account');
  }
  const token = json && json.access_token;
  if (!token) throw new Error('Google token response did not include access_token');
  const ttl = Number(json.expires_in) > 0 ? Number(json.expires_in) * 1000 : 5 * 60 * 1000;
  TOKEN_CACHE.set(cacheKey, { token, expiresAt: Date.now() + ttl });
  return token;
}

/** Authenticated JSON call to a Google API. Never echoes the bearer token. */
async function googleFetch(method, url, token, body, { timeoutMs = 30000, headers = {} } = {}) {
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) {
    opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
    opts.body = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { ok: res.ok, statusCode: res.status, json, text };
}

function clearTokenCache() { TOKEN_CACHE.clear(); }

module.exports = {
  parseServiceAccount,
  loadServiceAccount,
  onGoogleRuntime,
  signJwt,
  getAccessToken,
  googleFetch,
  clearTokenCache,
};
