'use strict';

/**
 * SpritzBuyEngine — "Buy Crypto" through Spritz: an ACH debit against a
 * Plaid-linked bank account (Spritz funding source) that delivers USDC
 * straight to a wallet address on Base.
 *
 *   funding source (`active`) --(ACH debit)--> Spritz --(USDC)--> destination wallet
 *
 * The destination defaults to the pinned thirdweb server wallet
 * (THIRDWEB_SERVER_WALLET_ADDRESS) and can be overridden with
 * SPRITZ_BUY_DESTINATION. Nothing is signed on-chain: authorization comes
 * from the verified funding source, so the wallet only ever receives.
 *
 * Fail-closed and idempotent on the ERP reference:
 *   capability (fiat_to_crypto ach_debit must not be reported inactive)
 *   → funding source `active` + deposit-limit check for the priority
 *   → prepare (Spritz quote: fee, expected USDC, ACH authorization text)
 *   → SPRITZ_BUY_LIVE gate: shadow mode records the quote and stops
 *   → create (Idempotency-Key = reference) → deposit row
 *   → sync() tracks debit / release; GL is booked once Spritz reports
 *     `completed` (Dr USDC treasury / Cr bank cash, fee to fee account).
 */

const { SpritzEngine } = require('./spritzEngine');

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }
let TrustAccountingEngine;
try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) { TrustAccountingEngine = null; }
let ThirdwebServerWalletEngine;
try { ({ ThirdwebServerWalletEngine } = require('../dapp/thirdwebServerWalletEngine')); } catch (e) { ThirdwebServerWalletEngine = null; }

const TABLE = 'spritz_buys';
const STATUSES = ['quoted', 'authorized', 'processing', 'partially_released', 'completed', 'returned', 'refunded', 'failed'];
const TERMINAL = new Set(['completed', 'returned', 'refunded', 'failed']);
const PRIORITIES = ['normal', 'high'];

function str(name, def = '') { return (process.env[name] || def).trim(); }
function bool(name, def = false) {
  const v = str(name);
  if (!v) return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}
