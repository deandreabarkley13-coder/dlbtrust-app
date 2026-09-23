'use strict';

/**
 * Stripe payment processing (intake) — the funding leg ahead of the
 * dlb-treasury -> Lili direct deposit.
 *
 *   payer (card / us_bank_account ACH debit)
 *     --PaymentIntent | Checkout Session--> Stripe balance
 *     --webhook payment_intent.succeeded--> treasury ledger deposit
 *     --POST /stripe-intakes/:id/payout--> BankSettlementEngine (lili, stripe_payout)
 *
 * Every payment is recorded in `stripe_payment_intakes` keyed by the Stripe
 * PaymentIntent id; the webhook is the only thing that marks an intake
 * `received` (and it verifies the Stripe signature with STRIPE_WEBHOOK_SECRET).
 * Payouts are never triggered from the webhook: the settlement is a separate
 * live call that still requires approvalRef/screeningRef and only succeeds once
 * the funds are in the *available* Stripe balance (card funds settle in ~2
 * business days, ACH debits in ~4).
 */

let stripe = null;
try { stripe = require('stripe'); } catch (e) { stripe = null; }
let pool = null;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }
let DepositAndSettlementEngine = null;
try { ({ DepositAndSettlementEngine } = require('./depositAndSettlementEngine')); } catch (e) { DepositAndSettlementEngine = null; }

let CouponService = null;
try { ({ CouponService } = require('../bonds/couponService')); } catch (e) { CouponService = null; }

const METHODS = new Set(['card', 'us_bank_account']);
const INCOME_PURPOSES = new Set(['coupon_income', 'principal_repayment', 'trust_income']);

function maskEin(ein) {
  const d = String(ein || '').replace(/\D/g, '');
  return d.length === 9 ? `**-***${d.slice(-4)}` : null;
}
const CASH_ACCOUNT = 'CA-STRIPE-BALANCE';

