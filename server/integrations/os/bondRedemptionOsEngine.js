'use strict';

/**
 * Bond Redemption Clearing & Settlement OS — the lifecycle that takes a bond
 * off the books without anyone hand-typing a principal payment.
 *
 * The bond engine already knows how to pay or receive principal on one bond
 * (`BondEngine.payPrincipal`), and the DataBridge already
 * carries interest accruals into the trust GL. What did not exist was the
 * process around the principal event: who called it, when the record date was
 * struck, which holders were owed what, whether the cash was there before the
 * value date, and how the redemption, once settled, reached the general ledger
 * and the event bus that every other module listens to.
 *
 * The engine models redemptions as *notices* that are cleared through *batches*:
 *
 *   notice      One redemption of one bond: full maturity, a partial/sinking-
 *               fund call, or an early call. Carries the redemption kind, the
 *               principal to redeem, the record date and the value date. The
 *               trust is either the issuer (DLB-PRB: cash leaves) or a holder
 *               (a purchased bond: cash arrives); the direction is fixed at the
 *               notice and drives the GL entry.
 *
 *     announced ─▶ record_struck ─▶ cleared ─▶ batched ─▶ settled
 *                                 └▶ rejected     └▶ cancelled (releases)
 *
 *   record      Striking the record date snapshots the holders entitled to the
 *               redemption proceeds (issuer side) as allocations. Holders come
 *               from the caller; if none are given the trust itself is the
 *               sole holder so a bond the trust bought redeems back to the
 *               trust's own operating account.
 *
 *   clearing    The pre-settlement gate. Every check the operator would
 *               otherwise do by eye: bond exists and is active, amount within
 *               principal balance, a full redemption before maturity is a
 *               `call` (not a `maturity`), allocations foot to the principal,
 *               value date not before record date, accrued interest disclosed.
 *               Failing a check parks the notice as `rejected` with the reasons.
 *
 *   batch       Cleared notices with the same value date, currency and
 *               direction net into one batch. The batch is the unit of funding
 *               and settlement: one net cash requirement, one settlement
 *               instruction per holder across every bond in the batch.
 *
 *   settlement  On settlement the engine calls the bond engine for each notice
 *               (the bond ledger stays the book of record for principal), then
 *               posts the GL entry through TrustAccountingEngine:
 *                 issuer:  DR Bonds Payable / CR Cash
 *                 holder:  DR Cash / CR Bond Investments
 *               and publishes `trust.bond.redemption.settled` on the canonical
 *               bus so DataBridge, dashboards and workers see one event.
 *
 * What it refuses: it will not settle a batch that is not funded, it will not
 * settle a notice twice (the notice row is the idempotency key), it never
 * touches principal outside the bond engine, and it never moves cash on a rail
 * — settlement instructions are emitted for Payer OS / wires to execute.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');

const REDEMPTION_KINDS = ['maturity', 'call', 'partial_call', 'sinking_fund'];
const DIRECTIONS = ['issuer', 'holder'];
const NOTICE_STATUSES = ['announced', 'record_struck', 'cleared', 'rejected', 'batched', 'settled', 'cancelled'];
const BATCH_STATUSES = ['open', 'funded', 'settling', 'settled', 'partially_settled', 'cancelled'];

const NOTICE_TRANSITIONS = Object.freeze({
  announced: new Set(['record_struck', 'cancelled']),
  record_struck: new Set(['cleared', 'rejected', 'cancelled']),
  rejected: new Set(['record_struck', 'cancelled']),
  cleared: new Set(['batched', 'cancelled']),
  batched: new Set(['settled', 'cleared']),
  settled: new Set([]),
  cancelled: new Set([]),
});

const BATCH_TRANSITIONS = Object.freeze({
  open: new Set(['funded', 'cancelled']),
  funded: new Set(['settling', 'cancelled']),
  settling: new Set(['settled', 'partially_settled']),
  partially_settled: new Set(['settling', 'settled']),
  settled: new Set([]),
  cancelled: new Set([]),
});

const GL = Object.freeze({
  CASH: process.env.BOND_REDEMPTION_CASH_GL || '1000',
  BOND_INVESTMENTS: process.env.BOND_REDEMPTION_INVESTMENT_GL || '1100',
  BONDS_PAYABLE: process.env.BOND_REDEMPTION_PAYABLE_GL || '2300',
});

class BondRedemptionError extends Error {
  constructor(message, code = 'BOND_REDEMPTION_ERROR', status = 409, details = {}) {
    super(message);
    this.name = 'BondRedemptionError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
    this.details = details;
  }
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function cents(value, field) {
  if (value === undefined || value === null || value === '') throw new BondRedemptionError(`${field} is required`, 'BOND_REDEMPTION_INVALID', 400);
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new BondRedemptionError(`${field} must be a positive integer number of cents`, 'BOND_REDEMPTION_INVALID', 400);
  return n;
}

function dollarsFromCents(c) {
  return Math.round(Number(c)) / 100;
}

function centsFromDollars(d) {
  return Math.round(Number(d || 0) * 100);
}

function isoDate(value, field) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new BondRedemptionError(`invalid date for ${field}: '${value}'`, 'BOND_REDEMPTION_INVALID', 400);
  return d.toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function assertTransition(table, from, to) {
  const allowed = table[from];
  if (!allowed || !allowed.has(to)) throw new BondRedemptionError(`cannot move from ${from} to ${to}`, 'BOND_REDEMPTION_STATE', 409, { from, to });
}

/**
 * Pure clearing rules. Exported so the gate can be unit-tested and reused by
 * the preflight endpoint without touching the database.
 *
 * @param {object} notice   mapped notice
 * @param {object} bond     { status, maturityDate, principalBalanceCents, currency }
 * @param {Array}  allocations [{ amountCents }]
 * @returns {{ ok: boolean, reasons: string[], warnings: string[] }}
 */
