'use strict';

/**
 * Enterprise Ingress & Idempotency
 *
 * Everything that wants to move money — the treasury dashboard, an ERP file, a
 * partner's ISO 20022 pain.001, an internal scheduler — enters through this one
 * door and leaves it as the same canonical instruction. Downstream engines
 * therefore never parse a channel format again.
 *
 * Idempotency here is stronger than "remember the key". The key is stored with
 * a fingerprint of the canonical instruction, so:
 *
 *   • the same key with the same instruction returns the first result and does
 *     not create a second payment;
 *   • the same key with a *different* instruction is refused outright, because
 *     that is a client bug or an attacker reusing a key, and quietly returning
 *     the old payment would hide the fact that the new one never happened;
 *   • a key whose first attempt is still in flight is refused with 409 rather
 *     than racing it.
 *
 * The fingerprint is a stable hash: key ordering in the caller's JSON cannot
 * change it, but a single changed cent does.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');
const { getConfig } = require('./inHouseBankConfig');

const SPEEDS = Object.freeze(['instant', 'express', 'same_day', 'standard']);
const CHANNELS = Object.freeze(['api', 'dashboard', 'iso20022', 'file', 'scheduler', 'webhook']);

class IngressError extends Error {
  constructor(message, code = 'IHB_INGRESS_REJECTED', status = 400) {
    super(message);
    this.name = 'IngressError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function text(value) {
  return value === undefined || value === null ? null : String(value).trim() || null;
}

function toCents(input) {
  if (input.amountCents !== undefined && input.amountCents !== null && input.amountCents !== '') {
    const value = Number(input.amountCents);
    if (!Number.isSafeInteger(value) || value <= 0) throw new IngressError('amountCents must be a positive integer', 'IHB_BAD_AMOUNT');
    return value;
  }
  const raw = String(input.amount === undefined || input.amount === null ? '' : input.amount).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw new IngressError('amount must be a positive USD value with at most two decimals', 'IHB_BAD_AMOUNT');
  const [whole, fraction = ''] = raw.split('.');
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(value) || value <= 0) throw new IngressError('amount is outside the supported range', 'IHB_BAD_AMOUNT');
  return value;
}

class IngressEngine {
  static speeds() {
    return SPEEDS.slice();
  }

  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ihb_idempotency (
        idempotency_key TEXT PRIMARY KEY,
        fingerprint     TEXT NOT NULL,
        principal       TEXT,
        payment_id      TEXT,
        state           TEXT NOT NULL DEFAULT 'in_flight'
                        CHECK (state IN ('in_flight','completed','failed')),
        response        JSONB,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at    TIMESTAMPTZ
      )
    `);
    return true;
  }

  /**
   * Normalize any accepted shape into the canonical instruction. Throwing here
   * is deliberate: a malformed instruction must never reach governance, where
   * a missing field could read as an absent restriction.
   */
  static normalize(raw = {}, { principal = 'system', channel = 'api' } = {}) {
    const config = getConfig();
    const creditorInput = raw.creditor || raw.beneficiary || {};

    const debtorRef = text(raw.debtorAccount || raw.debtor || raw.fromAccount || raw.sourceAccount);
    if (!debtorRef) throw new IngressError('debtorAccount (the paying virtual account) is required', 'IHB_NO_DEBTOR');

    const creditorName = text(creditorInput.name || raw.creditorName || raw.beneficiaryName);
    const creditorAccount = text(
      creditorInput.accountNumber || creditorInput.account || raw.creditorAccount || raw.toAccount || raw.destinationAccount
    );
    if (!creditorName) throw new IngressError('creditor.name is required', 'IHB_NO_CREDITOR');
    if (!creditorAccount && !creditorInput.walletAddress) {
      throw new IngressError('creditor.accountNumber or creditor.walletAddress is required', 'IHB_NO_CREDITOR_ACCOUNT');
    }

    const requestedSpeed = String(raw.requestedSpeed || raw.speed || 'standard').toLowerCase();
    if (!SPEEDS.includes(requestedSpeed)) {
      throw new IngressError(`requestedSpeed must be one of ${SPEEDS.join(', ')}`, 'IHB_BAD_SPEED');
    }
    const normalizedChannel = String(channel || 'api').toLowerCase();
    if (!CHANNELS.includes(normalizedChannel)) throw new IngressError(`channel must be one of ${CHANNELS.join(', ')}`, 'IHB_BAD_CHANNEL');

    const currency = String(raw.currency || config.currency).toUpperCase();
    if (currency !== config.currency) {
      throw new IngressError(`The in-house bank books ${config.currency}; ${currency} was requested`, 'IHB_BAD_CURRENCY');
    }

    return {
      amountCents: toCents(raw),
      currency,
      debtorAccount: debtorRef,
      creditor: {
        name: creditorName,
        accountNumber: creditorAccount,
        routingNumber: text(creditorInput.routingNumber || raw.routingNumber),
        bic: text(creditorInput.bic),
        iban: text(creditorInput.iban),
        walletAddress: text(creditorInput.walletAddress),
        country: (text(creditorInput.country) || 'US').toUpperCase(),
        accountType: text(creditorInput.accountType) || 'checking',
      },
      paymentPurpose: text(raw.paymentPurpose || raw.purpose) || 'family_disbursement',
      purposeCode: (text(raw.purposeCode) || 'OTHR').toUpperCase(),
      requestedSpeed,
      requestedRail: text(raw.requestedRail),
      requestedExecutionDate: text(raw.requestedExecutionDate),
      remittanceInformation: text(raw.remittanceInformation || raw.memo),
      endToEndId: text(raw.endToEndId) || `E2E-${crypto.randomBytes(8).toString('hex').toUpperCase()}`,
      seriesRef: text(raw.seriesRef),
      channel: normalizedChannel,
      sourceFormat: text(raw.sourceFormat) || (normalizedChannel === 'iso20022' ? 'pain.001.001.09' : 'native'),
      originator: principal,
      receivedAt: new Date().toISOString(),
    };
  }

  static fingerprint(instruction) {
    // Deliberately excludes receivedAt and endToEndId: a retry of the same
    // instruction is the same instruction even a minute later.
    const material = { ...instruction };
    delete material.receivedAt;
    delete material.endToEndId;
    return crypto.createHash('sha256').update(stableStringify(material)).digest('hex');
  }

  /**
   * Reserve the idempotency key for this instruction.
   * @returns {{replay: boolean, record: object, instruction: object, fingerprint: string}}
   */
  static async accept({ idempotencyKey, payload, principal = 'system', channel = 'api' } = {}) {
    await this.ensureTables();
    const key = text(idempotencyKey);
    if (!key) throw new IngressError('An Idempotency-Key header is required to submit a payment', 'IHB_NO_IDEMPOTENCY_KEY');
    if (key.length > 200) throw new IngressError('Idempotency-Key is too long', 'IHB_BAD_IDEMPOTENCY_KEY');

    const instruction = this.normalize(payload, { principal, channel });
    const fingerprint = this.fingerprint(instruction);

    const inserted = await pool.query(
      `INSERT INTO ihb_idempotency (idempotency_key, fingerprint, principal)
       VALUES ($1,$2,$3)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [key, fingerprint, principal]
    );
    if (inserted.rows.length) {
      return { replay: false, record: inserted.rows[0], instruction, fingerprint };
    }

    const existingRows = await pool.query('SELECT * FROM ihb_idempotency WHERE idempotency_key = $1', [key]);
    const existing = existingRows.rows[0];
    if (!existing) throw new IngressError('Idempotency key could not be reserved', 'IHB_INGRESS_RACE', 503);

    if (existing.fingerprint !== fingerprint) {
      throw new IngressError(
        `Idempotency key ${key} was already used for a different instruction; reusing it would hide the new payment`,
        'IHB_IDEMPOTENCY_CONFLICT',
        409
      );
    }
    if (existing.state === 'in_flight') {
      throw new IngressError(
        `Idempotency key ${key} is still being processed; retry once the first attempt reports a result`,
        'IHB_IN_FLIGHT',
        409
      );
    }
    return { replay: true, record: existing, instruction, fingerprint };
  }

  static async complete(key, { paymentId = null, response = null, state = 'completed' } = {}) {
    await this.ensureTables();
    const rows = await pool.query(
      `UPDATE ihb_idempotency
          SET state = $2, payment_id = $3, response = $4, completed_at = NOW()
        WHERE idempotency_key = $1
        RETURNING *`,
      [key, state, paymentId, response ? JSON.stringify(response) : null]
    );
    return rows.rows[0] || null;
  }

  /** A failed first attempt must not lock the key forever; the caller may retry. */
  static async release(key, reason = null) {
    await this.ensureTables();
    const rows = await pool.query(
      `DELETE FROM ihb_idempotency
        WHERE idempotency_key = $1 AND state = 'in_flight'
        RETURNING *`,
      [key]
    );
    return { released: rows.rows.length > 0, reason };
  }
}

module.exports = { IngressEngine, IngressError, SPEEDS };
