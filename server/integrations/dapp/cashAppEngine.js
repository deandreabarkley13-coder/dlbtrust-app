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
    return {
      enabled: bool('CASHAPP_ENABLED', false),
      clientId: str('CASHAPP_CLIENT_ID', ''),
      clientSecret: str('CASHAPP_CLIENT_SECRET', ''),
      networkApiKey: str('CASHAPP_NETWORK_API_KEY', ''),
      sandbox: bool('CASHAPP_SANDBOX', true),
      baseUrl: str('CASHAPP_BASE_URL', 'https://api.cash.app/network/v1'),
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
    if (!cfg.clientId) issues.push('CASHAPP_CLIENT_ID missing');
    if (!cfg.clientSecret) issues.push('CASHAPP_CLIENT_SECRET missing');
    if (!cfg.networkApiKey) issues.push('CASHAPP_NETWORK_API_KEY missing');
    return { ready: issues.length === 0, rail: 'cashapp', mode: cfg.sandbox ? 'sandbox' : 'production', issues };
  }

  static _cleanCashtag(cashtag) {
    return cashtag.replace(/^\$/, '').trim();
  }

  static async _toQrDataUrl(text) {
    return QRCode.toDataURL(text, { width: 256, margin: 2, type: 'image/png' });
  }

  /**
   * Returns a shareable Cash App crypto payment instruction.
   * In shadow/sandbox mode this does not call the Cash App network.
   */
  static async requestPayment({ amountUsd, currency = 'USD', recipientTag, walletAddress, chain = 'EVM', memo } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw new Error('Cash App rail is not enabled');
    const id = `CASH-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const tag = this._cleanCashtag(recipientTag || cfg.cashtag || '');
    const note = encodeURIComponent(memo || 'DLB Trust payment');
    const shareable = tag ? `https://cash.app/$${tag}/${amountUsd || '1.00'}?note=${note}` : `https://cash.app/payments?note=${note}`;
    const qrDataUrl = await this._toQrDataUrl(shareable);
    return {
      id,
      rail: 'cashapp',
      status: cfg.sandbox ? 'pending_merchant_approval' : 'pending',
      amountUsd,
      currency,
      walletAddress,
      chain,
      shareableUrl: shareable,
      qrDataUrl,
      qrPayload: walletAddress ? `${chain}:${walletAddress}?amount=${amountUsd}` : shareable,
      note: 'Cash App does not expose a personal crypto P2P API. Share this QR/link with the recipient; once they send crypto from Cash App, record the deposit in the dApp with the on-chain tx hash.',
    };
  }

  /**
   * Generate a Cash App QR/Deep Link to fund the operator wallet.
   * Cash App can only send USD or BTC; this routes USD to the trust $Cashtag.
   * The operator must then move the USD to a crypto on-ramp (Coinbase/Treasury bridge).
   */
  static async fundOperator({ amountUsd = '25.00', cashtag, memo = 'DLB Trust funding' } = {}) {
    const cfg = this.getConfig();
    const tag = this._cleanCashtag(cashtag || cfg.cashtag || '');
    if (!tag) throw new Error('CASHAPP_CASHTAG or cashtag is required to fund via Cash App');
    if (!cfg.operatorAddress) throw new Error('DAPP_OPERATOR_ADDRESS is required for operator wallet funding');
    const id = `CASH-FUND-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const note = encodeURIComponent(memo || 'DLB Trust funding');
    const cashAppDeepLink = `https://cash.app/$${tag}/${amountUsd}?note=${note}`;
    const cashMeDeepLink = `https://cash.me/$${tag}/${amountUsd}/`;
    const walletUri = `ethereum:${cfg.operatorAddress}`;
    const [cashQr, walletQr] = await Promise.all([
      this._toQrDataUrl(cashAppDeepLink),
      this._toQrDataUrl(walletUri),
    ]);
    return {
      id,
      rail: 'cashapp',
      amountUsd,
      cashtag: tag,
      operatorAddress: cfg.operatorAddress,
      cashAppDeepLink,
      cashMeDeepLink,
      cashAppQrDataUrl: cashQr,
      operatorWalletQrDataUrl: walletQr,
      instructions: [
        `1. Scan the Cash App QR or tap the deep link to send $${amountUsd} to $${tag}.`,
        '2. Cash App holds USD. To convert it to ETH/USDC for the operator wallet, transfer the USD to the connected Coinbase/bank account and use Source of Funds > Fund Safe via Coinbase Spot / Treasury -> Coinbase Bridge.',
        `3. Alternatively, send crypto directly to the operator EVM address ${cfg.operatorAddress} from a wallet that supports Ethereum/USDC (not Cash App).`,
      ].join(' '),
    };
  }

  static async verifyWebhook(payload, signature) {
    const cfg = this.getConfig();
    if (!cfg.webhookSecret) return { verified: false, reason: 'CASHAPP_WEBHOOK_SECRET not set' };
    // HMAC verification placeholder
    return { verified: true, payload };
  }
}

module.exports = { CashAppEngine };
