'use strict';

/**
 * Enterprise Network OS Engine — DLB Trust Platform
 *
 * Control plane for the trust network: which participants may transact with
 * the trust, how payouts to them are routed, and how much open exposure each
 * participant may carry. This engine never moves money; the private payment
 * network (privatePaymentNetworkOsEngine) reads the registry it maintains.
 *
 *   submit()       maker records a network change intent
 *                  (onboard / update / suspend / reinstate participant,
 *                   set routing policy, set exposure limit)
 *   approve()      checker (distinct from maker) applies the change
 *   cancel()       withdraw a submitted intent
 *   participants() / participant() / exposure() / resolveRoute()
 *   reconcile()    open exposure vs. limit per participant, screening events
 *   webhook()      HMAC-verified screening / partner callback → reconcile
 *   pipeline()     intents by status and kind, registry counts, breaches
 *
 * A change only becomes an active registry entry when
 * ENTERPRISE_NETWORK_LIVE=true AND the checker supplied an approvalRef (and a
 * screeningRef for participant onboarding / update / reinstatement).
 * Otherwise the approval is recorded in shadow mode: registry rows are written
 * with status 'shadow' and the payment network will not dispatch real value
 * against them. Suspensions only restrict the network, so they take effect in
 * either mode once a checker approves them.
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

const TABLE = 'enterprise_network_intents';
const PARTICIPANTS_TABLE = 'enterprise_network_participants';
const POLICIES_TABLE = 'enterprise_network_routing_policies';
const LIMITS_TABLE = 'enterprise_network_exposure_limits';
const PAYMENT_NETWORK_TABLE = 'private_payment_network_transactions';
const TABLES = [TABLE, PARTICIPANTS_TABLE, POLICIES_TABLE, LIMITS_TABLE, 'os_events'];
const STATUSES = ['submitted', 'approved', 'shadow', 'applied', 'failed', 'cancelled'];
const KINDS = ['onboard_participant', 'update_participant', 'suspend_participant', 'reinstate_participant', 'set_routing_policy', 'set_exposure_limit'];
const PARTICIPANT_KINDS = new Set(['onboard_participant', 'update_participant', 'reinstate_participant']);
const PARTICIPANT_TYPES = ['beneficiary', 'vendor', 'counterparty', 'bank', 'processor', 'custodian', 'affiliate'];
const PARTICIPANT_STATUSES = ['shadow', 'active', 'suspended'];
const RAILS = ['ach', 'wire', 'card', 'wallet', 'crypto', 'book'];
const OPEN_PAYMENT_STATUSES = ['submitted', 'approved', 'cleared'];
const SCREENING_HOLD_EVENTS = new Set(['screening.hit', 'screening.match', 'participant.suspended', 'sanctions.hit']);

const newId = (prefix) => `${prefix}-` + Date.now() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();

function rowToIntent(row) {
  if (!row) return null;
  return {
    intentId: row.intent_id,
    kind: row.kind,
    participantId: row.participant_id,
    payload: row.payload || {},
    status: row.status,
    live: Boolean(row.live),
    reason: row.reason,
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    approvalRef: row.approval_ref,
    screeningRef: row.screening_ref,
    result: row.result || null,
    error: row.error_message,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    appliedAt: row.applied_at,
  };
}

function rowToParticipant(row) {
  if (!row) return null;
  return {
    participantId: row.participant_id,
    name: row.name,
    participantType: row.participant_type,
    status: row.status,
    jurisdiction: row.jurisdiction,
    endpoint: row.endpoint || {},
    screeningRef: row.screening_ref,
    approvalRef: row.approval_ref,
    metadata: row.metadata || {},
    onboardedBy: row.onboarded_by,
    approvedBy: row.approved_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToPolicy(row) {
  if (!row) return null;
  return {
    policyId: row.policy_id,
    participantId: row.participant_id,
    rail: row.rail,
    processor: row.processor,
    priority: Number(row.priority),
    maxAmountCents: row.max_amount_cents == null ? null : Number(row.max_amount_cents),
    status: row.status,
    metadata: row.metadata || {},
    updatedAt: row.updated_at,
  };
}

function rowToLimit(row) {
  if (!row) return null;
  return {
    participantId: row.participant_id,
    limitCents: Number(row.limit_cents),
    currency: row.currency,
    status: row.status,
    approvalRef: row.approval_ref,
    updatedAt: row.updated_at,
  };
}

class EnterpriseNetworkOsEngine {
  static get engineName() { return 'enterprise-network'; }
  static get TABLES() { return TABLES; }
  static get STATUSES() { return STATUSES; }
  static get KINDS() { return KINDS; }
  static get PARTICIPANT_TYPES() { return PARTICIPANT_TYPES; }
  static get RAILS() { return RAILS; }

  static _processorOs() { return tryRequire('./paymentProcessorOsEngine')?.PaymentProcessorOsEngine || null; }

  static async ensureTables() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        intent_id       VARCHAR(64) PRIMARY KEY,
        kind            VARCHAR(32) NOT NULL,
        participant_id  VARCHAR(64),
        payload         JSONB NOT NULL DEFAULT '{}',
        status          VARCHAR(20) NOT NULL DEFAULT 'submitted',
        live            BOOLEAN NOT NULL DEFAULT FALSE,
        reason          TEXT,
        requested_by    VARCHAR(255),
        approved_by     VARCHAR(255),
        approval_ref    TEXT,
        screening_ref   TEXT,
        result          JSONB,
        error_message   TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        approved_at     TIMESTAMPTZ,
        applied_at      TIMESTAMPTZ
      )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_eni_status ON ${TABLE}(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_eni_participant ON ${TABLE}(participant_id)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${PARTICIPANTS_TABLE} (
        participant_id    VARCHAR(64) PRIMARY KEY,
        name              TEXT NOT NULL,
        participant_type  VARCHAR(32) NOT NULL,
        status            VARCHAR(20) NOT NULL DEFAULT 'shadow',
        jurisdiction      VARCHAR(64),
        endpoint          JSONB DEFAULT '{}',
        screening_ref     TEXT,
        approval_ref      TEXT,
        metadata          JSONB DEFAULT '{}',
        onboarded_by      VARCHAR(255),
        approved_by       VARCHAR(255),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${POLICIES_TABLE} (
        policy_id         VARCHAR(64) PRIMARY KEY,
        participant_id    VARCHAR(64),
        rail              VARCHAR(16) NOT NULL,
        processor         VARCHAR(64),
        priority          INTEGER NOT NULL DEFAULT 100,
        max_amount_cents  BIGINT,
        status            VARCHAR(20) NOT NULL DEFAULT 'shadow',
        metadata          JSONB DEFAULT '{}',
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_enrp_participant_rail ON ${POLICIES_TABLE}(participant_id, rail)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${LIMITS_TABLE} (
        participant_id  VARCHAR(64) PRIMARY KEY,
        limit_cents     BIGINT NOT NULL CHECK (limit_cents >= 0),
        currency        VARCHAR(3) NOT NULL DEFAULT 'USD',
        status          VARCHAR(20) NOT NULL DEFAULT 'shadow',
        approval_ref    TEXT,
        updated_by      VARCHAR(255),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
  }

  // ── Configuration ──────────────────────────────────────────────────────

  static getConfig(env = process.env) {
    return {
      live: isTrue(env.ENTERPRISE_NETWORK_LIVE),
      requireApproval: env.ENTERPRISE_NETWORK_REQUIRE_APPROVAL_REF !== 'false',
      requireScreening: env.ENTERPRISE_NETWORK_REQUIRE_SCREENING_REF !== 'false',
      webhookSecret: Boolean(env.ENTERPRISE_NETWORK_WEBHOOK_SECRET),
    };
  }

  static isSelfLoopbackUrl(url, env = process.env) {
    const P = this._processorOs();
    if (P) return P.isSelfLoopbackUrl(url, env);
    const u = String(url || '').trim().toLowerCase();
    return !u ? false : /^(direct|local|self|loopback)$/.test(u) || /^https?:\/\/(localhost|127\.0\.0\.1)/.test(u);
  }

  /** Participants whose endpoint resolves back to this platform are refused (self-loopback partner). */
  static loopbackReason(endpoint = {}, processor) {
    const partner = String(endpoint?.partnerAs2Id || '').trim();
    const station = String(tryRequire('../edi/mftGatewayClient')?.MftGatewayClient?.getConfig().stationAs2Id || '').trim();
    if (partner && station && partner.toUpperCase() === station.toUpperCase()) return `partner ${partner} is this platform's own AS2 station`;
    const P = this._processorOs();
    if (P) return P.loopbackReason(endpoint || {}, processor);
    const d = endpoint || {};
    if (d.loopback === true || d.selfLoopback === true) return 'endpoint flagged as self-loopback';
    for (const k of ['url', 'apiBaseUrl', 'partnerUrl', 'endpoint', 'webhookUrl', 'callbackUrl']) {
      if (d[k] && this.isSelfLoopbackUrl(d[k])) return `endpoint.${k}=${d[k]} points back at this platform`;
    }
    return null;
  }

  static _changeLoopback(kind, payload = {}) {
    if (kind === 'set_routing_policy') return this.loopbackReason(payload.policy?.destination || {}, payload.policy?.processor);
    if (PARTICIPANT_KINDS.has(kind)) return this.loopbackReason(payload.participant?.endpoint || {});
    return null;
  }

  // ── Maker / checker flow ───────────────────────────────────────────────

  static async submit({ kind, participantId, participant = {}, policy = {}, limit = {}, reason, requestedBy, approvalRef, screeningRef } = {}) {
    if (!pool) throw httpError('ledger database unavailable', 503);
    if (!KINDS.includes(kind)) throw httpError(`kind must be one of ${KINDS.join(', ')}`);
    if (!requestedBy) throw httpError('requestedBy required');

    let pid = participantId || null;
    const payload = {};
    if (kind === 'onboard_participant') {
      if (!participant.name) throw httpError('participant.name required');
      if (!PARTICIPANT_TYPES.includes(participant.type)) throw httpError(`participant.type must be one of ${PARTICIPANT_TYPES.join(', ')}`);
      pid = pid || newId('ENP');
      if (await this._participantRow(pid)) throw httpError(`participant ${pid} already exists`, 409);
      payload.participant = { name: participant.name, type: participant.type, jurisdiction: participant.jurisdiction || null, endpoint: participant.endpoint || {}, metadata: participant.metadata || {} };
    } else if (kind === 'set_routing_policy') {
      const rail = String(policy.rail || '').toLowerCase();
      if (!RAILS.includes(rail)) throw httpError(`policy.rail must be one of ${RAILS.join(', ')}`);
      if (rail !== 'book' && !policy.processor) throw httpError('policy.processor required for external rails');
      const priority = policy.priority == null ? 100 : Number(policy.priority);
      if (!Number.isInteger(priority) || priority < 0) throw httpError('policy.priority must be a non-negative integer');
      const maxAmountCents = policy.maxAmountCents == null ? null : Math.round(Number(policy.maxAmountCents));
      if (maxAmountCents != null && (!Number.isFinite(maxAmountCents) || maxAmountCents <= 0)) throw httpError('policy.maxAmountCents must be > 0');
      if (pid && !(await this._participantRow(pid))) throw httpError(`participant ${pid} not found`, 404);
      payload.policy = { policyId: policy.policyId || newId('ENR'), rail, processor: policy.processor || null, priority, maxAmountCents, destination: policy.destination || {}, metadata: policy.metadata || {} };
    } else {
      if (!pid) throw httpError('participantId required');
      const existing = await this._participantRow(pid);
      if (!existing) throw httpError(`participant ${pid} not found`, 404);
      if (kind === 'update_participant') {
        payload.participant = {};
        for (const k of ['name', 'jurisdiction', 'endpoint', 'metadata']) if (participant[k] !== undefined) payload.participant[k] = participant[k];
        if (participant.type !== undefined) {
          if (!PARTICIPANT_TYPES.includes(participant.type)) throw httpError(`participant.type must be one of ${PARTICIPANT_TYPES.join(', ')}`);
          payload.participant.type = participant.type;
        }
      } else if (kind === 'reinstate_participant') {
        if (existing.status !== 'suspended') throw httpError(`participant ${pid} is ${existing.status}, not suspended`, 409);
      } else if (kind === 'suspend_participant') {
        if (existing.status === 'suspended') throw httpError(`participant ${pid} is already suspended`, 409);
      } else if (kind === 'set_exposure_limit') {
        const cents = limit.limitCents != null ? Math.round(Number(limit.limitCents)) : Math.round(Number(limit.limit) * 100);
        if (!Number.isFinite(cents) || cents < 0) throw httpError('limit.limitCents must be >= 0');
        payload.limit = { limitCents: cents, currency: String(limit.currency || 'USD').toUpperCase() };
      }
    }

    const loop = this._changeLoopback(kind, payload);
    if (loop) throw httpError(`self-loopback partner refused: ${loop}`, 409);

    const id = newId('ENI');
    const res = await pool.query(
      `INSERT INTO ${TABLE} (intent_id, kind, participant_id, payload, status, reason, requested_by, approval_ref, screening_ref)
       VALUES ($1,$2,$3,$4::jsonb,'submitted',$5,$6,$7,$8) RETURNING *`,
      [id, kind, pid, JSON.stringify(payload), reason || null, requestedBy, approvalRef || null, screeningRef || null]
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

    const intent = rowToIntent(row);
    const loop = this._changeLoopback(intent.kind, intent.payload);
    if (loop) throw httpError(`self-loopback partner refused: ${loop}`, 409);

    const cfg = this.getConfig();
    const restrictive = intent.kind === 'suspend_participant';
    if (cfg.live && !restrictive) {
      if (cfg.requireApproval && !approvalRef) throw httpError('approvalRef (maker/checker record) is required from the checker before a network change goes live', 409);
      if (cfg.requireScreening && PARTICIPANT_KINDS.has(intent.kind) && !screeningRef) {
        throw httpError('screeningRef (compliance screening id) is required from the checker before a participant goes live', 409);
      }
    }
    const live = cfg.live || restrictive;

    await pool.query(
      `UPDATE ${TABLE} SET status = 'approved', approved_by = $2, approval_ref = $3, screening_ref = $4, live = $5, approved_at = NOW() WHERE intent_id = $1`,
      [intentId, approvedBy, approvalRef || null, screeningRef || null, live]
    );

    const applied = await settle(() => this._apply({ ...intent, approvedBy, approvalRef: approvalRef || null, screeningRef: screeningRef || null }, live));
    if (!applied.ok) {
      await pool.query(`UPDATE ${TABLE} SET status = 'failed', error_message = $2, applied_at = NOW() WHERE intent_id = $1`, [intentId, applied.error]);
      throw httpError(`apply failed: ${applied.error}`, 500);
    }
    const note = live ? null : 'ENTERPRISE_NETWORK_LIVE=false: registry entry recorded in shadow mode';
    await pool.query(`UPDATE ${TABLE} SET status = $2, result = $3::jsonb, applied_at = NOW() WHERE intent_id = $1`,
      [intentId, live ? 'applied' : 'shadow', JSON.stringify({ mode: live ? 'live' : 'shadow', note, ...applied.value })]);
    return { ...rowToIntent(await this._get(intentId)), applied: live, note };
  }

  /** Writes the registry change; only reached from approve(). */
  static async _apply(intent, live) {
    const entryStatus = live ? 'active' : 'shadow';
    const pid = intent.participantId;
    switch (intent.kind) {
      case 'onboard_participant': {
        const p = intent.payload.participant || {};
        await pool.query(
          `INSERT INTO ${PARTICIPANTS_TABLE} (participant_id, name, participant_type, status, jurisdiction, endpoint, screening_ref, approval_ref, metadata, onboarded_by, approved_by)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10,$11)`,
          [pid, p.name, p.type, entryStatus, p.jurisdiction || null, JSON.stringify(p.endpoint || {}), intent.screeningRef, intent.approvalRef, JSON.stringify(p.metadata || {}), intent.requestedBy, intent.approvedBy]
        );
        return { participantId: pid, participantStatus: entryStatus };
      }
      case 'update_participant': {
        const p = intent.payload.participant || {};
        await pool.query(
          `UPDATE ${PARTICIPANTS_TABLE} SET
             name = COALESCE($2, name), participant_type = COALESCE($3, participant_type), jurisdiction = COALESCE($4, jurisdiction),
             endpoint = COALESCE($5::jsonb, endpoint), metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE($6::jsonb, '{}'::jsonb),
             status = CASE WHEN status = 'suspended' THEN status ELSE $7 END,
             screening_ref = COALESCE($8, screening_ref), approval_ref = COALESCE($9, approval_ref), approved_by = $10, updated_at = NOW()
           WHERE participant_id = $1`,
          [pid, p.name ?? null, p.type ?? null, p.jurisdiction ?? null, p.endpoint ? JSON.stringify(p.endpoint) : null, p.metadata ? JSON.stringify(p.metadata) : null,
            entryStatus, intent.screeningRef, intent.approvalRef, intent.approvedBy]
        );
        return { participantId: pid };
      }
      case 'suspend_participant':
        await pool.query(`UPDATE ${PARTICIPANTS_TABLE} SET status = 'suspended', approved_by = $2, updated_at = NOW() WHERE participant_id = $1`, [pid, intent.approvedBy]);
        return { participantId: pid, participantStatus: 'suspended' };
      case 'reinstate_participant':
        await pool.query(
          `UPDATE ${PARTICIPANTS_TABLE} SET status = $2, screening_ref = COALESCE($3, screening_ref), approval_ref = COALESCE($4, approval_ref), approved_by = $5, updated_at = NOW() WHERE participant_id = $1`,
          [pid, entryStatus, intent.screeningRef, intent.approvalRef, intent.approvedBy]
        );
        return { participantId: pid, participantStatus: entryStatus };
      case 'set_routing_policy': {
        const p = intent.payload.policy || {};
        await pool.query(
          `INSERT INTO ${POLICIES_TABLE} (policy_id, participant_id, rail, processor, priority, max_amount_cents, status, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
           ON CONFLICT (policy_id) DO UPDATE SET participant_id = EXCLUDED.participant_id, rail = EXCLUDED.rail, processor = EXCLUDED.processor,
             priority = EXCLUDED.priority, max_amount_cents = EXCLUDED.max_amount_cents, status = EXCLUDED.status, metadata = EXCLUDED.metadata, updated_at = NOW()`,
          [p.policyId, pid, p.rail, p.processor, p.priority, p.maxAmountCents, entryStatus, JSON.stringify({ ...(p.metadata || {}), destination: p.destination || {} })]
        );
        return { policyId: p.policyId, policyStatus: entryStatus };
      }
      case 'set_exposure_limit': {
        const l = intent.payload.limit || {};
        await pool.query(
          `INSERT INTO ${LIMITS_TABLE} (participant_id, limit_cents, currency, status, approval_ref, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (participant_id) DO UPDATE SET limit_cents = EXCLUDED.limit_cents, currency = EXCLUDED.currency, status = EXCLUDED.status,
             approval_ref = EXCLUDED.approval_ref, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
          [pid, l.limitCents, l.currency || 'USD', entryStatus, intent.approvalRef, intent.approvedBy]
        );
        return { participantId: pid, limitCents: l.limitCents, limitStatus: entryStatus };
      }
      default:
        throw new Error(`unsupported network change ${intent.kind}`);
    }
  }

  static async cancel({ intentId, cancelledBy, reason } = {}) {
    if (!pool) throw httpError('ledger database unavailable', 503);
    const row = await this._get(intentId);
    if (!row) throw httpError('intent not found', 404);
    if (row.status !== 'submitted') throw httpError(`intent ${intentId} is ${row.status}; cannot cancel`, 409);
    await pool.query(`UPDATE ${TABLE} SET status = 'cancelled', error_message = $2, result = $3::jsonb WHERE intent_id = $1`,
      [intentId, reason || null, JSON.stringify({ cancelledBy: cancelledBy || null, reason: reason || null })]);
    return rowToIntent(await this._get(intentId));
  }

  static async intentStatus({ intentId } = {}) {
    if (!intentId) throw httpError('intentId required');
    const row = await this._get(intentId);
    if (!row) throw httpError('intent not found', 404);
    return rowToIntent(row);
  }

  static async listIntents({ status, kind, participantId, limit = 50 } = {}) {
    if (!pool) return [];
    const where = [];
    const params = [];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (kind) { params.push(kind); where.push(`kind = $${params.length}`); }
    if (participantId) { params.push(participantId); where.push(`participant_id = $${params.length}`); }
    params.push(Math.min(Number(limit) || 50, 500));
    const res = await pool.query(`SELECT * FROM ${TABLE} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return res.rows.map(rowToIntent);
  }

  // ── Registry reads (used by the private payment network) ────────────────

  static async participants({ status, type, limit = 100 } = {}) {
    if (!pool) return [];
    const where = [];
    const params = [];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (type) { params.push(type); where.push(`participant_type = $${params.length}`); }
    params.push(Math.min(Number(limit) || 100, 500));
    const res = await pool.query(`SELECT * FROM ${PARTICIPANTS_TABLE} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return res.rows.map(rowToParticipant);
  }

  static async participant({ participantId } = {}) {
    if (!participantId) throw httpError('participantId required');
    const row = await this._participantRow(participantId);
    if (!row) throw httpError(`participant ${participantId} not found`, 404);
    const [exposure, policies] = await Promise.all([this.exposure({ participantId }), this.policies({ participantId })]);
    return { ...rowToParticipant(row), exposure, policies };
  }

  static async policies({ participantId, rail } = {}) {
    if (!pool) return [];
    const params = [participantId || null];
    let sql = `SELECT * FROM ${POLICIES_TABLE} WHERE (participant_id = $1 OR participant_id IS NULL)`;
    if (rail) { params.push(String(rail).toLowerCase()); sql += ` AND rail = $${params.length}`; }
    const res = await pool.query(`${sql} ORDER BY (participant_id IS NULL), priority ASC, updated_at DESC`, params);
    return res.rows.map(rowToPolicy);
  }

  /**
   * Routing decision for a payout to a participant over a rail. Participant
   * policies win over network defaults; lowest priority first; policies whose
   * per-transaction cap is below the amount are skipped. A real-value route
   * only considers 'active' policies.
   */
  static async resolveRoute({ participantId, rail, amountCents, realValue = false } = {}) {
    const all = await this.policies({ participantId, rail });
    const candidates = all.filter((p) => p.status === 'active' || (!realValue && p.status === 'shadow'));
    const fit = candidates.find((p) => p.maxAmountCents == null || amountCents == null || Number(amountCents) <= p.maxAmountCents);
    if (!fit) return null;
    return { policyId: fit.policyId, processor: fit.processor, rail: fit.rail, priority: fit.priority, status: fit.status, scope: fit.participantId ? 'participant' : 'network' };
  }

  /** Open exposure = submitted + approved + cleared (not yet settled) payment-network transactions. */
  static async exposure({ participantId } = {}) {
    if (!participantId) throw httpError('participantId required');
    if (!pool) return { participantId, limitCents: null, limitStatus: null, openCents: 0, headroomCents: null };
    const [limRes, openRes] = await Promise.all([
      pool.query(`SELECT * FROM ${LIMITS_TABLE} WHERE participant_id = $1`, [participantId]),
      settle(() => pool.query(
        `SELECT COALESCE(SUM(amount_cents),0)::bigint AS cents FROM ${PAYMENT_NETWORK_TABLE} WHERE participant_id = $1 AND status = ANY($2)`,
        [participantId, OPEN_PAYMENT_STATUSES]
      )),
    ]);
    const limit = rowToLimit(limRes.rows[0]);
    const openCents = openRes.ok ? Number(openRes.value.rows[0]?.cents || 0) : 0;
    return {
      participantId,
      limitCents: limit ? limit.limitCents : null,
      limitStatus: limit ? limit.status : null,
      currency: limit ? limit.currency : null,
      openCents,
      headroomCents: limit ? limit.limitCents - openCents : null,
    };
  }

  /**
   * Admission check the payment network runs before recording or dispatching
   * a payout. Fails closed: an unknown or suspended participant, a missing
   * limit, or a limit breach is refused; a real-value payout additionally
   * needs an 'active' participant and an 'active' limit.
   */
  static async admit({ participantId, amountCents, realValue = false } = {}) {
    const row = await this._participantRow(participantId);
    if (!row) throw httpError(`participant ${participantId} not found in enterprise network`, 404);
    if (row.status === 'suspended') throw httpError(`participant ${participantId} is suspended`, 409);
    if (realValue && row.status !== 'active') throw httpError(`participant ${participantId} is ${row.status}; real-value payouts need an active participant`, 409);
    const loop = this.loopbackReason(row.endpoint || {});
    if (loop) throw httpError(`self-loopback partner refused: ${loop}`, 409);
    const exp = await this.exposure({ participantId });
    if (exp.limitCents == null) throw httpError(`participant ${participantId} has no exposure limit`, 409);
    if (realValue && exp.limitStatus !== 'active') throw httpError(`participant ${participantId} exposure limit is ${exp.limitStatus}; real-value payouts need an active limit`, 409);
    if (exp.openCents + Number(amountCents) > exp.limitCents) {
      throw httpError(`exposure limit exceeded for ${participantId}: open ${exp.openCents} + ${amountCents} > limit ${exp.limitCents} cents`, 409);
    }
    return { participant: rowToParticipant(row), exposure: exp };
  }

  // ── Reconcile / webhook ─────────────────────────────────────────────────

  /**
   * Applies a screening / partner event (holds only ever restrict the network)
   * and reports open exposure vs. limit for one or every participant.
   */
  static async reconcile({ participantId, event, reference, raw = {} } = {}) {
    if (!pool) throw httpError('ledger database unavailable', 503);
    let action = null;
    if (event) {
      if (!participantId) throw httpError('participantId required for a network event');
      const row = await this._participantRow(participantId);
      if (!row) throw httpError(`participant ${participantId} not found`, 404);
      const note = { event, reference: reference || null, at: new Date().toISOString(), raw };
      if (SCREENING_HOLD_EVENTS.has(event)) {
        await pool.query(`UPDATE ${PARTICIPANTS_TABLE} SET status = 'suspended', metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = NOW() WHERE participant_id = $1`,
          [participantId, JSON.stringify({ lastEvent: note })]);
        action = 'suspended';
      } else {
        await pool.query(`UPDATE ${PARTICIPANTS_TABLE} SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = NOW() WHERE participant_id = $1`,
          [participantId, JSON.stringify({ lastEvent: note })]);
        action = 'recorded';
      }
    }
    const ids = participantId ? [participantId] : (await this.participants({ limit: 500 })).map((p) => p.participantId);
    const exposures = await Promise.all(ids.map((id) => this.exposure({ participantId: id })));
    const breaches = exposures.filter((e) => e.limitCents == null ? e.openCents > 0 : e.openCents > e.limitCents);
    return { participantId: participantId || null, event: event || null, action, exposures, breaches, balanced: breaches.length === 0 };
  }

  /** Screening / partner callback: HMAC-SHA256 over the raw body with ENTERPRISE_NETWORK_WEBHOOK_SECRET. */
  static verifyWebhookSignature(rawBody, signature, env = process.env) {
    const secret = env.ENTERPRISE_NETWORK_WEBHOOK_SECRET;
    if (!secret) return { ok: false, reason: 'ENTERPRISE_NETWORK_WEBHOOK_SECRET not set' };
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
    if (!payload.event) throw httpError('event required');
    return this.reconcile({ participantId: payload.participantId, event: payload.event, reference: payload.reference, raw: payload });
  }

  // ── Pipeline / status ───────────────────────────────────────────────────

  static async pipeline() {
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    const byKind = Object.fromEntries(KINDS.map((k) => [k, 0]));
    const participants = Object.fromEntries(PARTICIPANT_STATUSES.map((s) => [s, 0]));
    let policies = 0;
    let limits = 0;
    if (pool) {
      const [intents, parts, pol, lim] = await Promise.all([
        pool.query(`SELECT status, kind, COUNT(*)::int AS n FROM ${TABLE} GROUP BY status, kind`),
        pool.query(`SELECT status, COUNT(*)::int AS n FROM ${PARTICIPANTS_TABLE} GROUP BY status`),
        pool.query(`SELECT COUNT(*)::int AS n FROM ${POLICIES_TABLE}`),
        pool.query(`SELECT COUNT(*)::int AS n FROM ${LIMITS_TABLE}`),
      ]);
      for (const r of intents.rows) {
        byStatus[r.status] = (byStatus[r.status] || 0) + Number(r.n);
        byKind[r.kind] = (byKind[r.kind] || 0) + Number(r.n);
      }
      for (const r of parts.rows) participants[r.status] = (participants[r.status] || 0) + Number(r.n);
      policies = Number(pol.rows[0]?.n || 0);
      limits = Number(lim.rows[0]?.n || 0);
    }
    return {
      byStatus, byKind, participants, policies, limits,
      movesMoney: false,
      gates: { approvalRef: true, screeningRef: true, distinctApprover: true, selfLoopbackRefused: true, exposureLimitRequired: true },
    };
  }

  static async status() {
    const cfg = this.getConfig();
    const pipeline = await settle(() => this.pipeline());
    return {
      engine: 'enterprise-network',
      healthy: Boolean(pool),
      mode: cfg.live ? 'live' : 'shadow',
      live: cfg.live,
      movesMoney: false,
      kinds: KINDS,
      participantTypes: PARTICIPANT_TYPES,
      rails: RAILS,
      config: cfg,
      integrations: { paymentProcessorOs: Boolean(this._processorOs()), webhookSecret: cfg.webhookSecret },
      pipeline: pipeline.ok ? pipeline.value : { error: pipeline.error },
      timestamp: new Date().toISOString(),
    };
  }

  static async readiness() {
    const { EngineWiringReadiness } = require('./engineWiringReadiness');
    return EngineWiringReadiness.engineReadiness('enterprise-network');
  }

  static async _get(id) {
    const res = await pool.query(`SELECT * FROM ${TABLE} WHERE intent_id = $1`, [id]);
    return res.rows[0] || null;
  }

  static async _participantRow(id) {
    if (!pool || !id) return null;
    const res = await pool.query(`SELECT * FROM ${PARTICIPANTS_TABLE} WHERE participant_id = $1`, [id]);
    return res.rows[0] || null;
  }
}

module.exports = { EnterpriseNetworkOsEngine };
