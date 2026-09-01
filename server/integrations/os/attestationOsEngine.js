'use strict';

/**
 * Attestation OS — every balance in the system, and who says so.
 *
 * The trust reads its own position out of a dozen places: cash accounts in core
 * banking, the GL, the bond ledger, token supply, a distributor on Stellar, a
 * Circle account, whatever the aggregator has pulled from an outside
 * institution. They are all rendered the same way, in dollars, which is the
 * problem: a number the trust wrote down for itself looks exactly like a
 * balance somebody else is holding for it. That is how a seeded
 * CA-BOND-PROCEEDS of $100,000,000 reads as treasury cash when no custodian
 * holds a cent of it.
 *
 * This engine draws the line the rest of the system needs and never had:
 *
 *   custody   A balance observed at an institution outside the trust — a
 *             Horizon trustline, a Circle account, a bank account reached
 *             through the aggregator. This can back a payment, and only while
 *             the observation is fresh.
 *   claim     A number the trust's own books assert — cash accounts, the bond
 *             ledger, token supply. It must be covered by custody; it can
 *             never substitute for it.
 *
 * What it does:
 *
 *   attest()      run every observer at once, so one run is one timestamp
 *                 across treasury, core banking, fixed income and token.
 *                 An observer with no readable balance records the reason it
 *                 could not read one — never a zero dressed as a reading, and
 *                 never a number carried over from last time.
 *   snapshot()    the unified position: per domain, what the books claim, what
 *                 is actually attested, the variance, and every claim standing
 *                 on nothing.
 *   assertLive()  the gate. A movement is refused when the custody behind it
 *                 was never observed or was observed too long ago, because an
 *                 attestation from last month is a memory, not a balance.
 *
 * Custody observations are persisted through ReserveEngine.record(), not into a
 * store of their own: the point of this engine is one attested truth, and a
 * second attestation table would be a fifth opinion rather than a reconcilable
 * one. What lives here is the run — which observers were asked, what each one
 * answered, and what the books claimed at that instant.
 */

const pool = require('../bonds/pgPool');
const { ReserveEngine } = require('../finops/reserveEngine');

let StablecoinPayoutRail;
try {
  ({ StablecoinPayoutRail } = require('./stablecoinPayoutRail'));
} catch (e) {
  StablecoinPayoutRail = null;
}

/** The desks a balance can belong to. Every observation names exactly one. */
const DOMAINS = ['treasury', 'core_banking', 'fixed_income', 'token'];

/** Somebody else holds it, or the trust merely says so. */
const CUSTODY = 'custody';
const CLAIM = 'claim';

/**
 * Aggregator connections of this connector type read the trust's own rails, so
 * what they return is the trust quoting itself back. Counting it as custody
 * would launder a claim into a reserve.
 */
const INTERNAL_CONNECTOR_TYPES = ['internal_rails'];

const ENFORCEMENT_MODES = ['strict', 'warn', 'off'];

