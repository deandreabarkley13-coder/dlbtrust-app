'use strict';

/**
 * OpenACH rail engine — origination and status for the in-house family bank
 *
 * The bank marks an external payment `dispatched` the moment its own ledger has
 * moved; from that instant the family member's virtual account is short the
 * money and nothing has yet been handed to an ODFI. For wire rails the
 * host-to-host link closes that gap. This engine closes it for ACH: it takes a
 * dispatched ACH payment, originates it at OpenACH as a real entry, and later
 * reads the entry's status back so the payment can settle or return.
 *
 * Three rules shape everything here:
 *
 *   1. One entry per payment, ever. The dispatch row is reserved with a unique
 *      constraint on the payment id before OpenACH is called, so a retried
 *      cycle, a double-clicked operator and two concurrent workers all collapse
 *      into the same origination. A failed attempt is retried on the *same* row.
 *   2. Only OpenACH may settle. This engine never calls `settled` itself; it
 *      maps the ODFI's own status onto `InHouseBankEngine.confirm`, which is the
 *      single door to settled/returned/failed and demands a reference.
 *   3. A refusal is durable. A payment that cannot be originated leaves a
 *      dispatch row in `failed` carrying the reason, because a log line an
 *      operator never reads is how a family member's money goes missing.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');
const { getOpenAchRailConfig, openAchRailReadiness } = require('./openachRailConfig');
const { OpenACHClient } = require('./openachClient');
const { InHouseBankEngine } = require('../inhouseBank/inHouseBankEngine');
const { DualLedgerEngine } = require('../inhouseBank/dualLedgerEngine');

const STATES = Object.freeze(['reserved', 'originated', 'settled', 'returned', 'failed']);

/**
 * OpenACH reports a schedule's progress in words, not codes. Anything not
 * listed is treated as still in flight: guessing "settled" from an unknown
 * status would credit a beneficiary the ODFI has not paid.
 */
const STATUS_OUTCOMES = Object.freeze({
  complete: 'settled',
  completed: 'settled',
  settled: 'settled',
  processed: 'settled',
  posted: 'settled',
  returned: 'returned',
  return: 'returned',
  reversed: 'returned',
  nsf: 'returned',
  failed: 'failed',
  error: 'failed',
  rejected: 'failed',
  cancelled: 'failed',
  canceled: 'failed',
  voided: 'failed',
});

