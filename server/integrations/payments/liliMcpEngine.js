'use strict';

/**
 * Lili MCP Engine
 *
 * Machine-to-machine integration with the Lili MCP server using the Streamable
 * HTTP transport (MCP spec 2025-03-26).  Supports OAuth 2.0 token refresh and
 * generic tool invocation, and exposes high-level helpers for paying a vendor
 * through Lili Bill Pay.
 *
 * Required env / system settings:
 *   LILI_MCP_URL            default https://mcp.lili.co/mcp
 *   LILI_OAUTH_CLIENT_ID    registered OAuth client id
 *   LILI_OAUTH_CLIENT_SECRET
 *   LILI_OAUTH_ACCESS_TOKEN current access token (or refresh token)
 *   LILI_OAUTH_REFRESH_TOKEN
 *   LILI_BUSINESS_USER_ID   Lili business user external id (optional for owner accounts)
 */

const crypto = require('crypto');

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

let SystemSettings;
let PaymentCrypto;
function loadDeps() {
  try { ({ SystemSettings } = require('../ach/systemSettings')); } catch (e) { SystemSettings = null; }
  try { PaymentCrypto = require('../paymentHub/paymentCrypto'); } catch (e) { PaymentCrypto = null; }
}

async function getSetting(name) {
  loadDeps();
  if (SystemSettings && typeof SystemSettings.get === 'function') {
    try {
      const v = await SystemSettings.get(name);
      if (v !== null && v !== undefined) return v;
    } catch (e) { /* fall through */ }
  }
  return process.env[name] || null;
}

async function setSetting(name, value, updatedBy = 'system') {
  loadDeps();
  if (SystemSettings && typeof SystemSettings.set === 'function') {
    await SystemSettings.set(name, value, updatedBy);
  }
}

function safeEncrypt(value) {
  if (!value) return value;
  if (PaymentCrypto && typeof PaymentCrypto.encrypt === 'function') {
    try { return PaymentCrypto.encrypt(value); } catch (e) { /* fall through to plaintext */ }
  }
  return value;
}

function safeDecrypt(value) {
  if (!value) return value;
  if (PaymentCrypto && typeof PaymentCrypto.decrypt === 'function') {
    try { return PaymentCrypto.decrypt(value); } catch (e) { return value; }
  }
  return value;
}

function generateId(prefix = 'MCP') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function generatePkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

class LiliMcpEngine {
  static async ensureTables() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lili_mcp_oauth_sessions (
        state TEXT PRIMARY KEY,
        code_verifier TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        client_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }

  static async getConfig() {
    return {
      mcpUrl: (await getSetting('LILI_MCP_URL')) || process.env.LILI_MCP_URL || 'https://mcp.lili.co/mcp',
      oauthBaseUrl: (await getSetting('LILI_OAUTH_BASE_URL')) || process.env.LILI_OAUTH_BASE_URL || 'https://mcp.lili.co',
      clientId: safeDecrypt(await getSetting('LILI_OAUTH_CLIENT_ID')) || process.env.LILI_OAUTH_CLIENT_ID || null,
      clientSecret: safeDecrypt(await getSetting('LILI_OAUTH_CLIENT_SECRET')) || process.env.LILI_OAUTH_CLIENT_SECRET || null,
      accessToken: safeDecrypt(await getSetting('LILI_OAUTH_ACCESS_TOKEN')) || process.env.LILI_OAUTH_ACCESS_TOKEN || null,
      refreshToken: safeDecrypt(await getSetting('LILI_OAUTH_REFRESH_TOKEN')) || process.env.LILI_OAUTH_REFRESH_TOKEN || null,
      businessUserId: (await getSetting('LILI_BUSINESS_USER_ID')) || process.env.LILI_BUSINESS_USER_ID || null,
      mcpEnabled: ((await getSetting('LILI_MCP_ENABLED')) || process.env.LILI_MCP_ENABLED || 'false') === 'true',
    };
  }

