'use strict';

/**
 * Fiat on-ramp providers, for buying USDC without a Circle Mint account.
 *
 * An on-ramp is a hosted checkout: the provider takes the card or bank payment,
 * runs its own KYC, and delivers the tokens on-chain to an address we name. So
 * the parts a program can own are the *session* (amount, asset, network and
 * destination, signed so none of them can be edited in the browser) and the
 * *status lookup* afterwards. The payment itself is a human completing the
 * provider's checkout, and this module does not pretend otherwise.
 *
 * Two providers, and they are not equivalent for Stellar:
 *
 *   moonpay   Sells USD Coin on Stellar as currency code `usdc_xlm`, delivered
 *             to a Stellar address. MoonPay enables Stellar per partner ("on
 *             demand" in their stablecoin matrix), so a key that works for USDC
 *             on Ethereum may still be refused for Stellar — the provider's own
 *             error is surfaced rather than swallowed.
 *   coinbase  Coinbase Onramp's USDC networks are Ethereum, Base, Polygon,
 *             Solana, Optimism and Avalanche; Stellar is not among them, so it
 *             cannot deliver to the trust's distributor. It refuses here rather
 *             than sending real money to a chain the payout rail cannot see.
 *
 * Nothing in this module is evidence of arrival. A provider reporting
 * `completed` is the provider's opinion; the treasury engine still waits for the
 * distributor's own Horizon balance to rise.
 */

const crypto = require('crypto');

const MOONPAY_STELLAR_USDC = 'usdc_xlm';

/** Coinbase Onramp's published USDC delivery networks. Stellar is absent. */
const COINBASE_USDC_NETWORKS = ['ethereum', 'base', 'polygon', 'solana', 'optimism', 'avalanche'];

class OnrampError extends Error {
  constructor(message, code = 'ONRAMP_ERROR', status = 503) {
    super(message);
    this.name = 'OnrampError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function text(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === null ? fallback : String(value).trim();
}

/**
 * MoonPay's hosted buy widget, driven by a signed URL.
 *
 * The signature is an HMAC-SHA256 of the URL's query string keyed by the secret
 * key, base64, appended last. It is what stops a destination address or amount
 * being changed between here and the browser, which is the only reason a URL is
 * acceptable as an instruction to move money at all.
 */
class MoonPayOnramp {
  constructor(cfg = null) {
    const config = cfg || MoonPayOnramp.config();
    this.cfg = config;
  }

  static config() {
    const sandbox = text('MOONPAY_ENV', 'live').toLowerCase() === 'sandbox';
    return {
      publishableKey: text('MOONPAY_PUBLISHABLE_KEY'),
      secretKey: text('MOONPAY_SECRET_KEY'),
      widgetBaseUrl: text('MOONPAY_WIDGET_URL', sandbox ? 'https://buy-sandbox.moonpay.com' : 'https://buy.moonpay.com'),
      apiBaseUrl: text('MOONPAY_API_URL', 'https://api.moonpay.com'),
      currencyCode: text('MOONPAY_USDC_CURRENCY_CODE', MOONPAY_STELLAR_USDC),
      sandbox,
    };
  }

  get name() { return 'moonpay'; }

  readiness() {
    const issues = [];
    if (!this.cfg.publishableKey) issues.push('MOONPAY_PUBLISHABLE_KEY is not set');
    if (!this.cfg.secretKey) {
      issues.push('MOONPAY_SECRET_KEY is not set, and MoonPay refuses an unsigned wallet address');
    }
    if (this.cfg.currencyCode !== MOONPAY_STELLAR_USDC) {
      issues.push(`MOONPAY_USDC_CURRENCY_CODE is ${this.cfg.currencyCode}, which is not USDC on Stellar`
        + ` (${MOONPAY_STELLAR_USDC})`);
    }
    return { provider: 'moonpay', ready: issues.length === 0, issues, sandbox: this.cfg.sandbox };
  }

  _require() {
    const readiness = this.readiness();
    if (!readiness.ready) {
      throw new OnrampError(
        `MoonPay is not configured: ${readiness.issues.join('; ')}`,
        'ONRAMP_NOT_CONFIGURED',
        503
      );
    }
  }

