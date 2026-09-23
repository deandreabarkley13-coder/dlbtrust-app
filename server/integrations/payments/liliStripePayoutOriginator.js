'use strict';

/**
 * Stripe balance payout as the originator of the dlb-treasury -> Lili
 * direct deposit.
 *
 * The trust's live Stripe account holds the Lili account (Sunrise Banks N.A.,
 * RDFI) as its registered external payout bank account. A Payout is an ACH
 * credit from the Stripe balance into that account:
 *
 *   dlb-treasury (Stripe balance, payouts_enabled)
 *     --Payout (standard ACH)--> Lili ****last4
 *     --Lili MCP feed--> reconciliation
 *
 * Selected with LILI_ORIGINATOR=stripe_payout. The destination is the Stripe
 * bank_account external account pinned by STRIPE_PAYOUT_EXTERNAL_ACCOUNT_ID
 * (validated against the LILI_DD_* last4), or — when not pinned — the single
 * bank_account external account whose last4 matches; an ambiguous match fails
 * closed. No other bank account is ever paid. Fails closed on test-mode keys,
 * payouts disabled, no matching external account, or insufficient available
 * balance. Each payout is recorded as a `lili_direct_deposits` row keyed by
 * the Stripe payout id so LiliDirectDepositEngine.reconcile matches it
 * against the Lili MCP feed.
 */

const { LiliDirectDepositEngine } = require('./liliDirectDepositEngine');

let stripe = null;
try { stripe = require('stripe'); } catch (e) { stripe = null; }
let pool = null;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const CHANNEL = 'stripe_payout';

function last4(v) { return v ? String(v).slice(-4) : null; }
function httpError(message, status, code) { return Object.assign(new Error(message), { status, code }); }
function toCents(dollars) { return Math.round(Number(dollars) * 100); }

class LiliStripePayoutOriginator {
  static getConfig() {
    const env = process.env;
    const key = env.STRIPE_SECRET_KEY || env.STRIPE_TREASURY_SECRET_KEY || null;
    return {
      channel: CHANNEL,
      enabled: String(env.LILI_ORIGINATOR || 'nacha').toLowerCase() === CHANNEL,
      keyMode: key ? (key.startsWith('sk_live_') || key.startsWith('rk_live_') ? 'live' : 'test') : null,
      method: String(env.LILI_STRIPE_PAYOUT_METHOD || 'standard').toLowerCase() === 'instant' ? 'instant' : 'standard',
      externalAccountId: env.STRIPE_PAYOUT_EXTERNAL_ACCOUNT_ID || null,
      statementDescriptor: (env.LILI_STRIPE_PAYOUT_DESCRIPTOR || env.ACH_COMPANY_NAME || 'DLB TRUST').slice(0, 22),
      _key: key,
    };
  }

  static _client(cfg) {
    if (!stripe) throw httpError('stripe npm package not installed', 503, 'STRIPE_UNAVAILABLE');
    if (!cfg._key) throw httpError('STRIPE_SECRET_KEY not configured', 503, 'STRIPE_NOT_CONFIGURED');
    return stripe(cfg._key, { apiVersion: '2024-06-20', maxNetworkRetries: 2 });
  }

  /**
   * The Stripe bank_account external account that is the registered Lili
   * account. Pinned id: retrieved directly and its last4 checked. Otherwise all
   * bank_account external accounts are paged and exactly one must match.
   */
  static async _findExternalAccount(client, accountId, dest, cfg) {
    const wantLast4 = last4(dest._account);
    if (cfg.externalAccountId) {
      const ea = await client.accounts.retrieveExternalAccount(accountId, cfg.externalAccountId);
      if (!ea || ea.object !== 'bank_account') throw new Error(`STRIPE_PAYOUT_EXTERNAL_ACCOUNT_ID ${cfg.externalAccountId} is not a bank_account`);
      if (ea.last4 !== wantLast4) throw new Error(`STRIPE_PAYOUT_EXTERNAL_ACCOUNT_ID ${cfg.externalAccountId} ends ${ea.last4}, not the Lili account ****${wantLast4}`);
      return ea;
    }
    const matches = [];
    for await (const ea of client.accounts.listExternalAccounts(accountId, { object: 'bank_account', limit: 100 })) {
      if (ea.object === 'bank_account' && ea.last4 === wantLast4) matches.push(ea);
    }
    if (matches.length > 1) throw new Error(`${matches.length} Stripe external bank accounts end ****${wantLast4}; pin the Lili one with STRIPE_PAYOUT_EXTERNAL_ACCOUNT_ID`);
    return matches[0] || null;
  }

