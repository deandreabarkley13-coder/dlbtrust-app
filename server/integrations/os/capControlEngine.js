'use strict';

/**
 * How much token the trust is allowed to have in existence.
 *
 * A bond token is a claim on a bond the trust holds. If more token exists than
 * the bond is worth, the surplus is a claim on nothing: settling with it moves
 * value the corpus cannot cover, and the books stop meaning anything. Nobody
 * outside the family has to be involved for that to hurt.
 *
 * This engine answers one question — may this much token exist? — and it is the
 * only thing entitled to answer it. It holds no keys, mints nothing, and
 * changes nothing.
 *
 * Two kinds of ceiling, because the repo has two kinds of token:
 *
 *   bond-backed   The ceiling is read from the bond ledger on every call, never
 *                 cached and never configured: tokenised principal may not
 *                 exceed the bond's principal_balance, and tokenised interest
 *                 may not exceed its accrued_interest. The components are
 *                 capped separately, so interest token can never be backed by
 *                 principal that is already backing principal token. A bond
 *                 paid down lowers its own ceiling, which is the ordinary way a
 *                 token goes over cap without anyone minting.
 *   declared      DLBUSD and the module tokens reference no bond, so no bond
 *                 can govern them. They get an explicit ceiling the trust
 *                 declares in TOKEN_DECLARED_CEILINGS, and a token with no
 *                 declared ceiling cannot mint at all. Unbacked and unlimited
 *                 is the one combination that must not be reachable.
 *
 * Headroom is the ceiling minus what is issued minus what open issuance tickets
 * are holding, so two approvals in flight cannot both spend the same room.
 */

const pool = require('../bonds/pgPool');

/** Tickets in these states hold headroom they have not spent yet. */
const OPEN_ISSUANCE_STATUSES = ['pending_approval', 'approved'];

