'use strict';

/**
 * Payment Processor OS Engine — the gated front door to every payment
 * processor rail behind PaymentProcessorServerEngine.processPayment,
 * PaymentGatewayServerEngine and PaymentHubEngine.
 *
 *   processors()   per-processor inventory: configured, live flag, real-value
 *                  capable and the exact reason it is not
 *   submit()       maker step: records a submission (no provider call)
 *   approve()      checker step (distinct approver): a real-value submission
 *                  requires approvalRef + screeningRef (the ApiGatewayClearingEngine /
 *                  BankSettlementEngine fail-closed rule) and refuses self-loopback
 *                  partners before anything is dispatched; the Lili rail is routed
 *                  through BankSettlementEngine / ApiGatewayClearingEngine, every
 *                  other processor through PaymentProcessorServerEngine.processPayment
 *   status()       submission + processor / settlement transaction state
 *   reconcile()    external reference / status back onto the transaction
 *   pipeline()     open submissions by status, live exposure
 *
 * Nothing leaves the platform unless PAYMENT_PROCESSOR_LIVE=true AND the chosen
 * processor is real-value capable AND the checker supplied both references.
 * Otherwise the approval is recorded in shadow mode and no provider is called.
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

const TABLE = 'payment_processor_submissions';
const TABLES = [TABLE, 'payment_processor_transactions', 'payment_gateway_transactions', 'payment_intents', 'payment_approvals', 'os_events'];
const STATUSES = ['submitted', 'approved', 'shadow', 'executed', 'failed', 'cancelled'];
const LILI_PROCESSORS = new Set(['lili', 'lili_bank', 'lili_settlement']);
const GATEWAY_RAILS = new Set(['api_gateway', 'apigee', 'apisix']);

const toCents = (amount) => Math.round(Number(amount) * 100);
const newId = () => 'PPS-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();

function rowToSubmission(row) {
  if (!row) return null;
  return {
    submissionId: row.submission_id,
    processor: row.processor,
    rail: row.rail,
    direction: row.direction,
    amountCents: Number(row.amount_cents),
    amount: Number(row.amount_cents) / 100,
    currency: row.currency,
    status: row.status,
    realValue: Boolean(row.real_value),
    reference: row.reference,
    source: row.source || {},
    destination: row.destination || {},
    metadata: row.metadata || {},
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    approvalRef: row.approval_ref,
    screeningRef: row.screening_ref,
    processorTxId: row.processor_tx_id,
    settlementId: row.settlement_id,
    route: row.route,
    result: row.result || null,
    error: row.error_message,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    executedAt: row.executed_at,
  };
}

class PaymentProcessorOsEngine {
  static get engineName() { return 'payment-processor'; }
  static get TABLES() { return TABLES; }
  static get STATUSES() { return STATUSES; }

  static _processor() { return tryRequire('../payments/paymentProcessorServerEngine')?.PaymentProcessorServerEngine || null; }
  static _gateway() { return tryRequire('../payments/paymentGatewayServerEngine')?.PaymentGatewayServerEngine || null; }
  static _hub() { return tryRequire('../paymentHub/paymentHubEngine')?.PaymentHubEngine || null; }
  static _hubConfig() { return tryRequire('../paymentHub/paymentHubConfig'); }
  static _settlement() { return tryRequire('../payments/bankSettlementEngine')?.BankSettlementEngine || null; }
  static _gatewayClearing() { return tryRequire('../dapp/apiGatewayClearingEngine')?.ApiGatewayClearingEngine || null; }
  static _lili() { return tryRequire('../payments/liliDirectDepositEngine')?.LiliDirectDepositEngine || null; }

  static async ensureTables() {
    if (!pool) return;
    const Processor = this._processor();
    const Gateway = this._gateway();
    if (Processor && typeof Processor.ensureTables === 'function') await Processor.ensureTables();
    if (Gateway && typeof Gateway.ensureTables === 'function') await Gateway.ensureTables();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        submission_id    VARCHAR(64) PRIMARY KEY,
        processor        VARCHAR(64) NOT NULL,
        rail             VARCHAR(64),
        direction        VARCHAR(16) NOT NULL DEFAULT 'outbound',
        amount_cents     BIGINT NOT NULL CHECK (amount_cents > 0),
        currency         VARCHAR(3) NOT NULL DEFAULT 'USD',
        status           VARCHAR(20) NOT NULL DEFAULT 'submitted',
        real_value       BOOLEAN NOT NULL DEFAULT FALSE,
        reference        TEXT,
        source           JSONB DEFAULT '{}',
        destination      JSONB DEFAULT '{}',
        metadata         JSONB DEFAULT '{}',
        requested_by     VARCHAR(255),
        approved_by      VARCHAR(255),
        approval_ref     TEXT,
        screening_ref    TEXT,
        processor_tx_id  TEXT,
        settlement_id    TEXT,
        route            VARCHAR(64),
        result           JSONB,
        error_message    TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        approved_at      TIMESTAMPTZ,
        executed_at      TIMESTAMPTZ
      )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pps_status ON ${TABLE}(status)`);
  }

  // ── Configuration and processor inventory ──────────────────────────────

  static getConfig(env = process.env) {
    return {
      live: isTrue(env.PAYMENT_PROCESSOR_LIVE),
      requireApproval: env.PAYMENT_PROCESSOR_REQUIRE_APPROVAL_REF !== 'false',
      requireScreening: env.PAYMENT_PROCESSOR_REQUIRE_SCREENING_REF !== 'false',
      defaultProcessor: env.PAYMENT_PROCESSOR_DEFAULT || null,
      stripeKeyMode: stripeKeyMode(env.STRIPE_SECRET_KEY),
      stripePaymentsKeyMode: stripeKeyMode(env.STRIPE_PAYMENTS_SECRET_KEY),
      stripeTreasuryAccount: Boolean(env.STRIPE_TREASURY_FINANCIAL_ACCOUNT_ID),
      paymentHubLive: isTrue(env.PAYMENT_HUB_LIVE),
      liliClearingLive: isTrue(env.LILI_CLEARING_LIVE),
      clearingApiEndpoint: (env.CLEARING_API_ENDPOINT || '').trim() || null,
      clearingApiKey: Boolean(env.CLEARING_API_KEY),
      pdcflowConfigured: Boolean(env.PDCFLOW_API_KEY || env.PDCFLOW_USERNAME),
      skrillConfigured: Boolean(env.SKRILL_MERCHANT_EMAIL || env.SKRILL_API_PASSWORD),
      encryptionKey: Boolean(env.PAYMENT_DATA_ENCRYPTION_KEY),
    };
  }

  /**
   * URLs that never leave this platform (`direct`/`local`, our own APP_URL /
   * DEPLOY_URL / DOMAIN) are self-loopback partners: a payment "sent" there is
   * posted back to us and never reaches a bank or processor.
   */
  static isSelfLoopbackUrl(url, env = process.env) {
    const u = String(url || '').trim().toLowerCase().replace(/\/+$/, '');
    if (!u) return false;
    if (u === 'direct' || u === 'local' || u === 'self' || u === 'loopback') return true;
    if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/.test(u)) return true;
    const self = [env.APP_URL, env.DEPLOY_URL, env.DOMAIN && `https://${env.DOMAIN}`, env.K_SERVICE_URL]
      .filter(Boolean).map((s) => String(s).trim().toLowerCase().replace(/\/+$/, ''));
    return self.some((s) => s && (u === s || u.startsWith(s + '/')));
  }

  /** Reject destinations that resolve to this platform (self-loopback partner). */
  static loopbackReason(destination = {}, processor, cfg = this.getConfig()) {
    const d = destination || {};
    if (d.loopback === true || d.selfLoopback === true) return 'destination flagged as self-loopback';
    const urlKeys = ['url', 'apiBaseUrl', 'partnerUrl', 'endpoint', 'webhookUrl', 'callbackUrl'];
    for (const k of urlKeys) {
      if (d[k] && this.isSelfLoopbackUrl(d[k])) return `destination.${k}=${d[k]} points back at this platform`;
    }
    const partner = String(d.partnerId || d.partnerAs2Id || d.odfiPartner || '').trim();
    if (partner && (/^DLBTRUST-DIRECT$/i.test(partner) || /-(DIRECT|LOOPBACK|SELF)$/i.test(partner))) {
      return `partner ${partner} is a self-loopback partner`;
    }
    if (processor === 'clearing' && cfg.clearingApiEndpoint && this.isSelfLoopbackUrl(cfg.clearingApiEndpoint)) {
      return `CLEARING_API_ENDPOINT=${cfg.clearingApiEndpoint} points back at this platform`;
    }
    if (processor === 'web_payment_rail' && d.rail && this.isSelfLoopbackUrl(d.rail)) return `web payment rail ${d.rail} points back at this platform`;
    return null;
  }

  static async processors() {
    const cfg = this.getConfig();
    const Processor = this._processor();
    const hubConfig = this._hubConfig();
    const hub = hubConfig ? await settle(() => hubConfig.readiness()) : { ok: false, error: 'paymentHubConfig unavailable' };
    const Lili = this._lili();
    const odfi = Lili ? await settle(() => Lili.odfiStatus()) : { ok: false, error: 'LiliDirectDepositEngine unavailable' };
    const inventory = Processor && typeof Processor.getProcessors === 'function' ? Processor.getProcessors() : [];
    const byName = Object.fromEntries(inventory.map((p) => [p.name, p]));

    const entries = [
      {
        id: 'stripe_treasury',
        liveFlag: 'STRIPE_SECRET_KEY',
        mode: cfg.stripeKeyMode || 'unset',
        realValueCapable: cfg.stripeKeyMode === 'live' && cfg.stripeTreasuryAccount,
        reason: !cfg.stripeKeyMode ? 'STRIPE_SECRET_KEY not set'
          : cfg.stripeKeyMode === 'test' ? 'STRIPE_SECRET_KEY is sk_test_ (test mode)'
            : cfg.stripeKeyMode !== 'live' ? 'STRIPE_SECRET_KEY is not a live key'
              : !cfg.stripeTreasuryAccount ? 'STRIPE_TREASURY_FINANCIAL_ACCOUNT_ID not set' : null,
        secrets: ['STRIPE_SECRET_KEY', 'STRIPE_TREASURY_FINANCIAL_ACCOUNT_ID', 'STRIPE_PAYMENTS_SECRET_KEY'],
      },
      {
        id: 'payment_hub',
        liveFlag: 'PAYMENT_HUB_LIVE',
        mode: cfg.paymentHubLive ? 'live' : 'shadow',
        realValueCapable: cfg.paymentHubLive && hub.ok && Boolean(hub.value.canTransmit),
        reason: !cfg.paymentHubLive ? 'PAYMENT_HUB_LIVE=false'
          : !hub.ok ? `payment hub: ${hub.error}`
            : !hub.value.canTransmit ? `payment hub: ${(hub.value.issues || []).join('; ') || 'cannot transmit'}` : null,
        secrets: ['PAYMENT_HUB_AUTH_TOKEN', 'PAYMENT_HUB_SERVICE_TOKEN', 'PAYMENT_HUB_WEBHOOK_SECRET'],
      },
      {
        id: 'lili',
        liveFlag: 'LILI_CLEARING_LIVE',
        mode: cfg.liliClearingLive ? 'live' : 'shadow',
        realValueCapable: cfg.liliClearingLive && odfi.ok && Boolean(odfi.value.ready),
        reason: !cfg.liliClearingLive ? 'LILI_CLEARING_LIVE=false'
          : !odfi.ok ? `Lili ODFI: ${odfi.error}`
            : !odfi.value.ready ? `Lili ODFI: ${odfi.value.blocker}` : null,
        loopback: odfi.ok ? odfi.value.loopback || [] : [],
        route: 'BankSettlementEngine.clearAndSettle(bankId=lili) / ApiGatewayClearingEngine.clearPayment',
        secrets: ['LILI_OAUTH_CLIENT_ID', 'LILI_OAUTH_CLIENT_SECRET', 'LILI_OAUTH_REFRESH_TOKEN', 'LILI_BUSINESS_USER_ID', 'LILI_DD_ACCOUNT_NUMBER', 'PAYMENT_SERVER_SERVICE_TOKEN'],
      },
      {
        id: 'clearing',
        liveFlag: 'CLEARING_API_ENDPOINT',
        mode: cfg.clearingApiEndpoint ? 'live' : 'shadow',
        realValueCapable: Boolean(cfg.clearingApiEndpoint) && !this.isSelfLoopbackUrl(cfg.clearingApiEndpoint) && cfg.clearingApiKey,
        reason: !cfg.clearingApiEndpoint ? 'CLEARING_API_ENDPOINT not set'
          : this.isSelfLoopbackUrl(cfg.clearingApiEndpoint) ? `CLEARING_API_ENDPOINT=${cfg.clearingApiEndpoint} is a self-loopback`
            : !cfg.clearingApiKey ? 'CLEARING_API_KEY not set' : null,
        secrets: ['CLEARING_API_KEY'],
      },
      {
        id: 'pdcflow',
        liveFlag: 'PDCFLOW_API_KEY',
        mode: cfg.pdcflowConfigured ? 'live' : 'shadow',
        realValueCapable: cfg.pdcflowConfigured,
        reason: cfg.pdcflowConfigured ? null : 'PDCFLOW_API_KEY / PDCFLOW_USERNAME not set',
        secrets: ['PDCFLOW_API_KEY', 'PDCFLOW_PASSWORD'],
      },
      {
        id: 'skrill',
        liveFlag: 'SKRILL_MERCHANT_EMAIL',
        mode: cfg.skrillConfigured ? 'live' : 'shadow',
        realValueCapable: false,
        reason: 'Skrill-to-Skrill only (never real-value capable)',
        secrets: ['SKRILL_API_PASSWORD'],
      },
      { id: 'deposit_settlement', liveFlag: null, mode: 'ledger', realValueCapable: false, reason: 'internal ledger settlement (no external value)', secrets: [] },
      { id: 'payout_center', liveFlag: null, mode: 'ledger', realValueCapable: false, reason: 'internal payout center (no external value)', secrets: [] },
      { id: 'web_payment_rail', liveFlag: null, mode: 'ledger', realValueCapable: false, reason: 'internal web payment rail (no external value)', secrets: [] },
    ];
    const sources = entries.map((e) => ({
      ...e,
      configured: (e.mode !== 'unset' && e.mode !== 'shadow') || Boolean(byName[e.id]?.available),
      available: Boolean(byName[e.id]?.available),
      rails: byName[e.id]?.rails || [],
    }));
    const realValueCapable = sources.filter((s) => s.realValueCapable).map((s) => s.id);
    return { config: cfg, sources, realValueCapable, anyRealValueCapable: realValueCapable.length > 0 };
  }

  /** Whether an approved submission on `processor` would move real value if dispatched. */
  static async isRealValue(processor, inventory) {
    const inv = inventory || await this.processors();
    const src = inv.sources.find((s) => s.id === processor);
    return Boolean(inv.config.live && src && src.realValueCapable);
  }

  // ── Maker / checker flow ───────────────────────────────────────────────

  static async submit({ processor, rail, direction = 'outbound', amount, amountCents, currency = 'USD', source = {}, destination = {}, reference, metadata = {}, requestedBy, approvalRef, screeningRef } = {}) {
    if (!pool) throw httpError('ledger database unavailable', 503);
    const cfg = this.getConfig();
    const chosen = String(processor || cfg.defaultProcessor || '').trim();
    if (!chosen) throw httpError('processor required');
    const cents = amountCents != null ? Math.round(Number(amountCents)) : toCents(amount);
    if (!Number.isFinite(cents) || cents <= 0) throw httpError('amount must be > 0');
    if (!requestedBy) throw httpError('requestedBy required');
    const loop = this.loopbackReason(destination, chosen, cfg);
    if (loop) throw httpError(`self-loopback partner refused: ${loop}`, 409);
    const realValue = await this.isRealValue(chosen);
    if (realValue) {
      if (cfg.requireApproval && !approvalRef) throw httpError('approvalRef (maker/checker record) is required for a real-value payment processor submission', 409);
      if (cfg.requireScreening && !screeningRef) throw httpError('screeningRef (compliance screening id) is required for a real-value payment processor submission', 409);
    }
    const id = newId();
    const res = await pool.query(
      `INSERT INTO ${TABLE} (submission_id, processor, rail, direction, amount_cents, currency, status, real_value, reference, source, destination, metadata, requested_by, approval_ref, screening_ref)
       VALUES ($1,$2,$3,$4,$5,$6,'submitted',$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14) RETURNING *`,
      [id, chosen, rail || null, direction, cents, String(currency).toUpperCase(), realValue, reference || null,
        JSON.stringify(source || {}), JSON.stringify(destination || {}), JSON.stringify(metadata || {}), requestedBy, approvalRef || null, screeningRef || null]
    );
    return rowToSubmission(res.rows[0]);
  }

  static async approve({ submissionId, approvedBy, approvalRef, screeningRef } = {}) {
    if (!pool) throw httpError('ledger database unavailable', 503);
    if (!submissionId) throw httpError('submissionId required');
    if (!approvedBy) throw httpError('approvedBy required');
    const row = await this._get(submissionId);
    if (!row) throw httpError('submission not found', 404);
    if (row.status !== 'submitted') throw httpError(`submission ${submissionId} is ${row.status}, expected submitted`, 409);
    if (row.requested_by && row.requested_by === approvedBy) throw httpError('maker/checker: approver must differ from requester', 409);

    const cfg = this.getConfig();
    const inventory = await this.processors();
    const loop = this.loopbackReason(row.destination, row.processor, cfg);
    if (loop) throw httpError(`self-loopback partner refused: ${loop}`, 409);
    const realValue = await this.isRealValue(row.processor, inventory);
    const aRef = approvalRef || row.approval_ref || null;
    const sRef = screeningRef || row.screening_ref || null;
    if (realValue) {
      if (cfg.requireApproval && !aRef) throw httpError('approvalRef (maker/checker record) is required before a real-value payment is dispatched', 409);
      if (cfg.requireScreening && !sRef) throw httpError('screeningRef (compliance screening id) is required before a real-value payment is dispatched', 409);
    }

    await pool.query(
      `UPDATE ${TABLE} SET status = 'approved', approved_by = $2, approval_ref = $3, screening_ref = $4, real_value = $5, approved_at = NOW() WHERE submission_id = $1`,
      [submissionId, approvedBy, aRef, sRef, realValue]
    );

    if (!realValue) {
      const src = inventory.sources.find((s) => s.id === row.processor);
      const note = !cfg.live ? 'PAYMENT_PROCESSOR_LIVE is not true' : (src?.reason || `${row.processor} is not real-value capable`);
      await pool.query(`UPDATE ${TABLE} SET status = 'shadow', route = 'shadow', result = $2::jsonb, executed_at = NOW() WHERE submission_id = $1`,
        [submissionId, JSON.stringify({ mode: 'shadow', note })]);
      return { ...rowToSubmission(await this._get(submissionId)), dispatched: false, note };
    }

    const dispatch = await settle(() => this._dispatch({ ...rowToSubmission(row), approvedBy, approvalRef: aRef, screeningRef: sRef }));
    if (!dispatch.ok) {
      await pool.query(`UPDATE ${TABLE} SET status = 'failed', error_message = $2, executed_at = NOW() WHERE submission_id = $1`, [submissionId, dispatch.error]);
      throw httpError(`dispatch failed: ${dispatch.error}`, 502);
    }
    const { route, processorTxId, settlementId, result } = dispatch.value;
    await pool.query(
      `UPDATE ${TABLE} SET status = 'executed', route = $2, processor_tx_id = $3, settlement_id = $4, result = $5::jsonb, executed_at = NOW() WHERE submission_id = $1`,
      [submissionId, route, processorTxId || null, settlementId || null, JSON.stringify(result || {})]
    );
    return { ...rowToSubmission(await this._get(submissionId)), dispatched: true };
  }

  /** Real-value dispatch; only reached from approve() after every gate passed. */
  static async _dispatch(sub) {
    const common = {
      amount: sub.amount,
      amountCents: sub.amountCents,
      currency: sub.currency,
      reference: sub.reference || sub.submissionId,
      description: sub.metadata.description || `payment-processor ${sub.submissionId}`,
      approvalRef: sub.approvalRef,
      screeningRef: sub.screeningRef,
      source: sub.source,
      destination: sub.destination,
      initiatedBy: sub.approvedBy,
    };
    if (LILI_PROCESSORS.has(sub.processor)) {
      if (GATEWAY_RAILS.has(String(sub.rail || ''))) {
        const GatewayClearing = this._gatewayClearing();
        if (!GatewayClearing) throw new Error('ApiGatewayClearingEngine not available');
        const ev = await GatewayClearing.clearPayment({ ...common, rail: sub.rail, flow: 'payment_processor', paymentType: sub.metadata.paymentType || 'ach', sourceType: 'payment_processor_submission', sourceId: sub.submissionId });
        return { route: 'ApiGatewayClearingEngine.clearPayment', settlementId: ev.eventId || ev.id || null, result: ev };
      }
      const Settlement = this._settlement();
      if (!Settlement) throw new Error('BankSettlementEngine not available');
      const ev = await Settlement.clearAndSettle({ ...common, bankId: sub.destination.bankId || 'lili', rail: sub.rail || 'ach', paymentType: 'payment_processor', flow: 'payment_processor' });
      return { route: 'BankSettlementEngine.clearAndSettle', settlementId: ev.settlementId || null, result: ev };
    }
    const Processor = this._processor();
    if (!Processor) throw new Error('PaymentProcessorServerEngine not available');
    const tx = await Processor.processPayment({
      processor: sub.processor,
      rail: sub.rail,
      direction: sub.direction,
      amount: sub.amount,
      currency: sub.currency,
      source: sub.source,
      destination: sub.destination,
      reference: sub.reference || sub.submissionId,
      metadata: { ...sub.metadata, submissionId: sub.submissionId, approvalRef: sub.approvalRef, screeningRef: sub.screeningRef, approvedBy: sub.approvedBy },
      initiatedBy: sub.approvedBy,
    });
    return { route: 'PaymentProcessorServerEngine.processPayment', processorTxId: tx.processorTxId || null, result: tx };
  }

  static async cancel({ submissionId, cancelledBy, reason } = {}) {
    if (!pool) throw httpError('ledger database unavailable', 503);
    const row = await this._get(submissionId);
    if (!row) throw httpError('submission not found', 404);
    if (!['submitted', 'approved'].includes(row.status)) throw httpError(`submission ${submissionId} is ${row.status}; cannot cancel`, 409);
    await pool.query(`UPDATE ${TABLE} SET status = 'cancelled', error_message = $2, result = $3::jsonb WHERE submission_id = $1`,
      [submissionId, reason || null, JSON.stringify({ cancelledBy: cancelledBy || null, reason: reason || null })]);
    return rowToSubmission(await this._get(submissionId));
  }

  // ── Status / reconcile ──────────────────────────────────────────────────

  static async submissionStatus({ submissionId, processorTxId } = {}) {
    if (!submissionId && !processorTxId) throw httpError('submissionId or processorTxId required');
    const row = submissionId ? await this._get(submissionId) : await this._getByTx(processorTxId);
    if (!row) throw httpError('submission not found', 404);
    const sub = rowToSubmission(row);
    const Processor = this._processor();
    const Settlement = this._settlement();
    const [tx, settlement] = await Promise.all([
      sub.processorTxId && Processor ? settle(() => Processor.getStatus(sub.processorTxId)) : Promise.resolve(null),
      sub.settlementId && Settlement ? settle(() => Settlement.get(sub.settlementId)) : Promise.resolve(null),
    ]);
    return { ...sub, transaction: tx ? (tx.ok ? tx.value : { error: tx.error }) : null, settlement: settlement ? (settlement.ok ? settlement.value : { error: settlement.error }) : null };
  }

  static async reconcile({ submissionId, processorTxId, externalReference, status, rawResponse, initiatedBy } = {}) {
    const sub = await this.submissionStatus({ submissionId, processorTxId });
    if (sub.settlementId) {
      const Settlement = this._settlement();
      if (!Settlement) throw httpError('BankSettlementEngine not available', 503);
      const out = await Settlement.reconcile(sub.settlementId, {});
      await pool.query(`UPDATE ${TABLE} SET result = COALESCE(result, '{}'::jsonb) || $2::jsonb WHERE submission_id = $1`, [sub.submissionId, JSON.stringify({ reconciliation: out })]);
      return { submissionId: sub.submissionId, route: sub.route, reconciliation: out };
    }
    if (!sub.processorTxId) throw httpError('submission has no processor transaction to reconcile', 409);
    const Processor = this._processor();
    if (!Processor) throw httpError('PaymentProcessorServerEngine not available', 503);
    const out = await Processor.reconcile({ txId: sub.processorTxId, externalReference, status, rawResponse, initiatedBy });
    await pool.query(`UPDATE ${TABLE} SET result = COALESCE(result, '{}'::jsonb) || $2::jsonb WHERE submission_id = $1`, [sub.submissionId, JSON.stringify({ reconciliation: out })]);
    return { submissionId: sub.submissionId, route: sub.route, reconciliation: out };
  }

  static async listSubmissions({ status, processor, limit = 50 } = {}) {
    if (!pool) return [];
    const where = [];
    const params = [];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (processor) { params.push(processor); where.push(`processor = $${params.length}`); }
    params.push(Math.min(Number(limit) || 50, 500));
    const sql = `SELECT * FROM ${TABLE} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $${params.length}`;
    const res = await pool.query(sql, params);
    return res.rows.map(rowToSubmission);
  }

  static async pipeline() {
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, { count: 0, amountCents: 0 }]));
    let liveExposureCents = 0;
    if (pool) {
      const res = await pool.query(`SELECT status, real_value, COUNT(*)::int AS n, COALESCE(SUM(amount_cents),0)::bigint AS cents FROM ${TABLE} GROUP BY status, real_value`);
      for (const r of res.rows) {
        if (!byStatus[r.status]) byStatus[r.status] = { count: 0, amountCents: 0 };
        byStatus[r.status].count += Number(r.n);
        byStatus[r.status].amountCents += Number(r.cents);
        if (r.real_value && ['submitted', 'approved'].includes(r.status)) liveExposureCents += Number(r.cents);
      }
    }
    return { byStatus, liveExposureCents, gates: { approvalRef: true, screeningRef: true, distinctApprover: true, selfLoopbackRefused: true } };
  }

  static async status() {
    const [inventory, pipeline] = await Promise.all([this.processors(), settle(() => this.pipeline())]);
    const Gateway = this._gateway();
    const Hub = this._hub();
    return {
      engine: 'payment-processor',
      healthy: Boolean(this._processor()),
      mode: inventory.config.live && inventory.anyRealValueCapable ? 'live' : 'shadow',
      live: inventory.config.live,
      realValueCapable: inventory.anyRealValueCapable,
      realValueProcessors: inventory.realValueCapable,
      processors: inventory.sources,
      integrations: { processor: Boolean(this._processor()), gateway: Boolean(Gateway), paymentHub: Boolean(Hub), bankSettlement: Boolean(this._settlement()), gatewayClearing: Boolean(this._gatewayClearing()) },
      pipeline: pipeline.ok ? pipeline.value : { error: pipeline.error },
      timestamp: new Date().toISOString(),
    };
  }

  static async readiness() {
    const { EngineWiringReadiness } = require('./engineWiringReadiness');
    return EngineWiringReadiness.engineReadiness('payment-processor');
  }

  static async _get(id) {
    const res = await pool.query(`SELECT * FROM ${TABLE} WHERE submission_id = $1`, [id]);
    return res.rows[0] || null;
  }

  static async _getByTx(txId) {
    const res = await pool.query(`SELECT * FROM ${TABLE} WHERE processor_tx_id = $1 OR settlement_id = $1 ORDER BY created_at DESC LIMIT 1`, [txId]);
    return res.rows[0] || null;
  }
}

module.exports = { PaymentProcessorOsEngine };
