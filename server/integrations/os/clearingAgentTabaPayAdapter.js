'use strict';

/**
 * TabaPay adapter for the Clearing Agent OS.
 *
 * TabaPay is a licensed US money-movement processor (ACH, RTP, push-to-card)
 * reached over a bearer-authenticated REST API:
 *   GET  https://{FQDN}:{PORT}/v1/clients/{ClientID}                  (handshake)
 *   POST https://{FQDN}:{PORT}/v1/clients/{ClientID}/transactions     (push payout)
 * The FQDN/port, ClientID, settlement AccountID and bearer key come from
 * TabaPay's credentials file. Only the bearer key is a secret and it is read
 * from a Secret Manager reference at call time; it never enters a response,
 * event, or DB row.
 *
 * A network is a TabaPay network when its capabilities carry
 * { adapter: 'tabapay', clientId, settlementAccountId }.
 */

const https = require('https');

const ADAPTER = 'tabapay';
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const ACH_OPTIONS = { instant: 'R', same_day: 'S', standard: 'N' };

function isTabaPay(network) {
  return Boolean(network && network.capabilities && network.capabilities.adapter === ADAPTER);
}

function adapterConfig(network) {
  const c = (network && network.capabilities) || {};
  const clientId = String(c.clientId || '').trim();
  const settlementAccountId = String(c.settlementAccountId || '').trim();
  if (!CLIENT_ID_RE.test(clientId)) throw new Error('tabapay capabilities.clientId must be the 22-character TabaPay ClientID');
  if (!CLIENT_ID_RE.test(settlementAccountId)) throw new Error('tabapay capabilities.settlementAccountId must be the 22-character TabaPay settlement AccountID');
  return { clientId, settlementAccountId, subClientId: c.subClientId ? String(c.subClientId) : null };
}

function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: parts[0] };
  return { first: parts[0], middle: parts.length > 2 ? parts.slice(1, -1).join(' ') : undefined, last: parts[parts.length - 1] };
}

/** referenceID: 1-15 chars, unique per client; derived deterministically from the idempotency key. */
function referenceId(idempotencyKey) {
  return require('crypto').createHash('sha256').update(String(idempotencyKey)).digest('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 15);
}

/**
 * Canonical instruction -> TabaPay Create Transaction body (push from the
 * client's settlement account to the creditor's US bank account).
 */
function toTransaction(ix, { settlementAccountId, idempotencyKey }) {
  const ach = ACH_OPTIONS[ix.speed] || ACH_OPTIONS.standard;
  const name = splitName(ix.creditor.name);
  return {
    referenceID: referenceId(idempotencyKey || ix.endToEndId),
    type: 'push',
    accounts: {
      sourceAccountID: settlementAccountId,
      destinationAccount: {
        bank: { routingNumber: ix.creditor.routingNumber, accountNumber: ix.creditor.accountNumber, accountType: ix.creditor.accountType === 'savings' ? 'S' : 'C' },
        owner: { name: { first: name.first, ...(name.middle ? { middle: name.middle } : {}), last: name.last } },
      },
    },
    currency: '840',
    amount: ix.amount,
    achOptions: ach,
    achEntryType: ix.secCode,
    memo: String(ix.purpose || 'TRUST DISTRIBUTION').slice(0, 32),
  };
}

function request(method, url, bearer, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') return reject(new Error('tabapay endpoint must be https'));
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const headers = { Accept: 'application/json', Authorization: `Bearer ${bearer}` };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const req = https.request({ method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ statusCode: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, json, text: text.slice(0, 2000) });
      });
    });
    req.on('timeout', () => req.destroy(new Error('tabapay endpoint timeout')));
    req.on('error', reject);
    req.end(data || undefined);
  });
}

/**
 * Handshake: an authenticated Retrieve Client must answer SC 200 for the
 * configured ClientID. Proves bearer key + ClientID + egress path without
 * creating anything at TabaPay.
 */
async function handshake(network, bearer, timeoutMs) {
  const { clientId } = adapterConfig(network);
  const res = await request('GET', `${network.base_url}/v1/clients/${clientId}`, bearer, null, timeoutMs);
  const sc = res.json && Number(res.json.SC);
  if (!res.ok || sc !== 200) return { ok: false, reason: `tabapay client retrieve answered HTTP ${res.statusCode}${sc ? ` SC ${sc}` : ''}`, statusCode: res.statusCode };
  const caps = { adapter: ADAPTER, clientStatus: res.json.status || null, rails: ['ach_standard', 'ach_same_day', 'rtp'], country: 'US', currency: 'USD' };
  return { ok: true, capabilities: caps, statusCode: res.statusCode };
}

/**
 * Clear: Create Transaction. 200 COMPLETED (RTP) or 201 pending/ACH batch
 * count as cleared; 207/4xx/5xx are rejections. Returns the TabaPay
 * transactionID as the network reference.
 */
async function clear(network, bearer, ix, idempotencyKey, timeoutMs) {
  const { clientId, settlementAccountId } = adapterConfig(network);
  const body = toTransaction(ix, { settlementAccountId, idempotencyKey });
  const res = await request('POST', `${network.base_url}/v1/clients/${clientId}/transactions`, bearer, body, timeoutMs);
  const j = res.json || {};
  const sc = Number(j.SC);
  const status = j.status ? String(j.status).toUpperCase() : null;
  const okStatus = !status || ['COMPLETED', 'PENDING', 'BATCH', 'CREATED', 'PROCESSING'].includes(status);
  if (!res.ok || (sc && sc !== 200 && sc !== 201) || !okStatus) {
    return { ok: false, statusCode: res.statusCode, reason: `tabapay ${status || 'error'} HTTP ${res.statusCode}${j.EC ? ` EC ${j.EC}` : ''}${j.networkRC ? ` networkRC ${j.networkRC}` : ''}`, body };
  }
  return { ok: true, statusCode: res.statusCode, networkRef: j.transactionID ? String(j.transactionID) : null, status, approvalCode: j.approvalCode || null, body };
}

module.exports = { ADAPTER, isTabaPay, adapterConfig, toTransaction, referenceId, handshake, clear, ACH_OPTIONS };
