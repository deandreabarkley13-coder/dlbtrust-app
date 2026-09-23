'use strict';

/**
 * MFT Gateway (Aayu) REST client — hands an EDI payload to our hosted AS2
 * station, which signs/encrypts it and delivers it to the named partner.
 *
 *   POST /authorize                 { tokenID, tokenSecret } -> { apiToken, apiTokenExpiryIn }
 *   POST /message/submit?service=as2  AS2-From / AS2-To headers, raw body
 *
 * Auth tokens are cached until shortly before expiry. Nothing here is gated:
 * callers (Edi820RemittanceEngine) decide whether a send is allowed.
 */

const DEFAULT_API_URL = 'https://api.mftgateway.com';
const EXPIRY_SKEW_MS = 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30 * 1000;

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }

function apiUrl() {
  const raw = str('MFTGATEWAY_API_URL', DEFAULT_API_URL).replace(/\/+$/, '');
  let parsed;
  try { parsed = new URL(raw); } catch (e) { parsed = null; }
  if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new MftGatewayError(`MFTGATEWAY_API_URL must be an https:// URL without credentials (got ${raw || 'empty'})`, 'MFTGATEWAY_BAD_URL', 503);
  }
  return raw;
}

function timeoutMs() {
  const n = Number(str('MFTGATEWAY_TIMEOUT_MS'));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

class MftGatewayError extends Error {
  constructor(message, code, httpStatus) {
    super(message);
    this.name = 'MftGatewayError';
    this.code = code || 'MFTGATEWAY_ERROR';
    this.httpStatus = httpStatus || 502;
  }
}

let session = null;

class MftGatewayClient {
  static getConfig() {
    return {
      apiUrl: apiUrl(),
      timeoutMs: timeoutMs(),
      tokenId: str('MFTGATEWAY_API_TOKEN_ID'),
      tokenSecret: str('MFTGATEWAY_API_TOKEN_SECRET'),
      stationAs2Id: str('MFTGATEWAY_STATION_AS2_ID') || str('EDI_820_SENDER_ID') || str('AS2_LOCAL_AS2_ID', 'DLBTRUST-AS2'),
      partnerAs2Id: str('MFTGATEWAY_PARTNER_AS2_ID') || str('EDI_820_RECEIVER_ID'),
    };
  }

  static configured() {
    const cfg = this.getConfig();
    return Boolean(cfg.tokenId && cfg.tokenSecret && cfg.stationAs2Id);
  }

  static issues() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.tokenId) issues.push('MFTGATEWAY_API_TOKEN_ID not configured');
    if (!cfg.tokenSecret) issues.push('MFTGATEWAY_API_TOKEN_SECRET not configured');
    if (!cfg.stationAs2Id) issues.push('MFTGATEWAY_STATION_AS2_ID not configured');
    if (!cfg.partnerAs2Id) issues.push('MFTGATEWAY_PARTNER_AS2_ID not configured');
    return issues;
  }

  static async authorize({ force = false } = {}) {
    const cfg = this.getConfig();
    if (!cfg.tokenId || !cfg.tokenSecret) {
      throw new MftGatewayError('MFT Gateway API token not configured', 'MFTGATEWAY_NOT_CONFIGURED', 503);
    }
    if (!force && session && session.expiresAt - EXPIRY_SKEW_MS > Date.now()) return session.apiToken;

    const res = await fetch(`${cfg.apiUrl}/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenID: cfg.tokenId, tokenSecret: cfg.tokenSecret }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    const body = await MftGatewayClient._json(res);
    if (!res.ok || !body.apiToken) {
      throw new MftGatewayError(`MFT Gateway authorization failed (${res.status}): ${body.message || 'no token returned'}`, 'MFTGATEWAY_AUTH_FAILED', 502);
    }
    const ttlSec = Number(body.apiTokenExpiryIn) > 0 ? Number(body.apiTokenExpiryIn) : 3300;
    session = { apiToken: body.apiToken, expiresAt: Date.now() + ttlSec * 1000 };
    return session.apiToken;
  }

  /** Station list — cheap connectivity/credential probe. */
  static async listStations() {
    const cfg = this.getConfig();
    const apiToken = await this.authorize();
    const res = await fetch(`${cfg.apiUrl}/station`, { headers: { Authorization: apiToken }, signal: AbortSignal.timeout(cfg.timeoutMs) });
    const body = await MftGatewayClient._json(res);
    if (!res.ok) throw new MftGatewayError(`MFT Gateway station lookup failed (${res.status}): ${body.message || ''}`, 'MFTGATEWAY_STATION_LOOKUP_FAILED', 502);
    return Array.isArray(body.stations) ? body.stations : [];
  }

  /**
   * Queue one AS2 message from our station to the partner.
   * Returns { success, message_id, status_code, response_body, link, transmitted_at }
   * — the same shape AS2Client.transmit produces so callers treat both alike.
   */
  static async submit(payload, filename, { stationAs2Id, partnerAs2Id, subject, contentType } = {}) {
    const cfg = this.getConfig();
    const from = stationAs2Id || cfg.stationAs2Id;
    const to = partnerAs2Id || cfg.partnerAs2Id;
    if (!from) throw new MftGatewayError('MFT Gateway station AS2 ID not configured', 'MFTGATEWAY_NOT_CONFIGURED', 503);
    if (!to) throw new MftGatewayError('MFT Gateway partner AS2 ID not configured', 'MFTGATEWAY_NOT_CONFIGURED', 503);

    const send = async (apiToken) => fetch(`${cfg.apiUrl}/message/submit?service=as2`, {
      method: 'POST',
      headers: {
        Authorization: apiToken,
        'AS2-From': from,
        'AS2-To': to,
        'Attachment-Name': filename,
        'Content-Type': contentType || 'application/edi-x12',
        ...(subject ? { Subject: subject } : {}),
      },
      body: Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8'),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });

    let res = await send(await this.authorize());
    if (res.status === 401) res = await send(await this.authorize({ force: true }));
    const body = await MftGatewayClient._json(res);
    const success = res.status === 202 || (res.ok && Boolean(body.messageIdentifier));
    return {
      success,
      transport: 'mftgateway',
      as2_from: from,
      as2_to: to,
      message_id: body.messageIdentifier || null,
      status_code: res.status,
      response_body: success ? (body.message || 'queued') : (body.message || body.raw || ''),
      link: res.headers.get('link') || null,
      transmitted_at: new Date().toISOString(),
    };
  }

  static async _json(res) {
    const text = await res.text();
    try { return text ? JSON.parse(text) : {}; } catch (e) { return { raw: text }; }
  }

  /** Test hook. */
  static _resetSession() { session = null; }
}

module.exports = { MftGatewayClient, MftGatewayError };
