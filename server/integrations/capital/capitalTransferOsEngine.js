'use strict';

/**
 * Capital Transfer OS Engine
 *
 * The reserve engine says what the trust holds, and the Series OS says which
 * pool holds it — but neither one moves anything. Turning a reserve asset into
 * spendable funds inside a series is a *transfer*: a bond is sold or pledged, a
 * digital asset is redeemed, a custodian sweeps cash to the operating bank, or
 * an outside contributor funds the trust. Each of those is a multi-step
 * instruction with an external counterparty, and until now the system had no
 * record of one — so proceeds either never appeared or appeared as an internal
 * posting with nothing behind it.
 *
 * This engine automates that pipeline end to end:
 *
 *   plan()      identify which reserve assets can become spendable, by what
 *               route, at what expected proceeds, and — for the ones that
 *               cannot — exactly why not.
 *   propose()   raise a transfer from one identified asset to one target series.
 *   authorize() two distinct trustees countersign (maker/checker, same rule the
 *               custody receipts use).
 *   instruct()  record the instruction actually sent to the custodian, exchange
 *               or bank, with its reference.
 *   confirm()   record the external settlement: on confirmation the proceeds are
 *               attested as spendable cash *and fenced into the target series*,
 *               so capital lands inside the ring fence rather than in the
 *               commingled pool.
 *   automate()  scan every series for a funding gap, and raise the proposals
 *               that would close it.
 *
 * The one thing the engine will not do is manufacture the proceeds. `confirm()`
 * requires a settlement reference, documentary evidence and an attesting
 * officer, because that is the only difference between capital arriving and a
 * journal entry claiming it did. A route whose source is a self-issued,
 * self-held instrument is reported as ineligible with its reason rather than
 * being given a path: there is nobody on the other side of that sale.
 *
 * Automation therefore stops at `proposed`. Signatures and external settlement
 * are deliberately human steps; scheduling them away would only produce
 * confirmed transfers with no money in them.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');

let ReserveEngine;
try { ({ ReserveEngine } = require('../finops/reserveEngine')); } catch (e) { ReserveEngine = null; }

let SeriesOsEngine;
try { ({ SeriesOsEngine } = require('../series/seriesOsEngine')); } catch (e) { SeriesOsEngine = null; }

/**
 * The conversion routes, keyed by what they consume.
 *
 * `advanceRateBps` is how much of the source value the route can realistically
 * raise: a sale realises the collateral value the custodian already haircut, a
 * pledge advances less than that again. `destinationSourceType` is the reserve
 * source the proceeds land in, which is what makes them spendable.
 */
const ROUTES = {
  collateral_sale: {
    route: 'collateral_sale',
    name: 'Sell custodian-held fixed income',
    consumes: ['collateral'],
    assetKinds: ['bond', 'reserve_attestation'],
    advanceRateBps: 10000,
    destinationSourceType: 'partner_bank',
    requiresCounterparty: true,
    note: 'The custodian sells the position and remits cash proceeds to the trust bank account.',
  },
  collateral_pledge: {
    route: 'collateral_pledge',
    name: 'Borrow against custodian-held collateral',
    consumes: ['collateral'],
    assetKinds: ['bond', 'reserve_attestation'],
    // A lender advances a fraction of collateral value and the position stays
    // in the series; the cash is a liability, so the series owes it back.
    advanceRateBps: 5000,
    destinationSourceType: 'partner_bank',
    requiresCounterparty: true,
    createsObligation: true,
    note: 'A lender advances cash against the pledged position; the advance is a series obligation.',
  },
  digital_asset_redemption: {
    route: 'digital_asset_redemption',
    name: 'Redeem digital assets for USD',
    consumes: ['spendable'],
    assetKinds: ['reserve_attestation'],
    sourceTypes: ['onchain_wallet', 'circle_custody'],
    advanceRateBps: 10000,
    destinationSourceType: 'partner_bank',
    requiresCounterparty: true,
    note: 'USDC held by the trust is redeemed at Circle or an exchange and paid out as USD.',
  },
  custodian_cash_sweep: {
    route: 'custodian_cash_sweep',
    name: 'Sweep attested custodian cash to the operating bank',
    consumes: ['spendable'],
    assetKinds: ['reserve_attestation'],
    sourceTypes: ['custodian_statement', 'depository_account', 'partner_bank'],
    advanceRateBps: 10000,
    destinationSourceType: 'partner_bank',
    requiresCounterparty: true,
    note: 'Cash already attested at one institution is moved to the account the rails draw on.',
  },
  external_contribution: {
    route: 'external_contribution',
    name: 'Receive an external contribution',
    // The only route that does not consume an existing asset: it is new value
    // arriving from outside, which is the one thing no conversion can create.
    consumes: [],
    assetKinds: [],
    advanceRateBps: 10000,
    destinationSourceType: 'partner_bank',
    requiresCounterparty: true,
    note: 'A contributor transfers real funds into the trust; the only route that adds backing.',
  },
};

