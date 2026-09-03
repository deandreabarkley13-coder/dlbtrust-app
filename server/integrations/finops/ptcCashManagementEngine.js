'use strict';

/**
 * PTC Digital Cash Management Account (CMA)
 *
 * One liquidity-managed account for the Private Trust Company, built on top of
 * the corporate treasury ledger. A CMA owns three sub-ledgers (all
 * corporate_treasury_accounts rows) and a liquidity policy:
 *
 *   operating          day-to-day cash; kept between policy.minOperating and policy.maxOperating
 *   liquidity_reserve  ring-fenced buffer sized as reserveRatioBps of total CMA cash
 *   investment_sweep   excess cash swept into short-term instruments (MMF / T-bill)
 *
 * rebalance() moves cash between the sub-ledgers to satisfy the policy, using
 * CorporateTreasuryEngine transactions (type 'sweep'/'transfer'). Funding and
 * disbursement across bank rails are routed, never simulated:
 *   wire      → WireEngine.initiateWire (approval + reserve checks apply)
 *   ach_lili  → LiliDirectDepositEngine.createDirectDeposit (queued until an ODFI exists)
 *   internal  → ledger movement only
 * Linked bank balances (Lili via MCP) are read for the liquidity picture but
 * never mutated.
 */

const pool = require('../bonds/pgPool');
const { CorporateTreasuryEngine } = require('./corporateTreasuryEngine');

let WireEngine;
try { ({ WireEngine } = require('../wire/wireEngine')); } catch (e) { WireEngine = null; }
let LiliMcpEngine;
try { ({ LiliMcpEngine } = require('../payments/liliMcpEngine')); } catch (e) { LiliMcpEngine = null; }
let LiliDirectDepositEngine;
try { ({ LiliDirectDepositEngine } = require('../payments/liliDirectDepositEngine')); } catch (e) { LiliDirectDepositEngine = null; }

const SUB_LEDGERS = ['operating', 'liquidity_reserve', 'investment_sweep'];
const RAILS = ['wire', 'ach_lili', 'internal'];

function id(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}
function toCents(v) { return Math.round((Number(v) || 0) * 100); }
function dollars(c) { return Number(c || 0) / 100; }
function cents(opts, centsKey, dollarKey, dflt = 0) {
  if (opts[centsKey] !== undefined && opts[centsKey] !== null) return Math.round(Number(opts[centsKey]));
  if (opts[dollarKey] !== undefined && opts[dollarKey] !== null) return toCents(opts[dollarKey]);
  return dflt;
}

const DEFAULT_POLICY = {
  minOperatingCents: 25000000,      // $250k floor
  targetOperatingCents: 50000000,   // $500k target
  maxOperatingCents: 100000000,     // $1M ceiling → sweep excess
  reserveRatioBps: 1000,            // 10% of CMA cash held in liquidity reserve
  minCoverageDays: 30,              // operating + reserve must cover N days of forecast outflows
  sweepInstrument: 'mmf',
  sweepYieldBps: 450,
  autoRebalance: true,
};

