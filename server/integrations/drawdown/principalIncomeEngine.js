'use strict';

/**
 * Principal & Income Drawdown OS Engine
 *
 * A trust draws down on two different things, and trust accounting has always
 * kept them apart: principal (the corpus contributed or the assets it was
 * converted into) and income (what the corpus earns). Ohio's Uniform Principal
 * and Income Act works the same way — a receipt is allocated to one or the
 * other, a disbursement is charged against one or the other, and a beneficiary's
 * entitlement is stated against the right one.
 *
 * The ledger had no such layer. A drawdown against the bond was posted straight
 * into a cash account as a movement, which is why $6,000,000 of principal
 * allocation reads as spendable cash and dies at the rail: the *entitlement* was
 * recorded as if it were *money*. This engine separates the two:
 *
 *   1. A principal & income ledger (`recordEntry`) allocates every receipt and
 *      disbursement to principal or income, on a cash or accrual basis, and
 *      marks whether it is distributable. Accrued interest on an instrument the
 *      trust itself issued is recorded and reported, never distributable: the
 *      trust is both obligor and holder, so it is interest owed to itself.
 *   2. A drawdown lifecycle (`propose` → `authorize` → `fund`) where authorizing
 *      creates an *entitlement* and only `fund()` moves money — and it can fund
 *      no more than the attested cash available to that series. A drawdown with
 *      no cash behind it stays visible as authorized and unfunded, with the
 *      reason attached, instead of presenting as a balance.
 *
 * So `statement()` answers the question the cash account was answering wrongly:
 * authorized $6,000,000, funded $0, unfunded $6,000,000 because the principal
 * behind it is a self-issued instrument with no attested cash. The entitlement
 * is real and auditable; the funding is honest about itself.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');

let ReserveEngine;
try { ({ ReserveEngine } = require('../finops/reserveEngine')); } catch (e) { ReserveEngine = null; }

let SeriesOsEngine;
try { ({ SeriesOsEngine } = require('../series/seriesOsEngine')); } catch (e) { SeriesOsEngine = null; }

/** The two funds every trust receipt and disbursement belongs to. */
const ALLOCATIONS = ['principal', 'income'];

/**
 * Where an entry came from, and which fund it lands in by default. `accrualOnly`
 * sources never produce distributable cash on their own: an accrual is a
 * receivable until it is actually received.
 */
const ENTRY_SOURCES = {
  contribution: { allocation: 'principal', note: 'Property contributed to the trust' },
  bond_maturity: { allocation: 'principal', note: 'Return of principal at maturity or on sale' },
  capital_transfer: { allocation: 'principal', note: 'Proceeds of converting a principal asset' },
  bond_coupon: { allocation: 'income', note: 'Interest earned on a bond position' },
  interest: { allocation: 'income', note: 'Interest on cash or deposits' },
  rent: { allocation: 'income', note: 'Rent on trust property' },
  business_receipt: { allocation: 'income', note: 'Receipts of a trust-owned business' },
  accrued_interest: { allocation: 'income', accrualOnly: true, note: 'Interest accrued and not yet received' },
  trustee_fee: { allocation: 'income', note: 'Compensation and administration expense' },
  distribution: { allocation: 'income', note: 'Distribution to a beneficiary' },
};

const ENTRY_TYPES = ['receipt', 'disbursement'];
const BASES = ['cash', 'accrual'];

const DRAWDOWN_STATUSES = ['proposed', 'authorized', 'partially_funded', 'funded', 'cancelled'];

function id(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function cents(value) {
  return Math.round(Number(value || 0));
}

function dollars(value) {
  return Number(value || 0) / 100;
}

function requireText(value, message) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) throw new Error(message);
  return text;
}

function hashEvent({ prevHash, eventType, drawdownId, seriesId, actor, payload, createdAt }) {
  return crypto.createHash('sha256').update(JSON.stringify([
    prevHash || '',
    eventType,
    drawdownId || '',
    seriesId || '',
    actor || '',
    payload || {},
    createdAt,
  ])).digest('hex');
}

class DrawdownError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'DrawdownError';
    this.status = 409;
    this.code = 'DRAWDOWN_REFUSED';
    this.detail = detail;
  }
}

