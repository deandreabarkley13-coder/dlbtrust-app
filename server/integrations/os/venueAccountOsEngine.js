'use strict';

/**
 * Venue Account OS — the trust's accounts at other people's institutions.
 *
 * Every rail in this system ends at somebody else's balance sheet: an exchange
 * that converts dollars into XLM, Circle for USD↔USDC, a partner bank that
 * originates a Fedwire, a depository the aggregator can read. The code for all
 * of them exists and none of them work, always for the same reason — there is
 * no account, or the account has no money in it. That fact was scattered across
 * six engines as "not configured", which reads like a bug and is actually a
 * business state: an application not filed, an approval not granted, a deposit
 * not made.
 *
 * This engine makes that state a first-class record. A venue account has:
 *
 *   an onboarding lifecycle   prospective → applied → under_review → approved
 *                             → funded, and suspended/closed. Approval is a
 *                             second trustee's act with an evidence reference,
 *                             because "the venue approved us" is a claim about
 *                             the outside world.
 *   declared capabilities     what the venue can do for the trust (hold USD,
 *                             buy XLM, withdraw over Stellar, wire out).
 *   credential state          which environment keys the adapter needs, and
 *                             whether each is present. Never the values.
 *   a probed balance          read from the venue where an adapter exists, and
 *                             persisted as a custody attestation through
 *                             ReserveEngine — so what a venue holds is reserve
 *                             evidence, not a note in a table.
 *
 * The question it answers, which nothing could answer before: *which venue can
 * do X today, and if none, what precisely is missing.* `forCapability('buy_xlm')`
 * returns either a usable account or a refusal naming the step — an application
 * to file, a key to set, or dollars to deposit.
 *
 * Two things it deliberately refuses to do:
 *
 *   • It will not mark an account funded on somebody's word. Funding is either
 *     a live probe that read a positive balance, or a statement attestation
 *     with an evidence reference and a named attester — the same standard the
 *     reserve engine holds every other custody balance to.
 *   • It will not report a capability as available because the credentials are
 *     set. An API key is permission to trade, not dollars to trade with.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');
const { ReserveEngine } = require('../finops/reserveEngine');

let coinbaseApi;
try { coinbaseApi = require('coinbase-api'); } catch (e) { coinbaseApi = null; }

let CircleMintClient;
try { ({ CircleMintClient } = require('../stablecoin/circleMintClient')); } catch (e) { CircleMintClient = null; }

let PartnerBankRails;
try { ({ PartnerBankRails } = require('../rails/partnerBankRails')); } catch (e) { PartnerBankRails = null; }

/** What a venue account can do for the trust. Declared per provider, not per row. */
const CAPABILITIES = [
  'hold_usd',
  'buy_xlm',
  'buy_usdc',
  'withdraw_stellar',
  'wire_out',
  'ach_out',
  'ach_in',
  'read_balance',
];

/** Where an account is in its onboarding, which is the real blocker most days. */
const STATUSES = ['prospective', 'applied', 'under_review', 'approved', 'funded', 'suspended', 'closed'];

/** Only these can be used by a rail; the rest are applications in progress. */
const USABLE_STATUSES = ['approved', 'funded'];

/**
 * The providers the repo has an adapter for, with the environment keys that
 * adapter needs and how dollars physically arrive. `reserveSourceType` maps a
 * venue onto the reserve engine's vocabulary so a probed balance lands in the
 * one attestation store rather than a second one.
 */
