'use strict';

/**
 * PTC In-House Family Bank — direct host-to-host wire engine
 *
 * This is the trust's own wire rail. There is no aggregator in the path: an
 * approved and dispatched in-house-bank payment is rendered as a pacs.008,
 * written into the correspondent bank's SFTP outbound drop, and then tracked
 * until the bank's own files say what happened to it.
 *
 * The engine is four cooperating pieces, each of which exists to make one
 * specific way of losing money impossible:
 *
 *   idempotency vault   one payment can produce at most one file on the bank
 *                       host, no matter how many operators or retries push it
 *   state machine       a wire the bank can already see never reports itself as
 *                       failed, so a "retry" cannot become a second wire
 *   reconciliation      local transmissions and bank advices are matched by
 *                       identity, and anything that does not match becomes a
 *                       durable exception instead of a silent assumption
 *   return handling     a pacs.004 return reverses the ledger exactly once,
 *                       through the in-house bank's own compensating path
 *
 * Where the money actually moves is unchanged: `InHouseBankEngine` remains the
 * single authority on balances. This engine only ever reports rail outcomes
 * into `confirm()`, which is the one door to `settled`, `returned` and
 * `failed`. Nothing here posts to a ledger directly.
 *
 * The one case that deliberately refuses to self-heal is a return that arrives
 * after the payment has already settled. The in-house bank will only confirm a
 * dispatched payment, and reversing a settled wire days later is a decision
 * with tax and trust-accounting consequences. The wire is marked returned, the
 * bank's reference and reason are recorded, and a `return_after_settlement`
 * exception is raised for an operator — the engine will not quietly re-credit
 * a closed payment.
 */

const crypto = require('crypto');
const pool = require('../../bonds/pgPool');
const { getWireChannelConfig, wireChannelReadiness } = require('./wireHostToHostConfig');
const { withWireTransport, WireTransportError } = require('./wireTransport');
const { WireIdempotencyVault, WireVaultError, hashPayload } = require('./wireIdempotencyVault');
const { assertTransition, bankHoldsFile, paymentOutcomeFor, WireStateError, TRANSITIONS } = require('./wireStateMachine');
const { parseAdvice, WireAdviceError } = require('./wireAdviceParser');
const { InHouseBankEngine } = require('../inHouseBankEngine');
const { DualLedgerEngine } = require('../dualLedgerEngine');
const { MftOsEngine, MftError } = require('../../os/mftOsEngine');

class WireHostToHostError extends Error {
  constructor(message, code = 'WIRE_H2H_ERROR', status = 400, details = {}) {
    super(message);
    this.name = 'WireHostToHostError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
    this.details = details;
  }
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
}

/**
 * Deterministic filename. The payment id is in the name because the bank's
 * advices frequently echo only the filename, and being able to get from a
 * filename back to a payment without a database round trip is what makes
 * reconciliation of a stray file possible.
 */
function filenameFor(payment, config = getWireChannelConfig()) {
  return `${config.filePrefix}_${stamp(payment.dispatchedAt ? new Date(payment.dispatchedAt) : new Date())}_${payment.paymentId}.xml`;
}

class WireHostToHostEngine {
  static config() {
    return getWireChannelConfig();
  }

  static readiness() {
    return wireChannelReadiness();
  }

  static states() {
    return TRANSITIONS;
  }

  static async ensureTables() {
    return WireIdempotencyVault.ensureTables();
  }

  /**
   * The channel this engine reads and writes. With WIRE_H2H_MFT_CHANNEL set,
   * the host, credentials and directory layout are the MFT channel's; the
   * wire-specific settings (rails, SLAs, prefix) stay this engine's own.
   */
  static async _channel() {
    const config = getWireChannelConfig();
    if (config.transport !== 'mft') return config;
    const mft = await MftOsEngine.transportFor(config.mftChannelId);
    return { ...config, ...mft, transport: mft.transport, via: 'mft', mftChannelId: config.mftChannelId };
  }

