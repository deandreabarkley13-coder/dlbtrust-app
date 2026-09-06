/**
 * Fixed Income Data Service — the single read model for bond data.
 *
 * Every consumer that needs "what does the trust hold in fixed income"
 * (health checks, trustee/finops agents, attestation, DataBridge, admin
 * reconciliation, dashboards) reads through here instead of issuing its own
 * SELECT against `bonds`. The canonical position is `bonds` joined to
 * `bond_balances`: face value is the issued amount, principal_balance is
 * what is still outstanding, accrued_interest is what has been earned but
 * not paid, and current value is principal + accrued.
 *
 * The unified snapshot layers the other platforms on top of that ledger:
 * live market metrics (LiveBondEngine), on-chain tokenization (thirdweb /
 * bond_tokens) and the platform readiness of thirdweb and Northflank.
 */

'use strict';

const pool = require('./pgPool');

const POSITION_SELECT = `
  SELECT b.id, b.bond_name, b.isin, b.bond_identifier, b.issuer, b.currency,
         b.status, b.coupon_rate, b.issue_date, b.maturity_date, b.payment_freq, b.day_count,
         b.face_value,
         COALESCE(bb.principal_balance, b.face_value) AS principal_balance,
         COALESCE(bb.accrued_interest, 0)             AS accrued_interest,
         COALESCE(bb.total_interest_paid, 0)          AS total_interest_paid,
         COALESCE(bb.total_principal_paid, 0)         AS total_principal_paid,
         bb.last_accrual_date, bb.last_payment_date, bb.updated_at AS balance_updated_at
    FROM bonds b
    LEFT JOIN bond_balances bb ON bb.bond_id = b.id`;

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
/** Base-unit string -> whole units at 2dp without going through a float first. */
const fromBaseUnits = (amount, decimals) => {
  const cents = BigInt(String(amount || '0')) * 100n / 10n ** BigInt(decimals);
  return Number(cents) / 100;
};

function normalizePosition(row) {
  const face = Number(row.face_value || 0);
  const principal = Number(row.principal_balance != null ? row.principal_balance : face);
  const accrued = Number(row.accrued_interest || 0);
  return {
    id: row.id,
    bond_name: row.bond_name,
    isin: row.isin || null,
    bond_identifier: row.bond_identifier || null,
    issuer: row.issuer || null,
    currency: row.currency || 'USD',
    status: row.status || 'active',
    coupon_rate: row.coupon_rate != null ? Number(row.coupon_rate) : null,
    issue_date: row.issue_date || null,
    maturity_date: row.maturity_date || null,
    payment_freq: row.payment_freq || null,
    day_count: row.day_count || null,
    face_value: round2(face),
    principal_balance: round2(principal),
    accrued_interest: round2(accrued),
    current_value: round2(principal + accrued),
    total_interest_paid: round2(row.total_interest_paid),
    total_principal_paid: round2(row.total_principal_paid),
    last_accrual_date: row.last_accrual_date || null,
    last_payment_date: row.last_payment_date || null,
    balance_updated_at: row.balance_updated_at || null,
  };
}

function sumPositions(positions) {
  const totals = positions.reduce((acc, p) => {
    acc.face += p.face_value;
    acc.principal += p.principal_balance;
    acc.accrued += p.accrued_interest;
    acc.current += p.current_value;
    return acc;
  }, { face: 0, principal: 0, accrued: 0, current: 0 });
  return {
    count: positions.length,
    total_face_value: round2(totals.face),
    total_principal_balance: round2(totals.principal),
    total_accrued_interest: round2(totals.accrued),
    total_current_value: round2(totals.current),
  };
}

class FixedIncomeDataService {
  /**
   * Canonical bond positions. Active bonds by default; pass
   * `{ status: 'all' }` for every bond regardless of status.
   */
  static async listPositions({ status = 'active' } = {}) {
    const where = status === 'all' ? '' : ` WHERE COALESCE(b.status, 'active') = $1`;
    const params = status === 'all' ? [] : [status];
    const res = await pool.query(`${POSITION_SELECT}${where} ORDER BY b.id`, params);
    return (res.rows || []).map(normalizePosition);
  }

