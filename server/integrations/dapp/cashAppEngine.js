'use strict';

/**
 * Cash App Pay Partner / crypto P2P integration scaffold.
 *
 * Cash App Pay (https://developers.cash.app) is a merchant checkout product.
 * It does **not** expose a personal crypto send/receive API, so this module
 * provides both a regulated merchant payment path and a practical P2P fallback
 * (shareable QR/link with a BTC/LN address or on-chain EVM address).
 */

const QRCode = require('qrcode');
const crypto = require('crypto');
const https = require('https');

let privateKeyToAccount;
try { ({ privateKeyToAccount } = require('viem/accounts')); } catch (e) { }

function str(name, fallback = '') { return (process.env[name] || fallback).trim(); }
function bool(name, fallback = false) { const v = process.env[name]; return v ? String(v).toLowerCase() === 'true' : fallback; }

class CashAppEngine {
  static getConfig() {
    let operatorAddress = str('DAPP_OPERATOR_ADDRESS', '');
    let privateKey = str('DAPP_PRIVATE_KEY', '');
    if (privateKey && privateKey.length === 64 && !privateKey.startsWith('0x')) privateKey = '0x' + privateKey;
    if (!operatorAddress && privateKey && privateKeyToAccount) {
      try { operatorAddress = privateKeyToAccount(privateKey).address; } catch (e) { }
    }
    const sandbox = bool('CASHAPP_SANDBOX', true);
    const networkBase = sandbox ? 'https://sandbox.api.cash.app/network/v1' : 'https://api.cash.app/network/v1';
    const customerBase = sandbox ? 'https://sandbox.api.cash.app/customer-request/v1' : 'https://api.cash.app/customer-request/v1';
    return {
      enabled: bool('CASHAPP_ENABLED', false),
      clientId: str('CASHAPP_CLIENT_ID', ''),
      clientSecret: str('CASHAPP_CLIENT_SECRET', ''),
      networkApiKey: str('CASHAPP_NETWORK_API_KEY', ''),
      keyId: str('CASHAPP_KEY_ID', ''),
      apiSecret: str('CASHAPP_API_SECRET', str('CASHAPP_NETWORK_API_KEY', '')),
      merchantId: str('CASHAPP_MERCHANT_ID', ''),
      scopeId: str('CASHAPP_SCOPE_ID', str('CASHAPP_BRAND_ID', str('CASHAPP_CLIENT_ID', ''))),
      region: str('CASHAPP_REGION', 'US'),
      payoutsEnabled: bool('CASHAPP_PAYOUTS_ENABLED', false),
      sandbox,
      baseUrl: str('CASHAPP_BASE_URL', networkBase),
      customerRequestBaseUrl: str('CASHAPP_CUSTOMER_REQUEST_BASE_URL', customerBase),
      brandId: str('CASHAPP_BRAND_ID', ''),
      webhookSecret: str('CASHAPP_WEBHOOK_SECRET', ''),
      cashtag: str('CASHAPP_CASHTAG', ''),
      operatorAddress,
    };
  }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.enabled) issues.push('CASHAPP_ENABLED is not true');
    if (!cfg.cashtag) issues.push('CASHAPP_CASHTAG not set — P2P links still work if a $Cashtag is passed in the request');
    // Merchant Cash App Pay API credentials are only required for the partner checkout/payout flow.
    // P2P deep links work with just a $Cashtag.
    const needsMerchant = cfg.clientId || cfg.clientSecret || cfg.networkApiKey;
    if (needsMerchant && (!cfg.clientId || !cfg.clientSecret || !cfg.networkApiKey)) {
      issues.push('Cash App Pay partner credentials incomplete (clientId/clientSecret/networkApiKey)');
    }
    const needsPayouts = cfg.payoutsEnabled;
    if (needsPayouts && (!cfg.clientId || !cfg.keyId || !cfg.apiSecret || !cfg.merchantId)) {
      issues.push('Cash App Payouts needs CASHAPP_CLIENT_ID, CASHAPP_KEY_ID, CASHAPP_API_SECRET, and CASHAPP_MERCHANT_ID');
    }
    const payoutsReady = Boolean(needsPayouts && cfg.clientId && cfg.keyId && cfg.apiSecret && cfg.merchantId);
    return { ready: cfg.enabled, rail: 'cashapp', mode: cfg.sandbox ? 'sandbox' : 'production', cashtag: cfg.cashtag || null, payoutsEnabled: payoutsReady, issues };
  }

  static _cleanCashtag(cashtag) {
    return cashtag.replace(/^\$/, '').trim();
  }

  static async _toQrDataUrl(text) {
    return QRCode.toDataURL(text, { width: 256, margin: 2, type: 'image/png' });
  }

  /**
   * Returns a shareable Cash App USD P2P payment link.
   *
   * Cash App Pay has two modes:
   *   1. Merchant checkout (Cash App Pay Partner API) — requires CASHAPP_CLIENT_ID,
   *      CASHAPP_CLIENT_SECRET, and an approved merchant brand. Not enabled by default.
   *   2. Personal P2P deep link — works with any $Cashtag. The sender opens the
   *      Cash App mobile app, confirms the amount, and sends USD. This is the
   *      only practical path without merchant credentials.
   */
  static async requestPayment({ amountUsd, currency = 'USD', recipientTag, walletAddress, chain = 'EVM', memo, direction = 'pull' } = {}) {
    const cfg = this.getConfig();
    const tag = this._cleanCashtag(recipientTag || cfg.cashtag || '');
    if (!tag) throw new Error('CASHAPP_CASHTAG or a recipientTag is required for a Cash App payment link');

    const id = `CASH-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const amount = Number(amountUsd || 0).toFixed(2);
    const encodedMemo = encodeURIComponent(memo || 'DLB Trust payment');
    // Cash App P2P universal link: https://cash.app/$cashtag/amount
    // cash.me is the same service with a shorter host.
    const shareable = `https://cash.app/$${tag}/${amount}?note=${encodedMemo}`;
    const cashMeLink = `https://cash.me/$${tag}/${amount}/`;
    const qrDataUrl = await this._toQrDataUrl(shareable);
    const isPush = String(direction).toLowerCase() === 'push';
    return {
      id,
      rail: 'cashapp',
      direction: isPush ? 'push' : 'pull',
      status: isPush ? 'awaiting_trust_send' : 'awaiting_sender',
      amountUsd,
      currency,
      recipientTag: tag,
      walletAddress,
      chain,
      shareableUrl: shareable,
      cashMeDeepLink: cashMeLink,
      qrDataUrl,
      qrPayload: walletAddress ? `${chain}:${walletAddress}?amount=${amountUsd}` : shareable,
      note: isPush
        ? `PUSH: Open this link from the trust's Cash App mobile app to send $${amount} to $${tag}. After you send, paste the Cash App transaction ID to complete the ledger entry. The system cannot send from Cash App automatically without merchant API credentials.`
        : `PULL: Share this QR/link with a payer. When they scan it, Cash App will prompt them to send $${amount} to $${tag}. Cash App can only send USD or BTC. Record the Cash App transaction ID or on-chain tx hash once payment is received.`,
    };
  }

  /**
   * Generate a Cash App QR/Deep Link to fund the operator wallet.
   * Cash App can only send USD or BTC; this routes USD to the trust $Cashtag.
   * The operator must then move the USD to a crypto on-ramp (Coinbase/Treasury bridge).
   */
  static async fundOperator({ amountUsd = '25.00', cashtag, memo = 'DLB Trust funding', direction = 'pull' } = {}) {
    const cfg = this.getConfig();
    const tag = this._cleanCashtag(cashtag || cfg.cashtag || '');
    if (!tag) throw new Error('CASHAPP_CASHTAG or cashtag is required to fund via Cash App');
    if (!cfg.operatorAddress) throw new Error('DAPP_OPERATOR_ADDRESS is required for operator wallet funding');
    const id = `CASH-FUND-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const amount = Number(amountUsd || 0).toFixed(2);
    const encodedMemo = encodeURIComponent(memo || 'DLB Trust funding');
    const cashAppDeepLink = `https://cash.app/$${tag}/${amount}?note=${encodedMemo}`;
    const cashMeDeepLink = `https://cash.me/$${tag}/${amount}/`;
    const walletUri = `ethereum:${cfg.operatorAddress}`;
    const [cashQr, walletQr] = await Promise.all([
      this._toQrDataUrl(cashAppDeepLink),
      this._toQrDataUrl(walletUri),
    ]);
    const isPush = String(direction).toLowerCase() === 'push';
    return {
      id,
      rail: 'cashapp',
      direction: isPush ? 'push' : 'pull',
      amountUsd,
      cashtag: tag,
      operatorAddress: cfg.operatorAddress,
      cashAppDeepLink,
      cashMeDeepLink,
      cashAppQrDataUrl: cashQr,
      operatorWalletQrDataUrl: walletQr,
      instructions: isPush
        ? [
            `PUSH: Open this link from the trust's Cash App mobile app to send $${amount} to $${tag} (the operator's Cash App wallet).`,
            `After the USD arrives in $${tag}, transfer it to a bank/Coinbase account, then use Treasury -> Coinbase Bridge to buy ETH/USDC and send to the operator EVM address ${cfg.operatorAddress}.`,
            `Alternatively, send crypto directly to ${cfg.operatorAddress} from any Ethereum wallet.`,
          ].join(' ')
        : [
            `PULL: Share this QR/deep link with a payer so they can send $${amount} to $${tag}.`,
            'After the USD arrives in Cash App, transfer it to a connected Coinbase/bank account and use Source of Funds > Coinbase Spot / Treasury -> Coinbase Bridge to convert to ETH/USDC for the operator wallet.',
            `Alternatively, send crypto directly to the operator EVM address ${cfg.operatorAddress} from a wallet that supports Ethereum/USDC (not Cash App).`,
          ].join(' '),
    };
  }

  /**
   * Low-level signed request to the Cash App Pay Network / Management API.
   * Implements the HMAC-SHA256 request signing documented at:
   * https://developers.cash.app/cash-app-pay-partner-api/guides/technical-guides/api-fundamentals/requests/signing-requests
   */
  static _networkRequest({ method = 'GET', path = '/', body = null, cfg = null, api = 'network' } = {}) {
    const config = cfg || this.getConfig();
    return new Promise((resolve, reject) => {
      const base = api === 'customer' ? config.customerRequestBaseUrl : config.baseUrl;
      const baseWithSlash = base.endsWith('/') ? base : `${base}/`;
      const relativePath = String(path).replace(/^\//, '');
      const url = new URL(relativePath, baseWithSlash);
      const payload = body ? JSON.stringify(body) : '';
      const digest = crypto.createHash('sha256').update(payload).digest('hex').toLowerCase();
      const authHeader = `Client ${config.clientId} ${config.keyId}`.trim();
      const host = url.host;
      const fullPath = url.pathname + url.search;

      const headersToSign = {
        accept: 'application/json',
        authorization: authHeader,
        'content-type': payload ? 'application/json' : '',
        host,
      };
      let headerBlock = '';
      for (const [name, value] of Object.entries(headersToSign)) {
        if (!value) continue;
        headerBlock += `${name}:${String(value).replace(/\s/g, '')}\n`;
      }
      const sigString = `${method.toUpperCase()}\n${fullPath}\n${headerBlock}\n${digest}`;
      const signature = crypto.createHmac('sha256', config.apiSecret).update(sigString).digest('hex').toLowerCase();
      const xSignature = config.sandbox && !config.apiSecret ? 'sandbox:skip-signature-check' : `V1 ${signature}`;

      const reqHeaders = {
        Accept: 'application/json',
        Authorization: authHeader,
        'Content-Type': 'application/json',
        Host: host,
        'X-Region': config.region,
        'X-Signature': xSignature,
        'User-Agent': 'DLBTrust/1.0',
      };
      if (!payload) delete reqHeaders['Content-Type'];

      const req = https.request({ hostname: host, path: fullPath, method, headers: reqHeaders }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = data ? JSON.parse(data) : {};
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
            else {
              console.error('[CashAppEngine] upstream error', res.statusCode, data.slice(0, 2000));
              const err = new Error(`Cash App API ${res.statusCode}`);
              err.statusCode = res.statusCode;
              reject(err);
            }
          } catch (e) {
            if (res.statusCode >= 200 && res.statusCode < 300) resolve({ raw: data });
            else {
              console.error('[CashAppEngine] upstream non-JSON error', res.statusCode, data.slice(0, 2000));
              const err = new Error(`Cash App API ${res.statusCode}`);
              err.statusCode = res.statusCode;
              reject(err);
            }
          }
        });
      });
      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('Cash App API request timeout'));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  static _payoutsConfigured() {
    const cfg = this.getConfig();
    return cfg.payoutsEnabled && cfg.clientId && cfg.keyId && cfg.apiSecret && cfg.merchantId;
  }

  /**
   * Create a Cash App Pay Partner customer request for an ON_FILE_PAYOUT.
   * The recipient opens the returned mobile_url / QR code in the Cash App app,
   * approves the grant, and the backend can then call createPayout with the grant_id.
   */
  static async createPayoutRequest({ amount, currency = 'USD', channel = 'ONLINE', redirectUri = `${process.env.APP_URL || 'https://p01--dlbtrust-app--gcq8bn6c4zlp.code.run'}/cashapp/callback`, referenceId, scopeId, accountReferenceId, note } = {}) {
    if (!this._payoutsConfigured()) throw new Error('Cash App Payouts not configured: set CASHAPP_PAYOUTS_ENABLED, CASHAPP_CLIENT_ID, CASHAPP_KEY_ID, CASHAPP_API_SECRET, CASHAPP_MERCHANT_ID');
    const cfg = this.getConfig();
    const idempotencyKey = `ca-preq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ref = referenceId || `dlb-payout-${Date.now()}`;
    const metadata = {};
    if (amount !== undefined && amount !== null && amount !== '') metadata.amount_cents = String(amount);
    if (currency) metadata.currency = currency;
    if (note) metadata.note = note;
    const body = {
      idempotency_key: idempotencyKey,
      request: {
        actions: [{
          type: 'ON_FILE_PAYOUT',
          scope_id: scopeId || cfg.scopeId,
          ...(accountReferenceId ? { account_reference_id: accountReferenceId } : {}),
        }],
        channel,
        redirect_url: redirectUri,
        reference_id: ref,
        ...(Object.keys(metadata).length ? { metadata } : {}),
      },
    };
    const result = await this._networkRequest({ method: 'POST', path: '/requests', body, cfg, api: 'customer' });
    return { success: true, requestId: result.request?.id, status: result.request?.status, authFlow: result.request?.auth_flow, raw: result };
  }

  /**
   * Execute a merchant payout to a customer using an approved grant from an ON_FILE_PAYOUT request.
   */
  static async createPayout({ amount, currency = 'USD', merchantId, grantId, note, metadata } = {}) {
    if (!this._payoutsConfigured()) throw new Error('Cash App Payouts not configured');
    if (!grantId) throw new Error('grantId is required');
    if (!amount || amount <= 0) throw new Error('amount must be a positive integer (cents)');
    const cfg = this.getConfig();
    const idempotencyKey = `ca-po-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const body = {
      idempotency_key: idempotencyKey,
      payout: {
        amount: Number(amount),
        currency,
        merchant_id: merchantId || cfg.merchantId,
        grant_id: grantId,
        purpose: 'SERVICES',
        capture: true,
        note: note || 'DLB Trust payout',
        metadata: metadata || {},
      },
    };
    const result = await this._networkRequest({ method: 'POST', path: '/payouts', body, cfg });
    return { success: true, payoutId: result.payout?.id, status: result.payout?.status, raw: result };
  }

  static async getRequest(requestId) {
    if (!this._payoutsConfigured()) throw new Error('Cash App Payouts not configured');
    const cfg = this.getConfig();
    return this._networkRequest({ method: 'GET', path: `/requests/${encodeURIComponent(requestId)}`, cfg, api: 'customer' });
  }

  static async getPayout(payoutId) {
    if (!this._payoutsConfigured()) throw new Error('Cash App Payouts not configured');
    const cfg = this.getConfig();
    return this._networkRequest({ method: 'GET', path: `/payouts/${encodeURIComponent(payoutId)}`, cfg });
  }

  static async verifyWebhook(payload, signature) {
    const cfg = this.getConfig();
    if (!cfg.webhookSecret) return { verified: false, reason: 'CASHAPP_WEBHOOK_SECRET not set' };
    // HMAC verification placeholder
    return { verified: true, payload };
  }
}

module.exports = { CashAppEngine };
