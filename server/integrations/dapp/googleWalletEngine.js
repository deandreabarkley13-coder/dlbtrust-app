'use strict';

/**
 * Google Wallet pass provisioning for trustees and beneficiaries.
 *
 * What this delivers: a Generic pass in the trustee's/beneficiary's Google
 * Wallet that identifies their DLB Trust wallet/distribution account, created
 * through the Google Wallet REST API (walletobjects.googleapis.com) and handed
 * over as a signed "Save to Google Wallet" link. Passes are keyed by the
 * person's email or wallet address so re-provisioning the same person updates
 * their existing pass instead of minting duplicates.
 *
 * What this does NOT deliver — read before wiring money to it: a pass is not a
 * funded payment instrument. Crediting a balance that can be tapped at an NFC
 * terminal requires a card issued by a bank/Token Service Provider (TSP) and
 * tokenised into Google Pay under an issuer agreement; that is out of scope
 * here. Funds for a `google_wallet` destination therefore settle over the
 * configured bank/gateway rail to the beneficiary's linked account, and the
 * pass is provisioned alongside as the beneficiary-facing credential.
 *
 * Gating follows the repo convention: shadow by default (signed link if a key
 * is present, no Google API call); `GOOGLE_WALLET_LIVE=true` creates the
 * class/object on Google before returning the link.
 */

const crypto = require('crypto');
const {
  loadServiceAccount, signJwt, getAccessToken, googleFetch, onGoogleRuntime,
} = require('../google/googleServiceAccount');

const WALLET_API = 'https://walletobjects.googleapis.com/walletobjects/v1';
const WALLET_SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';
const SAVE_URL = 'https://pay.google.com/gp/v/save/';

function str(name, fallback = '') { return (process.env[name] || fallback).trim(); }
function bool(name, fallback = false) { const v = process.env[name]; return v ? String(v).toLowerCase() === 'true' : fallback; }
function appUrl() { return (process.env.APP_URL || 'https://dlbtrust-app-r5oawu76jq-ue.a.run.app').replace(/\/$/, ''); }

