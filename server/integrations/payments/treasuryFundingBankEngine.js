'use strict';

/**
 * Treasury funding bank — the trust company's real, funded checking account
 * (Betterment Checking / nbkc bank, in the trust's name) acting as the
 * originating bank of every external fiat movement.
 *
 * Betterment exposes no ACH-origination API, so origination is done by
 * *debit authorization*: the account is saved once as the trust company's
 * `us_bank_account` PaymentMethod in Stripe under an ACH mandate, and each
 * conversion to fiat then pulls the amount from that account:
 *
 *   Fineract account of record (held value)
 *     --pull()--> ACH debit of the treasury bank (Stripe PaymentIntent, off_session)
 *     --webhook payment_intent.succeeded--> treasury ledger (StripePaymentIntakeEngine)
 *     --POST /stripe-intakes/:id/payout--> ACH credit / direct deposit to any registered
 *                                         settlement bank (Lili, Betterment, ...)
 *
 * The account and routing numbers come from TREASURY_BANK_ROUTING_NUMBER /
 * TREASURY_BANK_ACCOUNT_NUMBER, falling back to BETTERMENT_ROUTING_NUMBER /
 * BETTERMENT_ACCOUNT_NUMBER (Secret Manager), and are never returned by this
 * module; only the last4 and Stripe's PaymentMethod id are exposed. Nothing is
 * pulled until Stripe reports the mandate verified (micro-deposits or instant
 * verification), and a pull is a real ACH debit that settles in ~4 business
 * days — it is never treated as received until the signed webhook says so.
 */

let stripe = null;
try { stripe = require('stripe'); } catch (e) { stripe = null; }
let pool = null;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }
let StripePaymentIntakeEngine = null;
try { ({ StripePaymentIntakeEngine } = require('./stripePaymentIntakeEngine')); } catch (e) { StripePaymentIntakeEngine = null; }
let SettlementBankRegistry = null;
try { ({ SettlementBankRegistry } = require('./settlementBankRegistry')); } catch (e) { SettlementBankRegistry = null; }

function httpError(message, status, code) { return Object.assign(new Error(message), { status, code }); }
function digits(v) { return String(v || '').replace(/\D/g, ''); }
function last4(v) { const d = digits(v); return d.length >= 4 ? d.slice(-4) : null; }
function bool(name, dflt) {
  const v = process.env[name];
  if (v == null || v === '') return dflt;
  return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
}

class TreasuryFundingBankEngine {
  static getConfig() {
    const env = process.env;
    const key = env.STRIPE_PAYMENTS_SECRET_KEY || env.STRIPE_SECRET_KEY || null;
    const routing = digits(env.TREASURY_BANK_ROUTING_NUMBER || env.BETTERMENT_ROUTING_NUMBER);
    const account = digits(env.TREASURY_BANK_ACCOUNT_NUMBER || env.BETTERMENT_ACCOUNT_NUMBER);
    return {
      enabled: bool('TREASURY_BANK_ENABLED', false),
      bankId: String(env.TREASURY_BANK_ID || 'betterment').trim().toLowerCase(),
      name: env.TREASURY_BANK_NAME || 'Betterment Checking',
      institution: env.TREASURY_BANK_INSTITUTION || 'nbkc bank (Betterment Checking)',
      accountHolder: env.TREASURY_BANK_ACCOUNT_HOLDER || env.INCOME_OBLIGOR_NAME || null,
      accountHolderEmail: env.TREASURY_BANK_ACCOUNT_HOLDER_EMAIL || env.INCOME_OBLIGOR_EMAIL || null,
      accountType: String(env.TREASURY_BANK_ACCOUNT_TYPE || 'checking').toLowerCase() === 'savings' ? 'savings' : 'checking',
      payerId: env.TREASURY_BANK_PAYER_ID || env.INCOME_OBLIGOR_PAYER_ID || 'income-obligor',
      routingConfigured: routing.length === 9,
      accountConfigured: account.length >= 4,
      accountLast4: last4(account),
      routingLast4: last4(routing),
      mandateAcceptance: String(env.TREASURY_BANK_MANDATE_ACCEPTANCE || 'online').toLowerCase() === 'offline' ? 'offline' : 'online',
      registerAsSettlementBank: bool('TREASURY_BANK_REGISTER_SETTLEMENT', true),
      keyMode: key ? (key.startsWith('sk_live_') || key.startsWith('rk_live_') ? 'live' : 'test') : null,
      _key: key,
      _routing: routing,
      _account: account,
    };
  }

