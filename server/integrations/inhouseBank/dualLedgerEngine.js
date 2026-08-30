'use strict';

/**
 * Dual Ledger Sync & Events
 *
 * An in-house bank keeps two sets of books and they must agree:
 *
 *   the bank ledger   per-virtual-account postings — what each family member,
 *                     entity or purpose account holds and why;
 *   the general ledger the trust's accounting record, where the same movement
 *                     appears as a journal entry against the settlement and
 *                     expense accounts.
 *
 * Writing both from one place is what keeps them equal, but the two stores
 * cannot be committed atomically, so this engine does not pretend otherwise.
 * The bank posting is authoritative and always written first; the GL mirror is
 * attempted immediately and, if it fails, the posting is flagged
 * `gl_state = 'pending'` with the error. `reconcile()` reports those, along with
 * any account whose stored balance no longer equals the sum of its postings,
 * and `syncPending()` retries them. A mirror that failed is therefore visible
 * and fixable rather than a silent divergence discovered at year end.
 *
 * Every state change also appends to a hash-chained event log: each event
 * hashes its predecessor, so a payment's history cannot be edited after the
 * fact without `verifyChain()` reporting exactly where.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');
const { getConfig } = require('./inHouseBankConfig');

function id(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

/**
 * Key order has to be canonical: the payload comes back out of JSONB with its
 * keys reordered, so hashing raw JSON.stringify output would make every event
 * look tampered with on the way back in.
 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = canonical(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function hashEvent({ prevHash, eventType, paymentId, actor, payload, createdAt }) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      prevHash: prevHash || null,
      eventType,
      paymentId: paymentId || null,
      actor: actor || null,
      payload: canonical(payload || {}),
      createdAt,
    }))
    .digest('hex');
}

class DualLedgerEngine {
  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ihb_postings (
        posting_id      TEXT PRIMARY KEY,
        payment_id      TEXT,
        va_id           TEXT,
        account_number  TEXT,
        direction       TEXT NOT NULL CHECK (direction IN ('debit','credit')),
        amount_cents    BIGINT NOT NULL,
        balance_after_cents BIGINT,
        rail            TEXT,
        memo            TEXT,
        gl_state        TEXT NOT NULL DEFAULT 'pending'
                        CHECK (gl_state IN ('pending','posted','skipped','failed')),
        gl_entry_id     TEXT,
        gl_error        TEXT,
        posted_by       TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ihb_postings_payment ON ihb_postings (payment_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ihb_postings_va ON ihb_postings (va_id)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ihb_events (
        sequence   BIGSERIAL PRIMARY KEY,
        event_id   TEXT UNIQUE NOT NULL,
        event_type TEXT NOT NULL,
        payment_id TEXT,
        actor      TEXT,
        payload    JSONB NOT NULL DEFAULT '{}',
        prev_hash  TEXT,
        event_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    return true;
  }

  // ── Event chain ────────────────────────────────────────────────────────────

  static async appendEvent({ eventType, paymentId = null, actor = null, payload = {} }) {
    await this.ensureTables();
    const tip = await pool.query('SELECT event_hash FROM ihb_events ORDER BY sequence DESC LIMIT 1');
    const prevHash = (tip.rows[0] && tip.rows[0].event_hash) || null;
    const createdAt = new Date().toISOString();
    const eventId = id('IHE');
    const eventHash = hashEvent({ prevHash, eventType, paymentId, actor, payload, createdAt });
    const rows = await pool.query(
      `INSERT INTO ihb_events (event_id, event_type, payment_id, actor, payload, prev_hash, event_hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [eventId, eventType, paymentId, actor, JSON.stringify(payload), prevHash, eventHash, createdAt]
    );
    return rows.rows[0];
  }

  static async events({ paymentId = null, limit = 100 } = {}) {
    await this.ensureTables();
    const rows = await pool.query(
      `SELECT * FROM ihb_events
        WHERE ($1::text IS NULL OR payment_id = $1)
        ORDER BY sequence DESC
        LIMIT $2`,
      [paymentId, Math.min(Math.max(Number(limit) || 100, 1), 1000)]
    );
    return rows.rows;
  }

  static async verifyChain() {
    await this.ensureTables();
    const rows = await pool.query('SELECT * FROM ihb_events ORDER BY sequence ASC');
    let prevHash = null;
    const breaks = [];
    for (const row of rows.rows) {
      let payload = row.payload || {};
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch { payload = {}; }
      }
      const expected = hashEvent({
        prevHash,
        eventType: row.event_type,
        paymentId: row.payment_id,
        actor: row.actor,
        payload,
        createdAt: new Date(row.created_at).toISOString(),
      });
      if (expected !== row.event_hash || (row.prev_hash || null) !== prevHash) {
        breaks.push({ eventId: row.event_id, sequence: Number(row.sequence) });
      }
      prevHash = row.event_hash;
    }
    return {
      events: rows.rows.length,
      intact: breaks.length === 0,
      breaks,
      tipHash: prevHash,
      note: breaks.length === 0
        ? 'Every in-house bank event hashes to its predecessor; the payment history is intact.'
        : 'The event log has been altered: the listed events no longer hash to their predecessor.',
    };
  }

  // ── Postings ───────────────────────────────────────────────────────────────

  /**
   * Record one side of a movement on the bank ledger and mirror it to the GL.
   * The mirror never throws: a GL outage must not unwind a payment that has
   * already moved on the bank ledger, it must be visible as a pending mirror.
   */
  static async record({
    paymentId,
    vaId,
    accountNumber = null,
    direction,
    amountCents,
    balanceAfterCents = null,
    rail = null,
    memo = null,
    postedBy = 'system',
    glLines = null,
    description = null,
  }) {
    await this.ensureTables();
    const config = getConfig();
    const postingId = id('PST');

    const rows = await pool.query(
      `INSERT INTO ihb_postings
         (posting_id, payment_id, va_id, account_number, direction, amount_cents,
          balance_after_cents, rail, memo, gl_state, posted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        postingId, paymentId, vaId, accountNumber, direction, Number(amountCents),
        balanceAfterCents === null ? null : Number(balanceAfterCents), rail, memo,
        glLines && config.mirrorToGeneralLedger ? 'pending' : 'skipped', postedBy,
      ]
    );
    let posting = rows.rows[0];

    if (glLines && config.mirrorToGeneralLedger) {
      posting = await this._mirror(posting, { glLines, description: description || memo, postedBy });
    }
    return posting;
  }

  static async _mirror(posting, { glLines, description, postedBy }) {
    try {
      const { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');
      const entry = await TrustAccountingEngine.postJournalEntry({
        entryDate: new Date(),
        description: description || `In-house bank posting ${posting.posting_id}`,
        lines: glLines,
        referenceType: 'inhouse_bank_payment',
        referenceId: posting.payment_id,
        postedBy: postedBy || 'inhouse-bank',
        postToFineract: false,
      });
      const glEntryId = (entry && (entry.entryId || entry.entry_id)) || null;
      const rows = await pool.query(
        `UPDATE ihb_postings SET gl_state = 'posted', gl_entry_id = $2, gl_error = NULL
          WHERE posting_id = $1 RETURNING *`,
        [posting.posting_id, glEntryId]
      );
      return rows.rows[0];
    } catch (err) {
      const rows = await pool.query(
        `UPDATE ihb_postings SET gl_state = 'failed', gl_error = $2 WHERE posting_id = $1 RETURNING *`,
        [posting.posting_id, err.message]
      );
      console.warn('[ihb-dual-ledger] GL mirror failed for', posting.posting_id, err.message);
      return rows.rows[0];
    }
  }

  static async postingsFor(paymentId) {
    await this.ensureTables();
    const rows = await pool.query('SELECT * FROM ihb_postings WHERE payment_id = $1 ORDER BY created_at ASC', [paymentId]);
    return rows.rows;
  }

  /**
   * Retry the GL side of postings whose mirror failed. The bank ledger is
   * untouched: this only catches the general ledger up.
   */
  static async syncPending({ limit = 50, postedBy = 'system' } = {}) {
    await this.ensureTables();
    const config = getConfig();
    const rows = await pool.query(
      `SELECT * FROM ihb_postings WHERE gl_state IN ('pending','failed') ORDER BY created_at ASC LIMIT $1`,
      [Math.min(Math.max(Number(limit) || 50, 1), 500)]
    );
    const results = [];
    for (const posting of rows.rows) {
      const amount = Number(posting.amount_cents) / 100;
      // Rebuild the journal from the posting itself so a retry cannot invent a
      // different entry than the one that failed.
      const glLines = posting.direction === 'debit'
        ? [
          { accountCode: config.glOutflowAccountCode, debitAmount: amount, creditAmount: 0 },
          { accountCode: config.settlementAccountCode, debitAmount: 0, creditAmount: amount },
        ]
        : [
          { accountCode: config.settlementAccountCode, debitAmount: amount, creditAmount: 0 },
          { accountCode: config.glClearingAccountCode, debitAmount: 0, creditAmount: amount },
        ];
      const updated = await this._mirror(posting, {
        glLines,
        description: posting.memo || `In-house bank posting ${posting.posting_id}`,
        postedBy,
      });
      results.push({ postingId: posting.posting_id, glState: updated.gl_state, glError: updated.gl_error });
    }
    return { attempted: results.length, results };
  }

  /**
   * Does the bank ledger still add up, and does the GL still agree with it?
   * Reported per account rather than as a single total, because a net-zero pair
   * of opposite errors is still two errors.
   */
  static async reconcile() {
    await this.ensureTables();
    const drift = await pool.query(`
      SELECT va.va_id,
             va.account_number,
             va.name,
             va.balance_cents,
             COALESCE(SUM(CASE WHEN p.direction = 'credit' THEN p.amount_cents
                               WHEN p.direction = 'debit'  THEN -p.amount_cents
                               ELSE 0 END), 0)::bigint AS posted_cents
        FROM ihb_virtual_accounts va
        LEFT JOIN ihb_postings p ON p.va_id = va.va_id
       GROUP BY va.va_id, va.account_number, va.name, va.balance_cents
    `);

    const breaks = drift.rows
      .map(row => ({
        vaId: row.va_id,
        accountNumber: row.account_number,
        name: row.name,
        balanceCents: Number(row.balance_cents),
        postedCents: Number(row.posted_cents),
        driftCents: Number(row.balance_cents) - Number(row.posted_cents),
      }))
      .filter(row => row.driftCents !== 0);

    const glRows = await pool.query(
      `SELECT gl_state, COUNT(*)::int AS count, COALESCE(SUM(amount_cents), 0)::bigint AS amount_cents
         FROM ihb_postings GROUP BY gl_state`
    );
    const glMirror = glRows.rows.reduce((acc, row) => {
      acc[row.gl_state] = { count: Number(row.count), amountCents: Number(row.amount_cents) };
      return acc;
    }, {});
    const unmirrored = (glMirror.pending ? glMirror.pending.count : 0) + (glMirror.failed ? glMirror.failed.count : 0);

    const { VirtualAccountManager } = require('./virtualAccountManager');
    const position = await VirtualAccountManager.position();

    return {
      accountsChecked: drift.rows.length,
      breaks,
      balanced: breaks.length === 0,
      glMirror,
      unmirroredPostings: unmirrored,
      pooledPosition: position,
      note: breaks.length === 0 && unmirrored === 0
        ? 'Bank ledger balances equal the sum of their postings and every posting is mirrored to the general ledger.'
        : [
          breaks.length ? `${breaks.length} virtual account(s) no longer equal the sum of their postings.` : null,
          unmirrored ? `${unmirrored} posting(s) are not mirrored to the general ledger; run syncPending.` : null,
        ].filter(Boolean).join(' '),
    };
  }
}

module.exports = { DualLedgerEngine };