const ROUTE_IDS = Object.keys(ROUTES);

/** proposed → authorized → instructed → confirmed, or cancelled/failed. */
const TERMINAL_STATUSES = ['confirmed', 'cancelled', 'failed'];

const AUTOMATION_MODES = ['propose', 'plan_only', 'off'];

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

function hashEvent({ prevHash, eventType, transferId, seriesId, actor, payload, createdAt }) {
  return crypto.createHash('sha256').update(JSON.stringify([
    prevHash || '',
    eventType,
    transferId || '',
    seriesId || '',
    actor || '',
    payload || {},
    createdAt,
  ])).digest('hex');
}

class CapitalTransferError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'CapitalTransferError';
    this.status = 409;
    this.code = 'CAPITAL_TRANSFER_REFUSED';
    this.detail = detail;
  }
}

class CapitalTransferOsEngine {
  static config() {
    return {
      requiredSignatures: (() => {
        const n = Number(process.env.CAPITAL_TRANSFER_SIGNATURES);
        return Number.isFinite(n) && n >= 1 && n <= 5 ? Math.round(n) : 2;
      })(),
      automation: (() => {
        const mode = String(process.env.CAPITAL_TRANSFER_AUTOMATION || 'propose').toLowerCase();
        return AUTOMATION_MODES.includes(mode) ? mode : 'propose';
      })(),
      pledgeAdvanceRateBps: (() => {
        const n = Number(process.env.CAPITAL_PLEDGE_ADVANCE_BPS);
        return Number.isFinite(n) && n >= 0 && n <= 10000
          ? Math.round(n)
          : ROUTES.collateral_pledge.advanceRateBps;
      })(),
      defaultDestination: String(process.env.CAPITAL_TRANSFER_DESTINATION || '').trim(),
    };
  }

  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS capital_transfers (
        transfer_id            TEXT PRIMARY KEY,
        route                  TEXT NOT NULL,
        series_id              TEXT NOT NULL,
        source_asset_kind      TEXT,
        source_asset_ref       TEXT,
        source_label           TEXT,
        source_value_cents     BIGINT NOT NULL DEFAULT 0,
        amount_cents           BIGINT NOT NULL,
        expected_proceeds_cents BIGINT NOT NULL DEFAULT 0,
        counterparty           TEXT,
        destination_ref        TEXT,
        memo                   TEXT,
        status                 TEXT NOT NULL DEFAULT 'proposed'
                               CHECK (status IN ('proposed','authorized','instructed','confirmed','cancelled','failed')),
        required_signatures    INTEGER NOT NULL DEFAULT 2,
        signatures             JSONB NOT NULL DEFAULT '[]',
        proposed_by            TEXT NOT NULL,
        origin                 TEXT NOT NULL DEFAULT 'manual',
        instruction_reference  TEXT,
        instructed_by          TEXT,
        instructed_at          TIMESTAMPTZ,
        settlement_reference   TEXT,
        evidence_reference     TEXT,
        settled_cents          BIGINT,
        confirmed_by           TEXT,
        confirmed_at           TIMESTAMPTZ,
        reserve_attestation_id TEXT,
        assignment_id          TEXT,
        settlement_note        TEXT,
        failure_reason         TEXT,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // One live transfer per source asset: two concurrent sales of the same bond
    // would each claim proceeds the position can only pay once.
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_capital_transfer_source_live
        ON capital_transfers (source_asset_kind, LOWER(source_asset_ref))
        WHERE status IN ('proposed','authorized','instructed')
          AND source_asset_ref IS NOT NULL
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS capital_transfer_events (
        sequence    BIGSERIAL PRIMARY KEY,
        event_id    TEXT UNIQUE NOT NULL,
        event_type  TEXT NOT NULL,
        transfer_id TEXT,
        series_id   TEXT,
        actor       TEXT,
        payload     JSONB NOT NULL DEFAULT '{}',
        prev_hash   TEXT,
        event_hash  TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_capital_transfers_series
         ON capital_transfers (series_id, status)`
    );
    return true;
  }

  // ── Event chain ────────────────────────────────────────────────────────────

  static async _appendEvent({ eventType, transferId = null, seriesId = null, actor = null, payload = {} }) {
    const tip = await pool.query(
      'SELECT event_hash FROM capital_transfer_events ORDER BY sequence DESC LIMIT 1'
    );
    const prevHash = (tip.rows[0] && tip.rows[0].event_hash) || null;
    const createdAt = new Date().toISOString();
    const eventId = id('CTE');
    const eventHash = hashEvent({ prevHash, eventType, transferId, seriesId, actor, payload, createdAt });
    const rows = await pool.query(
      `INSERT INTO capital_transfer_events
         (event_id, event_type, transfer_id, series_id, actor, payload, prev_hash, event_hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [eventId, eventType, transferId, seriesId, actor, JSON.stringify(payload), prevHash, eventHash, createdAt]
    );
    return rows.rows[0];
  }

  static async events({ limit = 100 } = {}) {
    await this.ensureTables();
    const rows = await pool.query(
      'SELECT * FROM capital_transfer_events ORDER BY sequence DESC LIMIT $1',
      [Math.min(Math.max(Number(limit) || 100, 1), 1000)]
    );
    return rows.rows;
  }

  static async verifyChain() {
    await this.ensureTables();
    const rows = await pool.query('SELECT * FROM capital_transfer_events ORDER BY sequence ASC');
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
        transferId: row.transfer_id,
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
        ? 'Every capital transfer event hashes to its predecessor; the movement record is intact.'
        : 'The capital transfer log has been altered: the listed events no longer hash to their predecessor.',
    };
  }

