'use strict';

/**
 * Enterprise Capacity OS — intra-trust capacity of the trust's self-custody
 * assets.
 *
 * Intra capacity is the book value of every Custody OS position the trust holds
 * in self custody (custody_type = 'self_custody', not released), at
 * ENTERPRISE_CAPACITY_INTRA_RATE_BPS (default 100%). Third-party receipted
 * positions are reported alongside as outside value but are not part of intra
 * capacity, and Private Equity Holdings OS intra-trust holdings are shown as a
 * cross-reference only (they are the same self-custody positions, so they are
 * not added again).
 *
 * Trustees earmark intra capacity for internal uses (a series, sub-account or
 * program) with maker/checker allocations:
 *   request (maker) -> approve (checker, distinct trustee) -> released | cancelled
 * Intra capacity is an internal figure: it is not collateral, not a Collateral
 * OS borrowing base and not Enterprise Credit capacity, and nothing here books
 * GL lines, edits balances or sends a wire.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');
const { resealEventChain } = require('./eventChainReseal');

function tryRequire(mod) {
  try { return require(mod); } catch (e) { return null; }
}

const STATUSES = ['requested', 'approved', 'released', 'cancelled'];
const OPEN_STATUSES = ['requested', 'approved'];
const VERDICTS = ['within', 'partial', 'over'];

class EnterpriseCapacityError extends Error {
  constructor(message, code = 'ENTERPRISE_CAPACITY_ERROR', status = 409) {
    super(message);
    this.name = 'EnterpriseCapacityError';
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

function getEnterpriseCapacityConfig(env = process.env) {
  return {
    enabled: String(env.ENTERPRISE_CAPACITY_ENABLED || 'true').toLowerCase() !== 'false',
    live: isTrue(env.ENTERPRISE_CAPACITY_LIVE),
    intraRateBps: bps(env.ENTERPRISE_CAPACITY_INTRA_RATE_BPS, 10000),
    approvalThreshold: Number(env.PAYMENT_APPROVAL_THRESHOLD || 2),
  };
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function text(value, message, code = 'ENTERPRISE_CAPACITY_INVALID') {
  const s = String(value == null ? '' : value).trim();
  if (!s) throw new EnterpriseCapacityError(message, code, 400);
  return s;
}

function optional(value) {
  const s = String(value == null ? '' : value).trim();
  return s || null;
}

function wholeCents(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new EnterpriseCapacityError(`${field} must be a positive whole number of cents`, 'ENTERPRISE_CAPACITY_INVALID', 400);
  return n;
}

function cents(v) { return Math.round(Number(v || 0)); }
function dollars(c) { return (Number(c || 0) / 100).toFixed(2); }

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

function custody() { return tryRequire('../custody/custodyOsEngine')?.CustodyOsEngine || null; }
function peHoldings() { return tryRequire('./privateEquityHoldingsOsEngine')?.PrivateEquityHoldingsOsEngine || null; }

function rowToAllocation(row) {
  if (!row) return null;
  const verdict = typeof row.verdict === 'string' ? JSON.parse(row.verdict) : (row.verdict || null);
  return {
    allocationId: row.allocation_id,
    amountCents: Number(row.amount_cents),
    amount: dollars(row.amount_cents),
    designation: row.designation,
    purpose: row.purpose,
    status: row.status,
    verdict,
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    approvalRef: row.approval_ref,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function classify(amountCents, coveredCents) {
  if (coveredCents >= amountCents) return 'within';
  return coveredCents > 0 ? 'partial' : 'over';
}

function bucket(map, key) {
  return map[key] || (map[key] = { positions: 0, bookCents: 0, receiptedCents: 0 });
}

const INTRA_ONLY = Object.freeze({
  countsAsCollateral: false,
  collateralOsBorrowingBase: false,
  enterpriseCreditCapacity: false,
  movesMoney: false,
});

const EnterpriseCapacityOsEngine = {
  engineName: 'enterprise-capacity',
  EnterpriseCapacityError,
  STATUSES,

  config(env = process.env) { return getEnterpriseCapacityConfig(env); },

  async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS enterprise_capacity_allocations (
        allocation_id TEXT PRIMARY KEY,
        amount_cents  BIGINT NOT NULL CHECK (amount_cents > 0),
        designation   TEXT NOT NULL,
        purpose       TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'requested'
                      CHECK (status IN ('requested','approved','released','cancelled')),
        verdict       JSONB,
        requested_by  TEXT NOT NULL,
        approved_by   TEXT,
        approval_ref  TEXT,
        closed_at     TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS enterprise_capacity_events (
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
    await pool.query('CREATE INDEX IF NOT EXISTS idx_enterprise_capacity_status ON enterprise_capacity_allocations (status)');
    return true;
  },

  async _event(eventType, allocationId, actor, payload = {}) {
    const tip = await pool.query('SELECT event_hash FROM enterprise_capacity_events ORDER BY sequence DESC LIMIT 1');
    const prevHash = (tip.rows[0] && tip.rows[0].event_hash) || null;
    const createdAt = new Date().toISOString();
    const eventHash = hashEvent({ prevHash, eventType, allocationId, actor, payload, createdAt });
    await pool.query(
      `INSERT INTO enterprise_capacity_events (event_id, allocation_id, event_type, actor, payload, prev_hash, event_hash, created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
      [newId('ECP'), allocationId, eventType, actor, JSON.stringify(payload), prevHash, eventHash, createdAt]
    );
    return eventHash;
  },

  async verifyChain() {
    await this.ensureTables();
    const { rows } = await pool.query('SELECT * FROM enterprise_capacity_events ORDER BY sequence ASC');
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
      db: pool, table: 'enterprise_capacity_events', subjectColumn: 'allocation_id', subjectKey: 'allocationId', hashEvent,
      appendEvent: (type, id, who, payload) => this._event(type, id, who, payload), actor, reason,
    });
    return { ...result, chain: await this.verifyChain() };
  },

  /** Intra capacity of the trust's self-custody assets. Read-only. */
  async capacity() {
    const cfg = this.config();
    const Custody = custody();
    if (!Custody) throw new EnterpriseCapacityError('Custody OS not loadable', 'ENTERPRISE_CAPACITY_SOURCE', 503);
    const positions = await Custody.listPositions();

    let selfCustodyCents = 0;
    let selfReceiptedCents = 0;
    let outsideReceiptedCents = 0;
    const byAccount = {};
    const byAssetClass = {};
    const intraPositions = [];
    for (const p of positions) {
      if (p.control_status === 'released') continue;
      const value = cents(p.valuation_cents);
      const receipted = p.control_status === 'receipted';
      if (p.custody_type !== 'self_custody') {
        if (receipted) outsideReceiptedCents += value;
        continue;
      }
      selfCustodyCents += value;
      if (receipted) selfReceiptedCents += value;
      for (const b of [bucket(byAccount, p.custody_account_id), bucket(byAssetClass, p.asset_class)]) {
        b.positions += 1;
        b.bookCents += value;
        if (receipted) b.receiptedCents += value;
      }
      intraPositions.push({
        positionId: p.position_id,
        custodyAccountId: p.custody_account_id,
        assetClass: p.asset_class,
        instrumentRef: p.instrument_ref,
        instrumentName: p.instrument_name,
        controlStatus: p.control_status,
        bookCents: value,
        book: dollars(value),
      });
    }

    const Pe = peHoldings();
    const pe = Pe ? await Pe.status().catch((e) => ({ error: e.message })) : null;
    const peIntra = pe && pe.summary && pe.summary.intraTrust ? pe.summary.intraTrust : null;

    const capacityCents = Math.floor(selfCustodyCents * cfg.intraRateBps / 10000);
    await this.ensureTables();
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(amount_cents),0)::bigint AS used FROM enterprise_capacity_allocations WHERE status = 'approved'`
    );
    const usedCents = Number(rows[0].used || 0);
    const availableCents = Math.max(capacityCents - usedCents, 0);
    const money = (c) => ({ cents: c, usd: dollars(c) });
    const shape = (m) => Object.fromEntries(Object.entries(m).map(([k, b]) => [k, { positions: b.positions, book: dollars(b.bookCents), receipted: dollars(b.receiptedCents) }]));
    return {
      basis: 'self_custody',
      intraRateBps: cfg.intraRateBps,
      selfCustodyCents, selfCustody: dollars(selfCustodyCents),
      selfCustodyReceipted: money(selfReceiptedCents),
      selfCustodyUnreceipted: money(selfCustodyCents - selfReceiptedCents),
      capacityCents, capacity: dollars(capacityCents),
      usedCents, used: dollars(usedCents),
      availableCents, available: dollars(availableCents),
      outsideReceipted: money(outsideReceiptedCents),
      peIntraTrust: peIntra
        ? { holdings: peIntra.holdings, book: dollars(peIntra.bookCents), note: 'same self-custody positions; not added again' }
        : null,
      byAccount: shape(byAccount),
      byAssetClass: shape(byAssetClass),
      positions: intraPositions,
      ...INTRA_ONLY,
    };
  },

  async _require(allocationId) {
    const id = text(allocationId, 'allocationId is required');
    await this.ensureTables();
    const { rows } = await pool.query('SELECT * FROM enterprise_capacity_allocations WHERE allocation_id = $1', [id]);
    if (!rows[0]) throw new EnterpriseCapacityError(`allocation ${id} not found`, 'ENTERPRISE_CAPACITY_NOT_FOUND', 404);
    return rows[0];
  },

  async _setStatus(row, from, to, fields, eventType, actor, payload) {
    if (!from.includes(row.status)) {
      throw new EnterpriseCapacityError(`allocation ${row.allocation_id} is ${row.status}; ${eventType} needs ${from.join(' or ')}`, 'ENTERPRISE_CAPACITY_STATE', 409);
    }
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 3}`);
    const { rows } = await pool.query(
      `UPDATE enterprise_capacity_allocations SET status = $2${sets.length ? `, ${sets.join(', ')}` : ''}, updated_at = NOW()
        WHERE allocation_id = $1 RETURNING *`,
      [row.allocation_id, to, ...keys.map((k) => fields[k])]
    );
    await this._event(eventType, row.allocation_id, actor, payload);
    return rowToAllocation(rows[0]);
  },

  /** Maker: earmark intra capacity for an internal designation. */
  async request({ amountCents, designation, purpose, actor = null } = {}) {
    const cfg = this.config();
    if (!cfg.enabled) throw new EnterpriseCapacityError('ENTERPRISE_CAPACITY_ENABLED=false', 'ENTERPRISE_CAPACITY_DISABLED', 503);
    const who = text(actor, 'trustee identity required', 'ENTERPRISE_CAPACITY_ACTOR');
    const amount = wholeCents(amountCents, 'amountCents');
    const where = text(designation, 'designation is required');
    const why = text(purpose, 'purpose is required');
    const cap = await this.capacity();
    const covered = Math.min(amount, cap.availableCents);
    const verdict = { verdict: classify(amount, covered), coveredCents: covered, availableCentsAtRequest: cap.availableCents };
    const id = newId('ECPA');
    const { rows } = await pool.query(
      `INSERT INTO enterprise_capacity_allocations (allocation_id, amount_cents, designation, purpose, verdict, requested_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING *`,
      [id, amount, where, why, JSON.stringify(verdict), who]
    );
    await this._event('intra_allocation_requested', id, who, { amountCents: amount, designation: where, verdict });
    return rowToAllocation(rows[0]);
  },

  /** Checker: a second trustee approves the earmark (maker/checker). */
  async approve({ allocationId, approvalRef, actor = null } = {}) {
    const who = text(actor, 'trustee identity required', 'ENTERPRISE_CAPACITY_ACTOR');
    const ref = text(approvalRef, 'approvalRef is required');
    const row = await this._require(allocationId);
    if (row.requested_by === who) throw new EnterpriseCapacityError('the approving trustee must differ from the requesting trustee', 'ENTERPRISE_CAPACITY_MAKER_CHECKER', 403);
    const cap = await this.capacity();
    const amount = Number(row.amount_cents);
    const covered = Math.min(amount, cap.availableCents);
    const verdict = { verdict: classify(amount, covered), coveredCents: covered, availableCentsAtApproval: cap.availableCents };
    return this._setStatus(row, ['requested'], 'approved', { approved_by: who, approval_ref: ref, verdict: JSON.stringify(verdict) }, 'intra_allocation_approved', who, { approvalRef: ref, verdict });
  },

  async release({ allocationId, reason = null, actor = null } = {}) {
    const who = text(actor, 'trustee identity required', 'ENTERPRISE_CAPACITY_ACTOR');
    const row = await this._require(allocationId);
    return this._setStatus(row, ['approved'], 'released', { closed_at: new Date().toISOString() }, 'intra_allocation_released', who, { reason: optional(reason) });
  },

  async cancel({ allocationId, reason = null, actor = null } = {}) {
    const who = text(actor, 'trustee identity required', 'ENTERPRISE_CAPACITY_ACTOR');
    const row = await this._require(allocationId);
    return this._setStatus(row, ['requested', 'approved'], 'cancelled', { closed_at: new Date().toISOString() }, 'intra_allocation_cancelled', who, { reason: optional(reason) });
  },

  /** Recompute intra capacity and each open earmark's verdict, oldest first. */
  async evaluate({ actor = null } = {}) {
    const who = optional(actor) || 'enterprise-capacity';
    await this.ensureTables();
    const cap = await this.capacity();
    const { rows } = await pool.query(
      `SELECT * FROM enterprise_capacity_allocations WHERE status IN ('requested','approved') ORDER BY created_at ASC`
    );
    let remaining = cap.capacityCents;
    const results = [];
    for (const row of rows) {
      const amount = Number(row.amount_cents);
      const covered = Math.min(amount, Math.max(remaining, 0));
      remaining -= amount;
      const verdict = { verdict: classify(amount, covered), coveredCents: covered, evaluatedBy: who, evaluatedAt: new Date().toISOString() };
      const updated = await pool.query(
        'UPDATE enterprise_capacity_allocations SET verdict = $2::jsonb, updated_at = NOW() WHERE allocation_id = $1 RETURNING *',
        [row.allocation_id, JSON.stringify(verdict)]
      );
      results.push(rowToAllocation(updated.rows[0]));
    }
    await this._event('intra_capacity_evaluated', null, who, {
      selfCustodyCents: cap.selfCustodyCents, capacityCents: cap.capacityCents, usedCents: cap.usedCents,
      intraRateBps: cap.intraRateBps, positions: cap.positions.length, open: results.length,
    });
    return { capacity: cap, allocations: results, summary: this._summary(results) };
  },

  _summary(allocations) {
    const open = allocations.filter((a) => OPEN_STATUSES.includes(a.status));
    const verdict = (a) => (a.verdict && a.verdict.verdict) || 'over';
    return {
      open: open.length,
      requestedCents: open.filter((a) => a.status === 'requested').reduce((s, a) => s + a.amountCents, 0),
      approvedCents: open.filter((a) => a.status === 'approved').reduce((s, a) => s + a.amountCents, 0),
      within: open.filter((a) => verdict(a) === 'within').length,
      partial: open.filter((a) => verdict(a) === 'partial').length,
      over: open.filter((a) => verdict(a) === 'over').length,
    };
  },

  async list({ limit = 50, status = null } = {}) {
    await this.ensureTables();
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const { rows } = status
      ? await pool.query('SELECT * FROM enterprise_capacity_allocations WHERE status = $1 ORDER BY created_at DESC LIMIT $2', [status, lim])
      : await pool.query('SELECT * FROM enterprise_capacity_allocations ORDER BY created_at DESC LIMIT $1', [lim]);
    return rows.map(rowToAllocation);
  },

  async get(allocationId) {
    const row = await this._require(allocationId);
    const events = await pool.query('SELECT event_id, event_type, actor, payload, event_hash, created_at FROM enterprise_capacity_events WHERE allocation_id = $1 ORDER BY sequence ASC', [row.allocation_id]);
    return { ...rowToAllocation(row), events: events.rows };
  },

  async status() {
    const cfg = this.config();
    await this.ensureTables();
    const allocations = await this.list({ limit: 500 });
    const chain = await this.verifyChain().catch((e) => ({ intact: false, error: e.message }));
    return {
      engine: 'enterprise-capacity',
      enabled: cfg.enabled,
      live: cfg.live,
      policy: { basis: 'self_custody', intraRateBps: cfg.intraRateBps, approvalThreshold: cfg.approvalThreshold, verdicts: VERDICTS, ...INTRA_ONLY },
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
    if (!s.enabled) blockers.push('ENTERPRISE_CAPACITY_ENABLED=false');
    if (!s.live) blockers.push('ENTERPRISE_CAPACITY_LIVE not true');
    if (!s.chain.intact) blockers.push(`enterprise capacity event chain broken: ${s.chain.error || `${(s.chain.breaks || []).length} break(s)`}`);
    if (s.policy.approvalThreshold < 2) blockers.push('PAYMENT_APPROVAL_THRESHOLD must be >= 2 (maker/checker)');
    if (s.capacity && s.capacity.error) blockers.push(`intra capacity unavailable: ${s.capacity.error}`);
    const warnings = [];
    if (s.capacity && !s.capacity.error && s.capacity.selfCustodyCents === 0) warnings.push('no self-custody positions in Custody OS');
    for (const a of s.allocations.filter((x) => OPEN_STATUSES.includes(x.status))) {
      const v = (a.verdict && a.verdict.verdict) || 'over';
      if (v !== 'within') warnings.push(`${a.allocationId} ($${a.amount} to ${a.designation}): ${v}, $${dollars((a.verdict && a.verdict.coveredCents) || 0)} covered`);
    }
    const ready = blockers.length === 0;
    return { ready, mode: ready ? 'live' : 'shadow', blockers, warnings, status: s };
  },

  async process({ action, actor = null, ...body } = {}) {
    switch (action) {
      case 'request': return this.request({ ...body, actor });
      case 'approve': return this.approve({ ...body, actor });
      case 'release': return this.release({ ...body, actor });
      case 'cancel': return this.cancel({ ...body, actor });
      case 'evaluate': return this.evaluate({ actor });
      case 'capacity': return this.capacity();
      case 'verify_chain': return this.verifyChain();
      case 'reseal_chain': return this.resealChain({ ...body, actor });
      default:
        throw new EnterpriseCapacityError(
          `unknown action "${action}" (request, approve, release, cancel, evaluate, capacity, verify_chain, reseal_chain)`,
          'ENTERPRISE_CAPACITY_UNKNOWN_ACTION', 400
        );
    }
  },
};

module.exports = { EnterpriseCapacityOsEngine, EnterpriseCapacityError, getEnterpriseCapacityConfig, STATUSES };