class CapControlError extends Error {
  constructor(message, code = 'CAP_CONTROL_ERROR', status = 409) {
    super(message);
    this.name = 'CapControlError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function text(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === null ? fallback : String(value).trim();
}

/**
 * Ceilings for tokens no bond backs, as `{"DLBUSD": 500000}` in cents, keyed by
 * token symbol or token id.
 */
function declaredCeilings() {
  const raw = text('TOKEN_DECLARED_CEILINGS');
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CapControlError(
      `TOKEN_DECLARED_CEILINGS is not valid JSON: ${err.message}`,
      'CAP_CONTROL_BAD_CONFIG',
      500
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CapControlError(
      'TOKEN_DECLARED_CEILINGS must be an object of token symbol or id to a ceiling in cents',
      'CAP_CONTROL_BAD_CONFIG',
      500
    );
  }
  const ceilings = {};
  for (const [key, value] of Object.entries(parsed)) {
    const cents = Number(value);
    if (!Number.isInteger(cents) || cents < 0) {
      throw new CapControlError(
        `TOKEN_DECLARED_CEILINGS[${key}] must be a whole number of cents, not ${value}`,
        'CAP_CONTROL_BAD_CONFIG',
        500
      );
    }
    ceilings[String(key).trim().toUpperCase()] = cents;
  }
  return ceilings;
}

function getConfig() {
  return {
    // An optional ceiling across every token, for when the trust wants a hard
    // number regardless of what the bonds could support.
    globalCeilingCents: Number(text('TOKEN_ISSUANCE_GLOBAL_CEILING_CENTS', '0')) || 0,
    declaredCeilings: declaredCeilings(),
  };
}

function money(cents) {
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

/**
 * Token supply and bond amounts are dollars in their tables; everything is
 * compared in cents so a rounding difference cannot become headroom.
 */
function toCents(amount) {
  return Math.round(Number(amount || 0) * 100);
}

function wholeCents(value, field) {
  const cents = Number(value || 0);
  if (!Number.isInteger(cents) || cents < 0) {
    throw new CapControlError(
      `${field} must be a whole number of cents, not ${value}`,
      'CAP_CONTROL_BAD_AMOUNT',
      400
    );
  }
  return cents;
}

const CapControlEngine = {
  CapControlError,
  OPEN_ISSUANCE_STATUSES,
  config: getConfig,

  /** The token row, which decides which kind of ceiling governs it. */
  async token(tokenId) {
    const rows = await pool.query('SELECT * FROM bond_tokens WHERE id = $1', [tokenId]);
    if (!rows.rows.length) {
      throw new CapControlError(`No bond token ${tokenId}`, 'CAP_CONTROL_NO_TOKEN', 404);
    }
    return rows.rows[0];
  },

  /**
   * A bond by whatever the desk calls it: the row id, the trust's own
   * identifier (`19781443-DLB-PRB`), the bond name, or the ISIN. Operators know
   * the instrument by its reference, and guessing that a reference is row 1 is
   * how a cap ends up bound to the wrong bond.
   */
  async resolveBond(reference) {
    const ref = String(reference === undefined || reference === null ? '' : reference).trim();
    if (!ref) {
      throw new CapControlError('A bond reference is required', 'CAP_CONTROL_NO_BOND_REF', 400);
    }
    const numeric = /^\d+$/.test(ref) ? Number(ref) : null;
    const rows = await pool.query(
      `SELECT id, bond_name, bond_identifier, isin
         FROM bonds
        WHERE ($1::integer IS NOT NULL AND id = $1::integer)
           OR UPPER(COALESCE(bond_identifier, '')) = UPPER($2)
           OR UPPER(bond_name) = UPPER($2)
           OR UPPER(COALESCE(isin, '')) = UPPER($2)
        ORDER BY id
        LIMIT 2`,
      [numeric, ref]
    );
    if (!rows.rows.length) {
      throw new CapControlError(
        `No bond matches ${ref} by id, identifier, name or ISIN`,
        'CAP_CONTROL_NO_BOND',
        404
      );
    }
    if (rows.rows.length > 1) {
      throw new CapControlError(
        `${ref} matches more than one bond (${rows.rows.map(r => r.id).join(', ')}); use the row id`,
        'CAP_CONTROL_AMBIGUOUS_BOND',
        409
      );
    }
    return rows.rows[0];
  },

  /**
   * What a bond backs, in cents. Read from the bond ledger every time: a bond
   * that has been paid down backs less than it did yesterday, and a cached
   * ceiling is how over-issuance happens.
   */
  async bondCeiling(bondId) {
    const { BondEngine } = require('../bonds/bondEngine');
    const bond = await BondEngine.getBond(bondId);
    if (!bond) {
      throw new CapControlError(
        `Bond ${bondId} does not exist, so nothing backs a token issued against it`,
        'CAP_CONTROL_NO_BOND',
        404
      );
    }
    const principalCents = toCents(bond.principal_balance);
    const interestCents = toCents(bond.accrued_interest);
    return {
      basis: 'bond',
      bondId: bond.id,
      bondName: bond.bond_name,
      principalCents,
      interestCents,
      totalCents: principalCents + interestCents,
      componentCapped: true,
    };
  },

  /**
   * The ceiling governing a token, and where it came from. An unbacked token
   * with nothing declared refuses here rather than defaulting to a number.
   */
  async ceiling(tokenId) {
    const token = await this.token(tokenId);
    if (token.bond_id !== null && token.bond_id !== undefined) {
      return { ...(await this.bondCeiling(token.bond_id)), tokenId: token.id };
    }
    const cfg = getConfig();
    const bySymbol = cfg.declaredCeilings[String(token.token_symbol || '').toUpperCase()];
    const byId = cfg.declaredCeilings[String(token.id).toUpperCase()];
    const declared = byId === undefined ? bySymbol : byId;
    if (declared === undefined) {
      throw new CapControlError(
        `${token.token_symbol || token.id} is backed by no bond and has no declared ceiling:`
        + ' add it to TOKEN_DECLARED_CEILINGS (cents) before any of it can be minted',
        'CAP_CONTROL_NO_CEILING'
      );
    }
    return {
      basis: 'declared',
      tokenId: token.id,
      bondId: null,
      symbol: token.token_symbol,
      principalCents: declared,
      interestCents: declared,
      totalCents: declared,
      // A declared ceiling is one number, so principal and interest are only
      // capped together; splitting it would invent a division nobody declared.
      componentCapped: false,
    };
  },

  /**
   * Token already in existence within the ceiling's scope. A bond ceiling is
   * shared by every token referencing that bond — one bond with two token
   * contracts is still one bond — while a declared ceiling governs its own
   * token only.
   */
  async issued(ceiling) {
    const rows = ceiling.basis === 'bond'
      ? await pool.query(
        `SELECT COALESCE(SUM(tokenized_principal), 0) AS principal,
                COALESCE(SUM(tokenized_interest), 0)  AS interest,
                COALESCE(SUM(total_supply), 0)        AS supply
           FROM bond_tokens
          WHERE bond_id = $1 AND status = 'active'`,
        [ceiling.bondId]
      )
      : await pool.query(
        `SELECT COALESCE(tokenized_principal, 0) AS principal,
                COALESCE(tokenized_interest, 0)  AS interest,
                COALESCE(total_supply, 0)        AS supply
           FROM bond_tokens
          WHERE id = $1`,
        [ceiling.tokenId]
      );
    const row = rows.rows[0] || {};
    return {
      principalCents: toCents(row.principal),
      interestCents: toCents(row.interest),
      totalCents: toCents(row.supply),
    };
  },

  /**
   * Headroom held by tickets that have not minted yet. Without this, two
   * trustees approving two tickets against the same bond both see the same room
   * and both spend it.
   */
  async reserved(ceiling, { excludeIssuanceId = null } = {}) {
    const exists = await pool.query(
      `SELECT to_regclass('token_issuances') IS NOT NULL AS present`
    );
    if (!exists.rows[0]?.present) {
      return { principalCents: 0, interestCents: 0, totalCents: 0 };
    }
    const params = [OPEN_ISSUANCE_STATUSES];
    const clauses = [`status = ANY($1::text[])`];
    if (ceiling.basis === 'bond') {
      params.push(ceiling.bondId);
      clauses.push(`bond_id = $${params.length}`);
    } else {
      params.push(ceiling.tokenId);
      clauses.push(`token_id = $${params.length}`);
    }
    if (excludeIssuanceId) {
      params.push(excludeIssuanceId);
      clauses.push(`issuance_id <> $${params.length}`);
    }
    const rows = await pool.query(
      `SELECT COALESCE(SUM(principal_cents), 0) AS principal,
              COALESCE(SUM(interest_cents), 0)  AS interest
         FROM token_issuances
        WHERE ${clauses.join(' AND ')}`,
      params
    );
    const row = rows.rows[0] || {};
    const principalCents = Number(row.principal || 0);
    const interestCents = Number(row.interest || 0);
    return { principalCents, interestCents, totalCents: principalCents + interestCents };
  },

  /** Every cent of token in existence, for the trust-wide ceiling. */
  async issuedTrustWide() {
    const rows = await pool.query(
      `SELECT COALESCE(SUM(total_supply), 0) AS supply FROM bond_tokens WHERE status = 'active'`
    );
    return toCents(rows.rows[0]?.supply);
  },

  /**
   * What may still be minted for a token. Reads only, so a desk can see the
   * room before spending an approval on a ticket that would be refused.
   */
  async headroom(tokenId, { excludeIssuanceId = null } = {}) {
    const cfg = getConfig();
    const ceiling = await this.ceiling(tokenId);
    const issued = await this.issued(ceiling);
    const reserved = await this.reserved(ceiling, { excludeIssuanceId });

    const totalCents = Math.max(0, ceiling.totalCents - issued.totalCents - reserved.totalCents);
    const principalCents = ceiling.componentCapped
      ? Math.max(0, ceiling.principalCents - issued.principalCents - reserved.principalCents)
      : totalCents;
    const interestCents = ceiling.componentCapped
      ? Math.max(0, ceiling.interestCents - issued.interestCents - reserved.interestCents)
      : totalCents;

    let globalHeadroomCents = null;
    if (cfg.globalCeilingCents) {
      globalHeadroomCents = Math.max(0, cfg.globalCeilingCents - (await this.issuedTrustWide()));
    }

    return {
      tokenId,
      ceiling,
      issued,
      reserved,
      principalCents,
      interestCents,
      totalCents,
      principal: money(principalCents),
      interest: money(interestCents),
      total: money(totalCents),
      globalCeilingCents: cfg.globalCeilingCents || null,
      globalHeadroomCents,
    };
  },

  /**
   * Would this mint fit? Returns the arithmetic either way rather than a bare
   * boolean, because the desk needs to know by how much it does not fit.
   */
  async assess({ tokenId, principalCents = 0, interestCents = 0, excludeIssuanceId = null } = {}) {
    const wantPrincipal = wholeCents(principalCents, 'principalCents');
    const wantInterest = wholeCents(interestCents, 'interestCents');
    if (wantPrincipal + wantInterest <= 0) {
      throw new CapControlError(
        'An issuance must be for a positive amount',
        'CAP_CONTROL_BAD_AMOUNT',
        400
      );
    }
    const headroom = await this.headroom(tokenId, { excludeIssuanceId });
    const breaches = [];

    if (headroom.ceiling.componentCapped) {
      if (wantPrincipal > headroom.principalCents) {
        breaches.push(
          `principal: ${money(wantPrincipal)} requested, ${money(headroom.principalCents)} available`
          + ` (${money(headroom.ceiling.principalCents)} outstanding principal,`
          + ` ${money(headroom.issued.principalCents)} issued,`
          + ` ${money(headroom.reserved.principalCents)} reserved)`
        );
      }
      if (wantInterest > headroom.interestCents) {
        breaches.push(
          `interest: ${money(wantInterest)} requested, ${money(headroom.interestCents)} available`
          + ` (${money(headroom.ceiling.interestCents)} accrued,`
          + ` ${money(headroom.issued.interestCents)} issued,`
          + ` ${money(headroom.reserved.interestCents)} reserved)`
        );
      }
    }
    if (wantPrincipal + wantInterest > headroom.totalCents) {
      breaches.push(
        `${headroom.ceiling.basis} ceiling: ${money(wantPrincipal + wantInterest)} requested,`
        + ` ${money(headroom.totalCents)} available of ${money(headroom.ceiling.totalCents)}`
      );
    }
    if (
      headroom.globalHeadroomCents !== null
      && wantPrincipal + wantInterest > headroom.globalHeadroomCents
    ) {
      breaches.push(
        `trust-wide ceiling: ${money(wantPrincipal + wantInterest)} requested,`
        + ` ${money(headroom.globalHeadroomCents)} left of the`
        + ` ${money(headroom.globalCeilingCents)} limit`
      );
    }

    return {
      allowed: breaches.length === 0,
      requestedPrincipalCents: wantPrincipal,
      requestedInterestCents: wantInterest,
      headroom,
      breaches,
    };
  },

  /** The gate. Anything that creates token passes here, or has no authority. */
  async assertIssuable({ tokenId, principalCents = 0, interestCents = 0, excludeIssuanceId = null } = {}) {
    const assessment = await this.assess({
      tokenId, principalCents, interestCents, excludeIssuanceId,
    });
    if (!assessment.allowed) {
      throw new CapControlError(
        `Minting this would put more token in existence than backs it —`
        + ` ${assessment.breaches.join('; ')}`,
        'CAP_CONTROL_OVER_CEILING'
      );
    }
    return assessment;
  },

  /** A bond's ceiling and every token standing on it, by any reference. */
  async bondSummary(reference) {
    const bond = await this.resolveBond(reference);
    const ceiling = await this.bondCeiling(bond.id);
    const issued = await this.issued(ceiling);
    const reserved = await this.reserved(ceiling);
    const tokens = await pool.query(
      `SELECT id, token_symbol, token_name, token_address, status,
              total_supply, tokenized_principal, tokenized_interest
         FROM bond_tokens
        WHERE bond_id = $1
        ORDER BY created_at`,
      [bond.id]
    );
    return {
      bond: {
        id: bond.id,
        name: bond.bond_name,
        identifier: bond.bond_identifier,
        isin: bond.isin,
      },
      ceiling,
      issued,
      reserved,
      headroomCents: Math.max(0, ceiling.totalCents - issued.totalCents - reserved.totalCents),
      tokens: tokens.rows,
    };
  },

  /** How far over its ceiling a token already is, and so how much must burn. */
  async excess(tokenId) {
    const ceiling = await this.ceiling(tokenId);
    const issued = await this.issued(ceiling);
    const principalCents = ceiling.componentCapped
      ? Math.max(0, issued.principalCents - ceiling.principalCents)
      : 0;
    const interestCents = ceiling.componentCapped
      ? Math.max(0, issued.interestCents - ceiling.interestCents)
      : 0;
    const totalCents = Math.max(
      principalCents + interestCents,
      Math.max(0, issued.totalCents - ceiling.totalCents)
    );
    return {
      tokenId, ceiling, issued, principalCents, interestCents, totalCents, total: money(totalCents),
    };
  },
};

module.exports = { CapControlEngine, CapControlError };