class OpenAchRailError extends Error {
  constructor(message, code = 'OPENACH_REFUSED', status = 409) {
    super(message);
    this.name = 'OpenAchRailError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function dispatchId() {
  return `OACH-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function last4(accountNumber) {
  const digits = String(accountNumber || '').replace(/\D/g, '');
  return digits ? digits.slice(-4) : null;
}

function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: 'Family', last: 'Beneficiary' };
  if (parts.length === 1) return { first: parts[0], last: parts[0] };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

function localMinutesNow(offsetMinutes, now) {
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return ((utcMinutes + offsetMinutes) % 1440 + 1440) % 1440;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

/** Weekends are not banking days; federal holidays are the ODFI's calendar, not ours. */
function nextBankingDay(from) {
  const date = new Date(from.getTime());
  do {
    date.setUTCDate(date.getUTCDate() + 1);
  } while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
  return date;
}

function isBankingDay(date) {
  return date.getUTCDay() !== 0 && date.getUTCDay() !== 6;
}

/**
 * The effective date an entry can realistically carry. A same-day rail asked
 * for after its window has closed is not same-day, and saying otherwise would
 * put a date on the file that the ODFI rewrites anyway.
 */
function effectiveDateFor(rail, config, now = new Date()) {
  const today = new Date(now.getTime());
  if (rail === 'ach_same_day'
    && isBankingDay(today)
    && localMinutesNow(config.timezoneOffsetMinutes, now) < config.sameDayCutoffMinutes) {
    return isoDate(today);
  }
  return isoDate(nextBankingDay(today));
}

/** A payment to a family entity is a corporate entry; a payment to a person is not. */
function secCodeFor(payment, config) {
  const creditor = payment.creditor || {};
  const accountType = String(creditor.accountType || '').toLowerCase();
  if (creditor.business === true || accountType === 'business' || accountType === 'corporate') return 'CCD';
  if (accountType === 'checking' || accountType === 'savings') return 'PPD';
  return config.defaultSecCode;
}

function publicDispatch(row) {
  if (!row) return null;
  return {
    dispatchId: row.dispatch_id,
    paymentId: row.payment_id,
    state: row.state,
    rail: row.rail,
    secCode: row.sec_code,
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    effectiveDate: row.effective_date,
    paymentProfileId: row.payment_profile_id,
    externalAccountId: row.external_account_id,
    paymentScheduleId: row.payment_schedule_id,
    paymentTypeId: row.payment_type_id,
    creditorName: row.creditor_name,
    creditorAccountLast4: row.creditor_account_last4,
    routingNumber: row.routing_number,
    attempts: Number(row.attempts || 0),
    lastError: row.last_error,
    lastStatus: row.last_status,
    outcome: row.outcome,
    settlementReference: row.settlement_reference,
    reservedAt: row.reserved_at,
    originatedAt: row.originated_at,
    confirmedAt: row.confirmed_at,
  };
}

class OpenAchRailEngine {
  static config() {
    return getOpenAchRailConfig();
  }

  static readiness() {
    return openAchRailReadiness();
  }

  static states() {
    return STATES.slice();
  }

  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ihb_openach_dispatches (
        dispatch_id           TEXT PRIMARY KEY,
        payment_id            TEXT UNIQUE NOT NULL,
        state                 TEXT NOT NULL DEFAULT 'reserved'
                                CHECK (state IN ('reserved','originated','settled','returned','failed')),
        rail                  TEXT NOT NULL,
        sec_code              TEXT,
        amount_cents          BIGINT NOT NULL,
        currency              TEXT NOT NULL DEFAULT 'USD',
        effective_date        DATE,
        payment_profile_id    TEXT,
        external_account_id   TEXT,
        payment_schedule_id   TEXT,
        payment_type_id       TEXT,
        creditor_name         TEXT,
        creditor_account_last4 TEXT,
        routing_number        TEXT,
        attempts              INTEGER NOT NULL DEFAULT 0,
        last_error            TEXT,
        last_status           TEXT,
        outcome               TEXT,
        settlement_reference  TEXT,
        reserved_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        originated_at         TIMESTAMPTZ,
        confirmed_at          TIMESTAMPTZ,
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ihb_openach_state ON ihb_openach_dispatches (state, reserved_at)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ihb_openach_status_log (
        log_id        BIGSERIAL PRIMARY KEY,
        dispatch_id   TEXT,
        payment_id    TEXT,
        openach_status TEXT,
        outcome       TEXT,
        note          TEXT,
        raw           JSONB NOT NULL DEFAULT '{}',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    return true;
  }

  static async get(paymentId) {
    await this.ensureTables();
    const rows = await pool.query('SELECT * FROM ihb_openach_dispatches WHERE payment_id = $1', [paymentId]);
    return publicDispatch(rows.rows[0]);
  }

  static async list({ state = null, limit = 100 } = {}) {
    await this.ensureTables();
    const rows = await pool.query(
      `SELECT * FROM ihb_openach_dispatches
        WHERE ($1::text IS NULL OR state = $1)
        ORDER BY reserved_at DESC
        LIMIT $2`,
      [state, Math.min(Math.max(Number(limit) || 100, 1), 500)]
    );
    return rows.rows.map(publicDispatch);
  }

  /**
   * Dispatched ACH payments with no OpenACH entry yet. A dispatch row in any
   * state disqualifies a payment: a failed origination is retried on its own
   * row through `retry`, never by creating a second entry.
   */
  static async pending({ limit = null } = {}) {
    await this.ensureTables();
    const config = getOpenAchRailConfig();
    const rows = await pool.query(
      `SELECT p.payment_id, p.rail, p.amount_cents, p.fee_cents, p.currency, p.dispatched_at
         FROM ihb_payments p
         LEFT JOIN ihb_openach_dispatches d ON d.payment_id = p.payment_id
        WHERE p.status = 'dispatched'
          AND p.internal = FALSE
          AND d.dispatch_id IS NULL
          AND p.rail = ANY($1::text[])
        ORDER BY p.dispatched_at ASC NULLS FIRST
        LIMIT $2`,
      [config.rails, Math.min(Math.max(Number(limit) || config.pollBatch, 1), 500)]
    );
    return rows.rows.map(row => ({
      paymentId: row.payment_id,
      rail: row.rail,
      amountCents: Number(row.amount_cents),
      currency: row.currency,
      dispatchedAt: row.dispatched_at,
    }));
  }

  static async _update(paymentId, patch) {
    const keys = Object.keys(patch);
    if (!keys.length) return this.get(paymentId);
    const sets = keys.map((key, index) => `${key} = $${index + 2}`);
    const rows = await pool.query(
      `UPDATE ihb_openach_dispatches SET ${sets.join(', ')}, updated_at = NOW()
        WHERE payment_id = $1 RETURNING *`,
      [paymentId, ...keys.map(key => patch[key])]
    );
    return publicDispatch(rows.rows[0]);
  }

  static async _log({ dispatchId: id = null, paymentId = null, status = null, outcome = null, note = null, raw = {} }) {
    try {
      await pool.query(
        `INSERT INTO ihb_openach_status_log (dispatch_id, payment_id, openach_status, outcome, note, raw)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, paymentId, status, outcome, note, JSON.stringify(raw || {})]
      );
    } catch (err) {
      console.warn('[openach-rail] status log unavailable:', err.message);
    }
  }

  /**
   * Originate one dispatched ACH payment at the ODFI.
   *
   * `client` exists so a caller can supply an alternative OpenACH client; the
   * default is the real one. Nothing else about the call changes.
   */
  static async originate(paymentId, { actor = 'openach-rail', client = OpenACHClient, now = new Date() } = {}) {
    await this.ensureTables();
    const config = getOpenAchRailConfig();
    const readiness = openAchRailReadiness();
    if (!readiness.ready) {
      throw new OpenAchRailError(`The OpenACH rail is not configured: ${readiness.blockers.join('; ')}`, 'OPENACH_NOT_CONFIGURED', 503);
    }

    const payment = await InHouseBankEngine.require(paymentId);
    if (payment.status !== 'dispatched') {
      throw new OpenAchRailError(`Payment ${paymentId} is ${payment.status}; only a dispatched payment is originated`, 'OPENACH_NOT_DISPATCHED');
    }
    if (payment.internal) {
      throw new OpenAchRailError(`Payment ${paymentId} is an on-us book transfer and never reaches an ODFI`, 'OPENACH_INTERNAL_PAYMENT');
    }
    if (!config.rails.includes(payment.rail)) {
      throw new OpenAchRailError(`The OpenACH rail does not carry ${payment.rail}`, 'OPENACH_RAIL_NOT_CARRIED');
    }

    const creditor = payment.creditor || {};
    if (!creditor.routingNumber || !creditor.accountNumber) {
      throw new OpenAchRailError(
        `Payment ${paymentId} has no creditor routing and account number, which an ACH entry cannot be built without`,
        'OPENACH_NO_BANK_DETAILS',
        422
      );
    }

    const paymentTypeId = config.paymentTypeIds[payment.rail];
    const secCode = secCodeFor(payment, config);
    const effectiveDate = effectiveDateFor(payment.rail, config, now);

    // Reserve before calling out. Whoever wins the unique constraint owns the
    // origination; everyone else sees the existing row and stops.
    const reserved = await pool.query(
      `INSERT INTO ihb_openach_dispatches
         (dispatch_id, payment_id, state, rail, sec_code, amount_cents, currency, effective_date,
          payment_type_id, creditor_name, creditor_account_last4, routing_number, attempts)
       VALUES ($1,$2,'reserved',$3,$4,$5,$6,$7,$8,$9,$10,$11,1)
       ON CONFLICT (payment_id) DO NOTHING
       RETURNING *`,
      [
        dispatchId(), paymentId, payment.rail, secCode, payment.amountCents, payment.currency, effectiveDate,
        paymentTypeId, creditor.name || null, last4(creditor.accountNumber), creditor.routingNumber,
      ]
    );
    if (!reserved.rows.length) {
      const existing = await this.get(paymentId);
      return { originated: false, replay: true, reason: `payment ${paymentId} already has an OpenACH dispatch in ${existing.state}`, dispatch: existing };
    }
    const dispatch = publicDispatch(reserved.rows[0]);

    try {
      const result = await this._schedule({ payment, dispatch, config, client, effectiveDate, paymentTypeId });
      const originated = await this._update(paymentId, {
        state: 'originated',
        payment_profile_id: result.paymentProfileId || null,
        external_account_id: result.externalAccountId || null,
        payment_schedule_id: result.paymentScheduleId || null,
        originated_at: new Date(),
        last_error: null,
      });
      await this._log({
        dispatchId: dispatch.dispatchId,
        paymentId,
        status: 'scheduled',
        note: `Entry scheduled at the ODFI for ${effectiveDate}`,
        raw: result.raw || {},
      });
      await DualLedgerEngine.appendEvent({
        eventType: 'payment.originated',
        paymentId,
        actor,
        payload: {
          rail: payment.rail,
          channel: 'openach',
          secCode,
          effectiveDate,
          paymentScheduleId: result.paymentScheduleId || null,
        },
      }).catch(() => null);
      return { originated: true, replay: false, dispatch: originated };
    } catch (err) {
      await this._update(paymentId, { state: 'failed', last_error: err.message });
      await this._log({ dispatchId: dispatch.dispatchId, paymentId, status: 'origination_failed', note: err.message });
      await DualLedgerEngine.appendEvent({
        eventType: 'payment.origination_failed',
        paymentId,
        actor,
        payload: { rail: payment.rail, channel: 'openach', error: err.message },
      }).catch(() => null);
      throw new OpenAchRailError(`OpenACH refused to originate ${paymentId}: ${err.message}`, 'OPENACH_ORIGINATION_FAILED', 502);
    }
  }

  /**
   * Build the OpenACH side of the entry. When the profile and bank account are
   * already known — a retry — only the schedule is created again, so the ODFI
   * does not accumulate a duplicate profile per attempt.
   */
  static async _schedule({ payment, dispatch, config, client, effectiveDate, paymentTypeId }) {
    const creditor = payment.creditor || {};
    const amount = (payment.amountCents / 100).toFixed(2);

    if (dispatch.paymentProfileId && dispatch.externalAccountId) {
      const scheduled = await client.schedulePayment({
        external_account_id: dispatch.externalAccountId,
        payment_type_id: paymentTypeId,
        amount,
        send_date: effectiveDate,
        currency_code: payment.currency,
      });
      return {
        paymentProfileId: dispatch.paymentProfileId,
        externalAccountId: dispatch.externalAccountId,
        paymentScheduleId: scheduled.payment_schedule_id,
        raw: scheduled,
      };
    }

    const { first, last } = splitName(creditor.name);
    const result = await client.disburseToBeneficiary({
      first_name: first,
      last_name: last,
      email: creditor.email || '',
      // The virtual account the money left is the stable identity of this
      // beneficiary inside the family bank, so OpenACH keys its profile on it.
      external_id: payment.creditorVaId || payment.paymentId,
      bank_name: creditor.bankName || 'Beneficiary Bank',
      routing_number: creditor.routingNumber,
      account_number: creditor.accountNumber,
      account_type: String(creditor.accountType || 'checking').toLowerCase() === 'savings' ? 'Savings' : 'Checking',
      billing_state: config.billingState,
      amount,
      send_date: effectiveDate,
      payment_type_id: paymentTypeId,
    });
    if (!result || result.success === false) {
      throw new Error(result && result.error ? result.error : 'origination returned no result');
    }
    return {
      paymentProfileId: result.payment_profile_id,
      externalAccountId: result.external_account_id,
      paymentScheduleId: result.payment_schedule_id,
      raw: result,
    };
  }

  /** Retry a failed origination on its own dispatch row. */
  static async retry(paymentId, { actor = 'openach-rail', client = OpenACHClient, now = new Date() } = {}) {
    await this.ensureTables();
    const config = getOpenAchRailConfig();
    const dispatch = await this.get(paymentId);
    if (!dispatch) throw new OpenAchRailError(`No OpenACH dispatch for ${paymentId}`, 'OPENACH_NO_DISPATCH', 404);
    if (dispatch.state !== 'failed') {
      throw new OpenAchRailError(`Dispatch for ${paymentId} is ${dispatch.state}; only a failed origination is retried`, 'OPENACH_NOT_RETRYABLE');
    }
    if (dispatch.attempts >= config.maxOriginationAttempts) {
      throw new OpenAchRailError(
        `Origination of ${paymentId} has failed ${dispatch.attempts} times; it needs an operator, not another attempt`,
        'OPENACH_ATTEMPTS_EXHAUSTED'
      );
    }

    const payment = await InHouseBankEngine.require(paymentId);
    const paymentTypeId = config.paymentTypeIds[payment.rail];
    const effectiveDate = effectiveDateFor(payment.rail, config, now);
    await this._update(paymentId, { attempts: dispatch.attempts + 1, effective_date: effectiveDate });

    try {
      const result = await this._schedule({ payment, dispatch, config, client, effectiveDate, paymentTypeId });
      const originated = await this._update(paymentId, {
        state: 'originated',
        payment_profile_id: result.paymentProfileId || dispatch.paymentProfileId || null,
        external_account_id: result.externalAccountId || dispatch.externalAccountId || null,
        payment_schedule_id: result.paymentScheduleId || null,
        originated_at: new Date(),
        last_error: null,
      });
      await this._log({ dispatchId: dispatch.dispatchId, paymentId, status: 'scheduled', note: `Retry scheduled for ${effectiveDate}`, raw: result.raw || {} });
      await DualLedgerEngine.appendEvent({
        eventType: 'payment.originated',
        paymentId,
        actor,
        payload: { rail: payment.rail, channel: 'openach', retry: true, effectiveDate },
      }).catch(() => null);
      return { originated: true, retried: true, dispatch: originated };
    } catch (err) {
      await this._update(paymentId, { state: 'failed', last_error: err.message });
      await this._log({ dispatchId: dispatch.dispatchId, paymentId, status: 'origination_failed', note: err.message });
      throw new OpenAchRailError(`OpenACH refused to originate ${paymentId}: ${err.message}`, 'OPENACH_ORIGINATION_FAILED', 502);
    }
  }

  static _outcomeFor(status) {
    const key = String(status || '').trim().toLowerCase();
    if (!key) return null;
    if (STATUS_OUTCOMES[key]) return STATUS_OUTCOMES[key];
    // Return reason codes come back as R01..R85 and mean the entry came back.
    if (/^r\d{2}$/.test(key)) return 'returned';
    return null;
  }

  /**
   * Read the ODFI's own status for every originated entry and let the bank act
   * on it. Settlement is `InHouseBankEngine.confirm`'s decision to make, and it
   * gets the OpenACH schedule id as the reference it demands.
   */
  static async pollStatuses({ actor = 'openach-rail', client = OpenACHClient, limit = null } = {}) {
    await this.ensureTables();
    const config = getOpenAchRailConfig();
    const report = { checked: 0, unchanged: [], confirmed: [], failed: [] };
    const dispatches = await this.list({ state: 'originated', limit: limit || config.pollBatch });

    for (const dispatch of dispatches) {
      report.checked += 1;
      try {
        const entry = await this._readSchedule(dispatch, client);
        const status = entry ? (entry.payment_schedule_status || entry.status || entry.state) : null;
        const outcome = this._outcomeFor(status);
        if (!outcome) {
          await this._update(dispatch.paymentId, { last_status: status || null });
          report.unchanged.push({ paymentId: dispatch.paymentId, status: status || 'unknown' });
          continue;
        }

        const reference = dispatch.paymentScheduleId ? `OPENACH-${dispatch.paymentScheduleId}` : `OPENACH-${dispatch.dispatchId}`;
        const reason = outcome === 'settled'
          ? null
          : `OpenACH reported ${status} for schedule ${dispatch.paymentScheduleId || dispatch.dispatchId}`;
        const confirmed = await InHouseBankEngine.confirm(dispatch.paymentId, {
          outcome,
          reference: outcome === 'settled' ? reference : null,
          reason,
          actor,
        });
        await this._update(dispatch.paymentId, {
          state: outcome,
          last_status: status,
          outcome,
          settlement_reference: outcome === 'settled' ? reference : null,
          confirmed_at: new Date(),
        });
        await this._log({ dispatchId: dispatch.dispatchId, paymentId: dispatch.paymentId, status, outcome, raw: entry || {} });
        report.confirmed.push({ paymentId: dispatch.paymentId, outcome, status, paymentStatus: confirmed.status });
      } catch (err) {
        await this._log({ dispatchId: dispatch.dispatchId, paymentId: dispatch.paymentId, status: 'poll_failed', note: err.message });
        report.failed.push({ paymentId: dispatch.paymentId, error: err.message, code: err.code || null });
      }
    }
    return report;
  }

  static async _readSchedule(dispatch, client) {
    if (!dispatch.paymentProfileId) return null;
    const response = await client.getPaymentSchedules(dispatch.paymentProfileId);
    const schedules = Array.isArray(response)
      ? response
      : (response && (response.payment_schedules || response.schedules || response.data)) || [];
    if (!Array.isArray(schedules)) return null;
    return schedules.find(row => String(
      row.payment_schedule_id || row.id || ''
    ) === String(dispatch.paymentScheduleId)) || null;
  }

  /**
   * Accept a status OpenACH (or the integration bus in front of it) pushes to
   * us rather than waiting for the next poll. Unknown statuses are recorded and
   * change nothing, which is the same rule the poller follows.
   */
  static async applyStatus({ paymentId, status, reference = null, reason = null, actor = 'openach-webhook', raw = {} } = {}) {
    await this.ensureTables();
    const dispatch = await this.get(paymentId);
    if (!dispatch) throw new OpenAchRailError(`No OpenACH dispatch for ${paymentId}`, 'OPENACH_NO_DISPATCH', 404);
    const outcome = this._outcomeFor(status);
    if (!outcome) {
      await this._update(paymentId, { last_status: status || null });
      await this._log({ dispatchId: dispatch.dispatchId, paymentId, status, note: 'status carries no outcome', raw });
      return { applied: false, reason: `OpenACH status ${status || 'unknown'} does not decide the payment`, dispatch: await this.get(paymentId) };
    }
    if (['settled', 'returned', 'failed'].includes(dispatch.state)) {
      return { applied: false, reason: `dispatch for ${paymentId} is already ${dispatch.state}`, dispatch };
    }

    const settlementReference = outcome === 'settled'
      ? (reference || (dispatch.paymentScheduleId ? `OPENACH-${dispatch.paymentScheduleId}` : `OPENACH-${dispatch.dispatchId}`))
      : null;
    const confirmed = await InHouseBankEngine.confirm(paymentId, {
      outcome,
      reference: settlementReference,
      reason: outcome === 'settled' ? null : (reason || `OpenACH reported ${status}`),
      actor,
    });
    const updated = await this._update(paymentId, {
      state: outcome,
      last_status: status,
      outcome,
      settlement_reference: settlementReference,
      confirmed_at: new Date(),
    });
    await this._log({ dispatchId: dispatch.dispatchId, paymentId, status, outcome, raw });
    return { applied: true, outcome, paymentStatus: confirmed.status, dispatch: updated };
  }

  /**
   * One full cycle: originate what the ledger has dispatched, then read back
   * what the ODFI has done with what was originated earlier. A payment that
   * cannot be originated never blocks the rest of the batch.
   */
  static async driveOnce({ actor = 'openach-rail', limit = null, client = OpenACHClient } = {}) {
    await this.ensureTables();
    const readiness = openAchRailReadiness();
    const report = {
      startedAt: new Date().toISOString(),
      readiness: { ready: readiness.ready, blockers: readiness.blockers },
      candidates: 0,
      originated: [],
      skipped: [],
      failed: [],
      statuses: null,
    };
    if (!readiness.ready) {
      report.note = `Nothing was originated: ${readiness.blockers.join('; ')}`;
      report.finishedAt = new Date().toISOString();
      return report;
    }

    const candidates = await this.pending({ limit });
    report.candidates = candidates.length;
    for (const candidate of candidates) {
      try {
        const result = await this.originate(candidate.paymentId, { actor, client });
        if (result.originated) {
          report.originated.push({ paymentId: candidate.paymentId, paymentScheduleId: result.dispatch.paymentScheduleId });
        } else {
          report.skipped.push({ paymentId: candidate.paymentId, reason: result.reason });
        }
      } catch (err) {
        report.failed.push({ paymentId: candidate.paymentId, error: err.message, code: err.code || null });
      }
    }

    try {
      report.statuses = await this.pollStatuses({ actor, client, limit });
    } catch (err) {
      report.statuses = { error: err.message };
    }
    report.finishedAt = new Date().toISOString();
    return report;
  }

  static async status() {
    await this.ensureTables();
    const [states, pending, log] = await Promise.all([
      pool.query('SELECT state, COUNT(*)::int AS count, COALESCE(SUM(amount_cents),0)::bigint AS amount_cents FROM ihb_openach_dispatches GROUP BY state'),
      this.pending({ limit: 500 }),
      pool.query('SELECT * FROM ihb_openach_status_log ORDER BY created_at DESC LIMIT 25'),
    ]);
    return {
      readiness: openAchRailReadiness(),
      config: (() => {
        const config = getOpenAchRailConfig();
        return {
          enabled: config.enabled,
          rails: config.rails,
          baseUrl: config.baseUrl,
          sameDayCutoffMinutes: config.sameDayCutoffMinutes,
          defaultSecCode: config.defaultSecCode,
          // Payment type ids are configuration, not secrets, but they identify
          // the origination account, so only their presence is reported.
          paymentTypesConfigured: Object.fromEntries(
            Object.entries(config.paymentTypeIds).map(([rail, id]) => [rail, Boolean(id)])
          ),
        };
      })(),
      awaitingOrigination: pending.length,
      pending: pending.slice(0, 25),
      byState: states.rows.map(row => ({ state: row.state, count: Number(row.count), amountCents: Number(row.amount_cents) })),
      recentStatuses: log.rows.map(row => ({
        paymentId: row.payment_id,
        status: row.openach_status,
        outcome: row.outcome,
        note: row.note,
        createdAt: row.created_at,
      })),
    };
  }
}

module.exports = { OpenAchRailEngine, OpenAchRailError, effectiveDateFor, secCodeFor, STATUS_OUTCOMES };