  // ── Planning ───────────────────────────────────────────────────────────────

  static _advanceRateBps(route) {
    if (route === 'collateral_pledge') return this.config().pledgeAdvanceRateBps;
    return ROUTES[route].advanceRateBps;
  }

  /** Which routes could consume this identified asset, and for how much. */
  static _routesForAsset(asset) {
    const matches = [];
    for (const route of ROUTE_IDS) {
      const spec = ROUTES[route];
      if (!spec.consumes.length) continue;
      if (!spec.assetKinds.includes(asset.assetKind)) continue;
      if (!spec.consumes.includes(asset.valueKind)) continue;
      if (spec.sourceTypes) {
        // Attestation refs are `${sourceType}:${sourceKey}`.
        const sourceType = String(asset.assetRef || '').split(':')[0].toLowerCase();
        if (!spec.sourceTypes.includes(sourceType)) continue;
      }
      const basisCents = asset.valueKind === 'collateral' ? asset.collateralCents : asset.spendableCents;
      if (basisCents <= 0) continue;
      const rate = this._advanceRateBps(route);
      matches.push({
        route,
        name: spec.name,
        advanceRateBps: rate,
        basisCents,
        basis: dollars(basisCents),
        expectedProceedsCents: Math.round(basisCents * rate / 10000),
        expectedProceeds: dollars(Math.round(basisCents * rate / 10000)),
        createsObligation: Boolean(spec.createsObligation),
        note: spec.note,
      });
    }
    return matches;
  }

  static _ineligibleReason(asset) {
    if (asset.valueKind === 'internal_only') {
      return asset.assetKind === 'cash_account'
        ? 'A ledger balance is a claim on the trust, not an asset that can be sold or redeemed;'
          + ' it becomes spendable only when an external deposit backs it.'
        : `${asset.identification}: there is no counterparty to buy or lend against it, so no`
          + ' route converts it to spendable funds.';
    }
    if (asset.valueKind === 'evidence') {
      return 'Evidence for another asset rather than an asset in its own right; convert the'
        + ' position or attestation it supports.';
    }
    return 'No conversion route consumes this asset in its current state.';
  }

