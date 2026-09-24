'use strict';

/**
 * Payment Gateway OS Engine — the gated disbursement gateway for trust
 * distributions and disbursements over PaymentGatewayServerEngine.
 *
 * The gateway is outbound-first: a beneficiary's payout instrument (ACH, card,
 * wallet, crypto) is tokenized once and every distribution / disbursement to it
 * is a `submit` (maker) → `approve` (distinct checker) intent.
 *
 *   tokenize()     store a beneficiary payout method (no money movement)
 *   methods()      tokenized payout methods (masked)
 *   processors()   which gateway processors are real-value capable and why not
 *   submit()       maker step: distribution/disbursement intent, bound to a
 *                  dapp_distribution_requests row when one is supplied
 *   approve()      checker step: real-value intents require approvalRef +
 *                  screeningRef, refuse self-loopback partners and, when bound to
 *                  a distribution request, require it to be two-trustee approved;
 *                  live dispatch goes through PaymentGatewayServerEngine.sale /
 *                  authorize / capture / refund / void
 *   status()       intent + gateway transaction state
 *   reconcile()    processor reference / status back onto the gateway transaction
 *   webhook()      HMAC-verified processor callback → reconcile
 *   pipeline()     open intents by status and purpose, live exposure
 *
 * Nothing leaves the platform unless PAYMENT_GATEWAY_LIVE=true AND the
 * underlying processor is real-value capable (PaymentProcessorOsEngine) AND the
 * checker supplied both references. Otherwise the approval is recorded in shadow
 * mode and no provider is called.
 */

const crypto = require('crypto');

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

function tryRequire(mod) {
  try { return require(mod); } catch (e) { return null; }
}

async function settle(fn) {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: e.message }; }
}

function httpError(message, status = 400) { return Object.assign(new Error(message), { status }); }
function isTrue(v) { return String(v || '').toLowerCase() === 'true'; }
function stripeKeyMode(key) {
  const k = String(key || '').trim();
  if (!k) return null;
  if (k.startsWith('sk_live_') || k.startsWith('rk_live_')) return 'live';
  if (k.startsWith('sk_test_') || k.startsWith('rk_test_')) return 'test';
  return 'unknown';
}

const TABLE = 'payment_gateway_intents';
const TABLES = [TABLE, 'payment_gateway_transactions', 'payment_methods', 'dapp_distribution_requests', 'os_events'];
const STATUSES = ['submitted', 'approved', 'shadow', 'executed', 'failed', 'cancelled'];
const PURPOSES = ['distribution', 'disbursement'];
const OPERATIONS = ['sale', 'authorize', 'capture', 'refund', 'void'];
const NEW_TX_OPERATIONS = new Set(['sale', 'authorize']);
const METHOD_TYPES = ['card', 'ach', 'wallet', 'crypto'];

const toCents = (amount) => Math.round(Number(amount) * 100);
const newId = () => 'PGI-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();

function rowToIntent(row) {
  if (!row) return null;
  return {
    intentId: row.intent_id,
    purpose: row.purpose,
    operation: row.operation,
    processor: row.processor,
    methodId: row.method_id,
    distributionRequestId: row.distribution_request_id,
    beneficiaryEmail: row.beneficiary_email,
    amountCents: Number(row.amount_cents),
    amount: Number(row.amount_cents) / 100,
    currency: row.currency,
    status: row.status,
    realValue: Boolean(row.real_value),
    reference: row.reference,
    destination: row.destination || {},
    metadata: row.metadata || {},
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    approvalRef: row.approval_ref,
    screeningRef: row.screening_ref,
    gatewayTxId: row.gateway_tx_id,
    processorTxId: row.processor_tx_id,
    route: row.route,
    result: row.result || null,
    error: row.error_message,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    executedAt: row.executed_at,
  };
}

class PaymentGatewayOsEngine {
  static get engineName() { return 'payment-gateway'; }
  static get TABLES() { return TABLES; }
  static get STATUSES() { return STATUSES; }
  static get PURPOSES() { return PURPOSES; }
  static get OPERATIONS() { return OPERATIONS; }