  /**
   * Render the pacs.008 for a dispatched payment and hash it, without touching
   * the bank host. Safe to call repeatedly: the same payment always produces
   * the same bytes for the same dispatch, so the hash is a stable identity the
   * vault can compare a retry against.
   */
  static async prepare(paymentId) {
    const payment = await InHouseBankEngine.require(paymentId);
    const config = getWireChannelConfig();

    if (payment.internal) {
      throw new WireHostToHostError(
        `Payment ${paymentId} is an on-us transfer and never leaves the bank; it has no wire file`,
        'WIRE_H2H_INTERNAL_PAYMENT',
        409
      );
    }
    if (payment.status !== 'dispatched') {
      throw new WireHostToHostError(
        `Payment ${paymentId} is ${payment.status}; only a dispatched payment has cleared approval and funding to be wired`,
        'WIRE_H2H_NOT_DISPATCHED',
        409
      );
    }
    if (payment.rail && config.rails.length && !config.rails.includes(payment.rail)) {
      throw new WireHostToHostError(
        `Rail ${payment.rail} is not carried by this wire channel (${config.rails.join(', ')})`,
        'WIRE_H2H_RAIL_NOT_CARRIED',
        409
      );
    }

    const payload = await InHouseBankEngine.pacs008(paymentId);
    const content = typeof payload === 'string' ? payload : (payload && (payload.xml || payload.message)) || '';
    if (!content) {
      throw new WireHostToHostError(`No pacs.008 could be rendered for ${paymentId}`, 'WIRE_H2H_NO_MESSAGE', 500);
    }

    return {
      payment,
      filename: filenameFor(payment, config),
      payload: content,
      payloadHash: hashPayload(content),
      remoteDir: config.outboundPath,
    };
  }

  /**
   * Transmit an approved, dispatched payment to the bank host — at most once,
   * ever, for that payment.
   *
   * The vault decides whether this call is the one that transmits. A replay
   * after a successful transmission returns the original transmission and
   * writes nothing. A call that finds a live reservation is refused rather
   * than racing it.
   */
  static async transmit(paymentId, { actor = 'operator', allowRetryAfterFailure = true } = {}) {
    await this.ensureTables();
    const readiness = this.readiness();
    if (!readiness.ready) {
      throw new WireHostToHostError(
        `The wire channel is not configured for transmission: ${readiness.blockers.join('; ')}`,
        'WIRE_H2H_NOT_CONFIGURED',
        412,
        { blockers: readiness.blockers }
      );
    }

    const prepared = await this.prepare(paymentId);
    const { payment, filename, payload, payloadHash } = prepared;
    const owner = `${actor}@${process.pid}`;

    const claim = await WireIdempotencyVault.reserve({
      paymentId,
      filename,
      payload,
      payloadHash,
      owner,
      rail: payment.rail,
      amountCents: payment.amountCents + payment.feeCents,
      currency: payment.currency,
      endToEndId: payment.endToEndId,
      uetr: payment.uetr,
      creditorName: payment.creditor && payment.creditor.name,
      creditorAccount: payment.creditor && payment.creditor.accountNumber,
    });

    if (!claim.reserved) {
      if (claim.reason === 'previous_attempt_failed' && allowRetryAfterFailure) {
        assertTransition(claim.transmission.state, 'reserved', claim.transmission);
        const retried = await WireIdempotencyVault.apply(claim.transmission.transmissionId, 'reserved', {
          actor,
          reason: 'retrying a transmission that failed before the bank received the file',
        });
        return this._deliver(retried, payment, { actor });
      }
      return {
        transmitted: false,
        replay: claim.replay,
        reason: claim.reason,
        transmission: claim.transmission,
      };
    }

    return this._deliver(claim.transmission, payment, { actor });
  }