class PrincipalIncomeEngine {
  static config() {
    const signatures = Number(process.env.DRAWDOWN_SIGNATURES || 2);
    const rateBps = Number(process.env.PRINCIPAL_DRAWDOWN_RATE_BPS || 200);
    return {
      requiredSignatures: Number.isInteger(signatures) && signatures > 0 ? signatures : 2,
      // The trust instrument's annual allowance against corpus, in bps. The
      // existing bond allocation used 2% a year, which is the default here.
      principalRateBps: Number.isFinite(rateBps) && rateBps >= 0 ? Math.round(rateBps) : 200,
      principalStart: String(process.env.PRINCIPAL_DRAWDOWN_START || '2024-02-01').trim(),
    };
  }

  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pi_entries (
        entry_id           TEXT PRIMARY KEY,
        series_id          TEXT NOT NULL,
        allocation         TEXT NOT NULL CHECK (allocation IN ('principal','income')),
        entry_type         TEXT NOT NULL CHECK (entry_type IN ('receipt','disbursement')),
        basis              TEXT NOT NULL CHECK (basis IN ('cash','accrual')),
        source_kind        TEXT NOT NULL,
        source_ref         TEXT,
        amount_cents       BIGINT NOT NULL,
        distributable      BOOLEAN NOT NULL DEFAULT FALSE,
        non_distributable_reason TEXT,
        drawdown_id        TEXT,
        evidence_reference TEXT,
        memo               TEXT,
        recorded_by        TEXT NOT NULL,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_pi_entries_series ON pi_entries (series_id, allocation)`
    );
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pi_drawdowns (
        drawdown_id        TEXT PRIMARY KEY,
        series_id          TEXT NOT NULL,
        allocation         TEXT NOT NULL CHECK (allocation IN ('principal','income')),
        requested_cents    BIGINT NOT NULL,
        entitlement_cents  BIGINT NOT NULL DEFAULT 0,
        funded_cents       BIGINT NOT NULL DEFAULT 0,
        purpose            TEXT NOT NULL,
        beneficiary_ref    TEXT,
        memo               TEXT,
        status             TEXT NOT NULL DEFAULT 'proposed'
                           CHECK (status IN ('proposed','authorized','partially_funded','funded','cancelled')),
        required_signatures INTEGER NOT NULL DEFAULT 2,
        signatures         JSONB NOT NULL DEFAULT '[]',
        funding_note       TEXT,
        payment_reference  TEXT,
        proposed_by        TEXT NOT NULL,
        authorized_at      TIMESTAMPTZ,
        funded_at          TIMESTAMPTZ,
        cancel_reason      TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_pi_drawdowns_series ON pi_drawdowns (series_id, status)`
    );
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pi_events (
        sequence    BIGSERIAL PRIMARY KEY,
        event_id    TEXT UNIQUE NOT NULL,
        event_type  TEXT NOT NULL,
        drawdown_id TEXT,
        series_id   TEXT,
        actor       TEXT,
        payload     JSONB NOT NULL DEFAULT '{}',
        prev_hash   TEXT,
        event_hash  TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    return true;
  }

  // ── Event chain ────────────────────────────────────────────────────────────

