'use strict';

/**
 * Clearing & Netting OS — settling the day's obligations as one position
 *
 * The back office already unifies what the family bank owes into one queue, and
 * Payer OS already originates a single credit under dual control. Between those
 * two there was nothing: every obligation was cleared on its own, so three
 * invoices from one vendor left as three credits on three files, each one its
 * own fee, its own return risk and its own chance of being pushed twice while
 * the other two were in flight. A back office that pays gross pays more than it
 * owes in friction, and it funds the same counterparty from three decisions
 * nobody adds up.
 *
 * This engine is the clearing house between them. A cycle is a dated batch:
 *
 *   open     obligations are drawn from the back-office credit queue and bound
 *            to the cycle, which is the moment they stop being independently
 *            pushable;
 *   netted   obligations are collapsed into one leg per counterparty, rail and
 *            currency, and the cycle's net funding requirement is known;
 *   funded   that requirement has been checked against the Trust Operating
 *            Account net of every other live cycle, so two cycles cannot promise
 *            the same dollars;
 *   settling each leg has been handed to Payer OS as one net credit;
 *   settled  every leg came back settled — or `partially_settled`, which is
 *            reported as itself rather than rounded up to done.
 *
 * What it refuses is what makes it safe to run against real money:
 *
 *   • It nets, it does not pay. Legs are handed to Payer OS, which still
 *     requires a second trustee, a compliance screen, a registered payee and a
 *     configured bank channel. This engine cannot approve, transmit or settle,
 *     and it posts no journal entry.
 *   • Netting never crosses a rail, a currency or a counterparty. A CCD vendor
 *     credit and a PPD beneficiary distribution to the same person are two
 *     legally distinct instructions; collapsing them would misstate both. Legs
 *     are keyed on payee, disbursement type, currency and value date.
 *   • Only credits net. There is no receivable side in the book of record yet,
 *     so every leg is money leaving; the intake is the one place to extend when
 *     there is something to net against, and until then a "net" is a sum, and is
 *     labelled as one.
 *   • An obligation belongs to one live cycle. Cycle membership is written under
 *     a unique partial index, so two operators opening a cycle at the same
 *     instant produce one claim on each obligation and one refusal.
 *   • Cancelling releases. A cancelled cycle frees its obligations back to the
 *     queue; obligations whose legs already reached Payer OS are not released,
 *     because those dollars are in flight on a rail this engine does not own.
 */

const crypto = require('crypto');
const pool = require('./../bonds/pgPool');

const { WealthBackOfficeEngine } = require('./wealthBackOfficeEngine');
const { PayerOsEngine, TERMINAL_STATUSES } = require('./payerOsEngine');
const { FundingSourceRegistry, TRUST_OPERATING } = require('../inhouseBank/clearing/fundingSourceRegistry');
const { MessagingEngine } = require('../messaging/messagingEngine');

/** A cycle in one of these states still speaks for the trust's cash. */
const LIVE_CYCLE_STATUSES = ['open', 'netted', 'funded', 'settling', 'partially_settled'];

/** A leg that has not reached Payer OS can still be released back to the queue. */
const RELEASABLE_LEG_STATUSES = ['netted', 'failed'];

const CYCLE_TRANSITIONS = Object.freeze({
  open: new Set(['netted', 'cancelled']),
  netted: new Set(['funded', 'cancelled']),
  funded: new Set(['settling', 'cancelled']),
  settling: new Set(['settled', 'partially_settled']),
  partially_settled: new Set(['settled', 'settling']),
  settled: new Set([]),
  cancelled: new Set([]),
});