  static async getPosition(bondIdOrRef) {
    const asInt = Number(bondIdOrRef);
    const res = Number.isInteger(asInt) && String(bondIdOrRef).trim() === String(asInt)
      ? await pool.query(`${POSITION_SELECT} WHERE b.id = $1`, [asInt])
      : await pool.query(`${POSITION_SELECT} WHERE b.bond_name = $1 OR b.isin = $1 OR b.bond_identifier = $1 LIMIT 1`, [String(bondIdOrRef)]);
    return res.rows && res.rows[0] ? normalizePosition(res.rows[0]) : null;
  }

  /** Portfolio totals over active positions — the one number every module should agree on. */
  static async getPortfolioTotals({ status = 'active' } = {}) {
    const positions = await FixedIncomeDataService.listPositions({ status });
    return { ...sumPositions(positions), as_of: new Date().toISOString() };
  }

  /** Tokenized supply per bond from the thirdweb / bond_tokens ledger. Empty when tokenization is not provisioned. */
  static async getTokenization(positions) {
    let rows = [];
    try {
      const res = await pool.query(
        `SELECT id, bond_id, token_name, token_symbol, token_address, total_supply,
                tokenized_principal, tokenized_interest, status, metadata, updated_at
           FROM bond_tokens
          ORDER BY created_at DESC`
      );
      rows = res.rows || [];
    } catch (e) {
      return { available: false, reason: e.message, tokens: [], by_bond: {}, excluded: { module_tokens: [], inactive_tokens: [] } };
    }
    let classify = () => 'on_chain';
    try {
      const { BondTokenizationEngine } = require('../dapp/bondTokenizationEngine');
      classify = (t) => BondTokenizationEngine.classifyToken(t);
    } catch (e) { /* tokenization engine unavailable: treat every address as on-chain */ }

    const byBond = {};
    const excluded = { module_tokens: [], inactive_tokens: [] };
    for (const t of rows) {
      const placement = classify(t);
      const entry = {
        id: t.id,
        bond_id: t.bond_id == null ? null : Number(t.bond_id),
        token_name: t.token_name,
        token_symbol: t.token_symbol,
        token_address: t.token_address || null,
        on_chain: placement === 'on_chain',
        placement,
        total_supply: Number(t.total_supply || 0),
        tokenized_principal: Number(t.tokenized_principal || 0),
        tokenized_interest: Number(t.tokenized_interest || 0),
        status: t.status,
        updated_at: t.updated_at || null,
      };
      // Only live contracts on the deployed chain, still active and standing on
      // a bond, are claims against that bond's principal. Module/stablecoin
      // tokens with no bond and testnet or retired rows are reported, not counted.
      if (t.status !== 'active' || placement !== 'on_chain') { excluded.inactive_tokens.push(entry); continue; }
      if (t.bond_id == null) { excluded.module_tokens.push(entry); continue; }

      const key = String(t.bond_id);
      if (!byBond[key]) byBond[key] = { tokens: [], tokenized_principal: 0, tokenized_interest: 0, total_supply: 0 };
      byBond[key].tokens.push(entry);
      byBond[key].tokenized_principal = round2(byBond[key].tokenized_principal + entry.tokenized_principal);
      byBond[key].tokenized_interest = round2(byBond[key].tokenized_interest + entry.tokenized_interest);
      byBond[key].total_supply += entry.total_supply;
    }
    for (const p of positions || []) {
      const entry = byBond[String(p.id)];
      if (!entry) continue;
      entry.coverage_pct = p.principal_balance > 0 ? round2((entry.tokenized_principal / p.principal_balance) * 100) : 0;
      entry.untokenized_principal = round2(p.principal_balance - entry.tokenized_principal);
    }
    return { available: true, tokens: rows.length, by_bond: byBond, excluded };
  }

