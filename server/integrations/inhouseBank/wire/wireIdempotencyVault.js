'use strict';

/**
 * Wire idempotency vault
 *
 * The ingress vault upstream stops the same *instruction* becoming two
 * payments. This one stops the same *payment* becoming two files on the bank's
 * host, which is a different and considerably more expensive failure: the
 * bank will happily execute both.
 *
 * The guarantee is a database uniqueness constraint, not a check-then-write.
 * `reserve()` inserts the wire key; a second caller loses the insert and is
 * told what the first one is doing. From there:
 *
 *   • the winner holds a reservation and is the only process allowed to
 *     transmit that payment;
 *   • a replay after the file landed gets the original transmission back,
 *     unchanged, and no second file is written;
 *   • a replay while the first attempt is still transmitting is refused rather
 *     than raced, because the two possible outcomes of racing are "duplicate
 *     wire" and "lost wire";
 *   • a replay whose payload hash differs from the stored one is refused
 *     outright — the same wire key must never describe two different amounts
 *     or two different beneficiaries;
 *   • a reservation whose process died is only reclaimable after it has gone
 *     stale *and* the caller has proved the file is absent from the bank host.
 *     `reclaim()` demands that proof as an argument; it will not guess.
 */

const crypto = require('crypto');
const pool = require('../../bonds/pgPool');
const { getWireChannelConfig } = require('./wireHostToHostConfig');

