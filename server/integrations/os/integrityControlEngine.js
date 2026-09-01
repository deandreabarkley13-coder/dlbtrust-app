'use strict';

/**
 * Whether the three places token supply is recorded still agree.
 *
 * A tokenised bond claim is written down in three independent places: the token
 * row's supply, the holder register that says who owns it, and — in live mode —
 * the contract's own totalSupply on chain. A fourth number, the bond ledger,
 * says how much of it is actually backed. Any pair of those disagreeing means
 * the trust's books and its instruments are telling different stories, and the
 * one thing worse than finding that out is issuing more while it is true.
 *
 * So this engine reconciles them and refuses. It has two jobs:
 *
 *   report   every disagreement, with the arithmetic and the exact remediation
 *            amount — an over-cap token names the burn it needs, rather than
 *            being described as "inconsistent".
 *   block    issuance while a blocking finding stands. Cap Control answers
 *            "does this fit?"; this answers "can the books be trusted at all?",
 *            and a mint has to pass both.
 *
 * It changes nothing. Remediation is a trustee's act under dual control, not a
 * side effect of a health check: silently burning a holder's balance because a
 * bond was paid down would be a worse bug than the drift it repaired.
 */

const pool = require('../bonds/pgPool');
const { CapControlEngine } = require('./capControlEngine');

/** A finding that stops issuance, versus one that only needs looking at. */
const BLOCKING = 'blocking';
const ADVISORY = 'advisory';

