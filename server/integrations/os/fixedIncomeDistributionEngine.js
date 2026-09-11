'use strict';

/**
 * Fixed Income Distribution Engine — turns booked bond income into governed,
 * segregated payouts. One unified pipeline from Treasury-Core ERP to cash:
 *
 *   coupon_period / coupon_payment journal (Dr 1020)  -> beneficiary distributions
 *   operating_allocation journal        (Dr 1030)      -> trustee operating payout
 *
 *   plan       each unpaid source journal becomes one planned distribution per
 *              payee of its bucket, sized from the policy contract's annual
 *              allocation (periodCap / periodSeconds) prorated to the bond's
 *              coupon frequency and capped at the journal amount (pro-rata if
 *              the period is short).
 *   stage      SpritzTreasuryLegEngine.fund(): ERP GL cash -> USDC into the
 *              policy contract via CanonicalMoneyEngine (maker/checker).
 *   reconcile  funded requests raise the on-chain payout: beneficiaries get a
 *              TrustDistributionPolicy proposal to their hold-account wallet;
 *              the trustee payout is staged as a Spritz off-ramp to the bank.
 *   execute    checker-approved + timelocked distributions are released; the
 *              GL books Dr distributions payable / Cr USDC treasury.
 *
 * coupon_income and trust_operating never share a source journal, a funding
 * request or a payee list (TrustAllocationEngine enforces both ends).
 */

const path = require('path');
const fs = require('fs');
const { SpritzTreasuryLegEngine, usdToUnits } = require('../spritz/spritzTreasuryLegEngine');
const { TrustAllocationEngine } = require('../dapp/trustAllocationEngine');
const { TrustPolicyEngine } = require('../dapp/trustPolicyEngine');

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

let TrustAccountingEngine;
try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) { TrustAccountingEngine = null; }

const POLICY_CONFIG = path.join(__dirname, '..', '..', '..', 'contracts', 'policy.base.json');
const YEAR_SECONDS = 31536000;
const PERIODS_PER_YEAR = { monthly: 12, quarterly: 4, 'semi-annual': 2, annual: 1 };
const SOURCE_BUCKETS = { coupon_period: 'coupon_income', coupon_payment: 'coupon_income', operating_allocation: 'trust_operating' };
const TRANSITIONS = {
  planned: ['funding', 'cancelled'],
  funding: ['funded', 'cancelled'],
  funded: ['proposed', 'cancelled'],
  proposed: ['executed', 'cancelled'],
  executed: [],
  cancelled: [],
};