class ClearingNettingError extends Error {
  constructor(message, code = 'CLEARING_NETTING_ERROR', status = 409) {
    super(message);
    this.name = 'ClearingNettingError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function dollars(cents) {
  return `$${(Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function isoDay(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function cycleId(valueDate) {
  const stamp = String(valueDate).replace(/-/g, '');
  return `CYC-${stamp}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

class ClearingNettingEngineImpl {
  constructor() {
    this.LIVE_CYCLE_STATUSES = LIVE_CYCLE_STATUSES;
    this.CYCLE_TRANSITIONS = CYCLE_TRANSITIONS;
    this.ClearingNettingError = ClearingNettingError;
  }

  async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clearing_cycles (
        cycle_id        TEXT PRIMARY KEY,
        value_date      DATE NOT NULL,
        currency        TEXT NOT NULL DEFAULT 'USD',
        status          TEXT NOT NULL DEFAULT 'open',
        opened_by       TEXT NOT NULL,
        gross_cents     BIGINT NOT NULL DEFAULT 0,
        net_cents       BIGINT NOT NULL DEFAULT 0,
        funding_source  TEXT,
        funded_by       TEXT,
        settled_cents   BIGINT NOT NULL DEFAULT 0,
        note            TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        netted_at       TIMESTAMPTZ,
        funded_at       TIMESTAMPTZ,
        settled_at      TIMESTAMPTZ,
        cancelled_at    TIMESTAMPTZ,
        cancelled_by    TEXT,
        cancel_reason   TEXT
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clearing_cycle_legs (
        leg_id            TEXT PRIMARY KEY,
        cycle_id          TEXT NOT NULL REFERENCES clearing_cycles(cycle_id) ON DELETE CASCADE,
        payee_key         TEXT NOT NULL,
        counterparty      TEXT,
        disbursement_type TEXT NOT NULL,
        currency          TEXT NOT NULL DEFAULT 'USD',
        value_date        DATE NOT NULL,
        gross_cents       BIGINT NOT NULL CHECK (gross_cents > 0),
        net_cents         BIGINT NOT NULL CHECK (net_cents > 0),
        obligation_count  INTEGER NOT NULL DEFAULT 0,
        status            TEXT NOT NULL DEFAULT 'netted',
        disbursement_id   TEXT,
        pushed_by         TEXT,
        failure_reason    TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        pushed_at         TIMESTAMPTZ,
        settled_at        TIMESTAMPTZ
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clearing_cycle_items (
        item_id      TEXT PRIMARY KEY,
        cycle_id     TEXT NOT NULL REFERENCES clearing_cycles(cycle_id) ON DELETE CASCADE,
        leg_id       TEXT,
        origin       TEXT NOT NULL,
        origin_id    TEXT NOT NULL,
        desk         TEXT,
        counterparty TEXT,
        payee_key    TEXT,
        amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
        currency     TEXT NOT NULL DEFAULT 'USD',
        reference    TEXT,
        due_date     DATE,
        released     BOOLEAN NOT NULL DEFAULT FALSE,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // The claim: one live cycle per obligation. A released row no longer claims
    // it, so an obligation freed by a cancelled cycle can be cleared again.
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_clearing_items_live_claim
         ON clearing_cycle_items(origin, origin_id) WHERE released = FALSE`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_clearing_items_cycle ON clearing_cycle_items(cycle_id)`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_clearing_legs_cycle ON clearing_cycle_legs(cycle_id)`
    );
    return true;
  }

  /**
   * Obligations the back office says are pushable today, minus anything a live
   * cycle already claims. The queue is the only intake: it is where compliance
   * on the payee allowlist, the one-push rule and the Melio in-flight rule
   * already live, so clearing inherits every one of those refusals instead of
   * re-implementing them more loosely.
   */
  async candidates({ limit = 200, valueDate = null } = {}) {
    await this.ensureTables();
    const cap = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    const queue = await WealthBackOfficeEngine.creditQueue({ limit: cap });
    const claimed = await this._liveClaims();

    const eligible = [];
    const excluded = [];
    for (const item of queue.items) {
      if (!item.pushable) continue;
      const claim = claimed.get(`${item.origin}:${item.originId}`);
      if (claim) {
        excluded.push({
          origin: item.origin,
          originId: item.originId,
          counterparty: item.counterparty,
          amount: item.amount,
          reason: `Already bound to clearing cycle ${claim.cycle_id} (${claim.status}).`,
        });
        continue;
      }
      eligible.push({
        origin: item.origin,
        originId: item.originId,
        desk: item.desk,
        counterparty: item.counterparty,
        payeeKey: item.payeeKey,
        disbursementType: item.disbursementType,
        amountCents: item.amountCents,
        amount: item.amount,
        currency: item.currency || 'USD',
        reference: item.reference || null,
        dueDate: item.dueDate || null,
      });
    }

    const proposed = this._net(eligible, valueDate || today());
    return {
      valueDate: valueDate || today(),
      eligible,
      excluded,
      proposedLegs: proposed.legs,
      totals: {
        obligationCount: eligible.length,
        legCount: proposed.legs.length,
        grossCents: proposed.grossCents,
        gross: dollars(proposed.grossCents),
        netCents: proposed.netCents,
        net: dollars(proposed.netCents),
        creditsAvoided: Math.max(0, eligible.length - proposed.legs.length),
      },
      queueErrors: queue.errors || [],
      note: queue.errors && queue.errors.length
        ? 'One or more desks could not be read, so this candidate set is incomplete; clear the desk error before netting a cycle you intend to fund.'
        : 'Every obligation here is pushable on its own desk and unclaimed by a live cycle.',
    };
  }

  /**
   * Collapse obligations into legs. The grouping key is the whole legal identity
   * of the instruction — who is paid, on which rail, in which currency, for
   * which value date — because anything coarser produces a credit no rail can
   * actually originate.
   */
  _net(items, valueDate) {
    const groups = new Map();
    for (const item of items) {
      const key = [item.payeeKey, item.disbursementType, item.currency, valueDate].join('|');
      const leg = groups.get(key) || {
        payeeKey: item.payeeKey,
        counterparty: item.counterparty,
        disbursementType: item.disbursementType,
        currency: item.currency,
        valueDate,
        grossCents: 0,
        netCents: 0,
        obligations: [],
      };
      leg.grossCents += item.amountCents;
      leg.netCents = leg.grossCents;
      leg.obligations.push(item);
      groups.set(key, leg);
    }
    const legs = [...groups.values()]
      .map(leg => ({
        ...leg,
        gross: dollars(leg.grossCents),
        net: dollars(leg.netCents),
        obligationCount: leg.obligations.length,
      }))
      .sort((a, b) => b.netCents - a.netCents);
    return {
      legs,
      grossCents: legs.reduce((total, leg) => total + leg.grossCents, 0),
      netCents: legs.reduce((total, leg) => total + leg.netCents, 0),
    };
  }

  /**
   * Open a cycle and net it in one act, because an un-netted cycle is only a
   * list and there is nothing an operator can decide from it. Membership is
   * written first: if another cycle claims an obligation in the same instant the
   * insert fails and this cycle is abandoned, rather than both cycles believing
   * they own the payable.
   */
  async openCycle({ openedBy, valueDate = null, limit = 200, currency = 'USD', origins = null, note = null } = {}) {
    if (!openedBy) {
      throw new ClearingNettingError(
        'openedBy is required: a clearing cycle is opened by a named operator',
        'CLEARING_NO_OPERATOR',
        400
      );
    }
    await this.ensureTables();
    const day = isoDay(valueDate) || today();
    const candidates = await this.candidates({ limit, valueDate: day });

    const wanted = Array.isArray(origins) && origins.length ? new Set(origins) : null;
    const selected = candidates.eligible.filter(item =>
      item.currency === currency && (!wanted || wanted.has(item.origin)));
    if (!selected.length) {
      throw new ClearingNettingError(
        `No unclaimed ${currency} obligation is eligible for clearing on ${day}`,
        'CLEARING_NOTHING_TO_CLEAR',
        409
      );
    }
    const netted = this._net(selected, day);
    const id = cycleId(day);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO clearing_cycles
           (cycle_id, value_date, currency, status, opened_by, gross_cents, net_cents, note, netted_at)
         VALUES ($1, $2, $3, 'netted', $4, $5, $6, $7, NOW())`,
        [id, day, currency, openedBy, netted.grossCents, netted.netCents, note || null]
      );
      let index = 0;
      for (const leg of netted.legs) {
        index += 1;
        const legId = `${id}-L${String(index).padStart(2, '0')}`;
        await client.query(
          `INSERT INTO clearing_cycle_legs
             (leg_id, cycle_id, payee_key, counterparty, disbursement_type, currency, value_date,
              gross_cents, net_cents, obligation_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [legId, id, leg.payeeKey, leg.counterparty, leg.disbursementType, leg.currency, leg.valueDate,
            leg.grossCents, leg.netCents, leg.obligations.length]
        );
        for (const item of leg.obligations) {
          await client.query(
            `INSERT INTO clearing_cycle_items
               (item_id, cycle_id, leg_id, origin, origin_id, desk, counterparty, payee_key,
                amount_cents, currency, reference, due_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [`${legId}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`, id, legId,
              item.origin, item.originId, item.desk, item.counterparty, item.payeeKey,
              item.amountCents, item.currency, item.reference, item.dueDate]
          );
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => null);
      if (String(error.message || '').includes('uq_clearing_items_live_claim')) {
        throw new ClearingNettingError(
          'An obligation in this set was claimed by another clearing cycle while this one was being opened,'
          + ' so no cycle was created; re-read the candidates and open again.',
          'CLEARING_ITEM_CLAIMED',
          409
        );
      }
      throw error;
    } finally {
      client.release();
    }

    return this.cycle(id);
  }

  /**
   * The funding decision, made once for the whole cycle. Available cash is read
   * from the funding registry — the same authority every rail draws on — and
   * reduced by every other live cycle's unsettled net, so the cash behind this
   * cycle is not the cash behind yesterday's unsettled one.
   */
  async fundCycle({ cycleId: id, fundedBy } = {}) {
    if (!fundedBy) {
      throw new ClearingNettingError(
        'fundedBy is required: funding a cycle is an act by a named operator',
        'CLEARING_NO_OPERATOR',
        400
      );
    }
    const cycle = await this.cycle(id);
    this._assertTransition(cycle, 'funded');

    const funding = await this.funding({ excludeCycleId: id });
    if (!funding.source || funding.blockers.length) {
      throw new ClearingNettingError(
        `The Trust Operating Account cannot fund this cycle: ${funding.blockers.join(' ') || 'the funding registry returned no account.'}`,
        'CLEARING_NO_FUNDING_SOURCE',
        409
      );
    }
    if (funding.spendableCents < cycle.netCents) {
      throw new ClearingNettingError(
        `${funding.source.accountName} has ${dollars(funding.spendableCents)} spendable`
        + ` (${dollars(funding.availableCents)} on the ledger less ${dollars(funding.committedCents)} committed to live cycles)`
        + ` and this cycle nets ${cycle.net}`,
        'CLEARING_UNDERFUNDED',
        409
      );
    }

    await pool.query(
      `UPDATE clearing_cycles
          SET status = 'funded', funding_source = $2, funded_by = $3, funded_at = NOW()
        WHERE cycle_id = $1`,
      [id, funding.source.sourceId, fundedBy]
    );
    return this.cycle(id);
  }

  /**
   * Hand every leg to Payer OS as one net credit. Each obligation inside the leg
   * is recorded against that single disbursement in the back office's own push
   * table, so a netted payable is as un-repushable as a gross one, and a leg
   * that Payer OS refuses is recorded `failed` with its reason rather than
   * silently dropped from the cycle.
   */
  async settleCycle({ cycleId: id, initiatedBy, memo = null } = {}) {
    if (!initiatedBy) {
      throw new ClearingNettingError(
        'initiatedBy is required: legs are raised by a named trustee',
        'CLEARING_NO_OPERATOR',
        400
      );
    }
    const cycle = await this.cycle(id);
    this._assertTransition(cycle, 'settling');

    const results = [];
    for (const leg of cycle.legs) {
      if (leg.status !== 'netted') {
        results.push({ legId: leg.legId, status: leg.status, skipped: true });
        continue;
      }
      try {
        const { disbursement } = await PayerOsEngine.initiate({
          disbursementType: leg.disbursementType,
          amountCents: leg.netCents,
          payee: leg.payeeKey,
          initiatedBy,
          memo: memo
            || `Clearing cycle ${id} net credit — ${leg.obligationCount} obligation(s) to ${leg.counterparty}`,
        });
        await this._recordLegPush(leg, disbursement.disbursement_id, initiatedBy);
        results.push({
          legId: leg.legId,
          status: 'pushed',
          disbursementId: disbursement.disbursement_id,
          net: leg.net,
          counterparty: leg.counterparty,
        });
      } catch (error) {
        await pool.query(
          `UPDATE clearing_cycle_legs SET status = 'failed', failure_reason = $2 WHERE leg_id = $1`,
          [leg.legId, error.message]
        );
        results.push({ legId: leg.legId, status: 'failed', error: error.message, counterparty: leg.counterparty });
      }
    }

    await pool.query(`UPDATE clearing_cycles SET status = 'settling' WHERE cycle_id = $1`, [id]);
    const refreshed = await this.reconcile(id);

    await MessagingEngine.notify({
      subject: `Clearing cycle ${id} raised ${results.filter(r => r.status === 'pushed').length} net credit(s)`,
      body: `${cycle.obligationCount} obligation(s) netted to ${cycle.legs.length} leg(s) totalling ${cycle.net}.`
        + ' Each leg is pending a second trustee\'s approval in Payer OS.',
      participants: [initiatedBy],
      referenceType: 'clearing_cycle',
      referenceId: id,
      sender: initiatedBy,
    }).catch(() => null);

    return { cycle: refreshed, legs: results };
  }

  /**
   * Read each pushed leg's disbursement back from Payer OS and let the cycle's
   * state follow it. The cycle is only `settled` when every leg settled;
   * anything else is `partially_settled` or still `settling`, which is the
   * honest answer an operator needs before opening tomorrow's cycle.
   */
  async reconcile(id) {
    const cycle = await this.cycle(id);
    if (!['settling', 'partially_settled', 'settled'].includes(cycle.status)) return cycle;

    let settledCents = 0;
    for (const leg of cycle.legs) {
      if (!leg.disbursementId) continue;
      const disbursement = await PayerOsEngine.get(leg.disbursementId).catch(() => null);
      if (!disbursement) continue;
      if (disbursement.status === 'settled') {
        settledCents += Number(leg.netCents);
        if (leg.status !== 'settled') {
          await pool.query(
            `UPDATE clearing_cycle_legs SET status = 'settled', settled_at = NOW() WHERE leg_id = $1`,
            [leg.legId]
          );
        }
      } else if (TERMINAL_STATUSES.includes(disbursement.status) && leg.status !== 'failed') {
        await pool.query(
          `UPDATE clearing_cycle_legs SET status = 'failed', failure_reason = $2 WHERE leg_id = $1`,
          [leg.legId, `Payer OS ${leg.disbursementId} ended ${disbursement.status}`]
        );
      }
    }

    const legs = (await pool.query(
      `SELECT status FROM clearing_cycle_legs WHERE cycle_id = $1`,
      [id]
    )).rows;
    const allSettled = legs.length > 0 && legs.every(leg => leg.status === 'settled');
    const anySettled = legs.some(leg => leg.status === 'settled');
    const status = allSettled ? 'settled' : (anySettled ? 'partially_settled' : cycle.status);

    await pool.query(
      `UPDATE clearing_cycles
          SET status = $2, settled_cents = $3, settled_at = CASE WHEN $2 = 'settled' THEN NOW() ELSE settled_at END
        WHERE cycle_id = $1`,
      [id, status, settledCents]
    );
    return this.cycle(id);
  }

  /**
   * Release a cycle. Legs that never reached Payer OS give their obligations
   * back to the queue; legs already in flight keep their claim, because this
   * engine does not own the rail those dollars are on and cannot un-promise
   * them by editing its own table.
   */
  async cancelCycle({ cycleId: id, cancelledBy, reason = null } = {}) {
    if (!cancelledBy) {
      throw new ClearingNettingError(
        'cancelledBy is required',
        'CLEARING_NO_OPERATOR',
        400
      );
    }
    const cycle = await this.cycle(id);
    const releasable = cycle.legs.filter(leg => RELEASABLE_LEG_STATUSES.includes(leg.status));
    const retained = cycle.legs.filter(leg => !RELEASABLE_LEG_STATUSES.includes(leg.status));
    const releasedObligations = releasable.reduce(
      (total, leg) => total + leg.obligations.filter(item => !item.released).length,
      0
    );

    for (const leg of releasable) {
      await pool.query(
        `UPDATE clearing_cycle_items SET released = TRUE WHERE cycle_id = $1 AND leg_id = $2`,
        [id, leg.legId]
      );
      await pool.query(`UPDATE clearing_cycle_legs SET status = 'released' WHERE leg_id = $1`, [leg.legId]);
    }

    if (retained.length) {
      return {
        cycle: await this.cycle(id),
        releasedLegs: releasable.length,
        releasedObligations,
        retained: retained.map(leg => ({
          legId: leg.legId,
          status: leg.status,
          disbursementId: leg.disbursementId,
          note: 'Left in the cycle: its net credit is already with Payer OS, so cancel or settle it there.',
        })),
      };
    }

    await pool.query(
      `UPDATE clearing_cycles
          SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $2, cancel_reason = $3
        WHERE cycle_id = $1`,
      [id, cancelledBy, reason || null]
    );
    return {
      cycle: await this.cycle(id),
      releasedLegs: releasable.length,
      releasedObligations,
      retained: [],
    };
  }

  async cycle(id) {
    await this.ensureTables();
    const found = await pool.query(`SELECT * FROM clearing_cycles WHERE cycle_id = $1`, [String(id || '')]);
    if (!found.rows.length) {
      throw new ClearingNettingError(`Clearing cycle ${id} does not exist`, 'CLEARING_CYCLE_NOT_FOUND', 404);
    }
    const row = found.rows[0];
    const legRows = (await pool.query(
      `SELECT * FROM clearing_cycle_legs WHERE cycle_id = $1 ORDER BY net_cents DESC`,
      [row.cycle_id]
    )).rows;
    const itemRows = (await pool.query(
      `SELECT * FROM clearing_cycle_items WHERE cycle_id = $1 ORDER BY created_at ASC`,
      [row.cycle_id]
    )).rows;

    const legs = legRows.map(leg => ({
      legId: leg.leg_id,
      payeeKey: leg.payee_key,
      counterparty: leg.counterparty,
      disbursementType: leg.disbursement_type,
      currency: leg.currency,
      valueDate: isoDay(leg.value_date),
      grossCents: Number(leg.gross_cents),
      gross: dollars(leg.gross_cents),
      netCents: Number(leg.net_cents),
      net: dollars(leg.net_cents),
      obligationCount: Number(leg.obligation_count),
      status: leg.status,
      disbursementId: leg.disbursement_id,
      failureReason: leg.failure_reason,
      obligations: itemRows
        .filter(item => item.leg_id === leg.leg_id)
        .map(item => ({
          origin: item.origin,
          originId: item.origin_id,
          desk: item.desk,
          amountCents: Number(item.amount_cents),
          amount: dollars(item.amount_cents),
          reference: item.reference,
          dueDate: isoDay(item.due_date),
          released: item.released,
        })),
    }));

    return {
      cycleId: row.cycle_id,
      valueDate: isoDay(row.value_date),
      currency: row.currency,
      status: row.status,
      openedBy: row.opened_by,
      grossCents: Number(row.gross_cents),
      gross: dollars(row.gross_cents),
      netCents: Number(row.net_cents),
      net: dollars(row.net_cents),
      settledCents: Number(row.settled_cents),
      settled: dollars(row.settled_cents),
      fundingSource: row.funding_source,
      fundedBy: row.funded_by,
      obligationCount: itemRows.filter(item => !item.released).length,
      legs,
      creditsAvoided: Math.max(0, itemRows.filter(item => !item.released).length - legs.length),
      note: row.note,
      openedAt: row.created_at ? row.created_at.toISOString() : null,
      nettedAt: row.netted_at ? row.netted_at.toISOString() : null,
      fundedAt: row.funded_at ? row.funded_at.toISOString() : null,
      settledAt: row.settled_at ? row.settled_at.toISOString() : null,
      cancelledAt: row.cancelled_at ? row.cancelled_at.toISOString() : null,
      cancelReason: row.cancel_reason,
      nextStep: this._nextStep(row.status),
    };
  }

  async list({ status = null, limit = 50 } = {}) {
    await this.ensureTables();
    const cap = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const rows = status
      ? (await pool.query(
        `SELECT cycle_id FROM clearing_cycles WHERE status = $1 ORDER BY created_at DESC LIMIT $2`,
        [String(status), cap]
      )).rows
      : (await pool.query(
        `SELECT cycle_id FROM clearing_cycles ORDER BY created_at DESC LIMIT $1`,
        [cap]
      )).rows;
    const cycles = [];
    for (const row of rows) cycles.push(await this.cycle(row.cycle_id));
    return {
      count: cycles.length,
      cycles,
      liveNetCents: cycles
        .filter(cycle => LIVE_CYCLE_STATUSES.includes(cycle.status))
        .reduce((total, cycle) => total + cycle.netCents - cycle.settledCents, 0),
    };
  }

  /**
   * What the trust can still commit to a cycle: the operating account's ledger
   * position less every live cycle's unsettled net. Anything else — a second
   * cycle reading the same balance and each believing it is funded — is how a
   * netting layer manufactures an overdraft.
   */
  async funding({ excludeCycleId = null } = {}) {
    await this.ensureTables();
    const blockers = [];
    let source = null;
    try {
      const sources = await FundingSourceRegistry.list();
      source = sources.find(row => row.sourceType === TRUST_OPERATING) || null;
      if (!source) blockers.push('The funding registry returned no Trust Operating Account.');
      else if (!source.eligible) blockers.push(source.ineligibleReason || 'The Trust Operating Account is not eligible to fund payments.');
    } catch (error) {
      blockers.push(error.message);
    }

    const committed = (await pool.query(
      `SELECT COALESCE(SUM(net_cents - settled_cents), 0) AS committed
         FROM clearing_cycles
        WHERE status = ANY($1::text[]) AND cycle_id <> COALESCE($2, '')`,
      [LIVE_CYCLE_STATUSES, excludeCycleId]
    )).rows[0];
    const committedCents = Number(committed.committed || 0);
    const availableCents = source ? Number(source.availableCents || 0) : 0;

    return {
      source: source
        ? { sourceId: source.sourceId, accountName: source.accountName, available: dollars(availableCents) }
        : null,
      availableCents,
      committedCents,
      committed: dollars(committedCents),
      spendableCents: Math.max(0, availableCents - committedCents),
      spendable: dollars(Math.max(0, availableCents - committedCents)),
      blockers,
    };
  }

  /**
   * The clearing desk's own findings, in the back office's runbook vocabulary:
   * a cycle netted but never funded, funded but never settled, or settled only
   * in part is an obligation nobody is chasing.
   */
  async runbook({ limit = 50 } = {}) {
    const { cycles } = await this.list({ limit });
    const live = cycles.filter(cycle => LIVE_CYCLE_STATUSES.includes(cycle.status));
    const actions = [];
    const breaks = [];

    for (const cycle of live) {
      if (cycle.status === 'netted') {
        actions.push(`Cycle ${cycle.cycleId} nets ${cycle.net} across ${cycle.legs.length} leg(s) and is not funded yet.`);
      } else if (cycle.status === 'funded') {
        actions.push(`Cycle ${cycle.cycleId} is funded (${cycle.net}) and waiting to be handed to Payer OS.`);
      } else if (cycle.status === 'settling') {
        actions.push(`Cycle ${cycle.cycleId} has ${cycle.legs.filter(l => l.status === 'pushed').length} leg(s) awaiting approval or settlement in Payer OS.`);
      } else if (cycle.status === 'partially_settled') {
        breaks.push(`Cycle ${cycle.cycleId} settled ${cycle.settled} of ${cycle.net}; ${cycle.legs.filter(l => l.status !== 'settled').length} leg(s) did not settle.`);
      }
      for (const leg of cycle.legs.filter(l => l.status === 'failed')) {
        breaks.push(`Cycle ${cycle.cycleId} leg ${leg.legId} to ${leg.counterparty} failed: ${leg.failureReason || 'no reason recorded'}.`);
      }
    }

    const funding = await this.funding();
    if (funding.blockers.length) {
      breaks.push(`Clearing cannot resolve its funding source: ${funding.blockers.join(' ')}`);
    } else if (funding.committedCents > funding.availableCents) {
      breaks.push(
        `Live cycles commit ${funding.committed} against ${dollars(funding.availableCents)} in ${funding.source.accountName};`
        + ' a cycle will fail funding until one settles or is cancelled.'
      );
    }

    return {
      liveCycles: live.length,
      liveNetCents: live.reduce((total, cycle) => total + cycle.netCents - cycle.settledCents, 0),
      funding,
      actions,
      breaks,
      clean: actions.length === 0 && breaks.length === 0,
    };
  }

  async _liveClaims() {
    const rows = await pool.query(
      `SELECT i.origin, i.origin_id, i.cycle_id, c.status
         FROM clearing_cycle_items i
         JOIN clearing_cycles c ON c.cycle_id = i.cycle_id
        WHERE i.released = FALSE AND c.status = ANY($1::text[])`,
      [LIVE_CYCLE_STATUSES]
    );
    const map = new Map();
    for (const row of rows.rows) map.set(`${row.origin}:${row.origin_id}`, row);
    return map;
  }

  /**
   * Record the net credit against every obligation inside the leg. The back
   * office's push table is the one-push register, so a netted obligation has to
   * appear in it or the queue would offer it again the moment the cycle is out
   * of sight.
   */
  async _recordLegPush(leg, disbursementId, initiatedBy) {
    await WealthBackOfficeEngine.ensureTables();
    for (const obligation of leg.obligations) {
      await pool.query(
        `INSERT INTO wealth_credit_pushes
           (push_id, origin, origin_id, disbursement_id, disbursement_type, payee_key, amount_cents, currency, memo, pushed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (push_id) DO NOTHING`,
        [
          `CYC-${leg.legId}-${obligation.origin}-${obligation.originId}`,
          obligation.origin,
          obligation.originId,
          disbursementId,
          leg.disbursementType,
          leg.payeeKey,
          obligation.amountCents,
          leg.currency,
          `Netted into ${leg.legId} (${leg.net}) on clearing cycle ${leg.legId.split('-L')[0]}`,
          initiatedBy,
        ]
      );
    }
    await pool.query(
      `UPDATE clearing_cycle_legs
          SET status = 'pushed', disbursement_id = $2, pushed_by = $3, pushed_at = NOW()
        WHERE leg_id = $1`,
      [leg.legId, disbursementId, initiatedBy]
    );
  }

  _assertTransition(cycle, next) {
    const allowed = CYCLE_TRANSITIONS[cycle.status] || new Set();
    if (!allowed.has(next)) {
      throw new ClearingNettingError(
        `Cycle ${cycle.cycleId} is ${cycle.status} and cannot move to ${next}`,
        'CLEARING_BAD_TRANSITION',
        409
      );
    }
  }

  _nextStep(status) {
    switch (status) {
      case 'open': return 'Net the cycle.';
      case 'netted': return 'Fund the cycle: its net requirement has not been checked against the operating account yet.';
      case 'funded': return 'Hand the legs to Payer OS; a second trustee approves each net credit there.';
      case 'settling': return 'Approve and settle each leg in Payer OS, then reconcile the cycle.';
      case 'partially_settled': return 'Chase the legs that did not settle; the cycle is not complete.';
      case 'settled': return 'Complete: every leg settled.';
      case 'cancelled': return 'Cancelled: its unpushed obligations are back in the credit queue.';
      default: return 'Unknown state.';
    }
  }
}

const ClearingNettingEngine = new ClearingNettingEngineImpl();

module.exports = {
  ClearingNettingEngine,
  ClearingNettingError,
  LIVE_CYCLE_STATUSES,
};
