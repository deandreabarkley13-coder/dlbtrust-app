'use strict';

/**
 * Pledge OS — the register of pledges and their lien evidence, and the
 * look-through that tells Collateral OS how much of each pledge is backed.
 *
 * A pledge records what is pledged, by whom, to whom, and the public lien
 * notice that perfects it (e.g. a UCC financing statement: filing number,
 * jurisdiction, filing office, filed date). Its backing is one of:
 *   - pe_holding       a Private Equity Holdings OS holding;
 *   - custody_position a Custody OS position;
 *   - bond             a Debt OS bond, looked through to the Private Equity
 *                      Holdings OS holdings that back it.
 *
 * `evaluate` checks each pledge and records `counted` (with the backed value)
 * or `not_counted` (with the unmet criteria). The backed value is always the
 * custody-receipted value of the underlying asset: a lien filing is notice of
 * a security interest, not custody or value. The engine never books GL lines,
 * edits balances, draws or sends a wire, and it does not gate other engines;
 * `coverage` reports how much of the Collateral OS borrowing base the counted
 * pledges back.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');
const { resealEventChain } = require('./eventChainReseal');

function tryRequire(mod) {
  try { return require(mod); } catch (e) { return null; }
}

const BACKING_TYPES = ['pe_holding', 'custody_position', 'bond'];
const STATUSES = ['recorded', 'counted', 'not_counted', 'released'];
const TERMINAL_BOND_STATUSES = ['matured', 'called', 'defaulted'];

class PledgeOsError extends Error {
  constructor(message, code = 'PLEDGE_OS_ERROR', status = 409) {
    super(message);
    this.name = 'PledgeOsError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function isTrue(v) { return String(v || '').toLowerCase() === 'true'; }

function getPledgeOsConfig(env = process.env) {
  return {
    enabled: String(env.PLEDGE_OS_ENABLED || 'true').toLowerCase() !== 'false',
    live: isTrue(env.PLEDGE_OS_LIVE),
    requireThirdPartyCustody: String(env.PLEDGE_OS_REQUIRE_THIRD_PARTY_CUSTODY || 'true').toLowerCase() !== 'false',
  };
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function text(value, message, code = 'PLEDGE_OS_INVALID') {
  const s = String(value == null ? '' : value).trim();
  if (!s) throw new PledgeOsError(message, code, 400);
  return s;
}

function optional(value) {
  const s = String(value == null ? '' : value).trim();
  return s || null;
}

function isoDate(value, field) {
  const d = new Date(value);
  if (!value || Number.isNaN(d.getTime())) throw new PledgeOsError(`${field} must be an ISO date`, 'PLEDGE_OS_INVALID', 400);
  return d.toISOString().slice(0, 10);
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
    e.prevHash || null, e.eventType, e.pledgeId || null, e.actor || null, canonical(e.payload || {}), e.createdAt,
  ])).digest('hex');
}

function custody() { return tryRequire('../custody/custodyOsEngine')?.CustodyOsEngine || null; }
function debt() { return tryRequire('./debtOsEngine')?.DebtOsEngine || null; }
function peHoldings() { return tryRequire('./privateEquityHoldingsOsEngine')?.PrivateEquityHoldingsOsEngine || null; }
function collateral() { return tryRequire('./collateralOsEngine')?.CollateralOsEngine || null; }

function asDate(v) { return v instanceof Date ? v.toISOString().slice(0, 10) : v; }

function rowToPledge(row) {
  if (!row) return null;
  const evaluation = typeof row.evaluation === 'string' ? JSON.parse(row.evaluation) : (row.evaluation || null);
  return {
    pledgeId: row.pledge_id,
    reference: row.reference,
    assetDescription: row.asset_description,
    pledgor: row.pledgor,
    securedParty: row.secured_party,
    backingType: row.backing_type,
    backingRef: row.backing_ref,
    lien: {
      filingNumber: row.lien_filing_number,
      jurisdiction: row.lien_jurisdiction,
      filingType: row.lien_filing_type,
      filingOffice: row.lien_filing_office,
      filedAt: asDate(row.lien_filed_at),
    },
    status: row.status,
    countedCents: Number((evaluation && evaluation.countedCents) || 0),
    counted: dollars((evaluation && evaluation.countedCents) || 0),
    evaluation,
    recordedBy: row.recorded_by,
    evaluatedAt: row.evaluated_at,
    releasedAt: row.released_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const PledgeOsEngine = {
  engineName: 'pledge-os',
  PledgeOsError,
  BACKING_TYPES,
  STATUSES,

  config(env = process.env) { return getPledgeOsConfig(env); },

  async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pledge_os_pledges (
        pledge_id          TEXT PRIMARY KEY,
        reference          TEXT UNIQUE NOT NULL,
        asset_description  TEXT NOT NULL,
        pledgor            TEXT NOT NULL,
        secured_party      TEXT NOT NULL,
        backing_type       TEXT NOT NULL CHECK (backing_type IN ('pe_holding','custody_position','bond')),
        backing_ref        TEXT NOT NULL,
        lien_filing_number TEXT NOT NULL,
        lien_jurisdiction  TEXT NOT NULL,
        lien_filing_type   TEXT,
        lien_filing_office TEXT,
        lien_filed_at      DATE NOT NULL,
        status             TEXT NOT NULL DEFAULT 'recorded'
                           CHECK (status IN ('recorded','counted','not_counted','released')),
        evaluation         JSONB,
        recorded_by        TEXT NOT NULL,
        evaluated_at       TIMESTAMPTZ,
        released_at        TIMESTAMPTZ,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pledge_os_events (
        sequence    BIGSERIAL PRIMARY KEY,
        event_id    TEXT UNIQUE NOT NULL,
        pledge_id   TEXT,
        event_type  TEXT NOT NULL,
        actor       TEXT,
        payload     JSONB NOT NULL DEFAULT '{}',
        prev_hash   TEXT,
        event_hash  TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_pledge_os_lien ON pledge_os_pledges (lien_filing_number)');
    return true;
  },

  async _event(eventType, pledgeId, actor, payload = {}) {
    const tip = await pool.query('SELECT event_hash FROM pledge_os_events ORDER BY sequence DESC LIMIT 1');
    const prevHash = (tip.rows[0] && tip.rows[0].event_hash) || null;
    const createdAt = new Date().toISOString();
    const eventHash = hashEvent({ prevHash, eventType, pledgeId, actor, payload, createdAt });
    await pool.query(
      `INSERT INTO pledge_os_events (event_id, pledge_id, event_type, actor, payload, prev_hash, event_hash, created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
      [newId('PLV'), pledgeId, eventType, actor, JSON.stringify(payload), prevHash, eventHash, createdAt]
    );
    return eventHash;
  },

  async verifyChain() {
    await this.ensureTables();
    const { rows } = await pool.query('SELECT * FROM pledge_os_events ORDER BY sequence ASC');
    let prevHash = null;
    const breaks = [];
    for (const row of rows) {
      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
      const expected = hashEvent({
        prevHash, eventType: row.event_type, pledgeId: row.pledge_id, actor: row.actor, payload,
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
      db: pool, table: 'pledge_os_events', subjectColumn: 'pledge_id', subjectKey: 'pledgeId', hashEvent,
      appendEvent: (type, id, who, payload) => this._event(type, id, who, payload), actor, reason,
    });
    return { ...result, chain: await this.verifyChain() };
  },

  async _requirePledge(pledgeId) {
    const id = text(pledgeId, 'pledgeId is required');
    const { rows } = await pool.query('SELECT * FROM pledge_os_pledges WHERE pledge_id = $1 OR reference = $1', [id]);
    if (!rows[0]) throw new PledgeOsError(`pledge ${id} not found`, 'PLEDGE_OS_NOT_FOUND', 404);
    return rows[0];
  },

  /**
   * Record (or update, by `reference`) a pledge with its lien evidence.
   * Re-recording resets the verdict to `recorded` until the next evaluate.
   */
  async record({
    reference, assetDescription, pledgor, securedParty, backingType, backingRef,
    lienFilingNumber, lienJurisdiction, lienFilingType = null, lienFilingOffice = null, lienFiledAt,
    actor = null,
  } = {}) {
    const cfg = this.config();
    if (!cfg.enabled) throw new PledgeOsError('PLEDGE_OS_ENABLED=false', 'PLEDGE_OS_DISABLED', 503);
    const who = text(actor, 'trustee identity required', 'PLEDGE_OS_ACTOR');
    const ref = text(reference, 'reference is required (e.g. PLEDGE-DLB-PRB-1)');
    const kind = text(backingType, `backingType is required (${BACKING_TYPES.join(', ')})`);
    if (!BACKING_TYPES.includes(kind)) throw new PledgeOsError(`backingType must be one of ${BACKING_TYPES.join(', ')}`, 'PLEDGE_OS_INVALID', 400);
    const row = [
      newId('PLG'), ref,
      text(assetDescription, 'assetDescription is required'),
      text(pledgor, 'pledgor is required'),
      text(securedParty, 'securedParty is required'),
      kind,
      text(backingRef, 'backingRef is required (holding id, custody position id or bond id)'),
      text(lienFilingNumber, 'lienFilingNumber is required (e.g. the UCC financing statement number)'),
      text(lienJurisdiction, 'lienJurisdiction is required (e.g. US-IA)'),
      optional(lienFilingType),
      optional(lienFilingOffice),
      isoDate(lienFiledAt, 'lienFiledAt'),
      who,
    ];
    await this.ensureTables();
    const { rows } = await pool.query(
      `INSERT INTO pledge_os_pledges
         (pledge_id, reference, asset_description, pledgor, secured_party, backing_type, backing_ref,
          lien_filing_number, lien_jurisdiction, lien_filing_type, lien_filing_office, lien_filed_at, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (reference) DO UPDATE
         SET asset_description = EXCLUDED.asset_description, pledgor = EXCLUDED.pledgor,
             secured_party = EXCLUDED.secured_party, backing_type = EXCLUDED.backing_type,
             backing_ref = EXCLUDED.backing_ref, lien_filing_number = EXCLUDED.lien_filing_number,
             lien_jurisdiction = EXCLUDED.lien_jurisdiction, lien_filing_type = EXCLUDED.lien_filing_type,
             lien_filing_office = EXCLUDED.lien_filing_office, lien_filed_at = EXCLUDED.lien_filed_at,
             status = 'recorded', evaluation = NULL, evaluated_at = NULL, released_at = NULL, updated_at = NOW()
       RETURNING *`,
      row
    );
    const pledge = rows[0];
    await this._event('pledge_recorded', pledge.pledge_id, who, {
      reference: ref, backingType: kind, backingRef: pledge.backing_ref,
      lienFilingNumber: pledge.lien_filing_number, lienJurisdiction: pledge.lien_jurisdiction,
    });
    return rowToPledge(pledge);
  },

  async release({ pledgeId, reason, actor = null } = {}) {
    const who = text(actor, 'trustee identity required', 'PLEDGE_OS_ACTOR');
    const why = text(reason, 'reason is required to release a pledge');
    await this.ensureTables();
    const p = await this._requirePledge(pledgeId);
    const { rows } = await pool.query(
      "UPDATE pledge_os_pledges SET status = 'released', released_at = NOW(), updated_at = NOW() WHERE pledge_id = $1 RETURNING *",
      [p.pledge_id]
    );
    await this._event('pledge_released', p.pledge_id, who, { reason: why });
    return rowToPledge(rows[0]);
  },

  /** Shared per-run context: PE holdings, bonds, custody chain. */
  async _context() {
    const Pe = peHoldings();
    const Debt = debt();
    const Custody = custody();
    const holdings = Pe ? await Pe.list({ limit: 500 }).catch(() => []) : [];
    const bonds = Debt ? await Debt.listBonds().catch(() => []) : [];
    const chain = Custody ? await Custody.verifyChain().catch((e) => ({ intact: false, error: e.message })) : { intact: false, error: 'Custody OS not loadable' };
    return { holdings, bonds, chain };
  },

  async _criteria(p, ctx, cfg) {
    const lienOk = Boolean(p.lien_filing_number && p.lien_jurisdiction && p.lien_filed_at);
    const criteria = [
      { id: 'lien_recorded', ok: lienOk, detail: `${p.lien_filing_type || 'lien'} ${p.lien_filing_number} (${p.lien_jurisdiction}) filed ${asDate(p.lien_filed_at)}` },
    ];
    let backedCents = 0;
    if (p.backing_type === 'pe_holding') {
      const h = ctx.holdings.find((x) => x.holdingId === p.backing_ref);
      const eligible = Boolean(h && h.status === 'collateral_eligible');
      backedCents = eligible ? Number((h.evaluation && h.evaluation.receiptedCents) || 0) : 0;
      criteria.push({
        id: 'pe_holding_eligible', ok: eligible,
        detail: !h ? `holding ${p.backing_ref} not found` : `${h.holdingId} ${h.status}${h.evaluation && h.evaluation.failing && h.evaluation.failing.length ? ` (${h.evaluation.failing.join(', ')})` : ''}`,
      });
    } else if (p.backing_type === 'custody_position') {
      const Custody = custody();
      const pos = Custody ? await Custody.getPosition(p.backing_ref).catch(() => null) : null;
      const receipted = Boolean(pos && pos.control_status === 'receipted');
      const thirdParty = Boolean(pos && pos.custody_type === 'third_party');
      criteria.push({ id: 'custody_receipted', ok: receipted, detail: pos ? `${pos.position_id} control_status=${pos.control_status}` : `custody position ${p.backing_ref} not found` });
      criteria.push({ id: 'third_party_custody', ok: !cfg.requireThirdPartyCustody || thirdParty, detail: pos ? `custody_type=${pos.custody_type}${pos.custodian_name ? ` (${pos.custodian_name})` : ''}` : 'n/a' });
      if (receipted && (thirdParty || !cfg.requireThirdPartyCustody)) backedCents = Number(pos.valuation_cents || 0);
    } else {
      const bond = ctx.bonds.find((b) => String(b.id) === String(p.backing_ref));
      const open = Boolean(bond && !TERMINAL_BOND_STATUSES.includes(bond.status));
      const backing = ctx.holdings.filter((h) => String(h.bondId) === String(p.backing_ref) && h.status === 'collateral_eligible');
      backedCents = open ? backing.reduce((s, h) => s + Number((h.evaluation && h.evaluation.receiptedCents) || 0), 0) : 0;
      criteria.push({ id: 'bond_open', ok: open, detail: bond ? `bond #${bond.id} ${bond.bond_name || ''} ${bond.status}`.trim() : `bond ${p.backing_ref} not found` });
      criteria.push({
        id: 'bond_asset_backing', ok: backedCents > 0,
        detail: backing.length
          ? `${backing.length} eligible private-equity holding(s): ${backing.map((h) => h.holdingId).join(', ')}`
          : `no collateral-eligible Private Equity Holdings OS holding backs bond ${p.backing_ref}`,
      });
    }
    criteria.push({ id: 'custody_chain', ok: Boolean(ctx.chain.intact), detail: ctx.chain.intact ? `${ctx.chain.events} custody events intact` : (ctx.chain.error || 'custody chain broken') });
    return { criteria, backedCents };
  },

  /** Evaluate every open pledge (or one) and record its verdict. Moves no money. */
  async evaluate({ pledgeId = null, actor = null } = {}) {
    const cfg = this.config();
    const who = String(actor || 'pledge-os').trim();
    await this.ensureTables();
    const rows = pledgeId
      ? [await this._requirePledge(pledgeId)]
      : (await pool.query("SELECT * FROM pledge_os_pledges WHERE status <> 'released' ORDER BY created_at ASC")).rows;
    const ctx = await this._context();
    const results = [];
    for (const p of rows) {
      if (p.status === 'released') { results.push(rowToPledge(p)); continue; }
      const { criteria, backedCents } = await this._criteria(p, ctx, cfg);
      const unmet = criteria.filter((c) => !c.ok).map((c) => c.id);
      const counted = unmet.length === 0;
      const evaluation = { criteria, unmet, backedCents, countedCents: counted ? backedCents : 0, live: cfg.live, evaluatedBy: who };
      const status = counted ? 'counted' : 'not_counted';
      const updated = await pool.query(
        `UPDATE pledge_os_pledges SET status = $2, evaluation = $3::jsonb, evaluated_at = NOW(), updated_at = NOW()
          WHERE pledge_id = $1 RETURNING *`,
        [p.pledge_id, status, JSON.stringify(evaluation)]
      );
      await this._event('pledge_evaluated', p.pledge_id, who, { status, unmet, countedCents: evaluation.countedCents });
      results.push(rowToPledge(updated.rows[0]));
    }
    return { pledges: results, summary: this._summary(results) };
  },

  _summary(pledges) {
    const open = pledges.filter((p) => p.status !== 'released');
    return {
      pledges: open.length,
      counted: open.filter((p) => p.status === 'counted').length,
      notCounted: open.filter((p) => p.status === 'not_counted').length,
      unevaluated: open.filter((p) => p.status === 'recorded').length,
      countedCents: open.reduce((s, p) => s + p.countedCents, 0),
      countedValue: dollars(open.reduce((s, p) => s + p.countedCents, 0)),
      liens: [...new Set(open.map((p) => p.lien.filingNumber))],
    };
  },

  /** How much of the Collateral OS borrowing base the counted pledges back. Read-only. */
  async coverage() {
    const pledges = await this.list({ limit: 500 });
    const summary = this._summary(pledges);
    const Collateral = collateral();
    let facility = null;
    if (Collateral) facility = await Collateral.facility().catch((e) => ({ error: e.message }));
    const collateralCents = facility && !facility.error ? Math.round(Number(facility.collateralUsd || 0) * 100) : 0;
    return {
      countedCents: summary.countedCents,
      counted: summary.countedValue,
      collateralOs: facility && !facility.error
        ? { collateral: dollars(collateralCents), spendable: Number(facility.spendableUsd || 0).toFixed(2), drawn: Number(facility.drawnUsd || 0).toFixed(2), positions: facility.positions }
        : { error: (facility && facility.error) || 'Collateral OS not loadable' },
      unbackedCents: Math.max(collateralCents - summary.countedCents, 0),
      unbacked: dollars(Math.max(collateralCents - summary.countedCents, 0)),
    };
  },

  async list({ limit = 50, status = null } = {}) {
    await this.ensureTables();
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const { rows } = status
      ? await pool.query('SELECT * FROM pledge_os_pledges WHERE status = $1 ORDER BY created_at DESC LIMIT $2', [status, lim])
      : await pool.query('SELECT * FROM pledge_os_pledges ORDER BY created_at DESC LIMIT $1', [lim]);
    return rows.map(rowToPledge);
  },

  async get(pledgeId) {
    await this.ensureTables();
    const { rows } = await pool.query('SELECT * FROM pledge_os_pledges WHERE pledge_id = $1 OR reference = $1', [pledgeId]);
    if (!rows[0]) return null;
    const events = await pool.query('SELECT event_id, event_type, actor, payload, event_hash, created_at FROM pledge_os_events WHERE pledge_id = $1 ORDER BY sequence ASC', [rows[0].pledge_id]);
    return { ...rowToPledge(rows[0]), events: events.rows };
  },

  async status() {
    const cfg = this.config();
    await this.ensureTables();
    const pledges = await this.list({ limit: 500 });
    const chain = await this.verifyChain().catch((e) => ({ intact: false, error: e.message }));
    return {
      engine: 'pledge-os',
      enabled: cfg.enabled,
      live: cfg.live,
      policy: { backingTypes: BACKING_TYPES, requireThirdPartyCustody: cfg.requireThirdPartyCustody },
      summary: this._summary(pledges),
      pledges,
      chain,
      coverage: await this.coverage().catch((e) => ({ error: e.message })),
      legalStatus: 'recorded pledges and lien notices; not a title search, valuation opinion or perfection determination',
      movesMoney: false,
    };
  },

  async health() {
    const s = await this.status();
    return { engine: s.engine, healthy: s.enabled && s.chain.intact !== false, mode: s.live ? 'live' : 'shadow', pledges: s.summary.pledges, timestamp: new Date().toISOString() };
  },

  async readiness() {
    const s = await this.status();
    const blockers = [];
    if (!s.enabled) blockers.push('PLEDGE_OS_ENABLED=false');
    if (!s.live) blockers.push('PLEDGE_OS_LIVE not true');
    if (!s.chain.intact) blockers.push(`pledge event chain broken: ${s.chain.error || `${(s.chain.breaks || []).length} break(s)`}`);
    const open = s.pledges.filter((p) => p.status !== 'released');
    if (!open.length) blockers.push('no pledge recorded (action=record)');
    const warnings = [];
    for (const p of open) {
      if (p.status === 'recorded') warnings.push(`${p.reference}: not evaluated (action=evaluate)`);
      else if (p.status === 'not_counted') warnings.push(`${p.reference}: not counted (${p.evaluation.unmet.join(', ')})`);
    }
    if (s.coverage && s.coverage.unbackedCents > 0) warnings.push(`Collateral OS carries $${s.coverage.unbacked} of collateral not backed by a counted pledge`);
    const ready = blockers.length === 0;
    return { ready, mode: ready ? 'live' : 'shadow', blockers, warnings, status: s };
  },

  async process({ action, actor = null, ...body } = {}) {
    switch (action) {
      case 'record': return this.record({ ...body, actor });
      case 'evaluate': return this.evaluate({ ...body, actor });
      case 'release': return this.release({ ...body, actor });
      case 'coverage': return this.coverage();
      case 'verify_chain': return this.verifyChain();
      case 'reseal_chain': return this.resealChain({ ...body, actor });
      default:
        throw new PledgeOsError(
          `unknown action "${action}" (record, evaluate, release, coverage, verify_chain, reseal_chain)`,
          'PLEDGE_OS_UNKNOWN_ACTION', 400
        );
    }
  },
};

module.exports = { PledgeOsEngine, PledgeOsError, getPledgeOsConfig, BACKING_TYPES, STATUSES };