  static _client(cfg) {
    if (!stripe) throw httpError('stripe npm package not installed', 503, 'STRIPE_UNAVAILABLE');
    if (!cfg._key) throw httpError('STRIPE_PAYMENTS_SECRET_KEY not configured', 503, 'STRIPE_NOT_CONFIGURED');
    return stripe(cfg._key, { apiVersion: '2024-06-20', maxNetworkRetries: 2 });
  }

  static async ensureTables() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS treasury_funding_bank (
        bank_id TEXT PRIMARY KEY,
        customer_id TEXT,
        payment_method_id TEXT,
        setup_intent_id TEXT,
        mandate_id TEXT,
        account_last4 TEXT,
        routing_last4 TEXT,
        fingerprint TEXT,
        verification TEXT NOT NULL DEFAULT 'unlinked',
        next_action TEXT,
        last_error TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        linked_at TIMESTAMPTZ,
        verified_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
  }

  static async _row(bankId) {
    if (!pool) return null;
    await this.ensureTables();
    const r = await pool.query('SELECT * FROM treasury_funding_bank WHERE bank_id = $1', [bankId]);
    return r.rows[0] || null;
  }

  static async _save(bankId, patch) {
    if (!pool) return null;
    await this.ensureTables();
    const cols = Object.keys(patch);
    const vals = cols.map((c) => (c === 'metadata' ? JSON.stringify(patch[c] || {}) : patch[c]));
    const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    const r = await pool.query(
      `INSERT INTO treasury_funding_bank (bank_id, ${cols.join(', ')})
       VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
       ON CONFLICT (bank_id) DO UPDATE SET ${sets}, updated_at = NOW()
       RETURNING *`,
      [bankId, ...vals],
    );
    return r.rows[0];
  }

  static _public(cfg, row) {
    return {
      bankId: cfg.bankId,
      name: cfg.name,
      institution: cfg.institution,
      role: 'originating_bank',
      accountHolder: cfg.accountHolder,
      accountType: cfg.accountType,
      accountNumberMasked: cfg.accountLast4 ? `****${cfg.accountLast4}` : null,
      routingNumberMasked: cfg.routingLast4 ? `*****${cfg.routingLast4}` : null,
      customerId: row ? row.customer_id : null,
      paymentMethodId: row ? row.payment_method_id : null,
      setupIntentId: row ? row.setup_intent_id : null,
      mandateId: row ? row.mandate_id : null,
      verification: row ? row.verification : 'unlinked',
      nextAction: row ? row.next_action : null,
      lastError: row ? row.last_error : null,
      linkedAt: row ? row.linked_at : null,
      verifiedAt: row ? row.verified_at : null,
    };
  }

