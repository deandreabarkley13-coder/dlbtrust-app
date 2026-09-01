'use strict';

/**
 * Who authorised this token to exist.
 *
 * Minting a claim on trust assets is a larger act than paying a vendor, and the
 * payout rails here have required two trustees for a long time while the token
 * engine required none. This engine closes that: issuance is a ticket, not a
 * function call.
 *
 *   request   a maker states the token, the amount and who is to hold it. Cap
 *             Control is asked whether it fits and Integrity Control whether
 *             the books can be trusted; a refusal here costs nothing, which is
 *             the point of raising a ticket before spending an approval on it.
 *             From this moment the ticket holds its headroom, so a second
 *             ticket cannot be sized against room this one already claims.
 *   approve   a different trustee agrees. The bond is re-read first — it may
 *             have been paid down since the request, and an approval is not a
 *             licence to mint against a ceiling that has since fallen.
 *   consume   the mint happened. The reservation is released in the same breath
 *             the supply appears, so the two are never counted at once.
 *   reject    the ticket is withdrawn and its headroom returns.
 *
 * The engine mints nothing itself — Mint & Exchange OS does that, and has to
 * present a ticket from here to be allowed to.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');
const { CapControlEngine } = require('./capControlEngine');
const { IntegrityControlEngine } = require('./integrityControlEngine');

const OPEN_STATUSES = CapControlEngine.OPEN_ISSUANCE_STATUSES;

class IssuanceOsError extends Error {
  constructor(message, code = 'ISSUANCE_OS_ERROR', status = 409) {
    super(message);
    this.name = 'IssuanceOsError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function money(cents) {
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

function newId() {
  return `TOKISS-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function wholeCents(value, field) {
  const cents = Number(value || 0);
  if (!Number.isInteger(cents) || cents < 0) {
    throw new IssuanceOsError(
      `${field} must be a whole number of cents, not ${value}`,
      'ISSUANCE_OS_BAD_AMOUNT',
      400
    );
  }
  return cents;
}

const IssuanceOsEngine = {
  IssuanceOsError,
  OPEN_STATUSES,

  async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS token_issuances (
        issuance_id      TEXT PRIMARY KEY,
        token_id         TEXT NOT NULL,
        bond_id          INTEGER,
        principal_cents  BIGINT NOT NULL DEFAULT 0 CHECK (principal_cents >= 0),
        interest_cents   BIGINT NOT NULL DEFAULT 0 CHECK (interest_cents >= 0),
        status           TEXT NOT NULL,
        holder_address   TEXT,
        initiated_by     TEXT NOT NULL,
        approved_by      TEXT,
        rejected_by      TEXT,
        rejection_reason TEXT,
        chain_reference  TEXT,
        memo             TEXT,
        metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        approved_at      TIMESTAMPTZ,
        consumed_at      TIMESTAMPTZ,
        CHECK (principal_cents + interest_cents > 0)
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_token_issuances_status ON token_issuances (status)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_token_issuances_token ON token_issuances (token_id)');
    return true;
  },

  /**
   * What a desk needs before raising a ticket: the ceiling, the room left, the
   * open tickets holding some of it, and whether the books currently reconcile.
   */
  async status(tokenId) {
    await this.ensureTables();
    const headroom = await CapControlEngine.headroom(tokenId);
    const integrity = await IntegrityControlEngine.check({ tokenId });
    const open = await this.list({ tokenId, status: OPEN_STATUSES });
    return {
      tokenId,
      headroom,
      integrity: {
        clean: integrity.clean,
        blockingCount: integrity.blockingCount,
        findings: integrity.findings,
      },
      openIssuances: open,
      canIssue: integrity.clean && headroom.totalCents > 0,
    };
  },

  /** Maker raises a ticket. Nothing is minted, but the headroom is now held. */
  async request({
    tokenId, principalCents = 0, interestCents = 0,
    initiatedBy, holderAddress = null, memo = null,
  } = {}) {
    await this.ensureTables();
    const maker = String(initiatedBy || '').trim();
    if (!maker) {
      throw new IssuanceOsError('initiatedBy is required', 'ISSUANCE_OS_NO_MAKER', 400);
    }
    if (!tokenId) {
      throw new IssuanceOsError('tokenId is required', 'ISSUANCE_OS_NO_TOKEN', 400);
    }
    const token = await CapControlEngine.token(tokenId);
    await IntegrityControlEngine.assertClean(tokenId);
    const assessment = await CapControlEngine.assertIssuable({
      tokenId,
      principalCents: wholeCents(principalCents, 'principalCents'),
      interestCents: wholeCents(interestCents, 'interestCents'),
    });

    const issuanceId = newId();
    const inserted = await pool.query(
      `INSERT INTO token_issuances
         (issuance_id, token_id, bond_id, principal_cents, interest_cents, status,
          holder_address, initiated_by, memo)
       VALUES ($1, $2, $3, $4, $5, 'pending_approval', $6, $7, $8)
       RETURNING *`,
      [
        issuanceId,
        token.id,
        token.bond_id === undefined ? null : token.bond_id,
        assessment.requestedPrincipalCents,
        assessment.requestedInterestCents,
        holderAddress,
        maker,
        memo,
      ]
    );
    return { issuance: inserted.rows[0], assessment };
  },

  /** Checker approves. Must not be the maker, and the room is re-checked. */
  async approve(issuanceId, approvedBy) {
    const row = await this.require(issuanceId);
    const checker = String(approvedBy || '').trim();
    if (!checker) {
      throw new IssuanceOsError('approvedBy is required', 'ISSUANCE_OS_NO_CHECKER', 400);
    }
    if (row.status !== 'pending_approval') {
      throw new IssuanceOsError(
        `${row.issuance_id} is ${row.status}, not awaiting approval`,
        'ISSUANCE_OS_WRONG_STATE'
      );
    }
    if (checker.toLowerCase() === String(row.initiated_by).toLowerCase()) {
      throw new IssuanceOsError(
        'The trustee who requested an issuance cannot also approve it',
        'ISSUANCE_OS_SAME_TRUSTEE'
      );
    }
    await this.assertStillFits(row);
    const updated = await pool.query(
      `UPDATE token_issuances
          SET status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW()
        WHERE issuance_id = $1
        RETURNING *`,
      [issuanceId, checker]
    );
    return updated.rows[0];
  },

  /**
   * The authority a mint has to present: approved, for this token, for this
   * amount, and still within what the ceiling backs right now.
   */
  async authorize({ issuanceId, tokenId, principalCents = 0, interestCents = 0 } = {}) {
    const row = await this.require(issuanceId);
    if (row.status !== 'approved') {
      throw new IssuanceOsError(
        `${row.issuance_id} is ${row.status}; a mint needs an approved issuance`,
        'ISSUANCE_OS_WRONG_STATE'
      );
    }
    if (String(row.token_id) !== String(tokenId)) {
      throw new IssuanceOsError(
        `${row.issuance_id} authorises token ${row.token_id}, not ${tokenId}`,
        'ISSUANCE_OS_TOKEN_MISMATCH'
      );
    }
    const wantPrincipal = wholeCents(principalCents, 'principalCents');
    const wantInterest = wholeCents(interestCents, 'interestCents');
    if (wantPrincipal !== Number(row.principal_cents) || wantInterest !== Number(row.interest_cents)) {
      throw new IssuanceOsError(
        `${row.issuance_id} authorises ${money(row.principal_cents)} principal and`
        + ` ${money(row.interest_cents)} interest, not ${money(wantPrincipal)} and ${money(wantInterest)}`,
        'ISSUANCE_OS_AMOUNT_MISMATCH'
      );
    }
    await this.assertStillFits(row);
    return row;
  },

  /**
   * The mint happened. Consuming turns the reservation into issued supply, so
   * the same cents are never counted as both.
   */
  async consume(issuanceId, { chainReference = null } = {}) {
    const row = await this.require(issuanceId);
    if (row.status !== 'approved') {
      throw new IssuanceOsError(
        `${row.issuance_id} is ${row.status}; only an approved issuance can be minted`,
        'ISSUANCE_OS_WRONG_STATE'
      );
    }
    const updated = await pool.query(
      `UPDATE token_issuances
          SET status = 'consumed', consumed_at = NOW(), updated_at = NOW(),
              chain_reference = COALESCE($2, chain_reference)
        WHERE issuance_id = $1
        RETURNING *`,
      [issuanceId, chainReference]
    );
    return updated.rows[0];
  },

  /** Withdraw a ticket, returning its headroom. */
  async reject(issuanceId, { rejectedBy, reason = null } = {}) {
    const row = await this.require(issuanceId);
    const actor = String(rejectedBy || '').trim();
    if (!actor) {
      throw new IssuanceOsError('rejectedBy is required', 'ISSUANCE_OS_NO_ACTOR', 400);
    }
    if (!OPEN_STATUSES.includes(row.status)) {
      throw new IssuanceOsError(
        `${row.issuance_id} is ${row.status} and cannot be rejected`,
        'ISSUANCE_OS_WRONG_STATE'
      );
    }
    const updated = await pool.query(
      `UPDATE token_issuances
          SET status = 'rejected', rejected_by = $2, rejection_reason = $3, updated_at = NOW()
        WHERE issuance_id = $1
        RETURNING *`,
      [issuanceId, actor, reason]
    );
    return updated.rows[0];
  },

  /**
   * Re-check a live ticket against the ceiling, excluding its own reservation so
   * it is not measured against itself.
   */
  async assertStillFits(row) {
    const assessment = await CapControlEngine.assess({
      tokenId: row.token_id,
      principalCents: Number(row.principal_cents),
      interestCents: Number(row.interest_cents),
      excludeIssuanceId: row.issuance_id,
    });
    if (!assessment.allowed) {
      throw new IssuanceOsError(
        `${row.issuance_id} is no longer backed — ${assessment.breaches.join('; ')};`
        + ' reject it and raise one for the amount that is backed',
        'ISSUANCE_OS_OVER_CEILING'
      );
    }
    return assessment;
  },

  async list({ status = null, tokenId = null, limit = 100 } = {}) {
    await this.ensureTables();
    const clauses = [];
    const params = [];
    if (status) {
      params.push(Array.isArray(status) ? status : [status]);
      clauses.push(`status = ANY($${params.length}::text[])`);
    }
    if (tokenId) {
      params.push(tokenId);
      clauses.push(`token_id = $${params.length}`);
    }
    params.push(Number(limit) || 100);
    const rows = await pool.query(
      `SELECT * FROM token_issuances
         ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params
    );
    return rows.rows;
  },

  async require(issuanceId) {
    await this.ensureTables();
    const rows = await pool.query('SELECT * FROM token_issuances WHERE issuance_id = $1', [issuanceId]);
    if (!rows.rows.length) {
      throw new IssuanceOsError(`No issuance ${issuanceId}`, 'ISSUANCE_OS_NOT_FOUND', 404);
    }
    return rows.rows[0];
  },
};

module.exports = { IssuanceOsEngine, IssuanceOsError };
