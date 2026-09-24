'use strict';

/**
 * Stripe balance Payout -> ACH credit (direct deposit) into any registered
 * settlement bank (provider `stripe_payout`), e.g. the trust's Betterment
 * Checking account. Generalises liliStripePayoutOriginator: the destination is
 * the settlement bank's registered routing/account, registered on the Stripe
 * account as an external bank account (created on first use, pinned by
 * `metadata.stripeExternalAccountId` afterwards). Real dollars leave the Stripe
 * *available* balance only; nothing is originated if the balance is short.
 */

let stripe = null;
try { stripe = require('stripe'); } catch (e) { stripe = null; }
let pool = null;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const CHANNEL = 'stripe_payout';

function httpError(message, status, code) { return Object.assign(new Error(message), { status, code }); }
function last4(v) { const d = String(v || '').replace(/\D/g, ''); return d.length >= 4 ? d.slice(-4) : null; }

class StripePayoutSettlementOriginator {
  static getConfig() {
    const env = process.env;
    const key = env.STRIPE_SECRET_KEY || env.STRIPE_TREASURY_SECRET_KEY || null;
    return {
      channel: CHANNEL,
      keyMode: key ? (key.startsWith('sk_live_') || key.startsWith('rk_live_') ? 'live' : 'test') : null,
      method: String(env.STRIPE_PAYOUT_METHOD || 'standard').toLowerCase() === 'instant' ? 'instant' : 'standard',
      statementDescriptor: (env.STRIPE_PAYOUT_DESCRIPTOR || env.ACH_COMPANY_NAME || 'DLB TRUST').slice(0, 22),
      _key: key,
    };
  }

  static _client(cfg) {
    if (!stripe) throw httpError('stripe npm package not installed', 503, 'STRIPE_UNAVAILABLE');
    if (!cfg._key) throw httpError('STRIPE_SECRET_KEY not configured', 503, 'STRIPE_NOT_CONFIGURED');
    return stripe(cfg._key, { apiVersion: '2024-06-20', maxNetworkRetries: 2 });
  }

  static async ensureTables() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS stripe_payout_settlements (
        payout_id TEXT PRIMARY KEY,
        bank_id TEXT NOT NULL,
        external_account_id TEXT NOT NULL,
        amount_cents BIGINT NOT NULL,
        reference TEXT NOT NULL,
        description TEXT,
        receiver_name TEXT,
        receiver_routing TEXT,
        receiver_account_last4 TEXT,
        stripe_status TEXT,
        expected_arrival DATE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
  }

  /**
   * Find (or create) the Stripe external bank account matching the settlement
   * bank. Pinned id in bank.metadata.stripeExternalAccountId wins; otherwise a
   * single last4+routing match; otherwise it is created from the registered
   * routing/account (payout-only, never a default_for_currency change).
   */
  static async ensureExternalAccount(client, accountId, bank, { create = true } = {}) {
    const wantLast4 = last4(bank._account);
    const routing = bank.routingNumber ? String(bank.routingNumber) : null;
    if (!wantLast4 || !routing) throw httpError(`settlement bank '${bank.bankId}' has no routing/account registered`, 409, 'BANK_INCOMPLETE');
    const pinned = bank.metadata && bank.metadata.stripeExternalAccountId;
    if (pinned) {
      const ea = await client.accounts.retrieveExternalAccount(accountId, pinned);
      if (!ea || ea.object !== 'bank_account') throw httpError(`${pinned} is not a bank_account`, 409);
      if (ea.last4 !== wantLast4) throw httpError(`external account ${pinned} ends ${ea.last4}, not ****${wantLast4}`, 409);
      return ea;
    }
    const matches = [];
    for await (const ea of client.accounts.listExternalAccounts(accountId, { object: 'bank_account', limit: 100 })) {
      if (ea.object === 'bank_account' && ea.last4 === wantLast4 && (!ea.routing_number || String(ea.routing_number) === routing)) matches.push(ea);
    }
    if (matches.length > 1) throw httpError(`${matches.length} Stripe external accounts end ****${wantLast4}; pin one via metadata.stripeExternalAccountId`, 409);
    if (matches[0]) return matches[0];
    if (!create) return null;
    return client.accounts.createExternalAccount(accountId, {
      external_account: {
        object: 'bank_account',
        country: 'US',
        currency: 'usd',
        account_holder_name: bank.accountName || bank.name,
        account_holder_type: 'company',
        routing_number: routing,
        account_number: String(bank._account),
      },
      metadata: { dlb_bank_id: bank.bankId, source: 'dlb-treasury' },
    }, { idempotencyKey: `sps-ea-${bank.bankId}-${routing}-${wantLast4}` });
  }

