'use strict';

/**
 * Google Wallet / NFC payment integration scaffold.
 *
 * Google Wallet supports:
 *  1. Passes (loyalty, offers, gift cards, generic private passes, tickets, etc.)
 *     via the Google Wallet REST API (walletobjects.googleapis.com).
 *  2. NFC tap-to-pay inside Google Wallet for tokenized payment cards issued by
 *     a bank/Token Service Provider (TSP). This requires a partnership with
 *     Google Pay and an issuer network agreement, and is not available through a
 *     simple REST call.
 *
 * This module covers pass generation. For real NFC card payments from a crypto
 * balance you would need a TSP to issue a card-backed token, or use Android
 * Host Card Emulation (HCE) in the companion mobile app.
 */

function str(name, fallback = '') { return (process.env[name] || fallback).trim(); }
function bool(name, fallback = false) { const v = process.env[name]; return v ? String(v).toLowerCase() === 'true' : fallback; }

class GoogleWalletEngine {
  static getConfig() {
    return {
      enabled: bool('GOOGLE_WALLET_ENABLED', true),
      issuerId: str('GOOGLE_WALLET_ISSUER_ID', 'DLB_TRUST_DEMO_ISSUER'),
      serviceAccountEmail: str('GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL', 'demo@dlbtrust.example'),
      serviceAccountKey: str('GOOGLE_WALLET_SERVICE_ACCOUNT_KEY', ''),
      classId: str('GOOGLE_WALLET_CLASS_ID', 'DLB_TRUST_DEMO_CLASS'),
    };
  }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.enabled) issues.push('GOOGLE_WALLET_ENABLED is not true');
    if (!cfg.issuerId) issues.push('GOOGLE_WALLET_ISSUER_ID missing');
    if (!cfg.serviceAccountEmail) issues.push('GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL missing');
    if (!cfg.serviceAccountKey) issues.push('GOOGLE_WALLET_SERVICE_ACCOUNT_KEY missing');
    return { ready: issues.length === 0, rail: 'google_wallet', mode: cfg.sandbox ? 'sandbox' : 'production', issues };
  }

  /**
   * Generates an "Add to Google Wallet" JWT link for a generic private pass
   * representing the user's DLB Trust wallet. In a full integration the backend
   * would sign a JWT with the service account key and call
   * walletobjects.googleapis.com to create the class/object before constructing
   * the link.
   */
  static async createPass({ userId, email, walletAddress, walletName = 'DLB Trust Wallet' } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw new Error('Google Wallet rail is not enabled');
    const objectId = `${cfg.issuerId}.${cfg.classId}.${userId || `${Date.now()}`}`;
    // Demo payload. In production, sign this with the service account key.
    const payload = {
      iss: cfg.serviceAccountEmail,
      aud: 'google',
      iat: Math.floor(Date.now() / 1000),
      typ: 'savetowallet',
      payload: {
        genericObjects: [{
          id: objectId,
          classId: `${cfg.issuerId}.${cfg.classId}`,
          state: 'ACTIVE',
          hexBackgroundColor: '#0f172a',
          logo: { sourceUri: { uri: `${process.env.APP_URL || 'https://p01--dlbtrust-app--gcq8bn6c4zlp.code.run'}/logo.png` } },
          cardTitle: { defaultValue: { language: 'en', value: walletName } },
          subheader: { defaultValue: { language: 'en', value: 'DLB Trust Stablecoin' } },
          header: { defaultValue: { language: 'en', value: walletAddress ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}` : 'Wallet' } },
          textModulesData: [
            { id: 'walletAddress', header: 'Wallet Address', body: walletAddress || 'Not linked' },
            { id: 'email', header: 'Trustee/Beneficiary', body: email || 'Unknown' }
          ],
          barcode: { type: 'QR_CODE', value: walletAddress || `${process.env.APP_URL || 'https://p01--dlbtrust-app--gcq8bn6c4zlp.code.run'}/` },
        }]
      }
    };
    const link = `https://pay.google.com/gp/v/save/${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    return { rail: 'google_wallet', objectId, walletAddress, addToWalletLink: link, note: 'Pass link generated. In production, sign the JWT with the Google Wallet service account and use the real Save to Google Wallet flow.' };
  }
}

module.exports = { GoogleWalletEngine };