  /** Fail-closed readiness: verified mandate on a live Stripe key is required before any pull. */
  static async status() {
    const cfg = this.getConfig();
    const issues = [];
    const warnings = [];
    if (!cfg.enabled) issues.push('TREASURY_BANK_ENABLED=false');
    if (!cfg._key) issues.push('STRIPE_PAYMENTS_SECRET_KEY not configured');
    else if (cfg.keyMode !== 'live') issues.push('Stripe key is not live-mode');
    if (!cfg.routingConfigured) issues.push('TREASURY_BANK_ROUTING_NUMBER / BETTERMENT_ROUTING_NUMBER not configured (9 digits)');
    if (!cfg.accountConfigured) issues.push('TREASURY_BANK_ACCOUNT_NUMBER / BETTERMENT_ACCOUNT_NUMBER not configured');
    if (!cfg.accountHolder) issues.push('TREASURY_BANK_ACCOUNT_HOLDER / INCOME_OBLIGOR_NAME not configured');
    if (!pool) issues.push('database unavailable');
    let row = null;
    try { row = await this._row(cfg.bankId); } catch (e) { issues.push(`treasury_funding_bank unreadable: ${e.message}`); }
    if (!row || !row.payment_method_id) issues.push('treasury bank not linked in Stripe (POST /treasury-bank/link)');
    else if (row.verification !== 'verified') issues.push(`treasury bank mandate ${row.verification}${row.next_action ? ` (${row.next_action})` : ''}`);
    if (row && row.account_last4 && cfg.accountLast4 && row.account_last4 !== cfg.accountLast4) {
      issues.push(`linked account ****${row.account_last4} differs from configured ****${cfg.accountLast4}; re-link`);
    }
    if (!StripePaymentIntakeEngine) warnings.push('StripePaymentIntakeEngine unavailable: pulls cannot be recorded');
    return {
      provider: 'treasury_funding_bank',
      channel: 'stripe_ach_debit',
      ready: issues.length === 0,
      issues,
      warnings,
      keyMode: cfg.keyMode,
      mandateAcceptance: cfg.mandateAcceptance,
      bank: this._public(cfg, row),
      flow: [
        'Fineract account of record (held value)',
        `ACH debit of ${cfg.name} (Stripe PaymentIntent, mandate)`,
        'Stripe balance (webhook payment_intent.succeeded -> treasury ledger)',
        'Stripe payout -> ACH credit / direct deposit to a registered settlement bank',
      ],
    };
  }

  /**
   * Save the treasury bank as the trust company's ACH payment method under a
   * mandate. Uses the account/routing from the environment (never from the
   * request). Returns the verification state; `requires_microdeposits` means
   * Stripe sent two micro-deposits (or a descriptor code SMxxxx) to the
   * account and POST /treasury-bank/verify must follow.
   */
  static async link({ acceptedBy, ipAddress, userAgent, actor = 'payment_server' } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw httpError('TREASURY_BANK_ENABLED=false', 503, 'DISABLED');
    if (!cfg.routingConfigured || !cfg.accountConfigured) {
      throw httpError('TREASURY_BANK_ROUTING_NUMBER / TREASURY_BANK_ACCOUNT_NUMBER not configured', 503, 'BANK_NOT_CONFIGURED');
    }
    if (!cfg.accountHolder) throw httpError('TREASURY_BANK_ACCOUNT_HOLDER not configured', 503, 'BANK_NOT_CONFIGURED');
    if (!StripePaymentIntakeEngine) throw httpError('StripePaymentIntakeEngine unavailable', 503);
    const client = this._client(cfg);
    const existing = await this._row(cfg.bankId);
    if (existing && existing.payment_method_id && existing.verification === 'verified' && existing.account_last4 === cfg.accountLast4) {
      return { ...this._public(cfg, existing), alreadyLinked: true };
    }
    const customer = await StripePaymentIntakeEngine._ensureCustomer(client, {
      payerId: cfg.payerId, payerName: cfg.accountHolder, payerEmail: cfg.accountHolderEmail,
    });
    if (!customer) throw httpError('unable to resolve the trust company Stripe customer', 502);

    const pm = await client.paymentMethods.create({
      type: 'us_bank_account',
      us_bank_account: {
        account_holder_type: 'company',
        account_type: cfg.accountType,
        routing_number: cfg._routing,
        account_number: cfg._account,
      },
      billing_details: { name: cfg.accountHolder, email: cfg.accountHolderEmail || undefined },
      metadata: { dlb_bank_id: cfg.bankId, role: 'treasury_funding_bank', source: 'dlb-treasury' },
    });

    const acceptance = cfg.mandateAcceptance === 'offline' || !ipAddress || !userAgent
      ? { type: 'offline' }
      : { type: 'online', online: { ip_address: ipAddress, user_agent: userAgent } };
    const si = await client.setupIntents.create({
      customer: customer.id,
      payment_method: pm.id,
      payment_method_types: ['us_bank_account'],
      usage: 'off_session',
      confirm: true,
      mandate_data: { customer_acceptance: acceptance },
      payment_method_options: { us_bank_account: { verification_method: 'automatic' } },
      description: `${cfg.accountHolder} treasury funding bank (${cfg.name})`,
      metadata: { dlb_bank_id: cfg.bankId, accepted_by: acceptedBy || actor, source: 'dlb-treasury' },
    }, { idempotencyKey: `tfb-link-${cfg.bankId}-${pm.id}` });

    const state = this._stateFromSetupIntent(si);
    const row = await this._save(cfg.bankId, {
      customer_id: customer.id,
      payment_method_id: pm.id,
      setup_intent_id: si.id,
      mandate_id: typeof si.mandate === 'string' ? si.mandate : (si.mandate && si.mandate.id) || null,
      account_last4: (pm.us_bank_account && pm.us_bank_account.last4) || cfg.accountLast4,
      routing_last4: cfg.routingLast4,
      fingerprint: (pm.us_bank_account && pm.us_bank_account.fingerprint) || null,
      verification: state.verification,
      next_action: state.nextAction,
      last_error: state.error,
      metadata: { bankName: pm.us_bank_account && pm.us_bank_account.bank_name, acceptance: acceptance.type, acceptedBy: acceptedBy || actor, linkedBy: actor },
      linked_at: new Date(),
      verified_at: state.verification === 'verified' ? new Date() : null,
    });
    if (state.verification === 'verified') await this._registerSettlementBank(cfg, row, actor);
    return { ...this._public(cfg, row), stripeStatus: si.status };
  }

