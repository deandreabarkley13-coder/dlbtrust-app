'use strict';

/**
 * Collateral OS — spendable value out of the tokenized RWA without selling it.
 *
 * A bond token (BondTokenizationEngine) held in trust custody is a claim on a
 * bond, not cash. This engine turns that claim into a governed borrowing base:
 *
 *   pledge     A token position held by the custody wallet is registered as
 *              collateral. The on-chain balance is read through the thirdweb
 *              server wallet API; the USD value comes from the thirdweb price
 *              oracle (pinned prices for trust-issued tokens, par as a last
 *              resort). Pledging is off-balance-sheet: no GL entry.
 *
 *   facility   collateral value x advance rate (per asset class / token) =
 *              spendable value; minus outstanding draws = available.
 *
 *   draw       Spend against the facility. The USDC is raised from the
 *              Treasury-Core ERP reserve through SpritzTreasuryLegEngine.fund()
 *              (CanonicalMoneyEngine maker/checker proposal) and delivered to
 *              the TrustDistributionPolicy contract on Base. When the request
 *              completes, `reconcile()` books
 *                DR USDC treasury (1210) / CR Collateral facility (2400)
 *              so the draw is a liability secured by the pledge, never a sale.
 *
 *   settle     A funded draw settles to the DB NET MGMT bank through the
 *              Spritz off-ramp (SpritzTreasuryLegEngine.stagePayout), still
 *              under the policy contract's maker/checker + timelock.
 *
 *   repay      Reduces the outstanding draw with the inverse journal.
 *   revalue    Re-prices every pledge; utilization above the margin-call
 *              threshold flags the facility, blocking further draws.
 *   release    Hands a pledge back once the remaining base still covers the
 *              outstanding draws.
 *
 * Every state change is appended to collateral_events.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');
const { getConfig } = require('../dapp/config');
const { BondTokenizationEngine } = require('../dapp/bondTokenizationEngine');
const { ThirdwebPriceOracle } = require('../dapp/thirdwebPriceOracle');
const { ThirdwebServerWalletEngine } = require('../dapp/thirdwebServerWalletEngine');
const { SpritzTreasuryLegEngine } = require('../spritz/spritzTreasuryLegEngine');
const { TrustAllocationEngine } = require('../dapp/trustAllocationEngine');

let TrustAccountingEngine;
try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) { TrustAccountingEngine = null; }

const POSITION_STATUSES = ['pledged', 'margin_call', 'released'];
const DRAW_STATUSES = ['proposed', 'funded', 'settling', 'settled', 'repaid', 'cancelled'];

const DRAW_TRANSITIONS = Object.freeze({
  proposed: new Set(['funded', 'cancelled']),
  funded: new Set(['settling', 'repaid', 'cancelled']),
  settling: new Set(['settled', 'repaid']),
  settled: new Set(['repaid']),
  repaid: new Set([]),
  cancelled: new Set([]),
});

const DEFAULT_ADVANCE_RATES_BPS = Object.freeze({
  bond_token: 7000,
  fixed_income: 7000,
  stablecoin: 9500,
  equity: 5000,
});

class CollateralError extends Error {
  constructor(message, code = 'COLLATERAL_ERROR', status = 409, details = {}) {
    super(message);
    this.name = 'CollateralError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
    this.details = details;
  }
}

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function envNum(name, def) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : def; }
function bool(name, def) { const v = str(name); return v ? v.toLowerCase() === 'true' : def; }

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function usd(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new CollateralError(`${field} must be a positive USD amount`, 'COLLATERAL_INVALID', 400);
  return Math.round(n * 100) / 100;
}

function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }

function unitsToAmount(units, decimals) {
  const n = BigInt(String(units || '0'));
  const scale = 10n ** BigInt(decimals);
  return Number(n / scale) + Number(n % scale) / Number(scale);
}

function amountToUnits(amount, decimals) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new CollateralError('quantity must be positive', 'COLLATERAL_INVALID', 400);
  return BigInt(Math.round(n * 10 ** Math.min(decimals, 15))) * 10n ** BigInt(Math.max(decimals - 15, 0));
}

function bps(n) { return Math.round(Number(n)); }

/** Advance rate for a position: per-token override, then per-asset-class, then default. */
function advanceRateFor({ assetClass, tokenSymbol, override }) {
  if (override !== undefined && override !== null && override !== '') {
    const n = Number(override);
    if (!Number.isInteger(n) || n < 0 || n > 10000) throw new CollateralError('advanceRateBps must be an integer 0..10000', 'COLLATERAL_INVALID', 400);
    return n;
  }
  const perToken = str('COLLATERAL_ADVANCE_RATES_BPS')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((pair) => pair.split(':'))
    .find(([key]) => key && tokenSymbol && key.toUpperCase() === String(tokenSymbol).toUpperCase());
  if (perToken && Number.isFinite(Number(perToken[1]))) return bps(perToken[1]);
  const byClass = envNum(`COLLATERAL_ADVANCE_RATE_${String(assetClass || '').toUpperCase()}_BPS`, NaN);
  if (Number.isFinite(byClass)) return bps(byClass);
  return DEFAULT_ADVANCE_RATES_BPS[assetClass] || envNum('COLLATERAL_DEFAULT_ADVANCE_RATE_BPS', 7000);
}

/**
 * Pure facility maths. `positions` are mapped rows; `draws` are mapped rows
 * whose outstandingUsd counts against the base.
 */
