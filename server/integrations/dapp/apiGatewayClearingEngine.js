'use strict';

/**
 * API-gateway clearing & settlement for the Family Trust Company.
 *
 * One rail (`api_gateway`, or the provider-specific aliases `apigee` /
 * `apisix`) that every money-movement engine can dispatch to:
 *
 *   distribution / disbursement  -> PayoutCenterEngine.createPayment(rail)
 *   vendor bill pay              -> VendorPaymentEngine.payBill(rail)
 *   direct deposit / vendor payout (Payer OS) -> PayerOsEngine.send()
 *   settlement orders            -> SettlementEngine.executeSettlement()
 *
 * The engine resolves the configured gateway provider — Google Cloud Apigee
 * (ApigeeGatewayEngine, outbound via the hardened generic REST connector) or
 * Apache APISIX (ApacheApisixEngine) — and hands it the canonical wire/push
 * payload. Approval and compliance are NOT re-implemented here: callers reach
 * this engine only after the two-trustee maker/checker step and the
 * PaymentComplianceGate have passed, and this engine refuses to move money
 * without the caller's approval/screening references.
 *
 * GCP data storage: every clearing event is written to the ledger database
 * (Cloud SQL for PostgreSQL in infra/gcp) in `gateway_clearing_events`, and —
 * when GCS_CLEARING_EVIDENCE_BUCKET is set — the full request/response
 * evidence is also written as an object to that Cloud Storage bucket, so the
 * settlement record survives independently of the app instance.
 *
 * Gating: shadow by default. Money moves only when the resolved provider's
 * own live flag is on (`APIGEE_LIVE=true` / `APISIX_LIVE=true`).
 */

const crypto = require('crypto');

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const { getAccessToken, googleFetch, loadServiceAccount, onGoogleRuntime } = require('../google/googleServiceAccount');

let GoogleWalletEngine;
try { ({ GoogleWalletEngine } = require('./googleWalletEngine')); } catch (e) { GoogleWalletEngine = null; }
let LiliSettlementBankEngine;
try { ({ LiliSettlementBankEngine } = require('../payments/liliSettlementBankEngine')); } catch (e) { LiliSettlementBankEngine = null; }

const GATEWAY_RAILS = ['api_gateway', 'apigee', 'apisix'];
const PROVIDERS = ['lili', 'apigee', 'apisix'];
const LIVE_FLAG = { lili: 'LILI_CLEARING_LIVE', apigee: 'APIGEE_LIVE', apisix: 'APISIX_LIVE' };
const GCS_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';
const GCS_UPLOAD = 'https://storage.googleapis.com/upload/storage/v1/b';

const STAGES = [
  'request',
  'two_trustee_approval',
  'compliance_gate',
  'rail_routing',
  'gateway_settlement',
  'google_wallet_pass',
  'ledger_reconciliation',
];

function id(prefix) { return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }
function safeJson(v) { return JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? String(x) : x)); }
function mask(v) { const s = String(v || ''); return s ? `****${s.slice(-4)}` : null; }
function redactParty(p) {
  if (!p) return null;
  return {
    name: p.name || p.holderName || null,
    bankName: p.bankName || null,
    routingNumber: p.routingNumber || p.routing || null,
    accountLast4: mask(p.accountNumber || p.account),
    accountType: p.accountType || null,
  };
}

function osEngines() {
  try { return require('../os/osEngine'); } catch (e) { return null; }
}

class ApiGatewayClearingEngine {
  static get RAILS() { return GATEWAY_RAILS; }
  static get STAGES() { return STAGES; }

  static isGatewayRail(rail) { return GATEWAY_RAILS.includes(String(rail || '').toLowerCase()); }

  static getConfig() {
    const env = process.env;
    const apigeeConfigured = Boolean(env.APIGEE_BASE_URL || env.APIGEE_HOSTNAME);
    const liliConfigured = String(env.LILI_CLEARING_LIVE || '').toLowerCase() === 'true';
    const explicit = String(env.API_GATEWAY_PROVIDER || '').toLowerCase();
    const auto = liliConfigured ? 'lili' : (apigeeConfigured ? 'apigee' : 'apisix');
    return {
      provider: PROVIDERS.includes(explicit) ? explicit : auto,
      providerExplicit: PROVIDERS.includes(explicit),
      requireApproval: env.API_GATEWAY_REQUIRE_APPROVAL_REF !== 'false',
      requireScreening: env.API_GATEWAY_REQUIRE_SCREENING_REF !== 'false',
      evidenceBucket: (env.GCS_CLEARING_EVIDENCE_BUCKET || '').trim(),
      evidencePrefix: (env.GCS_CLEARING_EVIDENCE_PREFIX || 'clearing').replace(/^\/+|\/+$/g, ''),
      evidenceKeyEnv: 'GCP_CLEARING_SERVICE_ACCOUNT_KEY',
      gcpProject: env.GCP_PROJECT || env.GOOGLE_CLOUD_PROJECT || '',
    };
  }

