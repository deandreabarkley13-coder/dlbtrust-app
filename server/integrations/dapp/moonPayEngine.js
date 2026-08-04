'use strict';

/**
 * MoonPay On-Ramp Engine
 *
 * Builds signed/widget on-ramp URLs so users can buy ETH (or any currency)
 * directly into the operator hot wallet. Also handles MoonPay webhooks to
 * record on-chain deposits in the dApp ledger.
 */

const crypto = require('crypto');

function str(name, fallback = '') { return (process.env[name] || fallback).trim(); }
function bool(name, fallback = false) { const v = process.env[name]; return v ? String(v).toLowerCase() === 'true' : fallback; }

function getConfig() {
  const operatorAddress = str('DAPP_OPERATOR_ADDRESS', str('MOONPAY_DEFAULT_WALLET', ''));
  return {
    enabled: bool('MOONPAY_ENABLED', true),
    apiKey: str('MOONPAY_API_KEY', ''),
    apiSecret: str('MOONPAY_API_SECRET', ''),
    widgetBase: str('MOONPAY_WIDGET_BASE', 'https://buy.moonpay.com'),
    webhookBase: str('MOONPAY_WEBHOOK_BASE', 'https://dlbtrust-app.fly.dev/api/dapp/moonpay/webhook'),
    operatorAddress,
    defaultCurrency: str('MOONPAY_DEFAULT_CURRENCY', 'eth'),
    defaultFiat: str('MOONPAY_DEFAULT_FIAT', 'usd'),
  };
}

class MoonPayEngine {
  static getConfig() { return getConfig(); }

  static readiness() {
    const cfg = getConfig();
    const issues = [];
    if (!cfg.enabled) issues.push('MOONPAY_ENABLED is not true');
    if (!cfg.apiKey) issues.push('MOONPAY_API_KEY not configured');
    if (!cfg.operatorAddress) issues.push('DAPP_OPERATOR_ADDRESS / MOONPAY_DEFAULT_WALLET not configured');
    return { ready: issues.length === 0, mode: cfg.apiKey ? 'live' : 'disabled', issues, apiKeyHint: cfg.apiKey ? `${cfg.apiKey.slice(0, 6)}...` : '' };
  }

  /**
   * Build a MoonPay on-ramp URL. If MOONPAY_API_SECRET is set the URL is
   * signed so parameters cannot be tampered with.
   */
  static buildUrl({ currencyCode, walletAddress, amount, fiatCurrency, lockWalletAddress = true } = {}) {
    const cfg = getConfig();
    if (!cfg.enabled) throw new Error('MoonPay is not enabled');
    if (!cfg.apiKey) throw new Error('MOONPAY_API_KEY not configured');

    const targetWallet = walletAddress || cfg.operatorAddress;
    if (!targetWallet) throw new Error('walletAddress or DAPP_OPERATOR_ADDRESS required');

    const params = new URLSearchParams();
    params.set('apiKey', cfg.apiKey);
    params.set('currencyCode', (currencyCode || cfg.defaultCurrency).toLowerCase());
    params.set('walletAddress', targetWallet);
    if (fiatCurrency || cfg.defaultFiat) params.set('baseCurrencyCode', (fiatCurrency || cfg.defaultFiat).toLowerCase());
    if (amount && Number(amount) > 0) params.set('quoteCurrencyAmount', String(amount));
    if (lockWalletAddress) params.set('showWalletAddressForm', 'false');

    let query = params.toString();
    if (cfg.apiSecret) {
      const signature = crypto.createHmac('sha256', cfg.apiSecret).update(`?${query}`).digest('base64');
      query += `&signature=${encodeURIComponent(signature)}`;
    }

    return `${cfg.widgetBase}?${query}`;
  }

  static async webhook(body, signatureHeader, rawBody) {
    const cfg = getConfig();
    if (cfg.apiSecret) {
      if (!signatureHeader) throw new Error('MoonPay webhook signature missing');
      const expected = crypto.createHmac('sha256', cfg.apiSecret).update(rawBody || JSON.stringify(body)).digest('hex');
      const expectedBuf = Buffer.from(expected, 'hex');
      const actualBuf = Buffer.from(signatureHeader, 'hex');
      if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
        throw new Error('MoonPay webhook signature mismatch');
      }
    }

    if (!body || !body.type) return { received: true, action: 'ignored' };

    const event = body.type;
    const data = body.data || {};
    const record = {
      provider: 'moonpay',
      event,
      externalId: data.id || data.transactionId || '',
      status: data.status || '',
      currency: data.currency?.code || data.cryptoCurrencyId || '',
      fiatCurrency: data.baseCurrency?.code || data.baseCurrencyId || '',
      amountCrypto: data.amount || data.quoteCurrencyAmount || 0,
      amountFiat: data.totalAmount || data.baseCurrencyAmount || 0,
      walletAddress: data.walletAddress || '',
      transactionId: data.transactionId || data.cryptoTransactionId || '',
      raw: body,
      recordedAt: new Date().toISOString(),
    };

    // Future: credit a Treasury/MoonPay holding account and top-up operator gas.
    return { received: true, event, record };
  }
}

module.exports = { MoonPayEngine };
