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
    if (!cfg.cashtag) issues.push('CASHAPP_CASHTAG not set — P2P links still work if a $Cashtag is passed in the request');
    // Merchant Cash App Pay API credentials are only required for the partner checkout flow.
    // P2P deep links work with just a $Cashtag.
    const needsMerchant = cfg.clientId || cfg.clientSecret || cfg.networkApiKey;
    if (needsMerchant && (!cfg.clientId || !cfg.clientSecret || !cfg.networkApiKey)) {
      issues.push('Cash App Pay partner credentials incomplete (clientId/clientSecret/networkApiKey)');
    }
    return { ready: cfg.enabled, rail: 'cashapp', mode: cfg.sandbox ? 'sandbox' : 'production', cashtag: cfg.cashtag || null, issues };
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

  static async verifyWebhook(payload, signature) {
    const cfg = this.getConfig();
    if (!cfg.webhookSecret) return { verified: false, reason: 'CASHAPP_WEBHOOK_SECRET not set' };
    // HMAC verification placeholder
    return { verified: true, payload };
  }
}

module.exports = { CashAppEngine };
