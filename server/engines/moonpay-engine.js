/**
 * MoonPay Engine — Fiat ↔ Crypto On-Ramp/Off-Ramp
 * DEANDREA LAVAR BARKLEY TRUST — Real Money Conversion
 *
 * Integrates MoonPay for:
 *   - Buy USDC with USD (on-ramp): Banking balance → MoonPay → USDC in wallet
 *   - Sell USDC for USD (off-ramp): USDC → MoonPay → Banking credit
 *
 * MoonPay Widget flow:
 *   1. Platform generates signed widget URL with pre-filled params
 *   2. User completes KYC + payment on MoonPay widget (or API direct for returning users)
 *   3. MoonPay sends USDC to specified wallet address on Polygon
 *   4. Webhook confirms completion → platform posts GL journals
 *
 * Environment variables:
 *   MOONPAY_API_KEY         - MoonPay publishable API key (for widget)
 *   MOONPAY_SECRET_KEY      - MoonPay secret key (for signing + API calls)
 *   MOONPAY_WEBHOOK_SECRET  - Webhook signature verification
 */

'use strict';

const crypto = require('crypto');

// --- Constants ---------------------------------------------------------------

const MOONPAY_BASE_URL = 'https://api.moonpay.com';
const MOONPAY_WIDGET_URL = 'https://buy.moonpay.com';
const MOONPAY_SELL_WIDGET_URL = 'https://sell.moonpay.com';

const SUPPORTED_CURRENCIES = {
  buy: ['usdc_polygon', 'usdc', 'usdt_polygon'],
  sell: ['usdc_polygon', 'usdc'],
};

const MOONPAY_STATUS_MAP = {
  waitingPayment: 'moonpay_pending',
  pending: 'moonpay_pending',
  waitingAuthorization: 'moonpay_pending',
  completed: 'completed',
  failed: 'failed',
};

// --- MoonPay API Client ------------------------------------------------------

class MoonPayClient {
  constructor(apiKey, secretKey) {
    this.apiKey = apiKey || process.env.MOONPAY_API_KEY || '';
    this.secretKey = secretKey || process.env.MOONPAY_SECRET_KEY || '';
  }

  /**
   * Generate a signed widget URL for buying USDC
   * The signature prevents URL tampering
   */
  generateBuyWidgetUrl({ walletAddress, amount, currencyCode = 'usdc_polygon', baseCurrencyCode = 'usd', email, externalTransactionId, redirectUrl }) {
    const params = new URLSearchParams();
    params.set('apiKey', this.apiKey);
    params.set('currencyCode', currencyCode);
    params.set('baseCurrencyCode', baseCurrencyCode);
    if (walletAddress) params.set('walletAddress', walletAddress);
    if (amount) params.set('baseCurrencyAmount', amount.toString());
    if (email) params.set('email', email);
    if (externalTransactionId) params.set('externalTransactionId', externalTransactionId);
    if (redirectUrl) params.set('redirectURL', redirectUrl);
    params.set('colorCode', '%230066FF');
    params.set('showWalletAddressForm', 'true');

    const queryString = '?' + params.toString();
    const signature = this._signUrl(queryString);
    return `${MOONPAY_WIDGET_URL}${queryString}&signature=${encodeURIComponent(signature)}`;
  }

  /**
   * Generate a signed widget URL for selling USDC (off-ramp)
   */
  generateSellWidgetUrl({ amount, currencyCode = 'usdc_polygon', quoteCurrencyCode = 'usd', refundAddress, externalTransactionId, redirectUrl }) {
    const params = new URLSearchParams();
    params.set('apiKey', this.apiKey);
    params.set('baseCurrencyCode', currencyCode);
    params.set('quoteCurrencyCode', quoteCurrencyCode);
    if (amount) params.set('baseCurrencyAmount', amount.toString());
    if (refundAddress) params.set('refundWalletAddress', refundAddress);
    if (externalTransactionId) params.set('externalTransactionId', externalTransactionId);
    if (redirectUrl) params.set('redirectURL', redirectUrl);

    const queryString = '?' + params.toString();
    const signature = this._signUrl(queryString);
    return `${MOONPAY_SELL_WIDGET_URL}${queryString}&signature=${encodeURIComponent(signature)}`;
  }

  /**
   * API: Get transaction by ID
   */
  async getTransaction(transactionId) {
    return this._request('GET', `/v1/transactions/${transactionId}`);
  }

