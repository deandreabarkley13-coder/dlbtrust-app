'use strict';

/**
 * Wire dispatch link — the last mile between the payment API and the bank host
 *
 * The in-house bank marks an external payment `dispatched` the moment the
 * ledger has moved, and the host-to-host engine can transmit a dispatched
 * payment and can read the bank's advices back. Until now nothing joined the
 * two: a payment could sit dispatched — money already debited from the family
 * member's virtual account — with no file on the bank host, until an operator
 * remembered to press transmit. This is that missing link, and it runs on a
 * timer instead of on a memory.
 *
 * One cycle does three things, in this order and for a reason:
 *
 *   1. transmit   every dispatched wire-rail payment that has no transmission
 *                 yet. Ordered oldest first, because the oldest is the one
 *                 whose beneficiary is already waiting.
 *   2. ingest     read the bank's ack, status and return advices, which is
 *                 what actually settles or reverses a payment.
 *   3. reconcile  at most once per reconcile interval, raise exceptions for
 *                 anything that has missed its SLA.
 *
 * Nothing here can move money or invent an outcome. Transmission is guarded by
 * the idempotency vault (one file per payment, ever), settlement still comes
 * only from a bank advice through `InHouseBankEngine.confirm`, and a payment
 * this link cannot transmit becomes a durable wire exception rather than a log
 * line. A cycle that fails half way is safe to run again — that is the whole
 * design: the link is a driver, not a state holder.
 */

const pool = require('../../bonds/pgPool');
const { getWireChannelConfig, wireChannelReadiness } = require('./wireHostToHostConfig');
const { WireHostToHostEngine } = require('./wireHostToHostEngine');

function intEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function getLinkConfig() {
  return {
    // The link is opt-out rather than opt-in: a dispatched wire that never
    // leaves is worse than a link that has nothing to do.
    enabled: boolEnv('WIRE_H2H_LINK_ENABLED', true),
    intervalSeconds: intEnv('WIRE_H2H_LINK_INTERVAL_SECONDS', 300, { min: 15, max: 86400 }),
    reconcileEverySeconds: intEnv('WIRE_H2H_LINK_RECONCILE_SECONDS', 3600, { min: 60, max: 86400 }),
    batchSize: intEnv('WIRE_H2H_LINK_BATCH', 25, { min: 1, max: 500 }),
    ingestAdvices: boolEnv('WIRE_H2H_LINK_INGEST', true),
    // Transmit as soon as the payment is dispatched, instead of waiting for
    // the next cycle. The cycle remains the safety net either way.
    transmitOnDispatch: boolEnv('WIRE_H2H_TRANSMIT_ON_DISPATCH', true),
  };
}

class WireDispatchLink {
  static config() {
    return getLinkConfig();
  }