function httpError(status, message, code) { return Object.assign(new Error(message), { status, code }); }
function badRequest(message, code = 'BAD_REQUEST') { return httpError(400, message, code); }
function conflict(message, code) { return httpError(409, message, code); }
function isAddress(a) { return /^0x[0-9a-fA-F]{40}$/.test(String(a || '')); }
function usd(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw badRequest('amountUsd must be a positive number');
  return Math.round(n * 100) / 100;
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function thirdwebWalletAddress() {
  if (!ThirdwebServerWalletEngine) return null;
  try {
    const tw = ThirdwebServerWalletEngine.getConfig();
    return tw.enabled && tw.address ? tw.address : null;
  } catch (e) { return null; }
}

let tableReady = null;
async function ensureTable() {
  if (!pool || !pool.query) return;
  if (!tableReady) {
    tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        reference TEXT PRIMARY KEY,
        amount_usd NUMERIC(18,2) NOT NULL,
        priority TEXT NOT NULL,
        funding_source_id TEXT NOT NULL,
        destination TEXT NOT NULL,
        network TEXT NOT NULL,
        preparation_id TEXT,
        quote JSONB,
        deposit_id TEXT,
        deposit JSONB,
        status TEXT NOT NULL,
        shadow BOOLEAN NOT NULL DEFAULT FALSE,
        gl_entry_id TEXT,
        error TEXT,
        memo TEXT,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`).catch((e) => { tableReady = null; throw e; });
  }
  await tableReady;
}

function mapRow(r) {
  if (!r) return null;
  return {
    reference: r.reference,
    amountUsd: Number(r.amount_usd),
    priority: r.priority,
    fundingSourceId: r.funding_source_id,
    destination: r.destination,
    network: r.network,
    preparationId: r.preparation_id,
    quote: r.quote || null,
    depositId: r.deposit_id,
    deposit: r.deposit || null,
    status: r.status,
    shadow: Boolean(r.shadow),
    glEntryId: r.gl_entry_id || null,
    error: r.error,
    memo: r.memo,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function summarizeQuote(prep) {
  const s = (prep && prep.summary) || {};
  return {
    preparationId: prep && prep.preparationId,
    expiresAt: prep && prep.expiresAt,
    message: prep && prep.message,
    requestedAmountUsd: s.requestedAmountUsd,
    principalAmountUsd: s.principalAmountUsd,
    expectedAssetAmount: s.expectedAssetAmount,
    userFeeUsd: s.userFeeUsd,
    feeRateBps: s.feeRateBps,
    totalDebitAmountUsd: s.totalDebitAmountUsd,
    priority: s.priority,
    releaseDecisionMode: s.releaseDecisionMode,
    destinationAddress: s.destinationAddress,
    network: s.network,
    asset: s.asset,
  };
}

function summarizeDeposit(dep) {
  if (!dep) return null;
  return {
    id: dep.id,
    status: dep.status,
    debitStatus: dep.debitStatus,
    releaseStatus: dep.releaseStatus,
    onRampId: dep.onRampId || null,
    principalAmountUsd: dep.principalAmountUsd,
    expectedAssetAmount: dep.expectedAssetAmount,
    userFeeUsd: dep.userFeeUsd,
    totalDebitAmountUsd: dep.totalDebitAmountUsd,
    releasedAmountUsd: dep.releasedAmountUsd,
    confirmedReleasedAmountUsd: dep.confirmedReleasedAmountUsd,
    address: dep.address,
    network: dep.network,
    debitFailureReason: dep.debitFailureReason || null,
    releaseFailureReason: dep.releaseFailureReason || null,
    createdAt: dep.createdAt,
  };
}

function mapFundingSource(fs) {
  return {
    id: fs.id,
    status: fs.status,
    active: String(fs.status || '').toLowerCase() === 'active',
    statusReason: fs.statusReason || null,
    institutionName: fs.institutionName || (fs.institution && fs.institution.name) || null,
    accountType: fs.accountType || null,
    accountNumberLast4: fs.accountNumberLast4 || null,
    permanent: Boolean(fs.permanent),
    createdAt: fs.createdAt || null,
  };
}

async function existingEntry(referenceType, referenceId) {
  if (!pool || !pool.query || !referenceId) return null;
  try {
    const { rows } = await pool.query(
      `SELECT entry_id FROM trust_journal_entries WHERE reference_type = $1 AND reference_id = $2 AND status = 'posted' LIMIT 1`,
      [referenceType, String(referenceId)]
    );
    return rows[0] ? rows[0].entry_id : null;
  } catch (e) { return null; }
}

class SpritzBuyEngine {
  static config() {
    const thirdweb = thirdwebWalletAddress();
    const destination = str('SPRITZ_BUY_DESTINATION') || thirdweb || null;
    const chainId = Number(str('SPRITZ_BUY_CHAIN_ID') || str('THIRDWEB_SERVER_WALLET_CHAIN_ID') || str('THIRDWEB_CHAIN_ID') || '8453');
    return {
      live: bool('SPRITZ_BUY_LIVE', false),
      destination,
      destinationIsThirdweb: Boolean(destination && thirdweb && destination.toLowerCase() === thirdweb.toLowerCase()),
      chainId,
      network: SpritzEngine.chainName(chainId),
      asset: 'USDC',
      fundingSourceId: str('SPRITZ_BUY_FUNDING_SOURCE_ID') || null,
      defaultPriority: str('SPRITZ_BUY_PRIORITY', 'normal').toLowerCase(),
      maxAmountUsd: num(str('SPRITZ_BUY_MAX_AMOUNT_USD', '0')),
      gl: {
        treasuryAccount: str('SPRITZ_BUY_TREASURY_GL_ACCOUNT', str('SPRITZ_TREASURY_GL_ACCOUNT', '1210')),
        cashAccount: str('SPRITZ_BUY_CASH_GL_ACCOUNT', str('CANONICAL_FUNDING_CASH_ACCOUNT_CODE', '1000')),
        feeAccount: str('SPRITZ_BUY_FEE_GL_ACCOUNT', str('SPRITZ_FEE_GL_ACCOUNT', '5300')),
        bookingEnabled: str('SPRITZ_GL_BOOKING_ENABLED', 'true').toLowerCase() !== 'false',
      },
    };
  }

  /** Spritz fiat_to_crypto ACH-debit capability; usable unless Spritz reports it non-active. */
  static async capability() {
    const caps = await SpritzEngine.capabilities();
    const list = Array.isArray(caps) ? caps : [];
    const cap = list.find((c) => c.product === 'fiat_to_crypto' && /debit|deposit/i.test(String(c.method || c.name || '')))
      || list.find((c) => c.product === 'fiat_to_crypto' && !c.method) || null;
    const requirements = cap && Array.isArray(cap.requirements) ? cap.requirements : [];
    return {
      method: cap ? (cap.method || cap.name || 'fiat_to_crypto') : 'ach_debit',
      status: cap ? cap.status : 'unreported',
      active: !cap || !cap.status || cap.status === 'active',
      requirements: requirements.map((r) => ({ type: r.type || null, status: r.status || null, actionUrl: r.actionUrl || null })),
    };
  }

  static async fundingSources() {
    const raw = await SpritzEngine.listFundingSources();
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.data) ? raw.data : []);
    return list.map(mapFundingSource);
  }

  /**
   * The funding source a buy debits: SPRITZ_BUY_FUNDING_SOURCE_ID / the
   * caller's id when set, otherwise the only active source. Refuses to guess
   * between several.
   */
  static async fundingSource(fundingSourceId) {
    const cfg = this.config();
    const sources = await this.fundingSources();
    const wanted = fundingSourceId || cfg.fundingSourceId;
    if (wanted) {
      const match = sources.find((s) => s.id === wanted);
      if (!match) throw httpError(404, `Spritz funding source ${wanted} not found on this user`, 'FUNDING_SOURCE_NOT_FOUND');
      return match;
    }
    const active = sources.filter((s) => s.active);
    if (active.length === 1) return active[0];
    if (active.length === 0) throw conflict('no active Spritz funding source: link a bank account in the Spritz dashboard (Plaid) first', 'FUNDING_SOURCE_MISSING');
    throw conflict(`${active.length} active Spritz funding sources; pin one with SPRITZ_BUY_FUNDING_SOURCE_ID or pass fundingSourceId`, 'FUNDING_SOURCE_AMBIGUOUS');
  }

  static async limits(fundingSourceId) {
    const source = await this.fundingSource(fundingSourceId);
    const limits = await SpritzEngine.getFundingSourceDepositLimits(source.id);
    return { fundingSourceId: source.id, ...limits };
  }

  static async readiness() {
    const cfg = this.config();
    const issues = [];
    const warnings = [];
    if (!str('SPRITZ_API_KEY')) issues.push('SPRITZ_API_KEY not configured');
    if (!cfg.destination) issues.push('SPRITZ_BUY_DESTINATION / THIRDWEB_SERVER_WALLET_ADDRESS not configured');
    else if (!isAddress(cfg.destination)) issues.push(`destination ${cfg.destination} is not an EVM address`);
    if (!cfg.network) issues.push(`chain ${cfg.chainId} has no Spritz deposit network mapping`);
    if (!PRIORITIES.includes(cfg.defaultPriority)) issues.push(`SPRITZ_BUY_PRIORITY=${cfg.defaultPriority} is not normal or high`);
    if (!cfg.live) warnings.push('SPRITZ_BUY_LIVE=false: buys are quoted and recorded but no ACH debit is authorized');
    if (cfg.destination && !cfg.destinationIsThirdweb) warnings.push(`destination ${cfg.destination} is not the thirdweb server wallet`);

    let capability = null;
    let sources = [];
    let source = null;
    let limits = null;
    if (str('SPRITZ_API_KEY')) {
      try {
        capability = await this.capability();
        if (!capability.active) issues.push(`Spritz fiat_to_crypto ${capability.method} is ${capability.status}${capability.requirements.length ? ` (${capability.requirements.map((r) => `${r.type || 'requirement'}${r.actionUrl ? ' ' + r.actionUrl : ''}`).join('; ')})` : ''}`);
        sources = await this.fundingSources();
        try {
          source = await this.fundingSource();
          if (!source.active) issues.push(`Spritz funding source ${source.id} is ${source.status}${source.statusReason ? ` (${source.statusReason})` : ''}`);
          else limits = await SpritzEngine.getFundingSourceDepositLimits(source.id);
        } catch (e) { issues.push(e.message); }
      } catch (e) { issues.push(e.message); }
    }
    return {
      provider: 'spritz-buy',
      direction: 'ach_debit_onramp',
      ready: issues.length === 0,
      live: cfg.live,
      issues,
      warnings,
      destination: cfg.destination,
      destinationIsThirdweb: cfg.destinationIsThirdweb,
      chainId: cfg.chainId,
      network: cfg.network,
      asset: cfg.asset,
      defaultPriority: cfg.defaultPriority,
      maxAmountUsd: cfg.maxAmountUsd || null,
      capability,
      fundingSources: sources,
      fundingSource: source,
      limits,
      gl: cfg.gl,
    };
  }

  static _checkAmount(amount, cfg) {
    if (cfg.maxAmountUsd > 0 && amount > cfg.maxAmountUsd) {
      throw conflict(`amount ${amount.toFixed(2)} exceeds SPRITZ_BUY_MAX_AMOUNT_USD ${cfg.maxAmountUsd}`, 'BUY_AMOUNT_ABOVE_CEILING');
    }
  }

  static _checkLimits(limits, amount, priority) {
    const block = limits && limits.limitsByPriority && limits.limitsByPriority[priority];
    if (!block) return;
    if (block.available === false) throw conflict(`Spritz will not accept a ${priority} deposit right now${block.reason ? ` (${block.reason})` : ''}`, 'BUY_LIMIT_UNAVAILABLE');
    if (block.maxAmountUsd !== undefined && amount > num(block.maxAmountUsd)) throw conflict(`amount ${amount.toFixed(2)} exceeds the funding source's ${priority} limit ${block.maxAmountUsd}`, 'BUY_ABOVE_DEPOSIT_LIMIT');
    if (block.minAmountUsd !== undefined && amount < num(block.minAmountUsd)) throw conflict(`amount ${amount.toFixed(2)} is below the minimum deposit ${block.minAmountUsd}`, 'BUY_BELOW_MINIMUM');
  }

  /** Quote only: Spritz prepares the ACH authorization; nothing is created. */
  static async quote({ amountUsd, fundingSourceId, priority } = {}) {
    const cfg = this.config();
    const amount = usd(amountUsd);
    this._checkAmount(amount, cfg);
    const useP = String(priority || cfg.defaultPriority).toLowerCase();
    if (!PRIORITIES.includes(useP)) throw badRequest('priority must be normal or high');
    if (!cfg.destination || !isAddress(cfg.destination)) throw conflict('SPRITZ_BUY_DESTINATION / THIRDWEB_SERVER_WALLET_ADDRESS not configured', 'BUY_DESTINATION_NOT_CONFIGURED');
    if (!cfg.network) throw conflict(`chain ${cfg.chainId} is not a Spritz deposit network`, 'BUY_NETWORK_UNSUPPORTED');

    const capability = await this.capability();
    if (!capability.active) {
      const action = capability.requirements.map((r) => r.actionUrl).filter(Boolean)[0];
      throw conflict(`Spritz fiat_to_crypto ${capability.method} is ${capability.status}${action ? `; complete ${action}` : ''}`, 'BUY_CAPABILITY_INACTIVE');
    }
    const source = await this.fundingSource(fundingSourceId);
    if (!source.active) throw conflict(`Spritz funding source ${source.id} is ${source.status}, not active`, 'FUNDING_SOURCE_INACTIVE');
    const limits = await SpritzEngine.getFundingSourceDepositLimits(source.id);
    this._checkLimits(limits, amount, useP);

    const prep = await SpritzEngine.prepareDirectDeposit({
      sourceId: source.id, address: cfg.destination, network: cfg.network, asset: cfg.asset, amountUsd: amount, quoteType: 'exact_input', priority: useP,
    });
    return {
      amountUsd: amount.toFixed(2),
      priority: useP,
      destination: cfg.destination,
      network: cfg.network,
      asset: cfg.asset,
      fundingSource: source,
      limits,
      quote: summarizeQuote(prep),
      live: cfg.live,
    };
  }

  /**
   * Buy USDC to the destination wallet. Idempotent on `reference`, which is
   * also the Spritz Idempotency-Key. In shadow mode (SPRITZ_BUY_LIVE unset)
   * the quote is recorded and no debit is authorized.
   */
  static async buy({ amountUsd, reference, fundingSourceId, priority, createdBy, memo } = {}) {
    await ensureTable();
    if (!reference) throw badRequest('reference required (ERP reference / idempotency key)');
    const existing = await this.get(reference);
    if (existing && (existing.status !== 'quoted' || !this.config().live)) return { ...existing, idempotent: true };

    const cfg = this.config();
    const quoted = await this.quote({ amountUsd, fundingSourceId, priority });
    const amount = Number(quoted.amountUsd);

    if (!cfg.live) {
      await this._upsert({
        reference, amount, priority: quoted.priority, fundingSourceId: quoted.fundingSource.id, destination: cfg.destination, network: cfg.network,
        preparationId: quoted.quote.preparationId, quote: quoted.quote, status: 'quoted', shadow: true, memo, createdBy,
      });
      return { ...(await this.get(reference)), quoteDetail: quoted, next: 'set SPRITZ_BUY_LIVE=true to authorize the ACH debit' };
    }

    let deposit = null;
    let error = null;
    try {
      deposit = await SpritzEngine.createDirectDeposit({ preparationId: quoted.quote.preparationId, idempotencyKey: reference });
    } catch (e) { error = e.message; }
    const summary = summarizeDeposit(deposit);
    await this._upsert({
      reference, amount, priority: quoted.priority, fundingSourceId: quoted.fundingSource.id, destination: cfg.destination, network: cfg.network,
      preparationId: quoted.quote.preparationId, quote: quoted.quote, depositId: summary ? summary.id : null, deposit: summary,
      status: error ? 'failed' : (summary && STATUSES.includes(summary.status) ? summary.status : 'authorized'), shadow: false, error, memo, createdBy,
    });
    if (error) throw conflict(`Spritz refused the deposit: ${error}`, 'BUY_CREATE_FAILED');
    const row = await this.get(reference);
    if (row && row.status === 'completed') await this._book(row);
    return { ...(await this.get(reference)), quoteDetail: quoted, next: 'sync({ reference }) tracks the ACH debit and USDC release; the GL is booked on completion.' };
  }

  static async _upsert(r) {
    if (!pool || !pool.query) return;
    await pool.query(
      `INSERT INTO ${TABLE} (reference, amount_usd, priority, funding_source_id, destination, network, preparation_id, quote, deposit_id, deposit, status, shadow, error, memo, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (reference) DO UPDATE SET preparation_id = EXCLUDED.preparation_id, quote = EXCLUDED.quote, deposit_id = EXCLUDED.deposit_id, deposit = EXCLUDED.deposit,
         status = EXCLUDED.status, shadow = EXCLUDED.shadow, error = EXCLUDED.error, updated_at = NOW()`,
      [r.reference, r.amount.toFixed(2), r.priority, r.fundingSourceId, r.destination, r.network, r.preparationId || null, JSON.stringify(r.quote || null),
        r.depositId || null, JSON.stringify(r.deposit || null), r.status, Boolean(r.shadow), r.error || null, r.memo || null, r.createdBy || null]
    );
  }

  /** Dr USDC treasury (principal) + Dr fee expense / Cr bank cash (total debit). Once per reference. */
  static async _book(row) {
    const cfg = this.config();
    if (!cfg.gl.bookingEnabled) return { status: 'booking_disabled', booked: false };
    if (!TrustAccountingEngine) return { status: 'accounting_unavailable', booked: false };
    if (row.glEntryId) return { status: 'already_booked', booked: true, entryId: row.glEntryId };
    const already = await existingEntry('spritz_buy', row.reference);
    if (already) {
      await pool.query(`UPDATE ${TABLE} SET gl_entry_id = $1, updated_at = NOW() WHERE reference = $2`, [String(already), row.reference]);
      return { status: 'already_booked', booked: true, entryId: already };
    }
    const dep = row.deposit || {};
    const principal = num(dep.principalAmountUsd) || row.amountUsd;
    const fee = num(dep.userFeeUsd);
    const total = num(dep.totalDebitAmountUsd) || principal + fee;
    const lines = [
      { accountCode: cfg.gl.treasuryAccount, debitAmount: +principal.toFixed(2), creditAmount: 0, description: `USDC bought via Spritz to ${row.destination}` },
    ];
    if (fee > 0) lines.push({ accountCode: cfg.gl.feeAccount, debitAmount: +fee.toFixed(2), creditAmount: 0, description: 'Spritz on-ramp fee' });
    lines.push({ accountCode: cfg.gl.cashAccount, debitAmount: 0, creditAmount: +total.toFixed(2), description: `ACH debit by Spritz (funding source ${row.fundingSourceId})` });
    try {
      const entry = await TrustAccountingEngine.postJournalEntry({
        entryDate: new Date().toISOString().slice(0, 10),
        description: `Spritz buy ${row.reference}: ${principal.toFixed(2)} USD -> USDC to ${row.destination}`,
        lines,
        referenceType: 'spritz_buy',
        referenceId: String(row.reference),
        postedBy: row.createdBy || 'spritz-buy',
        postToFineract: false,
      });
      const entryId = entry.entry_id || entry.entryId || null;
      if (entryId && pool && pool.query) await pool.query(`UPDATE ${TABLE} SET gl_entry_id = $1, updated_at = NOW() WHERE reference = $2`, [String(entryId), row.reference]);
      return { status: 'booked', booked: true, entryId };
    } catch (e) {
      return { status: 'error', booked: false, error: e.message };
    }
  }

  static async get(reference) {
    await ensureTable();
    if (!pool || !pool.query || !reference) return null;
    const { rows } = await pool.query(`SELECT * FROM ${TABLE} WHERE reference = $1`, [reference]);
    return mapRow(rows[0]);
  }

  static async list({ status, limit = 50 } = {}) {
    await ensureTable();
    if (!pool || !pool.query) return [];
    const params = [];
    const where = status ? (params.push(status), 'WHERE status = $1') : '';
    params.push(Math.min(Math.max(Number(limit) || 50, 1), 500));
    const { rows } = await pool.query(`SELECT * FROM ${TABLE} ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return rows.map(mapRow);
  }

  /** Re-read open deposits from Spritz; book the GL when one completes. */
  static async sync({ reference } = {}) {
    await ensureTable();
    const rows = reference ? [await this.get(reference)].filter(Boolean) : (await this.list({ limit: 500 })).filter((r) => !TERMINAL.has(r.status) && r.depositId);
    if (reference && !rows.length) throw httpError(404, `no Spritz buy ${reference}`, 'BUY_NOT_FOUND');
    const updates = [];
    for (const row of rows) {
      if (!row.depositId) { updates.push({ reference: row.reference, status: row.status, changed: false }); continue; }
      let dep;
      try { dep = await SpritzEngine.getDeposit(row.depositId); } catch (e) { updates.push({ reference: row.reference, status: row.status, changed: false, error: e.message }); continue; }
      const summary = summarizeDeposit(dep);
      const status = summary && STATUSES.includes(summary.status) ? summary.status : row.status;
      const failure = summary && (summary.debitFailureReason || summary.releaseFailureReason) || null;
      if (pool && pool.query) {
        await pool.query(`UPDATE ${TABLE} SET deposit = $1, status = $2, error = $3, updated_at = NOW() WHERE reference = $4`,
          [JSON.stringify(summary), status, failure, row.reference]);
      }
      let gl = null;
      if (status === 'completed') gl = await this._book({ ...row, deposit: summary, status });
      updates.push({ reference: row.reference, status, changed: status !== row.status, depositId: row.depositId, gl });
    }
    return { synced: updates.length, updates };
  }
}

module.exports = { SpritzBuyEngine, STATUSES, TERMINAL };