  /**
   * API: List transactions for the account
   */
  async listTransactions(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this._request('GET', `/v1/transactions${qs ? '?' + qs : ''}`);
  }

  /**
   * API: Get supported currencies
   */
  async getCurrencies() {
    return this._request('GET', '/v1/currencies');
  }

  /**
   * API: Get a buy quote (estimated USDC for given USD amount)
   */
  async getBuyQuote({ baseCurrencyAmount, baseCurrencyCode = 'usd', currencyCode = 'usdc_polygon' }) {
    const params = new URLSearchParams({
      baseCurrencyAmount: baseCurrencyAmount.toString(),
      baseCurrencyCode,
      apiKey: this.apiKey,
    });
    return this._request('GET', `/v1/currencies/${currencyCode}/buy_quote?${params.toString()}`);
  }

  /**
   * API: Get a sell quote (estimated USD for given USDC amount)
   */
  async getSellQuote({ baseCurrencyAmount, quoteCurrencyCode = 'usd', baseCurrencyCode = 'usdc_polygon' }) {
    const params = new URLSearchParams({
      baseCurrencyAmount: baseCurrencyAmount.toString(),
      quoteCurrencyCode,
      apiKey: this.apiKey,
    });
    return this._request('GET', `/v1/currencies/${baseCurrencyCode}/sell_quote?${params.toString()}`);
  }

  /**
   * Verify a webhook signature
   */
  verifyWebhookSignature(payload, signature) {
    const webhookSecret = process.env.MOONPAY_WEBHOOK_SECRET || this.secretKey;
    if (!webhookSecret) return false;
    const computed = crypto
      .createHmac('sha256', webhookSecret)
      .update(payload)
      .digest('base64');
    return computed === signature;
  }

  /**
   * Check if MoonPay is configured (API key present)
   */
  isConfigured() {
    return !!(this.apiKey && this.secretKey);
  }

  // --- Private ---------------------------------------------------------------

  _signUrl(queryString) {
    if (!this.secretKey) return '';
    return crypto
      .createHmac('sha256', this.secretKey)
      .update(queryString)
      .digest('base64');
  }

  async _request(method, pathStr) {
    const url = `${MOONPAY_BASE_URL}${pathStr}`;
    const headers = { 'Content-Type': 'application/json' };
    if (this.secretKey) {
      headers['Authorization'] = `Api-Key ${this.secretKey}`;
    }

    try {
      const resp = await fetch(url, { method, headers });
      if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`MoonPay API ${resp.status}: ${errBody}`);
      }
      return resp.json();
    } catch (err) {
      if (err.message.startsWith('MoonPay API')) throw err;
      throw new Error(`MoonPay request failed: ${err.message}`);
    }
  }
}

// --- Bridge Order Manager ----------------------------------------------------

class BridgeOrderManager {
  constructor(db) {
    this.db = db;
  }

  createOrder({ direction, sourceAccountId, sourceWalletId, destinationWalletId,
                destinationAccountId, fiatAmountCents, destinationAddress,
                requiresApproval, initiatedBy, notes }) {
    const orderNumber = `BRG-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const stmt = this.db.prepare(`
      INSERT INTO bridge_orders
        (order_number, direction, status, source_account_id, source_wallet_id,
         destination_wallet_id, destination_account_id, fiat_amount_cents,
         destination_address, requires_approval, initiated_by, notes)
      VALUES (?, ?, 'initiated', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      orderNumber, direction,
      sourceAccountId || null, sourceWalletId || null,
      destinationWalletId || null, destinationAccountId || null,
      fiatAmountCents, destinationAddress || null,
      requiresApproval ? 1 : 0, initiatedBy || 'user', notes || null
    );
    return this.getOrder(result.lastInsertRowid);
  }

  getOrder(id) {
    return this.db.prepare('SELECT * FROM bridge_orders WHERE id = ?').get(id);
  }

  getOrderByNumber(orderNumber) {
    return this.db.prepare('SELECT * FROM bridge_orders WHERE order_number = ?').get(orderNumber);
  }

  getOrderByMoonPayTxn(moonpayTxnId) {
    return this.db.prepare('SELECT * FROM bridge_orders WHERE moonpay_transaction_id = ?').get(moonpayTxnId);
  }

