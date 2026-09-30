'use strict';

/**
 * Private Equity Holdings OS — the enterprise register of private-equity
 * interests that back the PFTC-issued private-placement bond.
 *
 * Each holding binds one private-equity interest to:
 *   - the trustee-declared family trust company profile (Private Entity OS),
 *     which is the issuer of record;
 *   - one private-placement bond (Debt OS: placement_type='private', family
 *     and trustee holders only, KYC verified, no AML flag);
 *   - one Custody OS position (asset class `private_equity`) whose control
 *     status only becomes `receipted` against a documentary receipt and a
 *     second trustee's countersignature;
 *   - the latest certified Proof of Asset verdict for that bond.
 *
 * Custody OS stays the source of truth for the receipted value and the chain
 * of title; this engine never books GL lines or edits balances. A holding is
 * `collateral_eligible` only when every gate passes, and the eligible amount
 * is the receipted value at the Collateral OS equity advance rate. Borrowing
 * against it, and any wire, still goes through Collateral OS and the screened
 * maker/checker settlement pipeline.
 *
 * Intra-trust holdings (`registerIntraTrust`) record the trust's own
 * private-placement bond as an internal holding, pointing at the bond's
 * self-custody issuer-register position in Custody OS. They carry status
 * `intra_trust`, are never evaluated for collateral eligibility, and are
 * reported separately from backing holdings.
 *
 * What this engine is not: a valuation opinion, a title search, or a
 * securities-law determination. It records what the trustees declared and
 * evidenced, and whether the platform's controls hold.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');

function tryRequire(mod) {
  try { return require(mod); } catch (e) { return null; }
}

const CUSTODY_ASSET_CLASS = 'private_equity';
const COLLATERAL_ASSET_CLASS = 'equity';
const STATUSES = ['registered', 'blocked', 'collateral_eligible', 'intra_trust', 'retired'];
const UNEVALUATED_STATUSES = ['retired', 'intra_trust'];
const TERMINAL_BOND_STATUSES = ['matured', 'called', 'defaulted'];
const DAY_MS = 24 * 60 * 60 * 1000;

class PrivateEquityHoldingsError extends Error {
  constructor(message, code = 'PE_HOLDINGS_ERROR', status = 409) {
    super(message);
    this.name = 'PrivateEquityHoldingsError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function isTrue(v) { return String(v || '').toLowerCase() === 'true'; }

function intEnv(env, key, fallback) {
  const n = Number(env[key]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function getPrivateEquityHoldingsConfig(env = process.env) {
  return {
    enabled: String(env.PE_HOLDINGS_ENABLED || 'true').toLowerCase() !== 'false',
    live: isTrue(env.PE_HOLDINGS_LIVE),
    custodyAccountId: String(env.PE_HOLDINGS_CUSTODY_ACCOUNT_ID || 'CUS-PE-HOLDINGS').trim(),
    maxValuationAgeDays: intEnv(env, 'PE_HOLDINGS_MAX_VALUATION_AGE_DAYS', 120),
    requireThirdPartyCustody: String(env.PE_HOLDINGS_REQUIRE_THIRD_PARTY_CUSTODY || 'true').toLowerCase() !== 'false',
    advanceRateBps: env.PE_HOLDINGS_ADVANCE_RATE_BPS || null,
  };
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function text(value, message, code = 'PE_HOLDINGS_INVALID') {
  const s = String(value == null ? '' : value).trim();
  if (!s) throw new PrivateEquityHoldingsError(message, code, 400);
  return s;
}

function wholeCents(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new PrivateEquityHoldingsError(`${field} must be a positive whole number of cents`, 'PE_HOLDINGS_INVALID', 400);
  return n;
}

function isoDate(value, field) {
  const d = new Date(value);
  if (!value || Number.isNaN(d.getTime())) throw new PrivateEquityHoldingsError(`${field} must be an ISO date`, 'PE_HOLDINGS_INVALID', 400);
  if (d.getTime() > Date.now() + DAY_MS) throw new PrivateEquityHoldingsError(`${field} cannot be in the future`, 'PE_HOLDINGS_INVALID', 400);
  return d.toISOString().slice(0, 10);
}

function dollars(cents) { return (Number(cents || 0) / 100).toFixed(2); }

function hashEvent(e) {
  return crypto.createHash('sha256').update(JSON.stringify([
    e.prevHash || null, e.eventType, e.holdingId || null, e.actor || null, e.payload || {}, e.createdAt,
  ])).digest('hex');
}

function custody() { return tryRequire('../custody/custodyOsEngine')?.CustodyOsEngine || null; }
function debt() { return tryRequire('./debtOsEngine')?.DebtOsEngine || null; }
function privateEntity() { return tryRequire('./privateEntityOsEngine')?.PrivateEntityOsEngine || null; }
function proofOfAsset() { return tryRequire('./proofOfAssetOsEngine')?.ProofOfAssetOsEngine || null; }
function collateral() { return tryRequire('./collateralOsEngine') || null; }

function rowToHolding(row) {
  if (!row) return null;
  const evaluation = typeof row.evaluation === 'string' ? JSON.parse(row.evaluation) : (row.evaluation || null);
  return {
    holdingId: row.holding_id,
    bondId: row.bond_id == null ? null : Number(row.bond_id),
    entityProfileId: row.entity_profile_id,
    issuerName: row.issuer_name,
    holdingName: row.holding_name,
    instrumentRef: row.instrument_ref,
    custodyAccountId: row.custody_account_id,
    custodyPositionId: row.custody_position_id,
    quantity: Number(row.quantity || 0),
    valuationCents: Number(row.valuation_cents || 0),
    valuation: dollars(row.valuation_cents),
    valuationAsOf: row.valuation_as_of instanceof Date ? row.valuation_as_of.toISOString().slice(0, 10) : row.valuation_as_of,
    valuationSource: row.valuation_source,
    status: row.status,
    evaluation,
    registeredBy: row.registered_by,
    evaluatedAt: row.evaluated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const PrivateEquityHoldingsOsEngine = {
  engineName: 'private-equity-holdings',
  PrivateEquityHoldingsError,
  STATUSES,

  config(env = process.env) { return getPrivateEquityHoldingsConfig(env); },

  async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pe_holdings (
        holding_id          TEXT PRIMARY KEY,
        bond_id             INTEGER NOT NULL,
        entity_profile_id   TEXT,
        issuer_name         TEXT,
        holding_name        TEXT NOT NULL,
        instrument_ref      TEXT NOT NULL UNIQUE,
        custody_account_id  TEXT NOT NULL,
        custody_position_id TEXT NOT NULL,
        quantity            NUMERIC(28,8) NOT NULL DEFAULT 0,
        valuation_cents     BIGINT NOT NULL CHECK (valuation_cents > 0),
        valuation_as_of     DATE NOT NULL,
        valuation_source    TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'registered'
                            CHECK (status IN ('registered','blocked','collateral_eligible','intra_trust','retired')),
        evaluation          JSONB,
        registered_by       TEXT NOT NULL,
        evaluated_at        TIMESTAMPTZ,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pe_holding_events (
        sequence    BIGSERIAL PRIMARY KEY,
        event_id    TEXT UNIQUE NOT NULL,
        holding_id  TEXT,
        event_type  TEXT NOT NULL,
        actor       TEXT,
        payload     JSONB NOT NULL DEFAULT '{}',
        prev_hash   TEXT,
        event_hash  TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_pe_holdings_bond ON pe_holdings (bond_id)');
    await pool.query(`
      ALTER TABLE pe_holdings DROP CONSTRAINT IF EXISTS pe_holdings_status_check,
        ADD CONSTRAINT pe_holdings_status_check
        CHECK (status IN ('registered','blocked','collateral_eligible','intra_trust','retired'))`);
    return true;
  },

  async _event(eventType, holdingId, actor, payload = {}) {
    const tip = await pool.query('SELECT event_hash FROM pe_holding_events ORDER BY sequence DESC LIMIT 1');
    const prevHash = (tip.rows[0] && tip.rows[0].event_hash) || null;
    const createdAt = new Date().toISOString();
    const eventHash = hashEvent({ prevHash, eventType, holdingId, actor, payload, createdAt });
    await pool.query(
      `INSERT INTO pe_holding_events (event_id, holding_id, event_type, actor, payload, prev_hash, event_hash, created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
      [newId('PEV'), holdingId, eventType, actor, JSON.stringify(payload), prevHash, eventHash, createdAt]
    );
    return eventHash;
  },

  async verifyChain() {
    await this.ensureTables();
    const { rows } = await pool.query('SELECT * FROM pe_holding_events ORDER BY sequence ASC');
    let prevHash = null;
    const breaks = [];
    for (const row of rows) {
      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
      const expected = hashEvent({
        prevHash, eventType: row.event_type, holdingId: row.holding_id, actor: row.actor, payload,
        createdAt: new Date(row.created_at).toISOString(),
      });
      if (expected !== row.event_hash || (row.prev_hash || null) !== prevHash) breaks.push({ eventId: row.event_id, sequence: Number(row.sequence) });
      prevHash = row.event_hash;
    }
    return { events: rows.length, intact: breaks.length === 0, breaks, tipHash: prevHash };
  },

  async _bond(bondId) {
    const Debt = debt();
    if (!Debt) throw new PrivateEquityHoldingsError('Debt OS not loadable', 'PE_HOLDINGS_DEPENDENCY', 503);
    const bond = (await Debt.listBonds()).find((b) => Number(b.id) === Number(bondId));
    if (!bond) throw new PrivateEquityHoldingsError(`bond ${bondId} not found`, 'PE_HOLDINGS_NO_BOND', 404);
    return bond;
  },

  async _requireHolding(holdingId) {
    const id = text(holdingId, 'holdingId is required');
    const { rows } = await pool.query('SELECT * FROM pe_holdings WHERE holding_id = $1', [id]);
    if (!rows[0]) throw new PrivateEquityHoldingsError(`holding ${id} not found`, 'PE_HOLDINGS_NOT_FOUND', 404);
    return rows[0];
  },

  /**
   * Register (or re-value) a private-equity interest as backing for a private
   * placement bond. Records the Custody OS position, which resets it to
   * `unverified` until a new receipt is countersigned.
   */
  async register({
    bondId, holdingName, instrumentRef, quantity = 1, valuationCents, valuationAsOf, valuationSource,
    custodyAccountId = null, actor = null,
  } = {}) {
    const cfg = this.config();
    if (!cfg.enabled) throw new PrivateEquityHoldingsError('PE_HOLDINGS_ENABLED=false', 'PE_HOLDINGS_DISABLED', 503);
    const who = text(actor, 'trustee identity required', 'PE_HOLDINGS_ACTOR');
    const name = text(holdingName, 'holdingName is required');
    const ref = text(instrumentRef, 'instrumentRef is required (e.g. the subscription or LP interest reference)');
    const source = text(valuationSource, 'valuationSource is required (e.g. GP capital account statement id, appraisal id)');
    const value = wholeCents(valuationCents, 'valuationCents');
    const asOf = isoDate(valuationAsOf, 'valuationAsOf');
    const bond = await this._bond(bondId);
    if ((bond.placement_type || 'public') !== 'private') throw new PrivateEquityHoldingsError(`bond ${bond.id} is not a private placement`, 'PE_HOLDINGS_NOT_PRIVATE', 409);
    if (TERMINAL_BOND_STATUSES.includes(bond.status)) throw new PrivateEquityHoldingsError(`bond ${bond.id} is ${bond.status}`, 'PE_HOLDINGS_BOND_CLOSED', 409);

    const Pe = privateEntity();
    const profile = Pe ? await Pe.current() : null;
    if (!profile) throw new PrivateEquityHoldingsError('no PFTC profile registered (Private Entity OS action=register)', 'PE_HOLDINGS_NO_ISSUER', 409);

    const Custody = custody();
    if (!Custody) throw new PrivateEquityHoldingsError('Custody OS not loadable', 'PE_HOLDINGS_DEPENDENCY', 503);
    const accountId = String(custodyAccountId || cfg.custodyAccountId).trim();
    const position = await Custody.recordPosition({
      custodyAccountId: accountId,
      assetClass: CUSTODY_ASSET_CLASS,
      instrumentRef: ref,
      instrumentName: name,
      quantity: Number(quantity || 0),
      valuationCents: value,
      recordedBy: who,
    });

    await this.ensureTables();
    const { rows } = await pool.query(
      `INSERT INTO pe_holdings
         (holding_id, bond_id, entity_profile_id, issuer_name, holding_name, instrument_ref, custody_account_id,
          custody_position_id, quantity, valuation_cents, valuation_as_of, valuation_source, registered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (instrument_ref) DO UPDATE
         SET bond_id = EXCLUDED.bond_id, entity_profile_id = EXCLUDED.entity_profile_id,
             issuer_name = EXCLUDED.issuer_name, holding_name = EXCLUDED.holding_name,
             custody_account_id = EXCLUDED.custody_account_id, custody_position_id = EXCLUDED.custody_position_id,
             quantity = EXCLUDED.quantity, valuation_cents = EXCLUDED.valuation_cents,
             valuation_as_of = EXCLUDED.valuation_as_of, valuation_source = EXCLUDED.valuation_source,
             status = 'registered', evaluation = NULL, evaluated_at = NULL, updated_at = NOW()
       RETURNING *`,
      [newId('PEH'), Number(bond.id), profile.profile_id || null, profile.entity_name || null, name, ref, accountId,
        position.position_id, Number(quantity || 0), value, asOf, source, who]
    );
    const holding = rows[0];
    await this._event('holding_registered', holding.holding_id, who, {
      bondId: Number(bond.id), instrumentRef: ref, custodyPositionId: position.position_id, valuationCents: value, valuationAsOf: asOf, valuationSource: source,
    });
    return rowToHolding(holding);
  },

  /**
   * Record a private-placement bond as an intra-trust holding: the trust's own
   * bond, held in its self-custody issuer register (Custody OS `BOND-<id>`).
   * Status is `intra_trust`; it is excluded from backing and collateral totals.
   */
  async registerIntraTrust({ bondId, holdingName = null, instrumentRef = null, actor = null } = {}) {
    const cfg = this.config();
    if (!cfg.enabled) throw new PrivateEquityHoldingsError('PE_HOLDINGS_ENABLED=false', 'PE_HOLDINGS_DISABLED', 503);
    const who = text(actor, 'trustee identity required', 'PE_HOLDINGS_ACTOR');
    const bond = await this._bond(bondId);
    const Custody = custody();
    if (!Custody) throw new PrivateEquityHoldingsError('Custody OS not loadable', 'PE_HOLDINGS_DEPENDENCY', 503);
    const issuerAccountId = Custody.config().issuerAccountId;
    const bondRef = `BOND-${bond.id}`;
    const find = async () => (await Custody.listPositions({ custodyAccountId: issuerAccountId })).find((p) => p.instrument_ref === bondRef);
    let position = await find();
    if (!position && typeof Custody.syncFixedIncome === 'function') {
      await Custody.syncFixedIncome({ syncedBy: who, proposeReceipts: false });
      position = await find();
    }
    if (!position) throw new PrivateEquityHoldingsError(`no ${bondRef} position in ${issuerAccountId} (run Custody OS fixed-income sync)`, 'PE_HOLDINGS_NO_POSITION', 409);
    const value = Number(position.valuation_cents || 0) || Math.round(Number(bond.face_value || 0) * 100);
    if (!Number.isInteger(value) || value <= 0) throw new PrivateEquityHoldingsError(`${bondRef} has no book value`, 'PE_HOLDINGS_INVALID', 400);
    const Pe = privateEntity();
    const profile = Pe ? await Pe.current().catch(() => null) : null;
    const ref = String(instrumentRef || `INTRA-${bondRef}`).trim();
    const name = String(holdingName || `${bond.bond_name || bondRef} (intra-trust)`).trim();
    const asOf = new Date().toISOString().slice(0, 10);

    await this.ensureTables();
    const { rows } = await pool.query(
      `INSERT INTO pe_holdings
         (holding_id, bond_id, entity_profile_id, issuer_name, holding_name, instrument_ref, custody_account_id,
          custody_position_id, quantity, valuation_cents, valuation_as_of, valuation_source, registered_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'intra_trust')
       ON CONFLICT (instrument_ref) DO UPDATE
         SET bond_id = EXCLUDED.bond_id, entity_profile_id = EXCLUDED.entity_profile_id,
             issuer_name = EXCLUDED.issuer_name, holding_name = EXCLUDED.holding_name,
             custody_account_id = EXCLUDED.custody_account_id, custody_position_id = EXCLUDED.custody_position_id,
             quantity = EXCLUDED.quantity, valuation_cents = EXCLUDED.valuation_cents,
             valuation_as_of = EXCLUDED.valuation_as_of, valuation_source = EXCLUDED.valuation_source,
             status = 'intra_trust', evaluation = NULL, evaluated_at = NULL, updated_at = NOW()
       RETURNING *`,
      [newId('PEH'), Number(bond.id), (profile && profile.profile_id) || null, (profile && profile.entity_name) || null, name, ref,
        issuerAccountId, position.position_id, Number(position.quantity || bond.face_value || 1), value, asOf,
        `custody-os:${issuerAccountId}:${bondRef} (self_custody issuer register)`, who]
    );
    const holding = rows[0];
    await this._event('holding_registered_intra_trust', holding.holding_id, who, {
      bondId: Number(bond.id), instrumentRef: ref, custodyAccountId: issuerAccountId, custodyPositionId: position.position_id,
      custodyType: position.custody_type || 'self_custody', valuationCents: value,
    });
    return rowToHolding(holding);
  },

  /** Maker side of the custody receipt: documentary evidence for the holding's current value. */
  async proposeReceipt({ holdingId, evidenceReference, actor = null } = {}) {
    const who = text(actor, 'trustee identity required', 'PE_HOLDINGS_ACTOR');
    await this.ensureTables();
    const h = await this._requireHolding(holdingId);
    if (h.status === 'retired') throw new PrivateEquityHoldingsError(`holding ${h.holding_id} is retired`, 'PE_HOLDINGS_RETIRED', 409);
    const receipt = await custody().proposeReceipt({
      positionId: h.custody_position_id,
      action: 'safekeeping',
      valuationCents: Number(h.valuation_cents),
      quantity: Number(h.quantity || 0),
      evidenceReference,
      proposedBy: who,
    });
    await this._event('receipt_proposed', h.holding_id, who, { receiptId: receipt.receipt_id, evidenceReference });
    return receipt;
  },

  /** Checker side: Custody OS refuses a signer who already signed the receipt. */
  async countersign({ holdingId, receiptId, actor = null } = {}) {
    const who = text(actor, 'trustee identity required', 'PE_HOLDINGS_ACTOR');
    const rid = text(receiptId, 'receiptId is required');
    await this.ensureTables();
    const h = await this._requireHolding(holdingId);
    const found = await pool.query('SELECT position_id FROM custody_receipts WHERE receipt_id = $1', [rid]);
    if (!found.rows[0] || found.rows[0].position_id !== h.custody_position_id) {
      throw new PrivateEquityHoldingsError(`receipt ${rid} is not for holding ${h.holding_id}`, 'PE_HOLDINGS_RECEIPT_MISMATCH', 409);
    }
    const result = await custody().countersignReceipt(rid, who, { role: 'trustee' });
    await this._event('receipt_countersigned', h.holding_id, who, { receiptId: rid, controlStatus: result.controlStatus || null });
    return result;
  },

  async retire({ holdingId, reason, actor = null } = {}) {
    const who = text(actor, 'trustee identity required', 'PE_HOLDINGS_ACTOR');
    const why = text(reason, 'reason is required to retire a holding');
    await this.ensureTables();
    const h = await this._requireHolding(holdingId);
    const { rows } = await pool.query(
      "UPDATE pe_holdings SET status = 'retired', updated_at = NOW() WHERE holding_id = $1 RETURNING *", [h.holding_id]
    );
    await this._event('holding_retired', h.holding_id, who, { reason: why });
    return rowToHolding(rows[0]);
  },

  /** Shared, per-run context for evaluating many holdings. */
  async _context({ bondIds, prove = false, actor = null } = {}) {
    const Pe = privateEntity();
    const Debt = debt();
    const Poa = proofOfAsset();
    const Custody = custody();
    const entity = Pe ? await Pe.readiness().catch((e) => ({ ready: false, blockers: [e.message] })) : { ready: false, blockers: ['Private Entity OS not loadable'] };
    const placement = Debt ? await Debt.placementCompliance().catch((e) => ({ compliant: false, issues: [e.message] })) : { compliant: false, issues: ['Debt OS not loadable'] };
    const bonds = Debt ? await Debt.listBonds().catch(() => []) : [];
    const chain = Custody ? await Custody.verifyChain().catch((e) => ({ intact: false, error: e.message })) : { intact: false, error: 'Custody OS not loadable' };
    const proofs = {};
    for (const bondId of bondIds) {
      if (!Poa) { proofs[bondId] = { error: 'Proof of Asset OS not loadable' }; continue; }
      try {
        if (prove) await Poa.prove({ bondId, createdBy: actor || 'private-equity-holdings' });
        proofs[bondId] = await Poa.latest({ bondId });
      } catch (e) { proofs[bondId] = { error: e.message }; }
    }
    return { entity, placement, bonds, chain, proofs };
  },

  _gates(h, position, ctx, cfg, now = Date.now()) {
    const bond = ctx.bonds.find((b) => Number(b.id) === Number(h.bond_id));
    const proof = ctx.proofs[Number(h.bond_id)];
    const ageDays = Math.floor((now - new Date(h.valuation_as_of).getTime()) / DAY_MS);
    const receiptedCents = position && position.control_status === 'receipted' ? Number(position.valuation_cents || 0) : 0;
    const gates = [
      { id: 'pftc_issuer', ok: Boolean(ctx.entity.ready), detail: ctx.entity.ready ? 'PFTC profile attested and live' : (ctx.entity.blockers || []).join('; ') },
      { id: 'private_placement_bond', ok: Boolean(bond && bond.placement_type === 'private' && !TERMINAL_BOND_STATUSES.includes(bond.status)), detail: bond ? `bond #${bond.id} ${bond.status} placement_type=${bond.placement_type || 'public'}` : `bond ${h.bond_id} not found` },
      { id: 'placement_compliance', ok: Boolean(ctx.placement.compliant), detail: ctx.placement.compliant ? 'trust/family holders only, KYC verified, no AML flags' : (ctx.placement.issues || []).join('; ') },
      { id: 'custody_position', ok: Boolean(position && position.asset_class === CUSTODY_ASSET_CLASS && position.custody_account_id === h.custody_account_id), detail: position ? `${position.position_id} ${position.asset_class} in ${position.custody_account_id}` : `custody position ${h.custody_position_id} not found` },
      { id: 'custody_receipted', ok: Boolean(position && position.control_status === 'receipted'), detail: position ? `control_status=${position.control_status}; receipt ${position.last_receipt_id || 'none'}` : 'n/a' },
      { id: 'third_party_custody', ok: !cfg.requireThirdPartyCustody || Boolean(position && position.custody_type === 'third_party'), detail: position ? `custody_type=${position.custody_type}${position.custodian_name ? ` (${position.custodian_name})` : ''}` : 'n/a' },
      { id: 'valuation_matches_receipt', ok: receiptedCents > 0 && receiptedCents === Number(h.valuation_cents), detail: `declared ${dollars(h.valuation_cents)}, receipted ${dollars(receiptedCents)}` },
      { id: 'valuation_current', ok: ageDays <= cfg.maxValuationAgeDays, detail: `valuation as of ${rowToHolding(h).valuationAsOf} is ${ageDays}d old (max ${cfg.maxValuationAgeDays}d)` },
      { id: 'proof_of_asset', ok: Boolean(proof && proof.verdict === 'proven' && proof.certifiedBy), detail: !proof ? `no proof for bond ${h.bond_id}` : proof.error ? proof.error : `${proof.proofId} verdict=${proof.verdict}${proof.certifiedBy ? ' certified' : ' uncertified'}` },
      { id: 'custody_chain', ok: Boolean(ctx.chain.intact), detail: ctx.chain.intact ? `${ctx.chain.events} custody events intact` : (ctx.chain.error || `custody chain breaks: ${(ctx.chain.breaks || []).length}`) },
    ];
    return { gates, receiptedCents };
  },

  /**
   * Evaluate every open holding (or one) against the live gates and persist
   * the verdict. Writes evaluation rows and events only — never money.
   */
  async evaluate({ holdingId = null, prove = false, actor = null } = {}) {
    const cfg = this.config();
    const who = String(actor || 'private-equity-holdings').trim();
    await this.ensureTables();
    const { rows } = holdingId
      ? await pool.query('SELECT * FROM pe_holdings WHERE holding_id = $1', [holdingId])
      : await pool.query("SELECT * FROM pe_holdings WHERE status <> 'retired' ORDER BY created_at ASC");
    if (holdingId && !rows[0]) throw new PrivateEquityHoldingsError(`holding ${holdingId} not found`, 'PE_HOLDINGS_NOT_FOUND', 404);
    const bondIds = [...new Set(rows.map((r) => Number(r.bond_id)))];
    const ctx = await this._context({ bondIds, prove, actor: who });
    const Custody = custody();
    const Collateral = collateral();
    const rateBps = Collateral ? Collateral.advanceRateFor({ assetClass: COLLATERAL_ASSET_CLASS, override: cfg.advanceRateBps }) : 0;
    const results = [];
    for (const h of rows) {
      if (UNEVALUATED_STATUSES.includes(h.status)) { results.push(rowToHolding(h)); continue; }
      const position = Custody ? await Custody.getPosition(h.custody_position_id).catch(() => null) : null;
      const { gates, receiptedCents } = this._gates(h, position, ctx, cfg);
      const failing = gates.filter((g) => !g.ok).map((g) => g.id);
      const eligible = failing.length === 0;
      const evaluation = {
        gates,
        failing,
        receiptedCents,
        advanceRateBps: rateBps,
        eligibleCollateralCents: eligible ? Math.floor(receiptedCents * rateBps / 10000) : 0,
        live: cfg.live,
        evaluatedBy: who,
      };
      const status = eligible ? 'collateral_eligible' : 'blocked';
      const updated = await pool.query(
        `UPDATE pe_holdings SET status = $2, evaluation = $3::jsonb, evaluated_at = NOW(), updated_at = NOW()
          WHERE holding_id = $1 RETURNING *`,
        [h.holding_id, status, JSON.stringify(evaluation)]
      );
      await this._event('holding_evaluated', h.holding_id, who, { status, failing, eligibleCollateralCents: evaluation.eligibleCollateralCents });
      results.push(rowToHolding(updated.rows[0]));
    }
    return { holdings: results, summary: this._summary(results) };
  },

  _summary(holdings) {
    const open = holdings.filter((h) => !UNEVALUATED_STATUSES.includes(h.status));
    const intra = holdings.filter((h) => h.status === 'intra_trust');
    const eligible = open.filter((h) => h.status === 'collateral_eligible');
    const sum = (list, f) => list.reduce((s, h) => s + f(h), 0);
    const byBond = {};
    for (const h of open) {
      const b = byBond[h.bondId] || (byBond[h.bondId] = { bondId: h.bondId, holdings: 0, declaredCents: 0, receiptedCents: 0, eligibleCollateralCents: 0 });
      b.holdings += 1;
      b.declaredCents += h.valuationCents;
      b.receiptedCents += (h.evaluation && h.evaluation.receiptedCents) || 0;
      b.eligibleCollateralCents += (h.evaluation && h.evaluation.eligibleCollateralCents) || 0;
    }
    return {
      holdings: open.length,
      collateralEligible: eligible.length,
      blocked: open.filter((h) => h.status === 'blocked').length,
      unevaluated: open.filter((h) => h.status === 'registered').length,
      declared: dollars(sum(open, (h) => h.valuationCents)),
      receipted: dollars(sum(open, (h) => (h.evaluation && h.evaluation.receiptedCents) || 0)),
      eligibleCollateral: dollars(sum(eligible, (h) => h.evaluation.eligibleCollateralCents || 0)),
      eligibleCollateralCents: sum(eligible, (h) => h.evaluation.eligibleCollateralCents || 0),
      byBond: Object.values(byBond),
      intraTrust: {
        holdings: intra.length,
        book: dollars(sum(intra, (h) => h.valuationCents)),
        bookCents: sum(intra, (h) => h.valuationCents),
        countsAsCollateral: false,
      },
    };
  },

  async list({ limit = 50, status = null } = {}) {
    await this.ensureTables();
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const { rows } = status
      ? await pool.query('SELECT * FROM pe_holdings WHERE status = $1 ORDER BY created_at DESC LIMIT $2', [status, lim])
      : await pool.query('SELECT * FROM pe_holdings ORDER BY created_at DESC LIMIT $1', [lim]);
    return rows.map(rowToHolding);
  },

  async get(holdingId) {
    await this.ensureTables();
    const { rows } = await pool.query('SELECT * FROM pe_holdings WHERE holding_id = $1', [holdingId]);
    if (!rows[0]) return null;
    const events = await pool.query('SELECT event_id, event_type, actor, payload, event_hash, created_at FROM pe_holding_events WHERE holding_id = $1 ORDER BY sequence ASC', [holdingId]);
    return { ...rowToHolding(rows[0]), events: events.rows };
  },

  async status() {
    const cfg = this.config();
    await this.ensureTables();
    const { rows } = await pool.query('SELECT * FROM pe_holdings ORDER BY created_at ASC');
    const holdings = rows.map(rowToHolding);
    const chain = await this.verifyChain().catch((e) => ({ intact: false, error: e.message }));
    const Collateral = collateral();
    const collateralOs = Collateral && Collateral.CollateralOsEngine
      ? await Collateral.CollateralOsEngine.readiness().catch((e) => ({ ready: false, issues: [e.message] }))
      : { ready: false, issues: ['Collateral OS not loadable'] };
    return {
      engine: 'private-equity-holdings',
      enabled: cfg.enabled,
      live: cfg.live,
      custody: { accountId: cfg.custodyAccountId, assetClass: CUSTODY_ASSET_CLASS, requireThirdPartyCustody: cfg.requireThirdPartyCustody },
      policy: { maxValuationAgeDays: cfg.maxValuationAgeDays, collateralAssetClass: COLLATERAL_ASSET_CLASS, advanceRateOverrideBps: cfg.advanceRateBps },
      summary: this._summary(holdings),
      holdings,
      chain,
      collateralOs: { ready: Boolean(collateralOs.ready), issues: collateralOs.issues || [] },
      legalStatus: 'trustee-declared holdings and custody evidence; not a valuation opinion, title search or securities-law determination',
      movesMoney: false,
    };
  },

  async health() {
    const s = await this.status();
    return { engine: s.engine, healthy: s.enabled && s.chain.intact !== false, mode: s.live ? 'live' : 'shadow', holdings: s.summary.holdings, timestamp: new Date().toISOString() };
  },

  async readiness() {
    const s = await this.status();
    const blockers = [];
    if (!s.enabled) blockers.push('PE_HOLDINGS_ENABLED=false');
    if (!s.live) blockers.push('PE_HOLDINGS_LIVE not true');
    if (!s.chain.intact) blockers.push(`private-equity holdings event chain broken: ${s.chain.error || (s.chain.breaks || []).length + ' break(s)'}`);
    const open = s.holdings.filter((h) => !UNEVALUATED_STATUSES.includes(h.status));
    if (!open.length) blockers.push('no private-equity holding registered against a private-placement bond (action=register)');
    for (const h of open) {
      if (h.status === 'registered') blockers.push(`${h.holdingId}: not evaluated (action=evaluate)`);
      else if (h.status === 'blocked') blockers.push(`${h.holdingId}: ${h.evaluation.failing.join(', ')}`);
    }
    const warnings = [];
    if (!s.collateralOs.ready) warnings.push(`Collateral OS not ready to draw against eligible holdings: ${s.collateralOs.issues.join('; ')}`);
    const ready = blockers.length === 0;
    return { ready, mode: ready ? 'live' : 'shadow', blockers, warnings, status: s };
  },

  async process({ action, actor = null, ...body } = {}) {
    switch (action) {
      case 'register': return this.register({ ...body, actor });
      case 'register_intra_trust': return this.registerIntraTrust({ ...body, actor });
      case 'propose_receipt': return this.proposeReceipt({ ...body, actor });
      case 'countersign': return this.countersign({ ...body, actor });
      case 'evaluate': return this.evaluate({ ...body, actor });
      case 'retire': return this.retire({ ...body, actor });
      case 'verify_chain': return this.verifyChain();
      default:
        throw new PrivateEquityHoldingsError(
          `unknown action "${action}" (register, register_intra_trust, propose_receipt, countersign, evaluate, retire, verify_chain)`,
          'PE_HOLDINGS_UNKNOWN_ACTION', 400
        );
    }
  },
};

module.exports = {
  PrivateEquityHoldingsOsEngine,
  PrivateEquityHoldingsError,
  getPrivateEquityHoldingsConfig,
  CUSTODY_ASSET_CLASS,
  STATUSES,
};