class IntegrityControlError extends Error {
  constructor(message, code = 'INTEGRITY_CONTROL_ERROR', status = 409) {
    super(message);
    this.name = 'IntegrityControlError';
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

const IntegrityControlEngine = {
  IntegrityControlError,
  BLOCKING,
  ADVISORY,

  async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS integrity_control_runs (
        run_id        TEXT PRIMARY KEY,
        tokens        INTEGER NOT NULL DEFAULT 0,
        findings      INTEGER NOT NULL DEFAULT 0,
        blocking      INTEGER NOT NULL DEFAULT 0,
        clean         BOOLEAN NOT NULL DEFAULT TRUE,
        detail        JSONB NOT NULL DEFAULT '[]'::jsonb,
        checked_by    TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    return true;
  },

  /**
   * Reconcile one token. Reads the token row, its holder register, the bond
   * that backs it and, in live mode, the contract.
   */
  async checkToken(tokenId) {
    const token = await this._token(tokenId);
    const findings = [];

    const supplyCents = toCents(token.total_supply);
    const principalCents = toCents(token.tokenized_principal);
    const interestCents = toCents(token.tokenized_interest);

    // 1. The components must add up to the supply, or one of the three numbers
    //    was written without the others.
    if (principalCents + interestCents !== supplyCents) {
      findings.push({
        code: 'COMPONENT_MISMATCH',
        severity: BLOCKING,
        tokenId: token.id,
        bondId: token.bond_id,
        detail: `supply is ${money(supplyCents)} but principal ${money(principalCents)}`
          + ` plus interest ${money(interestCents)} is ${money(principalCents + interestCents)}`,
        remediation: null,
      });
    }

    // 2. The holder register must account for every cent of supply. A gap means
    //    supply exists that nobody owns, or is owned twice.
    const holders = await pool.query(
      `SELECT COALESCE(SUM(balance), 0) AS total,
              COUNT(*) FILTER (WHERE balance < 0) AS negatives
         FROM bond_token_holders WHERE token_id = $1`,
      [token.id]
    );
    const heldCents = toCents(holders.rows[0]?.total);
    const negatives = Number(holders.rows[0]?.negatives || 0);
    if (heldCents !== supplyCents) {
      findings.push({
        code: 'HOLDER_SUM_MISMATCH',
        severity: BLOCKING,
        tokenId: token.id,
        bondId: token.bond_id,
        detail: `holders account for ${money(heldCents)} of a ${money(supplyCents)} supply`
          + ` (${money(Math.abs(supplyCents - heldCents))} ${heldCents < supplyCents ? 'unaccounted' : 'over-allocated'})`,
        remediation: null,
      });
    }
    if (negatives > 0) {
      findings.push({
        code: 'NEGATIVE_BALANCE',
        severity: BLOCKING,
        tokenId: token.id,
        bondId: token.bond_id,
        detail: `${negatives} holder row${negatives === 1 ? '' : 's'} carry a negative balance`,
        remediation: null,
      });
    }

    // 3. Something has to establish what backs it — a bond, or a ceiling the
    //    trust declared. A token governed by neither cannot be reconciled
    //    against anything, and supply under it is a claim on nothing.
    let excess = null;
    try {
      excess = await CapControlEngine.excess(token.id);
    } catch (err) {
      findings.push({
        code: 'UNGOVERNED_TOKEN',
        severity: supplyCents > 0 ? BLOCKING : ADVISORY,
        tokenId: token.id,
        bondId: token.bond_id,
        detail: `no ceiling governs this token: ${err.message}`,
        remediation: supplyCents > 0
          ? { action: 'burn', amountCents: supplyCents, amount: money(supplyCents) }
          : null,
      });
    }
    if (excess && excess.totalCents > 0) {
      // 4. The bond may have been paid down since the mint, which is the
      //    ordinary way a token goes over its cap without anyone minting.
      const { ceiling } = excess;
      const parts = [];
      if (excess.principalCents > 0) {
        parts.push(`principal ${money(principalCents)} against ${money(ceiling.principalCents)} outstanding`);
      }
      if (excess.interestCents > 0) {
        parts.push(`interest ${money(interestCents)} against ${money(ceiling.interestCents)} accrued`);
      }
      if (!parts.length) {
        parts.push(`supply ${money(excess.issued.totalCents)} against a ${money(ceiling.totalCents)} ceiling`);
      }
      findings.push({
        code: 'OVER_CAP',
        severity: BLOCKING,
        tokenId: token.id,
        bondId: token.bond_id,
        detail: `${parts.join(', ')} — the ${ceiling.basis} ceiling no longer backs the supply`,
        remediation: {
          action: 'burn',
          amountCents: excess.totalCents,
          amount: money(excess.totalCents),
          principalCents: excess.principalCents,
          interestCents: excess.interestCents,
        },
      });
    }

    // 5. In live mode the contract is the instrument; the row is a record of it.
    const chain = await this._chainSupply(token);
    if (chain.checked && chain.error) {
      findings.push({
        code: 'CHAIN_UNREADABLE',
        severity: BLOCKING,
        tokenId: token.id,
        bondId: token.bond_id,
        detail: `on-chain supply could not be read: ${chain.error}`,
        remediation: null,
      });
    } else if (chain.checked && chain.supplyCents !== supplyCents) {
      findings.push({
        code: 'CHAIN_SUPPLY_MISMATCH',
        severity: BLOCKING,
        tokenId: token.id,
        bondId: token.bond_id,
        detail: `the contract reports ${money(chain.supplyCents)} but the ledger records`
          + ` ${money(supplyCents)}`,
        remediation: null,
      });
    }

    return {
      tokenId: token.id,
      bondId: token.bond_id,
      symbol: token.token_symbol,
      address: token.token_address,
      supplyCents,
      principalCents,
      interestCents,
      heldCents,
      chainSupplyCents: chain.checked && !chain.error ? chain.supplyCents : null,
      findings,
      clean: findings.every(finding => finding.severity !== BLOCKING),
    };
  },

  /** Reconcile every active token. */
  async check({ tokenId = null } = {}) {
    await this.ensureTables();
    const ids = tokenId
      ? [tokenId]
      : (await pool.query(`SELECT id FROM bond_tokens WHERE status = 'active' ORDER BY created_at`))
        .rows.map(row => row.id);

    const tokens = [];
    for (const id of ids) {
      tokens.push(await this.checkToken(id));
    }
    const findings = tokens.flatMap(token => token.findings);
    const blocking = findings.filter(finding => finding.severity === BLOCKING);

    return {
      checkedAt: new Date().toISOString(),
      tokens,
      findings,
      blockingCount: blocking.length,
      clean: blocking.length === 0,
      remediation: blocking
        .filter(finding => finding.remediation)
        .map(finding => ({ ...finding.remediation, tokenId: finding.tokenId, code: finding.code })),
    };
  },

  /** Record a check so the desk can show when the books were last reconciled. */
  async record(report, { checkedBy = null } = {}) {
    await this.ensureTables();
    const runId = `INTEG-${Date.now()}`;
    const inserted = await pool.query(
      `INSERT INTO integrity_control_runs (run_id, tokens, findings, blocking, clean, detail, checked_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING *`,
      [
        runId,
        report.tokens.length,
        report.findings.length,
        report.blockingCount,
        report.clean,
        JSON.stringify(report.findings),
        checkedBy,
      ]
    );
    return inserted.rows[0];
  },

  /** The gate. A mint passes here before Cap Control is even asked. */
  async assertClean(tokenId) {
    const report = await this.check({ tokenId });
    if (report.clean) return report;
    const blocking = report.findings.filter(finding => finding.severity === BLOCKING);
    throw new IntegrityControlError(
      `Token ${tokenId} cannot issue while its records disagree —`
      + ` ${blocking.map(finding => `${finding.code}: ${finding.detail}`).join('; ')}`,
      'INTEGRITY_CONTROL_BREACH'
    );
  },

  /**
   * The contract's own supply, when there is one. A shadow token has no
   * contract, so there is nothing to disagree with and nothing is claimed.
   */
  async _chainSupply(token) {
    const address = token.token_address;
    if (!address || String(address).startsWith('shadow-')) {
      return { checked: false, supplyCents: null, error: null };
    }
    const { BondTokenizationEngine } = require('../dapp/bondTokenizationEngine');
    if (BondTokenizationEngine.getConfig().shadow) {
      return { checked: false, supplyCents: null, error: null };
    }
    try {
      const supply = await BondTokenizationEngine.chainSupply(token.id);
      return { checked: true, supplyCents: toCents(supply), error: null };
    } catch (err) {
      return { checked: true, supplyCents: null, error: err.message };
    }
  },

  async _token(tokenId) {
    const rows = await pool.query('SELECT * FROM bond_tokens WHERE id = $1', [tokenId]);
    if (!rows.rows.length) {
      throw new IntegrityControlError(
        `No bond token ${tokenId}`,
        'INTEGRITY_CONTROL_NO_TOKEN',
        404
      );
    }
    return rows.rows[0];
  },
};

module.exports = { IntegrityControlEngine, IntegrityControlError };