  static async _appendEvent({ eventType, drawdownId = null, seriesId = null, actor = null, payload = {} }) {
    const tip = await pool.query('SELECT event_hash FROM pi_events ORDER BY sequence DESC LIMIT 1');
    const prevHash = (tip.rows[0] && tip.rows[0].event_hash) || null;
    const createdAt = new Date().toISOString();
    const eventId = id('PIE');
    const eventHash = hashEvent({ prevHash, eventType, drawdownId, seriesId, actor, payload, createdAt });
    const rows = await pool.query(
      `INSERT INTO pi_events
         (event_id, event_type, drawdown_id, series_id, actor, payload, prev_hash, event_hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [eventId, eventType, drawdownId, seriesId, actor, JSON.stringify(payload), prevHash, eventHash, createdAt]
    );
    return rows.rows[0];
  }

  static async events({ limit = 100 } = {}) {
    await this.ensureTables();
    const rows = await pool.query(
      'SELECT * FROM pi_events ORDER BY sequence DESC LIMIT $1',
      [Math.min(Math.max(Number(limit) || 100, 1), 1000)]
    );
    return rows.rows;
  }

  static async verifyChain() {
    await this.ensureTables();
    const rows = await pool.query('SELECT * FROM pi_events ORDER BY sequence ASC');
    let prevHash = null;
    const breaks = [];
    for (const row of rows.rows) {
      let payload = row.payload || {};
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch { payload = {}; }
      }
      const expected = hashEvent({
        prevHash,
        eventType: row.event_type,
        drawdownId: row.drawdown_id,
        seriesId: row.series_id,
        actor: row.actor,
        payload,
        createdAt: new Date(row.created_at).toISOString(),
      });
      if (expected !== row.event_hash || (row.prev_hash || null) !== prevHash) {
        breaks.push({ eventId: row.event_id, sequence: Number(row.sequence) });
      }
      prevHash = row.event_hash;
    }
    return {
      events: rows.rows.length,
      intact: breaks.length === 0,
      breaks,
      tipHash: prevHash,
      note: breaks.length === 0
        ? 'Every principal and income event hashes to its predecessor; the record is intact.'
        : 'The principal and income log has been altered: the listed events no longer hash to'
          + ' their predecessor.',
    };
  }

  // ── Series resolution ──────────────────────────────────────────────────────

  static async _series(seriesRef) {
    if (!SeriesOsEngine) throw new Error('The series OS engine is unavailable; a drawdown needs a series');
    const series = await SeriesOsEngine.getSeries(requireText(seriesRef, 'seriesRef is required'));
    if (!series) throw new Error(`Series ${seriesRef} not found`);
    return series;
  }

  // ── Principal & income ledger ──────────────────────────────────────────────

  /**
   * Post a receipt or disbursement to the principal & income ledger. The caller
   * names the source; the allocation follows from it unless overridden, because
   * "is this principal or income" is a rule about the source, not a preference.
   *
   * Distributability is decided here rather than trusted from the caller: an
   * accrual is never distributable, and neither is a receipt on an instrument
   * the trust issued to itself.
   */
  static async recordEntry({
    seriesRef, sourceKind, entryType = 'receipt', allocation = null, basis = 'cash',
    amountCents, sourceRef = null, evidenceReference = null, memo = null,
    drawdownId = null, recordedBy,
  } = {}) {
    const actor = requireText(recordedBy, 'recordedBy is required to post a principal or income entry');
    const kind = requireText(sourceKind, 'sourceKind is required').toLowerCase();
    const spec = ENTRY_SOURCES[kind];
    if (!spec) throw new Error(`sourceKind must be one of ${Object.keys(ENTRY_SOURCES).join(', ')}`);

    const type = String(entryType || 'receipt').toLowerCase();
    if (!ENTRY_TYPES.includes(type)) throw new Error(`entryType must be one of ${ENTRY_TYPES.join(', ')}`);

    const fund = String(allocation || spec.allocation).toLowerCase();
    if (!ALLOCATIONS.includes(fund)) throw new Error(`allocation must be one of ${ALLOCATIONS.join(', ')}`);

    const onBasis = spec.accrualOnly ? 'accrual' : String(basis || 'cash').toLowerCase();
    if (!BASES.includes(onBasis)) throw new Error(`basis must be one of ${BASES.join(', ')}`);

    const amount = cents(amountCents);
    if (amount <= 0) throw new Error('A principal or income entry requires a positive amountCents');

    const series = await this._series(seriesRef);
    await this.ensureTables();

    let distributable = type === 'receipt' && onBasis === 'cash';
    let reason = null;
    if (type === 'receipt' && onBasis === 'accrual') {
      reason = 'Accrued and not yet received: a receivable, not cash the trust can distribute';
      distributable = false;
    }
    // A coupon on a bond the trust issued is the trust paying itself. Recording
    // it is correct trust accounting; treating it as distributable income is not.
    if (distributable && (kind === 'bond_coupon' || kind === 'bond_maturity')) {
      const selfObligated = await this._isSelfObligated(sourceRef);
      if (selfObligated) {
        distributable = false;
        reason = 'The trust is both obligor and holder of this instrument, so the receipt is'
          + ' interest or principal it owes itself';
      }
    }

    const entryId = id('PIL');
    const rows = await pool.query(
      `INSERT INTO pi_entries
         (entry_id, series_id, allocation, entry_type, basis, source_kind, source_ref,
          amount_cents, distributable, non_distributable_reason, drawdown_id,
          evidence_reference, memo, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        entryId, series.series_id, fund, type, onBasis, kind, sourceRef, amount,
        distributable, reason, drawdownId, evidenceReference, memo, actor,
      ]
    );
    await this._appendEvent({
      eventType: `${fund}_${type}`,
      drawdownId,
      seriesId: series.series_id,
      actor,
      payload: { sourceKind: kind, basis: onBasis, amountCents: amount, distributable },
    });
    return rows.rows[0];
  }

