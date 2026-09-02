'use strict';

/**
 * Venue Depository OS — the trust's own bank accounts, read through the
 * aggregator and reconciled against the books.
 *
 * Venue Account OS registers a `depository` venue — a bank account the trust
 * holds — but has no adapter to read it, so a depository's balance could only
 * ever be attested from a statement. The balance is not unreadable; the
 * banking aggregator already pulls it into `banking_aggregator_accounts`. What
 * was missing is the link between the two records: *this* venue account *is*
 * *that* aggregator account, and its dollars belong to *this* cash account in
 * the trust's chart.
 *
 * A depository link joins three things that were each recorded on their own:
 *
 *   the venue account        onboarding, status, who registered and approved it
 *   the aggregator account   a connection and the bank's own account id; the
 *                            source of balances and transactions
 *   the GL cash account      where those dollars are booked (1000, 1050, …)
 *
 * With the link in place three things become mechanical:
 *
 *   • A depository's balance is *read*, not asserted: the latest aggregator
 *     pull is the reading, recorded through ReserveEngine as custody evidence
 *     with `verification: 'live'`, and the venue is marked funded only when a
 *     recent pull showed dollars.
 *   • The aggregator's transactions post to the right cash account. Before, the
 *     DataBridge booked every aggregator credit and debit to 1000 whichever
 *     bank they came from.
 *   • The bank's number and the trust's number are compared, every full sync,
 *     and a gap is a DataBridge discrepancy with a severity — the same
 *     workflow every other module reconciles through.
 *
 * What it will not do: it will not treat an aggregator row the bank has not
 * refreshed as today's balance. A reading older than the freshness window is
 * unverified — the number is reported as what the bank last said, with its
 * age, but it is not recorded as custody evidence and does not fund the venue.
 * A rail that pays against yesterday's balance is paying against a number
 * nobody has confirmed.
 */

const pool = require('../bonds/pgPool');
const { BankingAggregator } = require('../aggregator/bankingAggregator');
const { VenueAccountOsEngine, PROVIDERS } = require('./venueAccountOsEngine');

/** The venue provider a depository link may attach to. */
const DEPOSITORY_PROVIDER = 'depository';

/** The connector that is the trust's own rails, not an outside bank. */
const INTERNAL_CONNECTOR = 'internal_rails';

/** Where a depository's dollars are booked unless the link says otherwise. */
const DEFAULT_GL_ACCOUNT = '1000';

