'use strict';

/**
 * In-House Bank Orchestration
 *
 * This is the pipeline the five engines hang off. One payment walks through it
 * in a fixed order, and each step either advances the payment or stops it with
 * a reason that is written down:
 *
 *   1. Ingress & Idempotency   canonicalize the instruction, whatever channel
 *                              it arrived on, and make the submission safe to
 *                              retry (ingressEngine).
 *   2. Zero Trust              the caller has already been authenticated and
 *                              scoped by the gateway; the principal it returned
 *                              is carried through as the initiator, and it is
 *                              that principal — not a header — who is barred
 *                              from approving their own payment.
 *   3. Governance & Policy     limits, velocity, sanctions, dual authorization
 *                              (governanceEngine).
 *   4. Smart Routing           on-us or which rail, from the liquidity matrix
 *                              under least-cost/velocity rules (routingEngine).
 *   5. Dual Ledger Sync        move the money on the bank ledger, mirror it to
 *                              the general ledger, and append the hash-chained
 *                              event (dualLedgerEngine, virtualAccountManager).
 *
 * Two design points worth stating, because they are the difference between an
 * orchestrator and a wrapper:
 *
 *   • Funds are *held* the moment a payment is admitted, not when it executes.
 *     Between admission and settlement an external rail has the money in
 *     flight; leaving it available would let a second payment spend it.
 *   • Execution is never implied. An internal transfer settles immediately
 *     because both sides are our own ledger; an external payment stops at
 *     `dispatched` and only `confirm()` — carrying the rail's own reference —
 *     can call it settled. Nothing in this file can mark money as arrived
 *     because it believes it should have.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');
const { getConfig, readiness, RAILS } = require('./inHouseBankConfig');
const { IngressEngine } = require('./ingressEngine');
const { GovernanceEngine } = require('./governanceEngine');
const { RoutingEngine } = require('./routingEngine');
const { DualLedgerEngine } = require('./dualLedgerEngine');
const { VirtualAccountManager } = require('./virtualAccountManager');
const { ZeroTrustGateway } = require('./zeroTrustGateway');
const { Iso20022 } = require('./iso20022');

const OPEN_STATUSES = Object.freeze(['received', 'pending_approval', 'approved', 'dispatched']);

class InHouseBankError extends Error {
  constructor(message, code = 'IHB_REFUSED', status = 409) {
    super(message);
    this.name = 'InHouseBankError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function paymentId() {
  return `IHB-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function publicPayment(row) {
  if (!row) return null;
  return {
    paymentId: row.payment_id,
    status: row.status,
    isoStatus: Iso20022.statusCode(row.status),
    rail: row.rail,
    internal: Boolean(row.internal),
    amountCents: Number(row.amount_cents),
    amount: (Number(row.amount_cents) / 100).toFixed(2),
    feeCents: Number(row.fee_cents || 0),
    currency: row.currency,
    debtorAccountNumber: row.debtor_account_number,
    debtorVaId: row.debtor_va_id,
    creditorVaId: row.creditor_va_id,
    creditor: parseJson(row.creditor, {}),
    paymentPurpose: row.payment_purpose,
    purposeCode: row.purpose_code,
    requestedSpeed: row.requested_speed,
    endToEndId: row.end_to_end_id,
    uetr: row.uetr,
    channel: row.channel,
    sourceFormat: row.source_format,
    idempotencyKey: row.idempotency_key,
    requiredApprovals: Number(row.required_approvals || 1),
    approvals: parseJson(row.approvals, []),
    policy: parseJson(row.policy, null),
    routing: parseJson(row.routing, null),
    holdId: row.hold_id,
    initiatedBy: row.initiated_by,
    settlementReference: row.settlement_reference,
    failureReason: row.failure_reason,
    dispatchedAt: row.dispatched_at,
    settledAt: row.settled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class InHouseBankEngine {
  static config() {
    return getConfig();
  }

  static readiness() {
    return readiness();
  }

  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ihb_payments (
        payment_id            TEXT PRIMARY KEY,
        idempotency_key       TEXT,
        end_to_end_id         TEXT,
        uetr                  TEXT,
        status                TEXT NOT NULL DEFAULT 'received'
                              CHECK (status IN ('received','pending_approval','approved','dispatched',
                                                'settled','returned','rejected','failed','cancelled')),
        rail                  TEXT,
        internal              BOOLEAN NOT NULL DEFAULT FALSE,
        amount_cents          BIGINT NOT NULL,
        fee_cents             BIGINT NOT NULL DEFAULT 0,
        currency              TEXT NOT NULL DEFAULT 'USD',
        debtor_va_id          TEXT,
        debtor_account_number TEXT,
        creditor_va_id        TEXT,
        creditor              JSONB NOT NULL DEFAULT '{}',
        payment_purpose       TEXT,
        purpose_code          TEXT,
        requested_speed       TEXT,
        channel               TEXT,
        source_format         TEXT,
        instruction           JSONB,
        policy                JSONB,
        routing               JSONB,
        required_approvals    INTEGER NOT NULL DEFAULT 1,
        approvals             JSONB NOT NULL DEFAULT '[]',
        hold_id               TEXT,
        initiated_by          TEXT,
        dispatched_at         TIMESTAMPTZ,
        settled_at            TIMESTAMPTZ,
        settlement_reference  TEXT,
        failure_reason        TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ihb_payments_status ON ihb_payments (status, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ihb_payments_debtor ON ihb_payments (debtor_va_id, created_at DESC)`);
    await Promise.all([
      VirtualAccountManager.ensureTables(),
      IngressEngine.ensureTables(),
      GovernanceEngine.ensureTables(),
      RoutingEngine.ensureTables(),
      DualLedgerEngine.ensureTables(),
      ZeroTrustGateway.ensureTables(),
    ]);
    return true;
  }

  static async get(id) {
    await this.ensureTables();
    const rows = await pool.query('SELECT * FROM ihb_payments WHERE payment_id = $1', [id]);
    return publicPayment(rows.rows[0]);
  }

  static async require(id) {
    const payment = await this.get(id);
    if (!payment) throw new InHouseBankError(`Payment ${id} not found`, 'IHB_NOT_FOUND', 404);
    return payment;
  }

  static async list({ status = null, debtorRef = null, rail = null, limit = 100 } = {}) {
    await this.ensureTables();
    let debtorVaId = null;
    if (debtorRef) {
      const account = await VirtualAccountManager.get(debtorRef);
      debtorVaId = account ? account.vaId : debtorRef;
    }
    const rows = await pool.query(
      `SELECT * FROM ihb_payments
        WHERE ($1::text IS NULL OR status = $1)
          AND ($2::text IS NULL OR debtor_va_id = $2)
          AND ($3::text IS NULL OR rail = $3)
        ORDER BY created_at DESC
        LIMIT $4`,
      [status, debtorVaId, rail, Math.min(Math.max(Number(limit) || 100, 1), 500)]
    );
    return rows.rows.map(publicPayment);
  }

  static async _update(id, patch) {
    const fields = Object.keys(patch);
    const assignments = fields.map((field, index) => `${field} = $${index + 2}`);
    const rows = await pool.query(
      `UPDATE ihb_payments SET ${assignments.join(', ')}, updated_at = NOW() WHERE payment_id = $1 RETURNING *`,
      [id, ...fields.map(field => patch[field])]
    );
    return publicPayment(rows.rows[0]);
  }

  // ── 1–4: admission ─────────────────────────────────────────────────────────

  /**
   * @param {object} input
   * @param {string} input.idempotencyKey
   * @param {object} input.payload   the raw instruction as submitted
   * @param {object} input.principal the verified zero-trust principal
   * @param {string} [input.channel]
   */
  static async submit({ idempotencyKey, payload, principal, channel = 'api' } = {}) {
    await this.ensureTables();
    const actor = (principal && principal.principal) || 'system';

    const accepted = await IngressEngine.accept({ idempotencyKey, payload, principal: actor, channel });
    if (accepted.replay) {
      const existing = accepted.record.payment_id ? await this.get(accepted.record.payment_id) : null;
      return {
        replay: true,
        payment: existing,
        note: 'This idempotency key was already processed; the original payment is returned unchanged and nothing new was created.',
      };
    }

    const instruction = accepted.instruction;
    const id = paymentId();
    try {
      const debtor = await VirtualAccountManager.require(instruction.debtorAccount, 'debtor virtual account');
      const creditorInternal = instruction.creditor.accountNumber
        ? await VirtualAccountManager.get(instruction.creditor.accountNumber)
        : null;
      const internal = Boolean(creditorInternal);
      if (creditorInternal && creditorInternal.vaId === debtor.vaId) {
        throw new InHouseBankError('A virtual account cannot pay itself', 'IHB_SELF_PAYMENT', 400);
      }

      const policy = await GovernanceEngine.evaluate(instruction, debtor, { internal });

      const allowedRails = policy.railRestrictions.map(r => r.allowedRails).filter(Boolean).flat();
      const blockedRails = policy.railRestrictions.map(r => r.blockedRails).filter(Boolean).flat();

      let routing = null;
      let feeCents = 0;
      if (policy.decision !== 'deny') {
        routing = await RoutingEngine.decide(instruction, {
          internal,
          allowedRails: allowedRails.length ? allowedRails : null,
          blockedRails,
        });
        feeCents = routing.costCents;
      }

      const status = policy.decision === 'deny'
        ? 'rejected'
        : (policy.decision === 'review' || policy.requiredApprovals > 1 ? 'pending_approval' : 'approved');

      const rows = await pool.query(
        `INSERT INTO ihb_payments
           (payment_id, idempotency_key, end_to_end_id, uetr, status, rail, internal, amount_cents, fee_cents,
            currency, debtor_va_id, debtor_account_number, creditor_va_id, creditor, payment_purpose, purpose_code,
            requested_speed, channel, source_format, instruction, policy, routing, required_approvals, initiated_by,
            failure_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
         RETURNING *`,
        [
          id, idempotencyKey, instruction.endToEndId, crypto.randomUUID(), status,
          routing ? routing.rail : null, internal, instruction.amountCents, feeCents, instruction.currency,
          debtor.vaId, debtor.accountNumber, creditorInternal ? creditorInternal.vaId : null,
          JSON.stringify(instruction.creditor), instruction.paymentPurpose, instruction.purposeCode,
          instruction.requestedSpeed, instruction.channel, instruction.sourceFormat,
          JSON.stringify(instruction), JSON.stringify(policy), routing ? JSON.stringify(routing) : null,
          policy.requiredApprovals, actor,
          policy.decision === 'deny' ? policy.note : null,
        ]
      );
      let payment = publicPayment(rows.rows[0]);

      await DualLedgerEngine.appendEvent({
        eventType: policy.decision === 'deny' ? 'payment.rejected' : 'payment.received',
        paymentId: id,
        actor,
        payload: {
          amountCents: instruction.amountCents,
          rail: routing ? routing.rail : null,
          decision: policy.decision,
          violations: policy.violations,
          routingNote: routing ? routing.note : null,
        },
      });

      if (policy.decision !== 'deny') {
        // Hold the funds now: the payment is admitted, so this money is spent
        // even though it has not yet left.
        const hold = await VirtualAccountManager.placeHold({
          ref: debtor.vaId,
          amountCents: instruction.amountCents + feeCents,
          paymentId: id,
          reason: `Payment ${id} admitted for ${routing ? routing.railName : 'settlement'}`,
          placedBy: actor,
        });
        payment = await this._update(id, { hold_id: hold.holdId });
      }

      // Auto-execute only what needs no signature; anything else waits.
      if (payment.status === 'approved') {
        payment = await this.execute(id, { actor, reason: 'no additional approval required' });
      }

      await IngressEngine.complete(idempotencyKey, { paymentId: id, response: payment });
      return { replay: false, payment, policy, routing };
    } catch (err) {
      // Free the key so a corrected instruction can be retried, and leave a
      // trace of why the submission failed.
      await IngressEngine.release(idempotencyKey, err.message);
      await DualLedgerEngine.appendEvent({
        eventType: 'payment.refused',
        paymentId: id,
        actor,
        payload: { error: err.message, code: err.code || null },
      }).catch(() => null);
      throw err;
    }
  }

  // ── Approvals ──────────────────────────────────────────────────────────────

  static async approve(id, { approver, role = null, reason = null } = {}) {
    const payment = await this.require(id);
    if (payment.status !== 'pending_approval') {
      throw new InHouseBankError(`Payment ${id} is ${payment.status} and is not awaiting approval`, 'IHB_NOT_PENDING');
    }
    if (!approver) throw new InHouseBankError('An approver identity is required', 'IHB_NO_APPROVER', 400);
    // Segregation of duties, enforced against the verified principal that
    // submitted the payment rather than anything the approver can set.
    if (approver === payment.initiatedBy) {
      throw new InHouseBankError('The initiator of a payment cannot approve it', 'IHB_SEGREGATION_OF_DUTIES', 403);
    }
    if (payment.approvals.some(entry => entry.approver === approver)) {
      throw new InHouseBankError(`${approver} has already approved this payment`, 'IHB_DUPLICATE_APPROVAL');
    }

    const approvals = [...payment.approvals, { approver, role, reason, at: new Date().toISOString() }];
    const satisfied = approvals.length >= payment.requiredApprovals;
    let updated = await this._update(id, {
      approvals: JSON.stringify(approvals),
      status: satisfied ? 'approved' : 'pending_approval',
    });
    await DualLedgerEngine.appendEvent({
      eventType: 'payment.approved',
      paymentId: id,
      actor: approver,
      payload: { approvals: approvals.length, required: payment.requiredApprovals, satisfied },
    });

    if (satisfied) updated = await this.execute(id, { actor: approver, reason: 'approval threshold met' });
    return updated;
  }

  static async reject(id, { actor, reason = null } = {}) {
    const payment = await this.require(id);
    if (!OPEN_STATUSES.includes(payment.status) || payment.status === 'dispatched') {
      throw new InHouseBankError(`Payment ${id} is ${payment.status} and can no longer be rejected`, 'IHB_NOT_OPEN');
    }
    if (payment.holdId) await VirtualAccountManager.releaseHold(payment.holdId);
    const updated = await this._update(id, {
      status: 'rejected',
      failure_reason: reason || `Rejected by ${actor}`,
    });
    await DualLedgerEngine.appendEvent({ eventType: 'payment.rejected', paymentId: id, actor, payload: { reason } });
    return updated;
  }

  static async cancel(id, { actor, reason = null } = {}) {
    const payment = await this.require(id);
    if (payment.status === 'dispatched') {
      throw new InHouseBankError(
        `Payment ${id} is already with the ${payment.rail} rail; use a return, not a cancellation`,
        'IHB_ALREADY_DISPATCHED'
      );
    }
    if (!OPEN_STATUSES.includes(payment.status)) {
      throw new InHouseBankError(`Payment ${id} is ${payment.status} and cannot be cancelled`, 'IHB_NOT_OPEN');
    }
    if (payment.holdId) await VirtualAccountManager.releaseHold(payment.holdId);
    const updated = await this._update(id, { status: 'cancelled', failure_reason: reason || `Cancelled by ${actor}` });
    await DualLedgerEngine.appendEvent({ eventType: 'payment.cancelled', paymentId: id, actor, payload: { reason } });
    return updated;
  }

  // ── 5: execution and the dual ledger ───────────────────────────────────────

  static async execute(id, { actor = 'system', reason = null } = {}) {
    const payment = await this.require(id);
    if (payment.status !== 'approved') {
      throw new InHouseBankError(`Payment ${id} is ${payment.status}; only an approved payment executes`, 'IHB_NOT_APPROVED');
    }
    const config = getConfig();
    const total = payment.amountCents + payment.feeCents;

    // Capture converts the hold into a real debit; the funds were already
    // reserved at admission, so this cannot fail for insufficiency.
    if (payment.holdId) await VirtualAccountManager.captureHold(payment.holdId);
    else await VirtualAccountManager.debit({ ref: payment.debtorVaId, amountCents: total });

    const debtor = await VirtualAccountManager.get(payment.debtorVaId);

    if (payment.internal && payment.creditorVaId) {
      // On-us: one ledger, two postings, no GL impact — the settlement account
      // balance does not change when money moves between two claims on it.
      const creditor = await VirtualAccountManager.credit({ ref: payment.creditorVaId, amountCents: payment.amountCents });
      await DualLedgerEngine.record({
        paymentId: id,
        vaId: payment.debtorVaId,
        accountNumber: payment.debtorAccountNumber,
        direction: 'debit',
        amountCents: total,
        balanceAfterCents: debtor.balanceCents,
        rail: 'internal_book',
        memo: `On-us transfer to ${creditor.accountNumber}`,
        postedBy: actor,
      });
      await DualLedgerEngine.record({
        paymentId: id,
        vaId: creditor.vaId,
        accountNumber: creditor.accountNumber,
        direction: 'credit',
        amountCents: payment.amountCents,
        balanceAfterCents: creditor.balanceCents,
        rail: 'internal_book',
        memo: `On-us transfer from ${payment.debtorAccountNumber}`,
        postedBy: actor,
      });
      const settled = await this._update(id, {
        status: 'settled',
        settled_at: new Date(),
        settlement_reference: `ONUS-${id}`,
      });
      await DualLedgerEngine.appendEvent({
        eventType: 'payment.settled',
        paymentId: id,
        actor,
        payload: { rail: 'internal_book', reason, amountCents: payment.amountCents },
      });
      return settled;
    }

    // External: the bank ledger moves now, the GL mirrors it now, and the rail
    // is handed a pacs.008. Settlement is somebody else's confirmation.
    const amount = total / 100;
    await DualLedgerEngine.record({
      paymentId: id,
      vaId: payment.debtorVaId,
      accountNumber: payment.debtorAccountNumber,
      direction: 'debit',
      amountCents: total,
      balanceAfterCents: debtor ? debtor.balanceCents : null,
      rail: payment.rail,
      memo: `${payment.rail} payment to ${payment.creditor.name}`,
      postedBy: actor,
      description: `In-house bank ${payment.rail} payment ${id}`,
      glLines: [
        { accountCode: config.glOutflowAccountCode, debitAmount: amount, creditAmount: 0 },
        { accountCode: config.settlementAccountCode, debitAmount: 0, creditAmount: amount },
      ],
    });

    const dispatched = await this._update(id, { status: 'dispatched', dispatched_at: new Date() });
    await DualLedgerEngine.appendEvent({
      eventType: 'payment.dispatched',
      paymentId: id,
      actor,
      payload: { rail: payment.rail, feeCents: payment.feeCents, reason, isoMessage: RAILS[payment.rail].isoMessage },
    });
    return dispatched;
  }

  /**
   * The rail (or the operator reading its file) reports what actually
   * happened. This is the only path to `settled`.
   */
  static async confirm(id, { outcome, reference = null, actor = 'rail', reason = null } = {}) {
    const payment = await this.require(id);
    if (payment.status !== 'dispatched') {
      throw new InHouseBankError(`Payment ${id} is ${payment.status}; only a dispatched payment can be confirmed`, 'IHB_NOT_DISPATCHED');
    }
    if (!['settled', 'returned', 'failed'].includes(outcome)) {
      throw new InHouseBankError('outcome must be settled, returned or failed', 'IHB_BAD_OUTCOME', 400);
    }
    if (outcome === 'settled' && !reference) {
      throw new InHouseBankError('A settlement reference from the rail is required to mark a payment settled', 'IHB_NO_REFERENCE', 400);
    }

    if (outcome !== 'settled') {
      // The money came back, so the ledger has to show it coming back rather
      // than the debit disappearing.
      const config = getConfig();
      const total = payment.amountCents + payment.feeCents;
      await VirtualAccountManager.credit({ ref: payment.debtorVaId, amountCents: total });
      const debtor = await VirtualAccountManager.get(payment.debtorVaId);
      await DualLedgerEngine.record({
        paymentId: id,
        vaId: payment.debtorVaId,
        accountNumber: payment.debtorAccountNumber,
        direction: 'credit',
        amountCents: total,
        balanceAfterCents: debtor ? debtor.balanceCents : null,
        rail: payment.rail,
        memo: `${outcome === 'returned' ? 'Return' : 'Failure'} of ${payment.rail} payment: ${reason || 'no reason given'}`,
        postedBy: actor,
        description: `Reversal of in-house bank payment ${id}`,
        glLines: [
          { accountCode: config.settlementAccountCode, debitAmount: total / 100, creditAmount: 0 },
          { accountCode: config.glOutflowAccountCode, debitAmount: 0, creditAmount: total / 100 },
        ],
      });
    }

    const updated = await this._update(id, {
      status: outcome,
      settlement_reference: reference,
      settled_at: outcome === 'settled' ? new Date() : null,
      failure_reason: outcome === 'settled' ? null : (reason || `Rail reported ${outcome}`),
    });
    await DualLedgerEngine.appendEvent({
      eventType: `payment.${outcome}`,
      paymentId: id,
      actor,
      payload: { reference, reason, rail: payment.rail },
    });
    return updated;
  }

  // ── Funding ────────────────────────────────────────────────────────────────

  /**
   * Allocate value that already sits in the trust settlement account to a
   * virtual account, or hand it back. This is a sub-ledger movement inside the
   * bank, so it is deliberately not mirrored to the GL — the cash never moved
   * and mirroring it would double count the same dollars.
   */
  static async fund({ accountRef, amountCents, direction = 'credit', memo = null, actor = 'operator' } = {}) {
    await this.ensureTables();
    const amount = Math.round(Number(amountCents));
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new InHouseBankError('Funding amount must be a positive number of cents', 'IHB_BAD_AMOUNT', 400);
    }
    if (!['credit', 'debit'].includes(direction)) {
      throw new InHouseBankError('Funding direction must be credit or debit', 'IHB_BAD_DIRECTION', 400);
    }
    const account = direction === 'credit'
      ? await VirtualAccountManager.credit({ ref: accountRef, amountCents: amount })
      : await VirtualAccountManager.debit({ ref: accountRef, amountCents: amount });
    await DualLedgerEngine.record({
      paymentId: null,
      vaId: account.vaId,
      accountNumber: account.accountNumber,
      direction,
      amountCents: amount,
      balanceAfterCents: account.balanceCents,
      rail: 'internal_book',
      memo: memo || `${direction === 'credit' ? 'Allocation to' : 'Withdrawal from'} ${account.name} against the settlement account`,
      postedBy: actor,
      glLines: null,
    });
    await DualLedgerEngine.appendEvent({
      eventType: `account.${direction === 'credit' ? 'funded' : 'defunded'}`,
      paymentId: null,
      actor,
      payload: { vaId: account.vaId, accountNumber: account.accountNumber, amountCents: amount, memo },
    });
    return account;
  }

  // ── ISO 20022 ──────────────────────────────────────────────────────────────

  /** Ingest a pain.001 file: one payment per credit transfer transaction. */
  static async ingestPain001({ xml, principal, idempotencyKeyPrefix = null } = {}) {
    const { messageId, instructions } = Iso20022.parsePain001(xml);
    const results = [];
    for (const [index, instruction] of instructions.entries()) {
      const key = `${idempotencyKeyPrefix || messageId}-${instruction.endToEndId || index}`;
      try {
        const result = await this.submit({
          idempotencyKey: key,
          payload: instruction,
          principal,
          channel: 'iso20022',
        });
        results.push({ endToEndId: instruction.endToEndId, ...result });
      } catch (err) {
        results.push({ endToEndId: instruction.endToEndId, error: err.message, code: err.code || null });
      }
    }
    const statusReport = Iso20022.buildPain002({
      originalMessageId: messageId,
      payments: results.map(result => ({
        paymentId: result.payment ? result.payment.paymentId : (result.endToEndId || 'UNKNOWN'),
        endToEndId: result.endToEndId,
        status: result.payment ? result.payment.status : 'rejected',
        reason: result.error || (result.payment && result.payment.failureReason) || null,
      })),
    });
    return { messageId, accepted: results.filter(r => r.payment).length, results, statusReport };
  }

  static async pacs008(id) {
    const payment = await this.require(id);
    if (payment.internal) {
      throw new InHouseBankError('An on-us book transfer never leaves the bank, so it has no pacs.008', 'IHB_INTERNAL_NO_PACS', 400);
    }
    return Iso20022.buildPacs008(payment);
  }

  static async statement({ accountRef, fromDate = null, toDate = null }) {
    const account = await VirtualAccountManager.require(accountRef);
    const from = fromDate ? new Date(fromDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to = toDate ? new Date(toDate) : new Date();
    const rows = await pool.query(
      `SELECT * FROM ihb_postings
        WHERE va_id = $1 AND created_at >= $2 AND created_at <= $3
        ORDER BY created_at ASC`,
      [account.vaId, from.toISOString(), to.toISOString()]
    );
    return {
      account,
      postings: rows.rows,
      camt053: Iso20022.buildCamt053({
        account,
        postings: rows.rows,
        fromDate: from.toISOString(),
        toDate: to.toISOString(),
      }),
    };
  }

  // ── Operations view ────────────────────────────────────────────────────────

  static async dashboard() {
    await this.ensureTables();
    const config = getConfig();
    const statusRows = await pool.query(
      `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(amount_cents), 0)::bigint AS amount_cents
         FROM ihb_payments GROUP BY status`
    );
    const byStatus = statusRows.rows.reduce((acc, row) => {
      acc[row.status] = { count: Number(row.count), amountCents: Number(row.amount_cents) };
      return acc;
    }, {});
    const railRows = await pool.query(
      `SELECT rail, COUNT(*)::int AS count, COALESCE(SUM(fee_cents), 0)::bigint AS fee_cents
         FROM ihb_payments WHERE rail IS NOT NULL GROUP BY rail`
    );

    const [position, matrix, chain, reconciliation] = await Promise.all([
      VirtualAccountManager.position(),
      RoutingEngine.matrix({ amountCents: 100000 }),
      DualLedgerEngine.verifyChain(),
      DualLedgerEngine.reconcile(),
    ]);

    return {
      bank: { name: config.bankName, bic: config.bankBic, currency: config.currency },
      readiness: readiness(),
      payments: {
        byStatus,
        byRail: railRows.rows.map(row => ({ rail: row.rail, count: Number(row.count), feeCents: Number(row.fee_cents) })),
        awaitingApproval: (byStatus.pending_approval || { count: 0 }).count,
        inFlight: (byStatus.dispatched || { count: 0 }).count,
      },
      virtualAccounts: position,
      liquidityMatrix: matrix,
      eventChain: chain,
      reconciliation,
    };
  }
}

module.exports = { InHouseBankEngine, InHouseBankError };
