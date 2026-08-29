'use strict';

/**
 * Master Trust / Series OS Engine
 *
 * A master trust with series (the same structure a series LLC or a segregated
 * portfolio company uses) is how a private trust keeps one beneficiary's assets
 * from answering for another's obligations. The reserve engine could say how
 * much backing the trust held in total, and the Custody OS could say who holds
 * each asset — but nothing said *which pool an asset belongs to*, so every
 * attested dollar implicitly backed every obligation. That is commingling.
 *
 * This engine supplies the two missing pieces:
 *
 *   1. Reserve asset identification — `identify()` inventories every asset the
 *      trust can point at (reserve attestations, bond positions, custody
 *      positions, ledger cash accounts), says how each one was identified, and
 *      classifies what it actually contributes: `spendable` (attested external
 *      cash), `collateral` (custodian-held fixed income, sellable/pledgeable),
 *      `evidence` (a record that supports another asset), or `internal_only`
 *      (a ledger claim with no external backing).
 *   2. Ring-fencing — an identified asset is assigned to exactly one series.
 *      A second assignment is refused, so the assignment table is a partition
 *      rather than a set of overlapping claims. `assertSeriesSpendable()` then
 *      lets a series draw only on its own spendable assets, net of its own open
 *      obligations, and `statement()` reports what is still unassigned.
 *
 * Every structural action appends a hash-chained series event, so the record of
 * which pool an asset was fenced into is tamper-evident.
 *
 * What the engine deliberately does not do: identification never upgrades an
 * asset. Assigning a ledger balance to a series does not make it spendable, and
 * fencing a self-issued instrument into a beneficiary series does not give that
 * series external funds. Ring-fencing partitions backing; it cannot create it.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');

let ReserveEngine;
try { ({ ReserveEngine } = require('../finops/reserveEngine')); } catch (e) { ReserveEngine = null; }

let CustodyOsEngine;
try { ({ CustodyOsEngine } = require('../custody/custodyOsEngine')); } catch (e) { CustodyOsEngine = null; }

/** What a series exists to do. Drives reporting, not permissions. */
const SERIES_PURPOSES = [
  'beneficiary_support',
  'trust_operations',
  'reserve',
  'investment',
  'insurance',
  'custody',
];

/** The kinds of asset the identification pass can inventory and fence. */
const ASSET_KINDS = ['reserve_attestation', 'bond', 'custody_position', 'cash_account'];

/**
 * What an identified asset contributes to the series it is fenced into.
 * `evidence` and `internal_only` contribute nothing on purpose: a custody
 * receipt is the proof behind an attestation rather than a second asset, and a
 * ledger balance with no external deposit behind it is a claim on the trust
 * itself.
 */
const VALUE_KINDS = ['spendable', 'collateral', 'evidence', 'internal_only'];

const ENFORCEMENT_MODES = ['strict', 'warn', 'off'];

const OBLIGATION_STATUSES = ['open', 'settled', 'cancelled'];

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

function assetKey(assetKind, assetRef) {
  return `${assetKind}:${String(assetRef).toLowerCase()}`;
}

function hashEvent({ prevHash, eventType, seriesId, assetKey: key, actor, payload, createdAt }) {
  return crypto.createHash('sha256').update(JSON.stringify([
    prevHash || '',
    eventType,
    seriesId || '',
    key || '',
    actor || '',
    payload || {},
    createdAt,
  ])).digest('hex');
}

class SeriesRingFenceError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'SeriesRingFenceError';
    this.status = 409;
    this.code = 'RING_FENCE_BREACH';
    this.detail = detail;
  }
}