  static async _isSelfObligated(sourceRef) {
    if (!ReserveEngine || !sourceRef) return false;
    const portfolio = await ReserveEngine.portfolio().catch(() => null);
    if (!portfolio) return false;
    const ref = String(sourceRef).toLowerCase();
    const position = portfolio.positions.find((p) => [p.isin, p.bondIdentifier, p.bondName]
      .filter(Boolean)
      .some((k) => String(k).toLowerCase() === ref));
    return Boolean(position && position.selfIssued);
  }

  static async ledger({ seriesRef = null, allocation = null, limit = 200 } = {}) {
    await this.ensureTables();
    const series = seriesRef ? await this._series(seriesRef) : null;
    const rows = await pool.query(
      `SELECT * FROM pi_entries
        WHERE ($1::text IS NULL OR series_id = $1)
          AND ($2::text IS NULL OR allocation = $2)
        ORDER BY created_at DESC
        LIMIT $3`,
      [series ? series.series_id : null, allocation, Math.min(Math.max(Number(limit) || 200, 1), 1000)]
    );
    return rows.rows;
  }

  static async _fundTotals(seriesId) {
    const rows = await pool.query(
      `SELECT allocation, entry_type, basis, distributable, COALESCE(SUM(amount_cents),0) AS total
         FROM pi_entries WHERE series_id = $1
        GROUP BY allocation, entry_type, basis, distributable`,
      [seriesId]
    );
    const totals = {
      principal: { receiptsCents: 0, disbursementsCents: 0, distributableCents: 0, accruedCents: 0 },
      income: { receiptsCents: 0, disbursementsCents: 0, distributableCents: 0, accruedCents: 0 },
    };
    for (const row of rows.rows) {
      const bucket = totals[row.allocation];
      if (!bucket) continue;
      const amount = cents(row.total);
      if (row.entry_type === 'receipt') {
        bucket.receiptsCents += amount;
        if (row.basis === 'accrual') bucket.accruedCents += amount;
        if (row.distributable === true) bucket.distributableCents += amount;
      } else {
        bucket.disbursementsCents += amount;
      }
    }
    return totals;
  }

  // ── Entitlement ────────────────────────────────────────────────────────────

  static _allowanceYears(startDate, now = new Date()) {
    const start = new Date(startDate);
    if (Number.isNaN(start.getTime())) return 1;
    const elapsedMs = now.getTime() - start.getTime();
    if (elapsedMs < 0) return 0;
    // The allowance is annual and accrues at the start of each trust year, so
    // the year in progress counts: 02/2024 through today is three allowances.
    return Math.floor(elapsedMs / (365.25 * 24 * 3600 * 1000)) + 1;
  }

