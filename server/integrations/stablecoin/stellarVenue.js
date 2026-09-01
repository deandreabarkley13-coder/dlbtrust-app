'use strict';

/**
 * Buying XLM with dollars at a trading venue, and withdrawing it to a Stellar
 * address the trust controls.
 *
 * This is the one leg of the treasury the rest of the system cannot perform.
 * Everything downstream — trustline, USDC purchase, payouts — moves value the
 * trust already holds; nothing in a ledger converts dollars into XLM. Only a
 * venue that takes fiat can, so this wraps one and reports honestly when no
 * venue is reachable, instead of pretending an internal balance is spendable
 * on-chain.
 *
 * Coinbase is the adapter here because the repo already depends on
 * `coinbase-api` and uses it for the EVM funding path. That path buys ETH/BTC
 * and sends to an Ethereum address; XLM to a Stellar address is a different
 * product and a different network, and — critically — a Stellar destination
 * that does not exist yet cannot be paid by every venue, so a withdrawal is
 * only believed once Horizon shows it.
 */

const { getConfig } = require('./config');

let coinbaseApi;
try { coinbaseApi = require('coinbase-api'); } catch (e) { coinbaseApi = null; }

/** The venue product that converts dollars into the native asset. */
const XLM_USD = 'XLM-USD';
/** Coinbase's name for the Stellar network on a withdrawal. */
const STELLAR_NETWORK = 'stellar';

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function venueConfig() {
  const cfg = getConfig();
  return {
    keyName: (process.env.COINBASE_CDP_KEY_NAME || '').trim(),
    privateKey: (process.env.COINBASE_CDP_PRIVATE_KEY || '').trim(),
    distributor: cfg.distributorPublic,
  };
}

/**
 * Which venues can actually be reached, and what each is missing. A caller
 * shows this rather than a generic "not configured": the missing item is
 * always an account or a key, and naming it is the whole value.
 */
function venues() {
  const cfg = venueConfig();
  const configured = !!(cfg.keyName && cfg.privateKey);
  return [{
    id: 'coinbase',
    name: 'Coinbase Advanced Trade',
    buys: ['XLM', 'USDC'],
    configured,
    installed: !!coinbaseApi,
    missing: [
      !coinbaseApi ? 'the coinbase-api dependency' : null,
      !cfg.keyName ? 'COINBASE_CDP_KEY_NAME' : null,
      !cfg.privateKey ? 'COINBASE_CDP_PRIVATE_KEY' : null,
    ].filter(Boolean),
    note: 'Needs a Coinbase account holding USD (an ACH deposit from the trust'
      + ' bank account, or an existing fiat balance). API keys alone cannot buy.',
  }];
}

class StellarVenue {
  /** Whether a venue is configured well enough to be attempted at all. */
  static enabled() {
    const cfg = venueConfig();
    return !!(coinbaseApi && cfg.keyName && cfg.privateKey);
  }

  static _requireVenue() {
    if (!coinbaseApi) throw new Error('the coinbase-api dependency is not installed');
    const cfg = venueConfig();
    if (!cfg.keyName || !cfg.privateKey) {
      throw new Error('no trading venue is configured: set COINBASE_CDP_KEY_NAME and'
        + ' COINBASE_CDP_PRIVATE_KEY for an account that holds USD');
    }
    return cfg;
  }

  static _tradeClient() {
    const cfg = this._requireVenue();
    return new coinbaseApi.CBAdvancedTradeClient({ apiKey: cfg.keyName, apiSecret: cfg.privateKey });
  }

  static _appClient() {
    const cfg = this._requireVenue();
    return new coinbaseApi.CBAppClient({ apiKey: cfg.keyName, apiSecret: cfg.privateKey });
  }

  /**
   * What `usd` would buy, and whether the venue can settle it at all. A
   * preview that reports INSUFFICIENT_FUND is the honest answer that the
   * account has no dollars in it — not a transport error.
   */
  static async quote({ usd } = {}) {
    const amount = num(usd);
    if (amount <= 0) throw new Error('usd must be a positive amount');
    const client = this._tradeClient();
    const preview = await client.previewOrder({
      product_id: XLM_USD,
      side: 'BUY',
      order_configuration: { market_market_ioc: { quote_size: amount.toFixed(2) } },
    });
    const errors = Array.isArray(preview && preview.errs) ? preview.errs : [];
    const needsDeposit = errors.some(e => /INSUFFICIENT_FUND/i.test(String(e)));
    return {
      product: XLM_USD,
      usd: amount.toFixed(2),
      xlm: (preview && preview.base_size) || null,
      needsDeposit,
      errors,
      ok: errors.length === 0,
    };
  }

  /** Market-buy `usd` worth of XLM. Returns the filled size, never a promise of one. */
  static async buy({ usd } = {}) {
    const amount = num(usd);
    if (amount <= 0) throw new Error('usd must be a positive amount');
    const client = this._tradeClient();
    const submitted = await client.submitOrder({
      product_id: XLM_USD,
      side: 'BUY',
      order_configuration: { market_market_ioc: { quote_size: amount.toFixed(2) } },
    });
    const failure = submitted && submitted.error_response;
    if (!submitted || submitted.success === false || (failure && (failure.error || failure.message))) {
      throw new Error(`the venue refused the XLM buy: ${(failure
        && (failure.message || failure.error || failure.preview_failure_reason)) || 'unknown reason'}`);
    }
    const filled = (submitted.filled_size || (submitted.success_response && submitted.success_response.filled_size) || '').toString();
    return {
      orderId: submitted.order_id || (submitted.success_response && submitted.success_response.order_id) || '',
      xlm: filled || null,
      response: submitted,
    };
  }

  /**
   * Withdraw XLM to a Stellar address. Returns the venue's receipt only; the
   * caller confirms against Horizon, because a venue reporting "sent" is a
   * claim and the ledger is the fact.
   *
   * A Stellar address that has never been funded does not exist, and not every
   * venue will create it. If this one refuses, the refusal is surfaced as-is
   * rather than retried into a different shape.
   */
  static async withdraw({ address, xlm, reference } = {}) {
    const amount = num(xlm);
    if (!address) throw new Error('a destination Stellar address is required');
    if (amount <= 0) throw new Error('xlm must be a positive amount');
    const client = this._appClient();
    const accounts = await client.getAccounts();
    const list = (accounts && accounts.data) || [];
    const account = list.find(a => a.currency === 'XLM'
      || (a.balance && a.balance.currency === 'XLM')
      || (a.currency && a.currency.code === 'XLM'));
    if (!account) throw new Error('the venue account has no XLM wallet to withdraw from');
    const send = await client.sendMoney({
      account_id: account.id,
      type: 'send',
      to: address,
      amount: amount.toFixed(7),
      currency: 'XLM',
      network: STELLAR_NETWORK,
      idem: reference || undefined,
    });
    const data = (send && send.data) || {};
    return {
      withdrawalId: data.id || '',
      status: data.status || '',
      hash: (data.network && data.network.hash) || '',
      response: send,
    };
  }
}

module.exports = {
  XLM_USD,
  STELLAR_NETWORK,
  StellarVenue,
  venues,
};
