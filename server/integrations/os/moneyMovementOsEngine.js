'use strict';

/**
 * Money Movement OS: acquiring the trust's first on-chain value.
 *
 * Every other engine here moves value the trust already has. This one is the
 * only place dollars become XLM, which is the asset a Stellar account needs to
 * exist at all — before a trustline, before USDC, before a single payout. Until
 * that happens the whole rail is complete machinery attached to nothing.
 *
 * Why it is not just "send some XLM": the destination account does not exist
 * yet, so there is no balance to read, no trustline to hold USDC, and no
 * internal source that can create the asset. The sequence is therefore
 *
 *   USD at the trust bank
 *     → USD at a trading venue        (an ACH deposit; a bank moves it, not us)
 *     → XLM bought at the venue       (this engine, against the venue's API)
 *     → XLM at the distributor        (this engine, a venue withdrawal)
 *     → confirmed on Horizon          (this engine, reading the ledger itself)
 *
 * and the honest part is the second line: a venue must be involved because
 * converting dollars into crypto is a regulated act, and no amount of code
 * removes the account that performs it. What this engine does remove is every
 * manual step *after* the venue holds dollars — the buy, the withdrawal, the
 * confirmation and the bookkeeping run without a human touching an exchange UI.
 *
 * Controls, matching the USDC purchase engine because this is the same act one
 * asset earlier:
 *
 *   • The destination is the configured distributor, never a parameter, so an
 *     acquisition can never become a payment to somebody else.
 *   • Dual control: one trustee raises it, another approves, before the venue
 *     is called at all.
 *   • Arrival is a fact read from Horizon, not the venue reporting "sent". A
 *     withdrawal that the venue accepted and the network never showed stays
 *     `withdrawn`, which is exactly what it is.
 *   • Nothing is simulated. With no venue configured this refuses and names
 *     what is missing.
 *
 * Accounting:
 *
 *   dollars sent to venue   debit  purchases in transit (1215)  credit Trust Operating (1010)
 *   XLM confirmed on chain  debit  XLM (1216)                   credit purchases in transit (1215)
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');
const { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');
const { FundingSourceRegistry } = require('../inhouseBank/clearing/fundingSourceRegistry');
const { StellarVenue, venues } = require('../stablecoin/stellarVenue');
const { VenueAccountOsEngine } = require('./venueAccountOsEngine');
const { getConfig: stablecoinConfig } = require('../stablecoin/config');
const { XLM_FOR_TRUSTLINE, nativeBalance } = require('../stablecoin/accountFunding');

/** An acquisition in one of these states is dollars the trust has committed. */
const OPEN_STATUSES = ['pending_approval', 'approved', 'buying', 'withdrawn'];

class MoneyMovementError extends Error {
  constructor(message, code = 'MONEY_MOVEMENT_ERROR', status = 409) {
    super(message);
    this.name = 'MoneyMovementError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function text(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === null ? fallback : String(value).trim();
}

function money(cents) {
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

function newId() {
  return `XLMBUY-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

const MoneyMovementOsEngine = {
  MoneyMovementError,
  OPEN_STATUSES,

  config() {
    const cfg = stablecoinConfig();
    return {
      distributor: cfg.distributorPublic,
      horizonUrl: cfg.horizonUrl,
      network: cfg.network,
      transitAccount: text('STABLECOIN_PURCHASE_TRANSIT_ACCOUNT', '1215'),
      xlmAssetAccount: text('STABLECOIN_XLM_ASSET_ACCOUNT', '1216'),
    };
  },

  async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS xlm_acquisitions (
        acquisition_id      TEXT PRIMARY KEY,
        status              TEXT NOT NULL,
        usd_cents           BIGINT NOT NULL CHECK (usd_cents > 0),
        network             TEXT NOT NULL,
        destination         TEXT NOT NULL,
        venue               TEXT NOT NULL,
        venue_order_id      TEXT,
        venue_withdrawal_id TEXT,
        xlm_bought          TEXT,
        xlm_confirmed       TEXT,
        opening_balance     TEXT,
        initiated_by        TEXT NOT NULL,
        approved_by         TEXT,
        transit_journal_id  TEXT,
        journal_entry_id    TEXT,
        failure_reason      TEXT,
        memo                TEXT,
        metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        approved_at         TIMESTAMPTZ,
        confirmed_at        TIMESTAMPTZ
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_xlm_acquisitions_status ON xlm_acquisitions (status)`
    );
    return true;
  },