  /**
   * A signed checkout for an exact amount, asset, network and destination.
   * `externalTransactionId` is the purchase id, so the resulting MoonPay
   * transaction can be found again without a human copying a reference.
   */
  checkout({ address, amountCents, externalTransactionId = null, redirectUrl = null } = {}) {
    this._require();
    const destination = String(address || '').trim();
    if (!destination) {
      throw new OnrampError('A destination address is required', 'ONRAMP_NO_DESTINATION', 400);
    }
    const cents = Number(amountCents);
    if (!Number.isInteger(cents) || cents <= 0) {
      throw new OnrampError('amountCents must be a positive whole number of cents', 'ONRAMP_BAD_AMOUNT', 400);
    }

    const params = new URLSearchParams();
    params.set('apiKey', this.cfg.publishableKey);
    params.set('currencyCode', this.cfg.currencyCode);
    params.set('walletAddress', destination);
    // Priced in the token, not in fiat: the desk is short a number of USDC, and
    // the fees are the provider's business.
    params.set('quoteCurrencyAmount', (cents / 100).toFixed(2));
    params.set('baseCurrencyCode', 'usd');
    params.set('lockAmount', 'true');
    if (externalTransactionId) params.set('externalTransactionId', String(externalTransactionId));
    if (redirectUrl) params.set('redirectURL', redirectUrl);

    const query = `?${params.toString()}`;
    const signature = crypto.createHmac('sha256', this.cfg.secretKey).update(query).digest('base64');
    const url = `${this.cfg.widgetBaseUrl}${query}&signature=${encodeURIComponent(signature)}`;

    return {
      provider: 'moonpay',
      url,
      destination,
      asset: this.cfg.currencyCode,
      network: 'stellar',
      amountCents: cents,
      sandbox: this.cfg.sandbox,
      externalTransactionId: externalTransactionId || null,
    };
  }

  async _get(path) {
    this._require();
    const res = await fetch(`${this.cfg.apiBaseUrl}${path}`, {
      headers: { Authorization: `Api-Key ${this.cfg.secretKey}` },
    });
    const body = await res.text();
    let json;
    try { json = JSON.parse(body); } catch (e) { json = { raw: body }; }
    if (!res.ok) {
      throw new OnrampError(
        `MoonPay GET ${path} failed: ${res.status} ${(json && (json.message || json.error)) || body}`,
        'ONRAMP_REQUEST_FAILED',
        res.status >= 500 ? 502 : 400
      );
    }
    return json;
  }

  /** What MoonPay says about the purchases raised for this purchase id. */
  async transactionsFor(externalTransactionId) {
    const id = encodeURIComponent(String(externalTransactionId || '').trim());
    if (!id) {
      throw new OnrampError('An external transaction id is required', 'ONRAMP_NO_REFERENCE', 400);
    }
    const json = await this._get(`/v1/transactions/ext/${id}`);
    return Array.isArray(json) ? json : [json];
  }
}

/**
 * Coinbase Onramp, which cannot do this job. Kept as an explicit refusal: it is
 * the obvious thing to reach for, and reaching for it here would deliver real
 * USDC to an Ethereum address the Stellar payout rail cannot spend.
 */
class CoinbaseOnramp {
  get name() { return 'coinbase'; }

  readiness() {
    return {
      provider: 'coinbase',
      ready: false,
      issues: [
        'Coinbase Onramp delivers USDC on ' + COINBASE_USDC_NETWORKS.join(', ')
        + ' — not Stellar, so it cannot fund a Stellar distributor',
      ],
    };
  }

  checkout() {
    throw new OnrampError(
      'Coinbase Onramp cannot deliver USDC on Stellar; use MoonPay (usdc_xlm) or an exchange withdrawal',
      'ONRAMP_UNSUPPORTED_NETWORK',
      400
    );
  }

  async transactionsFor() {
    throw new OnrampError(
      'Coinbase Onramp is not a supported funding provider for Stellar USDC',
      'ONRAMP_UNSUPPORTED_NETWORK',
      400
    );
  }
}

const PROVIDERS = { moonpay: MoonPayOnramp, coinbase: CoinbaseOnramp };

function onrampProvider(name = null) {
  const key = String(name || text('STABLECOIN_ONRAMP_PROVIDER', 'moonpay')).trim().toLowerCase();
  const Provider = PROVIDERS[key];
  if (!Provider) {
    throw new OnrampError(
      `${key} is not a known on-ramp provider; use one of ${Object.keys(PROVIDERS).join(', ')}`,
      'ONRAMP_UNKNOWN_PROVIDER',
      400
    );
  }
  return new Provider();
}

module.exports = {
  onrampProvider,
  MoonPayOnramp,
  CoinbaseOnramp,
  OnrampError,
  MOONPAY_STELLAR_USDC,
  COINBASE_USDC_NETWORKS,
};