function clearingChecks(notice, bond, allocations) {
  const reasons = [];
  const warnings = [];
  if (!bond) return { ok: false, reasons: ['bond not found'], warnings };
  if (bond.status !== 'active') reasons.push(`bond is ${bond.status}; only active bonds redeem`);
  if (notice.principalCents > bond.principalBalanceCents) {
    reasons.push(`principal ${dollarsFromCents(notice.principalCents)} exceeds outstanding balance ${dollarsFromCents(bond.principalBalanceCents)}`);
  }
  const fullRedemption = notice.principalCents === bond.principalBalanceCents;
  const beforeMaturity = bond.maturityDate && notice.valueDate < bond.maturityDate;
  if (notice.kind === 'maturity' && beforeMaturity) reasons.push(`maturity redemption dated ${notice.valueDate} precedes maturity ${bond.maturityDate}; use kind 'call'`);
  if (notice.kind === 'maturity' && !fullRedemption) reasons.push('maturity redemption must retire the full outstanding principal');
  if ((notice.kind === 'partial_call' || notice.kind === 'sinking_fund') && fullRedemption) warnings.push('partial redemption retires the entire balance; bond will be marked matured/called');
  if (notice.recordDate && notice.valueDate < notice.recordDate) reasons.push('value date precedes record date');
  if (notice.currency && bond.currency && notice.currency !== bond.currency) reasons.push(`notice currency ${notice.currency} differs from bond currency ${bond.currency}`);
  const allocated = (allocations || []).reduce((s, a) => s + Number(a.amountCents || 0), 0);
  if ((allocations || []).length === 0) reasons.push('no holder allocations on record');
  else if (allocated !== notice.principalCents) reasons.push(`allocations ${dollarsFromCents(allocated)} do not foot to principal ${dollarsFromCents(notice.principalCents)}`);
  if (bond.accruedInterestCents > 0) warnings.push(`accrued interest ${dollarsFromCents(bond.accruedInterestCents)} outstanding; pay the coupon before or with redemption`);
  return { ok: reasons.length === 0, reasons, warnings };
}

/** Net one settlement leg per holder for the batch (same direction/currency/value date by construction). */
function netAllocations(allocations) {
  const legs = new Map();
  for (const a of allocations) {
    const key = `${a.holderRef}`;
    const leg = legs.get(key) || { holderRef: a.holderRef, holderName: a.holderName, settlementAccount: a.settlementAccount, amountCents: 0, noticeIds: [] };
    leg.amountCents += Number(a.amountCents);
    if (!leg.noticeIds.includes(a.noticeId)) leg.noticeIds.push(a.noticeId);
    legs.set(key, leg);
  }
  return [...legs.values()].sort((x, y) => y.amountCents - x.amountCents);
}

// ── Row mapping ──────────────────────────────────────────────────────────────

