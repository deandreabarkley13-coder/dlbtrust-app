'use strict';

/**
 * The acts themselves: bringing token into existence, taking it out, and
 * exchanging a holding back to the trust.
 *
 * Cap Control says how much may exist, Integrity Control says whether the books
 * can be trusted, Issuance OS says who authorised it. This engine is the only
 * thing that then does anything, and it does exactly three things:
 *
 *   mint      against an approved issuance ticket, never against an argument.
 *             The ticket is re-authorised at the moment of the mint, the books
 *             are reconciled first, and the ticket is consumed with the tx hash
 *             so the same authority cannot mint twice.
 *   burn      to bring a token back under a ceiling that has fallen — the
 *             ordinary case being a bond paid down, where the supply did not
 *             move but what backs it did. Under two trustees, because
 *             destroying a holder's balance is not a maintenance task.
 *   exchange  a holder returns token to the trust and is owed value for it. The
 *             token is burned here; the payment is not made here. Paying is
 *             Payer OS's job, under its own approval, and this engine records
 *             the obligation rather than claiming it was settled.
 *
 * Nothing is simulated. In live mode a mint or burn that the chain did not
 * accept is an error, not a record.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');
const { CapControlEngine } = require('./capControlEngine');
const { IntegrityControlEngine } = require('./integrityControlEngine');
const { IssuanceOsEngine } = require('./issuanceOsEngine');

const KINDS = ['mint', 'burn', 'exchange'];

class MintExchangeError extends Error {
  constructor(message, code = 'MINT_EXCHANGE_ERROR', status = 409) {
    super(message);
    this.name = 'MintExchangeError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function money(cents) {
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

function toCents(amount) {
  return Math.round(Number(amount || 0) * 100);
}

function toAmount(cents) {
  return Number(cents) / 100;
}

function wholeCents(value, field) {
  const cents = Number(value || 0);
  if (!Number.isInteger(cents) || cents < 0) {
    throw new MintExchangeError(
      `${field} must be a whole number of cents, not ${value}`,
      'MINT_EXCHANGE_BAD_AMOUNT',
      400
    );
  }
  return cents;
}

function newId(kind) {
  const prefix = kind === 'mint' ? 'TOKMINT' : kind === 'burn' ? 'TOKBURN' : 'TOKEXCH';
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

const MintExchangeOsEngine = {
  MintExchangeError,
  KINDS,

  async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS token_movements (
        movement_id           TEXT PRIMARY KEY,
        kind                  TEXT NOT NULL,
        token_id              TEXT NOT NULL,
        bond_id               INTEGER,
        issuance_id           TEXT,
        holder_address        TEXT NOT NULL,
        principal_cents       BIGINT NOT NULL DEFAULT 0 CHECK (principal_cents >= 0),
        interest_cents        BIGINT NOT NULL DEFAULT 0 CHECK (interest_cents >= 0),
        status                TEXT NOT NULL,
        initiated_by          TEXT NOT NULL,
        approved_by           TEXT,
        chain_reference       TEXT,
        settlement_reference  TEXT,
        failure_reason        TEXT,
        memo                  TEXT,
        metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        approved_at           TIMESTAMPTZ,
        executed_at           TIMESTAMPTZ,
        CHECK (principal_cents + interest_cents > 0)
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_token_movements_token ON token_movements (token_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_token_movements_status ON token_movements (status)');
    return true;
  },

  /**
   * Mint against an approved ticket. The order matters: reconcile, re-authorise,
   * then create — so a mint can never be the thing that makes the books wrong.
   */
  async mint({ issuanceId, mintedBy = null, expect = null } = {}) {
    await this.ensureTables();
    if (!issuanceId) {
      throw new MintExchangeError(
        'A mint needs an approved issuance: raise one with Issuance OS and have a second trustee approve it',
        'MINT_EXCHANGE_NO_ISSUANCE',
        400
      );
    }
    const ticket = await IssuanceOsEngine.require(issuanceId);
    // A caller that had its own amount in mind says so, and is refused if the
    // ticket authorises something else — an automated flow must not quietly
    // mint whatever a ticket happens to carry.
    if (expect) this._assertMatchesExpectation(ticket, expect);
    await IntegrityControlEngine.assertClean(ticket.token_id);
    await IssuanceOsEngine.authorize({
      issuanceId,
      tokenId: ticket.token_id,
      principalCents: Number(ticket.principal_cents),
      interestCents: Number(ticket.interest_cents),
    });

    const { BondTokenizationEngine } = require('../dapp/bondTokenizationEngine');
    const holder = ticket.holder_address || 'treasury';
    const movementId = newId('mint');
    await pool.query(
      `INSERT INTO token_movements
         (movement_id, kind, token_id, bond_id, issuance_id, holder_address,
          principal_cents, interest_cents, status, initiated_by, approved_by, approved_at)
       VALUES ($1, 'mint', $2, $3, $4, $5, $6, $7, 'executing', $8, $9, NOW())`,
      [
        movementId,
        ticket.token_id,
        ticket.bond_id,
        issuanceId,
        holder,
        Number(ticket.principal_cents),
        Number(ticket.interest_cents),
        String(mintedBy || ticket.approved_by || ticket.initiated_by),
        ticket.approved_by,
      ]
    );

    let result;
    try {
      result = await BondTokenizationEngine.applyMint({
        tokenId: ticket.token_id,
        principal: toAmount(ticket.principal_cents),
        interest: toAmount(ticket.interest_cents),
        holderAddress: holder,
      });
    } catch (err) {
      await this._fail(movementId, err.message);
      throw err;
    }

    await IssuanceOsEngine.consume(issuanceId, { chainReference: result.txHash || null });
    const movement = await this._executed(movementId, { chainReference: result.txHash || null });
    return { movement, issuance: await IssuanceOsEngine.require(issuanceId), result };
  },

  /**
   * Raise a burn or an exchange. Both destroy token, so both are raised and
   * approved rather than performed.
   */
  async request({
    kind, tokenId, holderAddress, principalCents = 0, interestCents = 0,
    initiatedBy, memo = null,
  } = {}) {
    await this.ensureTables();
    if (!KINDS.includes(kind) || kind === 'mint') {
      throw new MintExchangeError(
        `kind must be burn or exchange (a mint is raised through Issuance OS), not ${kind}`,
        'MINT_EXCHANGE_BAD_KIND',
        400
      );
    }
    const maker = String(initiatedBy || '').trim();
    if (!maker) {
      throw new MintExchangeError('initiatedBy is required', 'MINT_EXCHANGE_NO_MAKER', 400);
    }
    const holder = String(holderAddress || '').trim();
    if (!holder) {
      throw new MintExchangeError(
        'holderAddress is required: token is burned from a holding, not from thin air',
        'MINT_EXCHANGE_NO_HOLDER',
        400
      );
    }
    const token = await CapControlEngine.token(tokenId);
    const principal = wholeCents(principalCents, 'principalCents');
    const interest = wholeCents(interestCents, 'interestCents');
    if (principal + interest <= 0) {
      throw new MintExchangeError('Nothing to burn', 'MINT_EXCHANGE_BAD_AMOUNT', 400);
    }
    await this._assertHolderCovers(token.id, holder, principal + interest);

    const movementId = newId(kind);
    const inserted = await pool.query(
      `INSERT INTO token_movements
         (movement_id, kind, token_id, bond_id, holder_address, principal_cents,
          interest_cents, status, initiated_by, memo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_approval', $8, $9)
       RETURNING *`,
      [movementId, kind, token.id, token.bond_id, holder, principal, interest, maker, memo]
    );
    return inserted.rows[0];
  },

  /** Second trustee agrees to the burn or exchange. */
  async approve(movementId, approvedBy) {
    const row = await this.require(movementId);
    const checker = String(approvedBy || '').trim();
    if (!checker) {
      throw new MintExchangeError('approvedBy is required', 'MINT_EXCHANGE_NO_CHECKER', 400);
    }
    if (row.status !== 'pending_approval') {
      throw new MintExchangeError(
        `${row.movement_id} is ${row.status}, not awaiting approval`,
        'MINT_EXCHANGE_WRONG_STATE'
      );
    }
    if (checker.toLowerCase() === String(row.initiated_by).toLowerCase()) {
      throw new MintExchangeError(
        'The trustee who raised a burn cannot also approve it',
        'MINT_EXCHANGE_SAME_TRUSTEE'
      );
    }
    const updated = await pool.query(
      `UPDATE token_movements
          SET status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW()
        WHERE movement_id = $1
        RETURNING *`,
      [movementId, checker]
    );
    return updated.rows[0];
  },

  /**
   * Destroy the token. For an exchange this also returns what the trust now
   * owes the holder — an obligation for Payer OS to settle, not a settlement.
   */
  async execute(movementId, { settlementReference = null } = {}) {
    const row = await this.require(movementId);
    if (row.status !== 'approved') {
      throw new MintExchangeError(
        `${row.movement_id} is ${row.status}; only an approved movement can be executed`,
        'MINT_EXCHANGE_WRONG_STATE'
      );
    }
    const amountCents = Number(row.principal_cents) + Number(row.interest_cents);
    await this._assertHolderCovers(row.token_id, row.holder_address, amountCents);

    const { BondTokenizationEngine } = require('../dapp/bondTokenizationEngine');
    await pool.query(
      `UPDATE token_movements SET status = 'executing', updated_at = NOW() WHERE movement_id = $1`,
      [movementId]
    );
    let result;
    try {
      result = await BondTokenizationEngine.applyBurn({
        tokenId: row.token_id,
        principal: toAmount(row.principal_cents),
        interest: toAmount(row.interest_cents),
        holderAddress: row.holder_address,
      });
    } catch (err) {
      await this._fail(movementId, err.message);
      throw err;
    }

    const movement = await this._executed(movementId, {
      chainReference: result.txHash || null,
      settlementReference,
    });
    return {
      movement,
      result,
      // An exchange leaves the trust owing the holder. Saying so is the whole
      // point: the token is gone, and nothing here has paid for it.
      obligation: row.kind === 'exchange'
        ? {
          owedToHolder: row.holder_address,
          amountCents,
          amount: money(amountCents),
          settled: false,
          settlementReference,
          note: 'Raise this as a Payer OS disbursement; burning the token did not pay for it',
        }
        : null,
    };
  },

  /** Withdraw a burn or exchange that has not executed. */
  async cancel(movementId, cancelledBy) {
    const row = await this.require(movementId);
    const actor = String(cancelledBy || '').trim();
    if (!actor) {
      throw new MintExchangeError('cancelledBy is required', 'MINT_EXCHANGE_NO_ACTOR', 400);
    }
    if (!['pending_approval', 'approved'].includes(row.status)) {
      throw new MintExchangeError(
        `${row.movement_id} is ${row.status} and cannot be cancelled`,
        'MINT_EXCHANGE_WRONG_STATE'
      );
    }
    const updated = await pool.query(
      `UPDATE token_movements
          SET status = 'cancelled', failure_reason = $2, updated_at = NOW()
        WHERE movement_id = $1
        RETURNING *`,
      [movementId, `cancelled by ${actor}`]
    );
    return updated.rows[0];
  },

  /**
   * What a token would have to burn to come back under its ceiling, and who
   * holds enough to do it. Sized from Cap Control, not from a guess.
   */
  async burnRequired(tokenId) {
    const excess = await CapControlEngine.excess(tokenId);
    const holders = await pool.query(
      `SELECT holder_address, balance FROM bond_token_holders
        WHERE token_id = $1 AND balance > 0 ORDER BY balance DESC`,
      [tokenId]
    );
    return {
      tokenId,
      requiredCents: excess.totalCents,
      required: money(excess.totalCents),
      principalCents: excess.principalCents,
      interestCents: excess.interestCents,
      ceiling: excess.ceiling,
      issued: excess.issued,
      holders: holders.rows.map(row => ({
        holderAddress: row.holder_address,
        balanceCents: toCents(row.balance),
      })),
    };
  },

  async list({ kind = null, status = null, tokenId = null, limit = 100 } = {}) {
    await this.ensureTables();
    const clauses = [];
    const params = [];
    for (const [column, value] of [['kind', kind], ['status', status], ['token_id', tokenId]]) {
      if (value) {
        params.push(value);
        clauses.push(`${column} = $${params.length}`);
      }
    }
    params.push(Number(limit) || 100);
    const rows = await pool.query(
      `SELECT * FROM token_movements
         ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    return rows.rows;
  },

  async require(movementId) {
    await this.ensureTables();
    const rows = await pool.query('SELECT * FROM token_movements WHERE movement_id = $1', [movementId]);
    if (!rows.rows.length) {
      throw new MintExchangeError(`No movement ${movementId}`, 'MINT_EXCHANGE_NOT_FOUND', 404);
    }
    return rows.rows[0];
  },

  /** What the caller meant to mint, against what the ticket actually allows. */
  _assertMatchesExpectation(ticket, expect) {
    const mismatches = [];
    if (expect.tokenId && String(expect.tokenId) !== String(ticket.token_id)) {
      mismatches.push(`token ${ticket.token_id}, not ${expect.tokenId}`);
    }
    if (expect.holderAddress
      && String(expect.holderAddress).toLowerCase() !== String(ticket.holder_address || '').toLowerCase()) {
      mismatches.push(`holder ${ticket.holder_address || '(none)'}, not ${expect.holderAddress}`);
    }
    const wanted = wholeCents(
      expect.amountCents === undefined
        ? Number(expect.principalCents || 0) + Number(expect.interestCents || 0)
        : expect.amountCents,
      'expect.amountCents'
    );
    const authorised = Number(ticket.principal_cents) + Number(ticket.interest_cents);
    if (wanted && wanted !== authorised) {
      mismatches.push(`${money(authorised)}, not ${money(wanted)}`);
    }
    if (mismatches.length) {
      throw new MintExchangeError(
        `${ticket.issuance_id} authorises ${mismatches.join('; ')}`,
        'MINT_EXCHANGE_EXPECTATION_MISMATCH'
      );
    }
  },

  /** A holder cannot return more token than they hold. */
  async _assertHolderCovers(tokenId, holderAddress, amountCents) {
    const rows = await pool.query(
      'SELECT balance FROM bond_token_holders WHERE token_id = $1 AND holder_address = $2',
      [tokenId, holderAddress]
    );
    const balanceCents = rows.rows.length ? toCents(rows.rows[0].balance) : 0;
    if (balanceCents < amountCents) {
      throw new MintExchangeError(
        `${holderAddress} holds ${money(balanceCents)} of ${tokenId}, not the ${money(amountCents)} being burned`,
        'MINT_EXCHANGE_INSUFFICIENT_HOLDING'
      );
    }
    return balanceCents;
  },

  async _executed(movementId, { chainReference = null, settlementReference = null } = {}) {
    const updated = await pool.query(
      `UPDATE token_movements
          SET status = 'executed', executed_at = NOW(), updated_at = NOW(),
              chain_reference = COALESCE($2, chain_reference),
              settlement_reference = COALESCE($3, settlement_reference)
        WHERE movement_id = $1
        RETURNING *`,
      [movementId, chainReference, settlementReference]
    );
    return updated.rows[0];
  },

  async _fail(movementId, reason) {
    await pool.query(
      `UPDATE token_movements SET status = 'failed', failure_reason = $2, updated_at = NOW()
        WHERE movement_id = $1`,
      [movementId, reason]
    );
  },
};

module.exports = { MintExchangeOsEngine, MintExchangeError };