const PROVIDERS = {
  coinbase: {
    kind: 'exchange',
    name: 'Coinbase',
    capabilities: ['hold_usd', 'buy_xlm', 'buy_usdc', 'withdraw_stellar', 'read_balance'],
    credentials: ['COINBASE_CDP_KEY_NAME', 'COINBASE_CDP_PRIVATE_KEY'],
    dependency: 'coinbase-api',
    funding: 'ACH deposit from the trust bank account, initiated at Coinbase',
    reserveSourceType: 'depository_account',
  },
  circle_mint: {
    kind: 'stablecoin_issuer',
    name: 'Circle Mint',
    capabilities: ['hold_usd', 'buy_usdc', 'withdraw_stellar', 'read_balance'],
    credentials: ['CIRCLE_MINT_API_KEY', 'CIRCLE_MINT_WIRE_BANK_ACCOUNT_ID'],
    funding: 'Wire from the trust bank account to the Circle instructions',
    reserveSourceType: 'circle_custody',
  },
  column: {
    kind: 'partner_bank',
    name: 'Column',
    capabilities: ['hold_usd', 'wire_out', 'ach_out', 'ach_in'],
    credentials: ['PARTNER_BANK_PROVIDER', 'PARTNER_BANK_API_KEY', 'PARTNER_BANK_ACCOUNT_ID'],
    funding: 'Transfer from the trust bank account',
    reserveSourceType: 'partner_bank',
  },
  increase: {
    kind: 'partner_bank',
    name: 'Increase',
    capabilities: ['hold_usd', 'wire_out', 'ach_out', 'ach_in'],
    credentials: ['PARTNER_BANK_PROVIDER', 'PARTNER_BANK_API_KEY', 'PARTNER_BANK_ACCOUNT_ID'],
    funding: 'Transfer from the trust bank account',
    reserveSourceType: 'partner_bank',
  },
  moonpay: {
    kind: 'onramp',
    name: 'MoonPay',
    capabilities: ['buy_usdc'],
    credentials: ['MOONPAY_PUBLISHABLE_KEY', 'MOONPAY_SECRET_KEY'],
    funding: 'The buyer pays the checkout with a card or bank transfer; MoonPay holds no trust balance',
    reserveSourceType: null,
  },
  depository: {
    kind: 'depository',
    name: 'Bank account (read-only)',
    capabilities: ['hold_usd', 'ach_in'],
    credentials: [],
    funding: 'The trust\'s own bank; balances are read through the aggregator',
    reserveSourceType: 'depository_account',
  },
};