  /**
   * What a series may draw, per fund, and how much of that could actually be
   * paid today. The two numbers are deliberately separate: the entitlement comes
   * from the trust instrument, the funding comes from attested cash, and the
   * whole point of this engine is that the first does not imply the second.
   */
  static async entitlement(seriesRef) {
    const cfg = this.config();
    const series = await this._series(seriesRef);
    await this.ensureTables();

    const totals = await this._fundTotals(series.series_id);
    const sheet = await SeriesOsEngine.balanceSheet(series.series_id);

    // Principal base: the carrying value of the principal assets fenced into the
    // series, whether or not they are attested — the instrument's allowance is
    // written against corpus, not against cash.
    const principalAssets = sheet.assets.filter((a) => a.assetKind === 'bond' || a.assetKind === 'cash_account');
    const corpusCents = principalAssets.reduce((sum, a) => sum + cents(a.valueCents), 0)
      + totals.principal.receiptsCents;
    const allowanceYears = this._allowanceYears(cfg.principalStart);
    const principalAllowanceCents = Math.round((corpusCents * cfg.principalRateBps * allowanceYears) / 10000);

    const drawn = await pool.query(
      `SELECT allocation, COALESCE(SUM(requested_cents),0) AS committed,
              COALESCE(SUM(funded_cents),0) AS funded
         FROM pi_drawdowns
        WHERE series_id = $1 AND status <> 'cancelled'
        GROUP BY allocation`,
      [series.series_id]
    );
    const committed = { principal: 0, income: 0 };
    const funded = { principal: 0, income: 0 };
    for (const row of drawn.rows) {
      committed[row.allocation] = cents(row.committed);
      funded[row.allocation] = cents(row.funded);
    }

    const principalRemaining = Math.max(0, principalAllowanceCents - committed.principal);
    // Income is only ever drawable to the extent it was actually received in
    // cash; accrued income sits outside this number by design.
    const incomeAllowanceCents = Math.max(
      0,
      totals.income.distributableCents - totals.income.disbursementsCents
    );
    const incomeRemaining = Math.max(0, incomeAllowanceCents - committed.income + funded.income);

    const fundableCents = Math.max(0, cents(sheet.availableCents));
    const build = (allocation, allowanceCents, remainingCents) => {
      const fundable = Math.min(remainingCents, fundableCents);
      return {
        allocation,
        allowanceCents,
        allowance: dollars(allowanceCents),
        committedCents: committed[allocation],
        committed: dollars(committed[allocation]),
        fundedCents: funded[allocation],
        funded: dollars(funded[allocation]),
        remainingCents,
        remaining: dollars(remainingCents),
        fundableCents: fundable,
        fundable: dollars(fundable),
        unbackedCents: Math.max(0, remainingCents - fundable),
        unbacked: dollars(Math.max(0, remainingCents - fundable)),
      };
    };

    return {
      seriesId: series.series_id,
      seriesCode: series.series_code,
      corpusCents,
      corpus: dollars(corpusCents),
      principalRateBps: cfg.principalRateBps,
      allowanceYears,
      seriesAvailableCents: fundableCents,
      seriesAvailable: dollars(fundableCents),
      principal: build('principal', principalAllowanceCents, principalRemaining),
      income: build('income', incomeAllowanceCents, incomeRemaining),
      accruedIncome: dollars(totals.income.accruedCents),
      note: fundableCents > 0
        ? 'Entitlement can be funded up to the attested cash fenced into this series.'
        : 'The series holds an entitlement against corpus but no attested cash, so an authorized'
          + ' drawdown will stay unfunded until a capital transfer settles cash into it.',
    };
  }

  // ── Drawdown lifecycle ─────────────────────────────────────────────────────

  static async get(drawdownId) {
    await this.ensureTables();
    const rows = await pool.query(
      'SELECT * FROM pi_drawdowns WHERE drawdown_id = $1',
      [requireText(drawdownId, 'drawdownId is required')]
    );
    return rows.rows[0] || null;
  }

  static async list({ seriesRef = null, status = null, limit = 100 } = {}) {
    await this.ensureTables();
    const series = seriesRef ? await this._series(seriesRef) : null;
    const rows = await pool.query(
      `SELECT * FROM pi_drawdowns
        WHERE ($1::text IS NULL OR series_id = $1)
          AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC
        LIMIT $3`,
      [series ? series.series_id : null, status, Math.min(Math.max(Number(limit) || 100, 1), 500)]
    );
    return rows.rows;
  }