  /**
   * What capital could be raised, by route, and what stands in the way.
   *
   * Scoped to one series when `seriesRef` is given, because a conversion of an
   * asset fenced into another series would breach that fence — the ring fence
   * applies to raising capital exactly as it applies to spending it.
   */
  static async plan({ seriesRef = null, targetCents = null } = {}) {
    await this.ensureTables();
    if (!SeriesOsEngine) throw new Error('Series OS engine unavailable; capital transfers target a series');

    const series = seriesRef ? await SeriesOsEngine.getSeries(seriesRef) : null;
    if (seriesRef && !series) throw new Error(`Series ${seriesRef} not found`);

    const inventory = await SeriesOsEngine.identify();
    const scoped = series
      ? inventory.assets.filter((a) => a.seriesId === series.series_id)
      : inventory.assets;

    const eligible = [];
    const ineligible = [];
    for (const asset of scoped) {
      const routes = this._routesForAsset(asset);
      const entry = {
        assetKind: asset.assetKind,
        assetRef: asset.assetRef,
        label: asset.label,
        valueKind: asset.valueKind,
        identification: asset.identification,
        value: asset.value,
        seriesCode: asset.seriesCode,
      };
      if (routes.length) eligible.push({ ...entry, routes });
      else ineligible.push({ ...entry, reason: this._ineligibleReason(asset) });
    }

    // Each asset can only be converted once, so capacity takes its best route
    // rather than summing routes that compete for the same position.
    const capacityCents = eligible.reduce(
      (sum, a) => sum + Math.max(...a.routes.map((r) => r.expectedProceedsCents)),
      0
    );
    const sheet = series ? await SeriesOsEngine.balanceSheet(series.series_id) : null;
    const target = targetCents === null || targetCents === undefined
      ? (sheet ? sheet.openObligationCents : 0)
      : cents(targetCents);
    const availableCents = sheet ? sheet.availableCents : inventory.assets
      .reduce((s, a) => s + a.spendableCents, 0);
    const gapCents = Math.max(0, target - availableCents);

    return {
      seriesId: series ? series.series_id : null,
      seriesCode: series ? series.series_code : null,
      masterTrust: inventory.masterTrust,
      availableCents,
      available: dollars(availableCents),
      targetCents: target,
      target: dollars(target),
      gapCents,
      gap: dollars(gapCents),
      capacityCents,
      capacity: dollars(capacityCents),
      coversGap: capacityCents >= gapCents,
      eligible,
      ineligible,
      routes: ROUTE_IDS.map((r) => ({ route: r, ...ROUTES[r] })),
      note: capacityCents > 0
        ? 'Each eligible asset can be converted once, through one route, and the proceeds are'
          + ' fenced into the series that owned the asset.'
        : 'No asset in scope has a conversion route: raising spendable funds requires either'
          + ' third-party collateral to sell or pledge, redeemable digital assets, or an'
          + ' external contribution.',
    };
  }

  // ── Transfer lifecycle ─────────────────────────────────────────────────────

  static async get(transferId) {
    await this.ensureTables();
    const rows = await pool.query(
      'SELECT * FROM capital_transfers WHERE transfer_id = $1',
      [String(transferId || '')]
    );
    return rows.rows[0] || null;
  }

  static async list({ seriesRef = null, status = null, limit = 100 } = {}) {
    await this.ensureTables();
    let seriesId = null;
    if (seriesRef) {
      if (!SeriesOsEngine) throw new Error('Series OS engine unavailable');
      const series = await SeriesOsEngine.getSeries(seriesRef);
      if (!series) throw new Error(`Series ${seriesRef} not found`);
      seriesId = series.series_id;
    }
    const rows = await pool.query(
      `SELECT * FROM capital_transfers
        WHERE ($1::text IS NULL OR series_id = $1)
          AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC
        LIMIT $3`,
      [seriesId, status, Math.min(Math.max(Number(limit) || 100, 1), 500)]
    );
    return rows.rows;
  }