  /**
   * The destination account as the network sees it: whether it exists, and what
   * native balance it holds. A 404 is an answer — the account has never been
   * funded — not a failure to report.
   */
  async destinationState() {
    const cfg = this.config();
    if (!cfg.distributor) {
      return { address: null, exists: false, xlm: 0, reason: 'STABLECOIN_DISTRIBUTOR_PUBLIC is not set' };
    }
    const response = await fetch(`${cfg.horizonUrl}/accounts/${cfg.distributor}`);
    if (response.status === 404) {
      return { address: cfg.distributor, exists: false, xlm: 0, needsXlm: XLM_FOR_TRUSTLINE };
    }
    if (!response.ok) {
      throw new MoneyMovementError(
        `Horizon answered ${response.status} for the distributor; the network state is unknown`,
        'MONEY_MOVEMENT_HORIZON', 502
      );
    }
    const account = await response.json();
    const xlm = nativeBalance(account);
    return {
      address: cfg.distributor,
      exists: true,
      xlm,
      needsXlm: xlm >= XLM_FOR_TRUSTLINE ? 0 : Number((XLM_FOR_TRUSTLINE - xlm).toFixed(7)),
    };
  },

  /**
   * Can the trust acquire XLM right now, and if not, what exactly is missing.
   * Both halves matter: a configured venue with no dollars in it cannot buy,
   * and dollars with no venue cannot become XLM.
   */
  async readiness() {
    const cfg = this.config();
    const list = venues();
    const venue = list[0];
    const destination = await this.destinationState().catch(err => ({ error: err.message }));
    const issues = [];
    if (!cfg.distributor) issues.push('no destination: STABLECOIN_DISTRIBUTOR_PUBLIC is unset');
    if (!venue.installed) issues.push('the coinbase-api dependency is not installed');
    if (venue.missing.length) {
      issues.push(`no trading venue: ${venue.missing.join(', ')} unset`
        + ' — an account that holds USD is required to convert dollars into XLM');
    }
    // The register knows things the environment cannot: whether the account
    // behind those keys is approved, suspended, or holds any dollars. It only
    // speaks when an account has been registered — an empty register means the
    // trust is tracking venues by environment variable, which still works.
    const venueAccount = await this._venueAccount();
    if (venueAccount && venueAccount.issues.length) issues.push(...venueAccount.issues);
    return {
      network: cfg.network,
      destination,
      venues: list,
      venueAccount: venueAccount ? venueAccount.account : null,
      ready: issues.length === 0,
      issues,
    };
  },

  /** The registered account that will perform the buy, if the register knows one. */
  async _venueAccount() {
    try {
      const match = await VenueAccountOsEngine.forCapability('buy_xlm');
      return match.candidates.length ? match : null;
    } catch (e) {
      return null;
    }
  },