class GoogleWalletEngine {
  static getConfig() {
    let serviceAccount = null;
    let credentialError = null;
    try {
      serviceAccount = loadServiceAccount({ keyEnv: 'GOOGLE_WALLET_SERVICE_ACCOUNT_KEY', emailEnv: 'GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL' });
    } catch (e) { credentialError = e.message; }
    return {
      enabled: bool('GOOGLE_WALLET_ENABLED', true),
      live: bool('GOOGLE_WALLET_LIVE', false),
      issuerId: str('GOOGLE_WALLET_ISSUER_ID', 'DLB_TRUST_DEMO_ISSUER'),
      serviceAccountEmail: serviceAccount ? serviceAccount.clientEmail : str('GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL', 'demo@dlbtrust.example'),
      serviceAccount,
      credentialError,
      classId: str('GOOGLE_WALLET_CLASS_ID', 'DLB_TRUST_DEMO_CLASS'),
      origins: str('GOOGLE_WALLET_ORIGINS', appUrl()).split(',').map((s) => s.trim()).filter(Boolean),
    };
  }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.enabled) issues.push('GOOGLE_WALLET_ENABLED is not true');
    if (!cfg.issuerId || cfg.issuerId === 'DLB_TRUST_DEMO_ISSUER') issues.push('GOOGLE_WALLET_ISSUER_ID is not a real Google Wallet issuer id');
    if (cfg.credentialError) issues.push(`GOOGLE_WALLET_SERVICE_ACCOUNT_KEY invalid: ${cfg.credentialError}`);
    if (!cfg.serviceAccount) issues.push('GOOGLE_WALLET_SERVICE_ACCOUNT_KEY missing (JSON key or PEM + GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL)');
    if (!cfg.live) issues.push('GOOGLE_WALLET_LIVE is not true (shadow: link is signed locally, nothing is created on Google)');
    return {
      ready: issues.length === 0,
      rail: 'google_wallet',
      mode: cfg.live ? 'live' : 'shadow',
      live: cfg.live,
      canSign: Boolean(cfg.serviceAccount),
      runtimeIdentity: !cfg.serviceAccount && onGoogleRuntime(),
      issuerId: cfg.issuerId,
      classId: `${cfg.issuerId}.${cfg.classId}`,
      cardFunding: 'not supported: funded NFC card credit requires a bank/Token Service Provider issued card; this rail provisions a pass/link only',
      issues,
    };
  }

  /**
   * Deterministic pass key for a trustee/beneficiary. Google object ids are
   * `<issuerId>.<suffix>` with suffix in [A-Za-z0-9._-]; we hash the identity
   * so emails/addresses never appear in the id.
   */
  static passKey({ email, walletAddress, userId } = {}) {
    const identity = (email || walletAddress || userId || '').toString().trim().toLowerCase();
    if (!identity) throw Object.assign(new Error('email, walletAddress or userId is required to key a Google Wallet pass'), { status: 400 });
    return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32);
  }

  static objectIdFor(identity) {
    const cfg = this.getConfig();
    return `${cfg.issuerId}.${cfg.classId}.${this.passKey(identity)}`;
  }

  static buildClass(cfg) {
    return {
      id: `${cfg.issuerId}.${cfg.classId}`,
      classTemplateInfo: {
        cardTemplateOverride: {
          cardRowTemplateInfos: [{
            twoItems: {
              startItem: { firstValue: { fields: [{ fieldPath: "object.textModulesData['role']" }] } },
              endItem: { firstValue: { fields: [{ fieldPath: "object.textModulesData['walletAddress']" }] } },
            },
          }],
        },
      },
      enableSmartTap: false,
    };
  }

  static buildObject({ objectId, cfg, email, walletAddress, walletName, role, name }) {
    return {
      id: objectId,
      classId: `${cfg.issuerId}.${cfg.classId}`,
      state: 'ACTIVE',
      hexBackgroundColor: '#0f172a',
      logo: { sourceUri: { uri: `${appUrl()}/logo.png` } },
      cardTitle: { defaultValue: { language: 'en', value: walletName } },
      subheader: { defaultValue: { language: 'en', value: 'DLB Trust — Family Trust Company' } },
      header: { defaultValue: { language: 'en', value: name || email || (walletAddress ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}` : 'Wallet') } },
      textModulesData: [
        { id: 'role', header: 'Role', body: role },
        { id: 'walletAddress', header: 'Wallet Address', body: walletAddress || 'Not linked' },
        { id: 'email', header: 'Trustee/Beneficiary', body: email || 'Unknown' },
        { id: 'funding', header: 'Funding', body: 'Distributions settle to your linked account; this pass is identification only.' },
      ],
      barcode: { type: 'QR_CODE', value: walletAddress || `${appUrl()}/` },
    };
  }

  static async _ensureClass(cfg, token) {
    const cls = this.buildClass(cfg);
    const existing = await googleFetch('GET', `${WALLET_API}/genericClass/${encodeURIComponent(cls.id)}`, token);
    if (existing.ok) return { id: cls.id, created: false };
    if (existing.statusCode !== 404) throw new Error(`Google Wallet class lookup failed: HTTP ${existing.statusCode}`);
    const created = await googleFetch('POST', `${WALLET_API}/genericClass`, token, cls);
    if (!created.ok) throw new Error(`Google Wallet class create failed: HTTP ${created.statusCode} ${created.text.slice(0, 200)}`);
    return { id: cls.id, created: true };
  }

  static async _upsertObject(obj, token) {
    const existing = await googleFetch('GET', `${WALLET_API}/genericObject/${encodeURIComponent(obj.id)}`, token);
    if (existing.ok) {
      const updated = await googleFetch('PUT', `${WALLET_API}/genericObject/${encodeURIComponent(obj.id)}`, token, obj);
      if (!updated.ok) throw new Error(`Google Wallet object update failed: HTTP ${updated.statusCode} ${updated.text.slice(0, 200)}`);
      return { created: false, updated: true };
    }
    if (existing.statusCode !== 404) throw new Error(`Google Wallet object lookup failed: HTTP ${existing.statusCode}`);
    const created = await googleFetch('POST', `${WALLET_API}/genericObject`, token, obj);
    if (!created.ok) throw new Error(`Google Wallet object create failed: HTTP ${created.statusCode} ${created.text.slice(0, 200)}`);
    return { created: true, updated: false };
  }

  /**
   * Provision (or refresh) the pass for one trustee/beneficiary and return the
   * Save-to-Google-Wallet link. Live: class/object are created on Google and
   * the JWT references the object by id. Shadow: nothing leaves the process;
   * the JWT embeds the full object and is signed if a key is available.
   */
  static async createPass({ userId, email, walletAddress, walletName = 'DLB Trust Wallet', role = 'beneficiary', name } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw Object.assign(new Error('Google Wallet rail is not enabled'), { status: 503 });
    if (cfg.credentialError) throw Object.assign(new Error(`Google Wallet credentials invalid: ${cfg.credentialError}`), { status: 503 });
    const normalizedRole = String(role || 'beneficiary').toLowerCase() === 'trustee' ? 'trustee' : 'beneficiary';
    const objectId = this.objectIdFor({ email, walletAddress, userId });
    const object = this.buildObject({ objectId, cfg, email, walletAddress, walletName, role: normalizedRole, name });
    const claims = {
      iss: cfg.serviceAccountEmail,
      aud: 'google',
      typ: 'savetowallet',
      origins: cfg.origins,
      payload: {},
    };

    if (cfg.live) {
      if (!cfg.serviceAccount) {
        throw Object.assign(new Error('GOOGLE_WALLET_LIVE=true requires GOOGLE_WALLET_SERVICE_ACCOUNT_KEY: the Save-to-Wallet JWT must be signed by the issuer service account'), { status: 503 });
      }
      const token = await getAccessToken(cfg.serviceAccount, WALLET_SCOPE);
      const cls = await this._ensureClass(cfg, token);
      const obj = await this._upsertObject(object, token);
      claims.payload.genericObjects = [{ id: objectId }];
      const signed = signJwt(claims, cfg.serviceAccount);
      return {
        rail: 'google_wallet',
        mode: 'live',
        live: true,
        objectId,
        classId: cls.id,
        classCreated: cls.created,
        objectCreated: obj.created,
        role: normalizedRole,
        email: email || null,
        walletAddress: walletAddress || null,
        addToWalletLink: `${SAVE_URL}${signed}`,
        signed: true,
        cardFunding: 'not funded: pass/link only (NFC card credit requires a TSP-issued card)',
      };
    }

    claims.payload.genericObjects = [object];
    let link;
    let signed = false;
    if (cfg.serviceAccount) {
      link = `${SAVE_URL}${signJwt(claims, cfg.serviceAccount)}`;
      signed = true;
    } else {
      link = `${SAVE_URL}${Buffer.from(JSON.stringify({ ...claims, iat: Math.floor(Date.now() / 1000) })).toString('base64url')}`;
    }
    return {
      rail: 'google_wallet',
      mode: 'shadow',
      live: false,
      shadow: true,
      objectId,
      classId: `${cfg.issuerId}.${cfg.classId}`,
      role: normalizedRole,
      email: email || null,
      walletAddress: walletAddress || null,
      addToWalletLink: link,
      signed,
      cardFunding: 'not funded: pass/link only (NFC card credit requires a TSP-issued card)',
      note: signed
        ? 'Shadow: JWT signed with the service-account key but the class/object were not created on Google (set GOOGLE_WALLET_LIVE=true).'
        : 'Shadow: unsigned demo link. Set GOOGLE_WALLET_SERVICE_ACCOUNT_KEY and GOOGLE_WALLET_LIVE=true for a real Save-to-Google-Wallet pass.',
    };
  }
}

module.exports = { GoogleWalletEngine };