function facilityMath(positions, draws, maxUtilizationBps) {
  const active = positions.filter((p) => p.status !== 'released');
  const collateralUsd = round2(active.reduce((s, p) => s + Number(p.valueUsd || 0), 0));
  const spendableUsd = round2(active.reduce((s, p) => s + Number(p.valueUsd || 0) * Number(p.advanceRateBps || 0) / 10000, 0));
  const drawnUsd = round2(draws.filter((d) => !['repaid', 'cancelled'].includes(d.status)).reduce((s, d) => s + Number(d.outstandingUsd || 0), 0));
  const availableUsd = round2(Math.max(spendableUsd - drawnUsd, 0));
  const utilizationBps = spendableUsd > 0 ? Math.round(drawnUsd / spendableUsd * 10000) : (drawnUsd > 0 ? 10000 : 0);
  return {
    positions: active.length,
    collateralUsd,
    spendableUsd,
    drawnUsd,
    availableUsd,
    utilizationBps,
    maxUtilizationBps,
    marginCall: drawnUsd > 0 && utilizationBps > maxUtilizationBps,
  };
}

function mapPosition(r) {
  if (!r) return null;
  return {
    positionId: r.position_id, tokenId: r.token_id, tokenSymbol: r.token_symbol, tokenAddress: r.token_address,
    chainId: Number(r.chain_id), decimals: Number(r.decimals), quantityUnits: String(r.quantity_units),
    quantity: unitsToAmount(r.quantity_units, Number(r.decimals)),
    custodyWallet: r.custody_wallet, verification: r.verification, assetClass: r.asset_class,
    advanceRateBps: Number(r.advance_rate_bps), priceUsd: Number(r.price_usd), priceSource: r.price_source,
    valueUsd: Number(r.value_usd), spendableUsd: round2(Number(r.value_usd) * Number(r.advance_rate_bps) / 10000),
    status: r.status, reference: r.reference, pledgedBy: r.pledged_by, metadata: parseJson(r.metadata, {}),
    valuedAt: r.valued_at, releasedAt: r.released_at, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function mapDraw(r) {
  if (!r) return null;
  return {
    drawId: r.draw_id, positionId: r.position_id, amountUsd: Number(r.amount_usd), outstandingUsd: Number(r.outstanding_usd),
    status: r.status, reference: r.reference, bucket: r.bucket, destination: r.destination,
    requestId: r.request_id, proposalId: r.proposal_id, spritzQuoteId: r.spritz_quote_id, distributionId: r.distribution_id,
    journalEntryId: r.journal_entry_id, createdBy: r.created_by, metadata: parseJson(r.metadata, {}),
    fundedAt: r.funded_at, settledAt: r.settled_at, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function assertTransition(from, to) {
  const allowed = DRAW_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) throw new CollateralError(`draw cannot move from ${from} to ${to}`, 'COLLATERAL_STATE', 409, { from, to });
}

async function existingEntry(referenceType, referenceId) {
  try {
    const rows = await pool.query(
      `SELECT entry_id FROM trust_journal_entries WHERE reference_type = $1 AND reference_id = $2 AND status = 'posted' LIMIT 1`,
      [referenceType, String(referenceId)]
    );
    return rows.rows[0] ? rows.rows[0].entry_id : null;
  } catch (e) {
    return null;
  }
}

async function book({ referenceType, referenceId, description, lines, postedBy }) {
  if (!bool('COLLATERAL_GL_BOOKING_ENABLED', true)) return { status: 'booking_disabled', booked: false };
  if (!TrustAccountingEngine) return { status: 'accounting_unavailable', booked: false };
  const already = await existingEntry(referenceType, referenceId);
  if (already) return { status: 'already_booked', booked: true, entryId: already };
  try {
    const entry = await TrustAccountingEngine.postJournalEntry({
      entryDate: new Date().toISOString().slice(0, 10),
      description,
      lines,
      referenceType,
      referenceId: String(referenceId),
      postedBy: postedBy || 'collateral-os',
      postToFineract: false,
    });
    return { status: 'booked', booked: true, entryId: entry.entry_id || entry.entryId || null };
  } catch (e) {
    return { status: 'error', booked: false, error: e.message };
  }
}

const CollateralOsEngine = {
  CollateralError,
  POSITION_STATUSES,
  DRAW_STATUSES,
  DRAW_TRANSITIONS,
  facilityMath,
  advanceRateFor,

  config() {
    const dapp = getConfig();
    const leg = SpritzTreasuryLegEngine.config();
    return {
      enabled: bool('COLLATERAL_OS_ENABLED', true),
      chainId: Number(str('COLLATERAL_CHAIN_ID') || leg.chainId || dapp.chainId),
      custodyWallet: str('COLLATERAL_CUSTODY_WALLET') || null,
      requireVerifiedBalance: bool('COLLATERAL_REQUIRE_VERIFIED_BALANCE', false),
      parFallback: bool('COLLATERAL_PAR_FALLBACK', true),
      maxUtilizationBps: envNum('COLLATERAL_MAX_UTILIZATION_BPS', 9000),
      defaultAdvanceRateBps: envNum('COLLATERAL_DEFAULT_ADVANCE_RATE_BPS', 7000),
      advanceRates: { ...DEFAULT_ADVANCE_RATES_BPS },
      destination: leg.policyAddress,
      settlementBankMatch: leg.settlementBankMatch,
      gl: {
        treasuryAccount: str('COLLATERAL_TREASURY_GL_ACCOUNT', leg.gl.treasuryAccount),
        facilityAccount: str('COLLATERAL_FACILITY_GL_ACCOUNT', '2400'),
        bookingEnabled: bool('COLLATERAL_GL_BOOKING_ENABLED', true),
      },
    };
  },

  async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS collateral_positions (
        position_id      TEXT PRIMARY KEY,
        token_id         TEXT,
        token_symbol     TEXT,
        token_address    TEXT NOT NULL,
        chain_id         INTEGER NOT NULL,
        decimals         INTEGER NOT NULL DEFAULT 6,
        quantity_units   NUMERIC(78,0) NOT NULL,
        custody_wallet   TEXT,
        verification     TEXT NOT NULL DEFAULT 'unverified',
        asset_class      TEXT NOT NULL DEFAULT 'bond_token',
        advance_rate_bps INTEGER NOT NULL,
        price_usd        NUMERIC(24,8) NOT NULL DEFAULT 0,
        price_source     TEXT,
        value_usd        NUMERIC(20,2) NOT NULL DEFAULT 0,
        status           TEXT NOT NULL DEFAULT 'pledged',
        reference        TEXT,
        pledged_by       TEXT,
        metadata         JSONB DEFAULT '{}'::jsonb,
        valued_at        TIMESTAMPTZ DEFAULT NOW(),
        released_at      TIMESTAMPTZ,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_collateral_positions_status ON collateral_positions(status)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS collateral_draws (
        draw_id          TEXT PRIMARY KEY,
        position_id      TEXT,
        amount_usd       NUMERIC(20,2) NOT NULL,
        outstanding_usd  NUMERIC(20,2) NOT NULL,
        status           TEXT NOT NULL DEFAULT 'proposed',
        reference        TEXT UNIQUE,
        bucket           TEXT,
        destination      TEXT,
        request_id       TEXT,
        proposal_id      TEXT,
        spritz_quote_id  TEXT,
        distribution_id  TEXT,
        journal_entry_id TEXT,
        created_by       TEXT,
        metadata         JSONB DEFAULT '{}'::jsonb,
        funded_at        TIMESTAMPTZ,
        settled_at       TIMESTAMPTZ,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_collateral_draws_status ON collateral_draws(status)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS collateral_events (
        event_id   BIGSERIAL PRIMARY KEY,
        subject_id TEXT NOT NULL,
        kind       TEXT NOT NULL,
        actor      TEXT,
        payload    JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_collateral_events_subject ON collateral_events(subject_id)`);
  },

  async _event(subjectId, kind, actor, payload = {}) {
    await pool.query(
      `INSERT INTO collateral_events (subject_id, kind, actor, payload) VALUES ($1, $2, $3, $4::jsonb)`,
      [subjectId, kind, actor || null, JSON.stringify(payload)]
    );
  },

  async events({ subjectId = null, limit = 100 } = {}) {
    await this.ensureTables();
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const res = subjectId
      ? await pool.query(`SELECT * FROM collateral_events WHERE subject_id = $1 ORDER BY event_id DESC LIMIT ${n}`, [subjectId])
      : await pool.query(`SELECT * FROM collateral_events ORDER BY event_id DESC LIMIT ${n}`);
    return res.rows.map((r) => ({ eventId: Number(r.event_id), subjectId: r.subject_id, kind: r.kind, actor: r.actor, payload: parseJson(r.payload, {}), createdAt: r.created_at }));
  },

  /** What the engine can do right now, without moving anything. */
  async readiness() {
    const cfg = this.config();
    const issues = [];
    if (!cfg.enabled) issues.push('COLLATERAL_OS_ENABLED=false');
    if (!cfg.destination) issues.push('TRUST_POLICY_ADDRESS not configured (draw destination)');
    const oracle = ThirdwebPriceOracle.readiness();
    if (!oracle.ready && !cfg.parFallback) issues.push(...oracle.issues.map((i) => `price oracle: ${i}`));
    const wallet = ThirdwebServerWalletEngine.readiness();
    let custodyWallet = cfg.custodyWallet;
    if (!custodyWallet) {
      if (wallet.ready) {
        try { custodyWallet = await ThirdwebServerWalletEngine.resolveAddress(); } catch (e) { issues.push(`custody wallet: ${e.message}`); }
      } else {
        custodyWallet = BondTokenizationEngine.operatorAddress();
        if (!custodyWallet) issues.push('COLLATERAL_CUSTODY_WALLET not configured and no thirdweb server wallet / operator address');
      }
    }
    if (cfg.requireVerifiedBalance && !wallet.ready) issues.push('COLLATERAL_REQUIRE_VERIFIED_BALANCE=true but thirdweb server wallet is not ready to read balances');
    let leg = null;
    try { leg = await SpritzTreasuryLegEngine.readiness(); } catch (e) { leg = { ready: false, issues: [e.message] }; }
    if (!leg.ready) issues.push(...(leg.issues || []).map((i) => `treasury leg: ${i}`));
    return {
      provider: 'collateral-os',
      ready: issues.length === 0,
      issues,
      chainId: cfg.chainId,
      custodyWallet: custodyWallet || null,
      destination: cfg.destination,
      priceOracle: { ready: oracle.ready, parFallback: cfg.parFallback },
      balanceVerification: { available: wallet.ready, required: cfg.requireVerifiedBalance },
      treasuryLeg: leg ? { ready: leg.ready, settlementBank: leg.settlementBank || null, fundingSource: leg.fundingSource || null } : null,
      fundingSources: leg && leg.fundingSources ? leg.fundingSources : null,
      segregation: leg && leg.segregation ? leg.segregation : null,
      advanceRates: cfg.advanceRates,
      maxUtilizationBps: cfg.maxUtilizationBps,
      gl: cfg.gl,
    };
  },

  async status() {
    await this.ensureTables();
    const [readiness, facility] = await Promise.all([this.readiness(), this.facility()]);
    return { readiness, facility };
  },

  // ─── Pledge ────────────────────────────────────────────────────────────────

  async _resolveToken({ tokenId, tokenSymbol, tokenAddress }) {
    let token = null;
    if (tokenId) token = await BondTokenizationEngine.getToken(tokenId).catch(() => null);
    if (!token && tokenAddress) token = await BondTokenizationEngine.getTokenByAddress(tokenAddress);
    if (!token && tokenSymbol) token = await BondTokenizationEngine.getTokenBySymbol(tokenSymbol);
    if (!token && tokenAddress) {
      return { id: null, token_symbol: tokenSymbol || null, token_address: tokenAddress, bond_id: null, metadata: {} };
    }
    if (!token) throw new CollateralError('token not found; pass tokenId, tokenSymbol or tokenAddress', 'COLLATERAL_TOKEN_NOT_FOUND', 404);
    if (BondTokenizationEngine.classifyToken(token) === 'shadow') {
      throw new CollateralError(`token ${token.token_symbol} is a shadow record with no on-chain address`, 'COLLATERAL_TOKEN_SHADOW', 409);
    }
    return token;
  },

  async _custodyWallet(explicit) {
    const cfg = this.config();
    if (explicit) return explicit;
    if (cfg.custodyWallet) return cfg.custodyWallet;
    if (ThirdwebServerWalletEngine.readiness().ready) {
      try { return await ThirdwebServerWalletEngine.resolveAddress(); } catch { /* fall through */ }
    }
    const op = BondTokenizationEngine.operatorAddress();
    if (!op) throw new CollateralError('no custody wallet: set COLLATERAL_CUSTODY_WALLET or configure the thirdweb server wallet', 'COLLATERAL_CUSTODY_UNKNOWN', 409);
    return op;
  },

  /** On-chain balance of `tokenAddress` in the custody wallet, or null when it cannot be read. */
  async _heldUnits({ custodyWallet, chainId, tokenAddress }) {
    if (!ThirdwebServerWalletEngine.readiness().ready) return null;
    try {
      const rows = await ThirdwebServerWalletEngine.balance({ address: custodyWallet, chainId, tokenAddress });
      const row = rows.find((r) => String(r.tokenAddress || '').toLowerCase() === String(tokenAddress).toLowerCase()) || rows[0];
      return row ? { units: BigInt(String(row.value || '0')), decimals: Number(row.decimals) } : null;
    } catch {
      return null;
    }
  },

  async _price({ chainId, tokenAddress, decimals, token }) {
    const cfg = this.config();
    try {
      const quote = await ThirdwebPriceOracle.getPrice({ chainId, tokenAddress });
      return { priceUsd: quote.priceUsd, decimals: Number.isInteger(quote.decimals) ? quote.decimals : decimals, source: quote.source };
    } catch (e) {
      if (!cfg.parFallback) throw new CollateralError(`no USD price for ${tokenAddress}: ${e.message}`, 'COLLATERAL_PRICE_UNAVAILABLE', 422);
      const meta = parseJson(token && token.metadata, {});
      const par = Number(meta.parPriceUsd || meta.par_price_usd || 1);
      return { priceUsd: par > 0 ? par : 1, decimals, source: 'par' };
    }
  },

  /**
   * Register a custody-held token position as collateral.
   * Off-balance-sheet: the bond stays on the books; no GL entry.
   */
  async pledge({ tokenId, tokenSymbol, tokenAddress, quantity, quantityUnits, custodyWallet, assetClass, advanceRateBps, reference, pledgedBy, metadata } = {}) {
    await this.ensureTables();
    const cfg = this.config();
    if (!cfg.enabled) throw new CollateralError('Collateral OS disabled', 'COLLATERAL_DISABLED', 503);
    const token = await this._resolveToken({ tokenId, tokenSymbol, tokenAddress });
    const meta = parseJson(token.metadata, {});
    const chainId = Number(meta.chainId || cfg.chainId);
    let decimals = Number.isInteger(Number(meta.decimals)) ? Number(meta.decimals) : 6;
    const wallet = await this._custodyWallet(custodyWallet);

    const held = await this._heldUnits({ custodyWallet: wallet, chainId, tokenAddress: token.token_address });
    if (held && Number.isInteger(held.decimals)) decimals = held.decimals;

    let units;
    if (quantityUnits !== undefined && quantityUnits !== null && quantityUnits !== '') units = BigInt(String(quantityUnits));
    else if (quantity !== undefined && quantity !== null && quantity !== '') units = amountToUnits(quantity, decimals);
    else if (held) units = held.units;
    else throw new CollateralError('quantity required when the custody balance cannot be read', 'COLLATERAL_INVALID', 400);
    if (units <= 0n) throw new CollateralError('nothing to pledge: quantity is zero', 'COLLATERAL_INVALID', 400);

    let verification = 'unverified';
    if (held) {
      if (held.units < units) {
        throw new CollateralError(`custody wallet ${wallet} holds ${unitsToAmount(held.units, decimals)} ${token.token_symbol || ''}, less than the ${unitsToAmount(units, decimals)} pledged`, 'COLLATERAL_INSUFFICIENT_HOLDING', 409, { held: held.units.toString(), pledged: units.toString() });
      }
      verification = 'verified';
    } else if (cfg.requireVerifiedBalance) {
      throw new CollateralError('custody balance could not be verified on-chain and COLLATERAL_REQUIRE_VERIFIED_BALANCE=true', 'COLLATERAL_UNVERIFIED', 409);
    }

    const klass = assetClass || (token.bond_id ? 'bond_token' : 'fixed_income');
    const rate = advanceRateFor({ assetClass: klass, tokenSymbol: token.token_symbol, override: advanceRateBps });
    const price = await this._price({ chainId, tokenAddress: token.token_address, decimals, token });
    const valueUsd = round2(unitsToAmount(units, price.decimals) * price.priceUsd);

    const positionId = newId('COL');
    const res = await pool.query(
      `INSERT INTO collateral_positions (position_id, token_id, token_symbol, token_address, chain_id, decimals, quantity_units, custody_wallet, verification, asset_class, advance_rate_bps, price_usd, price_source, value_usd, status, reference, pledged_by, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'pledged', $15, $16, $17::jsonb) RETURNING *`,
      [positionId, token.id ? String(token.id) : null, token.token_symbol || null, token.token_address, chainId, price.decimals, units.toString(), wallet, verification, klass, rate, price.priceUsd, price.source, valueUsd, reference || null, pledgedBy || null,
        JSON.stringify({ ...(metadata || {}), bondId: token.bond_id || null })]
    );
    const position = mapPosition(res.rows[0]);
    await this._event(positionId, 'pledged', pledgedBy, { tokenSymbol: position.tokenSymbol, quantityUnits: position.quantityUnits, valueUsd, advanceRateBps: rate, verification });
    return { ...position, glImpact: 'none (off-balance-sheet pledge)' };
  },

  async positions({ status = null, limit = 200 } = {}) {
    await this.ensureTables();
    const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    const res = status
      ? await pool.query(`SELECT * FROM collateral_positions WHERE status = $1 ORDER BY created_at DESC LIMIT ${n}`, [status])
      : await pool.query(`SELECT * FROM collateral_positions ORDER BY created_at DESC LIMIT ${n}`);
    return res.rows.map(mapPosition);
  },

  async position(positionId) {
    await this.ensureTables();
    const res = await pool.query(`SELECT * FROM collateral_positions WHERE position_id = $1`, [positionId]);
    if (!res.rows.length) throw new CollateralError(`position ${positionId} not found`, 'COLLATERAL_NOT_FOUND', 404);
    return mapPosition(res.rows[0]);
  },

  async draws({ status = null, positionId = null, limit = 200 } = {}) {
    await this.ensureTables();
    const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    const where = [];
    const params = [];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (positionId) { params.push(positionId); where.push(`position_id = $${params.length}`); }
    const res = await pool.query(`SELECT * FROM collateral_draws${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ${n}`, params);
    return res.rows.map(mapDraw);
  },

  async getDraw(drawId) {
    await this.ensureTables();
    const res = await pool.query(`SELECT * FROM collateral_draws WHERE draw_id = $1`, [drawId]);
    if (!res.rows.length) throw new CollateralError(`draw ${drawId} not found`, 'COLLATERAL_NOT_FOUND', 404);
    return mapDraw(res.rows[0]);
  },

  // ─── Facility ──────────────────────────────────────────────────────────────

  async facility() {
    await this.ensureTables();
    const cfg = this.config();
    const [positions, draws] = await Promise.all([this.positions({ limit: 1000 }), this.draws({ limit: 1000 })]);
    const math = facilityMath(positions, draws, cfg.maxUtilizationBps);
    return {
      ...math,
      destination: cfg.destination,
      gl: cfg.gl,
      byPosition: positions.filter((p) => p.status !== 'released').map((p) => ({
        positionId: p.positionId, tokenSymbol: p.tokenSymbol, status: p.status, valueUsd: p.valueUsd, advanceRateBps: p.advanceRateBps, spendableUsd: p.spendableUsd,
        drawnUsd: round2(draws.filter((d) => d.positionId === p.positionId && !['repaid', 'cancelled'].includes(d.status)).reduce((s, d) => s + d.outstandingUsd, 0)),
      })),
      openDraws: draws.filter((d) => !['repaid', 'cancelled'].includes(d.status)).length,
    };
  },

  /** Re-price every live pledge; flag or clear the margin call. */
  async revalue({ actor } = {}) {
    await this.ensureTables();
    const cfg = this.config();
    const positions = await this.positions({ limit: 1000 });
    const repriced = [];
    for (const p of positions) {
      if (p.status === 'released') continue;
      const price = await this._price({ chainId: p.chainId, tokenAddress: p.tokenAddress, decimals: p.decimals, token: { metadata: p.metadata } });
      const valueUsd = round2(unitsToAmount(p.quantityUnits, price.decimals) * price.priceUsd);
      await pool.query(
        `UPDATE collateral_positions SET price_usd = $2, price_source = $3, value_usd = $4, valued_at = NOW(), updated_at = NOW() WHERE position_id = $1`,
        [p.positionId, price.priceUsd, price.source, valueUsd]
      );
      repriced.push({ ...p, priceUsd: price.priceUsd, priceSource: price.source, valueUsd, spendableUsd: round2(valueUsd * p.advanceRateBps / 10000), previousValueUsd: p.valueUsd });
    }
    const draws = await this.draws({ limit: 1000 });
    const math = facilityMath(repriced, draws, cfg.maxUtilizationBps);
    const target = math.marginCall ? 'margin_call' : 'pledged';
    for (const p of repriced) {
      if (p.status !== target) {
        await pool.query(`UPDATE collateral_positions SET status = $2, updated_at = NOW() WHERE position_id = $1`, [p.positionId, target]);
        await this._event(p.positionId, target === 'margin_call' ? 'margin_call' : 'margin_call_cleared', actor, { utilizationBps: math.utilizationBps });
        p.status = target;
      }
    }
    await this._event('FACILITY', 'revalued', actor, { collateralUsd: math.collateralUsd, spendableUsd: math.spendableUsd, drawnUsd: math.drawnUsd, utilizationBps: math.utilizationBps, marginCall: math.marginCall });
    return { ...math, positions: repriced.map((p) => ({ positionId: p.positionId, tokenSymbol: p.tokenSymbol, status: p.status, previousValueUsd: p.previousValueUsd, valueUsd: p.valueUsd, priceUsd: p.priceUsd, priceSource: p.priceSource })) };
  },

  // ─── Draw / settle / repay ─────────────────────────────────────────────────

  /**
   * Spend against the facility. Raises the ERP -> USDC -> policy contract
   * funding proposal; nothing moves until the checker approves.
   */
  async draw({ amountUsd, positionId, bucket, sourceType, sourceAccountId, sourceToken, sourceModule, reference, createdBy, autoApprove = false, metadata } = {}) {
    await this.ensureTables();
    const cfg = this.config();
    if (!cfg.enabled) throw new CollateralError('Collateral OS disabled', 'COLLATERAL_DISABLED', 503);
    const amount = usd(amountUsd, 'amountUsd');
    if (!reference) throw new CollateralError('reference required (ERP reference)', 'COLLATERAL_INVALID', 400);
    const segregated = TrustAllocationEngine.assertFundingSource({ bucket, sourceType, sourceAccountId, sourceToken, sourceModule });
    if (!segregated.bucket) throw new CollateralError('bucket required: coupon_income (beneficiary support from DLB-PRB coupons) or trust_operating (trustee operating from the treasury module); the two are never mixed', 'ALLOCATION_BUCKET_REQUIRED', 400);
    bucket = segregated.bucket.key;

    const dup = await pool.query(`SELECT * FROM collateral_draws WHERE reference = $1`, [reference]);
    if (dup.rows.length) {
      const prior = mapDraw(dup.rows[0]);
      if (prior.bucket && prior.bucket !== bucket) throw new CollateralError(`reference ${reference} already drawn in ${prior.bucket}`, 'ALLOCATION_REFERENCE_CONFLICT', 409);
      return { ...prior, idempotent: true };
    }

    const facility = await this.facility();
    if (facility.marginCall) throw new CollateralError(`facility is in margin call (utilization ${facility.utilizationBps} bps > ${facility.maxUtilizationBps}); repay or pledge more before drawing`, 'COLLATERAL_MARGIN_CALL', 409, facility);
    if (amount > facility.availableUsd) {
      throw new CollateralError(`draw ${amount.toFixed(2)} exceeds available spendable value ${facility.availableUsd.toFixed(2)}`, 'COLLATERAL_INSUFFICIENT', 409, { availableUsd: facility.availableUsd, spendableUsd: facility.spendableUsd, drawnUsd: facility.drawnUsd });
    }
    if (positionId) {
      const p = facility.byPosition.find((x) => x.positionId === positionId);
      if (!p) throw new CollateralError(`position ${positionId} is not a live pledge`, 'COLLATERAL_NOT_FOUND', 404);
      const room = round2(p.spendableUsd - p.drawnUsd);
      if (amount > room) throw new CollateralError(`draw ${amount.toFixed(2)} exceeds position ${positionId} room ${room.toFixed(2)}`, 'COLLATERAL_INSUFFICIENT', 409, { positionId, roomUsd: room });
    }

    const funding = await SpritzTreasuryLegEngine.fund({ amountUsd: amount, bucket, ...segregated.source, reference, createdBy: createdBy || 'collateral-os', autoApprove });

    const drawId = newId('CDR');
    const res = await pool.query(
      `INSERT INTO collateral_draws (draw_id, position_id, amount_usd, outstanding_usd, status, reference, bucket, destination, request_id, proposal_id, created_by, metadata)
       VALUES ($1, $2, $3, $3, 'proposed', $4, $5, $6, $7, $8, $9, $10::jsonb) RETURNING *`,
      [drawId, positionId || null, amount, reference, bucket, funding.destination || cfg.destination, funding.requestId ? String(funding.requestId) : null, funding.proposalId ? String(funding.proposalId) : null, createdBy || null,
        JSON.stringify({ ...(metadata || {}), source: funding.source || null, route: funding.route || null })]
    );
    const row = mapDraw(res.rows[0]);
    await this._event(drawId, 'draw_proposed', createdBy, { amountUsd: amount, bucket, source: funding.source || null, positionId: positionId || null, requestId: row.requestId, proposalId: row.proposalId, availableBefore: facility.availableUsd });
    return {
      ...row,
      funding,
      facility: { availableUsd: round2(facility.availableUsd - amount), spendableUsd: facility.spendableUsd, utilizationBps: facilityMath([], [{ status: 'proposed', outstandingUsd: facility.drawnUsd + amount }], cfg.maxUtilizationBps).utilizationBps },
      next: 'checker approves the canonical_money proposal; then reconcile() books DR USDC treasury / CR collateral facility and marks the draw funded.',
    };
  },

  /**
   * Draws whose ERP request completed become `funded` and are journaled once:
   *   DR USDC treasury (policy contract) / CR Collateral facility (liability).
   * When the request ran the Treasury-Core `erp_treasury` route the ERP cash
   * account was already credited and USDC treasury debited by
   * CanonicalFundingSource, so the facility entry instead restores that cash:
   *   DR bucket ERP cash / CR Collateral facility — net effect identical.
   */
  async reconcile({ postedBy } = {}) {
    await this.ensureTables();
    const cfg = this.config();
    const proposed = await this.draws({ status: 'proposed', limit: 1000 });
    const results = [];
    for (const d of proposed) {
      if (!d.requestId) { results.push({ drawId: d.drawId, status: d.status, note: 'no ERP request id' }); continue; }
      let request = null;
      try {
        const r = await pool.query(`SELECT id, status, amount, route FROM canonical_money_requests WHERE id = $1`, [d.requestId]);
        request = r.rows[0] || null;
      } catch { request = null; }
      if (!request) { results.push({ drawId: d.drawId, status: d.status, requestId: d.requestId, note: 'ERP request not found' }); continue; }
      if (request.status === 'failed' || request.status === 'rejected') {
        await pool.query(`UPDATE collateral_draws SET status = 'cancelled', outstanding_usd = 0, updated_at = NOW() WHERE draw_id = $1`, [d.drawId]);
        await this._event(d.drawId, 'draw_cancelled', postedBy, { requestId: d.requestId, requestStatus: request.status });
        results.push({ drawId: d.drawId, status: 'cancelled', requestId: d.requestId, requestStatus: request.status });
        continue;
      }
      if (request.status !== 'completed') { results.push({ drawId: d.drawId, status: d.status, requestId: d.requestId, requestStatus: request.status }); continue; }
      const route = typeof request.route === 'string' ? JSON.parse(request.route || '{}') : (request.route || {});
      const erpCash = route.action === 'erp_treasury' && route.glAccounts ? route.glAccounts.cash : null;
      const journal = await book({
        referenceType: 'collateral_draw',
        referenceId: d.drawId,
        description: `Collateral draw ${d.amountUsd.toFixed(2)} USDC to policy contract ${d.destination} secured by ${d.positionId || 'facility'} [${d.reference}]`,
        lines: [
          erpCash
            ? { accountCode: erpCash, debitAmount: d.amountUsd, creditAmount: 0, description: `Restore ${d.bucket} ERP cash ${erpCash} advanced to policy contract ${d.destination} (facility-financed)` }
            : { accountCode: cfg.gl.treasuryAccount, debitAmount: d.amountUsd, creditAmount: 0, description: `USDC to policy contract ${d.destination}` },
          { accountCode: cfg.gl.facilityAccount, debitAmount: 0, creditAmount: d.amountUsd, description: `Collateralized facility draw ${d.drawId}` },
        ],
        postedBy,
      });
      assertTransition(d.status, 'funded');
      await pool.query(`UPDATE collateral_draws SET status = 'funded', journal_entry_id = $2, funded_at = NOW(), updated_at = NOW() WHERE draw_id = $1`, [d.drawId, journal.entryId || null]);
      await this._event(d.drawId, 'draw_funded', postedBy, { requestId: d.requestId, journal });
      results.push({ drawId: d.drawId, status: 'funded', requestId: d.requestId, journal });
    }
    const facility = await this.facility();
    return { reconciled: results.length, draws: results, facility };
  },

  /** Settle a funded draw to the DB NET MGMT bank through the Spritz off-ramp. */
  async settle({ drawId, purpose, rail, memo, payoutWallet, actor } = {}) {
    await this.ensureTables();
    const d = await this.getDraw(drawId);
    assertTransition(d.status, 'settling');
    if (!d.bucket) throw new CollateralError(`draw ${drawId} has no allocation bucket; cannot settle without knowing whether it is coupon_income or trust_operating`, 'ALLOCATION_BUCKET_REQUIRED', 409);
    const allocation = TrustAllocationEngine.bucket(d.bucket);
    const settlePurpose = purpose || allocation.purposes[0];
    if (!allocation.purposes.includes(settlePurpose)) throw new CollateralError(`purpose ${settlePurpose} is not payable from ${d.bucket} (allowed: ${allocation.purposes.join(', ')})`, 'ALLOCATION_PURPOSE_MISMATCH', 409);
    const payout = await SpritzTreasuryLegEngine.stagePayout({ amountUsd: d.outstandingUsd, purpose: settlePurpose, reference: `${d.reference}:SETTLE`, rail, memo: memo || d.reference, payoutWallet, bucket: d.bucket });
    await pool.query(
      `UPDATE collateral_draws SET status = 'settling', spritz_quote_id = $2, distribution_id = $3, updated_at = NOW() WHERE draw_id = $1`,
      [drawId, payout.spritzQuoteId || null, payout.distribution && (payout.distribution.distributionId || payout.distribution.id) ? String(payout.distribution.distributionId || payout.distribution.id) : null]
    );
    await this._event(drawId, 'draw_settling', actor, { spritzQuoteId: payout.spritzQuoteId, settlementBank: payout.settlementBank, amountUsd: payout.amountUsd });
    return { ...(await this.getDraw(drawId)), payout, next: 'checker approves the distribution; after the release delay call executeSettlement({ drawId }).' };
  },

  /** Release the approved distribution and execute the Spritz off-ramp. */
  async executeSettlement({ drawId, actor } = {}) {
    await this.ensureTables();
    const d = await this.getDraw(drawId);
    assertTransition(d.status, 'settled');
    if (!d.distributionId || !d.spritzQuoteId) throw new CollateralError('draw has no staged distribution / Spritz quote; call settle() first', 'COLLATERAL_STATE', 409);
    const out = await SpritzTreasuryLegEngine.executePayout({ distributionId: d.distributionId, spritzQuoteId: d.spritzQuoteId, reference: `${d.reference}:SETTLE`, amountUsd: d.outstandingUsd, createdBy: actor });
    await pool.query(`UPDATE collateral_draws SET status = 'settled', settled_at = NOW(), updated_at = NOW() WHERE draw_id = $1`, [drawId]);
    await this._event(drawId, 'draw_settled', actor, { txHash: out.txHash, amountUsd: out.amountUsd, feeUsd: out.feeUsd });
    return { ...(await this.getDraw(drawId)), settlement: out };
  },

  /** Reduce the outstanding draw: DR Collateral facility / CR USDC treasury. */
  async repay({ drawId, amountUsd, actor, reference } = {}) {
    await this.ensureTables();
    const cfg = this.config();
    const d = await this.getDraw(drawId);
    if (['proposed', 'cancelled', 'repaid'].includes(d.status)) throw new CollateralError(`draw ${drawId} is ${d.status}; nothing to repay`, 'COLLATERAL_STATE', 409);
    const amount = amountUsd === undefined || amountUsd === null ? d.outstandingUsd : usd(amountUsd, 'amountUsd');
    if (amount > d.outstandingUsd + 0.005) throw new CollateralError(`repayment ${amount.toFixed(2)} exceeds outstanding ${d.outstandingUsd.toFixed(2)}`, 'COLLATERAL_INVALID', 400);
    const remaining = round2(d.outstandingUsd - amount);
    const ref = reference || `${drawId}:REPAY:${Date.now().toString(36).toUpperCase()}`;
    const journal = await book({
      referenceType: 'collateral_repayment',
      referenceId: ref,
      description: `Collateral draw ${drawId} repaid ${amount.toFixed(2)} [${d.reference}]`,
      lines: [
        { accountCode: cfg.gl.facilityAccount, debitAmount: amount, creditAmount: 0, description: `Collateralized facility repayment ${drawId}` },
        { accountCode: cfg.gl.treasuryAccount, debitAmount: 0, creditAmount: amount, description: 'USDC treasury applied to repayment' },
      ],
      postedBy: actor,
    });
    const status = remaining <= 0 ? 'repaid' : d.status;
    if (status !== d.status) assertTransition(d.status, status);
    await pool.query(`UPDATE collateral_draws SET outstanding_usd = $2, status = $3, updated_at = NOW() WHERE draw_id = $1`, [drawId, remaining, status]);
    await this._event(drawId, remaining <= 0 ? 'draw_repaid' : 'draw_partially_repaid', actor, { amountUsd: amount, remainingUsd: remaining, journal });
    return { ...(await this.getDraw(drawId)), repaidUsd: amount, journal, facility: await this.facility() };
  },

  /** Hand a pledge back once the remaining base still covers what is drawn. */
  async release({ positionId, actor, reason } = {}) {
    await this.ensureTables();
    const cfg = this.config();
    const p = await this.position(positionId);
    if (p.status === 'released') throw new CollateralError(`position ${positionId} already released`, 'COLLATERAL_STATE', 409);
    const [positions, draws] = await Promise.all([this.positions({ limit: 1000 }), this.draws({ limit: 1000 })]);
    const pinned = draws.filter((d) => d.positionId === positionId && !['repaid', 'cancelled'].includes(d.status));
    if (pinned.length) throw new CollateralError(`position ${positionId} secures ${pinned.length} open draw(s); repay them first`, 'COLLATERAL_ENCUMBERED', 409, { draws: pinned.map((d) => d.drawId) });
    const after = facilityMath(positions.filter((x) => x.positionId !== positionId), draws, cfg.maxUtilizationBps);
    if (after.drawnUsd > after.spendableUsd) {
      throw new CollateralError(`releasing ${positionId} leaves ${after.drawnUsd.toFixed(2)} drawn against ${after.spendableUsd.toFixed(2)} spendable`, 'COLLATERAL_INSUFFICIENT', 409, after);
    }
    await pool.query(`UPDATE collateral_positions SET status = 'released', released_at = NOW(), updated_at = NOW() WHERE position_id = $1`, [positionId]);
    await this._event(positionId, 'released', actor, { reason: reason || null, facilityAfter: after });
    return { ...(await this.position(positionId)), facility: after };
  },
};

module.exports = { CollateralOsEngine, CollateralError, facilityMath, advanceRateFor, DEFAULT_ADVANCE_RATES_BPS, DRAW_TRANSITIONS };