  /**
   * What an acquisition of `usdCents` would do, leg by leg, and which legs this
   * engine performs itself.
   */
  async plan({ usdCents } = {}) {
    const cfg = this.config();
    const cents = Number(usdCents);
    if (!Number.isFinite(cents) || cents <= 0) {
      throw new MoneyMovementError('usdCents must be a positive amount', 'MONEY_MOVEMENT_BAD_AMOUNT', 400);
    }
    const readiness = await this.readiness();
    const operating = FundingSourceRegistry.operatingAccountCode();
    return {
      usdCents: Math.round(cents),
      usd: money(cents),
      destination: readiness.destination,
      readiness,
      legs: [
        {
          leg: 'usd_to_venue',
          automated: false,
          description: `Deposit ${money(cents)} of USD at the venue from the trust bank account (ACH)`,
          posts: `debit ${cfg.transitAccount} / credit ${operating}`,
        },
        {
          leg: 'venue_buy',
          automated: true,
          description: `Market-buy ${money(cents)} of XLM at the venue`,
          posts: 'nothing: the asset has not left the venue yet',
        },
        {
          leg: 'venue_withdraw',
          automated: true,
          description: `Withdraw the XLM to ${readiness.destination.address || 'the distributor'} on Stellar`
            + (readiness.destination.exists ? '' : ' — which creates the account'),
          posts: 'nothing until Horizon shows it',
        },
        {
          leg: 'chain_confirm',
          automated: true,
          description: 'Read the distributor on Horizon and recognise the XLM that actually arrived',
          posts: `debit ${cfg.xlmAssetAccount} / credit ${cfg.transitAccount}`,
        },
      ],
    };
  },

