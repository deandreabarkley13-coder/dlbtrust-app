'use strict';

/**
 * Stripe Treasury as the originator of the dlb-treasury -> Lili direct deposit.
 *
 * Lili (Sunrise Banks N.A., RDFI) receives; the trust's Stripe Treasury
 * financial account is the treasury bank account that originates the credit:
 *
 *   dlb-treasury (Stripe Treasury financial account, ABA-addressable)
 *     --OutboundPayment us_bank_account (ach | us_domestic_wire)--> Lili ****last4
 *     --Lili MCP feed--> reconciliation
 *
 * The destination is always the registered Lili account
 * (LILI_DD_ROUTING_NUMBER / LILI_DD_ACCOUNT_NUMBER); nothing else is credited.
 * Selected with LILI_ORIGINATOR=stripe_treasury. Fails closed unless the
 * Stripe key and financial account are live-mode with outbound_payments.ach
 * active (test-mode keys never move money and are reported as a blocker).
 */

const { LiliDirectDepositEngine } = require('./liliDirectDepositEngine');

let StripeTreasuryEngine = null;
function loadDeps() {
  if (StripeTreasuryEngine) return;
  try { ({ StripeTreasuryEngine } = require('./stripeTreasuryEngine')); } catch (e) { StripeTreasuryEngine = null; }
}

const CHANNEL = 'stripe_treasury';
const NETWORKS = { ach: 'ach', wire: 'us_domestic_wire', us_domestic_wire: 'us_domestic_wire' };

function last4(v) { return v ? String(v).slice(-4) : null; }
function httpError(message, status, code) { return Object.assign(new Error(message), { status, code }); }

class LiliStripeTreasuryOriginator {
  static getConfig() {
    const env = process.env;
    const network = NETWORKS[String(env.LILI_STRIPE_TREASURY_NETWORK || 'ach').toLowerCase()] || 'ach';
    return {
      channel: CHANNEL,
      enabled: String(env.LILI_ORIGINATOR || 'nacha').toLowerCase() === CHANNEL,
      network,
      financialAccountId: env.STRIPE_TREASURY_FINANCIAL_ACCOUNT_ID || null,
      keyMode: env.STRIPE_SECRET_KEY ? (env.STRIPE_SECRET_KEY.startsWith('sk_live_') || env.STRIPE_SECRET_KEY.startsWith('rk_live_') ? 'live' : 'test') : null,
      statementDescriptor: (env.LILI_STRIPE_TREASURY_DESCRIPTOR || env.ACH_COMPANY_NAME || 'DLB TRUST').slice(0, 22),
      allowTestMode: String(env.LILI_STRIPE_TREASURY_ALLOW_TEST || 'false').toLowerCase() === 'true',
    };
  }

  /** Live financial account with outbound ACH enabled, or the reason it is not usable. */
  static async status() {
    loadDeps();
    const cfg = this.getConfig();
    const issues = [];
    let financialAccount = null;
    let dest = null;
    try {
      dest = await LiliDirectDepositEngine.getDestination();
      if (!dest.configured) issues.push('Lili credit destination not configured (LILI_DD_ROUTING_NUMBER / LILI_DD_ACCOUNT_NUMBER)');
    } catch (e) { issues.push(`lili destination: ${e.message}`); }

    if (!StripeTreasuryEngine) issues.push('StripeTreasuryEngine not available');
    else if (!StripeTreasuryEngine.isConfigured()) issues.push('STRIPE_SECRET_KEY / STRIPE_TREASURY_FINANCIAL_ACCOUNT_ID not configured');
    else {
      if (cfg.keyMode !== 'live' && !cfg.allowTestMode) issues.push('STRIPE_SECRET_KEY is a test-mode key; a live key is required to move funds');
      try {
        const fa = await StripeTreasuryEngine.getClient().treasury.financialAccounts.retrieve(cfg.financialAccountId);
        const features = Array.isArray(fa.active_features) ? fa.active_features : [];
        const needed = cfg.network === 'ach' ? 'outbound_payments.ach' : 'outbound_payments.us_domestic_wire';
        financialAccount = {
          id: fa.id,
          status: fa.status,
          livemode: fa.livemode === true,
          activeFeatures: features,
          aba: fa.financial_addresses && fa.financial_addresses[0] && fa.financial_addresses[0].aba
            ? { routingNumber: fa.financial_addresses[0].aba.routing_number, accountLast4: fa.financial_addresses[0].aba.account_number_last4, bankName: fa.financial_addresses[0].aba.bank_name }
            : null,
        };
        if (fa.status !== 'open') issues.push(`Stripe Treasury financial account is ${fa.status}`);
        if (!features.includes(needed)) issues.push(`Stripe Treasury financial account lacks ${needed}`);
        if (fa.livemode !== true && !cfg.allowTestMode) issues.push('Stripe Treasury financial account is test-mode');
      } catch (e) { issues.push(`stripe treasury: ${e.message}`); }
    }

    return {
      channel: CHANNEL,
      enabled: cfg.enabled,
      ready: issues.length === 0,
      network: cfg.network,
      keyMode: cfg.keyMode,
      financialAccountId: cfg.financialAccountId,
      financialAccount,
      destination: dest && dest.configured ? { routingNumber: dest.routingNumber, accountLast4: last4(dest._account), name: dest.accountName } : null,
      issues,
      blocker: issues.length ? issues.join('; ') : null,
    };
  }

  /**
   * Originate one direct deposit into Lili as a Stripe Treasury
   * OutboundPayment. `posted` -> originated; `processing` -> originated
   * (ACH in flight); anything else -> failed.
   */
  static async send({ amount, reference, description } = {}) {
    loadDeps();
    if (!StripeTreasuryEngine) throw httpError('StripeTreasuryEngine not available', 503, 'STRIPE_TREASURY_UNAVAILABLE');
    if (!reference) throw httpError('reference required', 400);
    const cfg = this.getConfig();
    const st = await this.status();
    if (!st.ready) throw httpError(`${st.blocker} — cannot originate the dlb-treasury -> Lili direct deposit through Stripe Treasury`, 503, 'LILI_STRIPE_TREASURY_NOT_READY');

    const dest = await LiliDirectDepositEngine.getDestination();
    const result = await StripeTreasuryEngine.createPayment({
      amount: Number(amount),
      routingNumber: dest.routingNumber,
      accountNumber: dest._account,
      accountHolderName: dest.accountName,
      accountHolderType: 'company',
      accountType: 'checking',
      network: cfg.network,
      description: [reference, description].filter(Boolean).join(' ').slice(0, 100),
      statementDescriptor: cfg.statementDescriptor,
      financialAccountId: cfg.financialAccountId,
      metadata: { lili_direct_deposit: 'true', reference, direction: 'treasury_to_lili' },
    });

    if (result.status === 'failed' || result.status === 'canceled') {
      const err = result.response && result.response.error;
      throw httpError(`Stripe Treasury outbound payment ${result.status}${err ? `: ${err.message}` : ''}`, 502, 'LILI_STRIPE_TREASURY_FAILED');
    }
    return {
      status: 'originated',
      channel: CHANNEL,
      network: cfg.network,
      financialAccountId: result.financial_account,
      payoutId: result.payout_id,
      outboundPaymentId: result.stripe_outbound_payment_id,
      stripeStatus: result.stripe_status,
      expectedArrival: result.response && result.response.expected_arrival_date
        ? new Date(result.response.expected_arrival_date * 1000).toISOString().slice(0, 10)
        : null,
    };
  }
}

module.exports = { LiliStripeTreasuryOriginator };
