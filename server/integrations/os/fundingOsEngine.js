'use strict';

/**
 * Funding OS Engine — the bridge between real money and the ledger.
 *
 * The dlb-treasury ledger records cash; it holds no dollars. Funding OS tracks how
 * real value enters (funding requests) and leaves (via Debt OS distribute-to-bank)
 * the platform, and only credits the ledger against a provider-side reference.
 *
 *   sources()          real-value source inventory (Credit OS funding sources + Lili
 *                      destination) with what each can do: fund the ledger, originate
 *                      a bank credit, or neither
 *   requestFunding()   maker step: intent to bring real money from a source into a
 *                      ledger account — status 'requested'
 *   approveFunding()   checker step (distinct approver) — 'approved'
 *   confirmFunding()   provider/bank reference required; posts CashEngine.deposit
 *                      into the target ledger account — 'confirmed'
 *   cancelFunding()
 *   pipeline()         open requests by status, unconfirmed exposure
 *   status()           sources + pipeline + unified path (fund → ledger → hold → bank)
 *
 * Nothing here moves money: a funding request is an instruction/record; a confirmation
 * is the ledger catching up to money that already arrived somewhere real.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

function tryRequire(mod) {
  try { return require(mod); } catch (e) { return null; }
}

async function settle(fn) {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: e.message }; }
}

const TABLE = 'funding_requests';
const TABLES = [TABLE, 'cash_accounts', 'cash_movements'];
const SOURCE_IDS = ['stripe_treasury', 'skrill', 'bank_odfi', 'manual_bank_deposit'];
const STATUSES = ['requested', 'approved', 'confirmed', 'cancelled'];

const toCents = (amount) => Math.round(Number(amount) * 100);
const newId = () => 'FUND-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();

class FundingOsEngine {
  static get engineName() { return 'funding-os'; }
  static get TABLES() { return TABLES; }
  static get SOURCE_IDS() { return SOURCE_IDS; }

  static async ensureTables() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        request_id        VARCHAR(64) PRIMARY KEY,
        source_id         VARCHAR(64) NOT NULL,
        to_account_id     VARCHAR(64) NOT NULL,
        amount_cents      BIGINT NOT NULL CHECK (amount_cents > 0),
        currency          VARCHAR(3) NOT NULL DEFAULT 'USD',
        status            VARCHAR(20) NOT NULL DEFAULT 'requested',
        memo              TEXT,
        requested_by      VARCHAR(255),
        approved_by       VARCHAR(255),
        confirmed_by      VARCHAR(255),
        external_ref      VARCHAR(255),
        ledger_movement_id VARCHAR(64),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_status ON ${TABLE}(status)`);
  }

  static async sources() {
    const Credit = tryRequire('./creditOsEngine')?.CreditOsEngine;
    const Lili = tryRequire('../payments/liliDirectDepositEngine')?.LiliDirectDepositEngine;
    const credit = Credit ? await settle(() => Credit.fundingSources()) : { ok: false, error: 'CreditOsEngine unavailable' };
    const dest = Lili ? await settle(() => Lili.getDestination()) : { ok: false, error: 'LiliDirectDepositEngine unavailable' };

    const sources = (credit.ok ? credit.value.sources : []).map(s => ({
      ...s,
      canFundLedger: s.id === 'stripe_treasury' ? s.realValueCapable : s.configured,
      canOriginateBankCredit: s.id === 'bank_odfi' ? s.realValueCapable : s.id === 'stripe_treasury' ? s.realValueCapable : false,
    }));
    sources.push({
      id: 'manual_bank_deposit',
      name: 'Manual deposit from a trust bank account',
      configured: true,
      mode: 'manual',
      realValueCapable: false,
      canFundLedger: true,
      canOriginateBankCredit: false,
      reason: 'operator deposits at the bank; ledger credited only on confirmFunding with the bank reference',
      secrets: [],
    });

    const destination = dest.ok
      ? { bank: 'Lili', configured: !!dest.value.configured, accountNumberMasked: dest.value.accountNumberMasked || null }
      : { bank: 'Lili', configured: false, error: dest.error };

    return {
      basis: 'configuration + provider readiness; balances are not queried here',
      sources,
      destination,
      anyRealValueCapable: sources.some(s => s.realValueCapable),
      realValueCapable: sources.filter(s => s.realValueCapable).map(s => s.id),
      creditError: credit.ok ? null : credit.error,
    };
  }

  static async requestFunding({ sourceId, toAccountId, amount, memo, requestedBy }) {
    if (!pool) throw new Error('ledger unavailable');
    if (!SOURCE_IDS.includes(sourceId)) throw new Error(`unknown funding source ${sourceId}; expected one of ${SOURCE_IDS.join(', ')}`);
    const cents = toCents(amount);
    if (!Number.isFinite(cents) || cents <= 0) throw new Error('amount must be positive');
    const acct = await pool.query(`SELECT account_id FROM cash_accounts WHERE account_id = $1 AND status = 'active'`, [toAccountId]);
    if (!acct.rows[0]) throw new Error(`cash account ${toAccountId} not found or not active`);
    const inv = await this.sources();
    const src = inv.sources.find(s => s.id === sourceId);
    if (!src.canFundLedger) throw new Error(`source ${sourceId} cannot fund the ledger: ${src.reason}`);
    await this.ensureTables();
    const r = await pool.query(
      `INSERT INTO ${TABLE} (request_id, source_id, to_account_id, amount_cents, memo, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [newId(), sourceId, toAccountId, cents, memo || null, requestedBy || null]
    );
    return this._row(r.rows[0]);
  }

  static async approveFunding({ requestId, approvedBy }) {
    const row = await this._get(requestId);
    if (row.status !== 'requested') throw new Error(`request ${requestId} is ${row.status}, not requested`);
    if (!approvedBy) throw new Error('approvedBy required');
    if (row.requested_by && row.requested_by === approvedBy) throw new Error('maker/checker: approver must differ from requester');
    const r = await pool.query(
      `UPDATE ${TABLE} SET status='approved', approved_by=$2, updated_at=NOW() WHERE request_id=$1 RETURNING *`,
      [requestId, approvedBy]
    );
    return this._row(r.rows[0]);
  }

  static async confirmFunding({ requestId, externalRef, amount, confirmedBy, dryRun = false }) {
    const row = await this._get(requestId);
    if (row.status !== 'approved') throw new Error(`request ${requestId} is ${row.status}, not approved`);
    if (!externalRef || !String(externalRef).trim()) throw new Error('externalRef (bank/provider transaction reference) required to confirm real funds');
    const cents = amount === undefined ? Number(row.amount_cents) : toCents(amount);
    if (!Number.isFinite(cents) || cents <= 0) throw new Error('amount must be positive');
    if (cents > Number(row.amount_cents)) throw new Error(`confirmed amount exceeds requested ${Number(row.amount_cents) / 100}`);
    if (dryRun) return { dryRun: true, request: this._row(row), wouldDeposit: { toAccountId: row.to_account_id, amount: cents / 100, externalRef } };

    const Cash = tryRequire('../cash/cashEngine')?.CashEngine;
    if (!Cash) throw new Error('CashEngine unavailable');
    const mov = await Cash.deposit({
      toAccountId: row.to_account_id,
      amountCents: cents,
      memo: `Funding ${row.request_id} from ${row.source_id} ref ${externalRef}`,
      referenceId: row.request_id,
      initiatedBy: confirmedBy || 'funding-os',
    });
    const r = await pool.query(
      `UPDATE ${TABLE} SET status='confirmed', confirmed_by=$2, external_ref=$3, amount_cents=$4, ledger_movement_id=$5, updated_at=NOW()
       WHERE request_id=$1 RETURNING *`,
      [requestId, confirmedBy || null, String(externalRef).trim(), cents, mov.movement_id]
    );
    return { ...this._row(r.rows[0]), ledgerMovement: mov };
  }

  static async cancelFunding({ requestId, cancelledBy, reason }) {
    const row = await this._get(requestId);
    if (row.status === 'confirmed') throw new Error('confirmed funding cannot be cancelled; post a reversing movement instead');
    const r = await pool.query(
      `UPDATE ${TABLE} SET status='cancelled', memo = COALESCE(memo,'') || $2, updated_at=NOW() WHERE request_id=$1 RETURNING *`,
      [requestId, ` [cancelled by ${cancelledBy || 'system'}${reason ? ': ' + reason : ''}]`]
    );
    return this._row(r.rows[0]);
  }

  static async listRequests({ status, limit = 50 } = {}) {
    if (!pool) throw new Error('ledger unavailable');
    await this.ensureTables();
    const r = status
      ? await pool.query(`SELECT * FROM ${TABLE} WHERE status=$1 ORDER BY created_at DESC LIMIT $2`, [status, limit])
      : await pool.query(`SELECT * FROM ${TABLE} ORDER BY created_at DESC LIMIT $1`, [limit]);
    return r.rows.map(x => this._row(x));
  }

  static async pipeline() {
    if (!pool) throw new Error('ledger unavailable');
    await this.ensureTables();
    const r = await pool.query(`SELECT status, COUNT(*)::int AS n, COALESCE(SUM(amount_cents),0)::bigint AS cents FROM ${TABLE} GROUP BY status`);
    const byStatus = Object.fromEntries(STATUSES.map(s => [s, { count: 0, amount: 0 }]));
    for (const x of r.rows) byStatus[x.status] = { count: x.n, amount: Number(x.cents) / 100 };
    return {
      byStatus,
      awaitingRealFunds: byStatus.requested.amount + byStatus.approved.amount,
      confirmedToLedger: byStatus.confirmed.amount,
      note: 'only confirmed requests (with an external bank/provider reference) have credited the ledger',
    };
  }

  static async unifiedPath() {
    const Debt = tryRequire('./debtOsEngine')?.DebtOsEngine;
    const [inv, bank] = await Promise.all([
      settle(() => this.sources()),
      settle(() => Debt ? Debt.bankSettlementPath() : Promise.reject(new Error('DebtOsEngine unavailable'))),
    ]);
    const fundIn = { stage: 'fund_ledger', ready: !!(inv.ok && inv.value.sources.some(s => s.canFundLedger)), detail: inv.ok ? { sources: inv.value.sources.filter(s => s.canFundLedger).map(s => s.id) } : { error: inv.error } };
    const stages = [fundIn, ...(bank.ok ? bank.value.stages : [{ stage: 'bank_leg', ready: false, detail: { error: bank.error } }])];
    const blockers = stages.filter(s => !s.ready).map(s => s.stage);
    return {
      unified: true,
      flow: 'real funds → funding request → ledger account → coupon/hold accounts → distribute-to-bank → Lili',
      realValueCapable: !!(inv.ok && inv.value.anyRealValueCapable) && !!(bank.ok && bank.value.realValueCapable),
      stages,
      blockers,
    };
  }

  static async status() {
    const [sources, pipeline, path] = await Promise.all([
      settle(() => this.sources()), settle(() => this.pipeline()), settle(() => this.unifiedPath()),
    ]);
    const realValue = sources.ok && sources.value.anyRealValueCapable;
    const issues = [];
    if (!sources.ok) issues.push(`sources: ${sources.error}`);
    else if (!realValue) issues.push(`no real-value source: ${sources.value.sources.filter(s => !s.realValueCapable).map(s => `${s.id} (${s.reason})`).join('; ')}`);
    if (!pipeline.ok) issues.push(`pipeline: ${pipeline.error}`);
    return {
      engine: 'funding-os',
      healthy: sources.ok && pipeline.ok,
      mode: realValue ? 'live' : 'shadow',
      realValueCapable: realValue,
      sources: sources.ok ? sources.value : { error: sources.error },
      pipeline: pipeline.ok ? pipeline.value : { error: pipeline.error },
      unifiedPath: path.ok ? path.value : { error: path.error },
      issues,
      timestamp: new Date().toISOString(),
    };
  }

  static async _get(requestId) {
    if (!pool) throw new Error('ledger unavailable');
    await this.ensureTables();
    const r = await pool.query(`SELECT * FROM ${TABLE} WHERE request_id=$1`, [requestId]);
    if (!r.rows[0]) throw new Error(`funding request ${requestId} not found`);
    return r.rows[0];
  }

  static _row(x) {
    return { ...x, amount: Number(x.amount_cents) / 100 };
  }
}

module.exports = { FundingOsEngine, FUNDING_REQUEST_STATUSES: STATUSES };