  /** Write the file and record the outcome. Only ever called by a reservation holder. */
  static async _deliver(transmission, payment, { actor }) {
    const config = await this._channel();
    assertTransition(transmission.state, 'transmitting', transmission);
    const transmitting = await WireIdempotencyVault.apply(transmission.transmissionId, 'transmitting', {
      actor,
      reason: `writing ${transmission.filename} to ${config.outboundPath}`,
    });

    let remotePath;
    let mftFileId = null;
    try {
      if (config.via === 'mft') {
        const approvals = payment.approvals || [];
        const approver = approvals.length ? approvals[approvals.length - 1].approver : null;
        const delivered = await MftOsEngine.deliver({
          channelId: config.mftChannelId,
          fileType: 'wire_payment',
          format: 'pacs.008',
          content: transmitting.payload,
          filename: transmitting.filename,
          sourceRef: `wire:${payment.paymentId}`,
          builtBy: payment.initiatedBy || 'in-house-bank',
          approvedBy: approver,
          memo: payment.memo || payment.description || null,
          actor,
        });
        remotePath = delivered.file.remotePath;
        mftFileId = delivered.file.fileId;
      } else {
        remotePath = await withWireTransport(
          session => session.put(config.outboundPath, transmitting.filename, transmitting.payload),
          config
        );
      }
    } catch (err) {
      // Nothing was renamed into place, so the bank cannot have a complete
      // file: this is a genuine failure and the wire may be retried.
      const failed = await WireIdempotencyVault.apply(transmitting.transmissionId, 'failed', {
        actor,
        reason: 'transmission failed before the bank received a complete file',
        evidence: { error: err.message },
        patch: { lastError: err.message },
      });
      await DualLedgerEngine.appendEvent({
        eventType: 'wire.transmission.failed',
        paymentId: payment.paymentId,
        actor,
        payload: { transmissionId: failed.transmissionId, filename: failed.filename, error: err.message },
      });
      throw err instanceof WireTransportError || err instanceof MftError
        ? err
        : new WireHostToHostError(`Wire transmission failed: ${err.message}`, 'WIRE_H2H_TRANSMIT_FAILED', 502);
    }

    assertTransition(transmitting.state, 'transmitted', transmitting);
    const transmitted = await WireIdempotencyVault.apply(transmitting.transmissionId, 'transmitted', {
      actor,
      reason: 'file renamed into the bank outbound directory',
      evidence: { remotePath, payloadHash: transmitting.payloadHash, transport: config.transport, mftFileId },
      patch: { remotePath },
    });
    await DualLedgerEngine.appendEvent({
      eventType: 'wire.transmitted',
      paymentId: payment.paymentId,
      actor,
      payload: {
        transmissionId: transmitted.transmissionId,
        filename: transmitted.filename,
        remotePath,
        payloadHash: transmitted.payloadHash,
        transport: config.transport,
        host: config.host || null,
        mftFileId,
      },
    });
    return { transmitted: true, replay: false, reason: null, transmission: transmitted, mftFileId };
  }

  /**
   * Read every advice file the bank has left for us and apply it.
   *
   * Exactly-once is enforced on the content hash of the file: a bank that
   * re-drops yesterday's ACK, or an operator who runs this twice, cannot make
   * a payment settle twice or a return credit twice. The state machine is the
   * second guard, and `InHouseBankEngine.confirm`'s dispatched-only rule is
   * the third.
   */
  static async ingestAdvices({ actor = 'reconciliation', limit = 200 } = {}) {
    await this.ensureTables();
    const config = await this._channel();
    const results = { files: 0, records: 0, applied: [], duplicates: [], unmatched: [], errors: [] };

    await withWireTransport(async session => {
      const directories = [
        { path: config.ackPath, forced: null },
        { path: config.returnPath, forced: 'return' },
      ];
      for (const directory of directories) {
        const entries = (await session.list(directory.path))
          .filter(entry => !entry.name.endsWith(config.stagingSuffix))
          .slice(0, limit);
        for (const entry of entries) {
          const remote = `${directory.path}/${entry.name}`;
          let content;
          try {
            content = await session.read(remote);
          } catch (err) {
            results.errors.push({ filename: entry.name, error: err.message });
            continue;
          }
          results.files += 1;
          let records;
          try {
            records = parseAdvice(content, entry.name);
          } catch (err) {
            results.errors.push({ filename: entry.name, error: err.message });
            await this.raiseException({
              kind: 'unparsable_advice',
              filename: entry.name,
              detail: err.message,
              context: { remotePath: remote },
            });
            continue;
          }
          for (const record of records) {
            results.records += 1;
            const advice = directory.forced ? { ...record, adviceType: directory.forced, outcome: record.outcome || 'returned' } : record;
            const applied = await this.applyAdvice(advice, { actor });
            if (applied.duplicate) results.duplicates.push(applied);
            else if (!applied.matched) results.unmatched.push(applied);
            else results.applied.push(applied);
          }
          if (config.archiveProcessedAdvices) {
            try {
              await session.move(remote, config.archivePath, entry.name);
            } catch (err) {
              results.errors.push({ filename: entry.name, error: `archive failed: ${err.message}` });
            }
          }
        }
      }
    }, config);

    return results;
  }