  static async ensureTables() {
    await WireHostToHostEngine.ensureTables();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ihb_wire_link_runs (
        run_id        BIGSERIAL PRIMARY KEY,
        trigger       TEXT NOT NULL,
        actor         TEXT,
        candidates    INTEGER NOT NULL DEFAULT 0,
        transmitted   INTEGER NOT NULL DEFAULT 0,
        skipped       INTEGER NOT NULL DEFAULT 0,
        failed        INTEGER NOT NULL DEFAULT 0,
        advices       INTEGER NOT NULL DEFAULT 0,
        settled       INTEGER NOT NULL DEFAULT 0,
        reconciled    BOOLEAN NOT NULL DEFAULT FALSE,
        detail        JSONB NOT NULL DEFAULT '{}',
        started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at   TIMESTAMPTZ
      )
    `);
    return true;
  }

  /**
   * Payments the bank ledger has dispatched on a rail this channel carries and
   * for which no wire transmission exists yet. A transmission in *any* state
   * disqualifies a payment: a failed one is retried through the vault's own
   * retry path, never by creating a second file.
   */
  static async pending({ limit = null } = {}) {
    await this.ensureTables();
    const config = getWireChannelConfig();
    const rows = await pool.query(
      `SELECT p.payment_id, p.rail, p.amount_cents, p.fee_cents, p.currency, p.dispatched_at
         FROM ihb_payments p
         LEFT JOIN ihb_wire_transmissions w ON w.payment_id = p.payment_id
        WHERE p.status = 'dispatched'
          AND p.internal = FALSE
          AND w.transmission_id IS NULL
          AND p.rail = ANY($1::text[])
        ORDER BY p.dispatched_at ASC NULLS FIRST
        LIMIT $2`,
      [config.rails, Math.min(Math.max(Number(limit) || getLinkConfig().batchSize, 1), 500)]
    );
    return rows.rows.map(row => ({
      paymentId: row.payment_id,
      rail: row.rail,
      amountCents: Number(row.amount_cents) + Number(row.fee_cents || 0),
      currency: row.currency,
      dispatchedAt: row.dispatched_at,
    }));
  }

  /**
   * Run one cycle. Never throws for a single bad payment: a payment that
   * cannot be transmitted is recorded as a wire exception and the rest of the
   * batch still goes out, because one malformed instruction must not hold up
   * everybody else's wires.
   */
  static async driveOnce({ actor = 'wire-link', trigger = 'manual', limit = null, reconcile = null } = {}) {
    await this.ensureTables();
    const config = getLinkConfig();
    const channel = wireChannelReadiness();
    const report = {
      startedAt: new Date().toISOString(),
      trigger,
      channel: { ready: channel.ready, transport: channel.transport, blockers: channel.blockers },
      candidates: 0,
      transmitted: [],
      skipped: [],
      failed: [],
      advices: null,
      reconciliation: null,
    };

    if (!channel.ready) {
      report.note = `The wire channel is not configured, so nothing was transmitted: ${channel.blockers.join('; ')}`;
      report.finishedAt = new Date().toISOString();
      await this._record(report, actor);
      return report;
    }

    const candidates = await this.pending({ limit: limit || config.batchSize });
    report.candidates = candidates.length;

    for (const candidate of candidates) {
      try {
        const result = await WireHostToHostEngine.transmit(candidate.paymentId, { actor });
        if (result.transmitted) {
          report.transmitted.push({
            paymentId: candidate.paymentId,
            transmissionId: result.transmission.transmissionId,
            filename: result.transmission.filename,
          });
        } else {
          report.skipped.push({ paymentId: candidate.paymentId, reason: result.reason, replay: result.replay });
        }
      } catch (err) {
        report.failed.push({ paymentId: candidate.paymentId, error: err.message, code: err.code || null });
        await WireHostToHostEngine.raiseException({
          kind: 'transmission_blocked',
          paymentId: candidate.paymentId,
          detail: `The dispatch link could not transmit ${candidate.paymentId}: ${err.message}`,
          context: { code: err.code || null, rail: candidate.rail, dispatchedAt: candidate.dispatchedAt },
        }).catch(() => null);
      }
    }

    if (config.ingestAdvices) {
      try {
        report.advices = await WireHostToHostEngine.ingestAdvices({ actor });
      } catch (err) {
        report.advices = { error: err.message };
      }
    }

    const shouldReconcile = reconcile === null ? await this._reconcileDue(config) : Boolean(reconcile);
    if (shouldReconcile) {
      try {
        report.reconciliation = await WireHostToHostEngine.reconcile({ actor });
      } catch (err) {
        report.reconciliation = { error: err.message };
      }
    }

    report.finishedAt = new Date().toISOString();
    await this._record(report, actor);
    return report;
  }

  /**
   * Transmit one payment the moment it is dispatched. Called from the payment
   * pipeline, so it swallows everything: a wire that cannot go out right now
   * is the scheduled cycle's problem, and must never turn a successful,
   * already-ledgered payment into a failed API call.
   */
  static async kick(paymentId, { actor = 'wire-link' } = {}) {
    const config = getLinkConfig();
    if (!config.enabled || !config.transmitOnDispatch) return { attempted: false, reason: 'transmit-on-dispatch is off' };
    if (!wireChannelReadiness().ready) return { attempted: false, reason: 'wire channel is not configured' };
    try {
      const [candidate] = (await this.pending({ limit: 100 })).filter(row => row.paymentId === paymentId);
      if (!candidate) return { attempted: false, reason: 'payment is not an untransmitted wire-rail dispatch' };
      const result = await WireHostToHostEngine.transmit(paymentId, { actor });
      return { attempted: true, ...result };
    } catch (err) {
      await WireHostToHostEngine.raiseException({
        kind: 'transmission_blocked',
        paymentId,
        detail: `Immediate transmission of ${paymentId} failed: ${err.message}`,
        context: { code: err.code || null, stage: 'dispatch' },
      }).catch(() => null);
      return { attempted: true, transmitted: false, error: err.message };
    }
  }

  static async _reconcileDue(config) {
    const rows = await pool.query(
      `SELECT started_at FROM ihb_wire_link_runs WHERE reconciled = TRUE ORDER BY started_at DESC LIMIT 1`
    );
    if (!rows.rows[0]) return true;
    const last = new Date(rows.rows[0].started_at).getTime();
    return Date.now() - last >= config.reconcileEverySeconds * 1000;
  }

  static async _record(report, actor) {
    const settled = report.advices && Array.isArray(report.advices.applied)
      ? report.advices.applied.filter(entry => entry.paymentOutcome).length
      : 0;
    try {
      await pool.query(
        `INSERT INTO ihb_wire_link_runs
           (trigger, actor, candidates, transmitted, skipped, failed, advices, settled, reconciled, detail, started_at, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          report.trigger, actor, report.candidates, report.transmitted.length, report.skipped.length,
          report.failed.length, report.advices && report.advices.records ? report.advices.records : 0,
          settled, Boolean(report.reconciliation && !report.reconciliation.error),
          JSON.stringify({
            transmitted: report.transmitted,
            skipped: report.skipped,
            failed: report.failed,
            channel: report.channel,
            note: report.note || null,
          }),
          report.startedAt, report.finishedAt,
        ]
      );
    } catch (err) {
      console.warn('[wire-link] run history unavailable:', err.message);
    }
  }

  // ── Scheduler ──────────────────────────────────────────────────────────────

  static start() {
    const config = getLinkConfig();
    if (this._timer) return { started: false, reason: 'already running' };
    if (!config.enabled) return { started: false, reason: 'WIRE_H2H_LINK_ENABLED is off' };

    const tick = async () => {
      if (this._running) return;
      this._running = true;
      try {
        const report = await this.driveOnce({ trigger: 'scheduler', actor: 'wire-link-scheduler' });
        this._lastReport = report;
        if (report.transmitted.length || report.failed.length) {
          console.log(`[wire-link] transmitted ${report.transmitted.length}, failed ${report.failed.length}`);
        }
      } catch (err) {
        console.warn('[wire-link] cycle failed:', err.message);
      } finally {
        this._running = false;
      }
    };

    this._timer = setInterval(tick, config.intervalSeconds * 1000);
    if (this._timer.unref) this._timer.unref();
    setTimeout(tick, 10000).unref?.();
    console.log(`[wire-link] driving the host-to-host channel every ${config.intervalSeconds}s`);
    return { started: true, intervalSeconds: config.intervalSeconds };
  }

  static stop() {
    if (!this._timer) return { stopped: false };
    clearInterval(this._timer);
    this._timer = null;
    return { stopped: true };
  }

  static async status() {
    await this.ensureTables();
    const config = getLinkConfig();
    const [runs, pending] = await Promise.all([
      pool.query('SELECT * FROM ihb_wire_link_runs ORDER BY started_at DESC LIMIT 10'),
      this.pending({ limit: 500 }),
    ]);
    return {
      config,
      running: Boolean(this._timer),
      channel: wireChannelReadiness(),
      awaitingTransmission: pending.length,
      pending: pending.slice(0, 25),
      lastRuns: runs.rows.map(row => ({
        runId: Number(row.run_id),
        trigger: row.trigger,
        actor: row.actor,
        candidates: row.candidates,
        transmitted: row.transmitted,
        skipped: row.skipped,
        failed: row.failed,
        advices: row.advices,
        settled: row.settled,
        reconciled: row.reconciled,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
      })),
    };
  }
}

WireDispatchLink._timer = null;
WireDispatchLink._running = false;
WireDispatchLink._lastReport = null;

module.exports = { WireDispatchLink, getLinkConfig };
