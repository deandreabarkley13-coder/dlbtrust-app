'use strict';

/**
 * Agent mandates — machine-checkable authorization limits for the FinOps agent.
 *
 * A mandate is the trust's written grant of bounded autonomy: which actions an
 * agent may take, to whom, in what asset, for how much per transaction, how
 * much in aggregate per period, and between which dates. Anything the mandate
 * does not cover escalates to the trustees; anything it forbids is denied
 * outright and cannot be executed by the agent at all.
 *
 * Mandates are opt-in. With none on file the agent behaves exactly as before —
 * every task waits for two trustee approvals — so installing this module
 * cannot loosen an existing control. Once a mandate exists for an agent it
 * binds that agent: a request outside it is denied rather than escalated,
 * because the trust has already stated what the agent may do.
 *
 * Every evaluation is recorded, including denials, in a hash-chained decision
 * log so a trustee can reconstruct what the agent was permitted to do and why
 * at the moment it acted.
 *
 * Amounts are decimal strings ("5000.00") throughout and are compared in
 * BigInt minor units — a spend limit must never be subject to float rounding.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');
const {
  normalizeAmount,
  compareAmounts,
  addAmounts,
  isPositiveAmount,
  coerceAmount,
} = require('../treasuryprime/decimalAmount');

const PERIODS = ['day', 'week', 'month'];
const STATUSES = ['active', 'suspended', 'revoked'];
const DECISIONS = ['allow', 'escalate', 'deny'];

/** Actions that move value and therefore require a mandate to be autonomous. */
const VALUE_ACTIONS = ['payment', 'distribution', 'dex_swap'];

let sequence = 0;

