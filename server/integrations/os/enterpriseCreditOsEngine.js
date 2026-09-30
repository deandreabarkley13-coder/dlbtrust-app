'use strict';

/**
 * Enterprise Credit OS — asset-backed credit for trust distributions and
 * disbursements.
 *
 * Capacity is the counted asset backing already established by the other
 * engines, so nothing is counted twice:
 *   - Private Equity Holdings OS `eligibleCollateralCents` (collateral-eligible
 *     holdings at their advance rate; intra-trust holdings are excluded there);
 *   - Pledge OS pledges backed by a Custody OS position and `counted`, at
 *     ENTERPRISE_CREDIT_CUSTODY_ADVANCE_RATE_BPS (pledges backed by PE holdings
 *     or bonds are already inside the PE figure).
 *
 * Each distribution / disbursement is an allocation against that capacity:
 *   request (maker) -> approve (checker, distinct trustee) -> disburse (bank
 *   reference of the settled wire) -> repaid | cancelled
 * and carries a backing verdict (backed | partial | unbacked) recomputed by
 * `evaluate` in request order. The engine moves no money: `fundingPlan` returns
 * the screened maker/checker settlement-funding pipeline command that sends the
 * wire, plus the Credit OS liquidity gate for the amount.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');
const { resealEventChain } = require('./eventChainReseal');

function tryRequire(mod) {
  try { return require(mod); } catch (e) { return null; }
}

const KINDS = ['distribution', 'disbursement'];
const STATUSES = ['requested', 'approved', 'disbursed', 'repaid', 'cancelled'];
const OPEN_STATUSES = ['requested', 'approved', 'disbursed'];
const BACKING = ['backed', 'partial', 'unbacked'];

class EnterpriseCreditError extends Error {
  constructor(message, code = 'ENTERPRISE_CREDIT_ERROR', status = 409) {
    super(message);
    this.name = 'EnterpriseCreditError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function isTrue(v) { return String(v || '').toLowerCase() === 'true'; }

function bps(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 10000 ? n : fallback;
}

function getEnterpriseCreditConfig(env = process.env) {
  return {
    enabled: String(env.ENTERPRISE_CREDIT_ENABLED || 'true').toLowerCase() !== 'false',
    live: isTrue(env.ENTERPRISE_CREDIT_LIVE),
    custodyAdvanceRateBps: bps(env.ENTERPRISE_CREDIT_CUSTODY_ADVANCE_RATE_BPS, 5000),
    approvalThreshold: Number(env.PAYMENT_APPROVAL_THRESHOLD || 2),
  };
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function text(value, message, code = 'ENTERPRISE_CREDIT_INVALID') {
  const s = String(value == null ? '' : value).trim();
  if (!s) throw new EnterpriseCreditError(message, code, 400);
  return s;
}

function optional(value) {
  const s = String(value == null ? '' : value).trim();
  return s || null;
}

function wholeCents(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new EnterpriseCreditError(`${field} must be a positive whole number of cents`, 'ENTERPRISE_CREDIT_INVALID', 400);
  return n;
}

function dollars(cents) { return (Number(cents || 0) / 100).toFixed(2); }

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function hashEvent(e) {
  return crypto.createHash('sha256').update(JSON.stringify([
    e.prevHash || null, e.eventType, e.allocationId || null, e.actor || null, canonical(e.payload || {}), e.createdAt,
  ])).digest('hex');
}

function peHoldings() { return tryRequire('./privateEquityHoldingsOsEngine')?.PrivateEquityHoldingsOsEngine || null; }
function pledges() { return tryRequire('./pledgeOsEngine')?.PledgeOsEngine || null; }
function credit() { return tryRequire('./creditOsEngine')?.CreditOsEngine || null; }

function rowToAllocation(row) {
  if (!row) return null;
  const backing = typeof row.backing === 'string' ? JSON.parse(row.backing) : (row.backing || null);
  return {
    allocationId: row.allocation_id,
    kind: row.kind,
    amountCents: Number(row.amount_cents),
    amount: dollars(row.amount_cents),
    beneficiary: row.beneficiary,
    purpose: row.purpose,
    bondId: row.bond_id == null ? null : Number(row.bond_id),
    status: row.status,
    backing,
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    approvalRef: row.approval_ref,
    bankReference: row.bank_reference,
    disbursedAt: row.disbursed_at,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function classify(amountCents, backedCents) {
  if (backedCents >= amountCents) return 'backed';
  return backedCents > 0 ? 'partial' : 'unbacked';
}

const EnterpriseCreditOsEngine = {
  engineName: 'enterprise-credit',
  EnterpriseCreditError,
  KINDS,
  STATUSES,

  config(env = process.env) { return getEnterpriseCreditConfig(env); },

  async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS enterprise_credit_allocations (
        allocation_id  TEXT PRIMARY KEY,
        kind           TEXT NOT NULL CHECK (kind IN ('distribution','disbursement')),
        amount_cents   BIGINT NOT NULL CHECK (amount_cents > 0),
        beneficiary    TEXT NOT NULL,
        purpose        TEXT NOT NULL,
        bond_id        INTEGER,
        status         TEXT NOT NULL DEFAULT 'requested'
                       CHECK (status IN ('requested','approved','disbursed','repaid','cancelled')),
        backing        JSONB,
        requested_by   TEXT NOT NULL,
        approved_by    TEXT,
        approval_ref   TEXT,
        bank_reference TEXT UNIQUE,
        disbursed_at   TIMESTAMPTZ,
        closed_at      TIMESTAMPTZ,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS enterprise_credit_events (
        sequence      BIGSERIAL PRIMARY KEY,
        event_id      TEXT UNIQUE NOT NULL,
        allocation_id TEXT,
        event_type    TEXT NOT NULL,
        actor         TEXT,
        payload       JSONB NOT NULL DEFAULT '{}',
        prev_hash     TEXT,
        event_hash    TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_enterprise_credit_status ON enterprise_credit_allocations (status)');
    return true;
  },

  async _event(eventType, allocationId, actor, payload = {}) {
    const tip = await pool.query('SELECT event_hash FROM enterprise_credit_events ORDER BY sequence DESC LIMIT 1');
    const prevHash = (tip.rows[0] && tip.rows[0].event_hash) || null;
    const createdAt = new Date().toISOString();
    const eventHash = hashEvent({ prevHash, eventType, allocationId, actor, payload, createdAt });
    await pool.query(
      `INSERT INTO enterprise_credit_events (event_id, allocation_id, event_type, actor, payload, prev_hash, event_hash, created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
      [newId('ECV'), allocationId, eventType, actor, JSON.stringify(payload), prevHash, eventHash, createdAt]
    );
    return eventHash;
  },

  async verifyChain() {
    await this.ensureTables();
    const { rows } = await pool.query('SELECT * FROM enterprise_credit_events ORDER BY sequence ASC');
    let prevHash = null;
    const breaks = [];
    for (const row of rows) {
      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
      const expected = hashEvent({
        prevHash, eventType: row.event_type, allocationId: row.allocation_id, actor: row.actor, payload,
        createdAt: new Date(row.created_at).toISOString(),
      });
      if (expected !== row.event_hash || (row.prev_hash || null) !== prevHash) breaks.push({ eventId: row.event_id, sequence: Number(row.sequence) });
      prevHash = row.event_hash;
    }
    return { events: rows.length, intact: breaks.length === 0, breaks, tipHash: prevHash };
  },

  async resealChain({ actor = null, reason } = {}) {
    await this.ensureTables();
    const result = await resealEventChain({
      db: pool, table: 'enterprise_credit_events', subjectColumn: 'allocation_id', subjectKey: 'allocationId', hashEvent,
      appendEvent: (type, id, who, payload) => this._event(type, id, who, payload), actor, reason,
    });
    return { ...result, chain: await this.verifyChain() };
  },

  /** Counted asset backing available to distributions and disbursements. Read-only. */
  async capacity() {
    const cfg = this.config();
    const sources = [];
    const Pe = peHoldings();
    if (Pe) {
      const s = await Pe.status().catch((e) => ({ error: e.message }));
      const cents = s && s.summary ? Number(s.summary.eligibleCollateralCents || 0) : 0;
      sources.push({
        source: 'private-equity-holdings', capacityCents: cents, capacity: dollars(cents),
        detail: s && s.summary
          ? { collateralEligible: s.summary.collateralEligible, receipted: s.summary.receipted, intraTrustExcluded: s.summary.intraTrust || null }
          : { error: (s && s.error) || 'status unavailable' },
      });
    }
    const Pledge = pledges();
    if (Pledge) {
      const list = await Pledge.list({ limit: 500 }).catch(() => []);
      const counted = list.filter((p) => p.status === 'counted' && p.backingType === 'custody_position');
      const receipted = counted.reduce((sum, p) => sum + p.countedCents, 0);
      const cents = Math.floor(receipted * cfg.custodyAdvanceRateBps / 10000);
      sources.push({
        source: 'pledge-os:custody_position', capacityCents: cents, capacity: dollars(cents),
        detail: { pledges: counted.map((p) => p.reference), receiptedCents: receipted, advanceRateBps: cfg.custodyAdvanceRateBps },
      });
    }
    const capacityCents = sources.reduce((sum, s) => sum + s.capacityCents, 0);
    await this.ensureTables();
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(amount_cents),0)::bigint AS used FROM enterprise_credit_allocations WHERE status IN ('approved','disbursed')`
    );
    const usedCents = Number(rows[0].used || 0);
    return {
      capacityCents, capacity: dollars(capacityCents),
      usedCents, used: dollars(usedCents),
      availableCents: Math.max(capacityCents - usedCents, 0), available: dollars(Math.max(capacityCents - usedCents, 0)),
      sources,
    };
  },

  async _require(allocationId) {
    const id = text(allocationId, 'allocationId is required');
    await this.ensureTables();
    const { rows } = await pool.query('SELECT * FROM enterprise_credit_allocations WHERE allocation_id = $1', [id]);
    if (!rows[0]) throw new EnterpriseCreditError(`allocation ${id} not found`, 'ENTERPRISE_CREDIT_NOT_FOUND', 404);
    return rows[0];
  },

  async _setStatus(row, from, to, fields, eventType, actor, payload) {
    if (!from.includes(row.status)) {
      throw new EnterpriseCreditError(`allocation ${row.allocation_id} is ${row.status}; ${eventType} needs ${from.join(' or ')}`, 'ENTERPRISE_CREDIT_STATE', 409);
    }
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 3}`);
    const { rows } = await pool.query(
      `UPDATE enterprise_credit_allocations SET status = $2${sets.length ? `, ${sets.join(', ')}` : ''}, updated_at = NOW()
        WHERE allocation_id = $1 RETURNING *`,
      [row.allocation_id, to, ...keys.map((k) => fields[k])]
    );
    await this._event(eventType, row.allocation_id, actor, payload);
    return rowToAllocation(rows[0]);
  },

  /** Maker: request a distribution or disbursement against counted asset backing. */
  async request({ kind, amountCents, beneficiary, purpose, bondId = null, actor = null } = {}) {
    const cfg = this.config();
    if (!cfg.enabled) throw new EnterpriseCreditError('ENTERPRISE_CREDIT_ENABLED=false', 'ENTERPRISE_CREDIT_DISABLED', 503);
    const who = text(actor, 'trustee identity required', 'ENTERPRISE_CREDIT_ACTOR');
    const k = text(kind, 'kind is required').toLowerCase();
    if (!KINDS.includes(k)) throw new EnterpriseCreditError(`kind must be one of ${KINDS.join(', ')}`, 'ENTERPRISE_CREDIT_INVALID', 400);
    const amount = wholeCents(amountCents, 'amountCents');
    const payee = text(beneficiary, 'beneficiary is required');
    const why = text(purpose, 'purpose is required');
    const bond = bondId == null || bondId === '' ? null : Number(bondId);
    const cap = await this.capacity();
    const backedCents = Math.min(amount, cap.availableCents);
    const backing = { verdict: classify(amount, backedCents), backedCents, availableCentsAtRequest: cap.availableCents };
    const id = newId('ECA');
    const { rows } = await pool.query(
      `INSERT INTO enterprise_credit_allocations (allocation_id, kind, amount_cents, beneficiary, purpose, bond_id, backing, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`,
      [id, k, amount, payee, why, bond, JSON.stringify(backing), who]
    );
    await this._event('allocation_requested', id, who, { kind: k, amountCents: amount, beneficiary: payee, bondId: bond, backing });
    return rowToAllocation(rows[0]);
  },

  /** Checker: a second trustee approves the allocation (maker/checker). */
  async approve({ allocationId, approvalRef, actor = null } = {}) {
    const who = text(actor, 'trustee identity required', 'ENTERPRISE_CREDIT_ACTOR');
    const ref = text(approvalRef, 'approvalRef is required');
    const row = await this._require(allocationId);
    if (row.requested_by === who) throw new EnterpriseCreditError('the approving trustee must differ from the requesting trustee', 'ENTERPRISE_CREDIT_MAKER_CHECKER', 403);
    const cap = await this.capacity();
    const amount = Number(row.amount_cents);
    const backedCents = Math.min(amount, cap.availableCents);
    const backing = { verdict: classify(amount, backedCents), backedCents, availableCentsAtApproval: cap.availableCents };
    return this._setStatus(row, ['requested'], 'approved', { approved_by: who, approval_ref: ref, backing: JSON.stringify(backing) }, 'allocation_approved', who, { approvalRef: ref, backing });
  },

  /** Record the settled wire: the bank reference returned by the settlement-funding pipeline. */
  async disburse({ allocationId, bankReference, actor = null } = {}) {
    const who = text(actor, 'trustee identity required', 'ENTERPRISE_CREDIT_ACTOR');
    const ref = text(bankReference, 'bankReference (the settling bank\'s reference for the wire) is required');
    const row = await this._require(allocationId);
    return this._setStatus(row, ['approved'], 'disbursed', { bank_reference: ref, disbursed_at: new Date().toISOString() }, 'allocation_disbursed', who, { bankReference: ref });
  },

  async repay({ allocationId, bankReference, actor = null } = {}) {
    const who = text(actor, 'trustee identity required', 'ENTERPRISE_CREDIT_ACTOR');
    const ref = text(bankReference, 'bankReference of the repayment is required');
    const row = await this._require(allocationId);
    return this._setStatus(row, ['disbursed'], 'repaid', { closed_at: new Date().toISOString() }, 'allocation_repaid', who, { bankReference: ref });
  },

  async cancel({ allocationId, reason = null, actor = null } = {}) {
    const who = text(actor, 'trustee identity required', 'ENTERPRISE_CREDIT_ACTOR');
    const row = await this._require(allocationId);
    return this._setStatus(row, ['requested', 'approved'], 'cancelled', { closed_at: new Date().toISOString() }, 'allocation_cancelled', who, { reason: optional(reason) });
  },

  /** The screened maker/checker wire that funds an approved allocation. Read-only. */
  async fundingPlan({ allocationId } = {}) {
    const a = rowToAllocation(await this._require(allocationId));
    const Credit = credit();
    const liquidity = Credit ? await Credit.gate(a.amountCents).catch((e) => ({ error: e.message })) : { error: 'Credit OS not loadable' };
    return {
      allocation: a,
      backing: a.backing,
      liquidity,
      steps: [
        { step: 'screen', via: 'Fraud Compliance OS live screening bound to amount + beneficiary', yields: 'FCS-… screeningRef' },
        {
          step: 'funding_wire',
          via: `node server/scripts/fundSettlementAccount.js pipeline --amount ${a.amount} --maker <m> --checker <c> --approval-ref ${a.approvalRef || '<APR-…>'} --screening-ref <FCS-…>`,
          movesMoney: true,
          requires: ['PAYMENT_APPROVAL_THRESHOLD>=2', 'live FCS- screening bound to amount + beneficiary', 'external bank settlement reference before settle'],
        },
        { step: 'record', via: `enterpriseCreditWire.js --disburse --allocation ${a.allocationId} --bank-reference <bank ref> --actor <id>` },
      ],
    };
  },

  /** Recompute backing verdicts for open allocations, oldest first. Records no status change. */
  async evaluate({ actor = null } = {}) {
    const who = optional(actor) || 'enterprise-credit';
    await this.ensureTables();
    const cap = await this.capacity();
    const { rows } = await pool.query(
      `SELECT * FROM enterprise_credit_allocations WHERE status IN ('requested','approved','disbursed') ORDER BY created_at ASC`
    );
    let remaining = cap.capacityCents;
    const results = [];
    for (const row of rows) {
      const amount = Number(row.amount_cents);
      const backedCents = Math.min(amount, Math.max(remaining, 0));
      remaining -= amount;
      const backing = { verdict: classify(amount, backedCents), backedCents, evaluatedBy: who, evaluatedAt: new Date().toISOString() };
      const updated = await pool.query(
        'UPDATE enterprise_credit_allocations SET backing = $2::jsonb, updated_at = NOW() WHERE allocation_id = $1 RETURNING *',
        [row.allocation_id, JSON.stringify(backing)]
      );
      results.push(rowToAllocation(updated.rows[0]));
    }
    await this._event('allocations_evaluated', null, who, { capacityCents: cap.capacityCents, open: results.length });
    return { capacity: cap, allocations: results, summary: this._summary(results) };
  },

  _summary(allocations) {
    const open = allocations.filter((a) => OPEN_STATUSES.includes(a.status));
    const by = (pred) => open.filter(pred).reduce((s, a) => s + a.amountCents, 0);
    const verdict = (a) => (a.backing && a.backing.verdict) || 'unbacked';
    return {
      open: open.length,
      requestedCents: by((a) => a.status === 'requested'),
      approvedCents: by((a) => a.status === 'approved'),
      disbursedCents: by((a) => a.status === 'disbursed'),
      distributionsCents: by((a) => a.kind === 'distribution'),
      disbursementsCents: by((a) => a.kind === 'disbursement'),
      backed: open.filter((a) => verdict(a) === 'backed').length,
      partial: open.filter((a) => verdict(a) === 'partial').length,
      unbacked: open.filter((a) => verdict(a) === 'unbacked').length,
    };
  },

  async list({ limit = 50, status = null } = {}) {
    await this.ensureTables();
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const { rows } = status
      ? await pool.query('SELECT * FROM enterprise_credit_allocations WHERE status = $1 ORDER BY created_at DESC LIMIT $2', [status, lim])
      : await pool.query('SELECT * FROM enterprise_credit_allocations ORDER BY created_at DESC LIMIT $1', [lim]);
    return rows.map(rowToAllocation);
  },

  async get(allocationId) {
    const row = await this._require(allocationId);
    const events = await pool.query('SELECT event_id, event_type, actor, payload, event_hash, created_at FROM enterprise_credit_events WHERE allocation_id = $1 ORDER BY sequence ASC', [row.allocation_id]);
    return { ...rowToAllocation(row), events: events.rows };
  },

  async status() {
    const cfg = this.config();
    await this.ensureTables();
    const allocations = await this.list({ limit: 500 });
    const chain = await this.verifyChain().catch((e) => ({ intact: false, error: e.message }));
    return {
      engine: 'enterprise-credit',
      enabled: cfg.enabled,
      live: cfg.live,
      policy: { kinds: KINDS, custodyAdvanceRateBps: cfg.custodyAdvanceRateBps, approvalThreshold: cfg.approvalThreshold, backingVerdicts: BACKING },
      capacity: await this.capacity().catch((e) => ({ error: e.message })),
      summary: this._summary(allocations),
      allocations,
      chain,
      movesMoney: false,
    };
  },

  async health() {
    const s = await this.status();
    return { engine: s.engine, healthy: s.enabled && s.chain.intact !== false, mode: s.live ? 'live' : 'shadow', open: s.summary.open, timestamp: new Date().toISOString() };
  },

  async readiness() {
    const s = await this.status();
    const blockers = [];
    if (!s.enabled) blockers.push('ENTERPRISE_CREDIT_ENABLED=false');
    if (!s.live) blockers.push('ENTERPRISE_CREDIT_LIVE not true');
    if (!s.chain.intact) blockers.push(`enterprise credit event chain broken: ${s.chain.error || `${(s.chain.breaks || []).length} break(s)`}`);
    if (s.policy.approvalThreshold < 2) blockers.push('PAYMENT_APPROVAL_THRESHOLD must be >= 2 (maker/checker)');
    const warnings = [];
    if (s.capacity && !s.capacity.error && s.capacity.capacityCents === 0) {
      warnings.push('no counted asset backing: register receipted, collateral-eligible PE holdings or counted custody-position pledges');
    }
    for (const a of s.allocations.filter((x) => OPEN_STATUSES.includes(x.status))) {
      const v = (a.backing && a.backing.verdict) || 'unbacked';
      if (v !== 'backed') warnings.push(`${a.allocationId} (${a.kind} $${a.amount} to ${a.beneficiary}): ${v}, $${dollars((a.backing && a.backing.backedCents) || 0)} backed`);
    }
    const ready = blockers.length === 0;
    return { ready, mode: ready ? 'live' : 'shadow', blockers, warnings, status: s };
  },

  async process({ action, actor = null, ...body } = {}) {
    switch (action) {
      case 'request': return this.request({ ...body, actor });
      case 'approve': return this.approve({ ...body, actor });
      case 'disburse': return this.disburse({ ...body, actor });
      case 'repay': return this.repay({ ...body, actor });
      case 'cancel': return this.cancel({ ...body, actor });
      case 'evaluate': return this.evaluate({ actor });
      case 'capacity': return this.capacity();
      case 'funding_plan': return this.fundingPlan(body);
      case 'verify_chain': return this.verifyChain();
      case 'reseal_chain': return this.resealChain({ ...body, actor });
      default:
        throw new EnterpriseCreditError(
          `unknown action "${action}" (request, approve, disburse, repay, cancel, evaluate, capacity, funding_plan, verify_chain, reseal_chain)`,
          'ENTERPRISE_CREDIT_UNKNOWN_ACTION', 400
        );
    }
  },
};

module.exports = { EnterpriseCreditOsEngine, EnterpriseCreditError, getEnterpriseCreditConfig, KINDS, STATUSES };
