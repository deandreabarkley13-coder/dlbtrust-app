'use strict';

/**
 * Core Bank Reserve Engine
 *
 * A real bank's core system is backed by a reserve: dollars held at the Fed or
 * a correspondent. Canonical's cash accounts had no equivalent, so a ledger
 * balance created by an internal journal posting read exactly like a balance
 * created by an incoming wire — which is how outbound rails ended up being
 * attempted against unbacked cash.
 *
 * This engine supplies the missing layer:
 *
 *   1. Attestations — the balances actually held for the trust at an external
 *      custodian, each recorded with how it was verified. Live verification
 *      reads the mainnet wallet and the Circle Mint business account; anything
 *      that has no readable balance API is recorded as `unverified` with the
 *      reason, never as a reserve.
 *   2. Coverage — attested external reserves against ledger cash liabilities,
 *      producing a reserve ratio and the unbacked remainder.
 *   3. Provenance — a walk back through cash_movements to the accounts that
 *      originated a balance, classifying it as externally backed or internally
 *      originated.
 *   4. Enforcement — `assertSpendable()`, which external rails call before
 *      origination so an unbacked balance cannot be transmitted.
 *   5. Fixed income — the bond portfolio read as collateral rather than cash.
 *      A bond the trust issued and holds itself is an asset and a liability in
 *      the same instrument, so it backs nothing; a third-party bond held at a
 *      custodian backs a pledge or a sale, which is reported separately from
 *      spendable reserve because it has to be liquidated first.
 *
 * The engine never treats a Canonical entry, a self-issued instrument, or a
 * self-held token as a reserve. Only a balance observed at an external
 * custodian counts.
 */

const pool = require('../bonds/pgPool');

let Web3Engine;
try { ({ Web3Engine } = require('../dapp/web3Engine')); } catch (e) { Web3Engine = null; }

let CircleMintClient;
try { ({ CircleMintClient } = require('../stablecoin/circleMintClient')); } catch (e) { CircleMintClient = null; }

let PartnerBankRails;
try { ({ PartnerBankRails } = require('../rails/partnerBankRails')); } catch (e) { PartnerBankRails = null; }

const SOURCE_TYPES = [
  'onchain_wallet',
  'circle_custody',
  'partner_bank',
  'depository_account',
  'custodian_statement',
  'securities_custodian',
];

const VERIFICATIONS = ['live', 'statement', 'unverified'];

/**
 * Cash is spendable over a payment rail as-is. Fixed income has to be sold or
 * pledged before it becomes cash, so it is attested and reported but never
 * added to the amount a rail may transmit.
 */
const ASSET_CLASSES = ['cash', 'fixed_income'];

const FIXED_INCOME_SOURCE_TYPES = ['securities_custodian'];

/** Issuer names that mean the trust itself issued the instrument. */
const DEFAULT_TRUST_ISSUERS = [
  'deandrea lavar barkley trust',
  'deandrea lavar barkley trust company',
  'dlb trust',
];

/**
 * Movement reference types that represent value arriving from outside the
 * trust's own books. Everything else is an internal posting.
 */
const DEFAULT_EXTERNAL_ORIGINS = [
  'wire_in',
  'incoming_wire',
  'ach_credit_received',
  'partner_bank_deposit',
  'onchain_deposit',
  'circle_payout',
  'card_settlement',
  'pdcflow_debit_settled',
  'depository_deposit',
];

const ENFORCEMENT_MODES = ['strict', 'warn', 'off'];

function id(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function cents(value) {
  return Math.round(Number(value || 0));
}

function dollars(value) {
  return Number(value || 0) / 100;
}

function list(raw, fallback) {
  const parsed = String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return parsed.length ? parsed : fallback;
}

function hours(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isStale(observedAt, ttlHours) {
  if (!observedAt) return true;
  const observed = new Date(observedAt).getTime();
  if (!Number.isFinite(observed)) return true;
  return Date.now() - observed > ttlHours * 3600 * 1000;
}

class ReserveShortfallError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ReserveShortfallError';
    this.status = 409;
    this.code = 'RESERVE_SHORTFALL';
    this.detail = detail;
  }
}