  static _stateFromSetupIntent(si) {
    if (!si) return { verification: 'unlinked', nextAction: null, error: null };
    if (si.status === 'succeeded') return { verification: 'verified', nextAction: null, error: null };
    if (si.status === 'requires_action' && si.next_action && si.next_action.type === 'verify_with_microdeposits') {
      const md = si.next_action.verify_with_microdeposits || {};
      return {
        verification: 'requires_microdeposits',
        nextAction: `verify_with_microdeposits:${md.microdeposit_type || 'amounts'}${md.arrival_date ? ` (arrives ${new Date(md.arrival_date * 1000).toISOString().slice(0, 10)})` : ''}`,
        error: null,
      };
    }
    if (si.status === 'processing') return { verification: 'processing', nextAction: null, error: null };
    if (si.status === 'canceled') return { verification: 'canceled', nextAction: null, error: null };
    return { verification: si.status || 'pending', nextAction: si.next_action ? si.next_action.type : null, error: si.last_setup_error ? si.last_setup_error.message : null };
  }

  /** Complete micro-deposit verification (two amounts in cents, or the SMxxxx descriptor code). */
  static async verify({ amounts, descriptorCode, actor = 'payment_server' } = {}) {
    const cfg = this.getConfig();
    const row = await this._row(cfg.bankId);
    if (!row || !row.setup_intent_id) throw httpError('treasury bank not linked; POST /treasury-bank/link first', 409, 'NOT_LINKED');
    if (row.verification === 'verified') return { ...this._public(cfg, row), alreadyVerified: true };
    const client = this._client(cfg);
    const params = {};
    if (descriptorCode) params.descriptor_code = String(descriptorCode).trim().toUpperCase();
    else if (Array.isArray(amounts) && amounts.length === 2) params.amounts = amounts.map((a) => Number(a));
    else throw httpError('amounts [cents, cents] or descriptorCode is required', 400);
    const si = await client.setupIntents.verifyMicrodeposits(row.setup_intent_id, params);
    return this._syncSetupIntent(cfg, row, si, actor);
  }

  /** Re-read the SetupIntent from Stripe (instant verification, or verification completed in the dashboard). */
  static async refresh({ actor = 'payment_server' } = {}) {
    const cfg = this.getConfig();
    const row = await this._row(cfg.bankId);
    if (!row || !row.setup_intent_id) throw httpError('treasury bank not linked', 409, 'NOT_LINKED');
    const client = this._client(cfg);
    const si = await client.setupIntents.retrieve(row.setup_intent_id);
    return this._syncSetupIntent(cfg, row, si, actor);
  }

  static async _syncSetupIntent(cfg, row, si, actor) {
    const state = this._stateFromSetupIntent(si);
    const updated = await this._save(cfg.bankId, {
      mandate_id: (typeof si.mandate === 'string' ? si.mandate : (si.mandate && si.mandate.id)) || row.mandate_id || null,
      verification: state.verification,
      next_action: state.nextAction,
      last_error: state.error,
      verified_at: state.verification === 'verified' ? (row.verified_at || new Date()) : row.verified_at,
    });
    if (state.verification === 'verified') await this._registerSettlementBank(cfg, updated, actor);
    return { ...this._public(cfg, updated), stripeStatus: si.status };
  }