  /**
   * Request a drawdown against one fund of one series. Refused above the
   * entitlement — that is a trust instrument limit, so it is checked before any
   * question of cash arises.
   */
  static async propose({
    seriesRef, allocation, amountCents, purpose, beneficiaryRef = null, memo = null, proposedBy,
  } = {}) {
    const cfg = this.config();
    const actor = requireText(proposedBy, 'proposedBy is required to request a drawdown');
    const fund = String(allocation || '').toLowerCase();
    if (!ALLOCATIONS.includes(fund)) throw new Error(`allocation must be one of ${ALLOCATIONS.join(', ')}`);
    const reason = requireText(purpose, 'purpose is required: what the drawdown is for');
    const amount = cents(amountCents);
    if (amount <= 0) throw new Error('A drawdown requires a positive amountCents');

    const series = await this._series(seriesRef);
    if (series.status !== 'active') {
      throw new DrawdownError(
        `Series ${series.series_code} is ${series.status} and cannot draw down.`,
        { seriesCode: series.series_code, status: series.status }
      );
    }

    const entitlement = await this.entitlement(series.series_id);
    const available = entitlement[fund];
    if (amount > available.remainingCents) {
      throw new DrawdownError(
        `A ${fund} drawdown of $${dollars(amount)} exceeds the $${available.remaining} remaining`
        + ` entitlement for series ${series.series_code}`
        + (fund === 'income'
          ? ': income is drawable only to the extent it was received in cash.'
          : `: ${cfg.principalRateBps / 100}% a year against corpus over ${entitlement.allowanceYears}`
            + ' allowance years, less what is already committed.'),
        { requested: dollars(amount), remaining: available.remaining, allocation: fund }
      );
    }

    await this.ensureTables();
    const drawdownId = id('PID');
    const rows = await pool.query(
      `INSERT INTO pi_drawdowns
         (drawdown_id, series_id, allocation, requested_cents, entitlement_cents, purpose,
          beneficiary_ref, memo, required_signatures, proposed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        drawdownId, series.series_id, fund, amount, available.remainingCents, reason,
        beneficiaryRef || series.beneficiary_ref || null, memo, cfg.requiredSignatures, actor,
      ]
    );
    await this._appendEvent({
      eventType: 'drawdown_proposed',
      drawdownId,
      seriesId: series.series_id,
      actor,
      payload: { allocation: fund, amountCents: amount, purpose: reason },
    });
    return rows.rows[0];
  }

  /** Trustee signature. Distinct signers only; the last one authorizes. */
  static async authorize(drawdownId, signedBy, { role = null } = {}) {
    const signer = requireText(signedBy, 'signedBy is required to authorize a drawdown');
    const drawdown = await this.get(drawdownId);
    if (!drawdown) throw new Error(`Drawdown ${drawdownId} not found`);
    if (drawdown.status !== 'proposed') {
      throw new DrawdownError(
        `Drawdown ${drawdown.drawdown_id} is ${drawdown.status}; only a proposed drawdown can be signed.`,
        { status: drawdown.status }
      );
    }

    let signatures = drawdown.signatures || [];
    if (typeof signatures === 'string') {
      try { signatures = JSON.parse(signatures); } catch { signatures = []; }
    }
    if (signatures.some((s) => String(s.signedBy).toLowerCase() === signer.toLowerCase())) {
      throw new DrawdownError(
        `${signer} has already signed drawdown ${drawdown.drawdown_id}; dual control needs a second trustee.`,
        { signedBy: signer }
      );
    }
    signatures.push({ signedBy: signer, role, signedAt: new Date().toISOString() });

    const required = Number(drawdown.required_signatures) || this.config().requiredSignatures;
    const status = signatures.length >= required ? 'authorized' : 'proposed';
    const rows = await pool.query(
      `UPDATE pi_drawdowns
          SET signatures = $2::jsonb, status = $3, updated_at = NOW(),
              authorized_at = CASE WHEN $3 = 'authorized' THEN NOW() ELSE authorized_at END
        WHERE drawdown_id = $1
        RETURNING *`,
      [drawdown.drawdown_id, JSON.stringify(signatures), status]
    );
    await this._appendEvent({
      eventType: status === 'authorized' ? 'drawdown_authorized' : 'drawdown_signed',
      drawdownId: drawdown.drawdown_id,
      seriesId: drawdown.series_id,
      actor: signer,
      payload: { signatures: signatures.length, required },
    });
    return {
      ...rows.rows[0],
      remainingSignatures: Math.max(0, required - signatures.length),
      note: status === 'authorized'
        ? 'Authorized as an entitlement. It becomes money only when fund() finds attested cash'
          + ' fenced into this series.'
        : `Needs ${required - signatures.length} more distinct trustee signature(s).`,
    };
  }

  /**
   * Pay an authorized drawdown, to the extent the series has attested cash. The
   * funded part posts a cash disbursement against the right fund; the rest stays
   * outstanding with the reason, because a trust cannot distribute a balance it
   * does not hold.
   */
  static async fund(drawdownId, { paymentReference = null, fundedBy, amountCents = null } = {}) {
    const actor = requireText(fundedBy, 'fundedBy is required to fund a drawdown');
    const drawdown = await this.get(drawdownId);
    if (!drawdown) throw new Error(`Drawdown ${drawdownId} not found`);
    if (!['authorized', 'partially_funded'].includes(drawdown.status)) {
      throw new DrawdownError(
        `Drawdown ${drawdown.drawdown_id} is ${drawdown.status}; it must be authorized by`
        + ` ${drawdown.required_signatures} trustees before it can be funded.`,
        { status: drawdown.status }
      );
    }

    const outstandingCents = cents(drawdown.requested_cents) - cents(drawdown.funded_cents);
    if (outstandingCents <= 0) throw new DrawdownError('This drawdown is already fully funded.');

    const sheet = await SeriesOsEngine.balanceSheet(drawdown.series_id);
    const requested = amountCents === null ? outstandingCents : cents(amountCents);
    if (requested <= 0) throw new Error('amountCents must be positive when funding part of a drawdown');
    if (requested > outstandingCents) {
      throw new DrawdownError(
        `$${dollars(requested)} exceeds the $${dollars(outstandingCents)} outstanding on this drawdown.`,
        { outstanding: dollars(outstandingCents) }
      );
    }

    const payableCents = Math.min(requested, Math.max(0, cents(sheet.availableCents)));
    if (payableCents <= 0) {
      const note = `Authorized but unfunded: series ${sheet.seriesCode} has $${sheet.available} of`
        + ' attested cash available. The entitlement stands; it needs a settled capital transfer'
        + ' or a real receipt before it can be paid.';
      await pool.query(
        `UPDATE pi_drawdowns SET funding_note = $2, updated_at = NOW() WHERE drawdown_id = $1`,
        [drawdown.drawdown_id, note]
      );
      await this._appendEvent({
        eventType: 'drawdown_unfunded',
        drawdownId: drawdown.drawdown_id,
        seriesId: drawdown.series_id,
        actor,
        payload: { outstandingCents, seriesAvailableCents: cents(sheet.availableCents) },
      });
      return {
        ...(await this.get(drawdown.drawdown_id)),
        fundedNow: 0,
        outstanding: dollars(outstandingCents),
        funding_note: note,
        note,
      };
    }

    const reference = requireText(
      paymentReference,
      'paymentReference is required to fund a drawdown: the rail or transfer that paid it'
    );
    const entry = await this.recordEntry({
      seriesRef: drawdown.series_id,
      sourceKind: 'distribution',
      entryType: 'disbursement',
      allocation: drawdown.allocation,
      basis: 'cash',
      amountCents: payableCents,
      sourceRef: reference,
      drawdownId: drawdown.drawdown_id,
      memo: drawdown.purpose,
      recordedBy: actor,
    });

    const fundedTotal = cents(drawdown.funded_cents) + payableCents;
    const status = fundedTotal >= cents(drawdown.requested_cents) ? 'funded' : 'partially_funded';
    const note = status === 'funded'
      ? `Funded in full from attested cash in series ${sheet.seriesCode}.`
      : `Funded $${dollars(payableCents)} of $${dollars(cents(drawdown.requested_cents))};`
        + ` $${dollars(cents(drawdown.requested_cents) - fundedTotal)} remains outstanding for want of`
        + ' attested cash.';
    const rows = await pool.query(
      `UPDATE pi_drawdowns
          SET funded_cents = $2, status = $3, funding_note = $4, payment_reference = $5,
              funded_at = CASE WHEN $3 = 'funded' THEN NOW() ELSE funded_at END,
              updated_at = NOW()
        WHERE drawdown_id = $1
        RETURNING *`,
      [drawdown.drawdown_id, fundedTotal, status, note, reference]
    );
    await this._appendEvent({
      eventType: 'drawdown_funded',
      drawdownId: drawdown.drawdown_id,
      seriesId: drawdown.series_id,
      actor,
      payload: { fundedCents: payableCents, status, paymentReference: reference, entryId: entry.entry_id },
    });
    return { ...rows.rows[0], fundedNow: dollars(payableCents), entryId: entry.entry_id, note };
  }

  static async cancel(drawdownId, { reason, cancelledBy } = {}) {
    const actor = requireText(cancelledBy, 'cancelledBy is required');
    const why = requireText(reason, 'reason is required to cancel a drawdown');
    const drawdown = await this.get(drawdownId);
    if (!drawdown) throw new Error(`Drawdown ${drawdownId} not found`);
    if (['funded', 'cancelled'].includes(drawdown.status)) {
      throw new DrawdownError(`Drawdown ${drawdown.drawdown_id} is ${drawdown.status}.`, {
        status: drawdown.status,
      });
    }
    const rows = await pool.query(
      `UPDATE pi_drawdowns SET status = 'cancelled', cancel_reason = $2, updated_at = NOW()
        WHERE drawdown_id = $1 RETURNING *`,
      [drawdown.drawdown_id, why]
    );
    await this._appendEvent({
      eventType: 'drawdown_cancelled',
      drawdownId: drawdown.drawdown_id,
      seriesId: drawdown.series_id,
      actor,
      payload: { reason: why, fundedCents: cents(drawdown.funded_cents) },
    });
    return rows.rows[0];
  }

  // ── Reporting ──────────────────────────────────────────────────────────────

  /**
   * The fiduciary accounting for one series: principal and income each with
   * receipts, disbursements and what is distributable, plus every drawdown with
   * authorized vs funded stated separately.
   */
  static async statement(seriesRef) {
    const series = await this._series(seriesRef);
    const totals = await this._fundTotals(series.series_id);
    const entitlement = await this.entitlement(series.series_id);
    const drawdowns = await this.list({ seriesRef: series.series_id, limit: 500 });

    const live = drawdowns.filter((d) => d.status !== 'cancelled');
    const authorizedCents = live
      .filter((d) => d.status !== 'proposed')
      .reduce((sum, d) => sum + cents(d.requested_cents), 0);
    const fundedCents = live.reduce((sum, d) => sum + cents(d.funded_cents), 0);
    const unfundedCents = Math.max(0, authorizedCents - fundedCents);

    const fund = (allocation) => {
      const t = totals[allocation];
      return {
        allocation,
        receipts: dollars(t.receiptsCents),
        disbursements: dollars(t.disbursementsCents),
        distributable: dollars(t.distributableCents),
        accrued: dollars(t.accruedCents),
        balance: dollars(t.receiptsCents - t.disbursementsCents),
      };
    };

    return {
      seriesId: series.series_id,
      seriesCode: series.series_code,
      seriesName: series.series_name,
      beneficiaryRef: series.beneficiary_ref,
      principal: fund('principal'),
      income: fund('income'),
      entitlement,
      drawdowns,
      authorized: dollars(authorizedCents),
      funded: dollars(fundedCents),
      unfunded: dollars(unfundedCents),
      note: unfundedCents > 0
        ? `$${dollars(unfundedCents)} of authorized drawdowns is unfunded: the entitlement is`
          + ' recorded against corpus, but no attested cash is fenced into this series to pay it.'
        : 'Every authorized drawdown has been funded from attested cash.',
    };
  }

  static async status() {
    const cfg = this.config();
    await this.ensureTables().catch(() => null);
    const chain = await this.verifyChain().catch((e) => ({ error: e.message }));
    let series = [];
    if (SeriesOsEngine) {
      const rows = await SeriesOsEngine.listSeries().catch(() => []);
      for (const row of rows) {
        series.push(await this.statement(row.series_id).catch((e) => ({
          seriesCode: row.series_code, error: e.message,
        })));
      }
    }
    const sum = (key) => series.reduce((total, s) => total + Number(s[key] || 0), 0);
    return {
      requiredSignatures: cfg.requiredSignatures,
      principalRateBps: cfg.principalRateBps,
      principalStart: cfg.principalStart,
      allocations: ALLOCATIONS,
      sources: Object.entries(ENTRY_SOURCES).map(([kind, spec]) => ({
        sourceKind: kind,
        allocation: spec.allocation,
        accrualOnly: Boolean(spec.accrualOnly),
        note: spec.note,
      })),
      seriesEngineAvailable: Boolean(SeriesOsEngine),
      reserveEngineAvailable: Boolean(ReserveEngine),
      series,
      authorized: sum('authorized'),
      funded: sum('funded'),
      unfunded: sum('unfunded'),
      chain,
      note: 'A drawdown is an entitlement against principal or income. Authorizing one records what'
        + ' a beneficiary may receive; funding one moves money, and it can only draw on cash'
        + ' attested to the series.',
    };
  }
}

module.exports = {
  PrincipalIncomeEngine,
  DrawdownError,
  PI_ALLOCATIONS: ALLOCATIONS,
  PI_ENTRY_SOURCES: ENTRY_SOURCES,
  PI_DRAWDOWN_STATUSES: DRAWDOWN_STATUSES,
};