function id(prefix) {
  sequence += 1;
  return `${prefix}-${Date.now()}-${String(sequence).padStart(4, '0')}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function normalizePayee(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function asArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return JSON.parse(value || '[]');
  return [];
}

/** Start of the period containing `at`, in UTC. */
function periodStart(period, at = new Date()) {
  const d = new Date(at.getTime());
  d.setUTCHours(0, 0, 0, 0);
  if (period === 'week') d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  if (period === 'month') d.setUTCDate(1);
  return d;
}

/**
 * Pure mandate check — no database, so it is exhaustively testable and can be
 * used to preview a decision before anything is written.
 *
 * `spendByMandate` maps mandate id -> decimal string already consumed in the
 * current period.
 */
function evaluateAgainst(mandates, request, spendByMandate = {}) {
  const { action, amount, asset, payee, purpose, at = new Date() } = request;
  const normalizedAmount = normalizeAmount(amount, 'amount');
  if (!isPositiveAmount(normalizedAmount)) throw new Error('amount must be positive');

  const candidates = mandates.filter((m) => m.status === 'active');
  if (!candidates.length) {
    // Nothing has been granted to this agent: fall back to trustee approval. A
    // withdrawn grant is named as such so the log distinguishes "revoked" from
    // "never granted".
    const withdrawn = mandates.filter((m) => m.status !== 'active');
    return {
      decision: 'escalate',
      mandateId: null,
      reasons: withdrawn.length
        ? withdrawn.map((m) => `mandate "${m.label}" is ${m.status} and no longer grants authority`)
        : ['no mandate on file for this agent'],
    };
  }

  const failures = [];
  for (const mandate of candidates) {
    const reasons = [];
    const actions = asArray(mandate.actions);
    const assets = asArray(mandate.assets);
    const payees = asArray(mandate.payees).map(normalizePayee);

    if (actions.length && !actions.includes(action)) {
      reasons.push(`action "${action}" is not in the mandate (${actions.join(', ')})`);
    }
    if (assets.length && asset && !assets.map((a) => String(a).toUpperCase()).includes(String(asset).toUpperCase())) {
      reasons.push(`asset "${asset}" is not in the mandate (${assets.join(', ')})`);
    }
    if (!payees.includes('*') && !payees.includes(normalizePayee(payee))) {
      reasons.push(`payee "${payee}" is not on the mandate allowlist`);
    }
    if (mandate.purpose && !String(purpose || '').toLowerCase().includes(String(mandate.purpose).toLowerCase())) {
      reasons.push(`purpose must reference "${mandate.purpose}"`);
    }
    if (mandate.not_before && at < new Date(mandate.not_before)) {
      reasons.push(`mandate is not effective until ${new Date(mandate.not_before).toISOString()}`);
    }
    if (mandate.not_after && at > new Date(mandate.not_after)) {
      reasons.push(`mandate expired at ${new Date(mandate.not_after).toISOString()}`);
    }
    if (compareAmounts(normalizedAmount, normalizeAmount(mandate.max_amount, 'max_amount')) > 0) {
      reasons.push(`amount ${normalizedAmount} exceeds the per-transaction limit ${normalizeAmount(mandate.max_amount)}`);
    }
    if (mandate.period_limit != null) {
      const spent = normalizeAmount(spendByMandate[mandate.id] || '0.00', 'period spend');
      const projected = addAmounts(spent, normalizedAmount);
      if (compareAmounts(projected, normalizeAmount(mandate.period_limit, 'period_limit')) > 0) {
        reasons.push(
          `amount ${normalizedAmount} would bring ${mandate.period}-to-date spend to ${projected}, over the ${mandate.period} limit ${normalizeAmount(mandate.period_limit)}`,
        );
      }
    }

    if (reasons.length) {
      failures.push({ mandateId: mandate.id, reasons });
      continue;
    }

    // Within the mandate. Autonomy only up to auto_execute_limit; above that
    // the mandate permits the action but still wants a trustee to see it.
    const autoLimit = mandate.auto_execute_limit;
    if (autoLimit != null && compareAmounts(normalizedAmount, normalizeAmount(autoLimit, 'auto_execute_limit')) <= 0) {
      return {
        decision: 'allow',
        mandateId: mandate.id,
        reasons: [`within mandate "${mandate.label}" (<= ${normalizeAmount(autoLimit)} may execute without approval)`],
      };
    }
    return {
      decision: 'escalate',
      mandateId: mandate.id,
      reasons: [
        autoLimit == null
          ? `mandate "${mandate.label}" permits this action but grants no autonomous execution limit`
          : `amount ${normalizedAmount} is over the autonomous limit ${normalizeAmount(autoLimit)} for mandate "${mandate.label}"`,
      ],
    };
  }

  // Mandates exist and every one of them rejects the request.
  return {
    decision: 'deny',
    mandateId: failures.length === 1 ? failures[0].mandateId : null,
    reasons: failures.flatMap((f) => f.reasons),
  };
}

/** Canonical fields of a decision, hashed into the audit chain. */
function decisionDigest(prevHash, fields) {
  const canonical = JSON.stringify([
    fields.id,
    fields.agent,
    fields.action,
    fields.amount,
    fields.asset,
    fields.payee,
    fields.decision,
    fields.mandateId,
    fields.reasons,
    fields.decidedAt,
  ]);
  return crypto.createHash('sha256').update(`${prevHash || ''}${canonical}`).digest('hex');
}

class MandateEngine {
  static get VALUE_ACTIONS() { return VALUE_ACTIONS; }

  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_mandates (
        id                 TEXT PRIMARY KEY,
        agent              TEXT NOT NULL,
        label              TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
        actions            JSONB NOT NULL DEFAULT '[]',
        assets             JSONB NOT NULL DEFAULT '[]',
        payees             JSONB NOT NULL DEFAULT '[]',
        max_amount         NUMERIC(20,2) NOT NULL,
        period_limit       NUMERIC(20,2),
        period             TEXT NOT NULL DEFAULT 'day' CHECK (period IN ('day','week','month')),
        auto_execute_limit NUMERIC(20,2),
        purpose            TEXT,
        not_before         TIMESTAMPTZ,
        not_after          TIMESTAMPTZ,
        granted_by         TEXT,
        created_at         TIMESTAMPTZ DEFAULT NOW(),
        updated_at         TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_mandates_agent ON agent_mandates(agent, status)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_mandate_decisions (
        id          TEXT PRIMARY KEY,
        seq         BIGSERIAL,
        mandate_id  TEXT,
        agent       TEXT NOT NULL,
        action      TEXT,
        amount      NUMERIC(20,2),
        asset       TEXT,
        payee       TEXT,
        purpose     TEXT,
        decision    TEXT NOT NULL CHECK (decision IN ('allow','escalate','deny')),
        reasons     JSONB NOT NULL DEFAULT '[]',
        task_id     TEXT,
        consumed    BOOLEAN NOT NULL DEFAULT FALSE,
        prev_hash   TEXT,
        hash        TEXT NOT NULL,
        decided_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`ALTER TABLE agent_mandate_decisions ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mandate_decisions_agent ON agent_mandate_decisions(agent, decided_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mandate_decisions_spend ON agent_mandate_decisions(mandate_id, consumed, decided_at)`);
  }

  static async createMandate(input = {}) {
    const {
      agent, label, actions = VALUE_ACTIONS, assets = [], payees = [],
      maxAmount, periodLimit = null, period = 'day', autoExecuteLimit = null,
      purpose = null, notBefore = null, notAfter = null, grantedBy = null,
    } = input;

    if (!agent) throw new Error('agent is required');
    if (!label) throw new Error('label is required');
    if (!PERIODS.includes(period)) throw new Error(`period must be one of ${PERIODS.join(', ')}`);
    if (!Array.isArray(payees) || !payees.length) {
      throw new Error('payees is required: list the allowed recipients, or ["*"] to allow any');
    }
    const max = normalizeAmount(maxAmount, 'maxAmount');
    if (!isPositiveAmount(max)) throw new Error('maxAmount must be positive');
    const limit = periodLimit == null ? null : normalizeAmount(periodLimit, 'periodLimit');
    const autoLimit = autoExecuteLimit == null ? null : normalizeAmount(autoExecuteLimit, 'autoExecuteLimit');
    if (autoLimit && compareAmounts(autoLimit, max) > 0) {
      throw new Error(`autoExecuteLimit ${autoLimit} cannot exceed maxAmount ${max}`);
    }
    if (limit && compareAmounts(max, limit) > 0) {
      throw new Error(`maxAmount ${max} cannot exceed periodLimit ${limit}`);
    }
    if (notBefore && notAfter && new Date(notBefore) >= new Date(notAfter)) {
      throw new Error('notBefore must precede notAfter');
    }

    await this.ensureTables();
    const mandateId = id('MANDATE');
    await pool.query(
      `INSERT INTO agent_mandates
         (id, agent, label, actions, assets, payees, max_amount, period_limit, period,
          auto_execute_limit, purpose, not_before, not_after, granted_by)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        mandateId, agent, label, JSON.stringify(actions), JSON.stringify(assets),
        JSON.stringify(payees.map(normalizePayee)), max, limit, period, autoLimit,
        purpose, notBefore, notAfter, grantedBy,
      ],
    );
    return this.getMandate(mandateId);
  }

  static async getMandate(mandateId) {
    await this.ensureTables();
    const { rows } = await pool.query('SELECT * FROM agent_mandates WHERE id = $1', [mandateId]);
    return rows.length ? this._hydrate(rows[0]) : null;
  }

  static async listMandates({ agent, status } = {}) {
    await this.ensureTables();
    const clauses = [];
    const params = [];
    if (agent) { params.push(agent); clauses.push(`agent = $${params.length}`); }
    if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await pool.query(`SELECT * FROM agent_mandates ${where} ORDER BY created_at DESC`, params);
    return rows.map((r) => this._hydrate(r));
  }

  static async setMandateStatus(mandateId, status) {
    if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
    await this.ensureTables();
    const { rowCount } = await pool.query(
      'UPDATE agent_mandates SET status = $1, updated_at = NOW() WHERE id = $2',
      [status, mandateId],
    );
    if (!rowCount) throw new Error('Mandate not found');
    return this.getMandate(mandateId);
  }

  /**
   * Decimal-string spend consumed under a mandate in its current period. Spend
   * is attributed to the period the money moved in, not the period the request
   * was reviewed in — an escalated decision may be executed days later.
   */
  static async periodSpend(mandate, at = new Date()) {
    await this.ensureTables();
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(amount), 0)::text AS total
         FROM agent_mandate_decisions
        WHERE mandate_id = $1 AND consumed = TRUE
          AND COALESCE(consumed_at, decided_at) >= $2`,
      [mandate.id, periodStart(mandate.period, at)],
    );
    return coerceAmount(rows[0].total) || '0.00';
  }

  /**
   * Evaluate every leg of an operation against the agent's mandates and record
   * a decision per leg. Denials are recorded too — a refused instruction is the
   * part of the log a trustee most wants to see.
   *
   * Legs are checked against a running total so a distribution cannot slip
   * under a cumulative cap by being split across recipients.
   */
  static async evaluateBatch({ agent, action, legs = [], purpose = null, at = new Date(), taskId = null }) {
    if (!agent) throw new Error('agent is required');
    if (!legs.length) throw new Error('at least one leg is required');
    await this.ensureTables();

    const mandates = await this.listMandates({ agent });
    const spendByMandate = {};
    for (const mandate of mandates.filter((m) => m.status === 'active' && m.period_limit != null)) {
      spendByMandate[mandate.id] = await this.periodSpend(mandate, at);
    }

    const results = [];
    for (const leg of legs) {
      const amount = normalizeAmount(leg.amount, 'amount');
      const asset = leg.asset || null;
      const payee = leg.payee || null;
      const outcome = evaluateAgainst(mandates, { action, amount, asset, payee, purpose, at }, spendByMandate);
      const decisionId = await this._record({
        ...outcome, agent, action, asset, payee, purpose, taskId, amount, decidedAt: at.toISOString(),
      });
      if (outcome.decision !== 'deny' && outcome.mandateId && spendByMandate[outcome.mandateId] != null) {
        spendByMandate[outcome.mandateId] = addAmounts(spendByMandate[outcome.mandateId], amount);
      }
      results.push({ ...outcome, decisionId, amount, asset, payee });
    }

    let decision = results.some((r) => r.decision === 'deny')
      ? 'deny'
      : results.some((r) => r.decision === 'escalate') ? 'escalate' : 'allow';

    // Autonomy is bounded by the instruction total as well as by each leg, so a
    // distribution cannot move an unbounded aggregate in legs that are each
    // individually under the autonomous limit.
    const aggregateReasons = [];
    if (decision === 'allow') {
      const total = results.reduce((sum, r) => addAmounts(sum, r.amount), '0.00');
      for (const mandateId of new Set(results.map((r) => r.mandateId))) {
        const mandate = mandates.find((m) => m.id === mandateId);
        if (!mandate || mandate.auto_execute_limit == null) continue;
        const autoLimit = normalizeAmount(mandate.auto_execute_limit, 'auto_execute_limit');
        if (compareAmounts(total, autoLimit) > 0) {
          decision = 'escalate';
          aggregateReasons.push(
            `instruction total ${total} is over the autonomous limit ${autoLimit} for mandate "${mandate.label}"`,
          );
        }
      }
    }

    return {
      decision,
      legs: results,
      decisionIds: results.map((r) => r.decisionId),
      mandateId: results[0].mandateId,
      reasons: [...results.flatMap((r) => r.reasons), ...aggregateReasons],
    };
  }

  /** Single-leg convenience wrapper around evaluateBatch. */
  static async evaluate(request) {
    const { agent, action, amount, asset = null, payee = null, purpose = null, at = new Date(), taskId = null } = request;
    const batch = await this.evaluateBatch({
      agent, action, purpose, at, taskId,
      legs: [{ amount, asset, payee }],
    });
    return { ...batch.legs[0], decision: batch.decision };
  }

  static async _record(fields) {
    const decisionId = id('MDEC');
    const { rows } = await pool.query(
      'SELECT hash FROM agent_mandate_decisions ORDER BY seq DESC LIMIT 1',
    );
    const prevHash = rows.length ? rows[0].hash : null;
    const hash = decisionDigest(prevHash, { ...fields, id: decisionId });
    await pool.query(
      `INSERT INTO agent_mandate_decisions
         (id, mandate_id, agent, action, amount, asset, payee, purpose, decision, reasons, task_id, prev_hash, hash, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14)`,
      [
        decisionId, fields.mandateId, fields.agent, fields.action, fields.amount, fields.asset,
        fields.payee, fields.purpose, fields.decision, JSON.stringify(fields.reasons),
        fields.taskId, prevHash, hash, fields.decidedAt,
      ],
    );
    return decisionId;
  }

  /**
   * Mark a decision as spent against its mandate. Called once the underlying
   * payment actually executed — an authorized-but-unexecuted decision must not
   * consume the period limit.
   */
  static async markConsumed(decisionId, taskId = null) {
    if (!decisionId) return null;
    await this.ensureTables();
    const { rows } = await pool.query(
      `UPDATE agent_mandate_decisions
          SET consumed = TRUE, consumed_at = NOW(), task_id = COALESCE($2, task_id)
        WHERE id = $1 AND decision <> 'deny'
        RETURNING *`,
      [decisionId, taskId],
    );
    return rows.length ? rows[0] : null;
  }

  static async listDecisions({ agent, mandateId, decision, limit = 100 } = {}) {
    await this.ensureTables();
    const clauses = [];
    const params = [];
    if (agent) { params.push(agent); clauses.push(`agent = $${params.length}`); }
    if (mandateId) { params.push(mandateId); clauses.push(`mandate_id = $${params.length}`); }
    if (decision) { params.push(decision); clauses.push(`decision = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT * FROM agent_mandate_decisions ${where} ORDER BY seq DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => ({ ...r, reasons: asArray(r.reasons) }));
  }

  /**
   * Recompute the decision chain. A mismatch means rows were edited or removed
   * after the fact, which is exactly what a fiduciary audit needs to detect.
   */
  static async verifyAuditChain() {
    await this.ensureTables();
    const { rows } = await pool.query(
      'SELECT * FROM agent_mandate_decisions ORDER BY seq ASC',
    );
    let prevHash = null;
    for (const row of rows) {
      const expected = decisionDigest(prevHash, {
        id: row.id,
        agent: row.agent,
        action: row.action,
        amount: coerceAmount(row.amount),
        asset: row.asset,
        payee: row.payee,
        decision: row.decision,
        mandateId: row.mandate_id,
        reasons: asArray(row.reasons),
        decidedAt: new Date(row.decided_at).toISOString(),
      });
      if (expected !== row.hash) {
        return { ok: false, verified: rows.length, brokenAt: row.id };
      }
      prevHash = row.hash;
    }
    return { ok: true, verified: rows.length, brokenAt: null };
  }

  static _hydrate(row) {
    return {
      ...row,
      actions: asArray(row.actions),
      assets: asArray(row.assets),
      payees: asArray(row.payees),
      max_amount: coerceAmount(row.max_amount),
      period_limit: coerceAmount(row.period_limit),
      auto_execute_limit: coerceAmount(row.auto_execute_limit),
    };
  }
}

module.exports = {
  MandateEngine,
  evaluateAgainst,
  decisionDigest,
  periodStart,
  VALUE_ACTIONS,
  PERIODS,
  STATUSES,
  DECISIONS,
};