  /**
   * Raise a transfer from one identified asset into one series.
   *
   * The source asset has to be fenced into the target series (or unassigned, in
   * which case the proceeds bring it in): converting an asset fenced elsewhere
   * would move another series' capital, which is the breach the ring fence
   * exists to prevent.
   */
  static async propose({
    route, seriesRef, assetKind = null, assetRef = null, amountCents = null,
    counterparty, destinationRef, memo, proposedBy, origin = 'manual',
  } = {}) {
    const key = String(route || '').toLowerCase();
    if (!ROUTE_IDS.includes(key)) throw new Error(`route must be one of ${ROUTE_IDS.join(', ')}`);
    const spec = ROUTES[key];
    const actor = requireText(proposedBy, 'proposedBy is required to raise a capital transfer');
    if (spec.requiresCounterparty) {
      requireText(
        counterparty,
        `A ${spec.name.toLowerCase()} needs the counterparty (custodian, lender, exchange or contributor)`
      );
    }
    if (!SeriesOsEngine) throw new Error('Series OS engine unavailable; capital transfers target a series');
    const series = await SeriesOsEngine.getSeries(requireText(seriesRef, 'seriesRef is required'));
    if (!series) throw new Error(`Series ${seriesRef} not found`);
    if (series.status !== 'active') {
      throw new CapitalTransferError(
        `Series ${series.series_code} is ${series.status} and cannot receive capital transfers.`,
        { seriesCode: series.series_code, status: series.status }
      );
    }

    await this.ensureTables();
    const cfg = this.config();
    let asset = null;
    let expectedCents;

    if (spec.consumes.length) {
      asset = await SeriesOsEngine.findIdentifiedAsset(
        requireText(assetKind, 'assetKind is required for this route'),
        requireText(assetRef, 'assetRef is required for this route')
      );
      if (!asset) throw new Error(`${assetKind} ${assetRef} is not an identified trust asset`);
      if (asset.seriesId && asset.seriesId !== series.series_id) {
        throw new CapitalTransferError(
          `${asset.label} is fenced into series ${asset.seriesCode}; converting it here would`
          + ` move that series' capital. Release it there first.`,
          { assetRef: asset.assetRef, heldBy: asset.seriesCode }
        );
      }
      // The asset can only pay proceeds once, so a live transfer already
      // claiming it blocks a second one.
      const live = await pool.query(
        `SELECT transfer_id, route, status FROM capital_transfers
          WHERE source_asset_kind = $1 AND LOWER(source_asset_ref) = LOWER($2)
            AND status IN ('proposed','authorized','instructed')`,
        [asset.assetKind, asset.assetRef]
      );
      if (live.rows.length) {
        throw new CapitalTransferError(
          `${asset.label} is already being converted by ${live.rows[0].transfer_id}`
          + ` (${live.rows[0].status}); cancel that transfer before raising another.`,
          { transferId: live.rows[0].transfer_id, status: live.rows[0].status }
        );
      }

      const match = this._routesForAsset(asset).find((r) => r.route === key);
      if (!match) {
        throw new CapitalTransferError(
          `${asset.label} cannot be converted by ${key}: ${this._ineligibleReason(asset)}`,
          { assetRef: asset.assetRef, valueKind: asset.valueKind, identification: asset.identification }
        );
      }
      expectedCents = match.expectedProceedsCents;
    } else {
      // A contribution has no source asset, so the amount is the whole input.
      expectedCents = cents(amountCents);
      if (expectedCents <= 0) throw new Error('An external contribution requires a positive amountCents');
    }

    const requestedCents = amountCents === null || amountCents === undefined
      ? expectedCents
      : cents(amountCents);
    if (requestedCents <= 0) throw new Error('amountCents must be positive');
    if (spec.consumes.length && requestedCents > expectedCents) {
      throw new CapitalTransferError(
        `A ${key} of ${asset.label} raises at most $${dollars(expectedCents)}; $${dollars(requestedCents)}`
        + ' was requested.',
        { expectedProceeds: dollars(expectedCents), requested: dollars(requestedCents) }
      );
    }

    const transferId = id('CAP');
    const rows = await pool.query(
      `INSERT INTO capital_transfers
         (transfer_id, route, series_id, source_asset_kind, source_asset_ref, source_label,
          source_value_cents, amount_cents, expected_proceeds_cents, counterparty,
          destination_ref, memo, required_signatures, proposed_by, origin, signatures)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'[]'::jsonb)
       RETURNING *`,
      [
        transferId, key, series.series_id,
        asset ? asset.assetKind : null,
        asset ? asset.assetRef : null,
        asset ? asset.label : spec.name,
        asset ? asset.valueCents : 0,
        requestedCents, expectedCents,
        counterparty || null,
        destinationRef || cfg.defaultDestination || null,
        memo || null,
        cfg.requiredSignatures, actor, String(origin || 'manual').toLowerCase(),
      ]
    );
    await this._appendEvent({
      eventType: 'transfer_proposed',
      transferId,
      seriesId: series.series_id,
      actor,
      payload: {
        route: key,
        amountCents: requestedCents,
        expectedProceedsCents: expectedCents,
        sourceAssetRef: asset ? asset.assetRef : null,
        origin: String(origin || 'manual').toLowerCase(),
      },
    });
    return rows.rows[0];
  }

  static _signatures(transfer) {
    let signatures = transfer.signatures || [];
    if (typeof signatures === 'string') {
      try { signatures = JSON.parse(signatures); } catch { signatures = []; }
    }
    return Array.isArray(signatures) ? signatures : [];
  }

  /** Countersign a proposed transfer; the last required signature authorizes it. */
  static async authorize(transferId, signedBy, { role = null } = {}) {
    const tid = requireText(transferId, 'transferId is required');
    const signer = requireText(signedBy, 'signedBy is required to authorize a capital transfer');
    const transfer = await this.get(tid);
    if (!transfer) throw new Error(`Capital transfer ${tid} not found`);
    if (transfer.status !== 'proposed') {
      throw new CapitalTransferError(`Capital transfer ${tid} is already ${transfer.status}`, {
        status: transfer.status,
      });
    }

    const signatures = this._signatures(transfer);
    if (signatures.some((s) => String(s.signedBy).toLowerCase() === signer.toLowerCase())) {
      throw new CapitalTransferError(`${signer} has already signed ${tid}`, { signer });
    }
    signatures.push({ signedBy: signer, role: role || null, at: new Date().toISOString() });

    const required = Number(transfer.required_signatures) || 2;
    const authorized = signatures.length >= required;
    const rows = await pool.query(
      `UPDATE capital_transfers
          SET signatures = $2::jsonb, status = $3, updated_at = NOW()
        WHERE transfer_id = $1
        RETURNING *`,
      [tid, JSON.stringify(signatures), authorized ? 'authorized' : 'proposed']
    );
    await this._appendEvent({
      eventType: authorized ? 'transfer_authorized' : 'transfer_signed',
      transferId: tid,
      seriesId: transfer.series_id,
      actor: signer,
      payload: { signatures: signatures.length, requiredSignatures: required },
    });
    return {
      ...rows.rows[0],
      signatures,
      remainingSignatures: Math.max(0, required - signatures.length),
    };
  }