  /** Maker raises the acquisition. Nothing is called at the venue yet. */
  async initiate({ usdCents, initiatedBy, memo = null } = {}) {
    await this.ensureTables();
    const maker = String(initiatedBy || '').trim();
    if (!maker) {
      throw new MoneyMovementError('initiatedBy is required', 'MONEY_MOVEMENT_NO_MAKER', 400);
    }
    const plan = await this.plan({ usdCents });
    if (!plan.readiness.ready) {
      throw new MoneyMovementError(
        `XLM cannot be acquired: ${plan.readiness.issues.join('; ')}`,
        'MONEY_MOVEMENT_NOT_READY', 503
      );
    }
    const acquisitionId = newId();
    const inserted = await pool.query(
      `INSERT INTO xlm_acquisitions
         (acquisition_id, status, usd_cents, network, destination, venue, initiated_by, memo)
       VALUES ($1, 'pending_approval', $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        acquisitionId,
        plan.usdCents,
        plan.readiness.network,
        plan.destination.address,
        plan.readiness.venues[0].id,
        maker,
        memo,
      ]
    );
    return { acquisition: inserted.rows[0], plan };
  },

  /** Checker approves. Must not be the maker. */
  async approve(acquisitionId, approvedBy) {
    const row = await this._require(acquisitionId);
    const checker = String(approvedBy || '').trim();
    if (!checker) {
      throw new MoneyMovementError('approvedBy is required', 'MONEY_MOVEMENT_NO_CHECKER', 400);
    }
    if (row.status !== 'pending_approval') {
      throw new MoneyMovementError(
        `${row.acquisition_id} is ${row.status}, not awaiting approval`,
        'MONEY_MOVEMENT_WRONG_STATE'
      );
    }
    if (checker.toLowerCase() === String(row.initiated_by).toLowerCase()) {
      throw new MoneyMovementError(
        'The trustee who raised an XLM acquisition cannot also approve it',
        'MONEY_MOVEMENT_SAME_TRUSTEE'
      );
    }
    return this._update(acquisitionId, {
      status: 'approved',
      approved_by: checker,
      approved_at: 'NOW()',
    });
  },

  /**
   * Record that dollars have been deposited at the venue, and book them as in
   * transit. The deposit is an ACH the bank performs; this is the trust
   * recognising that its cash has left.
   */
  async recordDeposit(acquisitionId, { reference, sentBy = null } = {}) {
    const cfg = this.config();
    const row = await this._require(acquisitionId);
    if (!['approved', 'pending_approval'].includes(row.status)) {
      throw new MoneyMovementError(
        `${row.acquisition_id} is ${row.status}; a deposit belongs to an open acquisition`,
        'MONEY_MOVEMENT_WRONG_STATE'
      );
    }
    const depositReference = String(reference || '').trim();
    if (!depositReference) {
      throw new MoneyMovementError(
        'A deposit reference is required: without it there is no evidence the dollars left the bank',
        'MONEY_MOVEMENT_NO_REFERENCE', 400
      );
    }
    const amount = Number(row.usd_cents) / 100;
    const journal = await TrustAccountingEngine.postJournalEntry({
      description: `XLM acquisition ${row.acquisition_id}: USD deposited at ${row.venue}`,
      lines: [
        {
          accountCode: cfg.transitAccount,
          debitAmount: amount,
          creditAmount: 0,
          memo: `USD in transit to ${row.venue} (${depositReference})`,
        },
        {
          accountCode: FundingSourceRegistry.operatingAccountCode(),
          debitAmount: 0,
          creditAmount: amount,
          memo: `Funding ${row.venue} for ${row.acquisition_id}`,
        },
      ],
      referenceType: 'xlm_acquisition',
      referenceId: row.acquisition_id,
      postedBy: sentBy || row.approved_by || row.initiated_by,
    });
    return this._update(acquisitionId, {
      transit_journal_id: journal.entry_id,
      metadata: { ...(row.metadata || {}), depositReference },
    });
  },

  /**
   * Buy the XLM and withdraw it to the distributor. This is the leg the venue
   * performs and the reason the engine exists; it records the venue's
   * references and stops there, because arrival is Horizon's to confirm.
   */
  async execute(acquisitionId, { executedBy = null } = {}) {
    const row = await this._require(acquisitionId);
    if (row.status !== 'approved') {
      throw new MoneyMovementError(
        `${row.acquisition_id} is ${row.status}; a second trustee approves before the venue is called`,
        'MONEY_MOVEMENT_WRONG_STATE'
      );
    }
    if (!row.approved_by) {
      throw new MoneyMovementError(
        `${row.acquisition_id} has not been approved by a second trustee`,
        'MONEY_MOVEMENT_NO_CHECKER'
      );
    }
    const usd = Number(row.usd_cents) / 100;
    const before = await this.destinationState();

    const quote = await StellarVenue.quote({ usd });
    if (!quote.ok) {
      const reason = quote.needsDeposit
        ? `the venue account holds no dollars to buy with: deposit ${money(row.usd_cents)} first`
        : `the venue refused the quote: ${quote.errors.join(', ')}`;
      await this._update(acquisitionId, { failure_reason: reason });
      throw new MoneyMovementError(reason, 'MONEY_MOVEMENT_VENUE_REFUSED', 402);
    }

    await this._update(acquisitionId, { status: 'buying', opening_balance: String(before.xlm) });
    let bought;
    try {
      bought = await StellarVenue.buy({ usd });
    } catch (err) {
      await this._update(acquisitionId, { status: 'approved', failure_reason: err.message });
      throw new MoneyMovementError(err.message, 'MONEY_MOVEMENT_BUY_FAILED', 502);
    }
    if (!bought.xlm) {
      const reason = 'the venue accepted the order but reported no filled size, so there is nothing to withdraw';
      await this._update(acquisitionId, { failure_reason: reason, venue_order_id: bought.orderId });
      throw new MoneyMovementError(reason, 'MONEY_MOVEMENT_NO_FILL', 502);
    }

    let sent;
    try {
      sent = await StellarVenue.withdraw({
        address: row.destination,
        xlm: bought.xlm,
        reference: row.acquisition_id,
      });
    } catch (err) {
      const reason = `bought ${bought.xlm} XLM but the withdrawal to ${row.destination} failed: ${err.message}`;
      await this._update(acquisitionId, {
        failure_reason: reason,
        venue_order_id: bought.orderId,
        xlm_bought: bought.xlm,
      });
      throw new MoneyMovementError(reason, 'MONEY_MOVEMENT_WITHDRAW_FAILED', 502);
    }

    return this._update(acquisitionId, {
      status: 'withdrawn',
      venue_order_id: bought.orderId,
      venue_withdrawal_id: sent.withdrawalId,
      xlm_bought: bought.xlm,
      failure_reason: null,
      metadata: {
        ...(row.metadata || {}),
        executedBy: executedBy || row.approved_by,
        venueWithdrawalStatus: sent.status,
      },
    });
  },

  /**
   * Recognise what actually arrived. The venue's receipt is not evidence: only
   * the distributor's own balance on Horizon is, and an account that still does
   * not exist has received nothing however the withdrawal was reported.
   */
  async confirm(acquisitionId, { confirmedBy = null } = {}) {
    const cfg = this.config();
    const row = await this._require(acquisitionId);
    if (row.status === 'confirmed') return row;
    if (row.status !== 'withdrawn') {
      throw new MoneyMovementError(
        `${row.acquisition_id} is ${row.status}; there is no withdrawal to confirm`,
        'MONEY_MOVEMENT_WRONG_STATE'
      );
    }
    const now = await this.destinationState();
    if (!now.exists) {
      throw new MoneyMovementError(
        `${row.destination} still does not exist on ${cfg.network}: the venue reported a withdrawal that the`
        + ' network has not shown, so nothing is recognised yet',
        'MONEY_MOVEMENT_NOT_ARRIVED', 409
      );
    }
    const opening = Number(row.opening_balance || 0);
    const arrived = Number((now.xlm - opening).toFixed(7));
    if (arrived <= 0) {
      throw new MoneyMovementError(
        `${row.destination} holds ${now.xlm} XLM, unchanged from ${opening}: the withdrawal has not landed`,
        'MONEY_MOVEMENT_NOT_ARRIVED', 409
      );
    }

    const journal = await TrustAccountingEngine.postJournalEntry({
      description: `XLM acquisition ${row.acquisition_id}: ${arrived} XLM confirmed at ${row.destination}`,
      lines: [
        {
          accountCode: cfg.xlmAssetAccount,
          debitAmount: Number(row.usd_cents) / 100,
          creditAmount: 0,
          memo: `${arrived} XLM on Stellar ${cfg.network}`,
        },
        {
          accountCode: cfg.transitAccount,
          debitAmount: 0,
          creditAmount: Number(row.usd_cents) / 100,
          memo: `Relieving USD in transit for ${row.acquisition_id}`,
        },
      ],
      referenceType: 'xlm_acquisition',
      referenceId: row.acquisition_id,
      postedBy: confirmedBy || row.approved_by || row.initiated_by,
    });

    return this._update(acquisitionId, {
      status: 'confirmed',
      xlm_confirmed: String(arrived),
      journal_entry_id: journal.entry_id,
      confirmed_at: 'NOW()',
    });
  },

  /** Dollars committed to acquisitions that have not yet landed on-chain. */
  async openCents() {
    await this.ensureTables();
    const result = await pool.query(
      `SELECT COALESCE(SUM(usd_cents), 0) AS cents FROM xlm_acquisitions WHERE status = ANY($1)`,
      [OPEN_STATUSES]
    );
    return Number(result.rows[0].cents || 0);
  },

  async list({ status = null, limit = 50 } = {}) {
    await this.ensureTables();
    const result = status
      ? await pool.query(
        'SELECT * FROM xlm_acquisitions WHERE status = $1 ORDER BY created_at DESC LIMIT $2',
        [status, Math.min(Number(limit) || 50, 200)]
      )
      : await pool.query(
        'SELECT * FROM xlm_acquisitions ORDER BY created_at DESC LIMIT $1',
        [Math.min(Number(limit) || 50, 200)]
      );
    return result.rows;
  },

  async get(acquisitionId) {
    await this.ensureTables();
    const result = await pool.query(
      'SELECT * FROM xlm_acquisitions WHERE acquisition_id = $1', [String(acquisitionId || '')]
    );
    return result.rows[0] || null;
  },

  async _require(acquisitionId) {
    const row = await this.get(acquisitionId);
    if (!row) {
      throw new MoneyMovementError(`${acquisitionId} is not an XLM acquisition`, 'MONEY_MOVEMENT_NOT_FOUND', 404);
    }
    return row;
  },

  async _update(acquisitionId, patch) {
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
    params.push(String(acquisitionId));
    const result = await pool.query(
      `UPDATE xlm_acquisitions SET ${sets.join(', ')} WHERE acquisition_id = $${params.length} RETURNING *`,
      params
    );
    return result.rows[0];
  },
};

module.exports = { MoneyMovementOsEngine, MoneyMovementError };