  /** Live key, payouts enabled, destination registered on the Stripe account, available balance. */
  static async status(bank, { registerDestination = false } = {}) {
    const cfg = this.getConfig();
    const issues = [];
    let account = null;
    let externalAccount = null;
    let balance = null;
    if (!bank) issues.push('settlement bank required');
    if (!stripe) issues.push('stripe npm package not installed');
    else if (!cfg._key) issues.push('STRIPE_SECRET_KEY not configured');
    else {
      if (cfg.keyMode !== 'live') issues.push('STRIPE_SECRET_KEY is a test-mode key; a live key is required to move funds');
      try {
        const client = this._client(cfg);
        const [acct, bal] = await Promise.all([client.accounts.retrieve(), client.balance.retrieve()]);
        account = { id: acct.id, payoutsEnabled: acct.payouts_enabled === true, name: acct.business_profile && acct.business_profile.name };
        if (!account.payoutsEnabled) issues.push('Stripe account payouts are not enabled');
        if (bank) {
          const ea = await this.ensureExternalAccount(client, acct.id, bank, { create: registerDestination });
          if (!ea) issues.push(`${bank.name} ****${last4(bank._account)} is not a registered external (payout) bank account on the Stripe account`);
          else {
            externalAccount = { id: ea.id, bankName: ea.bank_name, routingNumber: ea.routing_number, last4: ea.last4, status: ea.status, default: ea.default_for_currency === true };
            if (['verification_failed', 'errored'].includes(ea.status)) issues.push(`Stripe external account status ${ea.status}`);
          }
        }
        const usd = (bal.available || []).find((b) => b.currency === 'usd');
        balance = { availableCents: usd ? usd.amount : 0, pendingCents: ((bal.pending || []).find((b) => b.currency === 'usd') || {}).amount || 0, livemode: bal.livemode === true };
        if (bal.livemode !== true) issues.push('Stripe balance is test-mode');
      } catch (e) { issues.push(`stripe: ${e.message}`); }
    }
    return {
      channel: CHANNEL,
      ready: issues.length === 0,
      method: cfg.method,
      keyMode: cfg.keyMode,
      bankId: bank ? bank.bankId : null,
      account,
      externalAccount,
      balance,
      destination: bank ? { name: bank.accountName || bank.name, routingNumber: bank.routingNumber || null, accountLast4: last4(bank._account) } : null,
      issues,
      blocker: issues.length ? issues.join('; ') : null,
    };
  }

  /** One ACH credit into the settlement bank as a Stripe Payout (idempotent on bankId+reference). */
  static async send(bank, { amountCents, reference, description } = {}) {
    if (!reference) throw httpError('reference required', 400);
    const cents = Number(amountCents);
    if (!Number.isInteger(cents) || cents <= 0) throw httpError('amountCents must be a positive integer', 400);
    const cfg = this.getConfig();
    const st = await this.status(bank, { registerDestination: true });
    if (!st.ready) throw httpError(`${st.blocker} — cannot originate the Stripe payout to ${bank ? bank.name : 'bank'}`, 503, 'STRIPE_PAYOUT_NOT_READY');
    if (cents > st.balance.availableCents) {
      throw httpError(`Stripe available balance ${(st.balance.availableCents / 100).toFixed(2)} USD is below the ${(cents / 100).toFixed(2)} USD credit`, 409, 'STRIPE_PAYOUT_INSUFFICIENT_BALANCE');
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
        metadata: { dlb_bank_id: bank.bankId, reference, direction: `treasury_to_${bank.bankId}` },
      }, { idempotencyKey: `sps-${bank.bankId}-${reference}` });
    } catch (e) {
      throw httpError(`Stripe payout failed: ${e.message}`, 502, 'STRIPE_PAYOUT_FAILED');
    }
    if (payout.status === 'failed' || payout.status === 'canceled') {
      throw httpError(`Stripe payout ${payout.status}${payout.failure_message ? `: ${payout.failure_message}` : ''}`, 502, 'STRIPE_PAYOUT_FAILED');
    }
    const expectedArrival = payout.arrival_date ? new Date(payout.arrival_date * 1000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    if (pool) {
      await this.ensureTables();
      await pool.query(
        `INSERT INTO stripe_payout_settlements (payout_id, bank_id, external_account_id, amount_cents, reference, description, receiver_name, receiver_routing, receiver_account_last4, stripe_status, expected_arrival)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (payout_id) DO NOTHING`,
        [payout.id, bank.bankId, st.externalAccount.id, cents, reference, description || null, st.destination.name, st.destination.routingNumber, st.destination.accountLast4, payout.status, expectedArrival],
      );
    }
    return {
      status: 'originated',
      channel: CHANNEL,
      network: 'ach',
      method: payout.method,
      externalAccountId: st.externalAccount.id,
      payoutId: payout.id,
      stripeStatus: payout.status,
      expectedArrival,
      destination: st.destination,
    };
  }
}

module.exports = { StripePayoutSettlementOriginator, STRIPE_PAYOUT_CHANNEL: CHANNEL };