class PtcCashManagementEngine {
  static async ensureTables() {
    await CorporateTreasuryEngine.ensureTables();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ptc_cma_accounts (
        cma_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        ptc_entity_id TEXT NOT NULL DEFAULT 'PTC-DLB-TRUST',
        trust_id TEXT NOT NULL DEFAULT 'TRUST-DLB-001',
        currency TEXT NOT NULL DEFAULT 'USD',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','closed')),
        operating_account_id TEXT NOT NULL REFERENCES corporate_treasury_accounts(account_id),
        reserve_account_id TEXT NOT NULL REFERENCES corporate_treasury_accounts(account_id),
        sweep_account_id TEXT NOT NULL REFERENCES corporate_treasury_accounts(account_id),
        linked_bank JSONB NOT NULL DEFAULT '{}',
        policy JSONB NOT NULL DEFAULT '{}',
        created_by TEXT NOT NULL DEFAULT 'system',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ptc_cma_movements (
        movement_id TEXT PRIMARY KEY,
        cma_id TEXT NOT NULL REFERENCES ptc_cma_accounts(cma_id),
        kind TEXT NOT NULL CHECK (kind IN ('rebalance','funding','disbursement','allocation')),
        rail TEXT NOT NULL DEFAULT 'internal',
        direction TEXT NOT NULL CHECK (direction IN ('in','out','internal')),
        from_ledger TEXT,
        to_ledger TEXT,
        amount_cents BIGINT NOT NULL,
        status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending','completed','failed','cancelled')),
        treasury_txn_id TEXT,
        external_ref TEXT,
        reason TEXT,
        metadata JSONB NOT NULL DEFAULT '{}',
        created_by TEXT NOT NULL DEFAULT 'system',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ptc_cma_liquidity_snapshots (
        id SERIAL PRIMARY KEY,
        cma_id TEXT NOT NULL REFERENCES ptc_cma_accounts(cma_id),
        snapshot JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ptc_cma_mov_cma ON ptc_cma_movements(cma_id, created_at DESC)');
  }

  static normalizePolicy(input = {}, base = DEFAULT_POLICY) {
    const p = {
      ...base,
      minOperatingCents: cents(input, 'minOperatingCents', 'minOperating', base.minOperatingCents),
      targetOperatingCents: cents(input, 'targetOperatingCents', 'targetOperating', base.targetOperatingCents),
      maxOperatingCents: cents(input, 'maxOperatingCents', 'maxOperating', base.maxOperatingCents),
      reserveRatioBps: input.reserveRatioBps !== undefined ? Number(input.reserveRatioBps) : base.reserveRatioBps,
      minCoverageDays: input.minCoverageDays !== undefined ? Number(input.minCoverageDays) : base.minCoverageDays,
      sweepInstrument: input.sweepInstrument || base.sweepInstrument,
      sweepYieldBps: input.sweepYieldBps !== undefined ? Number(input.sweepYieldBps) : base.sweepYieldBps,
      autoRebalance: input.autoRebalance !== undefined ? Boolean(input.autoRebalance) : base.autoRebalance,
    };
    if (p.minOperatingCents < 0 || p.targetOperatingCents < p.minOperatingCents || p.maxOperatingCents < p.targetOperatingCents) {
      throw new Error('policy requires 0 <= minOperating <= targetOperating <= maxOperating');
    }
    if (p.reserveRatioBps < 0 || p.reserveRatioBps > 10000) throw new Error('reserveRatioBps must be 0..10000');
    if (!['mmf', 't_bill', 'repo', 'term_deposit'].includes(p.sweepInstrument)) throw new Error('sweepInstrument must be mmf, t_bill, repo or term_deposit');
    return p;
  }

  // ── Provisioning ────────────────────────────────────────────────────────

  static async provision({
    cmaId, name = 'PTC Digital Cash Management Account', ptcEntityId = 'PTC-DLB-TRUST', trustId = 'TRUST-DLB-001',
    currency = 'USD', policy = {}, linkedBank = {}, operatingLinkedSource, openingBalanceCents, createdBy = 'system',
  } = {}) {
    await this.ensureTables();
    const pol = this.normalizePolicy(policy);
    const cma = cmaId || id('CMA');
    const mk = (suffix, category, extra = {}) => CorporateTreasuryEngine.createAccount({
      accountId: `${cma}-${suffix}`, name: `${name} — ${suffix}`, type: 'internal', category, currency, ptcEntityId, trustId,
      metadata: { cmaId: cma, subLedger: suffix }, ...extra,
    });
    const operating = await mk('operating', 'operating', {
      targetBalance: dollars(pol.targetOperatingCents),
      ...(operatingLinkedSource ? { linkedSourceType: operatingLinkedSource.type, linkedSourceId: operatingLinkedSource.id } : {}),
    });
    const reserve = await mk('liquidity_reserve', 'reserve', { segregationLevel: 'liquidity_buffer' });
    const sweep = await mk('investment_sweep', 'investment');

    const bank = {
      provider: linkedBank.provider || (LiliMcpEngine ? 'lili' : ''),
      accountName: linkedBank.accountName || 'DB NET MGMT LLC',
      routingNumber: linkedBank.routingNumber || '',
      accountNumberMasked: linkedBank.accountNumber ? `****${String(linkedBank.accountNumber).slice(-4)}` : (linkedBank.accountNumberMasked || ''),
      businessUserId: linkedBank.businessUserId || '',
    };

    await pool.query(
      `INSERT INTO ptc_cma_accounts (cma_id, name, ptc_entity_id, trust_id, currency, operating_account_id, reserve_account_id, sweep_account_id, linked_bank, policy, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [cma, name, ptcEntityId, trustId, currency, operating.account_id, reserve.account_id, sweep.account_id, JSON.stringify(bank), JSON.stringify(pol), createdBy]
    );

    if (openingBalanceCents && Number(openingBalanceCents) > 0) {
      await this.recordFunding(cma, { rail: 'internal', direction: 'in', amountCents: Number(openingBalanceCents), toLedger: 'operating', reason: 'Opening balance', createdBy });
      if (pol.autoRebalance) await this.rebalance(cma, { actor: createdBy });
    }
    return this.getAccount(cma);
  }

  static async _row(cmaId) {
    const r = await pool.query('SELECT * FROM ptc_cma_accounts WHERE cma_id=$1', [cmaId]);
    return r.rows[0] || null;
  }

  static async getAccount(cmaId) {
    const row = await this._row(cmaId);
    if (!row) return null;
    return { ...row, position: await this.getPosition(cmaId, row) };
  }

  static async listAccounts() {
    await this.ensureTables();
    const r = await pool.query('SELECT * FROM ptc_cma_accounts ORDER BY created_at');
    return r.rows;
  }

  static async updatePolicy(cmaId, policy = {}, updatedBy = 'system') {
    const row = await this._row(cmaId);
    if (!row) throw new Error('CMA not found');
    const pol = this.normalizePolicy(policy, { ...DEFAULT_POLICY, ...(row.policy || {}) });
    await pool.query('UPDATE ptc_cma_accounts SET policy=$1, updated_at=NOW() WHERE cma_id=$2', [JSON.stringify(pol), cmaId]);
    await CorporateTreasuryEngine.updateAccount(row.operating_account_id, { target_balance_cents: pol.targetOperatingCents });
    return this.getAccount(cmaId);
  }

  static async setStatus(cmaId, status) {
    if (!['active', 'frozen', 'closed'].includes(status)) throw new Error('status must be active, frozen or closed');
    await pool.query('UPDATE ptc_cma_accounts SET status=$1, updated_at=NOW() WHERE cma_id=$2', [status, cmaId]);
    return this.getAccount(cmaId);
  }

  // ── Sub-ledger helpers ──────────────────────────────────────────────────

  static _ledgerAccountId(row, ledger) {
    if (ledger === 'operating') return row.operating_account_id;
    if (ledger === 'liquidity_reserve') return row.reserve_account_id;
    if (ledger === 'investment_sweep') return row.sweep_account_id;
    throw new Error(`unknown sub-ledger '${ledger}' (expected ${SUB_LEDGERS.join('|')})`);
  }

  static async _adjust(accountId, deltaCents) {
    await pool.query(
      `UPDATE corporate_treasury_accounts SET balance_cents = balance_cents + $1, available_cents = available_cents + $1, updated_at = NOW() WHERE account_id = $2`,
      [deltaCents, accountId]
    );
  }

  static async _move(row, fromLedger, toLedger, amountCents, { kind = 'rebalance', reason = '', createdBy = 'system', metadata = {} } = {}) {
    if (amountCents <= 0) return null;
    const fromId = this._ledgerAccountId(row, fromLedger);
    const toId = this._ledgerAccountId(row, toLedger);
    const from = await CorporateTreasuryEngine.getAccount(fromId);
    if (!from || Number(from.available_cents) < amountCents) throw new Error(`Insufficient ${fromLedger} balance for ${dollars(amountCents)}`);
    const txn = await CorporateTreasuryEngine.createTransaction({
      type: kind === 'rebalance' ? 'sweep' : 'transfer', fromAccountId: fromId, toAccountId: toId, amountCents, currency: row.currency,
      referenceId: row.cma_id, description: reason || `CMA ${fromLedger} → ${toLedger}`, status: 'completed', metadata: { cmaId: row.cma_id, ...metadata },
    });
    await this._adjust(fromId, -amountCents);
    await this._adjust(toId, amountCents);
    return this._record(row.cma_id, { kind, rail: 'internal', direction: 'internal', fromLedger, toLedger, amountCents, treasuryTxnId: txn.transaction_id, reason, createdBy, metadata });
  }

  static async _record(cmaId, { kind, rail = 'internal', direction, fromLedger = null, toLedger = null, amountCents, status = 'completed', treasuryTxnId = null, externalRef = null, reason = null, createdBy = 'system', metadata = {} }) {
    const movementId = id('CMM');
    await pool.query(
      `INSERT INTO ptc_cma_movements (movement_id, cma_id, kind, rail, direction, from_ledger, to_ledger, amount_cents, status, treasury_txn_id, external_ref, reason, metadata, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [movementId, cmaId, kind, rail, direction, fromLedger, toLedger, amountCents, status, treasuryTxnId, externalRef, reason, JSON.stringify(metadata), createdBy]
    );
    return { movementId, cmaId, kind, rail, direction, fromLedger, toLedger, amountCents, amountUsd: dollars(amountCents), status, treasuryTxnId, externalRef, reason };
  }

  // ── Liquidity position ──────────────────────────────────────────────────

  static async getLinkedBankBalance(row) {
    const bank = row.linked_bank || {};
    if (bank.provider !== 'lili' || !LiliMcpEngine) return { provider: bank.provider || null, available: false, balanceCents: 0 };
    try {
      const cfg = await LiliMcpEngine.getPublicConfig();
      if (!cfg.configured) return { provider: 'lili', available: false, balanceCents: 0, reason: 'Lili MCP not connected' };
      const summary = await LiliMcpEngine.getAccountSummary(bank.businessUserId || undefined);
      const bal = summary && (summary.availableBalance ?? summary.balance ?? summary.currentBalance);
      const balanceCents = bal != null ? Math.round(Number(bal) * 100) : (summary && summary.availableBalanceCents != null ? Number(summary.availableBalanceCents) : 0);
      return { provider: 'lili', available: true, balanceCents, accountName: bank.accountName, accountNumberMasked: summary && summary.accountNumberMasked || bank.accountNumberMasked, asOf: new Date().toISOString() };
    } catch (e) {
      return { provider: 'lili', available: false, balanceCents: 0, reason: e.message };
    }
  }

  static async getPosition(cmaId, row) {
    row = row || await this._row(cmaId);
    if (!row) throw new Error('CMA not found');
    const pol = { ...DEFAULT_POLICY, ...(row.policy || {}) };
    const [op, rs, sw] = await Promise.all([
      CorporateTreasuryEngine.getAccount(row.operating_account_id),
      CorporateTreasuryEngine.getAccount(row.reserve_account_id),
      CorporateTreasuryEngine.getAccount(row.sweep_account_id),
    ]);
    const ledgers = {
      operating: Number(op && op.available_cents || 0),
      liquidity_reserve: Number(rs && rs.available_cents || 0),
      investment_sweep: Number(sw && sw.available_cents || 0),
    };
    const totalCents = ledgers.operating + ledgers.liquidity_reserve + ledgers.investment_sweep;
    const liquidCents = ledgers.operating + ledgers.liquidity_reserve;

    const horizon = Math.max(1, pol.minCoverageDays);
    const flows = await CorporateTreasuryEngine.listCashFlows({ fromDate: new Date().toISOString().slice(0, 10), toDate: CorporateTreasuryEngine._addDays(horizon) });
    const cmaAccountIds = new Set([row.operating_account_id, row.reserve_account_id, row.sweep_account_id]);
    const scoped = flows.filter(f => f.status !== 'cancelled' && (!f.account_id || cmaAccountIds.has(f.account_id)));
    const outflowsCents = scoped.filter(f => f.type === 'outflow').reduce((s, f) => s + Number(f.amount_cents || 0), 0);
    const inflowsCents = scoped.filter(f => f.type === 'inflow').reduce((s, f) => s + Number(f.amount_cents || 0), 0);
    const dailyBurnCents = outflowsCents / horizon;
    const coverageDays = dailyBurnCents > 0 ? Math.floor(liquidCents / dailyBurnCents) : null;
    const coverageRatio = outflowsCents > 0 ? liquidCents / outflowsCents : null;
    const requiredReserveCents = Math.round(totalCents * pol.reserveRatioBps / 10000);

    const bank = await this.getLinkedBankBalance(row);

    const alerts = [];
    if (ledgers.operating < pol.minOperatingCents) alerts.push({ level: 'critical', code: 'OPERATING_BELOW_MIN', message: `Operating ${dollars(ledgers.operating)} below floor ${dollars(pol.minOperatingCents)}` });
    if (ledgers.operating > pol.maxOperatingCents) alerts.push({ level: 'info', code: 'OPERATING_ABOVE_MAX', message: `Operating ${dollars(ledgers.operating)} above ceiling ${dollars(pol.maxOperatingCents)} — excess sweepable` });
    if (ledgers.liquidity_reserve < requiredReserveCents) alerts.push({ level: 'warning', code: 'RESERVE_SHORTFALL', message: `Reserve ${dollars(ledgers.liquidity_reserve)} below required ${dollars(requiredReserveCents)}` });
    if (coverageDays !== null && coverageDays < pol.minCoverageDays) alerts.push({ level: 'warning', code: 'COVERAGE_SHORT', message: `Liquid cash covers ${coverageDays}d of forecast outflows (< ${pol.minCoverageDays}d)` });
    if (bank.available && bank.balanceCents < ledgers.operating) alerts.push({ level: 'warning', code: 'BANK_BELOW_LEDGER', message: `Linked ${bank.provider} balance ${dollars(bank.balanceCents)} is below ledger operating ${dollars(ledgers.operating)}` });

    const snapshot = {
      cmaId: row.cma_id, status: row.status, currency: row.currency, policy: pol,
      ledgers, ledgersUsd: Object.fromEntries(Object.entries(ledgers).map(([k, v]) => [k, dollars(v)])),
      totalCents, totalUsd: dollars(totalCents), liquidCents, liquidUsd: dollars(liquidCents),
      requiredReserveCents, excessOperatingCents: Math.max(0, ledgers.operating - pol.maxOperatingCents),
      operatingShortfallCents: Math.max(0, pol.minOperatingCents - ledgers.operating),
      forecast: { horizonDays: horizon, inflowsCents, outflowsCents, dailyBurnCents: Math.round(dailyBurnCents), coverageDays, coverageRatio },
      linkedBank: bank, alerts, health: alerts.some(a => a.level === 'critical') ? 'critical' : alerts.some(a => a.level === 'warning') ? 'warning' : 'healthy',
    };
    await pool.query('INSERT INTO ptc_cma_liquidity_snapshots (cma_id, snapshot) VALUES ($1,$2)', [row.cma_id, JSON.stringify(snapshot)]).catch(() => {});
    return snapshot;
  }

  // ── Rebalance (policy-driven sweep) ─────────────────────────────────────

  /** Compute the moves needed to bring sub-ledgers in line with the policy. Pure function of a position. */
  static planRebalance(position) {
    const pol = position.policy;
    const L = { ...position.ledgers };
    const moves = [];
    const push = (from, to, amount, reason) => { amount = Math.floor(amount); if (amount > 0) { moves.push({ fromLedger: from, toLedger: to, amountCents: amount, reason }); L[from] -= amount; L[to] += amount; } };

    const total = L.operating + L.liquidity_reserve + L.investment_sweep;
    const requiredReserve = Math.round(total * pol.reserveRatioBps / 10000);

    // 1. Operating floor: pull from sweep first, then reserve.
    if (L.operating < pol.minOperatingCents) {
      const need = pol.targetOperatingCents - L.operating;
      push('investment_sweep', 'operating', Math.min(need, L.investment_sweep), 'Restore operating to target from investment sweep');
      if (L.operating < pol.minOperatingCents) push('liquidity_reserve', 'operating', Math.min(pol.minOperatingCents - L.operating, L.liquidity_reserve), 'Restore operating floor from liquidity reserve');
    }
    // 2. Reserve requirement: top up from operating excess over target, then from sweep.
    if (L.liquidity_reserve < requiredReserve) {
      const need = requiredReserve - L.liquidity_reserve;
      push('operating', 'liquidity_reserve', Math.min(need, Math.max(0, L.operating - pol.targetOperatingCents)), 'Fund liquidity reserve from operating');
      if (L.liquidity_reserve < requiredReserve) push('investment_sweep', 'liquidity_reserve', Math.min(requiredReserve - L.liquidity_reserve, L.investment_sweep), 'Fund liquidity reserve from investment sweep');
    } else if (L.liquidity_reserve > requiredReserve) {
      push('liquidity_reserve', 'investment_sweep', L.liquidity_reserve - requiredReserve, 'Release excess reserve to investment sweep');
    }
    // 3. Coverage: liquid cash (operating + reserve) must cover minCoverageDays of forecast outflows.
    const burn = position.forecast && Number(position.forecast.dailyBurnCents) || 0;
    const requiredLiquid = Math.ceil(burn * pol.minCoverageDays);
    const liquid = L.operating + L.liquidity_reserve;
    if (liquid < requiredLiquid) push('investment_sweep', 'operating', Math.min(requiredLiquid - liquid, L.investment_sweep), `Unwind sweep to cover ${pol.minCoverageDays}d of forecast outflows`);
    // 4. Operating ceiling: sweep excess into investments, down to target (or the coverage floor if higher).
    const sweepFloor = Math.max(pol.targetOperatingCents, requiredLiquid - L.liquidity_reserve);
    if (L.operating > pol.maxOperatingCents && L.operating > sweepFloor) push('operating', 'investment_sweep', L.operating - sweepFloor, 'Sweep excess operating cash to investments');

    return { moves, projected: L, requiredReserveCents: requiredReserve, requiredLiquidCents: requiredLiquid };
  }

  static async rebalance(cmaId, { actor = 'system', dryRun = false } = {}) {
    const row = await this._row(cmaId);
    if (!row) throw new Error('CMA not found');
    if (row.status !== 'active') throw new Error(`CMA is ${row.status}`);
    const before = await this.getPosition(cmaId, row);
    const plan = this.planRebalance(before);
    if (dryRun) return { cmaId, dryRun: true, plan, before };

    const executed = [];
    for (const m of plan.moves) {
      executed.push(await this._move(row, m.fromLedger, m.toLedger, m.amountCents, { kind: 'rebalance', reason: m.reason, createdBy: actor }));
    }
    let investment = null;
    const sweptIn = plan.moves.filter(m => m.toLedger === 'investment_sweep').reduce((s, m) => s + m.amountCents, 0);
    if (sweptIn > 0) {
      investment = await CorporateTreasuryEngine.createInvestment({
        type: before.policy.sweepInstrument, accountId: row.sweep_account_id, counterparty: 'CMA sweep', amount: dollars(sweptIn),
        yieldBps: before.policy.sweepYieldBps, metadata: { cmaId, source: 'ptc_cma_rebalance' },
      });
    }
    return { cmaId, moves: executed, investment, before, after: await this.getPosition(cmaId, row) };
  }

  static async rebalanceAll({ actor = 'system' } = {}) {
    const rows = await this.listAccounts();
    const out = [];
    for (const r of rows) {
      const pol = { ...DEFAULT_POLICY, ...(r.policy || {}) };
      if (r.status !== 'active' || !pol.autoRebalance) continue;
      try { const res = await this.rebalance(r.cma_id, { actor }); out.push({ cmaId: r.cma_id, moves: res.moves.length }); }
      catch (e) { out.push({ cmaId: r.cma_id, error: e.message }); }
    }
    return out;
  }

  // ── Funding / disbursement across rails ─────────────────────────────────

  /**
   * Cash coming INTO the CMA. `internal`/`wire` inbound credits the ledger
   * immediately (wire-in is recorded as a confirmed inflow; the operator confirms
   * receipt). `ach_lili` inbound is not possible — Lili is only a destination.
   */
  static async recordFunding(cmaId, { rail = 'internal', direction = 'in', amountCents, amount, toLedger = 'operating', reason = '', externalRef = null, expectedDate, createdBy = 'system' } = {}) {
    const row = await this._row(cmaId);
    if (!row) throw new Error('CMA not found');
    if (row.status !== 'active') throw new Error(`CMA is ${row.status}`);
    if (direction !== 'in') throw new Error('recordFunding is for inbound cash; use disburse for outbound');
    if (!RAILS.includes(rail)) throw new Error(`rail must be one of ${RAILS.join(', ')}`);
    if (rail === 'ach_lili') throw new Error('ach_lili is an outbound rail (ACH credit into the Lili account); inbound funding from Lili is a wire or an internal transfer');
    const c = amountCents != null ? Math.round(Number(amountCents)) : toCents(amount);
    if (!Number.isFinite(c) || c <= 0) throw new Error('amount must be positive');
    const toId = this._ledgerAccountId(row, toLedger);

    if (rail === 'wire' && !externalRef) {
      const flow = await CorporateTreasuryEngine.createCashFlow({ type: 'inflow', accountId: toId, amount: dollars(c), expectedDate, status: 'confirmed', category: 'wire_in', description: reason || 'Expected incoming wire', metadata: { cmaId } });
      return this._record(cmaId, { kind: 'funding', rail, direction: 'in', toLedger, amountCents: c, status: 'pending', externalRef: flow.flow_id, reason: reason || 'Expected incoming wire (confirm with externalRef to post)', createdBy });
    }
    const txn = await CorporateTreasuryEngine.createTransaction({ type: 'deposit', toAccountId: toId, amountCents: c, currency: row.currency, referenceId: externalRef || cmaId, description: reason || `CMA funding via ${rail}`, status: 'completed', metadata: { cmaId, rail } });
    await this._adjust(toId, c);
    return this._record(cmaId, { kind: 'funding', rail, direction: 'in', toLedger, amountCents: c, treasuryTxnId: txn.transaction_id, externalRef, reason, createdBy, metadata: { rail } });
  }

  /**
   * Cash leaving the CMA. Debits the operating sub-ledger and hands off to the
   * real rail engine; the movement is `pending` until that rail settles.
   */
  static async disburse(cmaId, { rail, amountCents, amount, fromLedger = 'operating', reason = '', beneficiary = {}, memo, effectiveDate, createdBy = 'system' } = {}) {
    const row = await this._row(cmaId);
    if (!row) throw new Error('CMA not found');
    if (row.status !== 'active') throw new Error(`CMA is ${row.status}`);
    if (!RAILS.includes(rail)) throw new Error(`rail must be one of ${RAILS.join(', ')}`);
    const c = amountCents != null ? Math.round(Number(amountCents)) : toCents(amount);
    if (!Number.isFinite(c) || c <= 0) throw new Error('amount must be positive');

    const pos = await this.getPosition(cmaId, row);
    if (fromLedger === 'operating' && pos.ledgers.operating - c < pos.policy.minOperatingCents) {
      const plan = this.planRebalance({ ...pos, ledgers: { ...pos.ledgers, operating: pos.ledgers.operating - c } });
      const canCover = plan.projected.operating >= pos.policy.minOperatingCents;
      if (!canCover) throw new Error(`Disbursement of ${dollars(c)} would breach the operating floor ${dollars(pos.policy.minOperatingCents)} and cannot be covered from reserve/sweep`);
      for (const m of plan.moves.filter(m => m.toLedger === 'operating')) await this._move(row, m.fromLedger, m.toLedger, m.amountCents, { kind: 'rebalance', reason: `Pre-fund disbursement: ${m.reason}`, createdBy });
    }
    const fromId = this._ledgerAccountId(row, fromLedger);
    const from = await CorporateTreasuryEngine.getAccount(fromId);
    if (Number(from.available_cents) < c) throw new Error(`Insufficient ${fromLedger} balance`);

    let externalRef = null; let status = 'pending'; let external = null;
    if (rail === 'wire') {
      if (!WireEngine) throw new Error('Wire engine not available');
      external = await WireEngine.initiateWire({
        amountCents: c, beneficiaryName: beneficiary.name, beneficiaryRouting: beneficiary.routingNumber, beneficiaryAccount: beneficiary.accountNumber,
        beneficiaryBankName: beneficiary.bankName, purpose: reason || 'PTC CMA disbursement', description: memo || reason, paymentType: beneficiary.paymentType || 'vendor_payment',
        initiatedBy: createdBy, metadata: { cmaId, subLedger: fromLedger },
      });
      externalRef = external.wire_id || external.wireId || null;
    } else if (rail === 'ach_lili') {
      if (!LiliDirectDepositEngine) throw new Error('Lili direct deposit engine not available');
      external = await LiliDirectDepositEngine.createDirectDeposit({ amountCents: c, memo: memo || reason, effectiveDate, secCode: 'CCD', paymentType: beneficiary.paymentType || 'trust_distribution', createdBy });
      externalRef = external.deposit_id;
    } else {
      status = 'completed';
    }

    const txn = await CorporateTreasuryEngine.createTransaction({ type: rail === 'internal' ? 'withdrawal' : 'payment', fromAccountId: fromId, amountCents: c, currency: row.currency, referenceId: externalRef || cmaId, description: reason || `CMA disbursement via ${rail}`, status: status === 'completed' ? 'completed' : 'pending', metadata: { cmaId, rail, externalRef } });
    await this._adjust(fromId, -c);
    const movement = await this._record(cmaId, { kind: 'disbursement', rail, direction: 'out', fromLedger, amountCents: c, status, treasuryTxnId: txn.transaction_id, externalRef, reason, createdBy, metadata: { rail, beneficiary: beneficiary.name || null } });
    return { ...movement, external };
  }

  static async listMovements(cmaId, { limit = 50 } = {}) {
    const r = await pool.query('SELECT * FROM ptc_cma_movements WHERE cma_id=$1 ORDER BY created_at DESC LIMIT $2', [cmaId, Number(limit) || 50]);
    return r.rows.map(m => ({ ...m, amount_usd: dollars(m.amount_cents) }));
  }

  static async getLiquidityHistory(cmaId, { limit = 30 } = {}) {
    const r = await pool.query('SELECT snapshot, created_at FROM ptc_cma_liquidity_snapshots WHERE cma_id=$1 ORDER BY created_at DESC LIMIT $2', [cmaId, Number(limit) || 30]);
    return r.rows.map(x => ({ at: x.created_at, totalUsd: x.snapshot.totalUsd, liquidUsd: x.snapshot.liquidUsd, health: x.snapshot.health, coverageDays: x.snapshot.forecast && x.snapshot.forecast.coverageDays }));
  }

  static async getOverview() {
    const rows = await this.listAccounts();
    const accounts = [];
    for (const r of rows) accounts.push({ ...r, position: await this.getPosition(r.cma_id, r) });
    return {
      count: accounts.length,
      totalCents: accounts.reduce((s, a) => s + a.position.totalCents, 0),
      liquidCents: accounts.reduce((s, a) => s + a.position.liquidCents, 0),
      rails: { wire: Boolean(WireEngine), ach_lili: Boolean(LiliDirectDepositEngine), lili_balance_feed: Boolean(LiliMcpEngine) },
      subLedgers: SUB_LEDGERS,
      defaultPolicy: DEFAULT_POLICY,
      accounts,
    };
  }
}

module.exports = { PtcCashManagementEngine, DEFAULT_POLICY, SUB_LEDGERS, RAILS };