  static _gateway() { return tryRequire('../payments/paymentGatewayServerEngine')?.PaymentGatewayServerEngine || null; }
  static _processorOs() { return tryRequire('./paymentProcessorOsEngine')?.PaymentProcessorOsEngine || null; }
  static _distributions() { return tryRequire('../dapp/distributionRequestEngine')?.DistributionRequestEngine || null; }

  static async ensureTables() {
    if (!pool) return;
    const Gateway = this._gateway();
    if (Gateway && typeof Gateway.ensureTables === 'function') await Gateway.ensureTables();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        intent_id                VARCHAR(64) PRIMARY KEY,
        purpose                  VARCHAR(16) NOT NULL DEFAULT 'disbursement',
        operation                VARCHAR(16) NOT NULL DEFAULT 'sale',
        processor                VARCHAR(64),
        method_id                VARCHAR(64),
        distribution_request_id  TEXT,
        beneficiary_email        TEXT,
        amount_cents             BIGINT NOT NULL CHECK (amount_cents > 0),
        currency                 VARCHAR(3) NOT NULL DEFAULT 'USD',
        status                   VARCHAR(20) NOT NULL DEFAULT 'submitted',
        real_value               BOOLEAN NOT NULL DEFAULT FALSE,
        reference                TEXT,
        destination              JSONB DEFAULT '{}',
        metadata                 JSONB DEFAULT '{}',
        requested_by             VARCHAR(255),
        approved_by              VARCHAR(255),
        approval_ref             TEXT,
        screening_ref            TEXT,
        gateway_tx_id            TEXT,
        processor_tx_id          TEXT,
        route                    VARCHAR(64),
        result                   JSONB,
        error_message            TEXT,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        approved_at              TIMESTAMPTZ,
        executed_at              TIMESTAMPTZ
      )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pgi_status ON ${TABLE}(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pgi_distribution ON ${TABLE}(distribution_request_id)`);
  }

  // ── Configuration and processor inventory ──────────────────────────────

  static getConfig(env = process.env) {
    return {
      live: isTrue(env.PAYMENT_GATEWAY_LIVE),
      requireApproval: env.PAYMENT_GATEWAY_REQUIRE_APPROVAL_REF !== 'false',
      requireScreening: env.PAYMENT_GATEWAY_REQUIRE_SCREENING_REF !== 'false',
      requireDistributionRequest: isTrue(env.PAYMENT_GATEWAY_REQUIRE_DISTRIBUTION_REQUEST),
      defaultProcessor: env.PAYMENT_GATEWAY_DEFAULT_PROCESSOR || null,
      processorLive: isTrue(env.PAYMENT_PROCESSOR_LIVE),
      stripePaymentsKeyMode: stripeKeyMode(env.STRIPE_PAYMENTS_SECRET_KEY || env.STRIPE_SECRET_KEY),
      webhookSecret: Boolean(env.PAYMENT_GATEWAY_WEBHOOK_SECRET),
      encryptionKey: Boolean(env.PAYMENT_DATA_ENCRYPTION_KEY),
      maxDisbursementCents: Number(env.PAYMENT_GATEWAY_MAX_DISBURSEMENT_CENTS) > 0 ? Number(env.PAYMENT_GATEWAY_MAX_DISBURSEMENT_CENTS) : null,
    };
  }

  static isSelfLoopbackUrl(url, env = process.env) {
    const P = this._processorOs();
    if (P) return P.isSelfLoopbackUrl(url, env);
    const u = String(url || '').trim().toLowerCase();
    return !u ? false : /^(direct|local|self|loopback)$/.test(u) || /^https?:\/\/(localhost|127\.0\.0\.1)/.test(u);
  }

  /** Reject payout destinations that resolve to this platform (self-loopback partner). */
  static loopbackReason(destination = {}, processor) {
    const P = this._processorOs();
    if (P) return P.loopbackReason(destination, processor);
    const d = destination || {};
    if (d.loopback === true || d.selfLoopback === true) return 'destination flagged as self-loopback';
    for (const k of ['url', 'apiBaseUrl', 'partnerUrl', 'endpoint', 'webhookUrl', 'callbackUrl']) {
      if (d[k] && this.isSelfLoopbackUrl(d[k])) return `destination.${k}=${d[k]} points back at this platform`;
    }
    return null;
  }

  /**
   * Gateway processors: the payout rails a tokenized method can be disbursed
   * over. Real-value capability is inherited from the payment-processor engine
   * (the gateway only ever dispatches through it) and additionally requires
   * PAYMENT_GATEWAY_LIVE and the payment-data encryption key.
   */
  static async processors() {
    const cfg = this.getConfig();
    const P = this._processorOs();
    const upstream = P ? await settle(() => P.processors()) : { ok: false, error: 'PaymentProcessorOsEngine unavailable' };
    const upstreamById = upstream.ok ? Object.fromEntries(upstream.value.sources.map((s) => [s.id, s])) : {};
    const gate = !cfg.live ? 'PAYMENT_GATEWAY_LIVE=false'
      : !cfg.encryptionKey ? 'PAYMENT_DATA_ENCRYPTION_KEY not set (payout methods cannot be tokenized safely)'
        : !upstream.ok ? `payment-processor: ${upstream.error}`
          : !upstream.value.config.live ? 'PAYMENT_PROCESSOR_LIVE=false (gateway dispatches through the payment-processor engine)'
            : null;
    const entries = [
      { id: 'stripe_treasury', methodTypes: ['card', 'wallet'], liveFlag: 'STRIPE_PAYMENTS_SECRET_KEY', secrets: ['STRIPE_PAYMENTS_SECRET_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_TREASURY_FINANCIAL_ACCOUNT_ID'] },
      { id: 'lili', methodTypes: ['ach'], liveFlag: 'LILI_CLEARING_LIVE', secrets: ['LILI_OAUTH_CLIENT_ID', 'LILI_OAUTH_CLIENT_SECRET', 'LILI_OAUTH_REFRESH_TOKEN', 'LILI_DD_ACCOUNT_NUMBER'] },
      { id: 'clearing', methodTypes: ['ach'], liveFlag: 'CLEARING_API_ENDPOINT', secrets: ['CLEARING_API_KEY'] },
      { id: 'payment_hub', methodTypes: ['ach', 'wallet'], liveFlag: 'PAYMENT_HUB_LIVE', secrets: ['PAYMENT_HUB_AUTH_TOKEN', 'PAYMENT_HUB_SERVICE_TOKEN'] },
      { id: 'pdcflow', methodTypes: ['card', 'ach'], liveFlag: 'PDCFLOW_API_KEY', secrets: ['PDCFLOW_API_KEY', 'PDCFLOW_PASSWORD'] },
      { id: 'payout_center', methodTypes: ['wallet', 'crypto'], liveFlag: null, secrets: [] },
    ];
    const sources = entries.map((e) => {
      const up = upstreamById[e.id];
      const upstreamCapable = Boolean(up && up.realValueCapable);
      const reason = gate || (!up ? `${e.id} not in payment-processor inventory` : up.reason);
      return {
        ...e,
        mode: up ? up.mode : 'unset',
        configured: Boolean(up && up.configured),
        realValueCapable: !gate && upstreamCapable,
        reason: !gate && upstreamCapable ? null : reason,
        route: 'PaymentGatewayServerEngine → PaymentProcessorServerEngine.processPayment',
      };
    });
    const realValueCapable = sources.filter((s) => s.realValueCapable).map((s) => s.id);
    return { config: cfg, gate, sources, realValueCapable, anyRealValueCapable: realValueCapable.length > 0 };
  }

  static async isRealValue(processor, inventory) {
    const inv = inventory || await this.processors();
    const src = inv.sources.find((s) => s.id === processor);
    return Boolean(inv.config.live && src && src.realValueCapable);
  }

  // ── Payout methods (no money movement) ──────────────────────────────────

  static async tokenize({ type, processor, payload = {}, billingDetails = {}, memberId, beneficiaryEmail, initiatedBy } = {}) {
    const Gateway = this._gateway();
    if (!Gateway) throw httpError('PaymentGatewayServerEngine not available', 503);
    if (!METHOD_TYPES.includes(String(type || '').toLowerCase())) throw httpError(`type must be one of ${METHOD_TYPES.join(', ')}`);
    const cfg = this.getConfig();
    if (cfg.live && !cfg.encryptionKey) throw httpError('PAYMENT_DATA_ENCRYPTION_KEY is required to tokenize payout methods in live mode', 409);
    const method = await Gateway.tokenizePaymentMethod({
      type, processor, payload,
      billingDetails: { ...billingDetails, beneficiaryEmail: beneficiaryEmail || billingDetails.beneficiaryEmail || null },
      memberId: memberId || beneficiaryEmail || null,
      initiatedBy,
    });
    return method;
  }

  static async methods({ memberId, beneficiaryEmail, type, processor, limit = 50 } = {}) {
    const Gateway = this._gateway();
    if (!Gateway) throw httpError('PaymentGatewayServerEngine not available', 503);
    return Gateway.listMethods({ memberId: memberId || beneficiaryEmail, type, processor, limit });
  }

  static async disableMethod({ methodId } = {}) {
    const Gateway = this._gateway();
    if (!Gateway) throw httpError('PaymentGatewayServerEngine not available', 503);
    if (!methodId) throw httpError('methodId required');
    return Gateway.disableMethod(methodId);
  }

  // ── Distribution request binding ────────────────────────────────────────

  /** A bound distribution request must exist, match the amount and be two-trustee approved before dispatch. */
  static async _distributionGate(distributionRequestId, cents, { requireApproved = false } = {}) {
    if (!distributionRequestId) return null;
    const D = this._distributions();
    if (!D) throw httpError('DistributionRequestEngine not available', 503);
    const req = await D.getRequest(distributionRequestId);
    if (!req) throw httpError(`distribution request ${distributionRequestId} not found`, 404);
    if (['rejected', 'failed'].includes(req.status)) throw httpError(`distribution request ${distributionRequestId} is ${req.status}`, 409);
    if (Number(req.amount_cents) > 0 && Number(req.amount_cents) !== cents) {
      throw httpError(`amount ${cents} does not match distribution request ${distributionRequestId} (${req.amount_cents} cents)`, 409);
    }
    if (requireApproved && !['approved', 'payout_created'].includes(req.status)) {
      throw httpError(`distribution request ${distributionRequestId} must be approved by both trustees before dispatch (status ${req.status})`, 409);
    }
    return req;
  }

  // ── Maker / checker flow ───────────────────────────────────────────────

  static async submit({
    purpose = 'disbursement', operation = 'sale', processor, methodId, distributionRequestId, beneficiaryEmail,
    amount, amountCents, currency = 'USD', reference, destination = {}, metadata = {}, gatewayTxId,
    requestedBy, approvalRef, screeningRef,
  } = {}) {
    if (!pool) throw httpError('ledger database unavailable', 503);
    const cfg = this.getConfig();
    if (!PURPOSES.includes(purpose)) throw httpError(`purpose must be one of ${PURPOSES.join(', ')}`);
    if (!OPERATIONS.includes(operation)) throw httpError(`operation must be one of ${OPERATIONS.join(', ')}`);
    if (!requestedBy) throw httpError('requestedBy required');
    const cents = amountCents != null ? Math.round(Number(amountCents)) : toCents(amount);
    if (!Number.isFinite(cents) || cents <= 0) throw httpError('amount must be > 0');
    if (cfg.maxDisbursementCents && cents > cfg.maxDisbursementCents) {
      throw httpError(`amount ${cents} exceeds PAYMENT_GATEWAY_MAX_DISBURSEMENT_CENTS=${cfg.maxDisbursementCents}`, 409);
    }
    if (cfg.requireDistributionRequest && !distributionRequestId) throw httpError('distributionRequestId is required (PAYMENT_GATEWAY_REQUIRE_DISTRIBUTION_REQUEST=true)', 409);

    const Gateway = this._gateway();
    let method = null;
    if (NEW_TX_OPERATIONS.has(operation)) {
      if (!methodId) throw httpError('methodId (tokenized beneficiary payout method) required for sale/authorize');
      if (!Gateway) throw httpError('PaymentGatewayServerEngine not available', 503);
      method = await Gateway.getMethod(methodId);
      if (!method) throw httpError(`payment method ${methodId} not found`, 404);
      if (method.status && method.status !== 'active') throw httpError(`payment method ${methodId} is ${method.status}`, 409);
    } else if (!gatewayTxId) {
      throw httpError(`gatewayTxId required for ${operation}`);
    }
    const chosen = String(processor || (method && method.processor && method.processor !== 'generic' ? method.processor : '') || cfg.defaultProcessor || (Gateway ? Gateway._processorFromMethod(method) : '')).trim();
    if (!chosen) throw httpError('processor required');

    const loop = this.loopbackReason(destination, chosen);
    if (loop) throw httpError(`self-loopback partner refused: ${loop}`, 409);
    const dist = await this._distributionGate(distributionRequestId, cents);
    const realValue = await this.isRealValue(chosen);
    if (realValue) {
      if (cfg.requireApproval && !approvalRef) throw httpError('approvalRef (maker/checker record) is required for a real-value gateway disbursement', 409);
      if (cfg.requireScreening && !screeningRef) throw httpError('screeningRef (compliance screening id) is required for a real-value gateway disbursement', 409);
    }
    const id = newId();
    const res = await pool.query(
      `INSERT INTO ${TABLE} (intent_id, purpose, operation, processor, method_id, distribution_request_id, beneficiary_email, amount_cents, currency, status, real_value, reference, destination, metadata, requested_by, approval_ref, screening_ref, gateway_tx_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'submitted',$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17) RETURNING *`,
      [id, purpose, operation, chosen, methodId || null, distributionRequestId || null,
        beneficiaryEmail || (dist && dist.beneficiary_email) || (method && method.member_id) || null,
        cents, String(currency).toUpperCase(), realValue, reference || (dist && dist.id) || null,
        JSON.stringify(destination || {}), JSON.stringify({ ...(metadata || {}), methodType: method ? method.type : null }),
        requestedBy, approvalRef || null, screeningRef || null, NEW_TX_OPERATIONS.has(operation) ? null : gatewayTxId]
    );
    return rowToIntent(res.rows[0]);
  }

  static async approve({ intentId, approvedBy, approvalRef, screeningRef } = {}) {
    if (!pool) throw httpError('ledger database unavailable', 503);
    if (!intentId) throw httpError('intentId required');
    if (!approvedBy) throw httpError('approvedBy required');
    const row = await this._get(intentId);
    if (!row) throw httpError('intent not found', 404);
    if (row.status !== 'submitted') throw httpError(`intent ${intentId} is ${row.status}, expected submitted`, 409);
    if (row.requested_by && row.requested_by === approvedBy) throw httpError('maker/checker: approver must differ from requester', 409);

    const cfg = this.getConfig();
    const inventory = await this.processors();
    const loop = this.loopbackReason(row.destination, row.processor);
    if (loop) throw httpError(`self-loopback partner refused: ${loop}`, 409);
    const realValue = await this.isRealValue(row.processor, inventory);
    const aRef = approvalRef || row.approval_ref || null;
    const sRef = screeningRef || row.screening_ref || null;
    if (realValue) {
      if (cfg.requireApproval && !aRef) throw httpError('approvalRef (maker/checker record) is required before a real-value disbursement is dispatched', 409);
      if (cfg.requireScreening && !sRef) throw httpError('screeningRef (compliance screening id) is required before a real-value disbursement is dispatched', 409);
      await this._distributionGate(row.distribution_request_id, Number(row.amount_cents), { requireApproved: true });
    }

    await pool.query(
      `UPDATE ${TABLE} SET status = 'approved', approved_by = $2, approval_ref = $3, screening_ref = $4, real_value = $5, approved_at = NOW() WHERE intent_id = $1`,
      [intentId, approvedBy, aRef, sRef, realValue]
    );

    if (!realValue) {
      const src = inventory.sources.find((s) => s.id === row.processor);
      const note = inventory.gate || src?.reason || `${row.processor} is not real-value capable`;
      await pool.query(`UPDATE ${TABLE} SET status = 'shadow', route = 'shadow', result = $2::jsonb, executed_at = NOW() WHERE intent_id = $1`,
        [intentId, JSON.stringify({ mode: 'shadow', note })]);
      return { ...rowToIntent(await this._get(intentId)), dispatched: false, note };
    }

    const dispatch = await settle(() => this._dispatch({ ...rowToIntent(row), approvedBy, approvalRef: aRef, screeningRef: sRef }));
    if (!dispatch.ok) {
      await pool.query(`UPDATE ${TABLE} SET status = 'failed', error_message = $2, executed_at = NOW() WHERE intent_id = $1`, [intentId, dispatch.error]);
      throw httpError(`dispatch failed: ${dispatch.error}`, 502);
    }
    const { route, gatewayTxId, processorTxId, result } = dispatch.value;
    await pool.query(
      `UPDATE ${TABLE} SET status = 'executed', route = $2, gateway_tx_id = $3, processor_tx_id = $4, result = $5::jsonb, executed_at = NOW() WHERE intent_id = $1`,
      [intentId, route, gatewayTxId || null, processorTxId || null, JSON.stringify(result || {})]
    );
    if (row.distribution_request_id && NEW_TX_OPERATIONS.has(row.operation)) {
      const D = this._distributions();
      if (D && typeof D._update === 'function') {
        await settle(() => D._update(row.distribution_request_id, { status: 'payout_created', payout_id: gatewayTxId || null, metadata: { gatewayIntentId: intentId, gatewayTxId, processorTxId } }));
      }
    }
    return { ...rowToIntent(await this._get(intentId)), dispatched: true };
  }

  /** Real-value dispatch; only reached from approve() after every gate passed. */
  static async _dispatch(intent) {
    const Gateway = this._gateway();
    if (!Gateway) throw new Error('PaymentGatewayServerEngine not available');
    const metadata = {
      ...intent.metadata,
      purpose: intent.purpose,
      intentId: intent.intentId,
      distributionRequestId: intent.distributionRequestId,
      approvalRef: intent.approvalRef,
      screeningRef: intent.screeningRef,
      approvedBy: intent.approvedBy,
      processor: intent.processor,
    };
    const common = { amount: intent.amount, currency: intent.currency, methodId: intent.methodId, reference: intent.reference || intent.intentId, direction: 'outbound', destination: intent.destination, metadata, initiatedBy: intent.approvedBy };
    let tx;
    switch (intent.operation) {
      case 'sale': tx = await Gateway.sale({ ...common, processor: intent.processor }); break;
      case 'authorize': tx = await Gateway.authorize(common); break;
      case 'capture': tx = await Gateway.capture({ gatewayTxId: intent.gatewayTxId, amount: intent.amount, initiatedBy: intent.approvedBy }); break;
      case 'refund': tx = await Gateway.refund({ gatewayTxId: intent.gatewayTxId, amount: intent.amount, initiatedBy: intent.approvedBy, reason: intent.metadata.reason || intent.purpose }); break;
      case 'void': tx = await Gateway.void({ gatewayTxId: intent.gatewayTxId, initiatedBy: intent.approvedBy, reason: intent.metadata.reason || intent.purpose }); break;
      default: throw new Error(`unsupported gateway operation ${intent.operation}`);
    }
    return {
      route: `PaymentGatewayServerEngine.${intent.operation}`,
      gatewayTxId: tx.gatewayTxId || intent.gatewayTxId || null,
      processorTxId: tx.processorTxId || null,
      result: tx,
    };
  }

  static async cancel({ intentId, cancelledBy, reason } = {}) {
    if (!pool) throw httpError('ledger database unavailable', 503);
    const row = await this._get(intentId);
    if (!row) throw httpError('intent not found', 404);
    if (!['submitted', 'approved'].includes(row.status)) throw httpError(`intent ${intentId} is ${row.status}; cannot cancel`, 409);
    await pool.query(`UPDATE ${TABLE} SET status = 'cancelled', error_message = $2, result = $3::jsonb WHERE intent_id = $1`,
      [intentId, reason || null, JSON.stringify({ cancelledBy: cancelledBy || null, reason: reason || null })]);
    return rowToIntent(await this._get(intentId));
  }

  // ── Status / reconcile / webhook ────────────────────────────────────────

  static async intentStatus({ intentId, gatewayTxId } = {}) {
    if (!intentId && !gatewayTxId) throw httpError('intentId or gatewayTxId required');
    const row = intentId ? await this._get(intentId) : await this._getByTx(gatewayTxId);
    if (!row) throw httpError('intent not found', 404);
    const intent = rowToIntent(row);
    const Gateway = this._gateway();
    const tx = intent.gatewayTxId && Gateway ? await settle(() => Gateway.getStatus(intent.gatewayTxId)) : null;
    return { ...intent, transaction: tx ? (tx.ok ? tx.value : { error: tx.error }) : null };
  }

  static async reconcile({ intentId, gatewayTxId, processorTxId, status, raw = {} } = {}) {
    const Gateway = this._gateway();
    if (!Gateway) throw httpError('PaymentGatewayServerEngine not available', 503);
    let intent = null;
    if (intentId) intent = rowToIntent(await this._get(intentId));
    else if (gatewayTxId && pool) { const row = await this._getByTx(gatewayTxId); intent = row ? rowToIntent(row) : null; }
    if (intentId && !intent) throw httpError('intent not found', 404);
    const txId = gatewayTxId || (intent && intent.gatewayTxId) || null;
    if (!txId && !processorTxId) throw httpError('intent has no gateway transaction to reconcile', 409);
    const out = await Gateway.reconcileWebhook({ gatewayTxId: txId, processorTxId, status, raw });
    if (intent && pool) {
      await pool.query(`UPDATE ${TABLE} SET result = COALESCE(result, '{}'::jsonb) || $2::jsonb WHERE intent_id = $1`, [intent.intentId, JSON.stringify({ reconciliation: out })]);
    }
    return { intentId: intent ? intent.intentId : null, gatewayTxId: txId, reconciliation: out };
  }

  /** Processor callback: HMAC-SHA256 over the raw body with PAYMENT_GATEWAY_WEBHOOK_SECRET. */
  static verifyWebhookSignature(rawBody, signature, env = process.env) {
    const secret = env.PAYMENT_GATEWAY_WEBHOOK_SECRET;
    if (!secret) return { ok: false, reason: 'PAYMENT_GATEWAY_WEBHOOK_SECRET not set' };
    if (!signature) return { ok: false, reason: 'missing signature' };
    const expected = crypto.createHmac('sha256', secret).update(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody || {})).digest('hex');
    const given = String(signature).replace(/^sha256=/, '').trim();
    if (given.length !== expected.length) return { ok: false, reason: 'invalid signature' };
    const ok = crypto.timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(expected, 'utf8'));
    return ok ? { ok: true } : { ok: false, reason: 'invalid signature' };
  }

  static async webhook({ rawBody, signature, payload = {} } = {}) {
    const check = this.verifyWebhookSignature(rawBody ?? payload, signature);
    if (!check.ok) throw httpError(`webhook rejected: ${check.reason}`, 401);
    return this.reconcile({ gatewayTxId: payload.gatewayTxId, processorTxId: payload.processorTxId, status: payload.status, raw: payload });
  }

  static async listIntents({ status, purpose, processor, distributionRequestId, limit = 50 } = {}) {
    if (!pool) return [];
    const where = [];
    const params = [];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (purpose) { params.push(purpose); where.push(`purpose = $${params.length}`); }
    if (processor) { params.push(processor); where.push(`processor = $${params.length}`); }
    if (distributionRequestId) { params.push(distributionRequestId); where.push(`distribution_request_id = $${params.length}`); }
    params.push(Math.min(Number(limit) || 50, 500));
    const res = await pool.query(`SELECT * FROM ${TABLE} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return res.rows.map(rowToIntent);
  }