  /** Live account, payouts enabled, Lili registered as external account, available balance. */
  static async status() {
    const cfg = this.getConfig();
    const issues = [];
    let dest = null;
    let account = null;
    let externalAccount = null;
    let balance = null;
    try {
      dest = await LiliDirectDepositEngine.getDestination();
      if (!dest.configured) issues.push('Lili credit destination not configured (LILI_DD_ROUTING_NUMBER / LILI_DD_ACCOUNT_NUMBER)');
    } catch (e) { issues.push(`lili destination: ${e.message}`); }

    if (!stripe) issues.push('stripe npm package not installed');
    else if (!cfg._key) issues.push('STRIPE_SECRET_KEY not configured');
    else {
      if (cfg.keyMode !== 'live') issues.push('STRIPE_SECRET_KEY is a test-mode key; a live key is required to move funds');
      try {
        const client = this._client(cfg);
        const [acct, bal] = await Promise.all([client.accounts.retrieve(), client.balance.retrieve()]);
        account = { id: acct.id, payoutsEnabled: acct.payouts_enabled === true, name: acct.business_profile && acct.business_profile.name };
        if (!account.payoutsEnabled) issues.push('Stripe account payouts are not enabled');
        const ea = dest && dest.configured ? await this._findExternalAccount(client, acct.id, dest, cfg) : null;
        if (dest && dest.configured && !ea) issues.push(`Lili account ****${last4(dest._account)} is not a registered external (payout) bank account on the Stripe account`);
        if (ea) {
          externalAccount = { id: ea.id, bankName: ea.bank_name, routingNumber: ea.routing_number, last4: ea.last4, status: ea.status, default: ea.default_for_currency === true };
          if (dest.routingNumber && ea.routing_number && String(ea.routing_number) !== String(dest.routingNumber)) {
            externalAccount.routingMismatch = true;
          }
          if (ea.status === 'verification_failed' || ea.status === 'errored') issues.push(`Stripe external account status ${ea.status}`);
        }
        const usd = (bal.available || []).find((b) => b.currency === 'usd');
        balance = { availableCents: usd ? usd.amount : 0, pendingCents: ((bal.pending || []).find((b) => b.currency === 'usd') || {}).amount || 0, livemode: bal.livemode === true };
        if (bal.livemode !== true) issues.push('Stripe balance is test-mode');
      } catch (e) { issues.push(`stripe: ${e.message}`); }
    }

    return {
      channel: CHANNEL,
      enabled: cfg.enabled,
      ready: issues.length === 0,
      method: cfg.method,
      keyMode: cfg.keyMode,
      account,
      externalAccount,
      balance,
      destination: dest && dest.configured ? { routingNumber: dest.routingNumber, accountLast4: last4(dest._account), name: dest.accountName } : null,
      issues,
      blocker: issues.length ? issues.join('; ') : null,
    };
  }

  /** Originate one direct deposit into Lili as a Stripe Payout (idempotent on `reference`). */
  static async send({ amount, reference, description } = {}) {
    if (!reference) throw httpError('reference required', 400);
    const cfg = this.getConfig();
    const st = await this.status();
    if (!st.ready) throw httpError(`${st.blocker} — cannot originate the dlb-treasury -> Lili direct deposit through Stripe payouts`, 503, 'LILI_STRIPE_PAYOUT_NOT_READY');
    const cents = toCents(amount);
    if (!Number.isFinite(cents) || cents <= 0) throw httpError('amount must be positive', 400);
    if (cents > st.balance.availableCents) {
      throw httpError(`Stripe available balance ${(st.balance.availableCents / 100).toFixed(2)} USD is below the ${(cents / 100).toFixed(2)} USD deposit`, 409, 'LILI_STRIPE_PAYOUT_INSUFFICIENT_BALANCE');
    }

    const client = this._client(cfg);
    let payout;
    try {
      payout = await client.payouts.create({
        amount: cents,
        currency: 'usd',
        destination: st.externalAccount.id,
        method: cfg.method,
        description: [reference, description].filter(Boolean).join(' ').slice(0, 100),
        statement_descriptor: cfg.statementDescriptor,
        metadata: { lili_direct_deposit: 'true', reference, direction: 'treasury_to_lili' },
      }, { idempotencyKey: `lili-dd-${reference}` });
    } catch (e) {
      throw httpError(`Stripe payout failed: ${e.message}`, 502, 'LILI_STRIPE_PAYOUT_FAILED');
    }
    if (payout.status === 'failed' || payout.status === 'canceled') {
      throw httpError(`Stripe payout ${payout.status}${payout.failure_message ? `: ${payout.failure_message}` : ''}`, 502, 'LILI_STRIPE_PAYOUT_FAILED');
    }
    const expectedArrival = payout.arrival_date ? new Date(payout.arrival_date * 1000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    await this._recordDeposit({ payout, cents, reference, description, dest: st.destination, expectedArrival });
    return {
      status: 'originated',
      channel: CHANNEL,
      network: 'ach',
      method: payout.method,
      externalAccountId: st.externalAccount.id,
      payoutId: payout.id,
      depositId: payout.id,
      stripeStatus: payout.status,
      expectedArrival,
    };
  }

  /** Ledger row (deposit_id = Stripe payout id) so reconcile() can match the Lili credit. */
  static async _recordDeposit({ payout, cents, reference, description, dest, expectedArrival }) {
    if (!pool || !pool.query) return;
    await LiliDirectDepositEngine.ensureTables();
    await pool.query(
      `INSERT INTO lili_direct_deposits (deposit_id, status, amount_cents, sec_code, effective_date, memo, payment_type, receiver_name, receiver_routing, receiver_account_last4, lili_payment_id, created_by)
       VALUES ($1,'transmitted',$2,'CCD',$3,$4,'stripe_payout',$5,$6,$7,$8,'stripe_payout')
       ON CONFLICT (deposit_id) DO NOTHING`,
      [payout.id, cents, expectedArrival, [reference, description].filter(Boolean).join(' ').slice(0, 200), dest.name, dest.routingNumber, dest.accountLast4, reference],
    );
  }
}

module.exports = { LiliStripePayoutOriginator };