class VenueAccountError extends Error {
  constructor(message, code = 'VENUE_ACCOUNT_ERROR', status = 409) {
    super(message);
    this.name = 'VenueAccountError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function cents(value) {
  return Math.round(Number(value || 0));
}

function newId(provider) {
  const slug = String(provider || 'venue').toUpperCase().replace(/[^A-Z0-9]+/g, '');
  return `VENUE-${slug}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

/** Which of a provider's required keys are present. Presence only — never values. */
function credentialState(provider) {
  const spec = PROVIDERS[provider];
  if (!spec) return { required: [], missing: [], satisfied: false };
  const missing = spec.credentials.filter(name => !String(process.env[name] || '').trim());
  return { required: spec.credentials, missing, satisfied: missing.length === 0 };
}

const VenueAccountOsEngine = {
  VenueAccountError,
  CAPABILITIES,
  STATUSES,
  PROVIDERS,

  config() {
    const n = Number(process.env.VENUE_BALANCE_FRESH_MINUTES);
    return { freshMinutes: Number.isFinite(n) && n > 0 ? n : 24 * 60 };
  },

  async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS venue_accounts (
        venue_id            TEXT PRIMARY KEY,
        provider            TEXT NOT NULL,
        kind                TEXT NOT NULL,
        label               TEXT NOT NULL,
        status              TEXT NOT NULL,
        external_reference  TEXT,
        registered_by       TEXT NOT NULL,
        approved_by         TEXT,
        evidence_reference  TEXT,
        last_balance_cents  BIGINT,
        last_verification   TEXT,
        last_probe_reason   TEXT,
        last_probed_at      TIMESTAMPTZ,
        suspended_reason    TEXT,
        metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        applied_at          TIMESTAMPTZ,
        approved_at         TIMESTAMPTZ,
        funded_at           TIMESTAMPTZ
      )
    `);
    await pool.query(
      'CREATE INDEX IF NOT EXISTS idx_venue_accounts_status ON venue_accounts (status)'
    );
    return true;
  },

  // ── The register ───────────────────────────────────────────────────────────

  /**
   * Open the file on an account the trust intends to hold somewhere. This is a
   * record of intent, not access: it starts `prospective` and can do nothing.
   */
  async register({ provider, label = null, externalReference = null, registeredBy, metadata = {} } = {}) {
    await this.ensureTables();
    const key = String(provider || '').toLowerCase().trim();
    const spec = PROVIDERS[key];
    if (!spec) {
      throw new VenueAccountError(
        `${provider || 'that provider'} has no adapter here; supported: ${Object.keys(PROVIDERS).join(', ')}`,
        'VENUE_ACCOUNT_UNKNOWN_PROVIDER', 400
      );
    }
    const opener = String(registeredBy || '').trim();
    if (!opener) {
      throw new VenueAccountError('registeredBy is required', 'VENUE_ACCOUNT_NO_REGISTRAR', 400);
    }
    const venueId = newId(key);
    const inserted = await pool.query(
      `INSERT INTO venue_accounts
         (venue_id, provider, kind, label, status, external_reference, registered_by, metadata)
       VALUES ($1, $2, $3, $4, 'prospective', $5, $6, $7)
       RETURNING *`,
      [venueId, key, spec.kind, label || spec.name, externalReference, opener, JSON.stringify(metadata || {})]
    );
    return inserted.rows[0];
  },

  /** The application has been filed with the venue. */
  async recordApplication(venueId, { reference, filedBy = null } = {}) {
    const row = await this._require(venueId);
    if (!['prospective', 'applied', 'under_review'].includes(row.status)) {
      throw new VenueAccountError(
        `${row.venue_id} is ${row.status}; an application belongs to an account that is not yet open`,
        'VENUE_ACCOUNT_WRONG_STATE'
      );
    }
    const applicationReference = String(reference || '').trim();
    if (!applicationReference) {
      throw new VenueAccountError(
        'An application reference is required: the venue\'s own case or application id',
        'VENUE_ACCOUNT_NO_REFERENCE', 400
      );
    }
    return this._update(venueId, {
      status: 'under_review',
      applied_at: 'NOW()',
      metadata: { ...(row.metadata || {}), applicationReference, filedBy },
    });
  },

  /**
   * The venue approved the account. A second trustee records it, and names the
   * evidence — an approval email, a signed agreement, the account id — because
   * this asserts something about an institution the code cannot see.
   */
  async recordApproval(venueId, { approvedBy, evidenceReference, externalReference = null } = {}) {
    const row = await this._require(venueId);
    if (row.status === 'closed') {
      throw new VenueAccountError(`${row.venue_id} is closed`, 'VENUE_ACCOUNT_WRONG_STATE');
    }
    const checker = String(approvedBy || '').trim();
    if (!checker) {
      throw new VenueAccountError('approvedBy is required', 'VENUE_ACCOUNT_NO_CHECKER', 400);
    }
    if (checker.toLowerCase() === String(row.registered_by).toLowerCase()) {
      throw new VenueAccountError(
        'The trustee who registered a venue account cannot also record its approval',
        'VENUE_ACCOUNT_SAME_TRUSTEE'
      );
    }
    const evidence = String(evidenceReference || '').trim();
    if (!evidence) {
      throw new VenueAccountError(
        'An evidence reference is required: what shows the venue approved this account',
        'VENUE_ACCOUNT_NO_EVIDENCE', 400
      );
    }
    return this._update(venueId, {
      status: 'approved',
      approved_by: checker,
      evidence_reference: evidence,
      approved_at: 'NOW()',
      ...(externalReference ? { external_reference: externalReference } : {}),
    });
  },

  async suspend(venueId, { reason, suspendedBy = null } = {}) {
    const row = await this._require(venueId);
    const why = String(reason || '').trim();
    if (!why) throw new VenueAccountError('A suspension reason is required', 'VENUE_ACCOUNT_NO_REASON', 400);
    return this._update(venueId, {
      status: 'suspended',
      suspended_reason: why,
      metadata: { ...(row.metadata || {}), suspendedBy },
    });
  },

  async reinstate(venueId, { reinstatedBy = null } = {}) {
    const row = await this._require(venueId);
    if (row.status !== 'suspended') {
      throw new VenueAccountError(`${row.venue_id} is ${row.status}, not suspended`, 'VENUE_ACCOUNT_WRONG_STATE');
    }
    return this._update(venueId, {
      status: 'approved',
      suspended_reason: null,
      metadata: { ...(row.metadata || {}), reinstatedBy },
    });
  },

  async close(venueId, { reason = null, closedBy = null } = {}) {
    const row = await this._require(venueId);
    return this._update(venueId, {
      status: 'closed',
      suspended_reason: reason,
      metadata: { ...(row.metadata || {}), closedBy },
    });
  },

  /**
   * Attest that the venue holds funds without an adapter to read them — a
   * screenshot of the balance, a statement, a confirmation email. Held to the
   * reserve engine's statement standard: evidence and an attester, or nothing.
   */
  async attestBalance(venueId, { balanceCents, evidenceReference, attestedBy, asset = 'USD' } = {}) {
    const row = await this._require(venueId);
    const amount = cents(balanceCents);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new VenueAccountError('balanceCents must be zero or more', 'VENUE_ACCOUNT_BAD_AMOUNT', 400);
    }
    const evidence = String(evidenceReference || '').trim();
    const attester = String(attestedBy || '').trim();
    if (!evidence || !attester) {
      throw new VenueAccountError(
        'A balance nobody\'s API confirmed needs both an evidence reference and the attesting trustee',
        'VENUE_ACCOUNT_NO_EVIDENCE', 400
      );
    }
    await this._recordReserve(row, {
      balanceCents: amount,
      asset,
      verification: 'statement',
      evidenceReference: evidence,
      attestedBy: attester,
    });
    return this._update(row.venue_id, {
      last_balance_cents: amount,
      last_verification: 'statement',
      last_probe_reason: null,
      last_probed_at: 'NOW()',
      evidence_reference: evidence,
      ...(amount > 0 && USABLE_STATUSES.includes(row.status)
        ? { status: 'funded', funded_at: 'NOW()' }
        : {}),
    });
  },

  // ── Reading what a venue actually holds ────────────────────────────────────

  /**
   * Ask the venue what it holds. An adapter that cannot read returns the reason
   * it could not — never a zero standing in for an unknown, because a rail that
   * treats "unknown" as "empty" refuses valid payments and one that treats it
   * as "funded" sends invalid ones.
   */
  async probe(venueId) {
    const row = await this._require(venueId);
    const reading = await this._read(row);
    const patch = {
      last_verification: reading.verification,
      last_probe_reason: reading.reason || null,
      last_probed_at: 'NOW()',
      last_balance_cents: reading.verification === 'live' ? reading.balanceCents : row.last_balance_cents,
    };
    if (reading.verification === 'live') {
      await this._recordReserve(row, {
        balanceCents: reading.balanceCents,
        asset: reading.asset || 'USD',
        verification: 'live',
        detail: reading.detail || {},
      });
      if (reading.balanceCents > 0 && USABLE_STATUSES.includes(row.status)) {
        patch.status = 'funded';
        patch.funded_at = 'NOW()';
      }
    }
    const updated = await this._update(row.venue_id, patch);
    return { venue: updated, reading };
  },

  /** Probe every account that is open enough to have a balance. */
  async probeAll() {
    const rows = await this.list();
    const results = [];
    for (const row of rows) {
      if (!USABLE_STATUSES.includes(row.status)) continue;
      try {
        results.push(await this.probe(row.venue_id));
      } catch (e) {
        results.push({ venue: row, reading: { verification: 'unverified', balanceCents: 0, reason: e.message } });
      }
    }
    return results;
  },

  async _read(row) {
    const spec = PROVIDERS[row.provider] || {};
    if (row.provider === 'depository') return this._readDepository(row);
    const creds = credentialState(row.provider);
    if (spec.dependency === 'coinbase-api' && !coinbaseApi) {
      return { verification: 'unverified', balanceCents: 0, reason: 'the coinbase-api dependency is not installed' };
    }
    if (!creds.satisfied) {
      return {
        verification: 'unverified',
        balanceCents: 0,
        reason: `${creds.missing.join(', ')} unset, so the venue cannot be reached`,
      };
    }
    if (row.provider === 'coinbase') return this._readCoinbase();
    if (row.provider === 'circle_mint') return this._readCircle();
    if (spec.kind === 'partner_bank') {
      const status = PartnerBankRails ? PartnerBankRails.status() : null;
      return {
        verification: 'unverified',
        balanceCents: 0,
        reason: status && status.ready
          ? 'the partner bank exposes no balance API here; attest the balance from a statement'
          : 'the partner bank rail is not configured',
      };
    }
    return {
      verification: 'unverified',
      balanceCents: 0,
      reason: `no balance adapter exists for ${row.provider}; attest the balance from a statement`,
    };
  },

  /**
   * The exchange's fiat balance, which is the number that decides whether a
   * purchase can happen at all. Non-USD wallets are reported but not counted:
   * crypto at the venue is not dollars to buy with.
   */
  async _readCoinbase() {
    try {
      const client = new coinbaseApi.CBAppClient({
        apiKey: String(process.env.COINBASE_CDP_KEY_NAME || '').trim(),
        apiSecret: String(process.env.COINBASE_CDP_PRIVATE_KEY || '').trim(),
      });
      const accounts = await client.getAccounts();
      const list = (accounts && accounts.data) || [];
      let usdCents = 0;
      const wallets = [];
      for (const account of list) {
        const currency = String(
          (account.balance && account.balance.currency)
          || (account.currency && account.currency.code)
          || account.currency
          || ''
        ).toUpperCase();
        const amount = Number((account.balance && account.balance.amount) || 0);
        if (!currency) continue;
        wallets.push({ currency, amount: String(amount) });
        if (currency === 'USD') usdCents += cents(amount * 100);
      }
      if (!wallets.length) {
        return { verification: 'unverified', balanceCents: 0, reason: 'the venue returned no wallets for these keys' };
      }
      return {
        verification: 'live',
        balanceCents: usdCents,
        asset: 'USD',
        detail: { wallets, note: 'USD wallets only; crypto held at the venue is not dollars to buy with.' },
      };
    } catch (e) {
      return { verification: 'unverified', balanceCents: 0, reason: `the venue balance read failed: ${e.message}` };
    }
  },

  /**
   * A depository is read through the banking aggregator once Venue Depository
   * OS has linked it to an aggregator account; unlinked, it can only be
   * attested from a statement.
   */
  async _readDepository(row) {
    const { VenueDepositoryOsEngine } = require('./venueDepositoryOsEngine');
    const link = await VenueDepositoryOsEngine.get(row.venue_id);
    if (!link) {
      return {
        verification: 'unverified',
        balanceCents: 0,
        reason: 'the depository is not linked to an aggregator account; link it, or attest the balance from a statement',
      };
    }
    const reading = await VenueDepositoryOsEngine.read(row.venue_id);
    return {
      verification: reading.verification,
      balanceCents: reading.balanceCents,
      asset: reading.asset || 'USD',
      reason: reading.reason || null,
      detail: {
        source: 'banking_aggregator',
        connectionId: link.connection_id,
        externalAccountId: link.external_account_id,
        glAccountCode: link.gl_account_code,
        observedAt: reading.observedAt || null,
      },
    };
  },

  async _readCircle() {
    if (!CircleMintClient) {
      return { verification: 'unverified', balanceCents: 0, reason: 'the Circle Mint client is unavailable' };
    }
    try {
      const response = await new CircleMintClient().getBalances();
      const available = ((response && response.data && response.data.available) || [])
        .filter(b => String(b.currency || '').toUpperCase() === 'USD');
      return {
        verification: 'live',
        balanceCents: available.reduce((sum, b) => sum + cents(Number(b.amount) * 100), 0),
        asset: 'USD',
        detail: { currencies: available.map(b => b.currency) },
      };
    } catch (e) {
      return { verification: 'unverified', balanceCents: 0, reason: `the Circle balance read failed: ${e.message}` };
    }
  },

  /**
   * A venue balance is custody — somebody else is holding the trust's money —
   * so it belongs in the reserve store with every other custody balance, not in
   * a register of its own. A provider with no reserve vocabulary (an on-ramp
   * holds nothing for the trust) is simply not recorded.
   */
  async _recordReserve(row, { balanceCents, asset, verification, evidenceReference = null, attestedBy = null, detail = {} }) {
    const spec = PROVIDERS[row.provider] || {};
    if (!spec.reserveSourceType) return null;
    try {
      return await ReserveEngine.record({
        sourceType: spec.reserveSourceType,
        sourceKey: row.external_reference || row.venue_id,
        asset,
        balanceCents,
        verification,
        evidenceReference,
        attestedBy,
        detail: { ...detail, venueId: row.venue_id, provider: row.provider, label: row.label },
      });
    } catch (e) {
      // A reserve store that refuses the shape must not silently swallow the
      // reading, but it also must not lose the probe: the reason is returned.
      return { error: e.message };
    }
  },

  // ── What can actually be done today ────────────────────────────────────────

  /** One account, rendered with everything that decides whether a rail may use it. */
  async describe(row) {
    const spec = PROVIDERS[row.provider] || { capabilities: [], credentials: [] };
    const creds = credentialState(row.provider);
    const { freshMinutes } = this.config();
    const probedAt = row.last_probed_at ? new Date(row.last_probed_at).getTime() : NaN;
    const ageMinutes = Number.isFinite(probedAt) ? (Date.now() - probedAt) / 60000 : Infinity;
    const balanceCents = Number(row.last_balance_cents || 0);
    const blockers = [];
    if (row.status === 'closed') blockers.push('the account is closed');
    if (row.status === 'suspended') blockers.push(`the account is suspended: ${row.suspended_reason || 'no reason recorded'}`);
    if (!USABLE_STATUSES.includes(row.status) && !['closed', 'suspended'].includes(row.status)) {
      blockers.push(`onboarding is ${row.status}: the venue has not approved this account yet`);
    }
    if (spec.dependency === 'coinbase-api' && !coinbaseApi) blockers.push('the coinbase-api dependency is not installed');
    if (creds.missing.length) blockers.push(`${creds.missing.join(', ')} unset`);
    return {
      venueId: row.venue_id,
      provider: row.provider,
      kind: row.kind,
      label: row.label,
      status: row.status,
      externalReference: row.external_reference || null,
      capabilities: spec.capabilities,
      credentials: { required: creds.required, missing: creds.missing, satisfied: creds.satisfied },
      funding: spec.funding || null,
      balance: {
        cents: balanceCents,
        verification: row.last_verification || 'unverified',
        reason: row.last_probe_reason || null,
        observedAt: row.last_probed_at || null,
        stale: ageMinutes > freshMinutes,
      },
      blockers,
      usable: blockers.length === 0,
      // Dollars at the venue, read live and recently. Everything a purchase
      // needs beyond permission to trade.
      funded: blockers.length === 0 && balanceCents > 0
        && row.last_verification === 'live' && ageMinutes <= freshMinutes,
    };
  },

  /** The whole register, described. */
  async snapshot() {
    const rows = await this.list();
    const accounts = [];
    for (const row of rows) accounts.push(await this.describe(row));
    const byCapability = {};
    for (const capability of CAPABILITIES) {
      byCapability[capability] = accounts
        .filter(a => a.capabilities.includes(capability) && a.usable)
        .map(a => a.venueId);
    }
    return {
      accounts,
      byCapability,
      providers: Object.entries(PROVIDERS).map(([id, spec]) => ({
        id, kind: spec.kind, name: spec.name, capabilities: spec.capabilities, credentials: spec.credentials,
      })),
      registered: accounts.length,
      usable: accounts.filter(a => a.usable).length,
      funded: accounts.filter(a => a.funded).length,
    };
  },

  /**
   * Which account can perform `capability` right now. Returns the account, or
   * a refusal that names the next step rather than "not configured": an
   * application to file, a key to set, or dollars to deposit.
   *
   * `needsFunds` splits the two failures that look alike from the outside — an
   * account that cannot trade, and an account with nothing to trade with.
   */
  async forCapability(capability, { requireFunds = false } = {}) {
    const wanted = String(capability || '').trim();
    if (!CAPABILITIES.includes(wanted)) {
      throw new VenueAccountError(
        `${capability} is not a venue capability; known: ${CAPABILITIES.join(', ')}`,
        'VENUE_ACCOUNT_UNKNOWN_CAPABILITY', 400
      );
    }
    const snapshot = await this.snapshot();
    const candidates = snapshot.accounts.filter(a => a.capabilities.includes(wanted));
    if (!candidates.length) {
      const providers = Object.entries(PROVIDERS)
        .filter(([, spec]) => spec.capabilities.includes(wanted))
        .map(([id]) => id);
      return {
        capability: wanted,
        account: null,
        candidates: [],
        issues: [`no venue account is registered that can ${wanted}`
          + (providers.length ? `; an account at ${providers.join(' or ')} would` : '')],
      };
    }
    const usable = candidates.filter(a => a.usable);
    const chosen = usable.find(a => a.funded) || usable[0] || null;
    const issues = [];
    if (!usable.length) {
      for (const candidate of candidates) {
        issues.push(`${candidate.label} (${candidate.venueId}): ${candidate.blockers.join('; ')}`);
      }
    } else if (requireFunds && chosen && !chosen.funded) {
      issues.push(`${chosen.label} can ${wanted} but holds no confirmed dollars`
        + (chosen.balance.verification === 'live'
          ? ': the venue reports a zero USD balance'
          : `: no balance has been read (${chosen.balance.reason || 'never probed'})`));
    }
    return {
      capability: wanted,
      account: issues.length ? null : chosen,
      candidates,
      issues,
    };
  },

  // ── Storage ────────────────────────────────────────────────────────────────

  async list({ status = null } = {}) {
    await this.ensureTables();
    const result = status
      ? await pool.query('SELECT * FROM venue_accounts WHERE status = $1 ORDER BY created_at', [status])
      : await pool.query('SELECT * FROM venue_accounts ORDER BY created_at');
    return result.rows;
  },

  async get(venueId) {
    await this.ensureTables();
    const result = await pool.query('SELECT * FROM venue_accounts WHERE venue_id = $1', [String(venueId || '')]);
    return result.rows[0] || null;
  },

  async _require(venueId) {
    const row = await this.get(venueId);
    if (!row) {
      throw new VenueAccountError(`${venueId} is not a registered venue account`, 'VENUE_ACCOUNT_NOT_FOUND', 404);
    }
    return row;
  },

  async _update(venueId, patch) {
    const sets = ['updated_at = NOW()'];
    const params = [];
    for (const [column, value] of Object.entries(patch)) {
      if (value === 'NOW()') {
        sets.push(`${column} = NOW()`);
        continue;
      }
      params.push(column === 'metadata' ? JSON.stringify(value) : value);
      sets.push(`${column} = $${params.length}`);
    }
    params.push(String(venueId));
    const result = await pool.query(
      `UPDATE venue_accounts SET ${sets.join(', ')} WHERE venue_id = $${params.length} RETURNING *`,
      params
    );
    return result.rows[0];
  },
};

module.exports = { VenueAccountOsEngine, VenueAccountError, PROVIDERS, CAPABILITIES, STATUSES };