class WireVaultError extends Error {
  constructor(message, code = 'WIRE_H2H_VAULT', status = 409, details = {}) {
    super(message);
    this.name = 'WireVaultError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
    this.details = details;
  }
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(9).toString('hex').toUpperCase()}`;
}

/** Stable hash of the bytes we intend to hand the bank. */
function hashPayload(content) {
  return crypto.createHash('sha256').update(String(content), 'utf8').digest('hex');
}

/**
 * The wire key. Derived from the payment, not from the caller, so two operators
 * clicking "send" on the same payment collide in the vault instead of both
 * getting a file out.
 */
function wireKeyFor(paymentId) {
  return `wire:${paymentId}`;
}

let tablesReady = false;

async function ensureVaultTables() {
  if (tablesReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ihb_wire_transmissions (
      transmission_id     TEXT PRIMARY KEY,
      wire_key            TEXT NOT NULL UNIQUE,
      payment_id          TEXT NOT NULL,
      state               TEXT NOT NULL DEFAULT 'prepared'
                          CHECK (state IN ('prepared','reserved','transmitting','transmitted',
                                           'acknowledged','settled','returned','rejected','failed')),
      filename            TEXT NOT NULL UNIQUE,
      remote_path         TEXT,
      payload             TEXT NOT NULL DEFAULT '',
      payload_hash        TEXT NOT NULL,
      message_type        TEXT NOT NULL DEFAULT 'pacs.008',
      rail                TEXT,
      amount_cents        BIGINT NOT NULL DEFAULT 0,
      currency            TEXT NOT NULL DEFAULT 'USD',
      end_to_end_id       TEXT,
      uetr                TEXT,
      creditor_name       TEXT,
      creditor_account    TEXT,
      bank_reference      TEXT,
      return_reference    TEXT,
      return_reason       TEXT,
      reservation_owner   TEXT,
      reserved_at         TIMESTAMPTZ,
      attempts            INTEGER NOT NULL DEFAULT 0,
      transmitted_at      TIMESTAMPTZ,
      acknowledged_at     TIMESTAMPTZ,
      settled_at          TIMESTAMPTZ,
      returned_at         TIMESTAMPTZ,
      last_error          TEXT,
      metadata            JSONB NOT NULL DEFAULT '{}',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ihb_wire_state_log (
      log_id          TEXT PRIMARY KEY,
      transmission_id TEXT NOT NULL,
      payment_id      TEXT,
      from_state      TEXT,
      to_state        TEXT NOT NULL,
      actor           TEXT,
      reason          TEXT,
      evidence        JSONB NOT NULL DEFAULT '{}',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ihb_wire_advices (
      advice_id       TEXT PRIMARY KEY,
      content_hash    TEXT NOT NULL UNIQUE,
      filename        TEXT,
      advice_type     TEXT NOT NULL,
      transmission_id TEXT,
      payment_id      TEXT,
      bank_reference  TEXT,
      applied         BOOLEAN NOT NULL DEFAULT FALSE,
      outcome         TEXT,
      raw             TEXT NOT NULL DEFAULT '',
      parsed          JSONB NOT NULL DEFAULT '{}',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ihb_wire_exceptions (
      exception_id    TEXT PRIMARY KEY,
      kind            TEXT NOT NULL,
      transmission_id TEXT,
      payment_id      TEXT,
      filename        TEXT,
      detail          TEXT NOT NULL DEFAULT '',
      context         JSONB NOT NULL DEFAULT '{}',
      resolved        BOOLEAN NOT NULL DEFAULT FALSE,
      resolved_by     TEXT,
      resolved_at     TIMESTAMPTZ,
      resolution      TEXT,
      first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_ihb_wire_tx_payment ON ihb_wire_transmissions(payment_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_ihb_wire_tx_state ON ihb_wire_transmissions(state)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_ihb_wire_log_tx ON ihb_wire_state_log(transmission_id)');
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_ihb_wire_exceptions_open ON ihb_wire_exceptions(kind, COALESCE(transmission_id, filename, \'\')) WHERE resolved = FALSE'
  );
  tablesReady = true;
}

function mapTransmission(row) {
  if (!row) return null;
  return {
    transmissionId: row.transmission_id,
    wireKey: row.wire_key,
    paymentId: row.payment_id,
    state: row.state,
    filename: row.filename,
    remotePath: row.remote_path,
    payload: row.payload,
    payloadHash: row.payload_hash,
    messageType: row.message_type,
    rail: row.rail,
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    endToEndId: row.end_to_end_id,
    uetr: row.uetr,
    creditorName: row.creditor_name,
    creditorAccount: row.creditor_account,
    bankReference: row.bank_reference,
    returnReference: row.return_reference,
    returnReason: row.return_reason,
    reservationOwner: row.reservation_owner,
    reservedAt: row.reserved_at,
    attempts: Number(row.attempts),
    transmittedAt: row.transmitted_at,
    acknowledgedAt: row.acknowledged_at,
    settledAt: row.settled_at,
    returnedAt: row.returned_at,
    lastError: row.last_error,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class WireIdempotencyVault {
  static async ensureTables() {
    return ensureVaultTables();
  }

  static hashPayload(content) {
    return hashPayload(content);
  }

  static wireKeyFor(paymentId) {
    return wireKeyFor(paymentId);
  }

  static async get(transmissionId) {
    await ensureVaultTables();
    const rows = await pool.query('SELECT * FROM ihb_wire_transmissions WHERE transmission_id = $1', [transmissionId]);
    return mapTransmission(rows.rows[0]);
  }

  static async byPayment(paymentId) {
    await ensureVaultTables();
    const rows = await pool.query('SELECT * FROM ihb_wire_transmissions WHERE payment_id = $1 ORDER BY created_at DESC LIMIT 1', [paymentId]);
    return mapTransmission(rows.rows[0]);
  }

  static async byFilename(filename) {
    await ensureVaultTables();
    const rows = await pool.query('SELECT * FROM ihb_wire_transmissions WHERE filename = $1', [filename]);
    return mapTransmission(rows.rows[0]);
  }

  static async list({ state = null, paymentId = null, limit = 100 } = {}) {
    await ensureVaultTables();
    const rows = await pool.query(
      `SELECT * FROM ihb_wire_transmissions
        WHERE ($1::text IS NULL OR state = $1)
          AND ($2::text IS NULL OR payment_id = $2)
        ORDER BY created_at DESC
        LIMIT $3`,
      [state, paymentId, Math.min(Math.max(Number(limit) || 100, 1), 500)]
    );
    return rows.rows.map(mapTransmission);
  }

  /**
   * Claim the sole right to transmit this payment.
   *
   * Returns `{ reserved: true, transmission }` to the one caller that may
   * proceed, or `{ reserved: false, reason, transmission }` to everyone else.
   * It never returns two reservations for one payment, and it never silently
   * hands back a stored transmission whose payload differs from the one the
   * caller just built.
   */
  static async reserve({ paymentId, filename, payload, payloadHash = null, owner, ...facts }) {
    await ensureVaultTables();
    if (!paymentId) throw new WireVaultError('paymentId is required to reserve a wire', 'WIRE_H2H_BAD_REQUEST', 400);
    if (!filename) throw new WireVaultError('filename is required to reserve a wire', 'WIRE_H2H_BAD_REQUEST', 400);

    const hash = payloadHash || hashPayload(payload);
    const wireKey = wireKeyFor(paymentId);
    const transmissionId = newId('IHW');

    const inserted = await pool.query(
      `INSERT INTO ihb_wire_transmissions
        (transmission_id, wire_key, payment_id, state, filename, payload, payload_hash, message_type, rail,
         amount_cents, currency, end_to_end_id, uetr, creditor_name, creditor_account,
         reservation_owner, reserved_at, attempts)
       VALUES ($1,$2,$3,'reserved',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW(),1)
       ON CONFLICT (wire_key) DO NOTHING
       RETURNING *`,
      [
        transmissionId, wireKey, paymentId, filename, payload, hash,
        facts.messageType || 'pacs.008', facts.rail || null,
        facts.amountCents || 0, facts.currency || 'USD',
        facts.endToEndId || null, facts.uetr || null,
        facts.creditorName || null, facts.creditorAccount || null,
        owner || null,
      ]
    );

    if (inserted.rows[0]) {
      const transmission = mapTransmission(inserted.rows[0]);
      await this.log(transmission, { from: null, to: 'reserved', actor: owner, reason: 'wire reserved for transmission' });
      return { reserved: true, replay: false, transmission };
    }

    const existingRows = await pool.query('SELECT * FROM ihb_wire_transmissions WHERE wire_key = $1', [wireKey]);
    const existing = mapTransmission(existingRows.rows[0]);
    if (!existing) {
      // The conflicting row vanished between the insert and the read, which
      // only happens if something deleted it. Refuse rather than loop.
      throw new WireVaultError(`Wire reservation for ${paymentId} could not be established`, 'WIRE_H2H_VAULT_RACE', 503);
    }

    if (existing.payloadHash !== hash) {
      throw new WireVaultError(
        `Payment ${paymentId} was already prepared for the wire with different content; refusing to transmit a conflicting file`,
        'WIRE_H2H_PAYLOAD_CONFLICT',
        409,
        { transmissionId: existing.transmissionId, storedHash: existing.payloadHash, incomingHash: hash }
      );
    }

    if (['transmitted', 'acknowledged', 'settled', 'returned', 'rejected'].includes(existing.state)) {
      return { reserved: false, replay: true, reason: 'already_transmitted', transmission: existing };
    }
    if (existing.state === 'failed') {
      return { reserved: false, replay: false, reason: 'previous_attempt_failed', transmission: existing };
    }
    return { reserved: false, replay: false, reason: 'in_flight', transmission: existing };
  }

  /**
   * Take over a stuck reservation. `absentFromHost` must be the caller's
   * verified observation that neither the staged nor the final file exists on
   * the bank host; without it the vault refuses, because the alternative is
   * writing a second copy of a wire the bank may already be executing.
   */
  static async reclaim(transmissionId, { owner, absentFromHost }) {
    await ensureVaultTables();
    const current = await this.get(transmissionId);
    if (!current) throw new WireVaultError(`Wire transmission ${transmissionId} not found`, 'WIRE_H2H_NOT_FOUND', 404);
    if (!['reserved', 'transmitting'].includes(current.state)) {
      throw new WireVaultError(`Wire ${transmissionId} is ${current.state} and does not hold a reservation`, 'WIRE_H2H_NOT_RESERVED');
    }
    if (absentFromHost !== true) {
      throw new WireVaultError(
        `Refusing to reclaim ${transmissionId}: the file has not been proven absent from the bank host`,
        'WIRE_H2H_UNVERIFIED_RECLAIM',
        412
      );
    }
    const staleMinutes = getWireChannelConfig().reservationStaleMinutes;
    const rows = await pool.query(
      `UPDATE ihb_wire_transmissions
          SET reservation_owner = $2, reserved_at = NOW(), attempts = attempts + 1, updated_at = NOW()
        WHERE transmission_id = $1
          AND state IN ('reserved','transmitting')
          AND reserved_at < NOW() - ($3 || ' minutes')::interval
       RETURNING *`,
      [transmissionId, owner || null, String(staleMinutes)]
    );
    if (!rows.rows[0]) {
      throw new WireVaultError(
        `Wire ${transmissionId} is still within its ${staleMinutes} minute reservation window`,
        'WIRE_H2H_RESERVATION_ACTIVE'
      );
    }
    const transmission = mapTransmission(rows.rows[0]);
    await this.log(transmission, {
      from: current.state,
      to: current.state,
      actor: owner,
      reason: 'reservation reclaimed after verifying the file is absent from the bank host',
    });
    return transmission;
  }

  /** Persist a state change. Callers pass an already-validated transition. */
  static async apply(transmissionId, toState, { actor = null, reason = null, evidence = {}, patch = {} } = {}) {
    await ensureVaultTables();
    const before = await this.get(transmissionId);
    if (!before) throw new WireVaultError(`Wire transmission ${transmissionId} not found`, 'WIRE_H2H_NOT_FOUND', 404);

    const columns = {
      remote_path: patch.remotePath,
      bank_reference: patch.bankReference,
      return_reference: patch.returnReference,
      return_reason: patch.returnReason,
      last_error: patch.lastError,
      transmitted_at: toState === 'transmitted' ? new Date().toISOString() : undefined,
      acknowledged_at: toState === 'acknowledged' ? new Date().toISOString() : undefined,
      settled_at: toState === 'settled' ? new Date().toISOString() : undefined,
      returned_at: toState === 'returned' ? new Date().toISOString() : undefined,
    };
    const sets = ['state = $2', 'updated_at = NOW()'];
    const values = [transmissionId, toState];
    for (const [column, value] of Object.entries(columns)) {
      if (value === undefined) continue;
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    }
    const rows = await pool.query(
      `UPDATE ihb_wire_transmissions SET ${sets.join(', ')} WHERE transmission_id = $1 RETURNING *`,
      values
    );
    const after = mapTransmission(rows.rows[0]);
    await this.log(after, { from: before.state, to: toState, actor, reason, evidence });
    return after;
  }

  static async log(transmission, { from, to, actor = null, reason = null, evidence = {} }) {
    await pool.query(
      `INSERT INTO ihb_wire_state_log (log_id, transmission_id, payment_id, from_state, to_state, actor, reason, evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [newId('IHWL'), transmission.transmissionId, transmission.paymentId, from, to, actor, reason, JSON.stringify(evidence || {})]
    );
  }

  static async history(transmissionId) {
    await ensureVaultTables();
    const rows = await pool.query(
      'SELECT * FROM ihb_wire_state_log WHERE transmission_id = $1 ORDER BY created_at ASC',
      [transmissionId]
    );
    return rows.rows.map(row => ({
      logId: row.log_id,
      transmissionId: row.transmission_id,
      paymentId: row.payment_id,
      from: row.from_state,
      to: row.to_state,
      actor: row.actor,
      reason: row.reason,
      evidence: row.evidence || {},
      createdAt: row.created_at,
    }));
  }
}

module.exports = { WireIdempotencyVault, WireVaultError, hashPayload, wireKeyFor };