class ReserveEngine {
  static config() {
    return {
      enforcement: (() => {
        const mode = String(process.env.RESERVE_ENFORCEMENT || 'strict').toLowerCase();
        return ENFORCEMENT_MODES.includes(mode) ? mode : 'strict';
      })(),
      liveTtlHours: hours(process.env.RESERVE_LIVE_TTL_HOURS, 6),
      statementTtlHours: hours(process.env.RESERVE_STATEMENT_TTL_HOURS, 24 * 35),
      externalOrigins: list(process.env.RESERVE_EXTERNAL_ORIGINS, DEFAULT_EXTERNAL_ORIGINS),
      walletAddress: process.env.DAPP_OPERATOR_ADDRESS || '',
      circleEnabled: String(process.env.CIRCLE_ENABLED || '').toLowerCase() === 'true'
        && Boolean(process.env.CIRCLE_MINT_API_KEY),
      maxTraceDepth: Number(process.env.RESERVE_TRACE_DEPTH || 12),
      trustIssuers: list(process.env.RESERVE_TRUST_ISSUER_NAMES, DEFAULT_TRUST_ISSUERS),
      collateralHaircutBps: (() => {
        const n = Number(process.env.RESERVE_COLLATERAL_HAIRCUT_BPS);
        return Number.isFinite(n) && n >= 0 && n <= 10000 ? Math.round(n) : 2000;
      })(),
    };
  }

  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reserve_attestations (
        attestation_id      TEXT PRIMARY KEY,
        source_type         TEXT NOT NULL,
        source_key          TEXT NOT NULL,
        asset               TEXT NOT NULL DEFAULT 'USD',
        balance_cents       BIGINT NOT NULL DEFAULT 0,
        verification        TEXT NOT NULL DEFAULT 'unverified'
                            CHECK (verification IN ('live','statement','unverified')),
        unverified_reason   TEXT,
        evidence_reference  TEXT,
        attested_by         TEXT,
        detail              JSONB NOT NULL DEFAULT '{}',
        observed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Attestations predating the fixed income layer are all cash custody reads.
    await pool.query(
      `ALTER TABLE reserve_attestations
         ADD COLUMN IF NOT EXISTS asset_class TEXT NOT NULL DEFAULT 'cash'`
    );
    await pool.query(
      `ALTER TABLE reserve_attestations
         ADD COLUMN IF NOT EXISTS haircut_bps INTEGER NOT NULL DEFAULT 0`
    );
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_reserve_attestations_source
        ON reserve_attestations (source_type, source_key, observed_at DESC)
    `);
    return true;
  }

  static async record(attestation = {}) {
    const sourceType = String(attestation.sourceType || '').toLowerCase();
    if (!SOURCE_TYPES.includes(sourceType)) {
      throw new Error(`Unsupported reserve source type: ${attestation.sourceType}`);
    }
    const sourceKey = String(attestation.sourceKey || '').trim();
    if (!sourceKey) throw new Error('A reserve attestation requires a source key');

    const verification = String(attestation.verification || 'unverified').toLowerCase();
    if (!VERIFICATIONS.includes(verification)) {
      throw new Error(`Unsupported verification: ${attestation.verification}`);
    }

    const balanceCents = cents(attestation.balanceCents);
    if (balanceCents < 0) throw new Error('A reserve balance cannot be negative');

    const assetClass = String(
      attestation.assetClass
        || (FIXED_INCOME_SOURCE_TYPES.includes(sourceType) ? 'fixed_income' : 'cash')
    ).toLowerCase();
    if (!ASSET_CLASSES.includes(assetClass)) {
      throw new Error(`Unsupported asset class: ${attestation.assetClass}`);
    }
    if (assetClass === 'cash' && FIXED_INCOME_SOURCE_TYPES.includes(sourceType)) {
      throw new Error('A securities custodian holds fixed income, not spendable cash');
    }

    const cfg = this.config();
    const haircutBps = assetClass === 'fixed_income'
      ? (() => {
        const n = Number(attestation.haircutBps);
        if (!Number.isFinite(n)) return cfg.collateralHaircutBps;
        if (n < 0 || n > 10000) throw new Error('haircutBps must be between 0 and 10000');
        return Math.round(n);
      })()
      : 0;

    // A statement attestation is somebody asserting a custodian holds funds, so
    // it only counts as a reserve when the evidence and the attester are named.
    if (verification === 'statement') {
      if (!String(attestation.evidenceReference || '').trim()) {
        throw new Error('A statement attestation requires an evidence reference (statement id or document)');
      }
      if (!String(attestation.attestedBy || '').trim()) {
        throw new Error('A statement attestation requires the attesting trustee or officer');
      }
    }
    if (verification === 'unverified' && balanceCents !== 0) {
      throw new Error('An unverified source cannot report a reserve balance');
    }

    await this.ensureTables();
    const attestationId = id('RSV');
    const rows = await pool.query(
      `INSERT INTO reserve_attestations
         (attestation_id, source_type, source_key, asset, balance_cents, verification,
          unverified_reason, evidence_reference, attested_by, detail, asset_class,
          haircut_bps, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
       RETURNING *`,
      [
        attestationId,
        sourceType,
        sourceKey,
        String(attestation.asset || 'USD').toUpperCase(),
        balanceCents,
        verification,
        attestation.unverifiedReason || null,
        attestation.evidenceReference || null,
        attestation.attestedBy || null,
        JSON.stringify(attestation.detail || {}),
        assetClass,
        haircutBps,
      ]
    );
    return rows.rows[0];
  }

  /** Latest attestation per source, newest first. */
  static async latestAttestations() {
    await this.ensureTables();
    const rows = await pool.query(
      `SELECT DISTINCT ON (source_type, source_key) *
         FROM reserve_attestations
        ORDER BY source_type, source_key, observed_at DESC`
    );
    const cfg = this.config();
    return rows.rows.map((row) => {
      const ttl = row.verification === 'statement' ? cfg.statementTtlHours : cfg.liveTtlHours;
      const stale = row.verification === 'unverified' ? false : isStale(row.observed_at, ttl);
      const balanceCents = cents(row.balance_cents);
      const assetClass = row.asset_class || 'cash';
      const haircutBps = Number(row.haircut_bps || 0);
      const valid = row.verification !== 'unverified' && !stale && balanceCents > 0;
      return {
        ...row,
        asset_class: assetClass,
        haircut_bps: haircutBps,
        balance_cents: balanceCents,
        balance: dollars(balanceCents),
        stale,
        // Only cash counts toward the reserve a rail may draw on; fixed income
        // is carried as collateral net of its haircut.
        counted: valid && assetClass === 'cash',
        collateralCents: valid && assetClass === 'fixed_income'
          ? Math.round(balanceCents * (10000 - haircutBps) / 10000)
          : 0,
      };
    });
  }

  // ── Live verification ──────────────────────────────────────────────────────

  static async _verifyOnchainWallet() {
    const cfg = this.config();
    if (!cfg.walletAddress) {
      return {
        sourceType: 'onchain_wallet',
        sourceKey: 'operator',
        verification: 'unverified',
        balanceCents: 0,
        unverifiedReason: 'DAPP_OPERATOR_ADDRESS is not configured',
      };
    }
    if (!Web3Engine) {
      return {
        sourceType: 'onchain_wallet',
        sourceKey: cfg.walletAddress,
        verification: 'unverified',
        balanceCents: 0,
        unverifiedReason: 'Web3Engine unavailable',
      };
    }
    try {
      const balances = await Web3Engine.getBalances({ address: cfg.walletAddress });
      // Only USDC counts as a USD reserve: it is redeemable 1:1 at its issuer.
      // Native ETH is a volatile asset and is reported, not counted.
      const usdcCents = cents(Number(balances.usdc && balances.usdc.formatted) * 100);
      return {
        sourceType: 'onchain_wallet',
        sourceKey: String(balances.address || cfg.walletAddress),
        asset: 'USDC',
        verification: 'live',
        balanceCents: usdcCents,
        detail: {
          chainId: balances.chain,
          native: balances.native,
          usdc: balances.usdc && balances.usdc.formatted,
          note: 'USDC counted 1:1 as USD; native balance excluded from reserves.',
        },
      };
    } catch (e) {
      return {
        sourceType: 'onchain_wallet',
        sourceKey: cfg.walletAddress,
        verification: 'unverified',
        balanceCents: 0,
        unverifiedReason: `On-chain balance read failed: ${e.message}`,
      };
    }
  }

  static async _verifyCircle() {
    const cfg = this.config();
    if (!cfg.circleEnabled || !CircleMintClient) {
      return {
        sourceType: 'circle_custody',
        sourceKey: 'circle-mint-business-account',
        verification: 'unverified',
        balanceCents: 0,
        unverifiedReason: !CircleMintClient
          ? 'Circle Mint client unavailable'
          : 'CIRCLE_ENABLED / CIRCLE_MINT_API_KEY not configured',
      };
    }
    try {
      const client = new CircleMintClient();
      const response = await client.getBalances();
      const available = ((response && response.data && response.data.available) || [])
        .filter((b) => String(b.currency || '').toUpperCase() === 'USD');
      const balanceCents = available.reduce((sum, b) => sum + cents(Number(b.amount) * 100), 0);
      return {
        sourceType: 'circle_custody',
        sourceKey: 'circle-mint-business-account',
        verification: 'live',
        balanceCents,
        detail: { currencies: available.map((b) => b.currency) },
      };
    } catch (e) {
      return {
        sourceType: 'circle_custody',
        sourceKey: 'circle-mint-business-account',
        verification: 'unverified',
        balanceCents: 0,
        unverifiedReason: `Circle balance read failed: ${e.message}`,
      };
    }
  }

  static _verifyPartnerBank() {
    const status = PartnerBankRails ? PartnerBankRails.status() : null;
    if (!status || !status.ready) {
      return {
        sourceType: 'partner_bank',
        sourceKey: (status && status.accountLabel) || 'partner-bank',
        verification: 'unverified',
        balanceCents: 0,
        unverifiedReason: status
          ? `Partner bank rail not configured (missing ${(status.missingConfiguration || []).join(', ')})`
          : 'Partner bank rail unavailable',
      };
    }
    // The adapter originates payments; none of the supported providers expose a
    // balance read here, so the depository balance has to be attested from a
    // statement rather than inferred.
    return {
      sourceType: 'partner_bank',
      sourceKey: status.accountLabel || status.provider || 'partner-bank',
      verification: 'unverified',
      balanceCents: 0,
      unverifiedReason: 'Partner bank balance API is not integrated; record a statement attestation',
    };
  }

  /** Read every custody source we can and persist the result. */
  static async verifyLive() {
    const results = [];
    const wallet = await this._verifyOnchainWallet();
    results.push(wallet);
    const circle = await this._verifyCircle();
    results.push(circle);
    results.push(this._verifyPartnerBank());

    const recorded = [];
    for (const result of results) {
      try {
        recorded.push(await this.record(result));
      } catch (e) {
        recorded.push({ ...result, error: e.message });
      }
    }
    return { verified: recorded.length, sources: recorded };
  }

  // ── Fixed income portfolio ─────────────────────────────────────────────────

  static _isSelfIssued(issuer, trustIssuers) {
    const name = String(issuer || '').trim().toLowerCase();
    if (!name) return true; // an unnamed issuer is not an established third party
    return trustIssuers.some((trust) => name.includes(trust) || trust.includes(name));
  }

  /**
   * Read the bond portfolio and say what each position actually backs.
   *
   * A position is only collateral when a third party issued it and a securities
   * custodian has attested to holding it. A bond the trust issued to itself is
   * reported at its carrying value with an eligible value of zero: the trust is
   * both obligor and holder, so the instrument nets to nothing outside the books.
   */
  static async portfolio() {
    const cfg = this.config();
    const attestations = await this.latestAttestations();
    const custody = new Map();
    for (const a of attestations) {
      if (a.asset_class === 'fixed_income') custody.set(String(a.source_key).toLowerCase(), a);
    }

    const rows = await pool.query(
      `SELECT b.id, b.bond_name, b.isin, b.bond_identifier, b.issuer, b.placement_type,
              b.face_value, b.coupon_rate, b.maturity_date, b.status,
              bb.principal_balance, bb.accrued_interest
         FROM bonds b
         LEFT JOIN bond_balances bb ON bb.bond_id = b.id
        WHERE b.status = 'active'
        ORDER BY b.id ASC`
    );

    const positions = rows.rows.map((row) => {
      const carryingCents = cents(Number(row.principal_balance || row.face_value || 0) * 100)
        + cents(Number(row.accrued_interest || 0) * 100);
      const selfIssued = this._isSelfIssued(row.issuer, cfg.trustIssuers);
      const keys = [row.isin, row.bond_identifier, row.bond_name]
        .filter(Boolean)
        .map((k) => String(k).toLowerCase());
      const attested = keys.map((k) => custody.get(k)).find(Boolean) || null;

      let custodyStatus = 'unattested';
      let eligibleCents = 0;
      let note = 'No securities custodian has attested to holding this position.';

      if (selfIssued) {
        custodyStatus = 'self_issued_self_held';
        note = 'Issued and held by the trust: asset and liability in the same instrument,'
          + ' so it backs no external obligation.';
      } else if (attested && attested.collateralCents > 0) {
        custodyStatus = 'custodian_attested';
        eligibleCents = Math.min(attested.collateralCents, carryingCents || attested.collateralCents);
        note = `Held at ${attested.source_key} per ${attested.evidence_reference || 'statement'};`
          + ` collateral value net of a ${attested.haircut_bps} bps haircut.`;
      } else if (attested) {
        custodyStatus = attested.stale ? 'attestation_stale' : 'attested_zero';
        note = attested.stale
          ? 'The custodian attestation has expired; re-attest to carry it as collateral.'
          : 'The custodian attestation reports no holdable value.';
      }

      return {
        bondId: row.id,
        bondName: row.bond_name,
        isin: row.isin,
        bondIdentifier: row.bond_identifier,
        issuer: row.issuer,
        placementType: row.placement_type,
        couponRate: Number(row.coupon_rate || 0),
        maturityDate: row.maturity_date,
        carryingValueCents: carryingCents,
        carryingValue: dollars(carryingCents),
        selfIssued,
        custodyStatus,
        eligibleCollateralCents: eligibleCents,
        eligibleCollateral: dollars(eligibleCents),
        note,
      };
    });

    const carryingCents = positions.reduce((s, p) => s + p.carryingValueCents, 0);
    const eligibleCents = positions.reduce((s, p) => s + p.eligibleCollateralCents, 0);
    const selfIssuedCents = positions
      .filter((p) => p.selfIssued)
      .reduce((s, p) => s + p.carryingValueCents, 0);

    return {
      positions,
      carryingValueCents: carryingCents,
      carryingValue: dollars(carryingCents),
      selfIssuedCents,
      selfIssued: dollars(selfIssuedCents),
      eligibleCollateralCents: eligibleCents,
      eligibleCollateral: dollars(eligibleCents),
      defaultHaircutBps: cfg.collateralHaircutBps,
      note: eligibleCents > 0
        ? 'Eligible collateral can be pledged or sold; it becomes spendable reserve only'
          + ' once the proceeds arrive as an external deposit.'
        : 'No position is eligible collateral, so the portfolio backs no external payment.',
    };
  }

  // ── Coverage ───────────────────────────────────────────────────────────────

  static async ledgerCashCents() {
    const rows = await pool.query(
      `SELECT COALESCE(SUM(balance_cents), 0) AS total
         FROM cash_accounts
        WHERE status = 'active'`
    );
    return cents(rows.rows[0] && rows.rows[0].total);
  }

  static async coverage() {
    const attestations = await this.latestAttestations();
    const ledger = await this.ledgerCashCents();
    const portfolio = await this.portfolio().catch(() => null);
    const reserveCents = attestations
      .filter((a) => a.counted)
      .reduce((sum, a) => sum + a.balance_cents, 0);
    const collateralCents = portfolio
      ? portfolio.eligibleCollateralCents
      : attestations.reduce((sum, a) => sum + a.collateralCents, 0);
    const unbackedCents = Math.max(0, ledger - reserveCents);
    const ratioBps = ledger > 0 ? Math.round((reserveCents / ledger) * 10000) : 10000;

    let status = 'unbacked';
    if (reserveCents >= ledger) status = 'fully_backed';
    else if (reserveCents > 0) status = 'partially_backed';

    return {
      status,
      ledgerCashCents: ledger,
      ledgerCash: dollars(ledger),
      attestedReserveCents: reserveCents,
      attestedReserve: dollars(reserveCents),
      unbackedCents,
      unbacked: dollars(unbackedCents),
      reserveRatioBps: ratioBps,
      spendableCents: reserveCents,
      spendable: dollars(reserveCents),
      // Fixed income is reported alongside cash but is deliberately excluded
      // from spendable: a bond has to be sold or pledged before it pays anyone.
      pledgeableCollateralCents: collateralCents,
      pledgeableCollateral: dollars(collateralCents),
      totalBackingCents: reserveCents + collateralCents,
      totalBacking: dollars(reserveCents + collateralCents),
      fixedIncome: portfolio && {
        carryingValue: portfolio.carryingValue,
        selfIssued: portfolio.selfIssued,
        eligibleCollateral: portfolio.eligibleCollateral,
        positions: portfolio.positions.length,
      },
      sources: attestations.map((a) => ({
        sourceType: a.source_type,
        sourceKey: a.source_key,
        asset: a.asset,
        assetClass: a.asset_class,
        haircutBps: a.haircut_bps,
        balance: a.balance,
        verification: a.verification,
        unverifiedReason: a.unverified_reason,
        observedAt: a.observed_at,
        stale: a.stale,
        counted: a.counted,
      })),
      note: reserveCents >= ledger
        ? 'Ledger cash is covered by attested external reserves.'
        : 'Ledger cash exceeds attested external reserves; the difference was created by internal postings and cannot be transmitted.',
    };
  }

  // ── Provenance ─────────────────────────────────────────────────────────────

  static _isExternalOrigin(movement, externalOrigins) {
    const refType = String(movement.reference_type || '').toLowerCase();
    return Boolean(refType) && externalOrigins.includes(refType);
  }

  /**
   * Walk cash_movements backwards from an account and classify where its
   * balance came from. A deposit with an external reference type is real value
   * arriving; a transfer from an account that itself never received anything is
   * an internally created balance.
   */
  static async provenance(accountId) {
    const cfg = this.config();
    const account = await pool.query(
      'SELECT * FROM cash_accounts WHERE account_id = $1',
      [accountId]
    );
    if (!account.rows.length) throw new Error(`Cash account ${accountId} not found`);

    let externalCents = 0;
    let internalCents = 0;
    const origins = [];
    const visited = new Set();
    const queue = [{ accountId, depth: 0 }];

    while (queue.length) {
      const current = queue.shift();
      if (visited.has(current.accountId)) continue;
      visited.add(current.accountId);

      const inbound = await pool.query(
        `SELECT * FROM cash_movements
          WHERE to_account_id = $1
          ORDER BY created_at ASC`,
        [current.accountId]
      );

      if (!inbound.rows.length && current.depth > 0) {
        origins.push({
          accountId: current.accountId,
          funding: 'never_funded',
          note: 'This account paid out value it never received.',
        });
      }

      for (const movement of inbound.rows) {
        const amount = cents(movement.amount_cents);
        const origin = {
          accountId: current.accountId,
          movementId: movement.movement_id,
          referenceType: movement.reference_type || null,
          memo: movement.memo || null,
          amount: dollars(amount),
        };

        // Value arriving from outside counts anywhere in the chain: it is what
        // funded the account being traced, however many hops away. Internal
        // amounts only describe the traced account's own inbound movements.
        if (this._isExternalOrigin(movement, cfg.externalOrigins)) {
          externalCents += amount;
          origins.push({ ...origin, funding: 'external_deposit' });
          continue;
        }
        if (current.depth === 0) internalCents += amount;
        if (movement.from_account_id) {
          if (current.depth < cfg.maxTraceDepth) {
            queue.push({ accountId: movement.from_account_id, depth: current.depth + 1 });
          }
          origins.push({ ...origin, funding: 'internal_transfer', fromAccountId: movement.from_account_id });
          continue;
        }
        origins.push({ ...origin, funding: 'internal_posting' });
      }
    }

    const balanceCents = cents(account.rows[0].balance_cents);
    let classification = 'empty';
    if (balanceCents !== 0 || externalCents || internalCents) {
      if (externalCents && internalCents) classification = 'mixed';
      else if (externalCents) classification = 'externally_backed';
      else classification = 'internally_originated';
    }

    return {
      accountId,
      accountName: account.rows[0].account_name,
      balance: dollars(balanceCents),
      balanceCents,
      classification,
      externalDepositCents: externalCents,
      externalDeposits: dollars(externalCents),
      internalOriginCents: internalCents,
      internalOrigin: dollars(internalCents),
      tracedAccounts: Array.from(visited),
      origins,
      note: classification === 'externally_backed'
        ? 'Traced to value that arrived from outside the ledger.'
        : 'No external deposit was found in this account\'s funding chain.',
    };
  }

  // ── Enforcement ────────────────────────────────────────────────────────────

  /**
   * Called by external rails before origination. In `strict` mode an amount
   * larger than the attested external reserve throws instead of being sent to a
   * provider that would decline it or, worse, be recorded as settled.
   */
  static async assertSpendable({ amountCents, rail = 'external', accountId = null } = {}) {
    const cfg = this.config();
    const amount = cents(amountCents);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error('assertSpendable requires a positive integer amountCents');
    }
    if (cfg.enforcement === 'off') {
      return { allowed: true, enforcement: 'off', reason: 'Reserve enforcement disabled' };
    }

    // Zero attestations means the reserve layer has never been run, which is not
    // the same as knowing the reserve is empty. Enforcement stays advisory until
    // at least one custody source has been observed.
    const attestations = await this.latestAttestations().catch(() => []);
    if (!attestations.length) {
      return {
        allowed: true,
        enforcement: 'uninitialized',
        warning: 'No reserve attestation has been recorded; run reserve verification'
          + ' before relying on reserve enforcement.',
      };
    }

    const cover = await this.coverage();
    const provenanceResult = accountId ? await this.provenance(accountId).catch(() => null) : null;
    const withinReserve = amount <= cover.attestedReserveCents;

    const decision = {
      allowed: withinReserve,
      enforcement: cfg.enforcement,
      rail,
      amount: dollars(amount),
      attestedReserve: cover.attestedReserve,
      pledgeableCollateral: cover.pledgeableCollateral,
      shortfall: dollars(Math.max(0, amount - cover.attestedReserveCents)),
      coverageStatus: cover.status,
      provenance: provenanceResult ? provenanceResult.classification : null,
    };

    if (withinReserve) return decision;

    const message = `Reserve shortfall: ${rail} origination of $${decision.amount} exceeds the`
      + ` $${cover.attestedReserve} held at an external custodian for the trust.`
      + ' Canonical balances created by internal postings are not transmittable.'
      + (cover.pledgeableCollateralCents > 0
        ? ` $${cover.pledgeableCollateral} of fixed income is eligible collateral, which`
          + ' has to be pledged or sold before it can fund this payment.'
        : '');

    if (cfg.enforcement === 'strict') {
      throw new ReserveShortfallError(message, decision);
    }
    return { ...decision, allowed: true, warning: message };
  }

  static async status() {
    const cfg = this.config();
    const coverage = await this.coverage().catch((e) => ({ error: e.message }));
    return {
      enforcement: cfg.enforcement,
      liveTtlHours: cfg.liveTtlHours,
      statementTtlHours: cfg.statementTtlHours,
      externalOrigins: cfg.externalOrigins,
      walletConfigured: Boolean(cfg.walletAddress),
      circleConfigured: cfg.circleEnabled,
      partnerBankConfigured: PartnerBankRails ? PartnerBankRails.isConfigured() : false,
      collateralHaircutBps: cfg.collateralHaircutBps,
      trustIssuers: cfg.trustIssuers,
      coverage,
    };
  }
}

module.exports = {
  ReserveEngine,
  ReserveShortfallError,
  SOURCE_TYPES,
  ASSET_CLASSES,
  DEFAULT_EXTERNAL_ORIGINS,
  DEFAULT_TRUST_ISSUERS,
};