  /**
   * Ledger holders (bond_token_holders) against chain holders (thirdweb
   * indexing) for every bond-backed on-chain token. Pseudo-holders such as
   * 'treasury' have no address and are reported as unaddressed rather than
   * compared. Returns `available: false` (never throws) when thirdweb cannot be
   * asked, so the snapshot still renders without it.
   */
  static async getHolderReconciliation(tokenization) {
    const tokens = Object.values((tokenization && tokenization.by_bond) || {}).flatMap((e) => e.tokens);
    if (!tokens.length) return { available: true, tokens: [], discrepancies: [] };
    let ThirdwebServerWalletEngine;
    let BondTokenizationEngine;
    try {
      ({ ThirdwebServerWalletEngine } = require('../dapp/thirdwebServerWalletEngine'));
      ({ BondTokenizationEngine } = require('../dapp/bondTokenizationEngine'));
    } catch (e) {
      return { available: false, reason: e.message, tokens: [], discrepancies: [] };
    }
    if (!ThirdwebServerWalletEngine.getConfig().secretKey) {
      return { available: false, reason: 'THIRDWEB_SECRET_KEY not configured', tokens: [], discrepancies: [] };
    }
    const out = [];
    const discrepancies = [];
    for (const t of tokens) {
      let chain;
      try {
        chain = await ThirdwebServerWalletEngine.tokenOwners({ tokenAddress: t.token_address });
      } catch (e) {
        out.push({ id: t.id, token_symbol: t.token_symbol, error: e.message });
        continue;
      }
      const decimals = Number((await BondTokenizationEngine.getToken(t.id).catch(() => null) || {}).metadata?.decimals || 6);
      const ledger = await BondTokenizationEngine.getHoldings(t.id).catch(() => []);
      const ledgerByAddr = new Map();
      const unaddressed = [];
      for (const h of ledger) {
        const addr = String(h.holder_address || '');
        if (/^0x[0-9a-fA-F]{40}$/.test(addr)) ledgerByAddr.set(addr.toLowerCase(), round2(Number(h.balance || 0)));
        else unaddressed.push({ holder: addr, balance: round2(Number(h.balance || 0)) });
      }
      const chainByAddr = new Map(chain.owners.map((o) => [o.address.toLowerCase(), fromBaseUnits(o.amount, decimals)]));
      const holders = [];
      for (const addr of new Set([...ledgerByAddr.keys(), ...chainByAddr.keys()])) {
        const ledgerBal = ledgerByAddr.get(addr) || 0;
        const chainBal = chainByAddr.get(addr) || 0;
        const row = { address: addr, ledger_balance: ledgerBal, chain_balance: chainBal, delta: round2(chainBal - ledgerBal) };
        holders.push(row);
        if (Math.abs(row.delta) > 0.005) {
          discrepancies.push({ bond_id: t.bond_id, token_id: t.id, type: 'holder_balance_mismatch', address: addr, ledger_balance: ledgerBal, chain_balance: chainBal });
        }
      }
      out.push({ id: t.id, bond_id: t.bond_id, token_symbol: t.token_symbol, token_address: t.token_address, chain_holder_count: chain.owners.length, complete: chain.complete, holders, unaddressed });
    }
    return { available: true, tokens: out, discrepancies };
  }

  static platformStatus() {
    const platforms = { dlbtrust: { source_of_truth: 'postgres:bonds+bond_balances', ok: true } };
    try {
      const { ThirdwebServerWalletEngine } = require('../dapp/thirdwebServerWalletEngine');
      platforms.thirdweb = ThirdwebServerWalletEngine.readiness();
    } catch (e) {
      platforms.thirdweb = { ready: false, issues: [e.message] };
    }
    try {
      const { BondTokenizationEngine } = require('../dapp/bondTokenizationEngine');
      platforms.tokenization = BondTokenizationEngine.readiness();
    } catch (e) {
      platforms.tokenization = { ready: false, issues: [e.message] };
    }
    const nfProject = process.env.NORTHFLANK_PROJECT_ID || process.env.NF_PROJECT_ID || null;
    const nfService = process.env.NF_SERVICE_ID || process.env.NORTHFLANK_SERVICE_ID || null;
    platforms.northflank = {
      deployed: Boolean(nfProject || nfService),
      project_id: nfProject,
      service_id: nfService,
      region: process.env.NF_REGION || process.env.NORTHFLANK_REGION || null,
      api_token_configured: Boolean(process.env.NORTHFLANK_API_TOKEN),
    };
    return platforms;
  }