  /**
   * Record the instruction actually sent to the counterparty. The engine does
   * not transmit it: the reference proves an instruction exists outside these
   * books, and without one there is nothing to reconcile a settlement against.
   */
  static async instruct(transferId, { instructionReference, instructedBy } = {}) {
    const tid = requireText(transferId, 'transferId is required');
    const actor = requireText(instructedBy, 'instructedBy is required');
    const reference = requireText(
      instructionReference,
      'An instruction reference is required (custodian order id, redemption id or wire request)'
    );
    const transfer = await this.get(tid);
    if (!transfer) throw new Error(`Capital transfer ${tid} not found`);
    if (transfer.status !== 'authorized') {
      throw new CapitalTransferError(
        `Capital transfer ${tid} is ${transfer.status}; it must be authorized by`
        + ` ${transfer.required_signatures} trustees before it is instructed.`,
        { status: transfer.status }
      );
    }
    const rows = await pool.query(
      `UPDATE capital_transfers
          SET status = 'instructed', instruction_reference = $2, instructed_by = $3,
              instructed_at = NOW(), updated_at = NOW()
        WHERE transfer_id = $1
        RETURNING *`,
      [tid, reference, actor]
    );
    await this._appendEvent({
      eventType: 'transfer_instructed',
      transferId: tid,
      seriesId: transfer.series_id,
      actor,
      payload: { instructionReference: reference, counterparty: transfer.counterparty },
    });
    return rows.rows[0];
  }

  /**
   * Confirm external settlement and turn the proceeds into series capital.
   *
   * This is the only step that raises spendable funds, and it is gated on the
   * three things that distinguish arrived money from a claim: the settlement
   * reference the counterparty issued, the document evidencing it, and the
   * officer attesting to both. The proceeds are recorded as a reserve
   * attestation and then fenced into the transfer's series, so capital raised
   * for one beneficiary stays inside that beneficiary's fence.
   */
  static async confirm(transferId, {
    settlementReference, evidenceReference, settledCents = null, confirmedBy,
    destinationRef = null,
  } = {}) {
    const tid = requireText(transferId, 'transferId is required');
    const actor = requireText(confirmedBy, 'confirmedBy is required to confirm settlement');
    const settlement = requireText(
      settlementReference,
      'A settlement reference from the counterparty is required to confirm arrival of funds'
    );
    const evidence = requireText(
      evidenceReference,
      'Documentary evidence is required (custodian advice, redemption receipt or bank statement)'
    );
    const transfer = await this.get(tid);
    if (!transfer) throw new Error(`Capital transfer ${tid} not found`);
    if (transfer.status !== 'instructed') {
      throw new CapitalTransferError(
        `Capital transfer ${tid} is ${transfer.status}; only an instructed transfer can settle.`,
        { status: transfer.status }
      );
    }

    const proceedsCents = settledCents === null || settledCents === undefined
      ? cents(transfer.amount_cents)
      : cents(settledCents);
    if (proceedsCents <= 0) throw new Error('settledCents must be positive');

    const destination = String(destinationRef || transfer.destination_ref || '').trim();
    if (!destination) {
      throw new Error('A destination reference is required: the account the proceeds landed in');
    }

    const spec = ROUTES[transfer.route];
    const result = await this._recordProceeds({
      transfer, spec, proceedsCents, destination, settlement, evidence, actor,
    });

    const rows = await pool.query(
      `UPDATE capital_transfers
          SET status = 'confirmed', settlement_reference = $2, evidence_reference = $3,
              settled_cents = $4, confirmed_by = $5, confirmed_at = NOW(),
              reserve_attestation_id = $6, assignment_id = $7, settlement_note = $8,
              destination_ref = $9, updated_at = NOW()
        WHERE transfer_id = $1
        RETURNING *`,
      [
        tid, settlement, evidence, proceedsCents, actor,
        result.attestationId, result.assignmentId, result.note, destination,
      ]
    );
    await this._appendEvent({
      eventType: 'transfer_confirmed',
      transferId: tid,
      seriesId: transfer.series_id,
      actor,
      payload: {
        settlementReference: settlement,
        settledCents: proceedsCents,
        destinationRef: destination,
        reserveAttestationId: result.attestationId,
        assignmentId: result.assignmentId,
        obligationId: result.obligationId,
      },
    });
    return { ...rows.rows[0], reserve: result };
  }

