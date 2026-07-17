'use strict';

/**
 * Generic REST connector — a provider-agnostic connector driven entirely by a
 * connection's `config`. It can talk to any HTTPS/JSON financial API without
 * vendor-specific code, so new providers are onboarded by configuration rather
 * than new code.
 *
 * INBOUND (pull): GETs the configured endpoints and maps each JSON record into
 *   the aggregator's normalized shape using an optional field `mapping`.
 * OUTBOUND (push): POSTs the payload to the configured push endpoint.
 * WEBHOOKS: verifies an HMAC-SHA256 signature header when `webhookSecret` is set.
 *
 * Expected connection.config shape (all optional unless noted):
 * {
 *   baseUrl: 'https://provider.example.com',            // required for pull/push
 *   endpoints: {
 *     accounts: '/v1/accounts',
 *     transactions: '/v1/transactions',
 *     statements: '/v1/statements',
 *     push: '/v1/payments'
 *   },
 *   auth: { type: 'bearer'|'api_key'|'basic'|'hmac'|'none',
 *           bearerToken, apiKey, headerName, username, password, hmacSecret },
 *   // Mutual TLS (additive to header auth) — reuses the shared helper:
 *   useMtls, clientCertPath, clientKeyPath, clientCaPath, clientKeyPassphrase,
 *   // Webhook signature verification (secure default: unsigned webhooks are
 *   // rejected unless allowUnsignedWebhooks is explicitly set):
 *   webhookSecret, webhookSignatureHeader,   // default header: x-signature
 *   allowUnsignedWebhooks,                    // opt-in to accept unsigned webhooks
 *   // SSRF guard: requests to private/internal/loopback addresses are refused
 *   // unless the operator explicitly opts in:
 *   allowPrivateNetwork,                      // opt-in to allow internal targets
 *   // Optional record location + field mapping for normalization:
 *   listPaths: { accounts: 'data', transactions: 'data', statements: 'data' },
 *   mapping: {
 *     accounts: { externalAccountId:'id', name:'name', accountType:'type',
 *                 currency:'currency', mask:'mask',
 *                 balanceAvailable:'balances.available', balanceCurrent:'balances.current' },
 *     transactions: { externalTxnId:'id', externalAccountId:'account_id',
 *                     postedDate:'date', amount:'amount', currency:'currency',
 *                     description:'name', category:'category' },
 *     statements: { externalStatementId:'id', externalAccountId:'account_id',
 *                   periodStart:'start', periodEnd:'end', format:'format', uri:'url' }
 *   }
 * }
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const dns = require('dns').promises;
const { URL } = require('url');

// Build mutual-TLS options from a connection config. Returns {} when mTLS is
// not enabled or cert material is missing, so the result is always safe to
// spread into https.request options. Self-contained so this connector does not
// depend on other outbound clients being present.
function buildMtlsOptions(config) {
  if (!config) return {};
  const useMtls = config.useMtls === true || config.useMtls === 'true';
  const certPath = config.clientCertPath;
  const keyPath = config.clientKeyPath;
  if (!useMtls || !certPath || !keyPath) return {};
  const tls = {};
  try {
    tls.cert = fs.readFileSync(certPath);
    tls.key = fs.readFileSync(keyPath);
    if (config.clientCaPath && fs.existsSync(config.clientCaPath)) tls.ca = fs.readFileSync(config.clientCaPath);
    if (config.clientKeyPassphrase) tls.passphrase = config.clientKeyPassphrase;
  } catch (err) {
    throw new Error('Failed to load mTLS client certificate material: ' + err.message);
  }
  return tls;
}

// Returns true if the given literal IP is loopback/private/link-local (incl.
// cloud metadata 169.254.169.254) — used to block SSRF to internal targets.
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice(7));
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
  if (lower.startsWith('fe80')) return true; // link-local
  return false;
}

// SSRF guard: resolves the target host and returns the vetted public IPs to
// pin the connection to (defeats DNS rebinding). Returns null when the operator
// explicitly opts into private-network access via config.allowPrivateNetwork.
async function resolveAllowed(parsed, config) {
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only http/https URLs are allowed');
  }
  if (config && config.allowPrivateNetwork === true) return null;
  const host = parsed.hostname;
  let addrs;
  if (net.isIP(host)) {
    addrs = [host];
  } else {
    const results = await dns.lookup(host, { all: true });
    addrs = results.map((r) => r.address);
  }
  const allowed = addrs.filter((a) => !isPrivateIp(a));
  if (!allowed.length) {
    throw new Error('Refusing to connect to private/internal host ' + host
      + ' (set config.allowPrivateNetwork=true to override)');
  }
  return allowed;
}

const DEFAULT_ENDPOINTS = {
  accounts: '/accounts',
  transactions: '/transactions',
  statements: '/statements',
  push: '/payments',
};

function getPath(obj, dotted) {
  if (!dotted) return undefined;
  return dotted.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function toNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function applyAuth(headers, config, body) {
  const auth = (config && config.auth) || {};
  const type = auth.type || 'none';
  if (type === 'bearer' && auth.bearerToken) {
    headers['Authorization'] = 'Bearer ' + auth.bearerToken;
  } else if (type === 'api_key' && auth.apiKey) {
    headers[auth.headerName || 'X-API-Key'] = auth.apiKey;
  } else if (type === 'basic' && (auth.username || auth.password)) {
    const token = Buffer.from(`${auth.username || ''}:${auth.password || ''}`).toString('base64');
    headers['Authorization'] = 'Basic ' + token;
  } else if (type === 'hmac' && auth.hmacSecret) {
    const sig = crypto.createHmac('sha256', auth.hmacSecret).update(body || '').digest('hex');
    headers[auth.headerName || 'X-Signature'] = sig;
  }
}

async function request(method, urlStr, config, bodyObj) {
  const parsed = new URL(urlStr);
  const vetted = await resolveAllowed(parsed, config);
  return new Promise((resolve, reject) => {
    const lib = parsed.protocol === 'https:' ? https : http;
    const body = bodyObj != null ? JSON.stringify(bodyObj) : null;
    const headers = { 'Accept': 'application/json' };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    applyAuth(headers, config, body || '');

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method,
      headers,
      timeout: 30000,
      rejectUnauthorized: true,
      // Present a client certificate when the provider requires mutual TLS
      ...buildMtlsOptions(config),
    };

    // Pin the connection to a vetted public IP (with a custom lookup) so a
    // rebinding DNS response cannot redirect us to an internal address, while
    // preserving the original hostname for TLS SNI and the Host header.
    if (vetted && vetted.length) {
      const ip = vetted[0];
      const family = net.isIPv6(ip) ? 6 : 4;
      options.lookup = (hostname, opts, cb) => cb(null, ip, family);
    }

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (e) { json = null; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, json, raw: data });
        } else {
          reject(new Error(`HTTP ${res.statusCode} from ${method} ${urlStr}: ${data.substring(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Request timed out: ' + urlStr)); });
    if (body) req.write(body);
    req.end();
  });
}

function endpointUrl(config, key) {
  if (!config.baseUrl) throw new Error('config.baseUrl is required for the generic_rest connector');
  const endpoints = Object.assign({}, DEFAULT_ENDPOINTS, config.endpoints || {});
  const ep = endpoints[key];
  if (!ep) throw new Error(`No "${key}" endpoint configured`);
  return new URL(ep, config.baseUrl).toString();
}

function extractList(json, listPath) {
  if (Array.isArray(json)) return json;
  if (listPath) {
    const v = getPath(json, listPath);
    if (Array.isArray(v)) return v;
  }
  // common conventions
  for (const key of ['data', 'results', 'items', 'accounts', 'transactions', 'statements']) {
    if (json && Array.isArray(json[key])) return json[key];
  }
  return [];
}

function mapRecord(record, mapping, defaults) {
  const out = Object.assign({}, defaults);
  if (mapping) {
    for (const [normKey, srcPath] of Object.entries(mapping)) {
      out[normKey] = getPath(record, srcPath);
    }
  } else {
    Object.assign(out, record);
  }
  out.raw = record;
  return out;
}

const genericRestConnector = {
  type: 'generic_rest',

  async pullAccounts(conn, opts) {
    const config = conn.config || {};
    const url = endpointUrl(config, 'accounts');
    const { json } = await request('GET', url, config, null);
    const list = extractList(json, (config.listPaths || {}).accounts);
    const mapping = (config.mapping || {}).accounts;
    return list.map((rec) => {
      const m = mapRecord(rec, mapping, {});
      return {
        externalAccountId: m.externalAccountId != null ? m.externalAccountId : (rec.id || rec.account_id),
        name: m.name,
        accountType: m.accountType,
        currency: m.currency || 'USD',
        mask: m.mask,
        balanceAvailable: toNumber(m.balanceAvailable),
        balanceCurrent: toNumber(m.balanceCurrent),
        raw: rec,
      };
    }).filter((a) => a.externalAccountId != null);
  },

  async pullTransactions(conn, opts) {
    const config = conn.config || {};
    let url = endpointUrl(config, 'transactions');
    if (opts && opts.since) url += (url.indexOf('?') === -1 ? '?' : '&') + 'since=' + encodeURIComponent(opts.since);
    if (opts && opts.accountId) url += (url.indexOf('?') === -1 ? '?' : '&') + 'account_id=' + encodeURIComponent(opts.accountId);
    const { json } = await request('GET', url, config, null);
    const list = extractList(json, (config.listPaths || {}).transactions);
    const mapping = (config.mapping || {}).transactions;
    return list.map((rec) => {
      const m = mapRecord(rec, mapping, {});
      const amount = toNumber(m.amount != null ? m.amount : rec.amount);
      let direction = m.direction;
      if (!direction && amount != null) direction = amount < 0 ? 'debit' : 'credit';
      return {
        externalTxnId: m.externalTxnId != null ? m.externalTxnId : (rec.id || rec.transaction_id),
        externalAccountId: m.externalAccountId,
        postedDate: m.postedDate,
        amount: amount != null ? amount : 0,
        currency: m.currency || 'USD',
        direction,
        description: m.description,
        category: m.category,
        status: m.status || 'posted',
        raw: rec,
      };
    }).filter((t) => t.externalTxnId != null);
  },

  async pullStatements(conn, opts) {
    const config = conn.config || {};
    const url = endpointUrl(config, 'statements');
    const { json } = await request('GET', url, config, null);
    const list = extractList(json, (config.listPaths || {}).statements);
    const mapping = (config.mapping || {}).statements;
    return list.map((rec) => {
      const m = mapRecord(rec, mapping, {});
      return {
        externalStatementId: m.externalStatementId != null ? m.externalStatementId : (rec.id || rec.statement_id),
        externalAccountId: m.externalAccountId,
        periodStart: m.periodStart,
        periodEnd: m.periodEnd,
        format: m.format,
        uri: m.uri,
        raw: rec,
      };
    }).filter((s) => s.externalStatementId != null);
  },

  async push(conn, payload) {
    const config = conn.config || {};
    const url = endpointUrl(config, 'push');
    const { json } = await request('POST', url, config, payload);
    const providerRef = json && (json.id || json.reference || json.transfer_id || json.payment_id) || null;
    return { ok: true, providerRef, response: json };
  },

  verifyWebhook(conn, headers, rawBody) {
    const config = conn.config || {};
    // Secure default: reject unsigned webhooks unless a secret is configured.
    // Operators whose provider does not sign webhooks can opt in explicitly.
    if (!config.webhookSecret) return config.allowUnsignedWebhooks === true;
    const headerName = (config.webhookSignatureHeader || 'x-signature').toLowerCase();
    const provided = headers ? (headers[headerName] || headers[headerName.replace(/-/g, '_')]) : null;
    if (!provided) return false;
    const expected = crypto.createHmac('sha256', config.webhookSecret)
      .update(rawBody || '').digest('hex');
    try {
      const a = Buffer.from(String(provided).replace(/^sha256=/, ''));
      const b = Buffer.from(expected);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (e) {
      return false;
    }
  },
};

module.exports = { genericRestConnector };