  static async pipeline() {
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, { count: 0, amountCents: 0 }]));
    const byPurpose = Object.fromEntries(PURPOSES.map((p) => [p, { count: 0, amountCents: 0 }]));
    let liveExposureCents = 0;
    if (pool) {
      const res = await pool.query(`SELECT status, purpose, real_value, COUNT(*)::int AS n, COALESCE(SUM(amount_cents),0)::bigint AS cents FROM ${TABLE} GROUP BY status, purpose, real_value`);
      for (const r of res.rows) {
        if (!byStatus[r.status]) byStatus[r.status] = { count: 0, amountCents: 0 };
        if (!byPurpose[r.purpose]) byPurpose[r.purpose] = { count: 0, amountCents: 0 };
        byStatus[r.status].count += Number(r.n);
        byStatus[r.status].amountCents += Number(r.cents);
        byPurpose[r.purpose].count += Number(r.n);
        byPurpose[r.purpose].amountCents += Number(r.cents);
        if (r.real_value && ['submitted', 'approved'].includes(r.status)) liveExposureCents += Number(r.cents);
      }
    }
    return { byStatus, byPurpose, liveExposureCents, gates: { approvalRef: true, screeningRef: true, distinctApprover: true, selfLoopbackRefused: true, distributionRequestApproved: true } };
  }

  static async status() {
    const [inventory, pipeline] = await Promise.all([this.processors(), settle(() => this.pipeline())]);
    return {
      engine: 'payment-gateway',
      healthy: Boolean(this._gateway()),
      mode: inventory.config.live && inventory.anyRealValueCapable ? 'live' : 'shadow',
      live: inventory.config.live,
      gate: inventory.gate,
      realValueCapable: inventory.anyRealValueCapable,
      realValueProcessors: inventory.realValueCapable,
      processors: inventory.sources,
      purposes: PURPOSES,
      operations: OPERATIONS,
      integrations: { gateway: Boolean(this._gateway()), paymentProcessorOs: Boolean(this._processorOs()), distributionRequests: Boolean(this._distributions()), webhookSecret: inventory.config.webhookSecret },
      pipeline: pipeline.ok ? pipeline.value : { error: pipeline.error },
      timestamp: new Date().toISOString(),
    };
  }

  static async readiness() {
    const { EngineWiringReadiness } = require('./engineWiringReadiness');
    return EngineWiringReadiness.engineReadiness('payment-gateway');
  }

  static async _get(id) {
    const res = await pool.query(`SELECT * FROM ${TABLE} WHERE intent_id = $1`, [id]);
    return res.rows[0] || null;
  }

  static async _getByTx(txId) {
    const res = await pool.query(`SELECT * FROM ${TABLE} WHERE gateway_tx_id = $1 OR processor_tx_id = $1 ORDER BY created_at DESC LIMIT 1`, [txId]);
    return res.rows[0] || null;
  }
}

module.exports = { PaymentGatewayOsEngine };