  /**
   * One payload for every dashboard and workflow: ledger positions and
   * totals, live market metrics, tokenization coverage and platform status.
   */
  static async getUnifiedSnapshot({ includeLive = true, includeHolders = false } = {}) {
    const positions = await FixedIncomeDataService.listPositions();
    const totals = sumPositions(positions);
    const tokenization = await FixedIncomeDataService.getTokenization(positions);
    const holders = includeHolders ? await FixedIncomeDataService.getHolderReconciliation(tokenization) : null;

    let live = null;
    if (includeLive) {
      try {
        const { LiveBondEngine } = require('./liveEngine');
        live = await LiveBondEngine.getPortfolioSnapshot();
      } catch (e) {
        live = { error: e.message };
      }
    }

    const liveById = new Map((live && Array.isArray(live.bonds) ? live.bonds : []).map((m) => [Number(m.bond_id != null ? m.bond_id : m.id), m]));
    const bonds = positions.map((p) => ({
      ...p,
      tokenization: tokenization.by_bond[String(p.id)] || null,
      live: liveById.get(Number(p.id)) || null,
    }));

    const discrepancies = [];
    for (const b of bonds) {
      if (b.tokenization && b.tokenization.tokenized_principal > b.principal_balance + 0.005) {
        discrepancies.push({ bond_id: b.id, type: 'tokenized_exceeds_principal', tokenized_principal: b.tokenization.tokenized_principal, principal_balance: b.principal_balance });
      }
      if (b.live && Math.abs(Number(b.live.face_value || 0) - b.face_value) > 0.005) {
        discrepancies.push({ bond_id: b.id, type: 'live_face_value_mismatch', live_face_value: Number(b.live.face_value), face_value: b.face_value });
      }
    }
    if (holders) discrepancies.push(...holders.discrepancies);

    return {
      source_of_truth: 'postgres:bonds+bond_balances',
      totals,
      bonds,
      live: live && !live.error ? {
        total_market_value: live.total_market_value,
        total_accrued_interest: live.total_accrued_interest,
        total_current_value: live.total_current_value,
        total_daily_accrual: live.total_daily_accrual,
        total_annual_income: live.total_annual_income,
        weighted_avg_coupon_pct: live.weighted_avg_coupon_pct,
        weighted_avg_ytm_pct: live.weighted_avg_ytm_pct,
        weighted_avg_modified_duration: live.weighted_avg_modified_duration,
        total_dv01: live.total_dv01,
        generated_at: live.generated_at,
      } : live,
      tokenization: {
        available: tokenization.available,
        reason: tokenization.reason,
        tokens: tokenization.tokens,
        total_tokenized_principal: round2(Object.values(tokenization.by_bond).reduce((s, e) => s + e.tokenized_principal, 0)),
        coverage_pct: totals.total_principal_balance > 0
          ? round2((Object.values(tokenization.by_bond).reduce((s, e) => s + e.tokenized_principal, 0) / totals.total_principal_balance) * 100)
          : 0,
        module_tokens: (tokenization.excluded || { module_tokens: [] }).module_tokens.map((t) => ({
          id: t.id, token_symbol: t.token_symbol, token_address: t.token_address, total_supply: t.total_supply,
        })),
        inactive_tokens: (tokenization.excluded || { inactive_tokens: [] }).inactive_tokens.length,
      },
      holders,
      platforms: FixedIncomeDataService.platformStatus(),
      discrepancies,
      generated_at: new Date().toISOString(),
    };
  }
}

module.exports = { FixedIncomeDataService, normalizePosition, sumPositions };