class VenueDepositoryError extends Error {
  constructor(message, code = 'VENUE_DEPOSITORY_ERROR', status = 409) {
    super(message);
    this.name = 'VenueDepositoryError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function cents(value) {
  return Math.round(Number(value || 0));
}

function dollarsToCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function severityFor(diffCents) {
  const diff = Math.abs(diffCents) / 100;
  return diff > 10000 ? 'critical' : diff > 1000 ? 'high' : diff > 100 ? 'normal' : 'low';
}

const VenueDepositoryOsEngine = {
  VenueDepositoryError,
  DEPOSITORY_PROVIDER,
  DEFAULT_GL_ACCOUNT,

  config() {
    const n = Number(process.env.VENUE_DEPOSITORY_FRESH_MINUTES);
    const fallback = VenueAccountOsEngine.config().freshMinutes;
    return { freshMinutes: Number.isFinite(n) && n > 0 ? n : fallback };
  },

  async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS venue_depository_links (
        venue_id             TEXT PRIMARY KEY REFERENCES venue_accounts(venue_id) ON DELETE CASCADE,
        connection_id        TEXT NOT NULL,
        external_account_id  TEXT NOT NULL,
        gl_account_code      TEXT NOT NULL DEFAULT '1000',
        linked_by            TEXT NOT NULL,
        last_reconciled_at   TIMESTAMPTZ,
        last_difference_cents BIGINT,
        metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (connection_id, external_account_id)
      )
    `);
    return true;
  },

  // ── The link ───────────────────────────────────────────────────────────────

  /**
   * Declare that a registered depository venue is a specific account the
   * aggregator reads. Both ends must already exist: this joins records, it
   * does not create a bank account or a connection.
   */
  async link({ venueId, connectionId, externalAccountId, glAccountCode = DEFAULT_GL_ACCOUNT, linkedBy, metadata = {} } = {}) {
    await VenueAccountOsEngine.ensureTables();
    await this.ensureTables();

    const venue = await VenueAccountOsEngine.get(venueId);
    if (!venue) {
      throw new VenueDepositoryError(`${venueId} is not a registered venue account`, 'VENUE_DEPOSITORY_NO_VENUE', 404);
    }
    if (venue.provider !== DEPOSITORY_PROVIDER) {
      throw new VenueDepositoryError(
        `${venue.venue_id} is a ${venue.provider} account; only a ${DEPOSITORY_PROVIDER} venue is read through the aggregator`,
        'VENUE_DEPOSITORY_WRONG_PROVIDER', 400
      );
    }
    if (venue.status === 'closed') {
      throw new VenueDepositoryError(`${venue.venue_id} is closed`, 'VENUE_DEPOSITORY_WRONG_STATE');
    }

    const by = String(linkedBy || '').trim();
    if (!by) throw new VenueDepositoryError('linkedBy is required', 'VENUE_DEPOSITORY_NO_LINKER', 400);

    const connId = String(connectionId || '').trim();
    const acctId = String(externalAccountId || '').trim();
    if (!connId || !acctId) {
      throw new VenueDepositoryError(
        'connectionId and externalAccountId are required: which aggregator connection, and which of its accounts',
        'VENUE_DEPOSITORY_NO_ACCOUNT', 400
      );
    }

    const connection = await BankingAggregator.getConnection(connId);
    if (!connection) {
      throw new VenueDepositoryError(`${connId} is not an aggregator connection`, 'VENUE_DEPOSITORY_NO_CONNECTION', 404);
    }
    if (connection.connector_type === INTERNAL_CONNECTOR) {
      throw new VenueDepositoryError(
        `${connId} is the trust's own rails, not an outside depository`,
        'VENUE_DEPOSITORY_INTERNAL_CONNECTION', 400
      );
    }
    const accounts = await BankingAggregator.listAccounts(connId);
    const account = accounts.find(a => String(a.external_account_id) === acctId);
    if (!account) {
      throw new VenueDepositoryError(
        `${connId} has no account ${acctId}; pull the connection first, or check the bank's account id`,
        'VENUE_DEPOSITORY_ACCOUNT_UNKNOWN', 404
      );
    }

    const gl = String(glAccountCode || DEFAULT_GL_ACCOUNT).trim();
    const glRow = await pool.query(
      'SELECT account_code, account_name, account_type, sub_type FROM trust_accounts WHERE account_code = $1 AND is_active = TRUE',
      [gl]
    );
    const glAccount = glRow.rows[0];
    if (!glAccount) {
      throw new VenueDepositoryError(`${gl} is not an active account in the trust's chart`, 'VENUE_DEPOSITORY_NO_GL', 400);
    }
    if (glAccount.account_type !== 'asset') {
      throw new VenueDepositoryError(
        `${gl} (${glAccount.account_name}) is ${glAccount.account_type}; a depository's dollars are an asset`,
        'VENUE_DEPOSITORY_GL_NOT_CASH', 400
      );
    }

    const inserted = await pool.query(
      `INSERT INTO venue_depository_links
         (venue_id, connection_id, external_account_id, gl_account_code, linked_by, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (venue_id) DO UPDATE SET
         connection_id = EXCLUDED.connection_id,
         external_account_id = EXCLUDED.external_account_id,
         gl_account_code = EXCLUDED.gl_account_code,
         linked_by = EXCLUDED.linked_by,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING *`,
      [venue.venue_id, connId, acctId, gl, by, JSON.stringify(metadata || {})]
    );
    const externalReference = venue.external_reference || `${connection.name || connId}:${account.mask || acctId}`;
    if (!venue.external_reference) {
      await VenueAccountOsEngine._update(venue.venue_id, { external_reference: externalReference });
    }
    return inserted.rows[0];
  },

  async unlink(venueId) {
    await this.ensureTables();
    const result = await pool.query(
      'DELETE FROM venue_depository_links WHERE venue_id = $1 RETURNING *',
      [String(venueId || '')]
    );
    if (!result.rows[0]) {
      throw new VenueDepositoryError(`${venueId} has no depository link`, 'VENUE_DEPOSITORY_NOT_LINKED', 404);
    }
    return result.rows[0];
  },

  // ── Reading the bank ───────────────────────────────────────────────────────

  /**
   * What the bank last told the aggregator about this account: whatever the
   * last pull left behind, with its age reported honestly.
   */
  async read(venueId) {
    const link = await this._requireLink(venueId);
    const reasons = [];
    const accounts = await BankingAggregator.listAccounts(link.connection_id);
    const account = accounts.find(a => String(a.external_account_id) === String(link.external_account_id));
    if (!account) {
      return {
        verification: 'unverified',
        balanceCents: 0,
        reason: [`the aggregator no longer lists account ${link.external_account_id} on ${link.connection_id}`, ...reasons].join('; '),
        link,
      };
    }
    const current = dollarsToCents(account.balance_current);
    const available = dollarsToCents(account.balance_available);
    const balanceCents = current !== null ? current : available;
    if (balanceCents === null) {
      return {
        verification: 'unverified',
        balanceCents: 0,
        reason: ['the bank reported no balance for this account', ...reasons].join('; '),
        link,
        account,
      };
    }
    const observedAt = account.updated_at ? new Date(account.updated_at) : null;
    const ageMinutes = observedAt ? (Date.now() - observedAt.getTime()) / 60000 : Infinity;
    const { freshMinutes } = this.config();
    const stale = ageMinutes > freshMinutes;
    if (stale) {
      reasons.unshift(`the aggregator last read this account ${Number.isFinite(ageMinutes) ? Math.round(ageMinutes) + ' minutes' : 'an unknown time'} ago; pull the connection for a current balance`);
    }
    return {
      verification: stale ? 'unverified' : 'live',
      balanceCents: stale ? 0 : balanceCents,
      lastKnownCents: balanceCents,
      availableCents: available,
      asset: String(account.currency || 'USD').toUpperCase(),
      observedAt: observedAt ? observedAt.toISOString() : null,
      stale,
      reason: reasons.length ? reasons.join('; ') : null,
      link,
      account: {
        id: account.id,
        name: account.name,
        type: account.account_type,
        mask: account.mask,
        currency: account.currency,
      },
    };
  },

  /**
   * Refresh the connection if asked, then let Venue Account OS probe the venue
   * — its depository adapter reads through this engine, so the register and
   * the reserve store are written by the one code path every venue uses.
   */
  async probe(venueId, { refresh = false } = {}) {
    const link = await this._requireLink(venueId);
    const pullErrors = [];
    if (refresh) {
      try {
        const summary = await BankingAggregator.pull(link.connection_id, { kinds: ['accounts'] });
        for (const err of summary.errors || []) pullErrors.push(`${err.kind} pull failed: ${err.error}`);
      } catch (e) {
        pullErrors.push(`the aggregator pull failed: ${e.message}`);
      }
    }
    const result = await VenueAccountOsEngine.probe(venueId);
    if (pullErrors.length) {
      result.reading.reason = [result.reading.reason, ...pullErrors].filter(Boolean).join('; ');
    }
    return result;
  },

  // ── The unified data workflow ──────────────────────────────────────────────

  /**
   * Which GL cash account an aggregator account's transactions belong to.
   * `null` when no depository claims the account, so the caller falls back to
   * its own default rather than inventing one.
   */
  async glAccountFor(connectionId, externalAccountId) {
    const map = await this.glAccountMap();
    return map.get(`${connectionId}::${externalAccountId}`) || null;
  },

  async glAccountMap() {
    await this.ensureTables();
    const result = await pool.query(
      'SELECT connection_id, external_account_id, gl_account_code FROM venue_depository_links'
    );
    const map = new Map();
    for (const row of result.rows) {
      map.set(`${row.connection_id}::${row.external_account_id}`, row.gl_account_code);
    }
    return map;
  },

  /**
   * Compare what each bank says with what the books say, per GL account. Every
   * linked depository is probed, its balance summed into the GL account it is
   * booked to, and the sum compared with `trust_accounts.balance`. Gaps go to
   * the DataBridge discrepancy log with the severity every other module uses;
   * a balanced account resolves its earlier discrepancies.
   *
   * Depositories whose reading is unverified are reported and excluded from
   * the comparison, because a missing number is not a zero.
   */
  async reconcile({ refresh = false, log = true } = {}) {
    const { DataBridge } = require('../accounting/dataBridge');
    const syncId = 'RECON-DEPOSITORY-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const links = await this.list();
    const readings = [];
    const unread = [];
    const byGl = new Map();

    for (const link of links) {
      try {
        const { venue, reading } = await this.probe(link.venue_id, { refresh });
        const entry = {
          venueId: link.venue_id,
          label: venue.label,
          connectionId: link.connection_id,
          externalAccountId: link.external_account_id,
          glAccountCode: link.gl_account_code,
          verification: reading.verification,
          balanceCents: reading.balanceCents,
          observedAt: (reading.detail && reading.detail.observedAt) || null,
          reason: reading.reason || null,
        };
        readings.push(entry);
        if (reading.verification !== 'live') { unread.push(entry); continue; }
        byGl.set(link.gl_account_code, (byGl.get(link.gl_account_code) || 0) + reading.balanceCents);
      } catch (e) {
        const entry = { venueId: link.venue_id, glAccountCode: link.gl_account_code, verification: 'unverified', balanceCents: 0, reason: e.message };
        readings.push(entry);
        unread.push(entry);
      }
    }

    const comparisons = [];
    const discrepancies = [];
    for (const [glAccountCode, bankCents] of byGl.entries()) {
      const glRow = await pool.query(
        'SELECT account_code, account_name, balance FROM trust_accounts WHERE account_code = $1 AND is_active = TRUE',
        [glAccountCode]
      );
      const books = glRow.rows[0];
      const booksCents = books ? cents(Number(books.balance) * 100) : null;
      const differenceCents = booksCents === null ? null : bankCents - booksCents;
      const reconciled = differenceCents !== null && Math.abs(differenceCents) === 0;
      const comparison = {
        glAccountCode,
        glAccountName: books ? books.account_name : null,
        bankCents,
        booksCents,
        differenceCents,
        reconciled,
        severity: differenceCents === null || reconciled ? null : severityFor(differenceCents),
      };
      comparisons.push(comparison);

      await pool.query(
        `UPDATE venue_depository_links
            SET last_reconciled_at = NOW(), last_difference_cents = $2, updated_at = NOW()
          WHERE gl_account_code = $1`,
        [glAccountCode, differenceCents]
      );

      if (!log) continue;
      if (reconciled) {
        await pool.query(
          `UPDATE data_bridge_discrepancies
              SET resolved = TRUE, resolved_at = NOW(), resolution = 'auto_resolved_balanced'
            WHERE discrepancy_type = 'depository_balance_mismatch' AND account_code = $1 AND resolved = FALSE`,
          [glAccountCode]
        );
      } else if (differenceCents !== null) {
        const discId = `DISC-DEPOSITORY-${glAccountCode}-${Date.now()}`;
        discrepancies.push({ discrepancyId: discId, ...comparison });
        await DataBridge._logDiscrepancy(
          discId, 'depository_balance_mismatch', 'venue_depository', 'trust_accounting',
          glAccountCode, bankCents / 100, booksCents / 100, differenceCents / 100, comparison.severity
        );
      } else {
        discrepancies.push({ ...comparison, note: `${glAccountCode} is not an active trust account` });
      }
    }

    if (log) {
      await DataBridge._logSync(
        syncId, 'depository_reconciliation', 'venue_depository', 'trust_accounting',
        readings.length - unread.length, unread.length, 0,
        { comparisons, unread }
      );
    }

    return {
      syncId,
      linked: links.length,
      read: readings.length - unread.length,
      unread,
      readings,
      comparisons,
      discrepancies,
      isReconciled: comparisons.length > 0 && comparisons.every(c => c.reconciled) && unread.length === 0,
    };
  },

  /** The whole picture, for the data-flow dashboard and the CLI. */
  async snapshot() {
    const links = await this.list();
    const depositories = [];
    for (const link of links) {
      const venue = await VenueAccountOsEngine.get(link.venue_id);
      const described = venue ? await VenueAccountOsEngine.describe(venue) : null;
      let reading;
      try { reading = await this.read(link.venue_id); } catch (e) { reading = { verification: 'unverified', balanceCents: 0, reason: e.message }; }
      depositories.push({
        venueId: link.venue_id,
        label: described ? described.label : null,
        status: described ? described.status : null,
        connectionId: link.connection_id,
        externalAccountId: link.external_account_id,
        glAccountCode: link.gl_account_code,
        linkedBy: link.linked_by,
        balance: {
          cents: reading.balanceCents,
          lastKnownCents: reading.lastKnownCents === undefined ? null : reading.lastKnownCents,
          availableCents: reading.availableCents === undefined ? null : reading.availableCents,
          verification: reading.verification,
          observedAt: reading.observedAt || null,
          stale: Boolean(reading.stale),
          reason: reading.reason || null,
        },
        lastReconciledAt: link.last_reconciled_at || null,
        lastDifferenceCents: link.last_difference_cents === null || link.last_difference_cents === undefined
          ? null : Number(link.last_difference_cents),
        blockers: described ? described.blockers : ['the venue account no longer exists'],
      });
    }
    let unlinked = [];
    try {
      const venues = await VenueAccountOsEngine.list();
      const linked = new Set(links.map(l => l.venue_id));
      unlinked = venues
        .filter(v => v.provider === DEPOSITORY_PROVIDER && v.status !== 'closed' && !linked.has(v.venue_id))
        .map(v => ({ venueId: v.venue_id, label: v.label, status: v.status }));
    } catch (e) { /* the register is optional for the snapshot */ }
    return {
      depositories,
      unlinked,
      linked: depositories.length,
      live: depositories.filter(d => d.balance.verification === 'live').length,
      totalLiveCents: depositories
        .filter(d => d.balance.verification === 'live')
        .reduce((sum, d) => sum + d.balance.cents, 0),
      provider: PROVIDERS[DEPOSITORY_PROVIDER],
    };
  },

  // ── Storage ────────────────────────────────────────────────────────────────

  async list() {
    await this.ensureTables();
    const result = await pool.query('SELECT * FROM venue_depository_links ORDER BY created_at');
    return result.rows;
  },

  async get(venueId) {
    await this.ensureTables();
    const result = await pool.query('SELECT * FROM venue_depository_links WHERE venue_id = $1', [String(venueId || '')]);
    return result.rows[0] || null;
  },

  async _requireLink(venueId) {
    const link = await this.get(venueId);
    if (!link) {
      throw new VenueDepositoryError(
        `${venueId} is not linked to an aggregator account; link it, or attest its balance from a statement`,
        'VENUE_DEPOSITORY_NOT_LINKED', 404
      );
    }
    return link;
  },
};

module.exports = { VenueDepositoryOsEngine, VenueDepositoryError, DEPOSITORY_PROVIDER, DEFAULT_GL_ACCOUNT };