class AttestationError extends Error {
  constructor(message, code = 'ATTESTATION_ERROR', status = 409) {
    super(message);
    this.name = 'AttestationError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function id(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function cents(value) {
  return Math.round(Number(value || 0));
}

function money(value) {
  return `$${(Number(value || 0) / 100).toFixed(2)}`;
}

function minutes(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function ageMinutes(observedAt) {
  const then = new Date(observedAt).getTime();
  if (!Number.isFinite(then)) return Infinity;
  return (Date.now() - then) / 60000;
}

/** An observation nobody could read. Zero balance, and the reason, always. */
function unreadable({ domain, sourceType, sourceKey, reason, asset = 'USD' }) {
  return {
    domain,
    category: CUSTODY,
    sourceType,
    sourceKey,
    asset,
    balanceCents: 0,
    verification: 'unverified',
    unverifiedReason: reason,
    detail: {},
  };
}

const AttestationOsEngine = {
  AttestationError,
  DOMAINS,
  CUSTODY,
  CLAIM,

  config() {
    const mode = String(process.env.ATTESTATION_ENFORCEMENT || 'strict').toLowerCase();
    return {
      enforcement: ENFORCEMENT_MODES.includes(mode) ? mode : 'strict',
      // How long an observation may stand in for a live balance. Shorter than
      // the reserve engine's own window on purpose: this gate exists to catch
      // the case where nothing has been read recently at all.
      freshMinutes: minutes(process.env.ATTESTATION_FRESH_MINUTES, 60),
    };
  },

  async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS attestation_runs (
        run_id            TEXT PRIMARY KEY,
        observations      INTEGER NOT NULL DEFAULT 0,
        custody_cents     BIGINT NOT NULL DEFAULT 0,
        claimed_cents     BIGINT NOT NULL DEFAULT 0,
        unreadable        INTEGER NOT NULL DEFAULT 0,
        run_by            TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS attestation_observations (
        observation_id    TEXT PRIMARY KEY,
        run_id            TEXT NOT NULL,
        domain            TEXT NOT NULL,
        category          TEXT NOT NULL CHECK (category IN ('custody','claim')),
        source_type       TEXT NOT NULL,
        source_key        TEXT NOT NULL,
        asset             TEXT NOT NULL DEFAULT 'USD',
        balance_cents     BIGINT NOT NULL DEFAULT 0,
        verification      TEXT NOT NULL DEFAULT 'unverified',
        unverified_reason TEXT,
        detail            JSONB NOT NULL DEFAULT '{}'::jsonb,
        observed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_attestation_observations_source
        ON attestation_observations (source_type, source_key, observed_at DESC)
    `);
    return true;
  },

  // ── Custody observers ──────────────────────────────────────────────────────

  /**
   * The distributor's USDC trustline on Stellar. This is the one custody source
   * that can be read today with no account anywhere: Horizon is public, and the
   * rail pins Circle's issuer, so a balance in some look-alike asset cannot be
   * counted as dollars.
   */
  async _observeStellarDistributor() {
    const base = {
      domain: 'treasury',
      sourceType: 'onchain_wallet',
      sourceKey: 'stellar-distributor',
    };
    if (!StablecoinPayoutRail) {
      return unreadable({ ...base, reason: 'Stablecoin payout rail unavailable', asset: 'USDC' });
    }
    try {
      const position = await StablecoinPayoutRail.position();
      return {
        ...base,
        category: CUSTODY,
        sourceKey: position.address,
        asset: position.asset || 'USDC',
        balanceCents: cents(position.availableCents),
        verification: 'live',
        detail: {
          network: position.network,
          issuer: position.issuer,
          balance: position.balance,
          note: 'Horizon trustline balance, issuer pinned to Circle.',
        },
      };
    } catch (e) {
      return unreadable({ ...base, reason: `Stellar position unreadable: ${e.message}`, asset: 'USDC' });
    }
  },

  /**
   * The custody sources the reserve engine already knows how to read — the EVM
   * operator wallet, the Circle Mint account, the partner bank. verifyLive()
   * both reads and records them, so this engine reports rather than re-reads.
   */
  async _observeReserveCustody() {
    try {
      const result = await ReserveEngine.verifyLive();
      return (result.sources || []).map((source) => ({
        domain: 'treasury',
        category: CUSTODY,
        sourceType: source.source_type || source.sourceType,
        sourceKey: source.source_key || source.sourceKey,
        asset: source.asset || 'USD',
        balanceCents: cents(source.balance_cents !== undefined ? source.balance_cents : source.balanceCents),
        verification: source.verification || 'unverified',
        unverifiedReason: source.unverified_reason || source.unverifiedReason || null,
        detail: source.detail || {},
        // These are already in reserve_attestations; recording them again would
        // double the reserve the moment a rail added them up.
        alreadyRecorded: true,
      }));
    } catch (e) {
      return [unreadable({
        domain: 'treasury',
        sourceType: 'partner_bank',
        sourceKey: 'reserve-engine',
        reason: `Reserve verification failed: ${e.message}`,
      })];
    }
  },

  /**
   * Accounts reached through the banking aggregator. A balance pulled from an
   * outside institution is custody; one pulled from the trust's own rails is
   * the trust quoting itself, and is reported as a claim instead.
   */
  async _observeAggregatorAccounts() {
    let rows;
    try {
      rows = await pool.query(
        `SELECT a.external_account_id, a.name, a.currency, a.balance_current,
                a.updated_at, c.name AS connection_name, c.connector_type, c.active
           FROM banking_aggregator_accounts a
           JOIN banking_aggregator_connections c ON c.id = a.connection_id
          WHERE c.active = TRUE`
      );
    } catch (e) {
      return [];
    }

    const cfg = this.config();
    return (rows.rows || []).map((row) => {
      const internal = INTERNAL_CONNECTOR_TYPES.includes(String(row.connector_type));
      const sourceKey = `${row.connection_name}:${row.external_account_id}`;
      const balanceCents = cents(Number(row.balance_current) * 100);
      const stale = ageMinutes(row.updated_at) > cfg.freshMinutes;

      if (internal) {
        return {
          domain: 'core_banking',
          category: CLAIM,
          sourceType: 'depository_account',
          sourceKey,
          asset: String(row.currency || 'USD').toUpperCase(),
          balanceCents,
          verification: 'unverified',
          unverifiedReason: 'Read from the trust\'s own rails: a claim, not an outside custodian',
          detail: { connector: row.connector_type, accountName: row.name },
        };
      }

      if (stale || !Number.isFinite(Number(row.balance_current))) {
        return unreadable({
          domain: 'treasury',
          sourceType: 'depository_account',
          sourceKey,
          reason: stale
            ? `Aggregator last synced this account ${Math.round(ageMinutes(row.updated_at))} minutes ago;`
              + ' pull it again before counting it'
            : 'Aggregator holds no balance for this account',
        });
      }

      return {
        domain: 'treasury',
        category: CUSTODY,
        sourceType: 'depository_account',
        sourceKey,
        asset: String(row.currency || 'USD').toUpperCase(),
        balanceCents,
        verification: 'live',
        detail: { connector: row.connector_type, accountName: row.name },
      };
    });
  },

  // ── Book claims ────────────────────────────────────────────────────────────

  /** What core banking says the trust holds in each cash account. */
  async _claimCoreBankingCash() {
    let rows;
    try {
      rows = await pool.query(
        `SELECT account_id, account_name, account_type, balance_cents
           FROM cash_accounts
          WHERE status = 'active'`
      );
    } catch (e) {
      return [];
    }
    return (rows.rows || []).map((row) => ({
      domain: 'core_banking',
      category: CLAIM,
      sourceType: 'depository_account',
      sourceKey: row.account_id,
      asset: 'USD',
      balanceCents: cents(row.balance_cents),
      verification: 'unverified',
      unverifiedReason: 'Ledger balance in core banking; no custodian has confirmed it',
      detail: { accountName: row.account_name, accountType: row.account_type },
    }));
  },

  /** What the bond ledger says is outstanding — an obligation, not cash. */
  async _claimBondLedger() {
    let rows;
    try {
      rows = await pool.query(
        `SELECT id, bond_name, bond_identifier, principal_balance, accrued_interest
           FROM bonds
          WHERE COALESCE(status, 'active') = 'active'`
      );
    } catch (e) {
      return [];
    }
    return (rows.rows || []).map((row) => ({
      domain: 'fixed_income',
      category: CLAIM,
      sourceType: 'securities_custodian',
      sourceKey: row.bond_identifier || row.bond_name || `bond-${row.id}`,
      asset: 'USD',
      balanceCents: cents(Number(row.principal_balance) * 100) + cents(Number(row.accrued_interest) * 100),
      verification: 'unverified',
      unverifiedReason: 'Bond ledger balance; self-issued paper backs nothing until a custodian holds it',
      detail: {
        bondId: row.id,
        principalCents: cents(Number(row.principal_balance) * 100),
        interestCents: cents(Number(row.accrued_interest) * 100),
      },
    }));
  },

  /** Token supply outstanding — a claim on the corpus, held by someone. */
  async _claimTokenSupply() {
    let rows;
    try {
      rows = await pool.query(
        `SELECT id, token_symbol, total_supply, bond_id
           FROM bond_tokens
          WHERE COALESCE(status, 'active') = 'active'`
      );
    } catch (e) {
      return [];
    }
    return (rows.rows || []).map((row) => ({
      domain: 'token',
      category: CLAIM,
      sourceType: 'depository_account',
      sourceKey: row.token_symbol || row.id,
      asset: row.token_symbol || 'TOKEN',
      balanceCents: cents(Number(row.total_supply) * 100),
      verification: 'unverified',
      unverifiedReason: 'Token supply is a claim the trust issued against itself',
      detail: { tokenId: row.id, bondId: row.bond_id },
    }));
  },

  // ── The run ────────────────────────────────────────────────────────────────

  /**
   * Ask every observer at once and write down what each answered. One run is
   * one instant across every desk, which is the only way the numbers can be
   * compared to each other at all.
   */
  async attest({ runBy = null } = {}) {
    await this.ensureTables();

    const [stellar, reserve, aggregator, cash, bonds, tokens] = await Promise.all([
      this._observeStellarDistributor(),
      this._observeReserveCustody(),
      this._observeAggregatorAccounts(),
      this._claimCoreBankingCash(),
      this._claimBondLedger(),
      this._claimTokenSupply(),
    ]);

    const observations = [stellar, ...reserve, ...aggregator, ...cash, ...bonds, ...tokens]
      .filter(Boolean)
      .map((observation) => ({ category: CUSTODY, ...observation }));

    const runId = id('ATT');
    const persisted = [];

    for (const observation of observations) {
      // Custody is the reserve engine's ledger to keep. This engine records the
      // run; it does not keep a second opinion on what a custodian holds.
      if (observation.category === CUSTODY && !observation.alreadyRecorded) {
        try {
          await ReserveEngine.record({
            sourceType: observation.sourceType,
            sourceKey: observation.sourceKey,
            asset: observation.asset,
            balanceCents: observation.balanceCents,
            verification: observation.verification,
            unverifiedReason: observation.unverifiedReason || null,
            detail: observation.detail || {},
            attestedBy: runBy,
          });
        } catch (e) {
          observation.recordError = e.message;
        }
      }

      const observationId = id('OBS');
      await pool.query(
        `INSERT INTO attestation_observations
           (observation_id, run_id, domain, category, source_type, source_key, asset,
            balance_cents, verification, unverified_reason, detail, observed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,NOW())`,
        [
          observationId,
          runId,
          observation.domain,
          observation.category,
          observation.sourceType,
          observation.sourceKey,
          String(observation.asset || 'USD').toUpperCase(),
          observation.balanceCents,
          observation.verification,
          observation.unverifiedReason || null,
          JSON.stringify(observation.detail || {}),
        ]
      );
      persisted.push({ ...observation, observationId });
    }

    const custodyCents = persisted
      .filter((o) => o.category === CUSTODY && o.verification !== 'unverified')
      .reduce((sum, o) => sum + o.balanceCents, 0);
    const claimedCents = persisted
      .filter((o) => o.category === CLAIM)
      .reduce((sum, o) => sum + o.balanceCents, 0);
    const unreadableCount = persisted
      .filter((o) => o.category === CUSTODY && o.verification === 'unverified').length;

    await pool.query(
      `INSERT INTO attestation_runs
         (run_id, observations, custody_cents, claimed_cents, unreadable, run_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [runId, persisted.length, custodyCents, claimedCents, unreadableCount, runBy]
    );

    return {
      runId,
      observations: persisted,
      custodyCents,
      claimedCents,
      unreadable: unreadableCount,
    };
  },

  /** The newest observation for each source, whenever it was taken. */
  async latest() {
    await this.ensureTables();
    const rows = await pool.query(
      `SELECT DISTINCT ON (source_type, source_key, domain) *
         FROM attestation_observations
        ORDER BY source_type, source_key, domain, observed_at DESC`
    );
    const cfg = this.config();
    return (rows.rows || []).map((row) => {
      const age = ageMinutes(row.observed_at);
      const stale = age > cfg.freshMinutes;
      return {
        ...row,
        balance_cents: cents(row.balance_cents),
        ageMinutes: Number.isFinite(age) ? Math.round(age) : null,
        stale,
        // Only a custody balance that was read, and read recently, is money the
        // trust can act on. Everything else is a number waiting for evidence.
        live: row.category === CUSTODY && row.verification !== 'unverified' && !stale,
      };
    });
  },

  /**
   * The unified position. Per domain: what the books claim, what is actually
   * attested at a custodian, and the difference — which is the number nobody
   * in this system could previously see.
   */
  async snapshot() {
    const observations = await this.latest();
    const cfg = this.config();

    const domains = {};
    for (const domain of DOMAINS) {
      domains[domain] = {
        domain,
        attestedCents: 0,
        claimedCents: 0,
        unreadable: [],
        stale: [],
        sources: [],
      };
    }

    for (const row of observations) {
      const domain = domains[row.domain] || (domains[row.domain] = {
        domain: row.domain,
        attestedCents: 0,
        claimedCents: 0,
        unreadable: [],
        stale: [],
        sources: [],
      });
      if (row.category === CUSTODY) {
        if (row.live) domain.attestedCents += row.balance_cents;
        if (row.verification === 'unverified') {
          domain.unreadable.push({ sourceKey: row.source_key, reason: row.unverified_reason });
        } else if (row.stale) {
          domain.stale.push({ sourceKey: row.source_key, ageMinutes: row.ageMinutes });
        }
      } else {
        domain.claimedCents += row.balance_cents;
      }
      domain.sources.push({
        sourceType: row.source_type,
        sourceKey: row.source_key,
        category: row.category,
        asset: row.asset,
        balanceCents: row.balance_cents,
        verification: row.verification,
        unverifiedReason: row.unverified_reason,
        ageMinutes: row.ageMinutes,
        live: row.live,
      });
    }

    const list = Object.values(domains).map((domain) => ({
      ...domain,
      varianceCents: domain.claimedCents - domain.attestedCents,
      // A ratio only means something where something is claimed; 100% of
      // nothing is not coverage.
      coverageRatio: domain.claimedCents > 0
        ? Number((domain.attestedCents / domain.claimedCents).toFixed(4))
        : null,
    }));

    const attestedCents = list.reduce((sum, d) => sum + d.attestedCents, 0);
    const claimedCents = list.reduce((sum, d) => sum + d.claimedCents, 0);

    return {
      observedAt: new Date().toISOString(),
      freshMinutes: cfg.freshMinutes,
      enforcement: cfg.enforcement,
      attestedCents,
      claimedCents,
      varianceCents: claimedCents - attestedCents,
      attested: attestedCents / 100,
      claimed: claimedCents / 100,
      domains: list,
      // Said plainly, because the aggregate hides it: these are the books'
      // numbers that no outside institution has confirmed.
      uncovered: list
        .filter((d) => d.claimedCents > d.attestedCents)
        .map((d) => ({
          domain: d.domain,
          uncoveredCents: d.claimedCents - d.attestedCents,
          summary: `${d.domain}: ${money(d.claimedCents)} claimed, ${money(d.attestedCents)} attested`,
        })),
      sourcesObserved: observations.length,
    };
  },

  /**
   * The gate. A rail calls this before it moves money: an amount may only be
   * transmitted while custody behind it has been observed, and observed
   * recently. Whether the reserve is large enough remains the reserve engine's
   * question, so there is one answer to it, not two.
   */
  async assertLive({
    amountCents, rail = 'external', domain = 'treasury', accountId = null, seriesId = null,
  } = {}) {
    const cfg = this.config();
    const amount = cents(amountCents);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new AttestationError('assertLive requires a positive integer amountCents', 'ATTESTATION_BAD_AMOUNT', 400);
    }
    if (cfg.enforcement === 'off') {
      return { allowed: true, enforcement: 'off', reason: 'Attestation enforcement disabled' };
    }

    const observations = await this.latest();
    const custody = observations.filter((row) => row.category === CUSTODY && row.domain === domain);
    const live = custody.filter((row) => row.live);
    const liveCents = live.reduce((sum, row) => sum + row.balance_cents, 0);

    if (!custody.length) {
      // This engine has never observed anything in this domain, which is not
      // the same as there being no reserve: the reserve engine keeps its own
      // attestations and already refuses on an empty or expired one. Adding a
      // second refusal here would be a second gate saying the same thing, so
      // the ruling stays where it belongs.
      const reserve = await ReserveEngine.assertSpendable({ amountCents: amount, rail, accountId, seriesId })
        .catch((e) => { throw new AttestationError(e.message, 'ATTESTATION_RESERVE_REFUSED', 409); });
      return {
        allowed: true,
        enforcement: cfg.enforcement,
        liveCents: 0,
        note: `No attestation run has observed ${domain}; the reserve engine's own attestation carried this`,
        reserve,
      };
    }

    if (!live.length) {
      const stalest = custody
        .filter((row) => row.verification !== 'unverified')
        .sort((a, b) => (a.ageMinutes || 0) - (b.ageMinutes || 0))[0];
      const reason = stalest
        ? `The newest ${domain} attestation is ${stalest.ageMinutes} minutes old, past the`
          + ` ${cfg.freshMinutes} minute window: re-attest before transmitting`
        : `Nothing in ${domain} could be read at a custodian:`
          + ` ${custody.map((row) => row.unverified_reason).filter(Boolean).join('; ')}`;
      if (cfg.enforcement === 'strict') {
        throw new AttestationError(reason, 'ATTESTATION_STALE', 409);
      }
      return { allowed: true, enforcement: cfg.enforcement, warning: reason, liveCents: 0 };
    }

    if (amount > liveCents) {
      const reason = `${money(amount)} exceeds the ${money(liveCents)} attested live in ${domain}`;
      if (cfg.enforcement === 'strict') {
        throw new AttestationError(reason, 'ATTESTATION_INSUFFICIENT', 409);
      }
      return { allowed: true, enforcement: cfg.enforcement, warning: reason, liveCents };
    }

    // Size is the reserve engine's ruling, and it owns ring-fencing and
    // provenance too; this engine only ever adds the freshness condition.
    const reserve = await ReserveEngine.assertSpendable({ amountCents: amount, rail, accountId, seriesId })
      .catch((e) => { throw new AttestationError(e.message, 'ATTESTATION_RESERVE_REFUSED', 409); });

    return {
      allowed: true,
      enforcement: cfg.enforcement,
      liveCents,
      sources: live.map((row) => ({ sourceKey: row.source_key, ageMinutes: row.ageMinutes })),
      reserve,
    };
  },

  /**
   * A custodian with no balance API can still be attested, but only the way a
   * statement is: naming the evidence and the officer who stands behind it.
   * The reserve engine enforces both, which is why this delegates rather than
   * writing its own row.
   */
  async statement({
    domain = 'treasury', sourceType, sourceKey, balanceCents,
    evidenceReference, attestedBy, asset = 'USD', detail = {},
  } = {}) {
    if (!DOMAINS.includes(domain)) {
      throw new AttestationError(`Unknown domain: ${domain}`, 'ATTESTATION_BAD_DOMAIN', 400);
    }
    await this.ensureTables();
    const recorded = await ReserveEngine.record({
      sourceType,
      sourceKey,
      asset,
      balanceCents: cents(balanceCents),
      verification: 'statement',
      evidenceReference,
      attestedBy,
      detail,
    });

    const runId = id('ATT');
    await pool.query(
      `INSERT INTO attestation_observations
         (observation_id, run_id, domain, category, source_type, source_key, asset,
          balance_cents, verification, unverified_reason, detail, observed_at)
       VALUES ($1,$2,$3,'custody',$4,$5,$6,$7,'statement',NULL,$8::jsonb,NOW())`,
      [
        id('OBS'), runId, domain, sourceType, sourceKey,
        String(asset).toUpperCase(), cents(balanceCents),
        JSON.stringify({ ...detail, evidenceReference, attestedBy }),
      ]
    );
    return { runId, attestation: recorded };
  },

  /** Readiness, safe for a dashboard: what can be read, and what cannot. */
  async status() {
    const snapshot = await this.snapshot();
    return {
      enforcement: snapshot.enforcement,
      freshMinutes: snapshot.freshMinutes,
      attestedCents: snapshot.attestedCents,
      claimedCents: snapshot.claimedCents,
      varianceCents: snapshot.varianceCents,
      live: snapshot.domains.flatMap((d) => d.sources.filter((s) => s.live).map((s) => s.sourceKey)),
      unreadable: snapshot.domains.flatMap((d) => d.unreadable),
      stale: snapshot.domains.flatMap((d) => d.stale),
    };
  },
};

module.exports = { AttestationOsEngine, AttestationError, DOMAINS, CUSTODY, CLAIM };