function mapNotice(r) {
  if (!r) return null;
  return {
    noticeId: r.notice_id, bondId: Number(r.bond_id), bondName: r.bond_name, kind: r.kind, direction: r.direction,
    principalCents: Number(r.principal_cents), premiumCents: Number(r.premium_cents || 0), currency: r.currency,
    recordDate: isoDate(r.record_date, 'record_date'), valueDate: isoDate(r.value_date, 'value_date'), status: r.status, batchId: r.batch_id,
    clearing: parseJson(r.clearing, null), reference: r.reference, memo: r.memo,
    bondTransactionId: r.bond_transaction_id, journalEntryId: r.journal_entry_id,
    announcedBy: r.announced_by, settledAt: r.settled_at, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function mapAllocation(r) {
  if (!r) return null;
  return {
    allocationId: r.allocation_id, noticeId: r.notice_id, holderRef: r.holder_ref, holderName: r.holder_name,
    settlementAccount: r.settlement_account, amountCents: Number(r.amount_cents), createdAt: r.created_at,
  };
}

function mapBatch(r) {
  if (!r) return null;
  return {
    batchId: r.batch_id, direction: r.direction, currency: r.currency, valueDate: isoDate(r.value_date, 'value_date'), status: r.status,
    noticeCount: Number(r.notice_count || 0), grossCents: Number(r.gross_cents || 0), netCents: Number(r.net_cents || 0),
    legs: parseJson(r.legs, []), funding: parseJson(r.funding, null), settlement: parseJson(r.settlement, null),
    openedBy: r.opened_by, fundedBy: r.funded_by, settledAt: r.settled_at, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// ── Engine ───────────────────────────────────────────────────────────────────

const BondRedemptionOsEngine = {
  BondRedemptionError,
  REDEMPTION_KINDS,
  DIRECTIONS,
  NOTICE_STATUSES,
  BATCH_STATUSES,
  GL,

  async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bond_redemption_notices (
        notice_id TEXT PRIMARY KEY,
        bond_id INTEGER NOT NULL,
        bond_name TEXT,
        kind TEXT NOT NULL,
        direction TEXT NOT NULL,
        principal_cents BIGINT NOT NULL,
        premium_cents BIGINT NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'USD',
        record_date DATE,
        value_date DATE NOT NULL,
        status TEXT NOT NULL,
        batch_id TEXT,
        clearing JSONB,
        reference TEXT,
        memo TEXT,
        bond_transaction_id TEXT,
        journal_entry_id TEXT,
        announced_by TEXT,
        settled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_bond_redemption_notice_ref ON bond_redemption_notices(reference) WHERE reference IS NOT NULL;
      CREATE TABLE IF NOT EXISTS bond_redemption_allocations (
        allocation_id TEXT PRIMARY KEY,
        notice_id TEXT NOT NULL,
        holder_ref TEXT NOT NULL,
        holder_name TEXT,
        settlement_account TEXT,
        amount_cents BIGINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS bond_redemption_batches (
        batch_id TEXT PRIMARY KEY,
        direction TEXT NOT NULL,
        currency TEXT NOT NULL,
        value_date DATE NOT NULL,
        status TEXT NOT NULL,
        notice_count INTEGER NOT NULL DEFAULT 0,
        gross_cents BIGINT NOT NULL DEFAULT 0,
        net_cents BIGINT NOT NULL DEFAULT 0,
        legs JSONB NOT NULL DEFAULT '[]',
        funding JSONB,
        settlement JSONB,
        opened_by TEXT,
        funded_by TEXT,
        settled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS bond_redemption_events (
        event_id TEXT PRIMARY KEY,
        subject_type TEXT,
        subject_id TEXT,
        event_type TEXT NOT NULL,
        actor TEXT,
        detail JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  },

  // ── Bond lookups ───────────────────────────────────────────────────────────

  async bondSnapshot(bondId) {
    const res = await pool.query(
      `SELECT b.id, b.bond_name, b.status, b.maturity_date, b.currency, b.face_value, b.issuer,
              COALESCE(bb.principal_balance, b.face_value) AS principal_balance, COALESCE(bb.accrued_interest, 0) AS accrued_interest
       FROM bonds b LEFT JOIN bond_balances bb ON bb.bond_id = b.id WHERE b.id = $1`,
      [Number(bondId)]
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      bondId: Number(r.id), bondName: r.bond_name, status: r.status, maturityDate: isoDate(r.maturity_date, 'maturity_date'),
      currency: r.currency || 'USD', faceValueCents: centsFromDollars(r.face_value), issuer: r.issuer || null,
      principalBalanceCents: centsFromDollars(r.principal_balance), accruedInterestCents: centsFromDollars(r.accrued_interest),
    };
  },

  /** Bonds whose maturity falls within the horizon and still carry principal — the redemption calendar. */
  async upcoming({ horizonDays = 90 } = {}) {
    await this.ensureTables();
    const res = await pool.query(
      `SELECT b.id, b.bond_name, b.status, b.maturity_date, b.currency, b.issuer, COALESCE(bb.principal_balance, b.face_value) AS principal_balance,
              (SELECT n.notice_id FROM bond_redemption_notices n WHERE n.bond_id = b.id AND n.status NOT IN ('cancelled', 'rejected') ORDER BY n.created_at DESC LIMIT 1) AS notice_id
       FROM bonds b LEFT JOIN bond_balances bb ON bb.bond_id = b.id
       WHERE b.status = 'active' AND COALESCE(bb.principal_balance, b.face_value) > 0 AND b.maturity_date <= CURRENT_DATE + ($1::int * INTERVAL '1 day')
       ORDER BY b.maturity_date ASC`,
      [Math.max(0, Number(horizonDays) || 90)]
    );
    return res.rows.map(r => ({
      bondId: Number(r.id), bondName: r.bond_name, status: r.status, maturityDate: isoDate(r.maturity_date, 'maturity_date'), currency: r.currency || 'USD',
      issuer: r.issuer || null, principalBalanceCents: centsFromDollars(r.principal_balance), noticeId: r.notice_id || null,
      daysToMaturity: Math.round((new Date(r.maturity_date).getTime() - Date.now()) / 86400000),
    }));
  },

  // ── Notices ────────────────────────────────────────────────────────────────

  async announce({ bondId, kind = 'maturity', direction = 'issuer', principalCents = null, premiumCents = 0, valueDate = null, recordDate = null, reference = null, memo = null, announcedBy = null } = {}) {
    if (!announcedBy) throw new BondRedemptionError('announcedBy is required: a redemption is called by a named trustee', 'BOND_REDEMPTION_NO_ACTOR', 400);
    if (!REDEMPTION_KINDS.includes(kind)) throw new BondRedemptionError(`kind must be one of ${REDEMPTION_KINDS.join(', ')}`, 'BOND_REDEMPTION_INVALID', 400);
    if (!DIRECTIONS.includes(direction)) throw new BondRedemptionError(`direction must be one of ${DIRECTIONS.join(', ')}`, 'BOND_REDEMPTION_INVALID', 400);
    await this.ensureTables();
    const bond = await this.bondSnapshot(bondId);
    if (!bond) throw new BondRedemptionError(`bond ${bondId} not found`, 'BOND_REDEMPTION_NOT_FOUND', 404);
    const principal = principalCents === null || principalCents === undefined ? bond.principalBalanceCents : cents(principalCents, 'principalCents');
    if (principal <= 0) throw new BondRedemptionError('bond has no outstanding principal to redeem', 'BOND_REDEMPTION_INVALID', 400);
    const premium = Number(premiumCents || 0);
    if (!Number.isInteger(premium) || premium < 0) throw new BondRedemptionError('premiumCents must be a non-negative integer', 'BOND_REDEMPTION_INVALID', 400);
    const value = isoDate(valueDate, 'valueDate') || bond.maturityDate;
    const record = isoDate(recordDate, 'recordDate');

    const noticeId = newId('RDM');
    const res = await pool.query(
      `INSERT INTO bond_redemption_notices (notice_id, bond_id, bond_name, kind, direction, principal_cents, premium_cents, currency, record_date, value_date, status, reference, memo, announced_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'announced', $11, $12, $13) RETURNING *`,
      [noticeId, bond.bondId, bond.bondName, kind, direction, principal, premium, bond.currency, record, value, reference, memo, announcedBy]
    );
    await this._event('notice', noticeId, 'redemption_announced', announcedBy, { bondId: bond.bondId, bondName: bond.bondName, kind, direction, principalCents: principal, valueDate: value });
    await this._publish('bondRedemptionAnnounced', { noticeId, bondId: bond.bondId, bondName: bond.bondName, kind, direction, principalCents: principal, valueDate: value, announcedBy });
    return mapNotice(res.rows[0]);
  },

  async notice(noticeId) {
    const res = await pool.query('SELECT * FROM bond_redemption_notices WHERE notice_id = $1', [noticeId]);
    if (!res.rows[0]) throw new BondRedemptionError(`notice ${noticeId} not found`, 'BOND_REDEMPTION_NOT_FOUND', 404);
    return mapNotice(res.rows[0]);
  },

  async notices({ status = null, bondId = null, limit = 100 } = {}) {
    await this.ensureTables();
    const conditions = [];
    const params = [];
    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    if (bondId) { params.push(Number(bondId)); conditions.push(`bond_id = $${params.length}`); }
    params.push(Math.min(500, Math.max(1, Number(limit) || 100)));
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await pool.query(`SELECT * FROM bond_redemption_notices ${where} ORDER BY value_date ASC, created_at DESC LIMIT $${params.length}`, params);
    return res.rows.map(mapNotice);
  },

  async allocations(noticeId) {
    const res = await pool.query('SELECT * FROM bond_redemption_allocations WHERE notice_id = $1 ORDER BY amount_cents DESC', [noticeId]);
    return res.rows.map(mapAllocation);
  },

  /**
   * Strike the record date: snapshot the holders entitled to proceeds. With no
   * holders supplied the trust is the sole holder of record, which is the
   * common case for a bond the trust bought and for the closely-held DLB-PRB.
   */
  async strikeRecord(noticeId, { holders = null, recordDate = null, actor = null } = {}) {
    const n = await this.notice(noticeId);
    assertTransition(NOTICE_TRANSITIONS, n.status, 'record_struck');
    const record = isoDate(recordDate, 'recordDate') || (n.status === 'announced' && n.recordDate) || (n.valueDate < today() ? n.valueDate : today());
    const list = Array.isArray(holders) && holders.length
      ? holders
      : [{ holderRef: 'trust:operating', holderName: 'DeAndrea Lavar Barkley Trust', settlementAccount: 'trust:1000', amountCents: n.principalCents }];

    const rows = [];
    for (const h of list) {
      if (!h.holderRef) throw new BondRedemptionError('each holder needs a holderRef', 'BOND_REDEMPTION_INVALID', 400);
      rows.push({ allocationId: newId('ALLOC'), holderRef: String(h.holderRef), holderName: h.holderName || null, settlementAccount: h.settlementAccount || null, amountCents: cents(h.amountCents, `amountCents for ${h.holderRef}`) });
    }
    const allocated = rows.reduce((s, r) => s + r.amountCents, 0);
    if (allocated !== n.principalCents) {
      throw new BondRedemptionError(`holder allocations ${dollarsFromCents(allocated)} must foot to principal ${dollarsFromCents(n.principalCents)}`, 'BOND_REDEMPTION_UNBALANCED', 400, { allocatedCents: allocated, principalCents: n.principalCents });
    }

    await pool.query('DELETE FROM bond_redemption_allocations WHERE notice_id = $1', [noticeId]);
    for (const r of rows) {
      await pool.query(
        'INSERT INTO bond_redemption_allocations (allocation_id, notice_id, holder_ref, holder_name, settlement_account, amount_cents) VALUES ($1, $2, $3, $4, $5, $6)',
        [r.allocationId, noticeId, r.holderRef, r.holderName, r.settlementAccount, r.amountCents]
      );
    }
    await pool.query("UPDATE bond_redemption_notices SET status = 'record_struck', record_date = $2, clearing = NULL, updated_at = NOW() WHERE notice_id = $1", [noticeId, record]);
    await this._event('notice', noticeId, 'record_struck', actor, { recordDate: record, holders: rows.length, allocatedCents: allocated });
    return { ...(await this.notice(noticeId)), allocations: rows };
  },

  /** Run the clearing gate and park the notice as cleared or rejected. */
  async clear(noticeId, { actor = null } = {}) {
    const n = await this.notice(noticeId);
    if (n.status === 'cleared') return { ...n, allocations: await this.allocations(noticeId) };
    assertTransition(NOTICE_TRANSITIONS, n.status, 'cleared');
    const [bond, allocations] = await Promise.all([this.bondSnapshot(n.bondId), this.allocations(noticeId)]);
    const result = clearingChecks(n, bond, allocations);
    const clearing = { ...result, checkedAt: new Date().toISOString(), checkedBy: actor, bond };
    const status = result.ok ? 'cleared' : 'rejected';
    await pool.query('UPDATE bond_redemption_notices SET status = $2, clearing = $3::jsonb, updated_at = NOW() WHERE notice_id = $1', [noticeId, status, JSON.stringify(clearing)]);
    await this._event('notice', noticeId, result.ok ? 'cleared' : 'rejected', actor, { reasons: result.reasons, warnings: result.warnings });
    return { ...(await this.notice(noticeId)), allocations };
  },

  /** Dry-run clearing for a hypothetical redemption; touches nothing. */
  async preflight({ bondId, kind = 'maturity', principalCents = null, valueDate = null, recordDate = null, holders = null } = {}) {
    const bond = await this.bondSnapshot(bondId);
    if (!bond) throw new BondRedemptionError(`bond ${bondId} not found`, 'BOND_REDEMPTION_NOT_FOUND', 404);
    const principal = principalCents === null || principalCents === undefined ? bond.principalBalanceCents : cents(principalCents, 'principalCents');
    const notice = { kind, principalCents: principal, currency: bond.currency, valueDate: isoDate(valueDate, 'valueDate') || bond.maturityDate, recordDate: isoDate(recordDate, 'recordDate') };
    const allocations = Array.isArray(holders) && holders.length ? holders.map(h => ({ amountCents: Number(h.amountCents || 0) })) : [{ amountCents: principal }];
    return { bond, notice, ...clearingChecks(notice, bond, allocations) };
  },

  async cancelNotice(noticeId, { actor = null, reason = null } = {}) {
    const n = await this.notice(noticeId);
    assertTransition(NOTICE_TRANSITIONS, n.status, 'cancelled');
    await pool.query("UPDATE bond_redemption_notices SET status = 'cancelled', batch_id = NULL, updated_at = NOW() WHERE notice_id = $1", [noticeId]);
    await this._event('notice', noticeId, 'cancelled', actor, { reason, previousStatus: n.status });
    return this.notice(noticeId);
  },

  // ── Batches: clearing & netting ────────────────────────────────────────────

  /**
   * Open a settlement batch from cleared notices sharing a value date,
   * direction and currency. Legs are netted per holder across bonds.
   */
  async openBatch({ valueDate = null, direction = 'issuer', currency = 'USD', noticeIds = null, openedBy = null } = {}) {
    if (!openedBy) throw new BondRedemptionError('openedBy is required', 'BOND_REDEMPTION_NO_ACTOR', 400);
    if (!DIRECTIONS.includes(direction)) throw new BondRedemptionError(`direction must be one of ${DIRECTIONS.join(', ')}`, 'BOND_REDEMPTION_INVALID', 400);
    await this.ensureTables();
    const cleared = (await this.notices({ status: 'cleared', limit: 500 })).filter(n => n.direction === direction && n.currency === currency
      && (!valueDate || n.valueDate === isoDate(valueDate, 'valueDate')) && (!noticeIds || noticeIds.includes(n.noticeId)));
    if (!cleared.length) throw new BondRedemptionError('no cleared notices match the batch criteria', 'BOND_REDEMPTION_EMPTY', 409);
    const dates = [...new Set(cleared.map(n => n.valueDate))];
    if (dates.length > 1) throw new BondRedemptionError('a batch settles one value date; pass valueDate to select', 'BOND_REDEMPTION_INVALID', 400, { valueDates: dates });

    const allocations = [];
    for (const n of cleared) for (const a of await this.allocations(n.noticeId)) allocations.push(a);
    const legs = netAllocations(allocations);
    const gross = cleared.reduce((s, n) => s + n.principalCents + n.premiumCents, 0);
    const net = legs.reduce((s, l) => s + l.amountCents, 0) + cleared.reduce((s, n) => s + n.premiumCents, 0);

    const batchId = newId('RDMB');
    const res = await pool.query(
      `INSERT INTO bond_redemption_batches (batch_id, direction, currency, value_date, status, notice_count, gross_cents, net_cents, legs, opened_by)
       VALUES ($1, $2, $3, $4, 'open', $5, $6, $7, $8::jsonb, $9) RETURNING *`,
      [batchId, direction, currency, dates[0], cleared.length, gross, net, JSON.stringify(legs), openedBy]
    );
    for (const n of cleared) {
      await pool.query("UPDATE bond_redemption_notices SET status = 'batched', batch_id = $2, updated_at = NOW() WHERE notice_id = $1", [n.noticeId, batchId]);
    }
    await this._event('batch', batchId, 'batch_opened', openedBy, { noticeIds: cleared.map(n => n.noticeId), legs: legs.length, netCents: net });
    return mapBatch(res.rows[0]);
  },

  async batch(batchId) {
    const res = await pool.query('SELECT * FROM bond_redemption_batches WHERE batch_id = $1', [batchId]);
    if (!res.rows[0]) throw new BondRedemptionError(`batch ${batchId} not found`, 'BOND_REDEMPTION_NOT_FOUND', 404);
    const notices = await pool.query('SELECT * FROM bond_redemption_notices WHERE batch_id = $1', [batchId]);
    return { ...mapBatch(res.rows[0]), notices: notices.rows.map(mapNotice) };
  },

  async batches({ status = null, limit = 50 } = {}) {
    await this.ensureTables();
    const params = [];
    let where = '';
    if (status) { params.push(status); where = 'WHERE status = $1'; }
    params.push(Math.min(200, Math.max(1, Number(limit) || 50)));
    const res = await pool.query(`SELECT * FROM bond_redemption_batches ${where} ORDER BY value_date DESC, created_at DESC LIMIT $${params.length}`, params);
    return res.rows.map(mapBatch);
  },

  /**
   * Funding check. Issuer batches need the net amount spendable in the trust
   * cash GL; holder batches are inbound and are funded by definition.
   */
  async fundBatch(batchId, { fundedBy = null, force = false } = {}) {
    if (!fundedBy) throw new BondRedemptionError('fundedBy is required', 'BOND_REDEMPTION_NO_ACTOR', 400);
    const b = await this.batch(batchId);
    assertTransition(BATCH_TRANSITIONS, b.status, 'funded');
    let funding = { required: b.direction === 'issuer', requiredCents: b.netCents, availableCents: null, funded: true, source: GL.CASH, checkedAt: new Date().toISOString() };
    if (b.direction === 'issuer') {
      const { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');
      const position = await TrustAccountingEngine.getFundingPosition(GL.CASH).catch(() => null);
      const available = position ? Number(position.available_balance_cents || 0) : null;
      funding = { ...funding, availableCents: available, funded: force || (available !== null && available >= b.netCents), forced: Boolean(force) };
      if (!funding.funded) {
        throw new BondRedemptionError(`cash GL ${GL.CASH} has $${(Number(available || 0) / 100).toFixed(2)} spendable against $${(b.netCents / 100).toFixed(2)} required`, 'BOND_REDEMPTION_UNFUNDED', 409, funding);
      }
    }
    await pool.query("UPDATE bond_redemption_batches SET status = 'funded', funding = $2::jsonb, funded_by = $3, updated_at = NOW() WHERE batch_id = $1", [batchId, JSON.stringify(funding), fundedBy]);
    await this._event('batch', batchId, 'batch_funded', fundedBy, funding);
    return this.batch(batchId);
  },

  /**
   * Settle: per notice, retire principal through the bond engine, post the GL
   * entry, emit the settlement instruction per leg, publish to the bus.
   */
  async settleBatch(batchId, { settledBy = null, postGl = true } = {}) {
    if (!settledBy) throw new BondRedemptionError('settledBy is required', 'BOND_REDEMPTION_NO_ACTOR', 400);
    const b = await this.batch(batchId);
    assertTransition(BATCH_TRANSITIONS, b.status, 'settling');
    await pool.query("UPDATE bond_redemption_batches SET status = 'settling', updated_at = NOW() WHERE batch_id = $1", [batchId]);

    const { BondEngine } = require('../bonds/bondEngine');
    const results = [];
    for (const n of b.notices) {
      if (n.status === 'settled') { results.push({ noticeId: n.noticeId, status: 'settled', skipped: true }); continue; }
      try {
        const amount = dollarsFromCents(n.principalCents);
        const bondResult = await BondEngine.payPrincipal(n.bondId, amount, {});
        const bondTxnId = bondResult && bondResult.transaction ? String(bondResult.transaction.id) : (bondResult && bondResult.id ? String(bondResult.id) : null);
        const retired = bondResult && Number(bondResult.new_principal_balance ?? bondResult.new_balance ?? 1) === 0;
        if (retired && n.kind !== 'maturity') {
          await pool.query("UPDATE bonds SET status = 'called', updated_at = NOW() WHERE id = $1 AND status IN ('active', 'matured')", [n.bondId]);
        }
        let journalEntryId = null;
        let glError = null;
        if (postGl) {
          try { journalEntryId = await this._postGl(n, settledBy); } catch (err) { glError = err.message; }
        }
        await pool.query(
          "UPDATE bond_redemption_notices SET status = 'settled', bond_transaction_id = $2, journal_entry_id = $3, settled_at = NOW(), updated_at = NOW() WHERE notice_id = $1",
          [n.noticeId, bondTxnId, journalEntryId]
        );
        await this._event('notice', n.noticeId, 'settled', settledBy, { bondTransactionId: bondTxnId, journalEntryId, glError });
        await this._publish('bondRedemptionSettled', { noticeId: n.noticeId, batchId, bondId: n.bondId, bondName: n.bondName, kind: n.kind, direction: n.direction, principalCents: n.principalCents, valueDate: n.valueDate, journalEntryId, settledBy });
        results.push({ noticeId: n.noticeId, status: 'settled', bondTransactionId: bondTxnId, journalEntryId, glError });
      } catch (err) {
        await this._event('notice', n.noticeId, 'settlement_failed', settledBy, { error: err.message });
        results.push({ noticeId: n.noticeId, status: 'failed', error: err.message });
      }
    }

    const failed = results.filter(r => r.status === 'failed');
    const finalStatus = failed.length ? 'partially_settled' : 'settled';
    const instructions = b.legs.map(l => ({
      holderRef: l.holderRef, holderName: l.holderName, settlementAccount: l.settlementAccount, amountCents: l.amountCents, currency: b.currency, valueDate: b.valueDate,
      direction: b.direction === 'issuer' ? 'credit_holder' : 'receive_from_issuer', noticeIds: l.noticeIds,
      memo: `Bond redemption ${b.batchId} value ${b.valueDate}`,
    }));
    const settlement = { settledBy, settledAt: new Date().toISOString(), results, instructions };
    await pool.query(
      `UPDATE bond_redemption_batches SET status = $2, settlement = $3::jsonb, settled_at = CASE WHEN $2 = 'settled' THEN NOW() ELSE settled_at END, updated_at = NOW() WHERE batch_id = $1`,
      [batchId, finalStatus, JSON.stringify(settlement)]
    );
    await this._event('batch', batchId, finalStatus === 'settled' ? 'batch_settled' : 'batch_partially_settled', settledBy, { settled: results.length - failed.length, failed: failed.length });
    return this.batch(batchId);
  },

  async cancelBatch(batchId, { cancelledBy = null, reason = null } = {}) {
    const b = await this.batch(batchId);
    assertTransition(BATCH_TRANSITIONS, b.status, 'cancelled');
    await pool.query("UPDATE bond_redemption_batches SET status = 'cancelled', updated_at = NOW() WHERE batch_id = $1", [batchId]);
    await pool.query("UPDATE bond_redemption_notices SET status = 'cleared', batch_id = NULL, updated_at = NOW() WHERE batch_id = $1 AND status = 'batched'", [batchId]);
    await this._event('batch', batchId, 'batch_cancelled', cancelledBy, { reason, released: b.notices.length });
    return this.batch(batchId);
  },

  // ── Unified data workflow hooks ────────────────────────────────────────────

  /**
   * Settled notices with no GL entry yet (settled with postGl=false, or a GL
   * failure at settlement time). DataBridge.syncBondRedemptionsToAccounting
   * drains this so the redemption always lands in the trust ledger.
   */
  async unpostedSettlements({ limit = 100 } = {}) {
    await this.ensureTables();
    const res = await pool.query("SELECT * FROM bond_redemption_notices WHERE status = 'settled' AND journal_entry_id IS NULL ORDER BY settled_at ASC LIMIT $1", [Math.max(1, Number(limit) || 100)]);
    return res.rows.map(mapNotice);
  },

  async postSettlementToGl(noticeId, { postedBy = 'data_bridge' } = {}) {
    const n = await this.notice(noticeId);
    if (n.status !== 'settled') throw new BondRedemptionError(`notice ${noticeId} is ${n.status}, not settled`, 'BOND_REDEMPTION_STATE', 409);
    if (n.journalEntryId) return n;
    const journalEntryId = await this._postGl(n, postedBy);
    await pool.query('UPDATE bond_redemption_notices SET journal_entry_id = $2, updated_at = NOW() WHERE notice_id = $1', [noticeId, journalEntryId]);
    return this.notice(noticeId);
  },

  async status() {
    await this.ensureTables();
    const [notices, batches, upcoming, unposted] = await Promise.all([
      pool.query('SELECT status, COUNT(*) AS n, COALESCE(SUM(principal_cents), 0) AS cents FROM bond_redemption_notices GROUP BY status'),
      pool.query('SELECT status, COUNT(*) AS n, COALESCE(SUM(net_cents), 0) AS cents FROM bond_redemption_batches GROUP BY status'),
      this.upcoming({ horizonDays: 90 }),
      this.unpostedSettlements({ limit: 50 }),
    ]);
    const fold = rows => Object.fromEntries(rows.map(r => [r.status, { count: Number(r.n), cents: Number(r.cents) }]));
    return {
      engine: 'bond-redemption-os', gl: GL,
      notices: fold(notices.rows), batches: fold(batches.rows),
      upcomingMaturities: upcoming, unpostedSettlements: unposted.length,
      kinds: REDEMPTION_KINDS, directions: DIRECTIONS,
    };
  },

  async events({ subjectId = null, limit = 100 } = {}) {
    await this.ensureTables();
    const params = [];
    let where = '';
    if (subjectId) { params.push(subjectId); where = 'WHERE subject_id = $1'; }
    params.push(Math.min(500, Math.max(1, Number(limit) || 100)));
    const res = await pool.query(`SELECT * FROM bond_redemption_events ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return res.rows.map(r => ({ eventId: r.event_id, subjectType: r.subject_type, subjectId: r.subject_id, eventType: r.event_type, actor: r.actor, detail: parseJson(r.detail, {}), createdAt: r.created_at }));
  },

  // ── Internals ──────────────────────────────────────────────────────────────

  async _postGl(n, postedBy) {
    const { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');
    await this._ensureGlAccounts();
    const amount = dollarsFromCents(n.principalCents + n.premiumCents);
    const lines = n.direction === 'issuer'
      ? [
        { accountCode: GL.BONDS_PAYABLE, debitAmount: amount, creditAmount: 0, memo: `Retire ${n.bondName} principal (${n.kind})` },
        { accountCode: GL.CASH, debitAmount: 0, creditAmount: amount, memo: `Redemption proceeds paid ${n.bondName}` },
      ]
      : [
        { accountCode: GL.CASH, debitAmount: amount, creditAmount: 0, memo: `Redemption proceeds received ${n.bondName}` },
        { accountCode: GL.BOND_INVESTMENTS, debitAmount: 0, creditAmount: amount, memo: `Derecognize ${n.bondName} (${n.kind})` },
      ];
    const entry = await TrustAccountingEngine.postJournalEntry({
      entryDate: n.valueDate, description: `Bond redemption — ${n.bondName} (${n.kind}, ${n.direction})`, lines,
      referenceType: 'bond_redemption', referenceId: n.noticeId, bondId: n.bondId, postedBy: postedBy || 'bond_redemption_os', postToFineract: false,
    });
    const id = entry && (entry.entry_id || entry.entryId || entry.id);
    await this._publish('ledgerPosted', { referenceType: 'bond_redemption', referenceId: n.noticeId, journalEntryId: id, bondId: n.bondId, amountCents: n.principalCents + n.premiumCents });
    return id ? String(id) : null;
  },

  async _ensureGlAccounts() {
    const wanted = [
      [GL.CASH, 'Cash — Trust Operating', 'asset', 'cash'],
      [GL.BOND_INVESTMENTS, 'Bond Investments', 'asset', 'investment'],
      [GL.BONDS_PAYABLE, 'Bonds Payable', 'liability', 'long_term_debt'],
    ];
    for (const [code, name, type, subType] of wanted) {
      const exists = await pool.query('SELECT 1 FROM trust_accounts WHERE account_code = $1', [code]);
      if (exists.rows.length === 0) {
        await pool.query('INSERT INTO trust_accounts (account_code, account_name, account_type, sub_type) VALUES ($1, $2, $3, $4)', [code, name, type, subType]);
      }
    }
  },

  async _event(subjectType, subjectId, eventType, actor, detail = {}) {
    await pool.query(
      'INSERT INTO bond_redemption_events (event_id, subject_type, subject_id, event_type, actor, detail) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
      [newId('RDMEV'), subjectType, subjectId, eventType, actor, JSON.stringify(detail || {})]
    );
  },

  async _publish(topicKey, payload) {
    try {
      const { KafkaEventBus, TOPICS } = require('../events/kafkaEventBus');
      const topic = TOPICS[topicKey];
      if (!topic) return null;
      return await KafkaEventBus.publish(topic, payload, { key: payload.noticeId || payload.referenceId || null });
    } catch (err) {
      console.warn('[bond-redemption-os] event publish failed:', err.message);
      return null;
    }
  },
};

module.exports = {
  BondRedemptionOsEngine,
  BondRedemptionError,
  clearingChecks,
  netAllocations,
  NOTICE_TRANSITIONS,
  BATCH_TRANSITIONS,
  REDEMPTION_KINDS,
  DIRECTIONS,
  GL,
};
