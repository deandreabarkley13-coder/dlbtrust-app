'use strict';

/**
 * CollateralOsEngine — turns tokenized RWA held by the trust into spendable
 * value without selling it.
 *
 *   pledge   a module / bond token on Base (DLB-PRB, DLB-TREASURY, ...) held by
 *            the custody wallet is registered as collateral. The holding is read
 *            back from chain through the thirdweb wallet API and valued in USD
 *            by ThirdwebPriceOracle (pinned issuer price or market).
 *   facility spendable value = Σ collateral value × advance rate − outstanding
 *            draws. Utilisation above COLLATERAL_MARGIN_CALL_BPS flags a margin
 *            call; nothing new can be drawn until collateral is added or a draw
 *            is repaid.
 *   draw     borrows spendable value: the Treasury-Core ERP converts the
 *            collateral-backed reserve into USDC delivered to the
 *            TrustDistributionPolicy contract (SpritzTreasuryLegEngine.fund,
 *            maker/checker consensus). Once the ERP request completes the draw
 *            is booked Dr USDC treasury / Cr collateral facility liability.
 *   settle   pays a drawn amount out to the settlement bank through the Spritz
 *            off-ramp (SpritzTreasuryLegEngine.stagePayout / executePayout).
 *   repay    retires facility debt: Dr facility liability / Cr USDC treasury,
 *            restoring spendable value.
 *   release  removes a position when the remaining collateral still covers what
 *            has been drawn.
 *
 * Pledging is off-balance-sheet (a memo register); only draws and repayments
 * hit the trust GL. Every journal is keyed by draw id so replays never
 * double-book.
 */

const crypto = require('crypto');

const { ThirdwebPriceOracle } = require('../dapp/thirdwebPriceOracle');
const { ThirdwebServerWalletEngine } = require('../dapp/thirdwebServerWalletEngine');
const { MODULES } = require('../dapp/moduleSmartAccountEngine');
const { getConfig } = require('../dapp/config');
const { SpritzTreasuryLegEngine } = require('../spritz/spritzTreasuryLegEngine');

let BondTokenizationEngine;
try { ({ BondTokenizationEngine } = require('../dapp/bondTokenizationEngine')); } catch (e) { BondTokenizationEngine = null; }
let TrustAccountingEngine;
try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) { TrustAccountingEngine = null; }
let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const POSITIONS = 'collateral_positions';
const DRAWS = 'collateral_draws';
const EVENTS = 'collateral_events';

const OPEN_DRAW_STATUSES = ['proposed', 'funded', 'settling', 'settled'];

const memory = { positions: new Map(), draws: new Map(), events: [] };
let tableReady = false;

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function num(v, def = 0) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function lower(a) { return String(a || '').toLowerCase(); }
function usd(n) { return +Number(n || 0).toFixed(2); }
function newId(prefix) { return `${prefix}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`; }

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

function unitsToAmount(units, decimals) {
  const n = BigInt(String(units || '0'));
  const scale = 10n ** BigInt(decimals);
  return Number(n / scale) + Number(n % scale) / Number(scale);
}

function amountToUnits(amount, decimals) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) throw httpError(400, 'quantity must be a non-negative number');
  return BigInt(Math.round(n * 10 ** Math.min(decimals, 15))) * 10n ** BigInt(Math.max(decimals - 15, 0));
}

/** Per-token advance rates: COLLATERAL_ADVANCE_RATES="0xaddr:bps,DLB-PRB:bps". */
function advanceRateOverrides() {
  const out = new Map();
  for (const entry of str('COLLATERAL_ADVANCE_RATES').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [key, bps] = entry.split(':');
    const n = Number(bps);
    if (key && Number.isInteger(n) && n >= 0 && n <= 10000) out.set(lower(key), n);
  }
  return out;
}

function moduleForToken({ tokenAddress, symbol }) {
  for (const [key, mod] of Object.entries(MODULES)) {
    const envName = `${mod.tokenSymbol.replace(/-/g, '_')}_TOKEN_ADDRESS`;
    if (tokenAddress && lower(str(envName)) === lower(tokenAddress)) return { key, ...mod };
    if (symbol && lower(mod.tokenSymbol) === lower(symbol)) return { key, ...mod };
  }
  return null;
}