function httpError(message, status, code) { return Object.assign(new Error(message), { status, code }); }
function intakeId() { return `SPI-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }

function rowToIntake(r) {
  if (!r) return null;
  return {
    intakeId: r.intake_id,
    paymentIntentId: r.payment_intent_id,
    checkoutSessionId: r.checkout_session_id,
    customerId: r.customer_id,
    amountCents: Number(r.amount_cents),
    currency: r.currency,
    status: r.status,
    paymentMethodTypes: r.payment_method_types,
    payerEmail: r.payer_email,
    payerName: r.payer_name,
    reference: r.reference,
    purpose: r.purpose,
    checkoutUrl: r.checkout_url,
    depositOrderId: r.deposit_order_id,
    liliSettlementId: r.lili_settlement_id,
    receivedAt: r.received_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

class StripePaymentIntakeEngine {
  static getConfig() {
    const env = process.env;
    const key = env.STRIPE_PAYMENTS_SECRET_KEY || env.STRIPE_SECRET_KEY || null;
    const methods = String(env.STRIPE_INTAKE_PAYMENT_METHODS || 'card,us_bank_account')
      .split(',').map((s) => s.trim().toLowerCase()).filter((s) => METHODS.has(s));
    return {
      enabled: String(env.STRIPE_INTAKE_ENABLED || 'true').toLowerCase() !== 'false',
      keyMode: key ? (key.startsWith('sk_live_') || key.startsWith('rk_live_') ? 'live' : 'test') : null,
      paymentMethodTypes: methods.length ? methods : ['card'],
      webhookConfigured: Boolean(env.STRIPE_WEBHOOK_SECRET),
      returnUrl: env.STRIPE_INTAKE_RETURN_URL || env.APP_PUBLIC_URL || env.PUBLIC_URL || null,
      statementDescriptor: (env.STRIPE_INTAKE_DESCRIPTOR || env.ACH_COMPANY_NAME || 'DLB TRUST').slice(0, 22),
      incomeObligor: env.INCOME_OBLIGOR_NAME ? {
        payerId: env.INCOME_OBLIGOR_PAYER_ID || 'income-obligor',
        name: env.INCOME_OBLIGOR_NAME,
        email: env.INCOME_OBLIGOR_EMAIL || null,
        ein: env.INCOME_OBLIGOR_EIN ? String(env.INCOME_OBLIGOR_EIN).replace(/\D/g, '') : null,
        role: env.INCOME_OBLIGOR_ROLE || 'custodian_issuer',
      } : null,
      _key: key,
      _webhookSecret: env.STRIPE_WEBHOOK_SECRET || null,
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
      CREATE TABLE IF NOT EXISTS stripe_payment_intakes (
        id SERIAL PRIMARY KEY,
        intake_id TEXT UNIQUE NOT NULL,
        payment_intent_id TEXT UNIQUE,
        checkout_session_id TEXT UNIQUE,
        customer_id TEXT,
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'usd',
        status TEXT NOT NULL DEFAULT 'created'
          CHECK (status IN ('created','processing','received','failed','canceled','paid_out')),
        payment_method_types TEXT[] NOT NULL DEFAULT '{card}',
        payer_email TEXT,
        payer_name TEXT,
        reference TEXT,
        purpose TEXT,
        checkout_url TEXT,
        deposit_order_id TEXT,
        lili_settlement_id TEXT,
        last_event_id TEXT,
        error_message TEXT,
        received_at TIMESTAMPTZ,
        created_by TEXT NOT NULL DEFAULT 'payment_server',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
  }

  /** Fail-closed readiness of the intake leg: live key, charges enabled, webhook secret present. */
  static async status() {
    const cfg = this.getConfig();
    const issues = [];
    const out = {
      channel: 'stripe_payments', enabled: cfg.enabled, mode: cfg.keyMode, paymentMethodTypes: cfg.paymentMethodTypes,
      webhookConfigured: cfg.webhookConfigured, account: null, capabilities: null, ready: false, issues,
    };
    if (!cfg.enabled) { issues.push('STRIPE_INTAKE_ENABLED=false'); return out; }
    if (!cfg._key) { issues.push('STRIPE_SECRET_KEY not configured'); return out; }
    if (cfg.keyMode !== 'live') issues.push('Stripe key is test mode; live payments require sk_live_/rk_live_');
    if (!cfg.webhookConfigured) issues.push('STRIPE_WEBHOOK_SECRET not configured; payments cannot be confirmed');
    try {
      const client = this._client(cfg);
      const acct = await client.accounts.retrieve();
      out.account = { id: acct.id, name: (acct.business_profile && acct.business_profile.name) || acct.settings?.dashboard?.display_name || null, chargesEnabled: Boolean(acct.charges_enabled) };
      out.capabilities = {
        card: acct.capabilities && acct.capabilities.card_payments,
        us_bank_account: acct.capabilities && acct.capabilities.us_bank_account_ach_payments,
      };
      if (!acct.charges_enabled) issues.push('Stripe account has charges_enabled=false');
      for (const m of cfg.paymentMethodTypes) {
        const cap = m === 'card' ? out.capabilities.card : out.capabilities.us_bank_account;
        if (cap !== 'active') issues.push(`Stripe capability for ${m} is ${cap || 'missing'}`);
      }
    } catch (e) {
      issues.push(`stripe: ${e.message}`);
    }
    out.ready = issues.length === 0;
    return out;
  }

  static async _ensureCustomer(client, { payerEmail, payerName, payerId, payerEin }) {
    if (!payerEmail && !payerId) return null;
    const query = payerId ? `metadata['payer_id']:'${String(payerId).replace(/'/g, '')}'` : `email:'${String(payerEmail).replace(/'/g, '')}'`;
    const found = await client.customers.search({ query, limit: 1 });
    const customer = (found && found.data && found.data[0]) || await client.customers.create({
      email: payerEmail || undefined,
      name: payerName || undefined,
      metadata: { payer_id: payerId ? String(payerId) : '', source: 'dlb-treasury' },
    });
    if (payerEin) await this._ensureEin(client, customer, payerEin);
    return customer;
  }

  static async _ensureEin(client, customer, ein) {
    const value = String(ein).replace(/\D/g, '');
    if (value.length !== 9) return;
    const formatted = `${value.slice(0, 2)}-${value.slice(2)}`;
    const existing = await client.customers.listTaxIds(customer.id, { limit: 10 });
    const has = (existing.data || []).some((t) => t.type === 'us_ein' && String(t.value).replace(/\D/g, '') === value);
    if (!has) await client.customers.createTaxId(customer.id, { type: 'us_ein', value: formatted });
  }

  /** Configured payer of the trust's fixed-income P&I (INCOME_OBLIGOR_*), never exposing the full EIN. */
  static incomeObligor() {
    const o = this.getConfig().incomeObligor;
    if (!o) return { configured: false, issues: ['INCOME_OBLIGOR_NAME not set'] };
    return { configured: true, payerId: o.payerId, name: o.name, email: o.email, role: o.role, einMasked: maskEin(o.ein), issues: o.ein ? [] : ['INCOME_OBLIGOR_EIN not set'] };
  }

  /**
   * Hosted Checkout link for an income payment owed by the configured obligor
   * (custodian/issuer of the trust's fixed income). Amount defaults to the
   * bond's coupon_per_period when bondId is given without amountCents.
   */
  static async createIncomePaymentLink({ bondId, amountCents, purpose = 'coupon_income', reference, description, paymentMethodTypes, successUrl, cancelUrl, createdBy = 'payment_server' } = {}) {
    const cfg = this.getConfig();
    const o = cfg.incomeObligor;
    if (!o) throw httpError('INCOME_OBLIGOR_NAME not configured', 503, 'INCOME_OBLIGOR_NOT_CONFIGURED');
    if (!INCOME_PURPOSES.has(purpose)) throw httpError(`purpose must be one of ${[...INCOME_PURPOSES].join(', ')}`, 400);
    let cents = amountCents == null ? null : Number(amountCents);
    let ref = reference || null;
    let desc = description || null;
    if (bondId) {
      if (!CouponService) throw httpError('CouponService unavailable', 503);
      const s = await CouponService.getCouponSchedule(bondId);
      if (cents == null) cents = Math.round(Number(s.coupon_per_period || 0) * 100);
      const due = s.next_coupon_date ? String(s.next_coupon_date).slice(0, 10) : 'na';
      ref = ref || `BOND-${bondId}-${purpose.toUpperCase()}-${due}`;
      desc = desc || `${s.bond_name || `Bond ${bondId}`} ${purpose.replace('_', ' ')} due ${due}`;
    }
    if (cents == null) throw httpError('amountCents or bondId is required', 400);
    return this.createCheckoutLink({
      amountCents: cents,
      paymentMethodTypes: paymentMethodTypes || ['us_bank_account'],
      payerId: o.payerId, payerName: o.name, payerEmail: o.email, payerEin: o.ein,
      reference: ref, purpose, description: desc || `${o.name} ${purpose.replace('_', ' ')}`,
      successUrl, cancelUrl, createdBy,
    });
  }

  static _validate({ amountCents, currency, paymentMethodTypes }, cfg) {
    const cents = Number(amountCents);
    if (!Number.isInteger(cents) || cents < 50) throw httpError('amountCents must be an integer >= 50', 400);
    if (String(currency || 'usd').toLowerCase() !== 'usd') throw httpError('Stripe intake settles USD only', 400);
    const methods = (paymentMethodTypes && paymentMethodTypes.length ? paymentMethodTypes : cfg.paymentMethodTypes)
      .map((m) => String(m).toLowerCase());
    for (const m of methods) {
      if (!METHODS.has(m)) throw httpError(`unsupported payment method type '${m}'`, 400);
      if (!cfg.paymentMethodTypes.includes(m)) throw httpError(`payment method type '${m}' is not enabled (STRIPE_INTAKE_PAYMENT_METHODS)`, 400);
    }
    return { cents, methods };
  }

  static _metadata({ intake, reference, purpose, payerId }) {
    return { dlb_intake_id: intake, reference: reference || '', purpose: purpose || 'treasury_funding', payer_id: payerId ? String(payerId) : '', destination: 'lili_direct_deposit' };
  }

  /** Server-side PaymentIntent for an integrated payer flow (client confirms with the client_secret). */
  static async createPaymentIntent({ amountCents, currency = 'usd', paymentMethodTypes, payerEmail, payerName, payerId, reference, purpose, description, createdBy = 'payment_server' } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw httpError('Stripe intake disabled', 503);
    const { cents, methods } = this._validate({ amountCents, currency, paymentMethodTypes }, cfg);
    const client = this._client(cfg);
    const customer = await this._ensureCustomer(client, { payerEmail, payerName, payerId });
    const id = intakeId();
    const params = {
      amount: cents, currency: 'usd', payment_method_types: methods,
      customer: customer ? customer.id : undefined,
      description: (description || reference || `DLB Trust funding ${id}`).slice(0, 1000),
      statement_descriptor_suffix: methods.includes('card') ? cfg.statementDescriptor.slice(0, 22) : undefined,
      metadata: this._metadata({ intake: id, reference, purpose, payerId }),
    };
    if (methods.includes('us_bank_account')) {
      params.payment_method_options = { us_bank_account: { financial_connections: { permissions: ['payment_method'] }, verification_method: 'automatic' } };
    }
    const pi = await client.paymentIntents.create(params, { idempotencyKey: `spi-${id}` });
    const row = {
      intake_id: id, payment_intent_id: pi.id, checkout_session_id: null, customer_id: customer ? customer.id : null,
      amount_cents: cents, currency: 'usd', status: 'created', payment_method_types: methods,
      payer_email: payerEmail || null, payer_name: payerName || null, reference: reference || null, purpose: purpose || null,
      checkout_url: null, created_by: createdBy,
    };
    await this._insert(row);
    return { ...rowToIntake(row), clientSecret: pi.client_secret, stripeStatus: pi.status };
  }

  /** Hosted Stripe Checkout link — payer pays in Stripe's UI, nothing card-related touches this server. */
  static async createCheckoutLink({ amountCents, currency = 'usd', paymentMethodTypes, payerEmail, payerName, payerId, payerEin, reference, purpose, description, successUrl, cancelUrl, createdBy = 'payment_server' } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw httpError('Stripe intake disabled', 503);
    const { cents, methods } = this._validate({ amountCents, currency, paymentMethodTypes }, cfg);
    const success = successUrl || (cfg.returnUrl ? `${cfg.returnUrl.replace(/\/$/, '')}/payment-server/stripe/return?status=success` : null);
    const cancel = cancelUrl || (cfg.returnUrl ? `${cfg.returnUrl.replace(/\/$/, '')}/payment-server/stripe/return?status=cancel` : null);
    if (!success) throw httpError('successUrl (or STRIPE_INTAKE_RETURN_URL) is required for Checkout', 400);
    const client = this._client(cfg);
    const customer = await this._ensureCustomer(client, { payerEmail, payerName, payerId, payerEin });
    const id = intakeId();
    const meta = this._metadata({ intake: id, reference, purpose, payerId });
    const session = await client.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: methods,
      customer: customer ? customer.id : undefined,
      customer_email: customer ? undefined : (payerEmail || undefined),
      line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: cents, product_data: { name: (description || purpose || 'DLB Trust treasury funding').slice(0, 250) } } }],
      success_url: success,
      cancel_url: cancel || success,
      client_reference_id: id,
      metadata: meta,
      payment_intent_data: { metadata: meta, description: (description || reference || `DLB Trust funding ${id}`).slice(0, 1000) },
    }, { idempotencyKey: `spi-cs-${id}` });
    const row = {
      intake_id: id, payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent && session.payment_intent.id) || null,
      checkout_session_id: session.id, customer_id: customer ? customer.id : null,
      amount_cents: cents, currency: 'usd', status: 'created', payment_method_types: methods,
      payer_email: payerEmail || null, payer_name: payerName || null, reference: reference || null, purpose: purpose || null,
      checkout_url: session.url, created_by: createdBy,
    };
    await this._insert(row);
    return { ...rowToIntake(row), expiresAt: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null };
  }

  /**
   * Stripe webhook. Verifies the signature against STRIPE_WEBHOOK_SECRET, then
   * on payment success records the treasury ledger deposit and marks the intake
   * `received`. Idempotent per PaymentIntent (ON CONFLICT / status guard).
   */
  static async handleWebhook(rawBody, signature) {
    const cfg = this.getConfig();
    if (!cfg._webhookSecret) throw httpError('STRIPE_WEBHOOK_SECRET not configured', 503, 'WEBHOOK_NOT_CONFIGURED');
    if (!rawBody || !signature) throw httpError('missing Stripe signature or raw body', 400);
    const client = this._client(cfg);
    let event;
    try {
      event = client.webhooks.constructEvent(rawBody, signature, cfg._webhookSecret);
    } catch (e) {
      throw httpError(`invalid Stripe webhook signature: ${e.message}`, 400, 'BAD_SIGNATURE');
    }
    if (cfg.keyMode === 'live' && event.livemode === false) throw httpError('test-mode event rejected on live intake', 400);

    const obj = event.data && event.data.object;
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        await this._link(obj);
        if (obj.payment_status === 'paid') return this._received(obj.payment_intent, obj, event);
        return { received: false, eventType: event.type, status: 'processing' };
      case 'checkout.session.async_payment_failed':
        await this._link(obj);
        return this._failed(obj.payment_intent, 'async payment failed', event);
      case 'payment_intent.processing':
        await this._setStatus(obj.id, 'processing', event.id);
        return { received: false, eventType: event.type, status: 'processing' };
      case 'payment_intent.succeeded':
        return this._received(obj.id, obj, event);
      case 'payment_intent.payment_failed':
        return this._failed(obj.id, (obj.last_payment_error && obj.last_payment_error.message) || 'payment failed', event);
      case 'payment_intent.canceled':
        await this._setStatus(obj.id, 'canceled', event.id);
        return { received: false, eventType: event.type, status: 'canceled' };
      default:
        return { received: false, eventType: event.type, ignored: true };
    }
  }

  static async _link(session) {
    if (!pool || !session || !session.id) return;
    const piId = typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent && session.payment_intent.id) || null;
    if (!piId) return;
    await pool.query('UPDATE stripe_payment_intakes SET payment_intent_id = COALESCE(payment_intent_id, $2), updated_at = NOW() WHERE checkout_session_id = $1', [session.id, piId]);
  }

  static async _received(piId, obj, event) {
    const pi = typeof piId === 'string' ? piId : (piId && piId.id);
    const row = await this._byPaymentIntent(pi);
    if (row && ['received', 'paid_out'].includes(row.status)) return { received: true, duplicate: true, intake: rowToIntake(row) };
    const cents = Number(obj.amount_received != null ? obj.amount_received : (obj.amount_total != null ? obj.amount_total : obj.amount));
    const meta = obj.metadata || {};
    const depositOrderId = await this._postDeposit({
      amount: cents / 100,
      rail: 'stripe_payments',
      source: `Stripe ${pi}`,
      cashAccountId: CASH_ACCOUNT,
      trustAccountCode: 'PTC-DEPOSIT-CLEARING',
      externalReference: pi,
      description: `Stripe payment ${meta.reference || meta.dlb_intake_id || pi}`,
      initiatedBy: 'stripe_webhook',
      metadata: { stripeEventId: event.id, intakeId: meta.dlb_intake_id || (row && row.intake_id) || null, purpose: meta.purpose || null },
    });
    if (pool) {
      if (row) {
        await pool.query(
          `UPDATE stripe_payment_intakes SET status='received', amount_cents=$2, deposit_order_id=$3, last_event_id=$4, received_at=NOW(), updated_at=NOW() WHERE payment_intent_id=$1`,
          [pi, cents, depositOrderId, event.id],
        );
      } else {
        await this._insert({
          intake_id: meta.dlb_intake_id || intakeId(), payment_intent_id: pi, checkout_session_id: null, customer_id: typeof obj.customer === 'string' ? obj.customer : null,
          amount_cents: cents, currency: 'usd', status: 'received', payment_method_types: obj.payment_method_types || ['card'],
          payer_email: (obj.receipt_email || (obj.customer_details && obj.customer_details.email)) || null, payer_name: null,
          reference: meta.reference || null, purpose: meta.purpose || null, checkout_url: null, created_by: 'stripe_webhook',
          deposit_order_id: depositOrderId, last_event_id: event.id, received_at: new Date(),
        });
      }
    }
    const received = rowToIntake(await this._byPaymentIntent(pi));
    await this._notifyIssuance(received && received.intakeId);
    return { received: true, eventType: event.type, paymentIntentId: pi, amountCents: cents, depositOrderId, intake: received };
  }

  /** Bond issuance payments waiting on this intake move to `funded`. Best-effort. */
  static async _notifyIssuance(intakeId) {
    if (!intakeId) return null;
    try {
      const { BondIssuanceEngine } = require('../bonds/bondIssuanceEngine');
      return await BondIssuanceEngine.markFunded(intakeId);
    } catch (e) { return null; }
  }

  static async _postDeposit(params) {
    if (!DepositAndSettlementEngine) return null;
    const dep = await DepositAndSettlementEngine.recordDeposit(params);
    return (dep && dep.orderId) || null;
  }

  static async _failed(piId, message, event) {
    const pi = typeof piId === 'string' ? piId : (piId && piId.id);
    if (pool && pi) await pool.query(`UPDATE stripe_payment_intakes SET status='failed', error_message=$2, last_event_id=$3, updated_at=NOW() WHERE payment_intent_id=$1 AND status NOT IN ('received','paid_out')`, [pi, String(message).slice(0, 500), event.id]);
    return { received: false, eventType: event.type, status: 'failed', paymentIntentId: pi, error: message };
  }

  static async _setStatus(pi, status, eventId) {
    if (pool && pi) await pool.query(`UPDATE stripe_payment_intakes SET status=$2, last_event_id=$3, updated_at=NOW() WHERE payment_intent_id=$1 AND status NOT IN ('received','paid_out')`, [pi, status, eventId]);
  }

  /** Marks a received intake as paid out to Lili (called by the payment-server payout route after clearAndSettle). */
  static async markPaidOut(intakeIdOrPi, liliSettlementId) {
    if (!pool) return null;
    const r = await pool.query(
      `UPDATE stripe_payment_intakes SET status='paid_out', lili_settlement_id=$2, updated_at=NOW()
       WHERE (intake_id=$1 OR payment_intent_id=$1) AND status='received' RETURNING *`,
      [intakeIdOrPi, liliSettlementId],
    );
    return rowToIntake(r.rows[0]);
  }

  static async get(id) {
    if (!pool) return null;
    const r = await pool.query('SELECT * FROM stripe_payment_intakes WHERE intake_id=$1 OR payment_intent_id=$1 OR checkout_session_id=$1', [id]);
    return rowToIntake(r.rows[0]);
  }

  static async list({ status, limit = 50 } = {}) {
    if (!pool) return [];
    const r = status
      ? await pool.query('SELECT * FROM stripe_payment_intakes WHERE status=$1 ORDER BY created_at DESC LIMIT $2', [status, limit])
      : await pool.query('SELECT * FROM stripe_payment_intakes ORDER BY created_at DESC LIMIT $1', [limit]);
    return r.rows.map(rowToIntake);
  }

  static async _byPaymentIntent(pi) {
    if (!pool || !pi) return null;
    const r = await pool.query('SELECT * FROM stripe_payment_intakes WHERE payment_intent_id=$1', [pi]);
    return r.rows[0] || null;
  }

  static async _insert(row) {
    if (!pool) return;
    await this.ensureTables();
    await pool.query(
      `INSERT INTO stripe_payment_intakes
         (intake_id, payment_intent_id, checkout_session_id, customer_id, amount_cents, currency, status, payment_method_types,
          payer_email, payer_name, reference, purpose, checkout_url, created_by, deposit_order_id, last_event_id, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (payment_intent_id) DO NOTHING`,
      [row.intake_id, row.payment_intent_id, row.checkout_session_id, row.customer_id, row.amount_cents, row.currency, row.status, row.payment_method_types,
        row.payer_email, row.payer_name, row.reference, row.purpose, row.checkout_url, row.created_by, row.deposit_order_id || null, row.last_event_id || null, row.received_at || null],
    );
  }
}

module.exports = { StripePaymentIntakeEngine, STRIPE_INTAKE_CASH_ACCOUNT: CASH_ACCOUNT };