  /**
   * Attest the settled proceeds as spendable cash and fence them into the
   * transfer's series. A pledge additionally records the advance as a series
   * obligation, because borrowed cash is spendable and owed at the same time.
   */
  static async _recordProceeds({
    transfer, spec, proceedsCents, destination, settlement, evidence, actor,
  }) {
    const out = { attestationId: null, assignmentId: null, obligationId: null, note: '' };
    if (!ReserveEngine) {
      out.note = 'Reserve engine unavailable; settlement recorded on the transfer only.';
      return out;
    }
    try {
      const attestation = await ReserveEngine.record({
        sourceType: spec.destinationSourceType,
        sourceKey: destination,
        verification: 'statement',
        assetClass: 'cash',
        balanceCents: proceedsCents,
        evidenceReference: evidence,
        attestedBy: actor,
        detail: {
          capitalTransferId: transfer.transfer_id,
          route: transfer.route,
          counterparty: transfer.counterparty,
          settlementReference: settlement,
          seriesId: transfer.series_id,
          sourceAssetRef: transfer.source_asset_ref,
        },
      });
      out.attestationId = attestation.attestation_id;
      out.note = `Proceeds attested as ${spec.destinationSourceType} cash at ${destination}.`;
    } catch (e) {
      // A refused attestation must not be papered over: the transfer records
      // that the funds did not become spendable, and why.
      out.note = `Reserve attestation refused: ${e.message}`;
      return out;
    }

    if (SeriesOsEngine) {
      try {
        const assignment = await SeriesOsEngine.assignAsset({
          seriesRef: transfer.series_id,
          assetKind: 'reserve_attestation',
          assetRef: `${spec.destinationSourceType}:${destination}`,
          evidenceReference: evidence,
          assignedBy: actor,
        });
        out.assignmentId = assignment.assignment_id;
        out.note += ' Fenced into the series that raised it.';
      } catch (e) {
        out.note += ` Ring fence not applied: ${e.message}`;
      }

      if (spec.createsObligation) {
        try {
          const obligation = await SeriesOsEngine.recordObligation({
            seriesRef: transfer.series_id,
            obligationType: 'collateral_advance',
            counterparty: transfer.counterparty,
            amountCents: proceedsCents,
            memo: `Advance against ${transfer.source_label} per ${settlement}`,
            createdBy: actor,
          });
          out.obligationId = obligation.obligation_id;
          out.note += ' Advance recorded as a series obligation.';
        } catch (e) {
          out.note += ` Obligation not recorded: ${e.message}`;
        }
      }
    }
    return out;
  }

  static async fail(transferId, { reason, failedBy } = {}) {
    const tid = requireText(transferId, 'transferId is required');
    const actor = requireText(failedBy, 'failedBy is required');
    const why = requireText(reason, 'A reason is required to fail or cancel a capital transfer');
    const transfer = await this.get(tid);
    if (!transfer) throw new Error(`Capital transfer ${tid} not found`);
    if (TERMINAL_STATUSES.includes(transfer.status)) {
      throw new CapitalTransferError(`Capital transfer ${tid} is already ${transfer.status}`, {
        status: transfer.status,
      });
    }
    const next = transfer.status === 'proposed' ? 'cancelled' : 'failed';
    const rows = await pool.query(
      `UPDATE capital_transfers
          SET status = $2, failure_reason = $3, updated_at = NOW()
        WHERE transfer_id = $1
        RETURNING *`,
      [tid, next, why]
    );
    await this._appendEvent({
      eventType: `transfer_${next}`,
      transferId: tid,
      seriesId: transfer.series_id,
      actor,
      payload: { reason: why, from: transfer.status },
    });
    return rows.rows[0];
  }

  // ── Automation ─────────────────────────────────────────────────────────────