  /** `lili` / `apigee` / `apisix` from an explicit rail alias or the configured default. */
  static resolveProvider(rail) {
    const r = String(rail || '').toLowerCase();
    if (PROVIDERS.includes(r)) return r;
    return this.getConfig().provider;
  }

  static engineFor(provider) {
    if (provider === 'lili') {
      if (!LiliSettlementBankEngine) throw new Error('Lili settlement bank engine is not available');
      return LiliSettlementBankEngine;
    }
    const os = osEngines();
    if (!os) throw new Error('OS engines are not available');
    const Engine = provider === 'apigee' ? os.ApigeeGatewayEngine : os.ApacheApisixEngine;
    if (!Engine) throw new Error(`gateway engine for provider ${provider} is not available`);
    return Engine;
  }

  static async ensureTables() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gateway_clearing_events (
        event_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        rail TEXT NOT NULL,
        flow TEXT NOT NULL,
        payment_type TEXT NOT NULL,
        reference TEXT,
        source_type TEXT,
        source_id TEXT,
        approval_ref TEXT,
        screening_ref TEXT,
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        status TEXT NOT NULL,
        live BOOLEAN NOT NULL DEFAULT false,
        gateway_reference TEXT,
        wallet_pass_object_id TEXT,
        evidence_uri TEXT,
        request JSONB DEFAULT '{}',
        response JSONB DEFAULT '{}',
        error_message TEXT,
        reconciled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_gateway_clearing_status ON gateway_clearing_events(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_gateway_clearing_ref ON gateway_clearing_events(reference)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_gateway_clearing_created ON gateway_clearing_events(created_at DESC)`);
  }

  // ─── GCS evidence ───────────────────────────────────────────────────────────

  static evidenceStore() {
    const cfg = this.getConfig();
    if (!cfg.evidenceBucket) return { enabled: false, bucket: null, reason: 'GCS_CLEARING_EVIDENCE_BUCKET not set' };
    let sa = null;
    let error = null;
    try { sa = loadServiceAccount({ keyEnv: cfg.evidenceKeyEnv }); } catch (e) { error = e.message; }
    const credentialed = Boolean(sa) || onGoogleRuntime();
    return {
      enabled: true,
      bucket: cfg.evidenceBucket,
      prefix: cfg.evidencePrefix,
      credential: sa ? sa.source : (onGoogleRuntime() ? 'runtime_identity' : null),
      ready: credentialed && !error,
      reason: error || (credentialed ? null : `no ${cfg.evidenceKeyEnv} and not running on Cloud Run`),
    };
  }

  static async _writeEvidence(eventId, document) {
    const store = this.evidenceStore();
    if (!store.enabled) return null;
    if (!store.ready) throw new Error(`clearing evidence bucket not writable: ${store.reason}`);
    const cfg = this.getConfig();
    const sa = loadServiceAccount({ keyEnv: cfg.evidenceKeyEnv });
    const token = await getAccessToken(sa, GCS_SCOPE);
    const day = new Date().toISOString().slice(0, 10);
    const objectName = `${store.prefix}/${day}/${eventId}.json`;
    const url = `${GCS_UPLOAD}/${encodeURIComponent(store.bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
    const res = await googleFetch('POST', url, token, safeJson(document), { headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) throw new Error(`GCS evidence upload failed: HTTP ${res.statusCode}`);
    return `gs://${store.bucket}/${objectName}`;
  }

  // ─── Persistence ────────────────────────────────────────────────────────────

  static async _insert(row) {
    if (!pool) return row;
    const keys = Object.keys(row);
    await pool.query(
      `INSERT INTO gateway_clearing_events (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
      keys.map((k) => (k === 'request' || k === 'response' ? safeJson(row[k] || {}) : row[k]))
    );
    return row;
  }

  static async _update(eventId, patch) {
    if (!pool) return null;
    const keys = Object.keys(patch);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const res = await pool.query(
      `UPDATE gateway_clearing_events SET ${sets}, updated_at = NOW() WHERE event_id = $1 RETURNING *`,
      [eventId, ...keys.map((k) => (k === 'request' || k === 'response' ? safeJson(patch[k] || {}) : patch[k]))]
    );
    return res.rows[0] || null;
  }

  static async getEvent(eventId) {
    if (!pool) return null;
    await this.ensureTables();
    const res = await pool.query('SELECT * FROM gateway_clearing_events WHERE event_id = $1', [eventId]);
    return res.rows[0] || null;
  }

  static async listEvents({ limit = 50, status, flow } = {}) {
    if (!pool) return [];
    await this.ensureTables();
    const where = [];
    const params = [];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (flow) { params.push(flow); where.push(`flow = $${params.length}`); }
    params.push(Math.min(Number(limit) || 50, 500));
    const res = await pool.query(
      `SELECT * FROM gateway_clearing_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    return res.rows;
  }

  // ─── Clearing ───────────────────────────────────────────────────────────────

  /**
   * Clear one approved, screened payment through the gateway.
   *
   * @param flow          'distribution' | 'disbursement' | 'vendor_bill' | 'direct_deposit' | 'vendor_payout' | 'settlement'
   * @param paymentType   'wire' | 'push' (push = direct-deposit style push credit)
   * @param approvalRef   maker/checker record (distribution request id, consensus proposal id, settlement id …)
   * @param screeningRef  PaymentComplianceGate / ComplianceEngine screening id
   * @param destination   { name, bankName, routingNumber, accountNumber, accountType }
   * @param source        optional ODFI override; defaults to the provider's configured settlement account
   * @param walletPass    optional { email, walletAddress, userId, role, name } → Google Wallet pass provisioned after settlement
   */
  static async clearPayment({
    rail = 'api_gateway',
    flow,
    paymentType = 'wire',
    amount,
    currency = 'USD',
    reference,
    description,
    sourceType,
    sourceId,
    approvalRef,
    screeningRef,
    source,
    destination,
    walletPass,
    initiatedBy = 'system',
  } = {}) {
    if (!this.isGatewayRail(rail)) throw Object.assign(new Error(`rail ${rail} is not an API-gateway rail (${GATEWAY_RAILS.join(', ')})`), { status: 400 });
    if (!flow) throw Object.assign(new Error('flow is required'), { status: 400 });
    const cfg = this.getConfig();
    if (cfg.requireApproval && !approvalRef) {
      throw Object.assign(new Error('approvalRef (maker/checker record) is required before the gateway will clear a payment'), { status: 409 });
    }
    if (cfg.requireScreening && !screeningRef) {
      throw Object.assign(new Error('screeningRef (compliance screening id) is required before the gateway will clear a payment'), { status: 409 });
    }
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) throw Object.assign(new Error('amount must be positive'), { status: 400 });
    if (!destination || !(destination.routingNumber || destination.routing) || !(destination.accountNumber || destination.account)) {
      throw Object.assign(new Error('destination routingNumber and accountNumber are required'), { status: 400 });
    }

    await this.ensureTables();
    const provider = this.resolveProvider(rail);
    const Engine = this.engineFor(provider);
    const providerCfg = Engine._cfg();
    const eventId = id('GWC');
    const ref = reference || eventId;
    const isPush = paymentType === 'push' || paymentType === 'direct_deposit';
    const requestSummary = {
      provider,
      paymentType: isPush ? 'push' : 'wire',
      amount: n,
      currency,
      reference: ref,
      description: description || null,
      destination: redactParty(destination),
      source: redactParty(source) || { configured: Boolean(providerCfg.sourceRouting && providerCfg.sourceAccount) },
      initiatedBy,
      walletPass: walletPass ? { email: walletPass.email || null, walletAddress: walletPass.walletAddress || null, role: walletPass.role || 'beneficiary' } : null,
    };

    await this._insert({
      event_id: eventId,
      provider,
      rail: String(rail).toLowerCase(),
      flow,
      payment_type: requestSummary.paymentType,
      reference: ref,
      source_type: sourceType || null,
      source_id: sourceId || null,
      approval_ref: approvalRef || null,
      screening_ref: screeningRef || null,
      amount_cents: Math.round(n * 100),
      currency,
      status: 'submitting',
      live: Boolean(providerCfg.live),
      request: requestSummary,
    });

    let transfer;
    try {
      transfer = await Engine._sendPayment({
        amount: n,
        currency,
        type: isPush ? 'push' : 'wire',
        pushToCard: false,
        source,
        destination,
        description: description || `${flow} ${ref}`,
        reference: ref,
      });
    } catch (e) {
      await this._update(eventId, { status: 'failed', error_message: e.message });
      throw e;
    }

    let pass = null;
    let passError = null;
    if (walletPass && GoogleWalletEngine) {
      try {
        pass = await GoogleWalletEngine.createPass({
          userId: walletPass.userId,
          email: walletPass.email,
          walletAddress: walletPass.walletAddress,
          role: walletPass.role,
          name: walletPass.name,
          walletName: walletPass.walletName || 'DLB Trust Distribution Account',
        });
      } catch (e) { passError = e.message; }
    }

    const status = transfer.shadow ? 'shadow' : (transfer.status || 'originated');
    const response = {
      transferId: transfer.transferId,
      gatewayStatus: transfer.status,
      live: Boolean(transfer.live),
      shadow: Boolean(transfer.shadow),
      walletPass: pass ? { objectId: pass.objectId, mode: pass.mode, signed: pass.signed } : null,
      walletPassError: passError,
    };

    let evidenceUri = null;
    let evidenceError = null;
    try {
      evidenceUri = await this._writeEvidence(eventId, {
        eventId, flow, approvalRef, screeningRef, request: requestSummary, response, at: new Date().toISOString(),
      });
    } catch (e) { evidenceError = e.message; }

    const row = await this._update(eventId, {
      status,
      gateway_reference: transfer.transferId || null,
      wallet_pass_object_id: pass ? pass.objectId : null,
      evidence_uri: evidenceUri,
      response,
      error_message: [passError && `wallet pass: ${passError}`, evidenceError && `evidence: ${evidenceError}`].filter(Boolean).join('; ') || null,
    });

    return {
      eventId,
      provider,
      rail: String(rail).toLowerCase(),
      flow,
      status,
      live: Boolean(transfer.live),
      shadow: Boolean(transfer.shadow),
      reference: ref,
      gatewayReference: transfer.transferId,
      amount: n,
      currency,
      walletPass: pass,
      walletPassError: passError,
      evidenceUri,
      evidenceError,
      record: row,
    };
  }

  /**
   * Ledger reconciliation hook: the gateway (or an operator reading the bank
   * statement) reports the final status for a cleared payment.
   */
  static async reconcile({ eventId, gatewayReference, status, note } = {}) {
    await this.ensureTables();
    if (!pool) throw new Error('Postgres pool unavailable');
    const allowed = new Set(['settled', 'completed', 'returned', 'failed']);
    if (!allowed.has(String(status || '').toLowerCase())) {
      throw Object.assign(new Error(`status must be one of ${[...allowed].join(', ')}`), { status: 400 });
    }
    let row = eventId ? await this.getEvent(eventId) : null;
    if (!row && gatewayReference) {
      const res = await pool.query('SELECT * FROM gateway_clearing_events WHERE gateway_reference = $1 ORDER BY created_at DESC LIMIT 1', [gatewayReference]);
      row = res.rows[0] || null;
    }
    if (!row) throw Object.assign(new Error('clearing event not found'), { status: 404 });
    return this._update(row.event_id, {
      status: String(status).toLowerCase(),
      reconciled_at: new Date(),
      response: { ...(row.response || {}), reconciliation: { status, note: note || null, at: new Date().toISOString() } },
    });
  }

  // ─── Readiness / pipeline ───────────────────────────────────────────────────

  static async readiness() {
    const cfg = this.getConfig();
    const settle = (p) => Promise.resolve().then(() => p).then((value) => ({ ok: true, value })).catch((e) => ({ ok: false, error: e.message }));
    let gateway = { ok: false, error: 'gateway engine unavailable' };
    try { gateway = await settle(this.engineFor(cfg.provider).status()); } catch (e) { gateway = { ok: false, error: e.message }; }

    let Compliance = null;
    try { ({ PaymentComplianceGate: Compliance } = require('../compliance/paymentComplianceGate')); } catch (e) { Compliance = null; }
    const compliance = Compliance
      ? await settle(Compliance.paymentReadiness({ rail: 'api_gateway' }))
      : { ok: false, error: 'PaymentComplianceGate not available' };

    const wallet = GoogleWalletEngine ? GoogleWalletEngine.readiness() : { ready: false, issues: ['GoogleWalletEngine not available'] };
    const evidence = this.evidenceStore();
    const ledgerDb = Boolean(pool);

    const blockers = [];
    if (!gateway.ok) blockers.push(`gateway: ${gateway.error}`);
    else if (!gateway.value.live) blockers.push(`gateway ${cfg.provider} is in shadow mode (${LIVE_FLAG[cfg.provider]}=false)`);
    else if (!gateway.value.healthy) blockers.push(`gateway ${cfg.provider} unreachable: ${gateway.value.message}`);
    if (!compliance.ok) blockers.push(`compliance: ${compliance.error}`);
    else if (!compliance.value.ready) blockers.push(`compliance: ${(compliance.value.issues || []).join('; ')}`);
    if (!ledgerDb) blockers.push('ledger database (Cloud SQL / DATABASE_URL) not connected');
    if (evidence.enabled && !evidence.ready) blockers.push(`evidence bucket: ${evidence.reason}`);

    return {
      engine: 'api_gateway_clearing',
      provider: cfg.provider,
      providerSource: cfg.providerExplicit ? 'API_GATEWAY_PROVIDER' : 'auto',
      rails: GATEWAY_RAILS,
      stages: STAGES,
      mode: gateway.ok && gateway.value.live ? 'live' : 'shadow',
      ready: blockers.length === 0,
      blockers,
      gateway: gateway.ok ? gateway.value : { error: gateway.error },
      compliance: compliance.ok ? { ready: compliance.value.ready, issues: compliance.value.issues } : { ready: false, error: compliance.error },
      googleWallet: { ready: wallet.ready, mode: wallet.mode, issues: wallet.issues, cardFunding: wallet.cardFunding },
      storage: {
        ledger: { connected: ledgerDb, table: 'gateway_clearing_events', backend: 'Cloud SQL for PostgreSQL (infra/gcp/cloudsql.tf) / DATABASE_URL' },
        evidence,
        gcpProject: cfg.gcpProject || null,
      },
      controls: { approvalRefRequired: cfg.requireApproval, screeningRefRequired: cfg.requireScreening },
      generatedAt: new Date().toISOString(),
    };
  }

  static async pipeline({ limit = 20 } = {}) {
    const settle = (p) => Promise.resolve().then(() => p).then((value) => ({ ok: true, value })).catch((e) => ({ ok: false, error: e.message }));
    let Funding = null;
    try { ({ CanonicalFundingSource: Funding } = require('../fineract/canonicalFundingSource')); } catch (e) { Funding = null; }
    const [readiness, events, ledger] = await Promise.all([
      settle(this.readiness()),
      settle(this.listEvents({ limit })),
      Funding ? settle(Funding.reconcile()) : Promise.resolve({ ok: false, error: 'CanonicalFundingSource not available' }),
    ]);
    const rows = events.ok ? events.value : [];
    const counts = rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
    return {
      pipeline: 'api_gateway_clearing_settlement',
      stages: STAGES,
      stageOwners: {
        request: 'POST /api/dapp/distribution-requests | /api/dapp/vendor-bills | /api/os/payer/disbursements | /api/dapp/settlements',
        two_trustee_approval: 'DistributionRequestEngine.approveRequest / CanonicalConsensusEngine (maker/checker)',
        compliance_gate: 'PaymentComplianceGate.screenVendorPayment / ComplianceEngine.screenRecipientForPayout',
        rail_routing: 'PayoutRouteEngine.plan(payoutRail=api_gateway|apigee|apisix|google_wallet)',
        gateway_settlement: 'ApiGatewayClearingEngine.clearPayment -> ApigeeGatewayEngine | ApacheApisixEngine',
        google_wallet_pass: 'GoogleWalletEngine.createPass (pass/link only; no card funding)',
        ledger_reconciliation: 'ApiGatewayClearingEngine.reconcile + CanonicalFundingSource.reconcile',
      },
      readiness: readiness.ok ? readiness.value : { ready: false, error: readiness.error },
      recentEvents: rows.map((r) => ({
        eventId: r.event_id, provider: r.provider, flow: r.flow, paymentType: r.payment_type, status: r.status,
        live: r.live, amountUsd: Number(r.amount_cents) / 100, currency: r.currency, reference: r.reference,
        gatewayReference: r.gateway_reference, walletPassObjectId: r.wallet_pass_object_id, evidenceUri: r.evidence_uri,
        reconciledAt: r.reconciled_at, createdAt: r.created_at,
      })),
      counts,
      ledger: ledger.ok ? ledger.value : { error: ledger.error },
      generatedAt: new Date().toISOString(),
    };
  }
}

module.exports = { ApiGatewayClearingEngine, GATEWAY_RAILS, PIPELINE_STAGES: STAGES };
