'use strict';

/**
 * Governance & Policy
 *
 * Between "someone asked for a payment" and "the bank moves money" sits the
 * question the trust actually cares about: is this payment allowed, and who has
 * to say so. This engine answers it in one pass and returns the reasoning, not
 * just a verdict — a refused payment tells the operator which rule refused it
 * and what the limit was.
 *
 * Three kinds of rule are evaluated:
 *
 *   hard limits      per-payment ceiling, daily outflow, blocked destination
 *                    countries, frozen accounts, rails an account may not use.
 *   control rules    dual authorization above a threshold, and the segregation
 *                    rule that the initiator can never be one of the approvers.
 *   velocity rules   count and value inside a rolling window, per virtual
 *                    account: the pattern that distinguishes a compromised
 *                    credential from a busy month.
 *
 * Rules come from configuration and from `ihb_policies` rows, so the trust can
 * add a rule for one account (a minor's tuition account capped at $5,000 a
 * week) without a deploy. A policy that cannot be evaluated is treated as a
 * refusal, never as a pass.
 */

const pool = require('../bonds/pgPool');
const { getConfig } = require('./inHouseBankConfig');

const DECISIONS = Object.freeze(['allow', 'review', 'deny']);
const SCOPES = Object.freeze(['global', 'account', 'owner', 'purpose']);

class GovernanceError extends Error {
  constructor(message, code = 'IHB_POLICY_REFUSED', status = 409) {
    super(message);
    this.name = 'GovernanceError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function dollars(cents) {
  return `$${(Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

class GovernanceEngine {
  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ihb_policies (
        policy_id      TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        scope          TEXT NOT NULL DEFAULT 'global'
                       CHECK (scope IN ('global','account','owner','purpose')),
        scope_ref      TEXT,
        max_amount_cents        BIGINT,
        window_minutes          INTEGER,
        window_max_amount_cents BIGINT,
        window_max_count        INTEGER,
        required_approvals      INTEGER,
        allowed_rails  JSONB,
        blocked_rails  JSONB,
        action         TEXT NOT NULL DEFAULT 'deny'
                       CHECK (action IN ('deny','review')),
        active         BOOLEAN NOT NULL DEFAULT TRUE,
        created_by     TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    return true;
  }

  static async listPolicies({ activeOnly = true } = {}) {
    await this.ensureTables();
    const rows = await pool.query(
      `SELECT * FROM ihb_policies WHERE ($1::boolean IS FALSE OR active) ORDER BY created_at DESC`,
      [Boolean(activeOnly)]
    );
    return rows.rows;
  }

  static async upsertPolicy(input = {}) {
    await this.ensureTables();
    const scope = String(input.scope || 'global');
    if (!SCOPES.includes(scope)) throw new GovernanceError(`scope must be one of ${SCOPES.join(', ')}`, 'IHB_POLICY_BAD_SCOPE', 400);
    if (scope !== 'global' && !input.scopeRef) {
      throw new GovernanceError(`A ${scope} policy needs a scopeRef to apply to`, 'IHB_POLICY_NO_REF', 400);
    }
    if (!input.name) throw new GovernanceError('name is required', 'IHB_POLICY_NO_NAME', 400);
    const action = String(input.action || 'deny');
    if (!['deny', 'review'].includes(action)) throw new GovernanceError('action must be deny or review', 'IHB_POLICY_BAD_ACTION', 400);

    const policyId = input.policyId || `POL-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const rows = await pool.query(
      `INSERT INTO ihb_policies
         (policy_id, name, scope, scope_ref, max_amount_cents, window_minutes, window_max_amount_cents,
          window_max_count, required_approvals, allowed_rails, blocked_rails, action, active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (policy_id) DO UPDATE SET
         name = EXCLUDED.name, scope = EXCLUDED.scope, scope_ref = EXCLUDED.scope_ref,
         max_amount_cents = EXCLUDED.max_amount_cents, window_minutes = EXCLUDED.window_minutes,
         window_max_amount_cents = EXCLUDED.window_max_amount_cents, window_max_count = EXCLUDED.window_max_count,
         required_approvals = EXCLUDED.required_approvals, allowed_rails = EXCLUDED.allowed_rails,
         blocked_rails = EXCLUDED.blocked_rails, action = EXCLUDED.action, active = EXCLUDED.active
       RETURNING *`,
      [
        policyId,
        String(input.name),
        scope,
        input.scopeRef || null,
        input.maxAmountCents === undefined ? null : Number(input.maxAmountCents),
        input.windowMinutes === undefined ? null : Number(input.windowMinutes),
        input.windowMaxAmountCents === undefined ? null : Number(input.windowMaxAmountCents),
        input.windowMaxCount === undefined ? null : Number(input.windowMaxCount),
        input.requiredApprovals === undefined ? null : Number(input.requiredApprovals),
        input.allowedRails ? JSON.stringify(input.allowedRails) : null,
        input.blockedRails ? JSON.stringify(input.blockedRails) : null,
        action,
        input.active === undefined ? true : Boolean(input.active),
        input.createdBy || 'operator',
      ]
    );
    return rows.rows[0];
  }