  /**
   * The same account is also a place fiat can be pushed *to* (Stripe payout ->
   * ACH credit / direct deposit), so it is registered as a settlement bank with
   * the `stripe_payout` provider; the full numbers stay in the environment.
   */
  static async _registerSettlementBank(cfg, row, actor) {
    if (!cfg.registerAsSettlementBank || !SettlementBankRegistry) return null;
    try {
      return await SettlementBankRegistry.register({
        bankId: cfg.bankId,
        provider: 'stripe_payout',
        name: cfg.name,
        routingNumber: cfg._routing,
        accountNumber: cfg._account,
        accountName: cfg.accountHolder,
        rail: 'ach',
        enabled: true,
        metadata: {
          institution: cfg.institution,
          accountType: cfg.accountType,
          role: 'treasury_funding_bank',
          stripeCustomerId: row.customer_id,
          stripePaymentMethodId: row.payment_method_id,
          mandateId: row.mandate_id,
        },
        createdBy: actor,
      });
    } catch (e) {
      return null;
    }
  }

  /**
   * Originate from the treasury bank: an off-session ACH debit of the saved
   * account for `amountCents`, recorded as a Stripe intake (purpose
   * `treasury_bank_pull`). The intake becomes `received` only through the
   * signed webhook once the debit settles; the payout leg is a separate,
   * maker/checker-approved call.
   */
  static async pull({ amountCents, reference, description, purpose = 'trust_income', bondPaymentId, destinationBankId, createdBy = 'payment_server' } = {}) {
    const st = await this.status();
    if (!st.ready) throw httpError(`treasury bank not ready: ${st.issues.join('; ')}`, 503, 'TREASURY_BANK_NOT_READY');
    const cents = Number(amountCents);
    if (!Number.isInteger(cents) || cents < 50) throw httpError('amountCents must be an integer >= 50', 400);
    if (!reference) throw httpError('reference is required', 400);
    const cfg = this.getConfig();
    const row = await this._row(cfg.bankId);
    const client = this._client(cfg);
    const intakeId = `SPI-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const pi = await client.paymentIntents.create({
      amount: cents,
      currency: 'usd',
      customer: row.customer_id,
      payment_method: row.payment_method_id,
      payment_method_types: ['us_bank_account'],
      confirm: true,
      off_session: true,
      mandate: row.mandate_id || undefined,
      description: (description || `${cfg.accountHolder} ${purpose.replace(/_/g, ' ')} ${reference}`).slice(0, 1000),
      metadata: {
        dlb_intake_id: intakeId,
        reference: String(reference),
        purpose,
        payer_id: cfg.payerId,
        funding_bank_id: cfg.bankId,
        bond_payment_id: bondPaymentId ? String(bondPaymentId) : '',
        destination: destinationBankId ? `settlement_bank:${destinationBankId}` : 'settlement_bank',
      },
    }, { idempotencyKey: `tfb-pull-${cfg.bankId}-${reference}` });
    await StripePaymentIntakeEngine._insert({
      intake_id: intakeId, payment_intent_id: pi.id, checkout_session_id: null, customer_id: row.customer_id,
      amount_cents: cents, currency: 'usd', status: pi.status === 'succeeded' ? 'created' : 'processing',
      payment_method_types: ['us_bank_account'],
      payer_email: cfg.accountHolderEmail, payer_name: cfg.accountHolder, reference: String(reference), purpose,
      checkout_url: null, created_by: createdBy,
    });
    const intake = await StripePaymentIntakeEngine.get(intakeId);
    return {
      intake,
      paymentIntentId: pi.id,
      stripeStatus: pi.status,
      fundingBank: this._public(cfg, row),
      note: 'ACH debit originated from the treasury bank; the intake is received only when the Stripe webhook confirms settlement (~4 business days), after which POST /stripe-intakes/:id/payout pushes the direct deposit.',
    };
  }
}

module.exports = { TreasuryFundingBankEngine };
