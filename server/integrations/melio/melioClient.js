'use strict';

/**
 * Generic Melio B2B Payments API client.
 *
 * Melio exposes a partner/enterprise REST API for vendors, bills, payment
 * methods, and scheduled payments. The exact endpoint shapes are not
 * consistently published, so this client uses the conventional /v1 prefix and
 * documented resource names (company, vendors, bills, payments) and is
 * designed to be tuned once real API keys/credentials are available.
 *
 * In shadow mode (no MELIO_API_KEY or MELIO_SHADOW=true) all methods return
 * realistic mock responses so the OS engine and UI can be wired end-to-end.
 */

const DEFAULT_BASE_URL = 'https://api.meliopayments.com';

class MelioClient {
  constructor({ apiKey = '', baseUrl = DEFAULT_BASE_URL, shadow = false } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.shadow = shadow || !this.apiKey;
  }

  _headers() {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async _request(method, path, body) {
    const url = `${this.baseUrl}${path}`;
    const opts = { method, headers: this._headers() };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : {}; } catch { /* ignore */ }
    if (!res.ok) {
      const msg = json && (json.message || json.error) ? JSON.stringify(json) : text;
      throw new Error(`Melio API ${method} ${path} failed: ${res.status} ${msg}`);
    }
    return json || {};
  }

  async getCompany() {
    if (this.shadow) {
      return { id: 'melio-company-shadow', name: 'DLB Trust (shadow)', status: 'active' };
    }
    return this._request('GET', '/v1/company/me');
  }

  async listVendors() {
    if (this.shadow) {
      return { data: [{ id: 'melio-vendor-shadow', name: 'Shadow Vendor', status: 'active' }] };
    }
    return this._request('GET', '/v1/vendors');
  }

  async createVendor(vendor) {
    if (this.shadow) {
      const id = `melio-vendor-${Date.now()}`;
      return { id, ...vendor, status: 'active', created_at: new Date().toISOString() };
    }
    return this._request('POST', '/v1/vendors', vendor);
  }

  async createBill(bill) {
    if (this.shadow) {
      const id = `melio-bill-${Date.now()}`;
      return { id, ...bill, status: 'open', created_at: new Date().toISOString() };
    }
    return this._request('POST', '/v1/bills', bill);
  }

  async schedulePayment(payment) {
    if (this.shadow) {
      const id = `melio-payment-${Date.now()}`;
      return {
        id,
        ...payment,
        status: 'scheduled',
        estimated_arrival: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
        instructions: 'Shadow Melio payment. In live mode this will be submitted to Melio.',
        created_at: new Date().toISOString(),
      };
    }
    return this._request('POST', '/v1/payments', payment);
  }

  async getPayment(paymentId) {
    if (this.shadow) {
      return {
        id: paymentId,
        status: 'scheduled',
        estimated_arrival: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      };
    }
    return this._request('GET', `/v1/payments/${paymentId}`);
  }

  async listPayments({ limit = 50 } = {}) {
    if (this.shadow) {
      return { data: [], has_more: false };
    }
    return this._request('GET', `/v1/payments?limit=${limit}`);
  }
}

function getClient() {
  const apiKey = process.env.MELIO_API_KEY || '';
  const baseUrl = process.env.MELIO_BASE_URL || DEFAULT_BASE_URL;
  const shadow = !apiKey || (process.env.MELIO_SHADOW || '').toLowerCase() === 'true';
  return new MelioClient({ apiKey, baseUrl, shadow });
}

module.exports = { MelioClient, getClient };