async function ensureTables() {
  if (tableReady || !pool || !pool.query) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${POSITIONS} (
      id               TEXT PRIMARY KEY,
      token_address    TEXT NOT NULL,
      chain_id         INTEGER NOT NULL,
      symbol           TEXT,
      decimals         INTEGER NOT NULL DEFAULT 6,
      source_module    TEXT,
      custody_wallet   TEXT NOT NULL,
      quantity_units   TEXT NOT NULL,
      held_units       TEXT,
      price_usd        NUMERIC(24,8),
      price_source     TEXT,
      value_usd        NUMERIC(18,2) NOT NULL DEFAULT 0,
      advance_rate_bps INTEGER NOT NULL,
      status           TEXT NOT NULL DEFAULT 'active',
      pledged_by       TEXT,
      valued_at        TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${DRAWS} (
      id               TEXT PRIMARY KEY,
      reference        TEXT NOT NULL UNIQUE,
      position_id      TEXT REFERENCES ${POSITIONS}(id),
      amount_usd       NUMERIC(18,2) NOT NULL,
      repaid_usd       NUMERIC(18,2) NOT NULL DEFAULT 0,
      purpose          TEXT,
      bucket           TEXT,
      status           TEXT NOT NULL DEFAULT 'proposed',
      erp_request_id   TEXT,
      erp_proposal_id  TEXT,
      distribution_id  TEXT,
      spritz_quote_id  TEXT,
      journal_entry_id TEXT,
      created_by       TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${EVENTS} (
      id          BIGSERIAL PRIMARY KEY,
      subject_id  TEXT NOT NULL,
      kind        TEXT NOT NULL,
      actor       TEXT,
      payload     JSONB NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_${DRAWS}_status ON ${DRAWS}(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_${EVENTS}_subject ON ${EVENTS}(subject_id)`);
  tableReady = true;
}

function rowToPosition(r) {
  if (!r) return null;
  return {
    id: r.id,
    tokenAddress: r.token_address,
    chainId: Number(r.chain_id),
    symbol: r.symbol || null,
    decimals: Number(r.decimals),
    sourceModule: r.source_module || null,
    custodyWallet: r.custody_wallet,
    quantityUnits: String(r.quantity_units),
    quantity: unitsToAmount(r.quantity_units, Number(r.decimals)),
    heldUnits: r.held_units === null || r.held_units === undefined ? null : String(r.held_units),
    priceUsd: r.price_usd === null || r.price_usd === undefined ? null : Number(r.price_usd),
    priceSource: r.price_source || null,
    valueUsd: usd(r.value_usd),
    advanceRateBps: Number(r.advance_rate_bps),
    spendableUsd: usd(Number(r.value_usd) * Number(r.advance_rate_bps) / 10000),
    status: r.status,
    pledgedBy: r.pledged_by || null,
    valuedAt: r.valued_at || null,
    createdAt: r.created_at || null,
    updatedAt: r.updated_at || null,
  };
}

function rowToDraw(r) {
  if (!r) return null;
  const amount = usd(r.amount_usd);
  const repaid = usd(r.repaid_usd);
  return {
    id: r.id,
    reference: r.reference,
    positionId: r.position_id || null,
    amountUsd: amount,
    repaidUsd: repaid,
    outstandingUsd: usd(amount - repaid),
    purpose: r.purpose || null,
    bucket: r.bucket || null,
    status: r.status,
    erpRequestId: r.erp_request_id || null,
    erpProposalId: r.erp_proposal_id || null,
    distributionId: r.distribution_id || null,
    spritzQuoteId: r.spritz_quote_id || null,
    journalEntryId: r.journal_entry_id || null,
    createdBy: r.created_by || null,
    createdAt: r.created_at || null,
    updatedAt: r.updated_at || null,
  };
}

async function existingEntry(referenceType, referenceId) {
  if (!pool || !pool.query || !referenceId) return null;
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
  const gl = CollateralOsEngine.config().gl;
  if (!gl.bookingEnabled) return { status: 'booking_disabled', booked: false };
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

class CollateralOsEngine {
  static config() {
    const dapp = getConfig();
    return {
      enabled: str('COLLATERAL_OS_ENABLED', 'true').toLowerCase() !== 'false',
      chainId: num(str('COLLATERAL_CHAIN_ID'), dapp.chainId),
      custodyWallet: str('COLLATERAL_CUSTODY_WALLET', str('THIRDWEB_SERVER_WALLET_ADDRESS', dapp.operatorAddress || '')),
      defaultAdvanceRateBps: num(str('COLLATERAL_ADVANCE_RATE_BPS'), 7000),
      marginCallBps: num(str('COLLATERAL_MARGIN_CALL_BPS'), 9000),
      maxFacilityUsd: num(str('COLLATERAL_MAX_FACILITY_USD'), 0),
      verifyHoldings: str('COLLATERAL_VERIFY_HOLDINGS', 'true').toLowerCase() !== 'false',
      gl: {
        treasuryAccount: str('COLLATERAL_TREASURY_GL_ACCOUNT', str('SPRITZ_TREASURY_GL_ACCOUNT', '1210')),
        facilityAccount: str('COLLATERAL_FACILITY_GL_ACCOUNT', '2400'),
        bookingEnabled: str('COLLATERAL_GL_BOOKING_ENABLED', 'true').toLowerCase() !== 'false',
      },
    };
  }

  static async ensureTables() { await ensureTables(); }

  static advanceRateFor({ tokenAddress, symbol }) {
    const cfg = this.config();
    const overrides = advanceRateOverrides();
    if (tokenAddress && overrides.has(lower(tokenAddress))) return overrides.get(lower(tokenAddress));
    if (symbol && overrides.has(lower(symbol))) return overrides.get(lower(symbol));
    return cfg.defaultAdvanceRateBps;
  }

  static async readiness() {
    const cfg = this.config();
    const issues = [];
    if (!cfg.enabled) issues.push('COLLATERAL_OS_ENABLED=false');
    if (!cfg.custodyWallet) issues.push('COLLATERAL_CUSTODY_WALLET (or THIRDWEB_SERVER_WALLET_ADDRESS / DAPP_OPERATOR_ADDRESS) not configured');
    if (cfg.defaultAdvanceRateBps <= 0 || cfg.defaultAdvanceRateBps > 10000) issues.push('COLLATERAL_ADVANCE_RATE_BPS must be 1..10000');
    if (cfg.marginCallBps <= 0 || cfg.marginCallBps > 10000) issues.push('COLLATERAL_MARGIN_CALL_BPS must be 1..10000');
    const oracle = ThirdwebPriceOracle.readiness();
    if (!oracle.ready && ThirdwebPriceOracle.listPinned().length === 0) issues.push(...oracle.issues.map((i) => `price oracle: ${i}`));
    const wallet = ThirdwebServerWalletEngine.readiness();
    if (cfg.verifyHoldings && !wallet.ready) issues.push(...(wallet.issues || []).map((i) => `holding verification: ${i}`));
    let spritz = null;
    try { spritz = await SpritzTreasuryLegEngine.readiness(); } catch (e) { spritz = { ready: false, issues: [e.message] }; }
    if (!spritz.ready) issues.push(...spritz.issues.map((i) => `treasury leg: ${i}`));
    const facility = await this.facility().catch((e) => ({ error: e.message }));
    return {
      provider: 'collateral-os',
      ready: issues.length === 0,
      issues,
      chainId: cfg.chainId,
      custodyWallet: cfg.custodyWallet || null,
      advanceRateBps: cfg.defaultAdvanceRateBps,
      marginCallBps: cfg.marginCallBps,
      gl: cfg.gl,
      pricing: { oracle: oracle.ready ? 'thirdweb' : 'pinned-only', pinned: ThirdwebPriceOracle.listPinned().map((p) => ({ chainId: p.chainId, tokenAddress: p.tokenAddress, symbol: p.symbol, priceUsd: p.priceUsd })) },
      treasuryLeg: spritz,
      facility,
    };
  }

  // ─── Pledge / valuation ────────────────────────────────────────────────────

  /** Identify a token: registered bond token, module token, or a bare ERC-20. */
  static async resolveToken({ tokenAddress, symbol, chainId } = {}) {
    const cfg = this.config();
    const chain = num(chainId, cfg.chainId);
    let address = tokenAddress || null;
    let mod = moduleForToken({ tokenAddress: address, symbol });
    if (!address && mod) address = str(`${mod.tokenSymbol.replace(/-/g, '_')}_TOKEN_ADDRESS`) || null;
    let bondToken = null;
    if (BondTokenizationEngine) {
      try {
        if (address) bondToken = await BondTokenizationEngine.getTokenByAddress(address);
        if (!bondToken && symbol) bondToken = await BondTokenizationEngine.getTokenBySymbol(symbol);
      } catch (e) { bondToken = null; }
    }
    if (!address && bondToken) address = bondToken.token_address;
    if (!address) throw httpError(400, 'tokenAddress (or a known module/bond token symbol) required', 'COLLATERAL_TOKEN_REQUIRED');
    if (!mod) mod = moduleForToken({ tokenAddress: address, symbol: bondToken && bondToken.token_symbol });
    const meta = bondToken && bondToken.metadata ? (typeof bondToken.metadata === 'string' ? JSON.parse(bondToken.metadata) : bondToken.metadata) : {};
    return {
      tokenAddress: address,
      chainId: num(meta.chainId, chain),
      symbol: (bondToken && bondToken.token_symbol) || (mod && mod.tokenSymbol) || symbol || null,
      decimals: num(meta.decimals, mod ? mod.decimals : 6),
      sourceModule: mod ? mod.key : null,
      bondId: bondToken ? bondToken.bond_id : null,
      kind: bondToken ? 'bond_token' : (mod ? 'module_token' : 'erc20'),
    };
  }

  /** On-chain units of `tokenAddress` held by the custody wallet, or null when unverifiable. */
  static async heldUnits({ custodyWallet, chainId, tokenAddress }) {
    try {
      const rows = await ThirdwebServerWalletEngine.balance({ address: custodyWallet, chainId, tokenAddress });
      const row = rows.find((r) => lower(r.tokenAddress) === lower(tokenAddress)) || rows[0];
      return row ? BigInt(String(row.value || '0')) : 0n;
    } catch (e) {
      return null;
    }
  }

  static async price({ chainId, tokenAddress, quantityUnits }) {
    const quote = await ThirdwebPriceOracle.quoteUsd({ chainId, tokenAddress, quantity: quantityUnits });
    return { priceUsd: quote.priceUsd, valueUsd: usd(quote.amountUsd), source: quote.source, decimals: quote.decimals, symbol: quote.symbol };
  }

  /** Value a hypothetical pledge without recording anything. */
  static async quotePledge({ tokenAddress, symbol, chainId, quantity, quantityUnits, advanceRateBps } = {}) {
    const token = await this.resolveToken({ tokenAddress, symbol, chainId });
    const units = quantityUnits !== undefined && quantityUnits !== null ? BigInt(String(quantityUnits)) : amountToUnits(quantity, token.decimals);
    if (units <= 0n) throw httpError(400, 'quantity must be positive');
    const rate = advanceRateBps !== undefined && advanceRateBps !== null ? Number(advanceRateBps) : this.advanceRateFor(token);
    if (!Number.isInteger(rate) || rate <= 0 || rate > 10000) throw httpError(400, 'advanceRateBps must be an integer 1..10000');
    const valuation = await this.price({ chainId: token.chainId, tokenAddress: token.tokenAddress, quantityUnits: units.toString() });
    return {
      ...token,
      quantityUnits: units.toString(),
      quantity: unitsToAmount(units, token.decimals),
      priceUsd: valuation.priceUsd,
      priceSource: valuation.source,
      valueUsd: valuation.valueUsd,
      advanceRateBps: rate,
      spendableUsd: usd(valuation.valueUsd * rate / 10000),
    };
  }

  /**
   * Register collateral. The pledged quantity may never exceed what the
   * custody wallet actually holds on chain (when the holding can be read).
   */
  static async pledge({ tokenAddress, symbol, chainId, quantity, quantityUnits, advanceRateBps, custodyWallet, pledgedBy } = {}) {
    const cfg = this.config();
    if (!cfg.enabled) throw httpError(409, 'Collateral OS disabled (COLLATERAL_OS_ENABLED=false)', 'COLLATERAL_OS_DISABLED');
    const wallet = custodyWallet || cfg.custodyWallet;
    if (!wallet) throw httpError(409, 'COLLATERAL_CUSTODY_WALLET not configured', 'COLLATERAL_CUSTODY_WALLET_REQUIRED');
    const quote = await this.quotePledge({ tokenAddress, symbol, chainId, quantity, quantityUnits, advanceRateBps });

    let held = null;
    if (cfg.verifyHoldings) {
      held = await this.heldUnits({ custodyWallet: wallet, chainId: quote.chainId, tokenAddress: quote.tokenAddress });
      if (held === null) throw httpError(503, `cannot read ${quote.symbol || quote.tokenAddress} balance of ${wallet} on chain ${quote.chainId}; set COLLATERAL_VERIFY_HOLDINGS=false to pledge unverified`, 'COLLATERAL_HOLDING_UNVERIFIABLE');
      const pledgedElsewhere = (await this.positions({ status: 'active' }))
        .filter((p) => lower(p.tokenAddress) === lower(quote.tokenAddress) && p.chainId === quote.chainId && lower(p.custodyWallet) === lower(wallet))
        .reduce((s, p) => s + BigInt(p.quantityUnits), 0n);
      if (BigInt(quote.quantityUnits) + pledgedElsewhere > held) {
        throw httpError(409, `custody wallet ${wallet} holds ${held} units of ${quote.symbol || quote.tokenAddress} (${pledgedElsewhere} already pledged); cannot pledge ${quote.quantityUnits}`, 'COLLATERAL_INSUFFICIENT_HOLDING');
      }
    }

    if (cfg.maxFacilityUsd > 0) {
      const facility = await this.facility();
      if (facility.spendableUsd + quote.spendableUsd > cfg.maxFacilityUsd + 1e-9) {
        throw httpError(409, `facility ceiling ${cfg.maxFacilityUsd.toFixed(2)} USD would be exceeded (spendable ${facility.spendableUsd.toFixed(2)} + ${quote.spendableUsd.toFixed(2)})`, 'COLLATERAL_FACILITY_CEILING');
      }
    }

    const position = {
      id: newId('COL'),
      tokenAddress: quote.tokenAddress,
      chainId: quote.chainId,
      symbol: quote.symbol,
      decimals: quote.decimals,
      sourceModule: quote.sourceModule,
      custodyWallet: wallet,
      quantityUnits: quote.quantityUnits,
      heldUnits: held === null ? null : held.toString(),
      priceUsd: quote.priceUsd,
      priceSource: quote.priceSource,
      valueUsd: quote.valueUsd,
      advanceRateBps: quote.advanceRateBps,
      status: 'active',
      pledgedBy: pledgedBy || null,
      valuedAt: new Date().toISOString(),
    };
    await this._savePosition(position);
    await this._event(position.id, 'pledged', pledgedBy, { symbol: position.symbol, quantityUnits: position.quantityUnits, valueUsd: position.valueUsd, advanceRateBps: position.advanceRateBps });
    return { ...(await this.position(position.id)), verified: held !== null };
  }

  /** Re-price positions (all active, or one) and report the facility. */
  static async revalue({ positionId, actor } = {}) {
    const targets = positionId ? [await this.position(positionId)] : await this.positions({ status: 'active' });
    const results = [];
    for (const p of targets) {
      if (p.status !== 'active') continue;
      try {
        const v = await this.price({ chainId: p.chainId, tokenAddress: p.tokenAddress, quantityUnits: p.quantityUnits });
        const held = this.config().verifyHoldings ? await this.heldUnits({ custodyWallet: p.custodyWallet, chainId: p.chainId, tokenAddress: p.tokenAddress }) : null;
        await this._updatePosition(p.id, { price_usd: v.priceUsd, price_source: v.source, value_usd: v.valueUsd, held_units: held === null ? p.heldUnits : held.toString(), valued_at: new Date().toISOString() });
        const shortfall = held !== null && held < BigInt(p.quantityUnits);
        if (shortfall) await this._event(p.id, 'holding_shortfall', actor, { heldUnits: held.toString(), pledgedUnits: p.quantityUnits });
        results.push({ positionId: p.id, symbol: p.symbol, previousValueUsd: p.valueUsd, valueUsd: v.valueUsd, priceUsd: v.priceUsd, source: v.source, holdingShortfall: shortfall });
      } catch (e) {
        results.push({ positionId: p.id, symbol: p.symbol, error: e.message });
      }
    }
    const facility = await this.facility();
    if (facility.marginCall) await this._event('FACILITY', 'margin_call', actor, { utilizationBps: facility.utilizationBps, drawnUsd: facility.drawnUsd, spendableUsd: facility.spendableUsd });
    return { revalued: results, facility };
  }

  /** Spendable value, what has been drawn against it, and what is left. */
  static async facility() {
    const cfg = this.config();
    const [positions, draws] = await Promise.all([this.positions({ status: 'active' }), this.draws({ open: true })]);
    const collateralUsd = usd(positions.reduce((s, p) => s + p.valueUsd, 0));
    const spendableUsd = usd(positions.reduce((s, p) => s + p.spendableUsd, 0));
    const drawnUsd = usd(draws.reduce((s, d) => s + d.outstandingUsd, 0));
    const availableUsd = usd(Math.max(spendableUsd - drawnUsd, 0));
    const utilizationBps = spendableUsd > 0 ? Math.round(drawnUsd / spendableUsd * 10000) : (drawnUsd > 0 ? 10000 : 0);
    return {
      chainId: cfg.chainId,
      custodyWallet: cfg.custodyWallet || null,
      positions: positions.length,
      collateralUsd,
      spendableUsd,
      drawnUsd,
      availableUsd,
      utilizationBps,
      marginCallBps: cfg.marginCallBps,
      marginCall: utilizationBps > cfg.marginCallBps,
      openDraws: draws.length,
      byToken: Object.values(positions.reduce((acc, p) => {
        const k = `${p.chainId}:${lower(p.tokenAddress)}`;
        acc[k] = acc[k] || { tokenAddress: p.tokenAddress, chainId: p.chainId, symbol: p.symbol, positions: 0, valueUsd: 0, spendableUsd: 0 };
        acc[k].positions += 1;
        acc[k].valueUsd = usd(acc[k].valueUsd + p.valueUsd);
        acc[k].spendableUsd = usd(acc[k].spendableUsd + p.spendableUsd);
        return acc;
      }, {})),
    };
  }

  /** Release a position if the remaining collateral still covers the debt. */
  static async release({ positionId, actor } = {}) {
    const p = await this.position(positionId);
    if (p.status !== 'active') throw httpError(409, `position ${positionId} is ${p.status}`, 'COLLATERAL_POSITION_NOT_ACTIVE');
    const facility = await this.facility();
    const remaining = usd(facility.spendableUsd - p.spendableUsd);
    if (facility.drawnUsd > remaining + 1e-9) {
      throw httpError(409, `releasing ${p.symbol || p.id} leaves ${remaining.toFixed(2)} USD spendable against ${facility.drawnUsd.toFixed(2)} USD drawn; repay first`, 'COLLATERAL_RELEASE_UNDERCOLLATERALISED');
    }
    await this._updatePosition(p.id, { status: 'released' });
    await this._event(p.id, 'released', actor, { spendableUsd: p.spendableUsd });
    return { ...(await this.position(p.id)), facility: await this.facility() };
  }

  // ─── Draw / settle / repay ─────────────────────────────────────────────────

  /**
   * Borrow spendable value. The ERP converts the collateral-backed reserve
   * into USDC paid to the policy contract under maker/checker consensus; the
   * draw is `proposed` until `reconcile()` sees the request complete.
   */
  static async draw({ amountUsd, reference, purpose, bucket, positionId, createdBy, autoApprove = false } = {}) {
    const cfg = this.config();
    if (!cfg.enabled) throw httpError(409, 'Collateral OS disabled (COLLATERAL_OS_ENABLED=false)', 'COLLATERAL_OS_DISABLED');
    if (!reference) throw httpError(400, 'reference required', 'COLLATERAL_REFERENCE_REQUIRED');
    const amount = Number(amountUsd);
    if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, 'amountUsd must be a positive number');

    const existing = await this.drawByReference(reference);
    if (existing) return { ...existing, idempotent: true };

    const facility = await this.facility();
    if (facility.marginCall) throw httpError(409, `facility is in margin call (utilisation ${facility.utilizationBps} bps > ${facility.marginCallBps}); add collateral or repay before drawing`, 'COLLATERAL_MARGIN_CALL');
    if (amount > facility.availableUsd + 1e-9) {
      throw httpError(409, `available spendable value is ${facility.availableUsd.toFixed(2)} USD (spendable ${facility.spendableUsd.toFixed(2)}, drawn ${facility.drawnUsd.toFixed(2)}); cannot draw ${amount.toFixed(2)}`, 'COLLATERAL_INSUFFICIENT_SPENDABLE');
    }
    const projected = facility.spendableUsd > 0 ? Math.round((facility.drawnUsd + amount) / facility.spendableUsd * 10000) : 10000;
    if (projected > cfg.marginCallBps) {
      throw httpError(409, `drawing ${amount.toFixed(2)} USD takes utilisation to ${projected} bps, above the ${cfg.marginCallBps} bps margin-call line`, 'COLLATERAL_MARGIN_CALL');
    }

    const source = await this._fundingSourceFor({ positionId, bucket });
    const funding = await SpritzTreasuryLegEngine.fund({
      amountUsd: amount.toFixed(2),
      bucket: source.bucket,
      sourceToken: source.sourceToken,
      sourceModule: source.sourceModule,
      reference: `COLLATERAL:${reference}`,
      createdBy: createdBy || 'collateral-os',
      autoApprove,
    });

    const draw = {
      id: newId('CDR'),
      reference,
      positionId: source.positionId,
      amountUsd: usd(amount),
      repaidUsd: 0,
      purpose: purpose || null,
      bucket: source.bucket,
      status: 'proposed',
      erpRequestId: funding.requestId || null,
      erpProposalId: funding.proposalId || null,
      createdBy: createdBy || null,
    };
    await this._saveDraw(draw);
    await this._event(draw.id, 'drawn', createdBy, { amountUsd: draw.amountUsd, reference, erpRequestId: draw.erpRequestId, source });
    return { ...(await this.drawById(draw.id)), funding, facility: await this.facility(), next: 'checker approves the canonical_money proposal; then POST /api/collateral-os/reconcile books the draw and marks it funded.' };
  }

  /**
   * Match proposed draws to their ERP requests; a completed request books
   * Dr USDC treasury / Cr collateral facility liability and marks the draw funded.
   */
  static async reconcile({ postedBy } = {}) {
    const cfg = this.config();
    const proposed = (await this.draws({ status: 'proposed' })).filter((d) => d.erpRequestId);
    const results = [];
    for (const d of proposed) {
      const req = await this._erpRequest(d.erpRequestId);
      if (!req) { results.push({ drawId: d.id, status: 'proposed', note: 'ERP request not found' }); continue; }
      if (req.status === 'failed') {
        await this._updateDraw(d.id, { status: 'failed' });
        await this._event(d.id, 'failed', postedBy, { erpRequestId: d.erpRequestId });
        results.push({ drawId: d.id, status: 'failed' });
        continue;
      }
      if (req.status !== 'completed') { results.push({ drawId: d.id, status: 'proposed', erpStatus: req.status }); continue; }
      const journal = await book({
        referenceType: 'collateral_draw',
        referenceId: d.id,
        description: `Collateral facility draw ${d.amountUsd.toFixed(2)} USD -> USDC to TrustDistributionPolicy [${d.reference}]`,
        lines: [
          { accountCode: cfg.gl.treasuryAccount, debitAmount: d.amountUsd, creditAmount: 0, description: `USDC funded from collateral facility (draw ${d.id})` },
          { accountCode: cfg.gl.facilityAccount, debitAmount: 0, creditAmount: d.amountUsd, description: `Collateralised facility liability [${d.reference}]` },
        ],
        postedBy,
      });
      await this._updateDraw(d.id, { status: 'funded', journal_entry_id: journal.entryId || null });
      await this._event(d.id, 'funded', postedBy, { journal });
      results.push({ drawId: d.id, status: 'funded', journal });
    }
    return { reconciled: results, facility: await this.facility() };
  }

  /** Stage the fiat leg of a funded draw: policy contract -> Spritz -> settlement bank. */
  static async stageSettlement({ drawId, purpose, payoutWallet, rail, memo } = {}) {
    const d = await this.drawById(drawId);
    if (d.status !== 'funded') throw httpError(409, `draw ${drawId} is ${d.status}; only a funded draw can be settled`, 'COLLATERAL_DRAW_NOT_FUNDED');
    const staged = await SpritzTreasuryLegEngine.stagePayout({
      amountUsd: d.outstandingUsd,
      purpose: purpose || d.purpose,
      reference: `COLLATERAL:${d.reference}`,
      bucket: d.bucket || undefined,
      payoutWallet,
      rail,
      memo: memo || `Collateral draw ${d.id}`,
    });
    const distributionId = staged.distribution && (staged.distribution.distributionId || staged.distribution.id);
    await this._updateDraw(d.id, { status: 'settling', distribution_id: distributionId ? String(distributionId) : null, spritz_quote_id: staged.spritzQuoteId || null });
    await this._event(d.id, 'settlement_staged', null, { distributionId, spritzQuoteId: staged.spritzQuoteId, settlementBank: staged.settlementBank });
    return { ...(await this.drawById(d.id)), staged };
  }

  static async executeSettlement({ drawId, createdBy } = {}) {
    const d = await this.drawById(drawId);
    if (d.status !== 'settling') throw httpError(409, `draw ${drawId} is ${d.status}; stage the settlement first`, 'COLLATERAL_DRAW_NOT_STAGED');
    if (!d.distributionId || !d.spritzQuoteId) throw httpError(409, 'draw has no distribution / Spritz quote', 'COLLATERAL_DRAW_INCOMPLETE');
    const executed = await SpritzTreasuryLegEngine.executePayout({ distributionId: d.distributionId, spritzQuoteId: d.spritzQuoteId, reference: `COLLATERAL:${d.reference}`, amountUsd: d.outstandingUsd, createdBy });
    await this._updateDraw(d.id, { status: 'settled' });
    await this._event(d.id, 'settled', createdBy, { txHash: executed.txHash, amountUsd: executed.amountUsd, feeUsd: executed.feeUsd });
    return { ...(await this.drawById(d.id)), executed };
  }

  /** Retire facility debt: Dr facility liability / Cr USDC treasury. */
  static async repay({ drawId, amountUsd, createdBy } = {}) {
    const d = await this.drawById(drawId);
    if (!OPEN_DRAW_STATUSES.includes(d.status)) throw httpError(409, `draw ${drawId} is ${d.status}`, 'COLLATERAL_DRAW_NOT_OPEN');
    if (d.status === 'proposed') throw httpError(409, `draw ${drawId} has not funded yet`, 'COLLATERAL_DRAW_NOT_FUNDED');
    const amount = amountUsd === undefined || amountUsd === null ? d.outstandingUsd : Number(amountUsd);
    if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, 'amountUsd must be a positive number');
    if (amount > d.outstandingUsd + 1e-9) throw httpError(409, `repayment ${amount.toFixed(2)} exceeds outstanding ${d.outstandingUsd.toFixed(2)}`, 'COLLATERAL_OVERPAYMENT');
    const cfg = this.config();
    const repaymentId = `${d.id}:R${Date.now()}`;
    const journal = await book({
      referenceType: 'collateral_repayment',
      referenceId: repaymentId,
      description: `Collateral facility repayment ${amount.toFixed(2)} USD on draw ${d.id} [${d.reference}]`,
      lines: [
        { accountCode: cfg.gl.facilityAccount, debitAmount: usd(amount), creditAmount: 0, description: `Facility liability retired (draw ${d.id})` },
        { accountCode: cfg.gl.treasuryAccount, debitAmount: 0, creditAmount: usd(amount), description: 'USDC returned to treasury' },
      ],
      postedBy: createdBy,
    });
    const repaid = usd(d.repaidUsd + amount);
    const closed = repaid + 1e-9 >= d.amountUsd;
    await this._updateDraw(d.id, { repaid_usd: repaid, status: closed ? 'repaid' : d.status });
    await this._event(d.id, closed ? 'repaid' : 'partial_repayment', createdBy, { amountUsd: usd(amount), repaidUsd: repaid, journal });
    return { ...(await this.drawById(d.id)), journal, facility: await this.facility() };
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  static async positions({ status } = {}) {
    await ensureTables();
    if (pool && pool.query) {
      const params = [];
      let sql = `SELECT * FROM ${POSITIONS}`;
      if (status) { sql += ' WHERE status = $1'; params.push(status); }
      sql += ' ORDER BY created_at DESC';
      const { rows } = await pool.query(sql, params);
      return rows.map(rowToPosition);
    }
    return [...memory.positions.values()].filter((p) => !status || p.status === status).map((p) => rowToPosition(p));
  }

  static async position(positionId) {
    await ensureTables();
    let row = null;
    if (pool && pool.query) {
      const { rows } = await pool.query(`SELECT * FROM ${POSITIONS} WHERE id = $1`, [positionId]);
      row = rows[0] || null;
    } else {
      row = memory.positions.get(positionId) || null;
    }
    if (!row) throw httpError(404, `collateral position ${positionId} not found`, 'COLLATERAL_POSITION_NOT_FOUND');
    return rowToPosition(row);
  }

  static async draws({ status, open = false, limit = 200 } = {}) {
    await ensureTables();
    if (pool && pool.query) {
      const params = [];
      const where = [];
      if (status) { params.push(status); where.push(`status = $${params.length}`); }
      if (open) { params.push(OPEN_DRAW_STATUSES); where.push(`status = ANY($${params.length})`); }
      params.push(Number(limit) || 200);
      const { rows } = await pool.query(`SELECT * FROM ${DRAWS}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $${params.length}`, params);
      return rows.map(rowToDraw);
    }
    return [...memory.draws.values()]
      .filter((d) => (!status || d.status === status) && (!open || OPEN_DRAW_STATUSES.includes(d.status)))
      .slice(0, limit).map((d) => rowToDraw(d));
  }

  static async drawById(drawId) {
    await ensureTables();
    let row = null;
    if (pool && pool.query) {
      const { rows } = await pool.query(`SELECT * FROM ${DRAWS} WHERE id = $1`, [drawId]);
      row = rows[0] || null;
    } else {
      row = memory.draws.get(drawId) || null;
    }
    if (!row) throw httpError(404, `collateral draw ${drawId} not found`, 'COLLATERAL_DRAW_NOT_FOUND');
    return rowToDraw(row);
  }

  static async drawByReference(reference) {
    await ensureTables();
    if (pool && pool.query) {
      const { rows } = await pool.query(`SELECT * FROM ${DRAWS} WHERE reference = $1`, [reference]);
      return rows[0] ? rowToDraw(rows[0]) : null;
    }
    const row = [...memory.draws.values()].find((d) => d.reference === reference);
    return row ? rowToDraw(row) : null;
  }

  static async events({ subjectId, limit = 100 } = {}) {
    await ensureTables();
    if (pool && pool.query) {
      const params = [];
      let sql = `SELECT * FROM ${EVENTS}`;
      if (subjectId) { params.push(subjectId); sql += ' WHERE subject_id = $1'; }
      params.push(Number(limit) || 100);
      sql += ` ORDER BY id DESC LIMIT $${params.length}`;
      const { rows } = await pool.query(sql, params);
      return rows;
    }
    return memory.events.filter((e) => !subjectId || e.subject_id === subjectId).slice(-limit).reverse();
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  /** Which ERP reserve backs a draw: the pledged token (by position), else the bucket's module token. */
  static async _fundingSourceFor({ positionId, bucket }) {
    if (positionId) {
      const p = await this.position(positionId);
      if (p.status !== 'active') throw httpError(409, `position ${positionId} is ${p.status}`, 'COLLATERAL_POSITION_NOT_ACTIVE');
      return { positionId: p.id, bucket: bucket || null, sourceToken: p.tokenAddress, sourceModule: p.sourceModule || undefined };
    }
    const active = await this.positions({ status: 'active' });
    if (!active.length) throw httpError(409, 'no active collateral positions', 'COLLATERAL_NO_POSITIONS');
    if (bucket) return { positionId: null, bucket, sourceToken: undefined, sourceModule: undefined };
    const largest = active.slice().sort((a, b) => b.spendableUsd - a.spendableUsd)[0];
    return { positionId: largest.id, bucket: null, sourceToken: largest.tokenAddress, sourceModule: largest.sourceModule || undefined };
  }

  static async _erpRequest(requestId) {
    if (!pool || !pool.query) return null;
    try {
      const { rows } = await pool.query('SELECT id, status, amount, result FROM canonical_money_requests WHERE id = $1', [requestId]);
      return rows[0] || null;
    } catch (e) {
      return null;
    }
  }

  static async _savePosition(p) {
    await ensureTables();
    if (pool && pool.query) {
      await pool.query(
        `INSERT INTO ${POSITIONS} (id, token_address, chain_id, symbol, decimals, source_module, custody_wallet, quantity_units, held_units, price_usd, price_source, value_usd, advance_rate_bps, status, pledged_by, valued_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [p.id, p.tokenAddress, p.chainId, p.symbol, p.decimals, p.sourceModule, p.custodyWallet, p.quantityUnits, p.heldUnits, p.priceUsd, p.priceSource, p.valueUsd, p.advanceRateBps, p.status, p.pledgedBy, p.valuedAt]
      );
      return;
    }
    memory.positions.set(p.id, {
      id: p.id, token_address: p.tokenAddress, chain_id: p.chainId, symbol: p.symbol, decimals: p.decimals, source_module: p.sourceModule,
      custody_wallet: p.custodyWallet, quantity_units: p.quantityUnits, held_units: p.heldUnits, price_usd: p.priceUsd, price_source: p.priceSource,
      value_usd: p.valueUsd, advance_rate_bps: p.advanceRateBps, status: p.status, pledged_by: p.pledgedBy, valued_at: p.valuedAt,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
  }

  static async _updatePosition(id, patch) {
    await ensureTables();
    const keys = Object.keys(patch);
    if (!keys.length) return;
    if (pool && pool.query) {
      const sets = keys.map((k, i) => `${k} = $${i + 2}`);
      await pool.query(`UPDATE ${POSITIONS} SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, [id, ...keys.map((k) => patch[k])]);
      return;
    }
    const row = memory.positions.get(id);
    if (row) Object.assign(row, patch, { updated_at: new Date().toISOString() });
  }

  static async _saveDraw(d) {
    await ensureTables();
    if (pool && pool.query) {
      await pool.query(
        `INSERT INTO ${DRAWS} (id, reference, position_id, amount_usd, repaid_usd, purpose, bucket, status, erp_request_id, erp_proposal_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [d.id, d.reference, d.positionId, d.amountUsd, d.repaidUsd, d.purpose, d.bucket, d.status, d.erpRequestId, d.erpProposalId, d.createdBy]
      );
      return;
    }
    memory.draws.set(d.id, {
      id: d.id, reference: d.reference, position_id: d.positionId, amount_usd: d.amountUsd, repaid_usd: d.repaidUsd, purpose: d.purpose, bucket: d.bucket,
      status: d.status, erp_request_id: d.erpRequestId, erp_proposal_id: d.erpProposalId, distribution_id: null, spritz_quote_id: null, journal_entry_id: null,
      created_by: d.createdBy, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
  }

  static async _updateDraw(id, patch) {
    await ensureTables();
    const keys = Object.keys(patch);
    if (!keys.length) return;
    if (pool && pool.query) {
      const sets = keys.map((k, i) => `${k} = $${i + 2}`);
      await pool.query(`UPDATE ${DRAWS} SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, [id, ...keys.map((k) => patch[k])]);
      return;
    }
    const row = memory.draws.get(id);
    if (row) Object.assign(row, patch, { updated_at: new Date().toISOString() });
  }

  static async _event(subjectId, kind, actor, payload) {
    await ensureTables();
    if (pool && pool.query) {
      try {
        await pool.query(`INSERT INTO ${EVENTS} (subject_id, kind, actor, payload) VALUES ($1,$2,$3,$4)`, [subjectId, kind, actor || null, JSON.stringify(payload || {})]);
      } catch (e) { /* events are best-effort */ }
      return;
    }
    memory.events.push({ id: memory.events.length + 1, subject_id: subjectId, kind, actor: actor || null, payload: payload || {}, created_at: new Date().toISOString() });
  }

  static _resetMemory() { memory.positions.clear(); memory.draws.clear(); memory.events.length = 0; }
}

module.exports = { CollateralOsEngine, OPEN_DRAW_STATUSES, unitsToAmount, amountToUnits };