  static async getPublicConfig() {
    const cfg = await this.getConfig();
    return {
      mcpUrl: cfg.mcpUrl,
      oauthBaseUrl: cfg.oauthBaseUrl,
      mcpEnabled: cfg.mcpEnabled,
      configured: this.isConfigured(cfg),
      hasClientId: Boolean(cfg.clientId),
      hasAccessToken: Boolean(cfg.accessToken),
      hasRefreshToken: Boolean(cfg.refreshToken),
      businessUserId: cfg.businessUserId,
      lastRefreshError: this._lastRefreshError,
    };
  }

  static isConfigured(cfg) {
    if (!cfg) cfg = {};
    return Boolean(cfg.mcpEnabled && cfg.mcpUrl && (cfg.accessToken || cfg.refreshToken) && cfg.clientId);
  }

  static _getRedirectUri() {
    // Lili's MCP OAuth server only permits loopback redirect URIs for native
    // clients. 127.0.0.1 is required by Lili's native flow. Override via
    // LILI_OAUTH_REDIRECT_URI if you run the capture server on a different
    // host/port/path.
    return process.env.LILI_OAUTH_REDIRECT_URI || 'http://127.0.0.1:3000/oauth/callback';
  }

  static async registerClient({ appName = 'DLB Trust MCP', redirectUri } = {}) {
    const cfg = await this.getConfig();
    const url = `${cfg.oauthBaseUrl.replace(/\/$/, '')}/oauth/register`;
    const body = JSON.stringify({
      client_name: appName,
      client_uri: process.env.LILI_OAUTH_CLIENT_URI || 'https://github.com/deandreabarkley13-coder/dlbtrust-app',
      redirect_uris: [redirectUri || this._getRedirectUri()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'openid email profile',
      software_id: process.env.LILI_OAUTH_SOFTWARE_ID || 'dlbtrust-lili-mcp',
      software_version: process.env.LILI_OAUTH_SOFTWARE_VERSION || '1.0.0',
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Lili client registration failed: ${res.status} ${text}`);
    try { return JSON.parse(text); } catch (e) { return { raw: text }; }
  }

  static _getResource(resource) {
    return resource || process.env.LILI_OAUTH_RESOURCE || 'https://mcp.lili.co/';
  }

  /**
   * Forget the registered client and any stored tokens. Use when the auth
   * server no longer recognises the dynamic client (refresh -> 400
   * token_request_failed) so the next startOAuth re-registers from scratch.
   */
  static async resetCredentials(updatedBy = 'system') {
    for (const key of ['LILI_OAUTH_CLIENT_ID', 'LILI_OAUTH_CLIENT_SECRET', 'LILI_OAUTH_ACCESS_TOKEN', 'LILI_OAUTH_REFRESH_TOKEN']) {
      await setSetting(key, '', updatedBy);
    }
    this._sessionId = null;
    this._lastRefreshError = null;
  }

  static async startOAuth({ appName, redirectUri, state: providedState, resource, reset = false } = {}) {
    await this.ensureTables();
    if (reset) await this.resetCredentials();
    let cfg = await this.getConfig();
    const redirect = redirectUri || this._getRedirectUri();

    let clientId = cfg.clientId;
    let clientSecret = cfg.clientSecret;
    if (!clientId) {
      const reg = await this.registerClient({ appName, redirectUri: redirect });
      clientId = reg.client_id;
      clientSecret = reg.client_secret;
      if (!clientId) throw new Error('Lili client registration did not return client_id');
      await setSetting('LILI_OAUTH_CLIENT_ID', safeEncrypt(clientId));
      await setSetting('LILI_OAUTH_CLIENT_SECRET', clientSecret ? safeEncrypt(clientSecret) : '');
      cfg = await this.getConfig();
    }

    const { verifier, challenge } = generatePkce();
    const state = providedState || (crypto.randomUUID ? crypto.randomUUID() : generateId('STATE'));

    if (pool) {
      await pool.query(
        `INSERT INTO lili_mcp_oauth_sessions (state, code_verifier, redirect_uri, client_id) VALUES ($1,$2,$3,$4)
         ON CONFLICT (state) DO UPDATE SET code_verifier=$2, redirect_uri=$3, client_id=$4, created_at=NOW()`,
        [state, verifier, redirect, clientId]
      );
    }

    const authUrl = new URL(`${cfg.oauthBaseUrl.replace(/\/$/, '')}/oauth/authorize`);
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('client_id', clientId);
    authUrl.searchParams.append('redirect_uri', redirect);
    authUrl.searchParams.append('scope', 'openid email profile');
    authUrl.searchParams.append('state', state);
    authUrl.searchParams.append('code_challenge', challenge);
    authUrl.searchParams.append('code_challenge_method', 'S256');
    authUrl.searchParams.append('resource', this._getResource(resource));

    return { authUrl: authUrl.toString(), state, redirectUri: redirect };
  }

  static async handleCallback(code, state) {
    if (!pool) throw new Error('Database not available for OAuth session lookup');
    const res = await pool.query('SELECT * FROM lili_mcp_oauth_sessions WHERE state = $1', [state]);
    const session = res.rows[0];
    if (!session) throw new Error('OAuth session not found or expired');

    const tokenRes = await this._exchangeCode({
      code,
      codeVerifier: session.code_verifier,
      redirectUri: session.redirect_uri,
      clientId: session.client_id,
    });

    if (tokenRes.access_token) await setSetting('LILI_OAUTH_ACCESS_TOKEN', safeEncrypt(tokenRes.access_token));
    if (tokenRes.refresh_token) await setSetting('LILI_OAUTH_REFRESH_TOKEN', safeEncrypt(tokenRes.refresh_token));

    await pool.query('DELETE FROM lili_mcp_oauth_sessions WHERE state = $1', [state]);

    return {
      success: true,
      accessTokenMasked: tokenRes.access_token ? `***${tokenRes.access_token.slice(-8)}` : null,
      refreshTokenMasked: tokenRes.refresh_token ? `***${tokenRes.refresh_token.slice(-8)}` : null,
      expiresIn: tokenRes.expires_in,
    };
  }

  static async _exchangeCode({ code, codeVerifier, redirectUri, clientId }) {
    const cfg = await this.getConfig();
    const clientSecret = cfg.clientSecret;
    const url = `${cfg.oauthBaseUrl.replace(/\/$/, '')}/oauth/token`;
    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('client_id', clientId);
    if (clientSecret) params.append('client_secret', clientSecret);
    params.append('code', code);
    params.append('redirect_uri', redirectUri);
    params.append('code_verifier', codeVerifier);
    params.append('resource', this._getResource());
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!res.ok) throw new Error(`OAuth token exchange failed: ${res.status} ${await res.text()}`);
    return await res.json();
  }

  static async getAccessToken({ forceRefresh = false } = {}) {
    const cfg = await this.getConfig();
    if (!this.isConfigured(cfg)) return null;
    if (cfg.accessToken && !forceRefresh) return cfg.accessToken;
    if (cfg.refreshToken) {
      try {
        const refreshed = await this._refreshAccessToken(cfg);
        return refreshed.access_token;
      } catch (e) {
        this._lastRefreshError = e.message;
        return null;
      }
    }
    return null;
  }

  static _lastRefreshError = null;

  static async _refreshAccessToken(cfg) {
    if (!cfg.refreshToken || !cfg.clientId) throw new Error('Refresh token and client id required');
    const url = `${cfg.oauthBaseUrl.replace(/\/$/, '')}/oauth/token`;
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('client_id', cfg.clientId);
    if (cfg.clientSecret) params.append('client_secret', cfg.clientSecret);
    params.append('refresh_token', cfg.refreshToken);
    params.append('resource', this._getResource());
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!res.ok) throw new Error(`OAuth refresh failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    if (!data.access_token) throw new Error('OAuth refresh did not return access_token');
    await setSetting('LILI_OAUTH_ACCESS_TOKEN', safeEncrypt(data.access_token));
    if (data.refresh_token) await setSetting('LILI_OAUTH_REFRESH_TOKEN', safeEncrypt(data.refresh_token));
    this._lastRefreshError = null;
    return data;
  }

  static _sessionId = null;

  static async _mcpPost(body, { accessToken, retried = false } = {}) {
    const cfg = await this.getConfig();
    const token = accessToken || await this.getAccessToken();
    if (!token) throw new Error('Lili MCP not authenticated');
    const headers = {
      'Accept': 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    };
    if (this._sessionId) headers['Mcp-Session-Id'] = this._sessionId;
    const res = await fetch(cfg.mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const sessionId = res.headers.get('mcp-session-id');
    if (sessionId) this._sessionId = sessionId;
    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();
    if (res.status === 401 && !retried && !accessToken) {
      const fresh = await this.getAccessToken({ forceRefresh: true });
      if (fresh && fresh !== token) return this._mcpPost(body, { accessToken: fresh, retried: true });
      throw new Error(`Lili MCP session expired and refresh failed${this._lastRefreshError ? `: ${this._lastRefreshError}` : ''}; re-run the OAuth capture (liliMcpOAuthSetup.js)`);
    }
    if (!res.ok && !contentType.includes('event-stream')) {
      throw new Error(`MCP request failed: ${res.status} ${text}`);
    }
    return this._parseMcpResponse(text, contentType);
  }

  static _parseMcpResponse(text, contentType) {
    if (contentType.includes('text/event-stream')) {
      const messages = [];
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data:')) {
          const payload = trimmed.replace(/^data:\s*/, '');
          if (payload === '[DONE]') continue;
          try { messages.push(JSON.parse(payload)); } catch (e) { /* ignore */ }
        }
      }
      if (!messages.length) return null;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].result !== undefined || messages[i].error !== undefined) return messages[i];
      }
      return messages[messages.length - 1];
    }
    try { return text ? JSON.parse(text) : null; } catch (e) { return { raw: text }; }
  }

  static async initialize() {
    this._sessionId = null;
    const response = await this._mcpPost({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'dlbtrust-lili-mcp', version: '1.0.0' },
      },
    });
    try {
      await this._mcpPost({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });
    } catch (e) { /* notification may not return response */ }
    return response;
  }

  static async listTools() {
    if (!this._sessionId) await this.initialize();
    return this._mcpPost({
      jsonrpc: '2.0',
      id: generateId(),
      method: 'tools/list',
    });
  }

  static async callTool(name, args = {}) {
    if (!this._sessionId) await this.initialize();
    return this._mcpPost({
      jsonrpc: '2.0',
      id: generateId(),
      method: 'tools/call',
      params: { name, arguments: args },
    });
  }

  static _extractText(toolResult) {
    if (!toolResult || !toolResult.result) return null;
    const content = toolResult.result.content || [];
    for (const c of content) {
      if (c.type === 'text' && c.text) {
        try { return JSON.parse(c.text); } catch (e) { return c.text; }
      }
    }
    return toolResult.result;
  }

  static async getAccountSummary(businessUserId) {
    const cfg = await this.getConfig();
    const args = {};
    const bid = businessUserId || cfg.businessUserId;
    if (bid) args.businessUserId = bid;
    const res = await this.callTool('lili_get_account_summary', args);
    return this._extractText(res);
  }

  static async listSuppliers(businessUserId) {
    const cfg = await this.getConfig();
    const args = {};
    const bid = businessUserId || cfg.businessUserId;
    if (bid) args.businessUserId = bid;
    const res = await this.callTool('lili_list_suppliers', args);
    return this._extractText(res);
  }

  static async createSupplier({ businessUserId, name, address, city, state, zip, country = 'US', accountNumber, routingNumber, accountType = 'checking' }) {
    const cfg = await this.getConfig();
    const args = {
      name,
      address,
      city,
      state,
      zip,
      country,
      accountNumber,
      routingNumber,
      accountType,
    };
    const bid = businessUserId || cfg.businessUserId;
    if (bid) args.businessUserId = bid;
    const res = await this.callTool('lili_create_supplier', args);
    return this._extractText(res);
  }

  static async createBill({ businessUserId, supplierId, amount, dueDate, memo, invoiceNumber }) {
    const cfg = await this.getConfig();
    const args = {
      supplierId,
      amount: Number(amount).toFixed(2),
      currency: 'USD',
      dueDate: dueDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      memo: memo || '',
    };
    if (invoiceNumber) args.invoiceNumber = invoiceNumber;
    const bid = businessUserId || cfg.businessUserId;
    if (bid) args.businessUserId = bid;
    const res = await this.callTool('lili_create_bill', args);
    return this._extractText(res);
  }

  static async getBillPaymentMethods({ businessUserId, billId }) {
    const cfg = await this.getConfig();
    const args = { billId };
    const bid = businessUserId || cfg.businessUserId;
    if (bid) args.businessUserId = bid;
    const res = await this.callTool('lili_get_bill_payment_methods', args);
    return this._extractText(res);
  }

  static async payBill({ businessUserId, billId, paymentMethodId, paymentDate }) {
    const cfg = await this.getConfig();
    const args = { billId };
    if (paymentMethodId) args.paymentMethodId = paymentMethodId;
    if (paymentDate) args.paymentDate = paymentDate;
    const bid = businessUserId || cfg.businessUserId;
    if (bid) args.businessUserId = bid;
    const res = await this.callTool('lili_pay_bill', args);
    return this._extractText(res);
  }

  static async payToPayee({
    amount,
    recipientName,
    recipientAccount,
    recipientRouting,
    recipientBank,
    recipientEmail,
    businessUserId,
    memo,
    dueDays = 0,
  } = {}) {
    if (!this.isConfigured(await this.getConfig())) {
      return { status: 'manual_pending', reason: 'Lili MCP not configured', requires: ['LILI_MCP_ENABLED', 'LILI_OAUTH_CLIENT_ID', 'LILI_OAUTH_ACCESS_TOKEN or REFRESH_TOKEN'] };
    }

    let tools = [];
    try {
      await this.initialize();
      const toolsRes = await this.listTools();
      const extracted = this._extractText(toolsRes);
      tools = Array.isArray(extracted) ? extracted : [];
    } catch (e) {
      return { status: 'manual_pending', reason: `MCP connection failed: ${e.message}`, requires: ['Valid Lili OAuth token and MCP authorization'] };
    }

    const toolNames = new Set(tools.map(t => t.name));

    let supplierId = null;
    try {
      if (toolNames.has('lili_list_suppliers')) {
        const suppliers = await this.listSuppliers(businessUserId);
        if (Array.isArray(suppliers)) {
          const match = suppliers.find(s => s && (s.name === recipientName || s.accountNumber === recipientAccount || s.routingNumber === recipientRouting));
          if (match && match.id) supplierId = match.id;
        }
      }
      if (!supplierId && toolNames.has('lili_create_supplier')) {
        const created = await this.createSupplier({
          businessUserId,
          name: recipientName,
          accountNumber: recipientAccount,
          routingNumber: recipientRouting,
        });
        supplierId = created && (created.id || created.supplierId);
      }
    } catch (e) {
      return { status: 'manual_pending', reason: `Supplier step failed: ${e.message}`, requires: ['Verify supplier/bill-pay permissions in Lili dashboard'] };
    }

    if (!supplierId) {
      return { status: 'manual_pending', reason: 'Could not create or find supplier via Lili MCP', requires: ['Enable bill-pay and supplier tools in Lili'] };
    }

    let billId = null;
    try {
      if (toolNames.has('lili_create_bill')) {
        const dueDate = new Date(Date.now() + dueDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const bill = await this.createBill({ businessUserId, supplierId, amount, dueDate, memo });
        billId = bill && (bill.id || bill.billId);
      }
    } catch (e) {
      return { status: 'manual_pending', reason: `Bill creation failed: ${e.message}`, supplierId };
    }

    if (toolNames.has('lili_pay_bill') && billId) {
      try {
        const payment = await this.payBill({ businessUserId, billId });
        return { status: 'api_pending', billId, supplierId, payment, externalTxId: payment && (payment.id || payment.paymentId) };
      } catch (e) {
        return { status: 'manual_pending', reason: `Payment submission failed: ${e.message}`, billId, supplierId };
      }
    }

    if (billId) {
      return { status: 'manual_pending', reason: 'Bill created but no lili_pay_bill tool available; complete payment in Lili app', billId, supplierId };
    }

    return { status: 'manual_pending', reason: 'Supplier created/resolved; complete bill creation and payment in Lili app', supplierId };
  }
}

module.exports = { LiliMcpEngine };