  /**
   * Apply one parsed advice record. Public because operators also feed advices
   * in by hand when a bank sends one out of band.
   */
  static async applyAdvice(advice, { actor = 'reconciliation' } = {}) {
    await this.ensureTables();
    if (!advice || !advice.contentHash) {
      throw new WireAdviceError('An advice record with a content hash is required');
    }

    const transmission = await this._match(advice);
    const adviceId = newId('IHWA');
    const stored = await pool.query(
      `INSERT INTO ihb_wire_advices
        (advice_id, content_hash, filename, advice_type, transmission_id, payment_id, bank_reference, raw, parsed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (content_hash) DO NOTHING
       RETURNING advice_id`,
      [
        adviceId,
        `${advice.contentHash}:${advice.endToEndId || advice.paymentId || advice.bankReference || ''}:${advice.outcome || advice.status || ''}`,
        advice.filename || null,
        advice.adviceType,
        transmission ? transmission.transmissionId : null,
        transmission ? transmission.paymentId : (advice.paymentId || null),
        advice.bankReference || null,
        advice.raw || '',
        JSON.stringify({ ...advice, raw: undefined }),
      ]
    );

    if (!stored.rows[0]) {
      return { duplicate: true, matched: Boolean(transmission), adviceId: null, advice, transmission };
    }

    if (!transmission) {
      await this.raiseException({
        kind: 'unmatched_advice',
        filename: advice.filename,
        detail: 'The bank sent an advice that matches no local wire transmission',
        context: {
          endToEndId: advice.endToEndId,
          paymentId: advice.paymentId,
          bankReference: advice.bankReference,
          status: advice.status,
        },
      });
      return { duplicate: false, matched: false, adviceId, advice, transmission: null };
    }

    const outcome = advice.outcome;
    if (!outcome) {
      return { duplicate: false, matched: true, adviceId, advice, transmission, applied: false, reason: 'no actionable status' };
    }

    const result = await this._settleFromAdvice(transmission, advice, outcome, actor);
    await pool.query('UPDATE ihb_wire_advices SET applied = TRUE, outcome = $2 WHERE advice_id = $1', [adviceId, outcome]);
    return { duplicate: false, matched: true, adviceId, advice, ...result };
  }

  /** Move the wire, then tell the in-house bank what the rail did. */
  static async _settleFromAdvice(transmission, advice, outcome, actor) {
    if (!bankHoldsFile(transmission.state)) {
      await this.raiseException({
        kind: 'advice_before_transmission',
        transmissionId: transmission.transmissionId,
        paymentId: transmission.paymentId,
        filename: advice.filename,
        detail: `The bank reported ${outcome} for a wire that is locally ${transmission.state}`,
        context: { status: advice.status, bankReference: advice.bankReference },
      });
      return { transmission, applied: false, reason: 'advice arrived before the local wire was transmitted' };
    }

    let moved = transmission;
    try {
      assertTransition(transmission.state, outcome, transmission);
      moved = await WireIdempotencyVault.apply(transmission.transmissionId, outcome, {
        actor,
        reason: advice.reason || `bank advice ${advice.status || outcome}`,
        evidence: { filename: advice.filename, status: advice.status, reasonCode: advice.reasonCode },
        patch: {
          bankReference: advice.bankReference || undefined,
          returnReference: outcome === 'returned' ? (advice.bankReference || 'unreferenced return') : undefined,
          returnReason: outcome === 'returned' || outcome === 'rejected'
            ? (advice.reason || advice.reasonCode || 'returned by the beneficiary bank')
            : undefined,
        },
      });
    } catch (err) {
      if (!(err instanceof WireStateError)) throw err;
      await this.raiseException({
        kind: 'illegal_advice_transition',
        transmissionId: transmission.transmissionId,
        paymentId: transmission.paymentId,
        filename: advice.filename,
        detail: err.message,
        context: { from: transmission.state, to: outcome },
      });
      return { transmission, applied: false, reason: err.message };
    }

    if (moved.state === 'acknowledged') {
      return { transmission: moved, applied: true, paymentOutcome: null };
    }

    const paymentOutcome = paymentOutcomeFor(moved.state);
    if (!paymentOutcome) return { transmission: moved, applied: true, paymentOutcome: null };

    const payment = await InHouseBankEngine.get(transmission.paymentId);
    if (!payment) {
      await this.raiseException({
        kind: 'orphan_transmission',
        transmissionId: moved.transmissionId,
        paymentId: transmission.paymentId,
        detail: 'The wire references a payment that no longer exists',
      });
      return { transmission: moved, applied: true, paymentOutcome: null };
    }

    if (payment.status !== 'dispatched') {
      // Chiefly a return arriving after settlement. The ledger reversal is a
      // trust-accounting decision, so it is escalated rather than performed.
      await this.raiseException({
        kind: paymentOutcome === 'returned' && payment.status === 'settled' ? 'return_after_settlement' : 'payment_not_dispatched',
        transmissionId: moved.transmissionId,
        paymentId: payment.paymentId,
        filename: advice.filename,
        detail: `The bank reported ${paymentOutcome} but payment ${payment.paymentId} is ${payment.status}; the ledger was not moved automatically`,
        context: { bankReference: advice.bankReference, reason: advice.reason, reasonCode: advice.reasonCode },
      });
      return { transmission: moved, applied: true, paymentOutcome: null, escalated: true };
    }

    const confirmed = await InHouseBankEngine.confirm(payment.paymentId, {
      outcome: paymentOutcome,
      reference: advice.bankReference || (paymentOutcome === 'settled' ? null : 'bank-advice'),
      actor: `wire-h2h:${actor}`,
      reason: advice.reason || advice.reasonCode || null,
    });
    return { transmission: moved, applied: true, paymentOutcome, payment: confirmed };
  }