class FixedIncomeError extends Error {
  constructor(message, code = 'FIXED_INCOME_ERROR', status = 409, details = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function bool(name, def) { const v = str(name); return v ? v.toLowerCase() === 'true' : def; }
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function newId(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }
function lower(a) { return String(a || '').toLowerCase(); }

function assertTransition(from, to) {
  if (!(TRANSITIONS[from] || []).includes(to)) {
    throw new FixedIncomeError(`distribution cannot move ${from} -> ${to}`, 'FIXED_INCOME_STATE', 409, { from, to });
  }
}

/** Annual USD allocation per payee wallet from the policy contract config. */
function policyAnnualAllocations() {
  try {
    const cfg = JSON.parse(fs.readFileSync(POLICY_CONFIG, 'utf8'));
    const out = {};
    for (const b of cfg.beneficiaries || []) {
      const cap = Number(b.periodCap || 0);
      const seconds = Number(b.periodSeconds || 0);
      if (cap > 0 && seconds > 0) out[lower(b.beneficiary)] = round2((cap / 1e6) * (YEAR_SECONDS / seconds));
      else if (Number(b.maxPerDistribution || 0) > 0) out[lower(b.beneficiary)] = round2(Number(b.maxPerDistribution) / 1e6);
    }
    return out;
  } catch (e) {
    return {};
  }
}

function mapRow(r) {
  if (!r) return null;
  return {
    distributionId: r.distribution_id,
    sourceEntryId: r.source_entry_id,
    sourceReferenceType: r.source_reference_type,
    sourceReferenceId: r.source_reference_id,
    bondId: r.bond_id,
    periodDate: r.period_date,
    bucket: r.bucket,
    payee: r.payee,
    payeeName: r.payee_name,
    payeeRole: r.payee_role,
    purpose: r.purpose,
    amountUsd: Number(r.amount_usd),
    status: r.status,
    fundingReference: r.funding_reference,
    fundingRequestId: r.funding_request_id,
    fundingProposalId: r.funding_proposal_id,
    policyDistributionId: r.policy_distribution_id,
    spritzQuoteId: r.spritz_quote_id,
    txHash: r.tx_hash,
    journalEntryId: r.journal_entry_id,
    error: r.error,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    executedAt: r.executed_at,
  };
}

const FixedIncomeDistributionEngine = {
  config() {
    return {
      enabled: bool('FIXED_INCOME_DISTRIBUTION_ENABLED', true),
      autoStage: bool('FIXED_INCOME_AUTO_STAGE', false),
      autoExecute: bool('FIXED_INCOME_AUTO_EXECUTE', false),
      minAmountUsd: Number(str('FIXED_INCOME_MIN_AMOUNT_USD', '1')),
      trusteeRail: str('FIXED_INCOME_TRUSTEE_RAIL', '') || undefined,
      gl: {
        treasuryAccount: str('SPRITZ_TREASURY_GL_ACCOUNT', '1210'),
        distributionsAccount: str('SPRITZ_DISTRIBUTIONS_GL_ACCOUNT', '2000'),
      },
    };
  },

  async ensureTables() {
    if (!pool) throw new FixedIncomeError('Postgres unavailable', 'FIXED_INCOME_UNAVAILABLE', 503);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fixed_income_distributions (
        distribution_id        TEXT PRIMARY KEY,
        source_entry_id        TEXT NOT NULL,
        source_reference_type  TEXT NOT NULL,
        source_reference_id    TEXT,
        bond_id                INTEGER,
        period_date            DATE,
        bucket                 TEXT NOT NULL,
        payee                  TEXT NOT NULL,
        payee_name             TEXT,
        payee_role             TEXT NOT NULL,
        purpose                TEXT NOT NULL,
        amount_usd             NUMERIC(18,2) NOT NULL,
        status                 TEXT NOT NULL DEFAULT 'planned'
                                 CHECK (status IN ('planned','funding','funded','proposed','executed','cancelled')),
        funding_reference      TEXT,
        funding_request_id     TEXT,
        funding_proposal_id    TEXT,
        policy_distribution_id TEXT,
        spritz_quote_id        TEXT,
        tx_hash                TEXT,
        journal_entry_id       TEXT,
        error                  TEXT,
        created_by             TEXT,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        executed_at            TIMESTAMPTZ,
        UNIQUE (source_entry_id, payee)
      )
    `);
  },

  async readiness() {
    const cfg = this.config();
    const [treasury, allocations] = await Promise.all([
      SpritzTreasuryLegEngine.readiness().catch((e) => ({ ready: false, issues: [e.message] })),
      Promise.resolve(policyAnnualAllocations()),
    ]);
    const buckets = TrustAllocationEngine.buckets().map((b) => {
      const payees = TrustAllocationEngine.payees(b.key).map((p) => ({ ...p, annualAllocationUsd: allocations[lower(p.address)] || null }));
      return { bucket: b.key, label: b.label, glAccountCode: TrustAllocationEngine.glAccountCode(b.key), purposes: b.purposes, payees };
    });
    const issues = [...(treasury.issues || [])];
    for (const b of buckets) {
      if (!b.payees.length) issues.push(`${b.bucket} has no payees on the policy contract`);
      if (b.payees.some((p) => !p.annualAllocationUsd)) issues.push(`${b.bucket} payee without an annual allocation in contracts/policy.base.json`);
    }
    return { enabled: cfg.enabled, autoStage: cfg.autoStage, autoExecute: cfg.autoExecute, ready: cfg.enabled && issues.length === 0, issues, treasury, buckets };
  },

  /** Source journals (posted, pushed or not) without a distribution plan yet. */
  async unplannedSources({ limit = 100 } = {}) {
    await this.ensureTables();
    const { rows } = await pool.query(`
      SELECT je.entry_id, je.entry_date, je.reference_type, je.reference_id, je.bond_id, je.description,
             b.payment_freq,
             (SELECT COALESCE(SUM(l.debit_amount), 0) FROM trust_journal_lines l
                WHERE l.entry_id = je.entry_id AND l.account_code IN ($1, $2)) AS amount
      FROM trust_journal_entries je
      LEFT JOIN bonds b ON b.id = je.bond_id
      WHERE je.status = 'posted'
        AND je.reference_type IN ('coupon_period', 'coupon_payment', 'operating_allocation')
        AND NOT EXISTS (SELECT 1 FROM fixed_income_distributions d WHERE d.source_entry_id = je.entry_id)
      ORDER BY je.entry_date ASC, je.entry_id ASC
      LIMIT $3
    `, [TrustAllocationEngine.glAccountCode('coupon_income') || '1020', TrustAllocationEngine.glAccountCode('trust_operating') || '1030', limit]);
    return rows.map((r) => ({
      entryId: r.entry_id,
      entryDate: r.entry_date,
      referenceType: r.reference_type,
      referenceId: r.reference_id,
      bondId: r.bond_id,
      paymentFreq: r.payment_freq,
      bucket: SOURCE_BUCKETS[r.reference_type],
      amountUsd: Number(r.amount),
      description: r.description,
    }));
  },

  /** Split one source journal across its bucket's payees per policy allocations. */
  allocate(source, allocations = policyAnnualAllocations()) {
    const bucket = TrustAllocationEngine.bucket(source.bucket);
    const periods = PERIODS_PER_YEAR[source.paymentFreq] || 2;
    const payees = TrustAllocationEngine.payees(bucket.key);
    const lines = payees.map((p) => ({
      payee: p.address,
      payeeName: p.name,
      payeeRole: bucket.payeeRole,
      purpose: bucket.purposes[0],
      entitlementUsd: round2((allocations[lower(p.address)] || 0) / periods),
    })).filter((l) => l.entitlementUsd > 0);
    const entitled = round2(lines.reduce((s, l) => s + l.entitlementUsd, 0));
    const available = round2(source.amountUsd);
    const scale = entitled > available && entitled > 0 ? available / entitled : 1;
    let allocated = 0;
    const out = lines.map((l, i) => {
      let amountUsd = round2(l.entitlementUsd * scale);
      if (i === lines.length - 1 && scale < 1) amountUsd = round2(available - allocated);
      allocated = round2(allocated + amountUsd);
      return { ...l, amountUsd };
    });
    return { bucket: bucket.key, periodsPerYear: periods, entitledUsd: entitled, availableUsd: available, allocatedUsd: allocated, retainedUsd: round2(available - allocated), lines: out };
  },

  /** Create planned distributions for every unplanned source journal (idempotent). */
  async plan({ createdBy, dryRun = false } = {}) {
    const cfg = this.config();
    if (!cfg.enabled) throw new FixedIncomeError('Fixed income distribution disabled', 'FIXED_INCOME_DISABLED', 503);
    const sources = await this.unplannedSources();
    const allocations = policyAnnualAllocations();
    const planned = [];
    for (const s of sources) {
      const split = this.allocate(s, allocations);
      const entry = { source: s, ...split, distributions: [] };
      for (const l of split.lines) {
        if (l.amountUsd < cfg.minAmountUsd) continue;
        if (dryRun) { entry.distributions.push({ ...l, status: 'planned', dryRun: true }); continue; }
        const id = newId('FID');
        const res = await pool.query(
          `INSERT INTO fixed_income_distributions
             (distribution_id, source_entry_id, source_reference_type, source_reference_id, bond_id, period_date, bucket, payee, payee_name, payee_role, purpose, amount_usd, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (source_entry_id, payee) DO NOTHING RETURNING *`,
          [id, s.entryId, s.referenceType, s.referenceId, s.bondId, s.entryDate, split.bucket, l.payee, l.payeeName, l.payeeRole, l.purpose, l.amountUsd, createdBy || 'fixed-income']
        );
        if (res.rows[0]) entry.distributions.push(mapRow(res.rows[0]));
      }
      planned.push(entry);
    }
    return { dryRun, sources: sources.length, planned: planned.reduce((n, e) => n + e.distributions.length, 0), totalUsd: round2(planned.reduce((n, e) => n + e.allocatedUsd, 0)), entries: planned };
  },

  async list({ status = null, bucket = null, limit = 200 } = {}) {
    await this.ensureTables();
    const where = [];
    const params = [];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (bucket) { params.push(bucket); where.push(`bucket = $${params.length}`); }
    params.push(Math.min(Number(limit) || 200, 1000));
    const { rows } = await pool.query(
      `SELECT * FROM fixed_income_distributions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY period_date ASC, created_at ASC LIMIT $${params.length}`, params
    );
    return rows.map(mapRow);
  },

  async get(distributionId) {
    await this.ensureTables();
    const { rows } = await pool.query(`SELECT * FROM fixed_income_distributions WHERE distribution_id = $1`, [distributionId]);
    if (!rows.length) throw new FixedIncomeError(`distribution ${distributionId} not found`, 'FIXED_INCOME_NOT_FOUND', 404);
    return mapRow(rows[0]);
  },

  async _set(distributionId, fields) {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    await pool.query(`UPDATE fixed_income_distributions SET ${sets.join(', ')}, updated_at = NOW() WHERE distribution_id = $1`, [distributionId, ...keys.map((k) => fields[k])]);
    return this.get(distributionId);
  },

  /** Fund a planned distribution from its bucket's ERP cash account (maker/checker). */
  async stage({ distributionId, actor, autoApprove = false } = {}) {
    const d = await this.get(distributionId);
    assertTransition(d.status, 'funding');
    const reference = d.fundingReference || `${d.distributionId}:FUND`;
    try {
      const funding = await SpritzTreasuryLegEngine.fund({ amountUsd: d.amountUsd, bucket: d.bucket, reference, createdBy: actor || 'fixed-income', autoApprove });
      return {
        ...(await this._set(d.distributionId, {
          status: 'funding', funding_reference: reference, error: null,
          funding_request_id: funding.requestId ? String(funding.requestId) : null,
          funding_proposal_id: funding.proposalId ? String(funding.proposalId) : null,
        })),
        funding,
        next: 'checker approves the canonical_money proposal; reconcile() then raises the payout.',
      };
    } catch (err) {
      await this._set(d.distributionId, { error: err.message });
      throw err;
    }
  },

  /** Move funded distributions forward: ERP request completed -> payout proposed on-chain / via Spritz. */
  async reconcile({ actor } = {}) {
    const cfg = this.config();
    const results = [];
    for (const d of await this.list({ status: 'funding', limit: 1000 })) {
      if (!d.fundingRequestId) { results.push({ distributionId: d.distributionId, status: d.status, note: 'no ERP request id' }); continue; }
      let request = null;
      try {
        const r = await pool.query(`SELECT id, status FROM canonical_money_requests WHERE id = $1`, [d.fundingRequestId]);
        request = r.rows[0] || null;
      } catch { request = null; }
      if (!request) { results.push({ distributionId: d.distributionId, status: d.status, note: 'ERP request not found' }); continue; }
      if (request.status === 'failed' || request.status === 'rejected') {
        results.push(await this._set(d.distributionId, { status: 'cancelled', error: `ERP request ${request.status}` }));
        continue;
      }
      if (request.status !== 'completed') { results.push({ distributionId: d.distributionId, status: d.status, requestStatus: request.status }); continue; }
      await this._set(d.distributionId, { status: 'funded' });
      try {
        results.push(await this._propose(await this.get(d.distributionId), cfg, actor));
      } catch (err) {
        results.push(await this._set(d.distributionId, { error: err.message }));
      }
    }
    if (cfg.autoExecute) {
      for (const d of await this.list({ status: 'proposed', limit: 1000 })) {
        try {
          const onchain = d.policyDistributionId ? await TrustPolicyEngine.distribution(d.policyDistributionId) : null;
          const releasable = onchain && onchain.status === 'approved' && (!onchain.releasableAt || new Date(onchain.releasableAt) <= new Date());
          if (releasable) results.push(await this.execute({ distributionId: d.distributionId, actor: actor || 'fixed-income-auto' }));
        } catch (err) {
          results.push(await this._set(d.distributionId, { error: err.message }));
        }
      }
    }
    return { reconciled: results.length, distributions: results };
  },

  async _propose(d, cfg, actor) {
    const reference = `${d.distributionId}:PAY`;
    if (d.payeeRole === 'trustee') {
      const payout = await SpritzTreasuryLegEngine.stagePayout({ amountUsd: d.amountUsd, purpose: d.purpose, reference, rail: cfg.trusteeRail, memo: reference, payoutWallet: d.payee, bucket: d.bucket });
      return this._set(d.distributionId, {
        status: 'proposed', error: null,
        policy_distribution_id: payout.distribution && (payout.distribution.distributionId || payout.distribution.id) ? String(payout.distribution.distributionId || payout.distribution.id) : null,
        spritz_quote_id: payout.spritzQuoteId || null,
      });
    }
    await TrustAllocationEngine.assertPayout({ bucket: d.bucket, payoutWallet: d.payee, purpose: d.purpose, amountUsd: d.amountUsd, reference });
    const proposal = await TrustPolicyEngine.propose({ beneficiary: d.payee, quantity: usdToUnits(d.amountUsd).toString(), purpose: d.purpose, reference });
    await TrustAllocationEngine.recordPayout({ bucket: d.bucket, reference, payoutWallet: d.payee, purpose: d.purpose, amountUsd: d.amountUsd, distributionId: proposal.distributionId || proposal.id });
    return this._set(d.distributionId, {
      status: 'proposed', error: null,
      policy_distribution_id: proposal.distributionId || proposal.id ? String(proposal.distributionId || proposal.id) : null,
    });
  },

  /** Release a checker-approved distribution and book it. */
  async execute({ distributionId, actor } = {}) {
    const cfg = this.config();
    const d = await this.get(distributionId);
    assertTransition(d.status, 'executed');
    if (!d.policyDistributionId) throw new FixedIncomeError('no on-chain distribution id; reconcile() first', 'FIXED_INCOME_STATE', 409);
    const reference = `${d.distributionId}:PAY`;
    let settlement;
    if (d.payeeRole === 'trustee') {
      if (!d.spritzQuoteId) throw new FixedIncomeError('trustee payout has no Spritz quote', 'FIXED_INCOME_STATE', 409);
      settlement = await SpritzTreasuryLegEngine.executePayout({ distributionId: d.policyDistributionId, spritzQuoteId: d.spritzQuoteId, reference, amountUsd: d.amountUsd, createdBy: actor });
    } else {
      const release = await TrustPolicyEngine.execute({ distributionId: d.policyDistributionId });
      await TrustAllocationEngine.markExecuted(reference);
      let journal = null;
      if (TrustAccountingEngine) {
        journal = await TrustAccountingEngine.postJournalEntry({
          entryDate: new Date().toISOString().slice(0, 10),
          description: `Beneficiary distribution ${d.amountUsd.toFixed(2)} USDC to ${d.payeeName || d.payee} [${reference}]`,
          lines: [
            { accountCode: cfg.gl.distributionsAccount, debitAmount: d.amountUsd, creditAmount: 0, memo: `Coupon-income distribution ${d.distributionId}` },
            { accountCode: cfg.gl.treasuryAccount, debitAmount: 0, creditAmount: d.amountUsd, memo: `USDC released from policy contract` },
          ],
          referenceType: 'fixed_income_distribution',
          referenceId: d.distributionId,
          bondId: d.bondId,
          postedBy: actor || 'fixed-income',
          postToFineract: false,
        });
      }
      settlement = { release, txHash: release && (release.txHash || release.transactionHash) || null, journal };
    }
    return {
      ...(await this._set(d.distributionId, {
        status: 'executed', executed_at: new Date(), error: null,
        tx_hash: settlement.txHash || null,
        journal_entry_id: settlement.journal && (settlement.journal.entryId || settlement.journal.entry_id) ? String(settlement.journal.entryId || settlement.journal.entry_id) : null,
      })),
      settlement,
    };
  },

  async cancel({ distributionId, actor, reason } = {}) {
    const d = await this.get(distributionId);
    assertTransition(d.status, 'cancelled');
    return this._set(d.distributionId, { status: 'cancelled', error: reason || `cancelled by ${actor || 'operator'}` });
  },

  async summary() {
    await this.ensureTables();
    const { rows } = await pool.query(`SELECT bucket, status, COUNT(*)::int AS count, COALESCE(SUM(amount_usd), 0) AS total FROM fixed_income_distributions GROUP BY bucket, status ORDER BY bucket, status`);
    return rows.map((r) => ({ bucket: r.bucket, status: r.status, count: r.count, totalUsd: Number(r.total) }));
  },

  /**
   * Automatic cycle (hourly reconcile): plan new source journals, stage them
   * when FIXED_INCOME_AUTO_STAGE=true, and advance funded/approved ones.
   */
  async runCycle({ actor } = {}) {
    const cfg = this.config();
    if (!cfg.enabled) return { skipped: true, reason: 'disabled' };
    const planned = await this.plan({ createdBy: actor || 'fixed-income-auto' });
    const staged = [];
    if (cfg.autoStage) {
      for (const d of await this.list({ status: 'planned', limit: 1000 })) {
        try { staged.push(await this.stage({ distributionId: d.distributionId, actor: actor || 'fixed-income-auto' })); }
        catch (err) { staged.push({ distributionId: d.distributionId, error: err.message }); }
      }
    }
    const reconciled = await this.reconcile({ actor });
    return { planned: planned.planned, plannedUsd: planned.totalUsd, staged: staged.length, stagedErrors: staged.filter((s) => s.error).length, reconciled: reconciled.reconciled, summary: await this.summary() };
  },
};

module.exports = { FixedIncomeDistributionEngine, FixedIncomeError, policyAnnualAllocations, PERIODS_PER_YEAR, SOURCE_BUCKETS };