  /**
   * Scan every active series for a funding gap and raise the proposals that
   * would close it, best route first.
   *
   * Automation stops at `proposed` by design: signatures and external
   * settlement cannot be scheduled, and a run that auto-confirmed would produce
   * attested reserves with no counterparty behind them. `plan_only` reports the
   * gaps without writing anything.
   */
  static async automate({ actor, seriesRef = null, dryRun = false } = {}) {
    const who = requireText(actor, 'actor is required to run the capital transfer automation');
    const cfg = this.config();
    if (cfg.automation === 'off') {
      return { mode: 'off', proposed: [], skipped: [], note: 'Capital transfer automation is disabled.' };
    }
    if (!SeriesOsEngine) throw new Error('Series OS engine unavailable');
    await this.ensureTables();

    const series = seriesRef
      ? [await SeriesOsEngine.getSeries(seriesRef)].filter(Boolean)
      : await SeriesOsEngine.listSeries();
    const proposed = [];
    const skipped = [];
    const gaps = [];

    for (const row of series) {
      if (row.status !== 'active') {
        skipped.push({ seriesCode: row.series_code, reason: `series is ${row.status}` });
        continue;
      }
      const plan = await this.plan({ seriesRef: row.series_id });
      gaps.push({
        seriesCode: row.series_code,
        gap: plan.gap,
        capacity: plan.capacity,
        coversGap: plan.coversGap,
      });
      if (plan.gapCents <= 0) {
        skipped.push({ seriesCode: row.series_code, reason: 'no funding gap' });
        continue;
      }
      if (!plan.eligible.length) {
        skipped.push({
          seriesCode: row.series_code,
          reason: `gap of $${plan.gap} with no convertible asset fenced into the series`,
        });
        continue;
      }
      if (cfg.automation === 'plan_only' || dryRun) continue;

      let remaining = plan.gapCents;
      // Best proceeds first, so the fewest assets are converted to close the gap.
      const candidates = plan.eligible
        .map((a) => ({ asset: a, best: a.routes.slice().sort((x, y) => y.expectedProceedsCents - x.expectedProceedsCents)[0] }))
        .sort((x, y) => y.best.expectedProceedsCents - x.best.expectedProceedsCents);

      for (const candidate of candidates) {
        if (remaining <= 0) break;
        const amount = Math.min(remaining, candidate.best.expectedProceedsCents);
        try {
          const transfer = await this.propose({
            route: candidate.best.route,
            seriesRef: row.series_id,
            assetKind: candidate.asset.assetKind,
            assetRef: candidate.asset.assetRef,
            amountCents: amount,
            counterparty: candidate.asset.label,
            memo: `Automated proposal to close a $${dollars(plan.gapCents)} funding gap`,
            proposedBy: who,
            origin: 'automation',
          });
          proposed.push(transfer);
          remaining -= amount;
        } catch (e) {
          skipped.push({
            seriesCode: row.series_code,
            assetRef: candidate.asset.assetRef,
            reason: e.message,
          });
        }
      }
    }

    if (proposed.length) {
      await this._appendEvent({
        eventType: 'automation_run',
        actor: who,
        payload: { proposed: proposed.map((t) => t.transfer_id), gaps },
      });
    }
    return {
      mode: dryRun ? 'plan_only' : cfg.automation,
      gaps,
      proposed,
      skipped,
      note: proposed.length
        ? `Raised ${proposed.length} proposal(s). Each still needs ${cfg.requiredSignatures} trustee`
          + ' signatures, an instruction to the counterparty and confirmed settlement before it'
          + ' becomes spendable.'
        : 'No proposal was raised: every series is either funded or holds nothing convertible.',
    };
  }

  static async status() {
    const cfg = this.config();
    const chain = await this.verifyChain().catch((e) => ({ error: e.message }));
    const open = await this.list({ limit: 25 }).catch(() => []);
    const plan = await this.plan().catch((e) => ({ error: e.message }));
    return {
      automation: cfg.automation,
      requiredSignatures: cfg.requiredSignatures,
      pledgeAdvanceRateBps: cfg.pledgeAdvanceRateBps,
      defaultDestination: cfg.defaultDestination || null,
      reserveEngineAvailable: Boolean(ReserveEngine),
      seriesEngineAvailable: Boolean(SeriesOsEngine),
      routes: ROUTE_IDS.map((r) => ({ route: r, ...ROUTES[r] })),
      transfers: open.length,
      pipeline: open.map((t) => ({
        transferId: t.transfer_id,
        route: t.route,
        status: t.status,
        amount: dollars(t.amount_cents),
        counterparty: t.counterparty,
      })),
      chain,
      plan,
      note: 'A transfer becomes spendable series capital only on confirmed external settlement;'
        + ' every earlier stage is an instruction, not funds.',
    };
  }
}

module.exports = {
  CapitalTransferOsEngine,
  CapitalTransferError,
  CAPITAL_ROUTES: ROUTES,
  CAPITAL_ROUTE_IDS: ROUTE_IDS,
};