  static async _velocity({ vaId, windowMinutes }) {
    const rows = await pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount_cents), 0)::bigint AS amount_cents
         FROM ihb_payments
        WHERE debtor_va_id = $1
          AND status NOT IN ('rejected','cancelled','failed')
          AND created_at > NOW() - ($2 || ' minutes')::INTERVAL`,
      [vaId, String(windowMinutes)]
    );
    const row = rows.rows[0] || {};
    return { count: Number(row.count || 0), amountCents: Number(row.amount_cents || 0) };
  }

  static async _dailyOutflow() {
    const rows = await pool.query(
      `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS amount_cents
         FROM ihb_payments
        WHERE status NOT IN ('rejected','cancelled','failed')
          AND rail <> 'internal_book'
          AND created_at::date = CURRENT_DATE`
    );
    return Number((rows.rows[0] || {}).amount_cents || 0);
  }

  static async _screen(instruction) {
    const config = getConfig();
    if (!config.screeningRequired) {
      return { screened: false, hit: false, note: 'Sanctions screening is switched off by configuration.' };
    }
    try {
      const { ComplianceEngine } = require('../compliance/complianceEngine');
      // Throws when the sanctions list is not usable, which is exactly the
      // condition under which a beneficiary must not be paid.
      await ComplianceEngine.assertPaymentReady();
      const creditor = instruction.creditor;
      const isBusiness = !/\s/.test(String(creditor.name || '').trim()) || /\b(llc|inc|corp|ltd|co|company|trust|bank|energy|services)\b/i.test(creditor.name || '');
      const result = await ComplianceEngine.screen({
        type: 'sanctions',
        entityType: isBusiness ? 'business' : 'individual',
        fullName: isBusiness ? undefined : creditor.name,
        businessName: isBusiness ? creditor.name : undefined,
        country: creditor.country,
        bankAccount: creditor.accountNumber || null,
        routingNumber: creditor.routingNumber || null,
        amount: instruction.amountCents / 100,
        screenedBy: 'inhouse-bank',
        notes: `In-house bank payment screening for ${instruction.endToEndId || 'unreferenced instruction'}`,
      });
      const status = String((result && (result.status || result.risk_level)) || '').toLowerCase();
      const hit = status === 'blocked';
      const review = status === 'review';
      return {
        screened: true,
        hit,
        review,
        screeningId: (result && result.screening_id) || null,
        riskLevel: (result && result.risk_level) || null,
        provider: (result && result.provider) || 'compliance-engine',
        note: hit
          ? `${creditor.name} matched a sanctions list; the payment cannot proceed.`
          : review
            ? `${creditor.name} scored as ${result.risk_level || 'elevated'} risk; a trustee has to look at it before it leaves.`
            : `${creditor.name} cleared sanctions screening.`,
      };
    } catch (err) {
      // Fail closed: an unscreened beneficiary is not an approved beneficiary.
      return {
        screened: false,
        hit: true,
        note: `Sanctions screening is unavailable (${err.message}); the payment is held rather than released unscreened.`,
      };
    }
  }

  /**
   * @param {object} instruction canonical instruction from the ingress engine
   * @param {object} debtor      the paying virtual account
   * @param {object} [options]   { internal: boolean } — an on-us book transfer
   *                             never leaves the trust, so outflow rules do not apply
   */
  static async evaluate(instruction, debtor, { internal = false } = {}) {
    await this.ensureTables();
    const config = getConfig();
    const checks = [];
    const violations = [];
    let requiredApprovals = 1;
    let decision = 'allow';

    const fail = (code, message, action = 'deny') => {
      violations.push({ code, message, action });
      if (action === 'deny') decision = 'deny';
      else if (decision === 'allow') decision = 'review';
    };
    const pass = (code, message) => checks.push({ code, message, result: 'pass' });

    // ── Account state ────────────────────────────────────────────────────────
    if (debtor.status !== 'active') {
      fail('ACCOUNT_NOT_ACTIVE', `Virtual account ${debtor.accountNumber} is ${debtor.status}`);
    } else {
      pass('ACCOUNT_NOT_ACTIVE', `Virtual account ${debtor.accountNumber} is active`);
    }

    if (instruction.amountCents > debtor.availableCents) {
      fail(
        'INSUFFICIENT_AVAILABLE',
        `${dollars(instruction.amountCents)} exceeds the ${dollars(debtor.availableCents)} available on ${debtor.accountNumber}`
      );
    } else {
      pass('INSUFFICIENT_AVAILABLE', `${dollars(debtor.availableCents)} is available on ${debtor.accountNumber}`);
    }

    // ── Hard limits ──────────────────────────────────────────────────────────
    if (instruction.amountCents > config.singlePaymentLimitCents) {
      fail('SINGLE_PAYMENT_LIMIT', `${dollars(instruction.amountCents)} is above the ${dollars(config.singlePaymentLimitCents)} single payment limit`);
    } else {
      pass('SINGLE_PAYMENT_LIMIT', `Within the ${dollars(config.singlePaymentLimitCents)} single payment limit`);
    }

    if (!internal) {
      const dailyOutflow = await this._dailyOutflow();
      if (dailyOutflow + instruction.amountCents > config.dailyOutflowLimitCents) {
        fail(
          'DAILY_OUTFLOW_LIMIT',
          `Today's external outflow would reach ${dollars(dailyOutflow + instruction.amountCents)} against a ${dollars(config.dailyOutflowLimitCents)} limit`
        );
      } else {
        pass('DAILY_OUTFLOW_LIMIT', `External outflow today is ${dollars(dailyOutflow)} of ${dollars(config.dailyOutflowLimitCents)}`);
      }

      if (config.blockedCountries.includes(instruction.creditor.country)) {
        fail('BLOCKED_COUNTRY', `Payments to ${instruction.creditor.country} are blocked by policy`);
      } else {
        pass('BLOCKED_COUNTRY', `Destination country ${instruction.creditor.country} is permitted`);
      }
    }

    // ── Velocity ─────────────────────────────────────────────────────────────
    const velocity = await this._velocity({ vaId: debtor.vaId, windowMinutes: config.velocityWindowMinutes });
    if (velocity.count + 1 > config.velocityMaxPayments) {
      fail(
        'VELOCITY_COUNT',
        `${velocity.count + 1} payments in ${config.velocityWindowMinutes} minutes from ${debtor.accountNumber} exceeds the limit of ${config.velocityMaxPayments}`,
        'review'
      );
    } else {
      pass('VELOCITY_COUNT', `${velocity.count} of ${config.velocityMaxPayments} payments used in the velocity window`);
    }
    if (velocity.amountCents + instruction.amountCents > config.velocityMaxAmountCents) {
      fail(
        'VELOCITY_AMOUNT',
        `${dollars(velocity.amountCents + instruction.amountCents)} in ${config.velocityWindowMinutes} minutes exceeds the ${dollars(config.velocityMaxAmountCents)} velocity ceiling`,
        'review'
      );
    } else {
      pass('VELOCITY_AMOUNT', `${dollars(velocity.amountCents)} of ${dollars(config.velocityMaxAmountCents)} used in the velocity window`);
    }

    // ── Stored policies ──────────────────────────────────────────────────────
    const policies = await this.listPolicies({ activeOnly: true });
    const applicable = policies.filter(policy => {
      if (policy.scope === 'global') return true;
      if (policy.scope === 'account') return [debtor.vaId, debtor.accountNumber].includes(policy.scope_ref);
      if (policy.scope === 'owner') return debtor.ownerRef && debtor.ownerRef === policy.scope_ref;
      if (policy.scope === 'purpose') return instruction.paymentPurpose === policy.scope_ref;
      return false;
    });

    for (const policy of applicable) {
      if (policy.max_amount_cents !== null && instruction.amountCents > Number(policy.max_amount_cents)) {
        fail('POLICY_MAX_AMOUNT', `${policy.name}: ${dollars(instruction.amountCents)} exceeds ${dollars(policy.max_amount_cents)}`, policy.action);
      }
      if (policy.window_minutes && (policy.window_max_amount_cents !== null || policy.window_max_count !== null)) {
        const windowed = await this._velocity({ vaId: debtor.vaId, windowMinutes: Number(policy.window_minutes) });
        if (policy.window_max_amount_cents !== null && windowed.amountCents + instruction.amountCents > Number(policy.window_max_amount_cents)) {
          fail(
            'POLICY_WINDOW_AMOUNT',
            `${policy.name}: ${dollars(windowed.amountCents + instruction.amountCents)} over ${policy.window_minutes} minutes exceeds ${dollars(policy.window_max_amount_cents)}`,
            policy.action
          );
        }
        if (policy.window_max_count !== null && windowed.count + 1 > Number(policy.window_max_count)) {
          fail(
            'POLICY_WINDOW_COUNT',
            `${policy.name}: ${windowed.count + 1} payments over ${policy.window_minutes} minutes exceeds ${policy.window_max_count}`,
            policy.action
          );
        }
      }
      if (policy.required_approvals !== null) {
        requiredApprovals = Math.max(requiredApprovals, Number(policy.required_approvals));
      }
    }

    // ── Dual authorization ───────────────────────────────────────────────────
    if (instruction.amountCents >= config.dualApprovalThresholdCents) {
      requiredApprovals = Math.max(requiredApprovals, config.requiredApprovals);
      checks.push({
        code: 'DUAL_AUTHORIZATION',
        result: 'pass',
        message: `${dollars(instruction.amountCents)} is at or above the ${dollars(config.dualApprovalThresholdCents)} dual-authorization threshold: ${requiredApprovals} approvals required`,
      });
    }

    // ── Sanctions ────────────────────────────────────────────────────────────
    const screening = internal
      ? { screened: false, hit: false, note: 'On-us transfer between two accounts of the same trust; no external party to screen.' }
      : await this._screen(instruction);
    if (screening.hit) fail('SANCTIONS', screening.note);
    else if (screening.review) fail('SANCTIONS', screening.note, 'review');
    else checks.push({ code: 'SANCTIONS', result: 'pass', message: screening.note });

    const railRestrictions = applicable
      .flatMap(policy => {
        const allowed = policy.allowed_rails ? (typeof policy.allowed_rails === 'string' ? JSON.parse(policy.allowed_rails) : policy.allowed_rails) : null;
        const blocked = policy.blocked_rails ? (typeof policy.blocked_rails === 'string' ? JSON.parse(policy.blocked_rails) : policy.blocked_rails) : null;
        return [{ policy: policy.name, allowedRails: allowed, blockedRails: blocked }];
      })
      .filter(entry => entry.allowedRails || entry.blockedRails);

    if (debtor.allowedRails) {
      const allowed = typeof debtor.allowedRails === 'string' ? JSON.parse(debtor.allowedRails) : debtor.allowedRails;
      if (Array.isArray(allowed) && allowed.length) railRestrictions.push({ policy: 'account', allowedRails: allowed, blockedRails: null });
    }

    return {
      decision,
      requiredApprovals: decision === 'deny' ? requiredApprovals : requiredApprovals,
      checks,
      violations,
      velocity,
      screening,
      railRestrictions,
      policiesEvaluated: applicable.map(policy => policy.policy_id),
      note: decision === 'allow'
        ? `Policy cleared; ${requiredApprovals} approval(s) required before execution.`
        : decision === 'review'
          ? 'Policy did not refuse the payment outright, but it is held for a trustee to look at.'
          : `Policy refused the payment: ${violations.filter(v => v.action === 'deny').map(v => v.message).join('; ')}`,
    };
  }
}

module.exports = { GovernanceEngine, GovernanceError, DECISIONS };
