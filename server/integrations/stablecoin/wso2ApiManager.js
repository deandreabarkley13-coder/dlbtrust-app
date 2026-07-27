'use strict';

/**
 * WSO2 API Manager integration.
 *
 * Provides OAuth2 token refresh and a simple reverse proxy for stablecoin APIs.
 * In production this can be expanded to call WSO2 Publisher/Store REST APIs.
 */

const { getConfig } = require('./config');

class Wso2ApiManager {
  constructor() {
    this.cfg = getConfig();
    this.accessToken = null;
    this.expiresAt = 0;
  }

  _tokenUrl() {
    return this.cfg.wso2TokenUrl || `${this.cfg.wso2BaseUrl.replace(/\/$/, '')}/oauth2/token`;
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.expiresAt - 60000) return this.accessToken;
    if (!this.cfg.wso2ClientId || !this.cfg.wso2ClientSecret) {
      throw new Error('WSO2 client credentials not configured');
    }

    const body = new URLSearchParams();
    body.append('grant_type', 'client_credentials');
    if (this.cfg.wso2ApiContext) body.append('scope', `apim:${this.cfg.wso2ApiContext.replace(/^\//, '')}`);

    const res = await fetch(this._tokenUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${this.cfg.wso2ClientId}:${this.cfg.wso2ClientSecret}`).toString('base64')}`,
      },
      body: body.toString(),
    });

    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { json = {}; }
    if (!res.ok) throw new Error(`WSO2 token request failed: ${res.status} ${json.error_description || text}`);

    this.accessToken = json.access_token;
    this.expiresAt = Date.now() + (json.expires_in || 3600) * 1000;
    return this.accessToken;
  }

  async proxy({ method = 'GET', path, body, headers = {} }) {
    if (!this.cfg.wso2BaseUrl) throw new Error('WSO2_BASE_URL not configured');
    const token = await this.getAccessToken();
    const base = this.cfg.wso2BaseUrl.replace(/\/$/, '');
    const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
    const opts = {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    };
    if (body) opts.body = typeof body === 'string' ? body : JSON.stringify(body);

    const res = await fetch(url, opts);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
    return { status: res.status, body: json, headers: Object.fromEntries(res.headers.entries()) };
  }

  readiness() {
    const issues = [];
    if (!this.cfg.wso2BaseUrl) issues.push('WSO2_BASE_URL not configured');
    if (!this.cfg.wso2ClientId) issues.push('WSO2_CLIENT_ID not configured');
    if (!this.cfg.wso2ClientSecret) issues.push('WSO2_CLIENT_SECRET not configured');
    return { ready: issues.length === 0, issues, baseUrl: this.cfg.wso2BaseUrl };
  }
}

module.exports = { Wso2ApiManager };