  /**
   * Match an advice to a transmission by identity only — our filename, the
   * end-to-end id, the payment id, or a bank reference we have already stored.
   * Never by amount.
   */
  static async _match(advice) {
    if (advice.originalFilename) {
      const byFile = await WireIdempotencyVault.byFilename(advice.originalFilename);
      if (byFile) return byFile;
    }
    const rows = await pool.query(
      `SELECT * FROM ihb_wire_transmissions
        WHERE ($1::text IS NOT NULL AND payment_id = $1)
           OR ($2::text IS NOT NULL AND end_to_end_id = $2)
           OR ($3::text IS NOT NULL AND uetr = $3)
           OR ($4::text IS NOT NULL AND bank_reference = $4)
        ORDER BY created_at DESC
        LIMIT 1`,
      [advice.paymentId || null, advice.endToEndId || null, advice.uetr || null, advice.bankReference || null]
    );
    if (!rows.rows[0]) return null;
    return WireIdempotencyVault.get(rows.rows[0].transmission_id);
  }

  /**
   * Compare local state against the channel's expectations and record what
   * does not add up. Repeatable: an unresolved exception is refreshed rather
   * than duplicated, so running this on a schedule does not create noise.
   */
  static async reconcile({ actor = 'reconciliation' } = {}) {
    await this.ensureTables();
    const config = getWireChannelConfig();
    const findings = [];

    const awaitingAck = await pool.query(
      `SELECT * FROM ihb_wire_transmissions
        WHERE state = 'transmitted'
          AND transmitted_at < NOW() - ($1 || ' minutes')::interval`,
      [String(config.ackSlaMinutes)]
    );
    for (const row of awaitingAck.rows) {
      findings.push(await this.raiseException({
        kind: 'missing_acknowledgement',
        transmissionId: row.transmission_id,
        paymentId: row.payment_id,
        filename: row.filename,
        detail: `The bank has not acknowledged ${row.filename} within ${config.ackSlaMinutes} minutes`,
        context: { transmittedAt: row.transmitted_at },
      }));
    }

    const awaitingSettlement = await pool.query(
      `SELECT * FROM ihb_wire_transmissions
        WHERE state = 'acknowledged'
          AND acknowledged_at < NOW() - ($1 || ' minutes')::interval`,
      [String(config.settlementSlaMinutes)]
    );
    for (const row of awaitingSettlement.rows) {
      findings.push(await this.raiseException({
        kind: 'missing_settlement',
        transmissionId: row.transmission_id,
        paymentId: row.payment_id,
        filename: row.filename,
        detail: `The bank acknowledged ${row.filename} but has not confirmed settlement within ${config.settlementSlaMinutes} minutes`,
        context: { acknowledgedAt: row.acknowledged_at },
      }));
    }

    const stuck = await pool.query(
      `SELECT * FROM ihb_wire_transmissions
        WHERE state IN ('reserved','transmitting')
          AND reserved_at < NOW() - ($1 || ' minutes')::interval`,
      [String(config.reservationStaleMinutes)]
    );
    for (const row of stuck.rows) {
      findings.push(await this.raiseException({
        kind: 'stale_reservation',
        transmissionId: row.transmission_id,
        paymentId: row.payment_id,
        filename: row.filename,
        detail: `${row.filename} has held a ${row.state} reservation since ${row.reserved_at}; verify on the bank host before retrying`,
        context: { reservedAt: row.reserved_at, owner: row.reservation_owner },
      }));
    }

    // A payment the bank ledger has dispatched on a wire rail but that this
    // channel has never seen is the most dangerous gap: the money left the
    // virtual account and no file exists.
    const undispatched = await pool.query(
      `SELECT p.payment_id, p.rail, p.dispatched_at
         FROM ihb_payments p
         LEFT JOIN ihb_wire_transmissions w ON w.payment_id = p.payment_id
        WHERE p.status = 'dispatched'
          AND p.internal = FALSE
          AND w.transmission_id IS NULL
          AND p.rail = ANY($1::text[])`,
      [config.rails]
    );
    for (const row of undispatched.rows) {
      findings.push(await this.raiseException({
        kind: 'dispatched_without_file',
        paymentId: row.payment_id,
        detail: `Payment ${row.payment_id} is dispatched on ${row.rail} but no wire file has been prepared`,
        context: { dispatchedAt: row.dispatched_at },
      }));
    }

    const open = await this.exceptions({ resolved: false });
    await DualLedgerEngine.appendEvent({
      eventType: 'wire.reconciled',
      actor,
      payload: { raised: findings.length, open: open.length, transport: config.transport },
    });
    return { raised: findings.length, open, findings };
  }