  updateStatus(id, status, extra = {}) {
    let sql = `UPDATE bridge_orders SET status = ?, updated_at = datetime('now')`;
    const params = [status];
    if (extra.moonpayTransactionId) { sql += ', moonpay_transaction_id = ?'; params.push(extra.moonpayTransactionId); }
    if (extra.moonpayWidgetUrl) { sql += ', moonpay_widget_url = ?'; params.push(extra.moonpayWidgetUrl); }
    if (extra.moonpayStatus) { sql += ', moonpay_status = ?'; params.push(extra.moonpayStatus); }
    if (extra.moonpayCryptoTxHash) { sql += ', moonpay_crypto_tx_hash = ?'; params.push(extra.moonpayCryptoTxHash); }
    if (extra.polygonTxHash) { sql += ', polygon_tx_hash = ?'; params.push(extra.polygonTxHash); }
    if (extra.cryptoAmount) { sql += ', crypto_amount = ?'; params.push(extra.cryptoAmount); }
    if (extra.feeCents) { sql += ', fee_cents = ?'; params.push(extra.feeCents); }
    if (extra.exchangeRate) { sql += ', exchange_rate = ?'; params.push(extra.exchangeRate); }
    if (extra.journalEntryId) { sql += ', journal_entry_id = ?'; params.push(extra.journalEntryId); }
    if (extra.approvedBy) { sql += ", approved_by = ?, approved_at = datetime('now')"; params.push(extra.approvedBy); }
    if (extra.errorMessage) { sql += ', error_message = ?'; params.push(extra.errorMessage); }
    sql += ' WHERE id = ?';
    params.push(id);
    this.db.prepare(sql).run(...params);
    return this.getOrder(id);
  }

  listOrders(filters = {}) {
    let sql = 'SELECT * FROM bridge_orders WHERE 1=1';
    const params = [];
    if (filters.direction) { sql += ' AND direction = ?'; params.push(filters.direction); }
    if (filters.status) { sql += ' AND status = ?'; params.push(filters.status); }
    if (filters.source_account_id) { sql += ' AND source_account_id = ?'; params.push(filters.source_account_id); }
    sql += ' ORDER BY created_at DESC';
    if (filters.limit) { sql += ' LIMIT ?'; params.push(parseInt(filters.limit)); }
    return this.db.prepare(sql).all(...params);
  }

  getStats() {
    const total = this.db.prepare('SELECT COUNT(*) as count FROM bridge_orders').get().count;
    const completed = this.db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(fiat_amount_cents), 0) as volume FROM bridge_orders WHERE status = 'completed'").get();
    const pending = this.db.prepare("SELECT COUNT(*) as count FROM bridge_orders WHERE status IN ('initiated','pending_approval','approved','moonpay_pending','moonpay_processing')").get().count;
    const bankToCrypto = this.db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(fiat_amount_cents), 0) as volume FROM bridge_orders WHERE direction = 'bank_to_crypto' AND status = 'completed'").get();
    const cryptoToBank = this.db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(fiat_amount_cents), 0) as volume FROM bridge_orders WHERE direction = 'crypto_to_bank' AND status = 'completed'").get();
    return {
      total,
      pending,
      completedCount: completed.count,
      completedVolumeCents: completed.volume,
      bankToCrypto: { count: bankToCrypto.count, volumeCents: bankToCrypto.volume },
      cryptoToBank: { count: cryptoToBank.count, volumeCents: cryptoToBank.volume },
    };
  }
}

// --- Webhook Event Logger ----------------------------------------------------

function logWebhookEvent(db, { eventType, transactionId, status, cryptoAmount, fiatAmount, walletAddress, txHash, rawPayload }) {
  db.prepare(`
    INSERT INTO moonpay_webhook_events
      (event_type, transaction_id, status, crypto_amount, fiat_amount, wallet_address, tx_hash, raw_payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventType, transactionId || null, status || null,
    cryptoAmount || null, fiatAmount || null,
    walletAddress || null, txHash || null,
    typeof rawPayload === 'object' ? JSON.stringify(rawPayload) : rawPayload || null
  );
}

// --- Exports -----------------------------------------------------------------

module.exports = {
  MOONPAY_BASE_URL,
  MOONPAY_WIDGET_URL,
  MOONPAY_SELL_WIDGET_URL,
  SUPPORTED_CURRENCIES,
  MOONPAY_STATUS_MAP,
  MoonPayClient,
  BridgeOrderManager,
  logWebhookEvent,
};