class SeriesOsEngine {
  static config() {
    return {
      masterTrustName: String(process.env.MASTER_TRUST_NAME || 'DeAndrea Lavar Barkley Trust Company').trim(),
      enforcement: (() => {
        const mode = String(process.env.SERIES_RING_FENCE_ENFORCEMENT || 'strict').toLowerCase();
        return ENFORCEMENT_MODES.includes(mode) ? mode : 'strict';
      })(),
    };
  }

  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trust_series (
        series_id       TEXT PRIMARY KEY,
        series_code     TEXT UNIQUE NOT NULL,
        series_name     TEXT NOT NULL,
        purpose         TEXT NOT NULL,
        beneficiary_ref TEXT,
        mandate         TEXT,
        ring_fenced     BOOLEAN NOT NULL DEFAULT TRUE,
        status          TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','suspended','closed')),
        opened_by       TEXT NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS series_asset_assignments (
        assignment_id         TEXT PRIMARY KEY,
        series_id             TEXT NOT NULL REFERENCES trust_series(series_id),
        asset_kind            TEXT NOT NULL,
        asset_ref             TEXT NOT NULL,
        asset_class           TEXT,
        value_kind            TEXT NOT NULL,
        identification        TEXT NOT NULL,
        identified_value_cents BIGINT NOT NULL DEFAULT 0,
        evidence_reference    TEXT,
        assigned_by           TEXT NOT NULL,
        status                TEXT NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','released')),
        release_reason        TEXT,
        released_by           TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        released_at           TIMESTAMPTZ
      )
    `);
    // The ring fence itself: an asset may be assigned to at most one series at a
    // time. Without this, two series could each report the same dollar as theirs.
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_series_assignment_exclusive
        ON series_asset_assignments (asset_kind, LOWER(asset_ref))
        WHERE status = 'active'
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS series_obligations (
        obligation_id   TEXT PRIMARY KEY,
        series_id       TEXT NOT NULL REFERENCES trust_series(series_id),
        obligation_type TEXT NOT NULL,
        counterparty    TEXT,
        amount_cents    BIGINT NOT NULL,
        memo            TEXT,
        status          TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','settled','cancelled')),
        created_by      TEXT NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        settled_at      TIMESTAMPTZ
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS series_events (
        sequence   BIGSERIAL PRIMARY KEY,
        event_id   TEXT UNIQUE NOT NULL,
        event_type TEXT NOT NULL,
        series_id  TEXT,
        asset_key  TEXT,
        actor      TEXT,
        payload    JSONB NOT NULL DEFAULT '{}',
        prev_hash  TEXT,
        event_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_series_assignments_series
         ON series_asset_assignments (series_id, status)`
    );
    return true;
  }

  // ── Series register ────────────────────────────────────────────────────────

  static async _appendEvent({ eventType, seriesId = null, assetKey: key = null, actor = null, payload = {} }) {
    const tip = await pool.query('SELECT event_hash FROM series_events ORDER BY sequence DESC LIMIT 1');
    const prevHash = (tip.rows[0] && tip.rows[0].event_hash) || null;
    const createdAt = new Date().toISOString();
    const eventId = id('SEV');
    const eventHash = hashEvent({ prevHash, eventType, seriesId, assetKey: key, actor, payload, createdAt });
    const rows = await pool.query(
      `INSERT INTO series_events
         (event_id, event_type, series_id, asset_key, actor, payload, prev_hash, event_hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [eventId, eventType, seriesId, key, actor, JSON.stringify(payload), prevHash, eventHash, createdAt]
    );
    return rows.rows[0];
  }

  static async events({ limit = 100 } = {}) {
    await this.ensureTables();
    const rows = await pool.query(
      'SELECT * FROM series_events ORDER BY sequence DESC LIMIT $1',
      [Math.min(Math.max(Number(limit) || 100, 1), 1000)]
    );
    return rows.rows;
  }

  static async verifyChain() {
    await this.ensureTables();
    const rows = await pool.query('SELECT * FROM series_events ORDER BY sequence ASC');
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
        seriesId: row.series_id,
        assetKey: row.asset_key,
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
        ? 'Every series event hashes to its predecessor; the ring-fence record is intact.'
        : 'The series log has been altered: the listed events no longer hash to their predecessor.',
    };
  }

  static async openSeries({
    seriesId, seriesCode, seriesName, purpose, beneficiaryRef, mandate,
    ringFenced = true, openedBy,
  } = {}) {
    const code = requireText(seriesCode, 'seriesCode is required').toUpperCase();
    const name = requireText(seriesName, 'seriesName is required');
    const kind = String(purpose || '').toLowerCase();
    if (!SERIES_PURPOSES.includes(kind)) {
      throw new Error(`purpose must be one of ${SERIES_PURPOSES.join(', ')}`);
    }
    // A series that supports a beneficiary is only ring-fenced in any meaningful
    // sense if the beneficiary it answers to is named.
    if (kind === 'beneficiary_support') {
      requireText(beneficiaryRef, 'A beneficiary_support series requires beneficiaryRef');
    }
    const actor = requireText(openedBy, 'openedBy is required to open a series');

    await this.ensureTables();
    const newId = String(seriesId || id('SER')).trim();
    const rows = await pool.query(
      `INSERT INTO trust_series
         (series_id, series_code, series_name, purpose, beneficiary_ref, mandate, ring_fenced, opened_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [newId, code, name, kind, beneficiaryRef || null, mandate || null, ringFenced !== false, actor]
    );
    await this._appendEvent({
      eventType: 'series_opened',
      seriesId: newId,
      actor,
      payload: { seriesCode: code, purpose: kind, ringFenced: ringFenced !== false },
    });
    return rows.rows[0];
  }

  static async getSeries(seriesRef) {
    await this.ensureTables();
    const rows = await pool.query(
      `SELECT * FROM trust_series WHERE series_id = $1 OR series_code = UPPER($1)`,
      [String(seriesRef || '')]
    );
    return rows.rows[0] || null;
  }

  static async listSeries() {
    await this.ensureTables();
    const rows = await pool.query(
      "SELECT * FROM trust_series WHERE status <> 'closed' ORDER BY created_at ASC"
    );
    return rows.rows;
  }

  // ── Reserve asset identification ───────────────────────────────────────────

  static async _identifyReserveAssets() {
    if (!ReserveEngine) return [];
    const attestations = await ReserveEngine.latestAttestations().catch(() => []);
    return attestations.map((a) => {
      // Fixed income attestations are the custodian's evidence for a bond
      // position, and the bond carries the collateral value. Counting both would
      // report the same holding twice.
      const isFixedIncome = a.asset_class === 'fixed_income';
      const valueKind = isFixedIncome ? 'evidence' : (a.counted ? 'spendable' : 'internal_only');
      let identification = `${a.verification} ${a.source_type} attestation`;
      if (a.verification === 'unverified') identification = a.unverified_reason || 'unverified source';
      else if (a.stale) identification = `${a.source_type} attestation expired`;
      return {
        assetKind: 'reserve_attestation',
        assetRef: `${a.source_type}:${a.source_key}`,
        assetClass: a.asset_class,
        label: `${a.source_key} (${a.source_type})`,
        valueKind,
        identification,
        evidenceReference: a.evidence_reference || null,
        valueCents: cents(a.balance_cents),
        spendableCents: valueKind === 'spendable' ? cents(a.balance_cents) : 0,
        collateralCents: 0,
      };
    });
  }

  static async _identifyBondAssets() {
    if (!ReserveEngine) return [];
    const portfolio = await ReserveEngine.portfolio().catch(() => null);
    if (!portfolio) return [];
    return portfolio.positions.map((p) => ({
      assetKind: 'bond',
      assetRef: String(p.isin || p.bondIdentifier || p.bondName),
      assetClass: 'fixed_income',
      label: p.bondName,
      // Eligible collateral is the only part of a bond that backs anything, and
      // a self-issued bond has none of it however large its carrying value.
      valueKind: p.eligibleCollateralCents > 0 ? 'collateral' : 'internal_only',
      identification: p.custodyStatus,
      evidenceReference: null,
      valueCents: p.carryingValueCents,
      spendableCents: 0,
      collateralCents: p.eligibleCollateralCents,
    }));
  }

  static async _identifyCustodyAssets() {
    if (!CustodyOsEngine) return [];
    const positions = await CustodyOsEngine.listPositions().catch(() => []);
    return positions
      .filter((p) => p.control_status !== 'released')
      .map((p) => ({
        assetKind: 'custody_position',
        assetRef: p.position_id,
        assetClass: p.asset_class,
        label: p.instrument_name || p.instrument_ref,
        // A custody position's backing already reaches the reserve as an
        // attestation, so here it is the record of control, not a second asset.
        valueKind: 'evidence',
        identification: p.custody_type === 'third_party'
          ? `${p.control_status} at ${p.custodian_name}`
          : `${p.control_status} in self custody`,
        evidenceReference: p.last_receipt_id || null,
        valueCents: cents(p.valuation_cents),
        spendableCents: 0,
        collateralCents: 0,
      }));
  }

  static async _identifyCashAccounts() {
    const rows = await pool.query(
      `SELECT account_id, account_name, balance_cents
         FROM cash_accounts
        WHERE status = 'active'
        ORDER BY account_id ASC`
    ).catch(() => ({ rows: [] }));
    return rows.rows.map((row) => ({
      assetKind: 'cash_account',
      assetRef: row.account_id,
      assetClass: 'cash',
      label: row.account_name || row.account_id,
      // A ledger balance is a claim on the trust, not backing for one. It is
      // inventoried so it can be fenced into a series, never as spendable.
      valueKind: 'internal_only',
      identification: 'ledger balance; backing comes from the attestation behind it',
      evidenceReference: null,
      valueCents: cents(row.balance_cents),
      spendableCents: 0,
      collateralCents: 0,
    }));
  }

  /**
   * Inventory every asset the trust can point at, with what it contributes and
   * which series it is fenced into. This is the identification half of the
   * engine: assignment can only reference an asset that appears here.
   */
  static async identify() {
    await this.ensureTables();
    const groups = await Promise.all([
      this._identifyReserveAssets(),
      this._identifyBondAssets(),
      this._identifyCustodyAssets(),
      this._identifyCashAccounts(),
    ]);
    const assets = groups.flat();

    const assignments = await pool.query(
      `SELECT a.*, s.series_code, s.series_name
         FROM series_asset_assignments a
         JOIN trust_series s ON s.series_id = a.series_id
        WHERE a.status = 'active'`
    );
    const fenced = new Map(
      assignments.rows.map((row) => [assetKey(row.asset_kind, row.asset_ref), row])
    );

    const identified = assets.map((asset) => {
      const assignment = fenced.get(assetKey(asset.assetKind, asset.assetRef)) || null;
      return {
        ...asset,
        value: dollars(asset.valueCents),
        spendable: dollars(asset.spendableCents),
        collateral: dollars(asset.collateralCents),
        seriesId: assignment ? assignment.series_id : null,
        seriesCode: assignment ? assignment.series_code : null,
        assignmentId: assignment ? assignment.assignment_id : null,
      };
    });

    const unassigned = identified.filter((a) => !a.seriesId);
    return {
      masterTrust: this.config().masterTrustName,
      assets: identified,
      counts: {
        total: identified.length,
        assigned: identified.length - unassigned.length,
        unassigned: unassigned.length,
      },
      spendable: dollars(identified.reduce((s, a) => s + a.spendableCents, 0)),
      collateral: dollars(identified.reduce((s, a) => s + a.collateralCents, 0)),
      unassignedSpendable: dollars(unassigned.reduce((s, a) => s + a.spendableCents, 0)),
      unassignedCollateral: dollars(unassigned.reduce((s, a) => s + a.collateralCents, 0)),
      note: unassigned.length
        ? 'Unassigned assets sit at the master trust level and are commingled: they back every'
          + ' series equally until they are fenced into one.'
        : 'Every identified asset is fenced into a series.',
    };
  }

  static async findIdentifiedAsset(assetKind, assetRef) {
    const kind = String(assetKind || '').toLowerCase();
    if (!ASSET_KINDS.includes(kind)) {
      throw new Error(`assetKind must be one of ${ASSET_KINDS.join(', ')}`);
    }
    const ref = requireText(assetRef, 'assetRef is required');
    const inventory = await this.identify();
    const key = assetKey(kind, ref);
    return inventory.assets.find((a) => assetKey(a.assetKind, a.assetRef) === key) || null;
  }

  // ── Ring fencing ───────────────────────────────────────────────────────────

  /**
   * Fence an identified asset into one series. An asset already fenced into a
   * different series is refused rather than moved: reassignment has to be an
   * explicit release followed by a new assignment, so the event log shows the
   * asset leaving one pool before it enters another.
   */
  static async assignAsset({ seriesRef, assetKind, assetRef, evidenceReference, assignedBy } = {}) {
    const actor = requireText(assignedBy, 'assignedBy is required to fence an asset into a series');
    const series = await this.getSeries(requireText(seriesRef, 'seriesRef is required'));
    if (!series) throw new Error(`Series ${seriesRef} not found`);
    if (series.status !== 'active') throw new Error(`Series ${series.series_code} is ${series.status}`);

    const asset = await this.findIdentifiedAsset(assetKind, assetRef);
    if (!asset) {
      throw new Error(
        `${assetKind} ${assetRef} is not an identified trust asset; run identification first`
      );
    }

    const existing = await pool.query(
      `SELECT a.*, s.series_code
         FROM series_asset_assignments a
         JOIN trust_series s ON s.series_id = a.series_id
        WHERE a.asset_kind = $1 AND LOWER(a.asset_ref) = LOWER($2) AND a.status = 'active'`,
      [asset.assetKind, asset.assetRef]
    );
    if (existing.rows.length) {
      const held = existing.rows[0];
      if (held.series_id === series.series_id) return held;
      throw new SeriesRingFenceError(
        `${asset.assetKind} ${asset.assetRef} is already fenced into series ${held.series_code};`
        + ' release it there before assigning it elsewhere, or the same asset would back two series.',
        { assetKind: asset.assetKind, assetRef: asset.assetRef, heldBy: held.series_code }
      );
    }

    const assignmentId = id('SAS');
    const rows = await pool.query(
      `INSERT INTO series_asset_assignments
         (assignment_id, series_id, asset_kind, asset_ref, asset_class, value_kind,
          identification, identified_value_cents, evidence_reference, assigned_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        assignmentId, series.series_id, asset.assetKind, asset.assetRef, asset.assetClass,
        asset.valueKind, asset.identification, asset.valueCents,
        evidenceReference || asset.evidenceReference || null, actor,
      ]
    );
    await this._appendEvent({
      eventType: 'asset_ring_fenced',
      seriesId: series.series_id,
      assetKey: assetKey(asset.assetKind, asset.assetRef),
      actor,
      payload: {
        valueKind: asset.valueKind,
        identification: asset.identification,
        identifiedValueCents: asset.valueCents,
      },
    });
    return rows.rows[0];
  }

  static async releaseAsset(assignmentId, { releasedBy, reason = null } = {}) {
    const aid = requireText(assignmentId, 'assignmentId is required');
    const actor = requireText(releasedBy, 'releasedBy is required to release a fenced asset');
    await this.ensureTables();
    const rows = await pool.query(
      `UPDATE series_asset_assignments
          SET status = 'released', released_at = NOW(), released_by = $2, release_reason = $3
        WHERE assignment_id = $1 AND status = 'active'
        RETURNING *`,
      [aid, actor, reason]
    );
    if (!rows.rows.length) throw new Error(`No active series assignment ${aid} to release`);
    const assignment = rows.rows[0];
    await this._appendEvent({
      eventType: 'asset_released',
      seriesId: assignment.series_id,
      assetKey: assetKey(assignment.asset_kind, assignment.asset_ref),
      actor,
      payload: { reason },
    });
    return assignment;
  }

  static async listAssignments({ seriesRef = null } = {}) {
    await this.ensureTables();
    if (!seriesRef) {
      const rows = await pool.query(
        `SELECT a.*, s.series_code FROM series_asset_assignments a
           JOIN trust_series s ON s.series_id = a.series_id
          WHERE a.status = 'active' ORDER BY a.created_at ASC`
      );
      return rows.rows;
    }
    const series = await this.getSeries(seriesRef);
    if (!series) throw new Error(`Series ${seriesRef} not found`);
    const rows = await pool.query(
      `SELECT a.*, s.series_code FROM series_asset_assignments a
         JOIN trust_series s ON s.series_id = a.series_id
        WHERE a.series_id = $1 AND a.status = 'active' ORDER BY a.created_at ASC`,
      [series.series_id]
    );
    return rows.rows;
  }

  // ── Obligations ────────────────────────────────────────────────────────────

  static async recordObligation({
    seriesRef, obligationType, counterparty, amountCents, memo, createdBy,
  } = {}) {
    const actor = requireText(createdBy, 'createdBy is required to record an obligation');
    const type = requireText(obligationType, 'obligationType is required');
    const amount = cents(amountCents);
    if (amount <= 0) throw new Error('An obligation requires a positive amountCents');
    const series = await this.getSeries(requireText(seriesRef, 'seriesRef is required'));
    if (!series) throw new Error(`Series ${seriesRef} not found`);

    const obligationId = id('SOB');
    const rows = await pool.query(
      `INSERT INTO series_obligations
         (obligation_id, series_id, obligation_type, counterparty, amount_cents, memo, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [obligationId, series.series_id, type, counterparty || null, amount, memo || null, actor]
    );
    await this._appendEvent({
      eventType: 'obligation_recorded',
      seriesId: series.series_id,
      actor,
      payload: { obligationType: type, amountCents: amount, counterparty: counterparty || null },
    });
    return rows.rows[0];
  }

  static async settleObligation(obligationId, { status = 'settled', settledBy } = {}) {
    const oid = requireText(obligationId, 'obligationId is required');
    const actor = requireText(settledBy, 'settledBy is required');
    const next = String(status || 'settled').toLowerCase();
    if (!OBLIGATION_STATUSES.includes(next) || next === 'open') {
      throw new Error("status must be 'settled' or 'cancelled'");
    }
    await this.ensureTables();
    const rows = await pool.query(
      `UPDATE series_obligations SET status = $2, settled_at = NOW()
        WHERE obligation_id = $1 AND status = 'open'
        RETURNING *`,
      [oid, next]
    );
    if (!rows.rows.length) throw new Error(`No open obligation ${oid}`);
    await this._appendEvent({
      eventType: `obligation_${next}`,
      seriesId: rows.rows[0].series_id,
      actor,
      payload: { obligationId: oid },
    });
    return rows.rows[0];
  }

  static async listObligations({ seriesRef = null, status = null } = {}) {
    await this.ensureTables();
    const series = seriesRef ? await this.getSeries(seriesRef) : null;
    if (seriesRef && !series) throw new Error(`Series ${seriesRef} not found`);
    const rows = await pool.query(
      `SELECT * FROM series_obligations
        WHERE ($1::text IS NULL OR series_id = $1)
          AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC`,
      [series ? series.series_id : null, status]
    );
    return rows.rows;
  }

  // ── Series balance sheet ───────────────────────────────────────────────────

  /**
   * What one series actually has. Values are re-read from identification rather
   * than from the assignment row, so a position revalued or an attestation gone
   * stale is reflected immediately instead of being frozen at assignment time.
   */
  static async balanceSheet(seriesRef) {
    const series = await this.getSeries(requireText(seriesRef, 'seriesRef is required'));
    if (!series) throw new Error(`Series ${seriesRef} not found`);
    const inventory = await this.identify();
    const own = inventory.assets.filter((a) => a.seriesId === series.series_id);
    const obligations = await this.listObligations({ seriesRef: series.series_id, status: 'open' });

    const spendableCents = own.reduce((s, a) => s + a.spendableCents, 0);
    const collateralCents = own.reduce((s, a) => s + a.collateralCents, 0);
    const internalOnlyCents = own
      .filter((a) => a.valueKind === 'internal_only')
      .reduce((s, a) => s + a.valueCents, 0);
    const obligationCents = obligations.reduce((s, o) => s + cents(o.amount_cents), 0);
    const availableCents = Math.max(0, spendableCents - obligationCents);

    return {
      seriesId: series.series_id,
      seriesCode: series.series_code,
      seriesName: series.series_name,
      purpose: series.purpose,
      beneficiaryRef: series.beneficiary_ref,
      ringFenced: series.ring_fenced,
      status: series.status,
      assets: own,
      spendableCents,
      spendable: dollars(spendableCents),
      collateralCents,
      collateral: dollars(collateralCents),
      internalOnlyCents,
      internalOnly: dollars(internalOnlyCents),
      openObligationCents: obligationCents,
      openObligations: dollars(obligationCents),
      availableCents,
      available: dollars(availableCents),
      note: availableCents > 0
        ? 'This series can fund payments up to its own available spendable assets.'
        : 'This series holds no spendable external assets, so it cannot fund an outbound payment'
          + ' regardless of what the master trust holds elsewhere.',
    };
  }

  /** The master trust view: every series, plus what is still commingled. */
  static async statement() {
    const cfg = this.config();
    const series = await this.listSeries();
    const inventory = await this.identify();
    const sheets = [];
    for (const row of series) {
      sheets.push(await this.balanceSheet(row.series_id));
    }
    const unassigned = inventory.assets.filter((a) => !a.seriesId);
    return {
      masterTrust: cfg.masterTrustName,
      enforcement: cfg.enforcement,
      series: sheets,
      seriesCount: sheets.length,
      fencedSpendable: dollars(sheets.reduce((s, x) => s + x.spendableCents, 0)),
      fencedCollateral: dollars(sheets.reduce((s, x) => s + x.collateralCents, 0)),
      commingled: unassigned.map((a) => ({
        assetKind: a.assetKind,
        assetRef: a.assetRef,
        label: a.label,
        valueKind: a.valueKind,
        identification: a.identification,
        value: a.value,
        spendable: a.spendable,
        collateral: a.collateral,
      })),
      commingledSpendable: inventory.unassignedSpendable,
      commingledCollateral: inventory.unassignedCollateral,
      note: 'A series may only fund payments from the assets fenced into it. Commingled assets'
        + ' back the master trust generally and are available to no series until assigned.',
    };
  }

  // ── Enforcement ────────────────────────────────────────────────────────────

  /**
   * Ring-fence check, run alongside the reserve check before origination. The
   * reserve engine answers "does the trust hold this money"; this answers "does
   * *this series* hold it", which is the question that keeps one beneficiary's
   * assets from paying another's obligation.
   */
  static async assertSeriesSpendable({ seriesRef, amountCents, rail = 'external' } = {}) {
    const cfg = this.config();
    const amount = cents(amountCents);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error('assertSeriesSpendable requires a positive integer amountCents');
    }
    if (cfg.enforcement === 'off') {
      return { allowed: true, enforcement: 'off', reason: 'Series ring-fence enforcement disabled' };
    }
    const series = await this.getSeries(requireText(seriesRef, 'seriesRef is required'));
    if (!series) throw new Error(`Series ${seriesRef} not found`);
    if (series.status !== 'active') {
      throw new SeriesRingFenceError(
        `Series ${series.series_code} is ${series.status} and cannot fund a payment.`,
        { seriesCode: series.series_code, status: series.status }
      );
    }
    if (!series.ring_fenced) {
      return {
        allowed: true,
        enforcement: cfg.enforcement,
        seriesCode: series.series_code,
        warning: `Series ${series.series_code} is not ring-fenced; it draws on master trust assets.`,
      };
    }

    const sheet = await this.balanceSheet(series.series_id);
    const decision = {
      allowed: amount <= sheet.availableCents,
      enforcement: cfg.enforcement,
      rail,
      seriesId: series.series_id,
      seriesCode: series.series_code,
      amount: dollars(amount),
      seriesSpendable: sheet.spendable,
      seriesAvailable: sheet.available,
      seriesCollateral: sheet.collateral,
      openObligations: sheet.openObligations,
      shortfall: dollars(Math.max(0, amount - sheet.availableCents)),
    };
    if (decision.allowed) return decision;

    const message = `Ring-fence breach: ${rail} origination of $${decision.amount} exceeds the`
      + ` $${sheet.available} available to series ${series.series_code}.`
      + ' Assets fenced into another series cannot fund this payment'
      + (sheet.collateralCents > 0
        ? `; $${sheet.collateral} of this series' fixed income has to be pledged or sold first.`
        : '.');
    if (cfg.enforcement === 'strict') throw new SeriesRingFenceError(message, decision);
    return { ...decision, allowed: true, warning: message };
  }

  static async status() {
    const cfg = this.config();
    const statement = await this.statement().catch((e) => ({ error: e.message }));
    const chain = await this.verifyChain().catch((e) => ({ error: e.message }));
    return {
      masterTrust: cfg.masterTrustName,
      enforcement: cfg.enforcement,
      reserveEngineAvailable: Boolean(ReserveEngine),
      custodyEngineAvailable: Boolean(CustodyOsEngine),
      purposes: SERIES_PURPOSES,
      assetKinds: ASSET_KINDS,
      chain,
      statement,
    };
  }
}

module.exports = {
  SeriesOsEngine,
  SeriesRingFenceError,
  SERIES_PURPOSES,
  ASSET_KINDS,
  VALUE_KINDS,
};