  static async raiseException({ kind, transmissionId = null, paymentId = null, filename = null, detail = '', context = {} }) {
    await this.ensureTables();
    const rows = await pool.query(
      `INSERT INTO ihb_wire_exceptions (exception_id, kind, transmission_id, payment_id, filename, detail, context)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (kind, COALESCE(transmission_id, filename, '')) WHERE resolved = FALSE
       DO UPDATE SET last_seen_at = NOW(), detail = EXCLUDED.detail, context = EXCLUDED.context
       RETURNING *`,
      [newId('IHWX'), kind, transmissionId, paymentId, filename, detail, JSON.stringify(context || {})]
    );
    return this._mapException(rows.rows[0]);
  }

  static async resolveException(exceptionId, { actor, resolution }) {
    await this.ensureTables();
    if (!resolution) {
      throw new WireHostToHostError('A resolution note is required to close a wire exception', 'WIRE_H2H_NO_RESOLUTION', 400);
    }
    const rows = await pool.query(
      `UPDATE ihb_wire_exceptions
          SET resolved = TRUE, resolved_by = $2, resolved_at = NOW(), resolution = $3
        WHERE exception_id = $1 AND resolved = FALSE
       RETURNING *`,
      [exceptionId, actor || null, resolution]
    );
    if (!rows.rows[0]) {
      throw new WireHostToHostError(`Wire exception ${exceptionId} is not open`, 'WIRE_H2H_EXCEPTION_NOT_OPEN', 404);
    }
    return this._mapException(rows.rows[0]);
  }

  static async exceptions({ resolved = false, limit = 200 } = {}) {
    await this.ensureTables();
    const rows = await pool.query(
      `SELECT * FROM ihb_wire_exceptions
        WHERE ($1::boolean IS NULL OR resolved = $1)
        ORDER BY last_seen_at DESC
        LIMIT $2`,
      [resolved, Math.min(Math.max(Number(limit) || 200, 1), 500)]
    );
    return rows.rows.map(row => this._mapException(row));
  }

  static _mapException(row) {
    if (!row) return null;
    return {
      exceptionId: row.exception_id,
      kind: row.kind,
      transmissionId: row.transmission_id,
      paymentId: row.payment_id,
      filename: row.filename,
      detail: row.detail,
      context: row.context || {},
      resolved: Boolean(row.resolved),
      resolvedBy: row.resolved_by,
      resolvedAt: row.resolved_at,
      resolution: row.resolution,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  static async transmission(transmissionId) {
    const transmission = await WireIdempotencyVault.get(transmissionId);
    if (!transmission) return null;
    return { ...transmission, history: await WireIdempotencyVault.history(transmissionId) };
  }

  static async list(filters) {
    return WireIdempotencyVault.list(filters);
  }

  /** Operator dashboard for the channel. */
  static async dashboard() {
    await this.ensureTables();
    const byState = await pool.query('SELECT state, COUNT(*)::int AS count, COALESCE(SUM(amount_cents),0)::bigint AS amount_cents FROM ihb_wire_transmissions GROUP BY state');
    const open = await this.exceptions({ resolved: false, limit: 50 });
    return {
      channel: this.readiness(),
      states: byState.rows.map(row => ({ state: row.state, count: row.count, amountCents: Number(row.amount_cents) })),
      openExceptions: open.length,
      exceptions: open,
    };
  }
}

module.exports = { WireHostToHostEngine, WireHostToHostError, WireVaultError };
